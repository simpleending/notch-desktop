/**
 * Notch CLI — Retry with Exponential Backoff
 *
 * Wraps async operations with automatic retry logic for
 * transient failures (network errors, rate limits, 5xx).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export interface RetryOptions {
  signal?: AbortSignal;
  /** Maximum number of attempts (default 3) */
  maxAttempts?: number;
  /** Base delay in ms (default 1000) */
  baseDelay?: number;
  /** Maximum delay in ms (default 30000) */
  maxDelay?: number;
  /** Multiplier for exponential backoff (default 2) */
  factor?: number;
  /** Add random jitter (default true) */
  jitter?: boolean;
  /** Callback when a retry happens */
  onRetry?: (attempt: number, error: Error, nextDelay: number) => void;
  /** Custom function to decide if an error is retryable (default: network + 429 + 5xx) */
  isRetryable?: (error: Error) => boolean;
}

const DEFAULT_RETRYABLE = (err: Error): boolean => {
  if ((err as Error & { retryable?: boolean }).retryable === false) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  const msg = err.message.toLowerCase();
  if (/out of memory|insufficient memory|context.*(?:exceed|limit)|invalid.*(?:context|argument)/.test(msg)) return false;
  const status = (err as Error & { statusCode?: number; status?: number }).statusCode ?? (err as Error & { status?: number }).status;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500 && status <= 599;
  // Network errors
  if (msg.includes('fetch') || msg.includes('econnrefused') || msg.includes('econnreset') ||
      msg.includes('etimedout') || msg.includes('network') || msg.includes('socket')) {
    return true;
  }
  // Rate limits
  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('too many requests')) {
    return true;
  }
  // Server errors (5xx)
  if (/\b5\d{2}\b/.test(msg)) {
    return true;
  }
  return false;
};

/**
 * Execute an async function with exponential backoff retry.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const maxAttempts = options.maxAttempts ?? 3;
  const baseDelay = options.baseDelay ?? 1000;
  const maxDelay = options.maxDelay ?? 30_000;
  const factor = options.factor ?? 2;
  const jitter = options.jitter ?? true;
  const isRetryable = options.isRetryable ?? DEFAULT_RETRYABLE;

  let lastError: Error | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    options.signal?.throwIfAborted();
    try {
      return await fn();
    } catch (err: any) {
      options.signal?.throwIfAborted();
      lastError = err;

      if (attempt === maxAttempts || !isRetryable(err)) {
        throw err;
      }

      // Calculate delay with exponential backoff
      let delay = Math.min(baseDelay * Math.pow(factor, attempt - 1), maxDelay);

      // Add jitter (0-50% of delay)
      if (jitter) {
        delay += Math.random() * delay * 0.5;
      }

      options.onRetry?.(attempt, err, delay);

      await sleep(delay, options.signal);
    }
  }

  throw lastError;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/**
 * Extract retry-after header value from an error, if present.
 * Returns delay in ms, or null if not found.
 */
export function parseRetryAfter(err: Error): number | null {
  const msg = err.message;
  const match = msg.match(/retry[- ]after:\s*(\d+)/i);
  if (match) {
    return parseInt(match[1]!, 10) * 1000;
  }
  return null;
}
