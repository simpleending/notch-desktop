import { boundedText, webUrl } from './content.js';

export interface SearchResult { title: string; url: string; content: string }

function text(html: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
  return html.replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (entity, name: string) => {
    if (name[0] !== '#') return named[name.toLowerCase()] ?? entity;
    const code = name.slice(1, 2).toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
  }).replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function searchDomain(value: string): string {
  const host = new URL(webUrl(value.includes('://') ? value : `https://${value}`)).hostname.toLowerCase();
  if (!/^[a-z\d.-]+$/.test(host)) throw Error('Search domain filters must contain a valid hostname.');
  return host;
}

export function parseDuckDuckGo(html: string): SearchResult[] {
  if (/anomaly\.js|anomaly-modal|challenge-form|bots use DuckDuckGo too/i.test(html)) {
    throw Error('DuckDuckGo requested a human verification. Retry later, open https://duckduckgo.com/ manually, or select Tavily in Web research settings.');
  }
  const results: SearchResult[] = [], seen = new Set<string>();
  // shortcut: DuckDuckGo's public HTML layout is not a versioned API; update this parser if its result markup changes.
  const anchors = [...html.matchAll(/<a\b([^>]*\bclass=["'][^"']*\bresult__a\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi)];
  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i]!, href = /\bhref=["']([^"']*)["']/i.exec(anchor[1]!)?.[1];
    if (!href) continue;
    try {
      let url = new URL(text(href), 'https://html.duckduckgo.com');
      if (url.hostname === 'duckduckgo.com' || url.hostname.endsWith('.duckduckgo.com')) {
        const target = url.searchParams.get('uddg'); if (!target) continue;
        url = new URL(webUrl(target));
      }
      url = new URL(webUrl(url.href));
      if (seen.has(url.href)) continue;
      const tail = html.slice(anchor.index! + anchor[0].length, anchors[i + 1]?.index ?? html.length);
      const snippet = /<[^>]*\bclass=["'][^"']*\bresult__snippet\b[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/i.exec(tail)?.[1] ?? '';
      results.push({ title: text(anchor[2]!) || url.hostname, url: url.href, content: text(snippet) }); seen.add(url.href);
    } catch { /* Ignore malformed or unsafe result links. */ }
  }
  if (!anchors.length && !/class=["'][^"']*\bno-results\b|No results found for/i.test(html)) {
    throw Error('DuckDuckGo returned an unrecognized search page. Retry later or select Tavily in Web research settings.');
  }
  if (anchors.length && !results.length) throw Error('DuckDuckGo returned no usable source links. Try another search or select Tavily in Web research settings.');
  return results;
}

export async function searchDuckDuckGo(query: string, maxResults: number, include: string[] = [], exclude: string[] = [], signal?: AbortSignal): Promise<SearchResult[]> {
  const allowed = include.map(searchDomain), denied = exclude.map(searchDomain);
  const filters = [allowed.length ? `(${allowed.map(host => `site:${host}`).join(' OR ')})` : '', ...denied.map(host => `-site:${host}`)].filter(Boolean);
  const url = new URL('https://html.duckduckgo.com/html/'); url.searchParams.set('q', [query, ...filters].join(' '));
  const response = await fetch(url.href, { signal, headers: { Accept: 'text/html' } });
  if (!response.ok) throw Error(`DuckDuckGo search failed: HTTP ${response.status}. Retry later or select Tavily in Web research settings.`);
  const results = parseDuckDuckGo(await boundedText(response));
  const matches = (hostname: string, host: string) => hostname === host || hostname.endsWith('.' + host);
  return results.filter(row => {
    const host = new URL(row.url).hostname.toLowerCase();
    return (!allowed.length || allowed.some(domain => matches(host, domain))) && !denied.some(domain => matches(host, domain));
  }).slice(0, maxResults);
}
