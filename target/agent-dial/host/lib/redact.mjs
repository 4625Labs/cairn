// Redaction (SPEC.md "Redaction"): Bearer/Basic credentials, and the values of arguments or
// assignments whose key contains token, secret, password, passwd, api-key, or auth.
const KEY = String.raw`[A-Za-z0-9_.-]*?(?:token|secret|passw(?:or)?d|api[-_]?key|auth)[A-Za-z0-9_.-]*`;
const VALUE = String.raw`"[^"]*"|'[^']*'|[^\s"',;&)]+`;
const R = "[redacted]";
const MAX_IN = 4096; // bounded work: the key pattern backtracks

const RULES = [
  [/\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+\/=-]+/gi, (_, s, sp) => `${s}${sp}${R}`],
  [/(:\/\/[^\s:\/@]+:)[^\s@\/]+@/g, (_, p) => `${p}${R}@`],
  // --password hunter2   (flag, then a space-separated value)
  [new RegExp(String.raw`(--?${KEY})(\s+)(${VALUE})`, "gi"), (m, k, sp, v) => (/^(bearer|basic|\[redacted\])/i.test(v) ? m : `${k}${sp}${R}`)],
  // KEY=value, KEY: value, --key=value
  [new RegExp(String.raw`(\b${KEY})(\s*[=:]\s*)(${VALUE})`, "gi"), (m, k, sep, v) => (/^(bearer|basic|\[redacted\])/i.test(v) ? m : `${k}${sep}${quoteLike(v)}`)],
];
function quoteLike(v) {
  return v[0] === '"' ? `"${R}"` : v[0] === "'" ? `'${R}'` : R;
}

export function redact(text) {
  if (typeof text !== "string") return "";
  let s = text.length > MAX_IN ? text.slice(0, MAX_IN) : text;
  for (const [re, fn] of RULES) s = s.replace(re, fn);
  return s;
}
