#!/usr/bin/env node
'use strict';

/**
 * 演示网站桥接服务器（零第三方依赖，Node >= 18 内置 fetch）
 *
 * 作用：让 demo-site/index.html 能「真实连线」演示：
 * - 浏览器 ←→ 本服务器（127.0.0.1）同源，无 CORS 问题
 * - MCD_TOKEN 只存在于服务端环境变量，绝不进入浏览器/前端代码
 *
 * 用法：
 *   export MCD_TOKEN=xxx        # Windows PowerShell: $env:MCD_TOKEN="xxx"
 *   node demo-site/server.js    # 打开 http://127.0.0.1:8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const { McdTools } = require('../src/mcp/tools');
const { flattenMeals } = require('../src/core/match');
const { optimizeBasket, suggestAddons } = require('../src/core/optimizer');
const { splitBill } = require('../src/core/splitter');

const PORT = Number(process.env.PORT || 8080);
const INDEX_HTML = path.join(__dirname, 'index.html');

let _tools = null;
function tools() {
  if (!_tools) _tools = new McdTools(); // 缺 Token 时这里抛出 McpError(NO_TOKEN)
  return _tools;
}

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function sseInit(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
}
function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function friendly(e) {
  return (e && e.message) || String(e);
}

/** 真实算价裁判：calculate-price（分单位） */
function makePriceFn(storeCode) {
  return async (lines) => {
    const items = lines.map((l) => {
      const item = { productCode: l.productCode, quantity: l.quantity };
      if (l.couponId && l.couponCode) {
        item.couponId = l.couponId;
        item.couponCode = l.couponCode;
      }
      return item;
    });
    const d = await tools().calculatePrice({ storeCode, items });
    return {
      price: d.price,
      originalPrice: d.originalPrice,
      discount: d.discount,
      productList: d.productList || [],
    };
  };
}

/** 拉菜单 + 券，返回摊平列表与券归一化列表 */
async function fetchMenuAndCoupons(storeCode) {
  const mealsData = await tools().queryMeals({ storeCode });
  const mealList = flattenMeals(mealsData);
  const catByCode = new Map();
  (mealsData.categories || []).forEach((cat) => {
    (cat.meals || []).forEach((m) => catByCode.set(m.code, cat.name));
  });
  const storeCoupons = await tools().queryStoreCoupons({ storeCode });
  const coupons = (storeCoupons || []).map((c) => ({
    couponId: c.couponId,
    couponCode: c.couponCode,
    title: c.title,
    productCodes: (c.products || []).map((p) => p.productCode),
  }));
  return { mealList, catByCode, coupons };
}

