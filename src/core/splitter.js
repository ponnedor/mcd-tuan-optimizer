'use strict';

/**
 * AA 分摊（纯函数）
 *
 * 规则：优惠按各人商品小计占商品总价的比例分配（内部全部分单位整数运算）。
 * 正确性约束：分摊总额与订单实付严格对平，尾差（≤2 分）归发起人。
 */

/**
 * 最大余额法：把 total 按权重 weights 精确分配为整数数组，Σ结果 === total。
 * 全程整数运算，避免浮点误差。
 * @param {number} total 待分配总额（分）
 * @param {number[]} weights 权重（各人原价小计，分）
 */
function largestRemainder(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0 || total === 0) return weights.map(() => 0);
  const nums = weights.map((w) => total * w); // 整数乘法
  const floors = nums.map((x) => Math.floor(x / sumW));
  const remainders = nums.map((x) => x % sumW);
  let rest = total - floors.reduce((a, b) => a + b, 0);
  // 余数大者先补 1
  const order = remainders
    .map((r, i) => ({ i, r }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  let k = 0;
  while (rest > 0 && order.length > 0) {
    floors[order[k % order.length].i] += 1;
    rest -= 1;
    k += 1;
  }
  // total 为负（异常场景）时从余数最小者扣减
  while (rest < 0 && order.length > 0) {
    const idx = order[(order.length - 1 - (Math.abs(rest) - 1)) % order.length].i;
    if (floors[idx] > 0) {
      floors[idx] -= 1;
      rest += 1;
    } else break;
  }
  return floors;
}

/**
 * 计算每人分摊。
 * @param {object} params
 * @param {Array<{name:string, originalFen:number}>} params.shares 各人原价小计（分）
 * @param {number} params.priceFen 订单实付（分，来自 calculate-price 的 price）
 * @param {number} params.discountFen 订单优惠总额（分）
 * @returns {{shares:Array<{name,originalFen,discountFen,payFen}>, residualFen:number, initiator:string|null, balanced:boolean}}
 */
function splitBill({ shares, priceFen, discountFen }) {
  const list = (shares || []).map((s) => ({
    name: s.name,
    originalFen: Math.max(0, Math.round(s.originalFen || 0)),
  }));
  const discount = Math.max(0, Math.round(discountFen || 0));
  const price = Math.round(priceFen || 0);

  let allocs = largestRemainder(discount, list.map((s) => s.originalFen));

  // 保护：任何人的优惠分摊不得超过其原价小计（避免负应付），超出部分按剩余容量重分
  for (let guard = 0; guard < list.length + 1; guard++) {
    let excess = 0;
    const capped = allocs.map((a, i) => {
      if (a > list[i].originalFen) {
        excess += a - list[i].originalFen;
        return list[i].originalFen;
      }
      return a;
    });
    if (excess === 0) {
      allocs = capped;
      break;
    }
    const capacity = list.map((s, i) => s.originalFen - capped[i]);
    const extra = largestRemainder(excess, capacity);
    allocs = capped.map((a, i) => a + extra[i]);
  }

  const result = list.map((s, i) => ({
    name: s.name,
    originalFen: s.originalFen,
    discountFen: allocs[i],
    payFen: s.originalFen - allocs[i],
  }));

  // 对平校验：Σ应付 vs 订单实付；差额归发起人（第一个人）
  const sumPay = result.reduce((a, r) => a + r.payFen, 0);
  const residualFen = price - sumPay;
  if (result.length > 0) {
    result[0].payFen += residualFen; // 尾差归发起人
    result[0].discountFen -= residualFen;
  }
  return {
    shares: result,
    residualFen,
    initiator: result.length > 0 ? result[0].name : null,
    balanced: Math.abs(residualFen) <= 2, // 核心正确性约束
  };
}

module.exports = { splitBill, largestRemainder };
