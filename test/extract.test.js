'use strict';

/** 测试二：MCP 响应 JSON 提取（SSE 剥壳 / 说明文字+内嵌 JSON / structuredContent 优先） */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  parseResponseBody,
  extractBusinessJson,
  resolveResult,
  McpClient,
} = require('../src/mcp/client');
const { digData } = require('../src/mcp/tools');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const read = (f) => fs.readFileSync(path.join(FIXTURES, f), 'utf8');

test('纯 JSON 响应（initialize 200）可直接解析', () => {
  const json = parseResponseBody(read('sse-plain.txt'));
  assert.strictEqual(json.jsonrpc, '2.0');
  assert.strictEqual(json.result.serverInfo.name, 'mcd-mcp');
});

test('SSE 响应剥掉 data: 前缀后可解析', () => {
  const json = parseResponseBody(read('sse-tools-call.txt'));
  assert.strictEqual(json.jsonrpc, '2.0');
  assert.ok(json.result.content[0].text.includes('{"success"'));
});

test('HTTP 202 空响应返回 null（直接继续即可）', () => {
  assert.strictEqual(parseResponseBody(''), null);
  assert.strictEqual(parseResponseBody('   \r\n'), null);
});

test('从「给 LLM 看的说明文字 + 内嵌 JSON」提取业务 JSON', () => {
  const biz = extractBusinessJson(read('mixed-text.txt'));
  assert.strictEqual(biz.success, true);
  // query-meals 价格是元（字符串）
  assert.strictEqual(biz.data.meals['9900016075'].currentPrice, '29.9');
  assert.strictEqual(biz.data.meals['9900016075'].name, '龙焰芝士棒鸡腿堡三件套');
});

test('提取失败返回 null（无内嵌 JSON）', () => {
  assert.strictEqual(extractBusinessJson('纯说明文字，没有 JSON'), null);
  assert.strictEqual(extractBusinessJson(''), null);
});

test('structuredContent 优先于 content 文本', () => {
  const json = JSON.parse(read('tools-call-structured.json'));
  const r = resolveResult(json);
  assert.strictEqual(r.data.price, 8500);
  assert.ok(Array.isArray(r.data.productList)); // 只在 structuredContent 里
});

test('resolveResult 从混排文本响应中解析业务 JSON', () => {
  const dataLine = read('sse-tools-call.txt')
    .split(/\r?\n/)
    .find((line) => line.startsWith('data:'));
  const json = JSON.parse(dataLine.replace(/^data:\s*/, ''));
  const r = resolveResult(json);
  assert.strictEqual(r.success, true);
  assert.strictEqual(r.data[0].storeCode, '1950526');
  assert.strictEqual(r.data[0].storeName, '北京新东安二号餐厅');
});

test('digData 取出业务 data 字段', () => {
  const data = digData(JSON.parse(read('store-coupons.json')));
  assert.ok(Array.isArray(data));
  assert.strictEqual(data[0].title, '中薯条买一送一');
  assert.strictEqual(data[0].products[0].productCode, '9900016003');
});

test('digData 兼容双层 data 结构', () => {
  const data = digData({ success: true, data: { success: true, data: [1, 2] } });
  assert.deepStrictEqual(data, [1, 2]);
});

/* ---------- 完整客户端链路（注入 fetch，不发真实请求） ---------- */

function seqFetch(responses) {
  let i = 0;
  const seen = [];
  const fn = async (url, opts) => {
    seen.push({ url, opts });
    const r = responses[i++];
    if (!r) throw new Error('unexpected extra fetch');
    return { status: r.status, text: async () => r.body };
  };
  fn.seen = seen;
  return fn;
}

