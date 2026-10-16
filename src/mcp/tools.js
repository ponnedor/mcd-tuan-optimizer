'use strict';

/**
 * 麦当劳 MCP 工具的语义化封装（仅只读工具 + 一键领券，绝不真实下单）
 *
 * 安全红线：本文件之外任何地方不得出现下单类工具调用。
 * 只允许：query-nearby-stores / query-meals / available-coupons /
 *         query-my-coupons / auto-bind-coupons / query-store-coupons / calculate-price
 * 严禁：create-order / cancel-order / mall-create-order / party-order-create /
 *       draw-lottery / delivery-create-address 等任何下单/写类工具。
 */

const { McpClient } = require('./client');

/**
 * 从业务 JSON 中取出 data 字段；兼容极少数双层 {data:{data:...}} 结构。
 * query-meals 的价格是元（字符串）；calculate-price 的价格是分（整数）——调用方负责换算。
 */
function digData(biz) {
  if (biz && typeof biz === 'object' && biz.data !== undefined) {
    const d = biz.data;
    if (
      d &&
      typeof d === 'object' &&
      !Array.isArray(d) &&
      d.data !== undefined &&
      d.success !== undefined
    ) {
      return d.data;
    }
    return d;
  }
  return biz;
}

class McdTools {
  constructor(opts = {}) {
    this.client = opts.client || new McpClient(opts);
  }

  /** 找店（到店自取 beType=1，按城市+关键词搜索 searchType=2）→ data[]{storeCode,storeName,address,distance,beCode} */
  async queryNearbyStores({ city, keyword, beType = 1, searchType = 2 } = {}) {
    const biz = await this.client.callTool('query-nearby-stores', {
      beType,
      searchType,
      city,
      keyword,
    });
    return digData(biz) || [];
  }

  /** 门店菜单 → data{categories[], meals{code→{name,image,currentPrice,originalPrice,canWithOrder}}}，价格单位：元（字符串） */
  async queryMeals({ storeCode, orderType = 1, beType = 1 } = {}) {
    const biz = await this.client.callTool('query-meals', {
      storeCode,
      orderType,
      beType,
    });
    return digData(biz) || { categories: [], meals: {} };
  }

  /** 当前可领的券（无参） */
  async availableCoupons() {
    const biz = await this.client.callTool('available-coupons', {});
    return digData(biz) || [];
  }

  /** 我的卡包券 → data{coupons[]}（初始为空数组） */
  async queryMyCoupons({ page = 1, pageSize = 20 } = {}) {
    const biz = await this.client.callTool('query-my-coupons', {
      page,
      pageSize,
    });
    const data = digData(biz);
    return data && data.coupons !== undefined ? data : { coupons: [] };
  }

  /** 一键领取所有可领的券（唯一允许的写操作）→ data[]{couponId,couponCode,title,...} */
  async autoBindCoupons() {
    const biz = await this.client.callTool('auto-bind-coupons', {});
    return digData(biz) || [];
  }

  /** 指定门店可用券 → data[]{title,couponId,couponCode,tradeDateTime,products[]{productName,productCode}}（同券 ID 可多券码） */
  async queryStoreCoupons({ storeCode, orderType = 1, beType = 1 } = {}) {
    const biz = await this.client.callTool('query-store-coupons', {
      storeCode,
      orderType,
      beType,
    });
    return digData(biz) || [];
  }

  /**
   * 真实算价（优化器的「裁判」）→ data{originalPrice,discount,price,productList[]}，价格单位：分（整数）
   * items 支持逐商品挂 couponId/couponCode —— 这是组合优化的关键能力。
   */
  async calculatePrice({
    storeCode,
    items,
    needTableware = false,
    orderType = 1,
    beType = 1,
  } = {}) {
    const biz = await this.client.callTool('calculate-price', {
      storeCode,
      orderType,
      beType,
      items,
      needTableware,
    });
    return digData(biz) || {};
  }
}

module.exports = { McdTools, digData };
