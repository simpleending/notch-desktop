/** Token estimates include message framing; provider counts remain the UI's source of truth. */
export function estimateTextTokens(text: string): number {
  const nonAscii = [...text].filter(char => char.charCodeAt(0) > 127).length;
  return Math.ceil((text.length - nonAscii) / 3 + nonAscii);
}

export function contextBudget(window: number, overhead = 0, outputLimit?: number) {
  if (!Number.isSafeInteger(window) || window < 2048) throw new Error('Context must be at least 2,048 tokens.');
  const output = Math.min(outputLimit ?? 4096, Math.max(512, Math.floor(window / 4)));
  const safety = Math.max(256, Math.ceil(window * 0.05));
  const history = window - overhead - output - safety;
  if (history < 512) throw new Error('Instructions and tool definitions leave too little context. Increase the context limit or reduce project instructions.');
  return { output, history, compactAt: Math.floor(history * 0.8) };
}
