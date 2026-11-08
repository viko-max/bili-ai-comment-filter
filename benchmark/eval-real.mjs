/* 用 426 个真实人工标注评估规则引擎（新的主评估集）。
 * 隐藏类 = a(AI自动发评) + d(广告)；标记类 = s(人机共用)；保留类 = h(真人) + m(玩梗)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const C = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'constants.js'));
const U = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'utils.js'));
const Rules = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'rules.js'));
const raw = JSON.parse(readFileSync(path.join(ROOT, 'samples/real/comments.json'), 'utf8'));
const labels = JSON.parse(readFileSync(path.join(ROOT, 'samples/real/labels.json'), 'utf8')).labels;

const comments = raw.comments.map(c => ({
  key: 'r:' + c.rpid, rpid: String(c.rpid), uid: String(c.mid),
  uname: c.uname, sign: c.sign || '', level: c.level, text: c.text,
  ctime: c.ctime, oid: String(raw.meta.aid), videoId: raw.meta.bvid,
  like: c.like, replyCount: c.rcount,
  avatarKey: c.face ? U.avatarKey(c.face) : ''
}));
const t0 = performance.now();
const res = Rules.evaluatePage({
  comments, settings: C.DEFAULT_SETTINGS,
  lists: { whitelist: [], blocklist: [] }, overrides: {}, sessionComments: []
});
const elapsed = performance.now() - t0;

const HIDE = new Set(['a', 'd']), MARK = new Set(['s']);
const textByUid = new Map();
for (const c of raw.comments) {
  if (!textByUid.has(String(c.mid))) textByUid.set(String(c.mid), []);
  textByUid.get(String(c.mid)).push(c.text);
}
let tp = 0, fp = 0, fn = 0, tn = 0, markOK = 0, markAsHide = 0, markAsKeep = 0;
const errors = [];
for (const [uid, a] of Object.entries(res.accounts)) {
  const lab = labels[uid] || 'h';
  const shouldHide = HIDE.has(lab);
  const got = a.decision;
  if (got === 'hide' && shouldHide) tp++;
  else if (got === 'hide' && !shouldHide) { fp++; errors.push({ type: '误藏', lab, uid, uname: a.uname, level: a.level, why: a.why, text: (textByUid.get(uid) || []).join(' ').replace(/\s+/g, ' ').slice(0, 55) }); }
  else if (got !== 'hide' && shouldHide) { fn++; errors.push({ type: '漏判', lab, uid, uname: a.uname, level: a.level, why: a.why, text: (textByUid.get(uid) || []).join(' ').replace(/\s+/g, ' ').slice(0, 55) }); }
  else tn++;
  if (MARK.has(lab)) {
    if (got === 'mark') markOK++;
    else if (got === 'hide') markAsHide++;
    else markAsKeep++;
  }
}
const precision = tp / Math.max(1, tp + fp);
const recall = tp / Math.max(1, tp + fn);
const f1 = 2 * precision * recall / Math.max(1e-9, precision + recall);

const lines = [];
lines.push('# 真实标注集评估（426 个人工标签）\n');
lines.push(`视频：${raw.meta.title}（${raw.meta.bvid}）｜ ${raw.comments.length} 条评论 / ${res.accounts ? Object.keys(res.accounts).length : 0} 个账号\n`);
lines.push('口径：隐藏类 `a`(AI自动发评) + `d`(广告)；标记类 `s`(人机共用)；保留类 `h`(真人) + `m`(玩梗)。\n');
lines.push('| 指标 | 值 |');
lines.push('|---|---:|');
lines.push(`| 正确隐藏 TP | ${tp} |`);
lines.push(`| 误藏 FP（含把 s 判成隐藏） | ${fp} |`);
lines.push(`| 漏判 FN | ${fn} |`);
lines.push(`| 精确率 | ${precision.toFixed(3)} |`);
lines.push(`| 召回率 | ${recall.toFixed(3)} |`);
lines.push(`| F1 | ${f1.toFixed(3)} |`);
lines.push(`| 人机共用 s 判成 mark | ${markOK}/10 |`);
lines.push(`| 规则耗时 | ${U.round(elapsed, 2)} ms |`);
lines.push('\n## 误判明细\n');
lines.push('| 类型 | 真实标签 | 昵称 | Lv | 规则结论 | 文本 |');
lines.push('|---|---|---|---|---|---|');
for (const e of errors) lines.push(`| ${e.type} | ${e.lab} | ${String(e.uname).replace(/\|/g, '\\|')} | ${e.level} | ${e.why.slice(0, 28)} | ${String(e.text).replace(/\|/g, '\\|').replace(/\s+/g, ' ')} |`);

writeFileSync(path.join(ROOT, '验证/真实标注评估.md'), lines.join('\n'));
writeFileSync(path.join(ROOT, '验证/real-eval-result.json'), JSON.stringify({
  totalAccounts: Object.keys(res.accounts).length, tp, fp, fn, tn, precision, recall, f1,
  markOK, markAsHide, markAsKeep, elapsedMs: U.round(elapsed, 2), errors
}, null, 2));
console.log(`真实标注集：TP=${tp} 误藏=${fp} 漏判=${fn} 精确率=${precision.toFixed(3)} 召回率=${recall.toFixed(3)} F1=${f1.toFixed(3)} 耗时=${U.round(elapsed, 2)}ms`);
console.log('人机共用 s 判 mark:', markOK, '/ 10');
console.log('报告：验证/真实标注评估.md');
