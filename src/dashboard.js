// Local dashboard on 127.0.0.1. Built-in http only, no framework.
// Every page and endpoint needs the access token (a cookie set by /login?t=...).
// Pages are read-only. Tasks can be edited, completed, and deleted through two
// POST endpoints that accept only same-origin JSON requests from the dashboard.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { snapshot } from './status.js';
import { localDay } from './store.js';
import { TAGS } from './extractor.js';
import { ROOT, HOME, VERSION, REPO_URL, AUTHOR } from './config.js';
import { release } from 'node:os';
import { CATCH_UP_DAYS } from './scheduler.js';
import { SETUP_JS } from './setup.js';
import { sameToken, cookieToken, sessionCookie } from './access.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MB = 1048576;

const BASE_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};
// Pages may run only /app.js and frame only our own report view.
const CSP_PAGE = "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; frame-ancestors 'none'";
// A saved report may run nothing, and only our own page may frame it.
const CSP_REPORT = "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'self'";

// Same design as assets/icon.ico.
const LOGO = `<svg viewBox="0 0 256 256" width="22" height="22" aria-hidden="true"><defs><linearGradient id="lg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#14b8a6"/><stop offset="1" stop-color="#0f5c6e"/></linearGradient></defs><rect x="8" y="8" width="240" height="240" rx="56" fill="url(#lg)"/><rect x="48" y="56" width="160" height="118" rx="40" fill="#fff"/><path d="M70 160 L58 206 L112 168 Z" fill="#fff"/><path d="M88 116 L116 142 L170 88" fill="none" stroke="#0f766e" stroke-width="20" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// 16 px line icons for the sidebar.
const ICON = (d) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICONS = {
  Status: ICON('<path d="M3 12h4l3-7 4 14 3-7h4"/>'),
  Tasks: ICON('<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="m8 12 3 3 5-6"/>'),
  Reports: ICON('<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 12h6M9 16h6"/>'),
  Logs: ICON('<path d="M4 6h16M4 12h16M4 18h10"/>'),
  Settings: ICON('<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>'),
  Setup: ICON('<path d="M12 3v8"/><path d="M6.3 7.3a8 8 0 1 0 11.4 0"/>'),
};
const NAV = [['Overview', [['/', 'Status']]], ['Work', [['/tasks', 'Tasks'], ['/reports', 'Reports']]], ['System', [['/logs', 'Logs'], ['/settings', 'Settings'], ['/setup', 'Setup']]]];

const CSS = `
:root{color-scheme:light;--bg:#f6f7f9;--panel:#fff;--sunken:#f1f2f5;--text:#14161a;--muted:#5f6573;--faint:#8b91a0;--line:#e4e6eb;--line2:#d4d7de;
--ink:#16181d;--on-ink:#fff;--focus:#3b6fe0;--ok:#1a7f4b;--ok-bg:#e7f4ec;--warn:#985a00;--warn-bg:#fbf1dd;--soon:#c2410c;--soon-bg:#fdeee4;--bad:#b42318;--bad-bg:#fcebe9;--hover:#f7f8fa}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#0d0e11;--panel:#141619;--sunken:#1b1d22;--text:#e7e9ed;--muted:#a0a6b1;--faint:#6f7684;--line:#24272d;--line2:#33373e;
--ink:#e7e9ed;--on-ink:#0d0e11;--focus:#7aa2ff;--ok:#4cc38a;--ok-bg:#12291d;--warn:#e2aa4f;--warn-bg:#2c2312;--soon:#fb923c;--soon-bg:#2d1a0f;--bad:#f27a6b;--bad-bg:#321818;--hover:#181a1e}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:13.5px/1.5 "Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,Roboto,"Helvetica Neue",Arial,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--text);text-decoration:underline;text-decoration-color:var(--line2);text-underline-offset:3px}a:hover{text-decoration-color:currentColor}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.app{display:grid;grid-template-columns:228px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;height:100vh;display:flex;flex-direction:column;background:var(--panel);border-right:1px solid var(--line);padding:16px 10px 12px}
.brand{display:flex;align-items:center;gap:10px;padding:2px 8px 10px;font-weight:600;font-size:14px;color:var(--text);text-decoration:none}
.nav-sect{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);padding:16px 8px 6px}
.nav a{display:flex;align-items:center;gap:10px;padding:6px 8px;border-radius:6px;color:var(--muted);font-weight:500;text-decoration:none}
.nav a:hover{background:var(--sunken);color:var(--text)}.nav a.on{background:var(--sunken);color:var(--text);font-weight:600}
.side-foot{margin-top:auto;padding:12px 8px 0;border-top:1px solid var(--line);font-size:12.5px;display:grid;gap:8px}
.about-link{color:var(--faint);text-decoration:none;font-size:12px}.about-link:hover,.about-link.on{color:var(--text)}
.about-hero{display:flex;align-items:center;gap:20px;padding:24px}.about-hero h2{margin:0;font-size:22px;font-weight:600}
.about-hero .by{color:var(--muted);margin:4px 0 0}.about-acts{display:flex;flex-wrap:wrap;gap:8px;padding:0 24px 24px}
.sysinfo{margin:0;padding:14px 16px;font:12px/1.7 "Cascadia Mono",Consolas,monospace;white-space:pre-wrap}
.state{display:inline-flex;align-items:center;gap:8px;color:var(--text)}.state::before{content:"";width:7px;height:7px;border-radius:50%;background:var(--faint)}
.state.ok::before{background:var(--ok)}.state.bad::before{background:var(--bad)}
.content{min-width:0;padding:28px 36px 64px;max-width:1200px;width:100%}
.head{display:flex;align-items:flex-end;justify-content:space-between;gap:16px;flex-wrap:wrap;margin-bottom:20px}
.crumb{font-size:12.5px;color:var(--muted);margin-bottom:4px}.crumb a{color:var(--muted)}
h1{font-size:20px;font-weight:600;letter-spacing:-.01em;margin:0}.sub{color:var(--muted);margin:3px 0 0}.meta{color:var(--faint);font-size:12.5px}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.panel-h{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;border-bottom:1px solid var(--line);font-weight:600}
.panel-b{padding:16px}
.cols{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin-bottom:16px}
.summary{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin-bottom:16px}
.metric{padding:14px 16px;border-right:1px solid var(--line)}.metric:last-child{border-right:0}
.metric .l{font-size:12px;color:var(--muted)}.metric .n{font-size:19px;font-weight:600;margin-top:3px;font-variant-numeric:tabular-nums}.metric .s{font-size:12px;color:var(--faint)}
.kv{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;padding:10px 16px;border-bottom:1px solid var(--line)}.kv:last-child{border-bottom:0}
.kv .k{display:flex;align-items:center;gap:10px;color:var(--muted)}.kv .v{text-align:right;font-variant-numeric:tabular-nums}.kv .v small{display:block;color:var(--faint);font-size:12px}
.d{width:7px;height:7px;border-radius:50%;flex:none;background:var(--line2)}.d.ok{background:var(--ok)}.d.bad{background:var(--bad)}
.badge{display:inline-flex;align-items:center;height:20px;padding:0 7px;border-radius:4px;font-size:12px;font-weight:500;white-space:nowrap;background:var(--sunken);color:var(--muted)}
.badge.ok{background:var(--ok-bg);color:var(--ok)}.badge.warn{background:var(--warn-bg);color:var(--warn)}.badge.bad{background:var(--bad-bg);color:var(--bad)}.badge.ink{background:var(--ink);color:var(--on-ink)}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:30px;padding:0 12px;border-radius:6px;border:1px solid var(--line2);background:var(--panel);color:var(--text);font:inherit;font-weight:500;cursor:pointer;text-decoration:none;white-space:nowrap}
.btn:hover{background:var(--sunken)}.btn.primary{background:var(--ink);border-color:var(--ink);color:var(--on-ink)}.btn.primary:hover{opacity:.88}
.btn.danger{color:var(--bad)}.btn.danger.solid{background:var(--bad);border-color:var(--bad);color:#fff}
.btn.sm{height:26px;padding:0 9px;font-size:12.5px}.btn.ghost{border-color:transparent;background:transparent;color:var(--muted)}.btn.ghost:hover{background:var(--sunken);color:var(--text)}
.btn.ghost.danger:hover{color:var(--bad)}.btn.off,.btn[disabled]{opacity:.45;pointer-events:none}
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px}.toolbar .grow{flex:1}
.seg{display:inline-flex;border:1px solid var(--line2);border-radius:6px;overflow:hidden;background:var(--panel)}
.seg a{padding:5px 12px;color:var(--muted);text-decoration:none;border-right:1px solid var(--line2)}.seg a:last-child{border-right:0}
.seg a:hover{color:var(--text)}.seg a.on{background:var(--sunken);color:var(--text);font-weight:600}
.filters{display:flex;gap:8px;align-items:center}
input,select,textarea{font:inherit;color:var(--text);background:var(--panel);border:1px solid var(--line2);border-radius:6px}
input,select{height:32px;padding:0 10px}select.in{height:30px}textarea{padding:7px 10px;resize:vertical}
input[type=checkbox]{width:15px;height:15px;padding:0;accent-color:var(--ink);cursor:pointer;vertical-align:middle}
input[type=file]{height:auto;padding:0;border:0;background:none;color:var(--muted)}
input[type=file]::file-selector-button{height:28px;margin-right:10px;padding:0 12px;border:1px solid var(--line2);border-radius:6px;background:var(--panel);color:var(--text);font:inherit;font-weight:500;cursor:pointer}
input[type=file]::file-selector-button:hover{background:var(--sunken)}
table{width:100%;border-collapse:collapse}th{font-size:12px;font-weight:500;color:var(--muted);text-align:left;padding:9px 12px;border-bottom:1px solid var(--line);white-space:nowrap}
td{padding:9px 12px;border-bottom:1px solid var(--line);vertical-align:middle;font-variant-numeric:tabular-nums}tr:last-child td{border-bottom:0}
tbody tr:hover,table tr.task:hover,table tr.mine:hover,table tr.done:hover{background:var(--hover)}
td.c,th.c{width:36px;padding-right:0}
.badge.soon{background:var(--soon-bg);color:var(--soon)}
tr.dl-over td.c{box-shadow:inset 3px 0 var(--bad)}tr.dl-soon td.c{box-shadow:inset 3px 0 var(--soon)}tr.dl-near td.c{box-shadow:inset 3px 0 var(--warn)}
.tline{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:4px;font-weight:400}
.tag{display:inline-flex;align-items:center;height:18px;padding:0 6px;border:1px solid var(--line2);border-radius:9px;font-size:11.5px;color:var(--muted);text-decoration:none;text-transform:capitalize}a.tag:hover{color:var(--text);border-color:var(--muted)}
.why{font-size:12px;color:var(--warn)}
.filters .search{width:200px}.toolbar{flex-wrap:wrap}.filters{flex-wrap:wrap}td.t{min-width:220px}tr.mine td.t{font-weight:600}tr.done td.t{color:var(--faint);text-decoration:line-through}
td.dim,.dim{color:var(--faint)}.acts{display:flex;gap:2px;justify-content:flex-end}th.r,td.r{text-align:right}
.table-scroll{overflow-x:auto}
.pager{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;border-top:1px solid var(--line);color:var(--muted)}
.empty{padding:48px 16px;text-align:center;color:var(--muted)}
.bulk{position:sticky;bottom:16px;display:flex;align-items:center;gap:8px;margin-top:12px;padding:8px 8px 8px 16px;background:var(--ink);color:var(--on-ink);border-radius:8px;box-shadow:0 10px 30px rgba(0,0,0,.2)}
.bulk[hidden]{display:none}.bulk .grow{flex:1}.bulk .btn{background:transparent;color:var(--on-ink);border-color:rgba(127,127,127,.5)}.bulk .btn:hover{background:rgba(127,127,127,.18)}.bulk .btn.danger{color:#ff9d90}
dialog{padding:0;border:1px solid var(--line);border-radius:10px;background:var(--panel);color:var(--text);width:min(480px,calc(100vw - 32px));box-shadow:0 24px 64px rgba(0,0,0,.28)}
dialog::backdrop{background:rgba(9,11,15,.5)}.dlg-b{padding:18px 20px 6px}.dlg-b h3{margin:0 0 14px;font-size:15px;font-weight:600}
.dlg-f{display:flex;justify-content:flex-end;gap:8px;padding:12px 20px;border-top:1px solid var(--line);background:var(--sunken)}
.field{display:grid;gap:5px;margin-bottom:14px}.field label{font-size:12.5px;font-weight:500}.hint{font-size:12px;color:var(--faint)}
.row2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.check{display:flex;align-items:center;gap:8px;margin:0 0 14px}
.toast{position:fixed;right:20px;bottom:20px;z-index:30;display:flex;align-items:center;gap:9px;max-width:420px;padding:10px 14px;border-radius:8px;background:var(--ink);color:var(--on-ink);font-weight:500;box-shadow:0 10px 30px rgba(0,0,0,.22)}
.toast::before{content:"";width:7px;height:7px;border-radius:50%;flex:none;background:#4cc38a}.toast.bad::before{background:#ff8a7a}.toast[hidden]{display:none}
.callout{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:11px 16px;margin-bottom:16px;border:1px solid var(--line);border-radius:8px;background:var(--panel)}
.callout.warn{background:var(--warn-bg);border-color:transparent;color:var(--warn)}.callout.ok{background:var(--ok-bg);border-color:transparent;color:var(--ok)}.callout[hidden]{display:none}
.log{margin:0;padding:14px 16px;max-height:70vh;overflow:auto;font:12px/1.65 "Cascadia Mono",Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.log .t{color:var(--faint)}.log .WARN{color:var(--warn)}.log .ERROR{color:var(--bad)}
iframe.report{display:block;width:100%;height:76vh;border:0;background:#fff}
code{font:12.5px "Cascadia Mono",Consolas,monospace;background:var(--sunken);padding:2px 6px;border-radius:4px;overflow-wrap:anywhere}
.steps{display:grid;gap:10px}
details.step{background:var(--panel);border:1px solid var(--line);border-radius:8px}
details.step>summary{list-style:none;display:flex;align-items:center;gap:12px;padding:13px 16px;cursor:pointer}details.step>summary::-webkit-details-marker{display:none}
.sn{display:grid;place-items:center;width:24px;height:24px;flex:none;border-radius:50%;border:1.5px solid var(--line2);font-size:12px;font-weight:600;color:var(--muted)}
details.step.done .sn{background:var(--ink);border-color:var(--ink);color:var(--on-ink)}
.st-title{font-weight:600}.st-sum{color:var(--muted);font-size:12.5px;margin-left:4px}.st-right{margin-left:auto}
.step-b{padding:4px 16px 18px 52px;border-top:1px solid var(--line)}.step-b>p:first-child{margin-top:14px}
.step-b p,.step-b ol{margin:10px 0}.howto{padding-left:18px}.howto li{margin:6px 0}
.code{display:inline-block;margin:6px 0 4px;padding:10px 18px;border:1px dashed var(--line2);border-radius:8px;font:600 30px/1.2 "Cascadia Mono",Consolas,monospace;letter-spacing:.14em}
.bar{height:6px;background:var(--sunken);border-radius:3px;overflow:hidden;max-width:420px}.bar span{display:block;height:100%;background:var(--ink)}
.copy{display:inline-flex;align-items:center;gap:6px;flex-wrap:wrap}.bad-text{color:var(--bad)}
form.inline{display:flex;align-items:flex-end;gap:10px;flex-wrap:wrap}form.inline .field{flex:1;min-width:240px;margin:0}
.form-sec{display:grid;grid-template-columns:240px minmax(0,1fr);gap:28px;padding:22px 0;border-top:1px solid var(--line)}.form-sec:first-of-type{border-top:0;padding-top:4px}
.form-sec h2{font-size:13.5px;font-weight:600;margin:0}.form-sec .desc{color:var(--muted);font-size:12.5px;margin:4px 0 0}
.form-actions{display:flex;justify-content:flex-end;gap:8px;padding-top:16px;border-top:1px solid var(--line)}
.failure{display:grid;justify-items:center;gap:6px;text-align:center;padding:56px 24px}
.failure .fi{display:grid;place-items:center;width:44px;height:44px;border-radius:50%;margin-bottom:8px;background:var(--sunken);color:var(--muted)}
.failure.bad .fi{background:var(--bad-bg);color:var(--bad)}.failure.warn .fi{background:var(--warn-bg);color:var(--warn)}
.failure h2{margin:0;font-size:16px;font-weight:600}.failure p{margin:0;max-width:460px;color:var(--muted)}.failure .acts{justify-content:center;margin-top:14px;gap:8px}
.failure code{font-size:12px}
.loadbar{position:fixed;top:0;left:0;right:0;height:2px;z-index:50;overflow:hidden;pointer-events:none;opacity:0;transition:opacity .2s}
.is-loading .loadbar{opacity:1}.loadbar::before{content:"";position:absolute;top:0;bottom:0;width:40%;background:var(--ink);animation:lb 1.1s ease-in-out infinite}
@keyframes lb{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}
.skel-panel{padding:18px 20px;display:grid;gap:12px;margin-bottom:10px}
.skel{height:12px;border-radius:4px;background:linear-gradient(90deg,var(--sunken) 25%,var(--line) 37%,var(--sunken) 63%);background-size:400% 100%;animation:sk 1.4s ease infinite}
.w40{width:40%}.w55{width:55%}.w70{width:70%}@keyframes sk{0%{background-position:100% 50%}100%{background-position:0 50%}}
.spin{display:inline-block;flex:none;width:14px;height:14px;margin-right:9px;border:2px solid var(--line2);border-top-color:var(--ink);border-radius:50%;animation:sp .8s linear infinite}
@keyframes sp{to{transform:rotate(360deg)}}.busy-line{display:flex;align-items:center}
.j-top{display:flex;align-items:center;justify-content:space-between;max-width:780px;margin:0 auto;padding:20px 16px}
.j-main{max-width:780px;margin:0 auto;padding:6px 16px 64px}.j-card{padding:28px 32px}
.j-hero{display:grid;justify-items:center;gap:6px;text-align:center;padding:44px 32px}
.j-hero h2{margin:12px 0 0;font-size:24px;font-weight:600;letter-spacing:-.01em}.j-hero>.sub{max-width:540px}
.j-need{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;width:100%;margin:22px 0 4px}
.j-need div{display:grid;gap:2px;padding:12px;border:1px solid var(--line);border-radius:8px}.j-need span{color:var(--muted);font-size:12.5px}
.j-actions{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;margin-top:18px}.btn.lg{height:38px;padding:0 18px;font-size:14px}
.j-progress{display:flex;align-items:center;gap:14px;margin-bottom:14px;color:var(--muted);font-size:12.5px}.j-progress .bar{flex:1;max-width:none}
.j-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.j-head h2{margin:0;font-size:19px;font-weight:600}
.j-body{margin-top:14px}.j-ok{margin:14px 0 0}.j-nav{display:flex;align-items:center;gap:8px;margin-top:14px}.j-nav .grow{flex:1}
.j-summary{display:grid;gap:6px;width:100%;max-width:440px;margin:18px 0 0;padding:0;list-style:none;text-align:left}
.j-summary li{display:flex;align-items:center;gap:10px;padding:8px 12px;border:1px solid var(--line);border-radius:8px}
.sn.on{background:var(--ink);border-color:var(--ink);color:var(--on-ink)}
@media (max-width:640px){.j-need{grid-template-columns:1fr}.j-card{padding:22px 18px}}
@media (prefers-reduced-motion:reduce){*,*::before{animation-duration:0s!important;transition:none!important}}
.gate{max-width:520px;margin:14vh auto 0}.gate .panel-b{padding:24px 28px}.gate .brand{padding:0 0 14px}
@media (max-width:900px){.app{grid-template-columns:1fr}.side{position:static;height:auto;flex-direction:row;flex-wrap:wrap;align-items:center;gap:6px;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line)}
.brand{padding:0 8px 0 0}.nav{display:flex;flex-wrap:wrap;gap:2px}.nav-sect{display:none}.side-foot{margin:0 0 0 auto;padding:0;border:0}
.content{padding:20px 16px 48px}.summary{grid-template-columns:repeat(2,minmax(0,1fr))}.metric:nth-child(2){border-right:0}.metric:nth-child(-n+2){border-bottom:1px solid var(--line)}
.cols{grid-template-columns:1fr}.form-sec{grid-template-columns:1fr;gap:12px}.row2{grid-template-columns:1fr}.step-b{padding-left:16px}}
`;

// Status page from /api/status, every 30 s while the tab is visible. Tasks page actions.
const APP_JS = `const $=(id)=>document.getElementById(id);
const esc=(s)=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const time=(t)=>t?new Date(t).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}):'—';
const when=(t)=>{if(!t)return'—';const d=new Date(t),n=new Date();return d.toDateString()===n.toDateString()?'Today, '+time(t):d.toLocaleDateString([], {day:'numeric',month:'short'})+', '+time(t)};
const ago=(t)=>{if(!t)return'';const s=Math.round((Date.now()-t)/1000),f=s<0,a=Math.abs(s);const v=a<90?a+' s':a<5400?Math.round(a/60)+' min':a<172800?Math.round(a/3600)+' h':Math.round(a/86400)+' days';return f?'in '+v:v+' ago'};
const kv=(label,st,value,more)=>'<div class="kv"><span class="k"><i class="d '+(st===true?'ok':st===false?'bad':st)+'"></i>'+label+'</span><span class="v">'+value+(more?'<small>'+more+'</small>':'')+'</span></div>';
const FAIL_ICON='<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';
const failure=(title,text,action)=>'<div class="failure bad"><div class="fi">'+FAIL_ICON+'</div><h2>'+title+'</h2><p>'+text+'</p>'+(action?'<div class="acts">'+action+'</div>':'')+'</div>';
let lostSince=0;
const panel=(title,rows)=>'<section class="panel"><div class="panel-h">'+title+'</div>'+rows.join('')+'</section>';
const metric=(l,n,s)=>'<div class="metric"><div class="l">'+l+'</div><div class="n">'+n+'</div><div class="s">'+(s||'&nbsp;')+'</div></div>';
function overall(c,up,setupNeeded){const p=$('overall');if(!p)return;const bad=Object.values(c).filter(x=>x==='bad').length;
 if(bad){p.className='state bad';p.textContent=bad+(bad===1?' item needs':' items need')+' attention';return}
 if(setupNeeded){p.className='state';p.textContent='Setup not finished';return}
 p.className='state '+(up<180?'':'ok');p.textContent=up<180?'Starting':'All systems normal'}
let pending=0;const busy=(d)=>{pending=Math.max(0,pending+d);document.documentElement.classList.toggle('is-loading',pending>0)};
async function load(){
 const el=$('status');
 busy(1);setTimeout(()=>busy(-1),400);
 try{const r=await fetch('/api/status');if(r.status===401){location.reload();return}if(!r.ok)throw new Error('HTTP '+r.status);const s=await r.json();lostSince=0;const c=s.checks;overall(c,s.uptimeSec,s.setupNeeded);if(!el)return;
 const sb=$('setup-banner');if(sb)sb.hidden=!s.setupNeeded;
 const cn=$('connecting');if(cn)cn.hidden=!['connecting','reconnecting'].includes(s.whatsapp.state);el.setAttribute('aria-busy','false');
 const wa={open:'Connected',connecting:'Connecting',reconnecting:'Reconnecting','logged out':'Logged out','not linked':'Not linked','link failed':'Not linked',closed:'Stopped'}[s.whatsapp.state]||esc(s.whatsapp.state);
 const ollama=s.ollama.reachable===null?'Checking':s.ollama.reachable?'Reachable':(c.ollama==='idle'?'Starting':'Not reachable');
 el.innerHTML='<section class="panel summary">'+metric('WhatsApp',wa,'since '+when(s.whatsapp.since))+metric('Tasks found for you',(s.batch.mineFound||0),(s.batch.tasksFound||0)+' in total')+metric('Next check',s.batch.running?'Now':time(s.batch.nextAt),s.batch.running?'running':ago(s.batch.nextAt))+metric('Next report',time(s.email.nextAt),ago(s.email.nextAt))+'</section>'
 +'<div class="cols">'
 +panel('WhatsApp',[kv('Connection',c.whatsapp,wa,'since '+when(s.whatsapp.since)),kv('Last message',c.lastMessage,when(s.whatsapp.lastMessageAt),ago(s.whatsapp.lastMessageAt)),kv('Messages since start',s.ingest.stored?'ok':'idle',s.ingest.stored+' stored',s.ingest.stored?s.ingest.seen+' seen, '+s.ingest.dropped+' noise':'your chats can be quiet')])
 +panel('Processing',[kv('Last batch',c.lastBatch,s.batch.result?esc(s.batch.result.replace(/^ok: /,'')):'Not yet',s.batch.lastAt?when(s.batch.lastAt)+', '+((s.batch.durationMs||0)/1000).toFixed(1)+' s':''),kv('Last complete run',c.lastRun,when(s.batch.lastRun),ago(s.batch.lastRun)),kv('Next batch',c.nextBatch,s.batch.running?'Running now':when(s.batch.nextAt),s.batch.running?'':ago(s.batch.nextAt)),kv('Language model',c.ollama,ollama,s.ollama.checkedAt?'checked '+ago(s.ollama.checkedAt):'')])
 +panel('Delivery',[kv('Tasks found',s.batch.tasksFound?'ok':'idle',(s.batch.tasksFound||0)+' tasks, '+(s.batch.mineFound||0)+' for you',s.batch.lastTaskAt?'last '+ago(s.batch.lastTaskAt):'none yet'),kv('Calendar',c.calendar,s.calendar.lastWriteAt?when(s.calendar.lastWriteAt):'No writes yet',s.calendar.ok===false?'last write failed':s.calendar.lastWriteAt?ago(s.calendar.lastWriteAt):'waits for a task with a date'),kv('Last email',c.email,s.email.lastSentDate?esc(s.email.lastSentDate):'None yet',s.email.ok===false?'last try failed; retry in 10 min':s.email.lastSentDate?'':'first report at the report time'),kv('Next report',c.nextEmail,when(s.email.nextAt),ago(s.email.nextAt)),kv('Needs review','idle',s.reviewCount?'<a href="/tasks?s=review">'+s.reviewCount+(s.reviewCount===1?' task':' tasks')+'</a>':'None',s.reviewCount?'in the calendar with "?"':'')])
 +panel('System',[kv('Memory',c.ram,(s.rssBytes/1048576).toFixed(0)+' MB','target: less than 150 MB'),kv('Database',c.db,(s.dbBytes/1048576).toFixed(1)+' MB'),kv('Uptime','ok',s.uptimeSec<3600?Math.round(s.uptimeSec/60)+' min':(s.uptimeSec/3600).toFixed(1)+' h')])
 +'</div><section class="panel"><div class="panel-h">Recent errors<span class="meta">last 20</span></div>'
 +(s.errors.length?'<div class="table-scroll"><table><tr><th>Time</th><th>Source</th><th>Message</th></tr>'+s.errors.map(e=>'<tr class="task"><td class="dim">'+when(e.at)+'</td><td><span class="badge">'+esc(e.source)+'</span></td><td>'+esc(e.message)+'</td></tr>').join('')+'</table></div>':'<div class="empty">No errors.</div>')+'</section>';
 $('updated').textContent='Updated '+new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'});
 }catch(e){const p=$('overall');if(p){p.className='state bad';p.textContent='Bot not reachable'}
  if(!lostSince)lostSince=Date.now();const sb=$('setup-banner');if(sb)sb.hidden=true;
  if(el)el.innerHTML='<section class="panel">'+failure('Connection to the bot lost','The bot does not answer. It can be stopped, restarting, or busy. This page tries again every 30 seconds.<br><span class="meta">No answer since '+time(lostSince)+'.</span>','<button class="btn primary" data-retry>Try again</button><a class="btn" href="/logs">Open logs</a>')+'</section>';}
}
document.addEventListener('click',(e)=>{if(e.target.closest('[data-retry]'))load()});
const lg=document.querySelector('.log');if(lg)lg.scrollTop=lg.scrollHeight;
const ci=document.querySelector('[data-copy-info]');if(ci)ci.addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('sysinfo').textContent);ci.textContent='Copied'}catch(e){}});
const cu=$('check-update');if(cu)cu.addEventListener('click',async()=>{const out=$('update-result');cu.disabled=true;out.textContent='Checking...';
 try{const j=await (await fetch('/api/update')).json();
  if(!j.ok)out.textContent='Could not check: '+j.error+'.';else if(!j.latest)out.textContent='No release is published yet.';
  else if(j.newer)out.innerHTML='Version '+esc(j.latest)+' is available. <a href="'+esc(j.url)+'" target="_blank" rel="noopener noreferrer">Download</a>';
  else out.textContent='You have the latest version.'}catch(e){out.textContent='Could not check.'}cu.disabled=false});
