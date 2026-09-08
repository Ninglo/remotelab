import { createHash } from "node:crypto";
import { open, rm, realpath, readFile, readdir, stat } from "node:fs/promises";
import { dirname, basename, join, resolve, isAbsolute } from "node:path";
import { readRecord } from "./durable-records.mjs";
import {
  readProcessIdentity,
  isProcessIdentityAlive,
} from "./process-identity.mjs";
import { inside, pathExists } from "./request-migration-files.mjs";
import { discoverMigrationConnectors } from "./request-migration-inbox.mjs";
export async function loadUpgradePlan(path) {
  const input = await readRecord(resolve(path));
  if (input?.version !== 1) throw new Error("Upgrade plan version must be 1");
  if (
    typeof input.configDir !== "string" ||
    typeof input.workDir !== "string" ||
    !isAbsolute(input.configDir) ||
    !isAbsolute(input.workDir)
  )
    throw new Error("Absolute configDir and workDir are required");
  if (
    input.timeoutMs !== undefined &&
    (!Number.isInteger(input.timeoutMs) ||
      input.timeoutMs < 250 ||
      input.timeoutMs > 300000)
  )
    throw new Error("timeoutMs must be 250..300000");
  const configDir = join(
    await realpath(dirname(resolve(input.configDir))),
    basename(input.configDir),
  );
  const workDir = join(
    await realpath(dirname(input.workDir)),
    basename(input.workDir),
  );
  for (const path of [configDir, workDir]) {
    if (
      (await pathExists(path)) &&
      process.getuid &&
      (await stat(path)).uid !== process.getuid()
    ) {
      throw new Error(
        "Run upgrade as the instance data owner; use sudo only inside service commands",
      );
    }
  }
  if (inside(configDir, workDir) || inside(workDir, configDir))
    throw new Error("Work directory must be separate from instance data");
  for (const name of [
    "preflight",
    "stop",
    "stopped",
    "activate",
    "restore",
    "start",
    "connectorsHealthy",
  ]) {
    const group = input.commands?.[name];
    if (!Array.isArray(group) || !group.length)
      throw new Error(`Missing lifecycle command group: ${name}`);
    for (const cmd of group) {
      const argv = Array.isArray(cmd) ? cmd : cmd?.argv;
      if (
        !Array.isArray(argv) ||
        !argv.length ||
        argv.some((v) => typeof v !== "string" || !v)
      )
        throw new Error(`Invalid argv in ${name}`);
      if (
        !Array.isArray(cmd) &&
        cmd.stdout !== undefined &&
        typeof cmd.stdout !== "string"
      )
        throw new Error(`Invalid expected stdout in ${name}`);
      if (!Array.isArray(cmd) && !Number.isInteger(cmd.exitCode ?? 0))
        throw new Error(`Invalid expected exit code in ${name}`);
    }
  }
  const url = new URL(input.http?.baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  )
    throw new Error("Health endpoint must be an explicit loopback origin");
  if (
    typeof input.http.oldCommit !== "string" ||
    typeof input.http.newCommit !== "string" ||
    !input.http.oldCommit ||
    !input.http.newCommit
  )
    throw new Error("Both old and new build commits are required");
  return {
    ...input,
    configDir,
    workDir,
    http: { ...input.http, baseUrl: url.origin },
    timeoutMs: input.timeoutMs || 30000,
  };
}

export async function withLock(plan, operation) {
  const key = createHash("sha256")
    .update(plan.configDir)
    .digest("hex")
    .slice(0, 16);
  const path = join(dirname(plan.configDir), `.request-upgrade-${key}.lock`);
  let fd;
  try {
    fd = await open(path, "wx", 0o600);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    // Serialize stale-lock reclamation; contenders must not unlink a new owner's lock.
    const reclaim = await open(`${path}.reclaim`, "wx", 0o600);
    try {
      const owner = await readRecord(path);
      if (!owner?.birth || (await isProcessIdentityAlive(owner)))
        throw new Error(`Upgrade lock is active or incomplete: ${path}`);
      await rm(path);
      fd = await open(path, "wx", 0o600);
    } finally {
      await reclaim.close();
      await rm(`${path}.reclaim`, { force: true });
    }
  }
  try {
    const identity = await readProcessIdentity(process.pid);
    if (!identity) throw new Error("Cannot establish upgrade process identity");
    await fd.writeFile(JSON.stringify(identity));
    await fd.sync();
    return await operation();
  } finally {
    await fd.close();
    await rm(path, { force: true });
  }
}

export async function assertIdle(configDir) {
  for (const id of await readdir(join(configDir, "chat-runs")).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  })) {
    if (!id.startsWith("run_")) continue;
    const run = await readRecord(
      join(configDir, "chat-runs", id, "status.json"),
    );
    if (!run || !["completed", "failed", "cancelled"].includes(run.state))
      throw new Error(
        `Unfinished Run must finish or be explicitly reconciled before upgrade: ${id}`,
      );
    for (const identity of [run.runnerProcessIdentity, run.toolProcessIdentity])
      if (await isProcessIdentityAlive(identity))
        throw new Error(`Run executor still alive: ${id}`);
  }
  for (const bot of await discoverMigrationConnectors(configDir)) {
    const pid = Number(
      (
        await readFile(join(bot.storage, "connector.pid"), "utf8").catch(
          (e) => {
            if (e.code === "ENOENT") return "";
            throw e;
          },
        )
      ).trim(),
    );
    if (pid && (await readProcessIdentity(pid)))
      throw new Error(`Connector still running at ${bot.storage}`);
  }
}

export async function checkHttp(plan, which) {
  const token = (await readRecord(join(plan.configDir, "auth.json")))?.token;
  if (!token)
    throw new Error("Cannot verify instance health without its owner token");
  const expected = which === "old" ? plan.http.oldCommit : plan.http.newCommit;
  const deadline = Date.now() + plan.timeoutMs;
  let last;
  do {
    try {
      let build;
      for (const path of ["/api/auth/me", "/api/sessions", "/api/build-info"]) {
        const response = await fetch(plan.http.baseUrl + path, {
          headers: { authorization: `Bearer ${token}` },
          redirect: "error",
          signal: AbortSignal.timeout(Math.min(plan.timeoutMs, 5000)),
        });
        if (response.status !== 200)
          throw new Error(`Health ${path}: HTTP ${response.status}`);
        const body = await response.json();
        if (path === "/api/build-info") build = body;
      }
      if (
        typeof build?.commit !== "string" ||
        !build.commit ||
        !expected.startsWith(build.commit)
      )
        throw new Error(
          `Wrong running commit; expected ${expected}, got ${build?.commit || "missing"}`,
        );
      return { commit: build.commit, authenticated: true };
    } catch (error) {
      last = error;
    }
    await new Promise((r) => setTimeout(r, 250));
  } while (Date.now() < deadline);
  throw last;
}
