// Card views recover after reception starts. Their HTTP/provider requests must
// not become prerequisites for accepting messages against durable local state.
export function startFeishuCardRecovery({ startWorkboards, startProjectCards, restoreParticipation,
  warn = (name, error) => console.warn(`[feishu-${name}] restore failed: ${error.message}`) }) {
  let stopped = false;
  const start = (name, open) => Promise.resolve().then(async () => {
    if (stopped) return null;
    const component = await open();
    if (stopped) {
      await component?.stop();
      return null;
    }
    return component;
  }).catch(error => { warn(name, error); return null; });
  const components = [start('workboards', startWorkboards), start('project-cards', startProjectCards)];
  const participation = Promise.resolve().then(() => {
    if (!stopped) return restoreParticipation(() => !stopped);
  }).catch(error => warn('participation', error));
  return {
    ready: Promise.all([...components, participation]),
    async stop() {
      stopped = true;
      await Promise.all(components.map(async pending => (await pending)?.stop()));
    },
  };
}
