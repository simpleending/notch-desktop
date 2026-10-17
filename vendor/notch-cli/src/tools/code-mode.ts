/**
 * Notch CLI — Code-Mode Exec/Wait Tool
 *
 * Runs JavaScript in a sandboxed node:vm context with every other notch-cli
 * tool exposed on a global `tools.*` object. Lets the model compose many
 * tool calls in a single turn without round-tripping each one through the
 * serialized tool-call protocol.
 *
 * This is a port of OpenAI Codex's code-mode exec/wait (codex-rs/code-mode)
 * from a real V8 isolate to node:vm. It is therefore a WEAKER sandbox:
 *
 *   - fetch/URL/crypto/timers are exposed (the model needs them)
 *   - infinite loops are mitigated but not strictly bounded (vm timeout +
 *     outer race; neither can interrupt a tight sync loop inside a host
 *     callback)
 *   - there is no `require`, `process`, `fs`, or module system; all
 *     filesystem access must go through the wrapped tools
 *
 * Two tools are exported:
 *
 *   code_exec  — compiles and runs a script, returns stdout + return value.
 *                If `yield_time_ms` elapses while the script is still
 *                running, status becomes "yielded" and the cell is kept
 *                alive for `code_wait` to resume.
 *
 *   code_wait  — resumes a yielded cell, optionally injecting `input` as a
 *                global. Returns the same shape as code_exec.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import vm from 'node:vm';
import { z } from 'zod';
import type { NotchTool, ToolContext, ToolResult } from './types.js';
import { buildToolMap, listToolNames } from './index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_YIELD_TIME_MS = 30_000;
const MAX_YIELD_TIME_MS = 300_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 1_000;
const CHARS_PER_TOKEN = 4;

const PRAGMA_PREFIX = '// @exec:';

// Tool names that must NOT be re-exposed inside the VM (would recurse).
const EXCLUDED_TOOLS = new Set(['code_exec', 'code_wait']);

// ---------------------------------------------------------------------------
// Cell state — persists yielded cells across exec/wait calls
// ---------------------------------------------------------------------------

interface CellState {
  id: string;
  stdout: string;
  store: Map<string, unknown>;
  /** Promise settled when the underlying script actually finishes. */
  pending: Promise<unknown> | null;
  /** Last-known status (completed / yielded / timeout / error). */
  status: 'completed' | 'yielded' | 'timeout' | 'error';
  /** Final return value (stringified) once completed. */
  returnValue?: string;
  /** Final error text once errored. */
  error?: string;
  /** Set when the script finishes so wait() can return immediately. */
  settled: boolean;
  /** Context shared between exec and subsequent wait calls. */
  context: vm.Context;
  /** Pending notifications collected since last yield. */
  notifications: string[];
  /** Resolver used by `yield_control()` to break out of the script early. */
  yieldResolver?: () => void;
  /** Outer timeout timer, cleared on resolution. */
  timeoutTimer?: NodeJS.Timeout;
}

const CELLS = new Map<string, CellState>();

