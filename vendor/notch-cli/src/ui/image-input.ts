/**
 * Notch CLI — Image Input (Multimodal Attachments)
 *
 * Resolves a user-supplied image spec — a local file path, an http(s) URL,
 * or a data URL — into a validated ImageAttachment that can be rendered
 * into a Vercel AI SDK `ModelMessage` content block of type `"image"`.
 *
 * Design notes:
 * - Non-throwing: `loadImage` returns `{error}` on failure so callers can
 *   degrade gracefully (one-shot fails hard, REPL prints and continues).
 * - No new deps: uses Node 20+ `globalThis.fetch` and `node:fs/promises`.
 * - Size cap: 20 MB default, tunable via `NOTCH_MAX_IMAGE_BYTES`.
 * - URL fetches have a 30s timeout and reject non-image content types.
 *
 * Copyright 2026 Driftrail. Apache-2.0.
 */

import { promises as fs } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImageAttachment {
  /** Where the bytes came from */
  source: 'file' | 'url' | 'data';
  /** Original local path (only when source === 'file') */
  path?: string;
  /** Original remote URL (only when source === 'url') */
  url?: string;
  /** data:image/*;base64,... — populated for 'file' (from disk) and 'data' (pass-through) */
  dataUrl?: string;
  /** Mime type, e.g. "image/png" */
  mimeType: string;
  /** Decoded byte count */
  sizeBytes: number;
}

export interface ImageLoadError {
  error: string;
}

export type ImageLoadResult = ImageAttachment | ImageLoadError;

export function isImageLoadError(r: ImageLoadResult): r is ImageLoadError {
  return (r as ImageLoadError).error !== undefined;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024; // 20 MB
const FETCH_TIMEOUT_MS = 30_000;

/** Extension → mime map. Keep in sync with `pathLooksLikeImage`. */
const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
};

/** Supported image mime types (what we will accept from URL fetches / data URLs) */
export const SUPPORTED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'image/bmp',
]);

/** Regex matching filenames that look like images (extension-based). */
const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif|bmp)$/i;

/**
 * Regex that captures a whole whitespace-bounded token that LOOKS like an
 * image path. The token must either include a path separator (so we know
 * it's a path, not prose) OR consist of a bare filename that's followed by
 * whitespace / end-of-string (e.g. `shot.png`).
 *
 * We deliberately refuse to match when the extension is embedded mid-prose
 * with no separator and no clear token boundary, e.g. `foo.png-v2` or a URL
 * fragment.
 */
