import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { acquireLease } from './lease.js';
import type { ToolContext } from '../tools/types.js';
import type { LanguageModel } from 'ai';

export function openRouterTaskContext(ctx: ToolContext, model: LanguageModel): ToolContext {
  const cloud = typeof model === 'string' ? /^openrouter[/:]/.test(model) : /^openrouter(?:\.|$)/.test(model.provider);
  return { ...ctx, isolateTasks: () => cloud && (ctx.workspaceMode?.() === 'isolated' || (!ctx.workspaceMode && !!ctx.isolateTasks?.())) };
}

export function parseWorkspaceMode(value: unknown): 'shared' | 'isolated' {
  if (value !== 'shared' && value !== 'isolated') throw new Error('Workspace mode must be shared or isolated.');
  return value;
}

async function projectKey(cwd: string) {
  cwd = await fs.realpath(cwd);
  try { cwd = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); } catch { /* Shared folders do not require Git. */ }
  return 'project-task:' + (process.platform === 'win32' ? path.resolve(cwd).toLowerCase() : cwd);
}
const sharedWorkers = new Map<string, Set<Promise<unknown>>>();
export async function acquireProjectLease(cwd: string, signal?: AbortSignal, onWait?: (waiting: boolean) => void) {
  return acquireLease(await projectKey(cwd), signal, onWait);
}

/** Workers take turns within their parent task; nested workers use their own lane. */
export async function withSharedWorker<T>(ctx: ToolContext, run: (ctx: ToolContext) => Promise<T>): Promise<T> {
  if (ctx.taskWorkspace || ctx.accessMode === 'read-only' || ctx.dryRun) return run(ctx);
  return withTaskWorkspace(ctx, owned => {
    const workers = sharedWorkers.get(owned.sharedTask!)!;
    const pending = (async () => {
      const release = await acquireLease('shared-workers:' + owned.sharedTask + ':' + (owned.sharedWorker ?? 'root'), ctx.abortSignal,
        waiting => ctx.onQueue?.(waiting ? 'Waiting for another worker in this project…' : null));
      try { return await run({ ...owned, sharedWorker: randomUUID() }); } finally { await release(); }
    })();
    workers.add(pending);
    void pending.finally(() => workers.delete(pending)).catch(() => {});
    return pending;
  });
}

const exec = promisify(execFile);
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const home = () => path.join(process.env.USERPROFILE || process.env.HOME || os.homedir(), '.notch', 'worktrees');
type Revision = { hash: string; mode: number } | null;
interface Entry { source: Revision; task: Revision; reconcile?: Revision }
interface Manifest {
  version: 1; source: string; repo: string; root: string; cwd: string;
  baseline: Record<string, Entry>; state: 'running' | 'pending' | 'applied'; retainForWorkers?: boolean;
}

