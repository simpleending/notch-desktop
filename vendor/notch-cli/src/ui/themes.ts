/**
 * Notch CLI — Theme System
 *
 * Centralized color theming for the entire CLI.
 * Each theme defines a palette that controls banner, prompts,
 * tool output, markdown rendering, diff colors, and more.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import chalk, { type ChalkInstance } from 'chalk';

// ---------------------------------------------------------------------------
// Theme Palette Interface
// ---------------------------------------------------------------------------

export interface ThemePalette {
  /** Theme display name */
  name: string;
  /** Short description */
  description: string;

  // -- Brand / Banner --
  /** Primary brand color (NOTCH wordmark, headings) */
  brand: ChalkInstance;
  /** Mascot body color */
  mascot: ChalkInstance;
  /** Mascot accent (eyes, joints) */
  mascotAccent: ChalkInstance;
  /** Tagline / "by Driftrail" */
  tagline: ChalkInstance;

  // -- UI Chrome --
  /** Prompt prefix ("notch>") */
  prompt: ChalkInstance;
  /** Dividers, borders, separators */
  border: ChalkInstance;
  /** Muted/secondary text */
  dim: ChalkInstance;
  /** Normal body text */
  text: ChalkInstance;
  /** Bold / emphasis text */
  bold: ChalkInstance;

  // -- Semantic --
  /** Success, confirmations, "done" */
  success: ChalkInstance;
  /** Warnings, caution */
  warning: ChalkInstance;
  /** Errors, failures */
  error: ChalkInstance;
  /** Informational, hints, tips */
  info: ChalkInstance;

  // -- Tool Output --
  /** Tool name in call logs */
  toolName: ChalkInstance;
  /** Tool arguments */
  toolArgs: ChalkInstance;
  /** Tool result preview */
  toolResult: ChalkInstance;

  // -- Diff --
  /** Added lines */
  diffAdd: ChalkInstance;
  /** Removed lines */
  diffRemove: ChalkInstance;
  /** Diff header / hunk markers */
  diffHeader: ChalkInstance;

  // -- Markdown --
  /** H1 headers */
  mdH1: ChalkInstance;
  /** H2 headers */
  mdH2: ChalkInstance;
  /** H3+ headers */
  mdH3: ChalkInstance;
  /** Code blocks */
  mdCode: ChalkInstance;
  /** Inline code */
  mdInlineCode: ChalkInstance;
  /** Links */
  mdLink: ChalkInstance;

  // -- Context Meter --
  /** Low usage (<50%) */
  meterLow: ChalkInstance;
  /** Medium usage (50-75%) */
  meterMid: ChalkInstance;
  /** High usage (>75%) */
  meterHigh: ChalkInstance;
}

// ---------------------------------------------------------------------------
// Built-in Themes
// ---------------------------------------------------------------------------

/**
 * DEFAULT — Silver, white, gray. No color.
 * Matches the FreeSyntax brand: black/silver/gray/white only.
 * The banner uses a gradient from dark gray → white.
 */
const defaultTheme: ThemePalette = {
  name: 'Default',
  description: 'FreeSyntax — silver, white, monochrome',
  brand: chalk.hex('#D4D4D4'),          // silver (banner uses gradient override)
  mascot: chalk.hex('#AAAAAA'),         // medium gray mantis
  mascotAccent: chalk.hex('#FFFFFF'),   // white eyes
  tagline: chalk.hex('#777777'),        // muted gray
  prompt: chalk.hex('#CCCCCC'),         // silver prompt
  border: chalk.hex('#444444'),         // dark border
  dim: chalk.hex('#666666'),            // muted text
  text: chalk.hex('#D4D4D4'),           // silver body text
  bold: chalk.hex('#FFFFFF').bold,       // pure white emphasis
  success: chalk.green,
  warning: chalk.yellow,
  error: chalk.red,
  info: chalk.hex('#BBBBBB'),           // light gray info
  toolName: chalk.hex('#AAAAAA'),
  toolArgs: chalk.hex('#777777'),
  toolResult: chalk.hex('#555555'),
  diffAdd: chalk.green,
  diffRemove: chalk.red,
  diffHeader: chalk.hex('#CCCCCC'),
  mdH1: chalk.hex('#FFFFFF').bold,
  mdH2: chalk.hex('#D4D4D4'),
  mdH3: chalk.hex('#AAAAAA'),
  mdCode: chalk.hex('#BBBBBB'),
  mdInlineCode: chalk.hex('#CCCCCC'),
  mdLink: chalk.hex('#D4D4D4').underline,
  meterLow: chalk.green,
  meterMid: chalk.yellow,
  meterHigh: chalk.red,
};

