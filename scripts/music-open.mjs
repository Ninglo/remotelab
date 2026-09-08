#!/usr/bin/env node

import { appendFile, mkdir } from 'fs/promises'
import { execFile } from 'child_process'
import { homedir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { setTimeout as delay } from 'timers/promises'

const execFileAsync = promisify(execFile)

const DEFAULT_COUNTRY = 'us'
const DEFAULT_WAIT_MS = 3000
const DEFAULT_LOG_PATH = join(homedir(), '.config', 'remotelab', 'music-open', 'music-actions.jsonl')

const PRESETS = {
  'apple-music-classical': {
    label: 'Apple Music Classical demo playlist',
    url: 'music://music.apple.com/us/playlist/pure-classical/pl.92e04ee75ed64804b9df468b5f45a161',
  },
}

function trimString(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function nowIso() {
  return new Date().toISOString()
}

function printUsage(exitCode = 0) {
  const output = exitCode === 0 ? console.log : console.error
  output(`Usage:
  node scripts/music-open.mjs --preset apple-music-classical [options]
  node scripts/music-open.mjs --query "classical piano" [options]

Options:
  --preset <id>         Preset music target
  --query <text>        Open Apple Music search for the query
  --country <code>      Apple Music storefront country (default: ${DEFAULT_COUNTRY})
  --wait-ms <ms>        Wait before sending play key (default: ${DEFAULT_WAIT_MS})
  --open-only           Open target without sending play/pause
  --dry-run             Print the resolved action as JSON only
  -h, --help            Show this help
`)
  process.exit(exitCode)
}

function parseArgs(argv) {
  const options = {
    preset: '',
    query: '',
    country: DEFAULT_COUNTRY,
    waitMs: DEFAULT_WAIT_MS,
    openOnly: false,
    dryRun: false,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--preset') {
      options.preset = trimString(argv[index + 1])
      index += 1
      continue
    }
    if (arg === '--query') {
      options.query = trimString(argv[index + 1])
      index += 1
      continue
    }
    if (arg === '--country') {
      options.country = trimString(argv[index + 1]) || DEFAULT_COUNTRY
      index += 1
      continue
    }
    if (arg === '--wait-ms') {
      const parsed = Number.parseInt(argv[index + 1], 10)
      if (Number.isInteger(parsed) && parsed > 0) {
        options.waitMs = parsed
      }
      index += 1
      continue
    }
    if (arg === '--open-only') {
      options.openOnly = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--help' || arg === '-h') {
      printUsage(0)
    }
    printUsage(1)
  }

  return options
}

function buildMusicUrl(options) {
  if (options.preset) {
    const preset = PRESETS[options.preset]
    if (!preset) {
      throw new Error(`Unknown preset: ${options.preset}`)
    }
    return {
      label: preset.label,
      url: preset.url,
      source: 'preset',
    }
  }

  if (options.query) {
    const encodedQuery = encodeURIComponent(options.query)
    return {
      label: `Apple Music search: ${options.query}`,
      url: `music://music.apple.com/${options.country}/search?term=${encodedQuery}`,
      source: 'query',
    }
  }

  throw new Error('Either --preset or --query is required')
}

async function runCommand(command, args) {
  await execFileAsync(command, args)
}

async function logAction(payload) {
  const directory = DEFAULT_LOG_PATH.slice(0, DEFAULT_LOG_PATH.lastIndexOf('/'))
  if (directory) {
    await mkdir(directory, { recursive: true })
  }
  await appendFile(DEFAULT_LOG_PATH, `${JSON.stringify(payload)}\n`, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const target = buildMusicUrl(options)
  const result = {
    ts: nowIso(),
    ...target,
    openOnly: options.openOnly,
    waitMs: options.waitMs,
  }

  if (options.dryRun) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  await runCommand('open', ['-a', 'Music'])
  await delay(800)
  await runCommand('open', [target.url])
  await delay(options.waitMs)
  if (!options.openOnly) {
    await runCommand('osascript', ['-e', 'tell application "System Events" to key code 49'])
  }

  await logAction(result)
  console.log(JSON.stringify({ ok: true, ...result }, null, 2))
}

main().catch((error) => {
  console.error(error?.message || String(error))
  process.exit(1)
})
