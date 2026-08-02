import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { extractFeishuDocumentToken } from './index.mjs';

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_LARK_CLI_PATH = resolve(MODULE_DIR, '../../node_modules/.bin/lark-cli');
const DEFAULT_MAX_CHARS = 120_000;
const ABSOLUTE_MAX_CHARS = 200_000;
const DEFAULT_MAX_MEDIA = 20;
const ABSOLUTE_MAX_MEDIA = 50;
const LARK_CLI_MAX_BUFFER = 32 * 1024 * 1024;
const LARK_CLI_TIMEOUT_MS = 60_000;

const VALID_SCOPES = new Set(['full', 'outline', 'section', 'range', 'keyword']);
const VALID_DETAILS = new Set(['simple', 'with-ids', 'full']);
const VALID_DOC_FORMATS = new Set(['xml', 'markdown', 'im-markdown']);

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function trimScalarString(value) {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

function createProviderError(code, message, statusCode = 502, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function normalizePositiveInteger(value, fallback, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), maximum);
}

function normalizeOptionalInteger(value, name, minimum = -1) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw createProviderError(
      'document_parameters_invalid',
      `${name} must be an integer greater than or equal to ${minimum}.`,
      400,
    );
  }
  return parsed;
}

function normalizeEnum(value, allowed, fallback, name) {
  const normalized = trimString(value).toLowerCase() || fallback;
  if (!allowed.has(normalized)) {
    throw createProviderError(
      'document_parameters_invalid',
      `${name} must be one of: ${[...allowed].join(', ')}.`,
      400,
    );
  }
  return normalized;
}

function normalizeFetchParameters(parameters = {}) {
  const documentToken = extractFeishuDocumentToken(parameters.documentToken || parameters.documentUrl);
  if (!documentToken) {
    throw createProviderError(
      'document_token_invalid',
      'A valid Feishu Docx URL or document token is required.',
      400,
    );
  }
  const scope = normalizeEnum(parameters.scope, VALID_SCOPES, 'full', 'scope');
  const detail = normalizeEnum(parameters.detail, VALID_DETAILS, 'simple', 'detail');
  const docFormat = normalizeEnum(parameters.docFormat, VALID_DOC_FORMATS, 'xml', 'docFormat');
  const startBlockId = trimScalarString(parameters.startBlockId);
  const endBlockId = trimScalarString(parameters.endBlockId);
  const keyword = trimString(parameters.keyword);
  if (scope === 'section' && !startBlockId) {
    throw createProviderError(
      'document_parameters_invalid',
      'startBlockId is required when scope is section.',
      400,
    );
  }
  if (scope === 'range' && !startBlockId && !endBlockId) {
    throw createProviderError(
      'document_parameters_invalid',
      'startBlockId or endBlockId is required when scope is range.',
      400,
    );
  }
  if (scope === 'keyword' && !keyword) {
    throw createProviderError(
      'document_parameters_invalid',
      'keyword is required when scope is keyword.',
      400,
    );
  }
  return {
    documentToken,
    scope,
    detail,
    docFormat,
    startBlockId,
    endBlockId,
    keyword,
    revisionId: normalizeOptionalInteger(parameters.revisionId, 'revisionId'),
    contextBefore: normalizeOptionalInteger(parameters.contextBefore, 'contextBefore', 0),
    contextAfter: normalizeOptionalInteger(parameters.contextAfter, 'contextAfter', 0),
    maxDepth: normalizeOptionalInteger(parameters.maxDepth, 'maxDepth'),
    maxChars: normalizePositiveInteger(parameters.maxChars, DEFAULT_MAX_CHARS, ABSOLUTE_MAX_CHARS),
    downloadMedia: parameters.downloadMedia === true || trimString(parameters.downloadMedia).toLowerCase() === 'true',
    maxMedia: normalizePositiveInteger(parameters.maxMedia, DEFAULT_MAX_MEDIA, ABSOLUTE_MAX_MEDIA),
  };
}

function appendOptionalArg(args, name, value) {
  if (value === null || value === undefined || value === '') return;
  args.push(name, String(value));
}

function buildFetchArgs(parameters) {
  const args = [
    'docs', '+fetch',
    '--doc', parameters.documentToken,
    '--as', 'bot',
    '--format', 'json',
    '--doc-format', parameters.docFormat,
    '--detail', parameters.detail,
    '--scope', parameters.scope,
  ];
  appendOptionalArg(args, '--start-block-id', parameters.startBlockId);
  appendOptionalArg(args, '--end-block-id', parameters.endBlockId);
  appendOptionalArg(args, '--keyword', parameters.keyword);
  appendOptionalArg(args, '--revision-id', parameters.revisionId);
  appendOptionalArg(args, '--context-before', parameters.contextBefore);
  appendOptionalArg(args, '--context-after', parameters.contextAfter);
  appendOptionalArg(args, '--max-depth', parameters.maxDepth);
  return args;
}

