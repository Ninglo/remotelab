import * as manager from '../../chat/session-manager.mjs';
import * as delivery from '../../chat/source-deliveries.mjs';
import * as work from '../../chat/work-awareness.mjs';
import { loadAuthDocument } from '../../lib/auth-config.mjs';
await loadAuthDocument({ persistMigration: false });
await manager.startDetachedRunObservers();
process.send({ ready: true });
process.on('message', async ({ id, action, args }) => {
  try {
    const value = action === 'create' ? await manager.createSession(process.env.HOME, 'fake-native', 'Native input test', args[0] || {})
      : action === 'accept' ? await manager.submitHttpMessage(...args)
      : action === 'response' ? await manager.getSessionReplyPublication(...args)
      : action === 'history' ? await manager.getHistory(...args)
      : action === 'session' ? await manager.getSession(args[0], { includeQueuedMessages: true })
      : action === 'remove' ? await manager.removeQueuedMessage(...args)
      : action === 'shutdown' ? await manager.killAll()
      : action === 'work-start' ? await work.startWork(args[0])
      : action === 'work-suggest' ? await work.createWorkSuggestion(args[0])
      : action === 'work-inbox' ? await work.workInbox(args[0])
      : action === 'claim' ? await delivery.claimSourceDelivery(...args)
      : action === 'complete' ? await delivery.completeSourceDelivery(...args)
      : action === 'stop' ? await manager.drainRequestRuntime() : null;
    process.send({ id, value });
  } catch (error) { process.send({ id, error: error.stack, errorCode: error.code }); }
});
