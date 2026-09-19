#!/usr/bin/env node
import { execFile as execFileCallback } from 'child_process';
import { access, mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import { AUTH_FILE, API_REQUEST_LOGS_DIR } from '../lib/config.mjs';
import { readServiceToken } from '../lib/auth-config.mjs';
import { selectCloudflaredAccessDomain } from '../lib/cloudflared-config.mjs';
import {
  appendQueryMarker,
  median,
  parseCloudflareTrace,
  parseCloudflaredTunnelInfo,
} from '../lib/tunnel-diagnostics.mjs';

const execFile = promisify(execFileCallback);
const PERF_QUERY_KEY = '_perf';
const CURL_WRITE_OUT = '{"httpCode":%{http_code},"httpVersion":"%{http_version}","numConnects":%{num_connects},"remoteIp":"%{remote_ip}","sizeDownload":%{size_download},"speedDownload":%{speed_download},"timeNameLookup":%{time_namelookup},"timeConnect":%{time_connect},"timeAppConnect":%{time_appconnect},"timeStartTransfer":%{time_starttransfer},"timeTotal":%{time_total},"urlEffective":"%{url_effective}"}\n';

function printHelp() {
  console.log(`Usage: node scripts/tunnel-latency-diagnose.mjs [options]

Options:
  --path <path>           Repeatable path to probe
  --local-base <url>      Local origin base URL (default: http://127.0.0.1:7690)
  --remote-base <url>     Public tunnel base URL
  --token <token>         Service token override for /api/* probes
  --warm <count>          Warm samples per probe (default: 2)
  --json                  Emit JSON instead of a text report
  --help                  Show this help

Defaults probe these paths:
  /api/sessions?view=refs
  /api/models
  /chat/ui.js
`);
}

function parseArgs(argv) {
  const args = {
    paths: [],
    localBase: 'http://127.0.0.1:7690',
    remoteBase: '',
    token: '',
    warm: 2,
    json: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--path') {
      args.paths.push(argv[index + 1] || '');
      index += 1;
      continue;
    }
    if (arg === '--local-base') {
      args.localBase = argv[index + 1] || args.localBase;
      index += 1;
      continue;
    }
    if (arg === '--remote-base') {
      args.remoteBase = argv[index + 1] || args.remoteBase;
      index += 1;
      continue;
    }
    if (arg === '--token') {
      args.token = argv[index + 1] || '';
      index += 1;
      continue;
    }
    if (arg === '--warm') {
      const parsed = Number.parseInt(argv[index + 1] || '', 10);
      if (Number.isInteger(parsed) && parsed >= 1) args.warm = parsed;
      index += 1;
      continue;
    }
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      args.help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (args.paths.length === 0) {
    args.paths = [
      '/api/sessions?view=refs',
      '/api/models',
      '/chat/ui.js',
    ];
  }

  args.paths = args.paths.map((path) => String(path || '').trim()).filter(Boolean);
  return args;
}

function joinBasePath(base, path) {
  return new URL(path, ensureTrailingSlash(base)).toString();
}

function ensureTrailingSlash(value) {
  const text = String(value || '').trim();
  return text.endsWith('/') ? text : `${text}/`;
}

function formatMs(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${Math.round(value)}ms`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

function roundNumber(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function metricMs(sample, key) {
  const value = sample?.metrics?.[key];
  return Number.isFinite(value) ? value * 1000 : null;
}

function summarizeSamples(samples) {
  const startTransferMedianMs = median(samples.map((sample) => metricMs(sample, 'timeStartTransfer')));
  const totalMedianMs = median(samples.map((sample) => metricMs(sample, 'timeTotal')));
  const connectMedianMs = median(samples.map((sample) => metricMs(sample, 'timeConnect')));
  const tlsMedianMs = median(samples.map((sample) => metricMs(sample, 'timeAppConnect')));
  return {
    count: samples.length,
    startTransferMedianMs: roundNumber(startTransferMedianMs),
    totalMedianMs: roundNumber(totalMedianMs),
    connectMedianMs: roundNumber(connectMedianMs),
    tlsMedianMs: roundNumber(tlsMedianMs),
    statuses: samples.map((sample) => sample.metrics.httpCode),
  };
}

function summarizeWarmSamples(samples) {
  if ((samples || []).length <= 1) return summarizeSamples(samples || []);
  return summarizeSamples(samples.slice(1));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command, args, options = {}) {
  try {
    const result = await execFile(command, args, {
      maxBuffer: 8 * 1024 * 1024,
      ...options,
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      ok: true,
    };
  } catch (error) {
    const message = error.stderr || error.stdout || error.message;
    throw new Error(`${command} ${args.join(' ')} failed: ${message}`.trim());
  }
}

function parseCurlMetrics(output) {
  return String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function createCookieJar(tempDir, base, token, label) {
  const cookieJar = join(tempDir, `${label}.cookies`);
  await runCommand('curl', [
    '-sS',
    '-L',
    '-c', cookieJar,
    '-o', '/dev/null',
    joinBasePath(base, `/login?token=${encodeURIComponent(token)}`),
  ]);
  return cookieJar;
}

async function runCurlSequence(urls, {
  cookieJar,
  headers = [],
  bodyFiles = [],
} = {}) {
  const protocol = urls[0] ? new URL(urls[0]).protocol : 'https:';
  const args = ['-sS', protocol === 'https:' ? '--http2' : '--http1.1'];
  if (cookieJar) args.push('-b', cookieJar);
  for (const header of headers) {
    args.push('-H', header);
  }
  urls.forEach((url, index) => {
    args.push('-o', bodyFiles[index] || '/dev/null', '-w', CURL_WRITE_OUT, url);
  });
  const { stdout } = await runCommand('curl', args);
  return parseCurlMetrics(stdout);
}

async function fetchHeaders(url, { cookieJar, headers = [], headerFile } = {}) {
  const protocol = url ? new URL(url).protocol : 'https:';
  const args = ['-sS', protocol === 'https:' ? '--http2' : '--http1.1'];
  if (cookieJar) args.push('-b', cookieJar);
  for (const header of headers) {
    args.push('-H', header);
  }
  args.push('-D', headerFile, '-o', '/dev/null', '-w', CURL_WRITE_OUT, url);
  const { stdout } = await runCommand('curl', args);
  return parseCurlMetrics(stdout)[0] || null;
}

function getHeaderValue(headersText, name) {
  const expression = new RegExp(`^${name}:\\s*(.+)$`, 'im');
  const match = expression.exec(String(headersText || '').replace(/\r/g, ''));
  return match?.[1]?.trim() || null;
}

async function readAuthToken(tokenOverride) {
  if (tokenOverride) return tokenOverride;
  return readServiceToken(AUTH_FILE).catch(() => '');
}

async function readCloudflaredContext() {
  const configPath = join(process.env.HOME || '', '.cloudflared', 'config.yml');
  const exists = await pathExists(configPath);
  if (!exists) return null;

  const content = await readFile(configPath, 'utf8');
  const tunnel = content.match(/^tunnel:\s*(\S+)$/m)?.[1] || null;
  const protocol = content.match(/^protocol:\s*(\S+)$/m)?.[1] || null;
  const remoteHost = await selectCloudflaredAccessDomain(content, { port: 7690 });

  return {
    configPath,
    content,
    tunnel,
    protocol,
    remoteHost,
  };
}

async function readTunnelInfo(tunnelName) {
  if (!tunnelName) return null;
  try {
    const { stdout } = await runCommand('cloudflared', ['tunnel', 'info', tunnelName]);
    return parseCloudflaredTunnelInfo(stdout);
  } catch (error) {
    return {
      error: error.message,
      connectors: [],
    };
  }
}

function isApiPath(path) {
  return String(path || '').startsWith('/api/');
}

function createPerfId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

async function findApiLogRecord(perfId) {
  const target = `${PERF_QUERY_KEY}=${perfId}`;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const dateKeys = [];
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    dateKeys.push(today);
    const previous = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const previousKey = `${previous.getFullYear()}-${String(previous.getMonth() + 1).padStart(2, '0')}-${String(previous.getDate()).padStart(2, '0')}`;
    if (previousKey !== today) dateKeys.push(previousKey);

    for (const dateKey of dateKeys) {
      const filepath = join(API_REQUEST_LOGS_DIR, `${dateKey}.jsonl`);
      if (!(await pathExists(filepath))) continue;
      const content = await readFile(filepath, 'utf8');
      const lines = content.split(/\r?\n/).filter(Boolean);
      for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index];
        if (!line.includes(target)) continue;
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

async function runTaggedProbe(base, path, {
  cookieJar,
  warm = 1,
  headers = [],
  apiLog = false,
} = {}) {
  const requests = [];
  const ids = [];
  for (let index = 0; index < warm; index += 1) {
    const perfId = createPerfId('probe');
    ids.push(perfId);
    requests.push(joinBasePath(base, appendQueryMarker(path, PERF_QUERY_KEY, perfId)));
  }

  const metrics = await runCurlSequence(requests, { cookieJar, headers });
  const samples = [];

  for (let index = 0; index < metrics.length; index += 1) {
    const logRecord = apiLog ? await findApiLogRecord(ids[index]) : null;
    samples.push({
      perfId: ids[index],
      metrics: metrics[index],
      logRecord,
    });
  }

  return samples;
}

async function fetchProbeEtag(base, path, { cookieJar } = {}) {
  const perfId = createPerfId('etag');
  const headerFile = join(tmpdir(), `remotelab-etag-${perfId}.txt`);
  try {
    const url = joinBasePath(base, appendQueryMarker(path, PERF_QUERY_KEY, perfId));
    const metrics = await fetchHeaders(url, { cookieJar, headerFile });
    const headersText = await readFile(headerFile, 'utf8').catch(() => '');
    return {
      perfId,
      metrics,
      etag: getHeaderValue(headersText, 'etag'),
      statusCode: metrics?.httpCode || null,
    };
  } finally {
    await rm(headerFile, { force: true });
  }
}

async function probeTrace(base) {
  const tracePath = '/cdn-cgi/trace';
  const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-trace-'));
  const bodies = [join(tempDir, 'cold.txt'), join(tempDir, 'warm.txt')];
  try {
    const url = joinBasePath(base, tracePath);
    const metrics = await runCurlSequence([url, url], { bodyFiles: bodies });
    const body = await readFile(bodies[1], 'utf8').catch(() => readFile(bodies[0], 'utf8').catch(() => ''));
    return {
      path: tracePath,
      metrics,
      trace: parseCloudflareTrace(body),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function computeFindings(report) {
  const findings = [];
  const trace = report.trace?.trace || {};
  const warmTraceSample = report.trace?.metrics?.[1] || report.trace?.metrics?.[0] || null;
  if (trace.colo && trace.loc) {
    findings.push(`Cloudflare trace resolves this machine to colo ${trace.colo} while Cloudflare reports loc=${trace.loc}.`);
  }
  if (warmTraceSample) {
    findings.push(`Edge-only warm trace sits around ${formatMs(metricMs({ metrics: warmTraceSample }, 'timeTotal'))} on this host.`);
  }

  const staticPath = report.paths.find((entry) => !entry.isApi);
  if (staticPath?.remoteConditional?.summary?.startTransferMedianMs && staticPath.localConditional?.summary?.startTransferMedianMs != null) {
    const remoteMs = staticPath.remoteConditional.summary.startTransferMedianMs;
    const localMs = staticPath.localConditional.summary.startTransferMedianMs;
    if (remoteMs - localMs > 200) {
      findings.push(`Static conditional requests stay slow through the tunnel (${formatMs(remoteMs)} warm vs ${formatMs(localMs)} local), so the main bottleneck is outside the app.`);
    }
  }

  for (const pathReport of report.paths) {
    if (!pathReport.isApi) continue;
    const remoteWarmMs = pathReport.remoteWarm.summary.startTransferMedianMs;
    const localOriginMs = pathReport.localCold.samples[0]?.logRecord?.responseStartMs ?? null;
    const local304Ms = pathReport.localConditional.samples[0]?.logRecord?.responseStartMs ?? null;
    if (Number.isFinite(remoteWarmMs) && Number.isFinite(localOriginMs) && remoteWarmMs - localOriginMs > 300) {
      findings.push(`${pathReport.path} spends about ${formatMs(remoteWarmMs - localOriginMs)} more before first byte over the public tunnel than the app needs locally.`);
    }
    if (Number.isFinite(local304Ms) && local304Ms > 40) {
      findings.push(`${pathReport.path} still spends about ${formatMs(local304Ms)} locally on a 304, which matches the current full-payload ETag path.`);
    }
  }

  const tunnelEdges = report.tunnelInfo?.connectors?.map((connector) => connector.edge).filter(Boolean) || [];
  if (tunnelEdges.length > 0) {
    findings.push(`cloudflared currently attaches to ${tunnelEdges.join(' | ')}.`);
  }
  return findings;
}

function printPathReport(pathReport) {
  const localCold = pathReport.localCold.samples[0];
  const remoteCold = pathReport.remoteCold.samples[0];
  const localConditionalStable = pathReport.localConditional.summary.statuses.every((status) => status === 304);
  const remoteConditionalStable = pathReport.remoteConditional.summary.statuses.every((status) => status === 304);
  console.log(`\n${pathReport.path}`);
  console.log(`  local 200       ttfb=${formatMs(metricMs(localCold, 'timeStartTransfer'))} total=${formatMs(metricMs(localCold, 'timeTotal'))} size=${formatBytes(localCold.metrics.sizeDownload)}${pathReport.isApi && localCold.logRecord ? ` app=${formatMs(localCold.logRecord.responseStartMs)}` : ''}`);
  console.log(`  remote 200 cold ttfb=${formatMs(metricMs(remoteCold, 'timeStartTransfer'))} total=${formatMs(metricMs(remoteCold, 'timeTotal'))} ip=${remoteCold.metrics.remoteIp} h=${remoteCold.metrics.httpVersion}${pathReport.isApi && remoteCold.logRecord ? ` app=${formatMs(remoteCold.logRecord.responseStartMs)}` : ''}`);
  console.log(`  remote 200 warm median ttfb=${formatMs(pathReport.remoteWarm.summary.startTransferMedianMs)} total=${formatMs(pathReport.remoteWarm.summary.totalMedianMs)} statuses=${pathReport.remoteWarm.summary.statuses.join(',')}`);
  console.log(`  local conditional median ttfb=${formatMs(pathReport.localConditional.summary.startTransferMedianMs)} total=${formatMs(pathReport.localConditional.summary.totalMedianMs)} statuses=${pathReport.localConditional.summary.statuses.join(',')}`);
  console.log(`  remote conditional median ttfb=${formatMs(pathReport.remoteConditional.summary.startTransferMedianMs)} total=${formatMs(pathReport.remoteConditional.summary.totalMedianMs)} statuses=${pathReport.remoteConditional.summary.statuses.join(',')}`);
  if (pathReport.conditionalSeedLocal?.etag && pathReport.conditionalSeedRemote?.etag) {
    console.log(`  etag seeds       local=${pathReport.conditionalSeedLocal.statusCode} remote=${pathReport.conditionalSeedRemote.statusCode}`);
  }
  if (!localConditionalStable || !remoteConditionalStable) {
    console.log('  note             conditional probe saw content changes, so 200 means the resource mutated during sampling');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  const cloudflaredContext = await readCloudflaredContext();
  const remoteBase = args.remoteBase || (cloudflaredContext?.remoteHost ? `https://${cloudflaredContext.remoteHost}` : '');
  if (!remoteBase) {
    throw new Error('Could not infer the public tunnel URL. Pass --remote-base explicitly.');
  }

  const needsAuth = args.paths.some((path) => isApiPath(path));
  const token = needsAuth ? await readAuthToken(args.token) : '';
  if (needsAuth && !token) {
    throw new Error(`At least one /api/* path was requested, but no service token was available in ${AUTH_FILE}.`);
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'remotelab-tunnel-diag-'));
  try {
    const localCookie = needsAuth ? await createCookieJar(tempDir, args.localBase, token, 'local') : null;
    const remoteCookie = needsAuth ? await createCookieJar(tempDir, remoteBase, token, 'remote') : null;

    const trace = await probeTrace(remoteBase);
    const tunnelInfo = await readTunnelInfo(cloudflaredContext?.tunnel || null);
    const pathReports = [];

    for (const path of args.paths) {
      const api = isApiPath(path);
      const localColdSamples = await runTaggedProbe(args.localBase, path, {
        cookieJar: api ? localCookie : null,
        warm: 1,
        apiLog: api,
      });
      const remoteColdSamples = await runTaggedProbe(remoteBase, path, {
        cookieJar: api ? remoteCookie : null,
        warm: 1,
        apiLog: api,
      });
      const remoteWarmSamples = await runTaggedProbe(remoteBase, path, {
        cookieJar: api ? remoteCookie : null,
        warm: args.warm,
        apiLog: api,
      });

      const conditionalSeedLocal = await fetchProbeEtag(args.localBase, path, {
        cookieJar: api ? localCookie : null,
      });
      const conditionalSeedRemote = await fetchProbeEtag(remoteBase, path, {
        cookieJar: api ? remoteCookie : null,
      });
      const conditionalHeadersLocal = conditionalSeedLocal.etag ? [`If-None-Match: ${conditionalSeedLocal.etag}`] : [];
      const conditionalHeadersRemote = conditionalSeedRemote.etag ? [`If-None-Match: ${conditionalSeedRemote.etag}`] : [];
      const localConditionalSamples = await runTaggedProbe(args.localBase, path, {
        cookieJar: api ? localCookie : null,
        warm: 1,
        headers: conditionalHeadersLocal,
        apiLog: api,
      });
      const remoteConditionalSamples = await runTaggedProbe(remoteBase, path, {
        cookieJar: api ? remoteCookie : null,
        warm: args.warm,
        headers: conditionalHeadersRemote,
        apiLog: api,
      });

      pathReports.push({
        path,
        isApi: api,
        localCold: {
          samples: localColdSamples,
          summary: summarizeSamples(localColdSamples),
        },
        remoteCold: {
          samples: remoteColdSamples,
          summary: summarizeSamples(remoteColdSamples),
        },
        remoteWarm: {
          samples: remoteWarmSamples,
          summary: summarizeWarmSamples(remoteWarmSamples),
        },
        localConditional: {
          samples: localConditionalSamples,
          summary: summarizeSamples(localConditionalSamples),
        },
        remoteConditional: {
          samples: remoteConditionalSamples,
          summary: summarizeWarmSamples(remoteConditionalSamples),
        },
        conditionalSeedLocal,
        conditionalSeedRemote,
      });
    }

    const report = {
      localBase: args.localBase,
      remoteBase,
      warmCount: args.warm,
      cloudflared: cloudflaredContext ? {
        configPath: cloudflaredContext.configPath,
        tunnel: cloudflaredContext.tunnel,
        protocol: cloudflaredContext.protocol,
      } : null,
      tunnelInfo,
      trace,
      paths: pathReports,
    };
    report.findings = computeFindings(report);

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log(`Remote base: ${report.remoteBase}`);
    console.log(`Local base:  ${report.localBase}`);
    if (report.cloudflared) {
      console.log(`cloudflared: tunnel=${report.cloudflared.tunnel || 'n/a'} protocol=${report.cloudflared.protocol || 'n/a'}`);
    }
    if (trace.trace?.colo || trace.trace?.loc) {
      const warmTrace = trace.metrics[1] || trace.metrics[0];
      console.log(`trace:       colo=${trace.trace?.colo || 'n/a'} loc=${trace.trace?.loc || 'n/a'} warm=${formatMs(metricMs({ metrics: warmTrace }, 'timeTotal'))}`);
    }
    if (tunnelInfo?.connectors?.length) {
      console.log(`edges:       ${tunnelInfo.connectors.map((connector) => connector.edge).join(' | ')}`);
    }

    for (const pathReport of report.paths) {
      printPathReport(pathReport);
    }

    if (report.findings.length > 0) {
      console.log('\nFindings');
      for (const finding of report.findings) {
        console.log(`- ${finding}`);
      }
    }
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
