import { createHash } from "node:crypto";
import { cp, readFile, readdir } from "node:fs/promises";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import {
  canonicalJson,
  createRecordStore,
  readRecord,
  writeDurableJson,
} from "./durable-records.mjs";
import {
  inside,
  pathExists,
  fileManifest,
} from "./request-migration-files.mjs";

export async function discoverMigrationConnectors(source) {
  const paths = new Set([join(source, "feishu-connector/config.json")]);
  for (const name of await readdir(join(source, "feishu-connectors")).catch(
    (e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    },
  ))
    paths.add(join(source, "feishu-connectors", name, "config.json"));
  const registry = await readRecord(join(source, "feishu-bots.json"));
  for (const bot of registry?.bots || []) {
    if (!bot.configPath) continue;
    const path = resolve(bot.configPath);
    if (!inside(source, path))
      throw new Error(
        `External connector config must be included in the instance before migration: ${path}`,
      );
    paths.add(path);
  }
  const result = [];
  for (const path of [...paths].sort()) {
    if (!(await pathExists(path))) continue;
    const config = await readRecord(path);
    if (config.storageDir && !isAbsolute(config.storageDir))
      throw new Error(
        `Relative connector storage needs an explicit absolute path: ${path}`,
      );
    const storage = config.storageDir
      ? resolve(config.storageDir)
      : dirname(path);
    if (storage === source || inside(storage, source))
      throw new Error(
        `Connector storage cannot contain the instance: ${storage}`,
      );
    const external = !inside(source, storage);
    const storageRelative = external
      ? join(
          "migrated-connector-storage",
          createHash("sha256")
            .update(relative(source, path))
            .digest("hex")
            .slice(0, 16),
        )
      : relative(source, storage);
    await fileManifest(storage); // rejects symlink escape before any conversion writes
    result.push({
      path,
      relative: relative(source, path),
      storage,
      storageRelative,
      external,
      config,
    });
  }
  const roots = new Set();
  for (const bot of result) {
    if (roots.has(bot.storage))
      throw new Error(`Two connectors share a storage root: ${bot.storage}`);
    roots.add(bot.storage);
  }
  return result;
}

async function migratePolicy(config, path) {
  const next = { ...config };
  const changes = [];
  if (config.intakePolicy) {
    if (config.accessPolicy)
      throw new Error(`Both old and new access policies exist: ${path}`);
    const old = config.intakePolicy;
    if (!["allow_all", "whitelist"].includes(old.mode || "allow_all"))
      throw new Error(`Unknown old access policy: ${path}`);
    next.accessPolicy = {
      mode: old.mode === "whitelist" ? "whitelist" : "all",
    };
    if (next.accessPolicy.mode === "whitelist") {
      for (const key of ["allowedSendersPath", "accessStatePath"])
        if (old[key] && String(old[key]).startsWith("~"))
          throw new Error(
            `Resolve ${key} to the instance owner's absolute path before migration: ${path}`,
          );
      for (const key of ["allowedSendersPath", "accessStatePath"])
        if (old[key] && !(await pathExists(resolve(dirname(path), old[key]))))
          throw new Error(`Missing explicitly configured ${key}: ${path}`);
      const whitelist =
        (await readRecord(
          old.allowedSendersPath
            ? resolve(dirname(path), old.allowedSendersPath)
            : join(dirname(path), "allowed-senders.json"),
        )) || {};
      const state =
        (await readRecord(
          old.accessStatePath
            ? resolve(dirname(path), old.accessStatePath)
            : join(dirname(path), "access-state.json"),
        )) || {};
      next.accessPolicy.allowedSenders = Object.fromEntries(
        ["openIds", "userIds", "unionIds", "tenantKeys"].map((key) => [
          key,
          [
            ...new Set([
              ...(old.allowedSenders?.[key] || []),
              ...(whitelist[key] || []),
              ...(state.allowedSenders?.[key] || []),
            ]),
          ].sort(),
        ]),
      );
    }
    delete next.intakePolicy;
    changes.push(
      "intakePolicy converted to accessPolicy; stored sender whitelist retained",
    );
  }
  for (const key of [
    "groupReplyPolicy",
    "processingReaction",
    "silentConfirmationText",
  ]) {
    if (Object.hasOwn(next, key)) {
      delete next[key];
      changes.push(`${key} removed by current connector contract`);
    }
  }
  if (!next.responsePolicy) {
    next.responsePolicy = { group: "mention_only" };
    changes.push(
      "group responses default to mentions only; private access unchanged",
    );
  }
  if (!["all", "mention_only"].includes(next.responsePolicy.group))
    throw new Error(`Unsupported group response policy: ${path}`);
  if (
    next.accessPolicy &&
    !["all", "whitelist"].includes(next.accessPolicy.mode)
  )
    throw new Error(`Unsupported access policy: ${path}`);
  return { next, changes };
}

