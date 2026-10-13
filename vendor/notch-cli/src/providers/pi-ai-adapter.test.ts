import { describe, expect, it } from 'vitest';
import { getBuiltinModels } from '@earendil-works/pi-ai/providers/all';
import { computePiAiCostUsd, resolveModelViaPiAi } from './pi-ai-adapter.js';

describe('optional pi cost catalog', () => {
  it('resolves a current catalog model without credentials or inference', async () => {
    const model = getBuiltinModels('openai')[0]!;
    const handle = await resolveModelViaPiAi({byokProvider:'openai',model:model.id});
    expect(handle.model).toMatchObject({id:model.id,provider:'openai'});
    const cost = await computePiAiCostUsd({byokProvider:'openai',model:model.id},{input:10,output:5});
    expect(typeof cost).toBe('number');expect(Number.isFinite(cost)).toBe(true);
  });
  it('returns no estimate for unsupported local providers', async () => {
    expect(await computePiAiCostUsd({byokProvider:'ollama',model:'fixture'},{input:10,output:5})).toBeNull();
  });
});