function nextCellId(): string {
  return `cell_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Pragma parsing
// ---------------------------------------------------------------------------

interface ParsedSource {
  code: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

function parsePragma(input: string): ParsedSource {
  const firstNewline = input.indexOf('\n');
  if (firstNewline < 0) return { code: input };
  const firstLine = input.slice(0, firstNewline).trimStart();
  if (!firstLine.startsWith(PRAGMA_PREFIX)) return { code: input };

  const rest = input.slice(firstNewline + 1);
  const directive = firstLine.slice(PRAGMA_PREFIX.length).trim();
  if (!directive) return { code: rest };

  try {
    const parsed: unknown = JSON.parse(directive);
    if (!parsed || typeof parsed !== 'object') return { code: rest };
    const obj = parsed as Record<string, unknown>;
    const out: ParsedSource = { code: rest };
    if (typeof obj.yield_time_ms === 'number' && Number.isFinite(obj.yield_time_ms)) {
      out.yieldTimeMs = obj.yield_time_ms;
    }
    if (typeof obj.max_output_tokens === 'number' && Number.isFinite(obj.max_output_tokens)) {
      out.maxOutputTokens = obj.max_output_tokens;
    }
    return out;
  } catch {
    // Malformed pragma — ignore, treat as plain JS.
    return { code: rest };
  }
}

// ---------------------------------------------------------------------------
// Tool-name normalization (mcp__server__tool -> mcp__server__tool on tools.*)
// ---------------------------------------------------------------------------

/** Make a JS-identifier-safe name for use as `tools.<name>`. */
function toJsIdentifier(name: string): string {
  // Already-safe tool names pass through; MCP tools with slashes/dots get
  // replaced by underscores so `tools.mcp__ologs__get_profile` is valid.
  return name.replace(/[^A-Za-z0-9_]/g, '_');
}

// ---------------------------------------------------------------------------
// Context construction
// ---------------------------------------------------------------------------

interface ContextArgs {
  /** Pre-built tools map from buildToolMap(ctx). */
  realTools: Record<string, unknown>;
  /** Per-cell store map. */
  store: Map<string, unknown>;
  /** Mutable buffer that captures console output. */
  stdoutBuf: { value: string };
  /** Mutable buffer holding pending notifications. */
  notifBuf: string[];
  /** Optional pre-seeded input for code_wait. */
  input?: string;
  /** Hook invoked when script calls yield_control(). */
  onYield: () => void;
  /** Logger (ctx.log) for notify(). */
  log: (msg: string) => void;
}

function buildContext(args: ContextArgs): vm.Context {
  const { realTools, store, stdoutBuf, notifBuf, input, onYield, log } = args;

  // Wrap each tool's `execute` in an async JS-friendly function that
  // accepts a plain args object and returns the string content (or the
  // raw error text on failure).
  const wrappedTools: Record<string, (params?: Record<string, unknown>) => Promise<string>> = {};
  for (const [name, tool] of Object.entries(realTools)) {
    if (EXCLUDED_TOOLS.has(name)) continue;
    const jsName = toJsIdentifier(name);
    // The `tool()` helper from the ai SDK wraps the underlying execute.
    // @ts-expect-error - ai's tool shape exposes `execute` at runtime.
    const exec: (p: unknown) => Promise<ToolResult> = tool.execute;
    wrappedTools[jsName] = async (params?: Record<string, unknown>) => {
      try {
        const result = await exec(params ?? {});
        if (!result) return '';
        if (typeof result === 'string') return result;
        return (result as ToolResult).content ?? '';
      } catch (err: unknown) {
        return `Error: ${(err as Error).message ?? String(err)}`;
      }
    };
  }

  const captureConsole = (level: string) => (...a: unknown[]) => {
    const line = a
      .map((x) => {
        if (x === null || x === undefined) return String(x);
        if (typeof x === 'string') return x;
        try { return JSON.stringify(x); } catch { return String(x); }
      })
      .join(' ');
    stdoutBuf.value += (level === 'log' ? '' : `[${level}] `) + line + '\n';
  };

  const sandboxConsole = {
    log: captureConsole('log'),
    info: captureConsole('info'),
    warn: captureConsole('warn'),
    error: captureConsole('error'),
    debug: captureConsole('debug'),
  };

  const globals: Record<string, unknown> = {
    console: sandboxConsole,
    Buffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    // Timers
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    // Network
    fetch: globalThis.fetch,
    // WebCrypto
    crypto: globalThis.crypto,
    // Primitives that are mandatory for useful JS
    Promise,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Error,
    TypeError,
    RangeError,
    // Tool surface
    tools: wrappedTools,
    ALL_TOOLS: Object.keys(wrappedTools).map((n) => ({ name: n, description: '' })),
    // Per-cell kv
    store: (key: string, value: unknown) => { store.set(key, value); },
    load: (key: string) => store.get(key),
    // Extras
    notify: (msg: unknown) => {
      const text = typeof msg === 'string' ? msg : (() => {
        try { return JSON.stringify(msg); } catch { return String(msg); }
      })();
      notifBuf.push(text);
      log(`[code_exec notify] ${text}`);
    },
    yield_control: () => { onYield(); },
    exit: () => { throw new __CodeModeExitSignal(); },
    input,
  };

  return vm.createContext(globals, { name: 'notch-code-mode' });
}

class __CodeModeExitSignal extends Error {
  constructor() { super('__CODE_MODE_EXIT__'); this.name = '__CodeModeExitSignal'; }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

interface ExecInternalArgs {
  cellId: string;
  code: string;
  yieldTimeMs: number;
  maxChars: number;
  context: vm.Context;
  stdoutBuf: { value: string };
  notifBuf: string[];
  store: Map<string, unknown>;
  /** Hook to set the yield resolver on the cell state. */
  wireYield: (resolver: () => void) => void;
  /** Hook to capture the in-flight scriptPromise so code_wait can race it. */
  registerPending?: (p: Promise<unknown>) => void;
}

async function runScript(args: ExecInternalArgs): Promise<{
  status: 'completed' | 'yielded' | 'timeout' | 'error';
  returnValue?: string;
  error?: string;
  notExecuted?: boolean;
}> {
  const { code, yieldTimeMs, context, wireYield, registerPending } = args;

  // Wrap in async IIFE so top-level await works.
  const wrapped = `(async () => {\n${code}\n})()`;

  let script: vm.Script;
  try {
    script = new vm.Script(wrapped, { filename: 'code_exec.js' });
  } catch (err: unknown) {
    return { status: 'error', error: (err as Error).message + '\nNo JavaScript was executed. code_exec accepts JavaScript, not terminal commands. Use shell({command:"...",background:false}) for commands such as npm test or node test.mjs.', notExecuted: true };
  }

  const scriptPromise = (async () => {
    try {
      // vm `timeout` only applies to synchronous compilation/exec, so it
      // catches tight sync loops; async work is bounded by the outer race.
      const p = script.runInContext(context, { timeout: yieldTimeMs });
      return await p;
    } catch (err: unknown) {
      if (err instanceof __CodeModeExitSignal || (err as Error)?.name === '__CodeModeExitSignal') {
        return undefined;
      }
      throw err;
    }
  })();
  // Swallow unhandled rejection if nobody awaits (e.g. after timeout/yield).
  scriptPromise.catch(() => { /* handled via cell state */ });
  registerPending?.(scriptPromise);

  // Race: script completion vs. timeout vs. explicit yield_control().
  const outcome = await new Promise<
    | { kind: 'done'; value: unknown }
    | { kind: 'error'; error: Error }
    | { kind: 'timeout' }
    | { kind: 'yielded' }
  >((resolve) => {
    let settled = false;
    const finish = (o: { kind: 'done'; value: unknown } | { kind: 'error'; error: Error } | { kind: 'timeout' } | { kind: 'yielded' }) => {
      if (settled) return;
      settled = true;
      resolve(o);
    };

    wireYield(() => finish({ kind: 'yielded' }));

    const timer = setTimeout(() => finish({ kind: 'timeout' }), yieldTimeMs);

    scriptPromise
      .then((value) => { clearTimeout(timer); finish({ kind: 'done', value }); })
      .catch((error: Error) => { clearTimeout(timer); finish({ kind: 'error', error }); });
  });

  if (outcome.kind === 'done') {
    let rv: string | undefined;
    if (outcome.value !== undefined) {
      try { rv = typeof outcome.value === 'string' ? outcome.value : JSON.stringify(outcome.value); }
      catch { rv = String(outcome.value); }
    }
    return { status: 'completed', returnValue: rv };
  }
  if (outcome.kind === 'yielded') return { status: 'yielded' };
  if (outcome.kind === 'timeout') return { status: 'timeout' };
  return { status: 'error', error: outcome.error.message };
}

// ---------------------------------------------------------------------------
// Tool descriptions
// ---------------------------------------------------------------------------

export const CODE_EXEC_DESCRIPTION = `Run raw JavaScript with top-level await in node:vm. Call other tools as await tools.read({path:'file'}); names replace slashes/dots with underscores, arguments are objects, results strings. Console output is captured. Globals: tools, ALL_TOOLS ({name,description}), store(key,value), load(key), notify(message), yield_control(), exit(), input, fetch, URL, URLSearchParams, crypto, TextEncoder/Decoder, Buffer, timers. No require/process/fs/modules; filesystem access uses tools and their permissions. Not a security sandbox: fetch permits network access and synchronous loops can exceed yield_time_ms. Optional first-line // @exec: {"yield_time_ms":10000,"max_output_tokens":1000} overrides parameters; yield max300000ms, output default1000tokens. Returns cell_id/status/stdout/return_value/error. Resume yielded/timeout cells with code_wait.`;

export const CODE_WAIT_DESCRIPTION = `Resume code_exec only after yielded/timeout, using its exact cell_id. Optional additional_input becomes the input string. Returns cell_id/status/stdout/return_value/error; completed cells return the final result and are forgotten.`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampYield(ms: number | undefined): number {
  const v = ms ?? DEFAULT_YIELD_TIME_MS;
  if (!Number.isFinite(v) || v <= 0) return DEFAULT_YIELD_TIME_MS;
  return Math.min(v, MAX_YIELD_TIME_MS);
}

function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n\n[...truncated ${s.length - maxChars} chars]`;
}

function formatResult(cell: CellState, maxChars: number, extraNotifs: string[]): string {
  const lines: string[] = [];
  lines.push(`cell_id: ${cell.id}`);
  lines.push(`status: ${cell.status}`);
  if (cell.returnValue !== undefined) {
    lines.push(`return_value: ${cell.returnValue.slice(0, 2000)}`);
  }
  if (cell.error) {
    lines.push(`error: ${cell.error}`);
  }
  if (extraNotifs.length > 0) {
    lines.push(`notifications:\n${extraNotifs.map((n) => `  - ${n}`).join('\n')}`);
  }
  lines.push(`stdout:\n${truncate(cell.stdout, maxChars)}`);
  if (cell.status === 'yielded' || cell.status === 'timeout') {
    lines.push(`\n[cell still running — resume with code_wait({cell_id: "${cell.id}"})]`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// codeModeExecTool
// ---------------------------------------------------------------------------

const execParams = z.object({
  code: z.string().describe('Raw JavaScript source. May begin with `// @exec: {...}` pragma.'),
  yield_time_ms: z.number().optional().describe('Yield back to the model after this many ms. Max 300000.'),
  max_output_tokens: z.number().optional().describe('Cap stdout returned to the model. Default 1000.'),
  cell_id: z.string().optional().describe('Reuse an existing cell_id (rarely needed — exec allocates one).'),
});

