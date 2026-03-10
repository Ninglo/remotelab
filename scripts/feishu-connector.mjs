#!/usr/bin/env node

import { appendFile, mkdir, readFile, writeFile } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { setTimeout as delay } from "timers/promises";
import * as Lark from "@larksuiteoapi/node-sdk";

import { AUTH_FILE, CHAT_PORT } from "../lib/config.mjs";

const DEFAULT_CONFIG_PATH = join(
  homedir(),
  ".config",
  "remotelab",
  "feishu-connector",
  "config.json",
);
const DEFAULT_CHAT_BASE_URL = `http://127.0.0.1:${CHAT_PORT}`;
const DEFAULT_SESSION_TOOL = "codex";
const DEFAULT_SESSION_SYSTEM_PROMPT = [
  "You are replying as a Feishu bot powered by RemoteLab on the user's own machine.",
  "For each assistant turn, output exactly the plain-text message to send back to Feishu.",
  "Keep replies concise, helpful, and natural.",
  "Match the user's language when practical.",
  "Do not mention hidden connector, session, or run internals unless the user explicitly asks.",
].join("\n");
const RUN_POLL_INTERVAL_MS = 1500;
const RUN_POLL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_FEISHU_TEXT_LENGTH = 5000;

function parseArgs(argv) {
  const options = {
    configPath: DEFAULT_CONFIG_PATH,
    durationMs: 0,
    replayLast: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--config") {
      options.configPath = argv[index + 1] || "";
      index += 1;
      continue;
    }
    if (arg === "--duration-ms") {
      options.durationMs = parseDuration(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--replay-last") {
      options.replayLast = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      printUsage(0);
    }
    printUsage(1);
  }

  if (!options.configPath) {
    throw new Error("Missing config path");
  }

  return options;
}

function parseDuration(value) {
  const parsed = Number.parseInt(value || "", 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid --duration-ms value: ${value || "(missing)"}`);
  }
  return parsed;
}

function printUsage(exitCode) {
  const message = `Usage:
  node scripts/feishu-connector.mjs [options]

Options:
  --config <path>        Config file path (default: ${DEFAULT_CONFIG_PATH})
  --duration-ms <ms>     Optional smoke-test duration before exit
  --replay-last          Reprocess the latest stored inbound message once
  -h, --help             Show this help

Config shape:
  {
    "appId": "cli_xxx",
    "appSecret": "xxxx",
    "region": "feishu-cn",
    "loggerLevel": "info",
    "chatBaseUrl": "${DEFAULT_CHAT_BASE_URL}",
    "sessionFolder": "${homedir()}",
    "sessionTool": "${DEFAULT_SESSION_TOOL}",
    "model": "",
    "effort": "",
    "thinking": false,
    "systemPrompt": "${DEFAULT_SESSION_SYSTEM_PROMPT.replace(/"/g, '\\"')}",
    "intakePolicy": {
      "mode": "allow_all",
      "allowedSenders": {
        "openIds": [],
        "userIds": [],
        "unionIds": [],
        "tenantKeys": []
      }
    }
  }
