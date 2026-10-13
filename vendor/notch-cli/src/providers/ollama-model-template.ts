import { createHash } from 'node:crypto';
import { ollamaRoot } from './ollama-url.js';
import { showModel } from './ollama.js';
export interface OllamaTemplate { template?: string; renderer?: string; parser?: string; requires?: string }

async function blob(root: string, digest: string, signal?: AbortSignal): Promise<string> {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) throw new Error('Official model manifest has an invalid template digest.');
  const response = await fetch(`${root}/blobs/${digest}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Could not obtain official model metadata (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 256 * 1024 || `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== digest) throw new Error('Official model template checksum failed.');
  return bytes.toString('utf8');
}

export async function officialOllamaTemplate(base: string, signal?: AbortSignal): Promise<OllamaTemplate> {
  const match = /^([a-z0-9._-]+):([a-z0-9._-]+)$/.exec(base);
  if (!match) throw new Error('Invalid official template model reference.');
  const root = `https://registry.ollama.ai/v2/library/${match[1]}`;
  const response = await fetch(`${root}/manifests/${match[2]}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Cannot read the official ${base} template (HTTP ${response.status}).`);
  const manifest = await response.json() as { config: { digest: string }; layers: { mediaType: string; digest: string }[] };
  const layer = manifest.layers.find(item => item.mediaType === 'application/vnd.ollama.image.template');
  const config = JSON.parse(await blob(root, manifest.config.digest, signal)) as { renderer?: string; parser?: string; requires?: string };
  const template = layer ? await blob(root, layer.digest, signal) : undefined;
  if ((!config.renderer || !config.parser) && !template?.includes('.Tools')) throw new Error(`${base} has no verifiable tool-capable template.`);
  return { template, renderer: config.renderer, parser: config.parser, requires: config.requires };
}

export async function createToolReadyAlias(source: string, setup: OllamaTemplate, host: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256').update(source + JSON.stringify(setup)).digest('hex').slice(0, 12);
  const model = `notch-hf-${hash}`;
  try { if ((await showModel(model, host)).capabilities?.includes('tools')) return model; } catch { /* Create the alias below. */ }
  const response = await fetch(`${ollamaRoot(host)}/api/create`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(120000)]) : AbortSignal.timeout(120000),
    body: JSON.stringify({ model, from: source, ...setup, stream: false }) });
  const body = await response.json() as { error?: string; status?: string };
  if (!response.ok || body.error || body.status !== 'success') throw new Error(`Could not prepare tool calling: ${body.error || response.status}.`);
  if (!(await showModel(model, host)).capabilities?.includes('tools')) throw new Error('The prepared alias still does not advertise tools; current selection is unchanged.');
  return model;
}
