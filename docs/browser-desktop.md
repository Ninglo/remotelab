# Browser desktop through the instance domain

Give the instance's agent this task:

> Connect a persistent graphical browser to this instance's existing `/browser/`
> route. Reuse owner login and the existing HTTPS domain. Verify the desktop page,
> binary WebSocket/RFB connection, visitor rejection and cross-origin rejection.
> Preserve the browser profile and active requests. Replace any temporary public
> tunnel only after the stable route works. Ask me only to complete the account's
> interactive login or verification in the resulting desktop.

The operator supplies the target instance and, if already available, its local
noVNC/websockify service. The agent can discover the rest. Account credentials are
entered in the desktop, never placed in shared setup notes or chat links.

## Runtime contract

- `/browser/` redirects to noVNC with the same-origin `/browser/websockify` socket.
- HTTP and WebSocket requests require the instance owner. Anonymous page requests
  redirect to the existing login page and return to the desktop afterward.
  Visitors cannot access either assets or the control socket.
- WebSocket upgrades also require an exact matching Origin, using the normal
  instance Host and forwarded HTTP/HTTPS protocol. Only the configured loopback
  service is reachable; request parameters cannot select an upstream host/port.
- The backend's Basic credentials are injected locally. RemoteLab cookies and
  bearer tokens are not forwarded, and upstream cookies/redirects/auth challenges
  are not exposed. Desktop responses are private and non-cacheable.
- An HTTP/upgrade connection has a short transport deadline. Connected desktop
  sockets have no application deadline. Browser reasoning tasks run independently
  of the desktop and are unaffected by disconnecting it.

The feature is disabled until the instance config directory contains
`browser-desktop.json` (mode 0600):

```json
{
  "port": 16900,
  "authFile": "/absolute/private/path/desktop-auth.json"
}
```

The upstream must serve noVNC assets at `/`, accept binary WebSocket connections
at `/websockify`, and listen only on `127.0.0.1`. Its private `authFile` contains
`username` and `password`; it remains protected even when accessed locally.
The browser profile and VNC socket must also remain instance-private. CDP is a
separate loopback control channel for agents and is never mounted on this route.

Configuration is read per request, so updating it does not require a service
restart. Set `enabled: false` or remove the config to prevent new connections;
stop the desktop gateway as well when existing connections must be closed.
Do not delete the Chrome profile or restart the browser merely to close access.

## Verification

Run `node scripts/run-with-clean-instance-env.mjs node tests/test-browser-desktop-proxy.mjs`.
It covers owner/visitor/expired sessions, disabled and invalid configuration,
private response headers, credential stripping and replacement, exact socket
routing, same-origin enforcement, and binary bidirectional traffic. Then verify
the actual HTTPS domain and rendering against the instance's desktop. Reaching
noVNC does not prove that the target website's account login has succeeded.
