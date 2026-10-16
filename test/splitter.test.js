'use strict';

/** 测试一：AA 分摊对平（核心正确性约束） */

const test = require('node:test');
const assert = require('node:assert');
const { splitBill, largestRemainder } = require('../src/core/splitter');

test('三人拼单（演示数据）：分摊和与订单实付严格对平', () => {
  const r = splitBill({
    shares: [
      { name: '张三', originalFen: 3950 },
      { name: '李四', originalFen: 4800 },
      { name: '王五', originalFen: 3600 },
    ],
    priceFen: 8000,
    discountFen: 4350,
  });
  assert.strictEqual(r.shares.length, 3);
  const sum = r.shares.reduce((a, s) => a + s.payFen, 0);
  assert.strictEqual(sum, 8000, '分摊之和必须等于实付');
  assert.strictEqual(r.residualFen, 0);
  assert.ok(r.balanced);
  // 优惠按小计占比分配
  assert.strictEqual(r.shares.reduce((a, s) => a + s.discountFen, 0), 4350);
  // 演示数据的确定结果（最大余额法）
  assert.deepStrictEqual(
    r.shares.map((s) => s.payFen),
    [2559, 3109, 2332]
  );
});

test('除不尽的优惠也能对平：100 分优惠分给三人', () => {
  const r = splitBill({
    shares: [
      { name: '甲', originalFen: 100 },
      { name: '乙', originalFen: 100 },
      { name: '丙', originalFen: 100 },
    ],
    priceFen: 200,
    discountFen: 100,
  });
  assert.strictEqual(r.shares.reduce((a, s) => a + s.payFen, 0), 200);
  assert.deepStrictEqual(
    r.shares.map((s) => s.discountFen).sort(),
    [33, 33, 34]
  );
});

test('尾差（≤2分）归发起人，吸收后严格对平', () => {
  // 模拟菜单价与真实算价有 2 分出入：个人原价合计 12352，订单实付按 8000
  const r = splitBill({
    shares: [
      { name: '甲', originalFen: 4101 },
      { name: '乙', originalFen: 8251 },
    ],
    priceFen: 8000,
    discountFen: 4350,
  });
  assert.ok(Math.abs(r.residualFen) <= 2, '尾差必须 ≤ 2 分');
  assert.ok(r.balanced);
  // 吸收后对平
  assert.strictEqual(r.shares.reduce((a, s) => a + s.payFen, 0), 8000);
  // 尾差由发起人（第一个人）吸收
  assert.strictEqual(r.initiator, '甲');
});

test('单人拼单：应付即实付', () => {
  const r = splitBill({
    shares: [{ name: '独行侠', originalFen: 1000 }],
    priceFen: 700,
    discountFen: 300,
  });
  assert.strictEqual(r.shares[0].payFen, 700);
  assert.strictEqual(r.shares.reduce((a, s) => a + s.payFen, 0), 700);
});

test('零优惠：各付原价小计', () => {
  const r = splitBill({
    shares: [
      { name: '甲', originalFen: 100 },
      { name: '乙', originalFen: 200 },
    ],
    priceFen: 300,
    discountFen: 0,
  });
  assert.deepStrictEqual(
    r.shares.map((s) => s.payFen),
    [100, 200]
  );
});

test('优惠不超过任何人的原价小计（不出现负应付）', () => {
  const r = splitBill({
    shares: [
      { name: '甲', originalFen: 500 },
      { name: '乙', originalFen: 50 },
    ],
    priceFen: 0,
    discountFen: 550,
  });
  for (const s of r.shares) {
    assert.ok(s.payFen >= 0, `${s.name} 应付不能为负`);
    assert.ok(s.discountFen <= s.originalFen, '分摊优惠不能超过原价小计');
  }
  assert.strictEqual(r.shares.reduce((a, s) => a + s.payFen, 0), 0);
});

test('largestRemainder：整数精确分配', () => {
  assert.deepStrictEqual(largestRemainder(100, [1, 1, 1]).reduce((a, b) => a + b, 0), 100);
  assert.deepStrictEqual(largestRemainder(0, [3, 7]), [0, 0]);
  assert.deepStrictEqual(largestRemainder(10, [0, 0]), [0, 0]);
  // 权重全零时不崩溃
  assert.doesNotThrow(() => largestRemainder(10, []));
});

test('随机压力：分摊和始终与实付对平', () => {
  for (let t = 0; t < 200; t++) {
    const n = 1 + Math.floor(Math.random() * 8);
    const shares = Array.from({ length: n }, (_, i) => ({
      name: `p${i}`,
      originalFen: Math.floor(Math.random() * 50000),
    }));
    const original = shares.reduce((a, s) => a + s.originalFen, 0);
    const discount = Math.floor(Math.random() * (original + 1));
    const r = splitBill({ shares, priceFen: original - discount, discountFen: discount });
    const sum = r.shares.reduce((a, s) => a + s.payFen, 0);
    assert.strictEqual(sum, original - discount, `第 ${t} 组随机数据未对平`);
    for (const s of r.shares) assert.ok(s.payFen >= 0);
  }
});
