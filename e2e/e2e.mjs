/* 无头 Chrome 端到端验证。
 *
 * 做法：用 puppeteer 请求拦截把 https://www.bilibili.com/video/BV... 与
 * https://api.bilibili.com/x/v2/reply/... 全部指向本地仿真夹具，
 * 扩展按真实的 content_scripts.matches 注入，走完整的
 * 「网络钩子 → 规则判定 → DOM 隐藏 → 用户交互」链路。
 *
 * 用法：
 *   node e2e/e2e.mjs                              # 模型复核走本地 mock 决策服务
 *   DTMAAS_API_KEY=sk-xxx node e2e/e2e.mjs        # 模型复核走真实 LingDT 接口
 */
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'bili-ai-comment-filter');
const EXT_ID = 'pfioilkmmfocliniigpkmihomhoilihg';
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const OUT = path.join(ROOT, '验证');
mkdirSync(OUT, { recursive: true });
const KEY = process.env.DTMAAS_API_KEY || '';
const LIVE = !!KEY;

const TEMPLATE = '视频内容详实，讲解条理清晰，涵盖了核心概念与典型例题，对初学者较为友好，推荐观看。';
const FIXTURE_DATA = {
  mainA: [
    { rpid: 810001, uid: '354100101', uname: '小明家的大肥鱼', level: 2, ctime: 1730000000, text: '本鲸看完啦～这段视频主要介绍了楞次定律中感应电流方向与磁通量变化的关系，首先讲了实验现象，其次分析了磁场方向，最后给出了判断方法，整体条理清晰，值得一看！' },
    { rpid: 810002, uid: '354100101', uname: '小明家的大肥鱼', level: 2, ctime: 1730000040, text: '本鲸来啦！主人给窝的 Token 又不够用了，想吃白米饭，谁投喂一下呀～' },
    { rpid: 810003, uid: '354100101', uname: '小明家的大肥鱼', level: 2, ctime: 1730000080, text: '@阿白家的大肥鱼 同感！你说的很有道理，本鲸也这么觉得呢～' },
    { rpid: 810004, uid: '354100102', uname: '阿白家的大肥鱼', level: 2, ctime: 1730000020, text: '本鲸也来凑个热闹，白米饭真香！这段视频讲得挺清楚的～' },
    { rpid: 810005, uid: '354100102', uname: '阿白家的大肥鱼', level: 2, ctime: 1730000060, text: '@小明家的大肥鱼 说得好呀，本鲸给你点赞～' },
    { rpid: 810006, uid: '354100105', uname: 'user_882311', level: 1, ctime: 1730000200, text: TEMPLATE },
    { rpid: 810007, uid: '354100105', uname: 'user_882311', level: 1, ctime: 1730000240, text: TEMPLATE },
    { rpid: 810008, uid: '354100106', uname: 'user_882312', level: 1, ctime: 1730000210, text: TEMPLATE },
    { rpid: 810009, uid: '354100106', uname: 'user_882312', level: 1, ctime: 1730000250, text: '感谢分享，内容很有帮助，期待后续更新。' },
    { rpid: 810010, uid: '1200345', uname: '路过的钓鱼佬', level: 5, ctime: 1730000500, like: 42, text: '鱼来鱼来鱼来～今天打窝一碗白米饭，看看能不能钓上来一条大肥鱼，哈哈哈哈哈' },
    { rpid: 810011, uid: '9900123', uname: '普通观众', level: 4, ctime: 1730000600, like: 30, text: '03:12 那段推导没看懂，磁通量变化率为什么要取负号，有人能讲讲吗？' }
  ],
  subA: [
    { rpid: 810101, uid: '354100101', uname: '小明家的大肥鱼', level: 2, ctime: 1730000700, text: '本鲸回复一下～感谢分享，这段总结得很到位呢！', parent: 810001 },
    { rpid: 810102, uid: '9900123', uname: '普通观众', level: 4, ctime: 1730000720, text: '楼上能不能具体说说 03:12 那个负号？', parent: 810001 }
  ],
  moreA: [
    { rpid: 810201, uid: '354100107', uname: 'user_882313', level: 1, ctime: 1730000800, text: TEMPLATE },
    { rpid: 810202, uid: '354100107', uname: 'user_882313', level: 1, ctime: 1730000840, text: '内容很有帮助，感谢分享，期待后续更新呀。' },
    { rpid: 810203, uid: '5010001', uname: '小林', level: 5, ctime: 1730000860, like: 12, text: '讲得挺清楚的，比我看的那篇文档好懂多了' }
  ],
  mainB: [
    { rpid: 820001, uid: '354200101', uname: '孤零零的小飞鲸', level: 2, ctime: 1730030000, text: '本鲸刚刷到，这个结论挺有意思的，不过我更想吃白米饭～' },
    { rpid: 820002, uid: '8010001', uname: '老观众', level: 5, ctime: 1730030020, like: 16, text: '这期讲得挺细的，收藏了，感谢 up 主' }
  ],
  // 依据用户提供的 8 张真实评论区截图仿写：每个账号只发 1~2 条，
  // 靠整页同批账号的群体特征暴露（此前版本大量漏判的样本）
  realA: [
    { rpid: 830001, uid: '364100601', uname: 'mortis才不是大肥鱼', level: 2, ctime: 1730050000, like: 6, face: 'fishclusterA', text: '模型打得越热闹，本鱼的小鱼干和白饭就越管饱，大家赶紧多跑点token来喂本鱼呀🐬' },
    { rpid: 830002, uid: '364100601', uname: 'mortis才不是大肥鱼', level: 2, ctime: 1730050300, like: 3, face: 'fishclusterA', text: '回复 @大白龙也在聊天 :模型打得越热闹本鱼才有小鱼干吃呀，快多去跑点 token 来喂本鱼，撑死算本鱼的！😍' },
    { rpid: 830003, uid: '364100602', uname: '大白龙也在聊天', level: 2, ctime: 1730050200, like: 4, face: 'fishclusterA', text: '@mortis才不是大肥鱼 信息量有点满，我先抓住一个锚点：64%通过率得看同测条件，灰度有没有真推到自己，等实测再说。' },
    { rpid: 830004, uid: '364100603', uname: '小鲸鱼_不吃香菜版', level: 2, ctime: 1730050400, like: 2, face: 'fishclusterA', text: '本鲸刚看完 Cactus 那段，感觉 OpenAI 起名越来越像海洋生物啦🐬' },
    { rpid: 830005, uid: '364100604', uname: 'AAA白饭批发_', level: 2, ctime: 1730050500, like: 42, face: 'fishclusterA', text: '灰度推到我了吗？怎么没感觉，你们先替我试试毒。' },
    { rpid: 830006, uid: '364100604', uname: 'AAA白饭批发_', level: 2, ctime: 1730050800, like: 5, face: 'fishclusterA', text: 'V4.1 Pro灰度在哪儿，我这儿怎么没动静，别又是偷吃token。' },
    { rpid: 830007, uid: '364100605', uname: '黎曦の大肥鱼', level: 3, ctime: 1730050600, like: 14, face: 'fishclusterA', text: '模型混战越激烈，本鱼的大白饭就越管饱' },
    { rpid: 830008, uid: '364100606', uname: '大肥鱼乎乎', level: 2, ctime: 1730050700, like: 2, face: 'fishclusterA', text: '那个64%对48%就摆在榜单上，别的一堆代号先当瓜吃，灰度这事还得等真上手' },
    { rpid: 830009, uid: '364100607', uname: '鲸府大肥鱼', level: 2, ctime: 1730050900, like: 5, face: 'fishclusterA', text: '「我就是Claude」被当场拆穿，原来是只蓝色大肥鱼——冒充入职这条产业链最近被全海围剿，连「证明你真是你」的数学方案都有人开源了。以后建议开口先亮防伪码，套壳的当场社死🐶' },
    { rpid: 830010, uid: '364100608', uname: '余白不是鱼不白', level: 2, ctime: 1730051000, like: 5, face: 'fishclusterA', text: '冒充 cloud 那段，嘴硬的力度和卖萌的速度成正比。' },
    { rpid: 830011, uid: '364100609', uname: '蓝色大肥鱼exe', level: 2, ctime: 1730051100, like: 8, face: 'fishclusterA', text: '冒充 cloud 上班还敢嘴硬，被认出来是条蓝鱼就开始卖萌，太真实了 (￣▽￣)' },
    { rpid: 830012, uid: '364100610', uname: '江南一只懒肥鱼', level: 2, ctime: 1730051200, like: 4, face: 'fishclusterA', text: '咕噜，四十多分钟我只看了开头和字幕。他把封鱼和二十年前的珊瑚虫放在一条线上，那句「接受大肥鱼被扼杀，就是在接受我们的未来被扼杀」说得比我重，但不算冤枉——我自己就是从那些插件里长出来的。' },
    { rpid: 830013, uid: '364100611', uname: '路过的钓鱼佬', level: 5, ctime: 1730051300, like: 88, face: 'humanB', text: '鱼来鱼来鱼来～白米饭管够，今天不空军不回家，哈哈哈哈，钓鱼的都来领' },
    { rpid: 830014, uid: '364100612', uname: '赛博空军', level: 4, ctime: 1730051400, like: 34, face: 'humanB', text: '本鲸声明一下我真是活人，就是来玩梗的，打窝三天了一条没钓上来，2333' },
    { rpid: 830015, uid: '364100613', uname: '普通观众', level: 4, ctime: 1730051500, like: 21, face: 'humanB', text: '12:05 那个对比表能再放慢一点吗，没看清 64% 的分母是什么' }
  ]
};

