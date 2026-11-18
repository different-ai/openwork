"""Read-only ARM observer; never starts or retries a migration execution.

The native AzAPI start response identifies exactly one execution. Azure's start
LRO returning success is not the same as this execution reaching Succeeded.
Uses the operator's existing Azure CLI login; never extracts credentials.
"""
import json
import re
import subprocess
import sys
import time


def main():
    query = json.load(sys.stdin)
    execution_id = query["execution_id"]
    if not re.fullmatch(r"/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft.App/jobs/[^/]+/executions/[^/]+", execution_id, re.IGNORECASE):
        raise ValueError("Expected the exact ARM Job execution ID from the native start response")
    timeout = int(query["timeout"])
    if not 120 <= timeout <= 3720:
        raise ValueError("Invalid migration observation deadline")
    deadline = time.monotonic() + timeout
    status = "Unknown"
    while time.monotonic() < deadline:
        response = subprocess.run(
            ["az", "rest", "--method", "get", "--url",
             "https://management.azure.com" + execution_id + "?api-version=2025-01-01",
             "--query", "properties.status", "--output", "json", "--only-show-errors"],
            capture_output=True, text=True, timeout=30, check=False,
        )
        if response.returncode != 0:
            # Do not echo CLI diagnostics (they can include request metadata).
            raise RuntimeError("Cannot observe migration execution; no restart attempted. Check Azure CLI sign-in and Job read permission.")
        status = json.loads(response.stdout)
        if status == "Succeeded":
            print(json.dumps({"status": status, "execution_id": execution_id}))
            return
        if status in {"Failed", "Stopped", "Degraded"}:
            raise RuntimeError("Migration execution is terminal and unsuccessful: " + status)
        # Condition polling, not a presumed provisioning duration.
        time.sleep(min(3, max(0, deadline - time.monotonic())))
    raise RuntimeError("Migration observation deadline exceeded; last status: " + str(status))


if __name__ == "__main__":
    try:
        main()
    except (KeyError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
