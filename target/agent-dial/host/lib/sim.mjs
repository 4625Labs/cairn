// Simulated dial: a fake device that speaks the real frame protocol over a unix socket, so the
// whole approve/deny round trip can be demonstrated and tested without the hardware.
// Start the hub with AGENT_DIAL_PORT=sim, then run `agent-dial sim` (or use createSim()).
import net from "node:net";
import * as F from "./frame.mjs";
import { isObj } from "./sanitize.mjs";

/**
 * choose(question) -> answers object | null.  `question` is the hub's `question` message.
 * Returns {close(), events, questions, agents, send(msg)}.
 */
export function createSim({ socketPath, choose = null, delayMs = 150, log = () => {}, mac = "AA:BB:CC:DD:00:01", ip = "" }) {
  const sim = { events: [], questions: new Map(), agents: [], toasts: [], connected: false, welcomed: false };
  const sock = net.createConnection(socketPath);
  const send = (m) => { try { sock.write(F.encodeJson(m)); } catch {} };
  sim.send = send;
  const hello = () => send({ t: "hello", product: "agent-dial", proto: 1, hw: "m5stack-stopwatch", mac, fw: "sim", wifi: "none", ip, paired: true, key: "-" });
  const dec = new F.Decoder((type, p) => {
    if (type !== F.TYPE.JSON) return;
    let m; try { m = JSON.parse(p.toString("utf8")); } catch { return; }
    if (!isObj(m) || typeof m.t !== "string") return;
    sim.events.push(m);
    switch (m.t) {
      case "welcome": sim.welcomed = true; send({ t: "agents.list" }); break;
      case "ping": send({ t: "pong" }); break;
      case "agents.begin": sim.agents = []; break;
      case "agent": sim.agents.push(m); break;
      case "question": {
        sim.questions.set(`${m.id}\0${m.requestId}`, m);
        log(`QUESTION [${m.id}] ${m.questions.map((q) => `${q.q} (${q.options.join(" / ")})`).join("; ")}`);
        const answers = choose?.(m);
        if (answers) setTimeout(() => { send({ t: "answer", id: m.id, requestId: m.requestId, answers }); sim.questions.delete(`${m.id}\0${m.requestId}`); log(`ANSWER ${JSON.stringify(answers)}`); }, delayMs);
        break;
      }
      case "question.close": sim.questions.delete(`${m.id}\0${m.requestId}`); log(`CLOSED ${m.id} ${m.requestId}`); break;
      case "turn.started": log(`[${m.id}] working: ${m.text}`); break;
      case "summary": log(`[${m.id}] summary: ${m.text}`); break;
      case "turn.error": log(`[${m.id}] error: ${m.message}`); break;
      case "toast": case "voice.error": sim.toasts.push(m); log(`toast: ${m.text ?? m.message}`); break;
      default: break;
    }
  });
  sock.on("connect", () => { sim.connected = true; hello(); });
  sock.on("data", (b) => dec.feed(b));
  sock.on("error", () => {});
  sock.on("close", () => { sim.connected = false; });
  const timer = setInterval(hello, 2000); timer.unref();
  sim.close = () => { clearInterval(timer); sock.destroy(); };
  sim.pick = (q, option) => send({ t: "answer", id: q.id, requestId: q.requestId, answers: { [q.questions[0].key]: option } });
  return sim;
}

/** Choice policy from a CLI word: allow | deny | first | last | <literal option text>. */
export function policy(word) {
  if (!word) return null;
  return (q) => {
    const out = {};
    for (const x of q.questions) {
      const w = word.toLowerCase();
      const hit = x.options.find((o) => o.toLowerCase() === w);
      out[x.key] = hit ?? (w === "last" ? x.options.at(-1) : x.options[0]);
    }
    return out;
  };
}
