import fs from 'node:fs';

/** Observe real OpenRouter traffic without recording authorization headers. */
export function installOpenRouterTrace(traceFile, catalogFile, maxUsd = 0.10) {
  const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
  const original = globalThis.fetch, pending = new Set();
  const redact = value => String(value).replace(/sk-or-v1-[A-Za-z0-9_-]+/g, '[REDACTED]');
  const record = value => fs.appendFileSync(traceFile, redact(JSON.stringify({...value, at:Date.now()}))+'\n', {mode:0o600});
  globalThis.fetch = async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== 'https://openrouter.ai/api/v1/chat/completions') return original(input, init);
    const body = JSON.parse(init.body), model = catalog.find(row=>row.id===body.model);
    if (!model) throw Error('Live QA only permits its selected inexpensive models.');
    const output = body.max_tokens ?? body.max_completion_tokens;
    if (!Number.isSafeInteger(output) || output < 1 || output > 4096) throw Error('Live QA requires bounded output.');
    const previous = fs.existsSync(traceFile) ? fs.readFileSync(traceFile,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line)) : [];
    const requests = previous.filter(row=>row.type==='request');
    const reserveUsd = Buffer.byteLength(JSON.stringify(body))*Number(model.pricing.prompt)+output*Number(model.pricing.completion);
    if (!Number.isFinite(reserveUsd) || reserveUsd < 0 || requests.length >= 24 || requests.reduce((sum,row)=>sum+row.reserveUsd,0)+reserveUsd > maxUsd) throw Error('Live QA spending/request cap reached.');
    const id = requests.length+1;
    record({type:'request', id, model:body.model, messages:body.messages, stream:!!body.stream, outputLimit:output, reserveUsd});
    const response = await original(input, init);
    record({type:'http', id, status:response.status});
    const observe = response.clone().text().then(text=>{
      const frames = body.stream ? text.split('\n').filter(line=>line.startsWith('data: ')&&line.slice(6)!=='[DONE]').map(line=>{try{return JSON.parse(line.slice(6));}catch{return null;}}).filter(Boolean) : [JSON.parse(text)];
      const usage = frames.findLast(frame=>frame.usage)?.usage;
      record({type:'response', id, responseId:frames.find(frame=>frame.id)?.id, responseModel:frames.find(frame=>frame.model)?.model,
        usage, errors:frames.filter(frame=>frame.error).map(frame=>frame.error), finishReasons:frames.flatMap(frame=>(frame.choices??[]).map(choice=>choice.finish_reason).filter(Boolean))});
    }).catch(error=>record({type:'observation-error',id,error:redact(error.message)}));
    pending.add(observe);observe.finally(()=>pending.delete(observe));
    if (!body.stream) await observe;
    return response;
  };
  return {async flush(){await Promise.all([...pending]);}};
}

if (process.env.NOTCH_OPENROUTER_TRACE_FILE) globalThis.__notchOpenRouterTrace=installOpenRouterTrace(process.env.NOTCH_OPENROUTER_TRACE_FILE,process.env.NOTCH_OPENROUTER_CATALOG_FILE);
