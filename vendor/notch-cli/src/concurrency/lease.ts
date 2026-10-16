import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

async function retryFileOperation(operation: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= 100 || !['EPERM', 'EBUSY', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) throw error;
      await delay(10);
    }
  }
}
const removeTicket = (file: string) => retryFileOperation(() => fs.unlink(file)).catch(error => { if (error.code !== 'ENOENT') throw error; });

/** Cooperating CLI and IDE processes share FIFO tickets; a killed owner cannot strand the queue. */
export async function acquireLease(key: string, signal?: AbortSignal, onWait?: (waiting: boolean) => void, directory = path.join(os.homedir(), '.notch', 'coordination')): Promise<() => Promise<void>> {
  signal?.throwIfAborted();
  const folder = path.join(directory, createHash('sha256').update(key).digest('hex'));
  await fs.mkdir(folder, { recursive: true, mode: 0o700 });
  const name = `${String(Date.now()).padStart(16, '0')}-${String(process.hrtime.bigint()).padStart(24, '0')}-${process.pid}-${randomUUID()}.ticket`;
  const file = path.join(folder, name);
  await fs.writeFile(file, '', { flag: 'wx', mode: 0o600 });
  const readNumber = async (ticket: string): Promise<number | undefined> => {
    try {
      const raw = await fs.readFile(path.join(folder, ticket), 'utf8'), value = Number(raw);
      return raw && Number.isSafeInteger(value) && value > 0 ? value : undefined;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw error; }
  };
  let waiting = false, released = false;
  const release = async () => {
    if (released) return;
    released = true;
    await removeTicket(file);
    if (waiting) onWait?.(false);
  };
  try {
    // Publish "choosing" before taking a number (Lamport's bakery algorithm).
    // A ticket created late can never jump ahead of an already active owner.
    const existing = (await fs.readdir(folder)).filter(name => name.endsWith('.ticket'));
    const number = Math.max(0, ...(await Promise.all(existing.map(readNumber))).map(value => value ?? 0)) + 1;
    if (!Number.isSafeInteger(number)) throw new Error('Invalid coordination ticket; no operation was started.');
    const temporary = file + '.tmp';
    try { await fs.writeFile(temporary, String(number), { flag: 'wx', mode: 0o600 }); await retryFileOperation(() => fs.rename(temporary, file)); }
    finally { await removeTicket(temporary); }
    while (true) {
      signal?.throwIfAborted();
      const tickets = (await fs.readdir(folder)).filter(name => /^\d+-\d+-\d+-[\da-f-]+\.ticket$/.test(name)).sort();
      let blocked = false;
      for (const ticket of tickets) {
        if (ticket === name) continue;
        const pid = Number(ticket.split('-')[2]);
        let alive = true;
        try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (!alive) { await removeTicket(path.join(folder, ticket)); continue; }
        const other = await readNumber(ticket);
        if (other === undefined || (other > 0 && (other < number || (other === number && ticket < name)))) blocked = true;
      }
      if (!blocked) { if (waiting) { waiting = false; onWait?.(false); } return release; }
      if (!waiting) { waiting = true; onWait?.(true); }
      await delay(50, undefined, { signal });
    }
  } catch (error) { await release(); throw error; }
}