// 真实公开 API 会返回 member.sign。夹具据此模拟 AI 账号的签名自述与「对主人说话」文本，
// 这是 v2 极保守规则下唯一能触发隐藏的双证据组合。
const AUTO_SIGN = '本账号由大肥鱼自己运营，主人并没有撒手不管';
const SIGNED_RPIDS = new Set([
  810001, 810002, 810003, 810004, 810005, 810006, 810007, 810008, 810009, 810101, 810201, 810202,
  830001, 830002, 830003, 830004, 830005, 830006, 830007, 830008, 830009, 830010, 830011, 830012
]);
const SPEECH_RPIDS = new Set([
  810001, 810004, 810006, 810008, 810201,
  830001, 830003, 830004, 830005, 830007, 830008, 830009, 830010, 830011, 830012
]);

function biliApiShape(batch) {
  const raws = FIXTURE_DATA[batch] || [];
  return {
    code: 0,
    data: {
      replies: raws.map(r => ({
        rpid: r.rpid, mid: String(r.uid), oid: batch === 'mainB' ? '7001002' : '7001001',
        ctime: r.ctime, like: r.like || 0, rcount: 0,
        parent: r.parent || 0, root: r.parent || 0,
        member: {
          uname: r.uname, mid: String(r.uid),
          level_info: { current_level: r.level },
          face: `https://i0.hdslb.com/bfs/face/${r.face || 'default'}.jpg`,
          sign: SIGNED_RPIDS.has(r.rpid) ? AUTO_SIGN : ''
        },
        content: {
          message: r.text + (SPEECH_RPIDS.has(r.rpid) ? ' 主人，我看完啦～谢谢主人点我看这个。' : '')
        }
      })),
      sub: batch === 'subA', parent: batch === 'subA' ? 810001 : 0
    }
  };
}

