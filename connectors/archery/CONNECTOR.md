# Archery Connector

Instance-local connector that turns archery session records into a stable RemoteLab session source.

## Product shape

- `archery-toolbox` remains the data-entry frontend.
- This connector receives structured training uploads.
- RemoteLab keeps one long-lived session per athlete by default.
- The connector stores the latest coaching reply so the frontend can poll and render it without exposing the full RemoteLab UI.

## Default topology

- Connector type: instance-local inbound connector
- Default thread mode: one durable coach thread per athlete
- Default tool: `codex`

## Main routes

- `POST /archery/session`
  - ingest one training session
  - returns `requestId`, `sessionId`, `runId`, and poll URLs

- `GET /archery/replies?requestId=...`
  - fetch the stored reply for one submitted training upload

- `GET /archery/replies?athleteId=...`
  - fetch the latest stored reply for one athlete

- `POST /archery/import`
  - ingest a batch of historical sessions
  - accepts either `[{...}, {...}]` or `{ "sessions": [{...}, {...}] }`

- `GET /archery/schema`
  - returns the accepted payload shape and a sample body

## Auth

Use `Authorization: Bearer <ingestToken>` or `x-archery-token: <ingestToken>` when `ingestToken` is configured in `state/config.json`.

## Minimal payload

```json
{
  "athleteId": "ninglo",
  "athleteName": "Ninglo",
  "session": {
    "id": "sess_2026_04_14_01",
    "config": {
      "bowType": "复合",
      "distance": "50m",
      "sets": 12,
      "arrowsPerSet": 6
    },
    "sets": [
      {
        "arrows": [{ "value": "10" }, { "value": "10" }, { "value": "9" }],
        "note": "front shoulder felt tight",
        "total": 29
      }
    ],
    "totalScore": 675,
    "averageScore": 9.38,
    "createdAt": "2026-04-14T10:00:00Z",
    "completedAt": "2026-04-14T11:05:00Z"
  },
  "tags": ["outdoor", "fatigue"],
  "environment": {
    "indoorOutdoor": "outdoor",
    "weather": "cloudy",
    "wind": "crosswind"
  },
  "attachments": [
    {
      "kind": "target_photo",
      "name": "target-1.jpg",
      "url": "https://example.test/target-1.jpg"
    }
  ]
}
```

## Threading rule

By default the connector maps uploads to:

- `archery:<athleteId>:coach`

This creates one long-running coaching session per athlete.

If `threadMode` is set to `session`, uploads map to:

- `archery:<athleteId>:session:<sessionId>`

## Frontend loop

1. `archery-toolbox` records the session.
2. Frontend `POST`s the structured payload to `/archery/session`.
3. RemoteLab analyzes the upload in the stable coach session.
4. Frontend polls `/archery/replies?requestId=...`.
5. The latest coaching reply is rendered inside the same archery UI.

Historical imports use the same normalization path through `POST /archery/import`, so older records and new daily uploads land in the same durable coach thread shape.

## State directory

`state/config.json`

```json
{
  "port": 7796,
  "host": "127.0.0.1",
  "channel": "archery",
  "callbackToken": "",
  "ingestToken": "",
  "threadMode": "athlete",
  "tool": "codex",
  "sourceName": "Archery",
  "group": "Training"
}
```