document.querySelectorAll('select[data-autosubmit]').forEach(x=>x.addEventListener('change',()=>x.form.submit()));
// Deadline colors: red when overdue, orange within 24 hours, yellow within 3 days.
// A date without a time counts until the end of that day. Updated every minute.
function deadlines(){const now=Date.now(),H=3600000,D=24*H;
 const span=(ms)=>ms<H?Math.max(1,Math.round(ms/60000))+' min':ms<D?Math.round(ms/H)+' h':Math.round(ms/D)+(Math.round(ms/D)===1?' day':' days');
 const todayStr=new Date().toLocaleDateString('en-CA');
 document.querySelectorAll('tr[data-watch]').forEach(tr=>{const v=tr.dataset.due;const [y,m,d]=v.slice(0,10).split('-').map(Number);
  const at=tr.dataset.watch==='time'?new Date(y,m-1,d,Number(v.slice(11,13)),Number(v.slice(14,16))).getTime():new Date(y,m-1,d,23,59,59).getTime();
  const left=at-now;const cls=left<0?'dl-over':left<D?'dl-soon':left<3*D?'dl-near':'';
  tr.classList.remove('dl-over','dl-soon','dl-near');if(cls)tr.classList.add(cls);
  const lab=tr.querySelector('.due-label');if(!lab)return;
  const rel=left<0?'Overdue by '+span(-left):tr.dataset.watch==='day'&&v.slice(0,10)===todayStr?'Due today':'Due in '+span(left);
  lab.className='due-label badge'+(left<0?' bad':left<D?' soon':left<3*D?' warn':'');lab.textContent=rel;lab.title=v.replace('T',' ')});}
