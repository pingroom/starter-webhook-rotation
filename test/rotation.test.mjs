import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rotation } from '../src/rotation.mjs';
import { cliTransport } from '../src/cli.mjs';
import { connection } from '../src/config.mjs';
import { config, webhook } from '../src/values.mjs';
import { readJson } from '../src/storage.mjs';
import { mockServer, oldId, room, sample } from '../scripts/mock-server.mjs';

async function fixture(t, real = false, timeoutMs = 15000) {
  const directory = await mkdtemp(join(tmpdir(), 'rotation-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const conn = { token: 'offline-token', room, apiUrl: 'https://api.pingroom.io' };
  if (real) {
    const mock = await mockServer(); t.after(mock.close);
    return { ...mock, directory, app: rotation(directory, mock.connection, cliTransport(mock.connection, { timeoutMs })),
      journal: () => readJson(join(directory, 'journal.json')) };
  }
  const state = { items: [sample()] }, calls = { list: 0, create: 0, disable: 0 };
  const transport = {
    list: async () => { calls.list++; return structuredClone({ webhooks: state.items, count: state.items.length }); },
    create: async (settings) => { calls.create++; const item = { ...sample(), ...settings, id: randomUUID(), webhook_url: `https://api.pingroom.io/api/webhooks/${room}/${'B'.repeat(32)}` }; state.items.push(item); return structuredClone(item); },
    disable: async (id) => { calls.disable++; const item = state.items.find((item) => item.id === id); item.enabled = false; return structuredClone(item); },
  };
  return { state, calls, directory, transport, connection: conn, app: rotation(directory, conn, transport),
    journal: () => readJson(join(directory, 'journal.json')) };
}
async function staged(f) { const p = await f.app.plan(oldId); await f.app.stage(p.planHash); return p.planHash; }

test('real CLI completes overlap rotation and preserves settings without trigger/delete routes', async (t) => {
  const f = await fixture(t, true); const hash = await staged(f);
  assert.equal(f.state.items[0].enabled, true); assert.equal(f.state.items[1].enabled, true);
  await f.app.exportUrl(hash);
  assert.equal((await stat(join(f.directory, 'successor-url.txt'))).mode & 0o777, 0o600);
  assert.equal((await readFile(join(f.directory, 'successor-url.txt'), 'utf8')).trim(), f.state.items[1].webhook_url);
  await f.app.adopt(hash, true); const result = await f.app.retire(hash);
  assert.equal(result.state, 'complete'); assert.equal(f.state.items[0].enabled, false); assert.equal(f.state.items[1].enabled, true);
  assert.deepEqual(f.requests.filter((r) => r.method === 'PUT').map((r) => r.body), [{ enabled: false }]);
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
  assert.ok(f.requests.every((r) => r.url.startsWith(`/api/agent/rooms/${room}/webhooks`)));
  assert.ok(f.requests.every((r) => r.authorization === 'Bearer offline-token'));
  assert.ok(!JSON.stringify(result).includes('/api/webhooks/'));
});
test('real CLI lost create response is reconciled without a second create', async (t) => {
  const f = await fixture(t, true); const p = await f.app.plan(oldId); f.control.mode = 'lose-create';
  await assert.rejects(f.app.stage(p.planHash), /not confirmed/); assert.equal((await f.app.status()).state, 'creating');
  f.control.mode = null; assert.equal((await f.app.recover()).state, 'staged');
  await assert.rejects(f.app.stage(p.planHash), /Only a planned/);
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1); assert.equal(f.state.items[0].enabled, true);
});
test('real CLI lost retirement response is reconciled without a second update', async (t) => {
  const f = await fixture(t, true); const hash = await staged(f); await f.app.adopt(hash, true); f.control.mode = 'lose-retire';
  await assert.rejects(f.app.retire(hash), /not confirmed/); assert.equal((await f.app.status()).state, 'retiring');
  f.control.mode = null; assert.equal((await f.app.recover()).state, 'complete');
  await assert.rejects(f.app.retire(hash), /Retirement requires/);
  assert.equal(f.requests.filter((r) => r.method === 'PUT').length, 1);
});
test('real CLI error responses cannot disclose secret URLs in thrown errors', async (t) => {
  const f = await fixture(t, true); f.control.mode = 'forbidden';
  await assert.rejects(f.app.plan(oldId), (error) => !error.message.includes('A'.repeat(32)) && !error.message.includes('/api/webhooks/') && /Raw responses are suppressed/.test(error.message));
  assert.equal(f.requests.length, 1);
});
test('real CLI malformed success stays uncertain until read-only recovery', async (t) => {
  const f = await fixture(t, true); const p = await f.app.plan(oldId); f.control.mode = 'malformed-create';
  await assert.rejects(f.app.stage(p.planHash), /Malformed webhook identity/);
  assert.equal((await f.app.recover()).state, 'staged');
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
});
test('real CLI timeout after an observed request retains recoverable intent', async (t) => {
  const f = await fixture(t, true, 2000); const p = await f.app.plan(oldId); f.control.mode = 'hang-create';
  await assert.rejects(f.app.stage(p.planHash), /not confirmed/);
  assert.equal((await f.app.status()).state, 'creating'); f.control.mode = null;
  assert.equal((await f.app.recover()).state, 'staged');
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
});
test('a rejected create remains uncertain and readback does not authorize retry', async (t) => {
  const f = await fixture(t, true); const p = await f.app.plan(oldId); f.control.mode = 'reject-create';
  await assert.rejects(f.app.stage(p.planHash)); f.control.mode = null;
  assert.equal((await f.app.recover()).state, 'creating'); await assert.rejects(f.app.stage(p.planHash)); await assert.rejects(f.app.cancel(p.planHash));
  assert.equal(f.requests.filter((r) => r.method === 'POST').length, 1);
});
test('a rejected retirement cannot be retried from an enabled readback', async (t) => {
  const f = await fixture(t, true); const hash = await staged(f); await f.app.adopt(hash, true); f.control.mode = 'reject-retire';
  await assert.rejects(f.app.retire(hash)); f.control.mode = null;
  assert.equal((await f.app.recover()).state, 'retiring'); await assert.rejects(f.app.retire(hash));
  assert.equal(f.requests.filter((r) => r.method === 'PUT').length, 1);
});
test('plan is read-only and second plan cannot overwrite a reservation', async (t) => {
  const f = await fixture(t); await f.app.plan(oldId); await assert.rejects(f.app.plan(oldId), /already exists/);
  assert.deepEqual(f.calls, { list: 1, create: 0, disable: 0 });
});
test('planning rejects four total records including disabled records', async (t) => {
  const f = await fixture(t); for (let i = 0; i < 3; i++) f.state.items.push({ ...sample(), id: randomUUID(), enabled: false });
  await assert.rejects(f.app.plan(oldId), /four records/); assert.equal(f.calls.create, 0);
});
test('unsupported predecessor emoji is rejected before creation', async (t) => {
  const f = await fixture(t); f.state.items[0].emoji = '🚀'; await assert.rejects(f.app.plan(oldId), /default/); assert.equal(f.calls.create, 0);
});
test('unsupported haptic is rejected before creation', async (t) => {
  const f = await fixture(t); f.state.items[0].haptic = 'pulse'; await assert.rejects(f.app.plan(oldId), /haptic/); assert.equal(f.calls.create, 0);
});
test('unsupported server-trimmed edges are rejected but interior emoji joiners survive', () => {
  for (const edge of ['\u115f', '\u1160', '\u3164', '\uffa0', '\u034f', '\u200b', '\u2800']) assert.throws(() => config({ ...sample(), title: `${edge}Title` }), /unsupported/);
  assert.equal(config({ ...sample(), title: 'Family 👨‍👩‍👧' }).title, 'Family 👨‍👩‍👧');
});
test('predecessor configuration drift blocks creation', async (t) => {
  const f = await fixture(t); const p = await f.app.plan(oldId); f.state.items[0].message = 'Changed';
  await assert.rejects(f.app.stage(p.planHash), /drift/); assert.equal(f.calls.create, 0); assert.equal((await f.app.status()).state, 'planned');
});
test('predecessor credential drift blocks adoption', async (t) => {
  const f = await fixture(t); const hash = await staged(f); f.state.items[0].webhook_url = f.state.items[0].webhook_url.replace('A'.repeat(32), 'C'.repeat(32));
  await assert.rejects(f.app.adopt(hash, true), /drift/); assert.equal(f.calls.disable, 0);
});
test('successor drift blocks retirement', async (t) => {
  const f = await fixture(t); const hash = await staged(f); await f.app.adopt(hash, true); f.state.items[1].cooldown_seconds = 10;
  await assert.rejects(f.app.retire(hash), /drift/); assert.equal(f.calls.disable, 0); assert.equal(f.state.items[0].enabled, true);
});
test('adoption must be an explicit command and never follows stage automatically', async (t) => {
  const f = await fixture(t); const hash = await staged(f); await assert.rejects(f.app.retire(hash), /adoption/);
  await assert.rejects(f.app.adopt(hash, false), /explicit/); assert.equal(f.calls.disable, 0);
});
test('wrong plan hash cannot mutate or export credentials', async (t) => {
  const f = await fixture(t); await f.app.plan(oldId); await assert.rejects(f.app.stage('wrong'), /exact plan hash/); await assert.rejects(f.app.exportUrl('wrong'));
  assert.equal(f.calls.create, 0);
});
test('cancel planned rotation is local and makes later staging impossible', async (t) => {
  const f = await fixture(t); const p = await f.app.plan(oldId); const calls = { ...f.calls };
  assert.equal((await f.app.cancel(p.planHash)).state, 'cancelled'); assert.deepEqual(f.calls, calls);
  await assert.rejects(f.app.stage(p.planHash)); assert.equal(f.state.items.length, 1); assert.equal(f.state.items[0].enabled, true);
});
test('cancel staged rotation leaves both webhooks enabled and preserves private export', async (t) => {
  const f = await fixture(t); const hash = await staged(f); const calls = { ...f.calls };
  await f.app.cancel(hash); assert.deepEqual(f.calls, calls); assert.ok(f.state.items.every((item) => item.enabled));
  await f.app.exportUrl(hash); await assert.rejects(f.app.retire(hash));
});
test('unknown successor ambiguity requires manual reconciliation', async (t) => {
  const f = await fixture(t); const p = await f.app.plan(oldId);
  const create = f.transport.create; f.transport.create = async (settings) => { await create(settings); await create(settings); throw new Error('Lost response'); };
  await assert.rejects(f.app.stage(p.planHash)); await assert.rejects(f.app.recover(), /Ambiguous/); assert.equal(f.calls.disable, 0);
});
test('journal and URL export are private and export refuses overwrite', async (t) => {
  const f = await fixture(t); const hash = await staged(f); await f.app.exportUrl(hash);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o700); assert.equal((await stat(join(f.directory, 'journal.json'))).mode & 0o777, 0o600);
  await assert.rejects(f.app.exportUrl(hash), /already exists/); assert.ok(!(await readFile(join(f.directory, 'journal.json'), 'utf8')).includes('offline-token'));
});
test('changed credentials cannot reuse a journal', async (t) => {
  const f = await fixture(t); await f.app.plan(oldId);
  await assert.rejects(rotation(f.directory, { ...f.connection, token: 'another-token' }, f.transport).status(), /different credential/);
});
test('corrupt journal errors do not print private input snippets', async (t) => {
  const f = await fixture(t); await writeFile(join(f.directory, 'journal.json'), '{secret-CREDENTIAL}', { mode: 0o600 });
  await assert.rejects(f.app.status(), (error) => !error.message.includes('CREDENTIAL') && /suppressed/.test(error.message));
});
test('symlink journal is refused and a lock blocks another process', async (t) => {
  const f = await fixture(t); const outside = join(f.directory, 'other.json'); await writeFile(outside, '{}'); await symlink(outside, join(f.directory, 'journal.json'));
  await assert.rejects(f.app.status()); await mkdir(join(f.directory, '.lock'));
  await assert.rejects(f.app.plan(oldId), /locked/);
});
test('malformed settings, IDs and foreign credential URLs fail closed', () => {
  assert.throws(() => config({ ...sample(), cooldown_seconds: 61 })); assert.throws(() => config({ ...sample(), action_number: 0 }));
  assert.throws(() => config({ ...sample(), title: null, message: 'x'.repeat(121) }));
  assert.throws(() => webhook({ ...sample(), id: 'not-uuid' }, room, 'https://api.pingroom.io'));
  assert.throws(() => webhook({ ...sample(), webhook_url: sample().webhook_url.replace('api.pingroom.io', 'example.com') }, room, 'https://api.pingroom.io'));
});
test('connection rejects partial credentials, malformed room and blank explicit token', async () => {
  await assert.rejects(connection({ PINGROOM_ROOM: room, PINGROOM_TOKEN: '' }), /nonblank/);
  await assert.rejects(connection({ PINGROOM_TOKEN: 'token' }), /room code/);
  await assert.rejects(connection({ PINGROOM_ROOM: room, CI: 'true' }), /nonblank/);
  assert.deepEqual(await connection({ PINGROOM_ROOM: room, PINGROOM_TOKEN: 'token' }), { token: 'token', room, apiUrl: 'https://api.pingroom.io' });
});
test('real CLI copies null defaults and literal shell metacharacters without execution', async (t) => {
  const f = await fixture(t, true);
  Object.assign(f.state.items[0], { title: null, message: '$(touch /tmp/not-executed) `literal` --help', icon: null, color: null, sound: null, action_number: 2, cooldown_seconds: 0 });
  const hash = await staged(f); assert.equal((await f.app.status()).planHash, hash);
  assert.deepEqual(config({ ...f.state.items[1], name: f.state.items[0].name }), config(f.state.items[0]));
});
test('inventory lists only IDs and enabled states despite receiving every secret', async (t) => {
  const f = await fixture(t, true); const value = await f.app.inventory();
  assert.deepEqual(value, { webhooks: [{ id: oldId, enabled: true }] });
  assert.ok(!JSON.stringify(value).includes('/api/webhooks/'));
});
test('private file reader rejects invalid UTF-8 without printing credential bytes', async (t) => {
  const f = await fixture(t);
  const path = join(f.directory, 'invalid.json');
  await writeFile(path, Buffer.concat([Buffer.from('{"secret":"CREDENTIAL-'), Buffer.from([0xc3, 0x28]), Buffer.from('"}')]), { mode: 0o600 });
  await assert.rejects(readJson(path), (error) => /not valid UTF-8 JSON/.test(error.message) && !error.message.includes('CREDENTIAL'));
});
test('private file reader enforces its 64 KiB limit and accepts the boundary', async (t) => {
  const f = await fixture(t), path = join(f.directory, 'bounded.json');
  await writeFile(path, `"${'x'.repeat(65534)}"`, { mode: 0o600 });
  assert.equal((await readJson(path)).length, 65534);
  await writeFile(path, `"${'x'.repeat(65535)}"`, { mode: 0o600 });
  await assert.rejects(readJson(path), /bounded private file|exceeds 64 KiB/);
});
