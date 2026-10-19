import { describe, expect, it } from 'vitest';
import { findByokProvider, isByokRef, parseByokRef, openRouterFallbackIds } from './byok.js';

describe('provider model refs', () => {
  it('accepts OpenCode-style provider/model refs', () => {
    expect(isByokRef('openrouter/anthropic/claude-sonnet-4.6')).toBe(true);
    expect(parseByokRef('openrouter/anthropic/claude-sonnet-4.6')).toEqual({
      provider: 'openrouter',
      model: 'anthropic/claude-sonnet-4.6',
    });
  });

  it('keeps legacy provider:model refs working', () => {
    expect(isByokRef('ollama:llama3.2:latest')).toBe(true);
    expect(parseByokRef('ollama:llama3.2:latest')).toEqual({
      provider: 'ollama',
      model: 'llama3.2:latest',
    });
  });

  it('does not treat bare Ollama tags as provider refs', () => {
    expect(isByokRef('llama3.2:latest')).toBe(false);
  });

  it('builds an OpenRouter fallback list that excludes the primary and caps at three', () => {
    expect(openRouterFallbackIds('openai/gpt-4.1', [
      'openrouter/openai/gpt-4.1',
      'google/gemini-3.5-flash',
      'openrouter/deepseek/deepseek-v4-flash',
      'moonshotai/kimi-k2.6',
      'qwen/qwen3.7-max',
    ])).toEqual(['google/gemini-3.5-flash', 'deepseek/deepseek-v4-flash', 'moonshotai/kimi-k2.6']);
  });

  it('includes current OpenAI-compatible provider presets', () => {
    expect(findByokProvider('google')?.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta/openai');
    expect(findByokProvider('google')?.defaultModel).toBe('gemini-3.5-flash');
    expect(findByokProvider('deepseek')?.baseUrl).toBe('https://api.deepseek.com');
    expect(findByokProvider('deepseek')?.defaultModel).toBe('deepseek-v4-flash');
  });
});
