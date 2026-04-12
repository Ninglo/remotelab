import { WebSocketServer } from 'ws';
import { isAuthenticated, getAuthSession } from '../lib/auth.mjs';
import { setWss } from './ws-clients.mjs';
import { getPageBuildInfo } from './router.mjs';
import { bindDoubaoVoiceRelaySocket, DOUBAO_VOICE_WS_PATH } from './voice-doubao-relay.mjs';

function sendJson(ws, payload) {
  if (ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {}
}

async function sendBuildInfo(ws) {
  try {
    const buildInfo = await getPageBuildInfo();
    if (ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'build_info', buildInfo }));
  } catch (error) {
    console.warn(`[build] failed to send websocket build info: ${error.message}`);
  }
}

export function attachWebSocket(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const voiceRelayWss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
  setWss(wss);

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname !== '/ws' && url.pathname !== DOUBAO_VOICE_WS_PATH) {
      socket.destroy();
      return;
    }

    if (!isAuthenticated(req)) {
      if (url.pathname === DOUBAO_VOICE_WS_PATH) {
        console.warn(`[voice-relay] rejected unauthenticated websocket upgrade path=${url.pathname}`);
      }
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const targetWss = url.pathname === DOUBAO_VOICE_WS_PATH
      ? voiceRelayWss
      : wss;
    targetWss.handleUpgrade(req, socket, head, (ws) => {
      ws._authSession = getAuthSession(req);
      targetWss.emit('connection', ws, req);
    });
  });

  wss.on('connection', (ws) => {
    const role = ws._authSession?.role || 'owner';
    console.log(`[ws] Client connected (role=${role})`);
    void sendBuildInfo(ws);

    ws.on('message', () => {
      try {
        ws.close(1008, 'Push-only WebSocket');
      } catch {}
    });

    ws.on('close', () => {
      console.log(`[ws] Client disconnected (role=${role})`);
    });
  });

  voiceRelayWss.on('connection', (ws) => {
    const role = ws._authSession?.role || 'owner';
    console.log(`[voice-relay] client connected (role=${role})`);
    bindDoubaoVoiceRelaySocket(ws);
  });

  return wss;
}