function buildLarkCliEnvironment(configDir) {
  const environment = {};
  for (const name of [
    'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP',
    'LANG', 'LC_ALL', 'LC_CTYPE',
    'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy',
  ]) {
    if (typeof process.env[name] === 'string' && process.env[name]) {
      environment[name] = process.env[name];
    }
  }
  environment.LARKSUITE_CLI_CONFIG_DIR = configDir;
  environment.LARKSUITE_CLI_NO_UPDATE_NOTIFIER = '1';
  environment.LARKSUITE_CLI_NO_SKILLS_NOTIFIER = '1';
  return environment;
}

export function runLarkCliCommand(request = {}) {
  return new Promise((resolveCommand, rejectCommand) => {
    const child = execFile(
      request.command,
      Array.isArray(request.args) ? request.args : [],
      {
        cwd: request.cwd,
        env: request.env,
        encoding: 'utf8',
        maxBuffer: Number.isInteger(request.maxBuffer) ? request.maxBuffer : LARK_CLI_MAX_BUFFER,
        timeout: Number.isInteger(request.timeoutMs) ? request.timeoutMs : LARK_CLI_TIMEOUT_MS,
      },
      (error, stdout = '', stderr = '') => {
        if (error) {
          error.stdout = String(stdout || '');
          error.stderr = String(stderr || '');
          rejectCommand(error);
          return;
        }
        resolveCommand({ stdout: String(stdout || ''), stderr: String(stderr || '') });
      },
    );
    child.stdin?.on('error', () => {});
    child.stdin?.end(typeof request.stdin === 'string' ? request.stdin : '');
  });
}

function parseJsonObject(value) {
  const text = trimString(value);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function findNestedString(value, keys, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 5) return '';
  for (const key of keys) {
    const candidate = trimString(value[key]);
    if (candidate) return candidate;
  }
  for (const child of Object.values(value)) {
    if (!child || typeof child !== 'object') continue;
    const candidate = findNestedString(child, keys, depth + 1);
    if (candidate) return candidate;
  }
  return '';
}

function normalizeLarkCliFailure(error) {
  if (error?.code && String(error.code).startsWith('document_')) return error;
  if (error?.code === 'missing_scope' || error?.code === 'connector_unavailable') return error;
  const stderrPayload = parseJsonObject(error?.stderr);
  const stdoutPayload = parseJsonObject(error?.stdout);
  const payload = stderrPayload || stdoutPayload || {};
  const message = findNestedString(payload, ['message', 'msg', 'hint']) || trimString(error?.message) || 'lark-cli failed';
  const searchable = `${JSON.stringify(payload)} ${message}`;
  const consoleUrl = findNestedString(payload, ['console_url', 'consoleUrl']);
  const details = {
    ...(Number.isInteger(error?.code) ? { exitCode: error.code } : {}),
    ...(consoleUrl ? { consoleUrl } : {}),
  };
  if (/99991672|99991679|missing[_\s-]*scope|scope.*required|token_scope_insufficient/i.test(searchable)) {
    return createProviderError(
      'missing_scope',
      'The Feishu app is missing the required document read scope.',
      403,
      details,
    );
  }
  if (/91403|forbidden|permission[_\s-]*denied|access[_\s-]*denied/i.test(searchable)) {
    return createProviderError(
      'document_permission_denied',
      'The Feishu bot app does not have permission to read this document.',
      403,
      details,
    );
  }
  if (/404|not[_\s-]*found/i.test(searchable)) {
    return createProviderError('document_not_found', 'The Feishu document was not found.', 404, details);
  }
  return createProviderError('document_read_failed', message, 502, details);
}

