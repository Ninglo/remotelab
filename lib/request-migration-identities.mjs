// Historical attempts stay individually addressable by Run ID. The earliest
// explicit publication root owns a shared identity; otherwise earliest Run wins.
export function planHistoricalIdentities(rows) {
  for (const row of rows) {
    if (!row.status || !row.manifest)
      throw new Error(`Missing Run status or manifest: ${row.id}`);
    if (
      !/^run_[a-zA-Z0-9_-]+$/.test(row.id) ||
      !/^[a-zA-Z0-9_-]+$/.test(row.status.sessionId || "")
    ) {
      throw new Error(`Unsafe historical Run/session path: ${row.id}`);
    }
  }
  const rank = (row) => [
    row.status.createdAt || row.status.startedAt || "",
    row.id,
  ];
  const compare = (a, b) => {
    const x = JSON.stringify(rank(a)),
      y = JSON.stringify(rank(b));
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const normalized = rows.map((row) => ({
    ...row,
    requestId: row.status.requestId || `historical:${row.id}`,
    responseId:
      row.status.responseId || row.status.requestId || `historical:${row.id}`,
  }));
  for (const row of normalized) {
    if (!row.status.sessionId || row.status.id !== row.id)
      throw new Error(`Invalid Run identity: ${row.id}`);
    for (const field of ["requestIds", "responseIds"])
      if ((row.status[field]?.length || row.manifest[field]?.length || 0) > 1) {
        throw new Error(
          `Batched historical ${field} require an explicit reconciliation: ${row.id}`,
        );
      }
  }
  const mappings = new Map(
    normalized.map((row) => [
      row.id,
      { id: row.id, requestId: row.requestId, responseId: row.responseId },
    ]),
  );
  for (const field of ["requestId", "responseId"]) {
    const grouped = new Map();
    for (const row of normalized) {
      const key = JSON.stringify([row.status.sessionId, row[field]]);
      const group = grouped.get(key) || [];
      group.push(row);
      grouped.set(key, group);
    }
    const occupied = new Set(grouped.keys());
    for (const group of grouped.values()) {
      if (group.length < 2) continue;
      const roots = new Set(
        group.map((r) => r.status.replyPublicationRootRunId).filter(Boolean),
      );
      group.sort(
        (a, b) =>
          Number(roots.has(b.id)) - Number(roots.has(a.id)) || compare(a, b),
      );
      for (const row of group.slice(1)) {
        let candidate = `historical:${row.id}:${field}`;
        while (occupied.has(JSON.stringify([row.status.sessionId, candidate])))
          candidate += ":legacy";
        occupied.add(JSON.stringify([row.status.sessionId, candidate]));
        mappings.get(row.id)[field] = candidate;
      }
    }
  }
  return normalized.map((row) => ({ ...row, identity: mappings.get(row.id) }));
}
