/* 抓取真实 B 站视频页的评论区 DOM 结构（含 Shadow DOM），用于校准选择器。
 * 只输出标签/类名/属性/层级，不输出评论正文全文（截断 24 字）。
 */
import puppeteer from 'puppeteer-core';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const URL_ = process.argv[2] || 'https://www.bilibili.com/video/BV1FKsX6jEDH/';

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--no-first-run', '--no-default-browser-check', '--lang=zh-CN'],
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 60000
});

const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 });

// 评论区需要滚动并等待异步加载
await page.evaluate(() => {
  const el = document.querySelector('bili-comments') || document.querySelector('#comment');
  if (el) el.scrollIntoView({ block: 'center' });
});
await new Promise(r => setTimeout(r, 1500));
for (let i = 0; i < 20; i++) {
  await page.evaluate(() => window.scrollBy(0, 400));
  await new Promise(r => setTimeout(r, 400));
}
// 等 spinner 消失或评论项出现，最多 25 秒
for (let i = 0; i < 50; i++) {
  const ok = await page.evaluate(() => {
    const host = document.querySelector('bili-comments');
    const root = host && host.shadowRoot;
    if (!root) return false;
    if (root.querySelector('bili-comment-thread-renderer, .reply-item, [data-rpid]')) return true;
    const sp = root.querySelector('bili-comments-spinner');
    return !sp;
  });
  if (ok) break;
  await new Promise(r => setTimeout(r, 500));
}
await new Promise(r => setTimeout(r, 2500));

