// User engagement check engine for RemoteLab trial users.
// Reads user-instance bindings + live instance metrics → outputs daily follow-up brief.
//
// Usage:
//   import { checkUserEngagement } from './user-engagement-check.mjs';
//   const result = await checkUserEngagement({ days: 14 });
//   // result.users — per-user engagement cards
//   // result.actions — today's recommended actions sorted by priority
//   // result.summary — aggregate stats
//   // result.briefText — human-readable brief for Feishu/chat

import { readFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { collectLocalOpsReport } from './local-ops-summary.mjs';

const HOME = homedir();
const BINDINGS_PATH = join(HOME, '.config', 'remotelab', 'user-instance-bindings.json');

// --- Follow-up cadence thresholds (days since last activity) ---

const CADENCE = {
  onboardingCheck: 2,    // day 2: did they open it?
  gentleNudge: 5,        // day 5: how's it going?
  deepRecovery: 10,      // day 10+: what went wrong?
  churnRisk: 14,         // day 14+: last attempt before marking inactive
  activeCheckIn: 7,      // every 7 days for active users: relationship maintenance
};

// --- Engagement tier classification ---

function classifyEngagement(metrics) {
  const { totalUserMessages, daysSinceLastMessage, daysSinceAssigned, latestUserMessageAt } = metrics;

  // Treat as never-used if no real user messages or message timestamp is missing with very low count
  if (totalUserMessages === 0 || (totalUserMessages <= 5 && !latestUserMessageAt)) {
    return { tier: 'never_used', label: '从未使用', emoji: '🔴' };
  }
  if (daysSinceLastMessage >= 14) {
    return { tier: 'churned', label: '已流失', emoji: '⚫' };
  }
  if (daysSinceLastMessage >= 7) {
    return { tier: 'at_risk', label: '流失风险', emoji: '🟡' };
  }
  if (daysSinceLastMessage >= 3) {
    return { tier: 'cooling', label: '趋冷', emoji: '🟡' };
  }
  if (totalUserMessages >= 50) {
    return { tier: 'power_user', label: '深度用户', emoji: '🟢' };
  }
  if (totalUserMessages >= 15) {
    return { tier: 'active', label: '活跃', emoji: '🟢' };
  }
  if (daysSinceAssigned <= 3) {
    return { tier: 'onboarding', label: '新用户', emoji: '🔵' };
  }
  return { tier: 'light', label: '轻度使用', emoji: '🔵' };
}

// --- Determine what follow-up action is needed ---

function determineAction(metrics, engagement) {
  const { daysSinceLastMessage, daysSinceAssigned, totalUserMessages, daysSinceLastFollowUp } = metrics;
  const { tier } = engagement;

  // Never used — urgent onboarding rescue
  if (tier === 'never_used') {
    if (daysSinceAssigned >= CADENCE.onboardingCheck) {
      return {
        priority: 1,
        action: 'onboarding_rescue',
        reason: `发链接 ${daysSinceAssigned} 天了，从未真正使用`,
        suggestion: '确认是否卡在入口，主动做一次引导式 demo',
      };
    }
    return null; // too early
  }

  // Churned — last recovery attempt
  if (tier === 'churned') {
    return {
      priority: 2,
      action: 'churn_recovery',
      reason: `已沉默 ${daysSinceLastMessage} 天，曾发过 ${totalUserMessages} 条消息`,
      suggestion: totalUserMessages >= 20
        ? '曾是活跃用户，深度了解流失原因，看是否有未解决的 blocker'
        : '使用较浅就流失了，可能需要更具体的场景引导',
    };
  }

  // At risk — deep follow-up
  if (tier === 'at_risk') {
    return {
      priority: 3,
      action: 'deep_followup',
      reason: `${daysSinceLastMessage} 天未活跃`,
      suggestion: '主动问候，了解停用原因，是否遇到问题',
    };
  }

  // Cooling — gentle nudge
  if (tier === 'cooling') {
    return {
      priority: 4,
      action: 'gentle_nudge',
      reason: `${daysSinceLastMessage} 天没动静`,
      suggestion: '轻量问候，问问最近用得怎么样',
    };
  }

  // Active / power user — periodic check-in
  if (tier === 'power_user' || tier === 'active') {
    if (daysSinceLastFollowUp === null || daysSinceLastFollowUp >= CADENCE.activeCheckIn) {
      return {
        priority: 5,
        action: 'relationship_maintenance',
        reason: `活跃用户，${totalUserMessages} 条消息，适合深入了解需求`,
        suggestion: '聊使用场景、产品反馈、付费意愿、是否想让团队其他人也用',
      };
    }
    return null; // recently followed up
  }

  return null;
}

// --- Generate conversation starter ---

function generateConversationStarter(user, engagement, action, metrics) {
  if (!action) return null;

  const name = user.userName;
  const notes = user.notes || '';

  switch (action.action) {
    case 'onboarding_rescue':
      return `"${name}，前几天给你发的那个试用链接，有没有顺利打开？如果遇到什么问题我直接帮你看。"`;

    case 'churn_recovery':
      if (notes.includes('远程交付')) {
        return `"${name}，之前你提到的那个文件下载的问题，我们这边做了一些改进。方便的话你可以再试试，有什么问题随时说。"`;
      }
      return `"${name}，好久没聊了。之前试用的感觉怎么样？有没有遇到什么不好用的地方，我来看看能不能解决。"`;

    case 'deep_followup':
      if (metrics.totalUserMessages <= 10) {
        return `"${name}，之前给你发的那个试用，用着顺手吗？如果有不清楚怎么用的地方我可以帮你看看。"`;
      }
      return `"${name}，最近是不是比较忙？我看你之前用得挺好的，有没有什么功能上的需求或者不顺的地方？"`;

    case 'gentle_nudge':
      return `"${name}，最近在忙什么呢？你那个实例还在跑着，有需要随时用。"`;

    case 'relationship_maintenance': {
      if (notes.includes('短视频') || notes.includes('工业设计')) {
        return `"${name}，看你用得挺频繁的，团队那边有没有其他人也想试试？另外你现在主要用来做什么场景？"`;
      }
      if (notes.includes('报账') || notes.includes('记账')) {
        return `"${name}，记账那个流程最近跑得顺吗？除了这个之外你还在用什么场景？有没有什么想让它帮你做但目前做不到的事？"`;
      }
      return `"${name}，最近用着感觉怎么样？我想听听你的真实反馈，好的坏的都行。"`;
    }

    default:
      return null;
  }
}

// --- Main check function ---

export async function checkUserEngagement({ days = 14, nowMs = Date.now() } = {}) {
  // 1. Load bindings
  let bindings;
  try {
    bindings = JSON.parse(await readFile(BINDINGS_PATH, 'utf8'));
  } catch (err) {
    return { error: `Failed to read bindings: ${err.message}`, users: [], actions: [], summary: {} };
  }

  const bindingsList = bindings.bindings || [];
  if (bindingsList.length === 0) {
    return { users: [], actions: [], summary: { totalUsers: 0 }, briefText: '当前没有绑定用户。' };
  }

  // 2. Load instance metrics
  // Engagement only needs per-instance activity summaries.
  // Skip host/process probes so admin views don't block on unrelated system diagnostics.
  const report = await collectLocalOpsReport({
    days,
    nowMs,
    includeHostMetrics: false,
    includeServiceProcesses: false,
    reachabilityMode: 'none',
  });
  const trials = report.trials || [];
  const trialMap = new Map(trials.map(t => [t.name, t]));

  const now = nowMs;
  const users = [];
  const actions = [];

  // 3. Process each binding
  for (const binding of bindingsList) {
    const instance = trialMap.get(binding.instanceName);
    const assignedAt = new Date(binding.assignedAt).getTime();
    const daysSinceAssigned = Math.round((now - assignedAt) / 86400000);

    let totalUserMessages = 0;
    let sessionCount = 0;
    let latestUserMessageAt = null;
    let daysSinceLastMessage = null;
    let status = 'unknown';

    if (instance) {
      totalUserMessages = instance.totalUserMessageCount || 0;
      sessionCount = instance.sessionCount || 0;
      latestUserMessageAt = instance.latestUserMessageAt || null;
      status = instance.status || 'unknown';

      if (latestUserMessageAt) {
        daysSinceLastMessage = Math.round((now - new Date(latestUserMessageAt).getTime()) / 86400000);
      } else {
        // Has API requests but no user messages → opened but never used
        daysSinceLastMessage = daysSinceAssigned;
      }
    } else {
      daysSinceLastMessage = daysSinceAssigned;
    }

    const metrics = {
      totalUserMessages,
      sessionCount,
      daysSinceLastMessage: daysSinceLastMessage ?? daysSinceAssigned,
      daysSinceAssigned,
      latestUserMessageAt,
      // TODO: track last follow-up date from event log
      daysSinceLastFollowUp: null,
    };

    const engagement = classifyEngagement(metrics);
    const action = determineAction(metrics, engagement);
    const conversationStarter = generateConversationStarter(binding, engagement, action, metrics);

    const userCard = {
      userName: binding.userName,
      instanceName: binding.instanceName,
      assignedAt: binding.assignedAt,
      source: binding.source,
      notes: binding.notes,
      metrics,
      engagement,
      action: action ? { ...action, conversationStarter } : null,
      instanceStatus: status,
    };

    users.push(userCard);

    if (action) {
      actions.push({
        ...action,
        userName: binding.userName,
        instanceName: binding.instanceName,
        conversationStarter,
      });
    }
  }

  // 4. Sort actions by priority
  actions.sort((a, b) => a.priority - b.priority);

  // 5. Build summary
  const summary = {
    totalUsers: users.length,
    activeUsers: users.filter(u => ['power_user', 'active', 'onboarding'].includes(u.engagement.tier)).length,
    atRiskUsers: users.filter(u => ['at_risk', 'cooling'].includes(u.engagement.tier)).length,
    churnedUsers: users.filter(u => ['churned', 'never_used'].includes(u.engagement.tier)).length,
    actionsNeeded: actions.length,
  };

  // 6. Build brief text
  const briefText = buildBriefText(users, actions, summary);

  return { users, actions, summary, briefText };
}

// --- Brief text generation for Feishu/chat ---

function buildBriefText(users, actions, summary) {
  const lines = [];
  lines.push(`用户运营：${summary.totalUsers}人跟进中，${summary.activeUsers}人活跃，${summary.atRiskUsers}人趋冷，${summary.churnedUsers}人流失/未启用`);

  if (actions.length === 0) {
    lines.push('今天暂无需要主动联系的用户。');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`今日关注（${actions.length}人需要联系）：`);

  for (const action of actions) {
    const label = action.priority <= 2 ? '⚠️' : (action.priority <= 4 ? '💬' : '📋');
    lines.push(`${label} ${action.userName}：${action.reason}`);
    lines.push(`   建议：${action.suggestion}`);
    if (action.conversationStarter) {
      lines.push(`   开场：${action.conversationStarter}`);
    }
  }

  return lines.join('\n');
}

// --- Compact focus line for daily brief body ---

export function buildEngagementFocusLine(summary, actions) {
  if (actions.length === 0) {
    return `用户侧${summary.totalUsers}人跟进中，${summary.activeUsers}人活跃，今天无需主动联系。`;
  }
  const urgentCount = actions.filter(a => a.priority <= 2).length;
  const topNames = actions.slice(0, 2).map(a => a.userName).join('、');
  if (urgentCount > 0) {
    return `用户侧${urgentCount}人需紧急联系（${topNames}），共${actions.length}人待跟进。`;
  }
  return `用户侧${actions.length}人建议联系（${topNames}），${summary.activeUsers}人活跃中。`;
}
