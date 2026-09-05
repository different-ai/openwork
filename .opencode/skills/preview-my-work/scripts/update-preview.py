#!/usr/bin/env python3
"""Update only the frontends of a live, owned preview world; preserve its data."""
import argparse
import json
import os
from pathlib import Path
import re
import shlex
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("world", choices=["preview-den", "preview-desktop"])
parser.add_argument("--stage", required=True)
parser.add_argument("--ref", required=True, help="Pushed branch or full commit SHA")
args = parser.parse_args()
if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._-]*", args.stage):
    parser.error("Use the normalized stage name from world outputs.")
if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9/._-]*", args.ref):
    parser.error("Use a pushed git ref or commit SHA.")
root = Path(__file__).resolve().parents[4]
receipt_dir = Path(os.environ.get("OPENWORK_WORLD_SNAPSHOT_DIR", root / "evals/results/.worlds/scripts"))
receipt = receipt_dir / f"{args.world}--{args.stage}.json"
state = json.loads(receipt.read_text())
if state.get("kind") != "script" or state.get("place") != "daytona" or Path(state["sourcePath"]).resolve() != root / "worlds" / f"{args.world}.ts":
    parser.error("Receipt is not an owned Daytona preview in this worktree.")
os.kill(state["pid"], 0)
outputs = state["outputs"]
# All commands are argv-based locally, and one shell-quoted Python program remotely.
# Reuse the running web process's environment without printing or serializing it.
remote = r'''
import os, signal, subprocess, time
from pathlib import Path
ref = REF
web = WEB
root = "/workspace"
subprocess.run(["git", "diff", "--quiet", "--", ".", ":!ee/apps/den-web/next-env.d.ts", ":!ee/apps/den-web/tsconfig.tsbuildinfo"], cwd=root, check=True)
subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=root, check=True)
env = None
pid = None
if web:
    for proc in Path("/proc").iterdir():
        if not proc.name.isdigit(): continue
        try:
            command = (proc / "cmdline").read_bytes().split(b"\0")[0]
            if not command.startswith(b"next-server"): continue
            if str((proc / "cwd").resolve()) != root + "/ee/apps/den-web": continue
            if pid is not None: raise RuntimeError("Multiple Next servers; refusing an ambiguous update")
            pid = int(proc.name)
            running = dict(item.decode().split("=", 1) for item in (proc / "environ").read_bytes().split(b"\0") if b"=" in item)
            allowed = {"PATH", "HOME", "PNPM_HOME", "DEN_WEB_PORT", "DEN_BASE_URL", "DEN_API_BASE", "DEN_AUTH_ORIGIN", "DEN_AUTH_FALLBACK_BASE", "NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL", "DEN_ORG_MODE", "OPENWORK_DEV_MODE", "DEN_WEB_ALLOWED_DEV_ORIGINS"}
            env = {key: value for key, value in running.items() if key in allowed}
        except (FileNotFoundError, PermissionError): continue
    if pid is None: raise RuntimeError("No running preview web server")
subprocess.run(["git", "fetch", "origin", ref], cwd=root, check=True)
subprocess.run(["git", "checkout", "--detach", "FETCH_HEAD"], cwd=root, check=True)
install_env = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "PNPM_HOME"}}
with open("/tmp/preview-update.log", "w") as log:
    subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=root, env=install_env, stdout=log, stderr=subprocess.STDOUT, check=True)
    if web:
        subprocess.run(["pnpm", "--filter", "@openwork-ee/den-web", "build"], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, check=True)
if web:
    os.kill(pid, signal.SIGTERM)
    for _ in range(100):
        try: os.kill(pid, 0)
        except ProcessLookupError: break
        time.sleep(0.1)
    else: raise RuntimeError("Previous web server did not stop")
    with open("/tmp/den-web.log", "a") as log:
        subprocess.Popen(["pnpm", "--filter", "@openwork-ee/den-web", "exec", "next", "start", "--hostname", "0.0.0.0", "--port", "3005"], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
print("Updated frontend; existing data preserved.")
'''
targets = [(outputs["denSandbox"], True)]
if args.world == "preview-desktop":
    targets.append((outputs["desktopSandbox"], False))
for sandbox, web in targets:
    if not re.fullmatch(r"[a-zA-Z0-9_-]+", sandbox):
        parser.error("Invalid sandbox ID in receipt")
    program = remote.replace("REF", repr(args.ref)).replace("WEB", repr(web))
    subprocess.run(["daytona", "exec", sandbox, "--", "python3", "-c", shlex.quote(program)], check=True)
# Never resurrect a receipt whose lifetime ended while the build was running.
current = json.loads(receipt.read_text())
if current["pid"] != state["pid"]:
    raise RuntimeError("Preview ownership changed during update")
os.kill(current["pid"], 0)
# Keep boot ref distinct: the API/Electron main still run that version.
current["outputs"]["frontendRef"] = args.ref
with receipt.open("r+") as handle:
    handle.write(json.dumps(current, indent=2) + "\n")
    handle.truncate()
print("Frontend update complete. Reopen the existing preview and verify the changed screen.")
