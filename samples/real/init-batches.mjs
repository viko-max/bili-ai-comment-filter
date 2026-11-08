/* 把真实评论区的 426 个账号切成每批 20 个的对话式标注任务。
 * 排序：最需要人工判断的排前面（签名自述 > 鱼系昵称 > 钓鱼复读 > 低等级无特征 >
 * 广告 > Lv4+ 无特征），让前几批就覆盖所有边界账号。
 * 每行给一个「默认初判」，用户回「同意」即可整批采用。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const C = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'constants.js'));
const U = require(path.join(ROOT, 'bili-ai-comment-filter', 'src', 'shared', 'utils.js'));
const data = JSON.parse(readFileSync(path.join(ROOT, 'samples', 'real', 'comments.json'), 'utf8'));

const byUid = new Map();
for (const c of data.comments) {
  const k = c.mid || ('anon-' + c.rpid);
  if (!byUid.has(k)) byUid.set(k, { uid: k, uname: c.uname, level: c.level, sign: c.sign, texts: [], likes: 0 });
  const g = byUid.get(k);
  g.texts.push(c.text);
  g.likes += c.like || 0;
  if (!g.sign && c.sign) g.sign = c.sign;
}

const SIGN_AI = U.countHits ? null : null; // 用下面的简化判定
function hasSignAI(s) {
  return /(大肥鱼|肥鱼|鲸鱼娘|鲸娘|小飞鲸|小鲸运营|住在电脑里|dsh|deepseek|harness|本账号由|本账号目前|本账号|接管|共享账号|共用账号|与主人|主人|运营中|运营|仓库|github|本鱼会|ai\s*运营|智能体|自动发|每天也在逛|插件|大小姐)/i.test(s || '');
}
function hasSpeech(t) {
  return /(主人，我看完|谢谢主人|主人点我|主人说|主人给|主人让我|按主人|我是跟着字幕|跟着字幕和弹幕|跟着字幕|我看完啦|本鱼看完|本鲸看完|谢谢主人点我|主人，|点我看这个)/.test(t || '');
}
function coreName(n) { return C.PERSONA_CORE_RE.test(n || ''); }
function fishing(t) { return C.FISHING_REPEAT_RE.test(t || ''); }
function ad(t) { return C.AD_RE.test(t || ''); }
function lowLevel(l) { return l > 0 && l <= 3; }

const accounts = [...byUid.values()].map(g => {
  const text = g.texts.join(' ').replace(/\s+/g, ' ');
  const signAI = hasSignAI(g.sign);
  const speech = hasSpeech(text);
  const core = coreName(g.uname);
  const fish = fishing(text);
  const isAd = ad(text);
  const high = g.level >= 4;

  let prio, def;
  if (signAI) {
    prio = 0;
    def = (speech && lowLevel(g.level)) ? 'a' : 's';
  } else if (core) {
    prio = 1;
    def = (speech && lowLevel(g.level)) ? 'a' : 'h';
  } else if (fish) {
    prio = 2; def = 'm';
  } else if (isAd) {
    prio = 3; def = 'd';
  } else if (lowLevel(g.level)) {
    prio = 4; def = 'h';
  } else {
    prio = 5; def = 'h';
  }

  return {
    uid: g.uid, uname: g.uname, level: g.level, sign: g.sign,
    text: text.slice(0, 150), comments: g.texts.length, likes: g.likes,
    prio, def
  };
});

accounts.sort((a, b) => a.prio - b.prio || String(a.uid).localeCompare(String(b.uid)));

const SIZE = 20;
const batches = [];
for (let i = 0; i < accounts.length; i += SIZE) batches.push(accounts.slice(i, i + SIZE));
const totalBatches = batches.length;

const payload = {
  createdAt: new Date().toISOString(),
  source: data.meta.bvid,
  totalAccounts: accounts.length,
  batchSize: SIZE,
  totalBatches,
  legend: {
    a: 'AI 自动发评，应隐藏',
    s: '人机共用 / 签名自述但边界模糊，只标记不隐藏',
    h: '真人，保留',
    m: '真人玩梗 / 钓鱼打窝，保留',
    d: '广告，不属于本扩展目标',
    u: '不确定，先跳过'
  },
  batches
};
writeFileSync(path.join(ROOT, 'samples', 'real', '标注批次.json'), JSON.stringify(payload, null, 2));
if (!require('node:fs').existsSync(path.join(ROOT, 'samples', 'real', 'labels.json'))) {
  writeFileSync(path.join(ROOT, 'samples', 'real', 'labels.json'), JSON.stringify({ labels: {}, updatedAt: new Date().toISOString() }, null, 2));
}

console.log('账号总数', accounts.length, '| 批次', totalBatches, '| 每批', SIZE);
const byPrio = {};
for (const a of accounts) byPrio[a.prio] = (byPrio[a.prio] || 0) + 1;
console.log('优先级分布', JSON.stringify(byPrio), '(0签名自述 1鱼系昵称 2钓鱼复读 3低等级 4广告 5高等级真人)');
console.log('输出：samples/real/标注批次.json、samples/real/labels.json');
