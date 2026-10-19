import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn as nodeSpawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { renderPairingQr } from './phone-qr.mjs';

const phoneWrapped = Symbol('notchPhoneApproval');
const reaches = new Set(['lan', 'address', 'ngrok', 'cloudflare']);
const assetRoot = fileURLToPath(new URL('../assets/', import.meta.url));
const pageRoot = fileURLToPath(new URL('./phone/', import.meta.url));
const pages = new Map([
  ['/phone.css', ['page.css', 'text/css; charset=utf-8']],
  ['/phone.js', ['page.js', 'text/javascript; charset=utf-8']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']],
]);
const publicAssets = new Map([
  ['/assets/notch-wordmark-dark.svg', ['notch-wordmark-dark.svg', 'image/svg+xml']],
  ['/assets/notch-wordmark-light.svg', ['notch-wordmark-light.svg', 'image/svg+xml']],
  ['/assets/notch-symbol.svg', ['notch-symbol.svg', 'image/svg+xml']],
  ['/assets/notch-symbol.png', ['notch-symbol.png', 'image/png']],
  ['/assets/Manrope.ttf', ['fonts/Manrope.ttf', 'font/ttf']],
]);

function httpError(message, status) { const error = new Error(message); error.status = status; return error; }
function sameText(left, right) { return timingSafeEqual(createHash('sha256').update(String(left)).digest(), createHash('sha256').update(String(right)).digest()); }
function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function phoneSessionId(cwd) { return `phone-${createHash('sha256').update(cwd).digest('hex').slice(0, 32)}`; }
function computerName() { return os.hostname().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64) || 'This computer'; }
function phoneMode(mode) { return mode === 'read-only' ? 'read-only' : 'default'; }
function validToken(value) { return typeof value === 'string' && /^[A-Za-z0-9_\-+=./]{8,4000}$/.test(value); }
function scrub(text, secrets) {
  let clean = String(text || '');
  for (const secret of secrets) if (secret && secret.length > 3) clean = clean.split(secret).join('hidden');
  return clean.replace(/\s+/g, ' ').trim().slice(0, 280);
}
function isPrivate(host) {
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
}
export function validReachUrl(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.origin.length > 300) return false;
  if (url.protocol === 'https:') return true;
  const host = url.hostname;
  return host === 'localhost' || host.endsWith('.local') || host.endsWith('.ts.net') || isPrivate(host);
}
function canonicalUrl(value, httpsOnly = false) {
  const text = String(value || '').trim();
  if (!text) return '';
  const withScheme = /^https?:\/\//i.test(text) ? text : `https://${text}`;
  if (!validReachUrl(withScheme)) return null;
  const url = new URL(withScheme);
  if (httpsOnly && url.protocol !== 'https:') return null;
  return url.origin;
}
export function networkAddresses(interfaces = {}) {
  const found = [];
  for (const entries of Object.values(interfaces || {})) for (const entry of entries || []) {
    if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue;
    found.push(entry.address);
  }
  const unique = [...new Set(found)];
  const rank = ip => ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3;
  return { lan: unique.filter(ip => rank(ip) < 3).sort((a, b) => rank(a) - rank(b)), tailscale: unique.filter(ip => /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(ip)) };
}
export function formatPairCode(code) { return code ? `${code.slice(0, 4)} · ${code.slice(4)}` : ''; }
function deviceName(agent) {
  const text = String(agent || '');
  const name = /iPad/.test(text) ? 'iPad' : /iPhone/.test(text) ? 'iPhone' : /Android/.test(text) ? 'Android' : 'Phone';
  return name.slice(0, 32);
}
function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter(part => part?.type === 'text' && typeof part.text === 'string').map(part => part.text).join('');
}
function visibleText(message) {
  const text = textOf(message?.content).trim();
  if (!text || text.startsWith('Files from the selected turn') || text.startsWith('The preceding turn was interrupted')) return '';
  return text.slice(0, 8000);
}
function approvalCopy(name, input) {
  const source = input && typeof input === 'object' ? input : {};
  const file = ['file_path', 'path'].map(key => source[key]).find(value => typeof value === 'string') || '';
  const command = typeof source.command === 'string' ? source.command : '';
  const hidden = /key|token|password|secret|authorization|cookie/i;
  const lines = [];
  if (file) lines.push(file);
  if (command) lines.push(command);
  for (const [key, value] of Object.entries(source)) {
    if (['file_path', 'path', 'command'].includes(key)) continue;
    if (hidden.test(key)) lines.push(`${key}: hidden`);
    else if (typeof value === 'string' && value) lines.push(value.slice(0, 1200));
  }
  const base = file ? file.split(/[\\/]/).filter(Boolean).pop() : '';
  return { title: `${name}${base ? ' · ' + base : ''}`.slice(0, 180), detail: lines.join('\n').slice(0, 2000) };
}
function securityHeaders(extra) {
  return { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY', 'X-Robots-Tag': 'noindex, nofollow', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self'; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", ...extra };
}
async function readRaw(req, limit) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw httpError('That recording is too long.', 413); chunks.push(chunk); }
  return Buffer.concat(chunks);
}
async function readJson(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > 20000) throw httpError('That request is too large.', 413); chunks.push(chunk); }
  if (!size) return {};
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('shape'); return value; }
  catch (error) { if (error.status) throw error; throw httpError('The request could not be read.', 400); }
}

