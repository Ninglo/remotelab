#!/usr/bin/env node
/**
 * Email Connector — bridges Cloudflare Email Routing with RemoteLab instances.
 *
 * Inbound:  Cloudflare webhook → normalize → dispatch to instance
 * Outbound: Instance reply callback → send via Cloudflare Worker
 *
 * Usage:
 *   node connectors/email/index.mjs --port 7694 --state-dir /path/to/state
 */

import { createConnectorRuntime } from '../../lib/connector-sdk/index.mjs'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readBody, sendJson } from '../../lib/connector-sdk/server.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

// --- Config ---

function loadConfig(stateDir) {
  const defaults = {
    port: 7694,
    host: '127.0.0.1',
    channel: 'email',
    callbackToken: '',
    webhookToken: '',
    from: '',
    domain: '',
    outbound: { provider: 'cloudflare_worker', workerBaseUrl: '', workerToken: '' },
    allowlist: { allowedEmails: [], allowedDomains: [] },
  }
  const configPath = join(stateDir, 'config.json')
  if (existsSync(configPath)) {
    try {
      return { ...defaults, ...JSON.parse(readFileSync(configPath, 'utf8')) }
    } catch { /* use defaults */ }
  }
  return defaults
}

// --- Email-specific match function ---

export function emailMatchFn(pattern, message) {
  const address = (message.to?.address || '').toLowerCase()
  const pat = pattern.toLowerCase()

  if (pat === '*') return true
  // *@domain.dev — match domain
  if (pat.startsWith('*@')) return address.endsWith(pat.slice(1))
  // prefix*@domain.dev — match prefix
  if (pat.includes('*')) {
    const [prefix, suffix] = pat.split('*')
    return address.startsWith(prefix) && address.endsWith(suffix)
  }
  // exact match
  return address === pat
}

// --- Admission check ---

export function checkAdmission(message, allowlist) {
  if (!allowlist) return true
  const { allowedEmails = [], allowedDomains = [] } = allowlist
  if (allowedEmails.length === 0 && allowedDomains.length === 0) return true

  const from = (message.from?.address || '').toLowerCase()
  if (allowedEmails.some(e => e.toLowerCase() === from)) return true
  const domain = from.split('@')[1]
  if (domain && allowedDomains.some(d => d.toLowerCase() === domain)) return true

  return false
}

// --- Normalize Cloudflare email webhook payload ---

export function normalizeCloudflareEmail(payload, headers = {}) {
  const from = headers['x-envelope-from'] || payload.envelope?.mailFrom || payload.from || ''
  const to = headers['x-envelope-to'] || payload.envelope?.rcptTo || payload.to || ''
  const subject = headers['x-email-subject'] || payload.headers?.subject || payload.subject || ''
  const messageId = headers['x-email-message-id'] || payload.headers?.messageId || ''
  const inReplyTo = headers['x-email-in-reply-to'] || payload.headers?.inReplyTo || ''
  const date = headers['x-email-date'] || payload.headers?.date || ''
  const body = payload.text || payload.extractedText || payload.content?.body || ''

  return {
    id: `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    channel: 'email',
    direction: 'inbound',
    from: { address: from, name: payload.fromName || '' },
    to: { address: to },
    thread: {
      externalId: messageId ? `email:${messageId}` : `email:${Date.now()}`,
    },
    content: {
      subject,
      body,
      html: payload.html || null,
      attachments: [],
    },
    sourceContext: {
      channel: 'email',
      connectorId: 'email',
      messageId: `cmsg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      from: { address: from, name: payload.fromName || '' },
      to: { address: to },
      subject,
      inReplyTo,
      references: payload.headers?.references || '',
      date,
    },
    createdAt: new Date().toISOString(),
  }
}

// --- Email skill declarations ---

export const EMAIL_SKILLS = [
  {
    name: 'send',
    description: 'Send an email to a recipient',
    schema: {
      to: { type: 'string', required: true, description: 'Recipient email address' },
      subject: { type: 'string', required: true, description: 'Email subject line' },
      body: { type: 'string', required: true, description: 'Email body (plain text)' },
      cc: { type: 'array', items: 'string', description: 'CC recipients' },
      bcc: { type: 'array', items: 'string', description: 'BCC recipients' },
      html: { type: 'string', description: 'HTML version of the body' },
      replyTo: { type: 'string', description: 'Reply-To address' },
    },
  },
  {
    name: 'send_bulk',
    description: 'Send same email to multiple recipients',
    schema: {
      recipients: { type: 'array', items: 'string', required: true, description: 'List of recipient email addresses' },
      subject: { type: 'string', required: true, description: 'Email subject line' },
      body: { type: 'string', required: true, description: 'Email body (plain text)' },
      html: { type: 'string', description: 'HTML version of the body' },
    },
  },
]

// --- Skill execution ---

