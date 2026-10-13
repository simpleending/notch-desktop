/**
 * Notch CLI — Coordinator Loop Integration
 *
 * Thin wrapper that takes the existing runAgentLoop function and, when
 * coordinator mode is enabled, replaces the system prompt with the
 * COORDINATOR_SYSTEM_PROMPT and tags the tool context with coordinatorMode=true
 * so buildToolMap filters down to the coordinator's allowed set.
 *
 * When coordinator mode is disabled this is a pass-through — the returned
 * function is bytewise the original runAgentLoop.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { runAgentLoop as RunAgentLoop } from '../agent/loop.js';
import { COORDINATOR_SYSTEM_PROMPT } from './prompt.js';

/**
 * Wrap runAgentLoop so the top-level agent runs as a coordinator. When
 * `enabled` is false the original function is returned unchanged.
 */
export function wrapLoopForCoordinator(
  originalRunAgentLoop: typeof RunAgentLoop,
  enabled: boolean,
): typeof RunAgentLoop {
  if (!enabled) return originalRunAgentLoop;

  const wrapped: typeof RunAgentLoop = (messages, config) => {
    return originalRunAgentLoop(messages, {
      ...config,
      systemPrompt: COORDINATOR_SYSTEM_PROMPT,
      toolContext: {
        ...config.toolContext,
        coordinatorMode: true,
      },
    });
  };

  return wrapped;
}
