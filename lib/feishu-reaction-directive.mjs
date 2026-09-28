// The model chooses one outcome reaction in its final answer. The connector
// binds it to the inbound delivery target and sends it with its Bot identity.
export const FEISHU_OUTCOME_REACTIONS = Object.freeze([
  'OnIt', 'EatingFood', 'OK', 'THUMBSUP', 'THANKS', 'GLANCE',
  'SMILE', 'APPLAUSE', 'WOW', 'WHAT', 'DULL', 'TEARS', 'HUG', 'COMFORT',
]);

const reactionSet = new Set(FEISHU_OUTCOME_REACTIONS);
const directive = /^<private>\s*<feishu-reaction emoji="([A-Za-z]+)"\s*\/>\s*<\/private>/;

export function parseFeishuReactionDirective(value) {
  const final = String(value || '').trim();
  const match = directive.exec(final);
  if (match && reactionSet.has(match[1])) {
    return { emojiType: match[1], text: final.slice(match[0].length).trim(), invalid: false };
  }
  if (/^<private>\s*<feishu-reaction\b/i.test(final)) {
    // A malformed private instruction must never be copied into a group chat.
    const afterBlock = final.indexOf('</private>');
    return { emojiType: '', text: afterBlock >= 0 ? final.slice(afterBlock + 10).trim() : '', invalid: true };
  }
  return null;
}
