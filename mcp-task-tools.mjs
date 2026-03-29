/**
 * RemoteLab MCP Task Tools
 *
 * Provides task management MCP tools that communicate with the chat-server
 * via HTTP API. Designed to be imported and registered by mcp-server.mjs.
 */

import { readFileSync } from 'fs';
import { join } from 'path';

const TEMPLATES_FILE = join(import.meta.dirname, 'team-templates.json');

// ---- MCP Tool Definitions ----

export const TASK_TOOLS = [
  {
    name: 'create_task',
    description: 'Create a task with subject, description, assigned session, and dependencies. Status is auto-set to "blocked" if blocked_by is non-empty, else "pending".',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Task subject / title.' },
        description: { type: 'string', description: 'Detailed description of the task.' },
        assigned_session_id: { type: 'string', description: 'Session ID to assign this task to.' },
        blocked_by: {
          type: 'array',
          items: { type: 'string' },
          description: 'Array of task IDs that must complete before this task can start.',
        },
        report_to: {
          type: 'string',
          description: 'Session ID to report back to when this task\'s assigned session completes.',
        },
      },
      required: ['subject'],
    },
  },
  {
    name: 'get_task',
    description: 'Get a task by its ID, including status, dependencies, and assignment.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID.' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'list_tasks',
    description: 'List all tasks, optionally filtered by status and/or assigned session.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status: pending, blocked, in_progress, completed.' },
        assigned_session_id: { type: 'string', description: 'Filter by assigned session ID.' },
      },
      required: [],
    },
  },
  {
    name: 'update_task',
    description: 'Update a task\'s fields. Setting status to "completed" automatically triggers dependency resolution and auto-dispatch of unblocked tasks.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: 'The task ID to update.' },
        subject: { type: 'string', description: 'New subject.' },
        description: { type: 'string', description: 'New description.' },
        status: { type: 'string', description: 'New status: pending, blocked, in_progress, completed.' },
        assigned_session_id: { type: 'string', description: 'New assigned session ID.' },
        blocked_by: {
          type: 'array',
          items: { type: 'string' },
          description: 'New list of blocking task IDs.',
        },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'launch_team',
    description: 'Launch a team from a predefined template. Creates sessions for each role, creates tasks with dependencies, and sends startup messages to unblocked tasks. Available templates: "software-dev" (leader + backend + frontend + tester), "research" (researcher + analyzer + writer).',
    inputSchema: {
      type: 'object',
      properties: {
        template_name: { type: 'string', description: 'Template name (e.g. "software-dev", "research").' },
        goal: { type: 'string', description: 'The project goal — injected into prompt templates via {{goal}}.' },
        goal_folder: { type: 'string', description: 'Project folder path — injected via {{goal_folder}} and used as session folder.' },
        team_name: { type: 'string', description: 'Team name prefix for session naming (e.g. "auth-refactor").' },
      },
      required: ['template_name', 'goal', 'goal_folder'],
    },
  },
];

// ---- Tool Execution ----

/**
 * Execute a task-related MCP tool.
 * @param {string} name - Tool name
 * @param {Object} args - Tool arguments
 * @param {Function} apiRequest - HTTP client: (method, path, body?) => { status, data }
 * @returns MCP tool result
 */
