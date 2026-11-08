/* 后台 service worker：只负责模型复核的网络调用、去重、限流与密钥保管。
 *
 * 密钥安全：
 *  - 只保存在 chrome.storage.session（内存级、浏览器重启即清），不写入 chrome.storage.local / sync；
 *  - 源码、设置导出、日志、错误消息一律不出现密钥（返回前统一 redact）；
 *  - 内容脚本永远不接触密钥，只把公开证据交给后台。
 */
'use strict';
try {
  importScripts(
    '../shared/constants.js',
    '../shared/utils.js',
    '../shared/rules.js',
    '../shared/decision.js',
    '../shared/store.js'
  );
} catch (e) {
  console.warn('[BAF] importScripts failed', e && e.message);
}

// UMD 模块把自己的导出直接合并到 BiliAICF 顶层（没有子命名空间）
const N = self.BiliAICF || {};
const Decision = N;
const Store = N;
const U = N;
const KEYS = Store.KEYS || { settings: 'settings', apiKey: 'apiKey', apiMeta: 'apiMeta' };

const STATE = {
  key: null,                 // 仅内存缓存
  tokens: 12,
  lastRefill: Date.now(),
  concurrent: 0,
  requests: 0,
  cacheHits: 0,
  cache: new Map(),          // cacheKey -> { at, result }
  lastMs: null,
  lastError: null
};

try {
  if (chrome.storage.session && chrome.storage.session.setAccessLevel) {
    chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' });
  }
} catch (_) {}

function getStore(area, key) {
  return new Promise(resolve => {
    try { area.get(key, v => resolve(v ? v[key] : undefined)); } catch (_) { resolve(undefined); }
  });
}
function setStore(area, obj) {
  return new Promise(resolve => { try { area.set(obj, () => resolve()); } catch (_) { resolve(); } });
}

async function apiKey() {
  if (STATE.key != null) return STATE.key;
  const k = await getStore(chrome.storage.session, KEYS.apiKey);
  STATE.key = k || '';
  return STATE.key;
}
async function settings() {
  const s = await getStore(chrome.storage.local, KEYS.settings);
  return Store.normalizeSettings ? Store.normalizeSettings(s) : (s || {});
}

function redact(text, key) { return U.redact ? U.redact(text, key) : String(text || ''); }

