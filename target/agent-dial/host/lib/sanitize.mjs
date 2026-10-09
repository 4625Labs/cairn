// Shared input validation. Every field that crosses a trust boundary goes through here.
const CTRL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

export const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
export const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** Printable text only: control and bidi characters removed, trimmed, capped by codepoints. */
export function clean(v, max) {
  if (typeof v !== "string") return "";
  const s = v.slice(0, max * 4 + 8).replace(CTRL, "").trim();
  const cp = Array.from(s);
  return cp.length > max ? cp.slice(0, max).join("") : s;
}

/** Shorten to `max` codepoints with an ellipsis. */
export function shorten(s, max) {
  const cp = Array.from(s);
  return cp.length <= max ? s : cp.slice(0, Math.max(0, max - 1)).join("") + "\u2026";
}

/** A session id: printable ASCII without spaces. Overlong ids keep their tail (47 chars). */
export function cleanId(v) {
  if (typeof v !== "string" || v.length === 0 || v.length > 4096) return null;
  if (!/^[\x21-\x7e]+$/.test(v)) return null;
  return v.length > 47 ? v.slice(-47) : v;
}

/** Same rule, but for ids an adapter is building itself: replace bad characters instead of failing. */
export function makeId(prefix, raw) {
  const tail = String(raw ?? "").replace(/[^\x21-\x7e]/g, "_");
  if (!tail) return null;
  return cleanId((prefix + tail).slice(-47));
}

export const CAPS = ["answer", "approve", "stop", "prompt"];
export function cleanCaps(v) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const c of v.slice(0, 32)) if (typeof c === "string" && CAPS.includes(c) && !out.includes(c)) out.push(c);
  return out;
}
