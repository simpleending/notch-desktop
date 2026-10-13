/**
 * Notch CLI — Event system public API.
 *
 * The event router queues out-of-band notifications (git, GitHub, CI,
 * custom webhooks) outside the agent's conversation context. Severity-
 * thresholded events also land in the tail-notification queue so the
 * REPL can surface them between turns.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export {
  EventRouter,
  getGlobalRouter,
  setGlobalRouter,
  emitEvent,
  type AgentEvent,
  type EventFilter,
  type EventSeverity,
  type RouterOptions,
} from './router.js';

export {
  watchGitState,
  type GitWatchOptions,
  type GitWatchHandle,
} from './sources/git-watch.js';
