const GiB = 2 ** 30;
export function localContextProfile(bytes, hardware, metadata = {}, mounted = {}) {
  const info = metadata.model_info || {}, arch = info['general.architecture'];
  const number = key => Number(info[`${arch}.${key}`]);
  const primary = typeof arch === 'string' ? info[`${arch}.context_length`] : undefined;
  const contexts = Object.entries(info).filter(([key,value])=>key.endsWith('.context_length') && Number.isSafeInteger(value) && value>0).map(([,value])=>value);
  const native = Number.isSafeInteger(primary) && primary>0 ? primary : contexts.length===1 ? contexts[0] : undefined;
  const nativeKnown = Number.isSafeInteger(native) && native>=2048;
  const layers = number('block_count'), heads = number('attention.head_count_kv');
  const key = number('attention.key_length') || number('embedding_length') / number('attention.head_count');
  const value = number('attention.value_length') || key;
  // FP16 KV cache, all layers: deliberately overestimates hybrid attention models.
  const kvBytesPerToken = layers * heads * (key + value) * 2;
  const known = Number.isFinite(kvBytesPerToken) && kvBytesPerToken > 0;
  // A running copy already occupies memory; count only that same model's reclaimable allocation.
  const resident = Number.isSafeInteger(mounted.size) && mounted.size>0 ? mounted.size : 0;
  const residentVram = !hardware.appleSilicon && Number.isSafeInteger(mounted.size_vram) && mounted.size_vram>=0 ? Math.min(resident,mounted.size_vram) : 0;
  const ram = Math.min(hardware.totalMemory,hardware.availableMemory+resident-residentVram);
  const ramBudget = Math.max(0, Math.min(ram - GiB, hardware.totalMemory * .75));
  const vram = Math.min(hardware.totalVram ?? Infinity, hardware.availableVram + residentVram);
  const vramBudget = hardware.appleSilicon ? 0 : Math.max(0, vram - GiB);
  const budget = ramBudget + vramBudget;
  const weights = bytes * 1.2 + 1.5 * GiB;
  const cap = nativeKnown ? native : 8192;
  const required = context => weights + (known ? kvBytesPerToken * context : GiB * context / 8192);
  const choices = [2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144].filter(context => nativeKnown && context <= cap && required(context) <= budget);
  // Prefer a GPU-resident context; larger RAM/offload choices stay available manually.
  const gpu = hardware.totalVram > 0 || vramBudget > 0;
  const preferredBudget = hardware.appleSilicon || !gpu ? ramBudget : vramBudget;
  const automaticCap = known && (gpu || hardware.appleSilicon) ? 131072 : 8192;
  const automatic = choices.filter(context => context <= automaticCap && required(context) <= preferredBudget).at(-1);
  return { choices, contextWindow: automatic || (choices.includes(8192) ? 8192 : choices[0] || Math.min(4096, cap)),
    fits: choices.length > 0 && Array.isArray(metadata.capabilities) && metadata.capabilities.includes('tools'),
    reason: !(Array.isArray(metadata.capabilities) && metadata.capabilities.includes('tools')) ? 'tool support not confirmed' : !nativeKnown ? 'native context limit not confirmed' : choices.length ? 'estimated memory fit' : 'not enough memory available',
    kvBytesPerToken: known ? kvBytesPerToken : null, bytes, nativeContext: cap };
}

export function cloudModelRows(data, connected) {
  if (!Array.isArray(data)) throw new Error('OpenRouter returned an invalid model catalog.');
  return data.filter(row => row && typeof row.id === 'string' && /^[\w./:~+-]{1,256}$/.test(row.id) &&
    Array.isArray(row.architecture?.output_modalities) && row.architecture.output_modalities.includes('text') && (!Array.isArray(row.architecture.input_modalities) || row.architecture.input_modalities.includes('text')) &&
    Number.isSafeInteger(row.context_length) && row.context_length >= 4096)
    .sort((a,b) => (b.created || 0) - (a.created || 0) || a.id.localeCompare(b.id)).map(row => {
      const cap = Math.min(row.context_length, Number.isSafeInteger(row.top_provider?.context_length) && row.top_provider.context_length>=4096 ? row.top_provider.context_length : row.context_length);
      const choices = [...new Set([8192, 16384, 32768, 65536, 131072, 262144, cap].filter(n => n <= cap))].sort((a,b)=>a-b);
      const initial = Math.min(32768, cap);
      if (!choices.includes(initial)) choices.push(initial);
      const tools=Array.isArray(row.supported_parameters) && row.supported_parameters.includes('tools');
      return { key: `openrouter/${row.id}`, displayName: typeof row.name==='string' && row.name ? row.name : row.id, description: !tools?'Chat model · coding tools not supported':!connected?'Connect your OpenRouter key to use':'OpenRouter · cloud',
        provider: 'openrouter', source: 'system', enabled: connected && tools, tools, isDefault: false, isNew: false, priceFactor: 1, tags: ['cloud'],
        maxInputTokens: cap, maxOutputTokens: Math.min(Number.isSafeInteger(row.top_provider?.max_completion_tokens) && row.top_provider.max_completion_tokens>0 ? row.top_provider.max_completion_tokens : 4096, 8192),
        availableContextWindows: choices.sort((a,b)=>a-b), defaultContextWindow: initial, efforts: [], defaultEffort: null, supportsDisabled: true,
        created: row.created || 0, pricing: { input: Number(row.pricing?.prompt) * 1e6, output: Number(row.pricing?.completion) * 1e6 } };
    });
}

export function isPrimaryModelSender(event) {
  try { const url = new URL(event.senderFrame.url); return event.senderFrame === event.sender.mainFrame && url.protocol === 'notch-app:' && url.host === 'renderer' && url.pathname === '/index.html' && !url.searchParams.has('surface'); }
  catch { return false; }
}

export const OPENROUTER_FALLBACK_LIMIT = 3;
export function openRouterModelId(key) {
  return typeof key === 'string' && key.startsWith('openrouter/') ? key.slice(11) : typeof key === 'string' ? key : '';
}
export function openRouterModelKey(value) {
  const id = openRouterModelId(value);
  return id ? `openrouter/${id}` : '';
}
/** Ordered OpenRouter keys, primary excluded, at most three, unique. */
export function normalizeOpenRouterFallbacks(primary, ids, allowed) {
  const primaryId = openRouterModelId(primary);
  const seen = new Set(primaryId ? [primaryId] : []);
  const out = [];
  if (!Array.isArray(ids)) return out;
  for (const raw of ids) {
    const key = openRouterModelKey(raw), id = openRouterModelId(key);
    if (!id || !/^[\w./:~+-]{1,256}$/.test(id) || seen.has(id)) continue;
    if (allowed && !allowed.has(key) && !allowed.has(id)) continue;
    seen.add(id);
    out.push(key);
    if (out.length >= OPENROUTER_FALLBACK_LIMIT) break;
  }
  return out;
}
