/* 用 426 个真实人工标注推导判定规则。
 * 输出：等级×标签交叉表、各标签特征命中率、若干候选规则在真实标签上的混淆矩阵。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const C = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'constants.js'));
const U = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'utils.js'));
const batches = JSON.parse(readFileSync(path.join(ROOT, 'samples/real/标注批次.json'), 'utf8'));
const labels = JSON.parse(readFileSync(path.join(ROOT, 'samples/real/labels.json'), 'utf8')).labels;
const raw = JSON.parse(readFileSync(path.join(ROOT, 'samples/real/comments.json'), 'utf8'));

const textsByUid = new Map();
for (const c of raw.comments) {
  const k = c.mid;
  if (!textsByUid.has(k)) textsByUid.set(k, []);
  textsByUid.get(k).push(c.text);
}

const SIGN_RE = /(大肥鱼|肥鱼|鲸鱼娘|鲸娘|小飞鲸|小鲸运营|住在电脑里|dsh|deepseek|harness|本账号由|本账号目前|本账号|接管|共享账号|共用账号|与主人|主人|运营中|运营|仓库|github|本鱼会|智能体|自动发|每天也在逛|插件|大小姐|已接入|gpt|小龙娘|claude|bot)/i;
const PERSONA_WORDS = ['本鱼', '本鲸', '本座', '白饭', '白米饭', '大米饭', '小鱼干', '鱼干', '管饱',
  '投喂', '喂本', '摸鱼', '咕噜', '撑死', '吃呀', '讨口饭', '跑点token', '偷吃token', '讨token',
  '主人', '替班', '加班', '正版', '吃token', '傲娇', '鲸尾', '鱼鱼', '鱼儿', '饭',
  '鲸娘', '龙娘', '大小姐', '蓝头发', '窗口', '工位'];
const SPEECH_RE = /(主人，我看完|谢谢主人|主人点我|主人说|主人给|主人让我|我是跟着字幕|跟着字幕和弹幕|跟着字幕|我看完啦|谢谢主人点我|点我看这个)/;
const HUMAN_RE = /(我刚|我上次|我之前|能不能|有没有人|\d{1,2}:\d{2}|笑死|哈哈哈|doge|求|请教|没看懂|建议|其实|我应该|我记得|我看到)/i;
const TOPIC_RE = /(中转站|顶配|票|钱到底给谁|冒充|换演员|窗口|面具|差价|claude|deepseek|token)/i;

const accounts = batches.batches.flat().map(a => {
  const full = (textsByUid.get(a.uid) || [a.text]).join('\n');
  const persona = U.countHits(full, PERSONA_WORDS).count;
  return {
    uid: a.uid, uname: a.uname, level: a.level, sign: a.sign, text: full,
    label: labels[a.uid] || 'h',
    f: {
      low: a.level > 0 && a.level <= 3,
      high: a.level >= 4,
      nameCore: C.PERSONA_CORE_RE.test(a.uname),
      nameLoose: C.PERSONA_LOOSE_RE.test(a.uname),
      signAI: SIGN_RE.test(a.sign || ''),
      persona,
      speech: SPEECH_RE.test(full),
      fishing: C.FISHING_REPEAT_RE.test(full),
      ad: C.AD_RE.test(full),
      human: HUMAN_RE.test(full),
      topic: TOPIC_RE.test(full),
      short: Math.max(...(textsByUid.get(a.uid) || [a.text]).map(t => String(t).length)) <= 28,
      at: /@/.test(full)
    }
  };
});

const HIDE = new Set(['a', 'd']);       // 用户确认要隐藏：AI 自动发评 + 广告
const KEEP = new Set(['h', 'm']);       // 用户确认保留：真人 + 真人玩梗
const MARK = new Set(['s']);            // 人机共用：只标记不隐藏

function evaluate(name, fn) {
  let tp = 0, fp = 0, fn_ = 0, tn = 0, markHit = 0, markWrong = 0;
  const errors = [];
  for (const a of accounts) {
    const d = fn(a);
    const shouldHide = HIDE.has(a.label);
    if (d === 'hide' && shouldHide) tp++;
    else if (d === 'hide' && !shouldHide) { fp++; errors.push(['误藏', a.label, a.uname, 'L' + a.level, a.text.slice(0, 42)]); }
    else if (d !== 'hide' && shouldHide) { fn_++; errors.push(['漏判', a.label, a.uname, 'L' + a.level, a.text.slice(0, 42)]); }
    else tn++;
    if (d === 'mark' && MARK.has(a.label)) markHit++;
    if (d === 'mark' && !MARK.has(a.label) && !shouldHide) markWrong++;
  }
  const precision = tp / Math.max(1, tp + fp);
  const recall = tp / Math.max(1, tp + fn_);
  const f1 = 2 * precision * recall / Math.max(1e-9, precision + recall);
  return { name, tp, fp, fn: fn_, tn, precision, recall, f1, markHit, markWrong, errors };
}

const rules = [
  ['R0 v2 极保守（签名自述+对主人说话）', a =>
    a.f.ad ? 'hide' : (a.f.signAI && a.f.speech && a.f.low ? 'hide' : (a.f.high && a.f.signAI ? 'mark' : 'keep'))],
  ['R1 低等级+任一身份信号', a =>
    a.f.ad ? 'hide' : (a.f.low && (a.f.nameCore || a.f.nameLoose || a.f.signAI || a.f.persona >= 1 || a.f.speech) ? 'hide'
      : (a.f.high && a.f.signAI ? 'mark' : 'keep'))],
  ['R2 低等级+核心身份信号（不含弱鱼字）', a =>
    a.f.ad ? 'hide' : (a.f.low && (a.f.nameCore || a.f.signAI || a.f.persona >= 2 || a.f.speech) ? 'hide'
      : (a.f.high && a.f.signAI ? 'mark' : 'keep'))],
  ['R3 R2 + 排除打窝/真人口语/纯短评', a => {
    if (a.f.fishing || a.f.ad === false && a.f.human && a.f.short) return 'keep';
    if (a.f.ad) return 'hide';
    if (a.f.low && (a.f.nameCore || a.f.signAI || a.f.persona >= 2 || a.f.speech)) return 'hide';
    if (a.f.high && a.f.signAI) return 'mark';
    return 'keep';
  }],
  ['R4 R3 + 签名自述低等级一律隐藏', a => {
    if (a.f.fishing) return 'keep';
    if (a.f.ad) return 'hide';
    if (a.f.low && a.f.signAI) return 'hide';
    if (a.f.low && (a.f.nameCore || a.f.persona >= 2 || a.f.speech)) return 'hide';
    if (a.f.high && a.f.signAI) return 'mark';
    return 'keep';
  }],
  ['R5 低等级+身份信号，排除打窝/短评真人口语/高等级自述', a => {
    if (a.f.ad) return 'hide';
    if (a.f.fishing) return 'keep';
    if (a.f.high) return a.f.signAI ? 'mark' : 'keep';
    if (a.f.short && a.f.human) return 'keep';
    if (a.f.nameCore || a.f.nameLoose || a.f.signAI || a.f.persona >= 1 || a.f.speech) return 'hide';
    return 'keep';
  }],
  ['R6 R5 + 签名自述低等级只标记（人机共用）', a => {
    if (a.f.ad) return 'hide';
    if (a.f.fishing) return 'keep';
    if (a.f.high) return a.f.signAI ? 'mark' : 'keep';
    if (a.f.short && a.f.human) return 'keep';
    if (a.f.signAI && !a.f.nameCore && !a.f.speech && a.f.persona < 1) return 'mark';
    if (a.f.nameCore || a.f.nameLoose || a.f.signAI || a.f.persona >= 1 || a.f.speech) return 'hide';
    return 'keep';
  }]
];

const lines = [];
lines.push('# 426 个真实人工标注 · 判定规律分析\n');
lines.push(`> 数据源：\`samples/real/labels.json\`（用户逐批标注）+ \`comments.json\`（完整评论文本）。\n`);
lines.push('## 标签分布\n');
const dist = {};
for (const a of accounts) dist[a.label] = (dist[a.label] || 0) + 1;
lines.push('| 标签 | 含义 | 数量 | 处置 |');
lines.push('|---|---|---:|---|');
const legend = {
  a: ['AI 自动发评', '隐藏'], s: ['人机共用（高等级+签名自述）', '只标记'],
  h: ['真人', '保留'], m: ['真人玩梗 / 钓鱼打窝', '保留'], d: ['广告（带链接）', '隐藏']
};
for (const k of ['a', 's', 'h', 'm', 'd']) lines.push(`| ${k} | ${legend[k][0]} | ${dist[k] || 0} | ${legend[k][1]} |`);
lines.push(`\n隐藏类 ${dist.a + dist.d} 个，标记类 ${dist.s} 个，保留类 ${dist.h + dist.m} 个。\n`);

lines.push('## 等级 × 标签（最强分界）\n');
lines.push('| 等级 | a 隐藏 | s 标记 | h 真人 | m 玩梗 | d 广告 |');
lines.push('|---|---:|---:|---:|---:|---:|');
for (const [name, pred] of [['Lv2-3', a => a.f.low], ['Lv4-6', a => a.f.high]]) {
  const g = accounts.filter(pred);
  const c = {}; for (const a of g) c[a.label] = (c[a.label] || 0) + 1;
  lines.push(`| ${name} (${g.length}) | ${c.a || 0} | ${c.s || 0} | ${c.h || 0} | ${c.m || 0} | ${c.d || 0} |`);
}

lines.push('\n## 各标签的特征命中率\n');
const featNames = ['nameCore', 'nameLoose', 'signAI', 'persona', 'speech', 'fishing', 'ad', 'human', 'topic', 'short', 'at'];
lines.push('| 标签 | ' + featNames.join(' | ') + ' |');
lines.push('|---|' + featNames.map(() => '---:').join('|') + '|');
for (const lab of ['a', 's', 'h', 'm', 'd']) {
  const g = accounts.filter(a => a.label === lab);
  const cells = featNames.map(f => {
    const n = g.filter(a => typeof a.f[f] === 'number' ? a.f[f] >= 1 : a.f[f]).length;
    return Math.round(n / g.length * 100) + '%';
  });
  lines.push(`| ${lab} (${g.length}) | ${cells.join(' | ')} |`);
}

lines.push('\n## 候选规则在真实标签上的表现\n');
lines.push('| 规则 | 正确隐藏 | 误藏 | 漏判 | 精确率 | 召回率 | F1 |');
lines.push('|---|---:|---:|---:|---:|---:|---:|');
const results = rules.map(([n, f]) => evaluate(n, f));
for (const r of results) lines.push(`| ${r.name} | ${r.tp} | ${r.fp} | ${r.fn} | ${r.precision.toFixed(3)} | ${r.recall.toFixed(3)} | ${r.f1.toFixed(3)} |`);

const best = results.slice().sort((x, y) => y.f1 - x.f1 || y.precision - x.precision)[0];
lines.push(`\n**最优：${best.name}**（F1 ${best.f1.toFixed(3)}，精确率 ${best.precision.toFixed(3)}，召回率 ${best.recall.toFixed(3)}）\n`);
lines.push('### 最优规则的误判明细\n');
lines.push('| 类型 | 真实标签 | 昵称 | 等级 | 文本 |');
lines.push('|---|---|---|---|---|');
for (const e of best.errors.slice(0, 40)) lines.push(`| ${e[0]} | ${e[1]} | ${e[2]} | ${e[3]} | ${e[4].replace(/\|/g, '\\|').replace(/\s+/g, ' ')} |`);
if (best.errors.length > 40) lines.push(`\n> 还有 ${best.errors.length - 40} 条未列出。`);

writeFileSync(path.join(ROOT, 'samples/real/标注分析与规则推导.md'), lines.join('\n'));
console.log(lines.slice(0, 34).join('\n'));
console.log('\n完整报告：samples/real/标注分析与规则推导.md');
