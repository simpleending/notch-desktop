/** Token estimates include message framing; provider counts remain the UI's source of truth. */
export function estimateTextTokens(text: string): number {
  let nonAscii = 0;
  for (const char of text) if (char.charCodeAt(0) > 127) nonAscii++;
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii);
}

export function contextBudget(window: number, overhead = 0, outputLimit?: number) {
  if (!Number.isSafeInteger(window) || window < 2048) throw new Error('Context must be at least 2,048 tokens.');
  const safety = Math.max(256, Math.ceil(window * 0.05));
  const available = window - overhead - safety;
  const output = Math.min(outputLimit ?? 4096, Math.max(512, Math.floor(window / 4)), Math.max(512, available - Math.max(512, Math.floor(window / 8))));
  const history = window - overhead - output - safety;
  if (history < 512) throw new Error('Instructions and tool definitions leave too little context. Increase the context limit or reduce project instructions.');
  return { output, history, compactAt: Math.floor(history * 0.8) };
}

/** Only hardware-validated choices may enlarge an automatic desktop context. */
export function fitContextWindow(window: number, overhead: number, outputLimit?: number, choices: number[] = []) {
  try { contextBudget(window, overhead, outputLimit); return window; }
  catch (error) {
    for (const next of [...new Set(choices)].filter(n => Number.isSafeInteger(n) && n > window).sort((a, b) => a - b)) {
      try { contextBudget(next, overhead, outputLimit); return next; } catch { /* Try the next validated choice. */ }
    }
    throw error;
  }
}
