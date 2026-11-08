/* 在真实 B 站视频页加载扩展，检查是否真的识别并隐藏了评论。
 * 只做只读统计，不点击、不修改页面数据。
 */
import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { rmSync, existsSync } from 'node:fs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'bili-ai-comment-filter');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PROFILE = path.join(ROOT, '.chrome-live');
const URL_ = process.argv[2] || 'https://www.bilibili.com/video/BV1FKsX6jEDH/';

if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  pipe: true,
  enableExtensions: [EXT],
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
    '--enable-unsafe-extension-debugging', '--no-first-run', '--no-default-browser-check', '--lang=zh-CN'],
  userDataDir: PROFILE,
  defaultViewport: { width: 1440, height: 1000 },
  protocolTimeout: 120000
});

const page = await browser.newPage();
await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
await page.goto(URL_, { waitUntil: 'domcontentloaded', timeout: 45000 });

await page.evaluate(() => {
  const el = document.querySelector('bili-comments') || document.querySelector('#comment');
  if (el) el.scrollIntoView({ block: 'center' });
});
for (let i = 0; i < 50; i++) {
  await page.evaluate(() => window.scrollBy(0, 380));
  await new Promise(r => setTimeout(r, 400));
}
await new Promise(r => setTimeout(r, 10000));

const result = await page.evaluate(() => {
  const roots = [document];
  const seen = new Set();
  const walk = (r, d) => {
    if (d > 6) return;
    let all = []; try { all = [...r.querySelectorAll('*')]; } catch (_) { return; }
    for (const el of all) {
      if (el.shadowRoot && !seen.has(el.shadowRoot)) {
        seen.add(el.shadowRoot); roots.push(el.shadowRoot); walk(el.shadowRoot, d + 1);
      }
    }
  };
  walk(document, 0);

  let comments = 0, hidden = 0, placeholders = 0, actions = 0, marked = 0;
  const hiddenSamples = [];
  const dq = (root, sel, d) => {
    if (!root || (d || 0) > 8) return null;
    if (root.shadowRoot) { const r = dq(root.shadowRoot, sel, (d || 0) + 1); if (r) return r; }
    let h = null; try { h = root.querySelector(sel); } catch (_) {}
    if (h) return h;
    let all = []; try { all = [...root.querySelectorAll('*')]; } catch (_) { return null; }
    for (const c of all) if (c.shadowRoot) { const r = dq(c.shadowRoot, sel, (d || 0) + 1); if (r) return r; }
    return null;
  };
  for (const r of roots) {
    let els = [];
    try { els = [...r.querySelectorAll('bili-comment-renderer, bili-comment-reply-renderer, .reply-item')]; } catch (_) {}
    for (const el of els) {
      comments++;
      if (el.hasAttribute('data-baf-hidden') || el.hasAttribute('data-baf-hidden-hard')) {
        hidden++;
        if (el.getAttribute('data-baf-hidden') === '1' && hiddenSamples.length < 5) {
          const n = dq(el, '#user-name, .user-name');
          hiddenSamples.push(n ? String(n.textContent || '').trim().slice(0, 14) : '(未知)');
        }
      }
      if (el.classList.contains('baf-marked')) marked++;
      if (dq(el, '.baf-actions')) actions++;
    }
    try { placeholders += r.querySelectorAll('.baf-placeholder').length; } catch (_) {}
  }
  const panel = document.querySelector('.baf-panel');
  return {
    shadowRoots: roots.length - 1,
    comments, hidden, placeholders, actions, marked,
    hiddenSamples,
    panelText: panel ? panel.textContent.replace(/\s+/g, ' ').slice(0, 120) : '(面板未打开)'
  };
});

// 直接问扩展自己的判定记录，比在 headless 下遍历 shadow DOM 可靠
const EXT_ID = 'pfioilkmmfocliniigpkmihomhoilihg';
const opt = await browser.newPage();
await opt.goto(`chrome-extension://${EXT_ID}/src/options/options.html`, { waitUntil: 'domcontentloaded' });
const stored = await opt.evaluate(() => new Promise(r => chrome.storage.local.get(
  ['lastDecisions', 'settings', 'bafDiag'], v => r(v))));

const decs = stored.lastDecisions || [];
const byDecision = {};
for (const d of decs) byDecision[d.decision] = (byDecision[d.decision] || 0) + 1;
const hideSamples = decs.filter(d => d.decision === 'hide').slice(0, 8)
  .map(d => `${d.uname || '?'}｜${String(d.text || '').slice(0, 26)}`);
const markSamples = decs.filter(d => d.decision === 'mark').slice(0, 8)
  .map(d => `${d.uname || '?'}｜${String(d.text || '').slice(0, 26)}`);

await browser.close();
rmSync(PROFILE, { recursive: true, force: true });

console.log('=== DOM 层统计（仅 document 层，shadow 内不计） ===');
console.log(JSON.stringify(result, null, 2));
console.log('\n=== 扩展判定记录 ===');
console.log('总记录', decs.length, '|', JSON.stringify(byDecision));
console.log('hide 样本:'); hideSamples.forEach(s => console.log('  ', s));
console.log('mark 样本:'); markSamples.forEach(s => console.log('  ', s));
if (stored.bafDiag) console.log('诊断:', JSON.stringify(stored.bafDiag));
