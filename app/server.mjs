// Cairn Board: read-only dashboard. Node built-ins only. See app/README.md.
// Env: PORT(8080) DATA_SOURCE(clickhouse|fixture) CLICKHOUSE_URL CLICKHOUSE_USER CLICKHOUSE_PASSWORD FIXTURE_DIR
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const E = process.env;
const PORT = Number(E.PORT) || 8080;
const FIXTURE = (E.DATA_SOURCE || (E.CLICKHOUSE_URL ? 'clickhouse' : 'fixture')) === 'fixture';
const FDIR = E.FIXTURE_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CARD_RE = /^[a-z0-9-]{1,64}$/;
const WINDOWS = { '10m': 600, '1h': 3600, '1d': 86400, '7d': 604800 };
const CACHE_MS = 5000, CH_TIMEOUT = 60000, MAX_URL = 200;

// ---------- data source ----------
let CH = null, hostLabel = 'demo fixtures';
if (!FIXTURE) {
  let u;
  try { u = new URL(E.CLICKHOUSE_URL || ''); } catch { u = null; }
  if (!u || u.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(u?.hostname) || u.username || u.password) {
    console.error('CLICKHOUSE_URL must be https://host:port with no credentials in it (use CLICKHOUSE_USER / CLICKHOUSE_PASSWORD)');
    process.exit(1);
  }
  CH = { base: u.origin + '/', headers: { 'X-ClickHouse-User': E.CLICKHOUSE_USER || 'default', 'X-ClickHouse-Key': E.CLICKHOUSE_PASSWORD || '' } };
  hostLabel = 'ClickHouse ' + u.host;
}
let fx = null;
if (FIXTURE) {
  const rd = (f) => JSON.parse(fs.readFileSync(path.join(FDIR, f), 'utf8'));
  fx = { cards: rd('cards.json'), events: rd('events.json') };
  // shift demo timestamps so the newest event is 30 s old (keeps the incident window meaningful)
  const mx = Math.max(...fx.events.map((e) => Date.parse(e.ts.replace(' ', 'T') + 'Z')));
  const d = Date.now() - 30000 - mx;
  for (const e of fx.events) e.ts = fmtTs(new Date(Date.parse(e.ts.replace(' ', 'T') + 'Z') + d));
}
function fmtTs(d) { return d.toISOString().replace('T', ' ').replace('Z', ''); }

