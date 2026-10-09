// Curated built-in IDs from the official Lark CLI IM reaction reference.
// https://github.com/larksuite/cli/blob/main/skills/lark-im/references/lark-im-reactions.md
export const FEISHU_REACTION_CATALOG = Object.freeze({
  Get: '收到、接下；回复可在工作话题继续，不表示已完成或已成功移交',
  OnIt: '正在处理请求', EatingFood: '安静旁听',
  OK: '理解或同意', THUMBSUP: '赞同', THANKS: '感谢', GLANCE: '关注到更新',
  SMILE: '友善微笑', APPLAUSE: '鼓掌认可', WOW: '惊喜', WHAT: '疑惑',
  DULL: '无语', TOASTED: '接受批评、衰', TEARS: '笑中带泪', HUG: '拥抱支持', COMFORT: '安慰',
  MUSCLE: '鼓励', FINGERHEART: '感谢或喜爱', FISTBUMP: '合作默契', JIAYI: '附议',
  BLUSH: '不好意思', LAUGH: '开心', LOL: '大笑', FACEPALM: '捂脸', WINK: '轻松回应',
  PROUD: '为成果自豪', WITTY: '机智', SMART: '聪明的想法', JOYFUL: '喜悦', YEAH: '欢呼',
  EMBARRASSED: '尴尬', Sigh: '叹气', SALUTE: '敬意', HIGHFIVE: '击掌',
  HEART: '喜爱', PARTY: '庆祝', ROSE: '欣赏', Coffee: '陪伴休息',
  YouAreTheBest: '称赞', STRIVE: '加油', SPEECHLESS: '一时无言', Shrug: '尚不确定',
  OneSecond: '请稍候', Typing: '正在组织回复',
  LGTM: '实际审核通过', DONE: '实际完成', CheckMark: '实际核验通过', CrossMark: '实际核验失败',
  Yes: '有依据的肯定答复', No: '有依据的否定答复',
});

export const FEISHU_OUTCOME_REACTIONS = Object.freeze(Object.keys(FEISHU_REACTION_CATALOG));
// Status and binary claims need independent evidence, not a tone prediction.
const statusOnly = new Set(['OnIt', 'EatingFood', 'OneSecond', 'Typing', 'THINKING',
  'LGTM', 'DONE', 'CheckMark', 'CrossMark', 'Yes', 'No']);
export const FEISHU_SOCIAL_REACTION_CRITERIA = Object.freeze(Object.fromEntries(
  Object.entries(FEISHU_REACTION_CATALOG).filter(([id]) => !statusOnly.has(id))));
export const FEISHU_REACTION_CATALOG_TEXT = Object.entries(FEISHU_REACTION_CATALOG)
  .map(([id, meaning]) => `${id} (${meaning})`).join(', ');
