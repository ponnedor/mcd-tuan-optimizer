'use strict';

/**
 * 离线演示数据（--demo 模式，无需 Token 即可跑通全流程，方便评委/路人体验）
 *
 * 菜品/门店样例取自真实接口的实测片段（storeCode 1950526 北京新东安二号餐厅、
 * 龙焰芝士棒鸡腿堡三件套 currentPrice "29.9" / originalPrice "51.5" 等）。
 * 演示 oracle 模拟 calculate-price 的真实语义（分单位），优化器对此无感知。
 */

const storeCode = '1950526';
const storeName = '北京新东安二号餐厅';

// 菜单（结构与 query-meals 返回一致：categories + meals 对象映射表，价格单位：元/字符串）
const categories = [
  { name: '人气热卖', meals: ['9900016001', '9900016010', '9900016075'] },
  { name: '鸡肉汉堡', meals: ['9900016002'] },
  { name: '小食拼盘', meals: ['9900016003', '9900016004', '9900016009', '9900016011'] },
  { name: '甜品小食', meals: ['9900016006', '9900016007', '9900016008'] },
  { name: '饮品', meals: ['9900016005'] },
];

const meals = {
  '9900016001': { name: '巨无霸套餐', currentPrice: '39.5', originalPrice: '45.0' },
  '9900016010': { name: '麦辣鸡腿堡套餐', currentPrice: '34.5', originalPrice: '40.0' },
  '9900016075': { name: '龙焰芝士棒鸡腿堡三件套', currentPrice: '29.9', originalPrice: '51.5' },
  '9900016002': { name: '麦辣鸡腿堡', currentPrice: '22.5', originalPrice: '25.0' },
  '9900016004': { name: '那么大鸡排', currentPrice: '23.0', originalPrice: '26.0' },
  '9900016003': { name: '中薯条', currentPrice: '13.5', originalPrice: '14.5' },
  '9900016009': { name: '麦乐鸡(5块)', currentPrice: '19.5', originalPrice: '23.0' },
  '9900016011': { name: '王牌小食拼', currentPrice: '32.5', originalPrice: '45.0' },
  '9900016006': { name: '菠萝派', currentPrice: '6.5', originalPrice: '8.0' },
  '9900016007': { name: '香芋派', currentPrice: '6.5', originalPrice: '8.0' },
  '9900016005': { name: '可口可乐(中杯)', currentPrice: '9.5', originalPrice: '11.0' },
  '9900016008': { name: '圆筒冰淇淋', currentPrice: '4.5', originalPrice: '6.0' },
};

// 演示拼单意愿（3 人）
const wishlist = {
  storeCode,
  budget: 100,
  people: [
    { name: '张三', wants: [{ name: '巨无霸套餐', quantity: 1 }] },
    { name: '李四', wants: [{ name: '麦辣鸡腿堡套餐', quantity: 1 }, { name: '中薯条', quantity: 1 }] },
    { name: '王五', wants: [{ name: '麦辣鸡腿堡', quantity: 1 }, { name: '中薯条', quantity: 1 }] },
  ],
};

// 演示券（demoType 仅供演示 oracle 使用；优化器只认 couponId/couponCode/productCodes）
const coupons = [
  {
    couponId: 'C001',
    couponCode: 'BOGO_FRIES',
    title: '中薯条买一送一',
    demoType: 'bogo',
    productCodes: ['9900016003'],
  },
  {
    couponId: 'C002',
    couponCode: 'OFF_100_30',
    title: '满100减30',
    demoType: 'threshold',
    thresholdFen: 10000,
    amountFen: 3000,
    productCodes: [], // 挂任意商品即可生效
  },
  {
    couponId: 'C003',
    couponCode: 'OFF_130_40',
    title: '满130减40',
    demoType: 'threshold',
    thresholdFen: 13000,
    amountFen: 4000,
    productCodes: [],
  },
  {
    couponId: 'C004',
    couponCode: 'SNACK_8OFF',
    title: '王牌小食拼立减8元',
    demoType: 'item-off',
    amountFen: 800,
    productCodes: ['9900016011'], // 拼单篮里没有 → 不可用（演示"不是每张券都用得上"）
  },
];

function yuanToFen(s) {
  return Math.round(Number(s) * 100);
}

/** 摊平后的菜单列表（供匹配/凑单候选使用） */
function menuList() {
  return Object.entries(meals).map(([code, m]) => ({
    code,
    name: m.name,
    currentPrice: m.currentPrice,
    originalPrice: m.originalPrice,
    currentPriceFen: yuanToFen(m.currentPrice),
    originalPriceFen: yuanToFen(m.originalPrice),
  }));
}

/**
 * 演示算价 oracle：模拟 calculate-price 的真实语义。
 * - 单品行挂券：bogo（买一送一，每 2 件免 1 件）/ item-off（立减）
 * - 满减券（threshold）：挂在任意行生效，多张满足门槛时取优惠最大的一张
 * - 全部分单位整数运算
 */
function createPriceFn() {
  const byCode = new Map(Object.entries(meals).map(([code, m]) => [code, m]));
  const byCouponId = new Map(coupons.map((c) => [c.couponId, c]));
  return async (lines) => {
    const productList = [];
    let original = 0;
    const attached = [];
    lines.forEach((line, idx) => {
      const meal = byCode.get(line.productCode);
      if (!meal) return;
      const originalSubtotal = yuanToFen(meal.currentPrice) * line.quantity;
      original += originalSubtotal;
      productList.push({
        productCode: line.productCode,
        productName: meal.name,
        quantity: line.quantity,
        originalSubtotal,
        subtotal: originalSubtotal,
      });
      if (line.couponId) {
        const cp = byCouponId.get(line.couponId);
        if (cp) attached.push({ cp, line, idx });
      }
    });
    let discount = 0;
    let thresholdBest = 0;
    for (const { cp, line, idx } of attached) {
      if (cp.demoType === 'threshold') {
        if (original >= cp.thresholdFen) {
          thresholdBest = Math.max(thresholdBest, cp.amountFen);
        }
      } else if (cp.demoType === 'bogo') {
        const freeQty = Math.floor(line.quantity / 2);
        if (freeQty > 0) {
          const d = yuanToFen(byCode.get(line.productCode).currentPrice) * freeQty;
          discount += d;
          productList[idx].subtotal -= d;
        }
      } else if (cp.demoType === 'item-off') {
        discount += cp.amountFen;
        productList[idx].subtotal -= cp.amountFen;
      }
    }
    discount += thresholdBest;
    return {
      price: original - discount,
      originalPrice: original,
      discount,
      productList,
    };
  };
}

/** 凑单候选：优先小食/甜品/饮品，按单价升序 */
function addonCandidates() {
  const prefer = new Set(['小食拼盘', '甜品小食', '饮品']);
  const list = menuList();
  const preferred = list.filter((m) => {
    const cat = categories.find((c) => c.meals.includes(m.code));
    return cat && prefer.has(cat.name);
  });
  const pool = preferred.length >= 5 ? preferred : list;
  return pool.slice().sort((a, b) => a.currentPriceFen - b.currentPriceFen);
}

module.exports = {
  storeCode,
  storeName,
  categories,
  meals,
  wishlist,
  coupons,
  menuList,
  createPriceFn,
  addonCandidates,
};
