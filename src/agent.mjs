// The Patchroom agent: migrate one subscriber repo to a provider's breaking change,
// streaming every step into a shared Room and folding in steering messages between steps.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chat, extractCode } from './llm.mjs';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const GIT_ID = ['-c', 'user.name=METHEZONE', '-c', 'user.email=260937568+METHEZONE@users.noreply.github.com'];
const GIT_AUTH = ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, { cwd, env, timeout = 120_000 } = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    const t = setTimeout(() => p.kill('SIGKILL'), timeout);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
    p.on('error', (e) => {
      clearTimeout(t);
      resolve({ code: -1, out: String(e) });
    });
  });
}

function walk(dir, base = dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'vendor'].includes(ent.name)) continue;
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, base, acc);
    else if (/\.(m?[jt]sx?)$/.test(ent.name)) acc.push(path.relative(base, p));
  }
  return acc;
}

function parseTests(out) {
  const pass = Number(out.match(/(?:ℹ|#) pass (\d+)/)?.[1] ?? 0);
  const fail = Number(out.match(/(?:ℹ|#) fail (\d+)/)?.[1] ?? 0);
  const failures = [...out.matchAll(/(?:✖|^not ok \d+ -) (.+?)(?: \(|$)/gm)].map((m) => m[1].trim()).filter((v, i, a) => a.indexOf(v) === i && !/^(test\/|failing tests)/.test(v));
  return { pass, fail, failures };
}

function changelogText(change) {
  return [
    `${change.provider} SDK ${change.from} → ${change.to}: ${change.title}`,
    change.summary,
    ...change.breaking.map((b) => `- BEFORE: ${b.before}\n  AFTER:  ${b.after}\n  NOTES:  ${b.notes}`),
  ].join('\n');
}

export async function runAgent(room, { workRoot } = {}) {
  const change = room.change;
  const repo = room.repo.repo;
  let stepN = 0;
  const step = (kind, title, extra = {}) => {
    const stepId = `s${++stepN}`;
    room.emitEvent('step', { stepId, kind, title, status: 'running', ...extra });
    return {
      id: stepId,
      update: (patch) => room.emitEvent('step', { stepId, kind, title, ...patch }),
      done: (patch = {}) => room.emitEvent('step', { stepId, kind, title, status: 'done', ...patch }),
      fail: (patch = {}) => room.emitEvent('step', { stepId, kind, title, status: 'failed', ...patch }),
      log: (text) => room.emitEvent('log', { stepId, text }),
    };
  };
  const say = (text) => room.emitEvent('agent', { text });

  const files = new Map(); // path -> status
  const pushFiles = () => room.emitEvent('files', { files: [...files].map(([p, status]) => ({ path: p, status })) });
  const queue = [];
  const enqueue = (f, why) => {
    if (!queue.includes(f)) queue.push(f);
    files.set(f, why === 'revisit' || ['patched', 'created'].includes(files.get(f)) ? 'revisit' : 'queued');
    pushFiles();
  };

  // ---------------------------------------------------------------------------
  // Steering checkpoint: drain messages, ask the model to triage each one,
  // acknowledge visibly, and (re)queue the files it should touch.
  // ---------------------------------------------------------------------------
  let dir;
  async function checkpoint(where) {
    const msgs = room.drainSteering();
    if (!msgs.length) return 0;
    const st = step('steer', `Folding in ${msgs.length} steering message${msgs.length > 1 ? 's' : ''}`, { where });
    const tree = walk(dir);
    for (const m of msgs) {
      room.emitEvent('steer-start', { msgId: m.id, name: m.name });
      const prompt = [
        { role: 'system', content: 'You are Patchroom, a code-migration agent working in a shared live room with humans. A teammate just sent you a steering message mid-run. Decide how it changes your work. Reply with ONLY compact JSON: {"ack": "<one or two friendly sentences addressed to them by name, saying concretely what you will do>", "files": ["<repo-relative paths to (re)edit or create>"]}. List the MINIMUM set of files: usually 1-2. Prefer editing an existing file over creating a new one; e.g. put a new test into the existing test file that already covers that module. Never list vendor/ files. A requested new test goes into exactly ONE test file.' },
        { role: 'user', content: `Migration:\n${changelogText(change)}\n\nRepo files:\n${tree.join('\n')}\n\nFiles already patched: ${[...files].filter(([, s]) => s === 'patched' || s === 'created').map(([p]) => p).join(', ') || '(none yet)'}\n\nMessage from ${m.name}: "${m.text}"` },
      ];
      let ack = { ack: `On it, ${m.name}.`, files: [] };
      for (let attempt = 0; attempt < 3; attempt++) {
        let raw = '';
        try {
          const { text } = await chat(prompt, { maxTokens: 500 });
          raw = text;
          const j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
          if (j && typeof j.ack === 'string') {
            ack = { ack: j.ack, files: Array.isArray(j.files) ? j.files : [] };
            break;
          }
        } catch (e) {
          console.error(`[triage] attempt ${attempt + 1} failed: ${e.message} raw=${raw.slice(0, 300)}`);
        }
      }
      if (!ack.files.length) {
        // Fallback: treat it as a global instruction and revisit every patched file.
        ack.files = [...files].filter(([, s]) => s === 'patched' || s === 'created').map(([p]) => p);
      }
      ack.files = ack.files.map((f) => f.replace(/^\.?\//, '')).filter((f) => !f.includes('..') && !f.startsWith('vendor/'));
      const tests = ack.files.filter((x) => /(^|\/)test|\.test\./.test(x));
      if (tests.length > 1 && /\btests?\b/i.test(m.text)) {
        // one new test → one test file (prefer the file covering the module it mentions)
        const keep = tests.find((t) => m.text.toLowerCase().split(/\W+/).some((w) => w.length > 4 && t.includes(w.slice(0, 5)))) || tests.find((t) => fs.existsSync(path.join(dir, t))) || tests[0];
        ack.files = ack.files.filter((x) => !tests.includes(x) || x === keep);
      }
      const inst = room.instructions.find((i) => i.id === m.id);
      if (inst) inst.files = ack.files;
      room.emitEvent('ack', { msgId: m.id, name: m.name, text: ack.ack, files: ack.files, quote: m.text });
      for (const f of ack.files) enqueue(f, 'revisit');
    }
    st.done();
    return msgs.length;
  }

  try {
    room.status = 'running';
    // 1. Change received ----------------------------------------------------
    const s1 = step('change', `${change.provider} ${change.to} published — "${change.title}"`);
    room.emitEvent('change', { change });
    await sleep(900);
    s1.done({ meta: `${change.breaking.length} breaking changes` });

    // 2. Clone ---------------------------------------------------------------
    const s2 = step('clone', `Cloning ${repo}`);
    const base = workRoot || path.join(os.tmpdir(), 'patchroom');
    fs.mkdirSync(base, { recursive: true });
    dir = path.join(base, `${room.id}-${repo.replace('/', '__')}`);
    fs.rmSync(dir, { recursive: true, force: true });
    const cl = await run('git', [...GIT_AUTH, 'clone', '--depth', '20', `https://github.com/${repo}.git`, dir]);
    if (cl.code !== 0) throw new Error(`clone failed: ${cl.out}`);
    const head = (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })).out.trim();
    s2.done({ meta: `main @ ${head}` });

    // 3. Scan ----------------------------------------------------------------
    const s3 = step('scan', 'Scanning for affected call sites');
    const res = change.detect.map((d) => new RegExp(d));
    const hits = [];
    for (const f of walk(dir)) {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
      lines.forEach((line, i) => {
        const rule = res.findIndex((r) => r.test(line));
        if (rule >= 0) hits.push({ file: f, line: i + 1, text: line.trim(), rule: change.breaking[rule]?.id || change.detect[rule] });
      });
    }
    for (const h of hits) {
      room.emitEvent('hit', { stepId: s3.id, ...h });
      await sleep(120);
    }
    const hitFiles = [...new Set(hits.map((h) => h.file))].sort((a, b) => (a.startsWith('test') - b.startsWith('test')) || a.localeCompare(b));
    for (const f of hitFiles) enqueue(f);
    s3.done({ meta: `${hits.length} usages in ${hitFiles.length} files` });

    // 4. Upgrade the SDK and prove it breaks --------------------------------
    const s4 = step('upgrade', `Bumping ${change.package} ${change.from} → ${change.to}`);
    const sdkSrc = path.join(ROOT, 'providers', change.package, `sdk-${change.to}`);
    fs.cpSync(sdkSrc, path.join(dir, change.vendorPath), { recursive: true });
    const t0 = await run('npm', ['test', '--silent'], { cwd: dir });
    const r0 = parseTests(t0.out);
    if (r0.pass + r0.fail === 0) s4.log(t0.out.slice(-400));
    room.emitEvent('tests', { stepId: s4.id, ...r0, label: 'after bump, before fix' });
    s4.done({ meta: `${r0.fail} failing / ${r0.pass} passing — as expected` });

    // 5. Plan ----------------------------------------------------------------
    await checkpoint('before plan');
    const s5 = step('plan', 'Planning the migration');
    const sample = hitFiles.slice(0, 8).map((f) => `--- ${f}\n${fs.readFileSync(path.join(dir, f), 'utf8')}`).join('\n');
    await chat(
      [
        { role: 'system', content: 'You are Patchroom, an agent that migrates customer code to API breaking changes. Teammates are watching live. Write a SHORT plan: 3-5 terse bullet lines starting with "- ", no preamble, no code, under 70 words total. Mention concrete pitfalls (e.g. float→integer conversion, required fields).' },
        { role: 'user', content: `${changelogText(change)}\n\nAffected files:\n${sample}\n\nTeam instructions so far: ${room.instructions.map((i) => `${i.name}: ${i.text}`).join(' | ') || '(none)'}` },
      ],
      { maxTokens: 300, onDelta: (d) => room.emitEvent('stream', { stepId: s5.id, delta: d }) },
    );
    s5.done();

    // 6. Patch loop ----------------------------------------------------------
    const patched = new Set();
    const patchFile = async (f) => {
      const abs = path.join(dir, f);
      const exists = fs.existsSync(abs);
      const before = exists ? fs.readFileSync(abs, 'utf8') : '';
      files.set(f, 'patching');
      pushFiles();
      const sp = step('patch', `${exists ? 'Patching' : 'Creating'} ${f}`, { file: f });
      const instr = room.instructions.map((i) => `- ${i.name}: ${i.text}${i.files?.length ? ` [targets: ${i.files.join(', ')}${i.files.includes(f) ? ' ← THIS FILE' : ' — not this file, do not duplicate'}]` : ''}`).join('\n');
      const ctx = [...files.keys()].filter((p) => p !== f && fs.existsSync(path.join(dir, p))).slice(0, 10)
        .map((p) => `--- ${p}\n${fs.readFileSync(path.join(dir, p), 'utf8')}`).join('\n');
      const { text } = await chat(
        [
          { role: 'system', content: 'You are Patchroom, a careful code-migration agent. Rewrite ONE file so it works with the new SDK. Make the minimal change; keep style, comments and exports. Convert money exactly (use Math.round when turning a float into minor units; prefer existing integer cents directly). Follow the team instructions — they come from humans watching you live and override your defaults. Each instruction says which file(s) it targets: apply it ONLY when this file is a target; never add a test that already exists in another file shown in context. Output ONLY the full new file in one ```js code block, nothing else.' },
          { role: 'user', content: `Migration notes:\n${changelogText(change)}\n\nNew SDK source (${change.vendorPath}/index.js):\n${fs.readFileSync(path.join(sdkSrc, 'index.js'), 'utf8')}\n\nOther files in the repo for context:\n${ctx}\n\nTeam instructions:\n${instr || '(none)'}\n\nFILE TO ${exists ? 'REWRITE' : 'CREATE'}: ${f}\n${exists ? before : '(new file)'}` },
        ],
        { maxTokens: 3000, onDelta: (d) => room.emitEvent('stream', { stepId: sp.id, delta: d }) },
      );
      let after = extractCode(text);
      if (!after.endsWith('\n')) after += '\n';
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, after);
      const diff = (await run('git', ['--no-pager', 'diff', '--no-color', '-U2', '--', f], { cwd: dir })).out ||
        (await run('git', ['--no-pager', 'diff', '--no-color', '--no-index', '-U2', '/dev/null', f], { cwd: dir })).out;
      const added = (diff.match(/^\+(?!\+\+)/gm) || []).length;
      const removed = (diff.match(/^-(?!--)/gm) || []).length;
      room.emitEvent('diff', { stepId: sp.id, file: f, diff, added, removed });
      files.set(f, exists && files.get(f) !== 'created' ? 'patched' : 'created');
      patched.add(f);
      pushFiles();
      sp.done({ meta: `+${added} −${removed}` });
    };

    let attempts = 0;
    for (;;) {
      while (queue.length) {
        await checkpoint('between files');
        const f = queue.shift();
        if (!f) continue;
        await patchFile(f);
      }
      await checkpoint('before tests');
      if (queue.length) continue;

      // 7. Tests ---------------------------------------------------------------
      const st = step('test', 'Running the test suite');
      const t = await run('npm', ['test', '--silent'], { cwd: dir });
      const r = parseTests(t.out);
      room.emitEvent('tests', { stepId: st.id, ...r, label: 'after patch' });
      if (r.fail === 0 && t.code === 0) {
        st.done({ meta: `${r.pass} passing` });
      } else {
        st.fail({ meta: `${r.fail} failing` });
        if (++attempts > 2) throw new Error('tests still failing after 2 repair attempts');
        const sr = step('repair', 'Reading failures and repairing');
        const changed = [...patched].map((p) => `--- ${p}\n${fs.readFileSync(path.join(dir, p), 'utf8')}`).join('\n');
        const { text } = await chat(
          [
            { role: 'system', content: 'Tests failed after a migration. Pick the files to fix. Reply ONLY JSON: {"why": "<one sentence>", "files": ["path", ...]}' },
            { role: 'user', content: `${changelogText(change)}\n\nTest output:\n${t.out.slice(-3500)}\n\nChanged files:\n${changed}` },
          ],
          { maxTokens: 300 },
        );
        let j = { why: 'retrying failing files', files: [...patched] };
        try { j = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); } catch {}
        say(`Tests failed: ${j.why}`);
        room.instructions.push({ name: 'test runner', text: `Fix this failure: ${t.out.slice(-1500)}` });
        for (const f of j.files || []) enqueue(String(f).replace(/^\.?\//, ''), 'revisit');
        sr.done();
        continue;
      }

      // 8. Human gate ----------------------------------------------------------
      const sg = step('gate', 'Waiting for a human to approve the PR');
      room.emitEvent('gate', { waiting: true });
      say('All green. Anyone in the room can type /approve (or hit Approve) and I\'ll open the PR — or keep steering.');
      const autoMs = Number(process.env.PATCHROOM_AUTO_APPROVE_MS || 0);
      const who = await Promise.race([
        room.waitForApproval(autoMs || 0),
        new Promise((resolve) => {
          const h = (ev) => {
            if (ev.type === 'queued') {
              room.off('event', h);
              resolve(null);
            }
          };
          room.on('event', h);
        }),
      ]);
      room.emitEvent('gate', { waiting: false });
      if (!who) {
        room.gate = null;
        sg.done({ meta: 'new steering — back to work' });
        continue;
      }
      sg.done({ meta: `approved by ${who}` });
      break;
    }

    // 9. Commit + PR -----------------------------------------------------------
    const sp = step('pr', 'Opening a pull request');
    const branch = `patchroom/${change.package}-${change.to}-${room.id}`;
    await run('git', ['checkout', '-b', branch], { cwd: dir });
    await run('git', ['add', '-A'], { cwd: dir });
    const people = [...new Set(room.events.filter((e) => e.type === 'presence' && e.action === 'join').map((e) => e.name))];
    const steerers = room.instructions.filter((i) => i.name !== 'test runner');
    const msg = `Migrate to ${change.provider} SDK ${change.to}\n\n${change.title}. Patched by Patchroom in a live room with ${people.join(', ') || 'the team'}.`;
    const c = await run('git', [...GIT_ID, 'commit', '-q', '-m', msg], { cwd: dir });
    if (c.code !== 0) throw new Error(`commit failed: ${c.out}`);
    const pu = await run('git', [...GIT_AUTH, 'push', '-q', '-u', 'origin', branch], { cwd: dir });
    if (pu.code !== 0) throw new Error(`push failed: ${pu.out}`);
    sp.log(`pushed ${branch}`);
    const stat = (await run('git', ['--no-pager', 'diff', '--stat', 'HEAD~1'], { cwd: dir })).out.trim();
    const finalTests = room.events.filter((e) => e.type === 'tests').at(-1);
    const roomUrl = process.env.PATCHROOM_PUBLIC_URL ? `${process.env.PATCHROOM_PUBLIC_URL}/r/${room.id}` : null;
    const body = [
      `## ${change.provider} ${change.from} → ${change.to}: ${change.title}`,
      '',
      change.summary,
      '',
      '### What changed',
      ...change.breaking.map((b) => `- \`${b.before}\` → \`${b.after}\``),
      '',
      '```',
      stat,
      '```',
      '',
      `### Tests\n✅ ${finalTests?.pass ?? '?'} passing locally (were ${r0.fail} failing right after the SDK bump).`,
      '',
      '### Steered live by the team',
      steerers.length ? steerers.map((i) => `- **${i.name}**: “${i.text}”`).join('\n') : '- (no steering — agent ran solo)',
      '',
      `Watched by: ${people.join(', ') || '—'} · approved by **${room.events.filter((e) => e.type === 'approved').at(-1)?.name || '—'}**`,
      roomUrl ? `\nReplay the room: ${roomUrl}` : '',
      '',
      '---',
      '_Opened by [Patchroom](https://github.com/METHEZONE/patchroom) — multiplayer Dependabot for APIs._',
    ].join('\n');
    const pr = await run('gh', ['pr', 'create', '--repo', repo, '--head', branch, '--base', room.repo.branch || 'main',
      '--title', `${change.provider} ${change.to}: migrate Charges → Payments`, '--body', body], { cwd: dir });
    const url = pr.out.match(/https:\/\/github\.com\/\S+\/pull\/\d+/)?.[0];
    if (!url) throw new Error(`gh pr create failed: ${pr.out}`);
    room.pr = { url, number: Number(url.split('/').pop()), branch, ci: 'pending' };
    room.emitEvent('pr', room.pr);
    sp.done({ meta: `#${room.pr.number}` });

    // 10. CI -------------------------------------------------------------------
    const sc = step('ci', 'Waiting for CI on the PR');
    let ci = 'pending';
    for (let i = 0; i < 60 && ci === 'pending'; i++) {
      await sleep(5000);
      const r = await run('gh', ['pr', 'checks', url, '--json', 'name,state,bucket'], { cwd: dir });
      try {
        const checks = JSON.parse(r.out);
        if (checks.length) {
          if (checks.every((x) => x.bucket === 'pass')) ci = 'pass';
          else if (checks.some((x) => x.bucket === 'fail' || x.bucket === 'cancel')) ci = 'fail';
          sc.update({ status: 'running', meta: checks.map((x) => `${x.name}: ${x.state.toLowerCase()}`).join(', ') });
        }
      } catch {}
    }
    room.pr.ci = ci;
    room.emitEvent('ci', { state: ci, url });
    if (ci === 'pass') sc.done({ meta: 'CI green ✓' });
    else if (ci === 'fail') sc.fail({ meta: 'CI failed' });
    else sc.done({ meta: 'CI still running — see PR' });
    room.status = 'done';
    room.emitEvent('done', { pr: room.pr });
    say(`Done. ${url}`);
  } catch (e) {
    room.status = 'error';
    room.emitEvent('error', { message: String(e.message || e).slice(0, 800) });
  }
}
