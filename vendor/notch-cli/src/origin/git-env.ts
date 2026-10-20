import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function originAuthPath(env: NodeJS.ProcessEnv = process.env) {
  return path.join(env.LOCALAPPDATA || path.join(env.HOME || env.USERPROFILE || os.homedir(), '.config'), 'notch', 'origin', 'auth.json');
}

/** Configure only Origin HTTPS; SSH and other hosts retain their own credentials. */
export function originGitEnv(env: NodeJS.ProcessEnv = process.env, helper = fileURLToPath(new URL(existsSync(new URL('./origin-credential.js', import.meta.url)) ? './origin-credential.js' : '../../node_modules/@freesyntax/notch-cli/dist/origin-credential.js', import.meta.url))) {
  if (!env.CURSOR_API_KEY && !env.CURSOR_AUTH_TOKEN && !existsSync(originAuthPath(env))) return { ...env };
  const count = Number(env.GIT_CONFIG_COUNT || '0');
  if (!Number.isSafeInteger(count) || count < 0 || count > 10000) throw Error('Invalid GIT_CONFIG_COUNT.');
  const quote = (value: string) => "'" + value.replaceAll('\\', '/').replaceAll("'", "'\"'\"'") + "'";
  return { ...env, GIT_CONFIG_COUNT: String(count + 2),
    [`GIT_CONFIG_KEY_${count}`]: 'credential.https://origin.cursor.com.helper', [`GIT_CONFIG_VALUE_${count}`]: '',
    [`GIT_CONFIG_KEY_${count + 1}`]: 'credential.https://origin.cursor.com.helper',
    [`GIT_CONFIG_VALUE_${count + 1}`]: `!ELECTRON_RUN_AS_NODE=1 ${quote(process.execPath)} ${quote(helper)} credential`,
  };
}
