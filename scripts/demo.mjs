import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cliTransport } from '../src/cli.mjs';
import { rotation } from '../src/rotation.mjs';
import { mockServer, oldId } from './mock-server.mjs';
const mock = await mockServer();
const directory = await mkdtemp(join(tmpdir(), 'rotation-demo-'));
try {
  const app = rotation(directory, mock.connection, cliTransport(mock.connection));
  const plan = await app.plan(oldId);
  console.log('Offline demo: plan recorded; predecessor remains enabled.');
  await app.stage(plan.planHash);
  await app.exportUrl(plan.planHash);
  console.log('Successor staged. Its URL was written privately, never printed.');
  await app.adopt(plan.planHash, true); // Simulated operator confirmation; no downstream service exists in this demo.
  const receipt = await app.retire(plan.planHash);
  console.log(`Rotation ${receipt.state}: successor enabled, predecessor disabled.`);
  console.log(`Used the pinned CLI against localhost for ${mock.requests.length} management requests. No live pings or external adoption were tested.`);
} finally { await mock.close(); await rm(directory, { recursive: true, force: true }); }
