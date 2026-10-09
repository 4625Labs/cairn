#!/usr/bin/env python3
"""Generate deploy.yaml: rules (tar.gz) + run.sh inlined as base64. No secrets anywhere."""
import base64, io, os, tarfile, sys
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.abspath(os.path.join(HERE, "../../.."))
CLONE_URL = "https://github.com/chantastic/esptember.git"
SLEEP = 1800
buf = io.BytesIO()
with tarfile.open(fileobj=buf, mode="w:gz") as t:
    for n in sorted(os.listdir(os.path.join(ROOT, "cairn/rules"))):
        if n.endswith(".yml"):
            ti = tarfile.TarInfo("rules/" + n); d = open(os.path.join(ROOT, "cairn/rules", n), "rb").read()
            ti.size = len(d); ti.mtime = 0; t.addfile(ti, io.BytesIO(d))
rules = base64.b64encode(buf.getvalue()).decode()
run = base64.b64encode(open(os.path.join(HERE, "run.sh"), "rb").read()).decode()
cmd = (f"mkdir -p /tmp/w && cd /tmp/w && echo {rules} | base64 -d | tar xz && echo {run} | base64 -d > run.sh && "
       f"RULES_DIR=/tmp/w/rules CLONE_URL={CLONE_URL} SCAN_ID=akash-esptember SLEEP_SECS={SLEEP} sh run.sh")
assert "'" not in cmd and '"' not in cmd
sdl = f'''---
version: "2.0"
services:
  scanner:
    image: semgrep/semgrep:1.180.0
    command:
      - "sh"
      - "-c"
    args:
      - "{cmd}"
    expose:
      - port: 8080
        as: 80
        to:
          - global: true
profiles:
  compute:
    scanner:
      resources:
        cpu:
          units: 0.5
        memory:
          size: 512Mi
        storage:
          size: 1Gi
  placement:
    akash:
      pricing:
        scanner:
          denom: uact
          amount: 100
deployment:
  scanner:
    akash:
      profile: scanner
      count: 1
'''
open(os.path.join(HERE, "deploy.yaml"), "w").write(sdl)
print("wrote deploy.yaml", len(sdl), "bytes")
