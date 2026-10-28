import { readBody } from '../lib/utils.mjs';
import { proposeAutomationConfirmation, readAutomationConfirmation, actOnAutomationConfirmation,
  recordAutomationCardReceipt } from './automation-confirmations.mjs';

export async function handleAutomationConfirmationRoutes({ req, res, pathname, authSession, writeJson }) {
  if (!pathname.startsWith('/api/automation-confirmations')) return false;
  // Card actions originate in the authenticated connector, never browser JSON.
  if (authSession?.authKind !== 'service') { writeJson(res, 403, { error: 'Service authentication required' }); return true; }
  try {
    if (pathname === '/api/automation-confirmations' && req.method === 'POST') {
      const input = JSON.parse(await readBody(req, 32768));
      writeJson(res, 201, { confirmation: await proposeAutomationConfirmation(input) });
      return true;
    }
    const match = /^\/api\/automation-confirmations\/([a-f0-9]{24})(?:\/(action|receipt))?$/.exec(pathname);
    if (!match) { writeJson(res, 404, { error: 'Not found' }); return true; }
    if (req.method === 'GET' && !match[2]) writeJson(res, 200, { confirmation: await readAutomationConfirmation(match[1]) });
    else if (req.method === 'POST' && match[2]) {
      const input = JSON.parse(await readBody(req, 8192));
      const operation = match[2] === 'action' ? actOnAutomationConfirmation : recordAutomationCardReceipt;
      writeJson(res, 200, { confirmation: await operation(match[1], input) });
    } else writeJson(res, 405, { error: 'Method not allowed' });
  } catch (error) { writeJson(res, 400, { error: error.message }); }
  return true;
}
