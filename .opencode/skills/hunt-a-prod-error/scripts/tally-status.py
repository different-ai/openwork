#!/usr/bin/env python3
"""Tally desktop server requests by status class, route, and error code, plus same-millisecond bursts.

    python3 tally-status.py            # 5xx in the default desktop server logs
    python3 tally-status.py 4 [files]  # another status class, or other log files
"""
import collections, glob, json, os, re, sys

prefix = sys.argv[1] if len(sys.argv) > 1 else "5"
files = sys.argv[2:] or sorted(glob.glob(os.path.expanduser(
    "~/Library/Application Support/com.differentai.openwork/logs/openwork-server.log*")))
routes, bursts, total = collections.Counter(), collections.Counter(), 0
for path in files:
    with open(path, errors="replace") as handle:
        for line in handle:
            try:
                record = json.loads(line)
            except ValueError:
                continue
            attrs = record.get("attributes") or {}
            status = str(attrs.get("status", ""))
            if not status.startswith(prefix):
                continue
            total += 1
            route = re.sub(r"\b(ses|ws|msg|prt)_[A-Za-z0-9]+", r"\1_*", str(attrs.get("path", "?")))
            routes[(status, attrs.get("method", "?"), route, attrs.get("error.code"))] += 1
            bursts[str(record.get("timeUnixNano", ""))[:13]] += 1

print(f"{total} requests with status {prefix}xx in {len(files)} file(s)")
for (status, method, route, code), count in routes.most_common(25):
    print(f"{count:6} {status} {method} {route}" + (f"  error.code={code}" if code else ""))
shared = [(ms, n) for ms, n in bursts.most_common(5) if n > 1]
if shared:
    print("same-millisecond bursts (a shared event, not per-request data):")
    for ms, n in shared:
        print(f"{n:6} at unix ms {ms}")
