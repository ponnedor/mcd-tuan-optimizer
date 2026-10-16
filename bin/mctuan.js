#!/usr/bin/env node
'use strict';

/**
 * 麦门拼单官 mcd-tuan-optimizer —— CLI 入口
 * 找店 → 菜单 → 领券 → 组合优化 → 真实算价 → AA 分摊
 *
 * 安全红线：只调用只读工具 + auto-bind-coupons（领券），绝不真实下单。
 * 运行时零第三方依赖，Node >= 18（内置 fetch）。
 */

const fs = require('fs');
const path = require('path');

const { McpError } = require('../src/mcp/client');
const { McdTools } = require('../src/mcp/tools');
const render = require('../src/ui/render');
const { matchMeal, flattenMeals, yuanToFen } = require('../src/core/match');
const { optimizeBasket, suggestAddons } = require('../src/core/optimizer');
const { splitBill } = require('../src/core/splitter');
const demo = require('../src/demo');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--') && next !== '') {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { command: positional[0], flags };
}

function requireToken() {
  if (!process.env.MCD_TOKEN) {
    throw new McpError(
      '未检测到 MCD_TOKEN 环境变量',
      'NO_TOKEN'
    );
  }
}

/* ---------------- 子命令 ---------------- */

async function cmdStores(flags) {
  const { city, keyword } = flags;
  if (!city || !keyword) {
    throw new Error('用法: mctuan stores --city 北京 --keyword 王府井');
  }
  requireToken();
  const tools = new McdTools();
  render.progress(`🔍 正在搜索「${city} · ${keyword}」附近门店…`);
  const stores = await tools.queryNearbyStores({ city, keyword });
  render.renderStores(stores, { city, keyword });
}

async function cmdMenu(flags) {
  const store = flags.store;
  if (!store) throw new Error('用法: mctuan menu --store 1950526 [--category 小食]');
  requireToken();
  const tools = new McdTools();
  render.progress(`📖 正在拉取门店 ${store} 的菜单…`);
  const mealsData = await tools.queryMeals({ storeCode: String(store) });
  const list = flattenMeals(mealsData);
  render.renderMenu(list, mealsData.categories, flags.category);
}

async function cmdGrab() {
  requireToken();
  const tools = new McdTools();
  render.progress('🎫 正在一键领取所有可领的券…');
  const coupons = await tools.autoBindCoupons();
  render.renderGrabResult(coupons);
}

async function cmdCoupons(flags) {
  const store = flags.store;
  if (!store) throw new Error('用法: mctuan coupons --store 1950526');
  requireToken();
  const tools = new McdTools();
  render.progress(`🎫 正在查询门店 ${store} 可用券…`);
  const coupons = await tools.queryStoreCoupons({ storeCode: String(store) });
  render.renderCoupons(coupons, String(store));
}

/* ---------------- 主命令: optimize ---------------- */

