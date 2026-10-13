/**
 * Notch CLI — Workflow runtime (oh-my-codex-inspired)
 *
 * Lightweight state-machine for multi-mode agent work: PLAN → IMPLEMENT
 * → VERIFY → SHIP. Each mode constrains the agent's tools and prompt
 * addendum so the model stays on-task in that mode, and transitions
 * happen via explicit keywords the agent emits in its output.
 *
 * Modeled on the OmX ("oh-my-codex") layer described in ultraworkers/
 * claw-code's PHILOSOPHY.md: "Workflow orchestration layer that
 * translates directives into structured execution protocols, including
 * planning keywords, execution modes, and verification loops."
 *
 * Pure state + helpers. The REPL / agent loop owns wiring this to the
 * tool filter + system prompt on each turn.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkflowMode {
  /** Machine-readable id ("plan", "implement", "verify", "ship"). */
  name: string;
  /** Human-readable one-liner shown in UI. */
  description: string;
  /**
   * Allowed tool names for this mode. If present, every other tool is
   * filtered out for the duration of the mode. If absent, all tools
   * are allowed.
   */
  allowedTools?: readonly string[];
  /**
   * String appended to the system prompt while in this mode. Empty
   * string means no addendum.
   */
  systemPromptAddendum?: string;
  /**
   * Exit keywords the agent can emit to request a transition. The first
   * keyword found in a response triggers the transition; the runner then
   * checks {@link Workflow.transitions} for whether the move is valid.
   */
  exitKeywords?: readonly ExitKeyword[];
  /**
   * Max iterations in this mode before auto-transitioning away (or
   * failing if no next mode exists). Default: unlimited.
   */
  maxIterations?: number;
}

export interface ExitKeyword {
  /** Literal token the model emits (case-insensitive). */
  token: string;
  /** Mode to transition to when this keyword is seen. */
  target: string;
  /** Optional description for help / UI. */
  description?: string;
}

export interface Workflow {
  /** Machine-readable id ("fix-bug", "plan-implement-verify", etc). */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Ordered list of modes. */
  modes: readonly WorkflowMode[];
  /** Mode the runner starts in. Must match one of {@link modes}. */
  initialMode: string;
  /**
   * Allowed transitions: mode id → list of mode ids it may transition
   * to. An empty list means "terminal" (workflow ends in this mode).
   */
  transitions: Record<string, readonly string[]>;
}

export interface WorkflowState {
  workflow: string;
  currentMode: string;
  history: { mode: string; iterations: number; exitReason: string }[];
  iterationsInCurrentMode: number;
  completed: boolean;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Pure state manager for a workflow. The agent loop calls `noteIteration`
 * after each model turn, then `maybeTransition` with the model's output
 * to see if a keyword triggered a mode change. The runner never calls
 * the model itself — it just tracks state and exposes mode-appropriate
 * tool/prompt hints.
 */
export class WorkflowRunner {
  private readonly wf: Workflow;
  private state: WorkflowState;

  constructor(workflow: Workflow) {
    validateWorkflow(workflow);
    this.wf = workflow;
    this.state = {
      workflow: workflow.name,
      currentMode: workflow.initialMode,
      history: [],
      iterationsInCurrentMode: 0,
      completed: false,
    };
  }

  workflow(): Workflow {
    return this.wf;
  }

  snapshot(): WorkflowState {
    // Return a defensive copy so external mutation can't corrupt state.
    return {
      ...this.state,
      history: [...this.state.history],
    };
  }

  currentMode(): WorkflowMode {
    return this.findMode(this.state.currentMode);
  }

  /**
   * Tools the current mode allows. Pass this to the tool-filter layer
   * so the agent literally cannot call disallowed tools during this mode.
   */
  allowedTools(): readonly string[] | undefined {
    return this.currentMode().allowedTools;
  }

  /** System-prompt addendum for the current mode. */
  currentPromptAddendum(): string {
    return this.currentMode().systemPromptAddendum ?? '';
  }

  /**
   * Called by the agent loop after each iteration finishes. Updates the
   * iteration counter and auto-transitions if the mode's max is reached.
   * Returns the new mode id if a transition occurred, or null.
   */
  noteIteration(): string | null {
    this.state.iterationsInCurrentMode += 1;
    const mode = this.currentMode();
    if (mode.maxIterations != null && this.state.iterationsInCurrentMode >= mode.maxIterations) {
      // Auto-transition to the first allowed next mode if one exists;
      // otherwise mark the workflow complete.
      const nexts = this.wf.transitions[mode.name] ?? [];
      const next = nexts[0];
      if (next) {
        return this.forceTransition(next, 'max-iterations');
      }
      this.markCompleted('max-iterations-terminal');
      return null;
    }
    return null;
  }

  /**
   * Inspect a model output for exit keywords. If one fires AND the
   * target mode is a valid transition, transition and return the new
   * mode id. Otherwise return null.
   */
  maybeTransition(modelOutput: string): string | null {
    const mode = this.currentMode();
    if (!mode.exitKeywords || mode.exitKeywords.length === 0) return null;
    const lower = modelOutput.toLowerCase();
    for (const kw of mode.exitKeywords) {
      if (lower.includes(kw.token.toLowerCase())) {
        const allowed = this.wf.transitions[mode.name] ?? [];
        if (allowed.includes(kw.target)) {
          return this.forceTransition(kw.target, `keyword:${kw.token}`);
        }
      }
    }
    return null;
  }

