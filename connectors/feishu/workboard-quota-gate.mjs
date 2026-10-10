import { isFeishuMonthlyQuotaError } from '../../lib/feishu-retry-policy.mjs';

// Every provider operation in the card worker targets the same Bot route.
// A monthly quota rejection blocks that writer until an operator restores the
// quota and restarts it. Session events and existing card receipts stay intact.
export function createWorkboardQuotaGate({ onBlocked = async () => {}, now = Date.now } = {}) {
  let blocked = false;
  return {
    get blocked() { return blocked; },
    async observe(error) {
      if (!isFeishuMonthlyQuotaError(error)) return false;
      if (!blocked) {
        blocked = true;
        await onBlocked({ code: 99991403, at: new Date(now()).toISOString(),
          message: String(error?.message || error?.msg || 'Feishu monthly API quota exhausted') });
      }
      return true;
    },
  };
}