if(document.querySelector('tr[data-watch]')){deadlines();setInterval(deadlines,60000)}
const tbl=$('tasks-table');
if(tbl){
 const boxes=()=>[...document.querySelectorAll('input.sel')];
 const sel=()=>boxes().filter(x=>x.checked).map(x=>Number(x.value));
 const upd=()=>{const n=sel().length;$('bulk').hidden=!n;$('bulk-count').textContent=n+(n===1?' task selected':' tasks selected');const a=$('all');if(a)a.checked=n>0&&n===boxes().length};
 const toast=(m,bad)=>{const t=$('toast');t.textContent=m;t.className='toast'+(bad?' bad':'');t.hidden=false;clearTimeout(toast.t);toast.t=setTimeout(()=>{t.hidden=true},4500)};
 try{const m=sessionStorage.getItem('flash');if(m){sessionStorage.removeItem('flash');toast(m)}}catch(e){}
 async function post(path,body){busy(1);setTimeout(()=>busy(-1),600);const r=await fetch(path,{method:'POST',headers:{'content-type':'application/json','x-bot-action':'1'},body:JSON.stringify(body)});let j={};try{j=await r.json()}catch(e){}if(!r.ok)throw new Error(j.error||('Error '+r.status));return j}
 const done=(m)=>{try{sessionStorage.setItem('flash',m)}catch(e){}location.reload()};
 const NAMES={done:'Marked as done',reopen:'Opened again',delete:'Deleted',restore:'Restored',confirm:'Confirmed'};
 async function bulk(action,ids){if(!ids.length)return;try{const j=await post('/api/tasks/bulk',{action,ids});done(NAMES[action]+': '+j.changed+(j.changed===1?' task':' tasks'))}catch(e){toast(e.message,true)}}
 let pendingDelete=[];
 function askDelete(ids){if(!ids.length)return;pendingDelete=ids;$('confirm-text').textContent='Delete '+ids.length+(ids.length===1?' task':' tasks')+'? The calendar event is removed too. You can restore deleted tasks from the "Deleted" view.';$('confirm-dlg').showModal()}
 $('confirm-ok').addEventListener('click',()=>{$('confirm-dlg').close();bulk('delete',pendingDelete)});
 const who=$('e-who'),other=$('e-other'),nodate=$('e-nodate');
 const sync=()=>{other.hidden=who.value!=='other';$('e-date').disabled=$('e-time').disabled=nodate.checked};
 who.addEventListener('change',sync);nodate.addEventListener('change',sync);
 function openEdit(tr){const d=tr.dataset;$('e-id').value=d.id;$('e-title').value=d.title;
  const a=d.assignee;if(['me','everyone','unclear'].includes(a)){who.value=a;other.value=''}else{who.value='other';other.value=a}
  $('e-tag').value=d.tag||'other';$('e-date').value=d.due?d.due.slice(0,10):'';$('e-time').value=d.due&&d.due.length>10?d.due.slice(11,16):'';nodate.checked=!d.due;sync();$('edit-dlg').showModal();$('e-title').focus()}
 $('edit-form').addEventListener('submit',async(e)=>{e.preventDefault();
  const assignee=who.value==='other'?other.value.trim():who.value;
  if(!assignee){toast('Enter the name of the person.',true);return}
  let due=null;if(!nodate.checked){const dt=$('e-date').value;if(!dt){toast('Choose a date, or select "No date".',true);return}due=$('e-time').value?dt+'T'+$('e-time').value:dt}
  try{await post('/api/tasks/update',{id:Number($('e-id').value),title:$('e-title').value.trim(),assignee,due,tag:$('e-tag').value});$('edit-dlg').close();done('Saved. Google Calendar is updated.')}catch(err){toast(err.message,true)}});
 document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>b.closest('dialog').close()));
 document.addEventListener('change',(e)=>{if(e.target.id==='all')boxes().forEach(x=>{x.checked=e.target.checked});if(e.target.id==='all'||e.target.classList.contains('sel'))upd()});
 document.addEventListener('click',(e)=>{const b=e.target.closest('[data-act]');if(!b)return;const act=b.dataset.act;
  if(act.startsWith('bulk-')){const a=act.slice(5);return a==='delete'?askDelete(sel()):bulk(a,sel())}
  const tr=b.closest('tr');const id=Number(tr.dataset.id);
  if(act==='edit')openEdit(tr);else if(act==='delete')askDelete([id]);else bulk(act,[id])});
}
if($('status')||$('overall'))load();setInterval(()=>{if(document.visibilityState==='visible')load()},30000);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')load()});`;

