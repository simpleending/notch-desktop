import fs from 'node:fs/promises';
import path from 'node:path';
import { MCPClient, mcpToolsToNotch, type MCPToolDef } from './client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { NotchTool } from '../tools/types.js';

export interface DesktopMcpStatus { name: string; status: 'connected' | 'failed' | 'disabled'; tools: Array<{ name: string }>; error?: string }

/** Each turn owns its connections: workspace credentials and tools never leak into another chat. */
export async function connectDesktopMcp(options: {
  cwd: string; servers?: Record<string, any>; signal: AbortSignal;
  approve: (name: string, args: Record<string, unknown>, message: string) => Promise<boolean>;
  onStatus?: (rows: DesktopMcpStatus[]) => void;
}) {
  const clients: Array<{ disconnect(): Promise<void> }> = [], tools: NotchTool<any>[] = [], rows: DesktopMcpStatus[] = [];
  let closing: Promise<unknown> | undefined;
  const close = () => closing ??= Promise.allSettled(clients.splice(0).map(client => client.disconnect()));
  const abort = () => { void close(); };
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    const raw = await fs.readFile(path.join(options.cwd, '.notch.json'), 'utf8').catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return '{}'; throw error; });
    const configured = JSON.parse(raw).mcpServers ?? {};
    for (const [name, config] of Object.entries({ ...configured, ...options.servers }) as Array<[string, any]>) {
      options.signal.throwIfAborted();
      const row: DesktopMcpStatus = { name, status: 'disabled', tools: [] }; rows.push(row);
      if (config?.disabled) continue;
      let client: ReturnType<typeof protocolClient> | undefined;
      try {
        if (!/^[\w-]{1,64}$/.test(name)) throw Error('Invalid MCP server name.');
        // Workbench SDK servers are already enabled by the user; project config can launch programs.
        if (config?.type !== 'sdk' && !await options.approve('mcp_connect', { server: name, command: config.command, url: config.url }, `Connect MCP server ${name}?`)) continue;
        options.signal.throwIfAborted();
        client = protocolClient({ ...config, cwd: config.cwd ? path.resolve(options.cwd, config.cwd) : options.cwd }, options.signal);
        clients.push(client);
        await client.connect(); options.signal.throwIfAborted();
        const discovered = mcpToolsToNotch(client as unknown as MCPClient, name);
        for (let i = 0; i < discovered.length; i++) discovered[i]!.name = `mcp__${name}__${client.tools[i]!.name}`;
        tools.push(...discovered); row.status = 'connected'; row.tools = discovered.map(tool => ({ name: tool.name }));
      } catch (error) {
        await client?.disconnect(); options.signal.throwIfAborted();
        row.status = 'failed'; row.error = `Could not connect MCP server ${name}. Check its configuration and availability.`;
      }
    }
    options.onStatus?.(rows);
    return { tools, status: rows, async close() { options.signal.removeEventListener('abort', abort); await close(); } };
  } catch (error) { options.signal.removeEventListener('abort', abort); await close(); throw error; }
}

/** The maintained protocol client owns framing, sessions, redirects and cancellation. */
function protocolClient(config: any, signal: AbortSignal) {
  const client = new Client({ name: 'notch-desktop', version: '0.1.49' });
  let definitions: MCPToolDef[] = [], closed = false;
  return {
    get tools() { return definitions; }, get isAlive() { return !closed; },
    async disconnect() { closed = true; await client.close().catch(() => {}); },
    async connect() {
      let transport;
      if (config.type === 'sdk') {
        const pair = InMemoryTransport.createLinkedPair(); transport = pair[0];
        await config.instance.connect(pair[1]);
      } else if (config.url) {
        const url = new URL(config.url);
        if (!['http:', 'https:'].includes(url.protocol)) throw Error('Invalid MCP URL.');
        const options = { requestInit: { headers: config.headers } };
        transport = config.transport === 'sse' || config.type === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
      } else {
        transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: config.env, stderr: 'pipe' });
        transport.stderr?.on('data', () => {});
      }
      signal.throwIfAborted();
      await client.connect(transport, { signal, timeout: 15000 });
      let cursor: string | undefined;
      do {
        const result = await client.listTools({ cursor }, { signal, timeout: 15000 });
        definitions.push(...result.tools.map(tool => ({ ...tool, description: tool.description ?? tool.name }))); cursor = result.nextCursor;
        if (definitions.length > 1000) throw Error('MCP server returned too many tools.');
      } while (cursor);
    },
    callTool(name: string, args: Record<string, unknown>) { return client.callTool({ name, arguments: args }, undefined, { signal, timeout: 60000 }); },
  };
}
