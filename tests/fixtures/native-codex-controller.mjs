import { findActiveFeishuThreadExecution } from '../../chat/feishu-thread-continuation.mjs';
import * as manager from '../../chat/session-manager.mjs';
import * as delivery from '../../chat/source-deliveries.mjs';
import * as work from '../../chat/work-awareness.mjs';
import * as routing from '../../chat/group-routing.mjs';
import { requests } from '../../chat/requests.mjs';
import { loadAuthDocument } from '../../lib/auth-config.mjs';
import { changePersonMessageReplies } from '../../chat/person-message-replies.mjs';
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
      : action === 'runtime' ? await manager.updateSessionRuntimePreferences(...args)
      : action === 'remove' ? await manager.removeQueuedMessage(...args)
      : action === 'cancel-conversation' ? await manager.cancelFeishuConversation(...args)
      : action === 'cancel' ? await manager.cancelActiveRun(...args)
      : action === 'shutdown' ? await manager.killAll()
      : action === 'work-start' ? await work.startWork(args[0])
      : action === 'work-suggest' ? await work.createWorkSuggestion(args[0])
      : action === 'work-inbox' ? await work.workInbox(args[0])
      : action === 'route-input' ? await routing.routeGroupWork(await requests.byRequest(args[0], args[1]), args[2])
      : action === 'reply-input' ? await routing.replyGroupInput(await requests.byRequest(args[0], args[1]), args[2])
      : action === 'message-settings' ? await changePersonMessageReplies(...args)
      // Restore a captured pre-upgrade contract only in this isolated fixture.
      : action === 'legacy-routing-snapshot' ? await requests.mutate((await requests.byRequest(args[0], args[1])).key,
        r => { const options = { ...r.options, routingPilotMainline: true, routingPilotMainlineProtocol: 2,
          messageRoutingPolicy: { version: 1, mechanism: 'experimental' } };
          delete options.parallelWorkPolicy; return { ...r, options }; })
      : action === 'request' ? await requests.byRequest(...args)
      : action === 'thread-execution' ? await findActiveFeishuThreadExecution(...args)
      : action === 'claim' ? await delivery.claimSourceDelivery(...args)
      : action === 'complete' ? await delivery.completeSourceDelivery(...args)
      : action === 'stop' ? await manager.drainRequestRuntime() : null;
    process.send({ id, value });
  } catch (error) { process.send({ id, error: error.stack, errorCode: error.code }); }
});
