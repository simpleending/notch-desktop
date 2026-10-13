import { theme } from './themes.js';

const WORDMARK = [
  'N   N  OOO  TTTTT  CCC  H   H',
  'NN  N O   O   T   C     H   H',
  'N N N O   O   T   C     HHHHH',
  'N  NN O   O   T   C     H   H',
  'N   N  OOO    T    CCC  H   H',
];

export interface BannerOptions { updateAvailable?: string | null }

function width(): number { return Math.max(1, (process.stdout.columns || 80) - 1); }

// Keep printed rows shorter than the terminal to avoid automatic wrapping.
function line(text: string): void {
  const columns = width();
  const chars = Array.from(text);
  console.log(chars.length > columns ? chars.slice(0, Math.max(0, columns - 1)).join('') + '…' : text);
}

export function printWordmark(version: string): void {
  const t = theme();
  console.log('');
  const graphic = process.stdout.isTTY && process.env.TERM !== 'dumb' && width() >= 44;
  if (graphic) {
    for (const row of WORDMARK) console.log(t.brand('  ' + row));
  } else line(`NOTCH v${version}`);
  if (graphic) line(`  v${version} · by Driftrail`);
  console.log('');
}

export function printBanner(version: string, modelLabel: string, modelId: string, modelSize: string, project: string, options: BannerOptions = {}): void {
  printWordmark(version);
  line(`  ${modelLabel} · ${modelId}${modelSize && modelSize !== 'provider' ? ` (${modelSize})` : ''}`);
  line(`  ${project}`);
  if (options.updateAvailable) line(`  Update v${options.updateAvailable} available: /update`);
  console.log('');
}

export function printCompactBanner(version: string): void { line(`NOTCH v${version}`); }

export function printMantis(): void {
  const t = theme();
  console.log('');
  for (const row of ['  /oo\\', '   /|\\', ' _/ | \\_', '    |', '   / \\']) line(row);
  console.log(t.dim('Precision. Patience. Execution.'));
  console.log('');
}
