import { tool, type ToolSet, type ToolCallRepairFunction } from 'ai';
import { z } from 'zod';

/** Validation feedback is a tool result, not a reason to replay prior actions. */
export function toolValidationFeedback(tools: ToolSet) {
  if (Object.keys(tools).length === 0) return { tools, repair: undefined };
  const name = 'notch_tool_error';
  const withFeedback: ToolSet = { ...tools, [name]: tool({
    description: 'Report an invalid tool request without executing it. Use the error to correct the next request.',
    inputSchema: z.object({ toolName: z.string(), arguments: z.string(), error: z.string() }),
    execute: async params => ({ content: `Tool ${params.toolName} was NOT executed. ${params.error}\nCorrect the arguments and call the intended tool again.`, isError: true }),
  }) };
  const repair: ToolCallRepairFunction<ToolSet> = async ({ toolCall, error }) => ({
    ...toolCall, toolName: name,
    input: JSON.stringify({ toolName: toolCall.toolName, arguments: toolCall.input, error: error.message.slice(0, 4000) }),
  });
  return { tools: withFeedback, repair };
}

/** Some providers discard malformed JSON before the SDK repair hook can see it. */
export function missingToolCallFeedback(finishReason: string, callCount: number): string | null {
  return finishReason === 'tool-calls' && callCount === 0
    ? 'Your previous response requested tool execution, but no valid tool call could be parsed. No tool was executed in that response. Retry with a valid native tool name and complete JSON arguments matching its schema.'
    : null;
}
