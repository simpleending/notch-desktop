export function originRepository(value) {
  if (typeof value !== 'string') return null;
  let name = value.trim();
  if (/^(?:https?:\/\/|ssh:\/\/|git@)/i.test(name)) {
    try {
      const url = new URL(name.replace(/^git@origin\.cursor\.com:/i, 'ssh://git@origin.cursor.com/'));
      const ssh = url.protocol === 'ssh:';
      if ((!ssh && url.protocol !== 'https:') || url.hostname !== 'origin.cursor.com' || url.password ||
        (ssh ? url.username !== 'git' || url.port && url.port !== '22' : url.username || url.port) || url.search || url.hash) return null;
      name = url.pathname.replace(/^\//, '').replace(/\/$/, '');
      if (name.startsWith('git/') && name.split('/').length === 3) name = name.slice(4);
    } catch { return null; }
  }
  name = name.replace(/\.git$/, '');
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name) && name.split('/').every(part => part !== '.' && part !== '..') ? name : null;
}

export function originCloneUrl(value, protocol = 'https') {
  const repo = originRepository(value);
  if (!repo || !['https', 'ssh'].includes(protocol)) return null;
  if (/^https:\/\//i.test(value.trim())) return new URL(value.trim()).href.replace(/\/$/, '').replace(/(?:\.git)?$/, '.git');
  return /^(?:git@|ssh:\/\/)/i.test(value.trim()) || protocol === 'ssh' ? `git@origin.cursor.com:${repo}.git` : `https://origin.cursor.com/${repo}.git`;
}