test('完整链路：initialize → notifications/initialized → tools/call（SSE 响应）', async () => {
  const fetchImpl = seqFetch([
    {
      status: 200,
      body: '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","serverInfo":{"name":"mcd-mcp","version":"1.2.0"}}}',
    },
    { status: 202, body: '' },
    { status: 200, body: read('sse-tools-call.txt') },
  ]);
  const client = new McpClient({ token: 'test-token', throttleMs: 0, fetchImpl });
  const biz = await client.callTool('query-nearby-stores', {
    city: '北京',
    keyword: '王府井',
  });
  assert.strictEqual(biz.success, true);
  assert.strictEqual(biz.data[0].storeCode, '1950526');

  // 三个独立 POST
  assert.strictEqual(fetchImpl.seen.length, 3);
  // 请求头正确（Bearer 后有空格）
  const h = fetchImpl.seen[0].opts.headers;
  assert.strictEqual(h.Authorization, 'Bearer test-token');
  assert.strictEqual(h['Content-Type'], 'application/json');
  assert.strictEqual(h.Accept, 'application/json, text/event-stream');
  // 协议流程正确
  const bodies = fetchImpl.seen.map((s) => JSON.parse(s.opts.body));
  assert.strictEqual(bodies[0].method, 'initialize');
  assert.strictEqual(bodies[1].method, 'notifications/initialized');
  assert.strictEqual('id' in bodies[1], false); // notifications 无 id
  assert.strictEqual(bodies[2].method, 'tools/call');
  assert.strictEqual(bodies[2].params.name, 'query-nearby-stores');
});

test('initialize 允许 202 空响应', async () => {
  const fetchImpl = seqFetch([
    { status: 202, body: '' },
    { status: 202, body: '' },
    { status: 200, body: read('sse-tools-call.txt') },
  ]);
  const client = new McpClient({ token: 'test-token', throttleMs: 0, fetchImpl });
  const biz = await client.callTool('query-nearby-stores', {});
  assert.strictEqual(biz.success, true);
});

test('缺 Token：构造即报人话错误（指引 open.mcd.cn/mcp）', () => {
  const saved = process.env.MCD_TOKEN;
  delete process.env.MCD_TOKEN;
  try {
    assert.throws(
      () => new McpClient({ fetchImpl: async () => ({}) }),
      (e) => e.code === 'NO_TOKEN' && /open\.mcd\.cn/.test(e.message)
    );
  } finally {
    if (saved !== undefined) process.env.MCD_TOKEN = saved;
  }
});

test('401 时提示重新申请 Token', async () => {
  const fetchImpl = seqFetch([{ status: 401, body: '' }]);
  const client = new McpClient({ token: 'bad-token', throttleMs: 0, fetchImpl });
  await assert.rejects(
    () => client.callTool('query-meals', {}),
    (e) => e.code === 'AUTH' && /open\.mcd\.cn/.test(e.message)
  );
});

test('429 限流时给出人话提示', async () => {
  const fetchImpl = seqFetch([
    { status: 202, body: '' },
    { status: 202, body: '' },
    { status: 429, body: '' },
  ]);
  const client = new McpClient({ token: 't', throttleMs: 0, fetchImpl });
  await assert.rejects(
    () => client.callTool('query-meals', {}),
    (e) => e.code === 'RATE_LIMIT' && /600/.test(e.message)
  );
});

test('节流：连续请求间隔不小于设定值', async () => {
  const fetchImpl = seqFetch([
    { status: 202, body: '' },
    { status: 202, body: '' },
    { status: 200, body: read('sse-tools-call.txt') },
    { status: 200, body: read('sse-tools-call.txt') },
  ]);
  const client = new McpClient({ token: 't', throttleMs: 120, fetchImpl });
  const t0 = Date.now();
  await client.callTool('query-nearby-stores', {});
  await client.callTool('query-nearby-stores', {});
  const elapsed = Date.now() - t0;
  // 5 次请求（2 次握手 + 2 次 tools/call + 1 次重复? 实际 4 次）至少间隔 3×120ms
  assert.ok(elapsed >= 300, `elapsed=${elapsed} 应 ≥ 300ms`);
});
