/**
 * Notch CLI — MCP Transport Interface
 *
 * Abstraction over the communication channel to an MCP server.
 * Implementations: stdio (local), HTTP (remote), SSE (streaming remote).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export interface MCPTransport {
  /** Establish the connection. */
  connect(): Promise<void>;

  /** Tear down the connection. */
  disconnect(): void;

  /** Send a JSON-RPC request and wait for the response. */
  sendRequest(method: string, params: unknown): Promise<unknown>;

  /** Send a one-way JSON-RPC notification (no response expected). */
  sendNotification(method: string, params: unknown): void;

  /** Whether the transport is currently connected and healthy. */
  get isAlive(): boolean;
}

export interface MCPServerConfig {
  // --- stdio transport ---
  /** Command to start the server (stdio) */
  command?: string;
  /** Arguments to pass to the command (stdio) */
  args?: string[];
  /** Environment variables (all transports) */
  env?: Record<string, string>;
  /** Working directory (stdio) */
  cwd?: string;

  // --- HTTP / SSE transport ---
  /** Transport type — auto-detected if omitted */
  transport?: 'stdio' | 'http' | 'sse';
  /** Server URL (HTTP/SSE) */
  url?: string;
  /** Custom headers for authentication (HTTP/SSE) */
  headers?: Record<string, string>;
}

/**
 * Auto-detect the transport type from config.
 */
export function detectTransport(config: MCPServerConfig): 'stdio' | 'http' | 'sse' {
  if (config.transport) return config.transport;
  if (config.url) return 'http';
  return 'stdio';
}
