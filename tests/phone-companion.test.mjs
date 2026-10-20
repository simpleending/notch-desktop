import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createHost } from '../src/notch-host.mjs';
import { createPhoneCompanion, formatPairCode, installPhoneAssets, networkAddresses, validReachUrl } from '../src/phone-companion.mjs';
import { renderPairingQr } from '../src/phone-qr.mjs';
import { patchModelPreload } from '../src/model-ipc.mjs';

const storage = { isAsyncEncryptionAvailable: async () => true, getSelectedStorageBackend: () => 'test', encryptStringAsync: async value => Buffer.from(String(value).split('').reverse().join('')), decryptStringAsync: async bytes => ({ result: bytes.toString().split('').reverse().join('') }) };
const interfaces = () => ({ WiFi: [{ address: '192.168.4.20', family: 'IPv4', internal: false }, { address: '127.0.0.1', family: 'IPv4', internal: true }], Tailscale: [{ address: '100.64.8.8', family: 'IPv4', internal: false }], Ethernet: [{ address: '10.0.0.4', family: 'IPv4', internal: false }] });

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => { child.killed = true; child.emit('exit', 0); }; child.killed = false;
  return child;
}
async function boot(runTurn, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-phone-'));
  const project = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-phone-project-'));
  const host = createHost(root, { runTurn, hardware: async () => ({ bytes: 1 }) });
  host.resolveModelChoice = model => !model || model === 'auto' ? 'ollama/fixture' : model;
  host.listModels = async () => [{ key: 'ollama/fixture', enabled: true, displayName: 'Fixture' }];
  host.getCachedModels = () => [{ key: 'ollama/fixture', enabled: true, displayName: 'Fixture' }];
  host.getDefaultModel = () => 'ollama/fixture';
  const phone = createPhoneCompanion(root, { host, safeStorage: storage, interfaces, port: 0, ...options });
  host.phone = phone;
  return { root, project, host, phone };
}
const header = token => ({ 'content-type': 'application/json', 'x-notch-phone': '1', ...(token ? { authorization: `Bearer ${token}` } : {}) });
async function base(phone) { const status = await phone.status(); return `http://127.0.0.1:${status.port}`; }

test('network addresses prefer this Wi-Fi and keep Tailscale separate', () => {
  const nets = networkAddresses(interfaces());
  assert.deepEqual(nets.lan, ['192.168.4.20', '10.0.0.4']);
  assert.deepEqual(nets.tailscale, ['100.64.8.8']);
  assert.equal(validReachUrl('https://phone.example.com'), true);
  assert.equal(validReachUrl('http://100.64.8.8:47321'), true);
  assert.equal(validReachUrl('http://my-pc.tailnet.ts.net:47321'), true);
  assert.equal(validReachUrl('http://example.com'), false);
  assert.equal(validReachUrl('https://user:pass@phone.example.com'), false);
  assert.equal(formatPairCode('ABCD2345'), 'ABCD · 2345');
});

test('pairing code image is a local SVG and does not echo the address as markup', () => {
  const svg = renderPairingQr('http://192.168.4.20:47321/#pair=ABCD2345');
  assert.match(svg, /^<svg/);
  assert.doesNotMatch(svg, /<script|192\.168/);
  assert.notEqual(svg, renderPairingQr('http://192.168.4.20:47321/#pair=ZZZZ9999'));
});

