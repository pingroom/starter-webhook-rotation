import { connection, directory, environment } from '../src/config.mjs';
import { cliTransport } from '../src/cli.mjs';
import { rotation } from '../src/rotation.mjs';
try {
  const [command, argument, confirmation, ...extra] = process.argv.slice(2);
  if (extra.length) throw new Error('Unexpected arguments.');
  const noArgument = ['status', 'recover', 'inventory'].includes(command);
  const singleArgument = ['plan', 'stage', 'retire', 'export-url', 'cancel'].includes(command);
  if ((!noArgument && !singleArgument && command !== 'adopt') || (noArgument && (argument || confirmation)) || (singleArgument && (!argument || confirmation)) || (command === 'adopt' && (!argument || confirmation !== '--downstream-updated'))) throw new Error('See the README for commands and required arguments.');
  environment();
  const config = await connection();
  const app = rotation(directory, config, cliTransport(config));
  const result = command === 'export-url' ? await app.exportUrl(argument) : await app[command](argument, confirmation === '--downstream-updated');
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  // All errors from external subprocesses are replaced with static messages by cli.mjs.
  console.error(error.message); process.exitCode = 1;
}
