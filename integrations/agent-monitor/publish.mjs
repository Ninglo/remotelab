#!/usr/bin/env node
// Run on the RemoteLab host, or publish an already sanitized snapshot on a Dev host.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, rename, unlink, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { parseAgentSnapshot } from "./contract.mjs";
export function buildAgentSnapshot(sessions, overview, source, now = Date.now()) {
  const s = sessions === null ? null : sessions, a = overview === null ? null : overview;
  const accountSummary = a ? { available: 0, exhausted: 0, unknown: 0 } : null;
  if (a) for (const account of a.accounts) accountSummary[account.status === 'available' ? 'available' : account.status === 'exhausted' ? 'exhausted' : 'unknown']++;
  return parseAgentSnapshot({ schema: 1, accountSummary, source, publishedAt: new Date(now).toISOString(),
    dashboard: s?.agentDashboard ?? null,
    accounts: a ? { generatedAt: a.generatedAt, items: a.accounts } : null,
  }, now);
}

const exec = promisify(execFile);


export async function collect(source, cli = process.env.REMOTELAB_PROJECT_ROOT && resolve(process.env.REMOTELAB_PROJECT_ROOT, "cli.js")) {
  const get = async path => {
    const command = cli ? process.execPath : "remotelab";
    const args = [...(cli ? [cli] : []), "api", "GET", path];
    const { stdout } = await exec(command, args, { timeout: 45000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(stdout);
  };
  const values = await Promise.allSettled([get("/api/monitoring/sessions?days=7&compact=1&dashboard=1"), get("/api/monitoring/overview?days=7")]);
  if (values.every(v => v.status === "rejected")) throw new Error("Both sources unavailable");
  return buildAgentSnapshot(...values.map(v => v.status === "fulfilled" ? v.value : null), source);
}
export async function writeAtomic(file, payload) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, payload, { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
  finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
export async function publish(payload) {
  const destination = process.env.AGENT_MONITOR_DESTINATION;
  const { AGENT_MONITOR_KUBE_CONTEXT: context, AGENT_MONITOR_NAMESPACE: namespace, AGENT_MONITOR_DEPLOYMENT: deployment } = process.env;
  if (!destination?.startsWith("/") || !context || !namespace || !deployment) throw new Error("Publish target not configured");
  const kube = ["--context", context, "-n", namespace];
  // Feed stdin with spawn: no shell interpolation of data or secrets, and atomic NAS replacement.
  const { spawn } = await import("node:child_process");
  const script = 'mkdir -p "$1"; tmp=$(mktemp "$1/.snapshot.XXXXXX"); trap \'rm -f "$tmp"\' EXIT; cat > "$tmp"; chmod 644 "$tmp"; mv -f "$tmp" "$1/latest.json"';
  await new Promise((resolve, reject) => {
    const child = spawn("kubectl", [...kube, "exec", "-i", `deployment/${deployment}`, "--", "sh", "-ceu", script, "sh", destination], { stdio: ["pipe", "ignore", "pipe"], timeout: 60000 });
    child.stderr.resume(); child.stdin.on("error", () => {});
    child.on("error", reject); child.on("close", code => code === 0 ? resolve() : reject(new Error("Publish failed")));
    child.stdin.end(payload);
  });
}
async function main() {
  const args = process.argv.slice(2), options = {};
  while (args.length) {
    const key = args.shift();
    if (key === "--publish") options.publish = true;
    else if (["--input", "--output", "--source", "--cli"].includes(key) && args.length) options[key.slice(2)] = args.shift();
    else throw new Error("Usage: publish.mjs [--source label] [--cli /path/cli.js] [--input snapshot.json] [--output snapshot.json] [--publish]");
  }
  if (!options.output && !options.publish) throw new Error("An output or publish destination is required");
  let snapshot;
  if (options.input) {
    const body = await readFile(options.input); if (body.length > 256 * 1024) throw new Error("Snapshot too large");
    snapshot = parseAgentSnapshot(JSON.parse(body));
  } else snapshot = await collect(options.source || "RemoteLab", options.cli);
  const payload = JSON.stringify(snapshot) + "\n";
  if (Buffer.byteLength(payload) > 256 * 1024) throw new Error("Snapshot too large");
  if (options.output) await writeAtomic(resolve(options.output), payload);
  if (options.publish) await publish(payload);
  console.log(JSON.stringify({ ok: true, bytes: Buffer.byteLength(payload), dashboard: Boolean(snapshot.dashboard), accounts: Boolean(snapshot.accounts), published: Boolean(options.publish), generatedAt: snapshot.publishedAt }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(() => { console.error("Agent snapshot update failed; previous destination retained. Check source connectivity, configuration and Dev access."); process.exitCode = 1; });
}
