import { describe, expect, it } from 'vitest';
import {
  autoDetectPreset,
  extractTemplateToolCalls,
  extractToolCallsFromText,
  looksLikeFailedToolCall,
} from './correction.js';

describe('correction helpers', () => {
  const tools = ['Read', 'Edit', 'Shell'];

  it('detects a failed JSON-style tool call', () => {
    expect(looksLikeFailedToolCall('I will use Read with {"name":"Read","arguments":{"path":"src/a.ts"}}', tools))
      .toBe(true);
  });

  it('does not flag ordinary text with one weak signal', () => {
    expect(looksLikeFailedToolCall('I read through the code and here is the answer.', tools))
      .toBe(false);
  });

  it('extracts XML-wrapped tool calls', () => {
    const calls = extractToolCallsFromText(
      '<tool_call>{"name":"Read","arguments":{"file":"package.json"}}</tool_call>',
      tools,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('Read');
    expect(calls[0]?.args).toEqual({ file: 'package.json' });
  });
  it('recovers complete Qwen function syntax observed in a real local run', () => {
    const output="I'll read the file.\n<function=read>\n<parameter=path>\nimplementation.mjs\n</parameter>\n<parameter=limit>10</parameter>\n</function>\n</tool_call>";
    expect(looksLikeFailedToolCall(output,['read'])).toBe(true);
    expect(extractToolCallsFromText(output,['read'])).toMatchObject([{name:'read',args:{path:'implementation.mjs',limit:10}}]);
    expect(extractToolCallsFromText(output,['write'])).toEqual([]);
    expect(extractToolCallsFromText(output.replace('</function>',''),['read'])).toEqual([]);
    expect(extractToolCallsFromText('```xml\n'+output+'\n```',['read'])).toEqual([]);
  });

  it('extracts template-format tool calls and coerces primitives', () => {
    const calls = extractTemplateToolCalls(
      ['TOOL: Shell', 'ARG_command: npm test', 'ARG_timeout: 120000', 'ARG_dryRun: false'].join('\n'),
      tools,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe('Shell');
    expect(calls[0]?.args).toEqual({ command: 'npm test', timeout: 120000, dryRun: false });
  });

  it('selects safer presets for known model classes', () => {
    expect(autoDetectPreset('claude-sonnet-4').maxCorrectionAttempts).toBe(0);
    expect(autoDetectPreset('qwen2.5-coder-7b').intentGate).toBe(true);
    expect(autoDetectPreset('gemma-2b').useTemplateFormat).toBe(true);
  });
});