// Every query is a constant SELECT; user input only travels as param_* values.
const Q = {
  cards: {
    sql: 'SELECT card_id, version, status, class, severity, behavior FROM cairn_cards ORDER BY card_id, version DESC LIMIT 1 BY card_id',
    fx: () => latest(fx.cards),
  },
  card: {
    sql: 'SELECT card_id, version, created_at, status, class, severity, seed, behavior, why, recognize, known_copies, safe_pattern, verification, source_sha256 FROM cairn_cards WHERE card_id = {card_id:String} ORDER BY version DESC LIMIT 1',
    fx: (p) => latest(fx.cards).filter((c) => c.card_id === p.card_id),
  },
  stats: {
    sql: "SELECT card_id, countIf(kind='finding') AS findings, countIf(kind='cousin_candidate') AS cousins, uniqExactIf(file, file != '') AS files, min(ts) AS first_seen, max(ts) AS last_seen, countIf(kind='agent_ignored_finding') AS ignored FROM cairn_events GROUP BY card_id",
    fx: () => [...grp(fx.events, 'card_id')].map(([card_id, r]) => ({
      card_id, findings: cnt(r, 'finding'), cousins: cnt(r, 'cousin_candidate'), files: new Set(r.filter((x) => x.file).map((x) => x.file)).size,
      first_seen: r.map((x) => x.ts).sort()[0], last_seen: r.map((x) => x.ts).sort().pop(), ignored: cnt(r, 'agent_ignored_finding') })),
  },
  recent: {
    sql: 'SELECT ts, kind, card_id, file, line, actor FROM cairn_events ORDER BY ts DESC LIMIT 50',
    fx: () => [...fx.events].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 50),
  },
  spread: {
    sql: "SELECT repo, file, min(ts) AS first_seen, max(ts) AS last_seen, count() AS n FROM cairn_events WHERE card_id = {card_id:String} AND file != '' GROUP BY repo, file ORDER BY first_seen, repo, file LIMIT 100",
    fx: (p) => [...grp(fx.events.filter((e) => e.card_id === p.card_id && e.file), 'repo\u0000file')].map(([k, r]) => ({
      repo: r[0].repo, file: r[0].file, first_seen: r.map((x) => x.ts).sort()[0], last_seen: r.map((x) => x.ts).sort().pop(), n: r.length }))
      .sort((a, b) => a.first_seen.localeCompare(b.first_seen)),
  },
  // incident_groups / incident_evidence mirror events/queries.sql (read-only)
  groups: {
    sql: "SELECT card_id, count() AS n, uniqExactIf(file, file != '') AS files, uniqExactIf(repo, repo != '') AS repos, uniqExact(actor) AS actors, min(ts) AS first_ts, max(ts) AS last_ts FROM cairn_events WHERE ts >= parseDateTime64BestEffort({cutoff:String}) GROUP BY card_id ORDER BY n DESC, card_id",
    fx: (p) => [...grp(fx.events.filter((e) => e.ts >= p.cutoff), 'card_id')].map(([card_id, r]) => ({
      card_id, n: r.length, files: new Set(r.filter((x) => x.file).map((x) => x.file)).size, repos: new Set(r.filter((x) => x.repo).map((x) => x.repo)).size,
      actors: new Set(r.map((x) => x.actor)).size, first_ts: r.map((x) => x.ts).sort()[0], last_ts: r.map((x) => x.ts).sort().pop() }))
      .sort((a, b) => b.n - a.n || a.card_id.localeCompare(b.card_id)),
  },
  evidence: {
    sql: 'SELECT ts, kind, card_id, repo, file, line, actor, tool, verdict FROM cairn_events WHERE ts >= parseDateTime64BestEffort({cutoff:String}) ORDER BY card_id, ts LIMIT 500',
    fx: (p) => fx.events.filter((e) => e.ts >= p.cutoff).sort((a, b) => a.card_id.localeCompare(b.card_id) || a.ts.localeCompare(b.ts)),
  },
};
function latest(rows) { const m = new Map(); for (const r of rows) if (!m.has(r.card_id) || m.get(r.card_id).version < r.version) m.set(r.card_id, r); return [...m.values()].sort((a, b) => a.card_id.localeCompare(b.card_id)); }
function grp(rows, key) { const m = new Map(); const ks = key.split('\u0000'); for (const r of rows) { const k = ks.map((x) => r[x]).join('\u0000'); (m.get(k) || m.set(k, []).get(k)).push(r); } return m; }
function cnt(r, k) { return r.filter((x) => x.kind === k).length; }

const cache = new Map();
let lastOk = null, lastErr = null;
async function run(name, params = {}) {
  const key = name + JSON.stringify(params), hit = cache.get(key);
  if (hit && Date.now() - hit.t < CACHE_MS) return hit.v;
  let rows;
  if (FIXTURE) rows = Q[name].fx(params);
  else {
    const sql = Q[name].sql;
    if (!/^SELECT\s/.test(sql)) throw new Error('only SELECT is allowed');
    const qs = new URLSearchParams({ default_format: 'JSONEachRow' });
    for (const [k, v] of Object.entries(params)) qs.set('param_' + k, String(v));
    try {
      const r = await fetch(CH.base + '?' + qs, { method: 'POST', headers: CH.headers, body: sql, signal: AbortSignal.timeout(CH_TIMEOUT) });
      if (!r.ok) { await r.arrayBuffer().catch(() => 0); throw new Error('ClickHouse HTTP ' + r.status); }
      const txt = await r.text();
      rows = txt.split('\n').filter(Boolean).map((l) => JSON.parse(l));
    } catch (e) { lastErr = { t: new Date(), m: e.name === 'TimeoutError' ? 'timeout' : String(e.message).slice(0, 60) }; throw e; }
  }
  lastOk = new Date();
  if (cache.size > 200) cache.clear();
  cache.set(key, { t: Date.now(), v: rows });
  return rows;
}

