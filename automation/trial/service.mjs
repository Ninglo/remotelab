import { store } from './store.mjs';
import { runtime } from './runtime.mjs';
import { createEngine } from './engine.mjs';
export const engine = createEngine(store, runtime);
let timer, inFlight;
export function startTrialWorker() {
  if (timer) return;
  const tick = () => {
    if (inFlight) return;
    inFlight = engine.tick().then(results => {
      for (const r of results) if (r.status === 'rejected') console.error('[automation-trial]', r.reason);
    }).catch(e => console.error('[automation-trial]', e)).finally(() => { inFlight = null; });
  };
  timer = setInterval(tick, 2000); timer.unref(); tick();
}
export function stopTrialWorker() { clearInterval(timer); timer = null; }