export const codeModeExecTool: NotchTool<typeof execParams> = {
  name: 'code_exec',
  description: CODE_EXEC_DESCRIPTION,
  parameters: execParams,
  execute: async (params, ctx: ToolContext): Promise<ToolResult> => {
    const parsed = parsePragma(params.code);
    const yieldTimeMs = clampYield(parsed.yieldTimeMs ?? params.yield_time_ms);
    const maxTokens = parsed.maxOutputTokens ?? params.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const maxChars = Math.max(512, maxTokens * CHARS_PER_TOKEN);

    const cellId = params.cell_id ?? nextCellId();

    // Build a tool map snapshot for THIS cell. We deliberately rebuild per
    // exec so tool permissions/context are always fresh.
    const realTools = buildToolMap(ctx);

    const stdoutBuf = { value: '' };
    const notifBuf: string[] = [];
    const store = new Map<string, unknown>();

    const cell: CellState = {
      id: cellId,
      stdout: '',
      store,
      pending: null,
      status: 'error',
      settled: false,
      context: null as unknown as vm.Context,
      notifications: notifBuf,
    };

    const context = buildContext({
      realTools,
      store,
      stdoutBuf,
      notifBuf,
      onYield: () => cell.yieldResolver?.(),
      log: ctx.log,
    });
    cell.context = context;
    CELLS.set(cellId, cell);

    let outcome: Awaited<ReturnType<typeof runScript>>;
    try {
      outcome = await runScript({
        cellId,
        code: parsed.code,
        yieldTimeMs,
        maxChars,
        context,
        stdoutBuf,
        notifBuf,
        store,
        wireYield: (r) => { cell.yieldResolver = r; },
        registerPending: (p) => {
          cell.pending = p;
          // When the background script eventually settles, update cell state
          // so a later code_wait can read it. We intentionally don't await.
          p.then((value) => {
            cell.stdout = stdoutBuf.value;
            if (!cell.settled) {
              cell.status = 'completed';
              if (value !== undefined) {
                try { cell.returnValue = typeof value === 'string' ? value : JSON.stringify(value); }
                catch { cell.returnValue = String(value); }
              }
              cell.settled = true;
            }
          }).catch((err: Error) => {
            cell.stdout = stdoutBuf.value;
            if (!cell.settled) {
              cell.status = 'error';
              cell.error = err.message;
              cell.settled = true;
            }
          });
        },
      });
    } catch (err: unknown) {
      outcome = { status: 'error', error: (err as Error).message };
    }

    cell.stdout = stdoutBuf.value;
    cell.status = outcome.status;
    if (outcome.returnValue !== undefined) cell.returnValue = outcome.returnValue;
    if (outcome.error) cell.error = outcome.error;
    cell.settled = outcome.status === 'completed' || outcome.status === 'error';

    // Drop the cell if fully settled — nothing to wait on.
    if (cell.settled) CELLS.delete(cellId);

    // Swap in a fresh notif buffer on the cell so code_wait sees only NEW
    // notifications next time. Capture the current batch for this result.
    const notifsForThisCall = notifBuf.splice(0, notifBuf.length);

    return {
      content: formatResult(cell, maxChars, notifsForThisCall),
      isError: outcome.status === 'error',
      ...(outcome.notExecuted ? { notExecuted: true } : {}),
    };
  },
};