async function handleOptimize(body, res) {
  const { storeCode, people, addonCode } = body;
  if (!storeCode || !Array.isArray(people) || people.length === 0) {
    sseSend(res, 'error', { message: '参数不完整：需要 storeCode 和 people' });
    return;
  }
  const sc = String(storeCode);

  // ① 拉真实菜单 + 门店可用券
  const { mealList, catByCode, coupons } = await fetchMenuAndCoupons(sc);
  const mealByCode = new Map(mealList.map((m) => [m.code, m]));
  sseSend(res, 'menu', { count: mealList.length });
  sseSend(res, 'coupons', { coupons });

  // ② 建篮（按 productCode 合并）
  const basket = new Map();
  for (const p of people) {
    for (const w of p.wants || []) {
      const meal = mealByCode.get(w.code);
      if (!meal) throw new Error(`菜单里找不到餐品 ${w.code}，请刷新菜单后重试`);
      const qty = Math.max(1, parseInt(w.qty, 10) || 1);
      if (!basket.has(meal.code)) {
        basket.set(meal.code, {
          productCode: meal.code,
          name: meal.name,
          quantity: 0,
          unit: meal.currentPriceFen,
          persons: [],
        });
      }
      const b = basket.get(meal.code);
      b.quantity += qty;
      b.persons.push({ name: p.name, qty });
    }
  }
  if (addonCode) {
    const meal = mealByCode.get(addonCode);
    if (meal && !basket.has(addonCode)) {
      basket.set(addonCode, {
        productCode: meal.code,
        name: meal.name,
        quantity: 1,
        unit: meal.currentPriceFen,
        persons: [{ name: people[0].name, qty: 1 }], // 凑单品记发起人名下
      });
    }
  }
  const items = Array.from(basket.values());
  if (items.length === 0) {
    sseSend(res, 'error', { message: '拼单篮是空的' });
    return;
  }

  // ③ 券分配搜索（真实算价，逐组合事件回推）
  const priceFn = makePriceFn(sc);
  const opt = await optimizeBasket({
    items,
    coupons,
    priceFn,
    callBudget: 300, // 600 次/分钟红线内
    onBase: (b) => sseSend(res, 'base', b),
    onEval: (ev) => sseSend(res, 'combo', ev),
  });

  // ④ 凑单建议（单价升序，优先小食/饮品/甜品）
  const preferred = mealList.filter((m) => /小食|饮|甜品|点心/.test(catByCode.get(m.code) || ''));
  const pool = (preferred.length >= 5 ? preferred : mealList)
    .slice()
    .sort((a, b) => a.currentPriceFen - b.currentPriceFen);
  let suggestion = null;
  if (!addonCode) {
    const sug = await suggestAddons({
      items,
      coupons,
      assignment: opt.best.assignment,
      addonCandidates: pool.map((m) => ({
        productCode: m.code,
        name: m.name,
        unitPriceFen: m.currentPriceFen,
      })),
      priceFn,
      currentPriceFen: opt.best.result.price,
      callBudget: 20,
    });
    if (sug) {
      suggestion = {
        addon: { code: sug.addon.productCode, name: sug.addon.name, unit: sug.addon.unitPriceFen },
        newPriceFen: sug.newPriceFen,
        savingFen: sug.savingFen,
      };
    }
  }

  // ⑤ AA 分摊
  const shares = people.map((p) => {
    const originalFen = items.reduce((acc, it) => {
      const mine = it.persons.filter((x) => x.name === p.name).reduce((a, x) => a + x.qty, 0);
      return acc + mine * it.unit;
    }, 0);
    return { name: p.name, originalFen };
  });
  const split = splitBill({
    shares,
    priceFen: opt.best.result.price,
    discountFen: opt.best.result.originalPrice - opt.best.result.price,
  });

  sseSend(res, 'result', {
    items: items.map((it) => ({
      code: it.productCode,
      name: it.name,
      qty: it.quantity,
      unit: it.unit,
      persons: it.persons,
    })),
    base: { price: opt.base.price, originalPrice: opt.base.originalPrice },
    best: opt.best,
    coupons,
    split,
    suggestion,
    calls: opt.calls,
    mode: opt.mode,
    combos: opt.combos,
    autoAdded: Boolean(addonCode),
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(INDEX_HTML).pipe(res);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      sendJson(res, 200, { token: Boolean(process.env.MCD_TOKEN) });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/menu') {
      const storeCode = String(url.searchParams.get('storeCode') || '');
      if (!storeCode) return sendJson(res, 400, { error: '缺少 storeCode' });
      const { mealList, catByCode, coupons } = await fetchMenuAndCoupons(storeCode);
      sendJson(res, 200, {
        meals: mealList.map((m) => ({
          code: m.code,
          name: m.name,
          price: m.currentPriceFen,
          cat: catByCode.get(m.code) || '',
        })),
        coupons,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/optimize') {
      sseInit(res);
      const body = JSON.parse(await readBody(req));
      await handleOptimize(body, res);
      res.end();
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    if (!res.headersSent) {
      sendJson(res, e.code === 'NO_TOKEN' ? 401 : 500, { error: friendly(e), code: e.code || 'ERROR' });
    } else {
      sseSend(res, 'error', { message: friendly(e) });
      res.end();
    }
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const hasToken = Boolean(process.env.MCD_TOKEN);
  console.log('🍟 麦门拼单官 · 演示服务器已启动');
  console.log(`   打开: http://127.0.0.1:${PORT}`);
  console.log(
    hasToken
      ? '   MCD_TOKEN 已配置 ✓ 真实连线模式可用'
      : '   ⚠️  未配置 MCD_TOKEN：离线演示可用，真实连线需先 export MCD_TOKEN=xxx（open.mcd.cn/mcp 申请）'
  );
  console.log('   安全红线：本服务器只调用只读工具 + 一键领券，绝不真实下单。');
});
