/* 对话式分批标注工具。
 *   node samples/real/label.mjs 1                  显示第 1 批
 *   node samples/real/label.mjs 1 "同意"           采用默认初判并写盘，然后显示第 2 批
 *   node samples/real/label.mjs 1 "3a 7h"          采用默认 + 只改第 3、7 个，然后显示第 2 批
 *   node samples/real/label.mjs 1 "ahhms..."        20 个字母整串覆盖
 *   node samples/real/label.mjs 1 "全部h"           整批同一个标签
 * 标签：a=AI自动发评(隐藏) s=人机共用(只标记) h=真人 m=真人玩梗 d=广告 u=不确定
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'samples', 'real');
const batches = JSON.parse(readFileSync(path.join(DIR, '标注批次.json'), 'utf8'));
const LABELS_FILE = path.join(DIR, 'labels.json');
const VALID = new Set(['a', 's', 'h', 'm', 'd', 'u']);

const n = Number(process.argv[2] || 1);
const answer = (process.argv[3] || '').trim();
const B = batches.totalBatches;
if (n < 1 || n > B) { console.log(`批次需在 1..${B} 之间`); process.exit(1); }

const store = JSON.parse(readFileSync(LABELS_FILE, 'utf8'));
store.labels = store.labels || {};

function short(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : (t || '-');
}

function show(batchNo) {
  const list = batches.batches[batchNo - 1];
  const start = batches.batches.slice(0, batchNo - 1).reduce((s, b) => s + b.length, 0);
  console.log(`\n===== 批次 ${batchNo}/${B}（账号 ${start + 1}-${start + list.length} / 共 ${batches.totalAccounts}）=====`);
  console.log('标签  a=AI自动发评(隐藏)  s=人机共用(只标记)  h=真人  m=真人玩梗  d=广告  u=不确定');
  console.log(`行尾 [?x] 是我的默认初判。回「同意」采用；或「3a 7h」改个别；或 ${list.length} 字母整串；或「全部h」。\n`);
  list.forEach((a, i) => {
    const no = String(i + 1).padStart(2, '0');
    console.log(`${no} ${short(a.uname, 12).padEnd(14)} L${a.level} 签:${short(a.sign, 16).padEnd(18)} │ ${short(a.text, 62).padEnd(64)} [?${a.def}]`);
  });
  console.log(`\n已标注 ${Object.keys(store.labels).length}/${batches.totalAccounts} 个账号。`);
}

function parse(list, ans) {
  const out = list.map(a => a.def);
  if (!ans || /^(同意|ok|OK|是|默认|通过|y|yes)$/i.test(ans)) return out;
  const all = ans.match(/^全部\s*([ashmdu])$/i);
  if (all) return list.map(() => all[1].toLowerCase());
  // 「3a 7h」或「3:a」局部修改
  const pairs = [...ans.matchAll(/(\d{1,2})\s*[:：]?\s*([ashmduASHMDU])\b/g)];
  if (pairs.length) {
    for (const [, idx, lab] of pairs) {
      const i = Number(idx) - 1;
      if (i >= 0 && i < out.length) out[i] = lab.toLowerCase();
    }
    return out;
  }
  // 20 个字母整串
  const letters = ans.replace(/[^ashmduASHMDU]/g, '').toLowerCase();
  if (letters.length === list.length) return [...letters];
  if (letters.length && letters.length < list.length) {
    for (let i = 0; i < letters.length; i++) out[i] = letters[i];
    return out;
  }
  return null;
}

if (answer) {
  const list = batches.batches[n - 1];
  const parsed = parse(list, answer);
  if (!parsed) {
    console.log(`无法解析「${answer}」。可用：同意 / 3a 7h / 全部h / 20 个字母整串`);
    process.exit(2);
  }
  list.forEach((a, i) => { store.labels[a.uid] = parsed[i]; });
  store.updatedAt = new Date().toISOString();
  writeFileSync(LABELS_FILE, JSON.stringify(store, null, 2));
  const counts = {};
  for (const v of Object.values(store.labels)) counts[v] = (counts[v] || 0) + 1;
  console.log(`批次 ${n} 已写入：${parsed.join('')} ｜ 累计标签分布 ${JSON.stringify(counts)}`);
  if (n < B) show(n + 1);
  else {
    console.log('\n===== 全部批次标注完成 =====');
    console.log('累计标签分布', JSON.stringify(counts));
    console.log('结果文件：samples/real/labels.json');
  }
} else {
  show(n);
}