const IMAGE_PATH_TOKEN_RE = /(?:^|\s)((?:(?:[~.][\\/]|[A-Za-z]:[\\/]|[\\/]|[^\s@"'`<>]+[\\/])[^\s"'`<>]*?|[^\s@"'`<>/\\]+)\.(?:png|jpe?g|webp|gif|bmp))(?=\s|$|[.,;:!?)\]])/gi;

/** data:image/*;base64,... capture (whole-token) */
const DATA_URL_RE = /(?:^|\s)(data:image\/(?:png|jpeg|webp|gif|bmp);base64,[A-Za-z0-9+/=]+)(?=\s|$)/gi;

/** Image: <path> prefix — explicit attachment directive (supports quoted paths with spaces) */
const IMAGE_PREFIX_RE = /^\s*Image:\s*(?:"([^"]+)"|'([^']+)'|(\S+))\s*/i;

/**
 * Quoted image paths ("./my folder/shot.png" or './a b.jpg'). Drag-drop on
 * many terminals wraps paths with spaces in quotes — catch those.
 */
const QUOTED_IMAGE_RE = /(?:^|\s)(["'])([^"']*?\.(?:png|jpe?g|webp|gif|bmp))\1(?=\s|$|[.,;:!?)\]])/gi;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function maxImageBytes(): number {
  const raw = process.env.NOTCH_MAX_IMAGE_BYTES;
  if (!raw) return DEFAULT_MAX_BYTES;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_BYTES;
}

function mimeFromExt(ext: string): string | null {
  return MIME_BY_EXT[ext.toLowerCase()] ?? null;
}

/** Expand `~` to the user's home directory, then resolve against cwd. */
function expandUserPath(p: string, cwd: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    return nodePath.resolve(os.homedir(), p.slice(2));
  }
  return nodePath.isAbsolute(p) ? p : nodePath.resolve(cwd, p);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Quick check: does this string look like an image path? Extension-only. */
export function pathLooksLikeImage(s: string): boolean {
  return IMAGE_EXT_RE.test(s);
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

/**
 * Fetch an image over http(s). Validates `content-type`, enforces a timeout,
 * and caps the download at `maxImageBytes()`.
 */
async function loadFromUrl(url: string): Promise<ImageLoadResult> {
  const max = maxImageBytes();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await globalThis.fetch(url, { signal: controller.signal });
    if (!res.ok) {
      return { error: `Failed to fetch ${url}: HTTP ${res.status}` };
    }
    const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    if (!contentType.startsWith('image/')) {
      return { error: `URL ${url} did not return an image (content-type: ${contentType || 'unknown'})` };
    }
    if (!SUPPORTED_IMAGE_MIMES.has(contentType)) {
      return { error: `Unsupported image type: ${contentType}. Supported: ${Array.from(SUPPORTED_IMAGE_MIMES).join(', ')}` };
    }
    // Stream with size cap
    const lenHeader = res.headers.get('content-length');
    if (lenHeader) {
      const declared = parseInt(lenHeader, 10);
      if (Number.isFinite(declared) && declared > max) {
        return { error: `Image too large: ${formatBytes(declared)} > ${formatBytes(max)}` };
      }
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.byteLength > max) {
      return { error: `Image too large: ${formatBytes(buf.byteLength)} > ${formatBytes(max)}` };
    }
    const dataUrl = `data:${contentType};base64,${buf.toString('base64')}`;
    return {
      source: 'url',
      url,
      dataUrl,
      mimeType: contentType,
      sizeBytes: buf.byteLength,
    };
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      return { error: `Fetch timed out after ${FETCH_TIMEOUT_MS / 1000}s: ${url}` };
    }
    return { error: `Failed to fetch ${url}: ${err?.message ?? String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse a data: URL. Validates mime and decodes the base64 body for sizing.
 */
function loadFromDataUrl(spec: string): ImageLoadResult {
  const max = maxImageBytes();
  const m = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(spec);
  if (!m) return { error: 'Malformed data URL (expected data:image/*;base64,...)' };
  const mimeType = m[1]!.toLowerCase();
  const b64 = m[2]!;
  if (!SUPPORTED_IMAGE_MIMES.has(mimeType)) {
    return { error: `Unsupported image type: ${mimeType}` };
  }
  let sizeBytes: number;
  try {
    sizeBytes = Buffer.from(b64, 'base64').byteLength;
  } catch {
    return { error: 'Data URL base64 body failed to decode' };
  }
  if (sizeBytes > max) {
    return { error: `Image too large: ${formatBytes(sizeBytes)} > ${formatBytes(max)}` };
  }
  return { source: 'data', dataUrl: spec, mimeType, sizeBytes };
}

/**
 * Read an image off the local filesystem.
 */
async function loadFromFile(spec: string, cwd: string): Promise<ImageLoadResult> {
  const max = maxImageBytes();
  const abs = expandUserPath(spec, cwd);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(abs);
  } catch (err: any) {
    return { error: `Image file not found: ${abs} (${err?.code ?? err?.message ?? 'unknown error'})` };
  }
  if (!stat.isFile()) {
    return { error: `Not a file: ${abs}` };
  }
  if (stat.size > max) {
    return { error: `Image too large: ${formatBytes(stat.size)} > ${formatBytes(max)}` };
  }
  const ext = nodePath.extname(abs).toLowerCase();
  const mimeType = mimeFromExt(ext);
  if (!mimeType) {
    return { error: `Unknown image type for extension "${ext}". Supported: ${Object.keys(MIME_BY_EXT).join(', ')}` };
  }
  let buf: Buffer;
  try {
    buf = await fs.readFile(abs);
  } catch (err: any) {
    return { error: `Failed to read ${abs}: ${err?.message ?? String(err)}` };
  }
  const dataUrl = `data:${mimeType};base64,${buf.toString('base64')}`;
  return {
    source: 'file',
    path: abs,
    dataUrl,
    mimeType,
    sizeBytes: buf.byteLength,
  };
}

/**
 * Load an image from any supported spec form.
 *
 * Accepts:
 * - Local paths (absolute, relative, or `~`-prefixed)
 * - `http://` / `https://` URLs
 * - `data:image/*;base64,...` URLs
 *
 * Never throws. Returns `{error}` on failure so callers can decide whether
 * to abort (one-shot) or print + skip (REPL).
 */
export async function loadImage(spec: string, cwd: string = process.cwd()): Promise<ImageLoadResult> {
  const trimmed = spec.trim();
  if (!trimmed) return { error: 'Empty image spec' };

  if (trimmed.startsWith('data:')) {
    return loadFromDataUrl(trimmed);
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return loadFromUrl(trimmed);
  }
  return loadFromFile(trimmed, cwd);
}

// ---------------------------------------------------------------------------
// AI SDK content-block shape
// ---------------------------------------------------------------------------

/**
 * Shape matches the Vercel AI SDK `{type: 'image', image, mimeType}` content
 * block. `image` may be a string (data URL / http URL), a URL object, or a
 * Buffer; the SDK accepts all three.
 */
export interface ImageContentBlock {
  type: 'image';
  image: string | URL | Buffer;
  mimeType: string;
}

/**
 * Project an ImageAttachment into the AI SDK content-array shape.
 *
 * For http(s) URLs we prefer the data URL (already fetched + validated) over
 * passing the raw URL — this keeps auth/CORS behaviour consistent and means
 * the downstream model never has to re-fetch.
 */
export function imageToContentBlock(att: ImageAttachment): ImageContentBlock {
  if (att.dataUrl) {
    return { type: 'image', image: att.dataUrl, mimeType: att.mimeType };
  }
  if (att.source === 'url' && att.url) {
    return { type: 'image', image: new URL(att.url), mimeType: att.mimeType };
  }
  // Should not happen — dataUrl is always populated for file/data sources.
  throw new Error('ImageAttachment has neither dataUrl nor url');
}

// ---------------------------------------------------------------------------
// REPL helpers — detect inline image references in free-form input
// ---------------------------------------------------------------------------

export interface ExtractedImageRefs {
  /** Input with all matched image tokens removed (whitespace normalised). */
  cleanedText: string;
  /** Specs found in the input, in order, deduplicated. */
  specs: string[];
}

/**
 * Scan free-form user input for image references:
 *   - `Image: <path>` prefix (one-shot, must be at start)
 *   - whole-token paths ending in .png/.jpg/.jpeg/.webp/.gif/.bmp
 *   - literal `data:image/*;base64,...` tokens
 *
 * Returns the cleaned text and the list of image specs to load. Callers are
 * responsible for calling `loadImage` on each spec.
 */
export function extractImageRefs(input: string): ExtractedImageRefs {
  const specs: string[] = [];
  const seen = new Set<string>();
  let cleaned = input;

  // 1) Image: <path> prefix (explicit directive, supports quoted paths)
  const prefixMatch = IMAGE_PREFIX_RE.exec(cleaned);
  if (prefixMatch) {
    const spec = prefixMatch[1] ?? prefixMatch[2] ?? prefixMatch[3];
    if (spec && !seen.has(spec)) {
      seen.add(spec);
      specs.push(spec);
    }
    cleaned = cleaned.replace(IMAGE_PREFIX_RE, '').trimStart();
  }

  // 2) data:image/...;base64,... tokens
  cleaned = cleaned.replace(DATA_URL_RE, (_m, url: string) => {
    if (!seen.has(url)) {
      seen.add(url);
      specs.push(url);
    }
    return ' ';
  });

  // 3) Quoted paths (drag-drop often wraps paths with spaces in quotes)
  cleaned = cleaned.replace(QUOTED_IMAGE_RE, (_m, _q: string, tok: string) => {
    if (!seen.has(tok)) {
      seen.add(tok);
      specs.push(tok);
    }
    return ' ';
  });

  // 4) Whole-token paths with image extension
  cleaned = cleaned.replace(IMAGE_PATH_TOKEN_RE, (_m, tok: string) => {
    if (!seen.has(tok)) {
      seen.add(tok);
      specs.push(tok);
    }
    return ' ';
  });

  // Normalise whitespace
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return { cleanedText: cleaned, specs };
}

/**
 * Format a one-line "attached: foo.png (124 KB)" status for user feedback.
 */
export function formatAttachmentStatus(att: ImageAttachment): string {
  const label = att.source === 'url'
    ? att.url ?? '(url)'
    : att.source === 'file'
      ? nodePath.basename(att.path ?? '(file)')
      : `data:${att.mimeType}`;
  return `attached: ${label} (${formatBytes(att.sizeBytes)})`;
}
