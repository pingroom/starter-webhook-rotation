import { loadEnvFile } from 'node:process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson } from './storage.mjs';
import { roomCode } from './values.mjs';
export const root = fileURLToPath(new URL('..', import.meta.url));
export const home = join(root, '.pingroom');
export const directory = join(root, '.rotation');
export function environment() {
  try { loadEnvFile(join(root, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw new Error('Could not load .env.'); }
}
export async function connection(env = process.env) {
  const room = roomCode(env.PINGROOM_ROOM);
  let token;
  if (Object.hasOwn(env, 'PINGROOM_TOKEN') || env.CI) token = env.PINGROOM_TOKEN;
  else {
    let saved;
    try { saved = await readJson(join(home, 'credentials.json')); } catch { throw new Error('Run npm run connect or set PINGROOM_TOKEN.'); }
    if (saved?.api_url && saved.api_url !== 'https://api.pingroom.io') throw new Error('This starter requires a production PingRoom connection.');
    token = saved?.token;
  }
  if (typeof token !== 'string' || !token || token.length > 8192 || /\s/u.test(token)) throw new Error('The agent token must be nonblank and contain no whitespace.');
  return { room, token, apiUrl: 'https://api.pingroom.io' };
}