/**
 * INTERSTELLAR — Deep space blacks, warm amber displays, icy whites.
 * Inspired by the instrument panels of the Endurance and Miller's planet.
 */
const interstellarTheme: ThemePalette = {
  name: 'Interstellar',
  description: 'Deep space amber — Endurance control panels',
  brand: chalk.hex('#FFB347'),        // warm amber (instrument readout)
  mascot: chalk.hex('#4A90D9'),       // pale blue (frozen clouds)
  mascotAccent: chalk.hex('#FFD700'), // gold (Gargantua light)
  tagline: chalk.hex('#708090'),      // slate gray (ship hull)
  prompt: chalk.hex('#FFB347'),
  border: chalk.hex('#3A3A3A'),       // dark hull metal
  dim: chalk.hex('#5C5C5C'),
  text: chalk.hex('#D4D4D4'),         // cool white (display text)
  bold: chalk.hex('#FFFFFF').bold,
  success: chalk.hex('#7CFC00'),      // "CASE: All systems nominal"
  warning: chalk.hex('#FFB347'),      // amber warning
  error: chalk.hex('#FF4444'),        // critical alert
  info: chalk.hex('#4A90D9'),         // blue data readout
  toolName: chalk.hex('#FFB347'),
  toolArgs: chalk.hex('#708090'),
  toolResult: chalk.hex('#5C5C5C'),
  diffAdd: chalk.hex('#7CFC00'),
  diffRemove: chalk.hex('#FF4444'),
  diffHeader: chalk.hex('#FFB347'),
  mdH1: chalk.hex('#FFB347').bold,
  mdH2: chalk.hex('#4A90D9'),
  mdH3: chalk.hex('#708090'),
  mdCode: chalk.hex('#FFD700'),
  mdInlineCode: chalk.hex('#FFB347'),
  mdLink: chalk.hex('#4A90D9').underline,
  meterLow: chalk.hex('#4A90D9'),
  meterMid: chalk.hex('#FFB347'),
  meterHigh: chalk.hex('#FF4444'),
};

/**
 * SPACE GRAY — Apple's refined, understated palette.
 * Silver text on cool grays, ice-blue accents.
 */
const spaceGrayTheme: ThemePalette = {
  name: 'Space Gray',
  description: 'Apple minimalism — silver, cool gray, ice blue',
  brand: chalk.hex('#A2AAAD'),        // apple silver
  mascot: chalk.hex('#86868B'),       // space gray
  mascotAccent: chalk.hex('#0071E3'), // apple blue
  tagline: chalk.hex('#6E6E73'),      // secondary gray
  prompt: chalk.hex('#A2AAAD'),
  border: chalk.hex('#3A3A3C'),       // dark separator
  dim: chalk.hex('#6E6E73'),
  text: chalk.hex('#E5E5EA'),         // system gray 6
  bold: chalk.hex('#F5F5F7').bold,    // near white
  success: chalk.hex('#30D158'),      // apple green
  warning: chalk.hex('#FFD60A'),      // apple yellow
  error: chalk.hex('#FF453A'),        // apple red
  info: chalk.hex('#0A84FF'),         // apple blue
  toolName: chalk.hex('#A2AAAD'),
  toolArgs: chalk.hex('#6E6E73'),
  toolResult: chalk.hex('#48484A'),
  diffAdd: chalk.hex('#30D158'),
  diffRemove: chalk.hex('#FF453A'),
  diffHeader: chalk.hex('#0A84FF'),
  mdH1: chalk.hex('#F5F5F7').bold,
  mdH2: chalk.hex('#0A84FF'),
  mdH3: chalk.hex('#A2AAAD'),
  mdCode: chalk.hex('#BF5AF2'),       // apple purple for code
  mdInlineCode: chalk.hex('#BF5AF2'),
  mdLink: chalk.hex('#0A84FF').underline,
  meterLow: chalk.hex('#30D158'),
  meterMid: chalk.hex('#FFD60A'),
  meterHigh: chalk.hex('#FF453A'),
};

