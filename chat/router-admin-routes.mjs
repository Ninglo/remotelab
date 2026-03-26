import { getAuthSession } from '../lib/auth.mjs';
import { readBody } from '../lib/utils.mjs';
import {
  listApps,
  getApp,
  createApp,
  updateApp,
  deleteApp,
  isBuiltinAppId,
} from './apps.mjs';
import {
  createUser,
  deleteUser,
  getUser,
  listUsers,
  updateUser,
} from './users.mjs';
import {
  createVisitor,
  deleteVisitor,
  listVisitors,
  updateVisitor,
} from './visitors.mjs';

export async function handleAdminRoutes({
  req,
  res,
  pathname,
  writeJsonCached,
  createClientSessionDetail,
  normalizeSessionFolderInput,
  resolveTemplateApps,
  ensureUserSeedSession,
}) {
function writeRetiredManagementSurface(message) {
  res.writeHead(410, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: message, retired: true }));
}

if ((pathname === '/api/apps' || pathname.startsWith('/api/apps/')) && req.method !== 'OPTIONS') {
  writeRetiredManagementSurface('Apps have been removed from the current product surface');
  return true;
}

if ((pathname === '/api/users' || pathname.startsWith('/api/users/')) && req.method !== 'OPTIONS') {
  writeRetiredManagementSurface('Users have been removed from the current product surface');
  return true;
}

// ---- App CRUD APIs (retired) ----

if (pathname === '/api/apps' && req.method === 'GET') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  writeJsonCached(req, res, { apps: await listApps() });
  return true;
}

if (pathname === '/api/apps' && req.method === 'POST') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  let body;
  try { body = await readBody(req, 10240); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return true;
  }
  try {
    const { name, systemPrompt, welcomeMessage, skills, tool } = JSON.parse(body);
    const app = await createApp({ name, systemPrompt, welcomeMessage, skills, tool });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ app }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
  return true;
}

if (pathname.startsWith('/api/apps/') && req.method === 'PATCH') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  const id = pathname.split('/').pop();
  if (isBuiltinAppId(id)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Built-in apps cannot be modified' }));
    return true;
  }
  let body;
  try { body = await readBody(req, 10240); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return true;
  }
  try {
    const updates = JSON.parse(body);
    const updated = await updateApp(id, updates);
    if (updated) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: updated }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'App not found' }));
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
  return true;
}

if (pathname.startsWith('/api/apps/') && req.method === 'DELETE') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  const id = pathname.split('/').pop();
  if (isBuiltinAppId(id)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Built-in apps cannot be deleted' }));
    return true;
  }
  const ok = await deleteApp(id);
  if (ok) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'App not found' }));
  }
  return true;
}

// ---- User profile APIs (owner only) ----

if (pathname === '/api/users' && req.method === 'GET') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  writeJsonCached(req, res, { users: await listUsers() });
  return true;
}

if (pathname === '/api/users' && req.method === 'POST') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  let body;
  try { body = await readBody(req, 16384); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return true;
  }
  try {
    const payload = JSON.parse(body);
    const apps = await resolveTemplateApps(payload.appIds);
    if (apps.length === 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'At least one template app is required' }));
      return true;
    }
    const defaultAppId = typeof payload.defaultAppId === 'string' && payload.defaultAppId.trim()
      ? payload.defaultAppId.trim()
      : apps[0].id;
    if (!apps.some((app) => app.id === defaultAppId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'defaultAppId must be one of the allowed apps' }));
      return true;
    }
    const folder = await normalizeSessionFolderInput(payload.folder);
    if (!folder) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Folder does not exist' }));
      return true;
    }
    const user = await createUser({
      name: typeof payload.name === 'string' ? payload.name : '',
      appIds: apps.map((app) => app.id),
      defaultAppId,
      language: typeof payload.language === 'string' ? payload.language : 'auto',
    });
    const session = payload.autoCreateSession === false
      ? null
      : await ensureUserSeedSession(user, {
        folder,
        tool: typeof payload.tool === 'string' ? payload.tool.trim() : '',
      });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ user, session: createClientSessionDetail(session) }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
  return true;
}

if (pathname.startsWith('/api/users/') && req.method === 'PATCH') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  const id = pathname.split('/').pop();
  let body;
  try { body = await readBody(req, 16384); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return true;
  }
  try {
    const payload = JSON.parse(body);
    const updates = {};
    if (typeof payload.name === 'string') {
      updates.name = payload.name;
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'language')) {
      updates.language = typeof payload.language === 'string' ? payload.language : 'auto';
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'shareVisitorId')) {
      updates.shareVisitorId = typeof payload.shareVisitorId === 'string'
        ? payload.shareVisitorId.trim()
        : '';
    }
    if (Object.prototype.hasOwnProperty.call(payload, 'appIds')) {
      const apps = await resolveTemplateApps(payload.appIds);
      if (apps.length === 0) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'At least one template app is required' }));
        return true;
      }
      updates.appIds = apps.map((app) => app.id);
      if (typeof payload.defaultAppId === 'string' && payload.defaultAppId.trim()) {
        if (!updates.appIds.includes(payload.defaultAppId.trim())) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'defaultAppId must be one of the allowed apps' }));
          return true;
        }
        updates.defaultAppId = payload.defaultAppId.trim();
      }
    } else if (typeof payload.defaultAppId === 'string' && payload.defaultAppId.trim()) {
      updates.defaultAppId = payload.defaultAppId.trim();
    }
    const updated = await updateUser(id, updates);
    if (updated) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ user: updated }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'User not found' }));
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
  return true;
}

if (pathname.startsWith('/api/users/') && req.method === 'DELETE') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  const id = pathname.split('/').pop();
  const user = await getUser(id);
  const ok = await deleteUser(id);
  if (ok) {
    if (user?.shareVisitorId) {
      await deleteVisitor(user.shareVisitorId).catch(() => false);
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'User not found' }));
  }
  return true;
}

// ---- Visitor preset APIs (owner only) ----

if (pathname === '/api/visitors' && req.method === 'GET') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  writeJsonCached(req, res, { visitors: await listVisitors() });
  return true;
}

if (pathname === '/api/visitors' && req.method === 'POST') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  let body;
  try { body = await readBody(req, 10240); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return true;
  }
  try {
    const { name, appId, language } = JSON.parse(body);
    const app = await getApp(appId);
    if (!app || app.shareEnabled === false) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Shareable app is required' }));
      return true;
    }
    const visitor = await createVisitor({
      name,
      appId: app.id,
      language: typeof language === 'string' ? language : 'auto',
    });
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ visitor }));
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
  return true;
}

if (pathname.startsWith('/api/visitors/') && req.method === 'PATCH') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  const id = pathname.split('/').pop();
  let body;
  try { body = await readBody(req, 10240); } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Bad request' }));
    return true;
  }
  try {
    const updates = JSON.parse(body);
    if (updates.appId) {
      const app = await getApp(updates.appId);
      if (!app || app.shareEnabled === false) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Shareable app is required' }));
        return true;
      }
    }
    const updated = await updateVisitor(id, updates);
    if (updated) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ visitor: updated }));
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Visitor not found' }));
    }
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid request body' }));
  }
  return true;
}

if (pathname.startsWith('/api/visitors/') && req.method === 'DELETE') {
  const authSession = getAuthSession(req);
  if (authSession?.role !== 'owner') {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Owner access required' }));
    return true;
  }
  const id = pathname.split('/').pop();
  const ok = await deleteVisitor(id);
  if (ok) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  } else {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Visitor not found' }));
  }
  return true;
}


  return false;
}
