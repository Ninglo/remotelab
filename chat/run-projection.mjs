export function createRunProjectionService({
  buildCodexContextMetricsPayload,
  clipPreview,
  createToolInvocation,
  materializeRunSpoolLine,
  normalizeRunEvents,
  readLatestCodexSessionMetrics,
  readRunSpoolDelta,
  readRunSpoolRecords,
} = {}) {
  function parseRecordTimestamp(record) {
    const parsed = Date.parse(record?.ts || '');
    return Number.isFinite(parsed) ? parsed : null;
  }

  async function createRunRuntimeInvocation(manifest) {
    return createToolInvocation(manifest.tool, '', {
      model: manifest.options?.model,
      effort: manifest.options?.effort,
      thinking: manifest.options?.thinking,
      runtimeFamily: manifest.runtimeFamily || manifest.options?.runtimeFamily,
    });
  }

  function buildRunProjectionPreview(spoolRecords = []) {
    return (spoolRecords || [])
      .filter((record) => ['stdout', 'stderr', 'error'].includes(record.stream))
      .map((record) => {
        if (record?.json && typeof record.json === 'object') {
          try {
            return clipPreview(JSON.stringify(record.json));
          } catch {}
        }
        return typeof record?.line === 'string' ? clipPreview(record.line) : '';
      })
      .filter(Boolean)
      .slice(-3)
      .join(' | ');
  }

  async function maybeAppendProjectedCodexUsage(run, runtimeInvocation, normalizedEvents = [], lastRecordTimestamp = null) {
    if (!runtimeInvocation?.isCodexFamily || !run?.codexThreadId) {
      return normalizedEvents;
    }
    if (normalizedEvents.some((event) => event?.type === 'usage')) {
      return normalizedEvents;
    }

    const metrics = await readLatestCodexSessionMetrics(run.codexThreadId, {
      startedAt: run.startedAt || run.createdAt || null,
      completedAt: run.completedAt || run.spoolCompletionDetectedAt || run.finalizedAt || null,
    });
    const payload = buildCodexContextMetricsPayload(metrics);
    if (!payload) {
      return normalizedEvents;
    }

    const metricsTimestamp = Date.parse(metrics?.timestamp || '');
    const stableTimestamp = Number.isFinite(metricsTimestamp) ? metricsTimestamp : lastRecordTimestamp;
    const parsedEvents = runtimeInvocation.adapter.parseLine(JSON.stringify(payload)).map((event) => ({
      ...event,
      ...(Number.isInteger(stableTimestamp) ? { timestamp: stableTimestamp } : {}),
    }));
    normalizedEvents.push(...normalizeRunEvents(run, parsedEvents));
    return normalizedEvents;
  }

  async function normalizeRunSpoolRecords(run, runtimeInvocation, spoolRecords = [], options = {}) {
    const { adapter } = runtimeInvocation;
    const normalizedEvents = [];
    let lastRecordTimestamp = null;

    for (const record of spoolRecords) {
      if (record?.stream !== 'stdout') continue;
      const line = await materializeRunSpoolLine(run.id, record);
      if (!line) continue;
      const stableTimestamp = parseRecordTimestamp(record);
      if (Number.isInteger(stableTimestamp)) {
        lastRecordTimestamp = stableTimestamp;
      }
      const parsedEvents = adapter.parseLine(line).map((event) => ({
        ...event,
        ...(Number.isInteger(stableTimestamp) ? { timestamp: stableTimestamp } : {}),
      }));
      normalizedEvents.push(...normalizeRunEvents(run, parsedEvents));
    }

    if (options.flush !== false) {
      const flushedEvents = adapter.flush().map((event) => ({
        ...event,
        ...(Number.isInteger(lastRecordTimestamp) ? { timestamp: lastRecordTimestamp } : {}),
      }));
      normalizedEvents.push(...normalizeRunEvents(run, flushedEvents));
    }
    if (options.includeCodexContextMetrics === true) {
      await maybeAppendProjectedCodexUsage(run, runtimeInvocation, normalizedEvents, lastRecordTimestamp);
    }

    return {
      normalizedEvents,
      preview: buildRunProjectionPreview(spoolRecords),
    };
  }

  async function collectNormalizedRunEvents(run, manifest) {
    const runtimeInvocation = await createRunRuntimeInvocation(manifest);
    const spoolRecords = await readRunSpoolRecords(run.id);
    const parsed = await normalizeRunSpoolRecords(run, runtimeInvocation, spoolRecords, {
      includeCodexContextMetrics: true,
    });
    return {
      runtimeInvocation,
      ...parsed,
    };
  }

  async function collectNormalizedRunEventDelta(run, manifest) {
    const runtimeInvocation = await createRunRuntimeInvocation(manifest);
    const delta = await readRunSpoolDelta(run.id, {
      startOffset: Number.isInteger(run?.normalizedByteOffset) ? run.normalizedByteOffset : 0,
      skipLines: Number.isInteger(run?.normalizedLineCount) ? run.normalizedLineCount : 0,
    });
    const parsed = await normalizeRunSpoolRecords(run, runtimeInvocation, delta.records, { flush: false });
    return {
      runtimeInvocation,
      ...parsed,
      nextOffset: delta.nextOffset,
      processedLineCount: delta.processedLineCount,
      skippedLineCount: delta.skippedLineCount,
    };
  }

  return {
    collectNormalizedRunEvents,
    collectNormalizedRunEventDelta,
  };
}
