// The app entry in the Start menu and on the desktop.
// Shows a start screen at once, starts the bot if it does not operate, and opens
// the dashboard when it answers. The bot itself runs as its own process.
import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT, DATA_DIR, LOG_DIR } from './config.js';
import { loadOrCreateToken, loginUrl } from './access.js';

const TASK = 'WhatsApp Task Bot';
const port = config.dashboardPort;
const url = loginUrl(port, loadOrCreateToken());
const hidden = { detached: true, stdio: 'ignore', windowsHide: true };

const open = (target) => spawn('explorer.exe', [target], hidden).unref();

async function answers() {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/favicon.ico`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

function startBot() {
  // Prefer the Task Scheduler task: it keeps the bot running after a crash.
  // Only a task that starts this copy: a developer copy can use the same task name.
  const task = spawnSync('schtasks.exe', ['/Query', '/TN', TASK, '/XML'], { windowsHide: true, encoding: 'utf8' });
  if (task.status === 0 && task.stdout.toLowerCase().includes(join(ROOT, 'src', 'main.js').toLowerCase())) {
    spawnSync('schtasks.exe', ['/Run', '/TN', TASK], { windowsHide: true });
    return;
  }
  // A detached child gets its own console, and windowsHide keeps it hidden.
  spawn(process.execPath, [join(ROOT, 'src', 'main.js'), '--background', '--from-launcher'], { ...hidden, cwd: ROOT }).unref();
}

// A local page that waits for the dashboard. It checks the dashboard icon (an
// image needs no permission across origins) and then opens the access link.
function startScreen() {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Starting WhatsApp Task Bot</title><meta name="viewport" content="width=device-width,initial-scale=1">
<style>:root{color-scheme:light dark;--bg:#f6f7f9;--text:#14161a;--muted:#5f6573;--line:#d4d7de;--ink:#16181d}
@media (prefers-color-scheme:dark){:root{--bg:#0d0e11;--text:#e7e9ed;--muted:#a0a6b1;--line:#33373e;--ink:#e7e9ed}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:14px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif}
.box{display:grid;justify-items:center;gap:14px;text-align:center;padding:24px}h1{margin:6px 0 0;font-size:18px;font-weight:600}p{margin:0;color:var(--muted);max-width:420px}
.spin{width:22px;height:22px;border:2.5px solid var(--line);border-top-color:var(--ink);border-radius:50%;animation:s .8s linear infinite}@keyframes s{to{transform:rotate(360deg)}}
code{font:12px "Cascadia Mono",Consolas,monospace}.hide{display:none}</style></head><body><div class="box">
<svg viewBox="0 0 256 256" width="64" height="64" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#0f5c6e"/></linearGradient></defs><rect x="8" y="8" width="240" height="240" rx="56" fill="url(#g)"/><rect x="48" y="56" width="160" height="118" rx="40" fill="#fff"/><path d="M70 160 L58 206 L112 168 Z" fill="#fff"/><path d="M88 116 L116 142 L170 88" fill="none" stroke="#0f766e" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/></svg>
<h1 id="t">Starting WhatsApp Task Bot</h1><div class="spin" id="sp"></div><p id="m">This takes a few seconds. The dashboard opens by itself.</p>
<p id="f" class="hide">The bot did not start. Look at the log in <code>${esc(LOG_DIR)}</code>, or report the problem on GitHub.</p></div>
<script>const t0=Date.now();(function poll(){const i=new Image();i.onload=()=>location.replace(${JSON.stringify(url)});
i.onerror=()=>{if(Date.now()-t0>90000){document.getElementById('sp').className='hide';document.getElementById('m').className='hide';document.getElementById('f').className='';document.getElementById('t').textContent='The bot did not start';return}setTimeout(poll,600)};
i.src='http://localhost:${port}/favicon.ico?'+Date.now()})();</script></body></html>`;
  mkdirSync(DATA_DIR, { recursive: true });
  const file = join(DATA_DIR, 'starting.html');
  writeFileSync(file, html, { mode: 0o600 });
  return file;
}

if (await answers()) {
  open(url);
} else {
  open(startScreen());
  startBot();
}
