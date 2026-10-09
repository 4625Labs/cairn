#!/usr/bin/env node
// agent-dial CLI and the Claude Code hook adapter.
//   agent-dial ask [flags] "question" [option ...]   block until the dial answers; print the choice
//   agent-dial event <type> [flags]                  report a session event (turn.started, summary, ...)
//   agent-dial claude <Event>                        Claude Code command hook (JSON on stdin)
//   agent-dial install-claude                        print the hooks JSON for ~/.claude/settings.json
//   agent-dial status | release | pair | wifi | sim
// Adapters never throw into their harness: every failure degrades to "no dial".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect, redact, socketPath } from "../lib/client.mjs";
import { clean, makeId, isObj } from "../lib/sanitize.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLAUDE_WAIT_MS = 590_000;
const detail = () => process.env.AGENT_DIAL_DETAIL !== "0";

// ---------------------------------------------------------------- Claude Code hook
function activityLine(tool, input) {
  if (!detail()) return clean(tool, 60);
  const ti = isObj(input) ? input : {};
  const file = typeof ti.file_path === "string" ? path.basename(ti.file_path) : typeof ti.path === "string" ? path.basename(ti.path) : "";
  let line;
  if (tool === "Bash" && typeof ti.command === "string") line = "$ " + ti.command;
  else if (/^(Edit|Write|MultiEdit|NotebookEdit)$/.test(tool) && file) line = "editing " + file;
  else if (tool === "Read" && file) line = "reading " + file;
  else if (typeof ti.pattern === "string") line = `${tool} ${ti.pattern}`;
  else if (typeof ti.url === "string") line = `${tool} ${ti.url}`;
  else line = tool;
  return clean(redact(clean(line, 4096)), 60);
}

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd"];

/**
 * Handle one Claude Code hook event. Returns the JSON to print (PermissionRequest only) or null.
 * Resolves null, without a decision, whenever the dial cannot decide (Claude Code then prompts).
 */
export async function claudeHook(event, input) {
  try {
    if (!isObj(input) || typeof event !== "string") return null;
    const sid = typeof input.session_id === "string" ? input.session_id : "";
    const id = makeId("claude:", sid);
    if (!id) return null;
    const cwd = typeof input.cwd === "string" ? clean(input.cwd, 120) : "";
    const hello = { t: "hello", id, name: path.basename(cwd) || "claude", harness: "claude", cwd, caps: ["approve"], ttl: 1800 };
    const conn = await connect({ budgetMs: event === "PermissionRequest" ? 1000 : 250 });
    if (!conn) return null;
    conn.send(hello);
    const tool = typeof input.tool_name === "string" ? clean(input.tool_name, 40) : "tool";
    const toolUseId = typeof input.tool_use_id === "string" && /^[\x21-\x7e]{1,79}$/.test(input.tool_use_id) ? input.tool_use_id : "";
    switch (event) {
      case "SessionStart": break;
      case "UserPromptSubmit": conn.send({ t: "turn.started", id, text: "" }); break;
      case "PreToolUse": conn.send({ t: "turn.started", id, text: activityLine(tool, input.tool_input) }); break;
      case "PostToolUse": if (toolUseId) conn.send({ t: "question.close", id, requestId: toolUseId }); break;
      case "Stop": {
        const msg = typeof input.last_assistant_message === "string" ? input.last_assistant_message : "";
        if (!detail()) conn.send({ t: "summary", id, text: "Done" });
        else if (msg.trim()) conn.send({ t: "summary", id, text: clean(redact(clean(msg, 4096)), 160) });
        else conn.send({ t: "turn.done", id });
        break;
      }
      case "SessionEnd": conn.send({ t: "bye", id }); break;
      case "PermissionRequest": return await permission(conn, id, tool, input, toolUseId);
      default: break;
    }
    await conn.end();
    return null;
  } catch { return null; }
}

async function permission(conn, id, tool, input, toolUseId) {
  const requestId = toolUseId || "perm-" + crypto.randomBytes(6).toString("hex");
  const q = `${tool}: ${activityLine(tool, input.tool_input).replace(/^\$ /, "")}`;
  return await new Promise((resolve) => {
    let over = false;
    const finish = (v) => { if (over) return; over = true; clearTimeout(timer); resolve(v); conn.close(); };
    const timer = setTimeout(() => finish(null), CLAUDE_WAIT_MS);
    conn.onclose = () => finish(null); // the hub went away: no decision, Claude Code prompts
    conn.onmessage = (m) => {
      if (m.id !== id || m.requestId !== requestId) return;
      if (m.t === "question.close") return finish(null); // answered in the terminal
      if (m.t !== "answer" || !isObj(m.answers)) return;
      const d = m.answers.decision;
      if (d === "Allow") finish({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } } });
      else if (d === "Deny") finish({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "Denied on the Agent Dial" } } });
    };
    conn.send({ t: "question", id, requestId, questions: [{ key: "decision", q: clean(redact(q), 199), options: ["Allow", "Deny"] }] });
  });
}

