(function () {
  'use strict';
  const N = window.BiliAICF;
  const Store = N;
  const $ = id => document.getElementById(id);
  let settings = null;

  function msg(text, bad) {
    const el = $('msg');
    el.textContent = text || '';
    el.className = 'msg' + (bad ? ' bad' : '');
  }

  function getLocal(keys) {
    return new Promise(resolve => chrome.storage.local.get(keys, resolve));
  }
  function setLocal(obj) {
    return new Promise(resolve => chrome.storage.local.set(obj, resolve));
  }
  function send(message) {
    return new Promise(resolve => {
      try { chrome.runtime.sendMessage(message, r => resolve(r || {})); }
      catch (_) { resolve({}); }
    });
  }
  function sendToActiveTab(message) {
    return new Promise(resolve => {
      try {
        chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
          const t = tabs && tabs[0];
          if (!t || !/bilibili\.com/.test(t.url || '')) { resolve({ ok: false, error: '当前标签页不是 B 站视频页' }); return; }
          chrome.tabs.sendMessage(t.id, message, r => resolve(r || { ok: true }));
        });
      } catch (_) { resolve({ ok: false }); }
    });
  }

  async function refresh() {
    const [data] = await Promise.all([getLocal(['settings', 'lists', 'lastDecisions', 'apiStatus'])]);
    settings = N.normalizeSettings(data.settings);
    const lists = N.normalizeLists(data.lists);
    const dec = data.lastDecisions || [];
    const counts = { hide: 0, mark: 0, keep: 0 };
    for (const d of dec) if (counts[d.decision] != null) counts[d.decision]++;

    $('toggle').textContent = settings.enabled ? '已启用' : '已暂停';
    $('toggle').className = 'pill ' + (settings.enabled ? 'on' : 'off');
    $('mode').value = settings.mode;
    $('display').value = settings.display;
    $('stats').innerHTML = `隐藏 <b>${counts.hide}</b> · 标记 <b>${counts.mark}</b> · 保留 <b>${counts.keep}</b>`;
    $('wl').textContent = lists.whitelist.length;
    $('bl').textContent = lists.blocklist.length;

    const st = data.apiStatus;
    const api = $('api');
    if (settings.mode !== 'model') {
      api.textContent = '纯规则模式 · 未启用模型复核';
      api.className = 'api';
    } else if (!settings.api.enabled) {
      api.textContent = '模型复核开关未打开，请到设置页启用并填写 API Key';
      api.className = 'api bad';
    } else if (!st) {
      api.textContent = '模型复核已启用，等待首次调用';
      api.className = 'api';
    } else if (st.ok) {
      api.textContent = `模型复核可用 · 最近 ${st.meta && st.meta.ms != null ? st.meta.ms + 'ms' : '—'} · 累计调用 ${st.meta && st.meta.requests != null ? st.meta.requests : '—'} 次`;
      api.className = 'api';
    } else {
      api.textContent = `接口不可用：${st.message || '未知错误'}（已回退纯规则）`;
      api.className = 'api bad';
    }
  }

  $('toggle').addEventListener('click', async () => {
    settings.enabled = !settings.enabled;
    await setLocal({ settings });
    refresh();
  });
  $('mode').addEventListener('change', async () => {
    settings.mode = $('mode').value;
    if (settings.mode === 'model') settings.api.enabled = true;
    await setLocal({ settings });
    refresh();
    msg(settings.mode === 'model' ? '已启用模型复核，请确认设置页已填写 API Key' : '已切换为纯规则模式');
  });
  $('display').addEventListener('change', async () => {
    settings.display = $('display').value;
    await setLocal({ settings });
    msg('隐藏方式已更新');
  });
  $('test').addEventListener('click', async () => {
    msg('正在测试连接…');
    const r = await send({ type: 'BAF_TEST_CONNECTION' });
    if (r.ok) msg(`连接成功：${r.model || '模型已响应'}，耗时 ${r.ms}ms，返回 source=${r.sample ? r.sample.source : '—'}`);
    else msg('连接失败：' + (r.error || '未知错误'), true);
  });
  $('rescan').addEventListener('click', async () => {
    const r = await sendToActiveTab({ type: 'BAF_RESCAN' });
    msg(r.error ? r.error : '已重新扫描当前页面');
  });
  $('restore').addEventListener('click', async () => {
    const r = await sendToActiveTab({ type: 'BAF_RESTORE_ALL' });
    msg(r.error ? r.error : '已恢复当前页面的全部隐藏评论');
  });
  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  refresh();
})();
