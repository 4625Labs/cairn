// Adapters' transport (SPEC.md "Adapter <-> hub", "Direct Wi-Fi"): the hub socket first (start the
// hub detached when a board is on USB), then direct Wi-Fi from device.json, otherwise nothing.
// Never throws; a missing dial costs an adapter at most `budgetMs` (default 250).
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { redact } from "./redact.mjs";
import * as serial from "./serial.mjs";
import { isObj } from "./sanitize.mjs";

export { redact };
export const home = () => process.env.AGENT_DIAL_HOME || path.join(os.homedir(), ".agent-dial");
export const socketPath = () => process.env.AGENT_DIAL_SOCKET || path.join(home(), "hub.sock");
const HUB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hub.mjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tryUnix(p, ms) {
  return new Promise((resolve) => {
    const s = net.createConnection(p);
    const to = setTimeout(() => { s.destroy(); resolve(null); }, ms);
    s.once("connect", () => { clearTimeout(to); resolve(s); });
    s.once("error", () => { clearTimeout(to); resolve(null); });
  });
}

/** Wrap a connected hub socket as {send, end, close, onmessage, onclose, kind}. */
function wrapSocket(s) {
  const c = { kind: "hub", onmessage: null, onclose: null, closed: false };
  s.setEncoding("utf8");
  s.on("error", () => {});
  let buf = "";
  s.on("data", (d) => {
    buf += d;
    if (buf.length > 1 << 20) { buf = ""; return; }
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (isObj(m) && typeof m.t === "string") try { c.onmessage?.(m); } catch {}
    }
  });
  s.on("close", () => { c.closed = true; try { c.onclose?.(); } catch {} });
  c.send = (m) => { try { return s.write(JSON.stringify(m) + "\n"); } catch { return false; } };
  c.end = () => new Promise((r) => { if (s.destroyed) return r(); s.end(() => r()); setTimeout(r, 200).unref(); });
  c.close = () => s.destroy();
  return c;
}

function readPairing() {
  try {
    const r = JSON.parse(fs.readFileSync(path.join(home(), "device.json"), "utf8"));
    if (isObj(r) && typeof r.ip === "string" && r.ip && typeof r.token === "string" && Number.isInteger(r.port)) return r;
  } catch {}
  return null;
}

/** Direct Wi-Fi: POST /v1/exchange. Messages queue and flush at once; polling picks up commands. */
function directConn(rec) {
  const client = "ad-" + crypto.randomBytes(6).toString("hex");
  const c = { kind: "wifi", onmessage: null, onclose: null, closed: false };
  let queue = [];
  let busy = false;
  let timer = null;
  let active = false; // an open question or running turn: poll every 1 s instead of 5 s
  async function exchange() {
    if (busy || c.closed) return;
    busy = true;
    const messages = queue; queue = [];
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 3000);
      const res = await fetch(`http://${rec.ip}:${rec.port}/v1/exchange`, {
        method: "POST", signal: ctl.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${rec.token}` },
        body: JSON.stringify({ client, messages }),
      });
      clearTimeout(to);
      if (res.ok) {
        const j = await res.json();
        if (isObj(j) && Array.isArray(j.commands)) for (const m of j.commands) if (isObj(m) && typeof m.t === "string") try { c.onmessage?.(m); } catch {}
      } else queue = messages.concat(queue);
    } catch { queue = messages.concat(queue); }
    busy = false;
    if (!c.closed) { clearTimeout(timer); timer = setTimeout(exchange, active ? 1000 : 5000); timer.unref?.(); }
  }
  c.send = (m) => {
    if (c.closed) return false;
    if (m.t === "question") active = true;
    if (m.t === "question.close" || m.t === "bye" || m.t === "summary") active = false;
    queue.push(m); setTimeout(exchange, 0); return true;
  };
  c.end = async () => { for (let i = 0; i < 20 && (queue.length || busy); i++) { if (!busy) await exchange(); else await sleep(25); } c.close(); };
  c.close = () => { c.closed = true; clearTimeout(timer); try { c.onclose?.(); } catch {} };
  active = false; timer = setTimeout(exchange, 1000); timer.unref?.();
  return c;
}

/** Connect to whatever is reachable within `budgetMs`; resolves null (never rejects) otherwise. */
export async function connect({ budgetMs = 250, direct = true } = {}) {
  try {
    const deadline = Date.now() + budgetMs;
    let s = await tryUnix(socketPath(), Math.max(50, budgetMs));
    if (!s && !process.env.AGENT_DIAL_NO_SPAWN && serial.boardPresent()) {
      try { spawn(process.execPath, [HUB], { detached: true, stdio: "ignore" }).unref(); } catch {}
      while (!s && Date.now() < deadline) { await sleep(25); s = await tryUnix(socketPath(), 50); }
    }
    if (s) return wrapSocket(s);
    const rec = direct ? readPairing() : null;
    if (rec) return directConn(rec);
  } catch {}
  return null;
}