`;
  const output = exitCode === 0 ? console.log : console.error;
  output(message);
  process.exit(exitCode);
}

function trimString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeRegion(value) {
  const normalized = trimString(value).toLowerCase();
  if (
    !normalized ||
    normalized === "feishu" ||
    normalized === "feishu-cn" ||
    normalized === "cn"
  )
    return "feishu-cn";
  if (
    normalized === "lark" ||
    normalized === "lark-global" ||
    normalized === "global" ||
    normalized === "sg"
  )
    return "lark-global";
  throw new Error(`Unsupported region: ${value || "(missing)"}`);
}

function resolveDomain(region) {
  return region === "lark-global" ? Lark.Domain.Lark : Lark.Domain.Feishu;
}

function resolveLoggerLevel(value) {
  const normalized = trimString(value || "info").toLowerCase();
  if (normalized === "debug") return Lark.LoggerLevel.debug;
  if (normalized === "warn") return Lark.LoggerLevel.warn;
  if (normalized === "error") return Lark.LoggerLevel.error;
  return Lark.LoggerLevel.info;
}

function normalizeStringArray(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(
    new Set(values.map((value) => trimString(value)).filter(Boolean)),
  );
}

function normalizeIntakePolicy(value) {
  const mode = trimString(value?.mode || "allow_all").toLowerCase();
  if (!["allow_all", "whitelist"].includes(mode)) {
    throw new Error(
      `Unsupported intakePolicy.mode: ${value?.mode || "(missing)"}`,
    );
  }

  const allowedSenders = value?.allowedSenders || {};
  return {
    mode,
    allowedSenders: {
      openIds: normalizeStringArray(allowedSenders.openIds),
      userIds: normalizeStringArray(allowedSenders.userIds),
      unionIds: normalizeStringArray(allowedSenders.unionIds),
      tenantKeys: normalizeStringArray(allowedSenders.tenantKeys),
    },
  };
}

function normalizeBaseUrl(baseUrl) {
  const normalized = trimString(baseUrl);
  if (!normalized) {
    throw new Error("chat base URL is required");
  }
  return normalized.replace(/\/+$/, "");
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function normalizeSystemPrompt(value) {
  const normalized = trimString(value);
  return normalized || DEFAULT_SESSION_SYSTEM_PROMPT;
}

async function loadConfig(pathname) {
  const raw = await readFile(pathname, "utf8");
  const parsed = JSON.parse(raw);
  const appId = trimString(parsed?.appId);
  const appSecret = trimString(parsed?.appSecret);
  if (!appId) throw new Error(`Missing appId in ${pathname}`);
  if (!appSecret) throw new Error(`Missing appSecret in ${pathname}`);
  return {
    appId,
    appSecret,
    region: normalizeRegion(parsed?.region),
    loggerLevel: trimString(parsed?.loggerLevel || "info"),
    storageDir: trimString(parsed?.storageDir) || dirname(pathname),
    intakePolicy: normalizeIntakePolicy(parsed?.intakePolicy),
    storeRawEvents: parsed?.storeRawEvents === true,
    chatBaseUrl: normalizeBaseUrl(parsed?.chatBaseUrl || DEFAULT_CHAT_BASE_URL),
    sessionFolder: trimString(parsed?.sessionFolder) || homedir(),
    sessionTool: trimString(parsed?.sessionTool) || DEFAULT_SESSION_TOOL,
    model: trimString(parsed?.model),
    effort: trimString(parsed?.effort),
    thinking: normalizeBoolean(parsed?.thinking, false),
    systemPrompt: normalizeSystemPrompt(parsed?.systemPrompt),
  };
}

function parseTextPreview(rawContent) {
  const content = trimString(rawContent);
  if (!content) return "";
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed?.text === "string") {
      return parsed.text;
    }
  } catch {}
  return "";
}

function summarizeEvent(data) {
  const sender = data?.sender || {};
  const senderId = sender?.sender_id || {};
  const message = data?.message || {};
  const mentions = Array.isArray(message.mentions) ? message.mentions : [];
  const rawContent = typeof message.content === "string" ? message.content : "";
  return {
    eventId: data?.event_id || "",
    eventType: data?.event_type || "",
    tenantKey: data?.tenant_key || "",
    appId: data?.app_id || "",
    createTime: data?.create_time || "",
    sender: {
      openId: senderId?.open_id || "",
      userId: senderId?.user_id || "",
      unionId: senderId?.union_id || "",
      senderType: sender?.sender_type || "",
      tenantKey: sender?.tenant_key || "",
    },
    chatId: message.chat_id || "",
    chatType: message.chat_type || "",
    messageId: message.message_id || "",
    rootId: message.root_id || "",
    parentId: message.parent_id || "",
    threadId: message.thread_id || "",
    messageType: message.message_type || "",
    mentions: mentions.map((mention) => ({
      key: mention?.key || "",
      name: mention?.name || "",
      openId: mention?.id?.open_id || "",
      userId: mention?.id?.user_id || "",
      unionId: mention?.id?.union_id || "",
      tenantKey: mention?.tenant_key || "",
    })),
    textPreview: parseTextPreview(rawContent),
    rawContent,
  };
}

function summarizeLegacyMessageEvent(data) {
  return {
    eventId: data?.uuid || data?.event_id || "",
    eventType: "message",
    tenantKey: data?.tenant_key || "",
    appId: data?.app_id || "",
    createTime: data?.ts || "",
    sender: {
      openId: data?.open_id || data?.sender?.open_id || "",
      userId: data?.employee_id || data?.sender?.employee_id || "",
      unionId: "",
      senderType: "user",
      tenantKey: data?.tenant_key || "",
    },
    chatId: data?.open_chat_id || data?.chat_id || "",
    chatType: data?.chat_type || "",
    messageId: data?.open_message_id || data?.message_id || "",
    rootId: "",
    parentId: "",
    threadId: "",
    messageType: data?.msg_type || data?.message_type || "",
    mentions: [],
    textPreview:
      typeof data?.text_without_at_bot === "string"
        ? data.text_without_at_bot
        : "",
    rawContent: typeof data?.text === "string" ? data.text : "",
  };
}

async function ensureDir(pathname) {
  await mkdir(pathname, { recursive: true });
}

async function appendJsonl(pathname, value) {
  await ensureDir(dirname(pathname));
  await appendFile(pathname, `${JSON.stringify(value)}\n`, "utf8");
}

async function readJson(pathname, fallback) {
  try {
    const raw = await readFile(pathname, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(pathname, value) {
  await ensureDir(dirname(pathname));
  await writeFile(pathname, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function senderIdentity(summary) {
  return {
    openId: summary?.sender?.openId || "",
    userId: summary?.sender?.userId || "",
    unionId: summary?.sender?.unionId || "",
    tenantKey: summary?.sender?.tenantKey || summary?.tenantKey || "",
    senderType: summary?.sender?.senderType || "",
    firstSeenMessageId: summary?.messageId || "",
    lastSeenMessageId: summary?.messageId || "",
    lastSeenChatId: summary?.chatId || "",
    lastSeenChatType: summary?.chatType || "",
    lastTextPreview: summary?.textPreview || "",
    mentionKeys: Array.isArray(summary?.mentions)
      ? summary.mentions.map((mention) => mention.key).filter(Boolean)
      : [],
  };
}

function mergeSenderIdentity(existing, incoming) {
  return {
    openId: existing?.openId || incoming.openId,
    userId: existing?.userId || incoming.userId,
    unionId: existing?.unionId || incoming.unionId,
    tenantKey: existing?.tenantKey || incoming.tenantKey,
    senderType: incoming.senderType || existing?.senderType || "",
    firstSeenMessageId:
      existing?.firstSeenMessageId || incoming.firstSeenMessageId,
    lastSeenMessageId:
      incoming.lastSeenMessageId || existing?.lastSeenMessageId || "",
    lastSeenChatId: incoming.lastSeenChatId || existing?.lastSeenChatId || "",
    lastSeenChatType:
      incoming.lastSeenChatType || existing?.lastSeenChatType || "",
    lastTextPreview:
      incoming.lastTextPreview || existing?.lastTextPreview || "",
    mentionKeys: Array.from(
      new Set([
        ...(existing?.mentionKeys || []),
        ...(incoming.mentionKeys || []),
      ]),
    ),
  };
}

function senderKey(identity) {
  return (
    identity.openId ||
    identity.userId ||
    identity.unionId ||
    identity.tenantKey ||
    "unknown_sender"
  );
}

async function updateKnownSenders(pathname, summary) {
  const current = await readJson(pathname, { senders: {} });
  const incoming = senderIdentity(summary);
  const key = senderKey(incoming);
  current.senders[key] = mergeSenderIdentity(current.senders[key], incoming);
  await writeJson(pathname, current);
}

function isAllowedByPolicy(policy, summary) {
  if (policy.mode !== "whitelist") return true;
  const sender = summary.sender || {};
  const allowed = policy.allowedSenders || {};
  return (
    allowed.openIds.includes(sender.openId) ||
    allowed.userIds.includes(sender.userId) ||
    allowed.unionIds.includes(sender.unionId) ||
    allowed.tenantKeys.includes(sender.tenantKey || summary.tenantKey)
  );
}

async function recordInboundEvent(
  config,
  eventsLogPath,
  knownSendersPath,
  summary,
  raw,
  sourceLabel,
) {
  const allowed = isAllowedByPolicy(config.intakePolicy, summary);
  const record = {
    receivedAt: nowIso(),
    sourceLabel,
    allowed,
    summary,
    raw: config.storeRawEvents ? raw : undefined,
  };
  await appendJsonl(eventsLogPath, record);
  await updateKnownSenders(knownSendersPath, summary);
  console.log(
    `[feishu-connector] inbound event ${sourceLabel} (${allowed ? "allowed" : "blocked"})`,
    JSON.stringify(summary),
  );
  if (!allowed) {
    console.log("[feishu-connector] sender blocked by whitelist policy");
  }
  return allowed;
}

function containsCjk(text) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(text || "");
}

function sanitizeIdPart(value) {
  return (
    String(value || "")
      .trim()
      .replace(/[^a-zA-Z0-9._:-]+/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") || "unknown"
  );
}

function buildExternalTriggerId(summary) {
  return `feishu:${sanitizeIdPart(summary.chatType || "chat")}:${sanitizeIdPart(summary.chatId || "unknown_chat")}`;
}

function buildRequestId(summary) {
  return `feishu:${sanitizeIdPart(summary.messageId || `${Date.now()}`)}`;
}

function buildReplyUuid(summary) {
  return `reply:${sanitizeIdPart(summary.messageId || `${Date.now()}`).slice(0, 60)}`;
}

function buildSessionName(summary) {
  const chatType = trimString(summary.chatType) || "chat";
  if (chatType === "p2p") return "Feishu DM";
  return `Feishu ${chatType}`;
}

function buildSessionDescription(summary) {
  const parts = ["Inbound Feishu conversation"];
  if (summary.chatType) parts.push(`type=${summary.chatType}`);
  if (summary.chatId) parts.push(`chat=${summary.chatId}`);
  if (summary.sender?.openId) parts.push(`sender=${summary.sender.openId}`);
  return parts.join(" | ");
}

function buildRemoteLabMessage(summary) {
  return [
    "Inbound Feishu message.",
    `Chat type: ${summary.chatType || "unknown"}`,
    summary.chatId ? `Chat ID: ${summary.chatId}` : "",
    summary.messageId ? `Message ID: ${summary.messageId}` : "",
    summary.threadId ? `Thread ID: ${summary.threadId}` : "",
    summary.sender?.openId ? `Sender open_id: ${summary.sender.openId}` : "",
    summary.sender?.userId ? `Sender user_id: ${summary.sender.userId}` : "",
    summary.sender?.unionId ? `Sender union_id: ${summary.sender.unionId}` : "",
    summary.tenantKey ? `Tenant key: ${summary.tenantKey}` : "",
    "",
    "User message:",
    trimString(summary.textPreview) || "[non-text or empty message]",
    "",
    "Write the exact plain-text Feishu reply to send back.",
  ]
    .filter(Boolean)
    .join("\n");
}

async function readOwnerToken() {
  const auth = JSON.parse(await readFile(AUTH_FILE, "utf8"));
  const token = trimString(auth?.token);
  if (!token) {
    throw new Error(`No owner token found in ${AUTH_FILE}`);
  }
  return token;
}

async function loginWithToken(baseUrl, token) {
  const response = await fetch(
    `${normalizeBaseUrl(baseUrl)}/?token=${encodeURIComponent(token)}`,
    {
      redirect: "manual",
    },
  );
  const setCookie = response.headers.get("set-cookie");
  if (response.status !== 302 || !setCookie) {
    throw new Error(
      `Failed to authenticate to RemoteLab at ${baseUrl} (status ${response.status})`,
    );
  }
  return setCookie.split(";")[0];
}

async function requestJson(
  baseUrl,
  path,
  { method = "GET", cookie, body } = {},
) {
  const headers = {
    Accept: "application/json",
  };
  if (cookie) headers.Cookie = cookie;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${normalizeBaseUrl(baseUrl)}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {}

  return { response, json, text };
}

async function loadAssistantReply(requester, sessionId, runId, requestId) {
  const eventsResult = await requester(`/api/sessions/${sessionId}/events`);
  if (!eventsResult.response.ok || !Array.isArray(eventsResult.json?.events)) {
    throw new Error(
      eventsResult.json?.error ||
        eventsResult.text ||
        `Failed to load session events for ${sessionId}`,
    );
  }

  const candidate = [...eventsResult.json.events]
    .reverse()
    .find(
      (event) =>
        event.type === "message" &&
        event.role === "assistant" &&
        ((runId && event.runId === runId) ||
          (requestId && event.requestId === requestId)),
    );
  if (!candidate) return null;

  if (candidate.bodyAvailable && candidate.bodyLoaded === false) {
    const bodyResult = await requester(
      `/api/sessions/${sessionId}/events/${candidate.seq}/body`,
    );
    if (bodyResult.response.ok && bodyResult.json?.body?.value !== undefined) {
      candidate.content = bodyResult.json.body.value;
      candidate.bodyLoaded = true;
    }
  }

  return candidate;
}

function normalizeReplyText(text) {
  const normalized = String(text || "")
    .replace(/\r\n/g, "\n")
    .trim();
  if (!normalized) return "";
  if (normalized.length <= MAX_FEISHU_TEXT_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_FEISHU_TEXT_LENGTH - 16).trimEnd()}\n\n[truncated]`;
}

