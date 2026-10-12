import { queryUsageLedger } from './usage-ledger.mjs';

let sessionTokenTotalsCache = null;
let sessionTokenTotalsPending = null;
export async function getSessionTokenTotals() {
  if (sessionTokenTotalsCache && Date.now() < sessionTokenTotalsCache.expiresAt) {
    return sessionTokenTotalsCache.value;
  }
  if (!sessionTokenTotalsPending) {
    sessionTokenTotalsPending = queryUsageLedger({ days: 3650, top: Number.MAX_SAFE_INTEGER, includeTopRuns: false })
      .then((summary) => {
        const value = {
          generatedAt: summary.generatedAt,
          window: summary.window,
          bySession: summary.bySession.map(({ sessionId, totalTokens, runCount }) => ({ sessionId, totalTokens, runCount })),
        };
        sessionTokenTotalsCache = { value, expiresAt: Date.now() + 60_000 };
        return value;
      })
      .finally(() => { sessionTokenTotalsPending = null; });
  }
  return sessionTokenTotalsPending;
}
