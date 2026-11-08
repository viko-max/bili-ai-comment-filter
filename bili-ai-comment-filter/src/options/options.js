(function () {
  'use strict';
  const N = window.BiliAICF;
  const $ = id => document.getElementById(id);
  let settings, lists;

  function getLocal(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
  function setLocal(obj) { return new Promise(r => chrome.storage.local.set(obj, r)); }
  function send(m) {
    return new Promise(resolve => { try { chrome.runtime.sendMessage(m, r => resolve(r || {})); } catch (_) { resolve({}); } });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  }
  function flash(text, bad) {
    const el = $('saveMsg'); el.textContent = text; el.className = bad ? 'bad' : '';
    setTimeout(() => { el.textContent = ''; }, 4000);
  }

  // ---------- 设置 ----------
  function fillForm() {
    $('enabled').checked = !!settings.enabled;
    $('mode').value = settings.mode;
    $('display').value = settings.display;
    $('thHide').value = settings.thresholds.hide;
    $('thMark').value = settings.thresholds.mark;
    $('minStrong').value = settings.minStrongCategoriesForHide;
    $('mHide').value = settings.thresholds.modelHideProb;
    $('mAuto').value = settings.thresholds.modelAutoProb;
    $('mConf').value = settings.thresholds.modelConfidence;
    $('apiEnabled').checked = !!settings.api.enabled;
    $('endpoint').value = settings.api.endpoint;
    $('model').value = settings.api.model;
    $('protocol').value = settings.api.protocol;
    $('timeoutMs').value = settings.api.timeoutMs;
    $('batchSize').value = settings.api.batchSize;
    $('maxRequestsPerMinute').value = settings.api.maxRequestsPerMinute;
    $('maxConcurrent').value = settings.api.maxConcurrent;
    $('maxRequestsPerSession').value = settings.api.maxRequestsPerSession;
    $('cacheTtlMs').value = settings.api.cacheTtlMs;
  }
  function readForm() {
    const num = (id, fallback) => { const v = Number($(id).value); return Number.isFinite(v) ? v : fallback; };
    settings.enabled = $('enabled').checked;
    settings.mode = $('mode').value;
    settings.display = $('display').value;
    settings.thresholds.hide = num('thHide', 0.72);
    settings.thresholds.mark = num('thMark', 0.34);
    settings.minStrongCategoriesForHide = num('minStrong', 2);
    settings.thresholds.modelHideProb = num('mHide', 0.62);
    settings.thresholds.modelAutoProb = num('mAuto', 0.60);
    settings.thresholds.modelConfidence = num('mConf', 0.60);
    settings.api.enabled = $('apiEnabled').checked;
    settings.api.endpoint = $('endpoint').value.trim();
    settings.api.model = $('model').value.trim();
    settings.api.protocol = $('protocol').value;
    settings.api.timeoutMs = num('timeoutMs', 12000);
    settings.api.batchSize = num('batchSize', 2);
    settings.api.maxRequestsPerMinute = num('maxRequestsPerMinute', 12);
    settings.api.maxConcurrent = num('maxConcurrent', 2);
    settings.api.maxRequestsPerSession = num('maxRequestsPerSession', 60);
    settings.api.cacheTtlMs = num('cacheTtlMs', 1800000);
  }

  function withTimeout(promise, ms, fallback) {
    return Promise.race([promise, new Promise(r => setTimeout(() => r(fallback), ms))]);
  }

  function originPattern(endpoint) {
    try { return new URL(endpoint).origin + '/*'; } catch (_) { return ''; }
  }

  async function hasOrigin(endpoint) {
    const origin = originPattern(endpoint);
    if (!origin || !chrome.permissions) return true;
    return !!await withTimeout(
      new Promise(r => chrome.permissions.contains({ origins: [origin] }, r)), 2500, false);
  }

  // 权限申请只在用户显式点击时发起，避免保存设置时弹出原生对话框
  // （自动化/无头环境下该对话框不会返回，会挂住页面）。
  $('grantPerm').addEventListener('click', async () => {
    const origin = originPattern($('endpoint').value.trim());
    if (!origin) { flash('接口地址不合法', true); return; }
    const ok = await withTimeout(
      new Promise(r => chrome.permissions.request({ origins: [origin] }, r)), 8000, false);
    flash(ok ? '接口域名权限已授予' : '未取得权限，可在扩展详情页手动开启该站点权限', !ok);
    await renderStatus();
  });

  $('saveAll').addEventListener('click', async () => {
    readForm();
    const ok = await hasOrigin(settings.api.endpoint);
    await setLocal({ settings });
    flash(ok ? '设置已保存' : '设置已保存；接口域名权限未授予，请点「申请权限」', !ok);
    await renderStatus();
  });

  // ---------- API Key ----------
  async function refreshKeyStatus() {
    const r = await send({ type: 'BAF_HAS_KEY' });
    $('keyStatus').textContent = r.has
      ? '已设置 API Key（仅本次浏览器会话有效；源码、日志、导出文件均不含密钥）'
      : '未设置 API Key。纯规则模式可独立使用；如需模型复核请填入 Key 并保存。';
  }
  $('saveKey').addEventListener('click', async () => {
    const v = $('apiKey').value.trim();
    if (!v) { flash('未输入内容，密钥未修改', true); return; }
    await send({ type: 'BAF_SET_KEY', key: v });
    $('apiKey').value = '';
    await refreshKeyStatus();
    flash('API Key 已保存到会话级存储');
  });
  $('clearKey').addEventListener('click', async () => {
    await send({ type: 'BAF_CLEAR_KEY' });
    $('apiKey').value = '';
    await refreshKeyStatus();
    flash('已清除 API Key');
  });
  $('testConn').addEventListener('click', async () => {
    readForm();
    await setLocal({ settings });
    $('keyStatus').textContent = '正在调用结构化决策接口…';
    const r = await send({ type: 'BAF_TEST_CONNECTION' });
    if (r.ok) {
      $('keyStatus').textContent = `连接成功 · ${r.model || ''} · ${r.ms}ms · usage=${JSON.stringify(r.usage || {})} · 示例 source=${r.sample ? r.sample.source : '—'}`;
      flash('接口可用');
    } else {
      $('keyStatus').textContent = '连接失败：' + (r.error || '未知错误') + '（纯规则模式仍可独立使用）';
      flash('接口不可用', true);
    }
    await renderStatus();
  });

  // ---------- UID 名单 ----------
  function renderLists() {
    for (const [kind, box, count, input] of [
      ['whitelist', 'wlList', 'wlCount', 'wlInput'],
      ['blocklist', 'blList', 'blCount', 'blInput']
    ]) {
      $(count).textContent = `(${lists[kind].length})`;
      $(box).innerHTML = lists[kind].map(uid =>
        `<span class="chip">${esc(uid)}<button data-kind="${kind}" data-uid="${esc(uid)}">×</button></span>`).join('') || '<span class="hint">空</span>';
      $(input).value = $(input).value || '';
    }
  }
  async function persistLists() {
    await setLocal({ lists });
    renderLists();
  }
  document.querySelectorAll('[data-add]').forEach(btn => btn.addEventListener('click', async () => {
    const kind = btn.dataset.add;
    const input = $(kind === 'whitelist' ? 'wlInput' : 'blInput');
    const uid = input.value.trim();
    if (!uid) return;
    lists = N.addUid(lists, kind, uid);
    input.value = '';
    await persistLists();
    flash('名单已更新');
  }));
  for (const id of ['wlList', 'blList']) {
    $(id).addEventListener('click', async ev => {
      const b = ev.target.closest && ev.target.closest('button[data-uid]');
      if (!b) return;
      lists = N.removeUid(lists, b.dataset.kind, b.dataset.uid);
      await persistLists();
    });
  }
  $('exportLists').addEventListener('click', () => {
    $('listIO').value = JSON.stringify(lists, null, 2);
    flash('名单已导出到文本框');
  });
  $('importLists').addEventListener('click', async () => {
    try {
      const j = JSON.parse($('listIO').value);
      lists = N.normalizeLists({
        whitelist: (j.whitelist || []).concat(lists.whitelist),
        blocklist: (j.blocklist || []).concat(lists.blocklist)
      });
      // 白名单优先：同一 UID 只保留白名单
      lists.blocklist = lists.blocklist.filter(u => !lists.whitelist.includes(u));
      await persistLists();
      flash('名单已导入');
    } catch (_) { flash('导入失败：不是合法的名单 JSON', true); }
  });

  // ---------- 判定依据 ----------
  async function renderEvidence() {
    const d = await getLocal(['lastDecisions']);
    const rows = d.lastDecisions || [];
    $('evidenceBox').innerHTML = rows.map((x, i) => `
      <div class="ev-row" data-i="${i}">
        <div class="ev-head">
          <span class="ev-tag ${esc(x.decision)}">${x.decision === 'hide' ? '隐藏' : x.decision === 'mark' ? '标记' : '保留'}</span>
          <b>${esc(x.uname || '未知用户')}</b>
          <span>UID ${esc(x.uid)}</span><span>得分 ${esc(x.score)}</span>
          <span>${x.source === 'model' ? '规则+模型' : '纯规则'}</span>
          <button data-expand="${i}">展开依据</button>
        </div>
        <div class="ev-text">${esc(N.truncate(x.text, 120))}</div>
        <div class="ev-detail">
          <div>强证据类目：${esc((x.strongCategories || []).join('、') || '无')}；判定来源：${esc(x.source || 'rules')}；模型结论：${x.model ? esc(x.model.source + ' / ' + x.model.action) : '未复核'}</div>
          <ul>${(x.reasons || []).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
        </div>
      </div>`).join('') || '<div class="hint">尚无记录。打开一个 B 站视频页后回到这里刷新。</div>';
    $('evidenceBox').querySelectorAll('[data-expand]').forEach(b => b.addEventListener('click', () => {
      b.closest('.ev-row').classList.toggle('open');
    }));
  }
  $('refreshEvidence').addEventListener('click', renderEvidence);
  $('clearOverrides').addEventListener('click', async () => {
    await setLocal({ overrides: {} });
    try { chrome.storage.session.remove('overrides'); } catch (_) {}
    flash('已清除人工处置，页面会自动重算');
  });

  // ---------- 状态 ----------
  async function renderStatus() {
    const [meta, d] = await Promise.all([send({ type: 'BAF_STATUS' }), getLocal(['apiStatus', 'lastDecisions'])]);
    const m = meta.meta || {};
    const st = d.apiStatus;
    $('statusBox').innerHTML = [
      ['模型复核', settings.mode === 'model' ? (settings.api.enabled ? '已启用' : '未启用') : '纯规则模式'],
      ['API Key', m.hasKey ? '已设置（会话级）' : '未设置'],
      ['本会话调用', m.requests != null ? m.requests : '—'],
      ['去重缓存命中', m.cacheHits != null ? m.cacheHits : '—'],
      ['最近耗时', m.lastMs != null ? m.lastMs + ' ms' : '—'],
      ['最近错误', m.lastError ? esc(m.lastError) : '无'],
      ['页面接口状态', st ? (st.ok ? '可用' : '不可用：' + esc(st.message || '')) : '未调用'],
      ['最近扫描记录', (d.lastDecisions || []).length + ' 条']
    ].map(([k, v]) => `<div>${k}<br><span>${v}</span></div>`).join('');
  }

  async function init() {
    const d = await getLocal(['settings', 'lists']);
    settings = N.normalizeSettings(d.settings);
    lists = N.normalizeLists(d.lists);
    fillForm();
    renderLists();
    await Promise.all([refreshKeyStatus(), renderEvidence(), renderStatus()]);
  }
  init();
})();
