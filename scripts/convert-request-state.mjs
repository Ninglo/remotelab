#!/usr/bin/env node
// Deployment-only converter. Never imported by the server or connector.
import { cp, mkdir, readdir, stat, chmod } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { realpath } from "node:fs/promises";
import {
  inside,
  fileManifest,
  digestManifest,
} from "../lib/request-migration-files.mjs";
import { planHistoricalIdentities } from "../lib/request-migration-identities.mjs";
import {
  discoverMigrationConnectors,
  migrateConnectorInboxes,
} from "../lib/request-migration-inbox.mjs";
import { readRecord, writeDurableJson } from "../lib/durable-records.mjs";

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--interrupt-unfinished") continue;
  if (
    !["--source", "--output", "--final-config-dir"].includes(args[i]) ||
    !args[i + 1] ||
    args[i + 1].startsWith("--")
  )
    throw new Error("Invalid converter argument");
  i++;
}
if (!args.includes("--source") || !args.includes("--output")) {
  console.error(
    "Usage: node scripts/convert-request-state.mjs --source <stopped-config> --output <new-staging-directory> [--interrupt-unfinished]",
  );
  process.exit(1);
}
const source = await realpath(resolve(option("--source")));
const requestedOutput = resolve(option("--output"));
const output = join(
  await realpath(dirname(requestedOutput)),
  requestedOutput.slice(dirname(requestedOutput).length + 1),
);
const finalConfigDir = args.includes("--final-config-dir")
  ? resolve(option("--final-config-dir"))
  : output;
if (inside(source, output) || inside(output, source))
  throw new Error("Output must be a separate new staging directory");
if (await readRecord(join(source, "requests/schema.json")))
  throw new Error(
    "Source is already converted to a request schema; use upgrade verification",
  );
if (
  (
    await readdir(join(source, "requests")).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    })
  ).length
)
  throw new Error(
    "Partial Request store requires recovery from the original snapshot",
  );
const sourceManifest = await fileManifest(source);
const connectors = await discoverMigrationConnectors(source);
const externalManifests = await Promise.all(
  connectors
    .filter((b) => b.external)
    .map(async (b) => ({
      root: b.storage,
      manifest: await fileManifest(b.storage),
    })),
);
const sourceMode = (await stat(source)).mode & 0o777;
await mkdir(output, { mode: sourceMode }); // Refuse an existing conversion directory.
await chmod(output, sourceMode); // mkdir's umask must not change the instance mode.

for (const name of await readdir(source)) {
  await cp(join(source, name), join(output, name), {
    recursive: true,
    force: false,
    errorOnExist: true,
  });
}
process.env.REMOTELAB_CONFIG_DIR = output;
delete process.env.REMOTELAB_INSTANCE_ROOT;
const { createRequestStore } = await import("../chat/requests.mjs");
const { buildReplyPublicationPayload, collectReplyPublicationHistory } =
  await import("../chat/reply-publication.mjs");
const { buildReplyDeliveries, normalizeSourceDeliveryPlan } = await import(
  "../chat/source-deliveries.mjs"
);
const { loadHistory } = await import("../chat/history.mjs");
const store = createRequestStore(join(output, "requests"));
const report = {
  schema: 1,
  converterVersion: 2,
  source,
  output,
  sourceDigest: digestManifest(sourceManifest),
  identityPolicy: "publication-root-then-earliest-run",
  identityMappings: [],
  runs: [],
  queued: [],
  deliveries: [],
  connectors: [],
  warnings: [],
};
const sessionData =
  (await readRecord(join(output, "chat-sessions.json"))) || [];
const sessions = Array.isArray(sessionData)
  ? sessionData
  : sessionData.sessions || [];
if (sessions.some((session) => (session.completionTargets || []).length))
  throw new Error(
    "Legacy completion targets require explicit reconciliation before conversion",
  );
const sessionById = new Map(sessions.map((session) => [session.id, session]));
const runIds = (
  await readdir(join(output, "chat-runs")).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  })
)
  .filter((name) => /^run_/.test(name))
  .sort();
