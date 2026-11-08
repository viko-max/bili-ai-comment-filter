/* 存储结构与默认值。Chrome 扩展经典脚本 / CommonJS 通用。 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const C = isNode ? require('./constants.js') : root.BiliAICF;
  const api = factory(C);
  if (isNode) module.exports = api;
  if (root) {
    root.BiliAICF = root.BiliAICF || {};
    Object.assign(root.BiliAICF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C) {
  'use strict';

  const KEYS = {
    settings: 'settings',           // chrome.storage.local
    lists: 'lists',                 // chrome.storage.local
    apiKey: 'apiKey',               // chrome.storage.session（仅内存，浏览器重启即清）
    overrides: 'overrides',         // chrome.storage.session
    sessionComments: 'sessionComments', // chrome.storage.session
    lastDecisions: 'lastDecisions', // chrome.storage.session
    apiStatus: 'apiStatus',         // chrome.storage.session
    apiMeta: 'apiMeta'              // chrome.storage.session：调用次数/缓存命中
  };

  function deepMerge(base, patch) {
    const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    for (const k of Object.keys(patch || {})) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && !Array.isArray(base[k])) {
        out[k] = deepMerge(base[k], v);
      } else if (v !== undefined) out[k] = v;
    }
    return out;
  }

  function normalizeSettings(raw) {
    return deepMerge(C.DEFAULT_SETTINGS, raw || {});
  }

  function normalizeLists(raw) {
    const r = raw || {};
    return {
      whitelist: Array.from(new Set((r.whitelist || []).map(String))),
      blocklist: Array.from(new Set((r.blocklist || []).map(String)))
    };
  }

  function addUid(lists, kind, uid) {
    const l = normalizeLists(lists);
    const id = String(uid);
    if (!id) return l;
    l[kind] = Array.from(new Set(l[kind].concat(id)));
    const other = kind === 'whitelist' ? 'blocklist' : 'whitelist';
    l[other] = l[other].filter(x => x !== id);
    return l;
  }

  function removeUid(lists, kind, uid) {
    const l = normalizeLists(lists);
    l[kind] = l[kind].filter(x => x !== String(uid));
    return l;
  }

  function commentKey(c) {
    if (c.rpid != null && String(c.rpid) !== '') return 'r:' + String(c.rpid);
    return 'd:' + String(c.uid || '') + ':' + require_hash(String(c.text || '').slice(0, 80));
  }

  function require_hash(s) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  return { KEYS, deepMerge, normalizeSettings, normalizeLists, addUid, removeUid, commentKey };
});
