#!/usr/bin/env node
// Agent Dial hub: the one local process that owns the board, merges every adapter's sessions,
// routes answers and commands by capability, runs speech-to-text and provisions the board.
// Fork of the OpenHarness cable host (MIT, (c) 2026 Autonomous, Inc.; see LICENSE-OPENHARNESS).
//
// Trust model: the adapter socket is mode 0600 inside a 0700 directory, so only the same user
// connects. Even so, every message is validated, every field capped, and a connection may only
// act on sessions and questions it owns (a device-only message type from an adapter is ignored).
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as F from "./lib/frame.mjs";
import { redact } from "./lib/redact.mjs";
import { clean, cleanId, cleanCaps, isObj, shorten } from "./lib/sanitize.mjs";
import * as serial from "./lib/serial.mjs";

const HOME = () => process.env.AGENT_DIAL_HOME || path.join(os.homedir(), ".agent-dial");
const SOCK = () => process.env.AGENT_DIAL_SOCKET || path.join(HOME(), "hub.sock");
const SIM_SOCK = () => process.env.AGENT_DIAL_SIM_SOCKET || path.join(HOME(), "dial-sim.sock");

export const LIMITS = Object.freeze({
  id: 47, name: 39, harness: 11, turn: 60, summary: 160, q: 199, option: 79, key: 79,
  questions: 4, options: 6, sessions: 16, frame: 2000, notif: 8,
  line: 64 * 1024, conns: 64, pendingPerSession: 8, pendingTotal: 32, pcm: 16000 * 2 * 600,
});
const PROTO = 1;
const PORT = 47838;
const T = { ping: 5000, silence: 20000, foreign: 60000, release: 30000, idleExit: 5 * 60000 };

// ---------------------------------------------------------------- state
const sessions = new Map(); // id -> {id,name,harness,caps,cwd,ttl,expires,owner,active,unread}
const questions = new Map(); // `${id}\0${requestId}` -> {id,requestId,conn,msg,approval,keys}
const conns = new Set();
const monitors = new Set();
const stats = { badJson: 0, badShape: 0, unknownType: 0, oversize: 0, rejected: 0 };
let dev = null; // the attached device
let started = 0;
let lastBusy = Date.now();
let pausedUntil = 0;
let releasedUntil = 0;
let foreignUntil = 0;
let daemonMode = false;
let server = null;
let simServer = null;
let tickTimer = null;
let port = null; // serial port handle
let portPath = null;

const qkey = (id, rid) => `${id}\0${rid}`;
const now = () => Date.now();

// ---------------------------------------------------------------- device side
export function attachDevice(write) {
  if (dev) dev.attached = false;
  const d = {
    attached: true, welcomed: false, info: null, lastRx: now(), lastPing: 0, voice: null,
    decoder: null, counters: { frames: 0, unknown: 0, bad: 0, log: 0 },
    send(msg) {
      if (!d.attached) return false;
      let buf;
      try { buf = F.encodeJson(msg); } catch { return false; }
      if (buf.length - 8 >= 2048 + 200) return false; // belt and braces; callers already cap
      try { return write(buf) !== false; } catch { return false; }
    },
    feed(buf) { d.decoder.feed(buf); },
  };
  d.decoder = new F.Decoder((type, payload) => onDeviceFrame(d, type, payload));
  dev = d;
  return d;
}

function releaseDevice(d) {
  if (!d) return;
  d.attached = false;
  d.voice = null;
  if (dev === d) dev = null;
}

