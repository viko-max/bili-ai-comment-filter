/* LingDT-Decision-1.0 结构化决策复核。
 *
 * 实测接口（2026-11-08，用用户提供的 Key 验证）：
 *   POST https://maas-api.antdigital.com/v1/systemone
 *   Authorization: Bearer <API Key>  /  Content-Type: application/json
 *   body: { model, state, questions }
 *   resp: { errorCode: 0, model, answers: { <qid>: {type, choice|noul, probabilities, confidence} }, usage }
 *   注意：errorCode 非 0 时 200 也算失败；state 会按问题数放大 token 估算，
 *         超限报 invalid_request:request_tokens_estimate_exceeded，需缩小批次/裁剪文本。
 *
 * 隐私边界：state 只含公开可见的昵称、评论文本片段、等级，以及本地统计出的行为特征；
 * 不含 UID、头像 URL、cookie、视频地址、浏览记录等。API Key 由 service worker 临时注入请求头。
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

  const TASK = '判断 B 站视频评论区中，哪些账号是由 AI 智能体自动批量发布评论。最强证据是个性签名自述 AI/DSH/主人/接管运营，以及文本对「主人」说话或自述跟着字幕看视频。高等级老号的人机共用场景边界模糊，只应标记不应隐藏。真人钓鱼打窝复读（token 来、💰人来）即使多个账号一字不差复读也应判真人。视频主题词（模型名、额度、冒充、Token 等）不能作为证据，真人也会讨论这些。证据不足时保留或标记，绝不隐藏。';

  function labelOf(code) { return (C.SIGNAL_LABELS && C.SIGNAL_LABELS[code]) || code; }

  function publicAccountState(a, index) {
    const botSignals = (a.signals || []).filter(s => s.direction === 'bot').map(s => labelOf(s.code));
    const humanSignals = (a.signals || []).filter(s => s.direction === 'human').map(s => labelOf(s.code));
    const texts = (a.commentTexts || []).slice(0, 3).map(t => U.truncate(t, 140));
    const strong = a.strongCategories || [];
    const pc = a.pageCohort || {};
    const co = a.cohort || {};
    return {
      id: `a${index + 1}`,
      nickname: U.truncate(a.uname || '（未取得昵称）', 30),
      level: Number(a.level) || 0,
      comment_count: Number(a.commentCount) || texts.length,
      comment_texts: texts,
      behavior: {
        五分钟内最多连发条数: Number(a.timing && a.timing.maxBurst) || null,
        本会话出现过的不重复视频数: Number(a.crossVideoCount) || 1,
        本地规则给出的可疑得分_0到1: U.round(Number(a.score) || 0, 3),
        命中的独立强证据类目: strong.join('、') || '无',
        // 只传布尔与计数，不传签名原文（个性签名属于个人信息）
        个性签名自述AI或主人: Number(co.signAICount) > 0,
        文本对主人说话或自动浏览复述次数: Number(co.agentSpeechCount) || 0
      },
      // 页面级群体统计：只传聚合数字，不传头像 URL、UID 或具体账号标识
      page_cohort: {
        页面内不同账号数: Number(pc.distinct_accounts_on_page) || 0,
        签名自述AI的账号数: Number(pc.accounts_with_ai_self_sign) || 0,
        共用同一头像的账号数: Number(pc.accounts_sharing_avatar) || 0,
        最大头像簇人数: Number(pc.largest_avatar_cluster) || 0,
        人设族昵称账号数: Number(pc.accounts_with_persona_nickname) || 0,
        跨账号共享主题词数: Number(pc.shared_topic_terms) || 0,
        同时间窗低等级人设账号数: Number(pc.low_level_persona_accounts_in_same_window) || 0,
        本账号所在头像簇人数: Number(co.avatarClusterSize) || 0,
        本账号命中共享主题词数: Number(co.sharedTopicHits) || 0,
        本账号与同批账号的回复链数: Number(co.replyLinks) || 0
      },
      local_evidence: botSignals,
      local_counter_evidence: humanSignals,
      local_preliminary_decision: a.decision || 'keep'
    };
  }

  function buildRequestBody(accounts, settings) {
    const apiCfg = (settings && settings.api) || {};
    const model = apiCfg.model || C.MODEL_ID;
    const state = {
      task: TASK,
      note: '以下仅为公开可见的昵称/评论文本片段与本地统计特征，不含 UID、头像、凭据或浏览记录。',
      accounts: accounts.map(publicAccountState)
    };
    const questions = {};
    accounts.forEach((_, i) => {
      const id = `a${i + 1}`;
      questions[`${id}_source`] = {
        type: 'choice',
        instructions: `账号 ${id} 最可能属于哪一类？注意：仅文风书面化不足以判为自动发评。`,
        criteria: Object.assign({}, C.SOURCE_CRITERIA)
      };
      questions[`${id}_auto`] = {
        type: 'noul',
        instructions: `账号 ${id} 是否由自动程序批量发评（而非真人手动发布）？`
      };
      questions[`${id}_evidence`] = {
        type: 'noul',
        instructions: `针对账号 ${id}，是否存在至少两条相互独立的群体性或行为性自动化证据（跨账号模板雷同、昵称模板聚类、短时连发、跨视频出现、自述自动发评、账号间互相@盖楼）？仅文风书面化、单个梗词、预设人设口癖或社区常见打卡短句都不算。`
      };
      questions[`${id}_action`] = {
        type: 'choice',
        instructions: `账号 ${id} 的处置方式：已判定为自动发评且行为证据充分时选 hide；判定为真人时选 keep；证据不足或结论冲突时选 mark。`,
        criteria: Object.assign({}, C.ACTION_CRITERIA)
      };
    });
    return {
      url: apiCfg.endpoint || C.DEFAULT_ENDPOINT,
      protocol: apiCfg.protocol || 'systemone',
      model,
      body: { model, state, questions },
      ids: accounts.map((_, i) => `a${i + 1}`)
    };
  }

  // 按协议包装成最终 HTTP 请求体（systemone 原生 / chat 兼容 / 自定义 JSON 模板）
  function toFetchOptions(req, apiKey, settings) {
    const apiCfg = (settings && settings.api) || {};
    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    };
    const extra = apiCfg.extraHeaders || {};
    for (const k of Object.keys(extra)) if (!/^authorization$/i.test(k)) headers[k] = String(extra[k]);
    let body = req.body;
    if (req.protocol === 'chat') {
      body = {
        model: req.model,
        messages: [
          { role: 'system', content: '你是结构化决策模型，只输出 JSON，不要输出解释文字。' },
          { role: 'user', content: JSON.stringify(req.body) }
        ],
        temperature: 0,
        stream: false,
        response_format: { type: 'json_object' }
      };
    }
    return { url: req.url, method: 'POST', headers, body: JSON.stringify(body) };
  }

  function extractAnswers(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.answers && typeof data.answers === 'object') return data;
    // OpenAI 兼容协议：内容可能是 JSON 字符串
    const content = data.choices && data.choices[0] &&
      (data.choices[0].message ? data.choices[0].message.content : data.choices[0].text);
    if (typeof content === 'string') {
      const cleaned = content.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
      try {
        const parsed = JSON.parse(cleaned);
        if (parsed.answers) return parsed;
        return { answers: parsed, __fromContent: true };
      } catch (_) { /* 交给上层按解析失败处理 */ }
    }
    if (data.data && data.data.answers) return data.data;
    return null;
  }

  function answerProbabilities(ans) {
    return (ans && ans.probabilities) || {};
  }

  function parseResponse(data, ids) {
    if (data && data.errorCode !== undefined && data.errorCode !== 0) {
      const err = new Error(`接口返回错误 errorCode=${data.errorCode}: ${data.errorDesc || data.errorMsg || '未知错误'}`);
      err.code = 'api_error';
      err.apiError = data.errorDesc || '';
      throw err;
    }
    const wrapped = extractAnswers(data);
    if (!wrapped) {
      const err = new Error('响应中缺少 answers，无法解析结构化决策结果');
      err.code = 'parse_error';
      throw err;
    }
    const answers = wrapped.answers || {};
    const out = {};
    for (const id of ids) {
      const src = answers[`${id}_source`] || {};
      const auto = answers[`${id}_auto`] || {};
      const act = answers[`${id}_action`] || {};
      const evi = answers[`${id}_evidence`] || {};
      const srcProbs = answerProbabilities(src);
      const actProbs = answerProbabilities(act);
      out[id] = {
        source: String(src.choice || 'uncertain'),
        sourceProb: Number(srcProbs[src.choice] != null ? srcProbs[src.choice] : (src.confidence || 0)),
        sourceConfidence: Number(src.confidence || 0),
        autoProb: Number(auto.noul != null ? auto.noul : 0),
        evidenceProb: Number(evi.noul != null ? evi.noul : 0),
        action: String(act.choice || 'keep'),
        actionProb: Number(actProbs[act.choice] != null ? actProbs[act.choice] : 0),
        hideProb: Number(actProbs.hide || 0),
        keepProb: Number(actProbs.keep || 0),
        confidence: Number(act.confidence || 0),
        raw: { source: src, auto, evidence: evi, action: act }
      };
    }
    return {
      results: out,
      model: data && data.model ? data.model : null,
      usage: (wrapped.usage || (data && data.usage)) || null,
      requestId: (data && (data.request_id || data.requestId)) || null
    };
  }

  /* 复核合成：本地规则结果与模型结果共同决定最终处置。
   * 闸门（全部满足才允许 hide，任何一个不满足就降级）：
   *   - 模型 action=hide 且 hide 概率 / 置信度达阈值
   *   - 模型 is_auto 概率达阈值，source=auto_agent
   *   - 本地至少 1 类强证据（模型不能凭空隐藏一条完全干净的评论）
   *   - 本地无「强真人反证」
   * 模型判 human_* 且概率高时，可以纠正规则的误判，降级为 keep。
   */
  function combine(local, model, settings) {
    const th = (settings && settings.thresholds) || {};
    const tHide = th.modelHideProb != null ? th.modelHideProb : 0.62;
    const tAuto = th.modelAutoProb != null ? th.modelAutoProb : 0.60;
    const tConf = th.modelConfidence != null ? th.modelConfidence : 0.60;
    const tKeep = th.modelKeepProb != null ? th.modelKeepProb : 0.60;

    const reasons = [];
    let decision = local.decision;
    let modelStatus = 'reviewed';

    if (!model) {
      return {
        decision: local.decision, reasons: local.reasons.concat(['模型复核｜接口不可用，已回退纯规则结果']),
        modelStatus: 'unavailable', model: null
      };
    }

    const humanSources = ['human_meme', 'human_polished', 'human_normal'];
    const strongCount = (local.strongCategories || []).length;
    const humanCleared = humanSources.includes(model.source) && model.sourceProb >= tKeep;
    // 极保守口径：模型复核只能「确认或降级」本地隐藏，不能把 keep/mark 升级成 hide。
    const autoSignal = Math.max(
      Number(model.autoProb) || 0,
      (Number(model.evidenceProb) || 0) * 0.9,
      model.source === 'auto_agent' ? (Number(model.sourceProb) || 0) * 0.9 : 0
    );
    const sourceAuto = model.source === 'auto_agent' && model.sourceProb >= 0.60;
    const evidenceHigh = Number(model.evidenceProb || 0) >= 0.50;
    const actionHide = model.action === 'hide' && model.hideProb >= tHide && model.confidence >= tConf;
    const modelConfirmsAuto = sourceAuto && autoSignal >= tAuto && evidenceHigh;

    if (local.decision === 'hide') {
      // 只有模型**明确判为真人**时才降级；模型没表态/置信度低时维持本地隐藏。
      // 此前「模型未确认即降级」会把 Lv2 鱼系账号全部变成仅标记，与用户口径冲突。
      if (humanCleared && strongCount === 0) {
        decision = 'mark';
        reasons.push(`模型复核｜判定为 ${model.source}（概率 ${U.round(model.sourceProb, 3)}），与本地隐藏结论冲突，降级为标记，评论保持可见`);
        modelStatus = 'downgraded_mark';
      } else {
        decision = 'hide';
        reasons.push(modelConfirmsAuto
          ? `模型复核｜确认本地隐藏结论：source=${model.source} (${U.round(model.sourceProb, 3)})、集成信号=${U.round(autoSignal, 3)}`
          : `模型复核｜未提出真人反证（source=${model.source}、集成信号=${U.round(autoSignal, 3)}），维持本地隐藏结论`);
        modelStatus = modelConfirmsAuto ? 'confirmed_hide' : 'kept_hide';
      }
    } else if (local.decision === 'mark') {
      if (humanCleared && strongCount === 0) {
        decision = 'keep';
        reasons.push(`模型复核｜判定为 ${model.source}（概率 ${U.round(model.sourceProb, 3)}），纠正本地标记，保留评论`);
        modelStatus = 'corrected_keep';
      } else {
        decision = 'mark';
        reasons.push('模型复核｜维持标记；按极保守口径，模型不把标记升级为隐藏');
        modelStatus = 'kept_mark';
      }
    } else {
      decision = 'keep';
      reasons.push(`模型复核｜本地判定保留，模型不升级处置（source=${model.source}、action=${model.action}）`);
    }
    reasons.push(`模型依据｜source=${model.source} (${U.round(model.sourceProb, 3)})，is_auto=${U.round(model.autoProb, 3)}，evidence=${U.round(model.evidenceProb || 0, 3)}，action=${model.action} (${U.round(model.actionProb, 3)})，confidence=${U.round(model.confidence, 3)}`);
    return { decision, reasons: local.reasons.concat(reasons), modelStatus, model };
  }

  // 去重键：同一账号在相同证据快照下只复核一次
  function cacheKey(account) {
    return U.hash32(JSON.stringify({
      n: account.uname, l: account.level, t: (account.commentTexts || []).map(x => U.normalizeText(x)).slice(0, 4),
      s: (account.strongCategories || []).slice().sort(), score: U.round(account.score || 0, 2)
    }));
  }

  return {
    TASK, buildRequestBody, toFetchOptions, extractAnswers, parseResponse,
    combine, cacheKey, publicAccountState
  };
});
