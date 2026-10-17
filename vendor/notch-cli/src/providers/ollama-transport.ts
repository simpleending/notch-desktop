import { randomUUID } from 'node:crypto';
import { ollamaRoot } from './ollama-url.js';

/** Native Ollama supports per-request context; the OpenAI shim uses daemon defaults. */
export function ollamaContextLength(fallback?: number, nativeLimit?: number): number {
  const value = Number(process.env.NOTCH_OLLAMA_CONTEXT || fallback || 8192);
  if (!Number.isInteger(value) || value < 2048 || value > 262144) {
    throw new Error('NOTCH_OLLAMA_CONTEXT must be an integer between 2048 and 262144.');
  }
  return Number.isSafeInteger(nativeLimit) && nativeLimit! >= 2048 ? Math.min(value, nativeLimit!) : value;
}

export function ollamaBatchSize(fallback?: number): number | undefined {
  const raw = process.env.NOTCH_OLLAMA_BATCH;
  // 64 can prevent the tested Gemma 12B projector from loading even for text.
  const value = Number(raw || (fallback ?? 128));
  if (!Number.isInteger(value) || value < 1 || value > 2048) {
    throw new Error('NOTCH_OLLAMA_BATCH must be an integer between 1 and 2048.');
  }
  return value;
}

interface Call { id?: string; function: { name: string; arguments: string | Record<string, unknown> } }
interface Message {
  role: string;
  content?: string | null | { type: string; text?: string; image_url?: { url: string } }[];
  tool_calls?: Call[];
  tool_call_id?: string;
}
interface Frame {
  message?: { content?: string; thinking?: string; tool_calls?: Call[] };
  done?: boolean; done_reason?: string;
  prompt_eval_count?: number; eval_count?: number; error?: string;
}

/** Adapt SDK messages to native /api/chat and NDJSON to SSE, preserving backpressure and cancellation. */
export function ollamaFetch(baseUrl: string, options: { contextWindow?: number; nativeContextWindow?: number; ollamaBatch?: number } = {}): typeof fetch {
  // The OpenAI chat adapter omits thinking; Ollama needs it between tool calls.
  const thoughts = new Map<string, string>();
  return async (_input, init) => {
    const body = JSON.parse(String(init?.body));
    let lastUser = body.messages.length - 1;
    while (lastUser >= 0 && body.messages[lastUser].role !== 'user') lastUser--;
    const activeCalls = new Set<string>((body.messages as Message[]).slice(lastUser + 1).flatMap(message => (message.tool_calls ?? []).flatMap(call => call.id ? [call.id] : [])));
    const names = new Map<string, string>();
    const messages = (body.messages as Message[]).map(message => {
      for (const call of message.tool_calls ?? []) if (call.id) names.set(call.id, call.function.name);
      const images: string[] = [];
      const content = Array.isArray(message.content) ? message.content.map(part => {
        if (part.type === 'image_url') {
          const match = /^data:image\/[^;]+;base64,(.+)$/.exec(part.image_url?.url || '');
          if (!match) throw new Error('Ollama images must be local files or base64 data URLs.');
          images.push(match[1]!);
        }
        return part.text || '';
      }).join('\n') : message.content || '';
      const toolThought = message.tool_calls?.map(call => call.id && activeCalls.has(call.id) && thoughts.get(call.id)).find(Boolean);
      return {
        role: message.role, content,
        ...(toolThought ? { thinking: toolThought } : {}),
        ...(images.length ? { images } : {}),
        ...(message.tool_call_id ? { tool_name: names.get(message.tool_call_id) } : {}),
        ...(message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ function: {
          name: call.function.name,
          arguments: typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments) : call.function.arguments,
        } })) } : {}),
      };
    });
    const response = await fetch(`${ollamaRoot(baseUrl)}/api/chat`, {
      ...init,
      body: JSON.stringify({
        model: body.model, messages, stream: body.stream === true,
        ...(body.tools?.length ? { tools: body.tools } : {}),
        ...(body.response_format ? { format: body.response_format.json_schema?.schema || 'json' } : {}),
        ...(['0', '1'].includes(process.env.NOTCH_OLLAMA_THINK || '') ? { think: process.env.NOTCH_OLLAMA_THINK === '1' } : {}),
        options: { num_ctx: ollamaContextLength(options.contextWindow, options.nativeContextWindow),
          ...(body.temperature === undefined ? {} : { temperature: body.temperature }),
          ...(ollamaBatchSize(options.ollamaBatch) === undefined ? {} : { num_batch: ollamaBatchSize(options.ollamaBatch) }),
          ...(body.max_tokens ? { num_predict: body.max_tokens } : {}),
          ...(body.stop ? { stop: body.stop } : {}) },
      }),
    });
    if (!response.ok) {
      const detail = await response.text();
      return Response.json({ error: { message: `Ollama HTTP ${response.status}: ${detail.slice(0, 600)}`, type: 'ollama_error' } }, { status: response.status });
    }
    let toolIndex = 0;
    let sawTools = false;
    let thinking = '';
    const responseCalls: string[] = [];
    const convert = (frame: Frame) => {
      if (frame.error) throw new Error(`Ollama: ${frame.error}`);
      thinking += frame.message?.thinking || '';
      const calls = frame.message?.tool_calls?.map(call => ({
        index: toolIndex++, id: call.id || `call_${randomUUID()}`, type: 'function',
        function: { name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function.arguments) },
      }));
      if (calls?.length) sawTools = true;
      if (calls) responseCalls.push(...calls.map(call => call.id));
      if (frame.done && thinking) for (const id of responseCalls) thoughts.set(id, thinking);
      // Summary requests share this adapter; keep recent chains without growing indefinitely.
      while (thoughts.size > 128) thoughts.delete(thoughts.keys().next().value!);
      return {
        choices: [{ index: 0, [body.stream ? 'delta' : 'message']: {
          role: 'assistant', content: frame.message?.content || '', ...(calls?.length ? { tool_calls: calls } : {}),
        }, finish_reason: frame.done ? (sawTools ? 'tool_calls' : frame.done_reason === 'length' ? 'length' : 'stop') : null }],
        ...(frame.done ? { usage: { prompt_tokens: frame.prompt_eval_count || 0, completion_tokens: frame.eval_count || 0 } } : {}),
      };
    };
    if (!body.stream) return Response.json(convert(await response.json()));
    if (!response.body) throw new Error('Ollama returned an empty response stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let buffer = '';
    let finished = false;
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          let emitted = false;
          while (!emitted) {
            const { value, done } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = done ? '' : lines.pop()!;
            for (const line of lines) {
              if (!line.trim()) continue;
              const frame: Frame = JSON.parse(line);
              controller.enqueue(encoder.encode(`data: ${JSON.stringify(convert(frame))}\n\n`));
              emitted = true;
              if (frame.done) finished = true;
            }
            if (done || finished) {
              if (!finished) throw new Error('Ollama stream ended before completion.');
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
              await reader.cancel();
              return;
            }
          }
        } catch (error) { controller.error(error); await reader.cancel().catch(() => {}); }
      },
      async cancel(reason) { await reader.cancel(reason); },
    });
    return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
  };
}
