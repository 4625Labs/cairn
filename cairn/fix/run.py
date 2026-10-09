#!/usr/bin/env python3
"""Cairn fix-and-gate pipeline (deterministic; a Guild agent can drive it, or run standalone).

  python3 cairn/fix/run.py --sim [--sim-answer allow|deny] [--sabotage]

Steps: sweep target/work -> log findings -> patch (portal.c SSID escape + one dependency pin)
-> apply -> re-sweep (seed gone, no NEW findings) -> C unit test -> gate -> ask the dial
-> on approval write cairn/out/pr/{cairn-fix.patch,PR.md}.  NEVER pushes or opens a PR.
Only target/work is ever modified (reset from target/seeds each run unless --keep-work).
Events go wherever events/cairn_log.py selects (set CAIRN_BACKEND=sqlite for local tests).
Exit: 0 approved+written, 2 gate refused, 3 human denied, 4 dial/ask error.
"""
import argparse, collections, difflib, hashlib, json, os, shutil, subprocess, sys, tempfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SEEDS = os.path.join(ROOT, "target", "seeds")
WORK = os.path.join(ROOT, "target", "work")
OUT = os.path.join(ROOT, "cairn", "out")
PR_DIR = os.path.join(OUT, "pr")
DIAL = os.path.join(ROOT, "target", "agent-dial", "host")
PORTAL = "drafts/chan-live-captions/firmware/main/portal.c"
MANIFEST = "days/day-01-hello-world/firmware/main/idf_component.yml"
NEIGHBOUR = "days/day-03-static-graphic/firmware/main/idf_component.yml"
SEED_CARD = "unvalidated-network-input"
REPO = "target-work"

HELPER = '''// SSIDs come from nearby radios, not from us: never trust them into HTML
// without escaping (a rogue SSID is an easy stored-XSS vector here).
static void html_escape(const char *in, size_t in_len, char *out, size_t out_len)
{
    size_t o = 0;
    if (out_len == 0) return;
    for (size_t i = 0; i < in_len && in[i]; i++) {
        const char *rep;
        switch (in[i]) {
        case '&':  rep = "&amp;";  break;
        case '<':  rep = "&lt;";   break;
        case '>':  rep = "&gt;";   break;
        case '"':  rep = "&quot;"; break;
        case '\\'': rep = "&#39;";  break;
        default:
            if (o + 1 >= out_len) goto done;
            out[o++] = in[i];
            continue;
        }
        size_t rep_len = strlen(rep);
        if (o + rep_len >= out_len) break;
        memcpy(out + o, rep, rep_len);
        o += rep_len;
    }
done:
    out[o] = 0;
}

'''

def say(*a):
    print(*a, flush=True)

def log_events(rows):
    """Append rows through events/cairn_log.py (backend chosen by the environment)."""
    if not rows:
        return
    p = subprocess.run([sys.executable, os.path.join(ROOT, "events", "cairn_log.py"), "append"],
                       input="\n".join(json.dumps(r) for r in rows) + "\n", capture_output=True, text=True)
    if p.returncode:
        sys.exit("event log failed: " + (p.stderr or p.stdout)[-400:])

def ev(kind, **kw):
    d = dict(kind=kind, card_id=SEED_CARD, repo=REPO, actor="cairn-fixer", tool="cairn-fix")
    d.update(kw)
    return d

def sweep(target, out):
    p = subprocess.run([os.path.join(ROOT, "cairn", "sweep"), "--target", target, "--out", out, "--repo", REPO],
                       capture_output=True, text=True)
    if p.returncode:
        sys.exit("sweep failed: " + p.stderr[-400:])
    return [json.loads(l) for l in open(out) if l.strip()]

def ingest(rows_path):
    p = subprocess.run([os.path.join(ROOT, "cairn", "ingest")], stdin=open(rows_path), capture_output=True, text=True)
    if p.returncode:
        sys.exit("ingest failed: " + p.stderr[-400:])
    return [json.loads(l) for l in p.stdout.splitlines() if l.strip()]

def ident(r):
    return (r["rule_id"], r["file"], r["snippet"])

def is_seed(r):
    return r["card_id"] == SEED_CARD and r["file"] == PORTAL and r["kind"] == "finding"

def read(rel):
    with open(os.path.join(WORK, rel), newline="") as f:
        return f.read()