function onDeviceFrame(d, type, payload) {
  if (!d.attached) return;
  d.lastRx = now();
  d.counters.frames++;
  if (type === F.TYPE.LOG) {
    d.counters.log++;
    if (monitors.size) toMonitors({ t: "monitor.log", line: clean(payload.toString("utf8"), 511) });
    return;
  }
  if (type === F.TYPE.PCM) {
    const v = d.voice;
    if (!v) return;
    v.bytes += payload.length;
    if (v.bytes > LIMITS.pcm) { d.voice = null; d.send({ t: "voice.error", message: "Recording too long" }); return; }
    v.chunks.push(payload);
    return;
  }
  if (type === F.TYPE.SHOT) return;
  if (type !== F.TYPE.JSON) { d.counters.unknown++; return; }
  let m;
  try { m = JSON.parse(payload.toString("utf8")); } catch { d.counters.bad++; stats.badJson++; return; }
  if (!isObj(m) || typeof m.t !== "string") { d.counters.bad++; stats.badShape++; return; }
  if (monitors.size) toMonitors({ t: "monitor.msg", msg: m });
  try { onDeviceMsg(d, m); } catch (e) { d.counters.bad++; }
}

function onDeviceMsg(d, m) {
  switch (m.t) {
    case "hello": return onDeviceHello(d, m);
    case "pong": return;
    case "agents.list": return resync(d);
    case "focus": return; // the hub keeps no focus state
    case "agent.open": {
      const id = cleanId(m.id);
      const s = id && sessions.get(id);
      if (s && s.unread) { s.unread = ""; d.send({ t: "notif.seen", id }); }
      return;
    }
    case "answer": return onDeviceAnswer(d, m);
    case "turn.stop": {
      const s = sessions.get(cleanId(m.id) ?? "");
      if (s && s.caps.includes("stop")) sendConn(s.owner, { t: "turn.stop", id: s.id });
      return;
    }
    case "voice.begin": return voiceBegin(d, m);
    case "voice.end": return voiceEnd(d);
    case "voice.abort": d.voice = null; return;
    default:
      if (m.t.startsWith("diag.")) return; // diagnostics belong to monitors
      d.counters.unknown++; stats.unknownType++;
  }
}

function onDeviceHello(d, m) {
  if (m.product !== "agent-dial") {
    // A foreign board (Day 34's pet, upstream's harness dial, ...): leave it alone.
    releaseDevice(d);
    foreignUntil = now() + T.foreign;
    return;
  }
  const mac = typeof m.mac === "string" && /^[0-9A-Fa-f]{2}(:[0-9A-Fa-f]{2}){5}$/.test(m.mac) ? m.mac.toUpperCase() : null;
  d.info = {
    fw: clean(m.fw, 24), hw: clean(m.hw, 32), mac,
    wifi: ["none", "saved", "connected"].includes(m.wifi) ? m.wifi : "none",
    ip: typeof m.ip === "string" && /^\d{1,3}(\.\d{1,3}){3}$/.test(m.ip) ? m.ip : "",
    paired: m.paired === true,
    key: typeof m.key === "string" && /^([0-9a-f]{8}|-)$/.test(m.key) ? m.key : "-",
  };
  d.welcomed = true;
  d.send({ t: "welcome", proto: PROTO, app: "agent-dial", host: { name: clean(os.hostname(), 32) || "host" } });
  if (mac) maybePair(d, mac);
}

