import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { uiMessage } from '../src/ui-messages.mjs';
import { patchUiMessages, assertProductMessages } from '../src/ui-message-patch.mjs';
import { assertEnglishCatalogs, verifyProductMessages } from '../src/ui-message-verification.mjs';
import { patchEnglishRenderer } from '../src/english-renderer-patch.mjs';
import os from 'node:os';
import path from 'node:path';

test('product errors explain known codes, including Electron envelopes and OS diagnostics', () => {
  for (const value of ['APP_PLUGIN_PERMISSION_DENIED', "Error invoking remote method 'plugin:call': Error: APP_PLUGIN_PERMISSION_DENIED", new Error('APP_PLUGIN_PERMISSION_DENIED')]) {
    assert.match(uiMessage(value), /plugin.*permission.*Review its permissions/);
  }
  assert.match(uiMessage('ENOENT: no such file or directory, open C:\\project\\test.txt'), /file or program could not be found/);
  assert.match(uiMessage({ message: 'SSH_AUTHENTICATION_FAILED', code: 'unchanged' }), /SSH sign-in failed/);
  assert.match(uiMessage('fetch failed'), /Check your connection/);
  assert.equal(uiMessage('AbortError'), 'The action was cancelled.');
});

test('unknown codes, missing translations, structured failures and non-English diagnostics get readable fallbacks', () => {
  for (const value of ['IDE_PULL_OK', 'UNKNOWN', 'SOME_NEW_ERROR: details', 'Failed: APP_PLUGIN_FUTURE_ERROR', 'not_found', 'permission-denied', 'fileNotFound', 'settings.errors.missingKey', '文件不可用。', '{"error":"raw"}', 'HTTP 400: {"error":"invalid_request"}', 'TypeError: bad access', 'TypeError: bad access\n    at worker:23', "No handler registered for 'private:method'", 'Cannot read properties of undefined', '[object Object]']) {
    assert.equal(uiMessage(value, 'The project could not be opened. Try again.'), 'The project could not be opened. Try again.', value);
  }
});

test('English guidance, useful identifiers, empty states and React elements remain usable', () => {
  for (const value of ['Remove GH_TOKEN and GITHUB_TOKEN before signing in.', 'Open AGENTS.md in C:\\my_project.', 'Open C:\\MY_PROJECT\\SOURCE_CODE.ts.', 'Open C:\\项目\\file.ts.', 'package.json', 'Downloaded 12 of 24 MB.', 'Install Node.js 22 or later.', 'Save or discard your changes first.', '']) assert.equal(uiMessage(value), value);
  assert.equal(uiMessage(null), null);
  const element = { type: 'strong', props: { children: 'A custom notification' } };
  assert.equal(uiMessage(element), element);
  const error = new Error('GIT_SETTINGS_FAILED'); error.code = 'GIT_SETTINGS_FAILED';
  uiMessage(error); assert.equal(error.message, 'GIT_SETTINGS_FAILED'); assert.equal(error.code, 'GIT_SETTINGS_FAILED');
});

test('isolated plugins and the phone receive the same self-contained formatter', () => {
  const scope = vm.createContext({}); vm.runInContext(uiMessage.toString(), scope);
  assert.equal(scope.uiMessage('ENOSPC'), uiMessage('ENOSPC'));
  assert.equal(scope.uiMessage('UNKNOWN_NEW_CODE'), uiMessage('UNKNOWN_NEW_CODE'));
});

test('renderer patch formats notifications, descriptions and nested alerts while preserving protocol decisions', () => {
  const source = `function Settings({error}){
    const classification=error.message==='APP_PLUGIN_PERMISSION_DENIED';
    toast.error(error.message,{description:error.details});
    toast.success('SYNTHETIC_SUCCESS_CODE');
    return jsxRuntimeExports.jsx('div',{role:'alert',children:jsxRuntimeExports.jsx('p',{children:error.code})});
  }`;
  const patched = patchUiMessages(source);
  assertProductMessages(patched);
  assert.equal(patchUiMessages(patched), patched);
  assert.match(patched, /classification=error.message==='APP_PLUGIN_PERMISSION_DENIED'/);
  const notifications = [], React = { jsx: (type, props) => ({ type, ...props }) };
  const scope = vm.createContext({ uiMessage, jsxRuntimeExports: React, toast: { error: (...args) => notifications.push(args), success: (...args) => notifications.push(args) } });
  vm.runInContext(patched.replace(/^import[^\n]+\n/u, ''), scope);
  const view = scope.Settings({error:{message:'APP_PLUGIN_PERMISSION_DENIED',details:'UNKNOWN_NEW_CODE',code:'ENOENT'}});
  assert.match(notifications[0][0], /permission/);
  assert.equal(notifications[0][1].description, uiMessage('UNKNOWN_NEW_CODE'));
  assert.equal(notifications[1][0], 'The action finished.');
  assert.match(view.children.children, /file or program could not be found/);
});

