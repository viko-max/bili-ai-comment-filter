/* 统计真实页面上评论元素的覆盖率：哪些被扩展处理了、哪些漏了、漏的原因。 */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'bili-ai-comment-filter');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(ROOT, '.chrome-cov');
const URL_ = process.argv[2] || 'https://www.bilibili.com/video/BV1FKsX6jEDH/';

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', pipe: true, enableExtensions: [EXT],
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--lang=zh-CN'],
  userDataDir: PROFILE, defaultViewport: { width: 1440, height: 1000 }, protocolTimeout: 120000
});

const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.evaluate(() => {
  const el = document.querySelector('bili-comments') || document.querySelector('#comment');
  if (el) el.scrollIntoView({ block: 'center' });
});
for (let i = 0; i < 30; i++) {
  await page.evaluate(() => window.scrollBy(0, 420));
  await new Promise(r => setTimeout(r, 450));
}
await new Promise(r => setTimeout(r, 8000));

const report = await page.evaluate(() => {
  const roots = [document]; const seen = new Set();
  const walk = (r, d) => {
    if (d > 6) return;
    let all = []; try { all = [...r.querySelectorAll('*')]; } catch (_) { return; }
    for (const el of all) if (el.shadowRoot && !seen.has(el.shadowRoot)) {
      seen.add(el.shadowRoot); roots.push(el.shadowRoot); walk(el.shadowRoot, d + 1);
    }
  };
  walk(document, 0);

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
    const wk = (n, dd) => {
      if (!n || dd > 8) return;
      if (n.nodeType === 3) { out += ' ' + n.nodeValue; return; }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      const t = n.tagName ? String(n.tagName).toLowerCase() : '';
      if (t === 'style' || t === 'script' || t === 'noscript' || t === 'template') return;
      if (n.shadowRoot) wk(n.shadowRoot, dd + 1);
      const k = n.childNodes || [];
      for (let i = 0; i < k.length; i++) wk(k[i], dd);
    };
    wk(root, d || 0); return out;
  };

  const items = [];
  for (const r of roots) {
    let els = [];
    try { els = [...r.querySelectorAll('bili-comment-renderer, bili-comment-reply-renderer')]; } catch (_) {}
    for (const el of els) {
      const n = dq(el, '#user-name, .user-name, [class*="user-name"]');
      const t = dq(el, 'bili-rich-text, .reply-content, .comment-text');
      const hasKey = el.hasAttribute('data-baf-key');
      const hasActions = !!dq(el, '.baf-actions');
      items.push({
        uname: n ? String(n.textContent || '').trim().slice(0, 16) : '',
        len: t ? dt(t).replace(/\s+/g, ' ').trim().length : 0,
        text: t ? dt(t).replace(/\s+/g, ' ').trim().slice(0, 22) : '',
        hasKey, hasActions,
        hidden: el.hasAttribute('data-baf-hidden') || el.hasAttribute('data-baf-hidden-hard'),
        marked: el.classList.contains('baf-marked')
      });
    }
  }
  const hosts = ['bili-comments', '#comment', '.comment-container', '#commentapp']
    .map(s => { const e = document.querySelector(s); return e ? `${s}(${e.tagName.toLowerCase()})` : null; })
    .filter(Boolean);
  return {
    shadowRoots: roots.length - 1,
    commentHosts: hosts,
    total: items.length,
    withKey: items.filter(x => x.hasKey).length,
    withActions: items.filter(x => x.hasActions).length,
    hidden: items.filter(x => x.hidden).length,
    marked: items.filter(x => x.marked).length,
    missed: items.filter(x => !x.hasActions).slice(0, 12)
  };
});

await browser.close();
rmSync(PROFILE, { recursive: true, force: true });

console.log('评论区容器：', report.commentHosts.join('、') || '(未找到)');
console.log(`评论元素 ${report.total} 个 | 已绑定 key ${report.withKey} | 已加操作条 ${report.withActions} | 隐藏 ${report.hidden} | 标记 ${report.marked}`);
if (report.missed.length) {
  console.log('\n未被处理的评论（前 12 条）：');
  for (const m of report.missed) console.log(`  ${m.uname || '(无昵称)'} | 正文 ${m.len} 字 | ${m.text}`);
} else console.log('\n全部评论元素都已被处理。');
