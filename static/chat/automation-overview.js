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
    const title = (task.title || task.package?.title || "").replace(/\([^)]*\)|（[^）]*）/g, "");
    if (/复盘|审阅|回顾|review|retrospect|reflection/i.test(title)) return "review";
    if (/巡检|监控|检查|监管|健康|monitor|inspect|health|check/i.test(title)) return "inspection";
    if (/报告|日报|同步|汇总|report|sync|digest/i.test(title)) return "report";
    if (/提醒|跟进|通知|remind|follow.up|notif/i.test(title)) return "reminder";
    return "other";
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

  scope.RemoteLabAutomationOverview = { category, purpose, days };
})(typeof window === "undefined" ? globalThis : window);
