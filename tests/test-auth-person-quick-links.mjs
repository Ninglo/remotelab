import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const configDir = await mkdtemp(join(tmpdir(), 'remotelab-person-links-'));
process.env.REMOTELAB_CONFIG_DIR = configDir;
try {
  const authPath = join(configDir, 'auth.json');
  await writeFile(authPath, JSON.stringify({ version: 2, serviceToken: 'test-only', primaryPersonId: 'first', people: [
    { id: 'first', name: 'First', credentials: [], identities: [], preferences: {
      voiceShortcut: { enabled: true, binding: 'Alt*3' }, futurePreference: { enabled: true },
    } },
    { id: 'second', name: 'Second', credentials: [], identities: [], preferences: {} },
  ] }));
  const { updatePerson } = await import('../lib/auth.mjs');
  const saved = async () => JSON.parse(await readFile(authPath, 'utf8'));
  await updatePerson('first', { quickLinks: [{ label: ' Work documents ', url: 'https://example.com/docs' }] });
  let document = await saved();
  assert.deepEqual(document.people[0].preferences.quickLinks, [{ label: 'Work documents', url: 'https://example.com/docs' }]);
  assert.equal(document.people[1].preferences.quickLinks, undefined);
  assert.deepEqual(document.people[0].preferences.voiceShortcut, { enabled: true, binding: 'Alt*3' });
  assert.deepEqual(document.people[0].preferences.futurePreference, { enabled: true });

  const before = await readFile(authPath, 'utf8');
  for (const quickLinks of [
    null, {}, Array(7).fill({ label: 'link', url: 'https://example.com' }),
    [{ label: '', url: 'https://example.com' }],
    [{ label: 'link', url: 'javascript:alert(1)' }],
    [{ label: 'link', url: 'data:text/html,hello' }],
    [{ label: 'link', url: 'https://user:password@example.com/' }],
    [{ label: 'link', url: '/relative' }],
  ]) {
    await assert.rejects(updatePerson('first', { quickLinks }));
    assert.equal(await readFile(authPath, 'utf8'), before, 'rejected links must not replace saved preferences');
  }
  await updatePerson('first', { name: 'Renamed' });
  document = await saved();
  assert.equal(document.people[0].preferences.quickLinks[0].url, 'https://example.com/docs');
  await updatePerson('first', { quickLinks: [] });
  assert.deepEqual((await saved()).people[0].preferences.quickLinks, []);
} finally {
  await rm(configDir, { recursive: true, force: true });
}
console.log('test-auth-person-quick-links: ok');