export async function migrateConnectorInboxes(
  connectors,
  output,
  finalConfigDir,
) {
  const reports = [];
  for (const bot of connectors) {
    const target = join(output, bot.storageRelative);
    if (bot.external)
      await cp(bot.storage, target, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    const { next, changes } = await migratePolicy(bot.config, bot.path);
    if (bot.config.storageDir || bot.external)
      next.storageDir = join(finalConfigDir, bot.storageRelative);
    await writeDurableJson(join(output, bot.relative), next);
    const text = await readFile(
      join(bot.storage, "events.jsonl"),
      "utf8",
    ).catch((e) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    const events = new Map();
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      const event = JSON.parse(line),
        id = event.summary?.messageId || event.summary?.eventId;
      if (!id)
        throw new Error(
          `Event missing upstream identity: ${bot.storage}:${index + 1}`,
        );
      if (!events.has(id)) events.set(id, { ...event, line: index + 1 });
    }
    const handled =
      (await readRecord(join(bot.storage, "handled-messages.json")))
        ?.messages || {};
    const store = createRecordStore(join(target, "inbox"));
    const review = [];
    let sequence =
      (await readRecord(join(target, "inbox/sequence.json")))?.value || 0;
    let handledImported = 0;
    for (const id of [
      ...new Set([...events.keys(), ...Object.keys(handled)]),
    ].sort()) {
      const key = createHash("sha256").update(id).digest("hex").slice(0, 24);
      const prior = await store.get(key);
      if (prior) {
        if (!prior.complete)
          throw new Error(
            `Active Inbox needs reconciliation before legacy conversion: ${id}`,
          );
        if (Object.hasOwn(handled, id)) handledImported++;
        continue;
      }
      const event = events.get(id),
        receipt = Object.hasOwn(handled, id) ? handled[id] : null;
      const uncertain = !receipt && event?.allowed !== false;
      const summary = event?.summary || { messageId: id };
      if (uncertain)
        review.push({
          upstreamId: id,
          line: event?.line,
          reason:
            "No legacy handled receipt; retained without execution or resend",
        });
      if (receipt) handledImported++;
      await store.mutate(key, () => ({
        id,
        summary,
        raw: event?.raw || null,
        sourceLabel: event?.sourceLabel || "legacy-migration",
        fingerprint: canonicalJson(summary),
        sequence: ++sequence,
        complete: true,
        nextAttemptAt: 0,
        legacyReceiptImported: true,
        receipt: {
          ...(receipt || {
            status: uncertain ? "migration_review_required" : "blocked",
          }),
          legacyHandledMessageId: id,
        },
      }));
      await store.archive(key);
    }
    await writeDurableJson(join(target, "inbox/sequence.json"), {
      value: sequence,
    });
    await writeDurableJson(join(target, "migration-review.json"), {
      version: 1,
      entries: review,
    });
    reports.push({
      config: bot.relative,
      storage: bot.storageRelative,
      storageSource: bot.storage,
      externalStorageCopied: bot.external,
      handledImported,
      reviewRequired: review.length,
      reviewPath: join(bot.storageRelative, "migration-review.json"),
      policyChanges: changes,
    });
  }
  return reports;
}
