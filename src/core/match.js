'use strict';

/**
 * 菜单名称模糊匹配（纯函数）
 *
 * 输入用自然语言（"巨无霸" / "麦辣鸡腿堡套餐" / "可乐"），
 * 菜单是 118 个餐品（"巨无霸套餐" / "麦辣鸡腿堡三件套" / "可口可乐(中杯)"）。
 * 评分策略：归一化完全匹配 > 包含关系 > 最长公共子串占比 + 字符重合度。
 */

/** 元字符串价格 → 分（整数），避免浮点误差：Math.round(29.9*100)=2990 */
function yuanToFen(yuanStr) {
  const n = Number(yuanStr);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

function normalize(name) {
  return String(name == null ? '' : name)
    .toLowerCase()
    .replace(/\s+/g, '') // 去空白
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/[·・。.,，、!！?？]/g, '');
}

/** 最长公共子串长度（O(n*m)，餐品名很短，足够快） */
function longestCommonSubstring(a, b) {
  if (!a || !b) return 0;
  let best = 0;
  let prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        cur[j] = prev[j - 1] + 1;
        if (cur[j] > best) best = cur[j];
      }
    }
    prev = cur;
  }
  return best;
}

/** 查询名 vs 菜单品名 的匹配得分（0 ~ 100） */
function score(query, mealName) {
  const q = normalize(query);
  const m = normalize(mealName);
  if (!q || !m) return 0;
  if (q === m) return 100;
  if (m.includes(q) || q.includes(m)) {
    return (
      85 + (Math.min(q.length, m.length) / Math.max(q.length, m.length)) * 10
    );
  }
  const lcs = longestCommonSubstring(q, m);
  const r1 = lcs / q.length; // 查询被覆盖程度
  const mealChars = new Set(m);
  let hit = 0;
  for (const ch of q) if (mealChars.has(ch)) hit++;
  const overlap = hit / q.length;
  if (r1 >= 0.5) return 40 + r1 * 40 + overlap * 10;
  if (overlap >= 0.7) return 30 + overlap * 20;
  return 0;
}

/**
 * 模糊匹配一个餐品名。
 * 阈值 75：完全/包含匹配稳过；「后缀变体」（如 套餐↔三件套）可通过
 * 最长公共子串占比过线；仅字符相近但语义不同的（如 披萨↔堡）不过线，走候选列表。
 * @param {string} query 用户输入名
 * @param {Array<{code:string,name:string,...}>} meals 菜单品列表
 * @returns {{matched:boolean, meal:Object|null, candidates:Array, score:number}}
 */
function matchMeal(query, meals) {
  const scored = (meals || [])
    .map((meal) => ({ meal, s: score(query, meal.name) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.meal.name.length - b.meal.name.length);
  const best = scored[0];
  return {
    matched: Boolean(best && best.s >= 75),
    meal: best ? best.meal : null,
    candidates: scored.slice(0, 5).map((x) => x.meal),
    score: best ? best.s : 0,
  };
}

/**
 * 把 query-meals 的 meals 对象映射表摊平成列表，并预计算分单位价格。
 * @param {{categories:Array, meals:Object}} mealsData
 * @returns {Array<{code,name,currentPriceFen,originalPriceFen,currentPrice,originalPrice,...}>}
 */
function flattenMeals(mealsData) {
  const mealsMap = (mealsData && mealsData.meals) || {};
  return Object.entries(mealsMap).map(([code, m]) => ({
    code,
    name: m.name,
    currentPrice: m.currentPrice,
    originalPrice: m.originalPrice,
    currentPriceFen: yuanToFen(m.currentPrice), // 元(字符串) → 分(整数)
    originalPriceFen: yuanToFen(m.originalPrice),
  }));
}

module.exports = { matchMeal, flattenMeals, score, normalize, yuanToFen };
