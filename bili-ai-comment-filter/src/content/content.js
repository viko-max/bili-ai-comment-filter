/* 内容脚本：把评论 API 线索与 DOM 节点对齐，执行本地规则 / 模型复核，
 * 并提供隐藏、判定依据、恢复、名单管理。所有效果只在当前浏览器内。
 */
(function () {
  'use strict';
  if (window.__BAF_CONTENT_INSTALLED__) return;
  window.__BAF_CONTENT_INSTALLED__ = true;

  const NS = window.BiliAICF || {};
  const Rules = NS.Rules || NS;
  const Decision = NS.Decision || NS;
  const Store = NS.Store || NS;
  const U = NS;
  const KEYS = (Store.KEYS) || {
    settings: 'settings', lists: 'lists', overrides: 'overrides',
    sessionComments: 'sessionComments', lastDecisions: 'lastDecisions', apiStatus: 'apiStatus'
  };

  // 内容脚本只读写本地存储（chrome.storage.session 默认不对内容脚本开放）；
  // API Key 由后台 service worker 单独保存在 session 区，内容脚本永远接触不到。
  const sess = chrome.storage.local;
  const local = chrome.storage.local;

  const ST = {
    settings: Store.normalizeSettings ? Store.normalizeSettings({}) : {},
    lists: { whitelist: [], blocklist: [] },
    overrides: {},
    sessionComments: [],
    records: new Map(),
    apiRecords: new Map(),     // rpid -> 评论 API 的结构化记录快照（不受 DOM 重扫影响）
    bindings: new Map(),       // key -> Set<Element>
    placeholders: new Map(),   // key -> Element
    accountResults: {},
    decisions: new Map(),
    modelResults: {},
    modelDone: new Set(),
    apiStatus: null,
    videoId: '',
    oid: '',
    observedRoots: new WeakSet(),
    cssText: '',
    rootEl: null,
    commentHosts: [],
    panelOpen: false,
    showKeep: false,          // 是否在面板里列出「保留」项，供用户人工兜底
    selectedKey: null,
    reviewInFlight: false,
    recomputeTimer: null,
    scanTimer: null
  };

  const ITEM_SELECTORS = [
    '.reply-item', '.sub-reply-item', '.reply-wrap', '.comment-item', '.comment-list-item',
    'bili-comment-renderer', 'bili-comment-reply-renderer', 'bili-comment-thread-renderer',
    '[data-rpid]', '[data-baf-comment]'
  ].join(',');
  const USER_LINK = 'a[href*="space.bilibili.com"], [data-mid], [data-uid]';
  const TEXT_SELECTORS = '.reply-content, .comment-text, .comment-content, bili-rich-text, .content-text, .text-con, .text, [class*="reply-content"], [class*="comment-text"]';

  // ---------- 存储 ----------
  function readStore(area, defaults) {
    return new Promise(resolve => {
      try { area.get(defaults, v => resolve(v || {})); } catch (_) { resolve({}); }
    });
  }
  function writeStore(area, obj) {
    try { area.set(obj); } catch (_) {}
  }
  async function loadState() {
    const [l, s] = await Promise.all([
      readStore(local, { settings: null, lists: null }),
      readStore(sess, { overrides: {}, apiStatus: null, lastDecisions: [] })
    ]);
    ST.settings = Store.normalizeSettings(l.settings);
    ST.lists = Store.normalizeLists(l.lists);
    ST.overrides = s.overrides || {};
    ST.sessionComments = [];
    ST.apiStatus = s.apiStatus || null;
  }

  // ---------- 视频标识 ----------
  function videoIdFromUrl(href) {
    // 只认明确的视频 URL；about:blank / 未知路径不得触发「切换视频」重置
    const m = String(href || '').match(/\/(BV[0-9A-Za-z]{8,12})|\/(av\d+)|[?&]aid=(\d+)/i);
    return m ? (m[1] || m[2] || ('aid:' + m[3])) : '';
  }
  function oidFromUrl(url) {
    try { return new URL(url, location.href).searchParams.get('oid') || new URL(url, location.href).searchParams.get('aid') || ''; }
    catch (_) { return ''; }
  }

  // ---------- 评论 API 数据归一化 ----------
  function normalizeComment(raw, extra) {
    const content = raw.content || {};
    const member = raw.member || {};
    const lvl = (member.level_info && member.level_info.current_level) || raw.level || 0;
    const text = String(content.message || raw.message || raw.text || '').trim();
    if (!text) return null;
    const uid = String(raw.mid != null ? raw.mid : (member.mid != null ? member.mid : (extra.uid || '')));
    const uname = String(member.uname || raw.uname || extra.uname || '');
    const sign = String(member.sign || raw.sign || '');
    const rpid = String(raw.rpid != null ? raw.rpid : (raw.id || ''));
    const ctime = Number(raw.ctime) || Number(raw.time) || 0;
    const oid = String(raw.oid || extra.oid || ST.oid || '');
    const key = rpid ? 'r:' + rpid : 'd:' + uid + ':' + U.hash32(text.slice(0, 80));
    // 头像只在本地做归一化哈希用于聚类，URL 本身不保存、不发送
    const face = String((raw.member && raw.member.face) || raw.face || '');
    return {
      key, rpid, uid, uname, sign, level: Number(lvl) || 0, text, ctime, oid,
      avatarKey: raw.avatarKey || U.avatarKey(face),
      videoId: ST.videoId,
      like: Number(raw.like) || 0,
      replyCount: Number(raw.rcount != null ? raw.rcount : raw.reply_count) || 0,
      parentId: String(raw.parent || 0), rootId: String(raw.root || 0),
      isSub: !!(extra.isSub || (raw.parent && String(raw.parent) !== '0'))
    };
  }

  function ingestApiData(data, url) {
    const oid = oidFromUrl(url) || (data && data.cursor && data.cursor.oid ? String(data.cursor.oid) : '') || ST.oid;
    if (oid) ST.oid = String(oid);
    let added = 0;
    const seen = new Set();
    function walk(list, isSub) {
      if (!Array.isArray(list)) return;
      for (const raw of list) {
        if (!raw || typeof raw !== 'object' || seen.has(raw)) continue;
        seen.add(raw);
        const c = normalizeComment(raw, { oid, isSub, uid: raw.mid, uname: raw.member && raw.member.uname });
        if (c) {
          ST.records.set(c.key, c);
          ST.apiRecords.set(c.key, c);
          added++;
          // 追加到会话历史（仅保留跨视频所需的最小字段）
          ST.sessionComments.push({ uid: c.uid, oid: c.oid || oid, videoId: ST.videoId, ctime: c.ctime, text: c.text.slice(0, 120) });
        }
        if (Array.isArray(raw.replies) && raw.replies.length) walk(raw.replies, true);
      }
    }
    walk(data && data.replies, false);
    walk(data && data.hots, false);
    walk(data && data.top, false);
    if (data && data.upper && data.upper.top) walk([data.upper.top], false);
    if (data && data.top_replies) walk(data.top_replies, true);
    // 楼中楼接口：data.replies 已经是子回复；也兼容 { root: {...}, replies: [...] }
    if (data && Array.isArray(data.replies) && data.root) walk([data.root], false);
    if (ST.sessionComments.length > 900) ST.sessionComments = ST.sessionComments.slice(-900);
    // 会话历史只保存在本标签页内存里，避免多标签页同时写 storage 相互覆盖
    if (ST.apiRecords.size > 1500) {
      const stale = [...ST.apiRecords.keys()].slice(0, 500);
      for (const k of stale) ST.apiRecords.delete(k);
    }
    if (added) {
      // DOM 可能比钩子更早渲染；API 数据到达后重新对齐一次绑定
      scanAll();
      scheduleRecompute();
    }
  }

  // ---------- DOM 扫描（含 Shadow DOM） ----------
  function ensureObserved(root, observer) {
    if (!root || ST.observedRoots.has(root)) return;
    try {
      ST.observedRoots.add(root);
      // 同时监听 class/style 变化：B 站 React 重渲染会清掉我们加的隐藏属性
      observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
      if (ST.cssText && root !== document && typeof root.querySelector === 'function') injectStyle(root);
    } catch (_) {}
  }
  function injectStyle(root) {
    try {
      if (root.querySelector('style[data-baf-style]')) return;
      const s = document.createElement('style');
      s.setAttribute('data-baf-style', '1');
      s.textContent = ST.cssText;
      root.appendChild(s);
    } catch (_) {}
  }
  function collectRoots(observer) {
    const roots = [document];
    const walk = (node) => {
      if (!node || !node.querySelectorAll) return;
      let els;
      try { els = node.querySelectorAll('*'); } catch (_) { return; }
      for (const el of els) {
        if (el.shadowRoot) { roots.push(el.shadowRoot); ensureObserved(el.shadowRoot, observer); walk(el.shadowRoot); }
      }
    };
    walk(document);
    for (const r of roots) ensureObserved(r, observer);
    return roots;
  }
  function rpidOf(el) {
    const own = el.getAttribute('data-rpid') || el.getAttribute('data-reply-id') ||
      el.getAttribute('data-id') || (el.id && (el.id.match(/\d{6,}/) || [])[0]) || '';
    if (own) return String(own);
    const p = el.closest && el.closest('[data-rpid],[data-id]');
    if (p && p !== el) return p.getAttribute('data-rpid') || p.getAttribute('data-id') || '';
    return '';
  }
  // B 站新版评论是 bili-comment-thread-renderer -> bili-comment-renderer 的嵌套
  // shadow host，正文在 bili-rich-text、昵称在 bili-comment-user-info 里。
  // `textContent` 和 `querySelector` 都**不穿透** Shadow DOM，必须递归取。
  function deepQuery(root, selector, depth) {
    if (!root || (depth || 0) > 8) return null;
    // root 自己就是 shadow host 时，内容在 root.shadowRoot 里，必须先进入
    if (root.shadowRoot) {
      const r = deepQuery(root.shadowRoot, selector, (depth || 0) + 1);
      if (r) return r;
    }
    let hit = null;
    try { hit = root.querySelector(selector); } catch (_) {}
    if (hit) return hit;
    let all = [];
    try { all = [...root.querySelectorAll('*')]; } catch (_) { return null; }
    for (const c of all) {
      if (c.shadowRoot) {
        const r = deepQuery(c.shadowRoot, selector, (depth || 0) + 1);
        if (r) return r;
      }
    }
    return null;
  }

  // 遍历文本节点：跳过 style/script（B 站的 style 里全是 CSS 变量，会污染正文）
  // 以及扩展自己插入的 baf-* 节点。
  function deepText(root, depth) {
    if (!root || (depth || 0) > 8) return '';
    let out = '';
    const walk = (node, d) => {
      if (!node || d > 8) return;
      if (node.nodeType === 3) { out += ' ' + node.nodeValue; return; }
      if (node.nodeType !== 1 && node.nodeType !== 11) return;
      const tag = node.tagName ? String(node.tagName).toLowerCase() : '';
      if (tag === 'style' || tag === 'script' || tag === 'noscript' || tag === 'template') return;
      const cls = node.className ? String(node.className) : '';
      if (cls.indexOf('baf-') === 0) return;
      if (node.shadowRoot) walk(node.shadowRoot, d + 1);
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i], d);
    };
    walk(root, depth || 0);
    return out;
  }

  function uidOf(el) {
    if (el.getAttribute('data-uid')) return el.getAttribute('data-uid');
    if (el.getAttribute('data-mid')) return el.getAttribute('data-mid');
    const a = deepQuery(el, 'a[href*="space.bilibili.com"]');
    if (a) {
      const m = String(a.getAttribute('href') || '').match(/space\.bilibili\.com\/(\d+)/);
      if (m) return m[1];
    }
    return '';
  }
  function unameOf(el) {
    const n = deepQuery(el, '#user-name, .user-name, .bili-comment-user-name, [class*="user-name"]');
    if (n) {
      const s = String(n.textContent || '').trim();
      if (s) return s.slice(0, 40);
    }
    const img = deepQuery(el, 'bili-avatar img, img[src*="bfs/face"]');
    const alt = img && img.getAttribute('alt');
    return alt ? String(alt).trim().slice(0, 40) : '';
  }
  function textOf(el) {
    // 明确优先取正文容器：bili-rich-text 只在正文里，天然排除扩展插入的按钮文字
    const t = deepQuery(el, 'bili-rich-text, ' + TEXT_SELECTORS);
    const s = (t ? deepText(t) : deepText(el)).replace(/\s+/g, ' ').trim();
    return s.slice(0, 600);
  }
  function avatarOf(el) {
    // 只取明确的头像容器；不要用兜底 `img`，否则评论内容里的表情包会被当成头像
    const img = deepQuery(el, 'bili-avatar img, .bili-avatar img, img[src*="bfs/face"], img[data-src*="bfs/face"]');
    if (!img) return '';
    return String(img.getAttribute('src') || img.getAttribute('data-src') || '');
  }
  // 只处理评论区容器内的节点。此前全 document 扫描会把 UP 主头像、
  // 推荐视频作者、视频标题也当成「评论」，导致隐藏了无关内容。
  function refreshCommentHosts() {
    const out = [];
    for (const sel of ['bili-comments', '#comment', '.comment-container', '#commentapp']) {
      try { const el = document.querySelector(sel); if (el) out.push(el); } catch (_) {}
    }
    ST.commentHosts = out;
  }
  function isInComments(el) {
    const hosts = ST.commentHosts || [];
    if (!hosts.length) return false;
    for (const h of hosts) {
      if (h === el || h.contains(el)) return true;
      let r = el.getRootNode ? el.getRootNode() : null;
      let guard = 0;
      while (r && r.host && guard++ < 6) {
        if (r.host === h || h.contains(r.host)) return true;
        r = r.host.getRootNode ? r.host.getRootNode() : null;
      }
    }
    return false;
  }

  function findCommentNodes(root) {
    const set = new Set();
    try {
      root.querySelectorAll(ITEM_SELECTORS).forEach(el => {
        if (isInComments(el)) set.add(el);
      });
      root.querySelectorAll(USER_LINK).forEach(link => {
        const host = link.closest ? link.closest(ITEM_SELECTORS) : null;
        // 去掉「parentElement.parentElement」兜底：它会把 UP 主头像、
        // 推荐视频作者也当成评论，进而隐藏视频标题等无关内容
        if (host && isInComments(host)) set.add(host);
      });
    } catch (_) {}
    const all = [...set].map(el => ({
      el, rpid: rpidOf(el), uid: uidOf(el), text: textOf(el),
      uname: unameOf(el), face: avatarOf(el)
    }))
      .filter(x => x.rpid || x.text.length >= 4);
    // B 站新版：thread-renderer 是外层容器（含 renderer + 回复列表），
    // 真正的单条评论是 bili-comment-renderer / bili-comment-reply-renderer。
    // 跨 Shadow DOM 的 contains() 不生效，所以按标签显式挑内层。
    const INNER_TAG = /^(bili-comment-renderer|bili-comment-reply-renderer)$/i;
    const inner = all.filter(x => INNER_TAG.test(x.el.tagName));
    const pool = inner.length ? inner : all.filter(x => !/^bili-comment-thread-renderer$/i.test(x.el.tagName));
    // 保留最内层：不隐藏包含其它独立评论的容器，避免误伤整个楼
    return pool.filter(x => !pool.some(y => y !== x && y.rpid && y.rpid !== x.rpid && x.el.contains(y.el)));
  }

  // 用 API 快照补全 DOM 兜底记录里拿不到的结构化字段（等级、时间、头像、互动数）
  function enrichFromApi(rec, apiKey) {
    const snap = apiKey && ST.apiRecords.get(apiKey);
    if (!snap) return rec;
    const merged = Object.assign({}, rec, {
      ctime: snap.ctime || rec.ctime,
      level: snap.level || rec.level,
      avatarKey: snap.avatarKey || rec.avatarKey,
      like: snap.like || rec.like,
      replyCount: snap.replyCount || rec.replyCount,
      oid: snap.oid || rec.oid,
      videoId: ST.videoId || rec.videoId,
      uid: snap.uid || rec.uid,
      uname: snap.uname || rec.uname,
      sign: snap.sign || rec.sign || ''
    });
    ST.records.set(merged.key, merged);
    return merged;
  }

  function matchRecord(node) {
    const apiKey = node.rpid ? 'r:' + node.rpid : '';
    if (apiKey && ST.records.has(apiKey)) return enrichFromApi(ST.records.get(apiKey), apiKey);
    if (apiKey && ST.apiRecords.has(apiKey)) {
      ST.records.set(apiKey, ST.apiRecords.get(apiKey));
      return ST.apiRecords.get(apiKey);
    }
    const norm = U.normalizeText(node.text);
    let best = null, bestSim = 0;
    for (const rec of ST.records.values()) {
      if (rec.videoId !== ST.videoId) continue;
      if (node.uid && rec.uid && String(node.uid) !== String(rec.uid)) continue;
      if (node.uname && rec.uname && node.uname !== rec.uname) continue;
      const sim = U.textSimilarity(norm, U.normalizeText(rec.text));
      if (sim > bestSim) { bestSim = sim; best = rec; }
    }
    if (best && bestSim >= 0.55) return best;
    // DOM-only 记录：SSR / 未拦截到 API 时的兜底。
    // 若节点带 rpid，沿用同一个 key，稍后 API 数据到达时会原地覆盖，不产生重复记录。
    const uid = node.uid || ('dom:' + U.hash32(node.uname + norm.slice(0, 40)));
    const key = apiKey || ('d:' + uid + ':' + U.hash32(norm.slice(0, 80)));
    if (!ST.records.has(key)) {
      ST.records.set(key, {
        key, rpid: node.rpid || '', uid, uname: node.uname, level: 0,
        avatarKey: U.avatarKey(node.face),
        text: node.text, ctime: 0, oid: ST.oid, videoId: ST.videoId,
        like: 0, replyCount: 0, parentId: '0', rootId: '0', isSub: false
      });
    }
    return enrichFromApi(ST.records.get(key), apiKey);
  }

  function scanAll() {
    const observer = ST.observer;
    if (!observer) return;
    refreshCommentHosts();
    const roots = collectRoots(observer);
    for (const root of roots) {
      for (const node of findCommentNodes(root)) {
        const rec = matchRecord(node);
        if (!rec) continue;
        if (!ST.bindings.has(rec.key)) ST.bindings.set(rec.key, new Set());
        ST.bindings.get(rec.key).add(node.el);
      }
    }
    applyAll();
  }

  // ---------- 判定 ----------
  function scheduleRecompute() {
    clearTimeout(ST.recomputeTimer);
    ST.recomputeTimer = setTimeout(recompute, 160);
  }

  function recompute() {
    if (!ST.settings.enabled) { clearAllEffects(); renderPanel(); return; }
    const comments = [...ST.records.values()].filter(r => r.videoId === ST.videoId);
    const history = ST.sessionComments.filter(x => x.videoId && x.videoId !== ST.videoId);
    const res = Rules.evaluatePage({
      comments, settings: ST.settings, lists: ST.lists, overrides: scopedOverrides(), sessionComments: history
    });
    ST.accountResults = res.accounts || {};
    const decisions = (res.decisions || []).map(d => {
      const m = ST.modelResults[d.uid];
      if (!m) return Object.assign({}, d, { source: 'rules' });
      const c = Decision.combine(d, m, ST.settings);
      return Object.assign({}, d, {
        decision: c.decision, reasons: c.reasons, modelStatus: c.modelStatus,
        model: c.model, source: 'model'
      });
    });
    ST.decisions = new Map(decisions.map(d => [d.key, d]));
    writeStore(sess, { lastDecisions: decisions.slice(0, 400) });
    applyAll();
    renderPanel();
    maybeReview();
  }

  function scopedOverrides() {
    const out = {};
    const prefix = ST.videoId + '|';
    for (const k of Object.keys(ST.overrides)) if (k.indexOf(prefix) === 0) out[k.slice(prefix.length)] = ST.overrides[k];
    return out;
  }
  function setOverride(key, value) {
    ST.overrides[ST.videoId + '|' + key] = value;
    writeStore(sess, { overrides: ST.overrides });
  }

  function maybeReview() {
    if (ST.reviewInFlight) return;
    if (ST.settings.mode !== 'model' || !ST.settings.api.enabled) return;
    const reviewSet = ST.settings.reviewDecisions || ['mark', 'hide'];
    const includeAll = (ST.settings.reviewScope || 'suspect') === 'all';
    const accounts = [];
    const seen = new Set();
    for (const [uid, a] of Object.entries(ST.accountResults)) {
      if (seen.has(uid) || ST.modelDone.has(uid)) continue;
      // 默认只复核 mark/hide；reviewScope=all 时把 keep 也送检，
      // 让模型有机会发现本地规则漏掉的可疑账号（只能升级到「标记」，不能隐藏）。
      if (a.overridden || (!includeAll && !reviewSet.includes(a.decision))) continue;
      seen.add(uid);
      const texts = [...ST.records.values()].filter(r => r.videoId === ST.videoId && String(r.uid) === uid).map(r => r.text);
      accounts.push(Object.assign({}, a, {
        uid, commentTexts: texts.slice(0, 4),
        reasons: a.reasons || [],
        cacheKey: Decision.cacheKey(Object.assign({}, a, { commentTexts: texts.slice(0, 4) }))
      }));
    }
    if (!accounts.length) return;
    ST.reviewInFlight = true;
    chrome.runtime.sendMessage({ type: 'BAF_REVIEW', accounts }, resp => {
      ST.reviewInFlight = false;
      const lastErr = chrome.runtime.lastError;
      if (lastErr) { setApiStatus(false, '扩展后台不可用：' + lastErr.message); return; }
      if (resp && resp.status === 'ok') {
        for (const uid of Object.keys(resp.results || {})) { ST.modelDone.add(uid); ST.modelResults[uid] = resp.results[uid]; }
        setApiStatus(true, resp.meta || {});
        recompute();
      } else if (resp && resp.status === 'disabled') {
        setApiStatus(false, resp.message || '模型复核未启用');
        for (const a of accounts) ST.modelDone.add(a.uid);
      } else {
        setApiStatus(false, (resp && (resp.message || resp.error)) || '接口不可用，已回退纯规则模式');
        for (const a of accounts) ST.modelDone.add(a.uid);
      }
      renderPanel();
    });
  }

  function setApiStatus(ok, info) {
    ST.apiStatus = { ok: !!ok, message: typeof info === 'string' ? info : '', meta: typeof info === 'object' ? info : {}, at: Date.now() };
    writeStore(sess, { apiStatus: ST.apiStatus });
  }

  // ---------- 轻提示 / cookie / 拉黑 ----------
  function toast(msg, bad) {
    let t = document.getElementById('baf-toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'baf-toast';
      (document.body || document.documentElement).appendChild(t);
    }
    t.textContent = msg;
    t.className = bad ? 'baf-toast-bad' : '';
    t.dataset.on = '1';
    clearTimeout(toast.__timer);
    toast.__timer = setTimeout(() => { t.dataset.on = '0'; }, 3600);
  }

  function cookieOf(name) {
    const m = String(document.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  // 调用 B 站公开的拉黑接口（act=5）。属于写操作，只在用户明确确认后调用。
  async function blockUser(uid, uname) {
    const jct = cookieOf('bili_jct');
    if (!jct) {
      toast('拉黑失败：未检测到 bili_jct，请先在当前浏览器登录 B 站', true);
      return { ok: false, reason: 'not-logged-in' };
    }
    if (!uid || !/^\d+$/.test(String(uid))) {
      toast('拉黑失败：没取到这个账号的 UID', true);
      return { ok: false, reason: 'no-uid' };
    }
    const body = new URLSearchParams({
      fid: String(uid), act: '5', re_src: '11', csrf: jct
    });
    try {
      const resp = await fetch('https://api.bilibili.com/x/relation/modify', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      const json = await resp.json().catch(() => null);
      const code = json && json.code;
      if (code === 0) {
        toast(`已把「${uname || uid}」加入 B 站黑名单，并已本地屏蔽`);
        if (uid) {
          ST.lists = Store.addUid(ST.lists, 'blocklist', String(uid));
          writeStore(local, { lists: ST.lists });
        }
        scheduleRecompute();
        return { ok: true };
      }
      const msg = {
        '-101': '账号未登录，请先在当前浏览器登录 B 站',
        '-111': 'csrf 校验失败，刷新页面后重试',
        '22001': '对方在黑名单里已存在',
        '22003': '不能拉黑自己',
        '22008': '操作过于频繁，请稍后再试'
      }[String(code)];
      toast(`拉黑失败（code ${code}）${msg || (json && json.message) || ''}`, true);
      return { ok: false, reason: code };
    } catch (e) {
      toast('拉黑失败：网络或跨域错误，' + (e && e.message ? e.message : '请稍后重试'), true);
      return { ok: false, reason: 'network' };
    }
  }

  // ---------- 页面效果 ----------
  // 隐藏状态以 data-* 属性 + 内联 !important 为准：B 站 React 重渲染会重置
  // className，只有属性和内联样式能稳住；属性丢失时由 MutationObserver 补回。
  const HIDE_PROPS = ['height', 'min-height', 'max-height', 'margin', 'padding',
    'border', 'overflow', 'opacity', 'visibility', 'pointer-events', 'display'];

  // 真正的「一条评论」容器：扫描命中的元素可能只是头像/昵称块，正文在兄弟节点里。
  // 向上扩展，直到父级出现别的评论为止；同时防止把整个评论区一起隐藏。
  function hideScope(el) {
    const own = rpidOf(el);
    // 已经包含正文（el 内能找到正文容器）就用它自己，不要向上扩，否则会把整列表隐藏
    let hasText = false;
    try { hasText = !!(deepQuery(el, 'bili-rich-text, ' + TEXT_SELECTORS)); } catch (_) {}
    if (hasText) return el;
    const ownText = String(el.textContent || '').length;
    let node = el;
    for (let i = 0; i < 3; i++) {
      const p = node.parentElement;
      if (!p || p === document.body || p === document.documentElement) break;
      let cands;
      try { cands = [...p.querySelectorAll(ITEM_SELECTORS)]; } catch (_) { break; }
      // 父级里连评论项都匹配不到 → 无法确认边界，不扩
      if (!cands.length) break;
      let other = 0;
      for (const c of cands) {
        if (c === node || c === el) continue;
        const rp = rpidOf(c);
        if (rp && rp !== own) other++;
      }
      if (other > 0) break;
      const pText = String(p.textContent || '').length;
      if (pText > Math.max(ownText * 3 + 120, 600)) break;
      node = p;
    }
    return node;
  }

  function setHideState(el, hard) {
    const target = hideScope(el);
    el._bafTarget = target;
    const paint = (n) => {
      if (hard) {
        n.classList.add('baf-hidden-hard');
        n.setAttribute('data-baf-hidden-hard', '1');
        n.removeAttribute('data-baf-hidden');
        n.style.setProperty('display', 'none', 'important');
      } else {
        // 占位条是兄弟节点，评论本体直接 display:none，避免「高度压成 0 但内容溢出」
        n.classList.add('baf-hidden');
        n.setAttribute('data-baf-hidden', '1');
        n.style.setProperty('display', 'none', 'important');
        n.style.setProperty('height', '0', 'important');
        n.style.setProperty('min-height', '0', 'important');
        n.style.setProperty('max-height', '0', 'important');
        n.style.setProperty('margin', '0', 'important');
        n.style.setProperty('padding', '0', 'important');
        n.style.setProperty('border', '0', 'important');
        n.style.setProperty('overflow', 'hidden', 'important');
        n.style.setProperty('opacity', '0', 'important');
        n.style.setProperty('visibility', 'hidden', 'important');
        n.style.setProperty('pointer-events', 'none', 'important');
      }
    };
    paint(target);
    if (target !== el) paint(el);
    return target;
  }

  function clearHideState(el) {
    const targets = [el, el._bafTarget].filter(Boolean);
    delete el._bafTarget;
    for (const n of targets) {
      n.classList.remove('baf-hidden', 'baf-hidden-hard', 'baf-marked');
      n.removeAttribute('data-baf-hidden');
      n.removeAttribute('data-baf-hidden-hard');
      for (const p of HIDE_PROPS) n.style.removeProperty(p);
    }
    el.classList.remove('baf-marked');
  }

  function clearAllEffects() {
    for (const [, ph] of ST.placeholders) { try { ph.remove(); } catch (_) {} }
    ST.placeholders.clear();
    for (const [, els] of ST.bindings) for (const el of els) {
      clearHideState(el);
      const acts = el.querySelector && el.querySelector(':scope > .baf-actions');
      if (acts) acts.remove();
    }
  }

  function makeButton(label, act, key, extraClass, meta) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'baf-btn ' + (extraClass || '');
    b.dataset.bafAct = act;
    b.dataset.bafKey = key;
    if (meta) {
      if (meta.rpid) b.dataset.bafRpid = String(meta.rpid);
      if (meta.uid) b.dataset.bafUid = String(meta.uid);
    }
    b.textContent = label;
    b.addEventListener('click', ev => {
      ev.preventDefault();
      ev.stopPropagation();
      onAction(act, key, { rpid: b.dataset.bafRpid, uid: b.dataset.bafUid });
    });
    return b;
  }

  // 按钮是渲染时绑定的 key；DOM 兜底记录被评论 API 记录替换后 key 会变，
  // 此时按 rpid（其次 uid）找回当前决策，避免「点了没反应」。
  function resolveDecision(key, meta) {
    const direct = ST.decisions.get(key);
    if (direct) return { key, d: direct };
    const rpid = meta && meta.rpid;
    const uid = meta && meta.uid;
    if (rpid) {
      for (const [k, d] of ST.decisions) if (String(d.rpid) === String(rpid)) return { key: k, d };
    }
    if (uid) {
      for (const [k, d] of ST.decisions) if (String(d.uid) === String(uid)) return { key: k, d };
    }
    return { key, d: null };
  }

  // 记录发生 key 替换（DOM 兜底 -> 评论 API）时，旧 key 的占位条会变成孤儿，
  // 留在页面上却不归任何决策管，表现为「有占位条但正文还在」。统一按元素清掉。
  function dropOrphanPlaceholders(el) {
    if (!el || !el.parentNode) return;
    let n = el.previousElementSibling;
    // 只清理紧邻的连续占位条；遇到别的元素立即停，否则会把别的评论的占位条一起删掉
    while (n && n.classList && n.classList.contains('baf-placeholder')) {
      const prev = n.previousElementSibling;
      for (const [k, v] of ST.placeholders) if (v === n) ST.placeholders.delete(k);
      n.remove();
      n = prev;
    }
  }

  function ensurePlaceholder(key, el, d) {
    if (ST.settings.display === 'vanish') { removePlaceholder(key); return; }
    let ph = ST.placeholders.get(key);
    if (ph && ph.isConnected) return;
    dropOrphanPlaceholders(el);
    ph = document.createElement('div');
    ph.className = 'baf-placeholder';
    ph.appendChild(Object.assign(document.createElement('span'), { className: 'baf-ph-tag', textContent: '已隐藏' }));
    ph.appendChild(Object.assign(document.createElement('span'), { className: 'baf-ph-text', textContent: '疑似自动发评 · ' + (d.uname || '未知用户') }));
    const meta = { rpid: d.rpid, uid: d.uid };
    ph.appendChild(makeButton('判定依据', 'why', key, '', meta));
    ph.appendChild(makeButton('恢复', 'restore', key, 'baf-btn-primary', meta));
    ph.appendChild(makeButton('加白名单', 'whitelist', key, '', meta));
    ph.appendChild(makeButton('拉黑', 'block', key, 'baf-btn-danger', meta));
    ST.placeholders.set(key, ph);
    try { el.parentNode.insertBefore(ph, el); } catch (_) {}
  }
  function removePlaceholder(key) {
    const ph = ST.placeholders.get(key);
    if (ph) { try { ph.remove(); } catch (_) {} ST.placeholders.delete(key); }
  }

  function ensureActions(key, el, d) {
    if (!el.querySelector) return;
    let acts = el.querySelector(':scope > .baf-actions');
    if (!acts) {
      acts = document.createElement('span');
      acts.className = 'baf-actions';
      try { el.appendChild(acts); } catch (_) { return; }
    }
    // 幂等键必须带上 key：DOM 兜底记录（d:*）被评论 API 记录（r:*）替换后，
    // 只比较 decision 会误判「状态没变」而不重建按钮，按钮就仍绑在废弃的 key 上。
    const stateKey = d.decision + '|' + key;
    if (acts.dataset.bafState === stateKey) return;
    acts.dataset.bafState = stateKey;
    acts.textContent = '';
    const meta = { rpid: d.rpid, uid: d.uid };
    if (d.decision === 'mark') acts.appendChild(Object.assign(document.createElement('span'), { className: 'baf-badge', textContent: '疑似自动发评' }));
    acts.appendChild(makeButton('依据', 'why', key, '', meta));
    if (d.decision !== 'hide') acts.appendChild(makeButton('隐藏', 'hide', key, '', meta));
    if (d.decision === 'hide') acts.appendChild(makeButton('恢复', 'restore', key, '', meta));
    acts.appendChild(makeButton('拉黑', 'block', key, 'baf-btn-danger', meta));
  }

  const RANK = { hide: 3, mark: 2, keep: 1 };

  function applyAll() {
    // 同一 UID 的记录必须给同一处置：评论 API 记录与 DOM 兜底记录可能被拆成两条，
    // 否则会出现「占位条隐藏了、正文还在」的撕裂状态。取最严重的一档。
    const uidWorst = new Map();
    for (const d of ST.decisions.values()) {
      if (d.overridden || !d.uid) continue;
      const cur = uidWorst.get(String(d.uid));
      if (!cur || RANK[d.decision] > RANK[cur]) uidWorst.set(String(d.uid), d.decision);
    }

    for (const [key, els] of ST.bindings) {
      const d = ST.decisions.get(key);
      if (!d) {
        // 记录已被新 key 取代（或尚未判定）：只回收已脱离文档的 binding，
        // 不动仍在页面上的元素——它们由新 key 的 binding 负责。
        if (![...els].some(el => el.isConnected)) {
          removePlaceholder(key);
          ST.bindings.delete(key);
        }
        continue;
      }
      const eff = d.overridden ? d.decision : (uidWorst.get(String(d.uid)) || d.decision);
      const dd = eff === d.decision ? d : Object.assign({}, d, { decision: eff });
      for (const el of els) {
        if (!el.isConnected) continue;
        el.dataset.bafKey = key;
        if (dd.decision === 'hide') {
          // 占位条插在「被隐藏的那一层」前面，而不是扫描命中的小元素前面
          const target = setHideState(el, ST.settings.display === 'vanish');
          ensurePlaceholder(key, target, dd);
        } else {
          const prevTarget = el._bafTarget || el;
          clearHideState(el);
          removePlaceholder(key);
          dropOrphanPlaceholders(prevTarget);
          dropOrphanPlaceholders(el);
        }
        if (dd.decision === 'mark') el.classList.add('baf-marked'); else el.classList.remove('baf-marked');
        ensureActions(key, el, dd);
      }
    }
  }

  function onAction(act, rawKey, meta) {
    const hit = resolveDecision(rawKey, meta);
    const key = hit.key;
    const d = hit.d || {};
    if (act === 'restore') {
      setOverride(key, 'keep');
      if (d.uid) { ST.modelResults[d.uid] = null; ST.modelDone.delete(d.uid); }
      removePlaceholder(key);
      scheduleRecompute();
    } else if (act === 'hide') {
      setOverride(key, 'hide');
      scheduleRecompute();
    } else if (act === 'mark') {
      setOverride(key, 'mark');
      scheduleRecompute();
    } else if (act === 'whitelist') {
      if (d.uid) { ST.lists = Store.addUid(ST.lists, 'whitelist', d.uid); writeStore(local, { lists: ST.lists }); }
      setOverride(key, 'keep');
      scheduleRecompute();
    } else if (act === 'blocklist') {
      if (d.uid) { ST.lists = Store.addUid(ST.lists, 'blocklist', d.uid); writeStore(local, { lists: ST.lists }); }
      scheduleRecompute();
    } else if (act === 'block') {
      // 拉黑是写操作：必须用户确认；同时写入本地屏蔽名单，接口失败也能先本地隐藏
      if (!d.uid) { toast('没取到这个账号的 UID，无法拉黑', true); return; }
      const ok = window.confirm(
        `确定把「${d.uname || d.uid}」（UID ${d.uid}）加入 B 站黑名单？\n\n` +
        '这会调用 B 站「拉黑用户」接口，在你自己的账号里生效；同时本地也会隐藏该账号的评论。'
      );
      if (!ok) return;
      blockUser(d.uid, d.uname);
    } else if (act === 'why') {
      ST.selectedKey = key; ST.panelOpen = true; renderPanel();
    }
  }

  // ---------- 悬浮面板 ----------
  function buildRoot() {
    if (ST.rootEl && ST.rootEl.isConnected) return;
    const root = document.createElement('div');
    root.id = 'baf-root';
    const fab = document.createElement('button');
    fab.className = 'baf-fab';
    fab.addEventListener('click', () => { ST.panelOpen = !ST.panelOpen; renderPanel(); });
    const panel = document.createElement('div');
    panel.className = 'baf-panel';
    root.appendChild(fab);
    root.appendChild(panel);
    ST.rootEl = root;
    ST.fabEl = fab;
    ST.panelEl = panel;
    (document.body || document.documentElement).appendChild(root);
    panel.addEventListener('click', ev => {
      const btn = ev.target && ev.target.closest && ev.target.closest('[data-baf-act]');
      if (!btn) return;
      const { bafAct, bafKey, bafUid } = btn.dataset;
      if (bafAct === 'why') { ST.selectedKey = bafKey; renderPanel(); }
      else if (bafAct === 'restore' || bafAct === 'hide' || bafAct === 'mark' || bafAct === 'whitelist' || bafAct === 'blocklist' || bafAct === 'block') onAction(bafAct, bafKey);
      else if (bafAct === 'toggle-keep') { ST.showKeep = !ST.showKeep; renderPanel(); }
      else if (bafAct === 'restore-all') { for (const [k, dd] of ST.decisions) if (dd.decision === 'hide') setOverride(k, 'keep'); scheduleRecompute(); }
      else if (bafAct === 'rescan') { ST.modelDone.clear(); ST.modelResults = {}; scanAll(); scheduleRecompute(); }
      else if (bafAct === 'settings') { chrome.runtime.sendMessage({ type: 'BAF_OPEN_OPTIONS' }); }
      else if (bafAct === 'toggle') {
        ST.settings.enabled = !ST.settings.enabled;
        writeStore(local, { settings: ST.settings });
        scheduleRecompute();
      } else if (bafAct === 'remove-list') {
        ST.lists = Store.removeUid(ST.lists, btn.dataset.bafList, bafUid);
        writeStore(local, { lists: ST.lists });
        scheduleRecompute();
      }
    });
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function renderPanel() {
    buildRoot();
    const counts = { hide: 0, mark: 0, keep: 0 };
    for (const d of ST.decisions.values()) if (counts[d.decision] != null) counts[d.decision]++;
    ST.fabEl.textContent = `AI 评论过滤 · 隐藏 ${counts.hide} / 标记 ${counts.mark}${ST.settings.enabled ? '' : '（已暂停）'}`;
    ST.panelEl.style.display = ST.panelOpen ? 'block' : 'none';
    if (!ST.panelOpen) return;

    const apiLine = ST.settings.mode === 'model'
      ? (ST.apiStatus ? (ST.apiStatus.ok
          ? `模型复核可用 · 最近耗时 ${ST.apiStatus.meta && ST.apiStatus.meta.ms != null ? ST.apiStatus.meta.ms + 'ms' : '—'} · 调用 ${ST.apiStatus.meta && ST.apiStatus.meta.requests != null ? ST.apiStatus.meta.requests : '—'} 次`
          : `接口不可用：${esc(ST.apiStatus.message || '未知错误')}（已回退纯规则）`)
        : '模型复核已启用，等待首次调用')
      : '纯规则模式（未启用模型复核）';

    const allDecisions = [...ST.decisions.values()];
    const keepCount = allDecisions.filter(d => d.decision === 'keep').length;
    const rows = allDecisions
      .filter(d => ST.showKeep || d.decision !== 'keep' || ST.selectedKey === d.key)
      .sort((a, b) => (a.decision === 'hide' ? 0 : a.decision === 'mark' ? 1 : 2) -
        (b.decision === 'hide' ? 0 : b.decision === 'mark' ? 1 : 2))
      .slice(0, 160)
      .map(d => {
        const tag = d.decision === 'hide' ? '隐藏' : d.decision === 'mark' ? '标记' : '保留';
        const k = esc(d.key);
        return `<div class="baf-row ${d.decision}">
          <span class="baf-row-tag">${tag}</span>
          <span class="baf-row-name">${esc(d.uname || '未知用户')}</span>
          <span class="baf-row-text">${esc(U.truncate(d.text, 50))}</span>
          <button data-baf-act="why" data-baf-key="${k}">依据</button>
          ${d.decision === 'hide'
            ? `<button data-baf-act="mark" data-baf-key="${k}">改标记</button><button data-baf-act="restore" data-baf-key="${k}">恢复</button><button data-baf-act="whitelist" data-baf-key="${k}">白名单</button>`
            : `<button data-baf-act="hide" data-baf-key="${k}">隐藏</button>${d.decision === 'keep' ? `<button data-baf-act="mark" data-baf-key="${k}">标记</button>` : `<button data-baf-act="restore" data-baf-key="${k}">恢复</button>`}<button data-baf-act="blocklist" data-baf-key="${k}">屏蔽UID</button>`}
          <button class="baf-btn-danger" data-baf-act="block" data-baf-key="${k}">拉黑</button>
        </div>`;
      }).join('');

    let detail = '<div class="baf-empty">点击任意「依据」查看判定理由</div>';
    if (ST.selectedKey) {
      const d = ST.decisions.get(ST.selectedKey);
      if (d) {
        const m = d.model;
        detail = `<div class="baf-detail">
          <div class="baf-detail-head">${esc(d.uname || '未知用户')} · UID ${esc(d.uid)} · ${d.decision === 'hide' ? '隐藏' : d.decision === 'mark' ? '标记' : '保留'}</div>
          <div class="baf-detail-text">${esc(U.truncate(d.text, 240))}</div>
          <div class="baf-detail-meta">本地得分 ${d.score} · 强证据类目 ${(d.strongCategories || []).join('、') || '无'} · 判定来源 ${d.source === 'model' ? '规则 + 模型复核' : '纯规则'}</div>
          ${m ? `<div class="baf-detail-meta">模型：source=${esc(m.source)} (${m.sourceProb}) · is_auto=${m.autoProb} · action=${esc(m.action)} · confidence=${m.confidence}</div>` : ''}
          <ul>${(d.reasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
          <div class="baf-detail-btns">
            <button data-baf-act="why" data-baf-key="${esc(d.key)}">刷新</button>
            <button data-baf-act="whitelist" data-baf-key="${esc(d.key)}">UID 加白名单</button>
            <button data-baf-act="blocklist" data-baf-key="${esc(d.key)}">UID 加屏蔽</button>
            <button class="baf-btn-danger" data-baf-act="block" data-baf-key="${esc(d.key)}">拉黑 B 站账号</button>
          </div>
        </div>`;
      }
    }

    const listRows = (kind, label) => (ST.lists[kind] || []).slice(0, 30).map(uid =>
      `<span class="baf-chip">${esc(label)} ${esc(uid)} <button data-baf-act="remove-list" data-baf-list="${kind}" data-baf-uid="${esc(uid)}">×</button></span>`).join('');

    ST.panelEl.innerHTML = `
      <div class="baf-head"><strong>B 站 AI 评论过滤</strong><span class="baf-sub">仅本浏览器生效</span></div>
      <div class="baf-stats"><span>隐藏 <b>${counts.hide}</b></span><span>标记 <b>${counts.mark}</b></span><span>保留 <b>${counts.keep}</b></span></div>
      <div class="baf-api ${ST.apiStatus && !ST.apiStatus.ok ? 'baf-api-bad' : ''}">${apiLine}</div>
      <div class="baf-btns">
        <button data-baf-act="toggle">${ST.settings.enabled ? '暂停' : '启用'}</button>
        <button data-baf-act="rescan">重新扫描</button>
        <button data-baf-act="restore-all">全部恢复</button>
        <button data-baf-act="settings">设置 / 名单</button>
        <button data-baf-act="toggle-keep" class="${ST.showKeep ? 'baf-btn-primary' : ''}">${ST.showKeep ? '收起保留项' : `显示保留项 (${keepCount})`}</button>
      </div>
      <div class="baf-section-title">判定记录（${ST.showKeep ? allDecisions.length : allDecisions.length - keepCount} 条，最多列 160）· 每行都能手动改</div>
      <div class="baf-rows">${rows || '<div class="baf-empty">暂无可疑评论</div>'}</div>
      <div class="baf-section-title">判定依据</div>${detail}
      <div class="baf-section-title">UID 名单</div>
      <div class="baf-chips">${listRows('whitelist', '白')}${listRows('blocklist', '屏蔽') || '<span class="baf-empty">暂无名单项</span>'}</div>`;
  }

  // ---------- 生命周期 ----------
  function resetForNewVideo(newId) {
    clearAllEffects();
    ST.videoId = newId;
    ST.records.clear();
    ST.bindings.clear();
    ST.placeholders.clear();
    ST.modelResults = {};
    ST.modelDone.clear();
    ST.decisions.clear();
    ST.oid = '';
    ST.selectedKey = null;
    scanAll();
    scheduleRecompute();
  }

  function handleNavigation(href) {
    const id = videoIdFromUrl(href);
    if (id && id !== ST.videoId) resetForNewVideo(id);
  }

  async function init() {
    await loadState();
    ST.videoId = videoIdFromUrl(location.href);

    try {
      const cssUrl = chrome.runtime.getURL('src/content/content.css');
      const r = await fetch(cssUrl);
      ST.cssText = await r.text();
    } catch (_) { ST.cssText = ''; }

    ST.observer = new MutationObserver(muts => {
      let needScan = false;
      let needReapply = false;
      const own = '.baf-actions, .baf-placeholder, #baf-root';
      for (const m of muts) {
        if (m.type === 'attributes') {
          // 我们加的隐藏属性被框架清掉了 → 重新贴回去
          const t = m.target;
          if (t && t.nodeType === 1 && t.dataset && t.dataset.bafKey) {
            const d = ST.decisions.get(t.dataset.bafKey);
            if (d && d.decision === 'hide' &&
                !t.hasAttribute('data-baf-hidden') && !t.hasAttribute('data-baf-hidden-hard')) {
              needReapply = true;
            }
          }
          continue;
        }
        for (const n of m.addedNodes || []) {
          if (n.nodeType !== 1) continue;
          // 忽略扩展自己插入的占位条 / 操作按钮 / 面板 / 样式，避免自触发无限重扫
          const tag = String(n.tagName || '').toLowerCase();
          if (tag === 'script' || tag === 'style') continue;
          if (n.matches && n.matches(own)) continue;
          const p = n.parentElement;
          if (p && p.closest && p.closest(own)) continue;
          needScan = true;
          if (n.shadowRoot) { ensureObserved(n.shadowRoot, ST.observer); injectStyle(n.shadowRoot); }
        }
      }
      if (needReapply) {
        clearTimeout(ST.reapplyTimer);
        ST.reapplyTimer = setTimeout(applyAll, 60);
      }
      if (needScan) {
        clearTimeout(ST.scanTimer);
        ST.scanTimer = setTimeout(() => { collectRoots(ST.observer); scanAll(); scheduleRecompute(); }, 120);
      }
    });
    ensureObserved(document, ST.observer);
    collectRoots(ST.observer);
    injectStyle(document.head || document.documentElement);

    window.addEventListener('message', ev => {
      if (ev.source !== window || !ev.data || ev.data.__BAF__ !== true) return;
      const { type, payload, href } = ev.data;
      if (type === 'api') ingestApiData(payload && payload.data, (payload && payload.url) || '');
      else if (type === 'navigation') handleNavigation(href);
      else if (type === 'ready') handleNavigation(href);
    });

    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        let changed = false;
        if (area === 'local') {
          if (changes.settings) { ST.settings = Store.normalizeSettings(changes.settings.newValue); changed = true; }
          if (changes.lists) { ST.lists = Store.normalizeLists(changes.lists.newValue); changed = true; }
        }
        if (changes.overrides) { ST.overrides = changes.overrides.newValue || {}; changed = true; }
        if (changes.apiStatus) ST.apiStatus = changes.apiStatus.newValue || null;
        if (changed) scheduleRecompute();
        renderPanel();
      });
    } catch (_) {}

    try {
      chrome.runtime.onMessage.addListener((msg, sender, reply) => {
        if (msg && msg.type === 'BAF_PING') reply({ ok: true, videoId: ST.videoId, counts: countsSnapshot() });
        else if (msg && msg.type === 'BAF_RESCAN') { ST.modelDone.clear(); ST.modelResults = {}; scanAll(); scheduleRecompute(); reply({ ok: true }); }
        else if (msg && msg.type === 'BAF_RESTORE_ALL') { for (const [k, d] of ST.decisions) if (d.decision === 'hide') setOverride(k, 'keep'); scheduleRecompute(); reply({ ok: true }); }
        return true;
      });
    } catch (_) {}

    // SPA 兜底：轮询 URL 变化
    let lastHref = location.href;
    setInterval(() => { if (location.href !== lastHref) { lastHref = location.href; handleNavigation(lastHref); } }, 1500);

    scanAll();
    scheduleRecompute();
    renderPanel();
  }

  function countsSnapshot() {
    const c = { hide: 0, mark: 0, keep: 0 };
    for (const d of ST.decisions.values()) if (c[d.decision] != null) c[d.decision]++;
    return c;
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