function buildFailureReply(summary, reason = "") {
  const message = trimString(summary?.textPreview || summary?.rawContent);
  const prefersChinese = containsCjk(message) || containsCjk(reason);
  if (prefersChinese) {
    return "我收到了你的消息，但这次生成回复失败了。你可以稍后再发一次。";
  }
  return "I received your message, but I could not generate a reply just now. Please try again in a moment.";
}

async function loadHandledMessages(pathname) {
  return await readJson(pathname, { messages: {} });
}

async function wasMessageHandled(pathname, messageId) {
  const state = await loadHandledMessages(pathname);
  return Boolean(state?.messages?.[messageId]);
}

async function markMessageHandled(pathname, messageId, metadata) {
  const state = await loadHandledMessages(pathname);
  state.messages[messageId] = {
    ...(state.messages[messageId] || {}),
    ...metadata,
    handledAt: metadata?.handledAt || nowIso(),
  };
  await writeJson(pathname, state);
}

async function loadLatestReplayableSummary(eventsLogPath) {
  try {
    const raw = await readFile(eventsLogPath, "utf8");
    const lines = raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse();
    for (const line of lines) {
      let parsed = null;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed?.allowed === false) continue;
      if (!parsed?.summary?.messageId || !parsed?.summary?.chatId) continue;
      return parsed.summary;
    }
  } catch {}
  return null;
}