async function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const inherited = { ...process.env };
  for (const key of Object.keys(inherited)) if (/^GIT_(DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_PARAMETERS)$/i.test(key)) delete inherited[key];
  const result = await exec('git', ['-c', 'core.hooksPath=' + path.join(home(), 'no-hooks'), '-c', 'core.fsmonitor=false', '-c', 'core.longpaths=true', ...args], {
    cwd, env: { ...inherited, GIT_TERMINAL_PROMPT: '0', ...env },
    windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  return result.stdout;
}
async function revision(file: string): Promise<Revision> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Task isolation requires regular files: ${file}`);
    return { hash: hash(await fs.readFile(file)), mode: stat.mode & 0o777 };
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function same(a: Revision, b: Revision) { return a?.hash === b?.hash && (process.platform === 'win32' || a?.mode === b?.mode); }
function inside(root: string, file: string) {
  const relative = path.relative(root, file);
  return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function safeFile(root: string, relative: string) {
  const target = path.resolve(root, relative);
  if (!inside(root, target) || relative.split(/[\\/]/).some(part => part.toLowerCase() === '.git')) throw new Error('Task path escapes the project.');
  if (process.platform === 'win32' && path.relative(root, target).includes(':')) throw new Error('Windows alternate data streams are not task files.');
  let parent = target;
  while (parent !== root) {
    try {
      const stat = await fs.lstat(parent);
      if (stat.isSymbolicLink() || !inside(root, await fs.realpath(parent))) throw new Error(`Task path crosses a symbolic link: ${relative}`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    parent = path.dirname(parent);
  }
  return target;
}
async function save(file: string, data: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temporary, JSON.stringify(data), { flag: 'wx', mode: 0o600, flush: true }); await fs.rename(temporary, file); }
  finally { await fs.unlink(temporary).catch(() => {}); }
}
async function sourceLease(cwd: string, signal?: AbortSignal) {
  const projectRelease = await acquireProjectLease(cwd, signal);
  let release: (() => Promise<void>) | undefined;
  try {
    release = await acquireLease('file-mutations', signal);
    const taskRelease = await acquireLease('task-files:' + cwd, signal);
    return async () => { try { await taskRelease(); } finally { try { await release!(); } finally { await projectRelease(); } } };
  } catch (error) { try { await release?.(); } finally { await projectRelease(); } throw error; }
}
async function files(repo: string, root: string, index?: string) {
  const result = await git(root, ['--git-dir', repo, '--work-tree', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'], index ? { GIT_INDEX_FILE: index } : {});
  return [...new Set(result.split('\0').filter(Boolean))];
}

/** A linked checkout and a durable, byte-exact baseline; the user's index and branch never move. */
export class TaskWorkspace {
  private constructor(readonly file: string, readonly manifest: Manifest) {}
  get cwd() { return this.manifest.cwd; }

  static async open(source: string, session: string): Promise<TaskWorkspace> {
    source = await fs.realpath(source);
    if (inside(source, home())) throw new Error('Choose a specific project folder: the selected folder contains notch’s own task storage.');
    const folder = path.join(home(), hash(source).slice(0, 20), hash(session).slice(0, 20));
    const file = path.join(folder, 'task.json');
    await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    let savedText: string | undefined;
    try { savedText = await fs.readFile(file, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (savedText !== undefined) {
      const saved = JSON.parse(savedText) as Manifest;
      if (saved.version !== 1 || saved.source !== source || typeof saved.root !== 'string' || typeof saved.cwd !== 'string' || typeof saved.repo !== 'string' || !saved.baseline || !['running','pending','applied'].includes(saved.state) || !inside(folder, saved.root) || saved.root === folder || !inside(saved.root, saved.cwd)) throw new Error('Invalid saved task workspace.');
      if (saved.state !== 'applied') {
        if (await fs.realpath(saved.root).catch(() => '') !== saved.root) throw new Error('Saved task checkout is missing or moved. Its recovery record was preserved.');
        await safeFile(saved.root, path.relative(saved.root, saved.cwd));
        await fs.mkdir(saved.cwd, { recursive: true });
        if (await fs.realpath(saved.cwd) !== saved.cwd) throw new Error('Saved task checkout moved.');
        return new TaskWorkspace(file, saved);
      }
    }

    let root: string, repo: string;
    try {
      root = (await git(source, ['rev-parse', '--show-toplevel'])).trim();
      root = await fs.realpath(root);
      repo = (await git(root, ['rev-parse', '--absolute-git-dir'])).trim();
    } catch (error) {
      // A private Git database also gives non-Git projects isolated checkouts.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Install Git to enable automatic task isolation.');
      root = source; repo = path.join(folder, 'repository.git');
      await git(source, ['init', '--bare', repo]);
      await fs.writeFile(path.join(repo, 'info', 'exclude'), 'node_modules/\n.venv/\nvenv/\n__pycache__/\n');
    }
    if (inside(root, home())) throw new Error('Choose a project repository outside notch’s task storage. Its parent repository contains that storage.');
    const index = path.join(folder, 'index-' + randomUUID());
    const env = { GIT_INDEX_FILE: index };
    const args = ['--git-dir', repo, '--work-tree', root];
    const checkout = path.join(folder, 'checkout-' + randomUUID());
    try {
      let filterNames = '';
      try { filterNames = await git(root, [...args, 'config', '--name-only', '--get-regexp', '^filter\\..*\\.(clean|smudge|process|required)$']); }
      catch (error) { if ((error as { code?: number }).code !== 1) throw error; }
      // Snapshotting must never invoke a project's filter commands in the source checkout.
      const filters = [...new Set(filterNames.trim().split(/\r?\n/).filter(Boolean).map(name => name.replace(/\.[^.]+$/, '')))];
      const noFilters = filters.flatMap(name => ['-c', `${name}.clean=`, '-c', `${name}.smudge=`, '-c', `${name}.process=`, '-c', `${name}.required=false`]);
      const sourceIndex = (await git(root, ['--git-dir', repo, 'rev-parse', '--git-path', 'index'])).trim();
      try { await fs.copyFile(path.resolve(root, sourceIndex), index); await git(root, [...args, 'update-index', '--no-split-index'], env); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        try { await git(root, [...args, 'read-tree', 'HEAD'], env); }
        catch { await git(root, [...args, 'read-tree', '--empty'], env); }
      }
      let commit: string | undefined;
      try { commit = (await git(root, [...args, 'rev-parse', '--verify', 'HEAD'])).trim(); } catch { /* Unborn repository. */ }
      const headNames = commit ? (await git(root, [...args, 'ls-tree', '-r', '--name-only', '-z', commit])).split('\0').filter(Boolean) : [];
      const names = [...new Set([...headNames, ...await files(repo, root, index)])];
      const skipped = new Set((await git(root, [...args, 'ls-files', '-v', '-z'], env)).split('\0').filter(line => line[0]?.toUpperCase() === 'S').map(line => line.slice(2)));
      const baseline: Record<string, Entry> = Object.create(null);
      for (const name of names) baseline[name] = { source: await revision(await safeFile(root, name)), task: null };
      if (!commit) {
        const empty = { GIT_INDEX_FILE: index + '.empty' };
        try {
          await git(root, [...args, 'read-tree', '--empty'], empty);
          const tree = (await git(root, [...args, 'write-tree'], empty)).trim();
          commit = (await git(root, [...args, 'commit-tree', tree, '-m', 'notch task workspace'], {
            ...empty, GIT_AUTHOR_NAME: 'notch', GIT_AUTHOR_EMAIL: 'tasks@freesyntax.dev', GIT_COMMITTER_NAME: 'notch', GIT_COMMITTER_EMAIL: 'tasks@freesyntax.dev',
          })).trim();
        } finally { await fs.unlink(empty.GIT_INDEX_FILE).catch(() => {}); }
      }
      await git(root, ['--git-dir', repo, ...noFilters, '-c', 'core.autocrlf=false', 'worktree', 'add', '--detach', checkout, commit]);
      // Carry local edits as working files, never as an implicit commit of untracked data.
      for (const [name, entry] of Object.entries(baseline)) {
        const target = await safeFile(checkout, name);
        if (entry.source) { await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(await safeFile(root, name), target); }
        else if (!skipped.has(name)) await fs.unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
        entry.task = await revision(target);
      }
      for (const [name, entry] of Object.entries(baseline)) {
        if (!same(entry.source, await revision(await safeFile(root, name)))) throw new Error('Project changed while preparing the task. Please retry.');
      }
      for (const name of await files(repo, checkout, index)) {
        const entry = baseline[name];
        if (!entry) throw new Error('Project changed while preparing the task. Please retry.');
      }
      const manifest: Manifest = { version: 1, source, repo, root: checkout, cwd: path.join(checkout, path.relative(root, source)), baseline, state: 'running' };
      // Store paths relative to the selected project, including deleted inputs.
      manifest.baseline = Object.fromEntries(Object.entries(baseline).map(([name, entry]) => [path.relative(source, path.join(root, name)), entry]));
      await save(file, manifest);
      return new TaskWorkspace(file, manifest);
    } catch (error) {
      if (inside(folder, checkout) && path.basename(checkout).startsWith('checkout-')) await git(root, ['--git-dir', repo, 'worktree', 'remove', '--force', checkout]).catch(() => {});
      throw error;
    } finally { await fs.unlink(index).catch(() => {}); }
  }

  /** Capture shell-created/deleted files too; plugins cannot bypass the delivery check. */
  async changes() {
    const m = this.manifest;
    const taskRepo = (await git(m.root, ['rev-parse', '--absolute-git-dir'])).trim();
    const names = new Set([...Object.keys(m.baseline), ...(await files(taskRepo, m.root)).map(name => path.relative(m.cwd, path.join(m.root, name)))]);
    const changes = [];
    for (const name of names) {
      const current = await revision(await safeFile(m.root, path.relative(m.root, path.resolve(m.cwd, name))));
      const entry = Object.hasOwn(m.baseline, name) ? m.baseline[name] : undefined;
      if (!same(current, entry?.task ?? null)) changes.push({ name, current, entry: entry ?? { source: null, task: null } });
    }
    return changes;
  }

  async apply(checkpoints?: ToolContext['workspaceCheckpoints']) {
    const m = this.manifest, changes = await this.changes();
    const release = await sourceLease(m.source);
    try {
      const conflicts: string[] = [], plan = [];
      for (const change of changes) {
        if (!inside(m.source, path.resolve(m.source, change.name))) { conflicts.push(`Outside the selected folder: ${change.name}`); continue; }
        const source = await safeFile(m.source, change.name);
        const current = await revision(source);
        if (same(current, change.current)) continue; // Recovery after an interrupted delivery.
        if (Object.hasOwn(change.entry, 'reconcile') && same(change.current, change.entry.reconcile!)) { conflicts.push(change.name); continue; }
        if (!same(current, change.entry.source)) { conflicts.push(change.name); continue; }
        const bytes = change.current ? await fs.readFile(await safeFile(m.cwd, change.name)) : null;
        if (bytes && hash(bytes) !== change.current!.hash) throw new Error('Task files changed during delivery. Please retry.');
        if (checkpoints && bytes && !Buffer.from(bytes.toString('utf8')).equals(bytes)) throw new Error(`Binary task output needs review before applying: ${change.name}. The private checkout was preserved.`);
        plan.push({ ...change, source, bytes });
      }
      if (conflicts.length) {
        m.state = 'pending'; await save(this.file, m);
        return { applied: false, files: changes.map(c => c.name), conflicts, cwd: this.cwd };
      }
      // Persist Undo before the first source write, including actions performed by shell tools.
      for (const item of plan) await checkpoints?.recordBefore(item.source);
      for (const item of plan) {
        if (item.bytes === null) await fs.unlink(item.source);
        else {
          await fs.mkdir(path.dirname(item.source), { recursive: true });
          const temporary = item.source + '.notch-' + randomUUID() + '.tmp';
          try { await fs.writeFile(temporary, item.bytes, { mode: item.current!.mode, flag: 'wx', flush: true }); await fs.rename(temporary, item.source); }
          finally { await fs.unlink(temporary).catch(() => {}); }
        }
        await checkpoints?.recordAfter(item.source);
      }
      await checkpoints?.finish?.();
      m.state = 'applied'; await save(this.file, m);
      return { applied: true, files: changes.map(c => c.name), conflicts, cwd: this.cwd };
    } finally { await release(); }
  }

  async readSource(name: string) {
    const release = await sourceLease(this.manifest.source);
    try {
      const source = await safeFile(this.manifest.source, name);
      const relative = path.relative(this.manifest.source, source);
      const key = (value: string) => process.platform === 'win32' ? path.normalize(value).toLowerCase() : path.normalize(value);
      name = Object.keys(this.manifest.baseline).find(existing => key(existing) === key(relative)) ?? relative;
      const current = await revision(source);
      const bytes = current ? await fs.readFile(source) : null;
      if (bytes && hash(bytes) !== current!.hash) throw new Error('Source changed while reading. Read it again.');
      const entry = (Object.hasOwn(this.manifest.baseline, name) ? this.manifest.baseline[name] : undefined) ?? { source: null, task: null };
      if (!same(entry.source, current)) entry.reconcile = await revision(await safeFile(this.manifest.cwd, name));
      entry.source = current;
      Object.defineProperty(this.manifest.baseline, name, { value: entry, enumerable: true, writable: true, configurable: true });
      await save(this.file, this.manifest);
      return bytes ? bytes.toString('utf8') : '[This source file does not exist.]';
    } finally { await release(); }
  }

  async retainForWorkers() {
    this.manifest.retainForWorkers = true; await save(this.file, this.manifest);
  }

  async dispose() {
    if (this.manifest.state !== 'applied' || this.manifest.retainForWorkers) return;
    const root = path.resolve(this.manifest.root), folder = path.dirname(this.file);
    if (!inside(folder, root) || !path.basename(root).startsWith('checkout-')) throw new Error('Invalid managed checkout path.');
    await git(this.manifest.source, ['--git-dir', this.manifest.repo, 'worktree', 'remove', '--force', root]);
  }
}

/** Shared tasks hold the project lane for the whole turn, including terminal and plugin calls. */
export async function withTaskWorkspace<T>(ctx: ToolContext, run: (ctx: ToolContext) => Promise<T>): Promise<T> {
  if (ctx.accessMode === 'read-only' || ctx.dryRun || ctx.taskWorkspace) return run(ctx);
  if (!ctx.isolateTasks?.()) {
    if (ctx.sharedTask && sharedWorkers.has(ctx.sharedTask)) return run(ctx);
    const release = await acquireProjectLease(ctx.cwd, ctx.abortSignal,
      waiting => ctx.onQueue?.(waiting ? 'Waiting for another task in this project…' : null));
    const token = randomUUID(), workers = new Set<Promise<unknown>>(); sharedWorkers.set(token, workers);
    try { ctx.abortSignal?.throwIfAborted(); return await run({ ...ctx, sharedTask: token, sharedWorker: undefined, _readCache: new Map(), _fileVersions: new Map() }); }
    finally {
      try { while (workers.size) await Promise.allSettled([...workers]); await ctx.workspaceCheckpoints?.finish?.(); }
      finally { sharedWorkers.delete(token); await release(); }
    }
  }
  const session = ctx.permissionSessionId || randomUUID();
  const release = await acquireLease('task-workspace:' + hash(ctx.cwd + '\0' + session), ctx.abortSignal);
  let task: TaskWorkspace | undefined;
  try {
    ctx.onQueue?.('Preparing a private task workspace…');
    const sourceLock = await sourceLease(ctx.cwd, ctx.abortSignal);
    try { task = await TaskWorkspace.open(ctx.cwd, session); } finally { await sourceLock(); }
    ctx.abortSignal?.throwIfAborted(); ctx.onQueue?.(null);
    ctx.log('Working in a private task workspace. Safe changes return automatically.');
    const child: ToolContext = { ...ctx, cwd: task.cwd, taskWorkspace: task, _readCache: new Map(), _fileVersions: new Map(),
      runHook: ctx.runHook ? (event, payload) => ctx.runHook!(event, { ...payload, isolatedWorkspace: true, cwd: task!.cwd }) : undefined };
    const result = await run(child);
    ctx.abortSignal?.throwIfAborted();
    if (result && typeof result === 'object' && (('error' in result && result.error) || ('status' in result && result.status === 'max-iterations'))) {
      ctx.log(`Unfinished task files are safe in ${task.cwd}. Resume this chat to continue.`);
      return result;
    }
    const delivery = await task.apply(ctx.workspaceCheckpoints);
    ctx.onWorkspaceResult?.(delivery);
    ctx.log(delivery.applied ? `Applied ${delivery.files.length} task file change(s).` : `Changes kept separate: ${delivery.conflicts.join(', ')} changed in the project. Ask notch to reconcile them. Saved workspace: ${task.cwd}`);
    if (delivery.applied) await task.dispose().catch(() => ctx.log('Completed task checkout retained for cleanup.'));
    return result;
  } catch (error) {
    if (task) ctx.log(`Unfinished task files are safe in ${task.cwd}. Resume this chat to continue.`);
    throw error;
  } finally { ctx.onQueue?.(null); await release(); }
}