async function executeEmailSkill(skillName, { instanceId, sessionId, parameters }, outboundConfig, fromAddress) {
  if (skillName === 'send') {
    const { to, subject, body, cc, bcc, html, replyTo } = parameters
    if (!to || !subject || !body) throw new Error('Missing required parameters: to, subject, body')

    const message = {
      to,
      from: fromAddress,
      subject,
      text: body,
      ...(cc ? { cc: Array.isArray(cc) ? cc.join(', ') : cc } : {}),
      ...(bcc ? { bcc: Array.isArray(bcc) ? bcc.join(', ') : bcc } : {}),
      ...(html ? { html } : {}),
      ...(replyTo ? { replyTo } : {}),
    }

    if (outboundConfig.provider === 'cloudflare_worker') {
      return await sendViaCloudflareWorker(message, outboundConfig)
    }
    throw new Error(`unsupported outbound provider: ${outboundConfig.provider}`)
  }

  if (skillName === 'send_bulk') {
    const { recipients, subject, body, html } = parameters
    if (!recipients?.length || !subject || !body) throw new Error('Missing required parameters: recipients, subject, body')

    const results = []
    for (const to of recipients) {
      const message = {
        to,
        from: fromAddress,
        subject,
        text: body,
        ...(html ? { html } : {}),
      }

      try {
        if (outboundConfig.provider === 'cloudflare_worker') {
          const r = await sendViaCloudflareWorker(message, outboundConfig)
          results.push({ to, sent: true, ...r })
        } else {
          throw new Error(`unsupported outbound provider: ${outboundConfig.provider}`)
        }
      } catch (err) {
        results.push({ to, sent: false, error: err.message })
      }
    }
    return { sent: results.filter(r => r.sent).length, failed: results.filter(r => !r.sent).length, results }
  }

  throw new Error(`unknown skill: ${skillName}`)
}

// --- Outbound email sending ---

async function sendReplyEmail(reply, outboundConfig, fromAddress) {
  const { sourceContext, reply: replyContent } = reply
  if (!sourceContext || !replyContent) throw new Error('missing sourceContext or reply')

  const to = sourceContext.from?.address
  if (!to) throw new Error('no recipient address in sourceContext.from')

  const subject = sourceContext.subject?.startsWith('Re:')
    ? sourceContext.subject
    : `Re: ${sourceContext.subject || '(no subject)'}`

  const message = {
    to,
    from: fromAddress,
    subject,
    text: replyContent.body,
    inReplyTo: sourceContext.inReplyTo || '',
    references: sourceContext.references || '',
    ...(Array.isArray(replyContent.attachments) && replyContent.attachments.length > 0
      ? { attachments: replyContent.attachments }
      : {}),
  }

  if (outboundConfig.provider === 'cloudflare_worker') {
    return await sendViaCloudflareWorker(message, outboundConfig)
  }

  throw new Error(`unsupported outbound provider: ${outboundConfig.provider}`)
}

async function sendViaCloudflareWorker(message, config) {
  const { workerBaseUrl, workerToken } = config
  if (!workerBaseUrl) throw new Error('workerBaseUrl not configured')

  const res = await fetch(`${workerBaseUrl}/send`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(workerToken ? { Authorization: `Bearer ${workerToken}` } : {}),
    },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(30000),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Cloudflare Worker error ${res.status}: ${text}`)
  }

  const result = await res.json().catch(() => ({}))
  return { externalId: result.messageId || null, channel: 'email' }
}

// --- Main ---

export async function startEmailConnector(options = {}) {
  const stateDir = options.stateDir || join(__dirname, 'state')
  const config = { ...loadConfig(stateDir), ...options }

  const connector = createConnectorRuntime({
    channel: 'email',
    port: config.port,
    host: config.host,
    stateDir,
    callbackToken: config.callbackToken,
    matchFn: emailMatchFn,
    sourceName: 'Email',
    group: 'Email',
    skills: EMAIL_SKILLS,
    onReply: async (reply) => {
      return await sendReplyEmail(reply, config.outbound, config.from)
    },
    onSkill: async (skillName, body) => {
      return await executeEmailSkill(skillName, body, config.outbound, config.from)
    },
  })

  // Cloudflare email webhook endpoint
  connector.route('POST', '/cloudflare-email/webhook', async (req, res) => {
    // Validate webhook token
    const authHeader = req.headers.authorization || req.headers['x-bridge-token'] || ''
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader
    if (config.webhookToken && bearerToken !== config.webhookToken) {
      return sendJson(res, 403, { ok: false, error: 'invalid_webhook_token' })
    }

    try {
      const payload = await readBody(req)
      const message = normalizeCloudflareEmail(payload, req.headers)

      // Admission check
      if (!checkAdmission(message, config.allowlist)) {
        return sendJson(res, 403, { ok: false, error: 'sender_not_allowed', from: message.from.address })
      }

      const result = await connector.deliver(message)
      sendJson(res, result.delivered ? 200 : 502, { ok: result.delivered, ...result })
    } catch (err) {
      sendJson(res, 500, { ok: false, error: 'ingest_failed', message: err.message })
    }
  })

  await connector.start()
  console.log(`Email connector listening on ${config.host}:${config.port}`)
  return connector
}

// CLI entry
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2)
  const stateDir = args.includes('--state-dir') ? args[args.indexOf('--state-dir') + 1] : join(__dirname, 'state')
  const port = args.includes('--port') ? parseInt(args[args.indexOf('--port') + 1]) : undefined

  startEmailConnector({ stateDir, ...(port ? { port } : {}) }).catch(err => {
    console.error('Failed to start email connector:', err)
    process.exit(1)
  })
}