// ---------------------------------------------------------------- argument parsing
const BOOL = new Set(["multi", "approve", "json", "help"]);
function parseArgs(argv) {
  const flags = {}; const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") { pos.push(...argv.slice(i + 1)); break; }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const k = a.slice(2, eq < 0 ? undefined : eq);
      if (BOOL.has(k)) { flags[k] = true; continue; }
      const v = eq >= 0 ? a.slice(eq + 1) : argv[++i];
      if (v === undefined) throw new Error(`--${k} needs a value`);
      if (k === "option") (flags.option ??= []).push(v); else flags[k] = v;
    } else pos.push(a);
  }
  return { flags, pos };
}

const HELP = `agent-dial: use the Stopwatch dial from any script.

  agent-dial ask [flags] "question" [option ...]
      Opens the question on the dial and blocks. Prints the chosen option on stdout, exit 0.
      --options "A,B,C"   choices (default "Yes,No"); or pass them as extra arguments, or --option A --option B
      --approve           an Allow/Deny approval (key "decision"); exit 0 on Allow, 1 on Deny
      --multi             multi-select; answers print joined with ", "
      --key NAME          question key (default "choice")
      --id ID  --name N   session id (default cli:ask-<pid>) and display name
      --timeout SECONDS   give up (exit 4); default: wait forever
      --connect-timeout S wait this long to reach the hub or a board (default 3); exit 3 if none
      --json              print {"id","requestId","answers"} instead of the bare answer
      exit: 0 answered, 1 denied (--approve), 2 usage, 3 no dial, 4 timeout, 5 closed without an answer
  agent-dial event <turn.started|turn.done|turn.error|summary|bye> [--id ID] [--name N] [--harness H]
      [--cwd DIR] [--caps a,b] [--ttl SECONDS] [--text T | --message M]
  agent-dial claude <Event>      Claude Code hook; reads the hook JSON on stdin
  agent-dial install-claude      print the hooks JSON for Claude Code settings
  agent-dial status | release | pair | forget | wifi [--ssid S]
  agent-dial sim [--auto allow|deny|first|last|<text>] [--delay MS]
      A simulated dial for demos and tests (hub must run with AGENT_DIAL_PORT=sim).
`;

// ---------------------------------------------------------------- commands
async function cmdAsk(argv) {
  const { flags, pos } = parseArgs(argv);
  if (flags.help || !pos.length) { console.error(HELP); return 2; }
  const question = pos[0];
  let options = flags.option ?? (flags.options ? String(flags.options).split(",").map((s) => s.trim()).filter(Boolean) : pos.slice(1));
  if (!options.length) options = ["Yes", "No"];
  const approve = flags.approve === true;
  if (approve) options = ["Allow", "Deny"];
  const key = approve ? "decision" : clean(flags.key ?? "choice", 79) || "choice";
  const id = makeId("cli:", flags.id ?? `ask-${process.pid}`);
  if (!id) { console.error("bad --id"); return 2; }
  const requestId = "ask-" + crypto.randomBytes(6).toString("hex");
  const conn = await connect({ budgetMs: Math.max(0, Number(flags["connect-timeout"] ?? 3)) * 1000 });
  if (!conn) { console.error("agent-dial: no hub and no paired dial reachable"); return 3; }
  const timeoutMs = flags.timeout ? Number(flags.timeout) * 1000 : 0;
  return await new Promise((resolve) => {
    let timer;
    let over = false;
    const done = (code, out) => { if (over) return; over = true; clearTimeout(timer); if (out !== undefined) console.log(out); resolve(code); conn.close(); };
    if (timeoutMs > 0) timer = setTimeout(() => done(4), timeoutMs);
    process.once("SIGINT", () => done(130));
    process.once("SIGTERM", () => done(143));
    conn.onclose = () => done(3);
    conn.onmessage = (m) => {
      if (m.id !== id || m.requestId !== requestId) return;
      if (m.t === "question.close") return done(5);
      if (m.t !== "answer" || !isObj(m.answers) || typeof m.answers[key] !== "string") return;
      const a = m.answers[key];
      if (flags.json) return done(approve && a === "Deny" ? 1 : 0, JSON.stringify({ id, requestId, answers: m.answers }));
      done(approve && a === "Deny" ? 1 : 0, a);
    };
    conn.send({ t: "hello", id, name: clean(flags.name ?? "ask", 39) || "ask", harness: "cli", caps: [approve ? "approve" : "answer"], ttl: 0 });
    conn.send({ t: "question", id, requestId, questions: [{ key, q: question, multi: flags.multi === true, options }] });
  });
}

