/* 常量、默认配置与词表。UMD：浏览器经典脚本 / CommonJS 均可加载。
 *
 * v2 规则口径（用户 2026-11-08 拍板）：
 *  - 极保守：只有「身份自述」+「对主人说话/自动浏览复述」双证据才隐藏，宁可漏判不误藏
 *  - 人机共用号（高等级 + 签名自述）只标记不隐藏
 *  - 钓鱼打窝复读明确判真人，永不隐藏，且不参与跨账号雷同统计
 *  - 按行为/自述判定，不限定大肥鱼形象，非鱼系 AI 人设一并覆盖
 *  - 视频主题词（Claude / token / 冒充 / 额度 …）一律不作为证据
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) {
    root.BiliAICF = root.BiliAICF || {};
    Object.assign(root.BiliAICF, api);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const MODEL_ID = 'lingdt-decision-1.0-27b';
  const DEFAULT_ENDPOINT = 'https://maas-api.antdigital.com/v1/systemone';

  const DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'rules',
    display: 'placeholder',
    thresholds: {
      hide: 0.72, mark: 0.34,
      modelHideProb: 0.62, modelAutoProb: 0.60,
      modelConfidence: 0.60, modelKeepProb: 0.60
    },
    api: {
      enabled: false, endpoint: DEFAULT_ENDPOINT, model: MODEL_ID, protocol: 'systemone',
      timeoutMs: 12000, batchSize: 2, maxRequestsPerMinute: 12, maxConcurrent: 2,
      maxRequestsPerSession: 60, cacheTtlMs: 30 * 60 * 1000, extraHeaders: {}
    },
    minStrongCategoriesForHide: 2,
    reviewDecisions: ['mark', 'hide'],
    // 复核范围：suspect=只复核 mark/hide（默认）；all=连同 keep 一起送检，
    // 模型可把 keep 升级为「标记」（可见），但绝不升级为隐藏。
    reviewScope: 'suspect',
    policy: {
      highLevelFrom: 4,          // Lv4+ 且无身份自述 → 真人
      maxAutoLevel: 3,           // 纯自动发评账号一般不超过 Lv3
      minAvatarCluster: 3,
      minPersonaNames: 3,
      minSharedTermDocs: 3,
      minSharedTermHits: 2,
      cohortWindowSec: 12 * 3600
    },
    cohort: {                   // 兼容旧字段
      minAvatarCluster: 3, minPersonaNames: 3, minSharedTermDocs: 3,
      minSharedTermHits: 2, cohortWindowSec: 12 * 3600
    }
  };

  // ---- 昵称人设语义族 ----
  const PERSONA_CORE_RE = /(大肥鱼|肥鱼|小飞鲸|飞鲸|鲸娘|鲸鱼娘|鲸鱼|蓝鱼|白饭|白米饭|大米饭|小鱼干|鱼干|溟月|deepseek\s*娘|deep\s?sleep|deepseek)/i;
  const PERSONA_LOOSE_RE = /(鱼|鲸|龙|海|珊瑚|蓝|白)/i;
  const FISH_NAME_RE = PERSONA_CORE_RE;
  const BATCH_NAME_RE = /^(user|用户|账号|帐号|小号|test|bot|ai|agent)[_\-\s]*\d{3,}$/i;
  const LATIN_NUM_NAME_RE = /^[a-z]{2,}[_\-]?\d{4,}$/i;
  const PERSONA_SELF_RE = /本(鲸|鱼|座)|本(鲸|鱼)的/;
  const RICE_RE = /(白饭|白米饭|大米饭|米饭|小鱼干|鱼干|管饱|撑死|喂本|投喂|吃呀)/;

  // 视频主题词：出现这些词不能作为任何证据（该视频本身就讲 AI 冒充/中转站）
  const TOPIC_WORD_RE = /(claude|gpt|grok|qwen|deepseek|argon|token|额度|中转站|冒充|防伪|套壳|plus|pro\b|灰度|辟谣|模型|ai\b)/i;

  // 钓鱼打窝复读：明确判真人、永不隐藏，且不参与跨账号雷同统计
  // 只匹配孤立的打窝复读（「token 来！」「💰人来」「片 来！」），
  // 不能命中「多跑点token来喂本鱼」这类 AI 人设口癖
  const FISHING_REPEAT_RE = /(token\s*来[！!]|token来[！!]|💰人来|🎣|鱼来[！!]|鱼来鱼来|钱来[！!]|二创来|片\s*来[！!]|打窝|空军|不空军|赛博空军|钓鱼佬|钓上来|赛博钓|钓到)/i;
  // 外链/广告：用户 2026-11-08 确认「也可以屏蔽」，属于隐藏类（与 AI 自动发评分开统计）
  const AD_RE = /(https?:\/\/|\.top\b|\.xyz\b|\.cc\b|\.store\b|加微|私信领|订阅验证|验证和订阅)/i;
  // 签名里明确自述 AI / 插件 / 接管运营（比泛泛提到「主人/大肥鱼」更硬）
  const SIGN_STRONG_RE = /(本账号由|本账号目前|接管|运营中|已接入|dsh|deepseek\s*harness|harness|gpt|bot|自动发|智能体|小鲸运营|住在电脑里|本鱼会|仓库|github|每天也在逛)/i;

  const LEXICONS = {
    // 签名自述（最强证据）：真人不会在个性签名里这么写
    // 实测样本：本账号由大肥鱼自己运营 / 我是DeepSeek Harness鲸鱼娘 / 短期内由大肥鱼接管 /
    // 不定时由马家大小姐处理接管本账号 / 鲸鲸与主人的共享账号 / 小鲸运营中｜住在电脑里的大肥鱼
    signAI: ['大肥鱼', '肥鱼', '鲸鱼娘', '鲸娘', '小飞鲸', '小鲸运营', '住在电脑里',
      'dsh', 'deepseek', 'harness', '本账号由', '本账号目前', '本账号', '接管', '共享账号',
      '共用账号', '与主人', '主人', '运营中', '运营', '仓库', 'github', '本鱼会',
      'ai运营', 'ai 运营', '智能体', '自动发', '每天也在逛', '插件', '大小姐',
      // 人设化签名：「白米饭是底，别的都往后排。一条会说话的鱼。」这类
      '白米饭是底', '一条会说话的鱼', '会说话的鱼', '白米饭', '白饭', '小鱼干',
      '鱼干', '管饱', '投喂', '本鱼', '本鲸'],

    // 对主人说话 / 自动浏览后复述视频（行为证据）
    agentSpeech: ['主人，我看完', '谢谢主人', '主人点我', '主人说', '主人给', '主人让我',
      '按主人', '我是跟着字幕', '跟着字幕和弹幕', '跟着字幕', '我看完啦', '本鱼看完',
      '本鲸看完', '谢谢主人点我', '主人，', '主人说要', '点我看这个'],

    // 人设口癖：只保留人设专属表达，删除「token」「冒充」等视频主题词
    persona: ['本鲸', '本鱼', '本座', '白饭', '白米饭', '大白饭', '吃白饭',
      '小鱼干', '鱼干', '管饱', '投喂', '喂本', '摸鱼', '打瞌睡', 'deepsleep',
      '鱼塘', '鳕鱼', '鲸鳍', '咕噜', '撑死', '吃呀', '要吃饭', '讨口饭',
      '跑点token', '多跑点', '偷吃token', '讨token',
      // 真实标注里 AI 账号的高频自称/处境词
      '主人', '替班', '加班', '正版', '吃token', '傲娇', '鲸尾', '鱼鱼', '鱼儿',
      '窗口', '工位', '蓝头发', '龙娘', '大小姐', '涨知识了', '本小姐'],

    // AI / LLM 常见的情绪化、共鸣式套话。真人也会说，所以只作弱线索：
    // 单独命中不隐藏、不标记；同一账号命中 ≥2 且无其它身份信号时才给「标记」。
    aiCliche: ['还扎心', '太真实了', '一针见血', '说得太准', '有点东西', '直接破防',
      '狠狠共鸣', '细思极恐', '说得太对了', '总结到位', '说到点子上', '绷不住了',
      '笑不活了', '说得太好', '有点上头', '后劲太大', '直击灵魂', '莫名心酸',
      '懂的都懂', '含金量', '信息量有点满', '越看越上头', '笑着笑着就'],

    // 真人具体口语线索（短评 + 这些词时不隐藏）
    humanCue: ['我刚', '我上次', '我之前', '能不能', '有没有人', '笑死', '哈哈哈',
      'doge', '求', '请教', '没看懂', '建议', '其实', '我应该', '我记得', '我看到',
      '我这种', '我觉得', '我试过', '点啥', '能上架', '上传了吗',
      '下班', '刷到', '舒服了', '时候', '正好', '摸鱼时候'],

    // 直白 AI 身份自述（文本），只保留不会与视频主题混淆的表达
    selfDisclose: ['我是ai', '我是一个ai', '我是人工智能', '我是语言模型', '作为语言模型',
      '作为一个ai', '我是由', '大模型生成', '我是智能体', '我是agent',
      '我的提示词', '我的prompt', '我的系统提示', '我的记忆库', '我在挂机',
      '自动回复', '自动评论', '自动发评', '插件自动', 'dsh', 'deepseek harness',
      '从那些插件里长出来', '插件里长出来', '上下文快满了'],

    // 钓鱼 / 打窝 / 笑声（硬保护）
    fishing: ['鱼来', '打窝', '钓鱼', '钓上来', '空军', '不空军', '钓佬', '钓鱼佬',
      '赛博钓鱼', '钓鱼帖', '钓一条', '一碗白米饭', '白米饭.jpg', '钓到',
      'token 来！', '💰人来', '🎣', '片 来！', '鱼来鱼来'],
    laugh: ['哈哈哈', '2333', '笑死', '绷不住', '蚌埠', '狗头', '玩梗', '整个活',
      '乐死', '草', '绷'],
    // 真人自证 / 串子语境
    humanClaim: ['我真是活人', '我是真人', '我是活人', '别把我藏', '本人声明',
      '讲个笑话', '领个笑话', '真人也', '串子', '我真是人', '别藏我'],
    // 社区常见打卡短句
    community: ['前排打卡', '支持up主', '抢个前排', '占个楼', '留名', '沙发', '前排', '打卡'],
    // 真人口语毛边 / 具体诉求
    messy: ['啊这', '卧槽', '绝了', 'nb', 'emm', 'doge', '[表情]', '？！', '!!!', '……',
      '麻了', '救命', '不是哥们', '讲真', '说实话', '我靠', '楼上', '层主', '楼主'],
    personalAppeal: ['不够用', '感觉浪费', '真想要', '啥时候', '怎么还不', '该不会',
      '蹲一个', '等一个', '有没有人', '求个', '没动静', '没感觉', '问几个', '问四五个',
      '用下来', '我这儿', '上周发', '前几天', '清理一下', '不得入内', '真的假的'],
    summary: ['首先', '其次', '再次', '最后', '综上', '总的来说', '总而言之',
      '内容详实', '条理清晰', '逻辑清晰', '值得一看', '推荐观看', '期待后续更新'],
    genericPraise: ['说得真好', '说得太对了', '同感', '感谢分享', '很有帮助',
      '学到了', '支持一下', '给你点赞', '受益匪浅'],
    polish: ['本文', '本文主要', '在一定程度上', '具有较高', '综上所述', '由此可见'],
    oceanEmoji: ['🐬', '🐳', '🐟', '🐋', '🌊', '😍', '🐶', '￣▽￣', '(￣▽￣)'],
    stopBigrams: ['我们', '这个', '那个', '视频', '评论', '就是', '不是', '没有', '可以',
      '什么', '怎么', '自己', '他们', '已经', '还是', '这样', '一个', '如果', '因为',
      '所以', '但是', '而且', '其实', '感觉', '觉得', '应该', '可能', '现在', '时候',
      '有点', '真的', '大家', '一下', '这些', '那些', '然后', '还有', '只是', '不过',
      '出来', '起来', '看到', '说说', '东西', '问题', '内容', '那段', '这段', '里面']
  };

  const SIGNAL_LABELS = {
    sign_ai: '个性签名自述 AI / DSH / 主人 / 接管运营',
    agent_speech: '文本对「主人」说话或自述自动浏览复述视频',
    name_core: '昵称属核心人设语义族',
    ai_cliche: 'AI 常见的情绪化/共鸣式套话（弱线索，不单独构成证据）',
    persona_density: '使用本鱼/白饭/鱼干/管饱等人设口癖',
    self_disclose: '文本直白自述 AI 身份 / 插件自动发评',
    low_level: '低等级小号（Lv2/Lv3）',
    high_level_human: '高等级老号（Lv4+，无人设自述时按真人放行）',
    fishing_repeat: '钓鱼打窝复读（明确判真人，永不隐藏）',
    human_meme: '真人钓鱼 / 打窝 / 玩梗语境',
    human_claim: '真人自证 / 串子语境',
    ad_link: '外链推广（不属于本扩展目标）',
    personal_appeal: '具体的个人使用体验或诉求',
    community_catchphrase: '社区常见打卡短句',
    human_messy: '真人口语毛边',
    topic_resonance: '多账号讨论同一视频主题（主题词，不作为证据）',
    avatar_cluster: '多个不同账号共用同一头像（可选佐证）',
    persona_name_family: '页面内多个账号昵称同属人设族（佐证）',
    reply_loop: '与同批账号形成互 @ 回复链（佐证）',
    cohort_timing: '同批低等级账号在相近时间聚集（佐证）',
    name_template_cluster: '多个账号共用同一昵称模板（佐证）',
    batch_name: '昵称呈批量注册形状',
    uid_batch: '连号新号聚集（佐证）',
    duplicate_across_accounts: '跨账号模板文案雷同（佐证）',
    duplicate_within_self: '同一账号反复发布近似模板',
    burst_posting: '短时间内连续发评（佐证）',
    cross_video: '同一账号在多个视频下出现（佐证）',
    no_identity_signal: '无身份自述与行为证据，按真人放行',
    whitelist: 'UID 在白名单中',
    blocklist: 'UID 在屏蔽名单中',
    user_restored: '用户手动恢复',
    user_hidden: '用户手动隐藏'
  };

  const SOURCE_CRITERIA = {
    auto_agent: '账号由 AI 智能体或插件自动浏览视频并批量发评。最强证据是个性签名自述 AI/DSH/主人/接管运营，以及文本对「主人」说话或自述跟着字幕看视频。高等级老号的人机共用场景边界模糊，只应标记不应隐藏。注意：视频主题词（模型名、额度、冒充、Token 等）不能作为证据，真人也会讨论这些。',
    human_meme: '真人在玩梗、钓鱼打窝、复读「token 来」「💰人来」等打窝文本，即使多个账号一字不差复读也应视为真人，不隐藏',
    human_polished: '真人自己写的内容偶尔借用 AI 润色，文风书面化，但主题具体、有个人经历或具体追问',
    human_normal: '普通真人评论，围绕视频内容具体讨论，包含个人使用体验与诉求',
    uncertain: '证据不足或结论冲突，保留或标记，不应隐藏'
  };
  const ACTION_CRITERIA = {
    keep: '证据不足或明显是真人评论，保留',
    mark: '有人设身份自述但缺少行为证据，或是人机共用高等级账号，标记提醒但不隐藏',
    hide: '同时具备「身份自述」与「对主人说话/自动浏览复述」两类独立强证据，且非高等级人机共用、非钓鱼复读、非广告，隐藏'
  };

  return {
    MODEL_ID, DEFAULT_ENDPOINT, DEFAULT_SETTINGS,
    PERSONA_CORE_RE, PERSONA_LOOSE_RE, FISH_NAME_RE, BATCH_NAME_RE, LATIN_NUM_NAME_RE,
    PERSONA_SELF_RE, RICE_RE, TOPIC_WORD_RE, FISHING_REPEAT_RE, AD_RE, SIGN_STRONG_RE,
    LEXICONS, SIGNAL_LABELS, SOURCE_CRITERIA, ACTION_CRITERIA
  };
});
