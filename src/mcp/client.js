'use strict';

/**
 * 麦当劳 MCP 客户端（Streamable HTTP，无状态）
 *
 * 已验证事实：
 * - 端点 https://mcp.mcd.cn，每个 POST 独立，无需 session id
 * - 协议流程：initialize → notifications/initialized → tools/call（三个独立 POST）
 * - 请求头：Authorization: Bearer <MCD_TOKEN> / Content-Type: application/json
 *           / Accept: application/json, text/event-stream
 * - 响应可能是 SSE（data: {...}），先剥前缀再 JSON.parse
 * - tools/call 业务数据在 result.content[0].text（说明文字 + 内嵌 JSON），
 *   若有 result.structuredContent 则优先使用
 * - 限流：每 Token 每分钟 600 次请求 → 节流 100ms/次
 */

const DEFAULT_ENDPOINT = 'https://mcp.mcd.cn';
const THROTTLE_MS = 100; // 600 次/分钟 → 100ms/次

class McpError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'McpError';
    this.code = code;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 剥掉 SSE 的 `data: ` 前缀并 JSON.parse；纯 JSON 响应直接 parse。
 * @param {string} raw HTTP 响应正文
 * @returns {object|null} 解析后的 JSON，空响应（HTTP 202）返回 null
 */
function parseResponseBody(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null; // HTTP 202 空响应，直接继续即可
  // 先按整体 JSON 尝试
  try {
    return JSON.parse(text);
  } catch {
    /* 继续，按 SSE 处理 */
  }
  // SSE：取所有 data: 行，剥前缀后拼接
  const dataLines = text.split(/\r?\n/).filter((line) => line.startsWith('data:'));
  if (dataLines.length > 0) {
    const joined = dataLines.map((line) => line.replace(/^data:\s*/, '')).join('\n').trim();
    try {
      return JSON.parse(joined);
    } catch {
      /* 落入失败分支 */
    }
  }
  return null;
}

/**
 * 从「给 LLM 看的说明文字 + 内嵌 JSON」里提取业务 JSON：
 * 取第一个 {"success" 到最后一个 } 的段落再 parse。
 * @param {string} text result.content[0].text
 * @returns {object|null}
 */
function extractBusinessJson(text) {
  const s = String(text == null ? '' : text);
  const start = s.indexOf('{"success"');
  if (start === -1) return null;
  const end = s.lastIndexOf('}');
  if (end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 从 JSON-RPC 响应中解析 tools/call 的业务结果。
 * 优先级：result.structuredContent > result.content[0].text 内嵌 JSON > 纯文本 > result
 */
function resolveResult(json) {
  if (!json) return null;
  if (json.error) {
    throw new McpError(
      `MCP 服务返回错误: ${json.error.message || JSON.stringify(json.error)}`,
      'RPC_ERROR'
    );
  }
  const result = json.result;
  if (!result) return null;
  if (
    result.structuredContent !== undefined &&
    result.structuredContent !== null
  ) {
    return result.structuredContent; // 部分响应有 structuredContent，优先用它
  }
  const text = result.content && result.content[0] && result.content[0].text;
  if (typeof text === 'string') {
    const biz = extractBusinessJson(text);
    if (biz) return biz;
    return text; // 纯文本结果
  }
  return result;
}

class McpClient {
  /**
   * @param {object} [opts]
   * @param {string}  [opts.endpoint]   默认 https://mcp.mcd.cn
   * @param {string}  [opts.token]      默认取环境变量 MCD_TOKEN，严禁硬编码
   * @param {number}  [opts.throttleMs] 节流间隔，默认 100ms（600 次/分钟）
   * @param {Function} [opts.fetchImpl] fetch 实现（测试可注入）
   */
  constructor(opts = {}) {
    this.endpoint = opts.endpoint || DEFAULT_ENDPOINT;
    this.token =
      opts.token !== undefined ? opts.token : process.env.MCD_TOKEN;
    this.throttleMs = opts.throttleMs === undefined ? THROTTLE_MS : opts.throttleMs;
    this.fetchImpl =
      opts.fetchImpl ||
      (typeof fetch === 'function' ? fetch : null);
    if (!this.fetchImpl) {
      throw new McpError('当前 Node 版本不支持内置 fetch，请使用 Node >= 18', 'NO_FETCH');
    }
    if (!this.token) {
      throw new McpError(
        '缺少 Token：请到 open.mcd.cn/mcp 申请 Token 并设置 MCD_TOKEN 环境变量',
        'NO_TOKEN'
      );
    }
    this._lastPostAt = 0;
    this._initialized = false;
    this.requestCount = 0;
  }

  /** 带节流的 POST：保证请求间隔 >= throttleMs */
  async _post(payload) {
    const wait = this._lastPostAt + this.throttleMs - Date.now();
    if (wait > 0) await sleep(wait);
    this._lastPostAt = Date.now();
    this.requestCount++;

    let res;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          // 注意 Bearer 后有空格
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      throw new McpError(
        `网络错误：无法连接 ${this.endpoint}（${e.message}），请检查网络连接`,
        'NETWORK'
      );
    }

    if (res.status === 401 || res.status === 403) {
      throw new McpError(
        'Token 无效或已过期：请到 open.mcd.cn/mcp 重新申请 Token，并更新 MCD_TOKEN 环境变量',
        'AUTH'
      );
    }
    if (res.status === 429) {
      throw new McpError(
        '触发限流（每 Token 每分钟 600 次请求）：请稍等一分钟再试',
        'RATE_LIMIT'
      );
    }
    if (res.status >= 400) {
      const body = await res.text().catch(() => '');
      throw new McpError(
        `MCP 服务返回 HTTP ${res.status}${body ? '：' + body.slice(0, 200) : ''}`,
        'HTTP_' + res.status
      );
    }
    return res;
  }

  /** 协议握手：initialize + notifications/initialized（服务端无状态，仅按流程逐次发送） */
  async initialize() {
    const res = await this._post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcd-tuan', version: '1.0.0' },
      },
    });
    // 可能是 HTTP 202 空响应，也可能是 200 带 serverInfo，均直接继续
    await res.text().catch(() => '');
    const res2 = await this._post({
      jsonrpc: '2.0',
      method: 'notifications/initialized', // 无 id
    });
    await res2.text().catch(() => '');
  }

  async _ensureInit() {
    if (this._initialized) return;
    await this.initialize();
    this._initialized = true;
  }

  /**
   * 调用一个 MCP 工具并返回业务数据。
   * @param {string} name 工具名
   * @param {object} args 工具参数
   * @returns {Promise<object|string>} 解析后的业务数据
   */
  async callTool(name, args = {}) {
    await this._ensureInit();
    const id = Math.floor(Math.random() * 1e9);
    const res = await this._post({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name, arguments: args },
    });
    const raw = await res.text();
    const json = parseResponseBody(raw);
    if (!json) {
      throw new McpError(
        `响应解析失败（非 JSON/SSE 内容）：${String(raw).slice(0, 200)}`,
        'PARSE'
      );
    }
    return resolveResult(json);
  }
}

module.exports = {
  McpClient,
  McpError,
  parseResponseBody,
  extractBusinessJson,
  resolveResult,
  DEFAULT_ENDPOINT,
};
