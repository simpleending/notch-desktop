/**
 * Notch CLI — Event Router (clawhip-style)
 *
 * Queues events from out-of-band sources (git state changes, GitHub
 * notifications, CI completions, filesystem watchers) so they do NOT
 * inflate the agent's conversation context. The router stores events in
 * an in-memory ring buffer; the CLI/UI surfaces them through tail
 * notifications, and the agent can opt-in to see them via a tool.
 *
 * Modeled on the `clawhip` layer described in ultraworkers/claw-code's
 * PHILOSOPHY.md — "notification routing must be decoupled from agent
 * reasoning to maintain focus".
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { pushTailNotification } from '../permissions/dispatcher.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventSeverity = 'info' | 'warn' | 'error' | 'success';

export interface AgentEvent {
  /** Stable id derived from source+dedup key so retries don't duplicate. */
  id: string;
  /** Emitting source (e.g. `git`, `github`, `fs`, `ci`). */
  source: string;
  /** Subtype for routing (e.g. `commit`, `pr-merged`, `ci-failed`). */
  type: string;
  /** Epoch ms. */
  ts: number;
  severity: EventSeverity;
  /** Single-line human-readable description. */
  title: string;
  /** Optional longer body / payload. */
  payload?: Record<string, unknown>;
  /**
   * When true, the agent is expected to acknowledge (drain) this event
   * before the next planning cycle. When false (default), events are
   * purely advisory.
   */
  ackRequired?: boolean;
  /** Marks this event as drained — lingers in history for auditing. */
  drained?: boolean;
  /** When the event was drained (epoch ms). */
  drainedAt?: number;
}

export interface EventFilter {
  /** If present, only events from these sources pass. */
  sources?: string[];
  /** If present, only events of these types pass. */
  types?: string[];
  /** If present, only events at or above this severity pass. */
  minSeverity?: EventSeverity;
}

// ---------------------------------------------------------------------------
// EventRouter
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<EventSeverity, number> = {
  info: 0,
  success: 1,
  warn: 2,
  error: 3,
};

export interface RouterOptions {
  /** Ring buffer capacity. Oldest events drop when exceeded. Default 256. */
  capacity?: number;
  /**
   * Events whose severity meets this threshold are ALSO pushed to the
   * tail-notification queue so the REPL surfaces them between turns.
   * Default `'warn'`.
   */
  tailNotifyMin?: EventSeverity;
  /**
   * Max age for events before they're pruned on the next operation.
   * Default 6 hours. Set to Infinity to disable.
   */
  maxAgeMs?: number;
  /**
   * Optional filter — events that don't match are silently dropped at
   * emit time. Useful for per-session allowlists.
   */
  filter?: EventFilter;
}

export class EventRouter {
  private events: AgentEvent[] = [];
  private readonly capacity: number;
  private readonly tailNotifyMin: EventSeverity;
  private readonly maxAgeMs: number;
  private readonly filter?: EventFilter;
  private readonly subscribers = new Set<(e: AgentEvent) => void>();

  constructor(opts: RouterOptions = {}) {
    this.capacity = opts.capacity ?? 256;
    this.tailNotifyMin = opts.tailNotifyMin ?? 'warn';
    this.maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60 * 1000;
    this.filter = opts.filter;
  }

  /**
   * Emit an event. Returns the stored event (with normalized id/ts) or
   * null if it was dropped by filtering.
   */
  emit(partial: Omit<AgentEvent, 'ts' | 'id' | 'drained'> & { ts?: number; id?: string }): AgentEvent | null {
    const ts = partial.ts ?? Date.now();
    const id = partial.id ?? `${partial.source}:${partial.type}:${ts}`;
    const ev: AgentEvent = {
      id,
      source: partial.source,
      type: partial.type,
      ts,
      severity: partial.severity,
      title: partial.title,
      payload: partial.payload,
      ackRequired: partial.ackRequired,
      drained: false,
    };

    if (!this.passesFilter(ev)) return null;

    this.pruneOld();

    // Dedup by id: if an identical event is already queued (not drained),
    // replace its payload + ts rather than double-queueing.
    const existing = this.events.findIndex((e) => e.id === ev.id && !e.drained);
    if (existing >= 0) {
      this.events[existing] = ev;
    } else {
      this.events.push(ev);
      if (this.events.length > this.capacity) {
        this.events.splice(0, this.events.length - this.capacity);
      }
    }

    // Tail-notify if severity meets threshold.
    if (SEVERITY_RANK[ev.severity] >= SEVERITY_RANK[this.tailNotifyMin]) {
      try {
        pushTailNotification(`${ev.source}: ${ev.title}`);
      } catch {
        // Never block emit on notification failure.
      }
    }

    for (const sub of this.subscribers) {
      try {
        sub(ev);
      } catch {
        // Subscriber errors must not stop propagation.
      }
    }

    return ev;
  }

  /**
   * Subscribe to future emits. Returns an unsubscribe function.
   */
  subscribe(fn: (e: AgentEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /**
   * Return all pending (un-drained) events, optionally filtered, newest
   * first. Does NOT mark them drained — use {@link drain} to ack.
   */
  pending(filter?: EventFilter): AgentEvent[] {
    this.pruneOld();
    const f = filter ?? this.filter;
    return this.events
      .filter((e) => !e.drained)
      .filter((e) => this.eventMatchesFilter(e, f))
      .sort((a, b) => b.ts - a.ts);
  }

  /**
   * Drain (acknowledge) pending events matching an optional filter.
   * Returns the set drained — useful when an agent explicitly consumes
   * queued events as part of a step. Events remain in the ring buffer
   * marked `drained: true` for audit until aged out.
   */
  drain(filter?: EventFilter): AgentEvent[] {
    const matched = this.pending(filter);
    const now = Date.now();
    for (const ev of matched) {
      ev.drained = true;
      ev.drainedAt = now;
    }
    return matched;
  }

  /** All events in the ring buffer, including drained ones. */
  history(): AgentEvent[] {
    return [...this.events];
  }

  /** Clear everything. Primarily useful in tests. */
  clear(): void {
    this.events = [];
  }

  /** Count of un-drained events. */
  pendingCount(): number {
    return this.pending().length;
  }

  private passesFilter(ev: AgentEvent): boolean {
    if (!this.filter) return true;
    return this.eventMatchesFilter(ev, this.filter);
  }

  private eventMatchesFilter(ev: AgentEvent, f: EventFilter | undefined): boolean {
    if (!f) return true;
    if (f.sources && !f.sources.includes(ev.source)) return false;
    if (f.types && !f.types.includes(ev.type)) return false;
    if (f.minSeverity && SEVERITY_RANK[ev.severity] < SEVERITY_RANK[f.minSeverity]) return false;
    return true;
  }

  private pruneOld(): void {
    if (!Number.isFinite(this.maxAgeMs)) return;
    const cutoff = Date.now() - this.maxAgeMs;
    this.events = this.events.filter((e) => e.ts >= cutoff);
  }
}

// ---------------------------------------------------------------------------
// Singleton — the CLI process typically has one router.
// ---------------------------------------------------------------------------

let globalRouter: EventRouter | null = null;

export function getGlobalRouter(): EventRouter {
  if (!globalRouter) globalRouter = new EventRouter();
  return globalRouter;
}

export function setGlobalRouter(router: EventRouter | null): void {
  globalRouter = router;
}

/** Convenience: emit to the global router. */
export function emitEvent(
  partial: Omit<AgentEvent, 'ts' | 'id' | 'drained'> & { ts?: number; id?: string },
): AgentEvent | null {
  return getGlobalRouter().emit(partial);
}