function createRuntimeContext(config, storagePaths) {
  return {
    config,
    storagePaths,
    appClient: new Lark.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: resolveDomain(config.region),
      loggerLevel: resolveLoggerLevel(config.loggerLevel),
    }),
    processingMessageIds: new Set(),
    chatQueues: new Map(),
    authToken: "",
    authCookie: "",
  };
}

function enqueueByChat(runtime, summary, worker) {
  const key = summary.chatId || summary.messageId || "unknown_chat";
  const previous = runtime.chatQueues.get(key) || Promise.resolve();
  const next = previous
    .catch(() => {})
    .then(worker)
    .catch((error) => {
      console.error(
        `[feishu-connector] queued processing failed for ${summary.messageId || key}:`,
        error?.stack || error,
      );
    });
  runtime.chatQueues.set(key, next);
  next.finally(() => {
    if (runtime.chatQueues.get(key) === next) {
      runtime.chatQueues.delete(key);
    }
  });
}

async function ensureAuthCookie(runtime, forceRefresh = false) {
  if (!forceRefresh && runtime.authCookie) {
    return runtime.authCookie;
  }
  if (!runtime.authToken) {
    runtime.authToken = await readOwnerToken();
  }
  runtime.authCookie = await loginWithToken(
    runtime.config.chatBaseUrl,
    runtime.authToken,
  );
  return runtime.authCookie;
}