// ---------- html ----------
const esc = (v) => String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const MARK = '<svg class="mark" viewBox="0 0 32 32" width="34" height="34" role="img" aria-label="Cairn"><ellipse cx="16" cy="26" rx="12" ry="4.5"/><ellipse cx="16" cy="18" rx="8.5" ry="3.8" class="b"/><ellipse cx="16" cy="11.5" rx="5.5" ry="3.2"/><ellipse cx="16" cy="6" rx="3" ry="2.4" class="b"/></svg>';
const CSS = `:root{--bg:#faf8f4;--fg:#1d1b18;--mu:#6b655c;--card:#fff;--ln:#e4dfd5;--ac:#8a5a2b;--ok:#2f7d4f;--bad:#b3261e;--warn:#9a6a00}
@media(prefers-color-scheme:dark){:root{--bg:#161412;--fg:#f1ece3;--mu:#a69f93;--card:#201d1a;--ln:#363129;--ac:#d9a066;--ok:#5fc08a;--bad:#ff7b70;--warn:#e8b84a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:20px/1.5 system-ui,sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px 20px 48px}header{display:flex;align-items:center;gap:12px;margin:8px 0}
.mark{fill:var(--ac)}.mark .b{fill:var(--mu)}h1{font-size:34px;margin:0}h1 a{color:inherit;text-decoration:none}h2{font-size:26px;margin:32px 0 8px}h3{font-size:21px;margin:20px 0 4px;color:var(--ac)}
a{color:var(--ac)}.health{color:var(--mu);font-size:16px;border-top:1px solid var(--ln);border-bottom:1px solid var(--ln);padding:6px 0;margin-bottom:8px}
.demo{background:var(--warn);color:#000;font-weight:700;border-radius:4px;padding:1px 8px;font-size:15px}.err{color:var(--bad)}
table{width:100%;border-collapse:collapse;background:var(--card);font-size:17px}th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--ln);vertical-align:top;overflow-wrap:anywhere}th{color:var(--mu);font-weight:600;font-size:15px}
.box{background:var(--card);border:1px solid var(--ln);border-radius:8px;padding:12px 16px;margin:10px 0}.yes{color:var(--bad);font-weight:700}.no{color:var(--ok);font-weight:700}
.tiles{display:flex;gap:12px;flex-wrap:wrap}.tile{background:var(--card);border:1px solid var(--ln);border-radius:8px;padding:8px 16px;min-width:130px}.tile b{display:block;font-size:34px}.tile span{color:var(--mu);font-size:15px}
code{background:var(--ln);padding:0 4px;border-radius:3px;font-size:.9em}.mu{color:var(--mu)}nav a{margin-right:12px}ul,ol{padding-left:26px}li{margin:4px 0}`;

