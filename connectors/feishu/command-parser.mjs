const COMMANDS = Object.freeze({
  help: { args: 'none' },
  status: { args: 'none' },
  default: { args: 'default' },
  harness: { args: 'optional' },
  model: { args: 'optional' },
  effort: { args: 'optional' },
  follow: { args: 'none' },
  mute: { args: 'none' },
  unmute: { args: 'none' },
  fork: { args: 'none', task: true },
  continue: { args: 'none', task: true },
});

const COMMAND_LINE = /^(?:@[^/\r\n]+?[ \t]+)?\/([A-Za-z][A-Za-z0-9_-]*)(?:[ \t]+(.*))?$/;

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

/**
 * Parse the explicit Feishu command-block protocol.
 *
 * A command block is the consecutive non-empty slash-command lines at the
 * start of a message. One empty line terminates it; everything after that is
 * task text. A leading @mention is allowed on the first command line because
 * Feishu rich text commonly renders the Bot mention in front of the command.
 * Slash-prefixed text enters command handling only when the first name is a
 * registered command; otherwise the complete message remains ordinary text.
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
        return { commands: [], body: '', error: '命令必须连续写在消息开头；命令和任务正文之间要空一行。' };
      }
      return { commands: [], body: text.trim() };
    }
    const name = match[1].toLowerCase();
    if (!commandDefinition(name) && commands.length === 0) return { commands: [], body: text.trim() };
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
  return Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : null;
}

export const feishuCommandNames = Object.freeze(Object.keys(COMMANDS));