def make_patch(sabotage):
    """Return (unified diff text, hunk line number of the portal change). Does not touch disk."""
    old = read(PORTAL)
    new = old
    anchor = "static portal_submit_cb_t submit_cb;\n"
    if anchor not in new:
        sys.exit("portal.c anchor not found; seed changed?")
    new = new.replace(anchor, anchor + "\n" + HELPER.rstrip("\n") + "\n", 1)
    loop_old = '''    char option[80];
    for (int i = 0; i < n; i++) {
        snprintf(option, sizeof(option), "<option>%.32s</option>",
                 (const char *)aps[i].ssid);
        httpd_resp_sendstr_chunk(req, option);
    }
'''
    loop_new = '''    char escaped[200];
    char option[224];
    for (int i = 0; i < n; i++) {
        html_escape((const char *)aps[i].ssid, 32, escaped, sizeof(escaped));
        snprintf(option, sizeof(option), "<option>%s</option>", escaped);
        httpd_resp_sendstr_chunk(req, option);
    }
'''
    if loop_old not in new:
        sys.exit("portal.c SSID loop not found; seed changed?")
    if not sabotage:   # --sabotage: helper is added but never applied, the bug stays in place
        new = new.replace(loop_old, loop_new, 1)
    diffs = list(difflib.unified_diff(old.splitlines(True), new.splitlines(True), "a/" + PORTAL, "b/" + PORTAL))
    # dependency pin: day-01 caret range -> the exact pin day-03 already uses
    pin_old = 'waveshare/esp32_s3_touch_amoled_1_8: "^2.0.3"'
    pin = 'waveshare/esp32_s3_touch_amoled_1_8: "==2.0.3"'
    if pin not in read(NEIGHBOUR):
        sys.exit("neighbour manifest no longer uses the pin; refusing to invent a version")
    mo = read(MANIFEST)
    if pin_old not in mo:
        sys.exit("manifest line not found")
    diffs += list(difflib.unified_diff(mo.splitlines(True), mo.replace(pin_old, pin, 1).splitlines(True),
                                       "a/" + MANIFEST, "b/" + MANIFEST))
    hunk_line = next((int(l.split("-")[1].split(",")[0].split()[0]) for l in diffs if l.startswith("@@")), 0)
    return "".join(diffs), hunk_line


# ---------------------------------------------------------------------------------------------
# Patch hygiene (deterministic).  Two checks, both independent of the re-scan and the unit test:
#  (1) scope: every REMOVED or MODIFIED line must be on a per-card allowlist (pure additions are ok);
#  (2) identifier typos: in C files, a NEW identifier within edit distance 1-2 of an original identifier
#      is almost certainly a mangled copy (eSP_ERROR_CHECK, nvo_erase_all, sizeoff).
# Limits: (1) allows ANY added text (a malicious pure addition passes scope; the re-scan and test must
# catch it); it also trusts the allowlist regexes, which are matched on the trimmed line text, so a change to
# an allowed line is accepted even if what it was changed INTO is odd. (2) is a heuristic: identifiers shorter
# than 4 chars are ignored (so s[2] -> o[2] is caught by (1) only), a legitimate new name that is 1-2 edits from an old one is a false positive (it blocks; a human can relax the rule),
# a typo that happens to land on another existing identifier is invisible, comments (`//`) on added lines are ignored, and tokens in string literals are included on purpose (catches
# `</celect>`). The original is read from target/seeds.
# ---------------------------------------------------------------------------------------------
import re
ALLOW_REMOVE = {   # path -> (card, [regex on the stripped removed line])
    PORTAL: ("unvalidated-network-input", [
        r'^char option\[\d+\];$',                                    # the too-small option buffer declaration
        r'^snprintf\(option, sizeof\(option\), "<option>%\.32s</option>",$',   # the unescaped SSID print...
        r'^\(const char \*\)aps\[i\]\.ssid\);$']),                    # ...and its argument line
    MANIFEST: ("unpinned-dependency", [r'^waveshare/esp32_s3_touch_amoled_1_8: "\^2\.0\.3"$']),
}

