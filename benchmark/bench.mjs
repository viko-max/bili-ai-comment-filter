/* 对照实验：同一组带已知标签的样本，比较「纯规则」与「规则 + LingDT 模型复核」。
 *
 * 用法：
 *   node benchmark/bench.mjs                       # 仅规则（模型部分标注未验证）
 *   DTMAAS_API_KEY=sk-xxx node benchmark/bench.mjs   # 真实调用 LingDT
 *   BAF_MOCK_URL=http://127.0.0.1:8799/v1/systemone node benchmark/bench.mjs  # 本地 mock
 *
 * 密钥只从环境变量读取，不写入任何输出文件。
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared');
const C = require(path.join(EXT, 'constants.js'));
const U = require(path.join(EXT, 'utils.js'));
const Rules = require(path.join(EXT, 'rules.js'));
const Decision = require(path.join(EXT, 'decision.js'));

const KEY = process.env.DTMAAS_API_KEY || '';
const MOCK_URL = process.env.BAF_MOCK_URL || '';
const ENDPOINT = MOCK_URL || C.DEFAULT_ENDPOINT;
const OUT_DIR = path.join(ROOT, '验证');
mkdirSync(OUT_DIR, { recursive: true });

const dataset = JSON.parse(readFileSync(path.join(ROOT, 'samples', 'labeled-comments.json'), 'utf8'));
const SHOULD_HIDE = new Set(dataset.meta.shouldHide);
const CACHE_FILE = path.join(ROOT, '验证', 'model-responses.json');
const FRESH = process.argv.includes('--fresh');
const settings = C.DEFAULT_SETTINGS;
const apiCfg = Object.assign({}, settings.api, { endpoint: ENDPOINT, batchSize: 2, maxRequestsPerMinute: 30, maxRequestsPerSession: 200 });

function toComments(page) {
  return page.comments.map(c => ({
    key: 'r:' + c.rpid, rpid: String(c.rpid), uid: String(c.uid), uname: c.uname,
    level: c.level, text: c.text, ctime: c.ctime, oid: page.oid, videoId: page.videoId,
    avatarKey: c.face ? U.avatarKey(c.face) : '',
    sign: c.sign || '',
    like: c.like, replyCount: c.replyCount, parentId: '0', rootId: '0', isSub: false,
    label: c.label, note: c.note || ''
  }));
}

function buildAccounts(res, comments) {
  const out = [];
  for (const [uid, a] of Object.entries(res.accounts)) {
    const texts = comments.filter(c => String(c.uid) === uid).map(c => c.text);
    const acc = Object.assign({}, a, { uid, commentTexts: texts.slice(0, 4) });
    acc.cacheKey = Decision.cacheKey(acc);
    out.push(acc);
  }
  return out;
}

async function callModel(accounts) {
  const results = {};
  const latencies = [];
  let requests = 0, cacheHits = 0, errors = [];
  const cache = new Map();
  const todo = accounts.filter(a => {
    const hit = cache.get(a.cacheKey);
    if (hit) { results[a.uid] = hit; cacheHits++; return false; }
    return true;
  });
  for (let i = 0; i < todo.length; i += apiCfg.batchSize) {
    const group = todo.slice(i, i + apiCfg.batchSize);
    let req = Decision.buildRequestBody(group, { api: apiCfg });
    let parsed = null;
    const attempt = async (body, ids) => {
      const opts = Decision.toFetchOptions(body, KEY, { api: apiCfg });
      const t0 = performance.now();
      const r = await fetch(opts.url, { method: 'POST', headers: opts.headers, body: opts.body, signal: AbortSignal.timeout(apiCfg.timeoutMs) });
      const txt = await r.text();
      latencies.push(performance.now() - t0);
      requests++;
      if (!r.ok) throw new Error(`HTTP ${r.status}: ${txt.slice(0, 200)}`);
      return Decision.parseResponse(JSON.parse(txt), ids);
    };
    try {
      parsed = await attempt(req, req.ids);
    } catch (e) {
      if (/tokens_estimate_exceeded|too long/i.test(String(e.message)) && group.length > 1) {
        errors.push('输入规模超限，已拆为单账号重试');
        for (const one of group) {
          const oneReq = Decision.buildRequestBody([one], { api: apiCfg });
          const p = await attempt(oneReq, oneReq.ids);
          const r = p.results.a1;
          if (r) { results[one.uid] = r; cache.set(one.cacheKey, r); }
        }
        continue;
      }
      errors.push(String(e.message));
      continue;
    }
    group.forEach((a, j) => {
      const r = parsed.results['a' + (j + 1)];
      if (r) { results[a.uid] = r; cache.set(a.cacheKey, r); }
    });
  }
  return { results, requests, cacheHits, latencies, errors };
}

function evaluateMode(name, perPage) {
  const rows = [];
  for (const p of perPage) for (const d of p.final) rows.push({
    videoId: p.videoId, label: d.label, shouldHide: SHOULD_HIDE.has(d.label),
    decision: d.decision, source: d.source, score: d.score, uid: d.uid, note: d.note,
    modelStatus: d.modelStatus || null,
    model: d.model ? {
      source: d.model.source, sourceProb: U.round(d.model.sourceProb, 3),
      action: d.model.action, hideProb: U.round(d.model.hideProb, 3),
      autoProb: U.round(d.model.autoProb, 3), confidence: U.round(d.model.confidence, 3),
      evidenceProb: U.round(d.model.evidenceProb || 0, 3)
    } : null
  });
  const counts = { TP: 0, FN: 0, FP: 0, TN: 0, markShouldHide: 0, markShouldKeep: 0 };
  for (const r of rows) {
    const hidden = r.decision === 'hide';
    if (r.shouldHide && hidden) counts.TP++;
    else if (r.shouldHide && !hidden) { counts.FN++; if (r.decision === 'mark') counts.markShouldHide++; }
    else if (!r.shouldHide && hidden) counts.FP++;
    else { counts.TN++; if (r.decision === 'mark') counts.markShouldKeep++; }
  }
  const byLabel = {};
  for (const r of rows) {
    byLabel[r.label] = byLabel[r.label] || { total: 0, hide: 0, mark: 0, keep: 0 };
    byLabel[r.label].total++;
    byLabel[r.label][r.decision]++;
  }
  // 账号级（同一 UID 任一评论被隐藏即视为隐藏该账号）
  const accMap = new Map();
  for (const r of rows) {
    const a = accMap.get(r.uid) || { label: r.label, shouldHide: r.shouldHide, decision: 'keep' };
    if (r.decision === 'hide') a.decision = 'hide';
    else if (r.decision === 'mark' && a.decision === 'keep') a.decision = 'mark';
    accMap.set(r.uid, a);
  }
  let accTP = 0, accFN = 0, accFP = 0, accTN = 0;
  for (const a of accMap.values()) {
    const hidden = a.decision === 'hide';
    if (a.shouldHide && hidden) accTP++;
    else if (a.shouldHide) accFN++;
    else if (hidden) accFP++;
    else accTN++;
  }
  return {
    name, total: rows.length, accounts: accMap.size,
    TP: counts.TP, FN: counts.FN, FP: counts.FP, TN: counts.TN,
    漏判: counts.FN, 误藏: counts.FP,
    应隐藏被标记: counts.markShouldHide, 不应隐藏被标记: counts.markShouldKeep,
    精确率: counts.TP + counts.FP ? U.round(counts.TP / (counts.TP + counts.FP), 4) : null,
    召回率: counts.TP + counts.FN ? U.round(counts.TP / (counts.TP + counts.FN), 4) : null,
    账号级: { TP: accTP, FN: accFN, FP: accFP, TN: accTN, 漏判: accFN, 误藏: accFP },
    byLabel, rows
  };
}

function pct(arr, p) {
  if (!arr.length) return null;
  const s = arr.slice().sort((a, b) => a - b);
  return U.round(s[Math.min(s.length - 1, Math.floor(p * s.length))], 1);
}

async function main() {
  let cachedSnapshot = null;
  if (!FRESH) { try { cachedSnapshot = JSON.parse(readFileSync(CACHE_FILE, 'utf8')); } catch (_) {} }
  console.log('样本页：', dataset.pages.length, '｜模型端点：',
    MOCK_URL ? '本地 mock' : (KEY ? '真实 LingDT' : (cachedSnapshot ? '已保存的真实响应快照（离线复算）' : '未启用')));
  const perPage = [];
  const sessionComments = [];
  const tRules0 = performance.now();
  for (const page of dataset.pages) {
    const comments = toComments(page);
    const history = sessionComments.slice();
    const t0 = performance.now();
    const res = Rules.evaluatePage({
      comments, settings, lists: { whitelist: [], blocklist: [] }, overrides: {}, sessionComments: history
    });
    const rulesMs = performance.now() - t0;
    const accounts = buildAccounts(res, comments);
    perPage.push({ videoId: page.videoId, comments, res, accounts, rulesMs });
    for (const c of comments) sessionComments.push({ uid: c.uid, oid: c.oid, videoId: c.videoId, ctime: c.ctime, text: c.text.slice(0, 120) });
  }
  const rulesTotalMs = performance.now() - tRules0;

  const rulesMode = evaluateMode('纯规则', perPage.map(p => ({ videoId: p.videoId, final: p.res.decisions.map(d => Object.assign({}, d, { source: 'rules' })) })));

  let modelMode = null;
  let modelMeta = { enabled: false, reason: '未提供 DTMAAS_API_KEY / BAF_MOCK_URL，模型复核未实测' };
  if (KEY || MOCK_URL || cachedSnapshot) {
    const modelT0 = performance.now();
    const allResults = {};
    let requests = 0, cacheHits = 0, latencies = [], errors = [], fromCache = false;
    const snapshot = cachedSnapshot;
    if (snapshot && snapshot.model === apiCfg.model && snapshot.endpoint === ENDPOINT) {
      Object.assign(allResults, snapshot.results || {});
      requests = snapshot.requests || 0; cacheHits = snapshot.cacheHits || 0;
      latencies = snapshot.latencies || []; errors = snapshot.errors || [];
      fromCache = true;
    } else {
      for (const p of perPage) {
        const review = p.accounts.filter(a => (settings.reviewDecisions || ['mark', 'hide']).includes(a.decision));
        if (!review.length) continue;
        const out = await callModel(review);
        Object.assign(allResults, out.results);
        requests += out.requests; cacheHits += out.cacheHits;
        latencies = latencies.concat(out.latencies);
        errors = errors.concat(out.errors.map(e => `${p.videoId}: ${e}`));
      }
      writeFileSync(CACHE_FILE, JSON.stringify({
        savedAt: new Date().toISOString(), endpoint: ENDPOINT, model: apiCfg.model,
        results: allResults, requests, cacheHits, latencies, errors
      }, null, 2));
    }
    const modelTotalMs = fromCache ? (snapshot.totalMs != null ? snapshot.totalMs : 0) : performance.now() - modelT0;
    if (!fromCache) {
      const s = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
      s.totalMs = U.round(modelTotalMs, 1);
      writeFileSync(CACHE_FILE, JSON.stringify(s, null, 2));
    }
    const withModel = perPage.map(p => ({
      videoId: p.videoId,
      final: p.res.decisions.map(d => {
        const m = allResults[d.uid];
        if (!m) return Object.assign({}, d, { source: 'rules' });
        const c = Decision.combine(d, m, settings);
        return Object.assign({}, d, { decision: c.decision, reasons: c.reasons, modelStatus: c.modelStatus, model: c.model, source: 'model' });
      })
    }));
    modelMode = evaluateMode('规则 + 模型复核', withModel);
    modelMeta = {
      enabled: true,
      endpoint: MOCK_URL ? '本地 mock 决策服务' : C.DEFAULT_ENDPOINT,
      model: apiCfg.model,
      requests, cacheHits, errors, fromCache,
      totalMs: U.round(modelTotalMs, 1),
      latency: { avg: latencies.length ? U.round(latencies.reduce((a, b) => a + b, 0) / latencies.length, 1) : null, p50: pct(latencies, .5), p95: pct(latencies, .95), max: latencies.length ? U.round(Math.max(...latencies), 1) : null },
      reviewedAccounts: Object.keys(allResults).length,
      note: '模型耗时包含网络往返、限流等待与响应解析；规则耗时为本地同步计算。'
    };
  }

  const timing = {
    规则总耗时_ms: U.round(rulesTotalMs, 2),
    规则每页耗时_ms: perPage.map(p => ({ videoId: p.videoId, ms: U.round(p.rulesMs, 3), comments: p.comments.length })),
    模型: modelMeta
  };

  const result = {
    generatedAt: new Date().toISOString(),
    dataset: { file: 'samples/labeled-comments.json', pages: dataset.pages.length, comments: dataset.pages.reduce((s, p) => s + p.comments.length, 0), labels: dataset.meta.labels },
    settings: { thresholds: settings.thresholds, minStrongCategoriesForHide: settings.minStrongCategoriesForHide, reviewDecisions: settings.reviewDecisions },
    rules: rulesMode, model: modelMode, timing
  };
  writeFileSync(path.join(OUT_DIR, 'benchmark-result.json'), JSON.stringify(result, null, 2));

  // Markdown 摘要
  const fmt = m => m ? `| ${m.name} | ${m.total} | ${m.TP} | ${m.漏判} | ${m.误藏} | ${m.应隐藏被标记} | ${m.不应隐藏被标记} | ${m.精确率} | ${m.召回率} | ${m.账号级.漏判} | ${m.账号级.误藏} |` : '';
  const md = [
    '# 纯规则 vs 模型复核 · 对照实验',
    '',
    `- 样本：${result.dataset.pages} 个仿真视频 / ${result.dataset.comments} 条评论，全部带已知标签（大肥鱼、其他自动发评、真人玩梗、真人 AI 润色、普通评论）。`,
    `- 应隐藏标签：${[...SHOULD_HIDE].join('、')}；其余一律不应隐藏。`,
    '- **口径说明**：本轮规则由 426 个真实人工标注推导（v3：`低等级 + 人设昵称/签名自述/口癖` 隐藏，广告隐藏，打窝复读与 Lv4+ 真人保留）。仿真样本的 ground truth 仍是「所有 `auto_*` 都该隐藏」，与 v3 口径不完全一致，因此这里的漏判数偏高；**主评估集已改为 `npm run eval:real`（426 个真实标签）**，本实验只用于回归检查 `误藏 = 0`、`不应隐藏被标记 = 0`。',
    `- 模型：\`${apiCfg.model}\` @ \`${modelMeta.endpoint || '未启用'}\`，${modelMeta.enabled ? `实际发起 ${modelMeta.requests} 次请求、复核 ${modelMeta.reviewedAccounts} 个账号` : modelMeta.reason}。`,
    ...(modelMeta.enabled && modelMeta.fromCache
      ? ['- 本轮为离线复算：直接读取 `验证/model-responses.json` 中上一次真实调用保存的结构化决策响应，未发起新的网络请求，结果可复现。']
      : []),
    '',
    '## 评论级结果',
    '',
    '| 模式 | 样本数 | 正确隐藏(TP) | 漏判(FN) | 误藏(FP) | 应隐藏仅标记 | 不应隐藏被标记 | 精确率 | 召回率 | 账号级漏判 | 账号级误藏 |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    fmt(rulesMode),
    ...(modelMode ? [fmt(modelMode)] : ['| 规则 + 模型复核 | — | — | — | — | — | — | — | — | — | — |']),
    '',
    '> 漏判 = 应隐藏但未隐藏（含保留与标记）；误藏 = 不应隐藏但被隐藏。标记为可见，不计入误藏。',
    '',
    '## 各标签的处置分布',
    '',
    ...[rulesMode, modelMode].filter(Boolean).map(m => [
      `### ${m.name}`, '', '| 标签 | 总数 | 隐藏 | 标记 | 保留 |', '|---|---:|---:|---:|---:|',
      ...Object.entries(m.byLabel).map(([k, v]) => `| ${k} | ${v.total} | ${v.hide} | ${v.mark} | ${v.keep} |`), ''
    ].join('\n')),
    '## 处理耗时',
    '',
    `- 纯规则总耗时：${timing.规则总耗时_ms} ms（本地同步计算，${result.dataset.comments} 条评论）。`,
    ...(modelMeta.enabled ? [
      `- 模型复核总耗时：${modelMeta.totalMs} ms，请求 ${modelMeta.requests} 次，去重命中 ${modelMeta.cacheHits} 次。`,
      `- 单次请求延迟：平均 ${modelMeta.latency.avg} ms / P50 ${modelMeta.latency.p50} ms / P95 ${modelMeta.latency.p95} ms / 最大 ${modelMeta.latency.max} ms。`,
      `- 规则与模型耗时口径不同（本地同步 vs 网络往返），不可直接相减比较快慢。`
    ] : ['- 模型复核未实测：' + modelMeta.reason]),
    ...(modelMeta.errors && modelMeta.errors.length ? ['', '## 调用过程中的错误', '', ...modelMeta.errors.map(e => `- ${e}`)] : []),
    ''
  ].join('\n');
  writeFileSync(path.join(OUT_DIR, '对比实验.md'), md);

  console.log('\n=== 纯规则 ===');
  console.log(`TP=${rulesMode.TP} 漏判=${rulesMode.漏判} 误藏=${rulesMode.误藏} 标记(应隐藏)=${rulesMode.应隐藏被标记} 标记(不应隐藏)=${rulesMode.不应隐藏被标记} 耗时=${timing.规则总耗时_ms}ms`);
  if (modelMode) {
    console.log('=== 规则 + 模型复核 ===');
    console.log(`TP=${modelMode.TP} 漏判=${modelMode.漏判} 误藏=${modelMode.误藏} 标记(应隐藏)=${modelMode.应隐藏被标记} 标记(不应隐藏)=${modelMode.不应隐藏被标记}`);
    console.log(`请求=${modelMeta.requests} 去重=${modelMeta.cacheHits} 总耗时=${modelMeta.totalMs}ms 延迟avg=${modelMeta.latency.avg}ms p95=${modelMeta.latency.p95}ms`);
  } else console.log('模型复核：' + modelMeta.reason);
  console.log('\n结果写入：验证/benchmark-result.json、验证/对比实验.md');
}

main().catch(e => { console.error(e); process.exit(1); });
