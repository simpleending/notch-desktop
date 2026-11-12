import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { connectDesktopMcp } from '../vendor/notch-core/desktop-harness.js';
import { createKnowledge } from '../src/knowledge.mjs';
import { createEngineUpdates } from '../src/engine-updates.mjs';
import { createAutomationBackground, revealAutomation } from '../src/automation-background.mjs';
import { createAutomationEvents, normalizeWatchFiles } from '../src/automation-events.mjs';
import { openRouterTaskContext, withTaskWorkspace } from '../vendor/notch-core/desktop-harness.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
const { openLibrary } = createRequire(import.meta.url)('../src/local-features.cjs');
async function folder(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-features-')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }

test('agent knowledge search reads the same persisted library, with bounds and literal queries', async t => {
  const directory = await folder(t), search = createKnowledge(directory);
  assert.deepEqual(await search({}), { documents: [] });
  const library = openLibrary(path.join(directory, 'app-plugin-data', 'notch.knowledge.center'));
  const note = library.save({ title: 'Qwen references', body: 'Original source '.repeat(3000) }); library.close();
  assert.equal((await search({ query: 'qwen' })).documents[0].id, note.id);
  assert.equal((await search({ id: note.id })).document.body.length, 24000);
  assert.equal((await search({ id: note.id })).document.truncated, 1);
  assert.equal((await search({ query: "' OR 1=1 --" })).documents.length, 0);
  await assert.rejects(search({ id: '../outside' }), /valid knowledge/);
});

test('desktop MCP discovers and calls a real stdio server without leaking tools into other workspaces', async t => {
  const directory = await folder(t), server = path.join(directory, 'server.cjs');
  await fs.writeFile(server, `const readline=require('node:readline');readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Echo input',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}:{content:[{type:'text',text:m.params.arguments.text}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  await fs.writeFile(path.join(directory, '.notch.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [server] } } }));
  let approved = 0;
  const connection = await connectDesktopMcp({ cwd: directory, signal: new AbortController().signal, approve: async () => { approved++; return true; } });
  try {
    assert.equal(approved, 1); assert.equal(connection.status[0].status, 'connected');
    assert.equal(connection.tools[0].name, 'mcp__fixture__echo');
    assert.deepEqual(await connection.tools[0].execute({ text: 'actual result' }, {}), { content: 'actual result' });
    const other = await connectDesktopMcp({ cwd: await folder(t), signal: new AbortController().signal, approve: async () => true });
    assert.equal(other.tools.length, 0); await other.close();
    const denied = await connectDesktopMcp({ cwd: directory, signal: new AbortController().signal, approve: async () => false });
    assert.equal(denied.tools.length, 0); assert.equal(denied.status[0].status, 'disabled'); await denied.close();
  } finally { await connection.close(); }
});

test('workbench in-process MCP servers use protocol discovery, preserve tool failures and close on abort', async t => {
  const abort = new AbortController(); let closed = false;
  const instance = new McpServer({name:'test',version:'1'});
  instance.registerTool('read',{description:'Read',inputSchema:{}},async()=>({isError:true,content:[{type:'text',text:'Missing document'}]}));
  instance.server.onclose=()=>{closed=true;};
  const connection = await connectDesktopMcp({ cwd: await folder(t), servers: { internal: { type: 'sdk', instance } }, signal: abort.signal, approve: async () => { throw Error('SDK servers are enabled by the workbench'); } });
  assert.equal(connection.tools.length, 1); assert.equal((await connection.tools[0].execute({}, {})).isError, true);
  abort.abort(); await new Promise(resolve=>setImmediate(resolve)); assert.equal(closed, true); connection.close();
});

test('desktop remote MCP completes one handshake and retains HTTP session headers', async t => {
  const seen=[];
  const server=http.createServer(async(req,res)=>{
    if(req.method==='DELETE'){res.writeHead(204).end();return;}
    if(req.method==='GET'){res.writeHead(405).end();return;}
    let raw='';for await(const chunk of req)raw+=chunk;
    const message=JSON.parse(raw);seen.push({method:message.method,headers:req.headers});
    if(message.id===undefined){res.writeHead(202).end();return;}
    res.setHeader('Content-Type','application/json');res.setHeader('Mcp-Session-Id','fixture-session');
    const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'http-fixture',version:'1'}}:message.method==='tools/list'?{tools:[{name:'echo',description:'Echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'REMOTE_OK'}]};
    res.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const connection=await connectDesktopMcp({cwd:await folder(t),servers:{remote:{url:`http://127.0.0.1:${server.address().port}/mcp`,headers:{Authorization:'Bearer fixture-only'}}},signal:new AbortController().signal,approve:async()=>true});
  try{
    assert.equal(connection.status[0].status,'connected');assert.equal((await connection.tools[0].execute({},{})).content,'REMOTE_OK');
    assert.equal(seen.filter(row=>row.method==='initialize').length,1);
    for(const row of seen.filter(row=>row.method!=='initialize'))assert.equal(row.headers['mcp-session-id'],'fixture-session');
    assert(seen.every(row=>row.headers.authorization==='Bearer fixture-only'));
  }finally{await connection.close();}
});

test('engine polling caches checks, ignores prereleases and keeps existing runtime available offline', async t => {
  let calls = 0, fail = false, now = 1800000000000;
  const directory = await folder(t), updates = createEngineUpdates(directory, { now: () => now, fetcher: async () => { calls++; if (fail) throw Error('offline'); return { ok: true, json: async () => ({ tag_name: 'v99.0.0' }) }; } });
  await Promise.all([updates.check(), updates.check()]); assert.equal(calls, 2);
  assert.equal((await updates.status('colibri')).available, true);
  await updates.check(); assert.equal(calls, 2);
  fail = true; now += 86400001; await updates.check(); assert.equal(calls, 4);
  const state = await updates.status('strata'); assert.match(state.error, /installed engine remains available/); assert.equal(state.latest, '99.0.0');
  const rejected = createEngineUpdates(await folder(t), { fetcher: async () => ({ ok: true, json: async () => ({ tag_name: 'v100.0.0', prerelease: true }) }) });
  await rejected.check(); assert.equal((await rejected.status('colibri')).available, false);
});

test('background mode persists, only hides the primary window, and respects explicit quit', async t => {
  const app = new EventEmitter(), window = new EventEmitter(); let hidden = 0, destroyed = 0;
  Object.assign(app, { getFileIcon: async () => ({}), quit() { app.emit('before-quit'); } });
  Object.assign(window, { isDestroyed: () => false, isMinimized: () => false, webContents: { getURL: () => 'file:///index.html' }, hide: () => hidden++, show() {}, focus() {} });
  class Tray extends EventEmitter { setToolTip() {} setContextMenu(menu) { this.menu = menu; } destroy() { destroyed++; } }
  const directory = await folder(t), background = createAutomationBackground({ app, BrowserWindow: { getAllWindows: () => [window] }, Tray, Menu: { buildFromTemplate: x => x }, directory });
  await background.start(); app.emit('browser-window-created', {}, window);
  let prevented = 0; const event = { preventDefault: () => prevented++ };
  window.emit('close', event); assert.equal(prevented, 0);
  await background.settings(true); window.emit('close', event); assert.equal(hidden, 1); assert.equal(prevented, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'automation-background.json'))).enabled, true);
  app.quit(); window.emit('close', event); assert.equal(prevented, 1); app.emit('will-quit'); assert.equal(destroyed, 1);
});

