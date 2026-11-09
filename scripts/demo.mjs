// Records the real demo: two people (Min + Junho) in two browser windows, one live room.
// Prereq: `npm start` running. Usage: npm run demo  → recordings/*.webm + docs/*.png
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const BASE = process.env.PATCHROOM_URL || 'http://localhost:4317';
const OUT = path.resolve('recordings');
const DOCS = path.resolve('docs');
// Headed by default: headless Chrome leaves a gray band at the bottom of recordVideo frames.
const HEADLESS = process.env.HEADLESS === '1';
const STEER = process.env.STEER || 'Also add a test that a pro renewal charges exactly 2900 cents.';
const SIZE = { width: 1280, height: 800 };
fs.mkdirSync(OUT, { recursive: true });

setTimeout(() => { console.error('demo: hard timeout'); process.exit(2); }, 12 * 60_000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: HEADLESS, channel: process.env.PW_CHANNEL || 'chrome' });
const mk = async () => browser.newContext({ viewport: SIZE, recordVideo: { dir: OUT, size: SIZE }, colorScheme: 'dark' });
const t0 = Date.now();
const ctxMin = await mk();
const min = await ctxMin.newPage();

// Min opens the lobby and publishes PayCo 2.0
await min.goto(`${BASE}/?as=Min`);
await min.waitForSelector('#publish');
await sleep(2500);
await min.screenshot({ path: path.join(DOCS, 'lobby.png') });
await min.click('#publish');
await min.waitForURL(/\/r\//);
const roomUrl = min.url().split('?')[0];
console.log('room', roomUrl);

// Junho drops into the same room from his own browser
await sleep(1500);
const tJ = Date.now();
const ctxJ = await mk();
const junho = await ctxJ.newPage();
await junho.goto(`${roomUrl}?as=Junho`);

// Wait for the first patch step, then Junho steers
await junho.waitForSelector('.step.patch', { timeout: 180_000 });
await sleep(1200);
await junho.click('#chatInput');
await junho.keyboard.type(STEER, { delay: 28 });
await sleep(400);
await junho.keyboard.press('Enter');
console.log('Junho steered');

// The agent acknowledges in both windows
await min.waitForSelector('.ack', { timeout: 240_000 });
await sleep(1500);
await min.screenshot({ path: path.join(DOCS, 'steering.png') });

// Tests green → Min approves
await min.waitForSelector('#gate:not(.hidden)', { timeout: 420_000 });
await sleep(2500);
await min.screenshot({ path: path.join(DOCS, 'gate.png') });
await min.click('#approveBtn');
console.log('Min approved');

await min.waitForSelector('.pr-card a', { timeout: 120_000 });
const pr = await min.getAttribute('.pr-card a', 'href');
console.log('PR', pr);
await min.waitForFunction(() => /passed|fail/.test(document.getElementById('ci')?.textContent || ''), null, { timeout: 300_000 }).catch(() => {});
await sleep(3000);
await min.screenshot({ path: path.join(DOCS, 'pr.png') });
await junho.screenshot({ path: path.join(DOCS, 'pr-junho.png') });

// Show the actual PR on GitHub for a few seconds
await min.goto(pr, { waitUntil: 'domcontentloaded', timeout: 20_000 }).catch(() => {});
await sleep(6000);
console.log('closing');

const vMin = await min.video().path();
const vJ = await junho.video().path();
await ctxMin.close();
await ctxJ.close();
await browser.close();
fs.renameSync(vMin, path.join(OUT, 'min.webm'));
fs.renameSync(vJ, path.join(OUT, 'junho.webm'));
console.log('videos', path.join(OUT, 'min.webm'), path.join(OUT, 'junho.webm'));
console.log('PR_URL', pr);
fs.writeFileSync(path.join(OUT, 'offset.json'), JSON.stringify({ junhoStartsAfterMs: tJ - t0, pr, roomUrl }));

// Side-by-side video: Min (left) | Junho (right), Junho padded until he joined.
try {
  // Both recordings end together, so align their ends (more accurate than wall-clock start times).
  const dur = (f) => Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString().trim());
  const pad = Math.max(0, dur(path.join(OUT, 'min.webm')) - dur(path.join(OUT, 'junho.webm'))).toFixed(2);
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', path.join(OUT, 'min.webm'), '-i', path.join(OUT, 'junho.webm'), '-filter_complex',
    `[0:v]scale=960:-2,setsar=1[a];[1:v]tpad=start_duration=${pad}:start_mode=add:color=0x0d0a08,scale=960:-2,setsar=1[b];[a][b]hstack=inputs=2:shortest=0,format=yuv420p[v]`,
    '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-movflags', '+faststart', path.join(OUT, 'side-by-side.mp4')]);
  console.log('side-by-side', path.join(OUT, 'side-by-side.mp4'));
} catch (e) {
  console.log('ffmpeg compose skipped:', e.message);
}
