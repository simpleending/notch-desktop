export function patchWebToolCatalog(source) {
  const original = 'KHe=["Read","Write","Edit","Glob","Grep","Bash","WebSearch","WebFetch",';
  const previous = original + '"BrowserRead","BrowserInteract",';
  const updated = previous + '"Git","GitHub",';
  if (source.includes(updated)) return source;
  if (source.includes(previous)) return source.replace(previous, updated);
  if (source.split(original).length !== 2) throw Error('The default agent tool catalog differs from the tested version.');
  return source.replace(original, updated);
}

/** Project completed local search/fetch results into the existing Sources panel. */
export function patchWebSourceProjection(source){
  const before='if(KSt(A))for(const d of sne(o.input))',after='if(KSt(A))for(const d of [...sne(o.input),...sne(o.response)])';
  const oldRule='/browser|chrome|playwright|navigate|open_url|web__run/u',newRule='/browser|chrome|playwright|navigate|open_url|web__run|web_?search|web_?fetch/u';
  if(!source.includes(before)&&!source.includes(after))throw new Error('The native Sources projection differs from the tested version.');
  if(!source.includes(oldRule)&&!source.includes(newRule))throw new Error('The native web source matcher differs from the tested version.');
  const oldKind='n.push(w0("browser",h3(d),o.progressSummary??null',newKind='n.push(w0(/web_?search|web_?fetch/u.test(A)?"source":"browser",h3(d),o.progressSummary??null';
  const oldAnswer='const a=[...t.messages].reverse().find(s=>s.role==="assistant"&&s.status==="completed");for(const s of ine(a?.text??""))n.push(w0("browser",h3(s),null',newAnswer='for(const a of t.messages.filter(s=>s.role==="assistant"&&s.status==="completed"))for(const s of ine(a.text??""))n.push(w0("source",h3(s),null';
  for(const [original,patched] of [[oldKind,newKind],[oldAnswer,newAnswer],['const UQe=21,','const UQe=22,']]){
    if(!source.includes(original)&&!source.includes(patched))throw new Error('The native Sources panel projection differs from the tested version.');
    source=source.replace(original,patched);
  }
  return source.replace(before,after).replace(oldRule,newRule);
}
