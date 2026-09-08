import assert from "node:assert/strict";
import { chmod, stat } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequestStore } from "../chat/requests.mjs";
import { verifyRequestMigration } from "../lib/request-migration-verify.mjs";
import { createConnectorInbox } from "../lib/connector-inbox.mjs";
const exec = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "upgrade-conversion-"));
const source = join(root, "source");
const put = async (path, value) => {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value));
};
try {
  await put(join(source, "chat-sessions.json"), [
    { id: "s", followUpQueue: [] },
  ]);
  for (const [id, requestId, responseId] of [
    ["run_a", "req", "res"],
    ["run_b", "req", "res"],
    ["run_c", "other", "res"],
  ]) {
    await put(join(source, "chat-runs", id, "status.json"), {
      id,
      sessionId: "s",
      requestId,
      responseId,
      state: "completed",
      startedAt: "2026-01-01T00:00:00Z",
    });
    await put(join(source, "chat-runs", id, "manifest.json"), {
      tool: "fake",
      prompt: "old task",
      options: {},
    });
  }
  const bot = join(source, "feishu-connector");
  await put(join(bot, "config.json"), {
    appId: "fixture",
    appSecret: "fixture",
    intakePolicy: { mode: "allow_all" },
  });
  await put(join(bot, "handled-messages.json"), {
    messages: {
      handled: { status: "sent", responseMessageId: "remote-receipt" },
    },
  });
  await writeFile(
    join(bot, "events.jsonl"),
    [
      { summary: { messageId: "handled", chatId: "chat" }, allowed: true },
      {
        summary: {
          messageId: "unknown",
          chatId: "chat",
          text: "uncertain old message",
        },
        allowed: true,
      },
    ]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const external = join(root, "external");
  await put(join(external, "handled-messages.json"), {
    messages: { handled: { status: "sent" } },
  });
  await writeFile(join(external, "attachment.txt"), "preserved bytes");
  await put(join(source, "feishu-connectors/bot-2/config.json"), {
    appId: "two",
    appSecret: "two",
    storageDir: external,
    intakePolicy: {
      mode: "whitelist",
      allowedSenders: { openIds: ["sender-a"] },
    },
  });
  await put(join(source, "chat-source-deliveries.json"), [
    {
      id: "failed-notice",
      connector: "feishu",
      sourceRouteId: "default",
      sessionId: "s",
      target: { chatId: "chat" },
      state: "failed",
      text: "failed send",
    },
  ]);
  const before = await readFile(
    join(source, "chat-runs/run_b/status.json"),
    "utf8",
  );
  const convert = async (output) =>
    exec(process.execPath, [
      "scripts/convert-request-state.mjs",
      "--source",
      source,
      "--output",
      output,
    ]);
  await chmod(source, 0o700);
  const out = join(root, "out");
  await convert(out);
  assert.equal(
    (await stat(out)).mode & 0o777,
    0o700,
    "instance directory must stay private",
  );
  const report = JSON.parse(
    await readFile(join(out, "conversion-report.json"), "utf8"),
  );
  assert.equal(report.runs.length, 3);
  await verifyRequestMigration(source, out);
  const bot2 = report.connectors.find((b) => b.externalStorageCopied);
  assert.ok(bot2);
  assert.equal(
    await readFile(join(out, bot2.storage, "attachment.txt"), "utf8"),
    "preserved bytes",
  );
  const policy = JSON.parse(
    await readFile(join(out, bot2.config)),
  ).accessPolicy;
  assert.equal(policy.mode, "whitelist");
  assert.deepEqual(policy.allowedSenders.openIds, ["sender-a"]);
  assert.equal(report.deliveries[0].state, "delivery_failed");
  const store = createRequestStore(join(out, "requests"));
  assert.equal((await store.byRequest("s", "req")).runId, "run_a");
  assert.equal((await store.byResponse("s", "res")).runId, "run_a");
  for (const id of ["run_a", "run_b", "run_c"])
    assert.equal((await store.byRunId(id)).runId, id);
  assert.equal(report.identityMappings.length, 2);
  assert.equal(
    await readFile(join(source, "chat-runs/run_b/status.json"), "utf8"),
    before,
  );
  let processed = 0;
  const inbox = createConnectorInbox(join(out, "feishu-connector/inbox"), {
    conversationKey: () => "",
    process: async () => {
      processed++;
    },
  });
  assert.equal(
    (
      await inbox.accept("handled", {
        summary: { messageId: "handled", chatId: "chat", extra: "redelivery" },
      })
    ).complete,
    true,
  );
  assert.equal(
    (
      await inbox.accept("unknown", {
        summary: { messageId: "unknown", chatId: "chat" },
      })
    ).complete,
    true,
  );
  await inbox.tick();
  await inbox.idle();
  assert.equal(processed, 0);
  assert.equal(report.connectors[0].reviewRequired, 1);
  assert.equal(report.connectors[0].handledImported, 1);
  assert.equal(
    JSON.parse(await readFile(join(out, "feishu-connector/config.json")))
      .accessPolicy.mode,
    "all",
  );
  const second = join(root, "second");
  await convert(second);
  assert.deepEqual(
    JSON.parse(await readFile(join(second, "conversion-report.json")))
      .identityMappings,
    report.identityMappings,
  );
  await assert.rejects(convert(out), /exist|converted/);
  await assert.rejects(
    exec(process.execPath, [
      "scripts/convert-request-state.mjs",
      "--source",
      out,
      "--output",
      join(root, "again"),
    ]),
    /already.*schema|already.*converted/i,
  );
  await writeFile(join(out, bot2.storage, "attachment.txt"), "corrupted");
  await assert.rejects(
    verifyRequestMigration(source, out),
    /Changed external storage file/,
  );
  await symlink(join(external, "attachment.txt"), join(source, "linked-asset"));
  await assert.rejects(
    convert(join(root, "symlink-output")),
    /Symlink requires/,
  );
  console.log(
    "upgrade conversion: deterministic identity preservation, imported dedup, quarantined uncertainty, external storage, whitelist retention, tamper detection and repeat refusal passed",
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
