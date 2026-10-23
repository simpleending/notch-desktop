import {
  acquireLease
} from "./chunk-SWZ3JTKY.js";

// vendor/notch-cli/src/concurrency/local-inference.ts
import { AsyncLocalStorage } from "async_hooks";
var executionContext = new AsyncLocalStorage();
var ownership = new AsyncLocalStorage();
async function withLocalInference(operation, signal) {
  if (ownership.getStore()) return operation();
  const notify = executionContext.getStore()?.onQueue;
  const release = await acquireLease("local-inference", signal, (waiting) => notify?.(waiting ? "Waiting for local model\u2026" : null));
  try {
    return await ownership.run(true, operation);
  } finally {
    await release();
  }
}
function queuedLocalFetch(fetcher) {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : void 0) ?? void 0;
    const notify = executionContext.getStore()?.onQueue;
    const release = await acquireLease("local-inference", signal, (waiting) => notify?.(waiting ? "Waiting for local model\u2026" : null));
    let reader;
    const finish = async () => {
      signal?.removeEventListener("abort", abort);
      await release();
    };
    const abort = () => {
      void (reader?.cancel(signal?.reason) ?? Promise.resolve()).catch(() => {
      }).finally(finish);
    };
    try {
      signal?.throwIfAborted();
      const response = await ownership.run(true, async () => {
        await executionContext.getStore()?.prepareLocalModel?.();
        return fetcher(input, init);
      });
      if (!response.body) {
        await finish();
        return response;
      }
      reader = response.body.getReader();
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        await reader.cancel(signal.reason);
        signal.throwIfAborted();
      }
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const result = await reader.read();
            if (result.done) {
              controller.close();
              await finish();
            } else controller.enqueue(result.value);
          } catch (error) {
            controller.error(error);
            await reader.cancel().catch(() => {
            });
            await finish();
          }
        },
        async cancel(reason) {
          try {
            await reader.cancel(reason);
          } finally {
            await finish();
          }
        }
      }, { highWaterMark: 0 });
      return new Response(stream, { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch (error) {
      await finish();
      throw error;
    }
  };
}

export {
  executionContext,
  withLocalInference,
  queuedLocalFetch
};