  /**
   * Unconditional transition (operator override — skips transition-table
   * validation). Use `maybeTransition` for model-driven transitions.
   */
  forceTransition(target: string, reason: string): string {
    const mode = this.findMode(target);
    this.state.history.push({
      mode: this.state.currentMode,
      iterations: this.state.iterationsInCurrentMode,
      exitReason: reason,
    });
    this.state.currentMode = mode.name;
    this.state.iterationsInCurrentMode = 0;
    // If the target is terminal, mark done.
    if ((this.wf.transitions[mode.name] ?? []).length === 0) {
      this.markCompleted(`terminal:${mode.name}`);
    }
    return mode.name;
  }

  private markCompleted(reason: string): void {
    if (this.state.completed) return;
    this.state.history.push({
      mode: this.state.currentMode,
      iterations: this.state.iterationsInCurrentMode,
      exitReason: reason,
    });
    this.state.completed = true;
  }

  isComplete(): boolean {
    return this.state.completed;
  }

  private findMode(name: string): WorkflowMode {
    const m = this.wf.modes.find((x) => x.name === name);
    if (!m) throw new Error(`unknown workflow mode: ${name}`);
    return m;
  }
}

function validateWorkflow(wf: Workflow): void {
  const names = new Set(wf.modes.map((m) => m.name));
  if (names.size !== wf.modes.length) {
    throw new Error(`workflow ${wf.name}: duplicate mode names`);
  }
  if (!names.has(wf.initialMode)) {
    throw new Error(`workflow ${wf.name}: initialMode "${wf.initialMode}" not in modes`);
  }
  for (const [from, targets] of Object.entries(wf.transitions)) {
    if (!names.has(from)) {
      throw new Error(`workflow ${wf.name}: transitions key "${from}" not in modes`);
    }
    for (const t of targets) {
      if (!names.has(t)) {
        throw new Error(`workflow ${wf.name}: transition "${from}" -> "${t}" not in modes`);
      }
    }
  }
  for (const mode of wf.modes) {
    for (const kw of mode.exitKeywords ?? []) {
      if (!names.has(kw.target)) {
        throw new Error(
          `workflow ${wf.name}: mode "${mode.name}" keyword "${kw.token}" targets unknown mode "${kw.target}"`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Bundled workflows
// ---------------------------------------------------------------------------

const READ_ONLY_TOOLS = ['read', 'grep', 'glob', 'web_fetch', 'web_search'] as const;
const WRITE_TOOLS = ['read', 'grep', 'glob', 'edit', 'write', 'apply_patch', 'shell', 'git'] as const;
const VERIFY_TOOLS = ['read', 'grep', 'glob', 'shell', 'git'] as const;

/**
 * Classic plan-implement-verify: explore + plan (read-only), then code
 * (full write tools), then verify (run tests/build).
 */
export const PLAN_IMPLEMENT_VERIFY: Workflow = {
  name: 'plan-implement-verify',
  description: 'Explore and plan, implement the plan, verify with tests/build.',
  modes: [
    {
      name: 'plan',
      description: 'Explore the codebase and produce a concrete plan. Read-only.',
      allowedTools: READ_ONLY_TOOLS,
      systemPromptAddendum:
        'You are in PLAN mode. Do NOT modify any files. Read, search, and produce a step-by-step plan. ' +
        'When the plan is ready and you have verified assumptions, emit the literal token [MODE:implement] to begin implementation.',
      exitKeywords: [{ token: '[MODE:implement]', target: 'implement', description: 'Begin coding the plan' }],
      maxIterations: 20,
    },
    {
      name: 'implement',
      description: 'Apply edits per the plan. Full write tools available.',
      allowedTools: WRITE_TOOLS,
      systemPromptAddendum:
        'You are in IMPLEMENT mode. Execute the plan step by step. When implementation is complete, ' +
        'emit the literal token [MODE:verify] to run verification checks.',
      exitKeywords: [{ token: '[MODE:verify]', target: 'verify', description: 'Run tests/build' }],
      maxIterations: 40,
    },
    {
      name: 'verify',
      description: 'Run tests, build, typecheck. Report results. No new feature edits.',
      allowedTools: VERIFY_TOOLS,
      systemPromptAddendum:
        'You are in VERIFY mode. Run tests, build, and typecheck. Report concrete results. ' +
        'If all checks pass, emit [MODE:ship]. If checks fail, emit [MODE:implement] and fix the issue.',
      exitKeywords: [
        { token: '[MODE:ship]', target: 'ship', description: 'All checks pass' },
        { token: '[MODE:implement]', target: 'implement', description: 'A check failed — go back to fix' },
      ],
      maxIterations: 10,
    },
    {
      name: 'ship',
      description: 'Terminal mode — workflow complete.',
      systemPromptAddendum: 'Workflow complete. Summarize what was done.',
    },
  ],
  initialMode: 'plan',
  transitions: {
    plan: ['implement'],
    implement: ['verify'],
    verify: ['ship', 'implement'],
    ship: [],
  },
};

/**
 * Bug-fix workflow: reproduce → isolate → fix → verify.
 */
export const FIX_BUG: Workflow = {
  name: 'fix-bug',
  description: 'Reproduce a bug, isolate the cause, fix, then verify.',
  modes: [
    {
      name: 'reproduce',
      description: 'Reproduce the bug locally with a concrete trigger.',
      allowedTools: VERIFY_TOOLS,
      systemPromptAddendum:
        'You are in REPRODUCE mode. Produce a minimal repro: a command, test case, or steps that reliably surfaces the bug. ' +
        'When reproduced, emit [MODE:isolate].',
      exitKeywords: [{ token: '[MODE:isolate]', target: 'isolate' }],
      maxIterations: 10,
    },
    {
      name: 'isolate',
      description: 'Narrow the cause. Read-only inspection.',
      allowedTools: READ_ONLY_TOOLS,
      systemPromptAddendum:
        'You are in ISOLATE mode. Identify the specific file + line range responsible. ' +
        'Do NOT edit. When root cause is clear, emit [MODE:fix].',
      exitKeywords: [{ token: '[MODE:fix]', target: 'fix' }],
      maxIterations: 15,
    },
    {
      name: 'fix',
      description: 'Apply the minimal fix.',
      allowedTools: WRITE_TOOLS,
      systemPromptAddendum:
        'You are in FIX mode. Apply the minimal change that resolves the root cause. Do NOT refactor adjacent code. ' +
        'When done, emit [MODE:verify].',
      exitKeywords: [{ token: '[MODE:verify]', target: 'verify' }],
      maxIterations: 10,
    },
    {
      name: 'verify',
      description: 'Confirm the fix + no regressions.',
      allowedTools: VERIFY_TOOLS,
      systemPromptAddendum:
        'You are in VERIFY mode. Run the original repro, then the test suite. ' +
        'If fixed with no regressions, emit [MODE:done]. If not, emit [MODE:fix].',
      exitKeywords: [
        { token: '[MODE:done]', target: 'done' },
        { token: '[MODE:fix]', target: 'fix' },
      ],
      maxIterations: 8,
    },
    { name: 'done', description: 'Terminal mode.' },
  ],
  initialMode: 'reproduce',
  transitions: {
    reproduce: ['isolate'],
    isolate: ['fix'],
    fix: ['verify'],
    verify: ['done', 'fix'],
    done: [],
  },
};

/**
 * Explore-narrow-edit: broad exploration, focused read, minimal edit.
 * Good for "change X, preserve everything else" tasks.
 */
export const EXPLORE_NARROW_EDIT: Workflow = {
  name: 'explore-narrow-edit',
  description: 'Explore broadly, narrow to the target, edit minimally.',
  modes: [
    {
      name: 'explore',
      description: 'Broad codebase search. Read-only.',
      allowedTools: READ_ONLY_TOOLS,
      systemPromptAddendum:
        'You are in EXPLORE mode. Map the relevant files/functions. ' +
        'When you know which specific file(s) need changes, emit [MODE:narrow].',
      exitKeywords: [{ token: '[MODE:narrow]', target: 'narrow' }],
      maxIterations: 15,
    },
    {
      name: 'narrow',
      description: 'Deep-read the specific target.',
      allowedTools: ['read', 'grep'],
      systemPromptAddendum:
        'You are in NARROW mode. Read the target file(s) in full. ' +
        'When you have a concrete edit plan with exact old/new strings, emit [MODE:edit].',
      exitKeywords: [{ token: '[MODE:edit]', target: 'edit' }],
      maxIterations: 5,
    },
    {
      name: 'edit',
      description: 'Apply the focused edit. No refactors.',
      allowedTools: ['read', 'edit', 'write', 'apply_patch'],
      systemPromptAddendum:
        'You are in EDIT mode. Apply only the edit you described in NARROW. ' +
        'No unrelated changes. When done, emit [MODE:done].',
      exitKeywords: [{ token: '[MODE:done]', target: 'done' }],
      maxIterations: 10,
    },
    { name: 'done', description: 'Terminal.' },
  ],
  initialMode: 'explore',
  transitions: {
    explore: ['narrow'],
    narrow: ['edit'],
    edit: ['done'],
    done: [],
  },
};

/** Bundled workflow registry — lookup by name. */
export const BUNDLED_WORKFLOWS: Record<string, Workflow> = {
  [PLAN_IMPLEMENT_VERIFY.name]: PLAN_IMPLEMENT_VERIFY,
  [FIX_BUG.name]: FIX_BUG,
  [EXPLORE_NARROW_EDIT.name]: EXPLORE_NARROW_EDIT,
};

export function getBundledWorkflow(name: string): Workflow | undefined {
  return BUNDLED_WORKFLOWS[name];
}

export function listBundledWorkflows(): Workflow[] {
  return Object.values(BUNDLED_WORKFLOWS);
}
