"use strict";

// Presentation only: these categories never change producers or alert state.
(function attachAutomationOverview(scope) {
  function isLive(task) {
    if (["accepted", "admitted"].includes(task.state) && task.lastExecution?.runAvailable === false) return false;
    return ["scheduled", "starting", "running", "accepted", "admitted"].includes(task.state);
  }

  function category(task) {
    const members = task.members || [task];
    if (members.some(item => item.kind === "recurring" && item.state === "active")) return "recurring";
    if (members.some(item => item.kind === "one_time" && isLive(item))) return "one_time";
    if (members.some(item => item.state === "paused")) return "stopped";
    const recurring = members.filter(item => item.kind === "recurring");
    if (recurring.length || members.every(item => item.state === "cancelled")) return "stopped";
    // Completion and failure describe an attempt, not a new automation type.
    return "one_time";
  }

  function purpose(task) {
    const explicit = task.purpose || (task.members || []).find(item => item.purpose)?.purpose;
    if (purposes.includes(explicit)) return explicit;
    const title = (task.title || task.package?.title || "").replace(/\([^)]*\)|（[^）]*）/g, "");
    if (/反馈|复盘|回顾|retrospect|reflection/i.test(title)) return "improvement";
    if (/个人记忆|记忆.*核验|记忆.*候选|Skill.*候选|memory.*review/i.test(title)) return "memory";
    if (/项目审阅|项目巡检|项目.*TODO|项目.*待办|历史会话未推进|项目日报|总日报/i.test(title)) return "projects";
    if (/前沿追踪|前沿资讯|数据集.*发现|数据集.*审核|research.*intake/i.test(title)) return "research";
    if (/RoboDojo|评测.*报告|任务消费|seed.*gate/i.test(title)) return "execution";
    if (/磁盘|账号.*额度|资源.*告警|接口.*监管|运行.*健康|disk|quota/i.test(title)) return "operations";
    return "other";
  }

  const purposes = ["operations", "projects", "research", "execution", "memory", "improvement", "other"];

  function businessStatus(task, now = Date.now()) {
    const source = (task.members || [task]).find(item => item.kind === "recurring" && item.state === "active") || task;
    const check = source.check;
    const at = Date.parse(check?.at || "");
    if (source.state !== "active" || !Number.isFinite(at) || at > now + 5000 || now - at > 10 * 60_000 || check.error) return null;
    if (["consumer_disabled", "notifications_paused", "legacy_job_disabled", "job_cancelled"].includes(check.reason)) return "disabled";
    if (["send_uncertain", "retry_limit_reached"].includes(check.reason)) return "blocked";
    if (["no_new_entries", "no project due", "not_due"].includes(check.reason)) return "waiting";
    return null;
  }

  function dayKey(value, timezone) {
    const date = new Date(value || "");
    if (!Number.isFinite(date.getTime())) return "unknown";
    try {
      const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone || "Asia/Shanghai",
        year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
      const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
      return `${fields.year}-${fields.month}-${fields.day}`;
    } catch { return dayKey(value, "Asia/Shanghai"); }
  }

  function days(entries, timezone) {
    const groups = new Map();
    for (const entry of entries) {
      const key = dayKey(entry.attemptedAt || entry.admittedAt || entry.scheduledAt, timezone);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(entry);
    }
    return [...groups].sort(([a], [b]) => b.localeCompare(a)).map(([day, records]) => ({ day, records }));
  }

  const displayPurposes = ["operations", "memory", "tracking", "knowledge", "other"];
  function displayPurpose(task) {
    const original = purpose(task);
    if (["projects", "execution"].includes(original)) return "tracking";
    if (original === "research") return "knowledge";
    if (original === "improvement") return "memory";
    return original;
  }
  function latestExecutionSession(task) {
    const members = task.members || [task];
    if (!members.some(item => item.sessionCollection === "automations")) return null;
    return members.filter(item => item.sessionCollection === "automations").flatMap(item => [item.lastExecution, item.summary?.latestExecution, ...(item.recentExecutions || [])])
      .filter(item => item?.sessionId)
      .sort((a, b) => (Date.parse(b.scheduledAt || b.attemptedAt || "") || 0)
        - (Date.parse(a.scheduledAt || a.attemptedAt || "") || 0))[0] || null;
  }


  // Read-only daily plan. Only an unambiguous daily cron is expanded; other
  // expressions retain their next occurrence and original cadence, never guessed.
  function timeline(tasks) {
    const daily = new Map(), repeating = [], once = [], stopped = [];
    for (const task of tasks) {
      if (task.kind === 'one_time') {
        if (isLive(task)) once.push(task); else stopped.push(task);
        continue;
      }
      if (task.state !== 'active') { stopped.push(task); continue; }
      const fields = (task.schedule?.cron || '').trim().split(/\s+/);
      const [minute, hours, date, month, weekday] = fields;
      const fixed = task.schedule?.type === 'cron' && fields.length === 5
        && /^\d+$/.test(minute) && Number(minute) < 60
        && /^\d+(?:,\d+)*$/.test(hours) && hours.split(',').every(h => Number(h) < 24)
        && [date, month, weekday].every(v => v === '*');
      if (!fixed) { repeating.push(task); continue; }
      const timezone = task.schedule.timezone || 'Asia/Shanghai';
      for (const hour of new Set(hours.split(',').map(Number))) {
        const time = String(hour).padStart(2, '0') + ':' + minute.padStart(2, '0');
        const id = timezone + ':' + time;
        if (!daily.has(id)) daily.set(id, { time, timezone, tasks: [] });
        daily.get(id).tasks.push(task);
      }
    }
    return { daily: [...daily.values()].sort((a,b) => a.timezone.localeCompare(b.timezone) || a.time.localeCompare(b.time)),
      repeating: repeating.sort((a,b) => (a.schedule?.everySeconds || 86400) - (b.schedule?.everySeconds || 86400)),
      once: once.sort((a,b) => String(a.schedule?.scheduledAt || '').localeCompare(String(b.schedule?.scheduledAt || ''))),
      stopped, recurringCount: tasks.filter(t => t.kind === 'recurring' && t.state === 'active').length };
  }

  scope.RemoteLabAutomationOverview = { category, purpose, purposes, displayPurpose, displayPurposes, businessStatus, days, latestExecutionSession, timeline };
})(typeof window === "undefined" ? globalThis : window);
