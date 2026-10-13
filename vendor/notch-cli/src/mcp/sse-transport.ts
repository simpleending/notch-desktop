/**
 * Notch CLI — MCP SSE Transport
 *
 * Communicates with a remote MCP server using Server-Sent Events (SSE)
 * for server-to-client messages and HTTP POST for client-to-server requests.
 *
 * Standard MCP SSE pattern:
 *   - Client connects to SSE endpoint to receive events
 *   - Client sends requests via POST to a message endpoint
 *   - Server sends responses and notifications via SSE
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import type { MCPTransport, MCPServerConfig } from './transport.js';

interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class SSETransport implements MCPTransport {
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private abortController: AbortController | null = null;
  private connected = false;
  private name: string;
  private baseUrl: string;
  private messageEndpoint: string;
  private sseEndpoint: string;
  private headers: Record<string, string>;

  constructor(config: MCPServerConfig, name: string) {
    this.name = name;
    if (!config.url) {
      throw new Error(`SSE transport requires 'url' in config for server ${name}`);
    }
    this.baseUrl = config.url.replace(/\/$/, '');
    // Standard MCP SSE endpoints
    this.sseEndpoint = `${this.baseUrl}/sse`;
    this.messageEndpoint = `${this.baseUrl}/message`;
    this.headers = {
      'Content-Type': 'application/json',
      ...config.headers,
    };
  }

  async connect(): Promise<void> {
    this.abortController = new AbortController();

    // Start SSE connection
    const ssePromise = this.startSSEListener();

    // Wait briefly for SSE to establish, then initialize
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Send initialize request via POST
    const initResult = await this.sendRequest('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'notch-cli', version: '0.4.8' },
    });

    if (!initResult) {
      throw new Error(`MCP SSE server ${this.name} failed to initialize`);
    }

    this.sendNotification('notifications/initialized', {});
    this.connected = true;

    // Don't await the SSE listener — it runs in the background
    ssePromise.catch(() => {
      this.connected = false;
    });
  }

  disconnect(): void {
    this.abortController?.abort();
    this.abortController = null;
    this.connected = false;

    // Reject all pending requests
    for (const [id, pending] of this.pendingRequests) {
      pending.reject(new Error(`MCP SSE transport disconnected`));
      this.pendingRequests.delete(id);
    }
  }

  get isAlive(): boolean {
    return this.connected;
  }

  async sendRequest(method: string, params: unknown): Promise<unknown> {
    const id = ++this.requestId;
    const body: JSONRPCMessage = { jsonrpc: '2.0', id, method, params };

    // Create a promise that will be resolved when we get the SSE response
    const resultPromise = new Promise<unknown>((resolve, reject) => {
      this.pendingRequests.set(id, { resolve, reject });

      // Timeout
      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP SSE request ${method} timed out`));
        }
      }, 30_000);
    });

    // Send the request via POST
    const response = await fetch(this.messageEndpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      this.pendingRequests.delete(id);
      throw new Error(`MCP SSE POST error (${this.name}): ${response.status} ${response.statusText}`);
    }

    return resultPromise;
  }

  sendNotification(method: string, params: unknown): void {
    const body: JSONRPCMessage = { jsonrpc: '2.0', method, params };
    void fetch(this.messageEndpoint, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => { /* notifications are best-effort per JSON-RPC spec */ });
  }

  /**
   * Start listening for Server-Sent Events.
   * Parses the SSE stream and resolves pending requests.
   */
  private async startSSEListener(): Promise<void> {
    const response = await fetch(this.sseEndpoint, {
      headers: {
        Accept: 'text/event-stream',
        ...this.headers,
      },
      signal: this.abortController?.signal,
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from the buffer
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? ''; // Keep incomplete event in buffer

        for (const event of events) {
          const lines = event.split('\n');
          let data = '';

          for (const line of lines) {
            if (line.startsWith('data: ')) {
              data += line.slice(6);
            }
          }

          if (data) {
            this.handleSSEMessage(data);
          }
        }
      }
    } catch (err: any) {
      if (err.name !== 'AbortError') {
        this.connected = false;
      }
    }
  }

  private handleSSEMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as JSONRPCMessage;
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(`MCP SSE error: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }
}