function parseLarkCliEnvelope(result) {
  const payload = parseJsonObject(result?.stdout);
  if (!payload) {
    throw createProviderError(
      'document_read_failed',
      'lark-cli returned an invalid JSON response.',
      502,
    );
  }
  if (payload.ok === false) {
    const error = new Error(findNestedString(payload, ['message', 'msg', 'hint']) || 'lark-cli request failed');
    error.stdout = JSON.stringify(payload);
    throw normalizeLarkCliFailure(error);
  }
  const identity = trimString(payload.identity).toLowerCase();
  if (identity && identity !== 'bot') {
    throw createProviderError(
      'document_identity_mismatch',
      `lark-cli returned ${identity} identity for a Bot-only document request.`,
      502,
    );
  }
  return payload;
}

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractTitle(content, docFormat, document) {
  const explicitTitle = trimString(document?.title || document?.name);
  if (explicitTitle) return explicitTitle;
  if (docFormat === 'xml') {
    const match = String(content || '').match(/<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/i);
    if (match) return decodeXmlEntities(match[1].replace(/<[^>]+>/g, '')).trim();
  }
  const heading = String(content || '').match(/^#\s+(.+)$/m);
  return heading ? heading[1].trim() : '';
}

function parseXmlAttributes(rawAttributes) {
  const attributes = {};
  const pattern = /([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  for (const match of rawAttributes.matchAll(pattern)) {
    attributes[match[1]] = decodeXmlEntities(match[2] ?? match[3] ?? '');
  }
  return attributes;
}

export function extractLarkDocumentMedia(content) {
  const media = [];
  const seen = new Set();
  const pattern = /<(img|source|whiteboard)\b([^>]*)\/?\s*>/gi;
  for (const match of String(content || '').matchAll(pattern)) {
    const tag = match[1].toLowerCase();
    const attributes = parseXmlAttributes(match[2]);
    const token = trimString(attributes.token);
    if (!token) continue;
    const type = tag === 'img' ? 'image' : (tag === 'source' ? 'file' : 'whiteboard');
    const key = `${type}:${token}`;
    if (seen.has(key)) continue;
    seen.add(key);
    media.push({
      index: media.length + 1,
      type,
      token,
      ...(trimString(attributes.url) ? { url: trimString(attributes.url) } : {}),
      ...(trimString(attributes.name) ? { name: trimString(attributes.name) } : {}),
    });
  }
  return media;
}

function buildSnapshotId(documentToken, document, parameters, content) {
  return createHash('sha256').update(JSON.stringify({
    documentToken,
    revisionId: document?.revision_id ?? null,
    scope: parameters.scope,
    detail: parameters.detail,
    docFormat: parameters.docFormat,
    startBlockId: parameters.startBlockId,
    endBlockId: parameters.endBlockId,
    keyword: parameters.keyword,
    contentHash: createHash('sha256').update(content).digest('hex'),
  })).digest('hex').slice(0, 24);
}

async function findDownloadedMediaPath(snapshotPath, outputRelative) {
  const outputDirectory = dirname(outputRelative);
  const outputPrefix = outputRelative.slice(outputDirectory === '.' ? 0 : outputDirectory.length + 1);
  const absoluteDirectory = join(snapshotPath, outputDirectory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  const match = entries
    .filter((entry) => entry.isFile() && (entry.name === outputPrefix || entry.name.startsWith(`${outputPrefix}.`)))
    .sort((left, right) => left.name.localeCompare(right.name))[0];
  return match ? join(absoluteDirectory, match.name) : '';
}

function mediaOutputName(item) {
  const tokenHash = createHash('sha256').update(item.token).digest('hex').slice(0, 12);
  return `media/${String(item.index).padStart(3, '0')}-${item.type}-${tokenHash}`;
}

function sanitizeManifestMedia(media, snapshotPath) {
  return media.map((item) => ({
    ...item,
    ...(item.localPath ? { relativePath: relative(snapshotPath, item.localPath) } : {}),
  }));
}

export function createLarkCliDocumentProvider(options = {}) {
  const appId = trimString(options.appId);
  const appSecret = trimString(options.appSecret);
  const brand = trimString(options.brand).toLowerCase() === 'lark' ? 'lark' : 'feishu';
  const sourceRouteId = trimString(options.sourceRouteId) || 'default';
  const rawConfigDir = trimString(options.configDir);
  const rawSnapshotDir = trimString(options.snapshotDir);
  const larkCliPath = trimString(options.larkCliPath) || DEFAULT_LARK_CLI_PATH;
  const runCommand = typeof options.runCommand === 'function' ? options.runCommand : runLarkCliCommand;
  if (!appId || !appSecret) {
    throw createProviderError('connector_unavailable', 'Feishu Bot credentials are required for lark-cli.', 503);
  }
  if (!rawConfigDir || !rawSnapshotDir) {
    throw createProviderError('connector_unavailable', 'lark-cli config and snapshot directories are required.', 503);
  }
  const configDir = resolve(rawConfigDir);
  const snapshotDir = resolve(rawSnapshotDir);

  const environment = buildLarkCliEnvironment(configDir);
  let initialization = null;

  async function initialize() {
    if (!initialization) {
      initialization = (async () => {
        await mkdir(configDir, { recursive: true, mode: 0o700 });
        await mkdir(snapshotDir, { recursive: true, mode: 0o700 });
        await chmod(configDir, 0o700);
        await chmod(snapshotDir, 0o700);
        try {
          await runCommand({
            command: larkCliPath,
            args: ['config', 'init', '--app-id', appId, '--app-secret-stdin', '--brand', brand],
            cwd: configDir,
            env: environment,
            stdin: `${appSecret}\n`,
            timeoutMs: 15_000,
            maxBuffer: 2 * 1024 * 1024,
          });
          await chmod(join(configDir, 'config.json'), 0o600).catch((error) => {
            if (error?.code !== 'ENOENT') throw error;
          });
        } catch (error) {
          throw createProviderError(
            'connector_unavailable',
            'Failed to initialize the isolated lark-cli Bot profile.',
            503,
            { reason: trimString(error?.message) },
          );
        }
      })().catch((error) => {
        initialization = null;
        throw error;
      });
    }
    await initialization;
  }

  async function runJson(args, requestOptions = {}) {
    try {
      const result = await runCommand({
        command: larkCliPath,
        args,
        cwd: requestOptions.cwd || snapshotDir,
        env: environment,
        timeoutMs: requestOptions.timeoutMs || LARK_CLI_TIMEOUT_MS,
        maxBuffer: requestOptions.maxBuffer || LARK_CLI_MAX_BUFFER,
      });
      return parseLarkCliEnvelope(result);
    } catch (error) {
      throw normalizeLarkCliFailure(error);
    }
  }

  async function downloadMedia(snapshotPath, media, maxMedia) {
    if (media.length === 0) return media;
    await mkdir(join(snapshotPath, 'media'), { recursive: true, mode: 0o700 });
    const downloaded = [];
    for (const item of media) {
      if (item.index > maxMedia) {
        downloaded.push(item);
        continue;
      }
      const output = mediaOutputName(item);
      const args = [
        'docs', '+media-download',
        '--token', item.token,
        '--type', item.type === 'whiteboard' ? 'whiteboard' : 'media',
        '--output', output,
        '--overwrite',
        '--as', 'bot',
        '--format', 'json',
      ];
      try {
        await runJson(args, { cwd: snapshotPath });
        const localPath = await findDownloadedMediaPath(snapshotPath, output);
        downloaded.push(localPath ? { ...item, localPath } : {
          ...item,
          downloadError: 'lark-cli completed without creating a media file.',
        });
      } catch (error) {
        downloaded.push({
          ...item,
          downloadError: trimString(error?.message) || 'Failed to download document media.',
        });
      }
    }
    return downloaded;
  }

  async function fetch(parameters = {}) {
    const normalized = normalizeFetchParameters(parameters);
    await initialize();
    const payload = await runJson(buildFetchArgs(normalized));
    const document = payload?.data?.document;
    if (!document || typeof document !== 'object') {
      throw createProviderError('document_read_failed', 'lark-cli response did not include a document.', 502);
    }
    const content = typeof document.content === 'string' ? document.content : '';
    const snapshotId = buildSnapshotId(normalized.documentToken, document, normalized, content);
    const snapshotPath = join(snapshotDir, snapshotId);
    await mkdir(snapshotPath, { recursive: true, mode: 0o700 });
    const extension = normalized.docFormat === 'xml' ? 'xml' : 'md';
    const contentPath = join(snapshotPath, `document.${extension}`);
    await writeFile(contentPath, content, { encoding: 'utf8', mode: 0o600 });
    const indexedMedia = normalized.docFormat === 'xml' ? extractLarkDocumentMedia(content) : [];
    const media = normalized.downloadMedia
      ? await downloadMedia(snapshotPath, indexedMedia, normalized.maxMedia)
      : indexedMedia;
    const manifestPath = join(snapshotPath, 'manifest.json');
    const manifestMedia = sanitizeManifestMedia(media, snapshotPath);
    const result = {
      documentToken: normalized.documentToken,
      documentId: trimString(document.document_id) || normalized.documentToken,
      title: extractTitle(content, normalized.docFormat, document),
      revisionId: Number.isFinite(Number(document.revision_id)) ? Number(document.revision_id) : null,
      content: content.slice(0, normalized.maxChars),
      contentLength: content.length,
      truncated: content.length > normalized.maxChars,
      identity: 'bot',
      scope: normalized.scope,
      detail: normalized.detail,
      docFormat: normalized.docFormat,
      contentPath,
      manifestPath,
      media,
      mediaTruncated: normalized.downloadMedia && media.length > normalized.maxMedia,
    };
    await writeFile(manifestPath, `${JSON.stringify({
      sourceRouteId,
      documentToken: result.documentToken,
      documentId: result.documentId,
      title: result.title,
      revisionId: result.revisionId,
      identity: result.identity,
      scope: result.scope,
      detail: result.detail,
      docFormat: result.docFormat,
      contentLength: result.contentLength,
      contentPath,
      media: manifestMedia,
    }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    return result;
  }

  return {
    configDir,
    snapshotDir,
    sourceRouteId,
    initialize,
    fetch,
  };
}
