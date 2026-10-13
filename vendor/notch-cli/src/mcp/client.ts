/**
 * Notch CLI — MCP Client (Model Context Protocol)
 *
 * Transport-agnostic MCP client that connects to external tool servers.
 * Supports stdio (local), HTTP (remote), and SSE (streaming remote) transports.
 *
 * MCP servers are configured in .notch.json:
 *   "mcpServers": {
 *     "sqlite": { "command": "mcp-server-sqlite", "args": ["--db", "data.db"] },
 *     "remote": { "url": "https://mcp.example.com", "headers": { "Authorization": "Bearer ..." } },
 *     "stream": { "transport": "sse", "url": "https://mcp.example.com" }
 *   }
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { z } from 'zod';
import type { NotchTool, ToolResult } from '../tools/types.js';
import type { MCPTransport, MCPServerConfig } from './transport.js';
import { detectTransport } from './transport.js';
import { StdioTransport } from './stdio-transport.js';
import { HttpTransport } from './http-transport.js';
import { SSETransport } from './sse-transport.js';

export type { MCPServerConfig } from './transport.js';

export interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/**
 * Create the appropriate transport based on config.
 */
function createTransport(config: MCPServerConfig, name: string): MCPTransport {
  const type = detectTransport(config);
  switch (type) {
    case 'http':
      return new HttpTransport(config, name);
    case 'sse':
      return new SSETransport(config, name);
    case 'stdio':
    default:
      return new StdioTransport(config, name);
  }
}

/**
 * MCP Client — manages connection to a single MCP server.
 */
export class MCPClient {
  private transport: MCPTransport;
  private serverName: string;
  private _tools: MCPToolDef[] = [];

  constructor(
    config: MCPServerConfig,
    serverName: string,
  ) {
    this.serverName = serverName;
    this.transport = createTransport(config, serverName);
  }

  /**
   * Start the MCP server and initialize the connection.
   */
  async connect(): Promise<void> {
    await this.transport.connect();

    // Initialize the protocol
    await this.transport.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'notch-cli', version: '0.4.8' },
    });

    // Send initialized notification
    this.transport.sendNotification('notifications/initialized', {});

    // Discover tools
    const result = await this.transport.sendRequest('tools/list', {}) as { tools: MCPToolDef[] };
    this._tools = result.tools ?? [];
  }

  /**
   * Get discovered tools from this server.
   */
  get tools(): MCPToolDef[] {
    return this._tools;
  }

  /**
   * Check if the MCP server is still alive.
   */
  get isAlive(): boolean {
    return this.transport.isAlive;
  }

  /**
   * Call a tool on the MCP server. Auto-reconnects if the server has crashed.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.isAlive) {
      try {
        await this.transport.connect();
      } catch (err: any) {
        throw new Error(`MCP server ${this.serverName} is down and could not reconnect: ${err.message}`);
      }
    }
    return this.transport.sendRequest('tools/call', { name, arguments: args });
  }

  /**
   * Disconnect from the MCP server.
   */
  disconnect(): void {
    this.transport.disconnect();
  }
}

/**
 * Convert MCP tool definitions into NotchTool instances.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mcpToolsToNotch(client: MCPClient, serverName: string): NotchTool<any>[] {
  return client.tools.map((toolDef) => {
    const params = z.record(z.unknown()).describe(
      toolDef.description || `MCP tool from ${serverName}`
    );

    const notchTool: NotchTool<typeof params> = {
      name: `mcp_${serverName}_${toolDef.name}`,
      description: `[MCP/${serverName}] ${toolDef.description}`,
      parameters: params,
      inputSchema: toolDef.inputSchema,
      async execute(args, _ctx): Promise<ToolResult> {
        try {
          const result = await client.callTool(toolDef.name, args);
          const mcpResult = result as any;
          if (mcpResult?.content && Array.isArray(mcpResult.content)) {
            const text = mcpResult.content
              .filter((c: any) => c.type === 'text')
              .map((c: any) => c.text)
              .join('\n');
            return { content: text || JSON.stringify(result) };
          }
          return { content: typeof result === 'string' ? result : JSON.stringify(result, null, 2) };
        } catch (err: any) {
          return { content: `MCP error (${serverName}/${toolDef.name}): ${err.message}`, isError: true };
        }
      },
    };

    return notchTool;
  });
}

/**
 * Load MCP server configs from .notch.json.
 * Supports stdio (command), HTTP (url), and SSE (transport: 'sse') configs.
 */
export function parseMCPConfig(config: Record<string, unknown>): Record<string, MCPServerConfig> {
  const servers = (config as any)?.mcpServers;
  if (!servers || typeof servers !== 'object') return {};

  const result: Record<string, MCPServerConfig> = {};
  for (const [name, cfg] of Object.entries(servers)) {
    const c = cfg as any;
    if (c?.command || c?.url) {
      result[name] = {
        command: c.command,
        args: c.args,
        env: c.env,
        cwd: c.cwd,
        transport: c.transport,
        url: c.url,
        headers: c.headers,
      };
    }
  }
  return result;
}