/**
 * CYBERPUNK — Neon pink on black, electric cyan accents.
 * Night City terminal aesthetic.
 */
const cyberpunkTheme: ThemePalette = {
  name: 'Cyberpunk',
  description: 'Neon pink & cyan — Night City terminal',
  brand: chalk.hex('#FF2079'),        // hot pink
  mascot: chalk.hex('#00FFFF'),       // electric cyan
  mascotAccent: chalk.hex('#FF2079'), // hot pink eyes
  tagline: chalk.hex('#9D00FF'),      // deep violet
  prompt: chalk.hex('#FF2079'),
  border: chalk.hex('#1A1A2E'),
  dim: chalk.hex('#4A4A6A'),
  text: chalk.hex('#E0E0FF'),
  bold: chalk.hex('#FFFFFF').bold,
  success: chalk.hex('#00FF41'),      // matrix green
  warning: chalk.hex('#FFFF00'),      // neon yellow
  error: chalk.hex('#FF0000'),
  info: chalk.hex('#00FFFF'),
  toolName: chalk.hex('#FF2079'),
  toolArgs: chalk.hex('#9D00FF'),
  toolResult: chalk.hex('#4A4A6A'),
  diffAdd: chalk.hex('#00FF41'),
  diffRemove: chalk.hex('#FF0000'),
  diffHeader: chalk.hex('#FF2079'),
  mdH1: chalk.hex('#FF2079').bold,
  mdH2: chalk.hex('#00FFFF'),
  mdH3: chalk.hex('#9D00FF'),
  mdCode: chalk.hex('#00FF41'),
  mdInlineCode: chalk.hex('#00FFFF'),
  mdLink: chalk.hex('#9D00FF').underline,
  meterLow: chalk.hex('#00FF41'),
  meterMid: chalk.hex('#FFFF00'),
  meterHigh: chalk.hex('#FF0000'),
};

/**
 * AURORA BOREALIS — Northern lights: greens, teals, purples, and soft whites.
 */
const auroraTheme: ThemePalette = {
  name: 'Aurora',
  description: 'Northern lights — teal, violet, polar green',
  brand: chalk.hex('#7FFFD4'),        // aquamarine
  mascot: chalk.hex('#00CED1'),       // dark turquoise
  mascotAccent: chalk.hex('#DA70D6'), // orchid
  tagline: chalk.hex('#9370DB'),      // medium purple
  prompt: chalk.hex('#7FFFD4'),
  border: chalk.hex('#2F4F4F'),       // dark slate
  dim: chalk.hex('#5F9EA0'),          // cadet blue
  text: chalk.hex('#E0FFFF'),         // light cyan
  bold: chalk.hex('#F0FFFF').bold,
  success: chalk.hex('#00FA9A'),      // medium spring green
  warning: chalk.hex('#DDA0DD'),      // plum
  error: chalk.hex('#FF6B6B'),
  info: chalk.hex('#87CEEB'),         // sky blue
  toolName: chalk.hex('#7FFFD4'),
  toolArgs: chalk.hex('#5F9EA0'),
  toolResult: chalk.hex('#2F4F4F'),
  diffAdd: chalk.hex('#00FA9A'),
  diffRemove: chalk.hex('#FF6B6B'),
  diffHeader: chalk.hex('#DA70D6'),
  mdH1: chalk.hex('#7FFFD4').bold,
  mdH2: chalk.hex('#DA70D6'),
  mdH3: chalk.hex('#87CEEB'),
  mdCode: chalk.hex('#00CED1'),
  mdInlineCode: chalk.hex('#7FFFD4'),
  mdLink: chalk.hex('#DA70D6').underline,
  meterLow: chalk.hex('#00FA9A'),
  meterMid: chalk.hex('#DDA0DD'),
  meterHigh: chalk.hex('#FF6B6B'),
};

/**
 * SOLARIZED DARK — Ethan Schoonover's iconic warm palette.
 */
