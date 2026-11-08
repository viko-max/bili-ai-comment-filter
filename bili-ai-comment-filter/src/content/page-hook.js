/* MAIN world：只读拦截 B 站评论接口的响应，供内容脚本提取结构化线索。
 * 不修改请求、不修改响应、不读取 cookie / 凭据，也不上报任何数据到外部。
 */
(function () {
  'use strict';
  if (window.__BAF_HOOK_INSTALLED__) return;
  window.__BAF_HOOK_INSTALLED__ = true;

  var MARK = '__BAF__';
  var MAX = 1500000;

  function post(type, payload) {
    try {
      window.postMessage({ __BAF__: true, type: type, payload: payload, href: location.href, ts: Date.now() }, '*');
    } catch (_) { /* 忽略不可克隆数据 */ }
  }

  function isCommentApi(url) {
    var u = String(url || '');
    if (!/\/x\/v2\/reply|\/reply\/v2\/|\/x\/v2\/dm\//.test(u)) return false;
    if (/\/reply\/(add|del|action|like|hate)\b/.test(u)) return false;
    return true;
  }

  function emit(url, data) {
    if (!data || typeof data !== 'object') return;
    try { post('api', { url: String(url).slice(0, 300), data: data }); } catch (_) {}
  }

  function handleText(url, text) {
    try {
      if (!text || text.length > MAX) return;
      var j = JSON.parse(text);
      if (j && (j.code === 0 || j.code === '0' || j.data)) emit(url, j.data || j.result || j);
    } catch (_) {}
  }

  // fetch
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      var promise = origFetch.apply(this, arguments);
      try {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        var method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
        if (method === 'GET' && isCommentApi(url) && promise && typeof promise.then === 'function') {
          promise.then(function (res) {
            try { if (res && typeof res.clone === 'function') res.clone().text().then(function (t) { handleText(url, t); }).catch(function () {}); } catch (_) {}
          }).catch(function () {});
        }
      } catch (_) {}
      return promise;
    };
  }

  // XMLHttpRequest
  try {
    var XO = XMLHttpRequest.prototype.open;
    var XS = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__bafMethod = String(method || 'GET'); this.__bafUrl = String(url || ''); } catch (_) {}
      return XO.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (String(this.__bafMethod || 'GET').toUpperCase() === 'GET' && isCommentApi(this.__bafUrl)) {
          var url = this.__bafUrl;
          this.addEventListener('loadend', function () {
            try { handleText(url, this.responseText); } catch (_) {}
          }, false);
        }
      } catch (_) {}
      return XS.apply(this, arguments);
    };
  } catch (_) {}

  // 视频切换（B 站是 SPA，pushState 不会触发 page load）
  ['pushState', 'replaceState'].forEach(function (name) {
    try {
      var orig = history[name];
      history[name] = function () {
        var r = orig.apply(this, arguments);
        try { post('navigation', { href: location.href }); } catch (_) {}
        return r;
      };
    } catch (_) {}
  });
  window.addEventListener('popstate', function () { post('navigation', { href: location.href }); });
  window.addEventListener('hashchange', function () { post('navigation', { href: location.href }); });

  post('ready', { href: location.href });
})();
