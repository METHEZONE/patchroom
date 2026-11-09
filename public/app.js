// Patchroom client: lobby + live room (SSE in, fetch out).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const PALETTE = ['#ff8a3d', '#ffb347', '#7bd88f', '#7cc4ff', '#c79bff', '#ff7aa8', '#f4d35e'];
const FIXED = { min: '#ff8a3d', junho: '#7cc4ff' };
const colorFor = (n) => FIXED[n.toLowerCase()] || PALETTE[Math.abs([...n].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7)) % PALETTE.length];
const md = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
const initials = (n) => n.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();

// ---- identity: ?as=Name wins (so two windows in one browser can be two people) ----
const params = new URLSearchParams(location.search);
let me = params.get('as') || sessionStorage.getItem('pr-name') || localStorage.getItem('pr-name');
if (!me) me = (prompt('Your name in the room?') || `Guest ${Math.floor(Math.random() * 90 + 10)}`).trim();
sessionStorage.setItem('pr-name', me);
if (!params.get('as')) localStorage.setItem('pr-name', me);
const myColor = colorFor(me);
$('#me').textContent = me;
$('#me').onclick = () => {
  const n = prompt('Your name?', me);
  if (n) { sessionStorage.setItem('pr-name', n); localStorage.setItem('pr-name', n); const u = new URL(location); u.searchParams.set('as', n); location = u; }
};

const toast = (t) => { const el = $('#toast'); el.textContent = t; el.classList.remove('hidden'); clearTimeout(toast.t); toast.t = setTimeout(() => el.classList.add('hidden'), 2600); };
const withAs = (href) => `${href}?as=${encodeURIComponent(me)}`;