test('code, terminals, user messages, filenames and tool output retain exact bytes', () => {
  const source = `function CodeBlock({message}){return h('pre',null,message);}
    function Terminal({error}){return h('div',{role:'alert'},error.message);}
    function ToolResult({message}){return h('div',null,message);}
    function ChatMessage({message}){return h('article',null,message.text);}
    function Editor({file}){return h('textarea',null,file.content);}
    function Files({file}){return h('span',null,file.name);}
    const transcript={content:'IDE_PULL_OK',code:'const RAW_CODE = "你好";'};
    function diagnostics(error){return {code:error.code,message:error.message,stack:error.stack};}`;
  assert.equal(patchUiMessages(source), source);
});

test('guard fails on new unformatted product messages, including accessibility alerts', () => {
  for (const source of ["toast.error(response.error);", "toast[severity](response.message);", "banner.textContent=response.error;", "h('p',{role:'alert'},failure);", "h('p',null,job.message);", "h('span',null,'NEW_STATUS_CODE');", "h('button',{'aria-label':'NEW_BUTTON_CODE'},'Retry');", "jsxRuntimeExports.jsx('p',{role:'alert',children:'UNREVIEWED_NEW_CODE'});"]) {
    assert.throws(() => assertProductMessages(source, 'new-view.mjs'), /Unformatted product message in new-view.mjs:1/);
    assertProductMessages(patchUiMessages(source));
  }
});

test('release verification catches bypassed formatting and incomplete English catalogs', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-message-check-')), assets = path.join(root, 'out/renderer/assets');
  try {
    await fs.mkdir(assets, { recursive: true });
    await fs.writeFile(path.join(assets, 'ui-messages.mjs'), await fs.readFile(new URL('../src/ui-messages.mjs', import.meta.url)));
    const source = 'const shellResources={zh:{common:{ready:"就绪"}},en:{common:{ready:"Ready"}}};function OnboardingOverlaySurface(){return h("p",{role:"alert"},response.error);}';
    await fs.writeFile(path.join(assets, 'index.js'), patchUiMessages(source));
    assert.equal((await verifyProductMessages(root)).unformattedMessages, 0);
    await fs.writeFile(path.join(assets, 'index.js'), source);
    await assert.rejects(verifyProductMessages(root), /Unformatted product message/);
    const incomplete = 'const shellResources={zh:{common:{ready:"就绪"}},en:{common:{}}};';
    assert.throws(() => assertEnglishCatalogs(incomplete), /Missing English message.*common.ready/);
    assert.throws(() => assertEnglishCatalogs(incomplete.replace('common:{}', 'common:{ready:"就绪"}')), /Non-English message/);
    const previousGaps = 'const shellResources={zh:{common:{language:"English"}},en:{common:{language:"中文"}}};const newChatResources={zh:{composer:{referencePreview:{message:"已发送消息"}}},en:{composer:{send:"Send"}}};';
    assertEnglishCatalogs(patchEnglishRenderer(previousGaps));
    const missingNavigation = 'const shellResources={zh:{nav:{chats:"任务"}},en:{nav:{chats:"Tasks"}}};function label(t){return t("nav.chat");}';
    assert.throws(() => assertEnglishCatalogs(missingNavigation), /Missing English navigation message.*nav.chat/);
    assertEnglishCatalogs(patchEnglishRenderer(missingNavigation));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('every owned IDE view uses formatted product-message boundaries', async () => {
  const files = (await fs.readdir(new URL('../src/', import.meta.url))).filter(name => /\.(?:mjs|cjs)$/u.test(name));
  assert.ok(files.length >= 10);
  for (const name of files) assertProductMessages(await fs.readFile(new URL('../src/' + name, import.meta.url), 'utf8'), name);
  const phone = await fs.readFile(new URL('../src/phone/page.js', import.meta.url), 'utf8');
  assertProductMessages(phone, 'phone/page.js');
  assert.match(phone, /banner.textContent = uiMessage\(state.error\)/);
  assert.match(phone, /message.role === 'error' \? uiMessage\(message.text\) : message.text/);
});
