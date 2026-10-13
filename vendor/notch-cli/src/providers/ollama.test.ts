/**
 * Notch CLI — Ollama client tests
 *
 * Uses the global `fetch` mock pattern (vitest spy on globalThis.fetch)
 * so we don't need an HTTP server. Each test swaps fetch for a handler
 * and restores it afterwards.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  detectDaemon,
  listModels,
  showModel,
  pullModel,
  deleteModel,
  isCloudBaseUrl,
  isCloudModel,
  formatBytes,
  OLLAMA_LOCAL_BASE_URL,
  OLLAMA_CLOUD_BASE_URL,
} from './ollama.js';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function mockFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    return Promise.resolve(handler(url, init));
  }) as typeof fetch;
}

describe('detectDaemon', () => {
  it('returns true when /api/tags answers 200', async () => {
    mockFetch((url) => {
      expect(url).toBe(`${OLLAMA_LOCAL_BASE_URL}/api/tags`);
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });
    expect(await detectDaemon()).toBe(true);
  });

  it('returns false when fetch throws', async () => {
    globalThis.fetch = (() => Promise.reject(new Error('ECONNREFUSED'))) as typeof fetch;
    expect(await detectDaemon()).toBe(false);
  });

  it('returns false on non-2xx status', async () => {
    mockFetch(() => new Response('', { status: 503 }));
    expect(await detectDaemon()).toBe(false);
  });

  it('includes Authorization header when apiKey supplied', async () => {
    let seenAuth: string | null = null;
    mockFetch((_url, init) => {
      const headers = new Headers(init?.headers);
      seenAuth = headers.get('authorization');
      return new Response(JSON.stringify({ models: [] }), { status: 200 });
    });
    await detectDaemon(OLLAMA_CLOUD_BASE_URL, { apiKey: 'sk-test' });
    expect(seenAuth).toBe('Bearer sk-test');
  });
});

describe('listModels', () => {
  it('normalises each model entry', async () => {
    mockFetch(() => new Response(JSON.stringify({
      models: [
        { name: 'llama3.2:latest', size: 2_000_000_000, modified_at: '2026-01-01',
          details: { parameter_size: '3B', quantization_level: 'Q4_K_M' } },
        { name: 'qwen3-coder:30b' },
      ],
    }), { status: 200 }));
    const rows = await listModels();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      name: 'llama3.2:latest',
      parameterSize: '3B',
      quantization: 'Q4_K_M',
      sizeBytes: 2_000_000_000,
      modifiedAt: '2026-01-01',
    });
    expect(rows[1]?.parameterSize).toBe('—');
  });

  it('throws on non-2xx', async () => {
    mockFetch(() => new Response('nope', { status: 500 }));
    await expect(listModels()).rejects.toThrow(/500/);
  });
});

describe('showModel', () => {
  it('plucks the first .context_length key', async () => {
    mockFetch(() => new Response(JSON.stringify({
      model_info: {
        'general.architecture': 'qwen2',
        'qwen2.context_length': 32_768,
        'qwen2.block_count': 48,
      },
      details: { parameter_size: '30B', family: 'qwen2' },
    }), { status: 200 }));
    const info = await showModel('qwen3-coder:30b');
    expect(info.contextLength).toBe(32_768);
    expect(info.parameterSize).toBe('30B');
    expect(info.family).toBe('qwen2');
  });

  it('returns undefined contextLength when no matching key', async () => {
    mockFetch(() => new Response(JSON.stringify({ model_info: {} }), { status: 200 }));
    const info = await showModel('weird');
    expect(info.contextLength).toBeUndefined();
  });
});

describe('pullModel', () => {
  it('yields progress + done events from NDJSON stream', async () => {
    const frames = [
      '{"status":"pulling manifest"}',
      '{"status":"downloading","total":100,"completed":50}',
      '{"status":"success"}',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f + '\n'));
        controller.close();
      },
    });
    globalThis.fetch = (() => Promise.resolve(new Response(stream, { status: 200 }))) as typeof fetch;

    const events = [];
    for await (const ev of pullModel('llama3.2')) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual(['status', 'progress', 'done']);
    expect(events[1]).toMatchObject({ kind: 'progress', completed: 50, total: 100, percent: 50 });
  });

  it('throws when the server reports an error frame', async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"error":"manifest missing"}\n'));
        controller.close();
      },
    });
    globalThis.fetch = (() => Promise.resolve(new Response(stream, { status: 200 }))) as typeof fetch;

    const gen = pullModel('nonsense');
    await expect((async () => {
      for await (const _ of gen) { /* consume */ }
    })()).rejects.toThrow(/manifest missing/);
  });
});

describe('deleteModel', () => {
  it('returns true on 2xx', async () => {
    mockFetch((_url, init) => {
      expect(init?.method).toBe('DELETE');
      return new Response('', { status: 200 });
    });
    expect(await deleteModel('llama3.2')).toBe(true);
  });

  it('returns false on 404', async () => {
    mockFetch(() => new Response('', { status: 404 }));
    expect(await deleteModel('never-existed')).toBe(false);
  });
});

describe('helpers', () => {
  it('isCloudBaseUrl recognises ollama.com hosts', () => {
    expect(isCloudBaseUrl('https://ollama.com/v1')).toBe(true);
    expect(isCloudBaseUrl('https://api.ollama.com')).toBe(true);
    expect(isCloudBaseUrl('http://localhost:11434')).toBe(false);
    expect(isCloudBaseUrl('not a url')).toBe(false);
  });

  it('isCloudModel recognises :cloud-suffixed names', () => {
    expect(isCloudModel('kimi-k2.5:cloud')).toBe(true);
    expect(isCloudModel('gpt-oss-cloud')).toBe(true);
    expect(isCloudModel('llama3.2:latest')).toBe(false);
    expect(isCloudModel('qwen3-coder:30b')).toBe(false);
  });

  it('formatBytes pads to 8 chars and picks unit', () => {
    expect(formatBytes(0)).toBe('       —');
    expect(formatBytes(1024).trim()).toBe('1.0 KB');
    expect(formatBytes(1_536_000_000).trim()).toMatch(/GB$/);
  });
});


describe('pullModel completion integrity', () => {
  it('accepts a success record without a trailing newline', async () => {
    mockFetch(() => new Response('{"status":"success"}'));
    const events = []; for await (const event of pullModel('test')) events.push(event.kind);
    expect(events).toEqual(['done']);
  });
  it('rejects a truncated download instead of reporting success', async () => {
    mockFetch(() => new Response('{"status":"pulling manifest"}\n'));
    await expect((async () => { for await (const _ of pullModel('test')) {} })()).rejects.toThrow('before success');
  });
});
