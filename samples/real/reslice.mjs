/* 应用户要求加速：批次 1-8 保留（每批 20，已标注），其余账号重新切成每批 60。
 * 只重新分组，不改变账号集合与顺序，也不动已写入的 labels.json。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const P = path.join(ROOT, 'samples', 'real', '标注批次.json');
const d = JSON.parse(readFileSync(P, 'utf8'));
const KEEP = 8;                       // 已标注的前 8 批
const SIZE = Number(process.argv[2] || 60);
const done = d.batches.slice(0, KEEP).flat();
const rest = d.batches.slice(KEEP).flat();
const out = d.batches.slice(0, KEEP);
for (let i = 0; i < rest.length; i += SIZE) out.push(rest.slice(i, i + SIZE));
d.batches = out;
d.totalBatches = out.length;
d.batchSizeNote = `批次 1-${KEEP} 每批 20；批次 ${KEEP + 1} 起每批 ${SIZE}（应用户要求加速）`;
writeFileSync(P, JSON.stringify(d, null, 2));
console.log('已标注', done.length, '| 剩余', rest.length, '| 新总批次', out.length,
  '| 各批条数', out.map(b => b.length).join('/'));
