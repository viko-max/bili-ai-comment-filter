/* v2 规则在真实评论区上的判定结果报告（可复现）。 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const C = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'constants.js'));
const Rules = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'rules.js'));
const data = JSON.parse(readFileSync(path.join(ROOT, 'samples', 'real', 'comments.json'), 'utf8'));

const comments = data.comments.map(c => ({
  key: 'r:' + c.rpid, rpid: c.rpid, uid: c.mid, uname: c.uname, sign: c.sign,
  level: c.level, text: c.text, ctime: c.ctime, oid: String(data.meta.aid),
  like: c.like, replyCount: c.rcount, avatarKey: ''
}));
const res = Rules.evaluatePage({
  comments, settings: C.DEFAULT_SETTINGS,
  lists: { whitelist: [], blocklist: [] }, overrides: {}, sessionComments: []
});

const byUid = new Map();
for (const c of data.comments) {
  if (!byUid.has(c.mid)) byUid.set(c.mid, { uid: c.mid, uname: c.uname, level: c.level, sign: c.sign, texts: [] });
  byUid.get(c.mid).texts.push(c.text);
}
const counts = { hide: 0, mark: 0, keep: 0 };
for (const d of res.decisions) counts[d.decision]++;
const acc = Object.values(res.accounts);

const hidden = acc.filter(a => a.decision === 'hide');
const marked = acc.filter(a => a.decision === 'mark');
const highNoPersona = acc.filter(a => a.level >= 4 &&
  !C.PERSONA_CORE_RE.test(a.uname) && !(byUid.get(a.uid) || { sign: '' }).sign);
const highNoPersonaBad = highNoPersona.filter(a => a.decision !== 'keep');
const fishingAccounts = acc.filter(a => C.FISHING_REPEAT_RE.test((byUid.get(a.uid) || { texts: [] }).texts.join(' ')));
const fishingBad = fishingAccounts.filter(a => a.decision !== 'keep');
const adAccounts = acc.filter(a => C.AD_RE.test((byUid.get(a.uid) || { texts: [] }).texts.join(' ')));
const adBad = adAccounts.filter(a => a.decision !== 'keep');

const md = [];
md.push('# v2 极保守规则 · 真实评论区判定结果\n');
md.push(`视频：${data.meta.title}（${data.meta.bvid}）｜ 导出 ${data.comments.length} 条 / ${byUid.size} 个账号｜ 生成 ${new Date().toISOString()}\n`);
md.push('> 口径由用户拍板：只有「个性签名自述 AI/DSH/主人 + 文本对主人说话/自动浏览复述」才隐藏；人机共用号只标记；钓鱼打窝复读判真人永不隐藏；按自述判定不限定人设形象。\n');
md.push('## 总览\n');
md.push('| 处置 | 评论条数 | 账号数 |');
md.push('|---|---:|---:|');
for (const k of ['hide', 'mark', 'keep']) {
  md.push(`| ${k === 'hide' ? '隐藏' : k === 'mark' ? '标记' : '保留'} | ${counts[k]} | ${acc.filter(a => a.decision === k).length} |`);
}
md.push('\n## 回归检查（用户两轮误报场景）\n');
md.push(`| 检查项 | 账号数 | 被误处置 | 结果 |`);
md.push('|---|---:|---:|---|');
md.push(`| Lv4+ 且无人设昵称/签名（真人技术讨论） | ${highNoPersona.length} | ${highNoPersonaBad.length} | ${highNoPersonaBad.length === 0 ? 'PASS' : 'FAIL'} |`);
md.push(`| 钓鱼打窝复读文本 | ${fishingAccounts.length} | ${fishingBad.length} | ${fishingBad.length === 0 ? 'PASS' : 'FAIL'} |`);
md.push(`| 外链广告号 | ${adAccounts.length} | ${adBad.length} | ${adBad.length === 0 ? 'PASS' : 'FAIL'} |`);
md.push(`| 全部真人（无误藏） | — | ${res.decisions.filter(d => d.decision === 'hide').length} 条隐藏 | 需人工核对下方清单 |\n`);

md.push('## 被隐藏的账号（请重点核对）\n');
md.push('| UID | 昵称 | Lv | 签名 | 判定依据 | 评论摘要 |');
md.push('|---|---|---:|---|---|---|');
for (const a of hidden) {
  const g = byUid.get(a.uid) || { sign: '', texts: [] };
  md.push(`| ${a.uid} | ${a.uname} | ${a.level} | ${(g.sign || '').slice(0, 30)} | ${a.why} | ${g.texts.join(' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 90)} |`);
}

md.push('\n## 被标记的账号（可见，不隐藏）\n');
md.push('| UID | 昵称 | Lv | 判定依据 | 评论摘要 |');
md.push('|---|---|---:|---|---|');
for (const a of marked) {
  const g = byUid.get(a.uid) || { texts: [] };
  md.push(`| ${a.uid} | ${a.uname} | ${a.level} | ${a.why} | ${g.texts.join(' ').replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 80)} |`);
}

md.push('\n## 说明\n');
md.push('- `member.face` 在本次公开 API 数据中全为空，头像聚类未参与判定；DOM 头像仅作可选佐证。');
md.push('- 视频主题词（Claude / token / 冒充 / 额度 / Pro 等）一律不作为证据。');
md.push('- 本报告的「隐藏」口径是用户选择的极保守策略，其余疑似 AI 账号按「证据不足」保留或标记，属于设计内取舍，不是规则失败。');
md.push('- 完整逐账号标注表见 `待标注清单.md`（`你的标签` 列仍待人工填写）。');

writeFileSync(path.join(ROOT, 'samples', 'real', '规则v2判定结果.md'), md.join('\n'));
console.log('判定 hide/mark/keep =', counts.hide, counts.mark, counts.keep);
console.log('高等级无人设真人误标', highNoPersonaBad.length, '/', highNoPersona.length,
  '| 钓鱼复读误处置', fishingBad.length, '/', fishingAccounts.length,
  '| 广告误处置', adBad.length, '/', adAccounts.length);
console.log('报告：samples/real/规则v2判定结果.md');
