import messages from './working-messages.json';

export const WORKING_MESSAGES = Object.values(messages);

export function workingMessage(elapsedSeconds = 0): string {
  const elapsed = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  return WORKING_MESSAGES[Math.floor(elapsed / 10) % WORKING_MESSAGES.length] ?? messages.working;
}