// ---------------------------------------------------------------- pairing
const recordPath = () => path.join(HOME(), "device.json");
function readRecord() {
  try {
    const r = JSON.parse(fs.readFileSync(recordPath(), "utf8"));
    return isObj(r) && typeof r.token === "string" && /^[0-9a-f]{64}$/.test(r.token) ? r : null;
  } catch { return null; }
}
function writeRecord(rec) {
  fs.mkdirSync(HOME(), { recursive: true, mode: 0o700 });
  const tmp = recordPath() + `.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rec) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, recordPath());
}
const keyOf = (token) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 8);

function maybePair(d, mac, force = false) {
  const info = d.info;
  const rec = readRecord();
  const hostName = `agent-dial-${mac.replace(/:/g, "").slice(-4).toLowerCase()}.local`;
  const matches = rec && info.paired && info.key === keyOf(rec.token);
  if (matches && !force) {
    if (info.ip && rec.ip !== info.ip) writeRecord({ ...rec, ip: info.ip });
    return;
  }
  const token = force || !rec ? crypto.randomBytes(32).toString("hex") : rec.token;
  try {
    writeRecord({ id: mac, ip: info.ip || rec?.ip || "", host: hostName, port: PORT, token });
  } catch { return; }
  d.send({ t: "pair", token });
}

// ---------------------------------------------------------------- roster, notifications
function agentMsg(s) { return { t: "agent", id: s.id, name: s.name, harness: s.harness, caps: s.caps }; }

function pushRoster(d = dev) {
  if (!d?.attached) return;
  d.send({ t: "agents.begin" });
  let n = 0;
  for (const s of sessions.values()) { d.send(agentMsg(s)); n++; }
  d.send({ t: "agents.end", total: n });
}

function resync(d) {
  if (!d?.attached) return;
  pushRoster(d);
  const items = [];
  for (const s of sessions.values()) {
    const q = [...questions.values()].some((x) => x.id === s.id);
    if (s.unread || q) items.push({ id: s.id, summary: s.unread, question: q });
    if (items.length >= LIMITS.notif) break;
  }
  d.send({ t: "notif.replace", items });
  for (const q of questions.values()) d.send(q.msg);
}

function toDevice(msg) { return dev?.attached ? dev.send(msg) : false; }
function toMonitors(msg) { for (const c of monitors) sendConn(c, msg); }

// ---------------------------------------------------------------- sessions
function dropSession(s, why = "bye") {
  if (!sessions.delete(s.id)) return;
  for (const q of [...questions.values()]) if (q.id === s.id) closeQuestion(q, { notifyConn: why !== "conn" });
  pushRoster();
}

function ownsSession(conn, s) { return s && s.owner === conn; }

function onHello(conn, m) {
  const id = cleanId(m.id);
  if (!id) { stats.rejected++; return; }
  let s = sessions.get(id);
  // A session held by a live, non-ttl connection cannot be taken over. A ttl session (a hook that
  // does not hold a connection open) is re-claimed by whichever hook speaks for it next.
  if (s && s.owner && s.owner !== conn && !s.ttl) { stats.rejected++; return; }
  if (!s && sessions.size >= LIMITS.sessions) { stats.rejected++; return; }
  const cwd = clean(m.cwd, 120);
  const harness = clean(m.harness, LIMITS.harness) || clean(id.split(":")[0], LIMITS.harness) || "cli";
  const name = clean(m.name, LIMITS.name) || clean(path.basename(cwd), LIMITS.name) || clean(id, LIMITS.name);
  const caps = cleanCaps(m.caps);
  const ttl = typeof m.ttl === "number" && Number.isFinite(m.ttl) && m.ttl > 0 ? Math.min(m.ttl, 86400) : 0;
  const changed = !s || s.name !== name || s.harness !== harness || s.caps.join() !== caps.join();
  if (!s) { s = { id, unread: "" }; sessions.set(id, s); }
  Object.assign(s, { name, harness, caps, cwd, ttl, owner: conn, active: now(), expires: ttl ? now() + ttl * 1000 : 0 });
  if (changed) pushRoster();
}

function touch(s) { s.active = now(); if (s.ttl) s.expires = now() + s.ttl * 1000; }

// ---------------------------------------------------------------- questions
function buildQuestion(s, requestId, raw) {
  if (!Array.isArray(raw)) return null;
  const qs = [];
  for (const x of raw.slice(0, 16)) {
    if (qs.length >= LIMITS.questions) break;
    if (!isObj(x)) continue;
    const key = clean(x.key, LIMITS.key);
    const q = clean(x.q, LIMITS.q);
    const options = (Array.isArray(x.options) ? x.options.slice(0, 32) : [])
      .map((o) => clean(o, LIMITS.option)).filter(Boolean).slice(0, LIMITS.options);
    if (!key || !q || !options.length || qs.some((y) => y.key === key)) continue;
    qs.push({ key, q, multi: x.multi === true, options });
  }
  if (!qs.length) return null;
  const approval = qs.length === 1 && qs[0].key === "decision" && qs[0].options.join("\0") === "Allow\0Deny";
  if (!s.caps.includes(approval ? "approve" : "answer")) return null;
  const fitted = fit(s.id, requestId, qs);
  return fitted ? { approval, msg: fitted, keys: fitted.questions.map((y) => y.key) } : null;
}

const size = (m) => Buffer.byteLength(JSON.stringify(m));
/** Shorten every option, then every prompt, evenly; drop trailing questions last. */
function fit(id, requestId, qs) {
  const build = (oc, qc, n) => ({
    t: "question", id, requestId,
    questions: qs.slice(0, n).map((x) => ({ key: x.key, q: shorten(x.q, qc), multi: x.multi, options: x.options.map((o) => shorten(o, oc)) })),
  });
  for (let oc = LIMITS.option; oc >= 7; oc -= 8) { const m = build(oc, LIMITS.q, qs.length); if (size(m) < LIMITS.frame) return m; }
  for (let qc = LIMITS.q; qc >= 8; qc -= 16) { const m = build(7, qc, qs.length); if (size(m) < LIMITS.frame) return m; }
  for (let n = qs.length - 1; n >= 1; n--) { const m = build(7, 8, n); if (size(m) < LIMITS.frame) return m; }
  return null;
}

function onQuestion(conn, s, m) {
  const requestId = clean(m.requestId, LIMITS.key);
  if (!requestId || !/^[\x21-\x7e]+$/.test(requestId)) { stats.rejected++; return; }
  const built = buildQuestion(s, requestId, m.questions);
  if (!built) { stats.rejected++; return; }
  const k = qkey(s.id, requestId);
  const mine = [...questions.values()].filter((q) => q.id === s.id).length;
  if (!questions.has(k) && (mine >= LIMITS.pendingPerSession || questions.size >= LIMITS.pendingTotal)) { stats.rejected++; return; }
  questions.set(k, { id: s.id, requestId, conn, ...built });
  s.unread = s.unread || "";
  toDevice(built.msg);
}

/** Remove a question. Tell the dial, and (unless it just left) the adapter that asked. */
function closeQuestion(q, { notifyConn = true, notifyDevice = true } = {}) {
  if (!questions.delete(qkey(q.id, q.requestId))) return;
  const msg = { t: "question.close", id: q.id, requestId: q.requestId };
  if (notifyDevice) toDevice(msg);
  if (notifyConn) sendConn(q.conn, msg);
}

function onDeviceAnswer(d, m) {
  const id = cleanId(m.id);
  const rid = typeof m.requestId === "string" ? m.requestId : "";
  const q = id && questions.get(qkey(id, rid));
  if (!q || !isObj(m.answers)) return;
  const s = sessions.get(id);
  if (!s || !s.caps.includes(q.approval ? "approve" : "answer")) return;
  const entries = [];
  for (const k of q.keys) {
    if (!Object.prototype.hasOwnProperty.call(m.answers, k)) continue;
    const v = m.answers[k]; // strings only
    if (typeof v !== "string") continue;
    const val = clean(v, 600);
    if (q.approval && val !== "Allow" && val !== "Deny") continue;
    entries.push([k, val]);
  }
  if (!entries.length) return;
  questions.delete(qkey(id, rid));
  touch(s);
  sendConn(q.conn, { t: "answer", id, requestId: rid, answers: Object.fromEntries(entries) });
}

// ---------------------------------------------------------------- adapter side
function sendConn(conn, msg) {
  if (!conn || conn.destroyed || !conn.writable) return false;
  try { return conn.write(JSON.stringify(msg) + "\n"); } catch { return false; }
}

const ADAPTER_TYPES = new Set(["hello", "turn.started", "turn.done", "turn.error", "summary", "question", "question.close", "bye"]);

function onAdapterMsg(conn, m) {
  if (!isObj(m) || typeof m.t !== "string") { stats.badShape++; return; }
  lastBusy = now();
  if (!ADAPTER_TYPES.has(m.t)) return onDiag(conn, m);
  if (m.t === "hello") return onHello(conn, m);
  const id = cleanId(m.id);
  const s = id && sessions.get(id);
  if (!s || !ownsSession(conn, s)) { stats.rejected++; return; }
  touch(s);
  switch (m.t) {
    case "turn.started": s.unread = ""; toDevice({ t: "turn.started", id, text: clean(redact(clean(m.text, 4096)), LIMITS.turn) }); break;
    case "turn.done": toDevice({ t: "turn.done", id }); break;
    case "turn.error": toDevice({ t: "turn.error", id, message: clean(redact(clean(m.message, 4096)), LIMITS.turn) }); break;
    case "summary": {
      const text = clean(redact(clean(m.text, 4096)), LIMITS.summary);
      s.unread = text;
      toDevice({ t: "summary", id, text });
      break;
    }
    case "question": onQuestion(conn, s, m); break;
    case "question.close": {
      const q = questions.get(qkey(id, typeof m.requestId === "string" ? m.requestId : ""));
      if (q) closeQuestion(q);
      break;
    }
    case "bye": dropSession(s); break;
  }
}

function onConnClosed(conn) {
  conns.delete(conn);
  monitors.delete(conn);
  for (const q of [...questions.values()]) if (q.conn === conn) closeQuestion(q, { notifyConn: false });
  for (const s of [...sessions.values()]) {
    if (s.owner !== conn) continue;
    if (s.ttl) { s.owner = null; s.expires = now() + s.ttl * 1000; } // outlives its connection, then expires
    else dropSession(s, "conn");
  }
  lastBusy = now();
}

// ---- hub-only diagnostics, from any adapter-side socket client (same user only)
const RAW_OK = /^(diag\.|toast$|focus$|ping$)/;
function onDiag(conn, m) {
  switch (m.t) {
    case "status": sendConn(conn, statusMsg()); break;
    case "release": releasedUntil = now() + T.release; closePort(); sendConn(conn, { t: "released", seconds: T.release / 1000 }); break;
    case "pause": {
      const sec = typeof m.seconds === "number" && m.seconds > 0 ? Math.min(m.seconds, 3600) : 60;
      pausedUntil = now() + sec * 1000; closePort(); sendConn(conn, { t: "paused", seconds: sec }); break;
    }
    case "resume": pausedUntil = 0; releasedUntil = 0; sendConn(conn, { t: "resumed" }); break;
    case "monitor": monitors.add(conn); sendConn(conn, { t: "monitor.on" }); break;
    case "raw":
      if (isObj(m.msg) && typeof m.msg.t === "string" && RAW_OK.test(m.msg.t)) sendConn(conn, { t: "raw.result", ok: toDevice(m.msg) });
      else sendConn(conn, { t: "raw.result", ok: false });
      break;
    case "pair": {
      const mac = dev?.info?.mac;
      if (mac) { maybePair(dev, mac, true); sendConn(conn, { t: "pair.result", ok: true }); } else sendConn(conn, { t: "pair.result", ok: false, message: "No board attached" });
      break;
    }
    case "forget":
      if (dev?.attached) { dev.send({ t: "forget" }); try { fs.rmSync(recordPath(), { force: true }); } catch {} sendConn(conn, { t: "forget.result", ok: true }); }
      else sendConn(conn, { t: "forget.result", ok: false, message: "No board attached" });
      break;
    case "wifi": return provisionWifi(conn, m);
    default: stats.unknownType++;
  }
}

function provisionWifi(conn, m) {
  const reply = (ok, message) => sendConn(conn, { t: "wifi.result", ok, ...(message ? { message } : {}) });
  if (!dev?.attached) return reply(false, "No board attached");
  const ssid = clean(m.ssid, 32);
  const pass = typeof m.pass === "string" && m.pass.length <= 63 ? m.pass : null; // never logged or echoed
  const send = (s, p) => reply(dev.send({ t: "wifi", ssid: s, pass: p }));
  if (!ssid) return reply(false, "ssid required");
  if (pass !== null) return send(ssid, pass);
  if (process.platform !== "darwin") return reply(false, "pass required");
  execFile("security", ["find-generic-password", "-D", "AirPort network password", "-a", ssid, "-w"], { timeout: 30000 }, (err, out) => {
    if (err) return reply(false, "Keychain has no password for that network");
    send(ssid, out.replace(/\n$/, ""));
  });
}

export function statusMsg() {
  return {
    t: "status", proto: PROTO, pid: process.pid, uptime: Math.round((now() - started) / 1000),
    device: dev?.attached ? { attached: true, welcomed: dev.welcomed, ...(dev.info ? { fw: dev.info.fw, hw: dev.info.hw, wifi: dev.info.wifi, paired: dev.info.paired } : {}), counters: dev.counters } : { attached: false },
    port: portPath, paused: pausedUntil > now(), released: releasedUntil > now(),
    sessions: [...sessions.values()].map((s) => ({ id: s.id, name: s.name, harness: s.harness, caps: s.caps, ttl: s.ttl || undefined, live: !!s.owner })),
    questions: [...questions.values()].map((q) => ({ id: q.id, requestId: q.requestId, approval: q.approval })),
    stats: { ...stats }, clients: conns.size,
  };
}

// ---------------------------------------------------------------- voice
function voiceBegin(d, m) {
  const id = m.id === undefined ? "" : cleanId(m.id) ?? "?";
  const lang = typeof m.lang === "string" && /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/.test(m.lang) ? m.lang : "en";
  d.voice = { id, lang, chunks: [], bytes: 0 };
}

function pickVoiceTarget(id) {
  if (id === "?") return null;
  if (id) { const s = sessions.get(id); return s?.caps.includes("prompt") && s.owner ? s : null; }
  let best = null;
  for (const s of sessions.values()) if (s.caps.includes("prompt") && s.owner && (!best || s.active >= best.active)) best = s;
  return best;
}

function wav(pcm) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const shq = (s) => (/^[A-Za-z0-9_.\/:-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

function voiceEnd(d) {
  const v = d.voice;
  d.voice = null;
  if (!v) return;
  const target = pickVoiceTarget(v.id);
  if (!target) return void d.send({ t: "voice.error", message: "No agent to send that to" });
  const template = process.env.AGENT_DIAL_STT;
  if (!template) return void d.send({ t: "voice.error", message: "Set AGENT_DIAL_STT on your computer" });
  let dir, file;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-dial-stt-"));
    file = path.join(dir, "take.wav");
    fs.writeFileSync(file, wav(Buffer.concat(v.chunks)), { mode: 0o600 });
  } catch { return void d.send({ t: "voice.error", message: "Couldn't record" }); }
  const cmd = template.replaceAll("{wav}", shq(file)).replaceAll("{lang}", shq(v.lang));
  execFile("sh", ["-c", cmd], { timeout: 60000, maxBuffer: 64 * 1024, env: process.env }, (err, out) => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    if (!d.attached) return;
    if (err) return void d.send({ t: "voice.error", message: "Transcription failed" });
    const text = clean(String(out).replace(/\s+/g, " "), 500);
    if (!text) return void d.send({ t: "voice.error", message: "Didn't catch that" });
    const s = sessions.get(target.id);
    if (!s || !s.owner || !sendConn(s.owner, { t: "turn.send", id: s.id, text })) return void d.send({ t: "voice.error", message: "No agent to send that to" });
    touch(s);
    d.send({ t: "voice.transcript", id: s.id, text: clean(text, LIMITS.summary) });
  });
}

// ---------------------------------------------------------------- periodic work
export function tick() {
  const t = now();
  let changed = false;
  for (const s of [...sessions.values()]) {
    if (s.ttl && !s.owner && s.expires <= t) {
      sessions.delete(s.id); changed = true;
      for (const q of [...questions.values()]) if (q.id === s.id) closeQuestion(q);
    }
  }
  if (changed) pushRoster();
  if (dev?.attached) {
    if (dev.welcomed && t - dev.lastPing >= T.ping) { dev.lastPing = t; dev.send({ t: "ping" }); }
    if (port && t - dev.lastRx > T.silence) closePort(); // reopen after silence
  }
  if (daemonMode && !conns.size && !dev?.attached && t - lastBusy > T.idleExit) shutdown(0);
}

function closePort() {
  if (port) { try { port.close(); } catch {} port = null; }
  if (dev && portPath) releaseDevice(dev);
  portPath = null;
}

function scanSerial() {
  const mode = process.env.AGENT_DIAL_PORT;
  if (mode === "none" || mode === "sim") return;
  const t = now();
  if (port || t < pausedUntil || t < releasedUntil || t < foreignUntil) return;
  let target = null;
  if (mode) target = fs.existsSync(mode) ? mode : null;
  else if (serial.boardPresent()) target = serial.candidatePorts()[0] ?? null;
  if (!target) return;
  try {
    const handle = serial.openPort(target, {
      onData: (b) => dev?.feed(b),
      onClose: () => { if (port === handle) { port = null; portPath = null; if (dev) releaseDevice(dev); } },
    });
    port = handle; portPath = target;
    attachDevice((buf) => handle.write(buf));
  } catch { port = null; portPath = null; }
}

// ---------------------------------------------------------------- sockets
function acceptAdapter(sock) {
  if (conns.size >= LIMITS.conns) { sock.destroy(); return; }
  conns.add(sock);
  sock.setEncoding("utf8");
  let buf = "";
  let dropping = false;
  sock.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (dropping) { dropping = false; continue; } // tail of an oversized line
      if (!line.trim()) continue;
      let m;
      try { m = JSON.parse(line); } catch { stats.badJson++; continue; }
      try { onAdapterMsg(sock, m); } catch { stats.badShape++; }
    }
    if (buf.length > LIMITS.line) { stats.oversize++; buf = ""; dropping = true; } // oversized line: skip to the next newline
  });
  sock.on("error", () => {});
  sock.on("close", () => onConnClosed(sock));
}

function listenUnix(p, handler) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(handler);
    srv.once("error", reject);
    srv.listen(p, () => { try { fs.chmodSync(p, 0o600); } catch {} resolve(srv); });
  });
}

async function claimSocket(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  if (!fs.existsSync(p)) return true;
  const alive = await new Promise((res) => {
    const c = net.createConnection(p);
    c.once("connect", () => { c.destroy(); res(true); });
    c.once("error", () => res(false));
  });
  if (alive) return false;
  fs.rmSync(p, { force: true });
  return true;
}

export async function main({ daemon = false } = {}) {
  daemonMode = daemon;
  started = now(); lastBusy = now();
  const p = SOCK();
  if (!(await claimSocket(p))) { if (daemon) process.exit(0); return null; }
  server = await listenUnix(p, acceptAdapter);
  if (process.env.AGENT_DIAL_PORT === "sim") {
    const sp = SIM_SOCK();
    await claimSocket(sp);
    simServer = await listenUnix(sp, (sock) => {
      const d = attachDevice((buf) => sock.write(buf));
      sock.on("data", (b) => d.feed(b));
      sock.on("error", () => {});
      sock.on("close", () => releaseDevice(d));
    });
  }
  tickTimer = setInterval(() => { try { tick(); scanSerial(); } catch {} }, 1000);
  tickTimer.unref();
  scanSerial();
  return server;
}

export function shutdown(code = 0) {
  clearInterval(tickTimer);
  closePort();
  for (const c of conns) c.destroy();
  try { server?.close(); } catch {}
  try { simServer?.close(); } catch {}
  try { fs.rmSync(SOCK(), { force: true }); } catch {}
  if (code !== null) process.exit(code);
}

if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.on("uncaughtException", (e) => { try { console.error("agent-dial hub:", e?.message); } catch {} });
  process.on("SIGTERM", () => shutdown(0));
  process.on("SIGINT", () => shutdown(0));
  main({ daemon: true }).then(() => { if (process.stdout.isTTY) console.log(`agent-dial hub listening on ${SOCK()}`); });
}
