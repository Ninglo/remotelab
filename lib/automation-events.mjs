import { EventEmitter } from 'node:events';

// In-process hints only. These never create a Run or send an external message.
const events = new EventEmitter();
export function hintAutomationActivity(sessionId = '', { resetIdle = false } = {}) { events.emit('activity', sessionId, { resetIdle }); }
export function onAutomationActivityHint(listener) {
  events.on('activity', listener);
  return () => events.off('activity', listener);
}
export function notifyAutomationWake(reason, cause = reason) { events.emit('wake', { reason, cause }); }
export function onAutomationWake(listener) {
  events.on('wake', listener);
  return () => events.off('wake', listener);
}