def parse_diff(text):
    """-> list of dict(file, old_line, removed:[str], added:[str]) one per change block (a -run plus the +run after it)."""
    blocks, cur_file, old_ln, cur = [], None, 0, None
    def close():
        nonlocal cur
        if cur and (cur["removed"] or cur["added"]): blocks.append(cur)
        cur = None
    for l in text.splitlines():
        if l.startswith("+++ "):
            close(); p = l[4:].split("\t")[0].strip()
            cands = [p] + ([p.split("/", 1)[1]] if "/" in p else [])
            cur_file = next((c for c in cands if os.path.exists(os.path.join(SEEDS, c))), cands[-1]); continue
        if l.startswith("--- ") or l.startswith("diff ") or l.startswith("index "):
            close(); continue
        m = re.match(r"@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@", l)
        if m:
            close(); old_ln = int(m.group(1)); continue
        if cur_file is None or l.startswith("\\"): continue
        if l.startswith("-"):
            if cur is None or cur["added"]: close(); cur = dict(file=cur_file, old_line=old_ln, removed=[], added=[])
            cur["removed"].append(l[1:]); old_ln += 1
        elif l.startswith("+"):
            if cur is None: cur = dict(file=cur_file, old_line=old_ln, removed=[], added=[])
            cur["added"].append(l[1:])
        else:
            close(); old_ln += 1
    close()
    return blocks

def scope_violations(blocks):
    bad = []
    for b in blocks:
        rules = ALLOW_REMOVE.get(b["file"], (None, []))[1]
        for i, r in enumerate(b["removed"]):
            if any(re.match(rx, r.strip()) for rx in rules): continue
            after = b["added"][i] if i < len(b["added"]) else None
            where = f"{b['file']}:{b['old_line'] + i}"
            if after is None: msg = f'{where}: an unrelated line was DELETED: "{r.strip()}"'
            else: msg = f'{where}: an unrelated line was CHANGED: before "{r.rstrip()}" / after "{after.rstrip()}"'
            if b["file"] not in ALLOW_REMOVE: msg += " (this file is not part of the fix for this card)"
            bad.append(msg)
        if b["file"] not in ALLOW_REMOVE:   # also additions to files the fix has no business touching
            for a in b["added"][len(b["removed"]):]:
                bad.append(f'{b["file"]}:{b["old_line"]}: text was ADDED to a file outside the fix: "{a.strip()}"')
    return bad

def edit_distance(a, b, cap=3):
    if abs(len(a) - len(b)) > cap: return cap + 1
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]

IDENT = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")

def typo_findings(blocks, work_root):
    out = []
    for f in sorted({b["file"] for b in blocks}):
        if not f.endswith((".c", ".h")): continue
        po, pn = os.path.join(SEEDS, f), os.path.join(work_root, f)
        if not (os.path.exists(po) and os.path.exists(pn)): continue
        old = collections.Counter(IDENT.findall(open(po, errors="replace").read()))
        new_txt = open(pn, errors="replace").read()
        new = collections.Counter(IDENT.findall(new_txt))
        for b in blocks:   # control characters (other than tab) or non-ASCII in added code: corrupted copy
            if b["file"] != f: continue
            for a in b["added"]:
                if re.search(r"[\x00-\x08\x0b-\x1f\x7f]|[^\x00-\x7f]", a):
                    out.append(f'{f}:{b["old_line"]}: an added line contains a control or non-ASCII character: {a.strip()!r}')
        added_ids = collections.Counter(t for b in blocks if b["file"] == f for a in b["added"] for t in IDENT.findall(re.sub(r"//.*$", "", a)))
        for tok in sorted(added_ids):
            if tok in old or len(tok) < 4: continue
            lim = 1 if len(tok) <= 6 else 2
            for o in sorted(old):
                if len(o) < 4: continue
                if edit_distance(tok, o, lim) <= lim:
                    ln = next((i for i, l in enumerate(new_txt.splitlines(), 1) if re.search(r"(?<![A-Za-z0-9_])" + re.escape(tok) + r"(?![A-Za-z0-9_])", l)), 0)
                    out.append(f'{f}:{ln}: "{tok}" looks like a typo of "{o}" ("{o}" is used {old[o]} time(s) in the original and {new[o]} now; "{tok}" is new)')
                    break
    return out

def hygiene(patch_text, work_root):
    blocks = parse_diff(patch_text)
    scope, typos = scope_violations(blocks), typo_findings(blocks, work_root)
    return scope, typos

def apply_patch(patch_text, patch_file):
    with open(patch_file, "w") as f:
        f.write(patch_text)
    for flags in (["--dry-run"], []):
        p = subprocess.run(["patch", "-p1", "-s", "-i", patch_file] + flags, cwd=WORK, capture_output=True, text=True)
        if p.returncode:
            sys.exit("patch failed: " + (p.stdout + p.stderr)[-400:])

