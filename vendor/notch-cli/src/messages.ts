import { modelMessageSchema, type ModelMessage, type ToolResultPart } from 'ai';

export function toolOutput(value: unknown): ToolResultPart['output'] {
  return { type: 'json', value: JSON.parse(JSON.stringify(value ?? null)) };
}

export function toolResultValue(part: { output?: unknown; result?: unknown }): unknown {
  const output = part.output as { type?: string; value?: unknown; reason?: string } | undefined;
  if (!output) return part.result;
  return output.type === 'execution-denied' ? output.reason : output.value;
}

/** Existing sessions must remain resumable across the SDK message-format change. */
export function normalizeMessages(messages: unknown): ModelMessage[] {
  if (!Array.isArray(messages)) throw new Error('Session messages must be an array.');
  return messages.map(message => {
    const content = Array.isArray(message.content) ? message.content.map((part: Record<string, unknown>) => {
      const normalized = { ...part };
      if (part.type === 'tool-call' && !('input' in part) && 'args' in part) {
        normalized.input = part.args; delete normalized.args;
      }
      if (part.type === 'tool-result' && !('output' in part) && 'result' in part) {
        normalized.output = toolOutput(part.result); delete normalized.result;
      }
      if (part.type === 'image' && part.mimeType && !part.mediaType) {
        normalized.mediaType = part.mimeType; delete normalized.mimeType;
      }
      return normalized;
    }) : message.content;
    return modelMessageSchema.parse({ ...message, content });
  });
}
