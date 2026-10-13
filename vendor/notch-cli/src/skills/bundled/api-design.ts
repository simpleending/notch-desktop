/**
 * Notch CLI — Bundled Skill: api-design
 *
 * Reviews a TypeScript API/interface design against a checklist of
 * conventions covering naming, generics, discriminated unions, and error
 * contracts. Outputs a five-paragraph review framework.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { registerSkill } from '../registry.js';
import type { Skill } from '../types.js';

const CHECKLIST_MD = `# TypeScript API Design Checklist

Use this as a reference when reviewing a public-facing TypeScript surface
(library exports, SDK methods, plugin contracts). Not every item applies
to every API — flag the ones that matter and skip the rest.

## 1. Naming

- Types and interfaces: \`PascalCase\`. Never prefix with \`I\` (\`IUser\`).
- Functions and variables: \`camelCase\`.
- Type parameters: single capital letters for one-generic (\`T\`), meaningful
  PascalCase for two+ (\`TNode\`, \`TError\`). Never lowercase.
- Enum-like string unions: SCREAMING not required; prefer \`kebab-case\`
  literals for wire compat (\`'in-progress'\`), camelCase for internal.
- Boolean props: positive phrasing (\`isEnabled\`, \`hasChildren\`), not
  \`notDisabled\`. Avoid bare \`enabled\` — prefix with \`is\`/\`has\`/\`can\`.
- Options bags: suffix with \`Options\` or \`Config\`. Results with \`Result\`.
- Event / callback params: \`on<Verb>\` for handlers (\`onSelect\`), past-tense
  verb for emitted events (\`selected\`).

## 2. Interface vs Type alias

- Use \`interface\` for object shapes that might be extended by consumers
  (plugin points, DI). Interface declarations merge — that's usually a
  footgun, but sometimes the right answer.
- Use \`type\` for unions, tuples, conditional types, and object shapes
  that are sealed from consumer extension.
- Don't mix styles for siblings — a public API should look uniform.

## 3. Generics

- Add a type parameter only when a consumer will meaningfully benefit from
  preserving input type through the return. \`<T>(x: T): T\` is useful;
  \`<T>(x: T): string\` is noise.
- Always constrain generics (\`<T extends object>\`) when the body assumes
  anything about \`T\`. Unconstrained \`T\` is a liar about what it accepts.
- Default type params (\`<T = unknown>\`) for optional generics. Don't force
  the caller to write \`<unknown>\` to opt out.
- Avoid generic parameters that only appear in the return type — those are
  often an inference hazard and usually a sign you want overloads instead.

## 4. Discriminated unions for state

Prefer a discriminated union over optional-everywhere:

    // BAD — every consumer has to null-check everything
    type FetchState = {
      loading: boolean; data?: User; error?: Error;
    };

    // GOOD — one state at a time, narrow by \`status\`
    type FetchState =
      | { status: 'idle' }
      | { status: 'loading' }
      | { status: 'success'; data: User }
      | { status: 'error'; error: Error };

The discriminant lives on the value (\`status: '...'\` literal), not in a
separate flag. Use \`exhaustiveness checks\` (\`never\` in default branch) so
adding a new state breaks the compiler until every consumer is updated.

## 5. Error contracts

- Never \`throw\` an untyped value. Throw \`Error\` subclasses with a stable
  \`name\` ('MissingApiKeyError', 'RateLimitedError'). Consumers discriminate
  on \`name\`, not \`instanceof\` (survives dual-bundling).
- For expected failure modes (not-found, validation), prefer a
  \`Result<T, E>\` / discriminated-union return over throwing. Throwing is
  for programmer errors and unrecoverable I/O.
- Async functions must type their rejection shape in JSDoc (TS can't type
  rejections). If you use Result-types, that's self-documenting.

## 6. Optionality and defaults

- \`T | undefined\` is an explicit signal. \`T | null\` is rarely right —
  pick one and stick with it across the API.
- \`foo?: T\` in options bags is fine. In return types, prefer explicit
  \`foo: T | undefined\` so destructuring callers don't miss the field.
- Document defaults in JSDoc — \`@default 10\` — so tsdoc and editors surface
  them.

## 7. Deprecation

- Mark with \`/** @deprecated use X instead */\`. Keep the symbol exported
  for at least one minor version. Remove only at a major.
- Don't break the type shape during a deprecation window.

## 8. Public surface hygiene

- Everything a consumer can reach must have a JSDoc summary.
- Don't export implementation types that leak private details. If a type
  is in your \`index.ts\` export, consumers can depend on it — plan for that.
- Never export classes whose constructors take complex framework-internal
  dependencies. Offer a factory function instead.
`;

const PROMPT = `You are reviewing a proposed TypeScript API surface. The user will supply
a file path, a commit/PR, a code snippet, or a description. Review it
against the checklist at \`checklist.md\` (in the base directory above).

## Review framework — five paragraphs, in this order

**1. Surface summary.** One paragraph. Describe what you read: the
exported names, the general intent, and where it sits in the broader
system. Cite the file paths or PR diff you inspected.

**2. What's good.** One paragraph. Call out the design choices that hold
up: consistent naming, appropriate generics, clean error contracts, clear
separation of concerns. Be specific; generic praise helps nobody.

**3. Concrete issues.** One paragraph (or a short numbered list if there
are many). For each issue: which checklist item it trips (by section
number from the reference file), why it matters for consumers, and the
specific line(s) affected. Sort by severity — consumer-breaking first,
cosmetic last.

**4. Suggested redesign.** One paragraph with a code sketch. Show the
refactored shape, not prose describing it. Keep the sketch minimal —
just enough to make the change shape concrete. If multiple issues have
the same fix, show them resolved together.

**5. Risk and rollout.** One paragraph. Is this a breaking change? What
versioning cost does the redesign carry? Are there consumers you can see
in the repo that will need to migrate? If the answer is "it's fine,
ship it," say so — don't manufacture risk.

## Tool usage

- \`Read\` the referenced file(s) in full.
- \`Grep\` for consumers of the exported symbols — a suggestion is easier
  to make when you know who the change hits.
- Do NOT edit files. This skill produces a review, not a patch.
`;

export const apiDesignSkill: Skill = {
  id: 'api-design',
  name: 'API Design Review',
  description: 'Review a TypeScript API/interface design against conventions and produce a five-paragraph review.',
  prompt: PROMPT,
  files: {
    'checklist.md': CHECKLIST_MD,
  },
  allowedTools: ['read', 'grep', 'glob'],
};

registerSkill(apiDesignSkill);
