import assert from "node:assert/strict";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { createRequestStore } from "../chat/requests.mjs";
import { readRecord, canonicalJson } from "./durable-records.mjs";
import { fileManifest } from "./request-migration-files.mjs";

export async function verifyRequestMigration(source, output) {
  const report = await readRecord(join(output, "conversion-report.json"));
  assert.equal(
    report?.converterVersion,
    2,
    "Missing completed converter report",
  );
  assert.equal(
    (await readRecord(join(output, "requests/schema.json")))?.version,
    1,
    "Missing schema marker",
  );
  const before = await fileManifest(source),
    after = await fileManifest(output);
  const allowed = new Set([
    "chat-sessions.json",
    ...(report.connectors || []).map((b) => b.config),
  ]);
  for (const row of report.runs) {
    allowed.add(`chat-runs/${row.id}/status.json`);
    if (report.identityMappings.some((m) => m.runId === row.id))
      allowed.add(`chat-runs/${row.id}/manifest.json`);
    const old = await readRecord(
      join(source, "chat-runs", row.id, "status.json"),
    );
    assert.equal(
      row.state,
      ["completed", "failed", "cancelled"].includes(old.state)
        ? old.state
        : "failed",
      "Unexpected terminal state conversion",
    );
    if (!["completed", "failed", "cancelled"].includes(old.state))
      allowed.add(`chat-runs/${row.id}/result.json`);
  }
  for (const [path, entry] of Object.entries(before)) {
    assert.ok(after[path], `Missing copied file: ${path}`);
    if (!allowed.has(path))
      assert.deepEqual(after[path], entry, `Changed preserved file: ${path}`);
  }
  const ids = (
    await readdir(join(source, "chat-runs")).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    })
  )
    .filter((n) => n.startsWith("run_"))
    .sort();
  assert.deepEqual(
    report.runs.map((r) => r.id).sort(),
    ids,
    "Run count/identity mismatch",
  );
  const store = createRequestStore(join(output, "requests"));
  for (const row of report.runs) {
    const record = await store.byRunId(row.id),
      status = await readRecord(
        join(output, "chat-runs", row.id, "status.json"),
      );
    assert.ok(record, `Missing converted Request: ${row.id}`);
    for (const key of ["sessionId", "requestId", "responseId"])
      assert.equal(record[key], status[key], `${row.id}: ${key}`);
    assert.equal(record.result?.state, row.state);
    assert.equal(
      (await store.byResponse(record.sessionId, record.responseId))?.key,
      record.key,
    );
    assert.equal(
      (await store.byRequest(record.sessionId, record.requestId))?.key,
      record.key,
    );
  }
  const oldSessions =
    (await readRecord(join(source, "chat-sessions.json"))) || [];
  const expected = structuredClone(oldSessions);
  for (const session of Array.isArray(expected)
    ? expected
    : expected.sessions || []) {
    for (const entry of session.followUpQueue || []) {
      const record = await store.byRequest(session.id, entry.requestId);
      assert.equal(record?.text, entry.text);
      assert.deepEqual(record.images, entry.images || []);
    }
    delete session.followUpQueue;
    delete session.recentFollowUpRequestIds;
    delete session.activeRunId;
  }
  assert.equal(
    canonicalJson(await readRecord(join(output, "chat-sessions.json"))),
    canonicalJson(expected),
    "Session metadata changed unexpectedly",
  );
  const legacy =
    (await readRecord(join(source, "chat-source-deliveries.json"))) || [];
  const legacyRows = Array.isArray(legacy) ? legacy : legacy.deliveries || [];
  assert.deepEqual(
    report.deliveries.map((d) => d.oldId).sort(),
    legacyRows.map((d) => d.id).sort(),
    "Legacy delivery set mismatch",
  );
  for (const delivery of report.deliveries) {
    assert.ok(
      (Array.isArray(legacy) ? legacy : legacy.deliveries || []).some(
        (d) => d.id === delivery.oldId,
      ),
    );
    for (const partId of delivery.partIds) {
      const key = partId.split("_")[1];
      const record = await store.get(key);
      const part = record?.deliveries.find((d) => d.id === partId);
      assert.equal(
        part?.state,
        delivery.state,
        `Legacy delivery lost: ${partId}`,
      );
    }
  }
  for (const bot of report.connectors) {
    if (bot.externalStorageCopied) {
      const external = await fileManifest(bot.storageSource);
      for (const [path, entry] of Object.entries(external)) {
        if (path.startsWith("inbox/") || path === "migration-review.json")
          continue;
        assert.deepEqual(
          after[join(bot.storage, path)],
          entry,
          `Changed external storage file: ${path}`,
        );
      }
    }
    const old =
      (await readRecord(join(bot.storageSource, "handled-messages.json")))
        ?.messages || {};
    const archive = join(output, bot.storage, "inbox/archive");
    const imported = new Set();
    for (const name of await readdir(archive).catch((e) => {
      if (e.code === "ENOENT") return [];
      throw e;
    })) {
      const record = await readRecord(join(archive, name));
      if (record?.legacyReceiptImported && record.complete)
        imported.add(record.receipt?.legacyHandledMessageId);
    }
    for (const id of Object.keys(old))
      assert.ok(imported.has(id), `Missing legacy handled receipt: ${id}`);
  }
  return {
    runs: ids.length,
    preservedFiles: Object.keys(before).length,
    deliveries: report.deliveries.length,
    identityMappings: report.identityMappings.length,
    connectors: report.connectors.map(
      ({ config, handledImported, reviewRequired, policyChanges }) => ({
        config,
        handledImported,
        reviewRequired,
        policyChanges,
      }),
    ),
  };
}
