import { spawn } from 'node:child_process';
import { getSummaryFeishuResources } from './inbound-envelope.mjs';

// Operator configuration selects a fixed business executor. Neither the message
// nor the semantic parser can select an executable, identity, path or URL.
export async function executeRecruitingWorkflow(command, summary, {readOnly = false} = {}) {
  const packet = {version: 1, mode: readOnly ? 'receipt' : 'execute',
    appId:summary.appId, tenantKey:summary.tenantKey, sender:summary.sender,
    messageId:summary.messageId, chatId:summary.chatId, chatType:summary.chatType,
    eventType:summary.eventType, messageType:summary.messageType,
    text:summary.messageText || '', resources:getSummaryFeishuResources(summary)};
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), {stdio:['pipe','pipe','pipe'], shell:false});
    let output = '', diagnostic = '', settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    // File parsing, a short semantic call and native calendar/database steps.
    // Durable business receipts recover unknown results; a timeout never retries writes here.
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('Recruiting workflow timed out')); }, 240_000);
    child.stdout.on('data', bytes => {
      output += bytes;
      if (output.length > 64_000) {child.kill('SIGTERM'); finish(new Error('Recruiting result too large'));}
    });
    child.stderr.on('data', bytes => { diagnostic = (diagnostic + bytes).slice(-2000); });
    child.stdin.on('error', error => finish(error));
    child.on('error', error => finish(error));
    child.on('close', code => {
      if (code !== 0) return finish(new Error('Recruiting executor failed; saved operation must be checked'));
      try {
        const result = JSON.parse(output);
        if (typeof result.handled !== 'boolean' || (result.handled &&
            (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 24000)))
          throw new Error('Invalid recruiting workflow receipt');
        finish(null, result);
      } catch (error) { finish(error); }
    });
    child.stdin.end(JSON.stringify(packet));
  });
}
