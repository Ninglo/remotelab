import { loadInstanceSettings } from './instance-settings.mjs';
import { loadMessageReplySettings, listMessageReplyGroups } from './message-reply-settings.mjs';
import { listPeopleForClient } from '../lib/auth.mjs';
import { getVoiceReviewSettings } from './voice-review.mjs';
import { readDisplayThemeBaseline } from './display-theme-analytics.mjs';
import { settingRows, replySettingRows, instanceSettingValues, personSettingValues,
  voiceSettingValues, observeSettingRows, settingObserver } from './usage-settings.mjs';

let flight = null, checkedAt = 0, previous = null;
export function collectSettingBaseline() {
  if (flight) return flight;
  if (previous && Date.now() - checkedAt < 15_000) return settingObserver.snapshot().then(snapshot =>
    ({ ...snapshot, incomplete: snapshot.incomplete || previous.sourceErrors > 0, sourceErrors: previous.sourceErrors }));
  flight = (async () => {
    const observedAt = Date.now(), rows = [];
    let errors = 0;
    const sources = await Promise.allSettled([loadInstanceSettings({ includeSecrets: false }),
      loadMessageReplySettings(), listMessageReplyGroups(), listPeopleForClient()]);
    errors += sources.filter(result => result.status === 'rejected').length;
    if (sources[0].status === 'fulfilled') rows.push(...settingRows(instanceSettingValues(sources[0].value), { scope: 'instance', scopeId: 'instance' }));
    if (sources[1].status === 'fulfilled' && sources[2].status === 'fulfilled') rows.push(...replySettingRows(sources[1].value, sources[2].value));
    if (sources[3].status === 'fulfilled') {
      const people = sources[3].value;
      for (const person of people) rows.push(...settingRows(personSettingValues(person.preferences || {}), {
        scope: 'person', scopeId: person.id, subjectPersonId: person.id,
      }));
      const voices = await Promise.allSettled(people.map(person => getVoiceReviewSettings(person.id)));
      for (let i = 0; i < voices.length; i++) {
        if (voices[i].status === 'rejected') { errors++; continue; }
        rows.push(...settingRows(voiceSettingValues(voices[i].value), { scope: 'person', scopeId: people[i].id, subjectPersonId: people[i].id }));
      }
      const display = await readDisplayThemeBaseline(people);
      rows.push(...display.rows); if (display.incomplete) errors++;
    }
    await observeSettingRows(rows, { operation: 'snapshot', observedAt });
    const snapshot = await settingObserver.snapshot();
    previous = { ...snapshot, incomplete: snapshot.incomplete || errors > 0, sourceErrors: errors };
    checkedAt = Date.now();
    return previous;
  })().finally(() => { flight = null; });
  return flight;
}
