// vendor/notch-cli/src/concurrency/lease.ts
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createHash, randomUUID } from "crypto";
import { setTimeout as delay } from "timers/promises";
async function retryFileOperation(operation) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= 100 || !["EPERM", "EBUSY", "EACCES"].includes(error.code || "")) throw error;
      await delay(10);
    }
  }
}
var removeTicket = (file) => retryFileOperation(() => fs.unlink(file)).catch((error) => {
  if (error.code !== "ENOENT") throw error;
});
async function acquireLease(key, signal, onWait, directory = path.join(os.homedir(), ".notch", "coordination")) {
  signal?.throwIfAborted();
  const folder = path.join(directory, createHash("sha256").update(key).digest("hex"));
  await fs.mkdir(folder, { recursive: true, mode: 448 });
  const name = `${String(Date.now()).padStart(16, "0")}-${String(process.hrtime.bigint()).padStart(24, "0")}-${process.pid}-${randomUUID()}.ticket`;
  const file = path.join(folder, name);
  await fs.writeFile(file, "", { flag: "wx", mode: 384 });
  const readNumber = async (ticket) => {
    try {
      const raw = await retryFileOperation(() => fs.readFile(path.join(folder, ticket), "utf8")), value = Number(raw);
      return raw && Number.isSafeInteger(value) && value > 0 ? value : void 0;
    } catch (error) {
      if (error.code === "ENOENT") return 0;
      throw error;
    }
  };
  let waiting = false, released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await removeTicket(file);
    if (waiting) onWait?.(false);
  };
  try {
    const existing = (await fs.readdir(folder)).filter((name2) => name2.endsWith(".ticket"));
    const number = Math.max(0, ...(await Promise.all(existing.map(readNumber))).map((value) => value ?? 0)) + 1;
    if (!Number.isSafeInteger(number)) throw new Error("Invalid coordination ticket; no operation was started.");
    const temporary = file + ".tmp";
    try {
      await fs.writeFile(temporary, String(number), { flag: "wx", mode: 384 });
      await retryFileOperation(() => fs.rename(temporary, file));
    } finally {
      await removeTicket(temporary);
    }
    while (true) {
      signal?.throwIfAborted();
      const tickets = (await fs.readdir(folder)).filter((name2) => /^\d+-\d+-\d+-[\da-f-]+\.ticket$/.test(name2)).sort();
      let blocked = false;
      for (const ticket of tickets) {
        if (ticket === name) continue;
        const pid = Number(ticket.split("-")[2]);
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error.code === "ESRCH") alive = false;
        }
        if (!alive) {
          await removeTicket(path.join(folder, ticket));
          continue;
        }
        const other = await readNumber(ticket);
        if (other === void 0 || other > 0 && (other < number || other === number && ticket < name)) blocked = true;
      }
      if (!blocked) {
        if (waiting) {
          waiting = false;
          onWait?.(false);
        }
        return release;
      }
      if (!waiting) {
        waiting = true;
        onWait?.(true);
      }
      await delay(50, void 0, { signal });
    }
  } catch (error) {
    await release();
    throw error;
  }
}

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
      const response = await ownership.run(true, () => fetcher(input, init));
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
  acquireLease,
  executionContext,
  withLocalInference,
  queuedLocalFetch
};