function health() {
  const f = (d) => (d ? esc(fmtTs(d).slice(0, 19)) + ' UTC' : 'never');
  return `<div class="health">Data source: <b>${esc(hostLabel)}</b>${FIXTURE ? ' <span class="demo">DEMO</span>' : ''} &middot; last refresh: ${f(lastOk)}` +
    (lastErr ? ` &middot; <span class="err">last error ${f(lastErr.t)}: ${esc(lastErr.m)}</span>` : '') + ` &middot; auto-refresh 30 s</div>`;
}
function page(title, body, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="30"><title>${esc(title)}</title><style>${CSS}</style></head><body><main><header>${MARK}<h1><a href="/">Cairn Board</a></h1><span class="mu">lessons that outlast the bug</span>${FIXTURE ? ' <span class="demo">DEMO</span>' : ''}</header>${health()}${body}</main></body></html>`;
  return { status, html };
}
// plain text from cards: "- " bullets, "1. " items, `code`; everything escaped first
function rich(t) {
  const inl = (s) => esc(s).replace(/&#96;(.+?)&#96;/g, '<code>$1</code>');
  let out = '', mode = '';
  const close = () => { if (mode) out += `</${mode}>`; mode = ''; };
  for (const line of String(t ?? '').split('\n')) {
    const b = /^\s*-\s+(.*)/.exec(line), o = /^\s*\d+\.\s+(.*)/.exec(line);
    if (b || o) { const m = b ? 'ul' : 'ol'; if (mode !== m) { close(); out += `<${m}>`; mode = m; } out += `<li>${inl((b || o)[1])}</li>`; }
    else if (line.trim()) { close(); out += `<p>${inl(line)}</p>`; } else close();
  }
  close(); return out;
}
const failed = (what) => `<p class="err">${esc(what)} unavailable right now (data source error). Retrying on refresh.</p>`;

function incidentPanel(groups, ev, win) {
  let h = `<h2>Is it one incident?</h2><nav class="mu">Window: ${Object.keys(WINDOWS).map((w) => w === win ? `<b>${w}</b>` : `<a href="/?window=${w}">${w}</a>`).join(' ')}</nav>`;
  if (!groups.length) return h + `<div class="box">No events in the last ${esc(win)}, so there is no incident to report.</div>`;
  for (const g of groups) {
    const n = num(g.n), files = num(g.files), repos = num(g.repos);
    const rows = ev.filter((r) => r.card_id === g.card_id), kinds = new Set(rows.map((r) => r.kind));
    const span = Math.round((Date.parse(String(g.last_ts).replace(' ', 'T') + 'Z') - Date.parse(String(g.first_ts).replace(' ', 'T') + 'Z')) / 1000) || 0;
    const chain = [['finding', 'a scanner flagged it'], ['agent_write', 'an agent wrote code'], ['agent_ignored_finding', 'the agent ignored the warning'], ['reintroduced', 'the bug came back after a fix']].filter(([k]) => kinds.has(k)).map((x) => x[1]);
    const one = n >= 2 && (files >= 2 || repos >= 2 || chain.length >= 2);
    let why = `same behavior card, ${n} events inside ${win}`;
    if (files >= 2) why += `, touching ${files} different files`;
    if (repos >= 2) why += ` across ${repos} repos`;
    h += `<div class="box"><b>${cardLink(g.card_id)}</b>: ${n} events, ${files} file(s), ${repos} repo(s), over ${span}s<br>` +
      (one ? `<span class="yes">YES, treat as ONE incident</span> (${esc(why)}).` + (chain.length ? `<br>Story: ${esc(chain.join('; '))}.` : '') : `<span class="no">NO, looks isolated</span> (only ${n} event, one file, no chain).`) + '</div>';
  }
  return h + '<p class="mu">Same rule as <code>cairn_log.py incident</code>: 2+ events on one card and (2+ files, or 2+ repos, or a 2+ step chain).</p>';
}
const cardLink = (id) => CARD_RE.test(String(id)) ? `<a href="/card/${esc(id)}">${esc(id)}</a>` : esc(id);
const tsShort = (t) => esc(String(t).slice(0, 19));

async function index(win) {
  const cutoff = fmtTs(new Date(Date.now() - WINDOWS[win] * 1000));
  const [cards, stats, recent, groups, ev] = await Promise.allSettled([run('cards'), run('stats'), run('recent'), run('groups', { cutoff }), run('evidence', { cutoff })]);
  const st = new Map((stats.value || []).map((s) => [s.card_id, s]));
  let h = '<h2>Cards</h2>';
  if (cards.status !== 'fulfilled') h += failed('Cards');
  else h += '<table><tr><th>Card</th><th>Class</th><th>Status</th><th>Findings</th><th>Cousins</th><th>Files</th><th>Ignored by agent</th><th>Last seen</th></tr>' +
    cards.value.map((c) => { const s = st.get(c.card_id) || {}; return `<tr><td><b>${cardLink(c.card_id)}</b><br><span class="mu">${esc(c.severity)}</span></td><td>${esc(c.class)}</td><td>${esc(c.status)} v${num(c.version)}</td><td>${num(s.findings)}</td><td>${num(s.cousins)}</td><td>${num(s.files)}</td><td>${num(s.ignored)}</td><td>${s.last_seen ? tsShort(s.last_seen) : '-'}</td></tr>`; }).join('') + '</table>';
  h += groups.status === 'fulfilled' && ev.status === 'fulfilled' ? incidentPanel(groups.value, ev.value, win) : '<h2>Is it one incident?</h2>' + failed('Incident panel');
  h += '<h2>Recent events</h2>';
  h += recent.status !== 'fulfilled' ? failed('Events') : '<table><tr><th>Time (UTC)</th><th>Kind</th><th>Card</th><th>File:line</th><th>Actor</th></tr>' +
    recent.value.map((r) => `<tr><td>${tsShort(r.ts)}</td><td>${esc(r.kind)}</td><td>${cardLink(r.card_id)}</td><td>${esc(r.file)}${num(r.line) ? ':' + num(r.line) : ''}</td><td>${esc(r.actor)}</td></tr>`).join('') + '</table>';
  return page('Cairn Board', h);
}
async function cardPage(id) {
  const [c, st, sp] = await Promise.allSettled([run('card', { card_id: id }), run('stats'), run('spread', { card_id: id })]);
  if (c.status !== 'fulfilled') return page('Cairn Board', failed('Card'), 502);
  if (!c.value.length) return page('Not found', '<h2>No such card</h2><p><a href="/">Back to all cards</a></p>', 404);
  const k = c.value[0], s = (st.value || []).find((x) => x.card_id === id) || {};
  const tile = (n, l) => `<div class="tile"><b>${n}</b><span>${l}</span></div>`;
  let h = `<p><a href="/">&larr; All cards</a></p><h2>${esc(k.card_id)}</h2><p class="mu">${esc(k.class)} &middot; severity ${esc(k.severity)} &middot; ${esc(k.status)} v${num(k.version)} &middot; created ${tsShort(k.created_at)} &middot; seed <code>${esc(k.seed)}</code></p>`;
  h += st.status === 'fulfilled' ? `<div class="tiles">${tile(num(s.findings), 'findings')}${tile(num(s.cousins), 'cousin candidates')}${tile(num(s.files), 'files affected')}${tile(num(s.ignored), 'ignored by agent')}${tile(s.first_seen ? tsShort(s.first_seen) : '-', 'first seen')}${tile(s.last_seen ? tsShort(s.last_seen) : '-', 'last seen')}</div>` : failed('Live stats');
  for (const [t, f] of [['Behavior', 'behavior'], ['Why it matters', 'why'], ['How to recognize it', 'recognize'], ['Known copies', 'known_copies'], ['Safe pattern', 'safe_pattern'], ['Verification', 'verification']]) h += `<h3>${t}</h3>${rich(k[f])}`;
  h += '<h3>Files seen in events</h3>' + (sp.status !== 'fulfilled' ? failed('File list') : sp.value.length ? '<table><tr><th>Repo</th><th>File</th><th>First seen</th><th>Last seen</th><th>Events</th></tr>' + sp.value.map((r) => `<tr><td>${esc(r.repo)}</td><td>${esc(r.file)}</td><td>${tsShort(r.first_seen)}</td><td>${tsShort(r.last_seen)}</td><td>${num(r.n)}</td></tr>`).join('') + '</table>' : '<p class="mu">No events yet.</p>');
  return page(k.card_id + ' - Cairn Board', h);
}

// ---------- server ----------
const HDR = {
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY',
};
function send(res, status, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(status, { ...HDR, 'Content-Type': type, ...extra });
  res.end(body);
}
const srv = http.createServer({ maxHeaderSize: 8192, requestTimeout: 30000, headersTimeout: 10000 }, async (req, res) => {
  let status = 500;
  try {
    if (req.method !== 'GET') { status = 405; return send(res, 405, 'Method Not Allowed', 'text/plain; charset=utf-8', { Allow: 'GET' }); }
    if (req.url.length > MAX_URL) { status = 414; return send(res, 414, 'URI Too Long', 'text/plain; charset=utf-8'); }
    const u = new URL(req.url, 'http://x'), p = u.pathname;
    let r;
    if (p === '/healthz') { status = 200; return send(res, 200, JSON.stringify({ ok: true, source: FIXTURE ? 'fixture' : 'clickhouse', lastRefresh: lastOk }), 'application/json'); }
    else if (p === '/') {
      const w = u.searchParams.get('window') || '10m';
      r = Object.hasOwn(WINDOWS, w) ? await index(w) : page('Bad request', '<h2>Bad window</h2><p>Use one of ' + Object.keys(WINDOWS).map(esc).join(', ') + '.</p>', 400);
    } else if (p.startsWith('/card/')) {
      const id = p.slice(6);
      r = CARD_RE.test(id) ? await cardPage(id) : page('Bad request', '<h2>Invalid card id</h2><p><a href="/">Back</a></p>', 400);
    } else r = page('Not found', '<h2>Not found</h2><p><a href="/">Back to Cairn Board</a></p>', 404);
    status = r.status; send(res, r.status, r.html);
  } catch (e) { status = 500; send(res, 500, 'Internal error', 'text/plain; charset=utf-8'); }
  finally { console.log(JSON.stringify({ t: new Date().toISOString(), m: String(req.method).slice(0, 8), p: String(req.url).slice(0, 80), s: status })); }
});
srv.on('clientError', (e, sock) => { try { sock.end('HTTP/1.1 431 Request Header Fields Too Large\r\nConnection: close\r\n\r\n'); } catch {} });
srv.listen(PORT, '0.0.0.0', () => console.log(`Cairn Board on :${PORT} source=${FIXTURE ? 'fixture' : hostLabel}`));