test('the phone page uses the desktop palette, wordmark and home-screen install', async () => {
  const { root, phone } = await boot(async turn => ({ status: 'completed', text: 'ok', messages: turn.messages, iterations: 1 }));
  try {
    await phone.update({ enabled: true });
    const origin = await base(phone);
    const page = await (await fetch(origin)).text();
    const css = await (await fetch(`${origin}/phone.css`)).text();
    const script = await (await fetch(`${origin}/phone.js`)).text();
      assert.match(script, /^function uiMessage\(/);
      assert.doesNotThrow(() => new Function(script));
    const manifest = await (await fetch(`${origin}/manifest.webmanifest`)).json();
    const wordmark = await (await fetch(`${origin}/assets/notch-wordmark-dark.svg`)).text();
    const hello = await (await fetch(`${origin}/api/hello`)).json();
    assert.match(page, /apple-mobile-web-app-title" content="notch"/);
    assert.match(css, /#18181b/); assert.match(css, /#dab5d1/); assert.match(css, /Manrope/);
    assert.match(script, /notch-wordmark-dark\.svg/); assert.match(script, /Home Screen/); assert.match(script, /freesyntax\.dev/);
    assert.match(script, /System appearance/); assert.match(script, /menu-scrim/);
    assert.match(script, /TASK/); assert.doesNotMatch(script, /FOLDER/);
    assert.match(script, /Rename/); assert.match(script, /Archive/);
    assert.match(script, /Ask a question, or describe a change/);
    assert.doesNotMatch(script, /project-name', id: 'project-name' \}, snapshot\.project/);
    assert.match(script, /ACCESS/); assert.doesNotMatch(script, /this phone asks before files change/);
    assert.doesNotMatch(script, /innerHTML/);
    assert.equal(manifest.display, 'standalone'); assert.equal(manifest.name, 'notch');
    assert.match(wordmark, /<svg/);
    assert.equal(hello.product, 'notch'); assert.equal(hello.project, undefined);
    assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
    assert.equal((await fetch(`${origin}/assets/%2e%2e/phone-access.json`)).status, 404);
  } finally { await phone.close(); await fs.rm(root, { recursive: true, force: true }); }
});

test('a paired phone can ask, approve, and cannot take full access from the computer', async () => {
  let accessMode;
  const { root, project, host, phone } = await boot(async turn => {
    accessMode = turn.accessMode;
    const allowed = await turn.approve('write', { path: 'note.txt', content: 'hello from phone', apiKey: 'secret-token' }, '', 'call-phone');
    turn.onText(allowed ? 'Saved note.txt' : 'Denied');
    return { status: allowed ? 'completed' : 'cancelled', text: allowed ? 'Saved note.txt' : 'Denied', messages: [...turn.messages, { role: 'assistant', content: allowed ? 'Saved note.txt' : 'Denied' }], iterations: 1 };
  });
  try {
    await phone.update({ enabled: true });
    await host.prepare({ cwd: project, model: 'ollama/fixture', permissionMode: 'bypassPermissions' });
    const origin = await base(phone);
    const status = await phone.status();
    assert.match(status.pairUrl, /192\.168\.4\.20/); assert.match(status.qr, /^<svg/); assert.equal(status.pairLabel, formatPairCode(status.pairCode));
    const refused = await fetch(`${origin}/api/pair`, { method: 'POST', headers: header(), body: JSON.stringify({ code: 'WRONG123' }) });
    assert.equal(refused.status, 401);
    const paired = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { ...header(), 'user-agent': 'Mozilla/5.0 (iPhone)' }, body: JSON.stringify({ code: status.pairCode }) });
    const token = (await paired.json()).token;
    assert.equal(paired.status, 200); assert.match(paired.headers.get('set-cookie'), /HttpOnly/);
    const replay = await fetch(`${origin}/api/pair`, { method: 'POST', headers: header(), body: JSON.stringify({ code: status.pairCode }) });
    assert.equal(replay.status, 200);
    const started = await fetch(`${origin}/api/prompt`, { method: 'POST', headers: header(token), body: JSON.stringify({ text: 'Write a note' }) });
    assert.equal(started.status, 200);
    let pending;
    for (let attempt = 0; attempt < 40 && !pending?.length; attempt++) { pending = (await (await fetch(`${origin}/api/snapshot`, { headers: header(token) })).json()).pending; if (!pending?.length) await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(pending[0].title, 'Write · note.txt');
    assert.match(pending[0].detail, /hello from phone/); assert.match(pending[0].detail, /apiKey: hidden/); assert.doesNotMatch(pending[0].detail, /secret-token/);
    const allowed = await fetch(`${origin}/api/approval`, { method: 'POST', headers: header(token), body: JSON.stringify({ id: pending[0].id, behavior: 'allow' }) });
    assert.equal(allowed.status, 200);
    let done;
    for (let attempt = 0; attempt < 40 && !done; attempt++) { const body = await (await fetch(`${origin}/api/snapshot`, { headers: header(token) })).json(); done = body.messages.some(message => message.text === 'Saved note.txt'); if (!done) await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(done, true); assert.equal(accessMode, 'approve');
    const desktop = await phone.status();
    assert.equal(desktop.devices[0].name, 'iPhone');
    await phone.revoke(desktop.devices[0].id);
    assert.equal((await fetch(`${origin}/api/snapshot`, { headers: header(token) })).status, 401);
    const fresh = await (await fetch(`${origin}/api/pair`, { method: 'POST', headers: header(), body: JSON.stringify({ code: (await phone.status()).pairCode }) })).json();
    assert.equal((await fetch(`${origin}/api/prompt`, { method: 'POST', headers: header(fresh.token), body: JSON.stringify({ text: 'x'.repeat(8001) }) })).status, 400);
  } finally { await phone.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(project, { recursive: true, force: true }); }
});

test('the computer and the phone can approve the same action, and the first choice wins', async () => {
  let releaseDesktop;
  const desktopAllows = new Promise(resolve => { releaseDesktop = resolve; });
  let result;
  const { root, project, host, phone } = await boot(async turn => {
    result = await turn.approve('shell', { command: 'echo hi' }, '', 'call-desktop');
    return { status: result ? 'completed' : 'cancelled', text: result ? 'Ran' : 'Stopped', messages: turn.messages, iterations: 1 };
  });
  try {
    await phone.update({ enabled: true });
    await host.prepare({ cwd: project, model: 'ollama/fixture' });
    const origin = await base(phone);
    const token = (await (await fetch(`${origin}/api/pair`, { method: 'POST', headers: header(), body: JSON.stringify({ code: (await phone.status()).pairCode }) })).json()).token;
    const query = host.query({ cwd: project, sessionId: 'desktop-chat', model: 'ollama/fixture', permissionMode: 'default', prompt: 'Run it', canUseTool: () => desktopAllows.then(() => ({ behavior: 'deny' })) });
    const reading = (async () => { for await (const _event of query) void _event; })();
    let pending;
    for (let attempt = 0; attempt < 40 && !pending?.length; attempt++) { pending = (await (await fetch(`${origin}/api/snapshot`, { headers: header(token) })).json()).pending; if (!pending?.length) await new Promise(resolve => setTimeout(resolve, 25)); }
    assert.equal(pending[0].source, 'computer');
    assert.equal((await fetch(`${origin}/api/approval`, { method: 'POST', headers: header(token), body: JSON.stringify({ id: pending[0].id, behavior: 'allow' }) })).status, 200);
    releaseDesktop();
    await query.task; await reading;
    assert.equal(result, true);
    assert.equal((await (await fetch(`${origin}/api/snapshot`, { headers: header(token) })).json()).pending.length, 0);
  } finally { await phone.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(project, { recursive: true, force: true }); }
});

test('away-from-home keys stay encrypted and out of the phone status', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-phone-key-'));
  const spawned = [];
  const child = fakeChild();
  try {
    const phone = createPhoneCompanion(root, { safeStorage: storage, interfaces, port: 0, spawn: (command, args, options) => { spawned.push({ command, args, env: options.env }); return child; }, fetcher: async () => ({ ok: true, json: async () => ({ tunnels: [{ proto: 'https', public_url: 'https://people.ngrok.app' }] }) }) });
    await phone.update({ enabled: true, reach: 'ngrok', ngrokToken: 'ngrok-user-token' });
    child.stderr.emit('data', Buffer.from('using authtoken ngrok-user-token\n'));
    const status = await phone.status();
    assert.equal(status.hasNgrokKey, true); assert.equal(status.persistentKey, true);
    assert.equal(spawned[0].command, 'ngrok'); assert.deepEqual(spawned[0].args, ['http', String(status.port), '--log', 'stdout']);
    assert.equal(spawned[0].env.NGROK_AUTHTOKEN, 'ngrok-user-token'); assert.equal(spawned[0].args.includes('ngrok-user-token'), false);
    const raw = await fs.readFile(path.join(root, 'phone-access.json'), 'utf8');
    assert.equal(raw.includes('ngrok-user-token'), false);
    assert.equal(JSON.stringify(status).includes('ngrok-user-token'), false);
    for (let attempt = 0; attempt < 20 && (await phone.status()).tunnel.state !== 'ready'; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await phone.status()).tunnel.url, 'https://people.ngrok.app');
    assert.match((await phone.status()).pairUrl, /https:\/\/people\.ngrok\.app\/#pair=/);
    await assert.rejects(phone.update({ publicUrl: 'http://example.com' }), /https address/);
    await phone.update({ reach: 'address', publicUrl: 'http://my-pc.tailnet.ts.net:47321' });
    assert.equal((await phone.status()).url, 'http://my-pc.tailnet.ts.net:47321');
    const restarted = createPhoneCompanion(root, { safeStorage: storage, interfaces, port: 0, spawn: () => fakeChild(), fetcher: async () => ({ ok: false }) });
    assert.equal((await restarted.status()).hasNgrokKey, true);
    await restarted.update({ ngrokToken: null, enabled: false });
    assert.equal((await createPhoneCompanion(root, { safeStorage: storage, interfaces, port: 0 }).status()).hasNgrokKey, false);
    await phone.close(); await restarted.close();
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('eight wrong codes lock pairing, and phone assets install beside the packaged app', async () => {
  const { root, phone } = await boot(async turn => ({ status: 'completed', text: 'ok', messages: turn.messages, iterations: 1 }));
  const target = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-phone-assets-'));
  try {
    await phone.update({ enabled: true });
    const origin = await base(phone);
    for (let attempt = 0; attempt < 8; attempt++) assert.equal((await fetch(`${origin}/api/pair`, { method: 'POST', headers: header(), body: JSON.stringify({ code: 'NOPE1234' }) })).status, 401);
    assert.equal((await fetch(`${origin}/api/pair`, { method: 'POST', headers: header(), body: JSON.stringify({ code: (await phone.status()).pairCode }) })).status, 429);
    await installPhoneAssets(path.join(import.meta.dirname, '..'), target);
    assert.match(await fs.readFile(path.join(target, 'notch-wordmark-dark.svg'), 'utf8'), /<svg/);
    await fs.access(path.join(target, 'fonts', 'Manrope.ttf'));
    const bridge = patchModelPreload('');
    assert.match(bridge, /phone:\(action,value\)=>/);
    assert.equal(patchModelPreload(bridge), bridge);
  } finally { await phone.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(target, { recursive: true, force: true }); }
});

test('phone access is chosen in the menu and does not copy full access from the computer', async () => {
  const modes = [];
  let release = () => {};
  let gate = Promise.resolve();
  const { root, project, host, phone } = await boot(async turn => {
    modes.push(turn.accessMode);
    await gate;
    return { status: 'completed', text: 'done', messages: [...turn.messages, { role: 'assistant', content: 'done' }], iterations: 1 };
  });
  try {
    await phone.update({ enabled: true });
    await host.prepare({ cwd: project, model: 'ollama/fixture', permissionMode: 'bypassPermissions' });
    const origin = await base(phone);
    const token = (await (await fetch(`${origin}/api/pair`, { method: 'POST', headers: header(), body: JSON.stringify({ code: (await phone.status()).pairCode }) })).json()).token;
    const before = await (await fetch(`${origin}/api/snapshot`, { headers: header(token) })).json();
    assert.equal(before.project, path.basename(project));
    assert.equal(before.access, 'ask');
    assert.equal(before.accessShort, 'Ask');
    assert.deepEqual(before.accessChoices.map(item => item.key), ['ask', 'read', 'full']);
    gate = new Promise(resolve => { release = resolve; });
    assert.equal((await fetch(`${origin}/api/access`, { method: 'POST', headers: header(token), body: JSON.stringify({ mode: 'full' }) })).status, 200);
    assert.equal((await fetch(`${origin}/api/prompt`, { method: 'POST', headers: header(token), body: JSON.stringify({ text: 'Edit it' }) })).status, 200);
    for (let attempt = 0; attempt < 40 && !modes.length; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(modes[0], 'full-access');
    const locked = await fetch(`${origin}/api/access`, { method: 'POST', headers: header(token), body: JSON.stringify({ mode: 'read' }) });
    assert.equal(locked.status, 409);
    release();
    for (let attempt = 0; attempt < 40; attempt++) {
      const body = await (await fetch(`${origin}/api/snapshot`, { headers: header(token) })).json();
      if (body.tasks.some(task => task.current && task.phase === 'ready')) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const created = await (await fetch(`${origin}/api/task`, { method: 'POST', headers: header(token), body: JSON.stringify({ action: 'new' }) })).json();
    assert.equal(created.access, 'full');
    const read = await (await fetch(`${origin}/api/access`, { method: 'POST', headers: header(token), body: JSON.stringify({ mode: 'read' }) })).json();
    assert.equal(read.access, 'read');
    assert.equal(read.accessLabel, 'Read only');
    assert.equal((await fetch(`${origin}/api/access`, { method: 'POST', headers: header(token), body: JSON.stringify({ mode: 'yolo' }) })).status, 400);
    gate = new Promise(resolve => { release = resolve; });
    assert.equal((await fetch(`${origin}/api/prompt`, { method: 'POST', headers: header(token), body: JSON.stringify({ text: 'Look around' }) })).status, 200);
    for (let attempt = 0; attempt < 40 && modes.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(modes[1], 'read-only');
    release();
  } finally { release(); await phone.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(project, { recursive: true, force: true }); }
});

test('phone and computer tasks can be renamed and archived from the phone', async () => {
  const sessions = [{ sessionId: 'desktop-lights', title: 'Lights', cwd: '', archived: false, updatedAt: 5, model: 'ollama/fixture' }];
  const { root, project, host, phone } = await boot(async turn => ({ status: 'completed', text: 'done', messages: turn.messages, iterations: 1 }));
  sessions[0].cwd = project;
  host.chatSessions = {
    async listSessions() { return sessions.filter(row => !row.archived); },
    async rename(id, title) {
      const row = sessions.find(item => item.sessionId === id);
      if (!row) throw new Error('This session is not registered in notch.');
      row.title = title;
    },
    async archive(id) {
      const row = sessions.find(item => item.sessionId === id);
      if (!row || row.archived) throw new Error('This session is not registered in notch.');
      row.archived = true;
    },
  };
  try {
    await phone.update({ enabled: true });
    await host.prepare({ cwd: project, model: 'ollama/fixture' });
    const origin = await base(phone);
    const token = (await (await fetch(`${origin}/api/pair`, { method: 'POST', headers: header(), body: JSON.stringify({ code: (await phone.status()).pairCode }) })).json()).token;
    const first = await (await fetch(`${origin}/api/snapshot`, { headers: header(token) })).json();
    assert.notEqual(first.taskTitle, path.basename(project));
    assert.equal(first.taskTitle, 'New task');
    assert.equal(first.tasks.find(task => task.source === 'computer').title, 'Lights');
    const phoneId = first.tasks.find(task => task.source === 'phone').id;
    assert.equal((await fetch(`${origin}/api/task`, { method: 'POST', headers: header(token), body: JSON.stringify({ action: 'rename', id: phoneId, title: '   ' }) })).status, 400);
    const renamed = await (await fetch(`${origin}/api/task`, { method: 'POST', headers: header(token), body: JSON.stringify({ action: 'rename', id: phoneId, title: '  Evening rounds  ' }) })).json();
    assert.equal(renamed.taskTitle, 'Evening rounds');
    const catalog = JSON.parse(await fs.readFile(path.join(root, 'phone-task-catalog.json'), 'utf8'));
    assert.equal(catalog.titles[phoneId], 'Evening rounds');
    const opened = await (await fetch(`${origin}/api/task`, { method: 'POST', headers: header(token), body: JSON.stringify({ action: 'open', id: 'desktop-lights' }) })).json();
    assert.equal(opened.task, 'desktop-lights');
    assert.equal(opened.taskTitle, 'Lights');
    assert.equal(opened.composer, 'computer');
    const computerNamed = await (await fetch(`${origin}/api/task`, { method: 'POST', headers: header(token), body: JSON.stringify({ action: 'rename', id: 'desktop-lights', title: 'Kitchen' }) })).json();
    assert.equal(computerNamed.taskTitle, 'Kitchen');
    assert.equal(sessions[0].title, 'Kitchen');
    const archivedComputer = await (await fetch(`${origin}/api/task`, { method: 'POST', headers: header(token), body: JSON.stringify({ action: 'archive', id: 'desktop-lights' }) })).json();
    assert.equal(sessions[0].archived, true);
    assert.equal(archivedComputer.tasks.some(task => task.id === 'desktop-lights'), false);
    const archivedPhone = await (await fetch(`${origin}/api/task`, { method: 'POST', headers: header(token), body: JSON.stringify({ action: 'archive', id: phoneId }) })).json();
    assert.equal(archivedPhone.tasks.some(task => task.id === phoneId), false);
    assert.notEqual(archivedPhone.taskTitle, path.basename(project));
    await phone.close();
    const next = createPhoneCompanion(root, { host, safeStorage: storage, interfaces, port: 0 });
    host.phone = next;
    try {
      await next.update({ enabled: true });
      await host.prepare({ cwd: project, model: 'ollama/fixture' });
      const restored = await next.snapshot();
      assert.equal(restored.tasks.some(task => task.id === phoneId), false);
      assert.equal(restored.tasks.some(task => task.id === 'desktop-lights'), false);
    } finally { await next.close(); }
  } finally { await phone.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(project, { recursive: true, force: true }); }
});

test('phone tasks keep their own model, and dictation stays on this computer', async () => {
  let seenModel;
  const { root, project, host, phone } = await boot(async turn => { seenModel = turn.model; return { status: 'completed', text: 'done', messages: turn.messages, iterations: 1 }; });
  host.getCachedModels = () => [{ key: 'ollama/fixture', enabled: true, displayName: 'Local model', provider: 'ollama' }, { key: 'ollama/other', enabled: true, displayName: 'Other local', provider: 'ollama' }, { key: 'openrouter/lab/coder', enabled: true, displayName: 'Cloud coder', provider: 'openrouter' }];
  host.modelManager = { getWorkspaceMode: async () => 'isolated' };
  host.voice = { status: async () => ({ ready: true, stt: { name: 'Cactus Whistle' } }), transcribe: async pcm => pcm.length > 1000 ? 'lights off' : '' };
  try {
    await phone.update({ enabled: true });
    await host.prepare({ cwd: project, model: 'ollama/fixture' });
    const origin = await base(phone);
    const token = (await (await fetch(`${origin}/api/pair`, { method: 'POST', headers: header(), body: JSON.stringify({ code: (await phone.status()).pairCode }) })).json()).token;
    const first = await (await fetch(`${origin}/api/snapshot`, { headers: header(token) })).json();
    assert.equal(first.workspaceMode, 'isolated');
    assert.equal(first.voice.name, 'Cactus Whistle');
    assert.equal(first.models.some(model => model.key === 'openrouter/lab/coder'), true);
    const created = await (await fetch(`${origin}/api/task`, { method: 'POST', headers: header(token), body: JSON.stringify({ action: 'new' }) })).json();
    assert.equal(created.tasks.filter(task => task.source === 'phone').length, 2);
    assert.equal((await fetch(`${origin}/api/model`, { method: 'POST', headers: header(token), body: JSON.stringify({ key: 'ollama/other' }) })).status, 200);
    const sent = await (await fetch(`${origin}/api/prompt`, { method: 'POST', headers: header(token), body: JSON.stringify({ text: 'Run the cloud task' }) })).json();
    for (let attempt = 0; attempt < 40 && seenModel !== 'ollama/other'; attempt++) await new Promise(resolve => setTimeout(resolve, 25));
    assert.equal(seenModel, 'ollama/other');
    assert.equal(sent.tasks.find(task => task.current).title, 'Run the cloud task');
    const speech = await fetch(`${origin}/api/dictate`, { method: 'POST', headers: { ...header(token), 'content-type': 'application/octet-stream' }, body: Buffer.alloc(4000) });
    assert.equal((await speech.json()).text, 'lights off');
    const page = await (await fetch(`${origin}/phone.js`)).text();
    assert.match(page, /TASKS/); assert.match(page, /MODEL/); assert.match(page, /ACCESS/); assert.match(page, /VOICE/);
  } finally { await phone.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(project, { recursive: true, force: true }); }
});
