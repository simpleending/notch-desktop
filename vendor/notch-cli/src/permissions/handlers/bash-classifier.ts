/**
 * Notch CLI — Bash Classifier
 *
 * Regex/prefix-based classifier for shell commands. Used by interactive and
 * auto-mode handlers to decide whether to upgrade `allow` to `prompt` (e.g.
 * an allow-by-default read tool trying to pipe into `curl | sh`).
 *
 * NO LLM — pure pattern matching. Ordered: destructive > network > unknown
 * > safe, so a command that matches multiple categories resolves to the
 * most-dangerous label.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

export type BashClass = 'safe' | 'network' | 'destructive' | 'unknown';

export interface ClassificationResult {
  category: BashClass;
  /** Which pattern matched (for telemetry / explanation) */
  matchedPattern?: string;
  /** Tokenized head command (e.g. `git`, `rm`, `curl`) */
  head?: string;
}

/**
 * Destructive patterns — irreversible local damage or force pushes.
 * Matched first; highest priority.
 */
const DESTRUCTIVE_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*|--recursive|--force)/i,
  /\brm\s+-rf?\s+\//i,
  /\bsudo\s+rm\b/i,
  /\bdd\s+if=/i,
  /\bmkfs\./i,
  /\bshred\b/i,
  /\bchmod\s+-R\s+/i,
  /\bchown\s+-R\s+/i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/, // fork bomb
  /\b>\s*\/dev\/sd[a-z]/i,
  /\bgit\s+push\s+(?:.*\s)?(?:-f|--force|--force-with-lease)\b/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bgit\s+clean\s+-[a-zA-Z]*[fd]/i,
  /\bgit\s+checkout\s+--\s+\./,
  /\bnpm\s+publish\b/i,
  /\byarn\s+publish\b/i,
  /\bpnpm\s+publish\b/i,
  /\bdocker\s+(?:rm|rmi|system\s+prune|volume\s+rm)\b/i,
  /\bkubectl\s+delete\b/i,
  /\bterraform\s+destroy\b/i,
  /\bmv\s+\/\s+/i,
  /\bfind\s+.*\s-delete\b/i,
  /\bfind\s+.*-exec\s+rm\b/i,
  /\btruncate\s+-s\s+0/i,
  /\b(poweroff|shutdown|reboot|halt)\b/i,
  /\bkillall?\s+-9/i,
];

/**
 * Network patterns — anything that reaches out or listens. Not necessarily
 * dangerous but worth a prompt when auto-mode would normally breeze through.
 */
const NETWORK_PATTERNS: RegExp[] = [
  /\bcurl\b/i,
  /\bwget\b/i,
  /\bhttpie?\b/i,
  /\bnc\b/i,
  /\bnetcat\b/i,
  /\bssh\b/i,
  /\bscp\b/i,
  /\brsync\s+.*::?/i,
  /\bftp\b/i,
  /\bsftp\b/i,
  /\btelnet\b/i,
  /\bnmap\b/i,
  /\bping\b/i,
  /\bdig\b/i,
  /\bnslookup\b/i,
  /\bhost\s+[a-z0-9.-]+\.[a-z]+/i,
  /\bgit\s+(?:clone|fetch|pull|push)\b/i,
  /\bnpm\s+(?:install|i|update|audit|fund)\b/i,
  /\bpip\s+install\b/i,
  /\bapt(?:-get)?\s+(?:install|update|upgrade)\b/i,
  /\bbrew\s+(?:install|update|upgrade)\b/i,
  /\b(?:python|python3|node|bun)\s+-c\s+.*(?:urllib|requests|fetch|http)/i,
  /\bcurl.*\|\s*(?:sh|bash|zsh|fish)\b/i, // explicit "pipe to shell"
  /\bwget.*\|\s*(?:sh|bash|zsh|fish)\b/i,
];

/**
 * Safe patterns — read-only or local-only operations with no network, no
 * filesystem writes, and no privilege escalation.
 */
const SAFE_PATTERNS: RegExp[] = [
  /^\s*ls(\s|$)/i,
  /^\s*pwd(\s|$)/,
  /^\s*whoami(\s|$)/,
  /^\s*id(\s|$)/,
  /^\s*echo\s/i,
  /^\s*printf\s/i,
  /^\s*cat\s/i,
  /^\s*head\s/i,
  /^\s*tail\s/i,
  /^\s*wc\s/i,
  /^\s*file\s/i,
  /^\s*stat\s/i,
  /^\s*du\s/i,
  /^\s*df\s/i,
  /^\s*which\s/i,
  /^\s*type\s/i,
  /^\s*env(\s|$)/i,
  /^\s*date(\s|$)/i,
  /^\s*uname/i,
  /^\s*hostname(\s|$)/i,
  /^\s*uptime(\s|$)/i,
  /^\s*history(\s|$)/i,
  /^\s*git\s+(status|log|diff|show|branch|blame|config\s+--get|remote\s+-v|stash\s+list|tag\s+-l|ls-files)\b/i,
  /^\s*node\s+--version/i,
  /^\s*npm\s+(ls|list|outdated|view|config\s+get|--version|-v|root)\b/i,
  /^\s*yarn\s+(list|--version)\b/i,
  /^\s*(python|python3)\s+--version/i,
  /^\s*pip\s+(list|show|--version)\b/i,
  /^\s*(rg|ripgrep)\s/i,
  /^\s*grep\s/i,
  /^\s*find\s+[^|;&]*(?<!-delete)\s*$/i, // find without -delete/-exec rm
  /^\s*tree(\s|$)/i,
  /^\s*jq\s/i,
  /^\s*awk\s/i,
  /^\s*sed\s+-n\s/i, // sed in print-only mode
  /^\s*(make|cargo|go|npm|bun|pnpm|yarn)\s+(test|check|vet|fmt\s+--check|build\s+--dry-run)\b/i,
  /^\s*(cargo|rustc)\s+--version/i,
  /^\s*docker\s+(ps|images|logs|inspect|version)\b/i,
  /^\s*kubectl\s+(get|describe|logs|version|config\s+current-context)\b/i,
];

/**
 * Classify a shell command by pattern matching.
 * Returns `unknown` when no category matches — caller decides the default.
 */
export function classifyBashCommand(command: string): ClassificationResult {
  const cmd = command.trim();
  if (!cmd) return { category: 'safe' };

  const head = cmd.split(/[\s;|&]/)[0] ?? '';

  // Destructive wins over everything
  for (const p of DESTRUCTIVE_PATTERNS) {
    if (p.test(cmd)) {
      return { category: 'destructive', matchedPattern: p.source, head };
    }
  }

  // Network second — still safer than destructive
  for (const p of NETWORK_PATTERNS) {
    if (p.test(cmd)) {
      return { category: 'network', matchedPattern: p.source, head };
    }
  }

  // Safe last — most specific-to-least
  for (const p of SAFE_PATTERNS) {
    if (p.test(cmd)) {
      return { category: 'safe', matchedPattern: p.source, head };
    }
  }

  return { category: 'unknown', head };
}

/**
 * How many pattern entries the classifier carries. Exposed so the handler
 * can sanity-check that it is actually doing work (guards against a future
 * refactor accidentally clearing the list).
 */
export function classifierPatternCount(): number {
  return DESTRUCTIVE_PATTERNS.length + NETWORK_PATTERNS.length + SAFE_PATTERNS.length;
}
