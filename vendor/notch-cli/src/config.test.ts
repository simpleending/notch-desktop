import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig, persistConfigPatch, selectModel } from './config.js';
import { persistOllamaChoice } from './commands/ollama-launch.js';

let cwd: string;
beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), 'notch-config-'));
  for (const key of ['NOTCH_MODEL', 'NOTCH_PROVIDER', 'NOTCH_BASE_URL', 'NOTCH_API_KEY', 'OLLAMA_API_KEY']) vi.stubEnv(key, '');
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(cwd, { recursive: true, force: true }); });

describe('provider configuration', () => {
  it('disables implicit hybrid routing on provider selection while preserving its settings',async()=>{
    const hybrid={enabled:true,primary:{provider:'openrouter',model:'previous'},fallback:{provider:'openai',model:'backup'}};
    await fs.writeFile(path.join(cwd,'.notch.json'),JSON.stringify({hybrid}));
    await persistConfigPatch(cwd,{provider:{provider:'ollama',model:'local'}});
    expect(JSON.parse(await fs.readFile(path.join(cwd,'.notch.json'),'utf8')).hybrid).toEqual({...hybrid,enabled:false});
  });
  it('round-trips guided memory settings and drops them when changing providers',async()=>{
    await persistConfigPatch(cwd,{provider:{provider:'ollama',model:'local',contextWindow:8192,ollamaBatch:64,sourceRepo:'owner/model'}});
    const config=await loadConfig({projectRoot:cwd});
    expect(config.models.chat).toMatchObject({contextWindow:8192,ollamaBatch:64,sourceRepo:'owner/model'});
    const next=selectModel(config.models.chat,{provider:'openai',model:'fixture'});
    expect(next.contextWindow).toBeUndefined();expect(next.ollamaBatch).toBeUndefined();expect(next.sourceRepo).toBeUndefined();
  });
  it('reads the selected project rather than process.cwd and uses provider defaults', async () => {
    await fs.writeFile(path.join(cwd, '.notch.json'), JSON.stringify({ provider: { provider: 'ollama' }, maxIterations: 7 }));
    const config = await loadConfig({ projectRoot: cwd });
    expect(config.models.chat.model).not.toContain('openrouter');
    expect(config.models.chat.byokProvider).toBe('ollama');
    expect(config.maxIterations).toBe(7);
  });
  it('drops credentials, headers, protocol and endpoint when switching providers', () => {
    const selected = selectModel({ model: 'ollama/qwen3:4b', apiKey: 'old-key', baseUrl: 'http://localhost:11434', byokApiShape: 'anthropic', byokHeaders: { Authorization: 'old-key' }, headers: { Authorization: 'old-key' } }, { provider: 'openrouter', model: 'openrouter/test/coder' });
    expect(selected).toEqual({ model: 'test/coder', byokProvider: 'openrouter' });
  });
  it('applies flags after environment and keeps an explicit endpoint', async () => {
    vi.stubEnv('NOTCH_PROVIDER', 'ollama');
    vi.stubEnv('NOTCH_MODEL', 'qwen3:4b');
    const config = await loadConfig({ projectRoot: cwd }, { provider: 'openrouter', model: 'test/coder', baseUrl: 'https://example.com/v1', apiKey: 'explicit' });
    expect(config.models.chat).toMatchObject({ byokProvider: 'openrouter', model: 'test/coder', baseUrl: 'https://example.com/v1', apiKey: 'explicit' });
  });
  it('replaces stale provider blocks when saving Ollama and preserves unrelated preferences', async () => {
    await fs.writeFile(path.join(cwd, '.notch.json'), JSON.stringify({ provider: { provider: 'openrouter' }, apiKey: 'old', theme: 'aurora' }));
    await persistOllamaChoice(cwd, { providerId: 'ollama', modelId: 'qwen3:4b', baseUrl: 'localhost:11434', apiShape: 'openai' });
    const config = JSON.parse(await fs.readFile(path.join(cwd, '.notch.json'), 'utf8'));
    expect(config.provider).toEqual({ provider: 'ollama', model: 'qwen3:4b', baseUrl: 'http://localhost:11434/v1', apiShape: 'openai' });
    expect(config.theme).toBe('aurora');
    expect(config.apiKey).toBeUndefined();
    expect((await loadConfig({ projectRoot: cwd })).models.chat.byokProvider).toBe('ollama');
  });
  it('does not overwrite malformed config during setup', async () => {
    const file = path.join(cwd, '.notch.json');
    await fs.writeFile(file, '{broken');
    await expect(persistConfigPatch(cwd, { theme: 'aurora' })).rejects.toThrow();
    expect(await fs.readFile(file, 'utf8')).toBe('{broken');
    await expect(loadConfig({ projectRoot: cwd })).rejects.toThrow('Cannot read');
  });
  it('rejects mismatched provider references', () => {
    expect(() => selectModel({ model: 'ollama/qwen3:4b' }, { provider: 'ollama', model: 'openrouter/test/model' })).toThrow('must match');
  });
});
