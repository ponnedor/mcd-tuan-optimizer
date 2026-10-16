'use strict';

/** 测试三：券分配穷举最优性 + 凑单建议（注入模拟「真实算价」裁判） */

const test = require('node:test');
const assert = require('node:assert');

const {
  optimizeBasket,
  suggestAddons,
  buildLines,
} = require('../src/core/optimizer');

/** 模拟 calculate-price：挂上券的行立减 offFen（价格单位：分） */
function makeOracle(units, coupons) {
  const byId = new Map(coupons.map((c) => [c.couponId, c]));
  return async (lines) => {
    let original = 0;
    let discount = 0;
    const productList = [];
    for (const line of lines) {
      const unit = units[line.productCode];
      const originalSubtotal = unit * line.quantity;
      original += originalSubtotal;
      let subtotal = originalSubtotal;
      if (line.couponId && byId.has(line.couponId)) {
        const d = byId.get(line.couponId).offFen;
        discount += d;
        subtotal -= d;
      }
      productList.push({
        productCode: line.productCode,
        quantity: line.quantity,
        originalSubtotal,
        subtotal,
      });
    }
    return { price: original - discount, originalPrice: original, discount, productList };
  };
}

const UNITS = { A: 1000, B: 500, C: 300 };
const items = [
  { productCode: 'A', name: 'A 套餐', quantity: 1, unitPriceFen: 1000 },
  { productCode: 'B', name: 'B 小食', quantity: 2, unitPriceFen: 500 },
  { productCode: 'C', name: 'C 饮品', quantity: 1, unitPriceFen: 300 },
]; // 原价 2300 分

test('穷举最优性：两张券各挂各的商品，找到全局最优', async () => {
  const coupons = [
    { couponId: 'K1', couponCode: 'K1', title: 'A 立减 2 元', productCodes: ['A'], offFen: 200 },
    { couponId: 'K2', couponCode: 'K2', title: 'B 立减 1.5 元', productCodes: ['B'], offFen: 150 },
  ];
  const priceFn = makeOracle(UNITS, coupons);
  const opt = await optimizeBasket({ items, coupons, priceFn, callBudget: 50 });
  assert.strictEqual(opt.mode, 'exhaustive');
  assert.strictEqual(opt.best.result.price, 1950); // 2300 - 350
  assert.strictEqual(opt.best.assignment[0], 0); // K1 → A
  assert.strictEqual(opt.best.assignment[1], 1); // K2 → B
  assert.ok(opt.calls >= 1, '必须记录调用次数');

  // 测试内暴力对拍：枚举全部合法组合，最优价一致
  let brute = Infinity;
  for (const a of [-1, 0]) {
    for (const b of [-1, 1]) {
      for (const d of [-1, 0, 1, 2]) {
        const trial = [a, b, d];
        const lines = buildLines(items, coupons, trial);
        if (!lines) continue;
        const r = await priceFn(lines);
        if (r.price < brute) brute = r.price;
      }
    }
  }
  assert.strictEqual(opt.best.result.price, brute, '穷举结果必须等于暴力对拍最优');
});

test('一行一券：两张券争同一商品行时只挂一张（挂优惠大的）', async () => {
  const coupons = [
    { couponId: 'K1', couponCode: 'K1', title: 'A 立减 2 元', productCodes: ['A'], offFen: 200 },
    { couponId: 'K3', couponCode: 'K3', title: 'A 立减 2.5 元', productCodes: ['A'], offFen: 250 },
  ];
  const priceFn = makeOracle(UNITS, coupons);
  const opt = await optimizeBasket({ items, coupons, priceFn, callBudget: 50 });
  assert.strictEqual(opt.best.result.price, 2050); // 2300 - 250（K3 胜出，K1 同行冲突弃用）
  const used = opt.best.assignment.filter((a) => a >= 0);
  assert.strictEqual(used.length, 1);
});

test('不可用券（适用商品不在篮内）不参与分配', async () => {
  const coupons = [
    { couponId: 'K9', couponCode: 'K9', title: 'X 立减 5 元', productCodes: ['X'], offFen: 500 },
  ];
  const opt = await optimizeBasket({ items, coupons, priceFn: makeOracle(UNITS, coupons), callBudget: 50 });
  assert.strictEqual(opt.best.result.price, 2300);
  assert.strictEqual(opt.best.assignment[0], -1);
});

