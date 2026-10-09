#!/usr/bin/env node
// End-to-end without hardware: real hub process + simulated dial + real CLI processes,
// plus hostile-input checks. Usage: node host/test/sim_roundtrip.mjs
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import http from "node:http";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createSim } from "../lib/sim.mjs";
import * as F from "../lib/frame.mjs";

const HOST = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "ad-sim-"));
const env = { ...process.env, AGENT_DIAL_HOME: TMP, AGENT_DIAL_SOCKET: path.join(TMP, "hub.sock"), AGENT_DIAL_PORT: "sim", AGENT_DIAL_NO_SPAWN: "1" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let checks = 0;
const ok = (c, m) => { assert.ok(c, m); checks++; };
const eq = (a, b, m) => { assert.deepEqual(a, b, m); checks++; };

const hub = spawn(process.execPath, [path.join(HOST, "hub.mjs")], { env, stdio: "ignore" });
for (let i = 0; i < 100 && !fs.existsSync(path.join(TMP, "dial-sim.sock")); i++) await sleep(30);

function run(args, { input, timeout = 15000, e = env } = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HOST, "bin", "agent-dial.mjs"), ...args], { env: e });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d)); p.stderr.on("data", (d) => (err += d));
    if (input !== undefined) p.stdin.end(input); else p.stdin.end();
    const to = setTimeout(() => p.kill(), timeout);
    p.on("close", (code) => { clearTimeout(to); resolve({ code, out: out.trim(), err }); });
  });
}
const rawConn = () => new Promise((r) => { const s = net.createConnection(env.AGENT_DIAL_SOCKET); s.on("error", () => {}); s.once("connect", () => r(s)); });
const status = async () => JSON.parse((await run(["status"])).out);

