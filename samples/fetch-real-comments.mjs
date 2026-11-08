/* 导出 B 站公开视频评论区数据，用于人工标注与规则设计。
 * 不携带任何登录凭据，只读公开 API；输出放在 samples/real/ 下。
 *
 * 用法：node samples/fetch-real-comments.mjs [页数]
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'samples', 'real');
mkdirSync(OUT, { recursive: true });

const BVID = 'BV1FKsX6jEDH';
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Referer': `https://www.bilibili.com/video/${BVID}/`,
  'Accept': 'application/json, text/plain, */*'
};
const PAGES = Number(process.argv[2] || 12);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(url) {
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.code !== 0) throw new Error(`code ${j.code}: ${j.message || ''}`);
  return j.data;
}

function norm(raw, ctx) {
  const m = raw.member || {};
  const ctrl = raw.reply_control || {};
  return {
    rpid: String(raw.rpid), root: String(raw.root || 0), parent: String(raw.parent || 0),
    mid: String(raw.mid || ''), uname: m.uname || '',
    face: m.face || '', sign: m.sign || '',
    level: (m.level_info && m.level_info.current_level) || 0,
    ctime: raw.ctime || 0, like: raw.like || 0, rcount: raw.rcount || 0,
    text: (raw.content && raw.content.message) || '',
    timeText: ctrl.time_text || '', location: ctrl.location || '',
    upLiked: !!(raw.up_action && raw.up_action.like),
    isSub: !!ctx.isSub, mode: ctx.mode, batch: ctx.batch
  };
}

async function main() {
  const view = await get(`https://api.bilibili.com/x/web-interface/view?bvid=${BVID}`);
  const aid = view.aid;
  const meta = { bvid: BVID, aid, title: view.title, totalReplies: view.stat && view.stat.reply, fetchedAt: new Date().toISOString() };
  console.log('视频：', meta.title, '| aid=', aid, '| 评论数=', meta.totalReplies);

  const all = new Map();
  let requests = 0;

  for (const mode of [3, 2]) {
    let next = 0;
    for (let p = 0; p < PAGES; p++) {
      const url = `https://api.bilibili.com/x/v2/reply/main?type=1&oid=${aid}&mode=${mode}&next=${next}&ps=20`;
      let data;
      try { data = await get(url); requests++; }
      catch (e) { console.log(`  mode=${mode} 第${p + 1}页失败：${e.message}`); break; }
      const replies = data.replies || [];
      for (const raw of replies) {
        const c = norm(raw, { mode, isSub: false, batch: `main-${mode}-${p + 1}` });
        all.set(c.rpid, c);
        for (const sub of (raw.replies || [])) {
          const s = norm(sub, { mode, isSub: true, batch: `preview-${mode}-${p + 1}` });
          all.set(s.rpid, s);
        }
      }
      console.log(`  mode=${mode} 第${p + 1}页：${replies.length} 条主评论，累计 ${all.size}`);
      const cur = data.cursor || {};
      if (cur.is_end || !cur.next || cur.next === next) break;
      next = cur.next;
      await sleep(260);
    }
  }

  // 对回复数较多的楼，补拉完整楼中楼
  const roots = [...all.values()].filter(c => !c.isSub && c.rcount > 3).slice(0, 12);
  for (const root of roots) {
    try {
      const data = await get(`https://api.bilibili.com/x/v2/reply/reply?type=1&oid=${aid}&root=${root.rpid}&pn=1&ps=20`);
      requests++;
      for (const raw of (data.replies || [])) {
        const s = norm(raw, { mode: root.mode, isSub: true, batch: 'sub' });
        all.set(s.rpid, s);
      }
      await sleep(260);
    } catch (e) { console.log('  楼中楼失败', root.rpid, e.message); }
  }

  const list = [...all.values()].sort((a, b) => a.ctime - b.ctime);
  writeFileSync(path.join(OUT, 'comments.json'), JSON.stringify({ meta, count: list.length, requests, comments: list }, null, 2));
  writeFileSync(path.join(OUT, 'comments.csv'),
    ['rpid', 'mid', 'uname', 'level', 'ctime', 'like', 'rcount', 'isSub', 'upLiked', 'sign', 'text', 'label']
      .join(',') + '\n' + list.map(c => [c.rpid, c.mid, c.uname, c.level, c.ctime, c.like, c.rcount,
        c.isSub ? 1 : 0, c.upLiked ? 1 : 0, c.sign.replace(/[,\n"]/g, ' '), c.text.replace(/[,\n"]/g, ' '), ''
      ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n') + '\n');

  // 统计概览
  const byLevel = {}, byName = {}, faceGroups = new Map(), signCount = new Map();
  for (const c of list) {
    byLevel[c.level] = (byLevel[c.level] || 0) + 1;
    const core = /(大肥鱼|肥鱼|小飞鲸|飞鲸|鲸娘|鲸鱼|白饭|白米饭|大米饭|小鱼干|鱼干|溟月|deepseek)/i.test(c.uname);
    const loose = /(鱼|鲸|龙|海|蓝|白)/i.test(c.uname);
    const k = core ? 'core' : loose ? 'loose' : 'none';
    byName[k] = (byName[k] || 0) + 1;
    if (c.face) faceGroups.set(c.face, (faceGroups.get(c.face) || 0) + 1);
    if (c.sign) signCount.set(c.sign, (signCount.get(c.sign) || 0) + 1);
  }
  const topFaces = [...faceGroups.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topSigns = [...signCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log('\n=== 概览 ===');
  console.log('导出条数', list.length, '| 请求数', requests, '| 主评论', list.filter(c => !c.isSub).length, '| 子回复', list.filter(c => c.isSub).length);
  console.log('等级分布', JSON.stringify(byLevel));
  console.log('昵称人设词分布', JSON.stringify(byName));
  console.log('重复最多的头像(URL 计数)', JSON.stringify(topFaces.map(([f, n]) => [f.slice(-42), n])));
  console.log('重复最多的签名', JSON.stringify(topSigns.map(([s, n]) => [s.slice(0, 24), n])));
  console.log('\n输出：samples/real/comments.json、samples/real/comments.csv（末列 label 留空供标注）');
}

main().catch(e => { console.error('导出失败：', e); process.exit(1); });
