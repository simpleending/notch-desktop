import { readFileSync } from 'node:fs';
import { parseExpressionAt, tokenizer } from 'acorn';
import { patchFunction } from './bundle-patch.mjs';

const messages = JSON.parse(readFileSync(new URL('../vendor/notch-cli/src/ui/working-messages.json', import.meta.url), 'utf8'));
const keys = Object.keys(messages), phrases = Object.values(messages);

export function patchWorkingStatus(source) {
  // Keep historical keys so existing custom phrases survive preference normalization.
  const catalogs = [...source.matchAll(/processing:\{(?:almost|"almost"):/g)];
  for (const match of catalogs.reverse()) {
    const start = match.index + 'processing:'.length;
    const scanner = tokenizer(source.slice(start), { ecmaVersion: 'latest' });
    let depth = 0, end;
    do {
      const token = scanner.getToken();
      if (token.type.label === 'eof') throw new Error('Unclosed working status catalog.');
      if (token.type.label === '{') depth++;
      if (token.type.label === '}') depth--;
      end = start + token.end;
    } while (depth);
    const object = parseExpressionAt(source.slice(start, end), 0, { ecmaVersion: 'latest' });
    if (object.type !== 'ObjectExpression' || object.properties.some(prop => prop.value.type !== 'Literal')) throw new Error('Working status catalog changed.');
    const defaults = Object.fromEntries(object.properties.map((prop, index) => {
      const key = prop.key.name ?? prop.key.value;
      return [key, messages[key] ?? phrases[index % phrases.length]];
    }));
    source = source.slice(0, start) + JSON.stringify(defaults) + source.slice(end);
  }
  source = source.replace('return thinkingStatusMessageKeys.map(W2=>v2[J2][W2]??a2(`chatActivity.processing.${W2}`))', `return [...new Set([...${JSON.stringify(keys)},...thinkingStatusMessageKeys.filter(key=>v2[J2][key]!==void 0)])].map(W2=>v2[J2][W2]??a2(\`chatActivity.processing.\${W2}\`))`);
  if (source.includes('function ThinkingStatus(')) source = patchFunction(source, 'ThinkingStatus', body => {
    if (!body.includes('e1=[...new Set(e1)]')) body = body.replace('...o1}){', '...o1}){e1=[...new Set(e1)];');
    return body.replace('randomIndex(e1.length)', '0')
      .replace('nextRandomIndex(g1,e1.length)', '(g1+1)%e1.length')
      .replace('jsxRuntimeExports.jsx(ThinkingDotMatrixIcon,{"data-thinking-status-loader":"matrix",sizeClassName:"size-3"})', 'jsxRuntimeExports.jsx("span",{className:"notch-task-dot","aria-hidden":!0,"data-thinking-status-loader":"matrix"})');
  });
  if (source.includes('function ThinkingStatusMessagesDialog(')) source = patchFunction(source, 'ThinkingStatusMessagesDialog', `function ThinkingStatusMessagesDialog({open:e1,overrides:t1,onOpenChange:n1,onSave:r1}){
    const {t:i1,i18n:s1}=useTranslation(),language=(s1.resolvedLanguage||s1.language).toLowerCase().startsWith("zh")?"zh":"en",
      defaults=reactExports.useMemo(()=>Object.fromEntries(["zh","en"].map(lang=>[lang,Object.fromEntries(thinkingStatusMessageKeys.map(key=>[key,s1.getFixedT(lang)("chatActivity.processing."+key)]))])),[s1]),
      [draft,setDraft]=reactExports.useState(()=>createDrafts(defaults,t1));
    reactExports.useEffect(()=>{if(e1)setDraft(createDrafts(defaults,t1))},[defaults,e1,t1]);
    const overrides=reactExports.useMemo(()=>createOverrides(draft,defaults),[draft,defaults]),
      rows=[...new Set([...${JSON.stringify(keys)},...thinkingStatusMessageKeys.filter(key=>t1[language][key]!==undefined)])],
      reset=key=>setDraft(previous=>({...previous,[language]:{...previous[language],[key]:defaults[language][key]}}));
    return jsxRuntimeExports.jsx(ContentDialog,{open:e1,onClose:()=>n1(!1),title:i1("settings.thinkingStatusMessagesDialogTitle"),description:i1("settings.thinkingStatusMessagesDialogDescription"),closeLabel:i1("settings.thinkingStatusMessagesDialogClose"),maxWidth:640,footer:jsxRuntimeExports.jsxs("div",{className:"flex w-full items-center justify-between gap-4",children:[
      jsxRuntimeExports.jsx(Button,{type:"button",variant:"tertiary",disabled:!Object.keys(overrides[language]).length,onClick:()=>setDraft(previous=>({...previous,[language]:{...defaults[language]}})),children:i1("settings.thinkingStatusMessagesResetAll")}),
      jsxRuntimeExports.jsxs("div",{className:"flex gap-2",children:[jsxRuntimeExports.jsx(Button,{type:"button",variant:"ghost",onClick:()=>n1(!1),children:i1("common.cancel")}),jsxRuntimeExports.jsx(Button,{type:"button",variant:"primary",disabled:haveSameOverrides(overrides,t1),onClick:()=>{r1({...t1,[language]:overrides[language]});n1(!1)},children:i1("common.save")})]})]}),
      children:jsxRuntimeExports.jsx("div",{className:"grid gap-3","aria-label":i1("settings.thinkingStatusMessagesTableLabel"),children:rows.map((key,index)=>jsxRuntimeExports.jsxs("div",{className:"flex items-center gap-3",children:[
        jsxRuntimeExports.jsx("label",{className:"sr-only",htmlFor:"notch-status-"+key,children:i1(language==="zh"?"settings.thinkingStatusMessageEditChinese":"settings.thinkingStatusMessageEditEnglish",{count:index+1})}),
        jsxRuntimeExports.jsx(Input,{id:"notch-status-"+key,value:draft[language][key],onChange:event=>setDraft(previous=>({...previous,[language]:{...previous[language],[key]:event.target.value}}))}),
        jsxRuntimeExports.jsx(IconButton,{type:"button",variant:"ghost",disabled:draft[language][key]===defaults[language][key],"aria-label":i1("settings.thinkingStatusMessageReset",{count:index+1}),icon:jsxRuntimeExports.jsx(notchResetLeftLine,{size:16,"aria-hidden":!0}),onClick:()=>reset(key)})]},key))})});
  }`);
  return source.replace('Customize the Chinese and English messages shown while notch is thinking.', 'Customize the working messages for your current interface language.')
    .replace('thinkingStatusLoader:"Thinking status loader"', 'thinkingStatusLoader:"Working indicator"')
    .replace('thinkingStatusMessagesTableLabel:"Chinese and English thinking status messages"', 'thinkingStatusMessagesTableLabel:"Working status messages"')
    .replace('thinkingStatusMessages:"Thinking status messages"', 'thinkingStatusMessages:"Working status messages"')
    .replace('thinkingStatusMessagesDialogTitle:"Edit thinking status messages"', 'thinkingStatusMessagesDialogTitle:"Edit working status messages"')
    .replace('jsxRuntimeExports.jsx(ThinkingDotMatrixIcon,{sizeClassName:"size-3.5"})', 'jsxRuntimeExports.jsx("span",{className:"notch-task-dot","aria-hidden":!0})')
    .replaceAll('matrix:"Matrix (default)"', 'matrix:"Dot (default)"')
    .replaceAll('matrix:"Matrix（默认）"', 'matrix:"Dot (default)"')
    .replace('Shows how much context this task uses; compression summarizes earlier messages, takes a moment, and uses a small number of credits.', 'Shows context usage for this task. Compacting summarizes earlier messages using the selected model. Provider charges apply when using a paid model.')
    .replace('展示当前任务的上下文占用情况；压缩会摘要早期内容，需等待片刻并消耗少量积分。', '展示当前任务的上下文占用情况；压缩会使用所选模型摘要较早的消息。付费模型会产生相应费用。');
}
