/* 本地规则引擎 v3 —— 由 426 个真实人工标注推导（samples/real/labels.json）。
 *
 * 推导结论（见 samples/real/标注分析与规则推导.md）：
 *  - 等级是最强分界：Lv4-6 的 349 个账号里 325 个是真人；Lv2-3 的 77 个里 46 个要隐藏。
 *  - v2 把「对主人说话」当必要条件是错的：a 类只有 5% 命中，v2 召回仅 10.4%。
 *  - a 类 71% 含鱼系昵称、67% 复述视频；h 类 76% 是短评。
 *  - 因此隐藏条件是「低等级 + 身份信号」，打窝复读/广告/短评真人/高等级人机共用单独分流。
 *
 * 处置：
 *   hide  广告链接（用户确认也要隐藏）；或 Lv≤3 且有人设昵称/签名自述/人设口癖/对主人说话
 *   mark  Lv≥4 且签名自述（人机共用）；或 Lv≤3 只有模糊签名自述、无其它身份信号
 *   keep  钓鱼打窝复读；Lv≥4 无自述；短评+真人口语；无任何身份信号
 * 群体统计只作展示与模型上下文，不参与定罪。
 */
(function (root, factory) {
  const isNode = typeof module === 'object' && module.exports;
  const C = isNode ? require('./constants.js') : root.BiliAICF;
  const U = isNode ? require('./utils.js') : root.BiliAICF;
  const api = factory(C, U);
  if (isNode) module.exports = api;
  if (root) {
    root.BiliAICF = root.BiliAICF || {};
    Object.assign(root.BiliAICF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (C, U) {
  'use strict';

  const LEX = C.LEXICONS;
  const LABELS = C.SIGNAL_LABELS;
  const FN = U;

  function sig(list, code, direction, weight, detail) {
    list.push({ code, label: LABELS[code] || code, direction, weight: FN.round(weight, 3), detail: detail || '' });
  }

  function configOf(settings) {
    return Object.assign({}, C.DEFAULT_SETTINGS.policy, (settings && (settings.policy || settings.cohort)) || {});
  }

  function groupByUid(comments) {
    const map = new Map();
    for (const c of comments) {
      const uid = String(c.uid == null ? 'anon:' + c.key : c.uid);
      if (!map.has(uid)) {
        map.set(uid, {
          uid, uname: c.uname || '', level: Number(c.level) || 0, comments: [],
          avatarKey: c.avatarKey || FN.avatarKey(c.face) || '', sign: c.sign || ''
        });
      }
      const g = map.get(uid);
      g.comments.push(c);
      if (!g.uname && c.uname) g.uname = c.uname;
      if (!g.level && c.level) g.level = Number(c.level) || 0;
      if (!g.avatarKey) g.avatarKey = c.avatarKey || FN.avatarKey(c.face) || '';
      if (!g.sign && c.sign) g.sign = c.sign;
    }
    return map;
  }

  // 页面级统计：只用于判定依据展示与模型上下文，不参与定罪
  function buildPageContext(comments, groups, settings) {
    const cfg = configOf(settings);
    const personaNames = new Map();
    const signAIUids = new Set();
    const templates = new Map();
    for (const g of groups.values()) {
      const family = FN.personaNameFamily(g.uname);
      if (family) personaNames.set(g.uid, family);
      if (FN.countHits(g.sign, LEX.signAI).count > 0) signAIUids.add(g.uid);
      const tpl = FN.nameTemplate(g.uname);
      if (tpl) { if (!templates.has(tpl)) templates.set(tpl, new Set()); templates.get(tpl).add(g.uid); }
    }

    const avatarGroups = new Map();
    for (const g of groups.values()) {
      if (!g.avatarKey) continue;
      if (!avatarGroups.has(g.avatarKey)) avatarGroups.set(g.avatarKey, new Set());
      avatarGroups.get(g.avatarKey).add(g.uid);
    }
    const avatarClusterSize = new Map();
    let largestAvatarCluster = 0;
    for (const [, uids] of avatarGroups) {
      if (uids.size > largestAvatarCluster) largestAvatarCluster = uids.size;
      if (uids.size >= cfg.minAvatarCluster) for (const uid of uids) avatarClusterSize.set(uid, uids.size);
    }

    const termDocs = new Map();
    const perUidTerms = new Map();
    for (const c of comments) {
      if (C.FISHING_REPEAT_RE.test(String(c.text || ''))) continue;
      const uid = String(c.uid);
      if (!perUidTerms.has(uid)) perUidTerms.set(uid, new Set());
      for (const t of FN.contentTerms(c.text, LEX.stopBigrams)) {
        if (!termDocs.has(t)) termDocs.set(t, new Set());
        termDocs.get(t).add(uid);
        perUidTerms.get(uid).add(t);
      }
    }
    const minDocs = cfg.minSharedTermDocs;
    const maxDocs = Math.max(minDocs, Math.floor(groups.size * 0.8));
    const sharedTerms = [...termDocs.entries()]
      .filter(([, uids]) => uids.size >= minDocs && uids.size <= maxDocs)
      .map(([t, uids]) => ({ term: t, docs: uids.size }));
    const sharedSet = new Set(sharedTerms.map(x => x.term));
    const accountSharedHits = new Map();
    for (const [uid, terms] of perUidTerms) {
      let n = 0;
      for (const t of terms) if (sharedSet.has(t)) n++;
      accountSharedHits.set(uid, n);
    }

    const cohortSet = new Set([...personaNames.keys(), ...signAIUids]);
    const unameToUid = new Map();
    for (const g of groups.values()) if (g.uname) unameToUid.set(g.uname.toLowerCase(), g.uid);
    const replyNetwork = new Map();
    for (const c of comments) {
      const m = String(c.text || '').match(/@([^\s，,。:：、]{2,24})/g) || [];
      const src = String(c.uid);
      const linked = [];
      for (const raw of m) {
        const t = unameToUid.get(raw.slice(1).toLowerCase());
        if (t && t !== src && cohortSet.has(t)) linked.push(t);
      }
      if (linked.length) replyNetwork.set(src, linked);
    }

    const prepared = comments
      .filter(c => !C.FISHING_REPEAT_RE.test(String(c.text || '')))
      .filter(c => FN.normalizeText(c.text).length >= 12)
      .map(c => ({ c, uid: String(c.uid), norm: FN.normalizeText(c.text) }));
    const dupAcross = new Set();
    for (let i = 0; i < prepared.length; i++) for (let j = i + 1; j < prepared.length; j++) {
      const a = prepared[i], b = prepared[j];
      if (a.uid === b.uid) continue;
      const lr = Math.min(a.norm.length, b.norm.length) / Math.max(a.norm.length, b.norm.length);
      if (lr >= 0.7 && FN.textSimilarity(a.c.text, b.c.text) >= 0.78) { dupAcross.add(a.uid); dupAcross.add(b.uid); }
    }

    const lowTimes = [...groups.values()]
      .filter(g => g.level > 0 && g.level <= cfg.maxAutoLevel)
      .map(g => Math.min(...g.comments.map(c => Number(c.ctime) || 0).filter(Boolean)))
      .filter(Boolean).sort((a, b) => a - b);
    let cohortMax = 0;
    for (let i = 0; i < lowTimes.length; i++) {
      let n = 1;
      for (let j = i + 1; j < lowTimes.length && lowTimes[j] - lowTimes[i] <= cfg.cohortWindowSec; j++) n++;
      if (n > cohortMax) cohortMax = n;
    }

    const pageCohort = {
      distinct_accounts_on_page: groups.size,
      accounts_with_ai_self_sign: signAIUids.size,
      accounts_with_persona_nickname: personaNames.size,
      largest_avatar_cluster: largestAvatarCluster,
      shared_topic_terms: sharedTerms.length,
      low_level_accounts_in_same_window: cohortMax,
      sample_shared_terms: sharedTerms.slice(0, 8).map(x => x.term)
    };
    return {
      cfg, personaNames, signAIUids, templates, avatarClusterSize,
      sharedTerms, accountSharedHits, replyNetwork, dupAcross, cohortMax, pageCohort
    };
  }

  function evaluateAccount(group, ctx, opts) {
    const cfg = ctx.cfg;
    const L = LEX;
    const signals = [];
    const cs = group.comments;
    const allText = cs.map(c => String(c.text || '')).join('\n');
    const sign = String(group.sign || '');

    const low = group.level > 0 && group.level <= cfg.maxAutoLevel;
    const high = group.level >= cfg.highLevelFrom;
    const nameCore = C.PERSONA_CORE_RE.test(group.uname || '');
    const nameLoose = !nameCore && C.PERSONA_LOOSE_RE.test(group.uname || '');
    const signAI = FN.countHits(sign, L.signAI);
    const signStrong = C.SIGN_STRONG_RE.test(sign);
    const persona = FN.countHits(allText, L.persona);
    const speech = FN.countHits(allText, L.agentSpeech);
    const fishingWords = FN.countHits(allText, L.fishing);
    const laugh = FN.countHits(allText, L.laugh);
    const claim = FN.countHits(allText, L.humanClaim);
    const community = FN.countHits(allText, L.community);
    const cliche = FN.countHits(allText, L.aiCliche || []);
    const fishingHit = C.FISHING_REPEAT_RE.test(allText) || fishingWords.count >= 2 ||
      (fishingWords.count >= 1 && laugh.count >= 1);
    const ad = C.AD_RE.test(allText);
    const human = FN.countHits(allText, L.humanCue);
    const maxLen = Math.max(0, ...cs.map(c => String(c.text || '').length));
    const short = maxLen <= 28;
    // 真人硬保护：打窝复读、笑声、真人自证、社区打卡短句、短评+具体口语。
    // 但「顶着核心人设昵称（大肥鱼/肥鱼/鲸娘/白饭…）复读打窝」是 AI 账号在装真人，
    // 不享受打窝保护——这条是用户标注里明确把「观察人类的大肥鱼」标成拉黑后补的。
    const fishingHard = !nameCore &&
      (fishingHit || laugh.count >= 2 || (fishingWords.count >= 1 && laugh.count >= 1));
    const hardHuman = fishingHard || claim.count > 0 ||
      (community.count > 0 && maxLen <= 60) || (short && human.count >= 1);

    if (nameCore) sig(signals, 'name_core', 'bot', 0.3, `昵称：${group.uname}`);
    if (nameLoose) sig(signals, 'name_core', 'bot', 0.15, `昵称含弱人设词：${group.uname}`);
    if (signAI.count) sig(signals, 'sign_ai', 'bot', 0.3, `个性签名：${FN.truncate(sign, 46)}`);
    if (persona.count) sig(signals, 'persona_density', 'bot', 0.2, persona.words.slice(0, 4).join('、'));
    if (speech.count) sig(signals, 'agent_speech', 'bot', 0.2, speech.words.slice(0, 3).join('、'));
    if (cliche.count) sig(signals, 'ai_cliche', 'bot', 0,
      `命中 ${cliche.words.slice(0, 4).join('、')}（弱线索，不单独构成证据）`);
    if (low) sig(signals, 'low_level', 'bot', 0.2, `等级 Lv${group.level}`);
    if (high) sig(signals, 'high_level_human', 'human', 0.3, `等级 Lv${group.level}`);
    if (fishingHit) sig(signals, 'fishing_repeat', 'human', 1, '钓鱼打窝复读文本');
    if (ad) sig(signals, 'ad_link', 'bot', 1, '含外链推广');
    if (human.count) sig(signals, 'personal_appeal', 'human', 0.2, human.words.slice(0, 3).join('、'));

    // 佐证（只展示，不参与定罪）
    const avatarSize = ctx.avatarClusterSize.get(group.uid) || 0;
    const sharedHits = ctx.accountSharedHits.get(group.uid) || 0;
    const linked = ctx.replyNetwork.get(group.uid) || [];
    if (avatarSize >= cfg.minAvatarCluster) sig(signals, 'avatar_cluster', 'bot', 0, `本页 ${avatarSize} 个账号共用头像（佐证）`);
    if (linked.length) sig(signals, 'reply_loop', 'bot', 0, `与 ${linked.length} 个同批账号互 @（佐证）`);
    if (sharedHits >= cfg.minSharedTermHits) sig(signals, 'topic_resonance', 'bot', 0, '共享主题词（主题词不作为证据）');
    if (ctx.dupAcross.has(group.uid)) sig(signals, 'duplicate_across_accounts', 'bot', 0, '跨账号模板雷同（佐证）');
    const timing = FN.timingStats(cs.concat((opts.sessionComments || []).filter(x => String(x.uid) === group.uid)));

    // ---- v3 闸门式决策（由真实标注推导）----
    let decision = 'keep';
    let why;
    if (ad) {
      decision = 'hide';
      why = '含外链推广；用户 2026-11-08 确认广告号也要隐藏（与 AI 自动发评分开统计）';
    } else if (hardHuman) {
      decision = 'keep';
      why = fishingHit ? '钓鱼打窝复读文本，明确判真人，永不隐藏'
        : '命中真人硬保护（笑声 / 真人自证 / 社区打卡短句 / 短评带具体口语），保留';
    } else if (high) {
      // 高等级但顶着核心人设昵称（大肥鱼/肥鱼/鲸娘/白饭…）的，是挂了 AI 人设的老号，
      // 按人机共用只标记不隐藏；用户在面板上可以直接「拉黑」。
      const personaHigh = signAI.count > 0 || nameCore;
      decision = personaHigh ? 'mark' : 'keep';
      why = signAI.count > 0
        ? 'Lv4+ 老号但签名自述 AI/接管，属人机共用，按「证据不足」只标记不隐藏'
        : nameCore
          ? 'Lv4+ 但昵称是核心人设词，属人机共用，只标记不隐藏（可手动拉黑）'
          : 'Lv4+ 老号且无人设昵称/自述；真实标注中该组 325/349 为真人，保留';
    } else if (short && human.count >= 1) {
      decision = 'keep';
      why = '低等级但是短评且带真人口语/具体诉求，保留';
    } else if (signAI.count > 0 && !nameCore && speech.count === 0 && persona.count === 0) {
      decision = 'mark';
      why = '只有模糊的签名自述、无其它身份信号，按人机共用只标记不隐藏';
    } else if (nameCore || nameLoose || signAI.count > 0 || persona.count >= 1 || speech.count > 0) {
      decision = 'hide';
      why = `Lv${group.level} 低等级且命中身份信号（${[
        nameCore ? '核心人设昵称' : nameLoose ? '弱人设昵称' : '',
        signAI.count ? '签名自述' : '', persona.count ? '人设口癖' : '', speech.count ? '对主人说话/自动浏览' : ''
      ].filter(Boolean).join('、')}）`;
    } else if (cliche.count >= 2 && low) {
      // 「还扎心 / 太真实了 / 一针见血」这类情绪化套话是 AI 评论的常见腔调，
      // 但真人也会用。只有同一账号连中 ≥2 个且是低等级、又没有任何真人反证时，
      // 才给一个可见的「标记」；绝不隐藏，避免重演整页误标。
      decision = 'mark';
      why = `无身份信号，但连中 ${cliche.count} 个 AI 常见套话（${cliche.words.slice(0, 3).join('、')}），仅标记供人工核对`;
    } else {
      why = '无身份信号，按真人放行';
      signals.push({ code: 'no_identity_signal', label: LABELS.no_identity_signal, direction: 'human', weight: 0, detail: why });
    }

    const strongCategories = [];
    if (nameCore || nameLoose || signAI.count || persona.count) strongCategories.push('identity');
    if (low) strongCategories.push('low_level');
    if (speech.count) strongCategories.push('agent_speech');
    if (ad) strongCategories.push('ad');

    let score = 0;
    if (decision !== 'keep') {
      score = (nameCore ? 0.35 : nameLoose ? 0.2 : 0) +
        (signStrong ? 0.3 : signAI.count ? 0.15 : 0) +
        Math.min(0.2, persona.count * 0.05) + (speech.count ? 0.15 : 0) +
        (low ? 0.15 : 0) - (high ? 0.25 : 0) + (ad ? 0.3 : 0);
    }
    score = FN.clamp(FN.round(score, 3), 0, 1);

    return {
      uid: group.uid, uname: group.uname, level: group.level,
      decision, score, strongCategories, hardHuman: fishingHit || (high && !signAI.count), why,
      signals, timing, crossVideoCount: 1, commentCount: cs.length,
      pageCohort: ctx.pageCohort,
      cohort: {
        avatarClusterSize: avatarSize, personaFamily: ctx.personaNames.get(group.uid) || '',
        sharedTopicHits: sharedHits, replyLinks: linked.length, cohortMax: ctx.cohortMax,
        signAICount: signAI.count, agentSpeechCount: speech.count
      },
      reasons: [why].concat(signals.map(s => `${s.direction === 'human' ? '真人迹象' : '可疑迹象'}｜${s.label}${s.detail ? '：' + s.detail : ''}`))
    };
  }

  function evaluatePage(input) {
    const comments = input.comments || [];
    const settings = input.settings || {};
    const groups = groupByUid(comments);
    const ctx = buildPageContext(comments, groups, settings);
    const whitelist = new Set((input.lists && input.lists.whitelist || []).map(String));
    const blocklist = new Set((input.lists && input.lists.blocklist || []).map(String));
    const overrides = input.overrides || {};
    const results = [];
    const accountResults = {};

    for (const g of groups.values()) {
      let r = evaluateAccount(g, ctx, { settings, sessionComments: input.sessionComments || [] });
      if (whitelist.has(g.uid)) {
        r = Object.assign({}, r, {
          decision: 'keep', why: 'UID 在白名单中，跳过规则',
          reasons: ['白名单｜该 UID 由用户加入白名单，永不隐藏'].concat(r.reasons),
          overridden: 'whitelist'
        });
      } else if (blocklist.has(g.uid)) {
        r = Object.assign({}, r, {
          decision: 'hide', why: 'UID 在屏蔽名单中',
          reasons: ['屏蔽名单｜该 UID 由用户手动加入屏蔽名单'].concat(r.reasons),
          overridden: 'blocklist'
        });
      }
      accountResults[g.uid] = r;
      for (const c of g.comments) {
        let decision = r.decision;
        let reasons = r.reasons.slice();
        let overridden = r.overridden;
        const ov = overrides[c.key];
        if (ov === 'keep' || ov === 'hide' || ov === 'mark') {
          decision = ov;
          overridden = ov === 'keep' ? 'user_restored' : 'user_hidden';
          reasons = [`人工处置｜用户${ov === 'keep' ? '恢复了这条评论' : '手动隐藏了这条评论'}`].concat(reasons);
        }
        results.push(Object.assign({}, r, {
          key: c.key, rpid: c.rpid, oid: c.oid, uid: g.uid,
          text: String(c.text || ''), ctime: c.ctime, isSub: !!c.isSub,
          label: c.label || undefined, note: c.note || undefined,
          decision, reasons, overridden,
          needsReview: !overridden && (settings.reviewDecisions || ['mark', 'hide']).includes(decision),
          source: 'rules'
        }));
      }
    }
    return { decisions: results, accounts: accountResults, pageContext: ctx };
  }

  return { groupByUid, buildPageContext, evaluateAccount, evaluatePage };
});
