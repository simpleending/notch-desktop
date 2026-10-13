/**
 * Notch CLI — Terminal backend registry + factory.
 *
 * Picks a backend from `.notch.json`:
 *
 *   {
 *     "terminal": {
 *       "backend": "docker",
 *       "docker": {
 *         "image": "node:22-slim",
 *         "hostWorkspace": ".",
 *         "readOnly": false
 *       }
 *     }
 *   }
 *
 * Supported values for `backend`: `local` (default), `docker`, `ssh`, `modal`.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import path from 'node:path';
import { LocalTerminal } from './local.js';
import { DockerTerminal, type DockerTerminalOptions } from './docker.js';
import { SSHTerminal, type SSHTerminalOptions } from './ssh.js';
import { ModalTerminal, type ModalTerminalOptions } from './modal.js';
import type { TerminalBackend } from './types.js';

export type TerminalBackendId = 'local' | 'docker' | 'ssh' | 'modal';

export interface TerminalConfig {
  backend?: TerminalBackendId;
  docker?: Partial<DockerTerminalOptions> & { image?: string };
  ssh?: Partial<SSHTerminalOptions> & { target?: string };
  modal?: Partial<ModalTerminalOptions> & { endpoint?: string };
}

export function createTerminalBackend(
  config: TerminalConfig | undefined,
  projectRoot: string,
): TerminalBackend {
  const backend = config?.backend ?? 'local';
  switch (backend) {
    case 'local':
      return new LocalTerminal();
    case 'docker': {
      const docker = config?.docker ?? {};
      if (!docker.image) {
        throw new Error('terminal.docker.image is required when backend=docker');
      }
      // If hostWorkspace is relative or omitted, resolve against projectRoot.
      const hostWorkspace = docker.hostWorkspace
        ? path.isAbsolute(docker.hostWorkspace)
          ? docker.hostWorkspace
          : path.resolve(projectRoot, docker.hostWorkspace)
        : projectRoot;
      return new DockerTerminal({
        image: docker.image,
        hostWorkspace,
        containerWorkspace: docker.containerWorkspace,
        readOnly: docker.readOnly,
        extraRunArgs: docker.extraRunArgs,
        baseEnv: docker.baseEnv,
        shell: docker.shell,
      });
    }
    case 'ssh': {
      const ssh = config?.ssh ?? {};
      if (!ssh.target) {
        throw new Error('terminal.ssh.target is required when backend=ssh (e.g. "user@host")');
      }
      return new SSHTerminal({
        target: ssh.target,
        port: ssh.port,
        defaultCwd: ssh.defaultCwd,
        extraSshArgs: ssh.extraSshArgs,
        baseEnv: ssh.baseEnv,
        shell: ssh.shell,
      });
    }
    case 'modal': {
      const modal = config?.modal ?? {};
      if (!modal.endpoint) {
        throw new Error('terminal.modal.endpoint is required when backend=modal');
      }
      return new ModalTerminal({
        endpoint: modal.endpoint,
        authToken: modal.authToken,
        authHeaderName: modal.authHeaderName,
        app: modal.app,
        extraHeaders: modal.extraHeaders,
      });
    }
    default: {
      const exhaustive: never = backend;
      throw new Error(`unknown terminal backend: ${String(exhaustive)}`);
    }
  }
}

export { LocalTerminal, DockerTerminal, SSHTerminal, ModalTerminal };
export type { TerminalBackend, TerminalRunRequest, TerminalRunResult } from './types.js';
export type { DockerTerminalOptions, SSHTerminalOptions, ModalTerminalOptions };
