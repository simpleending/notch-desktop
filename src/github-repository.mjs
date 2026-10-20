export function githubRepository(value) {
  if (typeof value !== 'string') return null;
  let name = value.trim();
  if (/^(?:https?:\/\/|git@)/i.test(name)) {
    try {
      const url = new URL(name.replace(/^git@github\.com:/i, 'https://github.com/'));
      if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com' || url.username || url.password || url.port) return null;
      name = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    } catch { return null; }
  }
  name = name.replace(/\.git$/, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) && name.split('/').every(part => part !== '.' && part !== '..') ? name : null;
}