const solarizedTheme: ThemePalette = {
  name: 'Solarized',
  description: 'Solarized Dark — warm, precise, classic dev palette',
  brand: chalk.hex('#268BD2'),        // blue
  mascot: chalk.hex('#859900'),       // green
  mascotAccent: chalk.hex('#B58900'), // yellow
  tagline: chalk.hex('#2AA198'),      // cyan
  prompt: chalk.hex('#268BD2'),
  border: chalk.hex('#073642'),       // base02
  dim: chalk.hex('#586E75'),          // base01
  text: chalk.hex('#839496'),         // base0
  bold: chalk.hex('#93A1A1').bold,    // base1
  success: chalk.hex('#859900'),
  warning: chalk.hex('#B58900'),
  error: chalk.hex('#DC322F'),
  info: chalk.hex('#2AA198'),
  toolName: chalk.hex('#268BD2'),
  toolArgs: chalk.hex('#586E75'),
  toolResult: chalk.hex('#073642'),
  diffAdd: chalk.hex('#859900'),
  diffRemove: chalk.hex('#DC322F'),
  diffHeader: chalk.hex('#268BD2'),
  mdH1: chalk.hex('#93A1A1').bold,
  mdH2: chalk.hex('#268BD2'),
  mdH3: chalk.hex('#2AA198'),
  mdCode: chalk.hex('#859900'),
  mdInlineCode: chalk.hex('#2AA198'),
  mdLink: chalk.hex('#268BD2').underline,
  meterLow: chalk.hex('#859900'),
  meterMid: chalk.hex('#B58900'),
  meterHigh: chalk.hex('#DC322F'),
};

/**
 * DRACULA — The beloved dark theme with purple, pink, and green.
 */
const draculaTheme: ThemePalette = {
  name: 'Dracula',
  description: 'Dracula — purple, pink, green on charcoal',
  brand: chalk.hex('#BD93F9'),        // purple
  mascot: chalk.hex('#50FA7B'),       // green
  mascotAccent: chalk.hex('#FF79C6'), // pink
  tagline: chalk.hex('#6272A4'),      // comment gray
  prompt: chalk.hex('#BD93F9'),
  border: chalk.hex('#44475A'),       // current line
  dim: chalk.hex('#6272A4'),          // comment
  text: chalk.hex('#F8F8F2'),         // foreground
  bold: chalk.hex('#F8F8F2').bold,
  success: chalk.hex('#50FA7B'),
  warning: chalk.hex('#F1FA8C'),      // yellow
  error: chalk.hex('#FF5555'),
  info: chalk.hex('#8BE9FD'),         // cyan
  toolName: chalk.hex('#BD93F9'),
  toolArgs: chalk.hex('#6272A4'),
  toolResult: chalk.hex('#44475A'),
  diffAdd: chalk.hex('#50FA7B'),
  diffRemove: chalk.hex('#FF5555'),
  diffHeader: chalk.hex('#FF79C6'),
  mdH1: chalk.hex('#FF79C6').bold,
  mdH2: chalk.hex('#BD93F9'),
  mdH3: chalk.hex('#8BE9FD'),
  mdCode: chalk.hex('#50FA7B'),
  mdInlineCode: chalk.hex('#F1FA8C'),
  mdLink: chalk.hex('#8BE9FD').underline,
  meterLow: chalk.hex('#50FA7B'),
  meterMid: chalk.hex('#F1FA8C'),
  meterHigh: chalk.hex('#FF5555'),
};

/**
 * MONOKAI — Dark, vivid syntax highlighting legend.
 */
const monokaiTheme: ThemePalette = {
  name: 'Monokai',
  description: 'Monokai Pro — vivid on dark, a classic',
  brand: chalk.hex('#A6E22E'),        // green
  mascot: chalk.hex('#66D9EF'),       // blue
  mascotAccent: chalk.hex('#F92672'), // pink
  tagline: chalk.hex('#75715E'),      // comment
  prompt: chalk.hex('#A6E22E'),
  border: chalk.hex('#3E3D32'),
  dim: chalk.hex('#75715E'),
  text: chalk.hex('#F8F8F2'),
  bold: chalk.hex('#F8F8F2').bold,
  success: chalk.hex('#A6E22E'),
  warning: chalk.hex('#E6DB74'),      // yellow
  error: chalk.hex('#F92672'),
  info: chalk.hex('#66D9EF'),
  toolName: chalk.hex('#A6E22E'),
  toolArgs: chalk.hex('#75715E'),
  toolResult: chalk.hex('#3E3D32'),
  diffAdd: chalk.hex('#A6E22E'),
  diffRemove: chalk.hex('#F92672'),
  diffHeader: chalk.hex('#66D9EF'),
  mdH1: chalk.hex('#F92672').bold,
  mdH2: chalk.hex('#A6E22E'),
  mdH3: chalk.hex('#66D9EF'),
  mdCode: chalk.hex('#E6DB74'),
  mdInlineCode: chalk.hex('#A6E22E'),
  mdLink: chalk.hex('#66D9EF').underline,
  meterLow: chalk.hex('#A6E22E'),
  meterMid: chalk.hex('#E6DB74'),
  meterHigh: chalk.hex('#F92672'),
};