const info = await page.evaluate(() => {
  const ITEM = ['.reply-item', '.sub-reply-item', '.reply-wrap', '.comment-item', '.comment-list-item',
    'bili-comment-renderer', 'bili-comment-reply-renderer', 'bili-comment-thread-renderer',
    '[data-rpid]'].join(',');
  const TEXT = '.reply-content, .comment-text, .comment-content, bili-rich-text, .content-text, .text-con, .text, [class*="reply-content"], [class*="comment-text"]';

  const roots = [{ name: 'document', root: document }];
  const seen = new Set();
  function collect(r, depth) {
    if (depth > 6) return;
    let all = [];
    try { all = [...r.querySelectorAll('*')]; } catch (_) { return; }
    for (const el of all) {
      if (el.shadowRoot && !seen.has(el.shadowRoot)) {
        seen.add(el.shadowRoot);
        roots.push({ name: `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 40)}">`, root: el.shadowRoot });
        collect(el.shadowRoot, depth + 1);
      }
    }
  }
  collect(document, 0);

  const desc = (el) => ({
    tag: el.tagName.toLowerCase(),
    cls: String(el.className || '').slice(0, 70),
    id: el.id || '',
    rpid: el.getAttribute('data-rpid') || el.getAttribute('data-reply-id') || '',
    mid: el.getAttribute('data-mid') || el.getAttribute('data-uid') || '',
    msgLen: String(el.textContent || '').trim().length,
    childEls: el.children.length,
    hasText: false,
    hasAvatar: false,
    sample: String(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24)
  });

  // 1) 每个 shadow root 里，ITEM 选择器命中了什么
  const itemHits = [];
  for (const { name, root } of roots) {
    let hits = [];
    try { hits = [...root.querySelectorAll(ITEM)]; } catch (_) {}
    if (!hits.length) continue;
    itemHits.push({
      scope: name,
      count: hits.length,
      items: hits.slice(0, 6).map(el => {
        const d = desc(el);
        d.hasText = !!(el.querySelector && el.querySelector(TEXT));
        d.hasAvatar = !!(el.querySelector && el.querySelector('img'));
        // 祖先链
        d.ancestors = [];
        let p = el.parentElement;
        for (let i = 0; i < 4 && p; i++, p = p.parentElement) {
          d.ancestors.push(`<${p.tagName.toLowerCase()} class="${String(p.className).slice(0, 46)}">`);
        }
        // 正文容器
        const t = el.querySelector && el.querySelector(TEXT);
        d.textNode = t ? `<${t.tagName.toLowerCase()} class="${String(t.className).slice(0, 46)}">` : '(none)';
        return d;
      })
    });
  }

  // 2) 评论区根容器
  const commentRoots = [];
  for (const sel of ['#comment', '.comment-container', 'bili-comments', '.reply-list', '#commentapp']) {
    const el = document.querySelector(sel);
    if (el) commentRoots.push({ sel, tag: el.tagName.toLowerCase(), cls: String(el.className).slice(0, 50), childEls: el.children.length });
  }

  // 3) 点击可用性：检查评论区内按钮是否被覆盖
  const clickCheck = [];
  const allRoots = roots.map(x => x.root);
  for (const r of allRoots) {
    let btns = [];
    try { btns = [...r.querySelectorAll('button, .reply-btn, [class*="btn"]')].slice(0, 5); } catch (_) {}
    for (const b of btns) {
      const rect = b.getBoundingClientRect();
      if (rect.width < 2 || rect.height < 2) continue;
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const top = document.elementFromPoint(cx, cy);
      clickCheck.push({
        btn: `<${b.tagName.toLowerCase()} class="${String(b.className).slice(0, 40)}">`,
        text: String(b.textContent || '').trim().slice(0, 12),
        rect: [Math.round(rect.width), Math.round(rect.height)],
        topmost: top ? `<${top.tagName.toLowerCase()} class="${String(top.className).slice(0, 40)}">` : '(none)',
        covered: !!(top && top !== b && !b.contains(top))
      });
    }
    if (clickCheck.length >= 8) break;
  }

  // 4) 模拟扩展修复后的提取逻辑，验证能否拿到昵称/UID/正文
  const dq = (root, sel, d) => {
    if (!root || (d || 0) > 8) return null;
    if (root.shadowRoot) { const r = dq(root.shadowRoot, sel, (d || 0) + 1); if (r) return r; }
    let h = null; try { h = root.querySelector(sel); } catch (_) {}
    if (h) return h;
    let all = []; try { all = [...root.querySelectorAll('*')]; } catch (_) { return null; }
    for (const c of all) if (c.shadowRoot) { const r = dq(c.shadowRoot, sel, (d || 0) + 1); if (r) return r; }
    return null;
  };
  const dt = (root, d) => {
    if (!root || (d || 0) > 8) return '';
    let out = '';
    const walk = (node, dd) => {
      if (!node || dd > 8) return;
      if (node.nodeType === 3) { out += ' ' + node.nodeValue; return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      const tag = node.tagName ? String(node.tagName).toLowerCase() : '';
      if (tag === 'style' || tag === 'script' || tag === 'noscript' || tag === 'template') return;
      const cls = node.className ? String(node.className) : '';
      if (cls.indexOf('baf-') === 0) return;
      if (node.shadowRoot) walk(node.shadowRoot, dd + 1);
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i], dd);
    };
    walk(root, d || 0);
    return out;
  };
  const TEXTSEL = 'bili-rich-text, .reply-content, .comment-text, .comment-content, .content-text';
  const extract = [];
  for (const { root } of roots) {
    let list = [];
    try { list = [...root.querySelectorAll('bili-comment-renderer, bili-comment-reply-renderer')]; } catch (_) {}
    for (const el of list) {
      if (extract.length >= 6) break;
      const nameNode = dq(el, '#user-name, .user-name, .bili-comment-user-name, [class*="user-name"]');
      const link = dq(el, 'a[href*="space.bilibili.com"]');
      const textNode = dq(el, TEXTSEL);
      const img = dq(el, 'bili-avatar img, img[src*="bfs/face"]');
      extract.push({
        tag: el.tagName.toLowerCase(),
        uname: nameNode ? String(nameNode.textContent || '').trim().slice(0, 20) : '',
        uid: link ? (String(link.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/) || [])[1] || '' : '',
        textLen: textNode ? dt(textNode).replace(/\s+/g, ' ').trim().length : 0,
        text: textNode ? dt(textNode).replace(/\s+/g, ' ').trim().slice(0, 26) : '',
        hasAvatar: !!img
      });
    }
    if (extract.length >= 6) break;
  }

  return {
    extract,
    title: document.title,
    shadowRootCount: roots.length - 1,
    roots: roots.map(x => x.name),
    commentRoots,
    itemHits,
    clickCheck,
    bodyHasCommentText: !!document.querySelector('.reply-content, bili-rich-text, .comment-text')
  };
});

