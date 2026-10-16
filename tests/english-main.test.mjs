import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {patchEnglishMain} from '../src/english-main-patch.mjs';
import translations from '../src/english-main-strings.json' with {type:'json'};
import scriptTranslations from '../src/english-script-strings.json' with {type:'json'};

test('permission defaults and file errors are English, with interpolation and decisions intact',()=>{
  const source='function permission(name,allowed){return {title:`允许 ${name}？`,description:"此操作需要你的确认。",allowed,reason:allowed?null:"操作请求已取消。"};}function read(){throw new Error("文件不是有效的 UTF-8 文本。");}';
  const patched=patchEnglishMain(source),scope=vm.createContext({});vm.runInContext(patched,scope);
  assert.equal(scope.permission('BrowserInteract',false).title,'Allow BrowserInteract?');
  assert.equal(scope.permission('BrowserInteract',false).description,'This action requires your approval.');
  assert.equal(scope.permission('BrowserInteract',false).allowed,false);
  assert.equal(scope.permission('Read',true).reason,null);
  assert.equal(scope.permission('用户的中文工具名',true).title,'Allow 用户的中文工具名?');
  assert.throws(()=>scope.read(),/not valid UTF-8/);
  assert.equal(patchEnglishMain(patched),patched);
});

test('reviewed English messages retain numbers, template slots and technical codes',()=>{
  for(const [chinese,english] of Object.entries(translations)){
    assert.equal(typeof english,'string');assert.ok(english.trim());assert.doesNotMatch(english,/\p{Script=Han}/u,chinese);
    assert.deepEqual(english.match(/\{\{\d+\}\}/g)??[],chinese.match(/\{\{\d+\}\}/g)??[],chinese);
    const numbers=text=>(text.match(/\d+(?:\.\d+)*/g)??[]).sort();assert.deepEqual(numbers(english),numbers(chinese),chinese);
    for(const code of chinese.match(/\b[A-Z][A-Z0-9_]{2,}\b/g)??[])assert.ok(english.includes(code),code);
    assert.deepEqual(english.match(/\$\d+/g)??[],chinese.match(/\$\d+/g)??[],chinese);
  }
});

test('Chinese user data, regexes, legacy identity matching and comments are preserved',()=>{
  const source='// 用户备注\nconst pattern=/允许/u;const match=old.name==="允许 ";function show(value){return value;}';
  const patched=patchEnglishMain(source),scope=vm.createContext({old:{name:'允许 '},note:'用户自己的中文内容'});vm.runInContext(patched+';globalThis.result=show(note);globalThis.match=match;',scope);
  assert.equal(scope.result,'用户自己的中文内容');assert.equal(scope.match,true);
  assert.ok(patched.includes('// 用户备注'));assert.ok(patched.includes('/允许/u'));
});

test('fresh upstream and already branded builds share the same English messages',()=>{
 const source='function failure(){throw new Error("Qoder 的 MCP 配置已被其他程序修改，请重试。");}';
 const scope=vm.createContext({});vm.runInContext(patchEnglishMain(source),scope);assert.throws(()=>scope.failure(),/MCP configuration.*modified/i);
 assert.doesNotMatch(patchEnglishMain(source),/配置|Qoder/);
});

test('translation does not touch raw executable scripts or serialized keys',()=>{
  const source='const script=String.raw`文件不是有效的 UTF-8 文本。`;const schema={"文件不是有效的 UTF-8 文本。":42};globalThis.found=schema["文件不是有效的 UTF-8 文本。"];';
  const scope=vm.createContext({});vm.runInContext(patchEnglishMain(source),scope);assert.equal(scope.found,42);assert.equal(patchEnglishMain(source),source);
});

test('remote shell diagnostics translate without changing commands, protocol IDs or quoting',()=>{
  const source="const Dxt=String.raw`# 原始注释\nprintf '%s\\n' '远端机器未安装 Git。' >&2; exit 71`;";
  const patched=patchEnglishMain(source);
  assert.equal(patched,source.replace('远端机器未安装 Git。','Git is not installed on the remote host.'));
  assert.equal(patchEnglishMain(patched),patched);
  for(const text of Object.values(scriptTranslations))assert.doesNotMatch(text,/['`$\\\r\n]|\p{Script=Han}/u);
});

test('injected playback errors are English while the executable JavaScript is preserved',()=>{
  const source='const script=`const sink=document.getElementById("notch-live-voice-playback-sink");if(!sink)throw new Error("实时语音播放节点不可用。");`;';
  const patched=patchEnglishMain(source),scope=vm.createContext({});vm.runInContext(patched+';globalThis.script=script;',scope);
  assert.throws(()=>vm.runInContext(scope.script,vm.createContext({document:{getElementById:()=>null}})),/Live Voice audio element is unavailable/);
  assert.equal(patched,source.replace('实时语音播放节点不可用。','The Live Voice audio element is unavailable.'));
});

test('localized plugin errors keep the same error categories as legacy Chinese errors',()=>{
  const original='function tH(t,e){const r=t instanceof Error?t.message:String(t);return/^[A-Z][A-Z0-9_:-]*/u.test(r)?t instanceof Error?t:new Error(r):r.includes("不存在")||r.includes("已经归档")||r.includes("已经删除")?new Error("APP_PLUGIN_SESSION_UNAVAILABLE"):r.includes("权限")||r.includes("授权")?new Error("APP_PLUGIN_PERMISSION_DENIED"):r.includes("退出")||r.includes("关闭")?new Error("APP_PLUGIN_SHUTTING_DOWN"):new Error(e)}';
  const patched=patchEnglishMain(original),scope=vm.createContext({});vm.runInContext(patched,scope);
  for(const text of ['会话不存在。','This session does not exist.','The session has been archived.'])assert.equal(scope.tH(text,'fallback').message,'APP_PLUGIN_SESSION_UNAVAILABLE');
  for(const text of ['权限不足','Permission denied.','This action requires authorization.'])assert.equal(scope.tH(text,'fallback').message,'APP_PLUGIN_PERMISSION_DENIED');
  for(const text of ['已经关闭','The service is closed.','The app is shutting down.'])assert.equal(scope.tH(text,'fallback').message,'APP_PLUGIN_SHUTTING_DOWN');
  assert.equal(scope.tH('Unrelated failure','fallback').message,'fallback');assert.equal(patchEnglishMain(patched),patched);
  assert.equal(scope.tH('APP_PLUGIN_KNOWN_ERROR','fallback').message,'APP_PLUGIN_KNOWN_ERROR');
});