/**
 * OCEAN DEPTH — Deep sea blues, bioluminescent accents.
 */
const oceanTheme: ThemePalette = {
  name: 'Ocean',
  description: 'Deep sea — midnight blue, bioluminescent glow',
  brand: chalk.hex('#00B4D8'),        // cerulean
  mascot: chalk.hex('#0077B6'),       // deep blue
  mascotAccent: chalk.hex('#90E0EF'), // light blue (bioluminescent)
  tagline: chalk.hex('#023E8A'),      // navy
  prompt: chalk.hex('#00B4D8'),
  border: chalk.hex('#03045E'),       // deep navy
  dim: chalk.hex('#0077B6'),
  text: chalk.hex('#CAF0F8'),         // lightest blue
  bold: chalk.hex('#CAF0F8').bold,
  success: chalk.hex('#2DC653'),      // kelp green
  warning: chalk.hex('#F4A261'),      // sandy
  error: chalk.hex('#E76F51'),        // coral
  info: chalk.hex('#90E0EF'),
  toolName: chalk.hex('#00B4D8'),
  toolArgs: chalk.hex('#0077B6'),
  toolResult: chalk.hex('#03045E'),
  diffAdd: chalk.hex('#2DC653'),
  diffRemove: chalk.hex('#E76F51'),
  diffHeader: chalk.hex('#00B4D8'),
  mdH1: chalk.hex('#90E0EF').bold,
  mdH2: chalk.hex('#00B4D8'),
  mdH3: chalk.hex('#0077B6'),
  mdCode: chalk.hex('#90E0EF'),
  mdInlineCode: chalk.hex('#00B4D8'),
  mdLink: chalk.hex('#90E0EF').underline,
  meterLow: chalk.hex('#00B4D8'),
  meterMid: chalk.hex('#F4A261'),
  meterHigh: chalk.hex('#E76F51'),
};

/**
 * EMBER — Warm fire tones, from deep charcoal to bright orange flame.
 */
const emberTheme: ThemePalette = {
  name: 'Ember',
  description: 'Fire forged — charcoal, ember orange, flame red',
  brand: chalk.hex('#FF6B35'),        // flame orange
  mascot: chalk.hex('#D62828'),       // deep red
  mascotAccent: chalk.hex('#FFD166'), // bright flame
  tagline: chalk.hex('#8B4513'),      // saddle brown
  prompt: chalk.hex('#FF6B35'),
  border: chalk.hex('#2B2B2B'),       // charcoal
  dim: chalk.hex('#6B3A2A'),
  text: chalk.hex('#F4E4C1'),         // warm parchment
  bold: chalk.hex('#FFF5E1').bold,
  success: chalk.hex('#FFD166'),      // bright flame = success
  warning: chalk.hex('#FF6B35'),
  error: chalk.hex('#D62828'),
  info: chalk.hex('#F4845F'),         // soft coral
  toolName: chalk.hex('#FF6B35'),
  toolArgs: chalk.hex('#6B3A2A'),
  toolResult: chalk.hex('#2B2B2B'),
  diffAdd: chalk.hex('#FFD166'),
  diffRemove: chalk.hex('#D62828'),
  diffHeader: chalk.hex('#FF6B35'),
  mdH1: chalk.hex('#FF6B35').bold,
  mdH2: chalk.hex('#F4845F'),
  mdH3: chalk.hex('#8B4513'),
  mdCode: chalk.hex('#FFD166'),
  mdInlineCode: chalk.hex('#FF6B35'),
  mdLink: chalk.hex('#F4845F').underline,
  meterLow: chalk.hex('#FFD166'),
  meterMid: chalk.hex('#FF6B35'),
  meterHigh: chalk.hex('#D62828'),
};