async function cmdOptimize(flags) {
  const isDemo = flags.demo === true;
  const autoAdd = flags['auto-add'] === true;

  let wishlist;
  let storeCode;
  let storeName;
  let menu;
  let couponList; // [{couponId,couponCode,title,productCodes[]}]
  let priceFn;
  let categories;
  let addonPool;

  if (isDemo) {
    // 离线演示：内置数据 + 模拟算价 oracle，无需 Token
    wishlist = demo.wishlist;
    storeCode = demo.storeCode;
    storeName = demo.storeName;
    menu = demo.menuList();
    categories = demo.categories;
    couponList = demo.coupons;
    addonPool = demo.addonCandidates();
    priceFn = demo.createPriceFn();
  } else {
    const file = flags.wishlist;
    if (!file) {
      throw new Error('用法: mctuan optimize --wishlist order.json [--auto-add]（或 --demo 体验离线演示）');
    }
    requireToken();
    wishlist = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
    storeCode = String(wishlist.storeCode);
    storeName = wishlist.storeName || `门店 ${storeCode}`;

    const tools = new McdTools();
    render.progress('📖 拉取门店菜单…');
    const mealsData = await tools.queryMeals({ storeCode });
    menu = flattenMeals(mealsData);
    categories = mealsData.categories || [];

    render.progress('🎫 拉取门店可用券…');
    const storeCoupons = await tools.queryStoreCoupons({ storeCode });
    couponList = (storeCoupons || []).map((c) => ({
      couponId: c.couponId,
      couponCode: c.couponCode,
      title: c.title,
      productCodes: (c.products || []).map((p) => p.productCode),
    }));

    // 真实算价裁判：calculate-price（价格单位：分）
    priceFn = async (lines) => {
      const items = lines.map((l) => {
        const item = { productCode: l.productCode, quantity: l.quantity };
        if (l.couponId && l.couponCode) {
          item.couponId = l.couponId;
          item.couponCode = l.couponCode;
        }
        return item;
      });
      const d = await tools.calculatePrice({ storeCode, items });
      return {
        price: d.price,
        originalPrice: d.originalPrice,
        discount: d.discount,
        productList: d.productList || [],
      };
    };

    // 凑单候选：优先小食/饮品/甜品分类，按单价升序
    const preferredCats = categories.filter((c) => /小食|饮|甜品|点心/.test(c.name || ''));
    const preferredCodes = new Set(preferredCats.flatMap((c) => (c.meals || [])));
    let pool = menu.filter((m) => preferredCodes.has(m.code));
    if (pool.length < 5) pool = menu;
    addonPool = pool.slice().sort((a, b) => a.currentPriceFen - b.currentPriceFen);
  }

  if (!wishlist.people || wishlist.people.length === 0) {
    throw new Error('wishlist 里至少要有一个人（people 数组）');
  }

  // ---- 名称匹配：意愿 → 菜单品 ----
  const byCode = new Map(menu.map((m) => [m.code, m]));
  const basket = new Map(); // productCode -> {productCode,name,quantity,unitPriceFen,persons:[]}
  const unmatched = [];
  for (const person of wishlist.people) {
    for (const want of person.wants || []) {
      const m = matchMeal(want.name, menu);
      if (!m.matched || !m.meal) {
        unmatched.push({ person: person.name, want: want.name, candidates: m.candidates });
        continue;
      }
      const qty = Math.max(1, parseInt(want.quantity, 10) || 1);
      const meal = byCode.get(m.meal.code) || m.meal;
      if (!basket.has(meal.code)) {
        basket.set(meal.code, {
          productCode: meal.code,
          name: meal.name,
          quantity: 0,
          unitPriceFen: meal.currentPriceFen !== undefined ? meal.currentPriceFen : yuanToFen(meal.currentPrice),
          persons: [],
        });
      }
      const b = basket.get(meal.code);
      b.quantity += qty;
      b.persons.push({ name: person.name, qty });
    }
  }

  if (unmatched.length > 0) {
    process.stdout.write(`${'⚠️'} 以下餐品在菜单里没匹配到，请改用准确名称：\n`);
    for (const u of unmatched) {
      process.stdout.write(`  · ${u.person} 想吃的「${u.want}」\n`);
      if (u.candidates.length > 0) {
        process.stdout.write(`    候选: ${u.candidates.map((c) => c.name).join('、')}\n`);
      }
    }
    process.exitCode = 2;
    return;
  }

  let items = Array.from(basket.values());
  const peopleShares = wishlist.people.map((p) => {
    const originalFen = items.reduce((acc, it) => {
      const mine = (it.persons || []).filter((x) => x.name === p.name).reduce((a, x) => a + x.qty, 0);
      return acc + mine * it.unitPriceFen;
    }, 0);
    return { name: p.name, originalFen };
  });

  // ---- 券分配搜索 ----
  render.progress(`🧮 搜索最优券组合（${couponList.length} 张券 · ${items.length} 种商品）…`);
  let opt = await optimizeBasket({
    items,
    coupons: couponList,
    priceFn,
    callBudget: 300, // 600 次/分钟红线内
    onProgress: render.progress,
  });

  // ---- 凑单建议 ----
  let suggestion = null;
  if (addonPool.length > 0) {
    suggestion = await suggestAddons({
      items: opt.items,
      coupons: couponList,
      assignment: opt.best.assignment,
      addonCandidates: addonPool.map((m) => ({
        productCode: m.code,
        name: m.name,
        unitPriceFen: m.currentPriceFen,
      })),
      priceFn,
      currentPriceFen: opt.best.result.price,
      callBudget: 20,
    });
  }

  // ---- --auto-add：自动加入最优凑单品 ----
  let autoAdded = false;
  if (autoAdd && suggestion) {
    render.progress(`➕ 自动加入凑单品：${suggestion.addon.name}…`);
    items = [
      ...opt.items,
      {
        productCode: suggestion.addon.productCode,
        name: suggestion.addon.name,
        quantity: 1,
        unitPriceFen: suggestion.addon.unitPriceFen,
        persons: [{ name: wishlist.people[0].name, qty: 1 }], // 凑单品记在发起人名下
      },
    ];
    peopleShares[0].originalFen += suggestion.addon.unitPriceFen;
    opt = await optimizeBasket({
      items,
      coupons: couponList,
      priceFn,
      callBudget: 380,
      onProgress: render.progress,
    });
    autoAdded = true;
    suggestion = null; // 只自动加一轮，避免无限凑单
  }

  // ---- AA 分摊 ----
  const split = splitBill({
    shares: peopleShares,
    priceFen: opt.best.result.price,
    discountFen: opt.best.result.price > 0 || opt.best.result.originalPrice > 0
      ? opt.best.result.originalPrice - opt.best.result.price
      : 0,
  });

  render.renderOptimize({
    storeName,
    peopleCount: wishlist.people.length,
    items,
    coupons: couponList,
    base: opt.base,
    best: opt.best,
    split,
    suggestion,
    calls: opt.calls,
    mode: opt.mode,
    autoAdded,
    budgetFen: wishlist.budget ? Math.round(wishlist.budget * 100) : null,
    currentPriceFen: opt.best.result.price,
  });

  if (!split.balanced) {
    process.exitCode = 3; // 分摊未对平（理论上不应发生）
  }
}

/* ---------------- main ---------------- */

async function main() {
  const { command, flags } = parseArgs(process.argv.slice(2));

  if (flags.version || flags.v) {
    render.renderVersion();
    return;
  }
  if (!command || flags.help || flags.h) {
    render.printHelp();
    return;
  }

  switch (command) {
    case 'stores':
      await cmdStores(flags);
      break;
    case 'menu':
      await cmdMenu(flags);
      break;
    case 'grab':
      await cmdGrab();
      break;
    case 'coupons':
      await cmdCoupons(flags);
      break;
    case 'optimize':
      await cmdOptimize(flags);
      break;
    default:
      throw new Error(`未知命令「${command}」，运行 mctuan --help 查看用法`);
  }
}

main().catch((e) => {
  render.renderError(e);
  process.exitCode = 1;
});
