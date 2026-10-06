// Explicit, authenticated inspection only; never a prompt or background reader.
import { join, dirname } from 'node:path';
import { readMemoryDocument as document } from './memory-document.mjs';
import { MEMORY_DIR } from '../lib/config.mjs';
import { loadProjectMemoryRuntime } from './project-memory-runtime.mjs';
import { readMemoryFileCatalog } from './memory-file-catalog.mjs';

export async function readMemoryContextView({ people = [], personId = '', memoryDir = MEMORY_DIR, configPath } = {}) {
  // Validate against actual Person records, never a caller-provided file path.
  if (personId && (!/^[a-zA-Z0-9_-]{1,100}$/.test(personId) || !people.some(person => person.id === personId))) {
    const error = new Error('Unknown Person'); error.statusCode = 400; throw error;
  }
  let runtime = { status: 'unavailable' };
  let projectConfig;
  let projectIndex = { status: 'unavailable' }, projectLedger = { status: 'unavailable' }, chronology = { status: 'not-recorded' };
  try {
    const { config, hash } = await loadProjectMemoryRuntime(configPath);
    projectConfig = config;
    runtime = {
      status: 'available', release: config.releaseId, enabled: config.enabled,
      contextEnabled: config.contextEnabled, reviewEnabled: config.reviewEnabled, hash: hash.slice(0,16),
      projects: config.projects.map(({ id }) => ({ id, sourceGroups: config.groups.filter(group => group.projectIds.includes(id)).length,
        declaredSessions: config.sessionBindings.filter(binding => binding.projectIds.includes(id)).length })),
      sourceGroups: config.groups.length, declaredSessions: config.sessionBindings.length,
    };
    [projectIndex, projectLedger, chronology] = await Promise.all([document(config.indexPath, 64 * 1024), document(config.ledgerPath, 1024 * 1024), document(join(dirname(config.workflowPath), 'chronology.json'), 128 * 1024)]);
    if (chronology.status === 'available') {
      try {
        const data = JSON.parse(chronology.text);
        if (data.schemaVersion !== 1 || !Array.isArray(data.events) || data.events.length > 512
          || !data.events.every(event => typeof event.id === 'string' && Array.isArray(event.projectIds) && event.projectIds.every(id => config.projects.some(project => project.id === id))
            && typeof event.summary === 'string' && event.time && typeof event.time.kind === 'string'
            && Array.isArray(event.actors) && event.actors.every(actor => actor && typeof actor.name === 'string' && typeof actor.role === 'string')
            && event.source && typeof event.source.path === 'string')) throw new Error('Invalid chronology');
        const { text, ...metadata } = chronology;
        chronology = { ...metadata, data, stale: projectLedger.status !== 'available' || data.ledgerHash !== projectLedger.hash };
      } catch { chronology = { status: 'invalid' }; }
    }
  } catch { /* Inspection remains useful when this optional runtime is absent. */ }
  const [company, personal] = await Promise.all([
    document(join(memoryDir, 'reference', 'company.md'), 32 * 1024),
    personId ? document(join(memoryDir, 'reference', 'people', `${personId}.md`), 16 * 1024) : Promise.resolve({ status: 'select-person' }),
  ]);
  const fileCatalog = await readMemoryFileCatalog({ memoryDir, projectConfig });
  return { generatedAt: new Date().toISOString(), runtime, projectIndex, projectLedger, chronology,
    people: people.map(({ id, name }) => ({ id, name })), personId, personal, company, fileCatalog,
    boundary: 'Authenticated instance view. Registration is not complete coverage; file contents are recorded knowledge, not live business state or personal ownership certification.' };
}
