#!/usr/bin/env python3
"""Add or remove the Fault Lab test providers in the desktop's global runtime config.

    python3 fault-providers.py add      # backs up runtime.sqlite first
    python3 fault-providers.py remove
    python3 fault-providers.py status

After add/remove, run `node ../drive-desktop-cdp/scripts/cdp.mjs refresh-providers`
so the OpenWork server mirrors providers into the v2 engine.

This edits your real local config (~/.config/openwork/runtime.sqlite).
Set OPENWORK_RUNTIME_DB to point at another database.
"""
import json, os, shutil, sqlite3, sys, time

DB = os.environ.get("OPENWORK_RUNTIME_DB") or os.path.expanduser("~/.config/openwork/runtime.sqlite")
ROW = "__openwork_engine_global__"
PORT = os.environ.get("FAULT_PORT", "55600")
NAMES = ["fault-lab", "fault-refused", "fault-dns"]
LAB_MODELS = ["ok", "reset", "mid-stream-reset", "stall", "http-429", "http-500", "http-503", "http-401", "http-402"]


def provider(name, base, models):
    return {"name": name, "npm": "@ai-sdk/openai-compatible", "options": {"baseURL": base, "apiKey": "fault"},
            "models": {m: {"name": m, "tool_call": True, "limit": {"context": 128000, "output": 8192}} for m in models}}


def main(action):
    db = sqlite3.connect(DB)
    row = db.execute("select config_json from runtime_opencode_configs where workspace_id=?", (ROW,)).fetchone()
    if not row:
        sys.exit("No global runtime config row; open OpenWork once first.")
    config = json.loads(row[0])
    providers = config.setdefault("provider", {})
    if action == "status":
        print({name: name in providers for name in NAMES})
        return
    if action == "add":
        backup = f"{DB}.before-fault-lab-{int(time.time())}"
        shutil.copyfile(DB, backup)
        print("backup:", backup)
        providers["fault-lab"] = provider("Fault Lab", f"http://127.0.0.1:{PORT}/v1", LAB_MODELS)
        providers["fault-refused"] = provider("Fault Refused", "http://127.0.0.1:9/v1", ["refused"])
        providers["fault-dns"] = provider("Fault DNS", "https://gateway.fault-lab.invalid/v1", ["enotfound"])
    elif action == "remove":
        for name in NAMES:
            providers.pop(name, None)
    else:
        sys.exit("usage: fault-providers.py add|remove|status")
    db.execute("update runtime_opencode_configs set config_json=?, updated_at=? where workspace_id=?",
               (json.dumps(config), int(time.time() * 1000), ROW))
    db.commit()
    print(action, "done:", [name for name in NAMES if name in providers] or "none installed")


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "status")