async function requestRemoteLab(runtime, path, options = {}) {
  const cookie = await ensureAuthCookie(runtime, false);
  let result = await requestJson(runtime.config.chatBaseUrl, path, {
    ...options,
    cookie,
  });
  if ([401, 403].includes(result.response.status)) {
    const refreshedCookie = await ensureAuthCookie(runtime, true);
    result = await requestJson(runtime.config.chatBaseUrl, path, {
      ...options,
      cookie: refreshedCookie,
    });
  }
  return result;
}

async function createOrReuseSession(runtime, summary) {
  const payload = {
    folder: runtime.config.sessionFolder,
    tool: runtime.config.sessionTool,
    name: buildSessionName(summary),
    group: "Feishu",
    description: buildSessionDescription(summary),
    systemPrompt: runtime.config.systemPrompt,
    externalTriggerId: buildExternalTriggerId(summary),
  };
  const result = await requestRemoteLab(runtime, "/api/sessions", {
    method: "POST",
    body: payload,
  });
  if (!result.response.ok || !result.json?.session?.id) {
    throw new Error(
      result.json?.error ||
        result.text ||
        `Failed to create session (${result.response.status})`,
    );
  }
  return result.json.session;
}

async function submitRemoteLabMessage(runtime, sessionId, summary) {
  const payload = {
    requestId: buildRequestId(summary),
    text: buildRemoteLabMessage(summary),
    tool: runtime.config.sessionTool,
    thinking: runtime.config.thinking === true,
  };
  if (runtime.config.model) payload.model = runtime.config.model;
  if (runtime.config.effort) payload.effort = runtime.config.effort;

  const result = await requestRemoteLab(
    runtime,
    `/api/sessions/${sessionId}/messages`,
    {
      method: "POST",
      body: payload,
    },
  );
  if (![200, 202].includes(result.response.status) || !result.json?.run?.id) {
    throw new Error(
      result.json?.error ||
        result.text ||
        `Failed to submit session message (${result.response.status})`,
    );
  }

  return {
    requestId: payload.requestId,
    runId: result.json.run.id,
    duplicate: result.json?.duplicate === true,
  };
}

