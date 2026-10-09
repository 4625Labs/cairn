#!/usr/bin/env python3
"""Generate deploy.yaml (Akash SDL) for the Cairn Board. No secrets are ever written.
Usage: python3 cairn/akash/board/make_sdl.py [--plain]   (--plain = base64 only, no gzip; bigger)
"""
import base64, gzip, io, pathlib, sys
HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SRC = ROOT / "app" / "server.mjs"
ENVF = ROOT / ".env.clickhouse"
OUT = HERE / "deploy.yaml"
plain = "--plain" in sys.argv

data = SRC.read_bytes()
if plain:
    b64 = base64.b64encode(data).decode()
    cmd = f"echo {b64} | base64 -d > /srv/server.mjs && node /srv/server.mjs"
else:
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", mtime=0, compresslevel=9) as g:
        g.write(data)
    b64 = base64.b64encode(buf.getvalue()).decode()
    cmd = f"echo {b64} | base64 -d | gunzip > /srv/server.mjs && node /srv/server.mjs"

sdl = f'''---
version: "2.0"
# Cairn Board. The provider can read this whole file: NO real secrets here.
# Replace the three CLICKHOUSE_* values in the Akash Console form at deploy time.
services:
  board:
    image: node:22-alpine
    command:
      - "sh"
      - "-c"
    args:
      - "{cmd}"
    env:
      - PORT=8080
      - DATA_SOURCE=clickhouse
      - CLICKHOUSE_URL=https://REPLACE_WITH_CLICKHOUSE_HOST:8443
      - CLICKHOUSE_USER=cairn_ro
      - CLICKHOUSE_PASSWORD=REPLACE_WITH_READONLY_PASSWORD
    expose:
      - port: 8080
        as: 80
        to:
          - global: true
profiles:
  compute:
    board:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          size: 512Mi
  placement:
    akash:
      pricing:
        board:
          denom: uact
          amount: 100
deployment:
  board:
    akash:
      profile: board
      count: 1
'''

# secret guard: refuse if any value from .env.clickhouse appears in the output
if ENVF.exists():
    for line in ENVF.read_text().splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        k, v = line.split("=", 1)
        v = v.strip().strip('"').strip("'")
        if len(v) >= 4 and v in sdl:
            sys.exit(f"REFUSING: a value from .env.clickhouse (key {k.strip()}) appears in the SDL; not writing.")
OUT.write_text(sdl)
print(f"wrote {OUT} ({len(sdl)} bytes; command arg {len(cmd)} bytes; server.mjs {len(data)} bytes; mode={'plain' if plain else 'gzip'})")
