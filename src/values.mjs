import { createHash } from 'node:crypto';
export const hash = (value) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const uuid = (value) => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
export function roomCode(value) {
  if (typeof value !== 'string' || !/^[A-Z0-9]{12}$/.test(value)) throw new Error('PINGROOM_ROOM must be a 12-character uppercase room code.');
  return value;
}
// Match Laravel Str::trim at the edges; preserve interior emoji joiners.
const serverTrimCharacter = /^[\p{White_Space}\u0000\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200f\u2060-\u2065\u206a-\u206f\u2800\u3164\ufeff\uffa0\u{1d159}\u{1d173}-\u{1d17a}\u{e0020}]$/u;
function text(value, limit, nullable = false) {
  if (value === null && nullable) return null;
  if (typeof value !== 'string' || !value || [...value].length > limit || /[\u0000-\u001f\u007f]/u.test(value) || serverTrimCharacter.test([...value][0]) || serverTrimCharacter.test([...value].at(-1))) throw new Error('Webhook text is unsupported or malformed.');
  return value;
}
export function config(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Malformed webhook configuration.');
  if (value.emoji !== '🔗' || value.haptic !== null) throw new Error('This CLI starter requires the default 🔗 emoji and no haptic override.');
  if (typeof value.enabled !== 'boolean' || !Number.isInteger(value.cooldown_seconds) || value.cooldown_seconds < 0 || value.cooldown_seconds > 60) throw new Error('Malformed webhook settings.');
  if (value.action_number !== null && (!Number.isInteger(value.action_number) || value.action_number < 1 || value.action_number > 16)) throw new Error('Unsupported action number.');
  return { name: text(value.name, 100), title: text(value.title, 40, true), message: text(value.message, 120, true),
    emoji: '🔗', icon: text(value.icon, 100, true), color: text(value.color, 20, true),
    sound: text(value.sound, 100, true), haptic: null, action_number: value.action_number,
    enabled: value.enabled, cooldown_seconds: value.cooldown_seconds };
}
export function webhook(value, room, apiUrl) {
  if (!uuid(value?.id) || !uuid(value?.room_id)) throw new Error('Malformed webhook identity.');
  let url;
  try { url = new URL(value.webhook_url); } catch { throw new Error('Malformed secret URL.'); }
  if (url.origin !== apiUrl || url.username || url.password || url.search || url.hash || !new RegExp(`^/api/webhooks/${room}/[A-Za-z0-9]{32}$`).test(url.pathname)) throw new Error('Unexpected secret URL origin or path.');
  return { id: value.id, room_id: value.room_id, ...config(value), webhook_url: url.href };
}
export function inventory(value) {
  if (!value || !Array.isArray(value.webhooks) || value.webhooks.length > 4 || value.count !== value.webhooks.length) throw new Error('Malformed webhook inventory.');
  const ids = new Set();
  for (const item of value.webhooks) {
    if (!uuid(item?.id) || ids.has(item.id) || typeof item.name !== 'string' || typeof item.enabled !== 'boolean') throw new Error('Malformed webhook inventory identity.');
    ids.add(item.id);
  }
  return value.webhooks;
}
export const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
export const identity = (connection) => hash({ apiUrl: connection.apiUrl, room: connection.room, tokenHash: hash(connection.token) });
export const planHash = (plan) => hash({ room: plan.room, apiUrl: plan.apiUrl, binding: plan.binding, predecessor: plan.predecessor, baselineIds: plan.baselineIds, expected: plan.expected });
export function validateJournal(value, connection) {
  if (!value || value.version !== 1 || !['planned','creating','staged','adopted','retiring','complete','cancelled'].includes(value.state)) throw new Error('Invalid rotation journal; preserve it for inspection.');
  if (value.room !== connection.room || value.apiUrl !== connection.apiUrl || value.binding !== identity(connection)) throw new Error('Journal belongs to a different credential or room.');
  const old = webhook(value.predecessor, connection.room, connection.apiUrl);
  if (!old.enabled || !same(old, value.predecessor) || !Array.isArray(value.baselineIds) || value.baselineIds.length < 1 || value.baselineIds.length > 3 || !value.baselineIds.every(uuid) || new Set(value.baselineIds).size !== value.baselineIds.length || !value.baselineIds.includes(old.id)) throw new Error('Invalid baseline in journal.');
  if (!same(config(value.expected), value.expected) || !/^rotation-[0-9a-f-]{36}$/.test(value.expected.name) || !same(config({ ...old, name: value.expected.name }), value.expected)) throw new Error('Invalid successor settings in journal.');
  if (value.planHash !== planHash(value)) throw new Error('Journal plan hash mismatch.');
  if (value.successor !== null) {
    const next = webhook(value.successor, connection.room, connection.apiUrl);
    if (!same(next, value.successor) || next.room_id !== old.room_id || value.baselineIds.includes(next.id) || next.webhook_url === old.webhook_url || !same(config(next), value.expected)) throw new Error('Invalid successor in journal.');
  }
  if (['staged','adopted','retiring','complete'].includes(value.state) && !value.successor) throw new Error('Missing successor in journal.');
  if (['adopted','retiring','complete'].includes(value.state) && (!value.adoptedAt || !Number.isFinite(Date.parse(value.adoptedAt)))) throw new Error('Missing adoption receipt.');
  return value;
}
export function summary(journal) {
  return { state: journal.state, planHash: journal.planHash, predecessorId: journal.predecessor.id,
    successorId: journal.successor?.id ?? null, adoptionConfirmed: Boolean(journal.adoptedAt) };
}
