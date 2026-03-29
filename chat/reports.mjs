import { randomBytes } from 'crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, copyFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { REPORTS_DIR, REPORTS_META_FILE } from '../lib/config.mjs';

// ---- Persistence ----

function loadMeta() {
  try {
    if (!existsSync(REPORTS_META_FILE)) return [];
    return JSON.parse(readFileSync(REPORTS_META_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveMeta(reports) {
  const dir = dirname(REPORTS_META_FILE);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const tmp = REPORTS_META_FILE + '.tmp.' + process.pid;
  writeFileSync(tmp, JSON.stringify(reports, null, 2), 'utf8');
  renameSync(tmp, REPORTS_META_FILE);
}

function ensureReportsDir() {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
}

// ---- HTML Validation (hard test) ----

/**
 * Validate an HTML file before accepting it as a report.
 * Throws descriptive errors if validation fails.
 */
function validateHtml(filePath) {
  const html = readFileSync(filePath, 'utf-8');

  // Check 1: File not empty
  if (!html.trim()) {
    throw new Error('HTML file is empty');
  }

  // Check 2: Basic HTML structure tags
  if (!/<(html|body|div|article|section|h[1-6]|p|table|ul|ol)/i.test(html)) {
    throw new Error('HTML file lacks basic structure tags (expected at least one of: html, body, div, article, section, h1-h6, p, table, ul, ol)');
  }

  // Check 3: Simple tag balance check for critical tags
  const tagErrors = checkTagBalance(html);
  if (tagErrors.length > 0) {
    throw new Error(`HTML structure errors:\n${tagErrors.join('\n')}`);
  }

  // Check 4: Minimum text content
  const textContent = html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  if (textContent.length < 50) {
    throw new Error(`HTML content too short (${textContent.length} chars of text, minimum 50)`);
  }

  return { charCount: html.length, textLength: textContent.length };
}

/**
 * Simple tag balance checker. Returns an array of error strings.
 * Only checks block-level / important tags — not self-closing or inline.
 */
function checkTagBalance(html) {
  const errors = [];
  // Remove comments, scripts, styles, and self-closing tags before checking
  let cleaned = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '');

  const BLOCK_TAGS = ['html', 'head', 'body', 'div', 'article', 'section', 'nav', 'header', 'footer', 'main', 'table', 'thead', 'tbody', 'tr', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'blockquote', 'form', 'fieldset', 'details', 'summary'];
  const SELF_CLOSING = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'col', 'area', 'base', 'source', 'track', 'wbr', 'embed']);

  const stack = [];
  const tagRegex = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*\/?>/g;
  let match;

  while ((match = tagRegex.exec(cleaned)) !== null) {
    const full = match[0];
    const tagName = match[1].toLowerCase();

    if (!BLOCK_TAGS.includes(tagName)) continue;
    if (SELF_CLOSING.has(tagName)) continue;
    if (full.endsWith('/>')) continue; // self-closing syntax

    const isClosing = full.startsWith('</');
    if (isClosing) {
      if (stack.length === 0) {
        errors.push(`Unexpected closing tag </${tagName}> with no matching opening tag`);
      } else if (stack[stack.length - 1] === tagName) {
        stack.pop();
      } else {
        // Mismatch — try to find matching open tag
        const idx = stack.lastIndexOf(tagName);
        if (idx !== -1) {
          const unclosed = stack.splice(idx);
          unclosed.pop(); // remove the matched one
          for (const t of unclosed) {
            errors.push(`Unclosed tag <${t}> before </${tagName}>`);
          }
        } else {
          errors.push(`Unexpected closing tag </${tagName}> (expected </${stack[stack.length - 1]}> or no closing tag)`);
        }
      }
    } else {
      stack.push(tagName);
    }
  }

  // Only report top-level unclosed tags (limit noise)
  if (stack.length > 0 && stack.length <= 5) {
    for (const t of stack) {
      errors.push(`Unclosed tag <${t}>`);
    }
  } else if (stack.length > 5) {
    errors.push(`${stack.length} unclosed tags detected (first: <${stack[0]}>)`);
  }

  return errors;
}

// ---- Public API ----

export function listReports() {
  return loadMeta().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export function getReport(id) {
  const reports = loadMeta();
  return reports.find(r => r.id === id) || null;
}

export function getReportHtml(id) {
  const report = getReport(id);
  if (!report) return null;
  const filePath = join(REPORTS_DIR, report.filename);
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, 'utf-8');
}

/**
 * Create a new report. Validates the HTML, copies the file, stores metadata.
 * Throws on validation failure with detailed error messages.
 */
export function createReport({ title, filePath, sessionId, sessionFolder, source }) {
  if (!title) throw new Error('title is required');
  if (!filePath) throw new Error('filePath is required');
  if (!existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  // Hard test: validate HTML
  const stats = validateHtml(filePath);
  console.log(`[reports] HTML validation passed: ${stats.charCount} chars, ${stats.textLength} text chars`);

  // Copy file to reports directory
  ensureReportsDir();
  const id = randomBytes(16).toString('hex');
  const filename = `${id}.html`;
  const destPath = join(REPORTS_DIR, filename);
  copyFileSync(filePath, destPath);

  const report = {
    id,
    title,
    filename,
    sessionId: sessionId || null,
    sessionFolder: sessionFolder || null,
    source: source || 'unknown',
    createdAt: new Date().toISOString(),
    read: false,
  };

  const reports = loadMeta();
  reports.push(report);
  saveMeta(reports);

  console.log(`[reports] Created report "${title}" id=${id.slice(0, 8)} source=${source}`);
  return report;
}

export function markAsRead(id) {
  const reports = loadMeta();
  const report = reports.find(r => r.id === id);
  if (!report) return null;
  report.read = true;
  saveMeta(reports);
  return report;
}

export function deleteReport(id) {
  const reports = loadMeta();
  const idx = reports.findIndex(r => r.id === id);
  if (idx === -1) return false;
  const report = reports[idx];
  // Delete HTML file
  const filePath = join(REPORTS_DIR, report.filename);
  try { unlinkSync(filePath); } catch {}
  // Remove from metadata
  reports.splice(idx, 1);
  saveMeta(reports);
  console.log(`[reports] Deleted report id=${id.slice(0, 8)}`);
  return true;
}

export function getUnreadCount() {
  return loadMeta().filter(r => !r.read).length;
}
