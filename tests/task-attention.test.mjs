import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'acorn';
import {createTaskAttention} from '../src/task-attention.mjs';
import {patchSecondaryArtwork} from '../src/workbench-patch.mjs';
function attention(storage){
 const slots=[];let cursor=0;const cleanups=[];
 const React={useState(value){const index=cursor++;slots[index]??=value;return[slots[index],next=>{slots[index]=typeof next==='function'?next(slots[index]):next;}];},useEffect(effect,deps){const index=cursor++,old=slots[index];if(!old||deps.some((value,i)=>value!==old[i])){slots[index]=deps;const cleanup=effect();if(cleanup)cleanups.push(cleanup);}}};
 const hook=createTaskAttention(React,storage,new EventTarget());
 return{render(kind,session,active=false){cursor=0;return hook(kind,session,active);},close(){cleanups.forEach(fn=>fn());}};
}
test('opening acknowledges an error without changing its conversation or failure status; new failures can notify again',()=>{
 const values=new Map(),storage={getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};
 const session=Object.freeze({sessionId:'task-one',updatedAt:1,latestTurnStatus:'failed',runtimeState:'cold',unread:true});
 let ui=attention(storage);assert.equal(ui.render('error',session),'error');assert.equal(ui.render('error',session,true),null);assert.equal(ui.render('error',session),null);ui.close();
 ui=attention(storage);assert.equal(ui.render('error',session),null,'Acknowledgement survives restarting the window.');
 assert.equal(ui.render('error',{...session,updatedAt:2,unread:false}),null,'Read-only metadata changes must not resurface an old error.');
 assert.equal(ui.render('error',{...session,updatedAt:3,unread:true}),'error','A newly failed response must notify again.');
 for(const kind of ['running','waiting','unread',null])assert.equal(ui.render(kind,session,true),kind);
 assert.equal(session.latestTurnStatus,'failed');assert.equal(session.unread,true);ui.close();
});
test('storage failures still acknowledge the error for the current window',()=>{
 const ui=attention({getItem(){throw Error('Unavailable');},setItem(){throw Error('Full');}}),session={sessionId:'task-two',updatedAt:1};
 assert.equal(ui.render('error',session,true),null);assert.equal(ui.render('error',session),null);ui.close();
});
test('the sidebar uses attention acknowledgement while the conversation renderer is preserved',()=>{
 const call='getSessionIndicatorKind(n1.runtimeState,n1.pendingInteractionCount,n1.unread,n1.latestTurnStatus,n1.sideChatAttentionState)';
 const fixture=`const SidebarChatSessionLink=reactExports.memo(function e1({session:n1,active:t1}){return ${call};});function ConversationError(){return "Keep the actual error";}`;
 const patched=patchSecondaryArtwork(fixture);parse(patched,{ecmaVersion:'latest',sourceType:'module'});
 assert(patched.includes(`notchTaskAttention(${call},n1,t1)`));assert(patched.includes('function ConversationError(){return "Keep the actual error";}'));
 assert.equal(patchSecondaryArtwork(patched),patched);
});
