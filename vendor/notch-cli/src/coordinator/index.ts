/**
 * Notch CLI — Coordinator Mode (barrel)
 *
 * Coordinator mode restricts the top-level agent to orchestration: it can only
 * spawn, continue, or stop worker agents (plus read-only recon). All real work
 * is delegated. Toggle via --coordinator or NOTCH_COORDINATOR=1.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export { COORDINATOR_SYSTEM_PROMPT } from './prompt.js';
export {
  agentSpawnTool,
  agentSendMessageTool,
  agentStopTool,
  COORDINATOR_TOOLS,
  COORDINATOR_TOOL_NAMES,
  COORDINATOR_ALLOWED_TOOL_NAMES,
} from './tools.js';
export {
  registerAgent,
  getAgent,
  listAgents,
  clearRegistry,
  pendingCount,
  formatTaskNotification,
  awaitOneCompletion,
  injectCompletionAsUserMessage,
  pollPendingAgents,
  type AgentStatus,
  type AgentRegistryEntry,
  type DeliveredCompletion,
} from './runtime.js';
export { wrapLoopForCoordinator } from './loop-integration.js';

/** Check whether coordinator mode is requested via environment. */
export function isCoordinatorModeEnv(): boolean {
  const v = process.env.NOTCH_COORDINATOR;
  if (!v) return false;
  const lower = v.toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on';
}