export async function installPhoneAssets(root, target) {
  await fs.mkdir(path.join(target, 'fonts'), { recursive: true });
  for (const name of ['notch-wordmark-dark.svg', 'notch-wordmark-light.svg', 'notch-symbol.svg', 'notch-symbol.png']) await fs.copyFile(path.join(root, 'assets', name), path.join(target, name));
  await fs.copyFile(path.join(root, 'assets', 'fonts', 'Manrope.ttf'), path.join(target, 'fonts', 'Manrope.ttf'));
}

export function createPhoneCompanion(directory, { host, safeStorage, interfaces = () => os.networkInterfaces(), spawn = nodeSpawn, fetcher = globalThis.fetch, port: fixedPort, now = () => Date.now() } = {}) {
  const file = path.join(directory, 'phone-access.json');
  let settings = { version: 1, enabled: false, reach: 'lan', port: 47321, publicUrl: '', cloudflareHost: '', pairCode: '', pairExpires: 0, pairUses: 0, devices: [] };
  let ngrokToken, cloudflareToken, persistent = false, loadError = '', boundPort = 0, server, child, tunnelGeneration = 0, tunnelSignature = '';
  let tunnel = { state: 'off', message: '' }, runtimeError = '', queue = Promise.resolve(), revision = 0, notifyTimer;
  const waiters = [], failures = new Map(), live = new Map(), pending = new Map();
  let workspace, historyCache, modelProbe = 0, activeId = '', focus = '';
  const tasks = new Map();
  let modeCache = { at: 0, mode: 'shared' }, voiceCache = { at: 0, ready: false, name: '' };
  const self = { note, prepare, attach, decide };
  let ready;
  const ensure = () => ready ??= load();

  async function load() {
    persistent = !!safeStorage && await safeStorage.isAsyncEncryptionAvailable?.() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend?.() !== 'basic_text');
    try {
      const stored = JSON.parse(await fs.readFile(file, 'utf8'));
      if (stored.version !== 1 || !reaches.has(stored.reach) || !Array.isArray(stored.devices)) throw new Error('Phone settings are unreadable.');
      settings = { ...settings, ...stored, devices: stored.devices.filter(device => device && typeof device.id === 'string' && typeof device.hash === 'string' && device.hash.length === 64).slice(0, 6) };
      if (stored.encryptedNgrok) { if (!persistent) throw new Error('Unlock system key storage to load the saved ngrok authtoken.'); ngrokToken = (await safeStorage.decryptStringAsync(Buffer.from(stored.encryptedNgrok, 'base64'))).result; }
      if (stored.encryptedCloudflare) { if (!persistent) throw new Error('Unlock system key storage to load the saved Cloudflare tunnel token.'); cloudflareToken = (await safeStorage.decryptStringAsync(Buffer.from(stored.encryptedCloudflare, 'base64'))).result; }
    } catch (error) {
      if (error.code !== 'ENOENT') loadError = 'Phone settings could not be loaded. The saved file was left in place.';
    }
  }
  async function persist() {
    const encryptedNgrok = persistent && ngrokToken ? (await safeStorage.encryptStringAsync(ngrokToken)).toString('base64') : undefined;
    const encryptedCloudflare = persistent && cloudflareToken ? (await safeStorage.encryptStringAsync(cloudflareToken)).toString('base64') : undefined;
    const payload = { ...settings };
    delete payload.ngrokToken; delete payload.cloudflareToken; delete payload.encryptedNgrok; delete payload.encryptedCloudflare;
    if (encryptedNgrok) payload.encryptedNgrok = encryptedNgrok;
    if (encryptedCloudflare) payload.encryptedCloudflare = encryptedCloudflare;
    await fs.mkdir(directory, { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { await fs.writeFile(temporary, JSON.stringify(payload), { mode: 0o600 }); await fs.rename(temporary, file); }
    finally { await fs.unlink(temporary).catch(() => {}); }
  }
  function enqueue(task) { const run = queue.then(task, task); queue = run.then(() => {}, () => {}); return run; }
  function ensureCode(force = false) {
    if (!force && settings.pairCode && settings.pairExpires > now() && settings.pairUses < 4) return false;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    settings.pairCode = [...randomBytes(8)].map(byte => alphabet[byte % alphabet.length]).join('');
    settings.pairExpires = now() + 12 * 60 * 60 * 1000; settings.pairUses = 0; return true;
  }
  function notify() { revision++; clearTimeout(notifyTimer); notifyTimer = setTimeout(() => { for (const wake of waiters.splice(0)) wake(); }, 40); }
  function wait(signal) {
    if (signal.aborted) return Promise.resolve();
    return new Promise(resolve => { const wake = () => { signal.removeEventListener('abort', wake); resolve(); }; waiters.push(wake); signal.addEventListener('abort', wake, { once: true }); });
  }
  function addresses() { return networkAddresses(interfaces()); }
  function port() { return boundPort || settings.port || 47321; }
  function link() {
    const nets = addresses();
    if (settings.reach === 'address' && settings.publicUrl) return settings.publicUrl.replace(/\/$/, '');
    if (settings.reach === 'ngrok' && tunnel.url) return tunnel.url.replace(/\/$/, '');
    if (settings.reach === 'cloudflare' && settings.cloudflareHost) return settings.cloudflareHost.replace(/\/$/, '');
    return `http://${nets.lan[0] || nets.tailscale[0] || '127.0.0.1'}:${port()}`;
  }
  function stopChild() { const current = child; child = null; if (current && !current.killed) current.kill(); }
  async function closeServer() { const current = server; server = null; boundPort = 0; if (current) await new Promise(resolve => current.close(resolve)); }
  async function bind(start) {
    const attempts = start === 0 ? [0] : Array.from({ length: 20 }, (_, index) => start + index);
    let last;
    for (const candidate of attempts) {
      const next = http.createServer((req, res) => { void route(req, res).catch(error => { if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Phone access could not finish that request.' }); }); });
      next.timeout = 0; next.requestTimeout = 0; next.headersTimeout = 20000;
      try {
        await new Promise((resolve, reject) => { next.once('error', reject); next.listen(candidate, '0.0.0.0', resolve); });
        server = next; return next.address().port;
      } catch (error) { next.close(); last = error; if (error.code !== 'EADDRINUSE') throw error; }
    }
    throw last || new Error('Phone access could not open a port on this computer.');
  }
  async function startTunnel() {
    const token = settings.reach === 'ngrok' ? ngrokToken : settings.reach === 'cloudflare' ? cloudflareToken : '';
    const signature = createHash('sha256').update(`${settings.reach}\n${token || ''}\n${settings.cloudflareHost || ''}\n${port()}`).digest('hex');
    if (!token || (settings.reach !== 'ngrok' && settings.reach !== 'cloudflare')) { tunnelGeneration++; stopChild(); tunnelSignature = ''; tunnel = { state: 'off', message: '' }; return; }
    if (signature === tunnelSignature && child) return;
    tunnelGeneration++; const generation = tunnelGeneration; stopChild(); tunnelSignature = signature; tunnel = { state: 'starting', message: settings.reach === 'ngrok' ? 'Starting ngrok with your authtoken.' : 'Starting Cloudflare with your tunnel token.' };
    const command = settings.reach === 'ngrok' ? 'ngrok' : 'cloudflared';
    const args = settings.reach === 'ngrok' ? ['http', String(port()), '--log', 'stdout'] : ['tunnel', '--no-autoupdate', 'run'];
    const env = { ...process.env, ...(settings.reach === 'ngrok' ? { NGROK_AUTHTOKEN: token } : { TUNNEL_TOKEN: token }) };
    let started;
    try { started = spawn(command, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (error) { tunnelSignature = ''; tunnel = { state: 'missing', message: error.code === 'ENOENT' ? `Install ${command} and keep your token here.` : 'The tunnel program could not start.' }; return; }
    child = started; let hint = '';
    const watch = chunk => {
      const text = scrub(chunk.toString('utf8'), [token]);
      if (text) hint = text;
      const found = chunk.toString('utf8').match(/https:\/\/[a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s]*)?/i);
      if (settings.reach === 'ngrok' && found && generation === tunnelGeneration) { tunnel = { state: 'ready', message: 'ngrok is using your authtoken.', url: found[0].replace(/\/$/, '') }; notify(); }
    };
    started.stdout?.on('data', watch); started.stderr?.on('data', watch);
    started.on('error', error => { if (generation !== tunnelGeneration) return; tunnelSignature = ''; child = null; tunnel = { state: error.code === 'ENOENT' ? 'missing' : 'error', message: error.code === 'ENOENT' ? `Install ${command} and keep your token here. notch will start it.` : 'The tunnel program could not start.' }; notify(); });
    started.on('exit', () => { if (generation !== tunnelGeneration || child !== started) return; child = null; tunnelSignature = ''; if (tunnel.state !== 'ready') tunnel = { state: 'error', message: hint || 'The tunnel stopped before it had an address.' }; else tunnel = { state: 'error', message: 'The tunnel stopped. Turn phone access off and on to start it again.' }; notify(); });
    if (settings.reach === 'cloudflare') { tunnel = { state: 'ready', message: `Your hostname should forward to 127.0.0.1:${port()}.`, url: settings.cloudflareHost }; return; }
    for (let attempt = 0; attempt < 20 && generation === tunnelGeneration && tunnel.state === 'starting'; attempt++) {
      const discovered = await readNgrok().catch(() => '');
      if (discovered && generation === tunnelGeneration) { tunnel = { state: 'ready', message: 'ngrok is using your authtoken.', url: discovered.replace(/\/$/, '') }; return; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (generation === tunnelGeneration && tunnel.state === 'starting') { tunnel = { state: 'error', message: hint || 'ngrok did not report an address. Check that it is installed and the authtoken is yours.' }; tunnelSignature = ''; }
  }
  async function readNgrok() {
    const response = await fetcher('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(800) });
    if (!response?.ok) return '';
    const data = await response.json();
    const row = (data.tunnels || []).find(item => item.proto === 'https') || data.tunnels?.[0];
    return typeof row?.public_url === 'string' ? row.public_url : '';
  }
  async function apply() {
    await ensure();
    if (loadError) throw new Error(loadError);
    if (!settings.enabled) { tunnelGeneration++; stopChild(); tunnelSignature = ''; tunnel = { state: 'off', message: '' }; runtimeError = ''; await closeServer(); notify(); return; }
    const issued = ensureCode(false);
    try { if (!server) boundPort = await bind(fixedPort ?? settings.port ?? 47321); runtimeError = ''; }
    catch { runtimeError = 'Phone access could not open a port on this computer.'; throw new Error(runtimeError); }
    if (fixedPort == null) settings.port = boundPort;
    if (issued || fixedPort == null) await persist();
    await startTunnel();
    notify();
  }
  function primaryId() { return workspace?.cwd ? phoneSessionId(workspace.cwd) : ''; }
  function blankTask(id, model) { return { id, messages: [], draft: '', model: model && model !== 'auto' ? model : (host?.getDefaultModel?.() || 'auto'), created: now() }; }
  function ensureTasks() {
    const id = primaryId();
    if (!id) return null;
    if (!tasks.has(id)) tasks.set(id, blankTask(id, workspace.model));
    if (!activeId || !tasks.has(activeId)) activeId = id;
    return tasks.get(activeId);
  }
  function modelRows() {
    return (host?.getCachedModels?.() || []).filter(row => row && row.key && row.key !== 'auto').slice(0, 24).map(row => ({
      key: String(row.key), name: row.displayName || String(row.key), provider: row.provider || (String(row.key).startsWith('openrouter/') ? 'openrouter' : 'local'), enabled: !!row.enabled,
    }));
  }
  function modelName(key) { return modelRows().find(row => row.key === key)?.name || (key && key !== 'auto' ? key : 'Model'); }
  function taskTitle(task) {
    const text = task.messages.find(message => message.role === 'user')?.text?.replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, 80) : 'New task';
  }
  function taskPhase(task) {
    if ([...pending.values()].some(item => !item.settled && item.sessionId === task.id)) return 'needs-you';
    return live.get(task.id)?.query.active ? 'working' : 'ready';
  }
  async function workspaceMode() {
    if (now() - modeCache.at < 4000) return modeCache.mode;
    try { const mode = await host?.modelManager?.getWorkspaceMode?.(); modeCache = { at: now(), mode: mode === 'isolated' ? 'isolated' : 'shared' }; }
    catch { modeCache = { at: now(), mode: 'shared' }; }
    return modeCache.mode;
  }
  async function voiceSummary() {
    if (!host?.voice?.status) return { ready: false, name: '' };
    if (now() - voiceCache.at < 4000) return voiceCache;
    try { const status = await host.voice.status(); voiceCache = { at: now(), ready: !!status?.ready, name: status?.stt?.name || '' }; }
    catch { voiceCache = { at: now(), ready: false, name: '' }; }
    return voiceCache;
  }
  function note(request) {
    if (!request || request.phoneOrigin || typeof request.cwd !== 'string' || !request.cwd.trim()) return;
    workspace = { cwd: request.cwd, name: path.basename(request.cwd) || 'Project', model: typeof request.model === 'string' && request.model ? request.model : 'auto', permissionMode: typeof request.permissionMode === 'string' ? request.permissionMode : 'default' };
    if (historyCache?.cwd !== workspace.cwd) historyCache = undefined;
  }
  function prepare(request) {
    note(request);
    if (request?.canUseTool?.[phoneWrapped]) return request;
    const id = request?.resumeSessionId || request?.sessionId || randomUUID();
    const original = request?.canUseTool;
    const canUseTool = (name, input, options) => self.decide(id, name, input, options, original);
    canUseTool[phoneWrapped] = true;
    return request?.resumeSessionId || request?.sessionId ? { ...request, canUseTool } : { ...request, sessionId: id, canUseTool };
  }
  function attach(query, request) {
    note(request);
    const bag = { query, request, source: request?.phoneOrigin ? 'phone' : 'computer', text: '' };
    live.set(query.id, bag);
    const stop = request?.phoneOrigin ? () => {} : query.subscribe?.(event => onComputer(bag, event)) || (() => {});
    if (request?.phoneOrigin) { if (!tasks.has(query.id)) tasks.set(query.id, blankTask(query.id, request.model)); void collect(query); }
    query.task.finally(() => {
      stop();
      for (const [id, item] of pending) if (item.sessionId === query.id && !item.settled) { item.settled = true; pending.delete(id); item.resolve?.({ behavior: 'deny' }); }
      if (live.get(query.id)?.query === query) live.delete(query.id);
      notify();
    });
  }
  function onComputer(bag, event) {
    if (event.subtype === 'session_state_changed') bag.phase = event.state;
    const delta = event.type === 'stream_event' ? event.event?.delta?.text : '';
    if (delta) bag.text = (bag.text + delta).slice(-1500);
    if (event.type === 'result') { bag.phase = 'idle'; if (event.result) bag.text = String(event.result).slice(-1500); if (event.is_error && event.errors?.[0]) bag.error = String(event.errors[0]).slice(0, 300); }
    notify();
  }
  async function collect(query) {
    const task = tasks.get(query.id);
    if (!task) return;
    let local = '';
    try {
      for await (const event of query) {
        const delta = event.type === 'stream_event' ? event.event?.delta?.text : '';
        if (delta) { local += delta; task.draft = local; notify(); continue; }
        if (event.type === 'assistant' && event.message?.content?.[0]?.type === 'tool_use') {
          if (local) { task.messages.push({ role: 'assistant', text: local.slice(0, 8000) }); local = ''; task.draft = ''; }
          const block = event.message.content[0];
          const file = block.input?.file_path || block.input?.command || '';
          task.messages.push({ role: 'tool', text: `${block.name}${file ? ' · ' + file : ''}`.slice(0, 500) });
          notify(); continue;
        }
        if (event.type === 'result') {
          const text = local || (!event.is_error && event.result) || '';
          if (text) task.messages.push({ role: 'assistant', text: String(text).slice(0, 8000) });
          if (event.is_error) task.messages.push({ role: 'error', text: String(event.errors?.[0] || 'The task stopped before it finished.').slice(0, 500) });
          local = ''; task.draft = ''; notify();
        }
      }
    } catch { task.messages.push({ role: 'error', text: 'The task ended before this phone finished reading it.' }); }
    finally { task.draft = ''; task.messages = task.messages.slice(-80); notify(); }
  }
  function decide(sessionId, name, input, options, original) {
    if (!settings.enabled) return original ? original(name, input, options) : Promise.resolve({ behavior: 'deny' });
    const offered = typeof options?.toolUseID === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(options.toolUseID) ? options.toolUseID : randomUUID();
    const id = pending.has(offered) ? randomUUID() : offered;
    const view = approvalCopy(typeof name === 'string' ? name : 'Action', input);
    let suggestions = [];
    try { suggestions = structuredClone(Array.isArray(options?.suggestions) ? options.suggestions : []); } catch { suggestions = []; }
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = fn => { if (done) return; done = true; pending.delete(id); notify(); fn(); };
      const item = { id, sessionId, source: String(sessionId).startsWith('phone-') ? 'phone' : 'computer', ...view, input, suggestions, settled: false, resolve: decision => finish(() => resolve(decision)) };
      pending.set(id, item); notify();
      if (!original) return;
      Promise.resolve().then(() => original(name, input, options)).then(decision => finish(() => resolve(decision)), error => finish(() => reject(error)));
    });
  }
  async function recall() {
    if (workspace?.cwd) return workspace;
    const dir = path.join(directory, 'notch-sessions');
    const names = (await fs.readdir(dir).catch(() => [])).filter(name => name.endsWith('.json')).slice(0, 500);
    let best = 0, cwd = '';
    for (const name of names) {
      const full = path.join(dir, name);
      const stat = await fs.stat(full).catch(() => null);
      if (!stat || stat.mtimeMs < best) continue;
      try {
        const saved = JSON.parse(await fs.readFile(full, 'utf8'));
        if (saved.version === 1 && typeof saved.cwd === 'string' && await fs.stat(saved.cwd).catch(() => null)) { best = stat.mtimeMs; cwd = saved.cwd; }
      } catch { /* Skip a session the computer can no longer read. */ }
    }
    if (cwd) workspace = { cwd, name: path.basename(cwd) || 'Project', model: host?.getDefaultModel?.() || 'auto', permissionMode: 'default' };
    return workspace;
  }
  async function history() {
    if (!workspace?.cwd || !host?.loadSession) return [];
    if (historyCache && historyCache.cwd === workspace.cwd && now() - historyCache.at < 2000) return historyCache.messages;
    let saved = [];
    try { saved = (await host.loadSession(phoneSessionId(workspace.cwd), workspace.cwd)).messages || []; } catch { saved = []; }
    const rows = saved.map(message => ({ role: message.role === 'assistant' ? 'assistant' : 'user', text: visibleText(message) })).filter(message => message.text).slice(-40);
    historyCache = { cwd: workspace.cwd, at: now(), messages: rows };
    return rows;
  }
  async function snapshot() {
    await recall();
    const models = (host?.getCachedModels?.() || []).filter(row => row && row.key !== 'auto');
    if (!models.length && now() - modelProbe > 15000) { modelProbe = now(); void Promise.resolve(host?.listModels?.()).then(() => notify()).catch(() => {}); }
    const rows = modelRows();
    const task = ensureTasks();
    if (task?.id === primaryId() && !task.messages.length) task.messages = await history();
    const computer = [...live.values()].filter(item => item.source === 'computer');
    const focused = focus && computer.find(item => item.query.id === focus);
    if (focus && !focused) focus = '';
    const modelKey = focused ? (focused.request?.model || 'auto') : (task?.model || 'auto');
    const model = modelName(modelKey);
    const active = [...live.values()].some(item => item.query.active);
    const phase = pending.size ? 'needs-you' : active ? 'working' : rows.some(row => row.enabled) ? 'ready' : 'loading';
    const labels = { 'needs-you': 'Needs you', working: 'Working', ready: 'Ready', loading: 'Loading model' };
    const current = focused || computer.find(item => item.query.active) || computer.at(-1);
    const shown = focused ? (focused.text ? [{ role: 'assistant', text: focused.text }] : []) : [...(task?.messages || []), ...(task?.draft ? [{ role: 'assistant', text: task.draft }] : [])];
    const voice = await voiceSummary();
    const mode = await workspaceMode();
    return {
      phase, label: labels[phase], project: workspace?.name || null, model, modelKey, task: focused ? focused.query.id : task?.id || null, composer: focused ? 'computer' : 'phone',
      access: phoneMode(workspace?.permissionMode) === 'read-only' ? 'Read only, same as the computer' : 'Asks before changes and commands',
      workspaceMode: mode, voice: { ready: !!voice.ready, name: voice.name || '' },
      models: rows,
      tasks: [
        ...[...tasks.values()].map(item => ({ id: item.id, title: taskTitle(item), phase: taskPhase(item), model: modelName(item.model), source: 'phone', current: !focused && item.id === activeId })),
        ...computer.map(item => ({ id: item.query.id, title: String(item.request?.prompt || 'On this computer').replace(/\s+/g, ' ').trim().slice(0, 80) || 'On this computer', phase: [...pending.values()].some(entry => !entry.settled && entry.sessionId === item.query.id) ? 'needs-you' : item.query.active ? 'working' : 'ready', model: modelName(item.request?.model), source: 'computer', current: item.query.id === focus })),
      ],
      computer: current ? { visible: !!(current.query.active || current.text), text: (current.text || '').slice(-1500), detail: current.query.active ? 'Working with the open project.' : '' } : { visible: false },
      messages: shown.slice(-80),
      pending: [...pending.values()].filter(item => !item.settled).slice(0, 8).map(item => ({ id: item.id, title: item.title, detail: item.detail, source: item.source })),
      stopPhone: !!(task && live.get(task.id)?.source === 'phone' && live.get(task.id).query.active),
      stopComputer: computer.some(item => item.query.active),
    };
  }
  async function desktopStatus() {
    await ensure();
    const issued = settings.enabled && ensureCode(false);
    if (issued) await persist().catch(() => {});
    const nets = addresses();
    let qr = null;
    const base = settings.enabled ? link() : '';
    const pairUrl = settings.enabled && settings.pairCode ? `${base}/#pair=${settings.pairCode}` : '';
    if (pairUrl) { try { qr = renderPairingQr(pairUrl); } catch { qr = null; } }
    return {
      enabled: settings.enabled, reach: settings.reach, port: port(), url: base, pairUrl, pairCode: settings.enabled ? settings.pairCode : '', pairLabel: formatPairCode(settings.enabled ? settings.pairCode : ''), qr,
      addresses: nets.lan, tailscale: nets.tailscale, publicUrl: settings.publicUrl, cloudflareHost: settings.cloudflareHost,
      hasNgrokKey: !!ngrokToken, hasCloudflareKey: !!cloudflareToken, persistentKey: persistent,
      devices: settings.devices.map(device => ({ id: device.id, name: device.name, createdAt: device.createdAt })),
      tunnel: { state: tunnel.state, message: tunnel.message, ...(tunnel.url ? { url: tunnel.url } : {}) }, error: loadError || runtimeError, project: workspace?.name || null, platform: process.platform, computer: computerName(),
    };
  }
  async function update(patch) {
    return enqueue(async () => {
      await ensure();
      if (loadError) throw new Error(loadError);
      if (!patch || typeof patch !== 'object' || Array.isArray(patch) || Object.keys(patch).some(key => !['enabled', 'reach', 'publicUrl', 'cloudflareHost', 'ngrokToken', 'cloudflareToken'].includes(key))) throw new Error('Choose a phone setting notch understands.');
      if ('enabled' in patch && typeof patch.enabled !== 'boolean') throw new Error('Choose whether phone access is on.');
      if ('reach' in patch && !reaches.has(patch.reach)) throw new Error('Choose this Wi-Fi, an address you host, ngrok, or Cloudflare.');
      if ('publicUrl' in patch) {
        const url = patch.publicUrl ? canonicalUrl(patch.publicUrl) : '';
        if (patch.publicUrl && !url) throw new Error('Use an https address, or an http address on your own network, a .local name, or a Tailscale .ts.net name.');
        settings.publicUrl = url || '';
      }
      if ('cloudflareHost' in patch) {
        const url = patch.cloudflareHost ? canonicalUrl(patch.cloudflareHost, true) : '';
        if (patch.cloudflareHost && !url) throw new Error('Use the https hostname configured on your Cloudflare tunnel.');
        settings.cloudflareHost = url || '';
      }
      if ('ngrokToken' in patch) { if (patch.ngrokToken == null || patch.ngrokToken === '') ngrokToken = undefined; else if (!validToken(patch.ngrokToken)) throw new Error('Enter the ngrok authtoken from your ngrok account.'); else ngrokToken = patch.ngrokToken; }
      if ('cloudflareToken' in patch) { if (patch.cloudflareToken == null || patch.cloudflareToken === '') cloudflareToken = undefined; else if (!validToken(patch.cloudflareToken)) throw new Error('Enter the Cloudflare tunnel token from your Cloudflare account.'); else cloudflareToken = patch.cloudflareToken; }
      if ('enabled' in patch) settings.enabled = patch.enabled;
      if ('reach' in patch) settings.reach = patch.reach;
      if (settings.enabled) ensureCode(false);
      await persist(); await apply(); return desktopStatus();
    });
  }
  function clientAddress(req) { return String(req.socket?.remoteAddress || '').replace(/^::ffff:/, ''); }
  function locked(ip) { const row = failures.get(ip); return !!(row && row.until > now()); }
  function failPair(ip) { const row = failures.get(ip) || { count: 0, until: 0 }; row.count += 1; if (row.count >= 8) { row.until = now() + 15 * 60 * 1000; row.count = 0; } failures.set(ip, row); }
  function deviceFor(token) {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(token || '')) return null;
    const hash = Buffer.from(tokenHash(token), 'hex');
    let found = null;
    for (const device of settings.devices) { const stored = Buffer.from(device.hash, 'hex'); if (stored.length === hash.length && timingSafeEqual(stored, hash)) found = device; }
    return found;
  }
  function tokenFrom(req) {
    const header = String(req.headers.authorization || '');
    if (header.startsWith('Bearer ')) return header.slice(7).trim();
    const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)notch_phone=([^;]+)/);
    return cookie ? decodeURIComponent(cookie[1]) : '';
  }
  async function pair(code, agent) {
    await ensure();
    if (!settings.enabled) throw httpError('Turn on phone access on this computer.', 409);
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z2-9]/g, '');
    const current = settings.pairCode && settings.pairExpires > now() && settings.pairUses < 4 && sameText(normalized, settings.pairCode);
    if (!current) throw httpError('That pairing code is not valid. Use the code shown on this computer.', 401);
    if (settings.devices.length >= 6) throw httpError('Remove a phone on this computer before adding another.', 409);
    const token = randomBytes(32).toString('base64url');
    settings.devices.push({ id: randomUUID(), name: deviceName(agent), hash: tokenHash(token), createdAt: new Date(now()).toISOString() });
    settings.pairUses += 1;
    if (settings.pairUses >= 4) ensureCode(true);
    await persist(); notify();
    return token;
  }
  function validId(id) { return typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id); }
  async function newTask() {
    await recall();
    if (!workspace?.cwd) throw httpError('Open a project in notch on this computer first.', 409);
    ensureTasks();
    if ([...tasks.values()].length >= 8) throw httpError('This phone already has eight tasks.', 409);
    const id = `phone-${createHash('sha256').update(`${workspace.cwd}\0${randomUUID()}`).digest('hex').slice(0, 32)}`;
    const model = tasks.get(activeId)?.model || host?.getDefaultModel?.() || 'auto';
    tasks.set(id, blankTask(id, model));
    activeId = id; focus = ''; notify();
    return snapshot();
  }
  async function openTask(id) {
    if (!validId(id)) throw httpError('Choose a task.', 400);
    if (tasks.has(id)) { activeId = id; focus = ''; notify(); return snapshot(); }
    const bag = live.get(id);
    if (bag?.source === 'computer') { focus = id; notify(); return snapshot(); }
    throw httpError('That task is not on this phone.', 404);
  }
  async function chooseModel(key) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:~/-]{1,200}$/.test(key)) throw httpError('Choose a model from this computer.', 400);
    const task = ensureTasks();
    if (!task) throw httpError('Open a project in notch on this computer first.', 409);
    if (focus) throw httpError('The computer task keeps the model already running there.', 409);
    if (taskPhase(task) === 'working') throw httpError('This task is already working. The model stays until it finishes.', 409);
    const row = modelRows().find(item => item.key === key && item.enabled);
    if (!row) throw httpError('Choose an available model from this computer.', 400);
    task.model = row.key; notify();
    return snapshot();
  }
  async function dictate(pcm) {
    if (!host?.voice?.transcribe) throw httpError('Set up speech in notch on this computer first.', 409);
    if (!Buffer.isBuffer(pcm) || pcm.length < 3200 || pcm.length > 480000 || pcm.length % 2) throw httpError('Record a short message and try again.', 400);
    let text = '';
    try { text = await host.voice.transcribe(pcm); }
    catch (error) { throw httpError(error.message || 'Speech could not be read on this computer.', 409); }
    return { text: String(text || '').replace(/\u0000/g, '').slice(0, 4000) };
  }
  async function submit(text, requestedId) {
    await ensure();
    if (!settings.enabled) throw httpError('Turn on phone access on this computer.', 409);
    const body = String(text || '').replace(/\u0000/g, '').trim();
    if (!body || body.length > 8000) throw httpError('Write a message of 8,000 characters or fewer.', 400);
    await recall();
    if (!workspace?.cwd) throw httpError('Open a project in notch on this computer first.', 409);
    ensureTasks();
    const task = requestedId ? tasks.get(requestedId) : tasks.get(activeId);
    if (!task) throw httpError('Choose a task on this phone.', 404);
    activeId = task.id; focus = '';
    const existing = live.get(task.id);
    if (existing && existing.source !== 'phone') throw httpError('This conversation is open on the computer.', 409);
    if (existing?.query.active || (existing && !existing.query.ended && !existing.query.closed)) throw httpError('This task is still working.', 409);
    if (existing) await existing.query.task;
    if (task.id === primaryId() && !task.messages.length) task.messages = await history();
    task.messages.push({ role: 'user', text: body }); historyCache = undefined; notify();
    try {
      host.query({ cwd: workspace.cwd, sessionId: task.id, model: task.model || 'auto', permissionMode: phoneMode(workspace.permissionMode), prompt: body, phoneOrigin: true });
    } catch (error) {
      task.messages.pop();
      task.messages.push({ role: 'error', text: error.message || 'The task could not start.' }); notify();
      throw httpError(error.message || 'The task could not start.', 409);
    }
    return snapshot();
  }
  async function answer(id, behavior, remember) {
    const item = pending.get(id);
    if (!item || item.settled) throw httpError('That approval is no longer waiting.', 409);
    if (behavior !== 'allow' && behavior !== 'deny') throw httpError('Choose allow or deny.', 400);
    item.settled = true;
    item.resolve({ behavior, ...(behavior === 'allow' ? { updatedInput: item.input } : {}), ...(behavior === 'allow' && remember && item.suggestions.length ? { updatedPermissions: item.suggestions } : {}) });
    return snapshot();
  }
  async function stop(target) {
    const bag = target === 'computer'
      ? [...live.values()].find(item => item.source === 'computer' && item.query.active)
      : live.get(activeId);
    if (!bag || (target !== 'computer' && (bag.source !== 'phone' || !bag.query.active))) throw httpError(target === 'computer' ? 'The computer is not working on a task.' : 'This task is not working.', 409);
    await bag.query.interrupt();
    return snapshot();
  }
  function send(res, status, body, extra) {
    const payload = Buffer.from(JSON.stringify(body));
    res.writeHead(status, securityHeaders({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': payload.length, ...extra }));
    res.end(payload);
  }
  async function route(req, res) {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const pathname = url.pathname === '/favicon.ico' ? '/assets/notch-symbol.png' : decodeURIComponent(url.pathname);
      if (pathname.includes('\\') || pathname.includes('\0')) throw httpError('That page is not on this computer.', 404);
      if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) { await sendFile(res, path.join(pageRoot, 'page.html'), 'text/html; charset=utf-8', 'no-store'); return; }
      if (req.method === 'GET' && pathname === '/manifest.webmanifest') return send(res, 200, { name: 'notch', short_name: 'notch', description: 'The notch on this computer.', start_url: '/', scope: '/', display: 'standalone', background_color: '#141416', theme_color: '#141416', icons: [{ src: '/assets/notch-symbol.png', sizes: '192x192', type: 'image/png', purpose: 'any' }] }, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
      if (req.method === 'GET' && pages.has(pathname)) { const [name, type] = pages.get(pathname); await sendFile(res, path.join(pageRoot, name), type, 'no-cache'); return; }
      if (req.method === 'GET' && publicAssets.has(pathname)) { const [name, type] = publicAssets.get(pathname); await sendFile(res, path.join(assetRoot, name), type, 'public, max-age=86400'); return; }
      if (req.method === 'GET' && pathname === '/api/hello') return send(res, 200, { product: 'notch', computer: computerName() });
      if (pathname.startsWith('/api/')) { await api(req, res, pathname); return; }
      throw httpError('That page is not on this computer.', 404);
    } catch (error) { if (!res.headersSent) send(res, error.status || 500, { error: error.status ? error.message : 'Phone access could not finish that request.' }); }
  }
  async function sendFile(res, file, type, cache) {
    const body = await fs.readFile(file);
    res.writeHead(200, securityHeaders({ 'Content-Type': type, 'Cache-Control': cache, 'Content-Length': body.length, ...(file.endsWith('sw.js') ? { 'Service-Worker-Allowed': '/' } : {}) }));
    res.end(body);
  }
  async function api(req, res, pathname) {
    if (req.method === 'POST' && pathname !== '/api/dictate' && (req.headers['x-notch-phone'] !== '1' || !String(req.headers['content-type'] || '').includes('application/json'))) throw httpError('Open notch from the phone page.', 400);
    const ip = clientAddress(req);
    if (req.method === 'POST' && pathname === '/api/pair') {
      if (locked(ip)) throw httpError('Too many pairing attempts. Wait a few minutes, then use the code on this computer.', 429);
      const body = await readJson(req);
      try {
        const token = await pair(body.code, req.headers['user-agent']);
        failures.delete(ip);
        return send(res, 200, { token, computer: computerName() }, { 'Set-Cookie': `notch_phone=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000` });
      } catch (error) { if (error.status === 401) failPair(ip); throw error; }
    }
    if (req.method === 'POST' && pathname === '/api/dictate') {
      if (req.headers['x-notch-phone'] !== '1') throw httpError('Open notch from the phone page.', 400);
      if (!deviceFor(tokenFrom(req))) throw httpError('Pair this phone from the code on your computer.', 401);
      return send(res, 200, await dictate(await readRaw(req, 480000)));
    }
    if (!deviceFor(tokenFrom(req))) throw httpError('Pair this phone from the code on your computer.', 401);
    if (req.method === 'GET' && pathname === '/api/snapshot') return send(res, 200, await snapshot());
    if (req.method === 'GET' && pathname === '/api/stream') return stream(req, res);
    if (req.method !== 'POST') throw httpError('That page is not on this computer.', 404);
    const body = await readJson(req);
    if (pathname === '/api/prompt') return send(res, 200, await submit(body.text, validId(body.task) ? body.task : ''));
    if (pathname === '/api/task') return send(res, 200, body.action === 'new' ? await newTask() : await openTask(body.id));
    if (pathname === '/api/model') return send(res, 200, await chooseModel(body.key));
    if (pathname === '/api/approval') return send(res, 200, await answer(body.id, body.behavior, body.remember === true));
    if (pathname === '/api/stop') return send(res, 200, await stop(body.target === 'computer' ? 'computer' : 'phone'));
    throw httpError('That page is not on this computer.', 404);
  }
  async function stream(req, res) {
    res.writeHead(200, securityHeaders({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' }));
    const controller = new AbortController();
    req.on('close', () => controller.abort());
    const keep = setInterval(() => { if (!res.writableEnded) res.write(':\n\n'); }, 15000);
    let seen = -1;
    try {
      while (!controller.signal.aborted) {
        if (revision === seen) await wait(controller.signal);
        if (controller.signal.aborted) break;
        seen = revision;
        res.write(`data: ${JSON.stringify(await snapshot())}\n\n`);
      }
    } finally { clearInterval(keep); if (!res.writableEnded) res.end(); }
  }
  return {
    note, prepare, attach,
    start: () => enqueue(async () => { try { await apply(); } catch { /* The desktop status explains a port or settings failure. */ } }),
    close: () => enqueue(async () => { clearTimeout(notifyTimer); tunnelGeneration++; stopChild(); tunnelSignature = ''; for (const wake of waiters.splice(0)) wake(); await closeServer(); }),
    status: desktopStatus,
    update, rotate: () => enqueue(async () => { ensureCode(true); await persist(); notify(); return desktopStatus(); }),
    revoke: id => enqueue(async () => { if (typeof id !== 'string' || !settings.devices.some(device => device.id === id)) throw new Error('Choose a paired phone to remove.'); settings.devices = settings.devices.filter(device => device.id !== id); await persist(); notify(); return desktopStatus(); }),
    snapshot,
  };
}
