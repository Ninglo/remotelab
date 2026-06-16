import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  archeryMatchFn,
  normalizeArcherySession,
  readStoredArcheryReply,
  storeArcheryReply,
} from '../connectors/archery/index.mjs'

const tempDir = mkdtempSync(join(tmpdir(), 'archery-connector-'))

try {
  const basePayload = {
    athleteId: 'ninglo',
    athleteName: 'Ninglo',
    tags: ['outdoor', 'fatigue'],
    environment: {
      indoorOutdoor: 'outdoor',
      wind: 'crosswind',
    },
    session: {
      id: 'sess-1',
      config: {
        bowType: '复合',
        distance: '50m',
        sets: 2,
        arrowsPerSet: 3,
      },
      sets: [
        {
          arrows: [{ value: '10' }, { value: '9' }, { value: '8' }],
          note: 'steady release',
        },
        {
          arrows: [{ value: 'X' }, { value: '7' }, { value: 'M' }],
          total: 17,
          note: 'fatigue showed up',
        },
      ],
      createdAt: '2026-04-14T10:00:00Z',
      completedAt: '2026-04-14T11:00:00Z',
    },
  }

  {
    const message = normalizeArcherySession(basePayload, { threadMode: 'athlete' })
    assert.equal(message.id, 'archery:ninglo:session:sess-1')
    assert.equal(message.thread.externalId, 'archery:ninglo:coach')
    assert.equal(message.sourceContext.session.totalScore, 44)
    assert.equal(message.sourceContext.session.averageScore.toFixed(2), '7.33')
    assert.equal(message.sourceContext.session.ends[0].total, 27)
    assert.equal(message.sourceContext.session.ends[1].total, 17)
    assert.match(message.content.body, /Today summary/)
    assert.match(message.content.body, /Structured JSON:/)
    console.log('  ✓ normalizeArcherySession builds a stable coach-thread message')
  }

  {
    const message = normalizeArcherySession(basePayload, { threadMode: 'session' })
    assert.equal(message.thread.externalId, 'archery:ninglo:session:sess-1')
    console.log('  ✓ session thread mode can isolate one training upload per RemoteLab session')
  }

  {
    const message = normalizeArcherySession(basePayload, { threadMode: 'athlete' })
    assert.equal(archeryMatchFn('*', message), true)
    assert.equal(archeryMatchFn('athlete:ninglo', message), true)
    assert.equal(archeryMatchFn('athlete:other', message), false)
    assert.equal(archeryMatchFn('thread:archery:ninglo:coach', message), true)
    console.log('  ✓ archeryMatchFn supports wildcard, athlete, and thread rules')
  }

  {
    const stored = storeArcheryReply(tempDir, {
      sessionId: 'remotelab-session-1',
      externalTriggerId: 'archery:ninglo:coach',
      sourceContext: {
        athleteId: 'ninglo',
        requestId: 'archery:ninglo:session:sess-1',
      },
      reply: {
        body: 'Today looked stable, but the second end suggests fatigue.',
      },
    })
    assert.equal(stored.athleteId, 'ninglo')

    const byRequest = readStoredArcheryReply(tempDir, { requestId: 'archery:ninglo:session:sess-1' })
    const byAthlete = readStoredArcheryReply(tempDir, { athleteId: 'ninglo' })
    assert.equal(byRequest?.reply?.body, 'Today looked stable, but the second end suggests fatigue.')
    assert.equal(byAthlete?.requestId, 'archery:ninglo:session:sess-1')
    console.log('  ✓ reply storage supports request and athlete lookups for frontend polling')
  }

  console.log('\n✓ Archery connector tests passed')
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