const WHO = (a) => (a === 'me' ? 'Me' : a === 'everyone' ? 'Everyone' : a === 'unclear' ? 'Unclear' : a);
const STATUS_BADGE = { 'In calendar': 'ok', Pending: 'warn', 'No date': '', 'Not yours': '', Done: '', Deleted: '' };
const taskStatus = (t) => (t.status === 'deleted' ? 'Deleted' : t.status === 'done' ? 'Done'
  : !['me', 'everyone', 'unclear'].includes(t.assignee) ? 'Not yours' : !t.due ? 'No date' : t.event_id ? 'In calendar' : 'Pending');

// Edit input checks. A date must exist (no 30 February).
function validDue(due) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/.exec(due);
  if (!m) return false;
  const [y, mo, d, h = 0, mi = 0] = m.slice(1).map((x) => Number(x ?? 0));
  const x = new Date(y, mo - 1, d, h, mi);
  return x.getFullYear() === y && x.getMonth() === mo - 1 && x.getDate() === d && x.getHours() === h && x.getMinutes() === mi;
}
const httpError = (code, message) => Object.assign(new Error(message), { code });
const CONTROL = /[\u0000-\u001f\u007f]/;
const prettyDay = (day) => new Date(`${day}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

export function createDashboard({ store, config, status, log, dbFile, pingOllama, calendar = null, token, setup = null }) {
  const port = config.dashboardPort;
  const allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const allowedOrigins = new Set([...allowedHosts].map((h) => `http://${h}`));
  let favicon = null;
  try { favicon = readFileSync(join(ROOT, 'assets', 'icon.ico')); } catch { /* optional */ }
  let server = null;

  function send(res, code, type, body, { csp = CSP_PAGE, frame = 'DENY' } = {}) {
    res.writeHead(code, { ...BASE_HEADERS, 'X-Frame-Options': frame, 'Content-Type': type, 'Content-Security-Policy': csp });
    res.end(body);
  }

  // head: { title, sub, crumb, meta } shown above the body.
  const page = (title, active, body, script = '', head = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · WhatsApp Task Bot</title><link rel="icon" href="/favicon.ico"><style>${CSS}</style></head><body><div class="loadbar" aria-hidden="true"></div><div class="app">
<aside class="side"><a class="brand" href="/">${LOGO}<span>WhatsApp Task Bot</span></a>
<nav class="nav">${NAV.map(([sect, links]) => `<div class="nav-sect">${sect}</div>${links.map(([h, t]) => `<a href="${h}"${t === active ? ' class="on" aria-current="page"' : ''}>${ICONS[t]}<span>${t}</span></a>`).join('')}`).join('')}</nav>
<div class="side-foot"><span id="overall" class="state">Checking</span><a class="about-link${active === 'About' ? ' on' : ''}" href="/about">About · v${esc(VERSION)}</a></div></aside>
<main class="content">${head.title ? `<header class="head"><div>${head.crumb ? `<div class="crumb">${head.crumb}</div>` : ''}<h1>${esc(head.title)}</h1>${head.sub ? `<p class="sub">${head.sub}</p>` : ''}</div>${head.meta ? `<div class="meta">${head.meta}</div>` : ''}</header>` : ''}${body}</main></div>
<script src="/app.js"></script>${script ? `<script src="${script}"></script>` : ''}</body></html>`;

  // The guided setup: a calm frame with no sidebar, one step on each screen.
  const journeyPage = (body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome · WhatsApp Task Bot</title><link rel="icon" href="/favicon.ico"><style>${CSS}</style></head><body><div class="loadbar" aria-hidden="true"></div>
<header class="j-top"><span class="brand">${LOGO}<span>WhatsApp Task Bot</span></span><a class="btn ghost sm" href="/">Open the dashboard</a></header>
<main class="j-main">${body}</main><script src="/app.js"></script><script src="/setup.js"></script></body></html>`;

  // Shown without the token: no data, only how to get in.
  const gate = (title, text) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><link rel="icon" href="/favicon.ico"><style>${CSS}</style></head><body><div class="gate panel"><div class="panel-b"><div class="brand">${LOGO}<span>WhatsApp Task Bot</span></div><h1>${esc(title)}</h1>${text}</div></div></body></html>`;
  const GATE_TEXT = '<p class="sub">This dashboard needs its access link.</p><ol><li>Double-click the "WhatsApp Task Bot" shortcut on your desktop.</li><li>Or open PowerShell in the bot folder, type <code>npm run dashboard-url</code>, and open the link that it shows.</li></ol>';

  // Failure frame for error pages: what happened, and what to do next.
  const FAIL_SVG = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><path d="M12 8v5M12 16.5v.5"/><circle cx="12" cy="12" r="9"/></svg>';
  const failureBody = (title, text, actions, tone = 'bad') => `<section class="panel"><div class="failure ${tone}"><div class="fi">${FAIL_SVG}</div><h2>${esc(title)}</h2><p>${text}</p><div class="acts">${actions}</div></div></section>`;
  const ERRORS = {
    404: ['Page not found', 'This page does not exist. The link can be old or mistyped.', '<a class="btn primary" href="/">Go to Status</a><a class="btn" href="/tasks">Open Tasks</a>', 'warn'],
    405: ['Not available', 'This page only shows data. Use the buttons on the page to make changes.', '<a class="btn primary" href="/">Go to Status</a>', 'warn'],
    500: ['Something went wrong', 'The bot could not show this page. The error is in the log. The bot continues to operate.', '<a class="btn primary" href="/logs">Open logs</a><a class="btn" href="/">Go to Status</a>', 'bad'],
  };
  function errorPage(res, code, override = null) {
    const [title, text, actions, tone] = override ?? ERRORS[code];
    return send(res, code, 'text/html; charset=utf-8', page(title, '', failureBody(title, text, actions, tone)));
  }

  // Each check: 'ok' (green, it works), 'bad' (red, it failed), or 'idle'
  // (gray, it has not happened yet or the bot is still starting). Never green
  // for something that never happened.
  function apiStatus() {
    const s = snapshot(dbFile);
    const now = s.now;
    const interval = config.batchIntervalMinutes * 60 * 1000;
    const starting = s.uptimeSec < 180;
    const HOUR = 3600 * 1000;
    if (pingOllama && (!s.ollama.checkedAt || now - s.ollama.checkedAt > 60_000)) pingOllama().catch(() => {});
    const tri = (ok, bad) => (ok ? 'ok' : bad ? 'bad' : 'idle');
    const lastMsgAge = s.whatsapp.lastMessageAt ? now - s.whatsapp.lastMessageAt : null;
    const unlinked = ['not linked', 'link failed', 'logged out'].includes(s.whatsapp.state);
    s.setupNeeded = !config.myName || unlinked;
    s.reviewCount = store.s.reviewCount.get();
    s.whatsapp = { ...s.whatsapp }; // a copy: the live object keeps the pairing code for the setup page
    delete s.whatsapp.pairingCode;
    s.checks = {
      whatsapp: tri(s.whatsapp.state === 'open', !starting && !['not linked', 'link failed'].includes(s.whatsapp.state)), // logged out stays red
      lastMessage: tri(lastMsgAge !== null && lastMsgAge < 6 * HOUR, lastMsgAge === null ? !starting && s.uptimeSec > 24 * 3600 : lastMsgAge > 24 * HOUR),
      lastRun: tri(!!s.batch.lastRun && now - s.batch.lastRun < 2 * interval + 5 * 60 * 1000, !starting && (!s.batch.lastRun || now - s.batch.lastRun >= 2 * interval + 5 * 60 * 1000)),
      lastBatch: tri(!!s.batch.result && s.batch.result.startsWith('ok'), !!s.batch.result && !s.batch.result.startsWith('ok')),
      nextBatch: tri(s.batch.running || (!!s.batch.nextAt && s.batch.nextAt - now < interval + 2 * 60 * 1000), !starting),
      ollama: tri(s.ollama.reachable === true, s.ollama.reachable === false && !starting),
      calendar: tri(s.calendar.ok === true, s.calendar.ok === false),
      email: tri(s.email.ok === true || !!s.email.lastSentDate, s.email.ok === false),
      nextEmail: tri(!!s.email.nextAt, !starting),
      ram: tri(s.rssBytes < 150 * MB, true),
      db: tri(s.dbBytes < 200 * MB, true),
    };
    return JSON.stringify(s);
  }

  function statusPage() {
    return page('Status', 'Status', `<div class="callout warn" id="setup-banner" hidden><span>The setup is not finished.</span><a class="btn sm" href="/setup">Continue setup</a></div><div class="callout" id="connecting" hidden><span class="busy-line"><span class="spin"></span>Connecting to WhatsApp...</span></div><div id="status" aria-busy="true"><div class="panel summary">${'<div class="metric"><div class="skel w40"></div><div class="skel w70" style="margin-top:10px;height:18px"></div></div>'.repeat(4)}</div><div class="cols">${'<div class="panel skel-panel"><div class="skel w40"></div><div class="skel w70"></div><div class="skel w55"></div><div class="skel w70"></div></div>'.repeat(2)}</div></div>`, '',
      { title: 'Status', sub: 'Live health of the bot. The page updates every 30 seconds.', meta: '<span id="updated"></span>' });
  }

  // Every day since the bot started (within the retention time), with what
  // happened to its report. Same rules as the scheduler's catch-up.
  function reportsPage() {
    const [eh, em] = config.emailTime.split(':').map(Number);
    const emailAt = (day) => { const d = new Date(`${day}T00:00:00`); d.setHours(eh, em, 0, 0); return d.getTime(); };
    const DAY = 24 * 3600 * 1000;
    const now = Date.now();
    const today = localDay(now);
    const rows = new Map(store.s.listReports.all().map((r) => [r.day, r]));
    const first = [store.kvGet('firstDay') || [...rows.keys()].sort()[0] || today, localDay(now - (config.retention.reportDays - 1) * DAY)].sort().at(-1);
    const catchFrom = localDay(now - CATCH_UP_DAYS * DAY);
    const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const items = [];
    for (let day = today; day >= first; day = localDay(new Date(`${day}T12:00:00`).getTime() - DAY)) {
      const r = rows.get(day);
      let badge;
      let note = '';
      if (r?.sent_at) {
        const late = r.sent_at - emailAt(day) > 60 * 60 * 1000;
        badge = `<span class="badge ${late ? 'warn' : 'ok'}">${late ? 'Sent late' : 'Sent'}</span>`;
        note = late ? `Sent ${esc(new Date(r.sent_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))} at ${hhmm(r.sent_at)}. The computer was off at ${esc(config.emailTime)}.` : `Sent at ${hhmm(r.sent_at)}`;
      } else if (r) {
        badge = '<span class="badge warn">Not sent yet</span>';
        note = 'The email failed. The bot tries again every 10 minutes.';
      } else if (emailAt(day) > now) {
        badge = '<span class="badge">Scheduled</span>';
        note = `At ${esc(config.emailTime)}`;
      } else if (day >= catchFrom && store.s.dayHasContent.get({ day })) {
        badge = '<span class="badge warn">Waiting to send</span>';
        note = 'The bot sends this report within a few minutes.';
      } else {
        badge = '<span class="badge bad">Report skipped</span>';
        note = `The computer was off at ${esc(config.emailTime)}, and the bot found nothing for this day.`;
      }
      items.push(`<tr class="task"><td>${esc(prettyDay(day))}</td><td>${badge}</td><td class="dim">${note}</td><td class="r">${r ? `<a class="btn sm" href="/reports/${esc(day)}">View</a>` : ''}</td></tr>`);
    }
    return page('Reports', 'Reports', `<section class="panel"><div class="table-scroll"><table><tr><th>Day</th><th>Status</th><th>Details</th><th class="r"></th></tr>${items.join('')}</table></div></section>`, '',
      { title: 'Reports', sub: `One report each day at ${esc(config.emailTime)}. A missed report is sent late when the computer is on again (up to ${CATCH_UP_DAYS} days back).` });
  }

  function reportView(day) {
    return page(`Report ${day}`, 'Reports', `<section class="panel"><iframe class="report" sandbox="" src="/reports/${esc(day)}/raw" title="Report ${esc(day)}"></iframe></section>`, '',
      { title: prettyDay(day), crumb: '<a href="/reports">Reports</a> /', sub: 'The same report that the email showed.' });
  }

  const STATUSES = { open: 'Open', review: 'Needs review', done: 'Done', deleted: 'Deleted', all: 'All' };
  const FILTERS = { all: 'Everyone', mine: 'Mine', everyone: 'For the group', others: 'Others and unclear' };
  const DUES = { all: 'Any date', overdue: 'Overdue', today: 'Today', week: 'Next 7 days', upcoming: 'Today and later', nodate: 'No date' };
  const SORTS = { mine: 'Mine first', due: 'Due date', newest: 'Newest', chat: 'Chat' };
  const own = (map, v) => (Object.hasOwn(map, v) ? v : null);
  const cap = (t) => t.charAt(0).toUpperCase() + t.slice(1);
  const OURS = new Set(['me', 'everyone', 'unclear']);

  function tasksPage(q) {
    const st = own(STATUSES, q.get('s')) ?? 'open';
    const f = own(FILTERS, q.get('f')) ?? 'all';
    const d = own(DUES, q.get('due')) ?? 'all';
    const sort = own(SORTS, q.get('sort')) ?? 'mine';
    const tag = TAGS.includes(q.get('tag')) ? q.get('tag') : '';
    const chats = store.s.chatNames.all();
    const chat = chats.some((c) => c.chat_name === q.get('chat')) ? q.get('chat') : '';
    const text = String(q.get('q') ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
    const pageNo = Math.max(1, Number.parseInt(q.get('page'), 10) || 1);
    const today = localDay();
    const week = localDay(Date.now() + 7 * 24 * 3600 * 1000);
    // LIKE: "!" escapes the wildcard characters that the person typed.
    const like = text ? `%${text.replace(/[!%_]/g, (c) => `!${c}`)}%` : '';
    const params = { s: st, f, d, today, week, tag, chat, q: like, off: (pageNo - 1) * 50 };
    const total = store.s.tasksCount.get(params);
    const rows = store.s.tasksPage[sort].all(params);
    const pages = Math.max(1, Math.ceil(total / 50));
    // Every link keeps every filter, so a tab or the next page does not reset them.
    const cur = { s: st, f, due: d, tag, chat, q: text, sort };
    const link = (o = {}) => `/tasks?${new URLSearchParams(Object.entries({ ...cur, ...o }).filter(([, v]) => v !== '' && v != null && v !== 1)).toString()}`;
    const clear = { f: '', due: '', tag: '', chat: '', q: '' };
    const filtered = f !== 'all' || d !== 'all' || tag || chat || text;
    const opts = (map, now) => Object.entries(map).map(([k, v]) => `<option value="${esc(k)}"${k === now ? ' selected' : ''}>${esc(v)}</option>`).join('');
    const select = (name, label, inner) => `<select class="in" name="${name}" data-autosubmit aria-label="${label}">${inner}</select>`;
    const tagCounts = Object.fromEntries(store.s.tagCounts.all().map((r) => [r.tag, r.n]));
    const tagOpts = `<option value="">Any tag</option>${TAGS.filter((t) => tagCounts[t]).map((t) => `<option value="${t}"${t === tag ? ' selected' : ''}>${cap(t)} (${tagCounts[t]})</option>`).join('')}`;
    const chatOpts = `<option value="">Any chat</option>${chats.map((c) => `<option value="${esc(c.chat_name)}"${c.chat_name === chat ? ' selected' : ''}>${esc(c.chat_name)} (${c.n})</option>`).join('')}`;
    // The page script turns the due cell into "Due in 3 h" and colors the row as the time comes closer.
    const due = (t) => (t.due ? `<span class="due-label">${esc(t.due.replace('T', ' '))}</span>` : '<span class="dim">—</span>');
    const watch = (t) => t.status === 'open' && !!t.due && OURS.has(t.assignee);
    const who = (t) => (t.assignee === 'me' ? '<span class="badge ink">You</span>' : esc(WHO(t.assignee)));
    const acts = (t) => (t.status === 'deleted'
      ? '<button class="btn ghost sm" data-act="restore">Restore</button>'
      : `${t.flagged ? '<button class="btn ghost sm" data-act="confirm" title="The task is right: remove the warning and the ? in the calendar">Confirm</button>' : ''}<button class="btn ghost sm" data-act="edit">Edit</button>${t.status === 'done' ? '<button class="btn ghost sm" data-act="reopen">Reopen</button>' : '<button class="btn ghost sm" data-act="done">Done</button>'}<button class="btn ghost sm danger" data-act="delete">Delete</button>`);
    const reason = (t) => t.review_reason || (t.assignee === 'unclear' ? 'Unclear who must do it' : 'Low confidence');
    const line = (t) => {
      const parts = [];
      if (t.tag) parts.push(`<a class="tag" href="${esc(link({ tag: t.tag, page: '' }))}" title="Show all ${esc(t.tag)} tasks">${esc(t.tag)}</a>`);
      if (t.flagged && t.status !== 'deleted') parts.push(`<span class="badge warn">Needs review</span><span class="why">${esc(reason(t))}</span>`);
      return parts.length ? `<div class="tline">${parts.join('')}</div>` : '';
    };
    const row = (t) => `<tr class="${t.assignee === 'me' && t.status === 'open' ? 'mine' : t.status === 'done' ? 'done' : 'task'}" data-id="${t.id}" data-title="${esc(t.title)}" data-assignee="${esc(t.assignee)}" data-due="${esc(t.due ?? '')}" data-tag="${esc(t.tag ?? 'other')}"${watch(t) ? ` data-watch="${t.due_kind === 'datetime' ? 'time' : 'day'}"` : ''}>`
      + `<td class="c"><input type="checkbox" class="sel" value="${t.id}" aria-label="Select task"></td><td class="t">${esc(t.title)}${line(t)}</td><td>${who(t)}</td><td class="dim">${esc(t.chat_name)}</td><td>${due(t)}</td>`
      + `<td><span class="badge ${STATUS_BADGE[taskStatus(t)]}">${taskStatus(t)}</span></td><td class="dim">${esc(t.day)}</td><td class="r"><div class="acts">${acts(t)}</div></td></tr>`;
    const first = total ? (pageNo - 1) * 50 + 1 : 0;
    const empty = st === 'review' && !filtered ? 'No tasks need a review.' : st === 'open' && !filtered ? 'No open tasks. New tasks show here when the bot finds them.' : 'No tasks for this filter.';
    const table = rows.length
      ? `<div class="table-scroll"><table id="tasks-table"><tr><th class="c"><input type="checkbox" id="all" aria-label="Select all on this page"></th><th>Task</th><th>Assigned to</th><th>Chat</th><th>Due</th><th>Status</th><th>Found</th><th class="r"></th></tr>${rows.map(row).join('')}</table></div>`
      : `<div class="empty" id="tasks-table">${empty}${filtered ? ` <a href="${esc(link({ ...clear, page: '' }))}">Clear the filters</a>` : ''}</div>`;
    const bulkButtons = st === 'deleted'
      ? '<button class="btn sm" data-act="bulk-restore">Restore</button>'
      : '<button class="btn sm" data-act="bulk-confirm">Confirm</button><button class="btn sm" data-act="bulk-done">Mark as done</button><button class="btn sm" data-act="bulk-reopen">Reopen</button><button class="btn sm danger" data-act="bulk-delete">Delete</button>';
    const pager = `<div class="pager"><span>${first ? `${first}–${Math.min(total, pageNo * 50)} of ${total}` : '0 tasks'} · Page ${pageNo} of ${pages} (${total} tasks)</span><span class="filters"><a class="btn sm${pageNo > 1 ? '' : ' off'}" href="${esc(link({ page: pageNo - 1 }))}">Previous</a><a class="btn sm${pageNo < pages ? '' : ' off'}" href="${esc(link({ page: pageNo + 1 }))}">Next</a></span></div>`;
    const reviewN = store.s.reviewCount.get();
    const tabs = Object.entries(STATUSES).map(([k, v]) => `<a href="${esc(link({ s: k, page: '' }))}"${k === st ? ' class="on" aria-current="true"' : ''}>${v}${k === 'review' && reviewN ? ` (${reviewN})` : ''}</a>`).join('');
    const hidden = (k, v) => (v ? `<input type="hidden" name="${k}" value="${esc(v)}">` : '');
    const toolbar = `<div class="toolbar"><nav class="seg" aria-label="Task status">${tabs}</nav>`
      + `<form class="filters" method="get" action="/tasks">${hidden('s', st)}<input class="in search" type="search" name="q" value="${esc(text)}" placeholder="Search tasks, chats, people" aria-label="Search">`
      + `${select('f', 'Person', opts(FILTERS, f))}${select('due', 'Due date', opts(DUES, d))}${select('tag', 'Tag', tagOpts)}${select('chat', 'Chat', chatOpts)}${select('sort', 'Sort', opts(SORTS, sort))}`
      + `${filtered ? `<a class="btn ghost sm" href="${esc(link({ ...clear, page: '' }))}">Clear filters</a>` : ''}<noscript><button class="btn sm">Apply</button></noscript></form></div>`;
    const tagSelect = TAGS.map((t) => `<option value="${t}">${cap(t)}</option>`).join('');
    const dialogs = `<div class="bulk" id="bulk" hidden><span id="bulk-count"></span><span class="grow"></span>${bulkButtons}</div>
<dialog id="edit-dlg"><form id="edit-form"><div class="dlg-b"><h3>Edit task</h3><input type="hidden" id="e-id">
<div class="field"><label for="e-title">Task</label><input id="e-title" maxlength="200" required></div>
<div class="row2"><div class="field"><label for="e-who">Assigned to</label><select id="e-who"><option value="me">You</option><option value="everyone">Everyone in the group</option><option value="unclear">Unclear</option><option value="other">Another person</option></select><input id="e-other" maxlength="60" placeholder="Name of the person" hidden></div>
<div class="field"><label for="e-tag">Tag</label><select id="e-tag">${tagSelect}</select></div></div>
<div class="row2"><div class="field"><label for="e-date">Due date</label><input type="date" id="e-date"></div><div class="field"><label for="e-time">Time <span class="hint">optional</span></label><input type="time" id="e-time"></div></div>
<label class="check"><input type="checkbox" id="e-nodate"> No date</label>
<p class="hint">Tasks for you, for the group, or unclear, with a date, get a calendar event. Another person's task has no event. Saving also removes the "Needs review" warning.</p></div>
<div class="dlg-f"><button type="button" class="btn" data-close>Cancel</button><button type="submit" class="btn primary">Save changes</button></div></form></dialog>
<dialog id="confirm-dlg"><div class="dlg-b"><h3>Delete tasks</h3><p id="confirm-text" class="sub"></p></div><div class="dlg-f"><button type="button" class="btn" data-close>Cancel</button><button type="button" class="btn danger solid" id="confirm-ok">Delete</button></div></dialog>
<div class="toast" id="toast" hidden></div>`;
    return page('Tasks', 'Tasks', `${toolbar}<section class="panel">${table}${pager}</section>${dialogs}`, '',
      { title: 'Tasks', sub: 'Your open tasks come first. Changes go to Google Calendar at once. The colored edge shows how close a deadline is.' });
  }

  // ---- task changes (POST, same-origin JSON only) ----
  // A web page from another site cannot send this: it would need our Origin and a
  // custom header, and the browser blocks that without a CORS answer, which we never give.
  function writeAllowed(req) {
    if (!allowedOrigins.has(req.headers.origin)) return false;
    if (req.headers['x-bot-action'] !== '1') return false;
    if (!String(req.headers['content-type'] || '').startsWith('application/json')) return false;
    const site = req.headers['sec-fetch-site'];
    return !site || site === 'same-origin';
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size <= 16 * 1024) chunks.push(c); // more than 16 KB: read on, keep nothing, answer 413
      });
      req.on('end', () => {
        if (size > 16 * 1024) return reject(httpError(413, 'Request too large'));
        try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(httpError(400, 'Not valid JSON')); }
      });
      req.on('error', reject);
    });
  }

  const kickCalendar = () => calendar?.sync().catch((err) => log.error('dashboard: calendar sync failed', { err: err.message }));

  function updateTask(b) {
    const id = Number(b.id);
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    const assignee = typeof b.assignee === 'string' ? b.assignee.trim() : '';
    if (!Number.isInteger(id) || id < 1) throw httpError(400, 'Bad task id');
    if (!title || title.length > 200 || CONTROL.test(title)) throw httpError(400, 'The task text must have 1 to 200 characters.');
    if (!assignee || assignee.length > 60 || CONTROL.test(assignee)) throw httpError(400, 'The person must have 1 to 60 characters.');
    const due = b.due == null || b.due === '' ? null : String(b.due);
    if (due !== null && !validDue(due)) throw httpError(400, 'The date is not valid.');
    const task = store.s.taskById.get(id);
    if (!task || task.status === 'deleted') throw httpError(404, 'Task not found');
    const tag = TAGS.includes(b.tag) ? b.tag : task.tag ?? 'other';
    store.s.updateTask.run({ id, title, assignee, due, due_kind: due ? (due.length > 10 ? 'datetime' : 'date') : null, tag, now: Date.now() });
    log.info('dashboard: task edited', { id });
    kickCalendar();
    return { ok: true };
  }

  // Allowed status changes for each action.
  const ACTIONS = { done: { from: ['open'], to: 'done' }, reopen: { from: ['done'], to: 'open' }, delete: { from: ['open', 'done'], to: 'deleted' }, restore: { from: ['deleted'], to: 'open' }, confirm: { from: ['open', 'done'] } };

  function bulkTasks(b) {
    const rule = Object.hasOwn(ACTIONS, b.action) ? ACTIONS[b.action] : null;
    if (!rule) throw httpError(400, 'Unknown action');
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 500 || !b.ids.every((x) => Number.isInteger(x) && x > 0)) throw httpError(400, 'Bad task ids');
    const now = Date.now();
    const changed = store.db.transaction(() => {
      let n = 0;
      for (const id of new Set(b.ids)) {
        const t = store.s.taskById.get(id);
        if (!t || !rule.from.includes(t.status)) continue;
        n += b.action === 'confirm' ? store.s.confirmTask.run({ id, now }).changes : store.s.setTaskStatus.run({ id, status: rule.to, now }).changes;
      }
      return n;
    })();
    log.info('dashboard: tasks changed', { action: b.action, changed });
    if (changed) kickCalendar();
    return { ok: true, changed };
  }

  async function handleSetup(req, res, action) {
    if (!writeAllowed(req)) return send(res, 403, 'application/json', JSON.stringify({ error: 'Changes are allowed only from the dashboard page.' }));
    try {
      const out = await setup.act(action, await readJson(req));
      return send(res, 200, 'application/json', JSON.stringify(out));
    } catch (err) {
      const code = typeof err.code === 'number' ? err.code : 500;
      if (code === 500) log.error('dashboard: setup failed', { action, err: err.message });
      return send(res, code, 'application/json', JSON.stringify({ error: code === 500 ? 'Error. See the log page.' : err.message }));
    }
  }

  async function handleWrite(req, res, p) {
    if (!writeAllowed(req)) return send(res, 403, 'application/json', JSON.stringify({ error: 'Changes are allowed only from the dashboard page.' }));
    try {
      const body = await readJson(req);
      const out = p === '/api/tasks/update' ? updateTask(body) : bulkTasks(body);
      return send(res, 200, 'application/json', JSON.stringify(out));
    } catch (err) {
      if (!err.code || typeof err.code !== 'number') log.error('dashboard: change failed', { err: err.message });
      return send(res, typeof err.code === 'number' ? err.code : 500, 'application/json', JSON.stringify({ error: typeof err.code === 'number' ? err.message : 'Error' }));
    }
  }

  // About: who made it, where to report problems, version and update check.
  // A path without the Windows user name, for screenshots in public issues.
  function shortPath(p) {
    for (const [name, dir] of [['%LOCALAPPDATA%', process.env.LOCALAPPDATA], ['%USERPROFILE%', process.env.USERPROFILE]]) {
      if (dir && p.toLowerCase().startsWith(dir.toLowerCase())) return name + p.slice(dir.length);
    }
    return p;
  }
  function sysInfo() {
    return `App version: ${VERSION}\nWindows: ${release()}\nNode.js: ${process.version}`;
  }
  function aboutPage() {
    const q = (o) => new URLSearchParams(o).toString();
    const bug = `${REPO_URL}/issues/new?${q({ template: 'bug_report.yml', version: VERSION, system: `Windows ${release()}, Node.js ${process.version}` })}`;
    const idea = `${REPO_URL}/issues/new?${q({ template: 'feature_request.yml', version: VERSION })}`;
    const icon = LOGO.replace('width="22" height="22"', 'width="64" height="64"');
    const body = `<section class="panel"><div class="about-hero">${icon}<div><h2>WhatsApp Task Bot</h2><p class="by">Version ${esc(VERSION)} · Made by <a href="https://github.com/Codex-Crusader" target="_blank" rel="noopener noreferrer">${esc(AUTHOR)}</a></p></div></div>
<div class="about-acts"><a class="btn primary" href="${REPO_URL}" target="_blank" rel="noopener noreferrer">View on GitHub</a><a class="btn" href="${esc(bug)}" target="_blank" rel="noopener noreferrer">Report a problem</a><a class="btn" href="${esc(idea)}" target="_blank" rel="noopener noreferrer">Request a feature</a><button class="btn" id="check-update" type="button">Check for updates</button><span class="meta" id="update-result"></span></div></section>
<div class="cols" style="margin-top:16px"><section class="panel"><div class="panel-h">Your data</div><div class="panel-b"><p class="sub" style="margin:0 0 8px">Message text stays on this computer. The language model operates here too. Only your tasks go to your own Google Calendar, and the daily report goes to your own Gmail address.</p><p class="sub" style="margin:0">Personal files: <code>${esc(shortPath(HOME))}</code></p><p style="margin:10px 0 0"><a href="${REPO_URL}/blob/main/SECURITY.md" target="_blank" rel="noopener noreferrer">Security and privacy details</a></p></div></section>
<section class="panel"><div class="panel-h">For a problem report<button class="btn sm" type="button" data-copy-info>Copy</button></div><pre class="sysinfo" id="sysinfo">${esc(sysInfo())}</pre></section></div>
<p class="hint">Free software under the <a href="${REPO_URL}/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">GNU General Public License v3.0</a>. Problems and ideas go to the GitHub issue page. Do not put private data in an issue.</p>`;
    return page('About', 'About', body, '', { title: 'About' });
  }

  // GitHub's latest release, only when the person asks. No background calls.
  async function latestRelease() {
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO_URL.split('github.com/')[1]}/releases/latest`, { headers: { 'User-Agent': `whatsapp-task-bot/${VERSION}`, Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(8000) });
      if (r.status === 404) return { ok: true, latest: null };
      if (!r.ok) return { ok: false, error: `GitHub answered ${r.status}` };
      const j = await r.json();
      const latest = String(j.tag_name || '').replace(/^v/, '');
      const newer = latest.split('.').map(Number).reduce((acc, n, i) => acc ?? (n > (VERSION.split('.').map(Number)[i] ?? 0) ? true : n < (VERSION.split('.').map(Number)[i] ?? 0) ? false : null), null) === true;
      return { ok: true, latest, newer, url: j.html_url };
    } catch {
      return { ok: false, error: 'GitHub could not be reached' };
    }
  }

  function logsPage() {
    const lines = log.tail(200).map((l) => {
      const m = /^(\S+ \S+) (INFO|WARN|ERROR) (.*)$/.exec(l);
      return m ? `<span class="t">${esc(m[1])}</span> <span class="${m[2]}">${m[2].padEnd(5)} ${esc(m[3])}</span>` : esc(l);
    });
    return page('Logs', 'Logs', `<section class="panel"><pre class="log">${lines.join('\n') || 'Empty.'}</pre></section>`, '',
      { title: 'Logs', sub: 'The last 200 lines, newest at the bottom. The log contains no message text.' });
  }

  async function handle(req, res) {
    if (!allowedHosts.has(req.headers.host)) return send(res, 403, 'text/html; charset=utf-8', gate('Address not allowed', `<p class="sub">Open the dashboard at <code>http://localhost:${port}</code> with its access link.</p>`));
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;
    const html = 'text/html; charset=utf-8';

    // ---- access token ----
    if (p === '/favicon.ico' && req.method === 'GET') return favicon ? send(res, 200, 'image/x-icon', favicon) : send(res, 404, 'text/plain', 'Not found');
    if (p === '/login' && req.method === 'GET') {
      if (!sameToken(url.searchParams.get('t'), token)) return send(res, 403, html, gate('This link is not valid', GATE_TEXT));
      // The redirect removes the token from the address bar.
      const unlinked = ['not linked', 'link failed', 'logged out'].includes(status.whatsapp.state);
      const firstRun = !store.kvGet('onboarding') && (!config.myName || unlinked);
      res.writeHead(302, { ...BASE_HEADERS, 'Set-Cookie': sessionCookie(token), Location: firstRun ? '/welcome' : '/' });
      return res.end();
    }
    if (!sameToken(cookieToken(req), token)) {
      if (p.startsWith('/api/')) return send(res, 401, 'application/json', JSON.stringify({ error: 'Open the dashboard with its access link.' }));
      return send(res, 401, html, gate('Access link needed', GATE_TEXT));
    }

    if (req.method === 'POST' && (p === '/api/tasks/update' || p === '/api/tasks/bulk')) return handleWrite(req, res, p);
    const sa = /^\/api\/setup\/([a-z-]{1,30})$/.exec(p);
    if (req.method === 'POST' && sa && setup) return handleSetup(req, res, sa[1]);
    if (req.method !== 'GET' && req.method !== 'HEAD') return p.startsWith('/api/') ? send(res, 405, 'application/json', JSON.stringify({ error: 'Not allowed' })) : errorPage(res, 405);
    try {
      if (p === '/') return send(res, 200, html, statusPage());
      if (p === '/setup.js') return send(res, 200, 'text/javascript; charset=utf-8', SETUP_JS);
      if (p === '/welcome' && setup) return send(res, 200, html, journeyPage(setup.journeyBody()));
      if (p === '/setup' && setup) return send(res, 200, html, page('Setup', 'Setup', setup.setupBody(), '/setup.js', { title: 'Setup', sub: 'Do the steps in order. A step shows "Complete" when it works. You can come back at any time.' }));
      if (p === '/settings' && setup) return send(res, 200, html, page('Settings', 'Settings', setup.settingsBody(), '/setup.js', { title: 'Settings', sub: 'Changes apply at once. The bot does not need a restart.' }));
      if (p === '/api/setup' && setup) return send(res, 200, 'application/json', JSON.stringify(await setup.state()));
      if (p === '/app.js') return send(res, 200, 'text/javascript; charset=utf-8', APP_JS);
      if (p === '/api/status') return send(res, 200, 'application/json', apiStatus());
      if (p === '/reports') return send(res, 200, html, reportsPage());
      const m = /^\/reports\/(\d{4}-\d{2}-\d{2})(\/raw)?$/.exec(p);
      if (m) {
        const r = store.s.getReport.get(m[1]);
        if (!r) return errorPage(res, 404, ['Report not found', `There is no saved report for ${esc(m[1])}. The computer was off at the report time, or the report is older than ${config.retention.reportDays} days.`, '<a class="btn primary" href="/reports">All reports</a>', 'warn']);
        return m[2] ? send(res, 200, html, r.html, { csp: CSP_REPORT, frame: 'SAMEORIGIN' }) : send(res, 200, html, reportView(m[1]));
      }
      if (p === '/tasks') return send(res, 200, html, tasksPage(url.searchParams));
      if (p === '/logs') return send(res, 200, html, logsPage());
      if (p === '/about') return send(res, 200, html, aboutPage());
      if (p === '/api/update') return send(res, 200, 'application/json', JSON.stringify(await latestRelease()));
      if (p.startsWith('/api/')) return send(res, 404, 'application/json', JSON.stringify({ error: 'Not found' }));
      return errorPage(res, 404);
    } catch (err) {
      log.error('dashboard: request failed', { path: p, err: err.message });
      return p.startsWith('/api/') ? send(res, 500, 'application/json', JSON.stringify({ error: 'Error' })) : errorPage(res, 500);
    }
  }

  return {
    // Resolves when listening. Rejects with EADDRINUSE if another copy of the bot runs.
    start() {
      server = createServer((req, res) => handle(req, res).catch((err) => {
        log.error('dashboard: request failed', { err: err.message });
        if (!res.headersSent) errorPage(res, 500);
      }));
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => {
          server.off('error', reject);
          server.on('error', (err) => log.error('dashboard: server error', { err: err.message }));
          log.info('dashboard: listening', { url: `http://localhost:${port}/` });
          resolve(server);
        });
      });
    },
    stop: () => server?.close(),
  };
}
