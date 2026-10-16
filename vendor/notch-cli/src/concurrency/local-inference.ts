import { AsyncLocalStorage } from 'node:async_hooks';
import { acquireLease } from './lease.js';
import type { ToolContext } from '../tools/types.js';

export const executionContext = new AsyncLocalStorage<ToolContext>();
const ownership = new AsyncLocalStorage<boolean>();
export async function withLocalInference<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (ownership.getStore()) return operation();
  const notify = executionContext.getStore()?.onQueue;
  const release = await acquireLease('local-inference', signal, waiting => notify?.(waiting ? 'Waiting for local model…' : null));
  try { return await ownership.run(true, operation); } finally { await release(); }
}

/** Release between generations so a parent can await worker tools or approval without deadlocking. */
export function queuedLocalFetch(fetcher: typeof fetch): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
    const notify = executionContext.getStore()?.onQueue;
    const release = await acquireLease('local-inference', signal, waiting => notify?.(waiting ? 'Waiting for local model…' : null));
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const finish = async () => { signal?.removeEventListener('abort', abort); await release(); };
    const abort = () => { void (reader?.cancel(signal?.reason) ?? Promise.resolve()).catch(() => {}).finally(finish); };
    try {
      signal?.throwIfAborted();
      const response = await ownership.run(true, () => fetcher(input, init));
      if (!response.body) { await finish(); return response; }
      reader = response.body.getReader();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { await reader.cancel(signal.reason); signal.throwIfAborted(); }
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const result = await reader!.read();
            if (result.done) { controller.close(); await finish(); }
            else controller.enqueue(result.value);
          } catch (error) { controller.error(error); await reader!.cancel().catch(() => {}); await finish(); }
        },
        async cancel(reason) { try { await reader!.cancel(reason); } finally { await finish(); } },
      }, { highWaterMark: 0 });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) { await finish(); throw error; }
  };
}
