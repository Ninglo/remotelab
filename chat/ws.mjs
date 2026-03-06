import { WebSocketServer } from 'ws';
import { isAuthenticated, getAuthSession, parseCookies } from '../lib/auth.mjs';
import { setWss } from './ws-clients.mjs';
import {
  createSession, getSession, listSessions, listArchivedSessions,
  archiveSession, unarchiveSession,
  subscribe, unsubscribe, sendMessage, cancelSession, getHistory,
  resumeInterruptedSession,
  renameSession, compactSession, dropToolUse,
} from './session-manager.mjs';

/**
 * Attach WebSocket handling to an HTTP server.
 */
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });
  setWss(wss);

  server.on('upgrade', (req, socket, head) => {
    // Only handle /ws path
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Authenticate via cookie
    if (!isAuthenticated(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      // Attach auth session info to the ws object for role checks
      ws._authSession = getAuthSession(req);
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    let attachedSessionId = null;
    const authSession = ws._authSession || {};
    const role = authSession.role || 'owner';
    console.log(`[ws] Client connected (role=${role})`);

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        wsSend(ws, { type: 'error', message: 'Invalid JSON' });
        return;
      }

      console.log(`[ws] ← ${JSON.stringify(msg).slice(0, 200)}`);

      try {
        handleMessage(ws, msg, {
          getAttached: () => attachedSessionId,
          setAttached: (id) => { attachedSessionId = id; },
          role,
          authSession,
        });
      } catch (err) {
        console.error(`[ws] handleMessage error: ${err.message}`);
        wsSend(ws, { type: 'error', message: err.message });
      }
    });

    ws.on('close', () => {
      console.log(`[ws] Client disconnected (was attached to ${attachedSessionId?.slice(0,8) || 'none'})`);
      if (attachedSessionId) {
        unsubscribe(attachedSessionId, ws);
      }
    });
  });

  return wss;
}

function wsSend(ws, data) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(data));
  }
}

// Actions allowed for visitors (scoped to their assigned session)
const VISITOR_ALLOWED = new Set(['attach', 'send', 'cancel', 'resume_interrupted']);

function handleMessage(ws, msg, ctx) {
  const { role, authSession } = ctx;

  // Visitor access control: restrict actions and session scope
  if (role === 'visitor') {
    if (!VISITOR_ALLOWED.has(msg.action)) {
      wsSend(ws, { type: 'error', message: 'Not allowed in visitor mode' });
      return;
    }
    // Visitors can only attach to their assigned session
    if (msg.action === 'attach' && msg.sessionId !== authSession.sessionId) {
      wsSend(ws, { type: 'error', message: 'Access denied' });
      return;
    }
  }

  switch (msg.action) {
    case 'list': {
      const sessions = listSessions();
      wsSend(ws, { type: 'sessions', sessions });
      break;
    }

    case 'create': {
      if (!msg.tool) {
        wsSend(ws, { type: 'error', message: 'tool is required' });
        return;
      }
      const folder = msg.folder || '~';
      const session = createSession(folder, msg.tool, msg.name || '');
      wsSend(ws, { type: 'session', session });
      break;
    }

    case 'rename': {
      if (!msg.sessionId || typeof msg.name !== 'string') {
        wsSend(ws, { type: 'error', message: 'sessionId and name are required' });
        return;
      }
      const updated = renameSession(msg.sessionId, msg.name.trim());
      if (!updated) {
        wsSend(ws, { type: 'error', message: 'Session not found' });
      }
      break;
    }

    case 'delete':
    case 'archive': {
      if (!msg.sessionId) {
        wsSend(ws, { type: 'error', message: 'sessionId is required' });
        return;
      }
      const ok = archiveSession(msg.sessionId);
      if (ok) {
        wsSend(ws, { type: 'archived', sessionId: msg.sessionId });
      } else {
        wsSend(ws, { type: 'error', message: 'Session not found' });
      }
      break;
    }

    case 'unarchive': {
      if (!msg.sessionId) {
        wsSend(ws, { type: 'error', message: 'sessionId is required' });
        return;
      }
      const restored = unarchiveSession(msg.sessionId);
      if (restored) {
        wsSend(ws, { type: 'unarchived', session: restored });
      } else {
        wsSend(ws, { type: 'error', message: 'Session not found' });
      }
      break;
    }

    case 'list_archived': {
      wsSend(ws, { type: 'archived_list', sessions: listArchivedSessions() });
      break;
    }

    case 'attach': {
      if (!msg.sessionId) {
        wsSend(ws, { type: 'error', message: 'sessionId is required' });
        return;
      }
      // Detach from previous session
      const prev = ctx.getAttached();
      if (prev) unsubscribe(prev, ws);

      ctx.setAttached(msg.sessionId);
      subscribe(msg.sessionId, ws);

      const session = getSession(msg.sessionId);
      if (session) {
        wsSend(ws, { type: 'session', session });
      }

      // Replay history
      const events = getHistory(msg.sessionId);
      wsSend(ws, { type: 'history', events });
      break;
    }

    case 'send': {
      const sessionId = ctx.getAttached();
      if (!sessionId) {
        wsSend(ws, { type: 'error', message: 'Not attached to a session. Send "attach" first.' });
        return;
      }
      if (!msg.text || typeof msg.text !== 'string') {
        wsSend(ws, { type: 'error', message: 'text is required' });
        return;
      }
      const sendOptions = role === 'visitor'
        ? {}
        : {
            tool: msg.tool || undefined,
            thinking: !!msg.thinking,
            model: msg.model || undefined,
            effort: msg.effort || undefined,
          };
      sendMessage(sessionId, msg.text.trim(), msg.images, sendOptions);
      break;
    }

    case 'cancel': {
      const sessionId = ctx.getAttached();
      if (!sessionId) {
        wsSend(ws, { type: 'error', message: 'Not attached to a session' });
        return;
      }
      cancelSession(sessionId);
      break;
    }

    case 'resume_interrupted': {
      const sessionId = ctx.getAttached();
      if (!sessionId) {
        wsSend(ws, { type: 'error', message: 'Not attached to a session' });
        return;
      }
      if (!resumeInterruptedSession(sessionId)) {
        wsSend(ws, { type: 'error', message: 'Interrupted run is not recoverable' });
      }
      break;
    }

    case 'compact': {
      const sessionId = ctx.getAttached();
      if (!sessionId) {
        wsSend(ws, { type: 'error', message: 'Not attached to a session' });
        return;
      }
      compactSession(sessionId);
      break;
    }

    case 'drop_tools': {
      const sessionId = ctx.getAttached();
      if (!sessionId) {
        wsSend(ws, { type: 'error', message: 'Not attached to a session' });
        return;
      }
      dropToolUse(sessionId);
      break;
    }

    default:
      wsSend(ws, { type: 'error', message: `Unknown action: ${msg.action}` });
  }
}
