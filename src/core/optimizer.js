'use strict';

/**
 * 券分配搜索 + 凑单建议（纯函数，价格裁判由外部注入）
 *
 * 设计：
 * - 「真实价」永远由注入的 priceFn（calculate-price 或演示 oracle）裁决，
 *   本模块只负责组合搜索，不自己算优惠 —— 保证与真实结算一致。
 * - 商品数 ≤ 15、券数 ≤ 8 且组合数在预算内：直接穷举笛卡尔积；
 *   超出时：单券探测 → 按预期折扣贪心叠加 → 局部验证微调。
 * - 受 600 次/分钟约束，由 callBudget 控制调用次数上限。
 * - 凑单建议：从单价最低的候选里逐个试算，给出「加 X 后实付从 A 变为 B，净省 C」。
 */

/**
 * 组装 calculate-price 的 items 行；一行只能挂一张券，冲突返回 null。
 * @param {Array<{productCode,quantity}>} items
 * @param {Array<{couponId,couponCode,...}>} coupons
 * @param {number[]} assignment assignment[ci] = 挂到的商品行下标，-1 为不使用
 */
function buildLines(items, coupons, assignment) {
  const occupied = new Set();
  const lines = items.map((it) => ({
    productCode: it.productCode,
    quantity: it.quantity,
  }));
  for (let ci = 0; ci < coupons.length; ci++) {
    const ii = assignment[ci];
    if (ii == null || ii < 0) continue;
    if (occupied.has(ii)) return null; // 同一商品行只能挂一张券
    occupied.add(ii);
    lines[ii].couponId = coupons[ci].couponId;
    lines[ii].couponCode = coupons[ci].couponCode;
  }
  return lines;
}

/** 券的可挂候选行：productCodes 为空视为可挂任意商品（如满减券） */
function candidateItems(items, coupon) {
  const codes = coupon.productCodes;
  if (!codes || codes.length === 0) return items.map((_, i) => i);
  const set = new Set(codes);
  return items.map((it, i) => (set.has(it.productCode) ? i : -1)).filter((i) => i >= 0);
}

/**
 * 三阶段优化：建篮基准价 → 券分配搜索 → （凑单建议由 suggestAddons 单独执行）
 *
 * @param {object} params
 * @param {Array<{productCode:string,name:string,quantity:number}>} params.items 拼单篮
 * @param {Array<{couponId,couponCode,title,productCodes:string[]}>} params.coupons 门店可用券
 * @param {Function} params.priceFn async (lines) => {price,originalPrice,discount,productList}（分）
 * @param {number} [params.callBudget] calculate-price 调用次数上限（默认 300，600/分钟红线内）
 * @param {Function} [params.onProgress] 进度回调 (message) => void
 * @param {Function} [params.onBase] 基准价回调 ({price}) => void（演示网站逐帧动画用）
 * @param {Function} [params.onEval] 每次真实算价回调 ({done,total,price,bestPrice}) => void
 * @returns {Promise<{base, best:{assignment,result}, coupons, items, calls, mode, combos}>}
 */
