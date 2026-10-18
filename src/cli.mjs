import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export const cliPath = createRequire(import.meta.url).resolve('@pingroom/cli/bin/pingroom.js');
export function cliTransport(connection, { timeoutMs = 15000 } = {}) {
  const call = async (args) => {
    const home = await mkdtemp(join(tmpdir(), 'pingroom-rotation-'));
    try {
      const { stdout } = await exec(process.execPath, [cliPath, 'webhooks', ...args, '--json'], {
        env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, CI: 'true', PINGROOM_NO_UPDATE_CHECK: '1',
          PINGROOM_HOME: home, PINGROOM_TOKEN: connection.token, PINGROOM_ROOM: connection.room, PINGROOM_API_URL: connection.apiUrl },
        timeout: timeoutMs, maxBuffer: 65536,
      });
      return JSON.parse(stdout);
    } catch { throw new Error('CLI request was not confirmed; preserve the journal and use recover. Raw responses are suppressed.'); }
    finally { await rm(home, { recursive: true, force: true }); }
  };
  return {
    list: () => call(['list']),
    create: (settings) => {
      const args = ['create'];
      for (const key of ['name','title','message','icon','color','sound']) if (settings[key] !== null) args.push(`--${key}`, settings[key]);
      if (settings.action_number !== null) args.push('--action', String(settings.action_number));
      args.push('--cooldown', String(settings.cooldown_seconds), '--enabled', 'true');
      return call(args);
    },
    disable: (id) => call(['update', id, '--enabled', 'false']),
  };
}
