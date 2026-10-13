/**
 * Notch CLI — Notch-as-MCP-Server
 *
 * Exposes the Notch tool registry over the standard stdio MCP transport
 * (newline-delimited JSON-RPC 2.0). Other agents (Claude Code, Codex, Cursor,
 * or another Notch instance) can mount notch as an MCP server and call its
 * tools remotely.
 *
 * Invoked via:   notch mcp-serve
 *
 * Protocol methods supported:
 *   - initialize             → returns serverInfo + capabilities
 *   - notifications/initialized (notif, ignored)
 *   - tools/list             → list all built-in + plugin tools
 *   - tools/call             → execute a tool and return content[]
 *   - shutdown               → graceful exit
 *   - ping                   → latency check
 *
 * Permission model:
 *   The invoking client owns approval. We run tools with requireConfirm=false
 *   and dryRun off. The client is responsible for any sandboxing — same as
 *   how Codex treats its own MCP server.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import readline from 'node:readline';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { NotchTool, ToolContext } from '../tools/types.js';

// ---------------------------------------------------------------------------
// JSON-RPC types
// ---------------------------------------------------------------------------

interface RpcRequest {
  jsonrpc: '2.0';
  id: number | string | null;
  method: string;
  params?: unknown;
}

interface RpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface RpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

const RPC_ERR = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
} as const;

// ---------------------------------------------------------------------------
// Stdio framing — newline-delimited JSON per the MCP spec.
// ---------------------------------------------------------------------------

function writeMessage(msg: RpcResponse | RpcNotification): void {
  // One JSON object per line. No Content-Length header (that's LSP-style,
  // not MCP). Stdout is machine-only in server mode — humans go to stderr.
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function logStderr(msg: string): void {
  process.stderr.write(`[notch-mcp] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Tool → MCP schema conversion
// ---------------------------------------------------------------------------

interface McpToolListEntry {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toolsToMcpList(tools: NotchTool<any>[]): McpToolListEntry[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.parameters, { target: 'openApi3' }) as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// Server entry point
// ---------------------------------------------------------------------------

interface RunMcpServerOptions {
  cwd: string;
  version: string;
  /** Expose plugins in addition to built-ins (default true) */
  includePlugins?: boolean;
  /** Expose MCP-proxied tools (default false — avoids loops) */
  includeMcpProxies?: boolean;
}

