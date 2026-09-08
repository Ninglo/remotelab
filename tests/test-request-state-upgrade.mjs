import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readProcessIdentity } from "../lib/process-identity.mjs";
import { promisify } from "node:util";
const exec = promisify(execFile),
  root = await mkdtemp(join(tmpdir(), "request-upgrade-"));
const source = join(root, "config"),
  work = join(root, "work"),
  control = join(root, "control.json");
const put = async (path, value) => {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};
await put(join(source, "chat-sessions.json"), [{ id: "s", name: "preserved" }]);
await put(join(source, "auth.json"), { token: "fixture" });
await put(control, { version: "old", running: true });
const hook = join(root, "hook.mjs");
await writeFile(
  hook,
  `import {readFile,writeFile} from 'node:fs/promises';\nconst p=process.argv[2],cmd=process.argv[3],s=JSON.parse(await readFile(p));\nif(cmd==='stop')s.running=false;\nif(cmd==='stopped'&&s.running)process.exit(3);\nif(cmd==='crash'&&!s.crashed){s.crashed=true;await writeFile(p,JSON.stringify(s));await new Promise(r=>setTimeout(r,50));process.kill(process.ppid,'SIGKILL');process.exit(0);}
if(cmd==='activate'||cmd==='crash')s.version='new';\nif(cmd==='restore'&&s.blockRestore)process.exit(8);
if(cmd==='restore')s.version='old';\nif(cmd==='start')s.running=true;\nif(cmd==='fail'&&s.version==='new')process.exit(7);\nawait writeFile(p,JSON.stringify(s));`,
);
const server = createServer(async (req, res) => {
  const state = JSON.parse(await readFile(control));
  if (!state.running) {
    res.writeHead(503).end();
    return;
  }
  res.setHeader("content-type", "application/json");
  res.end(
    JSON.stringify(
      req.url === "/api/build-info" ? { commit: state.version } : { ok: true },
    ),
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const command = (mode) => [[process.execPath, hook, control, mode]];
const plan = {
  version: 1,
  configDir: source,
  workDir: work,
  timeoutMs: 600,
  http: {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    oldCommit: "old",
    newCommit: "new",
  },
  commands: Object.fromEntries(
    [
      "preflight",
      "stop",
      "stopped",
      "activate",
      "restore",
      "start",
      "connectorsHealthy",
    ].map((k) => [k, command(k)]),
  ),
};
const planFile = join(root, "plan.json");
await put(planFile, plan);
const run = (mode) =>
  exec(process.execPath, [
    "scripts/upgrade-request-state.mjs",
    mode,
    "--plan",
    planFile,
  ]);
try {
  const lock = join(
    root,
    `.request-upgrade-${createHash("sha256").update(source).digest("hex").slice(0, 16)}.lock`,
  );
  await put(lock, await readProcessIdentity(process.pid));
  await assert.rejects(run("apply"), /lock is active/);
  await rm(lock);
  await put(join(source, "chat-runs/run_pending/status.json"), {
    id: "run_pending",
    state: "running",
  });
  await assert.rejects(run("apply"), /Unfinished Run blocks/);
  assert.equal(
    JSON.parse(await readFile(control)).running,
    true,
    "preflight failure must not stop services",
  );
  await rm(join(source, "chat-runs"), { recursive: true });
  await run("apply");
  const journal = JSON.parse(await readFile(join(work, "upgrade.json")));
  assert.equal(journal.phase, "migrated");
  assert.equal(journal.liveE2E, "not-run");
  assert.equal(
    JSON.parse(await readFile(join(source, "requests/schema.json"))).version,
    1,
  );
  assert.equal(
    JSON.parse(await readFile(join(work, "backup/chat-sessions.json")))[0].name,
    "preserved",
  );
  await run("apply"); // no-op after successful same-plan migration
  await run("rollback");
  assert.equal(JSON.parse(await readFile(control)).version, "old");
  assert.equal(
    JSON.parse(await readFile(join(work, "upgrade.json"))).phase,
    "rolled_back",
  );
  await assert.rejects(readFile(join(source, "requests/schema.json")), {
    code: "ENOENT",
  });
  const work2 = join(root, "work2");
  plan.workDir = work2;
  plan.commands.connectorsHealthy = command("fail");
  await put(planFile, plan);
  await assert.rejects(run("apply"));
  assert.equal(
    JSON.parse(await readFile(join(work2, "upgrade.json"))).phase,
    "rolled_back",
  );
  assert.equal(JSON.parse(await readFile(control)).version, "old");
  const badRollback = join(root, "bad-rollback");
  plan.workDir = badRollback;
  await put(planFile, plan);
  await put(control, { version: "old", running: true, blockRestore: true });
  await assert.rejects(run("apply"), /recovery failed/);
  assert.equal(
    JSON.parse(await readFile(join(badRollback, "upgrade.json"))).phase,
    "rollback_failed",
  );
  await put(control, { version: "new", running: false, blockRestore: false });
  await run("rollback");
  assert.equal(
    JSON.parse(await readFile(join(badRollback, "upgrade.json")))
      .rollbackVerified,
    true,
  );
  const work3 = join(root, "work3");
  plan.workDir = work3;
  plan.commands.activate = command("crash");
  plan.commands.connectorsHealthy = command("connectorsHealthy");
  await put(planFile, plan);
  await assert.rejects(run("apply"));
  assert.equal(
    JSON.parse(await readFile(join(work3, "upgrade.json"))).phase,
    "activating",
  );
  await run("apply");
  assert.equal(
    JSON.parse(await readFile(join(work3, "upgrade.json"))).phase,
    "migrated",
  );
  await writeFile(join(source, "new-user-work.txt"), "must survive");
  await assert.rejects(
    run("rollback"),
    /Automatic rollback would discard work/,
  );
  assert.equal(
    await readFile(join(source, "new-user-work.txt"), "utf8"),
    "must survive",
  );
  assert.equal(
    JSON.parse(await readFile(join(work3, "upgrade.json"))).phase,
    "recovery-required",
  );
  console.log(
    "state upgrade: full transaction, idempotency, verified rollback, SIGKILL resume, and refusal to discard new work passed",
  );
} finally {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(root, { recursive: true, force: true });
}