async function waitForRunCompletion(runtime, runId) {
  const deadline = Date.now() + RUN_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await requestRemoteLab(runtime, `/api/runs/${runId}`);
    if (!result.response.ok || !result.json?.run) {
      throw new Error(
        result.json?.error || result.text || `Failed to load run ${runId}`,
      );
    }
    const run = result.json.run;
    if (run.state === "completed") {
      return run;
    }
    if (["failed", "cancelled"].includes(run.state)) {
      throw new Error(`run ${run.state}`);
    }
    await delay(RUN_POLL_INTERVAL_MS);
  }
  throw new Error(`run timed out after ${RUN_POLL_TIMEOUT_MS}ms`);
}

async function generateRemoteLabReply(runtime, summary) {
  const session = await createOrReuseSession(runtime, summary);
  const submission = await submitRemoteLabMessage(runtime, session.id, summary);
  await waitForRunCompletion(runtime, submission.runId);
  const replyEvent = await loadAssistantReply(
    (path) => requestRemoteLab(runtime, path),
    session.id,
    submission.runId,
    submission.requestId,
  );
  const replyText = normalizeReplyText(replyEvent?.content);
  if (!replyText) {
    throw new Error("no assistant reply found for completed run");
  }
  return {
    sessionId: session.id,
    runId: submission.runId,
    requestId: submission.requestId,
    duplicate: submission.duplicate,
    replyText,
  };
}

