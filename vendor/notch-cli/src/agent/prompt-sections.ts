/**
 * Notch CLI — Cacheable System Prompt Sections
 *
 * A system prompt is assembled from an ordered list of sections. Sections
 * that are stable across turns (tone, tool descriptions, built-in agent
 * registry) are marked `cacheBreak: false` so a provider-side prompt cache
 * can reuse the prefix. Sections whose contents change turn-to-turn (cwd
 * listing, memories, repo map snapshots) are marked `cacheBreak: true`.
 *
 * The FIRST cacheBreak=true section establishes the cache boundary, marked
 * in the rendered prompt with the literal string `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__`.
 * Everything BEFORE the boundary is cacheable across turns/sessions/users
 * running the same notch build; everything AFTER is session/user-specific.
 *
 * When we add an Anthropic provider with native prompt caching, the boundary
 * is the natural place to attach `cache_control: { type: 'ephemeral' }`.
 * On OpenAI-compat endpoints (Nova/Forge/Pyre/Solace/etc.) the marker is
 * currently informational — it simply documents WHERE caching would apply
 * if the endpoint supported it. Do not strip the marker: downstream renderers
 * (diagnostics, /context readout) look for it.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

/**
 * Literal boundary marker placed at the first cache-breaking section.
 * Exported so other modules (diagnostics, cache adapters) can locate the
 * split point without re-implementing the joining logic.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__';

/**
 * A single system-prompt section.
 *
 * `compute` is called at most once per turn per unique name. The returned
 * string (or empty-string for "nothing to contribute") becomes this section's
 * contribution to the final prompt.
 */
export interface PromptSection {
  name: string;
  compute: () => Promise<string> | string;
  /**
   * When true, this section is treated as volatile. The FIRST cacheBreak
   * section in the list marks the boundary between the cacheable prefix
   * and the volatile suffix.
   */
  cacheBreak?: boolean;
  /** Human-readable reason, required for DANGEROUS_ sections. */
  reason?: string;
}

/**
 * Create a normal, cacheable section. Use this by default — only reach for
 * the DANGEROUS variant if you actually need to break the cache each turn.
 */
export function safeSection(
  name: string,
  compute: () => Promise<string> | string,
  cacheBreak: boolean = false,
): PromptSection {
  return { name, compute, cacheBreak };
}

/**
 * Create a volatile section that WILL invalidate the prompt cache on every
 * turn where its content changes. The `reason` argument is required at the
 * TYPE level (not merely validated at runtime) to force anyone using this
 * function to stop and think — and to leave an audit trail of WHY a given
 * dynamic section was deemed necessary.
 *
 * The DANGEROUS_ prefix is intentional: code review should flag any new
 * callsite and ask "can this be made cacheable instead?".
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: () => Promise<string> | string,
  reason: string,
): PromptSection {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(
      `DANGEROUS_uncachedSystemPromptSection("${name}") requires a non-empty reason string`,
    );
  }
  return { name, compute, cacheBreak: true, reason };
}

// ---------------------------------------------------------------------------
// Memoization
// ---------------------------------------------------------------------------
//
// Section outputs are cached keyed by (section.name, contentHash). This lets
// us skip recomputing stable sections across turns. The cache is invalidated
// by `clearSectionCache()` — called on /clear, /compact, or when the caller
// decides it's time to start fresh.

interface CacheEntry {
  content: string;
  /** Simple FNV-1a hash of the content, used to detect drift. */
  hash: number;
}

const sectionCache = new Map<string, CacheEntry>();

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h;
}

/** Clear every memoized section. Call on /clear and /compact. */
export function clearSectionCache(): void {
  sectionCache.clear();
}

/** Number of currently-cached sections. Useful for diagnostics. */
export function sectionCacheSize(): number {
  return sectionCache.size;
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/**
 * Compose an ordered list of sections into a single system prompt string.
 *
 * Rules:
 *  - Section names must be unique.
 *  - Empty / null-ish compute results are dropped (the section contributes
 *    nothing).
 *  - The FIRST section with cacheBreak=true gets the boundary marker
 *    prepended to its rendered content. Subsequent cacheBreak sections are
 *    joined normally (the marker appears exactly once).
 *  - Non-cacheBreak sections are memoized by name; cacheBreak sections are
 *    always recomputed.
 */
export async function composeSystemPrompt(sections: PromptSection[]): Promise<string> {
  // Validate: unique names.
  const seen = new Set<string>();
  for (const s of sections) {
    if (seen.has(s.name)) {
      throw new Error(`composeSystemPrompt: duplicate section name "${s.name}"`);
    }
    seen.add(s.name);
  }

  const rendered: string[] = [];
  let boundaryInserted = false;

  for (const s of sections) {
    let content: string;

    if (!s.cacheBreak && sectionCache.has(s.name)) {
      content = sectionCache.get(s.name)!.content;
    } else {
      const raw = await s.compute();
      content = (raw ?? '').toString();
      if (!s.cacheBreak) {
        sectionCache.set(s.name, { content, hash: fnv1a(content) });
      }
    }

    // Skip empty contributions so consecutive joins don't produce blank runs.
    if (content.trim() === '') continue;

    if (s.cacheBreak && !boundaryInserted) {
      rendered.push(SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
      boundaryInserted = true;
    }

    rendered.push(content);
  }

  return rendered.join('\n\n');
}

/**
 * Return the (ordered) list of section names that would be used as the
 * cache prefix — i.e. everything up to (but not including) the first
 * cacheBreak=true section. Useful for diagnostics / /context readout.
 */
export function cacheablePrefixNames(sections: PromptSection[]): string[] {
  const out: string[] = [];
  for (const s of sections) {
    if (s.cacheBreak) break;
    out.push(s.name);
  }
  return out;
}