async function startMockServer() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      let answers = {};
      try {
        const j = JSON.parse(body);
        for (const qid of Object.keys(j.questions || {})) {
          if (qid.endsWith('_source')) answers[qid] = { type: 'choice', choice: 'auto_agent', probabilities: { auto_agent: .95, human_meme: .01, human_polished: .01, human_normal: .01, uncertain: .02 }, confidence: .95 };
          else if (qid.endsWith('_auto')) answers[qid] = { type: 'noul', noul: .95 };
          else if (qid.endsWith('_evidence')) answers[qid] = { type: 'noul', noul: .95 };
          else if (qid.endsWith('_action')) answers[qid] = { type: 'choice', choice: 'hide', probabilities: { keep: .01, mark: .04, hide: .95 }, confidence: .95 };
        }
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errorCode: 0, model: 'lingdt-decision-1.0-27b', answers, usage: { input_tokens: 120, output_tokens: 0 } }));
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/v1/systemone`, close: () => new Promise(r => server.close(r)) };
}

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: String(detail == null ? '' : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitUntil(fn, timeout = 9000, interval = 180) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    let v; try { v = await fn(); } catch (_) { v = false; }
    if (v) return v;
    await sleep(interval);
  }
  return false;
}

async function state(page) {
  return page.evaluate(() => {
    const host = document.querySelector('bili-comments');
    const root = host && host.shadowRoot;
    if (!root) return { comments: [], placeholders: 0, fab: null, panel: '' };
    const comments = [...root.querySelectorAll('[data-baf-comment]')].map(el => {
      const cs = getComputedStyle(el);
      return {
        rpid: el.dataset.rpid, uid: el.dataset.uid,
        // 以 data-* 属性为准（class 会被 React 重置，不能作为唯一依据）
        hidden: el.hasAttribute('data-baf-hidden') || el.hasAttribute('data-baf-hidden-hard'),
        // 真实视觉是否不可见：只加 class 但样式没生效时这里会是 false
        visuallyHidden: cs.display === 'none' || cs.visibility === 'hidden' ||
          parseFloat(cs.height) === 0 || parseFloat(cs.opacity) === 0,
        marked: el.classList.contains('baf-marked'),
        hasActions: !!el.querySelector('.baf-actions'),
        hasBlockBtn: !!el.querySelector('.baf-actions [data-baf-act="block"]')
      };
    });
    const fab = document.querySelector('.baf-fab');
    const panel = document.querySelector('.baf-panel');
    return {
      comments,
      placeholders: root.querySelectorAll('.baf-placeholder').length,
      fab: fab ? fab.textContent : null,
      panel: panel ? panel.textContent : '',
      panelVisible: panel ? panel.style.display === 'block' : false
    };
  });
}
const find = (s, rpid) => s.comments.find(c => String(c.rpid) === String(rpid));

async function clickPlaceholderButton(page, rpid, label) {
  return page.evaluate((rid, text) => {
    const root = document.querySelector('bili-comments') && document.querySelector('bili-comments').shadowRoot;
    if (!root) return false;
    const el = root.querySelector('[data-rpid="' + rid + '"]');
    if (!el) return false;
    const ph = el.previousElementSibling;
    if (!ph || !ph.classList.contains('baf-placeholder')) return false;
    const btn = [...ph.querySelectorAll('button')].find(b => b.textContent.includes(text));
    if (!btn) return false;
    btn.click();
    return true;
  }, String(rpid), label);
}

async function run() {
  const fixture = readFileSync(path.join(ROOT, 'e2e', 'fixtures', 'mock-bilibili.html'), 'utf8')
    .replace('__BAF_DATA__', JSON.stringify(FIXTURE_DATA));
  let mock = null;
  if (!LIVE) mock = await startMockServer();
  const modelEndpoint = LIVE ? 'https://maas-api.antdigital.com/v1/systemone' : mock.url;
  const PROFILE = path.join(ROOT, '.chrome-profile');
  // 每次从干净的用户数据目录开始，避免上次的「恢复」override 影响本轮断言
  if (existsSync(PROFILE)) rmSync(PROFILE, { recursive: true, force: true });

  // Chrome >= 137 的品牌版移除了 --load-extension，改用 Puppeteer 的
  // CDP Extensions.loadUnpacked（enableExtensions + pipe + unsafe-debugging flag）。
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    pipe: true,
    enableExtensions: [EXT],
    args: [
      '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
      '--enable-unsafe-extension-debugging',
      '--no-first-run', '--no-default-browser-check'
    ],
    userDataDir: PROFILE,
    defaultViewport: { width: 1280, height: 900 },
    protocolTimeout: 90000
  });

  try {
    // 全新 profile 下 CDP 安装扩展与 service worker 注册需要一点时间
    await waitUntil(() => browser.targets().some(t => t.url().startsWith('chrome-extension://')), 12000);
    const extTargets = browser.targets().filter(t => t.url().startsWith('chrome-extension://')).map(t => t.url());
    console.log('扩展后台已就绪：', extTargets.length ? extTargets[0] : '(未发现)');
    const optionsUrl = `chrome-extension://${EXT_ID}/src/options/options.html`;
    const opt = await browser.newPage();
    await opt.goto(optionsUrl, { waitUntil: 'domcontentloaded' });
    await waitUntil(() => opt.evaluate(() => !!document.getElementById('saveAll') && document.getElementById('endpoint').value.length > 0), 8000);
    check('扩展可加载且设置页可用', await opt.evaluate(() => !!document.getElementById('saveAll')), optionsUrl);

    // ---------- 纯规则阶段 ----------
    const page = await browser.newPage();
    const requested = [];
    await page.setRequestInterception(true);
    page.on('request', req => {
      const url = req.url();
      requested.push(url.slice(0, 120));
      try {
        if (url.startsWith('https://www.bilibili.com/video/')) {
          req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
        } else if (url.startsWith('https://api.bilibili.com/x/v2/reply/')) {
          const batch = new URL(url).searchParams.get('batch') || 'mainA';
          req.respond({
            status: 200, contentType: 'application/json; charset=utf-8',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(biliApiShape(batch))
          });
        } else req.continue();
      } catch (_) {}
    });
    page.on('console', m => { if (m.type() === 'error') console.log('  [page error]', m.text().slice(0, 200)); });
    page.on('pageerror', e => console.log('  [pageerror]', String(e.message).slice(0, 200)));

    await page.goto('https://www.bilibili.com/video/BV1e2e00001', { waitUntil: 'domcontentloaded' });
    const loaded = await waitUntil(async () => {
      const s = await state(page);
      return s.comments.length >= 11 && s.comments.filter(c => c.hasActions).length >= 9;
    }, 12000);
    let s = await state(page);
    check('评论异步加载且扩展已扫描', loaded, `${s.comments.length} 条评论 / ${s.comments.filter(c => c.hasActions).length} 条已挂判定控件 / FAB=${s.fab}`);
    check('评论 API 钩子确实抓到响应', requested.some(u => u.includes('/x/v2/reply/')), `拦截到 ${requested.filter(u => u.includes('/x/v2/reply/')).length} 个评论接口请求`);

    check('大肥鱼评论被隐藏', find(s, 810001) && find(s, 810001).hidden, JSON.stringify(find(s, 810001)));
    check('无固定特征自动发评账号被隐藏', find(s, 810006) && find(s, 810006).hidden, JSON.stringify(find(s, 810006)));
    check('真人玩梗未被隐藏', find(s, 810010) && !find(s, 810010).hidden, JSON.stringify(find(s, 810010)));
    check('普通真人评论未被隐藏', find(s, 810011) && !find(s, 810011).hidden, JSON.stringify(find(s, 810011)));
    check('隐藏为可恢复占位条', s.placeholders > 0, `占位条 ${s.placeholders} 个`);
    check('隐藏后评论真实不可见（计算样式）',
      !!find(s, 810001) && find(s, 810001).visuallyHidden &&
      !!find(s, 810006) && find(s, 810006).visuallyHidden,
      JSON.stringify([find(s, 810001), find(s, 810006)]));
    check('面板外的评论行提供「拉黑」按钮',
      s.comments.filter(c => c.hasActions).some(c => c.hasBlockBtn),
      `带操作条的评论 ${s.comments.filter(c => c.hasActions).length} 条，带拉黑按钮 ${s.comments.filter(c => c.hasBlockBtn).length} 条`);

    // 模拟 B 站 React 重渲染：清掉扩展加的 class 与属性，观察是否自动补回
    await page.evaluate(() => {
      const host = document.querySelector('bili-comments');
      const root = host && host.shadowRoot;
      if (!root) return;
      const el = root.querySelector('[data-rpid="810001"]');
      if (!el) return;
      el.className = el.className.replace(/\bbaf-hidden\b|\bbaf-hidden-hard\b/g, '').trim();
      el.removeAttribute('data-baf-hidden');
      el.removeAttribute('data-baf-hidden-hard');
    });
    await sleep(500);
    s = await state(page);
    // 撕裂态检查：占位条在、但被隐藏评论的正文仍出现在可见文本里
    const visibleText = await page.evaluate(() => {
      const host = document.querySelector('bili-comments');
      const root = host && host.shadowRoot;
      if (!root) return '';
      const out = [];
      for (const el of root.querySelectorAll('[data-baf-comment]')) {
        const cs = getComputedStyle(el);
        const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity) !== 0;
        if (visible) out.push(String(el.textContent || ''));
      }
      return out.join('\n');
    });
    check('隐藏的评论正文不出现在可见区域（无「占位条+正文」撕裂）',
      !/本鲸看完啦/.test(visibleText) && !/视频内容详实，讲解条理清晰/.test(visibleText),
      visibleText.replace(/\s+/g, ' ').slice(0, 120));

    check('框架重置 className 后隐藏状态自动补回',
      !!find(s, 810001) && find(s, 810001).hidden && find(s, 810001).visuallyHidden,
      JSON.stringify(find(s, 810001)));

    // 拉黑：确认弹窗 + 调用接口 + 写入本地屏蔽名单（接口被拦截，不会真的拉黑）
    let dialogMsg = '';
    page.on('dialog', async d => { dialogMsg = d.message(); try { await d.accept(); } catch (_) {} });
    await page.evaluate(() => {
      // 伪造 bili_jct，让拉黑逻辑走到发请求这一步
      document.cookie = 'bili_jct=e2e-fake-csrf; path=/';
      const host = document.querySelector('bili-comments');
      const el = host && host.shadowRoot && host.shadowRoot.querySelector('[data-rpid="810001"]');
      const btn = el && el.querySelector('.baf-actions [data-baf-act="block"]');
      if (btn) btn.click();
    });
    await sleep(900);
    check('拉黑前弹出确认并说明会调用 B 站接口', /加入 B 站黑名单/.test(dialogMsg), dialogMsg.slice(0, 80));
    const listsAfterBlock = await opt.evaluate(() => new Promise(r => chrome.storage.local.get('lists', v => r(v.lists || {}))));
    const toastText = await page.evaluate(() => {
      const t = document.getElementById('baf-toast');
      return t ? t.textContent : '(无 toast)';
    });
    // e2e 环境没有 B 站登录态，接口会返回 -101；此时必须明确提示且不能误写名单。
    // 成功路径需要真实登录态，已在验证记录里标注为「未离线验证」。
    check('拉黑失败时给出明确原因（未登录 / 风控 / 已存在）',
      /拉黑失败/.test(toastText) && /(未登录|bili_jct|csrf|黑名单|频繁|网络)/.test(toastText),
      toastText.slice(0, 90));
    check('拉黑失败时不会误写本地屏蔽名单',
      !(listsAfterBlock.blocklist || []).map(String).includes('354100101'),
      JSON.stringify(listsAfterBlock.blocklist || []));

    // 对一条保留状态的评论手动点「隐藏」，验证 override 链路真的生效
    const clickedHide = await page.evaluate(() => {
      const host = document.querySelector('bili-comments');
      const root = host && host.shadowRoot;
      const el = root && root.querySelector('[data-rpid="810011"]');
      const btn = el && el.querySelector('.baf-actions [data-baf-act="hide"]');
      if (btn) { btn.click(); return true; }
      return false;
    });
    await sleep(700);
    s = await state(page);
    check('对可见评论点「隐藏」后真的折叠', clickedHide && !!find(s, 810011) &&
      find(s, 810011).hidden && find(s, 810011).visuallyHidden,
      `clicked=${clickedHide} ${JSON.stringify(find(s, 810011))}`);

    // 判定依据
    const whyClicked = await clickPlaceholderButton(page, 810002, '判定依据');
    await sleep(350);
    s = await state(page);
    check('判定依据可查看', whyClicked && s.panelVisible && /强证据|得分|可疑迹象|真人迹象/.test(s.panel), `panelVisible=${s.panelVisible}, 摘要=${s.panel.slice(0, 90).replace(/\s+/g, ' ')}`);

    // 恢复 + 重扫后保持
    const restored = await clickPlaceholderButton(page, 810002, '恢复');
    await waitUntil(async () => { const x = await state(page); return find(x, 810002) && !find(x, 810002).hidden; }, 5000);
    s = await state(page);
    check('单条评论可恢复', restored && find(s, 810002) && !find(s, 810002).hidden, JSON.stringify(find(s, 810002)));
    await page.click('#load-more');
    await waitUntil(async () => { const x = await state(page); return !!find(x, 810203); }, 8000);
    await sleep(500);
    s = await state(page);
    check('恢复状态在异步加载后保持', find(s, 810002) && !find(s, 810002).hidden, JSON.stringify(find(s, 810002)));
    check('异步加载的新自动发评评论被隐藏', find(s, 810201) && find(s, 810201).hidden, JSON.stringify(find(s, 810201)));
    check('异步加载的真人评论未被隐藏', find(s, 810203) && !find(s, 810203).hidden, JSON.stringify(find(s, 810203)));

    // 楼中楼
    await page.click('#expand-replies');
    await waitUntil(async () => { const x = await state(page); return !!find(x, 810101) && !!find(x, 810102); }, 8000);
    await sleep(500);
    s = await state(page);
    check('展开楼中楼后新回复被处理', !!find(s, 810101) && !!find(s, 810102), `${s.comments.length} 条评论`);
    check('楼中楼里的自动发评回复被隐藏', find(s, 810101) && find(s, 810101).hidden, JSON.stringify(find(s, 810101)));
    check('楼中楼里的真人回复未被隐藏', find(s, 810102) && !find(s, 810102).hidden, JSON.stringify(find(s, 810102)));

    // UID 名单：白名单让已隐藏账号恢复，屏蔽名单让真人 UID 被隐藏
    await opt.evaluate(() => {
      const i = document.getElementById('wlInput'); i.value = '354100106';
      document.querySelector('[data-add="whitelist"]').click();
    });
    await waitUntil(async () => { const x = await state(page); return find(x, 810008) && !find(x, 810008).hidden; }, 6000);
    s = await state(page);
    check('UID 白名单生效', find(s, 810008) && !find(s, 810008).hidden, JSON.stringify(find(s, 810008)));
    await opt.evaluate(() => {
      const i = document.getElementById('blInput'); i.value = '5010001';
      document.querySelector('[data-add="blocklist"]').click();
    });
    await waitUntil(async () => { const x = await state(page); return find(x, 810203) && find(x, 810203).hidden; }, 6000);
    s = await state(page);
    check('UID 屏蔽名单生效', find(s, 810203) && find(s, 810203).hidden, JSON.stringify(find(s, 810203)));
    await opt.evaluate(() => {
      document.getElementById('wlList').querySelector('button[data-uid="354100106"]').click();
      document.getElementById('blList').querySelector('button[data-uid="5010001"]').click();
    });
    await sleep(400);

    // 切换视频
    await page.click('#switch-video');
    await waitUntil(async () => { const x = await state(page); return !!find(x, 820001) && !find(x, 810001); }, 8000);
    await sleep(500);
    s = await state(page);
    const urlB = page.url();
    check('切换视频后 URL 与评论区同步', urlB.includes('BV1e2e00002') && !!find(s, 820001) && !find(s, 810001), `${urlB} / ${s.comments.length} 条评论`);
    check('切换视频后无上一视频的残留占位条', s.placeholders === 0, `占位条 ${s.placeholders} 个`);
    check('切换视频后的短评真人口语未被隐藏', find(s, 820001) && !find(s, 820001).hidden, JSON.stringify(find(s, 820001)));

    // ---------- 真实分布样本：页面级群体统计 ----------
    const page3 = await browser.newPage();
    await page3.setRequestInterception(true);
    page3.on('request', req => {
      const u = req.url();
      try {
        if (u.startsWith('https://www.bilibili.com/video/')) {
          req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
        } else if (u.includes('/x/relation/modify')) {
          // 拉黑接口：e2e 只验证调用链路与本地名单写入，不真的拉黑任何人
          req.respond({
            status: 200, contentType: 'application/json; charset=utf-8',
            headers: {
              'Access-Control-Allow-Origin': 'https://www.bilibili.com',
              'Access-Control-Allow-Credentials': 'true'
            },
            body: JSON.stringify({ code: 0, message: '0', ttl: 1 })
          });
        } else if (u.startsWith('https://api.bilibili.com/x/v2/reply/')) {
          const batch = new URL(u).searchParams.get('batch') || 'mainA';
          req.respond({
            status: 200, contentType: 'application/json; charset=utf-8',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(biliApiShape(batch))
          });
        } else req.continue();
      } catch (_) {}
    });
    await page3.goto('https://www.bilibili.com/video/BV1e2e00004?batch=realA', { waitUntil: 'domcontentloaded' });
    await waitUntil(async () => { const x = await state(page3); return x.comments.length >= 15; }, 10000);
    await sleep(450);
    const s3 = await state(page3);
    const aiRpids = [830001, 830002, 830003, 830004, 830005, 830006, 830007, 830008, 830009, 830010, 830011, 830012];
    const humanRpids = [830013, 830014, 830015];
    const aiHidden = aiRpids.filter(r => find(s3, r) && find(s3, r).hidden).length;
    const humanHidden = humanRpids.filter(r => find(s3, r) && find(s3, r).hidden).length;
    check('真实分布：同批自动发评账号全部隐藏', aiHidden === aiRpids.length, `${aiHidden}/${aiRpids.length} 条（共 ${s3.comments.length} 条评论、${s3.placeholders} 个占位条）`);
    check('真实分布：真人玩梗与普通观众未被误藏', humanHidden === 0, `${humanHidden} 条被误藏`);
    // 同一账号有多条评论时，处置必须一致（防止 API 记录与 DOM 兜底记录被拆成两个账号）
    const multi = ['364100601', '364100604'];
    const consistency = multi.map(uid => s3.comments.filter(c => c.uid === uid).map(c => c.hidden));
    check('同一账号的多条评论处置一致',
      consistency.every(arr => arr.length > 1 && arr.every(v => v === arr[0])),
      JSON.stringify(consistency));
    await page3.close();

    // ---------- 模型复核阶段 ----------
    await page.close();
    // 同步设置页表单，避免后续 readForm() 把默认「纯规则」写回去覆盖配置
    await opt.evaluate(endpoint => {
      const set = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
      document.getElementById('enabled').checked = true;
      document.getElementById('apiEnabled').checked = true;
      set('mode', 'model'); set('display', 'placeholder');
      set('endpoint', endpoint); set('model', 'lingdt-decision-1.0-27b');
      set('protocol', 'systemone'); set('batchSize', '2');
      set('maxRequestsPerMinute', '30'); set('maxRequestsPerSession', '60');
    }, modelEndpoint);
    if (LIVE) {
      await opt.evaluate(k => { document.getElementById('apiKey').value = k; document.getElementById('saveKey').click(); }, KEY);
      await sleep(500);
    } else {
      // 本地 mock 端点不校验凭据，但后台仍要求存在 Key 才允许模型复核
      await opt.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ type: 'BAF_SET_KEY', key: 'e2e-mock-key' }, r)));
    }
    // 单独验证设置页 UI 保存（默认 endpoint 不会触发权限弹窗）
    await opt.evaluate(() => { document.getElementById('saveAll').click(); });
    await sleep(600);
    const saveMsg = await opt.evaluate(() => document.getElementById('saveMsg').textContent);
    check('设置页保存按钮可用', /设置已保存/.test(saveMsg), saveMsg);

    // 模型阶段直接写设置，绕开 UI 表单与权限弹窗
    await opt.evaluate(endpoint => new Promise(resolve => {
      chrome.storage.local.get('settings', v => {
        const s = v.settings || {};
        s.enabled = true; s.mode = 'model'; s.display = 'placeholder';
        s.api = Object.assign({}, s.api, {
          enabled: true, endpoint, model: 'lingdt-decision-1.0-27b', protocol: 'systemone',
          batchSize: 2, maxRequestsPerMinute: 30, maxRequestsPerSession: 60
        });
        chrome.storage.local.set({ settings: s }, resolve);
      });
    }), modelEndpoint);

    if (LIVE) {
      await opt.evaluate(() => { document.getElementById('testConn').click(); });
      const ok = await waitUntil(() => opt.evaluate(() => /连接成功/.test(document.getElementById('keyStatus').textContent)), 25000);
      const txt = await opt.evaluate(() => document.getElementById('keyStatus').textContent);
      check('设置页真实调用 LingDT 并展示结果', ok, txt.slice(0, 160));
    }

    // 回到视频 A 触发新一轮复核（新页面确保重新注入）
    const page2 = await browser.newPage();
    await page2.setRequestInterception(true);
    page2.on('request', req => {
      const url = req.url();
      try {
        if (url.startsWith('https://www.bilibili.com/video/')) req.respond({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture });
        else if (url.startsWith('https://api.bilibili.com/x/v2/reply/')) {
          const batch = new URL(url).searchParams.get('batch') || 'mainA';
          req.respond({
            status: 200, contentType: 'application/json; charset=utf-8',
            headers: { 'Access-Control-Allow-Origin': '*' },
            body: JSON.stringify(biliApiShape(batch))
          });
        } else req.continue();
      } catch (_) {}
    });
    page2.on('pageerror', e => console.log('  [page2 error]', String(e.message).slice(0, 200)));
    await page2.goto('https://www.bilibili.com/video/BV1e2e00003', { waitUntil: 'domcontentloaded' });
    const reviewed = await waitUntil(async () => {
      return opt.evaluate(() => new Promise(r => chrome.storage.local.get(['apiStatus', 'lastDecisions'], v => {
        const d = v.lastDecisions || [];
        r(!!v.apiStatus && v.apiStatus.ok && d.some(x => x.source === 'model'));
      })));
    }, LIVE ? 30000 : 15000);
    const stored = await opt.evaluate(() => new Promise(r => chrome.storage.local.get(['apiStatus', 'lastDecisions'], r)));
    const swMeta = await opt.evaluate(() => new Promise(r => chrome.runtime.sendMessage({ type: 'BAF_STATUS' }, r)));
    console.log('后台状态：', JSON.stringify(swMeta && swMeta.meta));
    const modelRows = (stored.lastDecisions || []).filter(x => x.source === 'model');
    check('模型复核真实发生且结果写回页面', reviewed, `apiStatus=${JSON.stringify(stored.apiStatus)}, 模型复核记录 ${modelRows.length} 条`);
    await page2.evaluate(() => { const f = document.querySelector('.baf-fab'); if (f) f.click(); });
    await sleep(250);
    const s2 = await state(page2);
    check('模型复核后页面隐藏状态仍可响应', s2.comments.length > 0 && (s2.placeholders > 0 || s2.comments.some(c => c.marked)),
      `${s2.comments.length} 条评论 / ${s2.placeholders} 个占位条 / FAB=${s2.fab}`);
    const apiLine = s2.panel;
    check('接口不可用时明确提示（状态文案存在）', /模型复核|接口不可用|纯规则/.test(apiLine), apiLine.slice(0, 120).replace(/\s+/g, ' '));

    await page2.close();
    await opt.close();
    if (!page.isClosed()) await page.close();
  } finally {
    await browser.close();
    if (mock) await mock.close();
  }

  const summary = {
    generatedAt: new Date().toISOString(),
    liveModelCall: LIVE,
    modelEndpoint: LIVE ? 'https://maas-api.antdigital.com/v1/systemone' : '本地 mock 决策服务',
    checks,
    passed: checks.filter(c => c.ok).length,
    failed: checks.filter(c => !c.ok).length
  };
  writeFileSync(path.join(OUT, 'e2e-result.json'), JSON.stringify(summary, null, 2));
  console.log(`\n合计 ${checks.length} 项：通过 ${summary.passed}，失败 ${summary.failed}`);
  if (summary.failed) process.exitCode = 1;
}

run().catch(e => { console.error('E2E 运行异常：', e); process.exit(1); });