async function sendFeishuText(runtime, summary, text) {
  const response = await runtime.appClient.im.v1.message.create({
    params: {
      receive_id_type: "chat_id",
    },
    data: {
      receive_id: summary.chatId,
      msg_type: "text",
      content: JSON.stringify({ text: normalizeReplyText(text) }),
      uuid: buildReplyUuid(summary),
    },
  });
  if (
    (response.code !== undefined && response.code !== 0) ||
    !response.data?.message_id
  ) {
    throw new Error(response.msg || "Failed to send Feishu reply");
  }
  return response.data;
}

function isProcessableMessage(summary) {
  if (!summary?.messageId || !summary?.chatId) return false;
  const senderType = trimString(summary?.sender?.senderType).toLowerCase();
  if (senderType && senderType !== "user") return false;
  return true;
}

async function handleMessage(runtime, summary, sourceLabel) {
  if (!isProcessableMessage(summary)) {
    return;
  }
  if (runtime.processingMessageIds.has(summary.messageId)) {
    return;
  }
  if (
    await wasMessageHandled(
      runtime.storagePaths.handledMessagesPath,
      summary.messageId,
    )
  ) {
    return;
  }

  runtime.processingMessageIds.add(summary.messageId);
  try {
    const messageType = trimString(summary.messageType).toLowerCase();
    if (messageType && messageType !== "text") {
      const replyText = buildFailureReply(
        { ...summary, textPreview: summary.textPreview || summary.rawContent },
        "unsupported_message_type",
      );
      const reply = await sendFeishuText(runtime, summary, replyText);
      await markMessageHandled(
        runtime.storagePaths.handledMessagesPath,
        summary.messageId,
        {
          status: "unsupported_message_type",
          sourceLabel,
          chatId: summary.chatId,
          requestId: buildRequestId(summary),
          responseMessageId: reply.message_id || "",
        },
      );
      return;
    }

    const generated = await generateRemoteLabReply(runtime, summary);
    const reply = await sendFeishuText(runtime, summary, generated.replyText);
    await markMessageHandled(
      runtime.storagePaths.handledMessagesPath,
      summary.messageId,
      {
        status: "sent",
        sourceLabel,
        chatId: summary.chatId,
        sessionId: generated.sessionId,
        runId: generated.runId,
        requestId: generated.requestId,
        duplicate: generated.duplicate,
        responseMessageId: reply.message_id || "",
        repliedAt: nowIso(),
      },
    );
    console.log(
      `[feishu-connector] replied to ${summary.messageId} with ${reply.message_id}`,
    );
  } catch (error) {
    console.error(
      `[feishu-connector] processing failed for ${summary.messageId}:`,
      error?.stack || error,
    );
    try {
      const fallback = buildFailureReply(summary, error?.message || "");
      const reply = await sendFeishuText(runtime, summary, fallback);
      await markMessageHandled(
        runtime.storagePaths.handledMessagesPath,
        summary.messageId,
        {
          status: "failed_with_notice",
          sourceLabel,
          chatId: summary.chatId,
          error: error?.message || String(error),
          responseMessageId: reply.message_id || "",
          repliedAt: nowIso(),
        },
      );
    } catch (sendError) {
      console.error(
        `[feishu-connector] fallback send failed for ${summary.messageId}:`,
        sendError?.stack || sendError,
      );
    }
  } finally {
    runtime.processingMessageIds.delete(summary.messageId);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = await loadConfig(options.configPath);
  const storagePaths = {
    eventsLogPath: join(config.storageDir, "events.jsonl"),
    knownSendersPath: join(config.storageDir, "known-senders.json"),
    handledMessagesPath: join(config.storageDir, "handled-messages.json"),
  };
  const runtime = createRuntimeContext(config, storagePaths);
  const wsClient = new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    domain: resolveDomain(config.region),
    loggerLevel: resolveLoggerLevel(config.loggerLevel),
  });

  let closed = false;
  const closeConnection = (reason) => {
    if (closed) return;
    closed = true;
    console.log(`[feishu-connector] closing connection (${reason})`);
    wsClient.close();
  };

  process.on("SIGINT", () => {
    closeConnection("SIGINT");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    closeConnection("SIGTERM");
    process.exit(0);
  });

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data) => {
      const summary = summarizeEvent(data);
      const allowed = await recordInboundEvent(
        config,
        storagePaths.eventsLogPath,
        storagePaths.knownSendersPath,
        summary,
        data,
        "im.message.receive_v1",
      );
      if (allowed) {
        enqueueByChat(runtime, summary, () =>
          handleMessage(runtime, summary, "im.message.receive_v1"),
        );
      }
      return {};
    },
    message: async (data) => {
      const summary = summarizeLegacyMessageEvent(data);
      const allowed = await recordInboundEvent(
        config,
        storagePaths.eventsLogPath,
        storagePaths.knownSendersPath,
        summary,
        data,
        "message",
      );
      if (allowed) {
        enqueueByChat(runtime, summary, () =>
          handleMessage(runtime, summary, "message"),
        );
      }
      return {};
    },
  });

  await wsClient.start({ eventDispatcher });
  console.log(
    `[feishu-connector] persistent connection ready (${config.region})`,
  );
  console.log(`[feishu-connector] intake policy: ${config.intakePolicy.mode}`);
  console.log(`[feishu-connector] event log: ${storagePaths.eventsLogPath}`);
  console.log(
    `[feishu-connector] known senders: ${storagePaths.knownSendersPath}`,
  );
  console.log(
    `[feishu-connector] handled messages: ${storagePaths.handledMessagesPath}`,
  );
  console.log(`[feishu-connector] RemoteLab base URL: ${config.chatBaseUrl}`);
  console.log(`[feishu-connector] session folder: ${config.sessionFolder}`);
  console.log(`[feishu-connector] session tool: ${config.sessionTool}`);

  if (options.replayLast) {
    const summary = await loadLatestReplayableSummary(
      storagePaths.eventsLogPath,
    );
    if (!summary) {
      throw new Error(
        `No replayable inbound message found in ${storagePaths.eventsLogPath}`,
      );
    }
    console.log(
      `[feishu-connector] replaying stored message ${summary.messageId}`,
    );
    await handleMessage(runtime, summary, "replay-last");
    if (options.durationMs === 0) {
      closeConnection("replay complete");
      await delay(250);
      process.exit(0);
    }
  }

  if (options.durationMs > 0) {
    await delay(options.durationMs);
    closeConnection(`duration ${options.durationMs}ms elapsed`);
    await delay(250);
    process.exit(0);
  }

  await new Promise(() => {});
}

main().catch((error) => {
  console.error(
    "[feishu-connector] failed to start:",
    error?.stack || error?.message || error,
  );
  process.exit(1);
});
