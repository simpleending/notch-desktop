import { toolOutput } from '../messages.js';
/**
 * Notch CLI — Hybrid router tests
 *
 * Pure unit tests — no live LLM calls. We exercise `classifyResponse`
 * and `detectRepeatedError` with handcrafted AgentResponse / message
 * fixtures. `bindHybridLoop`'s full flow is covered by stubbing
 * `runAgentLoop` via vi.spyOn on the module object.
 */

import { describe, it, expect, vi } from 'vitest';
import { runAgentLoop } from './loop.js';
import type { ModelMessage } from 'ai';
import type { AgentResponse } from './loop.js';
import { bindHybridLoop, classifyResponse, detectRepeatedError } from './hybrid-router.js';
vi.mock('./loop.js',()=>({runAgentLoop:vi.fn()}));

function makeResponse(partial: Partial<AgentResponse>): AgentResponse {
  return {
    text: '',
    messages: [],
    iterations: 1,
    toolCallCount: 0,
    compressed: false,
    correctionAttempts: 0,
    ...partial,
  };
}

it('continues fallback from completed actions and accounts for both models',async()=>{
  const history:ModelMessage[]=[{role:'user',content:'Fix file'},{role:'assistant',content:'File edited; I cannot complete the tests'}];
  const run=vi.mocked(runAgentLoop);
  run.mockResolvedValueOnce(makeResponse({text:'I cannot complete the tests',messages:history,toolCallCount:1,usage:{promptTokens:10,completionTokens:2,totalTokens:12}}));
  run.mockResolvedValueOnce(makeResponse({text:'Tests pass',messages:history,toolCallCount:2,usage:{promptTokens:20,completionTokens:3,totalTokens:23}}));
  const routed=bindHybridLoop({enabled:true,primary:()=> 'fixture',fallback:()=> 'fixture'});
  const result=await routed([history[0]!],{model:'fixture',systemPrompt:'fixture',toolContext:{cwd:process.cwd(),requireConfirm:false,confirm:async()=>true,log:()=>{}}});
  expect(run.mock.calls.at(-1)?.[0].slice(0,history.length)).toEqual(history);
  expect(result.toolCallCount).toBe(3);
  expect(result.usage).toEqual({promptTokens:30,completionTokens:5,totalTokens:35});
});

describe('classifyResponse', () => {
  it('flags empty response with no tool calls', () => {
    const reason = classifyResponse(makeResponse({ text: '', toolCallCount: 0 }), { maxIterations: 25 });
    expect(reason).toBe('empty-response');
  });

  it('does NOT flag non-empty response', () => {
    const reason = classifyResponse(makeResponse({ text: 'here is a solution' }), { maxIterations: 25 });
    expect(reason).toBeNull();
  });

  it('flags iteration cap hit while tools are still running', () => {
    const reason = classifyResponse(
      makeResponse({ text: 'partial answer', iterations: 25, toolCallCount: 30 }),
      { maxIterations: 25 },
    );
    expect(reason).toBe('iteration-exhausted');
  });

  it('does NOT flag iteration cap when no tool calls were needed', () => {
    const reason = classifyResponse(
      makeResponse({ text: 'done', iterations: 25, toolCallCount: 0 }),
      { maxIterations: 25 },
    );
    expect(reason).toBeNull();
  });

  it('detects "I cannot help" phrasing', () => {
    const reason = classifyResponse(
      makeResponse({ text: "I'm unable to help with this task because..." }),
      { maxIterations: 25 },
    );
    expect(reason).toBe('give-up-phrase');
  });

  it('detects "I apologize but I cannot" phrasing', () => {
    const reason = classifyResponse(
      makeResponse({ text: 'I apologize, but I cannot execute shell commands.' }),
      { maxIterations: 25 },
    );
    expect(reason).toBe('give-up-phrase');
  });

  it('detects "as an AI language model" phrasing', () => {
    const reason = classifyResponse(
      makeResponse({ text: 'As an AI language model, I do not have the ability to run code.' }),
      { maxIterations: 25 },
    );
    expect(reason).toBe('give-up-phrase');
  });

  it('ignores legitimate code containing the word "cannot"', () => {
    const text = 'Here is the fix:\n```\nif (user) { return "cannot be null"; }\n```';
    const reason = classifyResponse(makeResponse({ text }), { maxIterations: 25 });
    expect(reason).toBeNull();
  });
});

describe('detectRepeatedError', () => {
  it('fires on three identical tool-error messages', () => {
    const errorMessage = 'Permission denied: /etc/passwd';
    const history: ModelMessage[] = [
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'read', output: toolOutput(errorMessage) }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'b', toolName: 'read', output: toolOutput(errorMessage) }],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'read', output: toolOutput(errorMessage) }],
      },
    ];
    expect(detectRepeatedError(history)).toBe(true);
  });

  it('ignores successful tool results', () => {
    const history: ModelMessage[] = [
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'read', output: toolOutput('file contents') }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'b', toolName: 'read', output: toolOutput('more contents') }] },
    ];
    expect(detectRepeatedError(history)).toBe(false);
  });

  it('does not fire when three errors are non-identical', () => {
    const history: ModelMessage[] = [
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'read', output: toolOutput('Error: file not found') }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'b', toolName: 'shell', output: toolOutput('Error: permission denied') }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c', toolName: 'write', output: toolOutput('Error: disk full') }] },
    ];
    expect(detectRepeatedError(history)).toBe(false);
  });

  it('needs at least three error signatures to fire', () => {
    const errorMessage = 'Error: denied';
    const history: ModelMessage[] = [
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'a', toolName: 'read', output: toolOutput(errorMessage) }] },
      { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'b', toolName: 'read', output: toolOutput(errorMessage) }] },
    ];
    expect(detectRepeatedError(history)).toBe(false);
  });
});
