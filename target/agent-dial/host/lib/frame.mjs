// Agent Dial USB frame codec (SPEC.md "USB"). Derived from the format description and
// upstream OpenHarness cableFrame.ts (MIT, (c) 2026 Autonomous, Inc.; see LICENSE-OPENHARNESS).
//   A5 45 | ver:u8 = 1 | type:u8 | len:u16 LE | payload[len] | crc16:u16 LE
export const MAGIC = Buffer.from([0xa5, 0x45]);
export const VERSION = 1;
export const MAX_PAYLOAD = 8192;
export const TYPE = Object.freeze({ JSON: 1, PCM: 2, LOG: 4, SHOT: 5 });

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, no final xor. */
export function crc16(buf) {
  let crc = 0xffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

export function encode(type, payload) {
  if (!Number.isInteger(type) || type < 0 || type > 255) throw new RangeError("frame type must be a byte");
  const p = Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? []);
  if (p.length > MAX_PAYLOAD) throw new RangeError(`payload ${p.length} exceeds ${MAX_PAYLOAD}`);
  const out = Buffer.alloc(p.length + 8);
  out[0] = 0xa5; out[1] = 0x45; out[2] = VERSION; out[3] = type;
  out.writeUInt16LE(p.length, 4);
  p.copy(out, 6);
  out.writeUInt16LE(crc16(out.subarray(2, 6 + p.length)), 6 + p.length);
  return out;
}

export function encodeJson(obj) {
  return encode(TYPE.JSON, Buffer.from(JSON.stringify(obj), "utf8"));
}

/**
 * Streaming decoder. Feed it arbitrary byte chunks; it calls onFrame(type, payloadBuffer).
 * Resync: bytes before a magic are discarded and counted; a trailing A5 is kept; a length over
 * 8192 or a CRC mismatch drops one byte and resumes the hunt; a full buffer drops its oldest byte.
 */
export class Decoder {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.buf = Buffer.alloc(0);
    this.discarded = 0;
    this.corrupt = 0;
    this.frames = 0;
  }
  #drop(n) { this.buf = this.buf.subarray(n); this.discarded += n; }
  feed(data) {
    if (!Buffer.isBuffer(data)) data = Buffer.from(data);
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : Buffer.from(data);
    for (;;) {
      const b = this.buf;
      if (!b.length) break;
      const i = b.indexOf(MAGIC);
      if (i < 0) { this.#drop(b.length - (b[b.length - 1] === 0xa5 ? 1 : 0)); break; }
      if (i > 0) { this.#drop(i); continue; }
      if (b.length < 6) break;
      const n = b.readUInt16LE(4);
      if (n > MAX_PAYLOAD) { this.#drop(1); continue; }
      if (b.length < n + 8) break;
      if (crc16(b.subarray(2, 6 + n)) !== b.readUInt16LE(6 + n)) { this.corrupt++; this.#drop(1); continue; }
      const payload = Buffer.from(b.subarray(6, 6 + n));
      const type = b[3];
      this.buf = b.subarray(n + 8);
      this.frames++;
      try { this.onFrame(type, payload); } catch { /* a handler bug must not wedge the stream */ }
    }
    if (this.buf.length > 2 * (MAX_PAYLOAD + 8)) this.#drop(1);
  }
}
