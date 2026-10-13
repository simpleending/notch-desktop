/** Accept OLLAMA_HOST, native API roots and OpenAI-compatible roots consistently. */
export function ollamaRoot(host = process.env.OLLAMA_HOST || 'http://localhost:11434'): string {
  const url = new URL(host.includes('://') ? host : `http://${host}`);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Ollama host must be an HTTP(S) URL without embedded credentials.');
  }
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(v1|api)$/, '');
  return url.toString().replace(/\/+$/, '');
}

export function ollamaChatUrl(host?: string): string {
  return `${ollamaRoot(host)}/v1`;
}
