import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONFIG_DIR } from '../lib/config.mjs';
import { findIdentity, getAuthReadSnapshot, SYSTEM_PERSON_ID } from '../lib/auth-config.mjs';
import { DEFAULT_JEV_TIER_PROFILES, JEV_AUTO_MODEL_ID } from '../lib/jev-auto-router.mjs';
import { getToolDefinitionAsync } from '../lib/tools.mjs';
import { getModelsForTool } from './models.mjs';
import { buildPiModelRouteId, resolvePiModelRoute } from './pi-models.mjs';

const CONFIG_FILE = join(CONFIG_DIR, 'runtime-experiments.json');
const OVERRIDE_FIELDS = new Set(['tool', 'model', 'effort']);
const nonempty = value => typeof value === 'string' && value.trim() !== '';

export function validateRuntimeExperiments(config) {
  if (!Array.isArray(config?.experiments)) throw new Error('experiments must be an array');
  const ids = new Set();
  for (const experiment of config.experiments) {
    const { id, enabled, personIds, tiers, probability, override } = experiment || {};
    if (!nonempty(id) || ids.has(id) || typeof enabled !== 'boolean'
        || !Array.isArray(personIds) || !personIds.length || !personIds.every(nonempty)
        || (tiers !== undefined && (!Array.isArray(tiers) || !tiers.length
          || !tiers.every(tier => Object.hasOwn(DEFAULT_JEV_TIER_PROFILES, tier))))
        || !Number.isFinite(probability) || probability < 0 || probability > 1
        || !override || typeof override !== 'object' || Array.isArray(override)
        || !Object.keys(override).length
        || !Object.entries(override).every(([key, value]) => OVERRIDE_FIELDS.has(key) && nonempty(value))) {
      throw new Error('Invalid runtime experiment configuration');
    }
    ids.add(id);
  }
  return config.experiments;
}

async function readExperiments() {
  try {
    return validateRuntimeExperiments(JSON.parse(await readFile(CONFIG_FILE, 'utf8')));
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`[runtime-experiments] Unable to load configuration (${error.code || error.name})`);
    return [];
  }
}

function eligiblePerson(session, options, document) {
  if (!session.id || !session.creatorIdentityId || session.groupFeed || session.autoRouting
      || options.usageActorKind !== 'human' || options.internalOperation || options.nativeQuestionId
      || options.workReference || options.routingSource || options.routingRethink) return '';
  const personId = options.viewPersonId;
  if (!personId || personId === SYSTEM_PERSON_ID) return '';
  const initiator = findIdentity(document, options.initiatedByIdentityId)?.person.id;
  const owner = findIdentity(document, session.creatorIdentityId)?.person.id;
  return initiator === personId && owner === personId ? personId : '';
}

function experimentBucket(id, personId, sessionId) {
  return createHash('sha256').update(JSON.stringify([id, personId, sessionId])).digest().readUInt32BE(0) / 2 ** 32;
}

async function resolveVariant(baseline, override, { loadTool, loadModels }) {
  const variant = { ...baseline, ...override };
  if (!(await loadTool(variant.tool))?.available) return { reason: 'tool_unavailable' };
  if (variant.tool === 'pi') {
    const { provider, model } = resolvePiModelRoute(variant.model);
    variant.model = buildPiModelRouteId(provider, model);
  }
  const catalog = await loadModels(variant.tool);
  const model = catalog.models?.find(record => record.id === variant.model && record.id !== JEV_AUTO_MODEL_ID);
  if (!model) return { reason: 'model_unavailable' };
  if (variant.effort && !model.reasoning?.levels?.includes(variant.effort)) return { reason: 'effort_unavailable' };
  return { variant };
}

// Authenticated user admissions only. The same Session ID always selects the
// same arm. The caller stores this receipt with the accepted runtime snapshot.
export async function applyRuntimeExperiment(route, session, options, {
  read = readExperiments,
  getDocument = getAuthReadSnapshot,
  loadTool = getToolDefinitionAsync,
  loadModels = getModelsForTool,
} = {}) {
  const receipt = route.autoRoutingReceipt;
  if (!receipt) return route;
  const personId = eligiblePerson(session, options, getDocument());
  if (!personId) return route;
  const tier = receipt.decision?.tier || 'quality';
  const experiment = (await read()).find(rule => rule.enabled && rule.personIds.includes(personId)
    && (!rule.tiers || rule.tiers.includes(tier)));
  if (!experiment) return route;

  const baseline = { tool: route.tool, model: route.model, effort: route.effort };
  const { id, probability } = experiment;
  const arm = experimentBucket(id, personId, session.id) < probability ? 'variant' : 'control';
  let variant = baseline;
  let reason;
  if (arm === 'variant') {
    try {
      const resolved = await resolveVariant(baseline, experiment.override, { loadTool, loadModels });
      variant = resolved.variant || baseline;
      reason = resolved.reason;
    } catch (error) {
      console.warn(`[runtime-experiments] Unable to validate variant (${error.code || error.name})`);
      reason = 'variant_check_failed';
    }
  }
  return {
    ...route,
    ...variant,
    autoRoutingReceipt: {
      ...receipt,
      route: variant,
      experiment: { id, tier, arm, probability, status: reason ? 'unavailable' : 'assigned', baseline,
        ...(reason ? { reason } : {}) },
    },
  };
}
