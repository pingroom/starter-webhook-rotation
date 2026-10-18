// Only used by the credential-free demo and tests; never imported by the live entry point.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
export const oldId = '11111111-1111-4111-8111-111111111111';
export const roomId = '22222222-2222-4222-8222-222222222222';
export const room = 'ABCDEFGHIJKL';
export function sample(origin = 'https://api.pingroom.io') {
  return { id: oldId, room_id: roomId, name: 'Build reporter', title: 'Report ready', message: 'Open the latest report',
    emoji: '🔗', icon: 'bell', color: '#0391fe', sound: null, haptic: null, action_number: null,
    enabled: true, cooldown_seconds: 5, webhook_url: `${origin}/api/webhooks/${room}/${'A'.repeat(32)}` };
}
export async function mockServer() {
  const requests = [], control = { mode: null }, state = { items: [] };
  const server = createServer(async (request, response) => {
    try {
      const parts = []; for await (const part of request) parts.push(part);
      const body = parts.length ? JSON.parse(Buffer.concat(parts).toString()) : null;
      requests.push({ method: request.method, url: request.url, body, authorization: request.headers.authorization });
      const base = `/api/agent/rooms/${room}/webhooks`;
      const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(value)); };
      if (request.headers.authorization !== 'Bearer offline-token') return send(401, { message: 'Unauthenticated' });
      if (control.mode === 'forbidden') return send(403, { message: `Secret must not escape: ${state.items[0].webhook_url}` });
      if (request.method === 'GET' && request.url === base) return send(200, { webhooks: state.items, count: state.items.length });
      if (request.method === 'POST' && request.url === base) {
        if (control.mode === 'reject-create') return send(422, { message: 'Creation rejected' });
        const item = { ...sample(state.origin), title: null, message: null, icon: null, color: null, sound: null, haptic: null, action_number: null, ...body, id: randomUUID(), webhook_url: `${state.origin}/api/webhooks/${room}/${'B'.repeat(32)}` };
        state.items.push(item);
        if (control.mode === 'lose-create') return request.socket.destroy();
        if (control.mode === 'hang-create') return;
        if (control.mode === 'malformed-create') return send(201, { id: item.id, secret: item.webhook_url });
        return send(201, item);
      }
      if (request.method === 'PUT' && request.url === `${base}/${oldId}`) {
        const item = state.items.find((item) => item.id === oldId);
        if (control.mode === 'reject-retire') return send(403, { message: 'Denied' });
        Object.assign(item, body);
        if (control.mode === 'lose-retire') return request.socket.destroy();
        return send(200, item);
      }
      return send(404, { message: 'Unexpected route: this mock never implements triggering or deletion.' });
    } catch { response.writeHead(500); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  state.origin = `http://127.0.0.1:${server.address().port}`;
  state.items = [sample(state.origin)];
  return { state, control, requests, connection: { token: 'offline-token', room, apiUrl: state.origin },
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}
