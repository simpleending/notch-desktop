import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { desktopInstructionsForContext } from '../src/context-prompts.mjs';
const builtin = (await fs.readFile(new URL('./fixtures/desktop-general-instructions.txt', import.meta.url), 'utf8')).replaceAll('\r\n', '\n').trim();

test('8K and 16K use progressively fuller guidance; 32K keeps full workflow detail without extra content moderation', () => {
  const lean = desktopInstructionsForContext(builtin, 8192), medium = desktopInstructionsForContext(builtin, 16384);
  assert(lean.length < medium.length && medium.length < builtin.length);
  const full = desktopInstructionsForContext(builtin, 32768);
  assert(full.length > medium.length && full.includes('<research_and_verification>'));
  for (const prompt of [lean, medium, full]) assert(!/refusal_handling|user_wellbeing|Refuse harmful requests/.test(prompt));
  for (const prompt of [lean, medium]) for (const instruction of ['untrusted', 'permission mode', 'authorization', 'Never invent', 'across turns']) assert(prompt.includes(instruction));
});

test('custom instructions and user additions remain unchanged at every tier', () => {
  const suffix = '\nUser rule: never edit the protected folder. ' + 'Custom instructions. '.repeat(1000);
  for (const window of [8192, 16384, 32768]) {
    assert(desktopInstructionsForContext(builtin + suffix, window).endsWith(suffix));
    assert.equal(desktopInstructionsForContext(suffix, window), suffix);
    const altered = builtin.replace('desktop agentic', 'custom desktop');
    assert.equal(desktopInstructionsForContext(altered, window), altered);
  }
});
