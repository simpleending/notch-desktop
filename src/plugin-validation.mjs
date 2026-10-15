import fs from 'node:fs/promises';
import path from 'node:path';

/** Validate metadata without running a plugin or its commands during discovery. */
export async function validateLocalPlugin(inputPath) {
  const root = path.resolve(inputPath), diagnostics = [];
  const fail = (message, phase = 'manifest') => diagnostics.push({ severity: 'error', code: 'NOTCH_PLUGIN_INVALID', message, phase });
  async function checked(relative) {
    if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes('\\') || relative.includes('\0')) throw new Error('Invalid plugin component path.');
    const target = path.resolve(root, relative);
    if (!target.startsWith(root + path.sep)) throw new Error('Plugin component escaped its installation.');
    let cursor = target;
    while (true) {
      if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error('Plugin components cannot follow symbolic links.');
      if (cursor === root) break;
      cursor = path.dirname(cursor);
    }
    return target;
  }
  async function json(relative) {
    const file = await checked(relative), stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > 2 ** 20) throw new Error('Plugin metadata must be a JSON file smaller than 1 MiB.');
    return JSON.parse(await fs.readFile(file, 'utf8'));
  }
  let components = 0;
  try {
    const manifest = await json('.notch-plugin/plugin.json');
    if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(manifest.name) || (manifest.version !== undefined && typeof manifest.version !== 'string')) throw new Error('Plugin manifest needs a valid name and version.');
    for (const key of ['skills', 'agents', 'commands']) {
      let entries = manifest[key];
      if (entries === undefined) {
        try { await fs.access(path.join(root, key)); entries = [key]; } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      if (entries === undefined) continue;
      if (typeof entries === 'string') entries = [entries];
      if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) throw new Error(`Invalid ${key} component paths.`);
      for (const entry of entries) { await checked(entry); components++; }
    }
    const sources = manifest.mcpServers === undefined ? [] : Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers];
    for (const source of sources) {
      let servers = typeof source === 'string' ? await json(source) : source;
      servers = servers?.mcpServers ?? servers;
      if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('Invalid plugin MCP configuration.');
      for (const [name, server] of Object.entries(servers)) {
        if (!name || !server || typeof server !== 'object' || Array.isArray(server)) throw new Error('Invalid plugin MCP server.');
        if (server.command !== undefined) {
          if (typeof server.command !== 'string' || !server.command.trim() || (server.args !== undefined && (!Array.isArray(server.args) || server.args.some(arg => typeof arg !== 'string')))) throw new Error('Invalid plugin MCP command.');
        } else {
          const url = new URL(server.url || server.httpUrl);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid plugin MCP URL.');
        }
        components++;
      }
    }
  } catch (error) { fail(error.message); }
  return { schemaVersion: 1, valid: diagnostics.length === 0, validator: { name: 'notch', version: '0.1.0' },
    target: { inputPath, resolvedPath: root }, diagnostics,
    summary: { errorCount: diagnostics.length, warningCount: 0, componentCount: components } };
}
