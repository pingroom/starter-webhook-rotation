import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicJson, exportSecret, readJson, withLock } from './storage.mjs';
import { config, identity, inventory, planHash, same, summary, uuid, validateJournal, webhook } from './values.mjs';

// Every mutation is preceded by a durable intent. Recovery only reads.
export function rotation(directory, connection, transport) {
  const list = async () => inventory(await transport.list());
  const normalized = (value) => webhook(value, connection.room, connection.apiUrl);
  const read = async () => validateJournal(await readJson(join(directory, 'journal.json')), connection);
  const save = (journal) => atomicJson(directory, journal);
  const locked = (run) => withLock(directory, run);
  const checkHash = (journal, expectedHash) => {
    if (expectedHash !== journal.planHash) throw new Error('Use the exact plan hash printed by plan or status.');
  };
  const unchanged = (items, expected) => {
    const item = items.find((candidate) => candidate.id === expected.id);
    if (!item || !same(normalized(item), expected)) throw new Error('Webhook configuration or credential drift detected; no further mutation is permitted.');
  };
  const record = async (journal, state) => { journal.state = state; await save(journal); return summary(journal); };
  const recover = async (journal) => {
    if (journal.state === 'creating') {
      const items = await list();
      unchanged(items, journal.predecessor);
      const matches = items.filter((item) => !journal.baselineIds.includes(item.id) && item.name === journal.expected.name);
      if (matches.length === 0) return { ...summary(journal), observation: 'Successor not observed. Creation remains uncertain; do not repeat POST.' };
      if (matches.length !== 1) throw new Error('Ambiguous successor inventory; preserve the journal for manual reconciliation.');
      const next = normalized(matches[0]);
      if (!same(config(next), journal.expected) || next.room_id !== journal.predecessor.room_id || next.webhook_url === journal.predecessor.webhook_url || (journal.successor && !same(next, journal.successor))) throw new Error('Successor differs from the reserved configuration; manual reconciliation is required.');
      journal.successor = next;
      return record(journal, 'staged');
    }
    if (journal.state === 'retiring') {
      const items = await list();
      unchanged(items, journal.successor);
      const old = items.find((item) => item.id === journal.predecessor.id);
      if (old && same(normalized(old), { ...journal.predecessor, enabled: false })) return record(journal, 'complete');
      unchanged(items, journal.predecessor);
      return { ...summary(journal), observation: 'Predecessor is still enabled. Retirement remains uncertain; do not repeat PUT.' };
    }
    return summary(journal);
  };
  return {
    inventory: () => locked(async () => ({ webhooks: (await list()).map(({ id, enabled }) => ({ id, enabled })) })),
    plan: (oldId) => locked(async () => {
      if (!uuid(oldId)) throw new Error('Plan requires the exact predecessor webhook UUID.');
      try { await readJson(join(directory, 'journal.json')); throw new Error('A journal already exists. Finish this rotation before archiving it locally.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      const items = await list();
      if (items.length >= 4) throw new Error('Rotation needs a spare webhook slot; the room already has four records.');
      const old = normalized(items.find((item) => item.id === oldId));
      if (!old.enabled) throw new Error('The predecessor must be enabled.');
      const expected = config({ ...old, name: `rotation-${randomUUID()}` });
      const journal = { version: 1, state: 'planned', room: connection.room, apiUrl: connection.apiUrl,
        binding: identity(connection), predecessor: old, baselineIds: items.map((item) => item.id).sort(),
        expected, successor: null, adoptedAt: null };
      journal.planHash = planHash(journal);
      await save(journal); return summary(journal);
    }),
    status: () => locked(async () => summary(await read())),
    stage: (expectedHash) => locked(async () => {
      const journal = await read(); checkHash(journal, expectedHash);
      if (journal.state !== 'planned') throw new Error('Only a planned rotation can create a successor. Use status or recover.');
      const items = await list(); unchanged(items, journal.predecessor);
      if (items.length >= 4 || items.some((item) => item.name === journal.expected.name)) throw new Error('Webhook capacity or name changed; no successor was created.');
      await record(journal, 'creating');
      const created = normalized(await transport.create(journal.expected));
      if (journal.baselineIds.includes(created.id) || created.room_id !== journal.predecessor.room_id || !same(config(created), journal.expected) || created.webhook_url === journal.predecessor.webhook_url) throw new Error('Creation response does not match the plan; use recover.');
      journal.successor = created; await save(journal);
      return recover(journal);
    }),
    adopt: (expectedHash, downstreamUpdated) => locked(async () => {
      const journal = await read(); checkHash(journal, expectedHash);
      if (journal.state !== 'staged' || downstreamUpdated !== true) throw new Error('Adoption requires a staged successor and explicit downstream-updated confirmation.');
      const items = await list(); unchanged(items, journal.predecessor); unchanged(items, journal.successor);
      journal.adoptedAt = new Date().toISOString(); return record(journal, 'adopted');
    }),
    retire: (expectedHash) => locked(async () => {
      const journal = await read(); checkHash(journal, expectedHash);
      if (journal.state !== 'adopted') throw new Error('Retirement requires explicit adoption; uncertain requests must be recovered, not retried.');
      const items = await list(); unchanged(items, journal.predecessor); unchanged(items, journal.successor);
      await record(journal, 'retiring');
      const disabled = normalized(await transport.disable(journal.predecessor.id));
      if (!same(disabled, { ...journal.predecessor, enabled: false })) throw new Error('Retirement response differs from the plan; use recover.');
      return recover(journal);
    }),
    recover: () => locked(async () => recover(await read())),
    exportUrl: (expectedHash) => locked(async () => {
      const journal = await read(); checkHash(journal, expectedHash);
      if (!journal.successor || journal.state === 'creating') throw new Error('A verified staged successor is required before export.');
      await exportSecret(directory, journal.successor.webhook_url);
      return { ...summary(journal), exported: 'Private file: .rotation/successor-url.txt' };
    }),
    cancel: (expectedHash) => locked(async () => {
      const journal = await read(); checkHash(journal, expectedHash);
      if (!['planned', 'staged', 'adopted'].includes(journal.state)) throw new Error('Only a settled planned, staged, or adopted rotation can be cancelled locally.');
      return record(journal, 'cancelled');
    }),
  };
}