await browser.close();

const lines = [];
lines.push('# 真实 B 站评论区 DOM 结构抓取\n');
lines.push(`- 页面：${info.title}`);
lines.push(`- Shadow Root 数量：**${info.shadowRootCount}**`);
lines.push(`- 评论区根容器：${info.commentRoots.map(c => `\`${c.sel}\` (${c.tag}, ${c.childEls} 子元素)`).join('、') || '未找到'}`);
lines.push(`- body 内直接可见评论正文：${info.bodyHasCommentText}\n`);
lines.push('## Shadow Root 列表\n');
lines.push(info.roots.map(r => `- ${r}`).join('\n'));
lines.push('\n## ITEM_SELECTORS 命中情况\n');
if (!info.itemHits.length) {
  lines.push('**没有命中任何评论项！说明选择器全部失效。**\n');
} else {
  for (const h of info.itemHits) {
    lines.push(`### 作用域 ${h.scope} ｜ 命中 ${h.count} 个\n`);
    lines.push('| tag | class | rpid | 文本长度 | 子元素 | 含正文 | 含图 | 正文容器 | 正文预览 |');
    lines.push('|---|---|---|---:|---:|---|---|---|---|');
    for (const it of h.items) {
      lines.push(`| ${it.tag} | \`${it.cls}\` | ${it.rpid || '-'} | ${it.msgLen} | ${it.childEls} | ${it.hasText ? '是' : '**否**'} | ${it.hasAvatar ? '是' : '否'} | ${it.textNode} | ${it.sample.replace(/\|/g, '\\|')} |`);
    }
    lines.push('');
    lines.push('祖先链（由内到外）：');
    for (const it of h.items) lines.push(`- ${it.tag}.${it.cls.slice(0, 30)} → ${it.ancestors.join(' → ')}`);
    lines.push('');
  }
}
lines.push('## 用修复后的提取逻辑实测（穿透 Shadow DOM）\n');
if (!info.extract.length) lines.push('未提取到任何评论。\n');
else {
  lines.push('| 标签 | 昵称 | UID | 正文长度 | 正文预览 | 有头像 |');
  lines.push('|---|---|---|---:|---|---|');
  for (const e of info.extract) {
    lines.push(`| ${e.tag} | ${e.uname || '**(空)**'} | ${e.uid || '**(空)**'} | ${e.textLen} | ${e.text.replace(/\|/g, '\\|') || '**(空)**'} | ${e.hasAvatar ? '是' : '否'} |`);
  }
  lines.push('');
}

lines.push('## 按钮点击可用性（是否被遮挡）\n');
if (!info.clickCheck.length) lines.push('未找到可测按钮。\n');
else {
  lines.push('| 按钮 | 文案 | 尺寸 | 命中最上层 | 是否被遮挡 |');
  lines.push('|---|---|---|---|---|');
  for (const c of info.clickCheck) lines.push(`| ${c.btn} | ${c.text} | ${c.rect.join('×')} | ${c.topmost} | ${c.covered ? '**是**' : '否'} |`);
}

writeFileSync(path.join(ROOT, '验证/real-dom-structure.md'), lines.join('\n'));
console.log('Shadow roots:', info.shadowRootCount, '| ITEM 命中作用域:', info.itemHits.length, '| 按钮样本:', info.clickCheck.length);
console.log('报告：验证/real-dom-structure.md');