// ---------------------------------------------------------------------------
// codeModeWaitTool
// ---------------------------------------------------------------------------

const waitParams = z.object({
  cell_id: z.string().describe('The cell_id returned by code_exec.'),
  additional_input: z.string().optional().describe('Injected as the global `input` string inside the resumed script.'),
  yield_time_ms: z.number().optional(),
  max_output_tokens: z.number().optional(),
  terminate: z.boolean().optional().describe('If true, stop the cell instead of waiting for more output.'),
});

export const codeModeWaitTool: NotchTool<typeof waitParams> = {
  name: 'code_wait',
  description: CODE_WAIT_DESCRIPTION,
  parameters: waitParams,
  execute: async (params, _ctx: ToolContext): Promise<ToolResult> => {
    const cell = CELLS.get(params.cell_id);
    if (!cell) {
      return {
        content: `cell_id: ${params.cell_id}\nstatus: unknown\nerror: no running cell with that id (it may have already completed)`,
        isError: true,
      };
    }

    const maxTokens = params.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const maxChars = Math.max(512, maxTokens * CHARS_PER_TOKEN);
    const yieldTimeMs = clampYield(params.yield_time_ms);

    if (params.terminate) {
      cell.status = 'completed';
      cell.error = cell.error ?? 'terminated by code_wait';
      cell.settled = true;
      CELLS.delete(cell.id);
      const notifs = cell.notifications.splice(0, cell.notifications.length);
      return { content: formatResult(cell, maxChars, notifs) };
    }

    // Inject additional input if provided.
    if (params.additional_input !== undefined) {
      try {
        // Reassign the `input` global in the shared context.
        vm.runInContext(
          `globalThis.input = ${JSON.stringify(params.additional_input)};`,
          cell.context,
          { timeout: 1_000 },
        );
      } catch {
        // Non-critical — just continue.
      }
    }

    // If the cell already settled between exec and wait, return its final
    // state directly.
    if (cell.settled) {
      const notifs = cell.notifications.splice(0, cell.notifications.length);
      CELLS.delete(cell.id);
      return {
        content: formatResult(cell, maxChars, notifs),
        isError: cell.status === 'error',
      };
    }

    // Wait for either: the script settles, a new yield_control() fires, or
    // yield_time_ms elapses.
    const outcome = await new Promise<'done' | 'yielded' | 'timeout'>((resolve) => {
      let settled = false;
      const finish = (v: 'done' | 'yielded' | 'timeout') => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      cell.yieldResolver = () => finish('yielded');
      const timer = setTimeout(() => finish('timeout'), yieldTimeMs);
      if (cell.pending) {
        cell.pending
          .then(() => { clearTimeout(timer); finish('done'); })
          .catch(() => { clearTimeout(timer); finish('done'); });
      }
    });

    if (outcome === 'done') {
      cell.settled = true;
      CELLS.delete(cell.id);
    } else if (outcome === 'yielded') {
      cell.status = 'yielded';
    } else {
      cell.status = 'timeout';
    }

    const notifs = cell.notifications.splice(0, cell.notifications.length);
    return {
      content: formatResult(cell, maxChars, notifs),
      isError: cell.status === 'error',
    };
  },
};

// ---------------------------------------------------------------------------
// Test helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** @internal Clear all in-flight cells (used by tests). */
export function __clearCodeModeCells(): void {
  CELLS.clear();
}

/** @internal List active cell ids (used by tests). */
export function __listCodeModeCells(): string[] {
  return Array.from(CELLS.keys());
}

/** @internal List tool names currently exposed via tools.* (sanity check). */
export function __listExposedToolNames(): string[] {
  return listToolNames().filter((n) => !EXCLUDED_TOOLS.has(n)).map(toJsIdentifier);
}
