/* 通用工具：文本归一化、相似度、稳定哈希、时间统计。无外部依赖。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.BiliAICF = root.BiliAICF || {};
    Object.assign(root.BiliAICF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function hash32(str) {
    let h = 2166136261 >>> 0;
    const s = String(str == null ? '' : str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function normalizeText(text) {
    return String(text == null ? '' : text)
      .toLowerCase()
      .replace(/@[^\s，,。:：]+/g, ' ')
      .replace(/https?:\/\/\S+/g, ' ')
      .replace(/\[[^\]]{1,12}\]/g, ' ')
      .replace(/[\s\p{P}\p{S}\p{Emoji_Presentation}]/gu, '')
      .replace(/\s+/g, '');
  }

  function shingles(text, n) {
    const s = normalizeText(text);
    const size = n || 3;
    if (s.length <= size) return new Set(s ? [s] : []);
    const out = new Set();
    for (let i = 0; i + size <= s.length; i++) out.add(s.slice(i, i + size));
    return out;
  }

  function jaccard(a, b) {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    const small = a.size <= b.size ? a : b;
    const large = small === a ? b : a;
    for (const x of small) if (large.has(x)) inter++;
    return inter / (a.size + b.size - inter);
  }

  function textSimilarity(a, b) {
    const na = normalizeText(a);
    const nb = normalizeText(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    // 长度差异过大时直接判低，避免短句误配
    const lr = Math.min(na.length, nb.length) / Math.max(na.length, nb.length);
    if (lr < 0.6) return 0;
    return jaccard(shingles(na, 3), shingles(nb, 3)) * (0.6 + 0.4 * lr);
  }

  function countHits(text, words) {
    const lower = String(text || '').toLowerCase();
    let n = 0;
    const hitWords = [];
    for (const w of words) {
      const k = String(w).toLowerCase();
      if (!k) continue;
      let from = 0;
      let found = false;
      while ((from = lower.indexOf(k, from)) !== -1) { n++; found = true; from += k.length; }
      if (found) hitWords.push(w);
    }
    return { count: n, words: hitWords };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function round(v, p) { const f = Math.pow(10, p || 2); return Math.round(v * f) / f; }

  // 人设语义族：只抽核心词做聚类，忽略「の / exe / _不吃香菜版 / 乎乎 / 一只 / 才不是」等前后缀变体
  const PERSONA_CORE_RE = /(大肥鱼|肥鱼|小飞鲸|飞鲸|鲸娘|鲸鱼娘|鲸鱼|蓝鱼|白饭|白米饭|大米饭|小鱼干|鱼干|溟月|deepseek娘|deepsleep|deepseek)/i;
  const PERSONA_LOOSE_RE = /(鱼|鲸|龙|海|珊瑚|蓝|白)/i;

  function nameTemplate(name) {
    const s = String(name || '').trim();
    if (!s) return '';
    const m = s.match(PERSONA_CORE_RE);
    if (m) return 'persona:' + m[1].toLowerCase();
    if (/^(user|用户|账号|帐号|小号|test|bot|ai|agent)[_\-\s]*\d+$/i.test(s)) return 'batch:prefix-number';
    if (/^[a-z]{2,}[_\-]?\d{4,}$/i.test(s)) return 'batch:latin-number';
    if (/^\d{6,}$/.test(s)) return 'batch:pure-number';
    return '';
  }

  function personaNameFamily(name) {
    const s = String(name || '');
    if (!s) return '';
    if (PERSONA_CORE_RE.test(s)) return 'core';
    if (PERSONA_LOOSE_RE.test(s)) return 'loose';
    return '';
  }

  // 头像标识：只取公开 URL 中的稳定文件名做本地哈希，不保存/上报 URL 本身
  function avatarKey(face) {
    const s = String(face || '').trim();
    if (!s) return '';
    // 占位图 / 懒加载统一图不能用于聚类，否则整页账号会被误判成「共用头像」
    if (/noface|no_face|placeholder|loading|blank|default_?face|common\/face|base64/i.test(s)) return '';
    let m = s.match(/\/bfs\/face\/([A-Za-z0-9]+)/);
    if (!m) m = s.match(/\/([A-Za-z0-9_-]{16,})\.(?:jpg|jpeg|png|webp|gif)/i);
    const key = m ? m[1] : s.split('@')[0].split('?')[0];
    return hash32(key);
  }

  // 抽取「特征词」用于跨账号同题共振统计：英文专名 / 版本号 / 百分比 / 中文 2-gram
  function contentTerms(text, stopBigrams) {
    const s = String(text || '').toLowerCase();
    const out = new Set();
    for (const m of s.matchAll(/[a-z][a-z0-9._-]{2,}|\d+(?:\.\d+)?%?/g)) {
      const t = m[0];
      if (t.length >= 2 && !/^\d{1,2}$/.test(t)) out.add(t);
    }
    const stop = new Set(stopBigrams || []);
    const zh = s.replace(/[^\u4e00-\u9fa5]/g, ' ');
    for (const seg of zh.split(/\s+/)) {
      if (seg.length < 2) continue;
      for (let i = 0; i + 2 <= seg.length; i++) {
        const t = seg.slice(i, i + 2);
        if (!stop.has(t)) out.add(t);
      }
    }
    return out;
  }

  // 从账户的评论时间序列统计短时爆发 / 间隔规律性
  function timingStats(comments) {
    const ts = comments.map(c => Number(c.ctime) || 0).filter(Boolean).sort((a, b) => a - b);
    const out = { count: ts.length, maxBurst: ts.length, gapCV: null, medianGap: null, spanSec: 0 };
    if (ts.length < 2) return out;
    out.spanSec = ts[ts.length - 1] - ts[0];
    let maxBurst = 1;
    for (let i = 0; i < ts.length; i++) {
      let n = 1;
      for (let j = i + 1; j < ts.length && ts[j] - ts[i] <= 300; j++) n++;
      if (n > maxBurst) maxBurst = n;
    }
    out.maxBurst = maxBurst;
    const gaps = [];
    for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    gaps.sort((a, b) => a - b);
    out.medianGap = gaps[Math.floor(gaps.length / 2)];
    const mean = gaps.reduce((s, x) => s + x, 0) / gaps.length;
    if (mean > 0 && gaps.length >= 2) {
      const varr = gaps.reduce((s, x) => s + (x - mean) ** 2, 0) / gaps.length;
      out.gapCV = Math.sqrt(varr) / mean;
    }
    return out;
  }

  function truncate(s, n) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length <= (n || 160) ? t : t.slice(0, n || 160) + '…';
  }

  function uniq(arr) { return Array.from(new Set(arr)); }

  // 红act：确保密钥不进入任何日志/返回值
  function redact(text, secret) {
    if (!secret) return String(text == null ? '' : text);
    return String(text == null ? '' : text).split(String(secret)).join('[REDACTED]');
  }

  return {
    hash32, normalizeText, shingles, jaccard, textSimilarity, countHits,
    clamp, round, nameTemplate, personaNameFamily, avatarKey, contentTerms,
    timingStats, truncate, uniq, redact
  };
});