// ---------- 限流 ----------
function refill(cfg) {
  const cap = Math.max(1, Number(cfg.maxRequestsPerMinute) || 12);
  const now = Date.now();
  const rate = cap / 60000;
  STATE.tokens = Math.min(cap, STATE.tokens + (now - STATE.lastRefill) * rate);
  STATE.lastRefill = now;
}
async function takeToken(cfg) {
  const cap = Math.max(1, Number(cfg.maxRequestsPerMinute) || 12);
  for (let i = 0; i < 40; i++) {
    refill(cfg);
    if (STATE.tokens >= 1) { STATE.tokens -= 1; return; }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('本地限流：请求过于频繁，请稍后重试');
}
async function takeSlot(cfg) {
  const max = Math.max(1, Number(cfg.maxConcurrent) || 2);
  for (let i = 0; i < 60; i++) {
    if (STATE.concurrent < max) { STATE.concurrent++; return; }
    await new Promise(r => setTimeout(r, 120));
  }
  throw new Error('本地限流：并发已满');
}
function checkBudget(cfg) {
  const budget = Number(cfg.maxRequestsPerSession) || 60;
  if (STATE.requests >= budget) throw new Error(`已达到本次浏览器会话的调用上限（${budget} 次），请重新启用或调高上限`);
}

// ---------- 单次调用 ----------
async function callOnce(req, key, cfg) {
  checkBudget(cfg);
  await takeToken(cfg);
  await takeSlot(cfg);
  const started = Date.now();
  try {
    const opts = Decision.toFetchOptions(req, key, { api: cfg });
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(cfg.timeoutMs) || 12000);
    let res, text;
    try {
      res = await fetch(opts.url, { method: 'POST', headers: opts.headers, body: opts.body, signal: ctrl.signal });
      text = await res.text();
    } finally { clearTimeout(timer); }
    STATE.requests++;
    STATE.lastMs = Date.now() - started;
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}：${redact(text.slice(0, 240), key)}`);
      err.apiError = 'http_' + res.status;
      throw err;
    }
    let data;
    try { data = JSON.parse(text); }
    catch (_) { throw new Error('接口返回内容不是 JSON（可能已被网关拦截）'); }
    const parsed = Decision.parseResponse(data, req.ids);
    STATE.lastError = null;
    return parsed;
  } catch (e) {
    STATE.lastError = redact(e && e.message ? e.message : String(e), key);
    throw e;
  } finally {
    STATE.concurrent = Math.max(0, STATE.concurrent - 1);
  }
}

// ---------- 批量复核（去重 + 批次拆分 + 输入超限自动降级） ----------
async function review(accounts, cfg, key) {
  const ttl = Number(cfg.cacheTtlMs != null ? cfg.cacheTtlMs : 1800000);
  const now = Date.now();
  const results = {};
  const todo = [];
  const warnings = [];
  for (const a of accounts) {
    const ck = a.cacheKey || (Decision.cacheKey ? Decision.cacheKey(a) : String(a.uid));
    const hit = STATE.cache.get(ck);
    if (hit && now - hit.at < ttl) { results[a.uid] = hit.result; STATE.cacheHits++; }
    else todo.push(Object.assign({}, a, { cacheKey: ck }));
  }
  const size = Math.max(1, Math.min(6, Number(cfg.batchSize) || 2));
  for (let i = 0; i < todo.length; i += size) {
    const group = todo.slice(i, i + size);
    const req = Decision.buildRequestBody(group, { api: cfg });
    let parsed;
    try {
      parsed = await callOnce(req, key, cfg);
    } catch (e) {
      const msg = String((e && e.apiError) || '') + ' ' + String((e && e.message) || '');
      const tooBig = /tokens_estimate_exceeded|too long|context|token/i.test(msg);
      if (tooBig && group.length > 1) {
        // 决策接口会把 state 按问题数放大 token 估算；拆成单账号重试
        warnings.push('输入规模超限，已自动拆成单账号请求');
        for (const one of group) {
          try {
            const single = await callOnce(Decision.buildRequestBody([one], { api: cfg }), key, cfg);
            const r = single.results.a1;
            if (r) { results[one.uid] = r; STATE.cache.set(one.cacheKey, { at: Date.now(), result: r }); }
          } catch (e2) { warnings.push(`账号 ${one.uid} 复核失败：${redact(e2.message, key)}`); }
        }
        continue;
      }
      if (Object.keys(results).length) { warnings.push(redact(e.message || String(e), key)); continue; }
      throw e;
    }
    group.forEach((a, j) => {
      const r = parsed.results['a' + (j + 1)];
      if (r) { results[a.uid] = r; STATE.cache.set(a.cacheKey, { at: Date.now(), result: r }); }
    });
  }
  return { results, warnings, requests: STATE.requests, cacheHits: STATE.cacheHits, ms: STATE.lastMs };
}

// ---------- 消息入口 ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  (async () => {
    if (!msg || !msg.type) { reply({ ok: false }); return; }
    try {
      if (msg.type === 'BAF_SET_KEY') {
        STATE.key = String(msg.key || '');
        await setStore(chrome.storage.session, { [KEYS.apiKey]: STATE.key });
        reply({ ok: true });
      } else if (msg.type === 'BAF_CLEAR_KEY') {
        STATE.key = '';
        try { chrome.storage.session.remove(KEYS.apiKey); } catch (_) {}
        reply({ ok: true });
      } else if (msg.type === 'BAF_HAS_KEY') {
        reply({ ok: true, has: !!(await apiKey()) });
      } else if (msg.type === 'BAF_STATUS') {
        // service worker 会被回收，内存缓存不可靠；从会话级存储重新确认
        const k = await apiKey();
        reply({ ok: true, meta: Object.assign(statusMeta(), { hasKey: !!k }) });
      } else if (msg.type === 'BAF_TEST_CONNECTION') {
        const cfg = Object.assign({}, (await settings()).api, msg.api || {});
        const key = msg.key || (await apiKey());
        if (!key) { reply({ ok: false, error: '未填写 API Key' }); return; }
        const req = Decision.buildRequestBody([{
          uname: '连接测试', level: 3, commentCount: 1,
          commentTexts: ['这是一条用于验证结构化决策接口连通性的普通评论。'],
          signals: [], timing: { maxBurst: 1 }, crossVideoCount: 1, score: 0, strongCategories: []
        }], { api: cfg });
        const parsed = await callOnce(req, key, cfg);
        reply({ ok: true, ms: STATE.lastMs, model: parsed.model, usage: parsed.usage,
          sample: parsed.results.a1, requests: STATE.requests });
      } else if (msg.type === 'BAF_REVIEW') {
        const s = await settings();
        if (!s.enabled || s.mode !== 'model' || !s.api.enabled) {
          reply({ status: 'disabled', message: '模型复核未启用，当前为纯规则模式' }); return;
        }
        const key = await apiKey();
        if (!key) { reply({ status: 'disabled', message: '未设置 API Key，当前为纯规则模式' }); return; }
        const out = await review(msg.accounts || [], s.api, key);
        reply({ status: 'ok', results: out.results, meta: Object.assign(statusMeta(), { warnings: out.warnings, ms: out.ms }) });
      } else if (msg.type === 'BAF_OPEN_OPTIONS') {
        try { chrome.runtime.openOptionsPage(); } catch (_) {}
        reply({ ok: true });
      } else if (msg.type === 'BAF_RESET_META') {
        STATE.requests = 0; STATE.cacheHits = 0; STATE.cache.clear(); STATE.lastError = null;
        reply({ ok: true });
      } else reply({ ok: false, error: '未知消息类型' });
    } catch (e) {
      const key = STATE.key || '';
      reply({ ok: false, status: 'error', error: redact(e && e.message ? e.message : String(e), key) });
    }
  })();
  return true; // 异步 reply
});

function statusMeta() {
  return {
    requests: STATE.requests,
    cacheHits: STATE.cacheHits,
    cacheSize: STATE.cache.size,
    lastMs: STATE.lastMs,
    lastError: STATE.lastError,
    hasKey: !!(STATE.key)
  };
}

chrome.runtime.onInstalled.addListener(() => {
  // 不写入任何密钥；仅确保默认设置存在
  getStore(chrome.storage.local, KEYS.settings).then(s => {
    if (!s) setStore(chrome.storage.local, { [KEYS.settings]: (self.BiliAICF && self.BiliAICF.DEFAULT_SETTINGS) || {} });
  });
});
