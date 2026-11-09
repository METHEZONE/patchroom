// A Room is a shared, live agent session. Everyone connected sees the same event log,
// and anyone can post a steering message that the agent drains at its next step boundary.
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';

export class Room extends EventEmitter {
  constructor({ id, change, repo }) {
    super();
    this.setMaxListeners(100);
    this.id = id || crypto.randomBytes(3).toString('hex');
    this.change = change;
    this.repo = repo;
    this.createdAt = Date.now();
    this.events = [];
    this.seq = 0;
    this.steering = []; // pending (not yet drained by the agent)
    this.instructions = []; // accepted steering, in order
    this.presence = new Map(); // name -> {name, color, lastSeen}
    this.status = 'starting';
    this.gate = null; // {resolve}
    this.pr = null;
  }

  emitEvent(type, data = {}) {
    const ev = { seq: ++this.seq, ts: Date.now(), type, ...data };
    this.events.push(ev);
    this.emit('event', ev);
    return ev;
  }

  // ---- presence -------------------------------------------------------------
  heartbeat(name, color) {
    const had = this.presence.has(name);
    this.presence.set(name, { name, color, lastSeen: Date.now() });
    if (!had) {
      this.emitEvent('presence', { action: 'join', name, color, people: this.people() });
    }
  }
  leave(name) {
    if (this.presence.delete(name)) this.emitEvent('presence', { action: 'leave', name, people: this.people() });
  }
  sweep() {
    const now = Date.now();
    for (const [name, p] of this.presence) {
      if (now - p.lastSeen > 15_000) this.leave(name);
    }
  }
  people() {
    return [...this.presence.values()].map(({ name, color }) => ({ name, color }));
  }

  // ---- steering -------------------------------------------------------------
  post(name, color, text) {
    const msg = { id: crypto.randomBytes(4).toString('hex'), name, color, text };
    const ev = this.emitEvent('chat', msg);
    // Approval words open the PR gate if it's waiting.
    if (this.gate && /^\s*(\/approve|approve|lgtm|ship it)\b/i.test(text)) {
      this.approve(name);
      return ev;
    }
    this.steering.push({ ...msg, seq: ev.seq });
    this.emitEvent('queued', { msgId: msg.id, name, pending: this.steering.length });
    return ev;
  }
  drainSteering() {
    const out = this.steering;
    this.steering = [];
    this.instructions.push(...out);
    return out;
  }

  // ---- human gate -----------------------------------------------------------
  waitForApproval(timeoutMs) {
    return new Promise((resolve) => {
      const t = timeoutMs ? setTimeout(() => this.approve('auto-approve (timeout)'), timeoutMs) : null;
      this.gate = { resolve: (who) => { if (t) clearTimeout(t); resolve(who); } };
    });
  }
  approve(name) {
    if (!this.gate) return false;
    const g = this.gate;
    this.gate = null;
    this.emitEvent('approved', { name });
    g.resolve(name);
    return true;
  }

  summary() {
    return {
      id: this.id,
      repo: this.repo,
      change: { id: this.change.id, provider: this.change.provider, title: this.change.title, from: this.change.from, to: this.change.to },
      status: this.status,
      createdAt: this.createdAt,
      people: this.people(),
      pr: this.pr,
    };
  }
}