def run_unit_test():
    src = read(PORTAL)
    i = src.find("static void html_escape(")
    if i < 0:
        return False, "html_escape helper not present in patched portal.c"
    j = src.find("\n}\n", i)
    helper = src[i:j + 3]
    bd = tempfile.mkdtemp(prefix="cairn-test-", dir=OUT)
    try:
        inc = os.path.join(bd, "helper.inc")
        open(inc, "w").write("#include <string.h>\n" + helper)
        exe = os.path.join(bd, "t")
        c = subprocess.run(["cc", "-Wall", "-Wextra", "-O1", "-fsanitize=address,undefined", f'-DHELPER_INC="{inc}"',
                            os.path.join(HERE, "test_html_escape.c"), "-o", exe], capture_output=True, text=True)
        if c.returncode:
            return False, "compile failed: " + c.stderr[-500:]
        r = subprocess.run([exe], capture_output=True, text=True)
        return r.returncode == 0, (r.stdout + r.stderr).strip()
    finally:
        shutil.rmtree(bd, ignore_errors=True)

def ask_dial(question, sim, sim_answer):
    ask = ["node", os.path.join(DIAL, "bin", "agent-dial.mjs"), "ask", "--approve", "--timeout", "120", question]
    procs, tmp = [], None
    env = dict(os.environ)
    try:
        if sim:
            tmp = tempfile.mkdtemp(prefix="sim-", dir=OUT)   # short path: unix socket limit
            env.update(AGENT_DIAL_HOME=tmp, AGENT_DIAL_PORT="sim", AGENT_DIAL_NO_SPAWN="1")
            procs.append(subprocess.Popen(["node", os.path.join(DIAL, "hub.mjs")], env=env,
                                          stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            time.sleep(1.0)
            procs.append(subprocess.Popen(["node", os.path.join(DIAL, "bin", "agent-dial.mjs"), "sim", "--auto", sim_answer],
                                          env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
            time.sleep(1.0)
        p = subprocess.run(ask, env=env, capture_output=True, text=True)
        return p.returncode, p.stdout.strip(), p.stderr.strip()
    finally:
        for pr in procs:
            pr.terminate()
        for pr in procs:
            try: pr.wait(5)
            except Exception: pr.kill()
        if tmp:
            shutil.rmtree(tmp, ignore_errors=True)

def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--sim", action="store_true", help="use the simulated dial (no hardware)")
    ap.add_argument("--sim-answer", choices=["allow", "deny"], default="allow", help="what the simulated human presses")
    ap.add_argument("--sabotage", action="store_true", help="patch leaves the bug in place (demo: gate must refuse)")
    ap.add_argument("--keep-work", action="store_true", help="do not reset target/work from target/seeds")
    a = ap.parse_args()
    os.makedirs(OUT, exist_ok=True)
    say(f"backend: CAIRN_BACKEND={os.environ.get('CAIRN_BACKEND', '(unset: ClickHouse if configured)')}")

    # 1. fresh copy of the seeds; only target/work is modified
    if not a.keep_work:
        shutil.rmtree(WORK, ignore_errors=True)
        shutil.copytree(SEEDS, WORK)
    say("[1] sweep target/work")
    before_path = os.path.join(OUT, "fix-sweep-before.jsonl")
    before = sweep(WORK, before_path)
    seeds_before = [r for r in before if is_seed(r)]
    if not seeds_before:
        sys.exit("seed not present in target/work; nothing to fix")
    log_events(ingest(before_path))
    say(f"    {len(before)} rows logged; seed {PORTAL}:{seeds_before[0]['line']} FOUND")

    # 2+3. patch and apply
    say("[2] build patch" + (" (SABOTAGE: bug left in place)" if a.sabotage else ""))
    patch_text, hunk_line = make_patch(a.sabotage)
    patch_file = os.path.join(OUT, "fix-staged.patch")
    apply_patch(patch_text, patch_file)
    sha = hashlib.sha256(patch_text.encode()).hexdigest()[:12]
    say(f"    applied to target/work ({patch_text.count(chr(10))} diff lines, sha256 {sha})")
    log_events([ev("agent_write", file=PORTAL, line=hunk_line, verdict="applied", detail=f"patch {sha}: html_escape helper" + (" added but NOT applied (sabotage)" if a.sabotage else " applied to SSID option"))
                , ev("agent_write", card_id="unpinned-dependency", file=MANIFEST, line=2, verdict="applied",
                     detail=f'patch {sha}: waveshare ^2.0.3 -> ==2.0.3 (pin already used by {NEIGHBOUR})')])

    return gate_phase(a, before, patch_text, patch_file, sha, "Fix: escape scanned SSIDs in the setup portal; pin one dependency")

def gate_phase(a, before, patch_text, patch_file, sha, label):
    global WORK
    say(f"[3] re-sweep {os.path.relpath(WORK, ROOT)}")
    after_path = os.path.join(OUT, "fix-sweep-after.jsonl")
    after = sweep(WORK, after_path)
    seed_left = [r for r in after if is_seed(r)]
    cb, ca = collections.Counter(map(ident, before)), collections.Counter(map(ident, after))
    new = list((ca - cb).elements())
    gone = list((cb - ca).elements())
    say(f"    rows before={len(before)} after={len(after)}; removed={len(gone)} new={len(new)}")
    for g in gone: say(f"    removed: {g[1]} :: {g[2]}")
    for n in new: say(f"    NEW:     {n[1]} :: {n[2]}")
    if seed_left:
        say(f"    seed STILL PRESENT at {PORTAL}:{seed_left[0]['line']}")
        log_events([ev("agent_ignored_finding", file=PORTAL, line=seed_left[0]["line"], verdict="open",
                       detail="agent patch left the unescaped SSID finding in place")])
    rescan_clean = not seed_left and not new

    # 4. unit test
    say("[4] unit test: html_escape (cc, ASan+UBSan)")
    ok, out = run_unit_test()
    for l in out.splitlines()[-6:]: say("    " + l)
    say(f"    test {'PASS' if ok else 'FAIL'}")

    # 4b. patch hygiene (scope rule + identifier-typo check)
    scope_bad, typo_bad = hygiene(patch_text, WORK)
    hygiene_ok = not scope_bad and not typo_bad
    say(f"[4b] patch hygiene: {len(scope_bad)} out-of-scope line(s), {len(typo_bad)} suspected identifier typo(s)")
    for m in scope_bad: say("    SCOPE: " + m)
    for m in typo_bad: say("    TYPO:  " + m)
    unrelated = len(scope_bad) + len(typo_bad)

    # 5. gate
    verdict = "pass" if rescan_clean and ok and hygiene_ok else "block"
    why = f"rescan_clean={rescan_clean} seed_left={len(seed_left)} new={len(new)} test_pass={ok} hygiene={hygiene_ok}, unrelated_changes={unrelated}"
    logwhy = why + ((" | hygiene: " + " ; ".join(scope_bad + typo_bad))[:1500] if not hygiene_ok else "")
    log_events([ev("pr_gate", file=PORTAL, verdict=verdict, tool="pr-gate", detail=("PR allowed to ask human: " if verdict == "pass" else "PR BLOCKED: ") + logwhy)])
    say(f"[5] GATE: {verdict.upper()} ({why})")
    if verdict != "pass":
        say("    no PR opened, no approval requested.")
        return 2

    # 6. human approval on the dial
    q = f"Open fix PR? SSID escape + pin, scan clean, test pass ({sha})"
    say(f"[6] asking {'SIMULATED dial' if a.sim else 'real dial'}: {q}")
    rc, out, err = ask_dial(q, a.sim, a.sim_answer)
    say(f"    agent-dial exit={rc} stdout={out!r}" + (f" stderr={err[:200]!r}" if err else ""))
    approved = rc == 0 and out.lower().startswith("allow")
    dv = "approved" if approved else ("denied" if rc == 1 else "error")
    log_events([ev("device_approval", file=PORTAL, actor="pavan", tool="agent-dial-sim" if a.sim else "agent-dial", verdict=dv,
                   detail=f"{'SIMULATED ' if a.sim else ''}dial answer={out!r} exit={rc}")])
    if not approved:
        say(f"    {dv}: nothing written.")
        return 3 if rc == 1 else 4

    # 7. write patch + PR description, then stop (never push)
    os.makedirs(PR_DIR, exist_ok=True)
    shutil.copy(patch_file, os.path.join(PR_DIR, "cairn-fix.patch"))
    pr = f"""# {label}

Card: unvalidated-network-input (seed {PORTAL}), unpinned-dependency.

## What changed
- `{PORTAL}`: added `html_escape()` and applied it to each scanned SSID before it is written into the
  `<option>` element (a rogue nearby SSID such as `<script>` could inject HTML into the setup page).
- `{MANIFEST}`: `waveshare/esp32_s3_touch_amoled_1_8` `^2.0.3` -> `==2.0.3`, the pin already used by
  `{NEIGHBOUR}`.

## Evidence (gate verdict: pass)
- Re-scan of the patched tree: seed finding gone, {len(new)} new findings, {len(gone)} findings removed.
- Unit test `cairn/fix/test_html_escape.c` (hostile SSIDs, 32-byte limit, canary buffer, ASan+UBSan): PASS.
- Human approval: {'SIMULATED dial (not a real device)' if a.sim else 'physical dial'}, answer `{out}`.
- Patch sha256 prefix: {sha}. File: `cairn-fix.patch` (apply with `patch -p1`).

Not pushed. This description and the patch are local files only.
"""
    open(os.path.join(PR_DIR, "PR.md"), "w").write(pr)
    say(f"[7] approved: wrote {PR_DIR}/cairn-fix.patch and PR.md. Nothing pushed. Stopping.")
    return 0


def sweep_prelude(label_dir):
    os.makedirs(OUT, exist_ok=True)
    shutil.rmtree(WORK, ignore_errors=True)
    shutil.copytree(SEEDS, WORK)
    p = os.path.join(OUT, "fix-sweep-before.jsonl")
    before = sweep(WORK, p)
    log_events(ingest(p))
    say(f"[1] sweep fresh seeds copy in {label_dir}: {len(before)} rows logged")
    return before

def verify_main(argv):
    global WORK
    ap = argparse.ArgumentParser(prog="run.py verify", description="Verify a fetched fix (patch file or branch checkout dir) and gate it. No network, no push.")
    ap.add_argument("--patch", required=True, help="a .patch file (git or diff -u, -p1) or a directory holding a fetched copy of the branch")
    ap.add_argument("--sim", action="store_true"); ap.add_argument("--sim-answer", choices=["allow", "deny"], default="allow")
    a = ap.parse_args(argv)
    WORK = os.path.join(ROOT, "target", "work-verify")
    src = os.path.abspath(a.patch)
    if not os.path.exists(src):
        sys.exit("no such patch/dir: " + src)
    say(f"backend: CAIRN_BACKEND={os.environ.get('CAIRN_BACKEND', '(unset: ClickHouse if configured)')}")
    before = sweep_prelude("target/work-verify")
    patch_file = os.path.join(OUT, "fix-staged.patch")
    if os.path.isdir(src):
        for dp, dn, fns in os.walk(src):
            dn[:] = [d for d in dn if d != ".git"]
            for fn in fns:
                rel = os.path.relpath(os.path.join(dp, fn), src)
                dst = os.path.join(WORK, rel)
                if os.path.exists(dst) and os.path.realpath(os.path.join(dp, fn)).startswith(os.path.realpath(src)):
                    shutil.copy(os.path.join(dp, fn), dst)   # overlay only files that exist in the seeds
        diffs = []
        for dp, _, fns in os.walk(SEEDS):
            for fn in fns:
                rel = os.path.relpath(os.path.join(dp, fn), SEEDS)
                o, n = open(os.path.join(SEEDS, rel), errors="replace").read(), open(os.path.join(WORK, rel), errors="replace").read()
                if o != n:
                    diffs += difflib.unified_diff(o.splitlines(True), n.splitlines(True), "a/" + rel, "b/" + rel)
        patch_text = "".join(diffs)
        open(patch_file, "w").write(patch_text)
        say(f"[2] overlaid branch copy {src}; derived diff has {patch_text.count(chr(10))} lines")
    else:
        patch_text = open(src).read()
        shutil.copy(src, patch_file)
        for strip in ("-p1", "-p0"):
            if subprocess.run(["patch", strip, "-s", "--dry-run", "-i", patch_file], cwd=WORK, capture_output=True).returncode == 0:
                subprocess.run(["patch", strip, "-s", "-i", patch_file], cwd=WORK, check=True)
                break
        else:
            sys.exit("patch does not apply to a fresh seeds copy (tried -p1 and -p0); nothing run")
        say(f"[2] applied {src} to target/work-verify")
    if not patch_text.strip():
        sys.exit("empty patch: nothing changed in the seeds copy")
    sha = hashlib.sha256(patch_text.encode()).hexdigest()[:12]
    log_events([ev("agent_write", file=PORTAL, line=0, actor="guild-fixer", tool="guild", verdict="received", detail=f"verify: external patch {sha} applied to fresh copy")])
    return gate_phase(a, before, patch_text, patch_file, sha, "Verified Guild fix: escape scanned SSIDs / pin dependency")


if __name__ == "__main__":
    sys.exit(verify_main(sys.argv[2:]) if len(sys.argv) > 1 and sys.argv[1] == "verify" else main())
