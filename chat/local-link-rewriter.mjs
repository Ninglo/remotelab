/**
 * Detects local filesystem paths in assistant message markdown links
 * and rewrites them to downloadable file-asset URLs.
 *
 * This is a server-side safety net for when the model gives local file paths
 * instead of using `remotelab assistant-message --file`.
 */

import { stat } from 'fs/promises';
import { basename } from 'path';
import { publishLocalFileAssetFromPath } from './file-assets.mjs';

// Matches markdown links whose href is an absolute local path with a file extension.
// Examples:
//   [3月考勤.xlsx](/Users/jiujianian/attendance.xlsx)
//   [report](file:///tmp/report.pdf)
const LOCAL_PATH_LINK_RE = /\[([^\]]*)\]\((\/(?:Users|home|opt|private|var|tmp|Volumes|mnt)\/[^)]+\.[a-zA-Z0-9]+)\)/g;
const FILE_URL_LINK_RE = /\[([^\]]*)\]\(file:\/\/(\/[^)]+\.[a-zA-Z0-9]+)\)/g;

// In-memory cache: "sessionId\0localPath" → downloadUrl
// Avoids re-creating file assets for the same file on repeated display reads.
const assetCache = new Map();
const CACHE_MAX_SIZE = 2000;

function cacheKey(sessionId, localPath) {
  return `${sessionId}\0${localPath}`;
}

function cacheGet(sessionId, localPath) {
  return assetCache.get(cacheKey(sessionId, localPath)) || null;
}

function cacheSet(sessionId, localPath, downloadUrl) {
  if (assetCache.size >= CACHE_MAX_SIZE) {
    // Evict oldest entries (first 500)
    const keys = [...assetCache.keys()];
    for (let i = 0; i < 500 && i < keys.length; i++) {
      assetCache.delete(keys[i]);
    }
  }
  assetCache.set(cacheKey(sessionId, localPath), downloadUrl);
}

async function resolveLocalPath(localPath, sessionId, linkText) {
  // Check cache first
  const cached = cacheGet(sessionId, localPath);
  if (cached) return cached;

  // Verify file exists
  try {
    const stats = await stat(localPath);
    if (!stats.isFile()) return null;
  } catch {
    return null;
  }

  // Create file asset
  try {
    const asset = await publishLocalFileAssetFromPath({
      sessionId,
      localPath,
      originalName: linkText || basename(localPath),
      createdBy: 'local-link-rewriter',
    });
    const url = asset?.downloadUrl;
    if (url) {
      cacheSet(sessionId, localPath, url);
    }
    return url || null;
  } catch {
    return null;
  }
}

/**
 * Scan a markdown string for local file path links and rewrite them
 * to file-asset download URLs.
 *
 * @param {string} content - Markdown content
 * @param {string} sessionId
 * @returns {Promise<{content: string, rewritten: number}>}
 */
async function rewriteLocalFileLinksInContent(content, sessionId) {
  if (!content || typeof content !== 'string') return { content, rewritten: 0 };

  // Collect all matches first (both patterns)
  const matches = [];
  for (const re of [LOCAL_PATH_LINK_RE, FILE_URL_LINK_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(content)) !== null) {
      matches.push({
        fullMatch: m[0],
        linkText: m[1],
        localPath: m[2],
        index: m.index,
      });
    }
  }

  if (matches.length === 0) return { content, rewritten: 0 };

  // Deduplicate by index (in case both patterns match the same link)
  const seen = new Set();
  const unique = matches.filter((m) => {
    if (seen.has(m.index)) return false;
    seen.add(m.index);
    return true;
  });

  // Resolve all paths in parallel
  const resolutions = await Promise.all(
    unique.map(async (m) => ({
      ...m,
      downloadUrl: await resolveLocalPath(m.localPath, sessionId, m.linkText),
    })),
  );

  let result = content;
  let rewritten = 0;
  // Replace in reverse order to preserve indices
  for (const r of resolutions.sort((a, b) => b.index - a.index)) {
    if (!r.downloadUrl) continue;
    const replacement = `[${r.linkText}](${r.downloadUrl})`;
    result = result.slice(0, r.index) + replacement + result.slice(r.index + r.fullMatch.length);
    rewritten++;
  }

  return { content: result, rewritten };
}

/**
 * Rewrite local file links in display events (in-place mutation).
 * Only processes assistant message events.
 *
 * @param {Array} events - Display events array (mutated in place)
 * @param {string} sessionId
 * @returns {Promise<number>} - Total number of links rewritten
 */
export async function rewriteLocalFileLinksInDisplayEvents(events, sessionId) {
  if (!Array.isArray(events) || !sessionId) return 0;

  const tasks = [];
  for (const event of events) {
    if (event?.type !== 'message' || event?.role !== 'assistant') continue;
    if (!event.content || typeof event.content !== 'string') continue;
    // Quick check: does content likely contain a local path?
    if (!/\]\(\/(?:Users|home|opt|private|var|tmp|Volumes|mnt)\//.test(event.content) &&
        !/\]\(file:\/\//.test(event.content)) {
      continue;
    }
    tasks.push(
      rewriteLocalFileLinksInContent(event.content, sessionId).then((result) => {
        if (result.rewritten > 0) {
          event.content = result.content;
        }
        return result.rewritten;
      }),
    );
  }

  if (tasks.length === 0) return 0;
  const results = await Promise.all(tasks);
  return results.reduce((sum, n) => sum + n, 0);
}
