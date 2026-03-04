import { WebSocketServer } from 'ws';
import { isAuthenticated, parseCookies } from '../lib/auth.mjs';
import {
  createSession, deleteSession, getSession, listSessions,
  subscribe, unsubscribe, sendMessage, cancelSession, getHistory,
  renameSession, compactSession, dropToolUse,
} from './session-manager.mjs';

/**
 * Attach WebSocket handling to an HTTP server.
 */
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 });

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
      wss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    let attachedSessionId = null;
    console.log('[ws] Client connected');

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

function handleMessage(ws, msg, ctx) {
  switch (msg.action) {
    case 'list': {
      const sessions = listSessions();
      wsSend(ws, { type: 'sessions', sessions });
      break;
    }

    case 'create': {
      if (!msg.folder || !msg.tool) {
        wsSend(ws, { type: 'error', message: 'folder and tool are required' });
        return;
      }
      const session = createSession(msg.folder, msg.tool, msg.name || '');
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

    case 'delete': {
      if (!msg.sessionId) {
        wsSend(ws, { type: 'error', message: 'sessionId is required' });
        return;
      }
      const ok = deleteSession(msg.sessionId);
      if (ok) {
        wsSend(ws, { type: 'deleted', sessionId: msg.sessionId });
      } else {
        wsSend(ws, { type: 'error', message: 'Session not found' });
      }
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
      sendMessage(sessionId, msg.text.trim(), msg.images, {
        tool: msg.tool || undefined,
        thinking: !!msg.thinking,
      });
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
