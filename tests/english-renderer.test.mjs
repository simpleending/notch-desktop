import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { patchEnglishRenderer } from '../src/english-renderer-patch.mjs';

test('built-in labels, templates and anonymous components use English without changing conversation data',()=>{
  const source='const savedNote="取消"; const ChatInput=()=>({label:"加载中…",approval:"始终允许"}); function HoverCardListItemTagRow(count){return `还有 ${count} 个标签`;} function error(){throw Error("请选择未来的执行时间。")} function renderNote(note){return note;}';
  const patched=patchEnglishRenderer(source),context=vm.createContext({});vm.runInContext(patched,context);
  assert.equal(vm.runInContext('ChatInput().label',context),'Loading…');
  assert.equal(vm.runInContext('ChatInput().approval',context),'Always allow');
  assert.equal(vm.runInContext('HoverCardListItemTagRow(3)',context),'3 more tags');
  assert.throws(()=>vm.runInContext('error()',context),/Choose a future run time/);
  assert.equal(vm.runInContext('renderNote(savedNote)',context),'取消');
  assert.equal(patchEnglishRenderer(patched),patched);
});

test('existing English catalog wording is reused while Chinese catalogs and schema keys stay intact',()=>{
  const source='const labels={zh:{load:"加载中…"},en:{load:"Loading saved models…"}};function label(){return "加载中…"}function nestedCatalog(){return{zh:{cancel:"取消"},en:{cancel:"Cancel"}};}function schema(){const fields={"取消":1,["允许"]:2};return fields["取消"]+fields["允许"];}';
  const context=vm.createContext({});vm.runInContext(patchEnglishRenderer(source),context);
  assert.equal(vm.runInContext('label()',context),'Loading saved models…');
  assert.equal(vm.runInContext('labels.zh.load',context),'加载中…');
  assert.equal(vm.runInContext('nestedCatalog().zh.cancel',context),'取消');
  assert.equal(vm.runInContext('schema()',context),3);
});

test('Chinese text processing, old-error matching and sample names retain their original meaning',()=>{
  const source='function genNumberDict(){return "〇一";}function matchesComposerSiteCommand(){return ["站点","建站"];}function workspaceFileReadErrorCode(){return "文件不存在或无法访问";}function example(){return "Siqi Liu （刘思齐）";}';
  assert.equal(patchEnglishRenderer(source),source);
  assert.throws(()=>patchEnglishRenderer('function changed(){return "未经审核的新消息";}'),/Untranslated renderer text in changed/);
});

test('upstream product names do not bypass the English folder warning',()=>{
 const source='function ChatInput(){return "允许 QoderSpace 访问并修改“";}';
 assert.ok(patchEnglishRenderer(source).includes('Allow notch to access and modify files'));
});

test('English catalogs do not fall back to Chinese reference-preview labels or native language names',()=>{
  const source='const shellResources={zh:{common:{language:"English"}},en:{common:{language:"中文"}}};const newChatResources={zh:{composer:{referencePreview:{message:"已发送消息"}}},en:{composer:{send:"Send"}}};const chatSessionResources={zh:{chatSession:{composer:{referencePreview:{message:"已发送消息"}}}},en:{chatSession:{composer:{}}}};';
  const patched=patchEnglishRenderer(source),context=vm.createContext({});vm.runInContext(patched,context);
  assert.equal(vm.runInContext('shellResources.en.common.language',context),'Chinese');
  assert.equal(vm.runInContext('newChatResources.en.composer.referencePreview.message',context),'Sent message');
  assert.equal(vm.runInContext('chatSessionResources.en.chatSession.composer.referencePreview.authorization',context),'This preview does not call a model. Displaying a tag does not grant execution permission.');
  assert.equal(vm.runInContext('newChatResources.zh.composer.referencePreview.message',context),'已发送消息');
  assert.equal(patchEnglishRenderer(patched),patched);
});

test('sidebar accessibility labels use an English fallback agent name instead of nav.chat',()=>{
  const source='const shellResources={zh:{nav:{chats:"任务"}},en:{nav:{chats:"Tasks"}}};function agentName(t){return t("nav.chat");}';
  const patched=patchEnglishRenderer(source),context=vm.createContext({});vm.runInContext(patched,context);
  assert.equal(vm.runInContext('agentName(key=>shellResources.en.nav[key.slice(4)]??key)',context),'Chat');
  assert.equal(patchEnglishRenderer(patched),patched);
});
