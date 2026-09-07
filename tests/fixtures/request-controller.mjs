import * as manager from '../../chat/session-manager.mjs';
import * as delivery from '../../chat/source-deliveries.mjs';
await manager.startDetachedRunObservers();
process.send({ ready: true });
process.on('message', async ({ id, action, args }) => {
  try {
    const value = action === 'create' ? await manager.createSession(process.env.HOME, 'fake-restart', 'Restart test')
      : action === 'accept' ? await manager.submitHttpMessage(...args)
      : action === 'response' ? await manager.getSessionReplyPublication(...args)
      : action === 'claim' ? await delivery.claimSourceDelivery(...args)
      : action === 'complete' ? await delivery.completeSourceDelivery(...args)
      : action === 'stop' ? await manager.drainRequestRuntime() : null;
    process.send({ id, value });
  } catch (error) { process.send({ id, error: error.stack }); }
});