test('automation notification opens its exact chat and rejects invalid session ids', async () => {
  let source;
  const BrowserWindow = { getAllWindows: () => [{ isDestroyed: () => false, isMinimized: () => false, show() {}, focus() {}, webContents: { getURL: () => 'file:///index.html', executeJavaScript: async value => { source = value; } } }] };
  await revealAutomation(BrowserWindow, 'session-123'); assert.match(source, /openChatSession\("session-123"\)/); assert.match(source, /location.hash/);
  source = undefined; await revealAutomation(BrowserWindow, "';alert(1)"); assert.equal(source, undefined);
});

test('file triggers group changes, suppress active runs and cooldown, and detach at shutdown', async t => {
  const file = path.join(await folder(t), 'README.md'); let listener, runs = 0, eligible = true, now = 100000, detached = 0;
  const events = createAutomationEvents({ now: () => now, eligible: () => eligible, run: async () => { runs++; }, watch: (_file, _options, callback) => { listener = callback; }, unwatch: () => { detached++; } });
  assert.throws(() => normalizeWatchFiles(['../outside']), /absolute/);
  events.set('task', [file, file]);
  listener({ mtimeMs: 2, size: 1 }, { mtimeMs: 1, size: 1 }); listener({ mtimeMs: 3, size: 1 }, { mtimeMs: 2, size: 1 });
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(runs, 1);
  listener({ mtimeMs: 4, size: 1 }, { mtimeMs: 3, size: 1 });
  now += 60001; eligible = false; listener({ mtimeMs: 5, size: 1 }, { mtimeMs: 4, size: 1 });
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(runs, 1);
  eligible = true; listener({ mtimeMs: 6, size: 1 }, { mtimeMs: 5, size: 1 }); events.close();
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(runs, 1); assert.equal(detached, 1);
});

test('local models really run in a private Git checkout when isolation is selected', async t => {
  const cwd = await folder(t), exec = promisify(execFile);
  await exec('git', ['init', '-q'], { cwd, windowsHide: true });
  await fs.writeFile(path.join(cwd, 'note.txt'), 'original');
  await exec('git', ['add', 'note.txt'], { cwd, windowsHide: true });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture'], { cwd, windowsHide: true });
  for (const provider of ['ollama', 'colibri', 'strata']) {
    const ctx = openRouterTaskContext({ cwd, workspaceMode: () => 'isolated', permissionSessionId: 'isolation-' + provider, accessMode: 'full-access', log() {} }, { provider });
    await withTaskWorkspace(ctx, async child => {
      assert.notEqual(child.cwd, cwd); assert(child.taskWorkspace);
      await fs.writeFile(path.join(child.cwd, 'note.txt'), provider);
      assert.notEqual(await fs.readFile(path.join(cwd, 'note.txt'), 'utf8'), provider);
      return { status: 'completed' };
    });
    assert.equal(await fs.readFile(path.join(cwd, 'note.txt'), 'utf8'), provider);
  }
});
