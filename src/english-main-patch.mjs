import { parse } from 'acorn';
import translations from './english-main-strings.json' with { type: 'json' };
import { patchFunction, rebrandWorkbenchText } from './bundle-patch.mjs';
import scriptTranslations from './english-script-strings.json' with {type:'json'};

// These strings recognize old stored names and third-party Chinese errors, rather than display text.
const legacyNames = /(?:\.name|\.description)\s*===\s*$/;
const recognition = new Set(['未分类','虎嗅','不存在','已经归档','已经删除','权限','授权','退出','关闭','当前回答已停止。','执行已取消。']);

/** Translate build-time literals only; user messages, file contents, and runtime results never pass here. */
export function patchEnglishMain(source) {
  const edits=[];
  const scriptCopy=text=>{
    for(const [chinese,english] of Object.entries(scriptTranslations))text=text.replaceAll("'"+chinese+"'","'"+english+"'").replaceAll(JSON.stringify(chinese),JSON.stringify(english));
    return text;
  };
  function rewritten(start,end) {
    const pieces=[];let cursor=start;
    for(const edit of edits.filter(edit=>edit.start>=start&&edit.end<=end).sort((a,b)=>a.start-b.start)){pieces.push(source.slice(cursor,edit.start),edit.replacement);cursor=edit.end;}
    pieces.push(source.slice(cursor,end));return pieces.join('');
  }
  function visit(node,parent) {
    if(!node||typeof node!=='object')return;
    if(node.type==='TaggedTemplateExpression'&&node.tag?.object?.name==='String'&&node.tag?.property?.name==='raw'){
      const start=node.quasi.start+1,end=node.quasi.end-1,original=source.slice(start,end);
      // Only fixed quoted diagnostics change; script commands, interpolation, comments, and exit codes stay byte-for-byte intact.
      const replacement=scriptCopy(original);
      if(replacement!==original)edits.push({start,end,replacement});
      return;
    }
    for(const [key,value] of Object.entries(node))if(!['start','end','type','regex'].includes(key)&&!(key==='value'&&['Literal','TemplateElement'].includes(node.type))) {
      if(Array.isArray(value))value.forEach(child=>visit(child,node));else if(value&&typeof value==='object')visit(value,node);
    }
    const template=node.type==='TemplateLiteral';
    if(template&&parent?.type==='TaggedTemplateExpression')return;
    if(template&&source.slice(node.start,node.end).includes('live-voice-playback-sink')){
      const original=rewritten(node.start,node.end),replacement=scriptCopy(original);
      if(replacement!==original){for(let i=edits.length-1;i>=0;i--)if(edits[i].start>=node.start&&edits[i].end<=node.end)edits.splice(i,1);edits.push({start:node.start,end:node.end,replacement});}
      return;
    }
    const text=template?node.quasis.map((part,i)=>part.value.cooked+(i<node.expressions.length?'{{'+i+'}}':'')).join(''):node.type==='Literal'&&typeof node.value==='string'?node.value:null;
    if(text===null||!/\p{Script=Han}/u.test(text))return;
    const lookup=rebrandWorkbenchText(text);
    if(!Object.hasOwn(translations,lookup))return;
    // Never rename serialized schema keys or legacy data recognition rules.
    if(['Property','PropertyDefinition','MethodDefinition'].includes(parent?.type)&&parent.key===node||parent?.type==='MemberExpression'&&parent.property===node)return;
    const before=source.slice(Math.max(0,node.start-80),node.start);
    if(legacyNames.test(before)||recognition.has(text)&&/(?:===|includes\()\s*$/.test(before))return;
    let replacement=JSON.stringify(translations[lookup]);
    if(template) {
      const english=translations[lookup],slots=english.match(/\{\{\d+\}\}/g)??[];
      if(JSON.stringify(slots)!==JSON.stringify(node.expressions.map((_,i)=>'{{'+i+'}}')))throw Error('English template placeholders differ: '+text);
      const escape=part=>part.replace(/[\\`]/g,'\\$&').replace(/\$\{/g,'\\${');
      replacement='`'+english.split(/(\{\{\d+\}\})/g).map(part=>/^\{\{\d+\}\}$/.test(part)?'${'+rewritten(node.expressions[Number(part.slice(2,-2))].start,node.expressions[Number(part.slice(2,-2))].end)+'}':escape(part)).join('')+'`';
      for(let i=edits.length-1;i>=0;i--)if(edits[i].start>=node.start&&edits[i].end<=node.end)edits.splice(i,1);
    }
    edits.push({start:node.start,end:node.end,replacement});
  }
  visit(parse(source,{ecmaVersion:'latest',sourceType:'module'}));
  let result=rewritten(0,source.length);
  if(result.includes('function DIr('))result=patchFunction(result,'DIr',body=>{
    if(body.includes('/* notch English cancellation */'))return body;
    const anchor='return e==="interrupted"||';
    if(body.split(anchor).length!==2)throw Error('Cancellation classification changed.');
    const messages=['当前回答已停止。','执行已取消。'].map(text=>translations[text]?.toLowerCase()).filter(Boolean);
    return body.replace(anchor,'/* notch English cancellation */return '+JSON.stringify(messages)+'.includes(e)||e==="interrupted"||');
  });
  if(result.includes('function tH('))result=patchFunction(result,'tH',body=>{
    if(body.includes('/* notch English error categories */'))return body;
    const replacements=[
      ['/^[A-Z][A-Z0-9_:-]*/u.test(r)','/^[A-Z][A-Z0-9_:-]*(?:$|(?=\\s))/u.test(r)'],
      ['r.includes("不存在")','(/does not exist|not found|archived|deleted/i.test(r)||r.includes("不存在"))'],
      ['r.includes("权限")','(/permission|authoriz|access denied/i.test(r)||r.includes("权限"))'],
      ['r.includes("退出")','(/shut(?:ting)? down|closed|stopped/i.test(r)||r.includes("退出"))'],
    ];
    for(const [before,after] of replacements){if(body.split(before).length!==2)throw Error('Plugin error classification changed.');body=body.replace(before,after);}
    return body.replace('{','{/* notch English error categories */');
  });
  return result;
}
