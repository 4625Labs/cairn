#!/usr/bin/env python3
"""Regression for the Day 35 'ask never reaches the question screen' bug (E7).

The hub writes agents.begin + agent + agents.end + question back to back (312 bytes for a minimal
approval, up to ~2 KB per frame). ESP32-S3 HWCDC Serial has a 256-byte RX queue unless
Serial.setRxBufferSize() runs BEFORE Serial.begin(); the tail of the burst (the question) was
dropped and the decoder only saw it as ~102 discarded bytes. Checks:
 1. the firmware sizes the RX queue before begin(), to at least one max frame plus the roster burst;
 2. the exact burst the hub emits is longer than the default 256-byte queue (so the test is meaningful)
    and decodes fully when delivered whole, using the host frame codec.
"""
import re, subprocess, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent
ino = (root / "firmware/agent_dial/agent_dial.ino").read_text()
m_rx = re.search(r"Serial\.setRxBufferSize\(\s*(\d+)\s*\)", ino)
m_begin = re.search(r"Serial\.begin\(", ino)
assert m_rx and m_begin, "setRxBufferSize/begin not found"
assert m_rx.start() < m_begin.start(), "setRxBufferSize must precede Serial.begin"
assert int(m_rx.group(1)) >= 2 * (2039 + 8), f"RX queue {m_rx.group(1)} too small for a max frame plus a burst"
# burst length: header+len+crc per frame, JSON built exactly as hub.mjs emits for `ask --approve`
js = r'''
import * as F from "%s/host/lib/frame.mjs";
const id="cli:ask-12345", requestId="ask-aabbccddeeff";
const msgs=[{t:"agents.begin"},{t:"agent",id,name:"ask",harness:"cli",caps:["approve"]},{t:"agents.end",total:1},
 {t:"question",id,requestId,questions:[{key:"decision",q:"x",multi:false,options:["Allow","Deny"]}]}];
let n=0,got=0; const d=new F.Decoder(()=>got++); const all=Buffer.concat(msgs.map(m=>F.encodeJson(m)));
n=all.length; d.feed(all); console.log(n, got);
''' % root
out = subprocess.check_output(["node", "--input-type=module", "-e", js]).decode().split()
n, got = int(out[0]), int(out[1])
assert n > 256, f"burst {n} not larger than default queue"
assert got == 4, f"decoded {got} of 4 frames"
print(f"PASS: burst {n} B > 256 B default queue; RX queue set to {m_rx.group(1)} before Serial.begin; 4/4 frames decode")
