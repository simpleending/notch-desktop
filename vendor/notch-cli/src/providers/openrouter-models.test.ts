import { describe, expect, it } from 'vitest';
import {
  formatContextLength,
  formatOpenRouterPricePerMillion,
  selectTopOpenRouterCodingModels,
  type OpenRouterModel,
} from './openrouter-models.js';

describe('OpenRouter coding model selection', () => {
  it('keeps OpenRouter programming order while requiring tool-capable text models', () => {
    const models: OpenRouterModel[] = [
      {
        id: 'deepseek/deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        context_length: 1_048_576,
        architecture: { output_modalities: ['text'] },
        pricing: { prompt: '0.0000001', completion: '0.0000002' },
        supported_parameters: ['tools', 'structured_outputs'],
      },
      {
        id: 'image/not-a-coder',
        architecture: { output_modalities: ['image'] },
        supported_parameters: ['tools'],
      },
      {
        id: 'anthropic/claude-sonnet-4.6',
        name: 'Claude Sonnet 4.6',
        top_provider: { context_length: 1_000_000, max_completion_tokens: 64_000, is_moderated: true },
        architecture: { output_modalities: ['text'] },
        supported_parameters: ['tool_choice', 'structured_outputs'],
      },
    ];

    const selected = selectTopOpenRouterCodingModels(models, 7);

    expect(selected.map((model) => model.modelRef)).toEqual([
      'openrouter/deepseek/deepseek-v4-flash',
      'openrouter/anthropic/claude-sonnet-4.6',
    ]);
    expect(selected[0]?.supportsTools).toBe(true);
    expect(selected[1]?.contextLength).toBe(1_000_000);
  });

  it('formats OpenRouter model metadata for compact CLI rows', () => {
    expect(formatContextLength(1_048_576)).toBe('1.0M');
    expect(formatContextLength(262_144)).toBe('262K');
    expect(formatOpenRouterPricePerMillion('0.0000001')).toBe('$0.10');
    expect(formatOpenRouterPricePerMillion('0')).toBe('$0');
    expect(formatOpenRouterPricePerMillion(null)).toBe('?');
  });
});
