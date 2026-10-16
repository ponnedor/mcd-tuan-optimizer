# MCP_INTEGRATION.md — 麦门拼单官的麦当劳 MCP 接入说明

## 一、使用的 MCP Server

| 项目 | 值 |
| --- | --- |
| 端点 | `https://mcp.mcd.cn` |
| 传输方式 | Streamable HTTP（POST + SSE/JSON 响应） |
| 会话模式 | **无状态**：每个 POST 独立，无需 session id |
| 鉴权 | `Authorization: Bearer <MCD_TOKEN>`（Token 由 `MCD_TOKEN` 环境变量注入，严禁硬编码） |
| 限流 | 每 Token 每分钟 600 次请求（本工具内置 100ms/次节流兜底） |

## 二、实际调用的工具（6 组，全部只读 + 一键领券）

| # | 工具 | 读写 | 用途 | 关键参数 | 本项目用法 |
| --- | --- | --- | --- | --- | --- |
| 1 | `query-nearby-stores` | 读 | 找店 | `beType=1, searchType=2, city, keyword` | `mctuan stores` 命令：按城市+关键词找到店自取门店，取 `storeCode` |
| 2 | `query-meals` | 读 | 门店菜单 | `storeCode, orderType=1, beType=1` | 拉取 15 个分类 / 118 个餐品的映射表，供名称模糊匹配与凑单候选；注意价格是**元**（字符串） |
| 3 | `available-coupons` | 读 | 当前可领券 | 无 | `mctuan grab` 前的预览（标题/图片/状态） |
| 4 | `query-my-coupons` | 读 | 我的卡包 | `page, pageSize` | 领券后核对卡包（初始为空数组） |
| 5 | `auto-bind-coupons` | **写（唯一）** | 一键领券 | 无 | `mctuan grab` 命令：自动领取所有可领的券（实测 7 张，如「中薯条买一送一」） |
| 6 | `query-store-coupons` | 读 | 门店可用券 | `storeCode, orderType=1, beType=1` | 优化器输入：每张券的 `couponId/couponCode/products[]`（同券 ID 可多券码） |
| 7 | `calculate-price` | 读 | 真实算价 | `storeCode, items[]`（逐商品挂 `couponId/couponCode`） | **优化器的「裁判」**：任何组合方案的真实价格只信它；注意返回价格是**分**（整数） |

> 安全红线：只调用以上工具。**严禁** `create-order`、`cancel-order`、`mall-create-order`、`party-order-create`、`draw-lottery`、`delivery-create-address` 等任何下单/写类工具 —— 本工具是「算价参谋」，不做真实下单。代码层面在 `src/mcp/tools.js` 中收敛了全部工具调用面。

## 三、完整调用流程

### 协议层（每个会话一次，逐次发送三个独立 POST）

```
┌──────────────┐     POST initialize (id:1)                ┌──────────────┐
│              │ ────────────────────────────────────────▶ │              │
│  mcd-tuan    │ ◀──────── serverInfo / HTTP 202 ────────── │              │
│  MCP Client  │                                            │  mcp.mcd.cn  │
│ (无状态)      │     POST notifications/initialized (无 id)  │  Streamable  │
│              │ ────────────────────────────────────────▶ │    HTTP      │
│              │ ◀──────────────── HTTP 202 ──────────────  │              │
│              │                                            │              │
│              │     POST tools/call (id:随机)  ×N 次        │              │
│              │ ────────────────────────────────────────▶ │              │
│              │ ◀─ SSE(data:{...}) / JSON，节流 100ms ────  │              │
└──────────────┘                                            └──────────────┘
```

响应解析规则（已实测验证）：
1. HTTP 响应可能是 SSE 格式（`data: {...}`），先剥掉 `data: ` 前缀再 `JSON.parse`；
2. `tools/call` 的业务数据在 `result.content[0].text`，该 text 是「给 LLM 看的说明文字 + 内嵌 JSON」，用正则提取第一个 `{"success"...}` 到最后一个 `}` 的 JSON 段落再 parse；
3. 部分响应有 `result.structuredContent`，优先使用；
4. `initialize` 可能返回 HTTP 202 空响应，直接继续即可。

### 业务链路（`mctuan optimize` 主命令）

```
wishlist.json（每人想吃什么）
      │
      ▼
[1] query-meals ────────▶ 菜单（118 餐品，价格：元/字符串）
      │                     │ 名称模糊匹配（套餐↔三件套、包含、归一化）
      ▼                     ▼
   拼单篮 {productCode, quantity} ── calculate-price ──▶ 基准价 base
      │
      ▼
[2] query-store-coupons ▶ 门店可用券（每券 products[] 限定可挂商品）
      │
      ▼
[3] 券分配搜索（组合数小→穷举笛卡尔积；大→贪心剪枝+局部验证）
      │   每个候选组合都真实调用 calculate-price 验价（分单位）
      ▼
   最优方案（实付最低的券挂法）
      │
      ▼
[4] 凑单建议：单价升序的饮品/小食候选逐一试算
      │   「+1 份菠萝派(¥6.50) → 实付 ¥80.00 → ¥76.50，净省 ¥3.50」
      ▼
[5] AA 分摊：优惠按小计占比分配（最大余额法，分摊和 === 实付）
```

### 单位换算坑（已在代码中统一处理）

- `query-meals` 的 `currentPrice/originalPrice` 是**元**（字符串，如 `"29.9"`）；
- `calculate-price` 返回的 `originalPrice/discount/price/productList[]` 均是**分**（整数）；
- 本工具内部全部用**分**（整数）运算，只在展示层转元，避免浮点误差。

## 四、业务价值分析

1. **高频真实痛点**：办公室/宿舍/课题组拼单点麦当劳是高频场景。N 个人各想吃几样，谁也说不清：怎么凑满减、券给谁用最划算、最后 AA 每人出多少。本工具输入每个人的点餐意愿，自动完成「找店 → 菜单 → 领券 → 组合优化 → 真实算价 → AA 分摊」全流程。
2. **组合优化的真实价值**：券与商品的挂载关系是组合爆炸问题（商品 × 券 × 券码）。人工试算基本不可行；本工具利用 `calculate-price` 支持逐商品挂券的关键能力，把「真实价格」作为唯一裁判做搜索，输出可执行的最优方案（实测演示场景省 35%+）。
3. **AA 对平的工程保证**：优惠按小计占比分配 + 最大余额法整数分摊，分摊之和与订单实付**严格对平**（尾差 ≤2 分归发起人），并用单元测试固化该正确性约束（含 200 组随机压力测试）。
4. **对官方生态的价值**：只读 + 领券的安全边界意味着零下单风险；优化结果天然引导用户加购凑单（提高客单价）并主动领券（提高券核销率），是平台、用户双赢的「算价参谋」。
5. **可复制性**：运行时零第三方依赖（Node ≥18 内置 fetch 即可跑），`--demo` 模式无需 Token 即可体验完整效果，评委/路人 30 秒内可复现。

## 五、接入示例

任何支持 MCP 的客户端（WorkBuddy / Cursor 等）可参考仓库根目录的 `mcp-config.example.json`：

```json
{
  "mcpServers": {
    "mcd": {
      "type": "http",
      "url": "https://mcp.mcd.cn",
      "headers": {
        "Authorization": "Bearer YOUR_MCP_TOKEN",
        "Accept": "application/json, text/event-stream"
      }
    }
  }
}
```

Token 到 [open.mcd.cn/mcp](https://open.mcd.cn/mcp) 申请，通过 `MCD_TOKEN` 环境变量注入，仓库内不含任何真实凭证。