const unfinished = [];
for (const id of runIds) {
  const run = await readRecord(join(output, "chat-runs", id, "status.json"));
  if (run && !["completed", "failed", "cancelled"].includes(run.state))
    unfinished.push(id);
}
if (unfinished.length && !args.includes("--interrupt-unfinished")) {
  await writeDurableJson(join(output, "conversion-report.json"), {
    ...report,
    unfinished,
  });
  throw new Error(
    "Unfinished attempts require explicit disposition. Wait for them to finish or use --interrupt-unfinished after stopping their executors. Source is unchanged.",
  );
}
const planned = planHistoricalIdentities(
  await Promise.all(
    runIds.map(async (id) => ({
      id,
      status: await readRecord(join(output, "chat-runs", id, "status.json")),
      manifest: await readRecord(
        join(output, "chat-runs", id, "manifest.json"),
      ),
    })),
  ),
);
planned.sort((a, b) => {
  const x = JSON.stringify([
    a.status.sessionId,
    a.status.createdAt || a.status.startedAt || "",
    a.id,
  ]);
  const y = JSON.stringify([
    b.status.sessionId,
    b.status.createdAt || b.status.startedAt || "",
    b.id,
  ]);
  return x < y ? -1 : x > y ? 1 : 0;
});
let historySession = null,
  history = [];
for (const row of planned) {
  const { id, identity } = row;
  const dir = join(output, "chat-runs", id);
  let run = await readRecord(join(dir, "status.json"));
  if (!run) throw new Error(`Missing status: ${id}`);
  const manifest = await readRecord(join(dir, "manifest.json"));
  if (!manifest) throw new Error(`Missing manifest: ${id}`);
  if (historySession !== run.sessionId) {
    history = await loadHistory(run.sessionId, { includeBodies: true });
    historySession = run.sessionId;
  }
  const user = history.find(
    (event) =>
      event.runId === id && event.type === "message" && event.role === "user",
  );
  const requestId = identity.requestId;
  const changed =
    identity.requestId !== row.requestId ||
    identity.responseId !== row.responseId;
  if (changed)
    report.identityMappings.push({
      runId: id,
      sessionId: run.sessionId,
      oldRequestId: row.requestId,
      oldResponseId: row.responseId,
      requestId,
      responseId: identity.responseId,
    });
  const previous = await store.byRequest(run.sessionId, requestId);
  if (previous)
    throw new Error(
      `Multiple attempts share request identity ${run.sessionId}/${requestId}; reconcile explicitly before conversion`,
    );
  const options = {
    ...manifest.options,
    requestId,
    responseId: identity.responseId,
    tool: manifest.tool || run.tool,
    sourceContext: user?.sourceContext,
    sourceDelivery: manifest.sourceDelivery,
    internalOperation: manifest.internalOperation,
    triggerId: manifest.triggerId,
    scheduleId: manifest.scheduleId,
    occurrenceId: manifest.occurrenceId,
    recordUserMessage: !!user,
  };
  const { record } = await store.accept({
    sessionId: run.sessionId,
    requestId,
    runId: id,
    text: user?.content || manifest.prompt || "[historical request]",
    images: manifest.options?.images || [],
    options,
  });
  if (unfinished.includes(id)) {
    run = {
      ...run,
      state: "failed",
      completedAt: new Date().toISOString(),
      failureReason:
        "Execution interrupted during explicit offline conversion; not automatically replayed",
    };
    await writeDurableJson(join(dir, "result.json"), {
      exitCode: 1,
      completedAt: run.completedAt,
      error: run.failureReason,
    });
  }
  const payload = buildReplyPublicationPayload(
    collectReplyPublicationHistory(history, run),
    run,
    {
      session: sessionById.get(run.sessionId),
      fullHistory: history,
    },
  );
  // Old ordinary replies had no reliable outbox. Never infer permission to resend them.
  await store.settle(
    record.key,
    { state: run.state, payload, error: run.failureReason || null },
    [],
  );
  await store.mutate(record.key, (current) => ({
    ...current,
    releasedAt: run.completedAt || new Date().toISOString(),
    postCompletionPending: false,
  }));
  await store.archiveFinished(record.key);
  if (changed)
    run.legacyIdentity = {
      requestId: row.requestId,
      responseId: row.responseId,
    };
  run.requestId = requestId;
  run.responseId = identity.responseId;
  if (changed)
    await writeDurableJson(join(dir, "manifest.json"), {
      ...manifest,
      legacyIdentity: run.legacyIdentity,
      requestId,
      responseId: identity.responseId,
      options: {
        ...manifest.options,
        requestId,
        responseId: identity.responseId,
      },
    });
  delete run.replyPublication;
  delete run.replyPublicationRootRunId;
  await writeDurableJson(join(dir, "status.json"), run);
  report.runs.push({ id, requestId, state: run.state });
}
for (const session of sessions) {
  for (const entry of session.followUpQueue || []) {
    const { record } = await store.accept({
      sessionId: session.id,
      requestId: entry.requestId,
      text: entry.text,
      images: entry.images || [],
      options: { ...entry, responseId: entry.responseId || entry.requestId },
    });
    report.queued.push({ sessionId: session.id, requestId: record.requestId });
  }
  delete session.followUpQueue;
  delete session.recentFollowUpRequestIds;
  delete session.activeRunId;
}
await writeDurableJson(join(output, "chat-sessions.json"), sessionData);
const deliveryData =
  (await readRecord(join(output, "chat-source-deliveries.json"))) || [];
