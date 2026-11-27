// Runs only within sqlite-state-worker. No full-table transfer to the control plane.
const initialized = new WeakSet();
const day = 86_400_000;
const pageSize = 25;
const cursor = value => Math.max(0, Number.isSafeInteger(Number(value)) ? Number(value) : 0);
const projection = `c.id, c.source, c.label, c.identifiable, c.first_at AS firstAt, c.last_at AS lastAt,
  c.version, c.opened_at AS openedAt, c.fixed_at AS fixedAt, c.fixed_commit AS fixedCommit,
  CASE WHEN c.opened_at IS NOT NULL THEN 'pending' WHEN c.fixed_at IS NOT NULL AND c.last_at <= c.fixed_at
    THEN 'fixed' ELSE 'observed' END AS status,
  (SELECT count(*) FROM error_events e WHERE e.cluster=c.id AND e.at>=?) AS recentRecords,
  (SELECT count(DISTINCT operation) FROM error_events e WHERE e.cluster=c.id AND e.at>=?) AS recentOccurrences,
  (SELECT count(DISTINCT operation) FROM error_events e WHERE e.cluster=c.id AND e.at>=? AND e.at>coalesce(c.fixed_at,-1)) AS occurrences24h`;

export function recentErrorOperation(db, prepare, { action, now, event, cluster, before, version, commit, verification, personId,
  since, target, alertId, transition, expected, body, deliveryId, receipt, samples }) {
  if (!initialized.has(db)) {
    db.exec(`CREATE TABLE IF NOT EXISTS error_clusters(id TEXT PRIMARY KEY, source TEXT NOT NULL, label TEXT NOT NULL,
      identifiable INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL, version INTEGER NOT NULL,
      opened_at INTEGER, fixed_at INTEGER, fixed_commit TEXT);
      CREATE INDEX IF NOT EXISTS error_clusters_recency ON error_clusters(last_at DESC, id);
      CREATE INDEX IF NOT EXISTS error_clusters_pending ON error_clusters(opened_at) WHERE opened_at IS NOT NULL;
      CREATE TABLE IF NOT EXISTS error_events(seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
      cluster TEXT NOT NULL, operation TEXT NOT NULL, at INTEGER NOT NULL, session_id TEXT, reference TEXT);
      CREATE INDEX IF NOT EXISTS error_events_cluster ON error_events(cluster, at, operation);
      CREATE INDEX IF NOT EXISTS error_events_cluster_sequence ON error_events(cluster, seq DESC);
      CREATE INDEX IF NOT EXISTS error_events_retention ON error_events(at);
      CREATE TABLE IF NOT EXISTS error_excerpts(event_seq INTEGER PRIMARY KEY, excerpt TEXT NOT NULL,
        FOREIGN KEY(event_seq) REFERENCES error_events(seq) ON DELETE CASCADE);
      CREATE TABLE IF NOT EXISTS error_sources(source TEXT PRIMARY KEY, first_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS error_repairs(cluster TEXT NOT NULL, version INTEGER NOT NULL, at INTEGER NOT NULL,
      commit_sha TEXT NOT NULL, verification TEXT NOT NULL, person TEXT NOT NULL, PRIMARY KEY(cluster, version));
      CREATE INDEX IF NOT EXISTS error_repairs_retention ON error_repairs(at);
      CREATE TABLE IF NOT EXISTS error_alert_batches(id TEXT PRIMARY KEY, cluster TEXT NOT NULL, last_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL, target TEXT NOT NULL, evidence TEXT NOT NULL,
        state TEXT NOT NULL, body TEXT, delivery_id TEXT, receipt TEXT, attempts INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS error_alert_cluster ON error_alert_batches(cluster,last_at DESC);
      CREATE INDEX IF NOT EXISTS error_alert_active ON error_alert_batches(created_at)
        WHERE state IN ('new','analyzing','ready','queued');`);
    initialized.add(db);
  }
  const sql = query => prepare(db, query);
  const cutoff = now - 7*day;
  if (action === 'list') {
    const offset = cursor(before);
    const rows = sql(`SELECT ${projection} FROM (
      SELECT * FROM error_clusters WHERE last_at>=?
      ORDER BY last_at DESC, id LIMIT ? OFFSET ?) c
      ORDER BY last_at DESC, id`).all(cutoff, cutoff, now-day, cutoff, pageSize+1, offset);
    const pending = sql('SELECT count(*) AS count FROM error_clusters WHERE opened_at IS NOT NULL').get().count;
    return { rows: rows.slice(0, pageSize).map(row => samples ? { ...row, ...readEvents(row.id, 0, 5) } : row),
      pending, next: rows.length > pageSize ? offset+pageSize : null,
      sources: sql('SELECT source, first_at AS firstAt FROM error_sources').all() };
  }
  if (action === 'source-session') {
    return sql('SELECT session_id AS sessionId FROM error_events WHERE event_id=? AND at>=?').get(event?.id, now-30*day)?.sessionId || null;
  }
  if (action === 'detail') {
    const row = sql(`SELECT ${projection} FROM error_clusters c WHERE id=?`).get(cutoff, cutoff, now-day, cluster);
    if (!row) return null;
    return { cluster: row, ...readEvents(cluster, before, pageSize) };
  }
  function readEvents(id, offset, limit) {
    const events = sql(`SELECT e.seq, e.at, e.session_id AS sessionId, e.reference, x.excerpt
      FROM error_events e LEFT JOIN error_excerpts x ON x.event_seq=e.seq
      WHERE e.cluster=? AND e.seq<? AND e.at>=? ORDER BY e.seq DESC LIMIT ?`)
      .all(id, cursor(offset) || Number.MAX_SAFE_INTEGER, now-30*day, limit+1);
    return { events: events.slice(0, limit), eventsNext: events.length > limit ? events[limit-1].seq : null };
  }
  const transaction = task => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = task(); db.exec('COMMIT'); return result; }
    catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
  };
  if (action === 'alert-jobs') return transaction(() => {
    const floor = Math.max(since, now-day);
    sql(`UPDATE error_alert_batches SET state='expired' WHERE state IN ('new','analyzing','ready') AND created_at<?`).run(floor);
    sql(`DELETE FROM error_alert_batches WHERE state IN ('delivered','failed','expired','uncertain','insufficient') AND created_at<?`).run(now-30*day);
    // Only independent observations since activation (or the last alert) count.
    // Use the third qualifying occurrence to freeze the evidence deterministically.
    const due = sql(`SELECT c.id, c.source, c.label, coalesce((SELECT max(a.last_at) FROM error_alert_batches a WHERE a.cluster=c.id),0) AS sentThrough
      FROM error_clusters c WHERE c.last_at>=? AND c.identifiable=1
      AND NOT EXISTS(SELECT 1 FROM error_alert_batches a WHERE a.cluster=c.id AND
        (a.created_at>=? OR a.state IN ('new','analyzing','ready','queued')))
      AND 3 <= (SELECT count(*) FROM (SELECT DISTINCT operation FROM error_events e WHERE e.cluster=c.id
        AND e.at>=? AND e.at>coalesce((SELECT max(a.last_at) FROM error_alert_batches a WHERE a.cluster=c.id),0) LIMIT 3))
      ORDER BY c.last_at LIMIT 12`).all(floor, now-day, floor);
    for (const row of due) {
      const evidence = sql(`SELECT e.seq, e.event_id AS eventId, (e.session_id IS NOT NULL) AS hasSession, e.at, x.excerpt FROM error_events e
        LEFT JOIN error_excerpts x ON x.event_seq=e.seq WHERE e.seq IN (
          SELECT min(seq) FROM error_events WHERE cluster=? AND at>=? AND at>?
          GROUP BY operation ORDER BY min(at),min(seq) LIMIT 3) ORDER BY e.at,e.seq`).all(row.id, floor, row.sentThrough);
      const last = evidence.at(-1);
      sql(`INSERT OR IGNORE INTO error_alert_batches(id,cluster,last_at,created_at,target,evidence,state)
        VALUES (?,?,?,?,?,?,'new')`).run(`${row.id.slice(0,24)}:${last.seq}`,row.id,last.at,now,target,
          JSON.stringify({ source:row.source, label:row.label, events:evidence }));
    }
    return sql(`SELECT * FROM error_alert_batches WHERE state IN ('new','analyzing','ready','queued') AND target=?
      ORDER BY (state='queued'),created_at,id LIMIT 15`).all(target).map(row=>({ ...row,evidence:JSON.parse(row.evidence) }));
  });
  if (action === 'alert-transition') return Boolean(sql(`UPDATE error_alert_batches SET state=?,
      body=coalesce(?,body), delivery_id=coalesce(?,delivery_id), receipt=coalesce(?,receipt),
      attempts=attempts+CASE WHEN ?='analyzing' THEN 1 ELSE 0 END WHERE id=? AND state=? AND target=?`)
    .run(transition,body??null,deliveryId??null,receipt??null,transition,alertId,expected,target).changes);
  if (action === 'record') return transaction(() => {
    if (event.at < now - 30*day) return { inserted: false };
    const entry = sql(`INSERT INTO error_events(event_id,cluster,operation,at,session_id,reference) VALUES(?,?,?,?,?,?)
      ON CONFLICT(event_id) DO NOTHING RETURNING seq`).get(event.id, event.cluster, event.operation, event.at, event.sessionId, event.reference);
    if (event.excerpt) {
      // The original journal projection may be replayed to enrich a v1 record.
      // It must not change counts, occurrence times, or repair state.
      const evidence = entry || sql('SELECT seq FROM error_events WHERE event_id=? AND cluster=? AND at=?').get(event.id,event.cluster,event.at);
      if (evidence) sql('INSERT OR IGNORE INTO error_excerpts(event_seq,excerpt) VALUES (?,?)').run(evidence.seq, event.excerpt);
    }
    if (!entry) return { inserted: false };
    sql(`INSERT INTO error_sources(source,first_at) VALUES (?,?) ON CONFLICT(source) DO UPDATE SET first_at=min(first_at,excluded.first_at)`).run(event.source, event.at);
    sql(`INSERT INTO error_clusters(id,source,label,identifiable,first_at,last_at,version) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET first_at=min(first_at,excluded.first_at), last_at=max(last_at,excluded.last_at), version=excluded.version`)
      .run(event.cluster, event.source, event.label, Number(event.identifiable), event.at, event.at, entry.seq);
    // One cleanup per day, driven by existing producers, not page refresh or a new timer.
    const date = String(Math.floor(now/day));
    const pruned = sql(`INSERT INTO metadata(key,value) VALUES ('error_retention',?) ON CONFLICT(key) DO UPDATE
      SET value=excluded.value WHERE value<>excluded.value RETURNING key`).get(date);
    if (pruned) {
      sql('DELETE FROM error_events WHERE at<?').run(now-30*day);
      sql('DELETE FROM error_clusters WHERE opened_at IS NULL AND last_at<? AND coalesce(fixed_at,0)<?').run(now-30*day, now-90*day);
      sql('DELETE FROM error_repairs WHERE at<?').run(now-90*day);
    }
    return { inserted: true };
  });
  if (action === 'fix') return transaction(() => {
    const row = sql('SELECT version, opened_at AS openedAt FROM error_clusters WHERE id=?').get(cluster);
    if (!row) return { status: 404 };
    if (!row.openedAt || row.version !== version) return { status: 409 };
    sql('INSERT INTO error_repairs(cluster,version,at,commit_sha,verification,person) VALUES(?,?,?,?,?,?)')
      .run(cluster, version, now, commit, verification, personId);
    sql('UPDATE error_clusters SET fixed_at=?, fixed_commit=?, opened_at=NULL WHERE id=?').run(now, commit, cluster);
    return { status: 200 };
  });
  throw Error('Unknown recent error operation');
}
