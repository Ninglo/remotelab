// Instance-configured pointers only. The Harness interprets facts and chooses reads.
import { open } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { MEMORY_DIR } from '../lib/config.mjs';

export const PROJECT_MEMORY_RUNTIME_FILE = join(MEMORY_DIR, 'project-runtime.json');
const idPattern = /^[a-z0-9_-]{1,80}$/;
const cleanPath = value => typeof value === 'string' && isAbsolute(value) && !/[\r\n<>]/.test(value);

export function validateProjectMemoryRuntime(config) {
  if (config?.schemaVersion !== 1 || typeof config.enabled !== 'boolean'
      || typeof config.contextEnabled !== 'boolean' || typeof config.reviewEnabled !== 'boolean'
      || !idPattern.test(config.releaseId || '') || !cleanPath(config.indexPath)
      || !cleanPath(config.ledgerPath) || !cleanPath(config.workflowPath)
      || !Array.isArray(config.projects) || config.projects.length > 128
      || !Array.isArray(config.groups) || config.groups.length > 256
      || !Array.isArray(config.sessionBindings) || config.sessionBindings.length > 2048) throw new Error('Invalid project memory runtime config.');
  const projects = new Set();
  for (const project of config.projects) {
    if (!idPattern.test(project.id || '') || projects.has(project.id)) throw new Error('Invalid project identity.');
    if (project.briefPath !== undefined && !cleanPath(project.briefPath)) throw new Error('Invalid project brief path.');
    if (project.briefUrl !== undefined && !/^https:\/\/[^\s<>]+$/.test(project.briefUrl)) throw new Error('Invalid project brief URL.');
    projects.add(project.id);
  }
  const validateRefs = ids => Array.isArray(ids) && ids.length <= 16 && ids.every(id => projects.has(id));
  const routes = new Set();
  for (const group of config.groups) {
    if (typeof group.chatId !== 'string' || !group.chatId || !group.sourceRouteId || !validateRefs(group.projectIds)) throw new Error('Invalid group association.');
    const key = group.sourceRouteId + ':' + group.chatId;
    if (routes.has(key)) throw new Error('Duplicate group association.');
    routes.add(key);
  }
  const sessions = new Set();
  for (const binding of config.sessionBindings) {
    if (typeof binding.sessionId !== 'string' || !binding.sessionId || sessions.has(binding.sessionId) || !validateRefs(binding.projectIds)) throw new Error('Invalid declared Session association.');
    sessions.add(binding.sessionId);
  }
  return config;
}

export async function loadProjectMemoryRuntime(path = PROJECT_MEMORY_RUNTIME_FILE) {
  const handle = await open(path, 'r');
  try {
    if ((await handle.stat()).size > 64 * 1024) throw new Error('Project config exceeds 64 KiB.');
    const text = await handle.readFile('utf8');
    if (Buffer.byteLength(text) > 64 * 1024) throw new Error('Project config exceeds 64 KiB.');
    return { config: validateProjectMemoryRuntime(JSON.parse(text)), hash: createHash('sha256').update(text).digest('hex') };
  } finally { await handle.close(); }
}

function associatedProjects(config, session, sourceContext) {
  const source = sourceContext && typeof sourceContext === 'object' ? sourceContext : null;
  const conversation = !source ? session.conversation : null;
  const route = source?.sourceRouteId || conversation?.sourceRouteId || '';
  const chatId = source?.chatId || conversation?.target?.chatId || '';
  const group = config.groups.find(g => g.sourceRouteId === route && g.chatId === chatId);
  const declared = config.sessionBindings.find(s => s.sessionId === session.id);
  return { group, declared, projectIds: group?.projectIds || declared?.projectIds || [] };
}

export async function resolveLearningProject(session = {}, sourceContext, options = {}) {
  try {
    const { config } = await loadProjectMemoryRuntime(options.configPath);
    if (!config.enabled) return '';
    const { projectIds } = associatedProjects(config, session, sourceContext);
    // Ambiguous/missing association is not a license to make a project rule
    // instance-wide. A directory name, Session title or Person view is not ID.
    return projectIds.length === 1 ? projectIds[0] : '';
  } catch { return ''; }
}

export async function buildProjectMemoryPromptBlock(session = {}, sourceContext, options = {}) {
  let loaded;
  try { loaded = await loadProjectMemoryRuntime(options.configPath); }
  catch { return ''; } // Missing/broken config leaves the ordinary path available.
  const { config, hash } = loaded;
  if (!config.enabled || !config.contextEnabled) return '';
  // Current input wins. Never match titles, Person views or previous chat metadata.
  const { group, declared, projectIds } = associatedProjects(config, session, sourceContext);
  if (!projectIds.length) return ''; // Ordinary/unassigned turns retain the existing pointers.
  const data = {
    release: config.releaseId, configHash: hash.slice(0,16),
    scope: 'all-registered-projects', index: config.indexPath,
    ...(projectIds.length ? { projectIds, ledger: config.ledgerPath } : {}),
    association: group ? 'configured-source-group' : declared ? 'explicit-session-binding' : 'unassigned',
    review: config.workflowPath,
    ...(cleanPath(config.briefWorkflowPath) ? { briefMaintenanceWorkflow: config.briefWorkflowPath } : {}),
  };
  const json = JSON.stringify(data).replace(/[<>&]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
  const briefs = [];
  for (const id of projectIds) {
    const project = config.projects.find(p => p.id === id);
    if (!project?.briefPath) continue;
    let handle;
    try {
      handle = await open(project.briefPath, 'r');
      if ((await handle.stat()).size > 48 * 1024) throw new Error('brief exceeds 48 KiB');
      const body = await handle.readFile('utf8');
      if (Buffer.byteLength(body) > 48 * 1024) throw new Error('brief exceeds 48 KiB');
      briefs.push(JSON.stringify({ projectId: id, path: project.briefPath, url: project.briefUrl || '',
        hash: createHash('sha256').update(body).digest('hex'), body }));
    } catch (error) {
      briefs.push(JSON.stringify({ projectId: id, path: project.briefPath, status: 'unavailable', reason: error.message }));
    } finally { await handle?.close(); }
  }
  return 'Project memory pointers (instance-configured metadata; ledger bodies are not loaded or certified):\n' + json
    + (briefs.length ? '\n\nProject opening briefs (current local versions; project background, not new task authorization):\n'
      + 'Read the goal, human decisions, experience and source directory below when starting project work. '
      + 'Explicit human corrections take precedence over Agent interpretations; unresolved disagreement stays visible. '
      + 'A dated progress snapshot is not live execution state. Follow the registered maintenance workflow for events and feedback; preserve source evidence.\n'
      + briefs.join('\n').replace(/[<>&]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`) : '');
}