async function optimizeBasket({
  items,
  coupons,
  priceFn,
  callBudget = 300,
  onProgress = () => {},
  onBase = null,
  onEval = null,
}) {
  let calls = 0;
  const canCall = () => calls < callBudget;

  // 阶段一：建篮，算基准价（不用任何券）
  const base = await priceFn(items.map((it) => ({
    productCode: it.productCode,
    quantity: it.quantity,
  })));
  calls += 1;
  if (onBase) onBase({ price: base.price });
  let best = {
    assignment: coupons.map(() => -1),
    result: base,
  };

  // 每张券的候选行
  const usable = [];
  coupons.forEach((coupon, ci) => {
    const cand = candidateItems(items, coupon);
    if (cand.length > 0) usable.push({ ci, cand });
  });
  const totalCombos = usable.reduce((acc, u) => acc * (u.cand.length + 1), 1);
  let evaluated = 0;
  const reportEval = (r, total) => {
    if (onEval) onEval({ done: evaluated, total, price: r.price, bestPrice: best.result.price });
  };

  const recordBest = (assignment, result) => {
    if (result.price < best.result.price) {
      best = { assignment: assignment.slice(), result };
    }
  };

  if (totalCombos + 1 <= callBudget) {
    // ---------- 穷举笛卡尔积 ----------
    onProgress(`穷举 ${totalCombos} 种券组合（最多 ${calls + totalCombos} 次真实算价，冲突组合自动跳过）…`);
    const assignment = coupons.map(() => -1);
    const allUnused = () => assignment.every((a) => a < 0);
    const dfs = async (k) => {
      if (k === usable.length) {
        if (allUnused()) return; // 全不用的组合即基准价，已算过
        const lines = buildLines(items, coupons, assignment);
        if (!lines) return;
        const r = await priceFn(lines);
        calls += 1;
        evaluated += 1;
        recordBest(assignment, r);
        reportEval(r, totalCombos);
        return;
      }
      const { ci, cand } = usable[k];
      assignment[ci] = -1;
      await dfs(k + 1);
      for (const ii of cand) {
        assignment[ci] = ii;
        await dfs(k + 1);
      }
      assignment[ci] = -1;
    };
    await dfs(0);
    return { base, best, coupons, items, calls, mode: 'exhaustive', combos: totalCombos };
  }

  // ---------- 贪心 + 局部验证 ----------
  onProgress(`组合数 ${totalCombos} 超出预算，改用贪心剪枝 + 局部验证…`);

  // 1) 单券探测：每张券单独挂到每个候选行试一次，记录单券最优
  const solo = [];
  for (const u of usable) {
    let rec = null;
    for (const ii of u.cand) {
      if (!canCall()) break;
      const assignment = coupons.map(() => -1);
      assignment[u.ci] = ii;
      const lines = buildLines(items, coupons, assignment);
      if (!lines) continue;
      const r = await priceFn(lines);
      calls += 1;
      evaluated += 1;
      recordBest(assignment, r);
      reportEval(r, null);
      if (!rec || r.price < rec.price) rec = { price: r.price, ii };
    }
    if (rec) solo.push({ ci: u.ci, price: rec.price, ii: rec.ii });
  }
  solo.sort((a, b) => a.price - b.price); // 优先预期折扣大的券

  // 2) 贪心叠加
  let current = coupons.map(() => -1);
  let currentPrice = base.price;
  const occupied = new Set();
  for (const s of solo) {
    if (!canCall()) break;
    if (occupied.has(s.ii)) continue;
    const trial = current.slice();
    trial[s.ci] = s.ii;
    const lines = buildLines(items, coupons, trial);
    if (!lines) continue;
    const r = await priceFn(lines);
    calls += 1;
    evaluated += 1;
    if (r.price < currentPrice) {
      current = trial;
      currentPrice = r.price;
      occupied.add(s.ii);
      recordBest(trial, r);
    }
    reportEval(r, null);
  }

  // 3) 局部验证：已用券换挂其他候选行，持续改进
  for (let guard = 0; guard < 3 && canCall(); guard++) {
    let improved = false;
    for (const u of usable) {
      for (const ii of u.cand) {
        if (!canCall()) break;
        if (current[u.ci] === ii) continue;
        const trial = current.slice();
        trial[u.ci] = ii;
        const lines = buildLines(items, coupons, trial);
        if (!lines) continue;
        const r = await priceFn(lines);
        calls += 1;
        evaluated += 1;
        if (r.price < currentPrice) {
          current = trial;
          currentPrice = r.price;
          recordBest(trial, r);
          improved = true;
        }
        reportEval(r, null);
      }
    }
    if (!improved) break;
  }

  return { base, best, coupons, items, calls, mode: 'greedy', combos: totalCombos };
}

/**
 * 凑单建议：逐个试算最便宜的候选项，看实付是否还能降。
 * 覆盖典型场景：满减券门槛未达 → 加低价小食/饮品触发更高档优惠。
 *
 * @param {object} params
 * @param {Array} params.items 当前拼单篮
 * @param {Array} params.coupons 门店可用券
 * @param {number[]} params.assignment 当前最优券分配
 * @param {Array<{productCode,name,unitPriceFen}>} params.addonCandidates 单价升序的凑单候选
 * @param {Function} params.priceFn 同 optimizeBasket
 * @param {number} [params.currentPriceFen] 当前最优实付（分）
 * @param {number} [params.callBudget] 调用次数上限
 * @returns {Promise<{addon,newPriceFen,savingFen,assignment}|null>}
 */
async function suggestAddons({
  items,
  coupons,
  assignment,
  addonCandidates,
  priceFn,
  currentPriceFen,
  callBudget = 20,
  onProgress = () => {},
}) {
  let calls = 0;
  let bestSug = null;
  const inBasket = new Set(items.map((i) => i.productCode));
  const cands = (addonCandidates || [])
    .filter((a) => !inBasket.has(a.productCode))
    .slice(0, 8);

  for (const addon of cands) {
    if (calls >= callBudget) break;
    const newItems = [
      ...items,
      { productCode: addon.productCode, name: addon.name, quantity: 1, unitPriceFen: addon.unitPriceFen },
    ];
    const addonIdx = newItems.length - 1;

    // 变体 A：维持当前券分配
    const variants = [assignment.slice()];
    // 变体 B：未使用的券尝试挂到新增行（覆盖"满减券门槛差一点"的场景）
    for (let ci = 0; ci < coupons.length && variants.length < 4; ci++) {
      if (assignment[ci] >= 0) continue;
      const cp = coupons[ci];
      const applies =
        !cp.productCodes || cp.productCodes.length === 0 || cp.productCodes.includes(addon.productCode);
      if (applies) {
        const a2 = assignment.slice();
        a2[ci] = addonIdx;
        variants.push(a2);
      }
    }

    let addonBest = null;
    for (const v of variants) {
      if (calls >= callBudget) break;
      const lines = buildLines(newItems, coupons, v);
      if (!lines) continue;
      const r = await priceFn(lines);
      calls += 1;
      if (r.price < currentPriceFen && (!addonBest || r.price < addonBest.price)) {
        addonBest = { price: r.price, assignment: v };
      }
    }
    if (addonBest) {
      const savingFen = currentPriceFen - addonBest.price;
      if (!bestSug || savingFen > bestSug.savingFen) {
        bestSug = { addon, newPriceFen: addonBest.price, savingFen, assignment: addonBest.assignment };
      }
    }
  }
  onProgress(`凑单试算 ${calls} 次…`);
  return bestSug;
}

module.exports = { optimizeBasket, suggestAddons, buildLines, candidateItems };