export async function runMcpServer(opts: RunMcpServerOptions): Promise<void> {
  // Lazy-import tool registry so startup of `notch mcp-serve` is fast.
  const toolsModule = await import('../tools/index.js');
  const { pluginManager } = await import('../plugins/index.js');

  // Initialize plugins so their tools are available (fire-and-forget logs to stderr).
  if (opts.includePlugins !== false) {
    try {
      await pluginManager.init(opts.cwd, (m) => logStderr(m));
    } catch (err: any) {
      logStderr(`plugin init failed: ${err.message}`);
    }
  }

  const getTools = () => toolsModule.listToolNames()
    .map((name) => ({ name, desc: toolsModule.describeTools() }))
    .filter(() => true);

  // We need the actual NotchTool objects, not just names. Import the internal
  // registry functions via a side-channel: buildToolMap gives us AI-SDK wrapped
  // tools, but tools/index doesn't export the raw list. We re-import each
  // tool file here to build our own list. This keeps the server authoritative
  // about which tools it exposes and avoids double-wrapping by buildToolMap.
  const { readTool } = await import('../tools/read.js');
  const { writeTool } = await import('../tools/write.js');
  const { editTool } = await import('../tools/edit.js');
  const { applyPatchTool } = await import('../tools/apply-patch.js');
  const { shellTool } = await import('../tools/shell.js');
  const { gitTool } = await import('../tools/git.js');
  const { githubTool } = await import('../tools/github.js');
  const { grepTool } = await import('../tools/grep.js');
  const { globTool } = await import('../tools/glob.js');
  const { webFetchTool } = await import('../tools/web-fetch.js');
  const { lspTool } = await import('../tools/lsp.js');
  const { notebookTool } = await import('../tools/notebook.js');
  const { taskTool } = await import('../tools/task.js');

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const exposed: NotchTool<any>[] = [
    readTool, writeTool, editTool, applyPatchTool, shellTool, gitTool, githubTool,
    grepTool, globTool, webFetchTool, lspTool, notebookTool, taskTool,
  ];
  if (opts.includePlugins !== false) {
    exposed.push(...pluginManager.getTools());
  }

  const toolByName = new Map(exposed.map((t) => [t.name, t]));
  const mcpTools = toolsToMcpList(exposed);

  // MCP clients need a permissive ToolContext. The *caller* (upstream MCP
  // client) is responsible for user approvals; requireConfirm=false here.
  const toolCtx: ToolContext = {
    cwd: opts.cwd,
    requireConfirm: false,
    confirm: async () => true,
    log: (m) => logStderr(m),
  };

  let initialized = false;
  logStderr(`ready — ${exposed.length} tools on stdio (version ${opts.version})`);
  // Suppress unused-warning for getTools — kept for potential future use in logs.
  void getTools;

  // Parse requests line-by-line — spec-compliant stdio transport.
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let req: RpcRequest;
    try {
      req = JSON.parse(trimmed);
    } catch (err: any) {
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: { code: RPC_ERR.PARSE_ERROR, message: `parse error: ${err.message}` },
      });
      return;
    }

    // Notification (no id) — handle side-effects only
    if (req.id === undefined || req.id === null) {
      if (req.method === 'notifications/initialized') {
        initialized = true;
      } else if (req.method === 'notifications/cancelled') {
        // Ignore — no long-running cancellation support yet
      } else {
        logStderr(`ignored notification: ${req.method}`);
      }
      return;
    }

    const reply = (result: unknown) => writeMessage({ jsonrpc: '2.0', id: req.id, result });
    const fail = (code: number, message: string, data?: unknown) =>
      writeMessage({ jsonrpc: '2.0', id: req.id, error: { code, message, data } });

    try {
      switch (req.method) {
        case 'initialize': {
          reply({
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: { listChanged: false },
            },
            serverInfo: {
              name: 'notch-cli',
              version: opts.version,
            },
            instructions:
              'Notch CLI exposes its code-editing tool registry over MCP. ' +
              'Prefer apply_patch for multi-file edits and edit for surgical single-line changes. ' +
              'The caller is responsible for approval and sandboxing.',
          });
          break;
        }

        case 'ping': {
          reply({});
          break;
        }

        case 'tools/list': {
          reply({ tools: mcpTools });
          break;
        }

        case 'tools/call': {
          const params = req.params as { name?: string; arguments?: Record<string, unknown> };
          if (!params?.name) {
            fail(RPC_ERR.INVALID_PARAMS, '"name" is required');
            break;
          }
          const tool = toolByName.get(params.name);
          if (!tool) {
            fail(RPC_ERR.METHOD_NOT_FOUND, `tool not found: ${params.name}`);
            break;
          }
          if (!initialized) {
            logStderr(`tools/call before initialized notification — proceeding anyway`);
          }
          try {
            const parseResult = tool.parameters.safeParse(params.arguments ?? {});
            if (!parseResult.success) {
              reply({
                content: [{ type: 'text', text: `Invalid arguments: ${parseResult.error.message}` }],
                isError: true,
              });
              break;
            }
            const result = await tool.execute(parseResult.data, toolCtx);
            reply({
              content: [{ type: 'text', text: result.content }],
              isError: result.isError ?? false,
            });
          } catch (err: any) {
            reply({
              content: [{ type: 'text', text: `Tool error: ${err.message}` }],
              isError: true,
            });
          }
          break;
        }

        case 'shutdown': {
          reply({});
          // Give the reply time to flush, then exit.
          setTimeout(() => process.exit(0), 50);
          break;
        }

        default:
          fail(RPC_ERR.METHOD_NOT_FOUND, `method not found: ${req.method}`);
      }
    } catch (err: any) {
      fail(RPC_ERR.INTERNAL_ERROR, `internal error: ${err.message}`);
    }
  });

  rl.on('close', () => {
    logStderr('stdin closed, exiting');
    process.exit(0);
  });

  // Keep process alive
  await new Promise<void>(() => { /* never resolves */ });
}
