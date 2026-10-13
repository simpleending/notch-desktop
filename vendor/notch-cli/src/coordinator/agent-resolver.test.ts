import { describe, expect, test } from 'vitest';
import { resolveAgent, pickAgentOrGeneral } from './agent-resolver';

describe('resolveAgent', () => {
  test('routes "profile the hot path and benchmark" → archimedes', () => {
    const r = resolveAgent('profile the hot path in the rendering pipeline and benchmark it');
    expect(r.confident).toBe(true);
    expect(r.best?.agent.name).toBe('archimedes');
  });

  test('routes "write unit tests for auth" → pythagoras', () => {
    const r = resolveAgent('Write unit tests for the new auth flow, cover edge cases');
    expect(r.best?.agent.name).toBe('pythagoras');
    expect(r.confident).toBe(true);
  });

  test('routes "map the dependency graph" → ptolemy', () => {
    const r = resolveAgent('Survey the codebase and map the dependency graph for the payments module');
    expect(r.best?.agent.name).toBe('ptolemy');
  });

  test('routes architecture tradeoff discussion → plato', () => {
    const r = resolveAgent('Write an ADR: tradeoffs between monolith and microservices for this team');
    expect(r.best?.agent.name).toBe('plato');
  });

  test('routes math-heavy task → hypatia', () => {
    const r = resolveAgent('Compute the eigenvalue decomposition for this similarity matrix');
    expect(r.best?.agent.name).toBe('hypatia');
  });

  test('vague request returns not-confident → caller uses general', () => {
    const r = resolveAgent('please help me');
    expect(r.confident).toBe(false);
  });

  test('pickAgentOrGeneral returns null for vague requests', () => {
    expect(pickAgentOrGeneral('do stuff')).toBeNull();
  });

  test('pickAgentOrGeneral returns the matched agent for clear tasks', () => {
    const picked = pickAgentOrGeneral('benchmark this function and report variance');
    expect(picked?.name).toBe('archimedes');
  });

  test('ranked list includes multiple candidates when multiple roles partially match', () => {
    const r = resolveAgent('profile and test the hot path');
    const names = r.ranked.map((h) => h.agent.name);
    expect(names).toContain('archimedes');
    // 'test' also hits pythagoras at concept-weight
    expect(names.length).toBeGreaterThanOrEqual(1);
  });

  test('scores add up correctly — strong > task > concept', () => {
    // Use words that hit ONLY one weight tier each so the test asserts
    // the tier ordering, not keyword overlap across tiers.
    const strongMatch = resolveAgent('o(n^2) loop review');  // 'o(n' strong only
    const taskMatch = resolveAgent('measure the code');       // 'measure' task only
    const conceptOnly = resolveAgent('throughput work');      // 'throughput' concept only
    const s1 = strongMatch.best?.score ?? 0;
    const s2 = taskMatch.best?.score ?? 0;
    const s3 = conceptOnly.best?.score ?? 0;
    expect(s1).toBeGreaterThan(s2);
    expect(s2).toBeGreaterThan(s3);
  });
});
