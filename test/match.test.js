'use strict';

/** 测试四：菜单名称模糊匹配 */

const test = require('node:test');
const assert = require('node:assert');

const { matchMeal, flattenMeals, score, yuanToFen } = require('../src/core/match');

const menu = [
  { code: '9900016001', name: '巨无霸套餐' },
  { code: '9900016010', name: '麦辣鸡腿堡套餐' },
  { code: '9900016075', name: '龙焰芝士棒鸡腿堡三件套' },
  { code: '9900016002', name: '麦辣鸡腿堡' },
  { code: '9900016003', name: '中薯条' },
  { code: '9900016005', name: '可口可乐(中杯)' },
  { code: '9900016006', name: '菠萝派' },
  { code: '9900016007', name: '香芋派' },
];

test('完全匹配', () => {
  const m = matchMeal('中薯条', menu);
  assert.strictEqual(m.matched, true);
  assert.strictEqual(m.meal.code, '9900016003');
});

test('包含匹配：巨无霸 → 巨无霸套餐', () => {
  const m = matchMeal('巨无霸', menu);
  assert.strictEqual(m.matched, true);
  assert.strictEqual(m.meal.code, '9900016001');
});

test('包含匹配：可乐 → 可口可乐(中杯)', () => {
  const m = matchMeal('可乐', menu);
  assert.strictEqual(m.matched, true);
  assert.strictEqual(m.meal.code, '9900016005');
});

test('包含匹配：薯条 → 中薯条', () => {
  const m = matchMeal('薯条', menu);
  assert.strictEqual(m.matched, true);
  assert.strictEqual(m.meal.code, '9900016003');
});

test('完全匹配优先于包含匹配：麦辣鸡腿堡 → 麦辣鸡腿堡（而非套餐）', () => {
  const m = matchMeal('麦辣鸡腿堡', menu);
  assert.strictEqual(m.matched, true);
  assert.strictEqual(m.meal.code, '9900016002');
});

test('模糊匹配：三件套称呼能命中三件套餐品', () => {
  const m = matchMeal('麦辣鸡腿堡套餐', menu);
  assert.strictEqual(m.matched, true);
  assert.strictEqual(m.meal.code, '9900016010');
  const m2 = matchMeal('龙焰芝士棒鸡腿堡', menu);
  assert.strictEqual(m2.matched, true);
  assert.strictEqual(m2.meal.code, '9900016075');
});

test('大小写与空格归一化', () => {
  const m = matchMeal('  中薯条  ', menu);
  assert.strictEqual(m.matched, true);
  assert.strictEqual(m.meal.code, '9900016003');
});

test('匹配不到时返回候选列表', () => {
  const m = matchMeal('麦辣鸡腿披萨', menu);
  assert.strictEqual(m.matched, false);
  // 候选里应包含字形相近的品项，供用户修正
  assert.ok(m.candidates.length >= 1);
  assert.ok(m.candidates.some((c) => c.name === '麦辣鸡腿堡'));
});

test('匹配不到：完全无关的名字不给瞎猜', () => {
  const m = matchMeal('北京烤鸭', menu);
  assert.strictEqual(m.matched, false);
  assert.strictEqual(m.candidates.length, 0);
});

test('score：完全匹配 100 分，包含关系 > 模糊重合', () => {
  assert.strictEqual(score('中薯条', '中薯条'), 100);
  assert.ok(score('巨无霸', '巨无霸套餐') > score('薯条堡', '巨无霸套餐'));
});

test('flattenMeals：meals 对象映射表摊平 + 元转分', () => {
  const list = flattenMeals({
    categories: [{ name: '人气热卖', meals: [] }],
    meals: {
      '9900016075': {
        name: '龙焰芝士棒鸡腿堡三件套',
        image: 'https://img.mcd.cn/prod/9900016075.png',
        currentPrice: '29.9',
        originalPrice: '51.5',
        canWithOrder: false,
      },
    },
  });
  assert.strictEqual(list.length, 1);
  const m = list[0];
  assert.strictEqual(m.code, '9900016075');
  assert.strictEqual(m.currentPriceFen, 2990); // 29.9 元 → 2990 分
  assert.strictEqual(m.originalPriceFen, 5150); // 51.5 元 → 5150 分
});

test('yuanToFen：避免浮点误差', () => {
  assert.strictEqual(yuanToFen('29.9'), 2990);
  assert.strictEqual(yuanToFen('51.5'), 5150);
  assert.strictEqual(yuanToFen(0.1), 10);
  assert.strictEqual(yuanToFen('0.29'), 29);
});
