import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export function researchCandidateHandoff(snapshot, { edition, sourcePath, sourceSha256, generatedAt }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(edition || '')) throw new Error('An explicit intake edition is required');
  const unique = new Map();
  for (const [key, record] of Object.entries(snapshot.items || {})) {
    const candidate = record.candidate || {};
    if (record.private_reference_only || candidate.private_reference_only
      || /private/i.test([record.status, record.visibility, candidate.status, candidate.visibility].join(' '))) continue;
    let url; try { url = new URL(candidate.url || candidate.original_url || ''); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || isIP(url.hostname) || !url.hostname.includes('.') || /(^|\.)(localhost|local|internal|feishu\.cn|feishu\.com|larksuite\.com)$/.test(url.hostname)
      || [...url.searchParams.keys()].some(k => /token|secret|password|signature|authorization/i.test(k))) continue;
    url.hash = '';
    const originalUrl = url.href;
    const evidence = { sourceKey: key, sourcePath, sourceSha256, firstCapturedEdition: record.first_captured_edition || null,
      lastCapturedEdition: record.last_captured_edition || null, capturedAt: candidate.fetched_at || null,
      captureStatus: candidate.status || null, reviewStatus: record.status || null };
    if (unique.has(originalUrl)) { unique.get(originalUrl).sources.push(evidence); continue; }
    unique.set(originalUrl, { originalUrl, title: candidate.title || '', publishedAt: candidate.published_at || null,
      evidenceRole: 'discovery_candidate_only', sources: [evidence] });
  }
  return { schemaVersion: 1, edition, generatedAt, sourcePath, sourceSha256,
    scope: 'public_original_links_only_no_group_content', candidates: [...unique.values()],
    rules: ['Capture is not original reading, dataset approval or permission to download',
      'Reuse original evidence at the source path; independently verify license, payload and catalog status',
      'Generation time does not refresh an older capture; retain each source capture edition'] };
}

async function main() {
  const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, value, index, all) => {
    if (value.startsWith('--')) pairs.push([value.slice(2), all[index + 1]]); return pairs;
  }, []));
  for (const key of ['input', 'edition', 'output']) if (!args[key]) throw new Error(`--${key} is required`);
  const input = resolve(args.input), bytes = await readFile(input);
  const snapshot = researchCandidateHandoff(JSON.parse(bytes), { edition: args.edition, sourcePath: input,
    sourceSha256: createHash('sha256').update(bytes).digest('hex'), generatedAt: new Date().toISOString() });
  const output = resolve(args.output); await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 }); await rename(temporary, output);
  console.log(JSON.stringify({ output, edition: snapshot.edition, candidates: snapshot.candidates.length, sourceSha256: snapshot.sourceSha256 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
