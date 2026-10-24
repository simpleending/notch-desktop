import { colibriCatalog, colibriStatus, installColibri, prepareColibri, stopColibri } from '../providers/colibri.js';
import { persistConfigPatch, type ByokConfigBlock } from '../config.js';
import type { LocalModelResult } from './local-models.js';

export async function runColibriModels(action: string, flags: Record<string, any>, options: {
  ask: (question: string) => Promise<string>; signal?: AbortSignal; embedded?: boolean;
}): Promise<LocalModelResult> {
  if (flags.host) throw new Error('Notch-managed Colibri binds only to localhost; --host is for Ollama.');
  if (action === 'unload') { await stopColibri(); console.log('Colibri stopped; downloaded weights remain available.'); return { code: 0 }; }
  if (action === 'status') { console.log(JSON.stringify(await colibriStatus(), null, 2)); return { code: 0 }; }
  if (!(await colibriStatus()).installed) {
    if (action !== 'install' || (!flags.yes && !/^(y|yes)$/i.test(await options.ask('Install the experimental Colibri engine (under 16 MB; Python 3.10+ required)? [y/N] ')))) {
      console.log('Set up Colibri with notch models install --runner colibri. Model weights are a separate download.'); return { code: 0 };
    }
    await prepareColibri(options.signal);
  }
  const rows = await colibriCatalog(options.signal);
  if (action !== 'install') { console.log(JSON.stringify({ engine: 'colibri', experimental: true, models: rows }, null, 2)); return { code: 0 }; }
  console.log('Colibri is experimental. Large models may have very slow prompt processing. Downloads resume after interruption.');
  const memory = rows[0]?.memory;
  if (memory) console.log(`RAM available now: ${(memory.availableBytes / 1e9).toFixed(1)} GB of ${(memory.totalBytes / 1e9).toFixed(1)} GB usable RAM. Keeping ${(memory.reserveBytes / 1e9).toFixed(1)} GB headroom.`);
  console.log('Pre-download estimates include a safety reserve. Download size is disk space, not RAM. Exact model/context checks run before loading. Rerun this command to refresh memory.');
  if (flags.modelDir && flags.model) throw new Error('Choose --model or --model-dir, not both.');
  let selected = rows.find(row => row.id === flags.model);
  if (flags.model && !selected) throw new Error('Choose a Colibri catalog model id, not an Ollama tag or GGUF repository.');
  if (!selected && !flags.modelDir) {
    const labels = rows.map(row => `${row.fitLabel} · ${row.name} · ${row.download_gb} GB download · ${row.ram_min_gb}/${row.ram_good_gb} GB RAM minimum/recommended · ${row.reason}`);
    let index: number | undefined;
    if (process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== 'dumb') {
      const { selectOption } = await import('../ui/select.js');
      index = await selectOption(labels, Math.max(0, rows.findIndex(row => row.fits)), process.stdin, process.stdout, 'Colibri · experimental', true);
    } else { labels.forEach((label, i) => console.log(`  ${i + 1}. ${label}`)); const answer = await options.ask('Model number or q to cancel: '); if (answer.toLowerCase() === 'q') return { code: 0 }; index = Number(answer) - 1; }
    if (index === undefined) return { code: 0 }; selected = rows[index];
  }
  if (!flags.modelDir && !selected?.fits) throw new Error(selected?.reason || 'Choose a listed model.');
  if (!flags.yes && !/^(y|yes)$/i.test(await options.ask(flags.modelDir ? 'Validate these converted Colibri weights and use them for this project? [y/N] ' : `Download ${selected!.name} (${selected!.download_gb} GB), verify it and use it for this project? [y/N] `))) return { code: 0 };
  const ready=await installColibri(selected?.id || '', { signal: options.signal, modelDir: flags.modelDir, output: text => process.stdout.write(text), unloadAfterValidation:flags.launch===false || !options.embedded });
    const selection: ByokConfigBlock = { provider: 'colibri', model: ready.modelId, baseUrl: ready.baseUrl, ...(selected?{sourceRepo:selected.repo}:{}) };
    await persistConfigPatch(flags.cwd, { provider: selection, byok: undefined, model: undefined, baseUrl: undefined, apiKey: undefined });
    console.log(`Ready: colibri/${ready.modelId}. Automatic context: ${ready.contextWindow.toLocaleString()} tokens. Saved for ${flags.cwd}.`);
    return { code: 0, selection, ...(flags.launch !== false && !options.embedded && process.stdin.isTTY ? { launch: flags.cwd } : {}) };
}
