// Headless end-to-end run: publish → two viewers join → one steers → approve → PR.
// Usage: PORT=4317 npm start  (in another shell), then: npm run smoke
const BASE = process.env.PATCHROOM_URL || 'http://localhost:4317';
const STEER = process.env.STEER || 'Also add a test that renewals send the exact amount in cents (pro plan = 2900).';

const [room] = await (await fetch(`${BASE}/api/publish`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
console.log('room', `${BASE}/r/${room.id}`);

function watch(name) {
  const ctl = new AbortController();
  (async () => {
    const res = await fetch(`${BASE}/api/rooms/${room.id}/events?name=${encodeURIComponent(name)}`, { signal: ctl.signal });
    for await (const _ of res.body) { /* keep presence alive */ }
  })().catch(() => {});
  return ctl;
}
const a = watch('Min');
const b = watch('Junho');

const res = await fetch(`${BASE}/api/rooms/${room.id}/events`);
let buf = '';
let steered = false;
const dec = new TextDecoder();
for await (const chunk of res.body) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf('\n\n')) >= 0) {
    const block = buf.slice(0, i);
    buf = buf.slice(i + 2);
    const line = block.split('\n').find((l) => l.startsWith('data:'));
    if (!line || block.startsWith('event: hello')) continue;
    const ev = JSON.parse(line.slice(5));
    if (ev.type === 'step') console.log(`[${ev.status}] ${ev.kind}: ${ev.title}${ev.meta ? ' — ' + ev.meta : ''}`);
    if (ev.type === 'presence') console.log(`presence: ${ev.people.map((p) => p.name).join(', ')}`);
    if (ev.type === 'ack') console.log(`ACK → ${ev.text}  files=${ev.files.join(',')}`);
    if (ev.type === 'tests') console.log(`tests: ${ev.pass} pass / ${ev.fail} fail (${ev.label})`);
    if (ev.type === 'error') { console.log('ERROR', ev.message); process.exit(1); }
    if (ev.type === 'step' && ev.kind === 'patch' && ev.status === 'running' && !steered) {
      steered = true;
      await fetch(`${BASE}/api/rooms/${room.id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Junho', text: STEER }) });
      console.log('Junho steered:', STEER);
    }
    if (ev.type === 'gate' && ev.waiting) {
      await fetch(`${BASE}/api/rooms/${room.id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Min' }) });
    }
    if (ev.type === 'pr') console.log('PR', ev.url);
    if (ev.type === 'done') { console.log('DONE', JSON.stringify(ev.pr)); a.abort(); b.abort(); process.exit(0); }
  }
}