export async function executeTaskTool(name, args, apiRequest) {
  switch (name) {
    case 'create_task': {
      const body = { subject: args.subject };
      if (args.description) body.description = args.description;
      if (args.assigned_session_id) body.assigned_session_id = args.assigned_session_id;
      if (args.blocked_by) body.blocked_by = args.blocked_by;
      if (args.report_to) body.report_to = args.report_to;
      const res = await apiRequest('POST', '/api/tasks', body);
      if (res.status !== 201) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'get_task': {
      const res = await apiRequest('GET', `/api/tasks/${args.task_id}`);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'list_tasks': {
      const params = new URLSearchParams();
      if (args.status) params.set('status', args.status);
      if (args.assigned_session_id) params.set('assigned_session_id', args.assigned_session_id);
      const qs = params.toString();
      const path = qs ? `/api/tasks?${qs}` : '/api/tasks';
      const res = await apiRequest('GET', path);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'update_task': {
      const body = {};
      if (args.subject !== undefined) body.subject = args.subject;
      if (args.description !== undefined) body.description = args.description;
      if (args.status !== undefined) body.status = args.status;
      if (args.assigned_session_id !== undefined) body.assigned_session_id = args.assigned_session_id;
      if (args.blocked_by !== undefined) body.blocked_by = args.blocked_by;
      const res = await apiRequest('PATCH', `/api/tasks/${args.task_id}`, body);
      if (res.status !== 200) return { isError: true, content: [{ type: 'text', text: `Error ${res.status}: ${JSON.stringify(res.data)}` }] };
      return { content: [{ type: 'text', text: JSON.stringify(res.data, null, 2) }] };
    }

    case 'launch_team': {
      return await launchTeam(args, apiRequest);
    }

    default:
      return { isError: true, content: [{ type: 'text', text: `Unknown task tool: ${name}` }] };
  }
}

// ---- launch_team implementation ----

async function launchTeam(args, apiRequest) {
  const { template_name, goal, goal_folder, team_name } = args;

  // 1. Load template
  let templates;
  try {
    templates = JSON.parse(readFileSync(TEMPLATES_FILE, 'utf8'));
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Failed to read team-templates.json: ${err.message}` }] };
  }

  const template = templates[template_name];
  if (!template) {
    const available = Object.keys(templates).join(', ');
    return { isError: true, content: [{ type: 'text', text: `Unknown template "${template_name}". Available: ${available}` }] };
  }

  const prefix = team_name || template_name;
  const log = [];

  // 2. Create sessions for each role
  const roleToSessionId = {};
  for (const role of template.roles) {
    const folder = role.folder.replace(/\{\{goal_folder\}\}/g, goal_folder);
    const sessionName = `${prefix}-${role.name}`;
    const body = { folder, tool: role.tool, name: sessionName };
    const res = await apiRequest('POST', '/api/sessions', body);
    if (res.status !== 201) {
      log.push(`Failed to create session for role "${role.name}": ${res.status} ${JSON.stringify(res.data)}`);
      continue;
    }
    roleToSessionId[role.name] = res.data.session.id;
    log.push(`Created session "${sessionName}" (${res.data.session.id.slice(0, 8)}) for role "${role.name}"`);
  }

  // 3. Create tasks with dependencies
  // First pass: create all tasks, collect subject -> taskId mapping
  const subjectToTaskId = {};

  for (const taskDef of template.tasks) {
    if (!roleToSessionId[taskDef.role]) {
      log.push(`Skipping task "${taskDef.subject}" - no session for role "${taskDef.role}"`);
      continue;
    }

    const body = {
      subject: taskDef.subject,
      description: `Team: ${prefix} | Role: ${taskDef.role} | Goal: ${goal}`,
      assigned_session_id: roleToSessionId[taskDef.role],
      blocked_by: [],
    };
    const res = await apiRequest('POST', '/api/tasks', body);
    if (res.status !== 201) {
      log.push(`Failed to create task "${taskDef.subject}": ${res.status}`);
      continue;
    }
    subjectToTaskId[taskDef.subject] = res.data.task.id;
    log.push(`Created task "${taskDef.subject}" (${res.data.task.id.slice(0, 8)}) assigned to ${taskDef.role}`);
  }

  // Second pass: set blocked_by using subject -> taskId mapping
  for (const taskDef of template.tasks) {
    if (!subjectToTaskId[taskDef.subject]) continue;
    if (!taskDef.blocked_by || taskDef.blocked_by.length === 0) continue;

    const blockedByIds = taskDef.blocked_by
      .map(subject => subjectToTaskId[subject])
      .filter(Boolean);

    if (blockedByIds.length > 0) {
      const taskId = subjectToTaskId[taskDef.subject];
      await apiRequest('PATCH', `/api/tasks/${taskId}`, {
        blocked_by: blockedByIds,
        status: 'blocked',
      });
      log.push(`Set dependencies for "${taskDef.subject}": blocked by ${blockedByIds.map(id => id.slice(0, 8)).join(', ')}`);
    }
  }

  // 4. Send startup messages to unblocked tasks (those with no blocked_by)
  for (const taskDef of template.tasks) {
    if (taskDef.blocked_by && taskDef.blocked_by.length > 0) continue;
    if (!roleToSessionId[taskDef.role]) continue;
    if (!subjectToTaskId[taskDef.subject]) continue;

    const role = template.roles.find(r => r.name === taskDef.role);
    if (!role) continue;

    const prompt = role.prompt_template
      .replace(/\{\{goal\}\}/g, goal)
      .replace(/\{\{goal_folder\}\}/g, goal_folder);

    const sessionId = roleToSessionId[taskDef.role];
    const taskId = subjectToTaskId[taskDef.subject];
    const text = `${prompt}\n\nTask ID: ${taskId}\n任务: ${taskDef.subject}`;

    const msgBody = { text };
    if (role.model) msgBody.model = role.model;
    const res = await apiRequest('POST', `/api/sessions/${sessionId}/messages`, msgBody);
    if (res.status === 202) {
      log.push(`Sent startup message to "${taskDef.role}" (${sessionId.slice(0, 8)})`);
    } else {
      log.push(`Failed to send startup message to "${taskDef.role}": ${res.status}`);
    }
  }

  const summary = [
    `Team "${prefix}" launched from template "${template_name}"`,
    `Roles: ${Object.keys(roleToSessionId).join(', ')}`,
    `Tasks: ${Object.keys(subjectToTaskId).length} created`,
    '',
    ...log,
  ].join('\n');

  return { content: [{ type: 'text', text: summary }] };
}
