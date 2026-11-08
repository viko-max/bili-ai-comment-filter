/* 对导出的真实评论做无监督聚类分析，给出「待人工标注」的候选群组。
 * 不做任何判定结论，只把可疑的群体性线索摆出来供人工过一遍。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const U = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'utils.js'));
const C = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'constants.js'));
const data = JSON.parse(readFileSync(path.join(ROOT, 'samples', 'real', 'comments.json'), 'utf8'));
const cs = data.comments;

const groups = new Map();
for (const c of cs) {
  const k = c.mid || ('anon-' + c.rpid);
  if (!groups.has(k)) groups.set(k, { uid: k, names: new Set(), signs: new Set(), levels: new Set(), texts: [], times: [], likes: [], rcount: [], faces: new Set(), sub: 0 });
  const g = groups.get(k);
  g.names.add(c.uname); g.signs.add(c.sign); g.levels.add(c.level);
  g.faces.add(c.face); g.texts.push(c.text); g.times.push(c.ctime);
  g.likes.push(c.like); g.rcount.push(c.rcount);
  if (c.isSub) g.sub++;
}
console.log('账号数', groups.size, '| 评论数', cs.length,
  '| face 非空账号', [...groups.values()].filter(g => [...g.faces].some(Boolean)).length,
  '| sign 非空账号', [...groups.values()].filter(g => [...g.signs].some(Boolean)).length);

// ---- 签名聚类（真实数据里最强的同批线索）----
const signGroups = new Map();
for (const g of groups.values()) {
  const s = [...g.signs].find(Boolean);
  if (!s) continue;
  if (!signGroups.has(s)) signGroups.set(s, []);
  signGroups.get(s).push(g);
}
const repeatedSigns = [...signGroups.entries()].filter(([, arr]) => arr.length >= 2).sort((a, b) => b[1].length - a[1].length);

// ---- 昵称模板聚类 ----
const nameGroups = new Map();
for (const g of groups.values()) {
  const n = [...g.names][0] || '';
  const tpl = U.nameTemplate(n);
  if (!tpl) continue;
  if (!nameGroups.has(tpl)) nameGroups.set(tpl, []);
  nameGroups.get(tpl).push(g);
}
const repeatedNames = [...nameGroups.entries()].filter(([, arr]) => arr.length >= 2).sort((a, b) => b[1].length - a[1].length);

// ---- 文本近似重复（跨账号）----
const prepared = cs.filter(c => U.normalizeText(c.text).length >= 12).map(c => ({ c, norm: U.normalizeText(c.text) }));
const dupPairs = [];
for (let i = 0; i < prepared.length; i++) {
  for (let j = i + 1; j < prepared.length; j++) {
    if (prepared[i].c.mid === prepared[j].c.mid) continue;
    const sim = U.textSimilarity(prepared[i].c.text, prepared[j].c.text);
    if (sim >= 0.82) dupPairs.push({ a: prepared[i].c, b: prepared[j].c, sim: U.round(sim, 3) });
  }
}

// ---- 低等级 + 时间聚集 ----
const lowLevel = [...groups.values()].filter(g => [...g.levels].every(l => l > 0 && l <= 3));
const times = lowLevel.map(g => Math.min(...g.times)).filter(Boolean).sort((a, b) => a - b);
let maxWindow = { n: 0, span: 0, from: 0, to: 0 };
for (let i = 0; i < times.length; i++) {
  let n = 1;
  for (let j = i + 1; j < times.length && times[j] - times[i] <= 6 * 3600; j++) n++;
  if (n > maxWindow.n) maxWindow = { n, span: 6 * 3600, from: times[i], to: times[i] + 6 * 3600 };
}

const fmtTime = t => t ? new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) : '-';
const preview = g => ({
  uid: g.uid, uname: [...g.names][0], level: [...g.levels].join('/'), sign: ([...g.signs].find(Boolean) || '').slice(0, 30),
  comments: g.texts.length, first: fmtTime(Math.min(...g.times)),
  texts: g.texts.slice(0, 3).map(t => t.replace(/\s+/g, ' ').slice(0, 90))
});

const report = [];
report.push('# 真实评论区聚类分析（待人工标注）\n');
report.push(`视频：${data.meta.title}（${data.meta.bvid}），抓取 ${data.meta.count ?? data.count} 条 / ${groups.size} 个账号，抓取时间 ${data.meta.fetchedAt}\n`);
report.push('> 本文件只列线索，不下结论。`label` 需要人工填写。\n');
report.push('## 1. 关键结构发现\n');
report.push(`- \`member.face\` 非空账号数：**${[...groups.values()].filter(g => [...g.faces].some(Boolean)).length}**。未登录公开 API 不返回头像 URL，因此「头像聚类」在真实抓取数据上无法使用，只能依赖 DOM \`img\` 或改用其它同批线索。`);
report.push(`- \`member.sign\`（个性签名）非空账号数：**${[...groups.values()].filter(g => [...g.signs].some(Boolean)).length}**，其中重复签名 ${repeatedSigns.length} 组 —— 这是此前规则完全没用的线索。`);
report.push(`- 等级分布：Lv2/3 ${lowLevel.length} 个账号，Lv4+ ${groups.size - lowLevel.length} 个账号。`);
report.push(`- 跨账号文本高度雷同（相似度 ≥0.82）：${dupPairs.length} 对。`);
report.push(`- 低等级账号 6 小时窗口内最多聚集 ${maxWindow.n} 个（${fmtTime(maxWindow.from)} ~ ${fmtTime(maxWindow.to)}）。\n`);

report.push('## 2. 重复签名群组（同批账号候选）\n');
report.push('| 签名 | 账号数 | 等级 | 代表昵称 | 代表评论 |');
report.push('|---|---:|---|---|---|');
for (const [sign, arr] of repeatedSigns.slice(0, 20)) {
  const g = arr[0];
  report.push(`| ${sign.replace(/\|/g, '\\|').slice(0, 40)} | ${arr.length} | ${[...g.levels].join('/')} | ${([...g.names][0] || '').slice(0, 20)} | ${(g.texts[0] || '').replace(/\|/g, '\\|').slice(0, 60)} |`);
}

report.push('\n## 3. 重复昵称模板群组\n');
report.push('| 模板 | 账号数 | 昵称示例 |');
report.push('|---|---:|---|');
for (const [tpl, arr] of repeatedNames.slice(0, 20)) {
  report.push(`| ${tpl} | ${arr.length} | ${arr.slice(0, 4).map(g => [...g.names][0]).join('、').slice(0, 70)} |`);
}

report.push('\n## 4. 跨账号文本雷同（前 20 对）\n');
report.push('| 相似度 | A | B |');
report.push('|---|---|---|');
for (const p of dupPairs.slice(0, 20)) {
  report.push(`| ${p.sim} | ${p.a.uname}: ${p.a.text.replace(/\|/g, '\\|').slice(0, 45)} | ${p.b.uname}: ${p.b.text.replace(/\|/g, '\\|').slice(0, 45)} |`);
}

report.push('\n## 5. Lv2/Lv3 低等级账号清单（待标注重点）\n');
report.push('| UID | 昵称 | Lv | 签名 | 条数 | 首条时间 | 文本摘要 |');
report.push('|---|---|---|---|---:|---|---|');
for (const g of lowLevel.slice(0, 60)) {
  const p = preview(g);
  report.push(`| ${p.uid} | ${p.uname} | ${p.level} | ${p.sign} | ${p.comments} | ${p.first} | ${p.texts[0] || ''} |`);
}

report.push('\n## 6. 抽样：Lv4+ 账号（用于确认真人基线）\n');
report.push('| UID | 昵称 | Lv | 签名 | 条数 | 文本摘要 |');
report.push('|---|---|---|---|---:|---|');
for (const g of [...groups.values()].filter(g => [...g.levels].some(l => l >= 4)).slice(0, 30)) {
  const p = preview(g);
  report.push(`| ${p.uid} | ${p.uname} | ${p.level} | ${p.sign} | ${p.comments} | ${p.texts[0] || ''} |`);
}

const out = report.join('\n');
writeFileSync(path.join(ROOT, 'samples', 'real', 'clusters.md'), out);
console.log(out.slice(0, 6000));
console.log('\n完整报告：samples/real/clusters.md');
