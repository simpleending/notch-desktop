import { z } from 'zod';
import type { Browser, Page } from 'playwright-core';
import type { NotchTool, ToolContext, ToolResult } from './types.js';
import { loadWebSettings } from '../web/settings.js';
import { sourceLink, webContent, webUrl } from '../web/content.js';

const step = z.object({ action: z.enum(['click', 'fill', 'select', 'press']), selector: z.string().min(1).max(500), value: z.string().max(8000).optional() });
const readParameters = z.object({ url: z.string().max(8192), wait_for: z.string().max(500).optional(), max_length: z.number().int().min(500).max(30000).default(16000).optional() });
const interactParameters = readParameters.extend({ steps: z.array(step).min(1).max(8) });

async function snapshot(page: Page, limit: number): Promise<string> {
  const data = await page.evaluate(() => {
    const main = document.querySelector('main, [role="main"]') || document.body;
    return { title: document.title, text: (main as HTMLElement)?.innerText || '',
      links: Array.from(main.querySelectorAll('a[href]')).slice(0, 60).map(node => ({ title: (node.textContent || '').trim().slice(0, 120), url: (node as HTMLAnchorElement).href })),
      controls: Array.from(document.querySelectorAll('input:not([type=hidden]),button,select,textarea')).slice(0, 40).map(node => ({ tag: node.tagName.toLowerCase(), id: node.id, name: node.getAttribute('name'), label: node.getAttribute('aria-label'), type: node.getAttribute('type'), text: node.tagName === 'BUTTON' ? node.textContent?.trim().slice(0, 100) : undefined })),
    };
  });
  const links = data.links.flatMap(link => { try { return [sourceLink(link.title, link.url)]; } catch { return []; } });
  return webContent(data.title || 'Browser page', page.url(), data.text.slice(0, limit) + (data.text.length > limit ? '\n[Page text truncated]' : '') + '\n\nLinks:\n' + [...new Set(links)].join('\n') + '\n\nControls (CSS selectors can target id, name, or aria-label):\n' + JSON.stringify(data.controls));
}

async function browse(params: z.infer<typeof readParameters> & { steps?: z.infer<typeof step>[] }, ctx: ToolContext): Promise<ToolResult> {
  let browser: Browser | undefined;
  const signal = AbortSignal.any([...(ctx.abortSignal ? [ctx.abortSignal] : []), AbortSignal.timeout(60000)]);
  const stop = () => { void browser?.close().catch(() => {}); };
  try {
    const url = webUrl(params.url), settings = await (ctx.webSettings?.() ?? loadWebSettings());
    if (!settings.enabled) throw new Error('Web research is disabled. Enable it in Settings → Appearance → Web research, or /settings web.');
    signal.throwIfAborted(); signal.addEventListener('abort', stop, { once: true });
    const { chromium } = await import('playwright-core');
    const channels = settings.browser === 'auto' ? (process.platform === 'win32' ? ['msedge', 'chrome', 'chromium'] : ['chrome', 'chromium']) : [settings.browser];
    for (const channel of channels) {
      signal.throwIfAborted();
      try { browser = await chromium.launch({ headless: true, chromiumSandbox: true, ...(channel === 'chromium' ? {} : { channel }), timeout: 12000 }); break; }
      catch { /* Try the next installed browser without downloading anything. */ }
    }
    if (!browser) throw new Error('No supported browser could start. Choose Chrome or Edge, or install Chromium in Settings → Appearance → Web research (/settings web in the CLI).');
    signal.throwIfAborted();
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block' });
    await context.route('**/*', route => { try { webUrl(route.request().url()); return route.continue(); } catch { return route.abort(); } });
    context.on('page', popup => { if (context.pages().length > 1) void popup.close(); });
    const page = await context.newPage(); page.setDefaultTimeout(8000); page.setDefaultNavigationTimeout(25000);
    page.on('dialog', dialog => { void dialog.dismiss(); });
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    for (const action of params.steps || []) {
      signal.throwIfAborted();
      const target = page.locator(action.selector);
      if (await target.count() !== 1) throw new Error(`Selector must match exactly one element: ${action.selector}`);
      if (action.action === 'click') await target.click();
      else {
        if (action.value === undefined) throw new Error(`${action.action} requires a value.`);
        if (action.action === 'fill') await target.fill(action.value);
        else if (action.action === 'select') await target.selectOption(action.value);
        else await target.press(action.value);
      }
    }
    if (params.wait_for) await page.locator(params.wait_for).first().waitFor({ state: 'visible' });
    signal.throwIfAborted();
    return { content: await snapshot(page, params.max_length ?? 16000) };
  } catch (error) {
    return { content: signal.aborted ? 'Browser operation canceled or timed out.' : `Browser error: ${(error as Error).message}`, isError: true };
  } finally { signal.removeEventListener('abort', stop); await browser?.close().catch(() => {}); }
}

export const browserReadTool: NotchTool<typeof readParameters> = {
  name: 'browser_read', parameters: readParameters,
  description: 'Read a URL in a real headless browser, including JavaScript-rendered pages. Returns visible text, source links and controls. No API key. An installed Chrome, Edge or Chromium is required; set up in Web research settings. Each call uses a fresh private session that closes afterward.',
  execute: browse,
};
export const browserInteractTool: NotchTool<typeof interactParameters> = {
  name: 'browser_interact', parameters: interactParameters,
  description: 'Open a URL in a fresh private browser and perform up to 8 CSS-selector actions (click/fill/select/press), then read the resulting page. Include all steps in one call; sessions do not persist. External actions require write permission/approval. Never enter credentials unless the user explicitly requests it. Browser downloads and popups are disabled.',
  execute: browse,
};