for (const delivery of Array.isArray(deliveryData)
  ? deliveryData
  : deliveryData.deliveries || []) {
  if (
    ![
      "pending",
      "sending",
      "delivered",
      "failed",
      "delivery_failed",
      "cancelled",
    ].includes(delivery.state)
  )
    throw new Error(`Unsupported legacy delivery state: ${delivery.id}`);
  const convertedState =
    delivery.state === "sending"
      ? "unknown"
      : delivery.state === "failed"
        ? "delivery_failed"
        : delivery.state;
  const plan = normalizeSourceDeliveryPlan(delivery);
  if (!plan) throw new Error(`Cannot convert delivery target: ${delivery.id}`);
  const { record } = await store.accept({
    sessionId: delivery.sessionId || "outbound",
    requestId: `converted-delivery:${delivery.id}`,
    text: delivery.text || "[attachment]",
    options: { deliveryOnly: true },
    result: { state: "completed", payload: { text: delivery.text || "" } },
    plans: buildReplyDeliveries(plan, delivery),
  });
  await store.mutate(record.key, (current) => ({
    ...current,
    deliveries: current.deliveries.map((part) => ({
      ...part,
      state: convertedState,
      externalId: delivery.externalId || "",
      triggerId: delivery.triggerId || "",
      scheduleId: delivery.scheduleId || "",
      occurrenceId: delivery.occurrenceId || "",
      lastError:
        delivery.state === "sending"
          ? "Legacy sender receipt requires manual reconciliation"
          : delivery.lastError || "",
    })),
  }));
  await store.archiveFinished(record.key);
  report.deliveries.push({
    oldId: delivery.id,
    newId: record.deliveries[0]?.id,
    partIds: record.deliveries.map((part) => part.id),
    state: convertedState,
  });
}
report.connectors = await migrateConnectorInboxes(
  connectors,
  output,
  finalConfigDir,
);
report.warnings.push(
  "Historical ordinary replies and completion effects are not replayed. Unmatched inbound events are archived for review, not executed.",
);
if (digestManifest(await fileManifest(source)) !== report.sourceDigest)
  throw new Error(
    "Source changed during conversion; staging must not be installed",
  );
for (const entry of externalManifests)
  if (
    digestManifest(await fileManifest(entry.root)) !==
    digestManifest(entry.manifest)
  )
    throw new Error("External connector storage changed during conversion");
await writeDurableJson(
  join(output, "conversion-source-manifest.json"),
  sourceManifest,
);
await writeDurableJson(join(output, "conversion-report.json"), report);
await writeDurableJson(join(output, "requests", "schema.json"), { version: 1 });
console.log(JSON.stringify(report, null, 2));
