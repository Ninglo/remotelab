// The only broker destinations are the six personal workspace operations.
// No owner credential, arbitrary URL, person selector, or filesystem route.
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== 'rlfe:personal-workspace-request') return;
  void (async () => {
    const url = new URL(sender.url);
    if (url.protocol !== 'https:' || !/^(?:[a-z0-9-]+\.)?feishu\.cn$/.test(url.hostname) || !/^\/(?:next\/)?messenger/.test(url.pathname)) throw Error('请在飞书 Web 中使用个人入口。');
    const routes = { context: ['GET', 'context'], index: ['GET', 'index'], thinking: ['GET', 'thinking'], sendIndex: ['POST', 'index'], analyze: ['POST', 'thinking'], disconnect: ['DELETE', 'connection'] }, route = routes[message.operation];
    if (!route || !/^fwspace_[a-zA-Z0-9_-]{43}$/.test(message.token || '') || !/^\d{10,30}$/.test(message.account || '')) throw Error('个人入口请求无效。');
    const body = message.body === undefined ? undefined : JSON.stringify(message.body);
    if (body?.length > 32768) throw Error('内容过长。');
    if (message.requestId && !/^[a-zA-Z0-9_-]{16,80}$/.test(message.requestId)) throw Error('请求编号无效。');
    const response = await fetch('https://index.jiujianian.dev/api/feishu-web-workspace/' + route[1] + (message.requestId ? '?requestId=' + encodeURIComponent(message.requestId) : ''), {
      method: route[0], credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + message.token, 'Content-Type': 'application/json', 'X-Feishu-Origin': url.origin, 'X-Feishu-Account': message.account }, ...(body === undefined ? {} : { body }) });
    return { ok: response.ok, status: response.status, data: await response.json() };
  })().then(respond, error => respond({ ok: false, status: 0, data: { error: error.message } }));
  return true;
});