test('贪心路径：组合数超预算时降级为贪心+局部验证，结果不差于基准', async () => {
  // 8 件商品 × 8 张各挂一件的券 → 2^8 = 256 种组合，超出预算 60 → 贪心
  const greedyItems = Array.from({ length: 8 }, (_, i) => ({
    productCode: `P${i}`,
    name: `商品${i}`,
    quantity: 1,
    unitPriceFen: 300,
  }));
  const units = {};
  greedyItems.forEach((it) => {
    units[it.productCode] = 300;
  });
  const coupons = greedyItems.map((it, i) => ({
    couponId: `G${i}`,
    couponCode: `G${i}`,
    title: `券${i}`,
    productCodes: [it.productCode],
    offFen: 50 + i * 10,
  }));
  const priceFn = makeOracle(units, coupons);
  const opt = await optimizeBasket({ items: greedyItems, coupons, priceFn, callBudget: 60 });
  assert.strictEqual(opt.mode, 'greedy');
  assert.ok(opt.calls <= 60, '调用次数必须受预算约束');
  assert.ok(opt.best.result.price < opt.base.price, '贪心结果必须优于基准价');
  assert.strictEqual(opt.best.result.price, 2400 - (50 + 60 + 70 + 80 + 90 + 100 + 110 + 120)); // 1720
  // 无行冲突时，8 张券全部挂上
  assert.strictEqual(opt.best.assignment.filter((a) => a >= 0).length, 8);
});

test('凑单建议：满减门槛未达时，加低价单品可触发更高档优惠', async () => {
  const thresholdCoupons = [
    { couponId: 'T1', couponCode: 'T1', title: '满13减8', productCodes: [] },
  ];
  const priceFn = async (lines) => {
    const units = { ...UNITS, X: 650, Y: 450 }; // X/Y 为加购候选单价（分）
    let original = 0;
    for (const l of lines) original += units[l.productCode] * l.quantity;
    const attached = lines.some((l) => l.couponId === 'T1');
    const discount = attached && original >= 1300 ? 800 : 0;
    return { price: original - discount, originalPrice: original, discount };
  };
  // 单人只点 A（1000 分），券挂上也够不到 1300 门槛
  const soloItems = [items[0]];
  const opt = await optimizeBasket({ items: soloItems, coupons: thresholdCoupons, priceFn });
  assert.strictEqual(opt.best.result.price, 1000);

  const sug = await suggestAddons({
    items: soloItems,
    coupons: thresholdCoupons,
    assignment: opt.best.assignment,
    addonCandidates: [
      { productCode: 'X', name: '菠萝派', unitPriceFen: 650 },
      { productCode: 'Y', name: '圆筒冰淇淋', unitPriceFen: 450 },
    ],
    priceFn,
    currentPriceFen: 1000,
  });
  assert.ok(sug, '应给出凑单建议');
  // 便宜的圆筒（450）就能跨过门槛，净省更多
  assert.strictEqual(sug.addon.productCode, 'Y');
  assert.strictEqual(sug.newPriceFen, 650); // 1450 - 800
  assert.strictEqual(sug.savingFen, 350); // 净省 3.5 元
});

test('凑单建议：无利可图时不建议加购', async () => {
  const coupons = [];
  const priceFn = async (lines) => {
    let original = 0;
    for (const l of lines) original += UNITS[l.productCode] * l.quantity;
    return { price: original, originalPrice: original, discount: 0 };
  };
  const sug = await suggestAddons({
    items: [items[0]],
    coupons,
    assignment: [],
    addonCandidates: [{ productCode: 'X', name: '菠萝派', unitPriceFen: 650 }],
    priceFn,
    currentPriceFen: 1000,
  });
  assert.strictEqual(sug, null);
});

test('buildLines：同一行挂两张券返回 null（跳过该组合）', () => {
  const coupons = [
    { couponId: 'K1', couponCode: 'K1', title: 'a', productCodes: ['A'] },
    { couponId: 'K2', couponCode: 'K2', title: 'b', productCodes: ['A'] },
  ];
  assert.strictEqual(buildLines(items, coupons, [0, 0]), null);
  const lines = buildLines(items, coupons, [0, 1]);
  assert.strictEqual(lines[0].couponId, 'K1');
  assert.strictEqual(lines[1].couponId, 'K2');
  assert.strictEqual(lines[2].couponId, undefined);
});
