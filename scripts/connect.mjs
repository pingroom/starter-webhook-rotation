import { spawn } from 'node:child_process';
import { cliPath } from '../src/cli.mjs';
import { home } from '../src/config.mjs';
const child = spawn(process.execPath, [cliPath, 'pair', '--agent-label', 'Webhook-rotation-starter', '--api', 'https://api.pingroom.io'], {
  stdio: 'inherit', env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TERM: process.env.TERM,
    PINGROOM_HOME: home, PINGROOM_NO_UPDATE_CHECK: '1' },
});
child.once('error', () => { console.error('Could not start CLI. Run npm ci first.'); process.exitCode = 1; });
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1); });
