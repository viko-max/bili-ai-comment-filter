/* 用当前规则跑一遍真实评论，暴露误报；并生成便于人工标注的分组清单。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const U = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'utils.js'));
const C = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'constants.js'));
const Rules = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'rules.js'));
const data = JSON.parse(readFileSync(path.join(ROOT, 'samples', 'real', 'comments.json'), 'utf8'));
const cs = data.comments;

const comments = cs.map(c => ({
  key: 'r:' + c.rpid, rpid: c.rpid, uid: c.mid, uname: c.uname, level: c.level,
  text: c.text, ctime: c.ctime, oid: String(data.meta.aid), videoId: data.meta.bvid,
  like: c.like, replyCount: c.rcount, avatarKey: '', sign: c.sign, isSub: c.isSub
}));
const res = Rules.evaluatePage({
  comments, settings: C.DEFAULT_SETTINGS,
  lists: { whitelist: [], blocklist: [] }, overrides: {}, sessionComments: []
});

const counts = { hide: 0, mark: 0, keep: 0 };
for (const d of res.decisions) counts[d.decision]++;
console.log('当前规则在真实数据上的判定：', JSON.stringify(counts), '/ 共', res.decisions.length, '条');

const byUid = new Map();
for (const c of cs) {
  const k = c.mid;
  if (!byUid.has(k)) byUid.set(k, { uid: k, uname: c.uname, level: c.level, sign: c.sign, texts: [], sub: 0 });
  byUid.get(k).texts.push(c.text);
  if (c.isSub) byUid.get(k).sub++;
}
const accDec = new Map();
for (const [uid, a] of Object.entries(res.accounts)) accDec.set(uid, a);

const AI_SIGN = /(大肥鱼|肥鱼|鲸鱼娘|dsh|deepseek\s*harness|主人|本账号由|接管|ai\s*运营|智能体|自动发|仓库：)/i;
const FISH_CORE = /(大肥鱼|肥鱼|小飞鲸|飞鲸|鲸娘|鲸鱼娘|鲸鱼|白饭|白米饭|小鱼干|溟月|deepseek)/i;
const FISHING = /(🎣|💰人来|token\s*来|鱼来|打窝|空军|钓)/i;
const AD = /(https?:\/\/|\.top\b|\.xyz\b|\.cc\b|加微|领取|订阅验证)/i;

const groups = { A: [], B: [], C: [], D: [], E: [], F: [] };
for (const [uid, a] of byUid) {
  const text = a.texts.join(' ');
  const row = {
    uid, uname: a.uname, level: a.level, sign: a.sign, n: a.texts.length,
    text: text.replace(/\s+/g, ' ').slice(0, 100),
    decision: (accDec.get(uid) || {}).decision || 'keep',
    score: (accDec.get(uid) || {}).score || 0,
    cats: ((accDec.get(uid) || {}).strongCategories || []).join('、')
  };
  if (AD.test(text)) groups.D.push(row);
  else if (FISHING.test(text) && /(来！|人来|🎣|💰)/.test(text)) groups.C.push(row);
  else if (AI_SIGN.test(a.sign) || AI_SIGN.test(a.uname)) groups.A.push(row);
  else if (FISH_CORE.test(a.uname)) groups.B.push(row);
  else if (a.level >= 4) groups.E.push(row);
  else groups.F.push(row);
}

const md = [];
md.push('# 真实评论区 · 当前规则判定现状 + 待人工标注清单\n');
md.push(`视频：${data.meta.title}（${data.meta.bvid}）｜ 导出 ${cs.length} 条 / ${byUid.size} 个账号｜ ${data.meta.fetchedAt}\n`);
md.push('> **本文件不下结论**。请把「你的标签」填成 `auto`（AI 自动发评，应隐藏）/ `human`（真人，应保留）/ `meme`（真人玩梗）/ `ad`（广告，不属于本扩展目标）/ `uncertain`，然后把文件发回给我，我按标注重做规则与对照实验。\n');
md.push('## 当前规则判定（未标注前的现状）\n');
md.push(`| 处置 | 条数 |`);
md.push(`|---|---:|`);
md.push(`| 隐藏 | ${counts.hide} |`);
md.push(`| 标记 | ${counts.mark} |`);
md.push(`| 保留 | ${counts.keep} |`);
md.push('\n> 注意：`member.face` 在这份未登录公开 API 里全为空，所以「头像聚类」在本次离线复算中完全没生效；这正是需要改用其它线索的原因。\n');

const captions = {
  A: 'A 组｜昵称或个性签名里明确自述 AI / DSH / 主人 / 大肥鱼运营（最像自动发评）',
  B: 'B 组｜昵称属于鱼系人设族，但签名无自述（可能是 AI，也可能是真人串子）',
  C: 'C 组｜鱼系昵称 + 钓鱼/打窝复读文本（很可能是真人玩梗，需你确认）',
  D: 'D 组｜含外链/推广，疑似广告号（本扩展不应隐藏）',
  E: 'E 组｜Lv4+ 且无人设线索（真人基线，用于验证误报）',
  F: 'F 组｜Lv2/Lv3 且无人设线索（最不确定，最需要人工看）'
};
for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const arr = groups[k];
  md.push(`\n## ${captions[k]} — ${arr.length} 个账号\n`);
  md.push('| UID | 昵称 | Lv | 签名 | 条 | 当前判定 | 得分 | 文本摘要 | 你的标签 |');
  md.push('|---|---|---:|---|---:|---|---|---|---|');
  for (const r of arr.slice(0, 80)) {
    md.push(`| ${r.uid} | ${r.uname.replace(/\|/g, '\\|')} | ${r.level} | ${(r.sign || '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 28)} | ${r.n} | ${r.decision} | ${r.score} | ${r.text.replace(/\|/g, '\\|').slice(0, 68)} |  |`);
  }
  if (arr.length > 80) md.push(`\n> 还有 ${arr.length - 80} 个账号未列出，完整数据在 \`comments.csv\`。`);
}

writeFileSync(path.join(ROOT, 'samples', 'real', '待标注清单.md'), md.join('\n'));
console.log('分组账号数：', JSON.stringify(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length]))));
console.log('报告：samples/real/待标注清单.md');

// 额外输出：当前规则判隐藏/标记的账号里，文本看起来像真人的部分
const suspicious = [...accDec.entries()]
  .filter(([, a]) => a.decision !== 'keep')
  .map(([uid, a]) => ({ uid, uname: a.uname, level: a.level, decision: a.decision, score: a.score,
    cats: a.strongCategories, text: (byUid.get(uid) || { texts: [] }).texts.join(' ').replace(/\s+/g, ' ').slice(0, 80) }));
console.log('\n当前规则给出 hide/mark 的账号数：', suspicious.length);
console.log(JSON.stringify(suspicious.slice(0, 12), null, 1));
