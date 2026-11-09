// Patchroom server: provider webhook in, live multiplayer rooms out (SSE + POST).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Room } from './room.mjs';
import { runAgent } from './agent.mjs';
import { llmInfo } from './llm.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const PORT = Number(process.env.PORT || 4317);
const rooms = new Map();

const loadJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

function send(res, code, body, type = 'application/json') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); }
    });
  });
}

/** A provider published a change: open one room per subscriber repo and start the agent. */
export function publishChange(changeId = 'payco-2.0.0', { start = true } = {}) {
  const change = loadJSON(`providers/${changeId.split('-')[0]}/change.json`);
  const subs = loadJSON('providers/subscribers.json').filter((s) => s.package === change.package);
  const opened = subs.map((repo) => {
    const room = new Room({ change, repo });
    rooms.set(room.id, room);
    room.emitEvent('room', { summary: room.summary() });
    if (start) setTimeout(() => runAgent(room), Number(process.env.PATCHROOM_START_DELAY_MS ?? 2500));
    return room;
  });
  return opened;
}

const STATIC = {
  '/': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === 'GET' && (STATIC[p] || p.startsWith('/r/'))) {
    const file = STATIC[p] || 'index.html';
    const type = file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html';
    return send(res, 200, fs.readFileSync(path.join(ROOT, 'public', file)), type);
  }

  if (req.method === 'GET' && p === '/api/rooms') {
    return send(res, 200, [...rooms.values()].map((r) => r.summary()).reverse());
  }
  if (req.method === 'GET' && p === '/api/health') {
    return send(res, 200, { ok: true, rooms: rooms.size, llm: llmInfo });
  }
  if (req.method === 'GET' && p === '/api/changes') {
    return send(res, 200, [loadJSON('providers/payco/change.json')]);
  }
  if (req.method === 'POST' && p === '/api/publish') {
    const body = await readBody(req);
    const opened = publishChange(body.change || 'payco-2.0.0');
    return send(res, 200, opened.map((r) => r.summary()));
  }

  const m = p.match(/^\/api\/rooms\/([a-z0-9]+)(\/[a-z]+)?$/);
  if (m) {
    const room = rooms.get(m[1]);
    if (!room) return send(res, 404, { error: 'no such room' });
    const sub = m[2] || '';

    if (req.method === 'GET' && sub === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      const name = (url.searchParams.get('name') || '').slice(0, 24);
      const color = (url.searchParams.get('color') || '#ff7a1a').slice(0, 16);
      const write = (ev) => res.write(`id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`);
      res.write(`event: hello\ndata: ${JSON.stringify(room.summary())}\n\n`);
      for (const ev of room.events) write(ev);
      room.on('event', write);
      if (name) room.heartbeat(name, color);
      const ka = setInterval(() => {
        res.write(': ka\n\n');
        if (name) room.heartbeat(name, color);
      }, 5000);
      req.on('close', () => {
        clearInterval(ka);
        room.off('event', write);
        if (name) setTimeout(() => {
          // leave only if no other live connection refreshed presence in the meantime
          const pz = room.presence.get(name);
          if (pz && Date.now() - pz.lastSeen > 6000) room.leave(name);
        }, 7000);
      });
      return;
    }
    if (req.method === 'POST' && sub === '/chat') {
      const b = await readBody(req);
      const text = String(b.text || '').trim().slice(0, 600);
      if (!text || !b.name) return send(res, 400, { error: 'name and text required' });
      room.heartbeat(String(b.name).slice(0, 24), b.color);
      room.post(String(b.name).slice(0, 24), b.color, text);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'POST' && sub === '/approve') {
      const b = await readBody(req);
      const ok = room.approve(String(b.name || 'someone').slice(0, 24));
      return send(res, ok ? 200 : 409, { ok });
    }
    if (req.method === 'POST' && sub === '/start') {
      if (room.status !== 'starting') return send(res, 409, { error: 'already started' });
      runAgent(room);
      return send(res, 200, { ok: true });
    }
    if (req.method === 'GET' && !sub) return send(res, 200, room.summary());
  }

  send(res, 404, { error: 'not found' });
});

setInterval(() => rooms.forEach((r) => r.sweep()), 5000);

server.listen(PORT, () => {
  console.log(`\n  ▲ Patchroom  →  http://localhost:${PORT}`);
  console.log(`    LLM gateway: ${llmInfo.base}  models: ${llmInfo.models.join(', ')}\n`);
});
