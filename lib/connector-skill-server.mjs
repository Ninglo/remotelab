import { createServer } from 'node:http';

const MAX_REQUEST_BYTES = 1024 * 1024;

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0, must-revalidate',
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > MAX_REQUEST_BYTES) {
      const error = new Error('Connector skill request is too large');
      error.code = 'request_too_large';
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks, totalBytes).toString('utf8'));
  } catch {
    const error = new Error('Connector skill request must be valid JSON');
    error.code = 'invalid_json';
    error.statusCode = 400;
    throw error;
  }
}

function resolveBoundHost(host, address) {
  const normalized = trimString(address?.address || host);
  if (!normalized || normalized === '::' || normalized === '0.0.0.0') return '127.0.0.1';
  const unwrapped = normalized.replace(/^\[|\]$/g, '');
  return unwrapped.includes(':') ? `[${unwrapped}]` : unwrapped;
}

export async function startConnectorSkillServer(options = {}) {
  const channel = trimString(options.channel).toLowerCase();
  const token = trimString(options.token);
  const skills = Array.isArray(options.skills)
    ? options.skills.filter((skill) => trimString(skill?.name))
    : [];
  const onSkill = typeof options.onSkill === 'function' ? options.onSkill : null;
  const host = trimString(options.host) || '127.0.0.1';
  const port = Number.isInteger(options.port) && options.port >= 0 ? options.port : 0;
  if (!channel) throw new Error('connector skill server requires channel');
  if (!token) throw new Error('connector skill server requires a callback token');
  if (skills.length === 0) throw new Error('connector skill server requires at least one skill');
  if (!onSkill) throw new Error('connector skill server requires onSkill');

  const skillNames = skills.map((skill) => trimString(skill.name));
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/healthz') {
      sendJson(res, 200, { ok: true, channel, skills: skillNames });
      return;
    }
    if (req.method !== 'POST' || !url.pathname.startsWith('/skill/')) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const bearer = trimString(req.headers.authorization).replace(/^Bearer\s+/i, '');
    if (bearer !== token) {
      sendJson(res, 401, { error: 'invalid_callback_token' });
      return;
    }
    const skillName = decodeURIComponent(url.pathname.slice('/skill/'.length));
    if (!skillNames.includes(skillName)) {
      sendJson(res, 404, { error: 'skill_not_found', available: skillNames });
      return;
    }
    try {
      const body = await readJsonBody(req);
      const result = await onSkill(skillName, body);
      sendJson(res, 200, { success: true, result });
    } catch (error) {
      sendJson(res, Number.isInteger(error?.statusCode) ? error.statusCode : 502, {
        success: false,
        error: trimString(error?.code) || 'skill_execution_failed',
        message: trimString(error?.message) || 'Connector skill execution failed',
        ...(error?.details && typeof error.details === 'object' ? { details: error.details } : {}),
      });
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;
  const baseUrl = `http://${resolveBoundHost(host, address)}:${boundPort}`;
  return {
    baseUrl,
    skillUrl: `${baseUrl}/skill`,
    async stop() {
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
