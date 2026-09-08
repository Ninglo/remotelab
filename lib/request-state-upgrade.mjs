import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm, stat, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  readRecord,
  writeDurableJson,
} from "./durable-records.mjs";
import {
  readProcessIdentity,
  isProcessIdentityAlive,
} from "./process-identity.mjs";
import {
  fileManifest,
  digestManifest,
  durableRename,
  pathExists,
} from "./request-migration-files.mjs";
import { verifyRequestMigration } from "./request-migration-verify.mjs";
import {
  withLock,
  assertIdle,
  checkHttp,
} from "./request-upgrade-lifecycle.mjs";
export { loadUpgradePlan } from "./request-upgrade-lifecycle.mjs";
const exec = promisify(execFile);
const converter = fileURLToPath(
  new URL("../scripts/convert-request-state.mjs", import.meta.url),
);
const phasesAfterInstall = [
  "installing",
  "installed",
  "activating",
  "starting",
  "checking",
  "migrated",
];
export async function executeRequestUpgrade(plan, mode = "apply") {
  if (!["apply", "rollback", "status"].includes(mode))
    throw new Error("Expected apply, rollback or status");
  const journalPath = join(plan.workDir, "upgrade.json");
  if (mode === "status")
    return (await readRecord(journalPath)) || { phase: "not-started" };
  return withLock(plan, async () => {
    const planDigest = createHash("sha256")
      .update(canonicalJson(plan))
      .digest("hex");
    let journal = await readRecord(journalPath);
    const resuming = !!journal;
    if (
      journal &&
      (journal.version !== 1 ||
        ![
          "created",
          "preflighting",
          "preflight-passed",
          "stopping",
          "converting",
          "validated",
          "installing",
          "installed",
          "activating",
          "starting",
          "checking",
          "migrated",
          "rolled_back",
          "rollback_failed",
          "recovery-required",
        ].includes(journal.phase))
    )
      throw new Error("Unsupported upgrade journal; inspect before proceeding");
    if (journal && journal.planDigest !== planDigest)
      throw new Error("Plan changed; refusing to reuse this upgrade journal");
    if (!journal && mode === "rollback")
      throw new Error("No upgrade journal to roll back");
    const schema = await readRecord(
      join(plan.configDir, "requests/schema.json"),
    );
    if (!journal && schema?.version === 1)
      return { phase: "already-migrated", liveE2E: "not-run" };
    if (!journal && schema)
      throw new Error("Unsupported existing Request schema");
    if (!journal) {
      await mkdir(plan.workDir, { mode: 0o700 });
      if (
        (await stat(plan.workDir)).dev !==
        (await stat(dirname(plan.configDir))).dev
      )
        throw new Error("Staging and instance must be on the same filesystem");
      journal = {
        version: 1,
        planDigest,
        phase: "created",
        configDir: plan.configDir,
        workDir: plan.workDir,
        liveE2E: "not-run",
        preflightMode: plan.preflightMode || "online",
      };
      await writeDurableJson(join(plan.workDir, "plan.json"), plan);
      await writeDurableJson(journalPath, journal);
    }
    const update = async (patch) => {
      journal = { ...journal, ...patch, updatedAt: new Date().toISOString() };
      await writeDurableJson(journalPath, journal);
    };
    const commandEnv = {
      ...process.env,
      REMOTELAB_CONFIG_DIR: plan.configDir,
      REMOTELAB_CHAT_BASE_URL: plan.http.baseUrl,
    };
    for (const name of [
      "REMOTELAB_INSTANCE_ROOT",
      "REMOTELAB_MEMORY_DIR",
      "REMOTELAB_PROJECT_ROOT",
      "REMOTELAB_SOURCE_PROJECT_ROOT",
    ])
      delete commandEnv[name];
    const hook = async (name) => {
      for (const [index, cmd] of plan.commands[name].entries()) {
        const argv = Array.isArray(cmd) ? cmd : cmd.argv,
          expected = Array.isArray(cmd) ? 0 : (cmd.exitCode ?? 0);
        let result;
        await update({ commandInFlight: { name, index, identity: null } });
        const pending = exec(argv[0], argv.slice(1), {
          env: commandEnv,
          timeout: plan.timeoutMs,
          maxBuffer: 2 * 1024 * 1024,
        });
        pending.catch(() => {});
        await update({
          commandInFlight: {
            name,
            index,
            identity: await readProcessIdentity(pending.child.pid),
          },
        });
        try {
          const r = await pending;
          result = { exitCode: 0, ...r };
        } catch (error) {
          result = {
            exitCode: error.code,
            stdout: error.stdout,
            stderr: error.stderr,
            killed: error.killed,
            signal: error.signal,
          };
        }
        await update({ commandInFlight: null });
        await writeDurableJson(
          join(
            plan.workDir,
            "logs",
            `${Date.now()}-${name}-${index}-${randomBytes(3).toString("hex")}.json`,
          ),
          result,
        );
        if (result.killed || result.signal) {
          await update({
            phase: "recovery-required",
            error: `${name}[${index}] was interrupted; check command side effects before recovery`,
          });
          throw new Error(journal.error);
        }
        if (
          !Array.isArray(cmd) &&
          cmd.stdout !== undefined &&
          result.stdout?.trim() !== cmd.stdout
        )
          throw new Error(
            `${name}[${index}] returned unexpected output; see private logs`,
          );
        if (result.exitCode !== expected)
          throw new Error(
            `${name}[${index}] failed; expected ${expected}, got ${result.exitCode}; see private logs`,
          );
      }
    };
    const backup = join(plan.workDir, "backup"),
      staging = join(plan.workDir, "staging"),
      failed = join(plan.workDir, "failed-state");
    const rollback = async () => {
      // Persist intent before actions so a killed rollback resumes as rollback.
      await update({ rollbackRequested: true });
      await hook("stop");
      await hook("stopped");
      if (await pathExists(backup)) {
        if (await pathExists(plan.configDir)) {
          const current = digestManifest(await fileManifest(plan.configDir));
          if (journal.installedDigest && current !== journal.installedDigest) {
            await update({
              phase: "recovery-required",
              error:
                "New state changed after cutover; retained both versions. Automatic rollback would discard work.",
            });
            throw new Error(journal.error);
          }
          if (await pathExists(failed))
            throw new Error(
              "Failed-state destination already exists; inspect recovery journal",
            );
          await durableRename(plan.configDir, failed);
        }
        await durableRename(backup, plan.configDir);
      }
      await hook("restore");
      await hook("start");
      const health = await checkHttp(plan, "old");
      await hook("connectorsHealthy");
      await update({ phase: "rolled_back", rollbackVerified: true, health });
      return journal;
    };
    if (journal.commandInFlight) {
      if (!journal.commandInFlight.identity)
        throw new Error(
          "Lifecycle command ownership is uncertain; inspect the private log and journal",
        );
      if (await isProcessIdentityAlive(journal.commandInFlight.identity))
        throw new Error(
          "Prior lifecycle command still running; wait before resuming",
        );
      await update({ commandInFlight: null });
    }
    if (mode === "rollback" || journal.rollbackRequested) {
      if (journal.phase === "rolled_back") return journal;
      try {
        return await rollback();
      } catch (error) {
        if (journal.phase !== "recovery-required")
          await update({
            phase: "rollback_failed",
            rollbackVerified: false,
            error: error.message,
          });
        throw error;
      }
    }
    if (journal.phase === "migrated") return journal;
    if (["preflighting", "converting"].includes(journal.phase)) {
      if (!journal.converterIdentity)
        throw new Error(
          "Converter ownership is uncertain; inspect the journal before removing staging",
        );
      if (await isProcessIdentityAlive(journal.converterIdentity))
        throw new Error(
          "The prior converter is still running; wait before resuming",
        );
    }
    const convert = async (phase) => {
      await update({ phase, converterIdentity: null });
      const running = exec(
        process.execPath,
        [
          converter,
          "--source",
          plan.configDir,
          "--output",
          staging,
          "--final-config-dir",
          plan.configDir,
        ],
        {
          env: commandEnv,
          timeout: 30 * 60 * 1000,
          maxBuffer: 32 * 1024 * 1024,
        },
      );
      running.catch(() => {});
      await update({
        converterIdentity: await readProcessIdentity(running.child.pid),
      });
      const { stdout } = await running;
      return JSON.parse(stdout);
    };
    try {
      if (
        resuming &&
        ["validated", "installing", "installed", "activating"].includes(
          journal.phase,
        )
      ) {
        await hook("stop");
        await hook("stopped");
        if (
          (await pathExists(backup)) &&
          (await pathExists(plan.configDir)) &&
          !(await pathExists(staging)) &&
          digestManifest(await fileManifest(plan.configDir)) !==
            journal.installedDigest
        ) {
          await update({
            phase: "recovery-required",
            error:
              "Installed state changed while upgrade was interrupted; retain both versions for reconciliation",
          });
          throw new Error(journal.error);
        }
      }
      if (!phasesAfterInstall.includes(journal.phase)) {
        if (!(await pathExists(backup))) {
          if (journal.phase === "created") await checkHttp(plan, "old");
          await hook("preflight");
          // Refuse live work before stopping services; this tool never kills Runs.
          const rows = await readdir(join(plan.configDir, "chat-runs")).catch(
            (e) => {
              if (e.code === "ENOENT") return [];
              throw e;
            },
          );
          for (const id of rows.filter((n) => n.startsWith("run_"))) {
            const run = await readRecord(
              join(plan.configDir, "chat-runs", id, "status.json"),
            );
            if (
              !run ||
              !["completed", "failed", "cancelled"].includes(run.state)
            )
              throw new Error(`Unfinished Run blocks upgrade: ${id}`);
          }
          if (plan.preflightMode !== "offline") {
            if (await pathExists(staging)) await rm(staging, { recursive: true });
            const rehearsal = await convert("preflighting");
            const rehearsalVerification = await verifyRequestMigration(
              plan.configDir,
              staging,
            );
            await update({
              phase: "preflight-passed",
              rehearsal: {
                sourceDigest: rehearsal.sourceDigest,
                verification: rehearsalVerification,
              },
            });
          }
          await update({ phase: "stopping" });
          await hook("stop");
          await hook("stopped");
          await assertIdle(plan.configDir);
          if (await pathExists(staging)) await rm(staging, { recursive: true }); // only this journal's unfinished staging
          const report = await convert("converting");
          await writeDurableJson(
            join(plan.workDir, "conversion-report.json"),
            report,
          );
          const verification = await verifyRequestMigration(
            plan.configDir,
            staging,
          );
          await update({
            phase: "validated",
            verification,
            installedDigest: digestManifest(await fileManifest(staging)),
          });
          await durableRename(plan.configDir, backup);
        }
        await update({ phase: "installing" });
      }
      if (journal.phase === "installing") {
        if (!(await pathExists(plan.configDir)))
          await durableRename(staging, plan.configDir);
        if (
          digestManifest(await fileManifest(plan.configDir)) !==
          journal.installedDigest
        )
          throw new Error("Installed state does not match verified staging");
        await update({ phase: "installed" });
      }
      if (["installed", "activating"].includes(journal.phase)) {
        await update({ phase: "activating" });
        await hook("activate");
        await update({ phase: "starting" });
      }
      if (journal.phase === "starting") {
        await hook("start");
        await update({ phase: "checking" });
      }
      const health = await checkHttp(plan, "new");
      await hook("connectorsHealthy");
      await update({ phase: "migrated", health, rollbackRequested: false });
      return journal;
    } catch (error) {
      const original = error.message;
      await update({ error: original });
      if (
        [
          "created",
          "preflighting",
          "preflight-passed",
          "recovery-required",
        ].includes(journal.phase)
      )
        throw error; // preflight failed without stopping anything
      try {
        await rollback();
      } catch (recoveryError) {
        if (journal.phase !== "recovery-required")
          await update({
            phase: "rollback_failed",
            rollbackVerified: false,
            error: recoveryError.message,
          });
        throw new Error(
          `Upgrade failed: ${original}; recovery failed: ${recoveryError.message}`,
        );
      }
      throw new Error(
        `Upgrade failed and old version verified restored: ${original}`,
      );
    }
  });
}
