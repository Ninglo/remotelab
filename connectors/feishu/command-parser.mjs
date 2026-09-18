const COMMANDS = Object.freeze({
  help: { args: 'none' },
  status: { args: 'none' },
  default: { args: 'default' },
  harness: { args: 'optional' },
  model: { args: 'optional', aliases: ['m'] },
  effort: { args: 'optional' },
  follow: { args: 'none' },
  mute: { args: 'none' },
  unmute: { args: 'none' },
  fork: { args: 'none', task: true, aliases: ['f'] },
  quick: { args: 'none', task: true, aliases: ['q'] },
  continue: { args: 'none', task: true },
});

function buildCommandAliases() {
  const aliases = {};
  const canonicalNames = new Set(Object.keys(COMMANDS));
  for (const [name, definition] of Object.entries(COMMANDS)) {
    if (definition.aliases !== undefined && !Array.isArray(definition.aliases)) {
      throw new Error(`Feishu command /${name} aliases must be an array`);
    }
    for (const rawAlias of definition.aliases || []) {
      const alias = String(rawAlias || '').trim().toLowerCase();
      if (!/^[a-z][a-z0-9_-]*$/.test(alias)) throw new Error(`Invalid Feishu command alias: /${rawAlias}`);
      if (canonicalNames.has(alias)) throw new Error(`Feishu command alias /${alias} conflicts with a command name`);
      if (Object.hasOwn(aliases, alias)) throw new Error(`Duplicate Feishu command alias: /${alias}`);
      aliases[alias] = name;
    }
  }
  return Object.freeze(aliases);
}

const COMMAND_ALIASES = buildCommandAliases();

const COMMAND_LINE = /^(?:@[^/\r\n]+?[ \t]+)?\/([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+(.*))?$/;
const TASK_MODIFIERS = Object.freeze({
  harness: 'harness',
  model: 'model',
  effort: 'effort',
});

function normalizeText(value) {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function parseArguments(name, rawArgs, lineNumber) {
  const args = String(rawArgs || '').trim();
  const definition = commandDefinition(name);
  if (!definition) return { error: `未知命令：/${name}（第 ${lineNumber} 行）` };
  if (definition.args === 'none' && args) {
    return { error: `/${name} 不接受参数（第 ${lineNumber} 行）` };
  }
  if (definition.args === 'optional') {
    if (!args) return {};
    if (/\s/.test(args)) return { error: `/${name} 需要一个不含空格的参数（第 ${lineNumber} 行）` };
    return { value: args };
  }
  if (definition.args === 'default') {
    const match = args.match(/^(harness|model|effort)[ \t]+([^\s]+)$/i);
    if (!match) return { error: '/default 用法：/default harness <名称>、/default model <模型 ID> 或 /default effort <级别>' };
    return { field: match[1].toLowerCase(), value: match[2] };
  }
  return {};
}

function parseTaskArguments(name, rawArgs, lineNumber) {
  let rest = String(rawArgs || '').trim();
  const commands = [{ name }];

  while (rest.startsWith('--')) {
    const delimiter = rest.match(/^--(?:[ \t]+|$)/);
    if (delimiter) {
      rest = rest.slice(delimiter[0].length).trim();
      break;
    }

    const optionName = rest.match(/^--([A-Za-z][A-Za-z0-9_-]*)(?==|[ \t]|$)/)?.[1]?.toLowerCase();
    if (!optionName || !Object.hasOwn(TASK_MODIFIERS, optionName)) {
      return { error: `未知修饰参数：--${optionName || rest.slice(2).split(/\s/, 1)[0]}（第 ${lineNumber} 行）` };
    }

    const option = rest.match(/^--[A-Za-z][A-Za-z0-9_-]*(?:=([^\s]+)|[ \t]+([^\s]+))(?:[ \t]+|$)/);
    if (!option) return { error: `--${optionName} 需要一个不含空格的值（第 ${lineNumber} 行）` };
    commands.push({ name: TASK_MODIFIERS[optionName], value: option[1] || option[2] });
    rest = rest.slice(option[0].length).trim();
  }

  return { commands, body: rest };
}

/**
 * Parse the explicit Feishu command-block protocol.
 *
 * Task actions accept an inline shape such as
 * `/fork --model gpt-5.6 --effort high task text`. Modifiers are expanded to
 * the same command list used by the legacy multi-line command block. Task text
 * can start on the action line, on the next non-command line, or after the old
 * blank-line separator. A leading @mention is allowed on the first command
 * line because Feishu rich text commonly renders the Bot mention in front of
 * the command. Slash-prefixed text enters command handling only when the first
 * name is registered; otherwise the complete message remains ordinary text.
 */
export function parseFeishuCommandBlock(input) {
  const text = normalizeText(input);
  const lines = text.split('\n');
  let index = 0;
  const commands = [];

  while (index < lines.length && lines[index].trim() !== '') {
    const line = lines[index];
    const match = line.trim().match(COMMAND_LINE);
    if (!match) {
      if (commands.length > 0) {
        if (commands.some(command => commandDefinition(command.name)?.task)) {
          return { commands, body: lines.slice(index).join('\n').trim() };
        }
        return { commands: [], body: '', error: '命令必须连续写在消息开头；命令和任务正文之间要空一行。' };
      }
      return { commands: [], body: text.trim() };
    }
    const enteredName = match[1].toLowerCase();
    const name = resolveFeishuCommandName(enteredName);
    if (!name && commands.length === 0) return { commands: [], body: text.trim() };
    if (!name) return { commands: [], body: '', error: `未知命令：/${enteredName}（第 ${index + 1} 行）` };
    if (commandDefinition(name)?.task) {
      const parsed = parseTaskArguments(name, match[2], index + 1);
      if (parsed.error) return { commands: [], body: '', error: parsed.error };
      commands.push(...parsed.commands);
      index += 1;
      if (parsed.body) {
        return { commands, body: [parsed.body, ...lines.slice(index)].join('\n').trim() };
      }
      continue;
    }
    const parsed = parseArguments(name, match[2], index + 1);
    if (parsed.error) return { commands: [], body: '', error: parsed.error };
    commands.push({ name, ...parsed });
    index += 1;
  }

  if (commands.length === 0) return { commands: [], body: text.trim() };
  const body = index < lines.length ? lines.slice(index + 1).join('\n').trim() : '';
  return { commands, body };
}

export function commandDefinition(name) {
  const canonicalName = resolveFeishuCommandName(name);
  return canonicalName ? COMMANDS[canonicalName] : null;
}

export const feishuCommandNames = Object.freeze(Object.keys(COMMANDS));
export const feishuCommandAliases = COMMAND_ALIASES;

export function resolveFeishuCommandName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (Object.hasOwn(COMMANDS, name)) return name;
  return Object.hasOwn(COMMAND_ALIASES, name) ? COMMAND_ALIASES[name] : '';
}