try {
  const sim = createSim({ socketPath: path.join(TMP, "dial-sim.sock"), choose: (q) => ({ [q.questions[0].key]: q.questions[0].options.at(-1) }), delayMs: 100 });
  for (let i = 0; i < 100 && !sim.welcomed; i++) await sleep(30);
  ok(sim.welcomed, "simulated dial got a welcome");

  // 1. ask: option round trip (the sim picks the last option)
  let r = await run(["ask", "Deploy to prod?", "--options", "Yes,No,Later"]);
  eq([r.code, r.out], [0, "Later"], "ask prints the chosen option and exits 0");
  r = await run(["ask", "Pick", "A", "B"]);
  eq([r.code, r.out], [0, "B"], "positional options");
  // 2. approval: deny -> exit 1, allow -> exit 0
  r = await run(["ask", "--approve", "rm -rf build?"]);
  eq([r.code, r.out], [1, "Deny"], "approve + deny");
  sim.close();
  const sim2 = createSim({ socketPath: path.join(TMP, "dial-sim.sock"), choose: (q) => ({ [q.questions[0].key]: "Allow" }), delayMs: 100 });
  for (let i = 0; i < 100 && !sim2.welcomed; i++) await sleep(30);
  r = await run(["ask", "--approve", "rm -rf build?"]);
  eq([r.code, r.out], [0, "Allow"], "approve + allow");
  // 3. timeout and no-dial exit codes
  const noAnswer = createSim({ socketPath: path.join(TMP, "dial-sim.sock"), choose: null });
  sim2.close();
  for (let i = 0; i < 50; i++) await sleep(30);
  r = await run(["ask", "--timeout", "1", "Anyone?"]);
  eq(r.code, 4, "ask --timeout exits 4");
  r = await run(["ask", "x"], { e: { ...env, AGENT_DIAL_SOCKET: path.join(TMP, "none.sock") } });
  eq(r.code, 3, "no hub -> exit 3");
  noAnswer.close();
  // 4. Claude hook through the CLI process, dial allows
  const sim3 = createSim({ socketPath: path.join(TMP, "dial-sim.sock"), choose: (q) => ({ decision: "Allow" }), delayMs: 100 });
  for (let i = 0; i < 100 && !sim3.welcomed; i++) await sleep(30);
  r = await run(["claude", "PermissionRequest"], { input: JSON.stringify({ session_id: "s1", cwd: "/w/app", tool_name: "Bash", tool_input: { command: "ls API_KEY=abc" } }) });
  eq(JSON.parse(r.out), { hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } }, "claude hook allow through the sim dial");
  const asked = sim3.events.findLast((m) => m.t === "question");
  ok(asked && !asked.questions[0].q.includes("abc"), "hook question redacted");
  r = await run(["claude", "Stop"], { input: "not json" });
  eq(r.code, 0, "garbage hook input exits 0");
  r = await run(["claude", "PermissionRequest"], { input: JSON.stringify({ session_id: "s1" }), e: { ...env, AGENT_DIAL_SOCKET: path.join(TMP, "none.sock") } });
  eq([r.code, r.out], [0, ""], "hook with no hub: no decision, exit 0");
  // 5. event
  r = await run(["event", "summary", "--id", "nightly", "--text", "built TOKEN=zzz ok"]);
  await sleep(100);
  const sm = sim3.events.findLast((m) => m.t === "summary");
  eq([r.code, sm?.id, sm?.text], [0, "cli:nightly", "built TOKEN=[redacted] ok"], "event summary, redacted");

  // 6. hostile input to the adapter socket: the hub must survive and stay correct
  const s = await rawConn();
  const junk = ["null", "42", '"str"', "[]", "[1,2]", "{}", '{"t":5}', '{"t":null}', '{"t":"hello"}', '{"t":"hello","id":7}', '{"t":"hello","id":{"a":1}}',
    '{"t":"hello","id":"x:1","caps":"approve"}', '{"t":"hello","id":"x:2","caps":[1,null,{}],"name":{"a":1},"harness":[]}', '{"t":"question","id":"x:2"}',
    '{"t":"question","id":"x:2","requestId":9,"questions":"no"}', '{"t":"question","id":"x:2","requestId":"r","questions":[null,1,"a",{"key":1,"q":2,"options":3}]}',
    '{"t":"turn.started","id":"x:2","text":{"a":1}}', '{"t":"summary","id":"x:2","text":12}', '{"t":"answer","id":"x:2","requestId":"r","answers":{}}',
    '{"t":"raw","msg":{"t":"question"}}', '{"t":"raw","msg":null}', '{"t":"pause","seconds":"x"}', '{"__proto__":{"t":"hello"}}', '{"t":"hello","id":"__proto__"}',
    "{broken", "\u0000\u0001\u0002", '{"t":"hello","id":"' + "a".repeat(5000) + '"}'];
  for (const j of junk) s.write(j + "\n");
  s.write("x".repeat(200_000) + "\n"); // oversized line with no JSON
  s.write('{"t":"hello","id":"cli:after","harness":"cli","caps":["answer"]}\n');
  await sleep(300);
  const st = await status();
  ok(st.sessions.some((x) => x.id === "cli:after"), "hub still serving after hostile input");
  eq(st.sessions.map((x) => x.id).sort(), ["__proto__", "claude:s1", "cli:after", "cli:nightly", "x:1", "x:2"].sort(), "only well-formed hellos became sessions (Map-backed, so __proto__ is just a name)");
  ok(st.questions.length === 0, "no questions from junk");
  s.destroy();

  // device-side junk: bad JSON, non-object frames, oversized garbage, forged answers
  const dsock = net.createConnection(path.join(TMP, "dial-sim.sock"));
  dsock.on("error", () => {});
  await new Promise((r) => dsock.once("connect", r));
  for (const p of ["null", "7", "[]", '{"t":9}', "{bad", '{"t":"answer","id":5,"requestId":[],"answers":null}', '{"t":"voice.begin","id":{},"lang":9}', '{"t":"hello","product":"agent-dial","mac":{},"ip":5,"key":[]}'])
    dsock.write(F.encode(1, Buffer.from(p)));
  dsock.write(Buffer.alloc(30000, 0xa5));
  dsock.write(F.encode(1, Buffer.from('{"t":"answer","id":"cli:after","requestId":"nope","answers":{"k":"v"}}')));
  await sleep(300);
  ok((await status()).sessions.length >= 1, "hub survives hostile device frames");
  dsock.destroy();
  sim3.close();

  // 7. direct Wi-Fi fallback against a fake device HTTP endpoint (no hub reachable)
  const asked2 = [];
  const srv = http.createServer((req, res) => {
    let b = ""; req.on("data", (d) => (b += d));
    req.on("end", () => {
      if (req.headers.authorization !== "Bearer " + "a".repeat(64)) { res.statusCode = 401; return res.end("{}"); }
      const j = JSON.parse(b); asked2.push(...j.messages);
      const q = asked2.find((m) => m.t === "question");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, commands: q ? [{ t: "answer", id: q.id, requestId: q.requestId, answers: { choice: "Yes" } }] : [] }));
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "ad-direct-"));
  fs.writeFileSync(path.join(home2, "device.json"), JSON.stringify({ id: "x", ip: "127.0.0.1", host: "h", port: srv.address().port, token: "a".repeat(64) }), { mode: 0o600 });
  r = await run(["ask", "Direct?"], { e: { ...env, AGENT_DIAL_HOME: home2, AGENT_DIAL_SOCKET: path.join(home2, "none.sock") } });
  eq([r.code, r.out], [0, "Yes"], "ask over direct Wi-Fi (fake HTTP device)");
  srv.close(); fs.rmSync(home2, { recursive: true, force: true });

  console.log(`agent-dial sim round trip: ${checks} checks passed.`);
} catch (e) {
  console.error("FAILED:", e.message); process.exitCode = 1;
} finally {
  hub.kill(); fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
