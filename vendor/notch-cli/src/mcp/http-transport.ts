/**
 * Notch CLI — MCP HTTP Transport
 *
 * Communicates with a remote MCP server over HTTP POST requests.
 * Each JSON-RPC request is a separate HTTP request.
 * Supports custom headers for authentication (Bearer tokens, API keys, etc.).
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { MCPTransport, MCPServerConfig } from './transport.js';

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown;
}

interface JSONRPCResponse {
  jsonrpc: '2.0';
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class HttpTransport implements MCPTransport {
  private requestId = 0;
  private connected = false;
  private name: string;
  private baseUrl: string;
  private headers: Record<string, string>;

  constructor(config: MCPServerConfig, name: string) {
    this.name = name;
    if (!config.url) {
      throw new Error(`HTTP transport requires 'url' in config for server ${name}`);
    }
    this.baseUrl = config.url.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
  }

  async connect(): Promise<void> {
    // Verify the server is reachable with a health check or initialize
    try {
      const response = await fetch(`${this.baseUrl}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: ++this.requestId,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'notch-cli', version: '0.4.8' },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      // Send initialized notification
      this.sendNotification('notifications/initialized', {});
      this.connected = true;
    } catch (err: any) {
      throw new Error(`MCP HTTP server ${this.name} unreachable: ${err.message}`);
    }
  }

  disconnect(): void {
    this.connected = false;
  }

  get isAlive(): boolean {
    return this.connected;
  }

  async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    const body: JSONRPCRequest = { jsonrpc: '2.0', id, method, params };

    const response = await fetch(this.baseUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      throw new Error(`MCP HTTP error (${this.name}): ${response.status} ${response.statusText}`);
    }

    const json = await response.json() as JSONRPCResponse;

    if (json.error) {
      throw new Error(`MCP error (${this.name}): ${json.error.message}`);
    }

    return json.result;
  }

  sendNotification(method: string, params: unknown): void {
    // Fire-and-forget POST — no response expected. Errors are intentionally
    // swallowed because JSON-RPC notifications have no reply by design.
    void fetch(this.baseUrl, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ jsonrpc: '2.0', method, params }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { /* notifications are best-effort per JSON-RPC spec */ });
  }
}
