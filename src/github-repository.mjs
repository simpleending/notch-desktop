export function githubRepository(value) {
  if (typeof value !== 'string') return null;
  let name = value.trim();
  if (/^(?:https?:\/\/|ssh:\/\/|git@)/i.test(name)) {
    try {
      const url = new URL(name.replace(/^git@github\.com:/i, 'https://github.com/'));
      const ssh = url.protocol === 'ssh:';
      if ((!ssh && url.protocol !== 'https:') || url.hostname.toLowerCase() !== 'github.com' || url.password ||
        (ssh ? url.username !== 'git' || url.port && url.port !== '22' : url.username || url.port)) return null;
      name = url.pathname.replace(/^\//, '').replace(/\/$/, '');
    } catch { return null; }
  }
  name = name.replace(/\.git$/, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) && name.split('/').every(part => part !== '.' && part !== '..') ? name : null;
}

export function githubCloneUrl(value, protocol = 'https') {
  const repo = githubRepository(value);
  if (!repo || !['https', 'ssh'].includes(protocol)) return null;
  const ssh = /^(?:git@|ssh:\/\/)/i.test(value.trim()) || !/^https:\/\//i.test(value.trim()) && protocol === 'ssh';
  return ssh ? `git@github.com:${repo}.git` : `https://github.com/${repo}.git`;
}
