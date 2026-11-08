/* ISOLATED world：把只读网络钩子注入 MAIN world。 */
(function () {
  'use strict';
  try {
    var s = document.createElement('script');
    s.src = chrome.runtime.getURL('src/content/page-hook.js');
    s.dataset.bafHook = '1';
    s.onload = function () { s.remove(); };
    s.onerror = function () { s.remove(); };
    (document.head || document.documentElement || document.body).appendChild(s);
  } catch (_) {}
})();