/**
 * GHOST — Monochrome grayscale. Pure, minimal, no-nonsense.
 */
const ghostTheme: ThemePalette = {
  name: 'Ghost',
  description: 'Monochrome — pure grayscale minimalism',
  brand: chalk.hex('#E0E0E0'),
  mascot: chalk.hex('#AAAAAA'),
  mascotAccent: chalk.hex('#FFFFFF'),
  tagline: chalk.hex('#666666'),
  prompt: chalk.hex('#CCCCCC'),
  border: chalk.hex('#333333'),
  dim: chalk.hex('#555555'),
  text: chalk.hex('#CCCCCC'),
  bold: chalk.hex('#FFFFFF').bold,
  success: chalk.hex('#AAAAAA'),
  warning: chalk.hex('#CCCCCC'),
  error: chalk.hex('#FFFFFF'),
  info: chalk.hex('#999999'),
  toolName: chalk.hex('#AAAAAA'),
  toolArgs: chalk.hex('#666666'),
  toolResult: chalk.hex('#444444'),
  diffAdd: chalk.hex('#CCCCCC'),
  diffRemove: chalk.hex('#777777').strikethrough,
  diffHeader: chalk.hex('#E0E0E0'),
  mdH1: chalk.hex('#FFFFFF').bold,
  mdH2: chalk.hex('#CCCCCC'),
  mdH3: chalk.hex('#AAAAAA'),
  mdCode: chalk.hex('#BBBBBB'),
  mdInlineCode: chalk.hex('#CCCCCC'),
  mdLink: chalk.hex('#E0E0E0').underline,
  meterLow: chalk.hex('#AAAAAA'),
  meterMid: chalk.hex('#CCCCCC'),
  meterHigh: chalk.hex('#FFFFFF'),
};

// ---------------------------------------------------------------------------
// Theme Registry
// ---------------------------------------------------------------------------

export type ThemeId =
  | 'default'
  | 'interstellar'
  | 'space-gray'
  | 'cyberpunk'
  | 'aurora'
  | 'solarized'
  | 'dracula'
  | 'monokai'
  | 'ocean'
  | 'ember'
  | 'ghost';

export const THEME_CATALOG: Record<ThemeId, ThemePalette> = {
  'default': defaultTheme,
  'interstellar': interstellarTheme,
  'space-gray': spaceGrayTheme,
  'cyberpunk': cyberpunkTheme,
  'aurora': auroraTheme,
  'solarized': solarizedTheme,
  'dracula': draculaTheme,
  'monokai': monokaiTheme,
  'ocean': oceanTheme,
  'ember': emberTheme,
  'ghost': ghostTheme,
};

export const THEME_IDS = Object.keys(THEME_CATALOG) as ThemeId[];

export function isValidTheme(id: string): id is ThemeId {
  return id in THEME_CATALOG;
}

// ---------------------------------------------------------------------------
// Active Theme (global singleton)
// ---------------------------------------------------------------------------

let _activeTheme: ThemePalette = defaultTheme;
let _activeThemeId: ThemeId = 'default';

/** Get the current active theme */
export function theme(): ThemePalette {
  return _activeTheme;
}

/** Get the current active theme ID */
export function themeId(): ThemeId {
  return _activeThemeId;
}

/** Set the active theme by ID */
export function setTheme(id: ThemeId): ThemePalette {
  const t = THEME_CATALOG[id];
  if (!t) throw new Error(`Unknown theme: ${id}. Available: ${THEME_IDS.join(', ')}`);
  _activeTheme = t;
  _activeThemeId = id;
  return t;
}

/** Format the theme list for display */
export function formatThemeList(activeId: ThemeId): string {
  const lines = ['\n  Available themes:\n'];
  for (const id of THEME_IDS) {
    const t = THEME_CATALOG[id];
    const active = id === activeId ? t.success(' \u25cf') : '  ';
    const name = id === activeId ? t.bold(t.name) : chalk.gray(t.name);
    const desc = chalk.gray(t.description);
    lines.push(`  ${active} ${chalk.hex('#888')(id.padEnd(14))} ${name}  ${desc}`);
  }
  lines.push(chalk.gray(`\n  Switch with: /theme <name>\n`));
  return lines.join('\n');
}