async function cmdEvent(argv) {
  const { flags, pos } = parseArgs(argv);
  const type = pos[0];
  if (!["turn.started", "turn.done", "turn.error", "summary", "bye"].includes(type)) { console.error(HELP); return 2; }
  const cwd = flags.cwd ?? process.cwd();
  const id = makeId("cli:", flags.id ?? path.basename(cwd));
  if (!id) { console.error("bad --id"); return 2; }
  const conn = await connect({ budgetMs: 250 });
  if (!conn) return 0; // no dial: stay quiet, the script is unaffected
  const caps = String(flags.caps ?? "").split(",").filter(Boolean);
  const ttl = Number(flags.ttl ?? 3600);
  conn.send({ t: "hello", id, name: clean(flags.name ?? path.basename(cwd), 39), harness: clean(flags.harness ?? "cli", 11), cwd, caps, ttl: ttl > 0 ? ttl : 3600 });
  if (type === "turn.started" || type === "summary") conn.send({ t: type, id, text: clean(redact(clean(flags.text ?? "", 4096)), type === "summary" ? 160 : 60) });
  else if (type === "turn.error") conn.send({ t: type, id, message: clean(redact(clean(flags.message ?? flags.text ?? "Error", 4096)), 60) });
  else conn.send({ t: type, id });
  await conn.end();
  return 0;
}

async function cmdRequest(msg, argv = []) {
  const { flags } = parseArgs(argv);
  const conn = await connect({ budgetMs: 1500, direct: false });
  if (!conn) { console.error("agent-dial: no hub running"); return 3; }
  return await new Promise((resolve) => {
    const timer = setTimeout(() => { conn.close(); resolve(4); }, 10_000);
    conn.onmessage = (m) => { if (m.t === "status" || /\.result$|^(released|paused|resumed)$/.test(m.t)) { clearTimeout(timer); console.log(JSON.stringify(m, null, 2)); conn.close(); resolve(m.ok === false ? 1 : 0); } };
    conn.onclose = () => resolve(3);
    conn.send({ ...msg, ...(flags.ssid ? { ssid: flags.ssid } : {}) });
  });
}

async function cmdSim(argv) {
  const { flags } = parseArgs(argv);
  const { createSim, policy } = await import("../lib/sim.mjs");
  const sp = process.env.AGENT_DIAL_SIM_SOCKET || path.join(process.env.AGENT_DIAL_HOME || path.join(process.env.HOME ?? "", ".agent-dial"), "dial-sim.sock");
  const sim = createSim({ socketPath: sp, choose: policy(flags.auto), delayMs: Number(flags.delay ?? 300), log: (s) => console.log(s) });
  console.log(`simulated dial on ${sp}${flags.auto ? `, auto-answering "${flags.auto}"` : " (type: <n> to pick option n of the newest question)"}`);
  if (!flags.auto && process.stdin.isTTY !== undefined) {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      const qs = [...sim.questions.values()];
      const q = qs.at(-1);
      const n = parseInt(String(d).trim(), 10);
      if (q && n >= 1 && n <= q.questions[0].options.length) sim.pick(q, q.questions[0].options[n - 1]);
    });
  }
  await new Promise(() => {});
}

function installClaude() {
  const bin = fileURLToPath(import.meta.url);
  const cmd = (e) => ({ type: "command", command: `${JSON.stringify(process.execPath)} ${JSON.stringify(bin)} claude ${e}`, ...(e === "PermissionRequest" ? { timeout: 600 } : {}) });
  const hooks = Object.fromEntries(HOOK_EVENTS.map((e) => [e, [{ ...(/Tool|Permission/.test(e) ? { matcher: "*" } : {}), hooks: [cmd(e)] }]]));
  console.log(JSON.stringify({ hooks }, null, 2));
  return 0;
}

async function readStdin(limit = 1 << 20, ms = 3000) {
  return await new Promise((resolve) => {
    let s = "";
    const to = setTimeout(() => resolve(s), ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => { s += d; if (s.length > limit) { clearTimeout(to); resolve(""); process.stdin.destroy(); } });
    process.stdin.on("end", () => { clearTimeout(to); resolve(s); });
    process.stdin.on("error", () => { clearTimeout(to); resolve(""); });
  });
}

export async function main(argv = process.argv.slice(2)) {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "ask": return await cmdAsk(rest);
      case "event": return await cmdEvent(rest);
      case "claude": {
        const ev = HOOK_EVENTS.find((e) => e.toLowerCase() === String(rest[0] ?? "").toLowerCase());
        if (!ev) return 0;
        let input = null;
        try { input = JSON.parse(await readStdin()); } catch {}
        const out = await claudeHook(ev, input);
        if (out) process.stdout.write(JSON.stringify(out) + "\n");
        return 0; // a hook must never fail the harness
      }
      case "install-claude": return installClaude();
      case "status": return await cmdRequest({ t: "status" });
      case "release": return await cmdRequest({ t: "release" });
      case "pair": return await cmdRequest({ t: "pair" });
      case "forget": return await cmdRequest({ t: "forget" });
      case "wifi": return await cmdRequest({ t: "wifi" }, rest);
      case "sim": return await cmdSim(rest);
      case "socket": console.log(socketPath()); return 0;
      default: console.error(HELP); return cmd && cmd !== "help" && cmd !== "--help" ? 2 : 0;
    }
  } catch (e) {
    console.error("agent-dial:", e?.message ?? e);
    return cmd === "claude" || cmd === "event" ? 0 : 2;
  }
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && fs.existsSync(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(self)) {
  main().then((code) => process.exit(code), () => process.exit(0));
}
