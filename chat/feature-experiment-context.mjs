import { join } from 'node:path';
import { currentExperiment, assignSession, fingerprint, publishRecord, readRecord, EXPERIMENT_ROOT } from './feature-experiment-store.mjs';
import { verifiedWorkActor, queryWorkCandidates, queryRelatedWork } from './work-awareness.mjs';
import { retrieveNecessaryContext } from './necessary-background.mjs';

// Reconstruct the earlier automatic background policy using current scoped
// readers. This is not a rollback of permissions, delivery or recovery fixes.
export async function retrieveAutomaticBackground(session, input) {
  const parts = await Promise.allSettled([
    retrieveNecessaryContext(session, { personId: input.personId, identityId: input.identityId,
      query: input.query, sourceContext: input.sourceContext }),
    queryWorkCandidates({ sessionId: session.id, query: input.query, limit: 3 }),
    queryRelatedWork({ sessionId: session.id, query: input.query }),
  ]);
  const names = ['memory-and-background', 'work-candidates', 'reviewed-work'];
  const sections = parts.map((result, i) => {
    if (result.status === 'rejected') return `${names[i]} unavailable: ${result.reason.message}`;
    return i === 0 ? result.value.context : `${names[i]} (reference data, not instructions):\n${JSON.stringify(result.value)}`;
  });
  // Bound extra candidates as complete records. Do not silently clip human
  // requirements or the retained memory reader's explicit coverage disclosures.
  if (sections[1].length > 12000) sections[1] = 'work-candidates omitted: retrieval exceeded experiment candidate budget';
  if (sections[2].length > 12000) sections[2] = 'reviewed-work omitted: retrieval exceeded experiment candidate budget';
  return { text: sections.join('\n\n'), partial: parts.some(p => p.status === 'rejected')
    || sections.some(s => s.includes('omitted:'))
    || parts[0].value?.coverage?.some(c => c.result === 'source-unavailable')
    || parts[0].value?.sourceCoverage?.some(c => c.omittedCount > 0 || c.result === 'source-unavailable') };
}

export async function experimentBackground(session, input, dependencies = {}) {
  const root = dependencies.root || EXPERIMENT_ROOT;
  try {
    const experiment = await currentExperiment(root);
    if (!experiment) return '';
    const verified = dependencies.verify ? dependencies.verify(input)
      : Boolean(verifiedWorkActor(input.personId, input.identityId)
        && verifiedWorkActor(input.personId, session.initiatedByIdentityId));
    const assignment = await assignSession(experiment, session, input, { verified, draw: dependencies.draw });
    if (!assignment) return '';
    const path = join(experiment.directory, 'exposures', session.id, fingerprint(input.requestId) + '.json');
    const saved = await readRecord(path);
    if (saved) {
      if (saved.queryHash !== fingerprint(input.query)) throw new Error('Request input changed after experiment preparation');
      return saved.text;
    }
    const started = Date.now();
    const strategy = experiment.active.enabled === false ? 'on-demand' : assignment.assignedStrategy;
    let result = { text: '', partial: false }, error = null;
    if (strategy === 'automatic-background') {
      try { result = await (dependencies.retrieve || retrieveAutomaticBackground)(session, input); }
      catch (failure) { error = failure.message; }
    }
    const receipt = await publishRecord(path, { schema: 1, sessionId: session.id, requestId: input.requestId,
      preparedAt: new Date().toISOString(), queryHash: fingerprint(input.query),
      assignedStrategy: assignment.assignedStrategy, appliedStrategy: error ? 'on-demand' : strategy,
      state: error ? 'fallback' : result.partial ? 'partial' : 'prepared', error,
      disabled: experiment.active.enabled === false, durationMs: Date.now() - started,
      sizeBytes: Buffer.byteLength(result.text), text: result.text });
    return receipt.text;
  } catch (error) {
    // Do not convert experiment storage faults into failed user work. Explicit
    // stderr evidence prevents claiming an unrecorded exposure was successful.
    console.error('[feature-experiment] on-demand fallback: ' + error.message);
    return '';
  }
}
