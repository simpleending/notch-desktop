/**
 * Notch CLI — MCP Stdio Transport
 *
 * Communicates with a local MCP server via stdin/stdout using
 * Content-Length framed JSON-RPC 2.0 messages.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { MCPTransport, MCPServerConfig } from './transport.js';

interface JSONRPCMessage {
  jsonrpc: '2.0';
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

export class StdioTransport implements MCPTransport {
  private process: ChildProcess | null = null;
  private requestId = 0;
  private pendingRequests = new Map<number, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  private buffer = '';
  private name: string;

  constructor(
    private config: MCPServerConfig,
    name: string,
  ) {
    this.name = name;
  }

  async connect(): Promise<void> {
    if (!this.config.command) {
      throw new Error(`Stdio transport requires 'command' in config for server ${this.name}`);
    }

    this.process = spawn(this.config.command, this.config.args ?? [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...this.config.env },
      cwd: this.config.cwd,
    });

    this.process.stdout?.setEncoding('utf-8');
    this.process.stdout?.on('data', (data: string) => {
      this.buffer += data;
      this.processBuffer();
    });

    this.process.on('error', (err) => {
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server ${this.name} error: ${err.message}`));
        this.pendingRequests.delete(id);
      }
    });

    this.process.on('exit', (code) => {
      for (const [id, pending] of this.pendingRequests) {
        pending.reject(new Error(`MCP server ${this.name} exited with code ${code}`));
        this.pendingRequests.delete(id);
      }
    });
  }

  disconnect(): void {
    if (this.process) {
      this.process.stdin?.end();
      this.process.kill();
      this.process = null;
    }
    this.pendingRequests.clear();
  }

  get isAlive(): boolean {
    return this.process !== null && this.process.exitCode === null && !this.process.killed;
  }

  sendRequest(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.requestId;
      const msg: JSONRPCMessage = { jsonrpc: '2.0', id, method, params };
      this.pendingRequests.set(id, { resolve, reject });

      const data = JSON.stringify(msg);
      const header = `Content-Length: ${Buffer.byteLength(data)}\r\n\r\n`;
      this.process?.stdin?.write(header + data);

      setTimeout(() => {
        if (this.pendingRequests.has(id)) {
          this.pendingRequests.delete(id);
          reject(new Error(`MCP request ${method} timed out`));
        }
      }, 30_000);
    });
  }

  sendNotification(method: string, params: unknown): void {
    const msg: JSONRPCMessage = { jsonrpc: '2.0', method, params };
    const data = JSON.stringify(msg);
    const header = `Content-Length: ${Buffer.byteLength(data)}\r\n\r\n`;
    this.process?.stdin?.write(header + data);
  }

  private processBuffer(): void {
    while (this.buffer.length > 0) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const header = this.buffer.slice(0, headerEnd);
      const lengthMatch = header.match(/Content-Length:\s*(\d+)/i);
      if (!lengthMatch) {
        const nlIdx = this.buffer.indexOf('\n');
        if (nlIdx === -1) break;
        const line = this.buffer.slice(0, nlIdx).trim();
        this.buffer = this.buffer.slice(nlIdx + 1);
        if (line) this.handleMessage(line);
        continue;
      }

      const contentLength = parseInt(lengthMatch[1]!, 10);
      const messageStart = headerEnd + 4;
      if (this.buffer.length < messageStart + contentLength) break;

      const body = this.buffer.slice(messageStart, messageStart + contentLength);
      this.buffer = this.buffer.slice(messageStart + contentLength);
      this.handleMessage(body);
    }
  }

  private handleMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw) as JSONRPCMessage;
      if (msg.id !== undefined && this.pendingRequests.has(msg.id)) {
        const pending = this.pendingRequests.get(msg.id)!;
        this.pendingRequests.delete(msg.id);

        if (msg.error) {
          pending.reject(new Error(`MCP error: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
    } catch {
      // Ignore malformed messages
    }
  }
}