// =============================================================================
// Lobby
// =============================================================================
async function lobby() {
  $('#lobby').classList.remove('hidden');
  $('#crumb').innerHTML = '';
  const [change] = await (await fetch('/api/changes')).json();
  $('#changeCard').innerHTML = `
    <div class="card-h"><span>Provider changelog</span><span class="pill">new</span></div>
    <div class="prov"><div class="logo">P</div><div><b>${esc(change.provider)}</b><div class="ver">${esc(change.from)} → <b>${esc(change.to)}</b> · ${esc(change.released)}</div></div></div>
    <h3>${esc(change.title)}</h3>
    <div class="sub" style="font-size:13px">${esc(change.summary)}</div>
    <div class="brk">${change.breaking.map((b) => `<div><div class="b">${esc(b.before)}</div><div class="a">${esc(b.after)}</div></div>`).join('')}</div>
    <button class="btn" id="publish">⚡ Publish ${esc(change.provider)} ${esc(change.to)}</button>
    <div class="subs">Subscribers: METHEZONE/patchroom-demo-shop</div>`;
  $('#publish').onclick = async () => {
    $('#publish').disabled = true;
    $('#publish').textContent = 'Opening rooms…';
    const rooms = await (await fetch('/api/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ change: change.id }) })).json();
    location = withAs(`/r/${rooms[0].id}`);
  };
  const refresh = async () => {
    const rooms = await (await fetch('/api/rooms')).json();
    $('#roomCount').textContent = rooms.length;
    if (rooms.length) {
      $('#roomList').innerHTML = rooms.map((r) => `
        <a class="room-item" href="${withAs(`/r/${r.id}`)}">
          <div class="r1"><span>${esc(r.repo.repo)}</span><span class="meta">${esc(r.status)}</span></div>
          <div class="r2">${esc(r.change.provider)} ${esc(r.change.to)} · ${r.people.length} watching${r.pr ? ` · PR #${r.pr.number}` : ''}</div>
        </a>`).join('');
    }
  };
  refresh();
  setInterval(refresh, 3000);
}

// =============================================================================
// Room
// =============================================================================
function roomView(id) {
  $('#roomView').classList.remove('hidden');
  const steps = new Map();
  const tl = $('#timeline');
  const stage = $('.stage');
  const msgs = $('#msgs');
  let lastStepId = null;
  let summary = null;

  let follow = true;
  stage.addEventListener('wheel', (e) => { if (e.deltaY < 0) follow = false; }, { passive: true });
  stage.addEventListener('scroll', () => { if (stage.scrollHeight - stage.scrollTop - stage.clientHeight < 40) follow = true; }, { passive: true });
  const sb = () => requestAnimationFrame(() => { if (follow) stage.scrollTo({ top: stage.scrollHeight, behavior: 'auto' }); });
  const mb = () => requestAnimationFrame(() => { msgs.scrollTop = msgs.scrollHeight; });

  function setStatus(s) {
    const el = $('#status');
    el.className = `status ${s}`;
    el.lastElementChild.textContent = { running: 'agent working', done: 'PR opened', error: 'error', starting: 'starting', waiting: 'waiting for approval' }[s] || s;
    $('#tail').classList.toggle('hidden', s !== 'running');
  }

  function renderPresence(people) {
    const all = [{ name: 'Patchroom agent', agent: true }, ...people];
    $('#presence').innerHTML = all.map((p) => p.agent
      ? `<div class="av agent" title="Patchroom agent">✦</div>`
      : `<div class="av" style="background:${p.color || colorFor(p.name)}" title="${esc(p.name)} is watching">${esc(initials(p.name))}</div>`).join('');
    const humans = people.map((p) => p.name);
    $('#watching').textContent = humans.length ? `${humans.slice(0, 3).join(', ')}${humans.length > 3 ? ` +${humans.length - 3}` : ''} watching` : '';
  }

  function stepEl(ev) {
    let s = steps.get(ev.stepId);
    if (!s) {
      const li = document.createElement('li');
      li.className = `step ${ev.kind}`;
      li.innerHTML = `<div class="step-box"><div class="step-h"><span class="kind">${esc(ev.kind)}</span><span class="step-t"></span><span class="meta"></span></div><div class="step-body"></div></div>`;
      tl.appendChild(li);
      s = { li, body: li.querySelector('.step-body'), stream: null };
      steps.set(ev.stepId, s);
    }
    return s;
  }

  function addMsg({ name, color, text, agent, tag, tagOk }) {
    const d = document.createElement('div');
    d.className = `msg${agent ? ' agent' : ''}`;
    d.innerHTML = `<div class="av ${agent ? 'agent' : ''}" style="${agent ? '' : `background:${color || colorFor(name)}`}">${agent ? '✦' : esc(initials(name))}</div>
      <div class="b"><div class="n">${esc(name)}${tag ? `<span class="tag ${tagOk ? 'ok' : ''}">${esc(tag)}</span>` : ''}</div><div>${esc(text)}</div></div>`;
    msgs.appendChild(d);
    mb();
    return d;
  }
  const sys = (t) => { const d = document.createElement('div'); d.className = 'sys'; d.textContent = t; msgs.appendChild(d); mb(); };
  const chatEls = new Map();
  const pendingAcks = [];

  function renderDiff(diff) {
    const lines = diff.replace(/\n+$/, '').split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ |new file mode)/.test(l));
    return `<div class="diff">${lines.map((l) => `<div class="${l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : l.startsWith('@@') ? 'hunk' : ''}">${esc(l) || ' '}</div>`).join('')}</div>`;
  }

  const handlers = {
    room: (ev) => { summary = ev.summary; },
    step: (ev) => {
      const s = stepEl(ev);
      s.li.className = `step ${ev.kind} ${ev.status || ''}`;
      const t = ev.status === 'done' ? ev.title.replace(/^Patching /, 'Patched ').replace(/^Creating /, 'Created ').replace(/^Running the/, 'Ran the').replace(/^Scanning/, 'Scanned').replace(/^Cloning/, 'Cloned').replace(/^Bumping/, 'Bumped').replace(/^Planning the migration/, 'Migration plan').replace(/^Folding in/, 'Folded in').replace(/^Opening a pull request/, 'Opened a pull request').replace(/^Waiting for a human to approve the PR/, 'Human approval').replace(/^Waiting for CI on the PR/, 'CI on the PR') : ev.title;
      s.li.querySelector('.step-t').textContent = t;
      if (ev.meta !== undefined) s.li.querySelector('.meta').textContent = ev.meta;
      if (ev.status === 'running') { lastStepId = ev.stepId; setStatus(ev.kind === 'gate' ? 'waiting' : 'running'); }
      sb();
    },
    log: (ev) => { const s = steps.get(ev.stepId); if (s) { s.body.insertAdjacentHTML('beforeend', `<div class="meta">${esc(ev.text)}</div>`); } },
    hit: (ev) => {
      const s = steps.get(ev.stepId);
      s?.body.insertAdjacentHTML('beforeend', `<div class="hit"><span class="loc">${esc(ev.file)}:${ev.line}</span><span class="code">${esc(ev.text)}</span></div>`);
      sb();
    },
    stream: (ev) => {
      const s = steps.get(ev.stepId);
      if (!s) return;
      if (!s.stream) {
        s.stream = document.createElement('div');
        s.stream.className = `stream ${s.li.classList.contains('plan') ? 'plan' : ''}`;
        s.stream.appendChild(document.createElement('span'));
        s.body.appendChild(s.stream);
      }
      s.raw = (s.raw || '') + ev.delta;
      if (s.li.classList.contains('plan')) s.stream.firstChild.innerHTML = md(s.raw);
      else s.stream.firstChild.textContent = s.raw;
      sb();
    },
    diff: (ev) => {
      for (const a of pendingAcks) {
        a.files.delete(ev.file);
        if (!a.files.size && !a.done) { a.done = true; const t = a.el.querySelector('.tag'); t.textContent = 'applied ✓'; t.classList.add('ok'); }
      }
      const s = steps.get(ev.stepId);
      if (!s) return;
      const open = true;
      const wrap = document.createElement('div');
      wrap.innerHTML = `<button class="diff-toggle">${open ? '▾' : '▸'} ${esc(ev.file)} <span class="p" style="color:var(--green)">+${ev.added}</span> <span style="color:#ff9a8a">−${ev.removed}</span></button>${renderDiff(ev.diff)}`;
      const d = wrap.querySelector('.diff');
      if (!open) d.classList.add('hidden');
      wrap.querySelector('button').onclick = (e) => { d.classList.toggle('hidden'); e.currentTarget.firstChild.textContent = d.classList.contains('hidden') ? '▸ ' : '▾ '; };
      s.body.appendChild(wrap);
      sb();
    },
    tests: (ev) => {
      const s = steps.get(ev.stepId);
      s?.body.insertAdjacentHTML('beforeend', `<div class="tests"><span class="p">✓ ${ev.pass} passing</span><span class="f">${ev.fail ? `✗ ${ev.fail} failing` : ''}</span><span class="lbl">${esc(ev.label)}</span></div>${ev.failures?.length ? `<div class="fails">${ev.failures.slice(0, 4).map(esc).join('<br/>')}</div>` : ''}`);
      sb();
    },
    files: (ev) => {
      $('#fileCount').textContent = ev.files.length;
      $('#fileList').innerHTML = ev.files.map((f) => `<li class="${f.status}"><span>${esc(f.path)}</span><span class="st">${{ queued: 'queued', patching: 'patching…', patched: 'patched ✓', created: 'new ✓', revisit: 'revisit ↺' }[f.status] || f.status}</span></li>`).join('');
    },
    presence: (ev) => {
      renderPresence(ev.people);
      if (ev.name !== me) sys(`${ev.name} ${ev.action === 'join' ? 'joined the room' : 'left'}`);
      if (ev.action === 'join' && ev.name !== me && !replaying) toast(`👀 ${ev.name} is watching`);
    },
    chat: (ev) => { chatEls.set(ev.id, addMsg({ ...ev, tag: 'queued' })); },
    queued: () => {},
    'steer-start': (ev) => { const el = chatEls.get(ev.msgId); if (el) { const t = el.querySelector('.tag'); t.textContent = 'agent reading…'; } },
    ack: (ev) => {
      const el = chatEls.get(ev.msgId);
      if (el) { const t = el.querySelector('.tag'); t.textContent = 'acknowledged'; pendingAcks.push({ el, files: new Set(ev.files || []) }); }
      addMsg({ name: 'Patchroom agent', agent: true, text: ev.text });
      const s = steps.get(lastStepId);
      s?.body.insertAdjacentHTML('beforeend', `<div class="ack"><div><div class="q">${esc(ev.name)}: “${esc(ev.quote)}”</div><div class="agent-say">${esc(ev.text)}</div>${ev.files?.length ? `<div class="files">${ev.files.map((f) => `<span>${esc(f)}</span>`).join('')}</div>` : ''}</div></div>`);
      sb();
    },
    agent: (ev) => { if (!/^Done\. https/.test(ev.text)) addMsg({ name: 'Patchroom agent', agent: true, text: ev.text }); },
    gate: (ev) => { $('#gate').classList.toggle('hidden', !ev.waiting); setStatus(ev.waiting ? 'waiting' : 'running'); },
    approved: (ev) => { sys(`✅ ${ev.name} approved`); },
    pr: (ev) => {
      const s = steps.get(lastStepId);
      s?.body.insertAdjacentHTML('beforeend', `<div class="pr-card"><div style="font-size:26px">⇪</div><div><a href="${esc(ev.url)}" target="_blank">Pull request #${ev.number} opened</a><div class="ci" id="ci">CI: pending…</div></div></div>`);
      const d = addMsg({ name: 'Patchroom agent', agent: true, text: `PR #${ev.number} is up → ` });
      d.querySelector('.b > div:last-child').insertAdjacentHTML('beforeend', `<a href="${esc(ev.url)}" target="_blank" style="color:var(--orange2)">${esc(ev.url.replace('https://github.com/', ''))}</a>`);
      sb();
    },
    ci: (ev) => {
      const el = document.getElementById('ci');
      if (el) el.innerHTML = ev.state === 'pass' ? '<span style="color:var(--green)">GitHub Actions: all checks passed ✓</span>' : `CI: ${esc(ev.state)}`;
      if (ev.state === 'pass') sys('✅ CI is green on the PR');
      sb();
    },
    done: () => setStatus('done'),
    error: (ev) => {
      setStatus('error');
      tl.insertAdjacentHTML('beforeend', `<li class="step failed"><div class="step-box"><div class="err">${esc(ev.message)}</div></div></li>`);
    },
    change: () => {},
  };

  let replaying = true;
  const es = new EventSource(`/api/rooms/${id}/events?name=${encodeURIComponent(me)}&color=${encodeURIComponent(myColor)}`);
  es.addEventListener('hello', (e) => {
    const s = JSON.parse(e.data);
    summary = s;
    $('#roomEyebrow').textContent = `${s.change.provider} ${s.change.from} → ${s.change.to}`;
    $('#roomTitle').textContent = s.repo.repo;
    $('#crumb').innerHTML = `/ <b>${esc(s.repo.repo)}</b> · room ${esc(s.id)}`;
    renderPresence(s.people);
    setStatus(s.status);
    setTimeout(() => { replaying = false; }, 400);
  });
  let lastSeq = 0;
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    handlers[ev.type]?.(ev);
  };

  $('#chatForm').onsubmit = async (e) => {
    e.preventDefault();
    const text = $('#chatInput').value.trim();
    if (!text) return;
    $('#chatInput').value = '';
    await fetch(`/api/rooms/${id}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: me, color: myColor, text }) });
  };
  $('#approveBtn').onclick = () => fetch(`/api/rooms/${id}/approve`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: me }) });
}

const m = location.pathname.match(/^\/r\/([a-z0-9]+)/);
if (m) roomView(m[1]);
else lobby();
