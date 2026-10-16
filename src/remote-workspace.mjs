import path from 'node:path';
import { acquireLease } from '../vendor/notch-core/desktop-harness.js';

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const missing = error => error.code === 'workspace_provider_not_found';

/** The existing SSH filesystem enforces real-path containment and conditional writes. */
export async function createRemoteWorkspace(service, target, signal) {
  if (target?.host?.kind !== 'ssh') throw new Error('Choose an SSH workspace.');
  const root = target.workspace?.path;
  if (typeof root !== 'string' || !root.startsWith('/') || path.posix.normalize(root) !== root) throw new Error('Invalid remote workspace.');
  await service.connectLocalAgent(target.host.id);
  const provider = service.getWorkspaceProvider(target.host.id, { hostId: target.host.id, hostKind: 'ssh', workspaceId: target.workspace.id, path: root });
  const relative = file => {
    if (typeof file !== 'string' || /[\0\r\n\\]/.test(file)) throw new Error('Invalid remote path.');
    const value = path.posix.relative(root, path.posix.resolve(root, file));
    if (value === '..' || value.startsWith('../') || value.split('/').includes('.git')) throw new Error('Choose a file inside the remote workspace.');
    return value;
  };
  const read = async (file, signal) => {
    try {
      const result = await provider.readFile({ path: relative(file) }, { signal });
      const bytes = Buffer.from(result.data, 'base64'), text = bytes.toString('utf8');
      if (bytes.length > 5 * 2 ** 20 || bytes.includes(0) || !Buffer.from(text).equals(bytes)) throw new Error('Remote text files must be UTF-8 and at most 5 MiB.');
      return text;
    } catch (error) { if (missing(error)) return null; throw error; }
  };
  const write = async (file, content, expected, signal) => {
    const rel = relative(file);
    if (!rel) throw new Error('Choose a file inside the remote workspace.');
    if (content === null) {
      if (expected === null) return;
      const session = await provider.resolveSession();
      const script = 'set -eu\ncd -P -- "$1"\nroot=$(pwd -P)\ncd -P -- "$(dirname "$2")"\ncase "$PWD/" in "$root/"*) ;; *) exit 73;; esac\nfile=$(basename "$2")\ntest ! -L "$file" || exit 73\nIFS= read -r expected\nactual=$(base64 <"$file" | tr -d "\\r\\n")\ntest "$expected" = "$actual" || exit 80\nrm -- "$file"\n';
      const result = await session.run({ remoteCommand: `sh -c ${quote(script)} notch ${quote(root)} ${quote(rel)}`, input: Buffer.from(expected).toString('base64') + '\n', timeoutMs: 30000, maxOutputBytes: 1024, signal });
      if (result.exitCode !== 0) throw new Error(result.stderr || 'Cannot remove remote file.');
    } else {
      if (Buffer.byteLength(content) > 5 * 2 ** 20) throw new Error('Remote text files must be at most 5 MiB.');
      await provider.writeFile({ path: rel, data: Buffer.from(content).toString('base64'), encoding: 'base64', createParents: true,
        precondition: expected === null ? { kind: 'absent' } : { kind: 'match', data: Buffer.from(expected).toString('base64'), encoding: 'base64' } }, { signal });
    }
  };
  const identityResult = await provider.execute({ command: "stat -c '%d:%i' . 2>/dev/null || stat -f '%d:%i' .", maxOutputBytes: 1024 }, { signal });
  if (identityResult.exitCode !== 0 || !/^\d+:\d+\s*$/.test(identityResult.stdout)) throw new Error('Cannot verify the remote workspace identity.');
  const versions = new Map();
  const leaseKey = `ssh-workspace:${target.host.id}:${root}`;
  return {
    leaseKey,
    instructions: `Working directory: ${root}\nPlatform: remote POSIX host over SSH. Shell commands run on that host. Model inference and task history stay on this device. Read project instructions before changing files.`,
    checkpointFiles: {
      leaseKey,
      identity: `${target.host.id}:${target.workspace.id}:${identityResult.stdout.trim()}`,
      async safePath(file) {
        relative(file);
        try { const stat = await provider.stat({ path: relative(file) }, {}); if (stat.isSymbolicLink) throw new Error('Undo refuses symbolic links.'); }
        catch (error) { if (!missing(error)) throw error; }
      }, read, write,
    },
    async execute(name, args, signal) {
      const release = await acquireLease(leaseKey + ':files', signal);
      try {
        signal?.throwIfAborted();
        if (name === 'read') {
          const file = path.posix.resolve(root, args.path), text = await read(file, signal);
          if (text === null) { versions.set(file, null); return { content: 'Remote file does not exist.', isError: true }; }
          versions.set(file, text);
          const offset = Math.max(0, Math.floor(args.offset || 1) - 1), limit = Math.max(1, Math.min(2000, Math.floor(args.limit || 2000)));
          return { content: text.split('\n').slice(offset, offset + limit).map((line, index) => `${index + offset + 1}\t${line}`).join('\n') };
        }
        if (name === 'write' || name === 'edit') {
          const file = path.posix.resolve(root, args.path), current = await read(file, signal);
          if (current !== null && (!versions.has(file) || versions.get(file) !== current)) throw new Error('Remote file conflict: read the current file before changing it. Existing contents were preserved.');
          let content = args.content;
          if (name === 'edit') {
            if (current === null || !args.old_string || !current.includes(args.old_string)) throw new Error('The exact old_string was not found.');
            if (!args.replace_all && current.indexOf(args.old_string) !== current.lastIndexOf(args.old_string)) throw new Error('old_string is not unique; include more context.');
            content = args.replace_all ? current.replaceAll(args.old_string, args.new_string) : current.replace(args.old_string, args.new_string);
          }
          await write(file, content, current, signal); versions.set(file, content);
          return { content: `Updated ${file} over SSH.` };
        }
        if (name === 'glob') {
          const result = await provider.glob({ path: relative(args.path || root), pattern: args.pattern, ignore: ['**/.git/**', '**/node_modules/**'], limit: 10000 }, { signal });
          return { content: result.paths.join('\n') || '(no matches)' };
        }
        if (name === 'grep') {
          const result = await provider.grep({ path: relative(args.path || root), pattern: args.pattern, glob: args.glob ? [args.glob] : undefined, beforeContext: args.context, afterContext: args.context, lineNumbers: true, limit: args.max_results || 50 }, { signal });
          return { content: result.lines.join('\n') || '(no matches)' };
        }
        if (name === 'shell') {
          for (const [file, observed] of versions) if (await read(file, signal) !== observed) throw new Error(`Remote file conflict: ${file} changed. Read it again before running a command.`);
          const result = await provider.execute({ command: args.command, timeoutMs: Math.max(1, Math.min(600000, args.timeout || 30000)), maxOutputBytes: 50000 }, { signal });
          versions.clear();
          return { content: `${result.stdout}${result.stderr ? '\n' + result.stderr : ''}\nExit code: ${result.exitCode}`, isError: result.exitCode !== 0 };
        }
        throw new Error(`Unsupported SSH tool: ${name}`);
      } catch (error) { if (signal?.aborted) throw error; return { content: error.message, isError: true }; }
      finally { await release(); }
    },
  };
}
