# OpenWork's script bridge for Blender. OpenWork opens Blender with
#   --python openwork_blender.py -- <state dir>
# and sends Python to run inside this Blender, one script at a time on Blender's
# main thread, over a Unix socket only this user can open. Each request carries
# the per-launch token OpenWork wrote to <state dir>/blender.token. A cancel request
# stops the running script at its next Python line and drops queued ones.
import contextlib
import hmac
import io
import json
import os
import queue
import socket
import sys
import threading
import traceback

import bpy

STATE = sys.argv[sys.argv.index("--") + 1]
SOCKET = os.path.join(STATE, "blender.sock")
OUTPUT_LIMIT = 64 * 1024
with open(os.path.join(STATE, "blender.token"), encoding="utf-8") as handle:
    TOKEN = handle.read().strip()
jobs = queue.Queue()
cancelled = threading.Event()


class Stopped(Exception):
    pass


def stop_when_cancelled(frame, event, arg):
    if cancelled.is_set():
        raise Stopped("Stopped by OpenWork.")
    return stop_when_cancelled


def execute(code):
    output = io.StringIO()
    scope = {"bpy": bpy, "__name__": "__openwork__"}
    if cancelled.is_set():
        return {"ok": False, "error": {"code": "script_stopped", "message": "Stopped by OpenWork before it started."}}
    try:
        sys.settrace(stop_when_cancelled)
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            exec(compile(code, "<openwork>", "exec"), scope)
        result = scope.get("result")
        try:
            json.dumps(result)
        except (TypeError, ValueError):
            result = repr(result)
        return {"ok": True, "stdout": output.getvalue()[-OUTPUT_LIMIT:], "result": result}
    except Stopped:
        return {"ok": False, "stdout": output.getvalue()[-OUTPUT_LIMIT:], "mayHaveActed": True,
                "error": {"code": "script_stopped", "message": "Stopped by OpenWork. Its effects so far may have landed."}}
    except Exception:
        return {"ok": False, "stdout": output.getvalue()[-OUTPUT_LIMIT:], "mayHaveActed": True,
                "error": {"code": "script_error", "message": traceback.format_exc(limit=6)[-8000:]}}
    finally:
        sys.settrace(None)


def drain():
    # bpy is only safe on the main thread: run queued scripts from a timer.
    while True:
        try:
            code, holder, done = jobs.get_nowait()
        except queue.Empty:
            return 0.05
        holder.append(execute(code))
        done.set()


def handle(connection):
    with connection:
        data = b""
        while not data.endswith(b"\n"):
            chunk = connection.recv(65536)
            if not chunk or len(data) > 1_000_000:
                return
            data += chunk
        try:
            request = json.loads(data)
        except ValueError:
            return
        if not isinstance(request, dict) or not hmac.compare_digest(str(request.get("token", "")), TOKEN):
            reply = {"ok": False, "error": {"code": "unauthorized", "message": "This Blender was opened by another OpenWork."}}
        elif request.get("cancel") is True:
            cancelled.set()
            reply = {"ok": True}
        else:
            cancelled.clear()
            holder, done = [], threading.Event()
            jobs.put((str(request.get("code", "")), holder, done))
            timeout = min(max(float(request.get("timeoutMs", 30000)) / 1000, 1), 120)
            if done.wait(timeout):
                reply = holder[0]
            else:
                cancelled.set()
                reply = {"ok": False, "mayHaveActed": True, "error": {
                    "code": "script_timeout", "message": "Blender did not finish the script in time and stops it at its next Python line."}}
        connection.sendall((json.dumps(reply) + "\n").encode("utf-8"))


def serve():
    with contextlib.suppress(FileNotFoundError):
        os.unlink(SOCKET)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    previous = os.umask(0o177)
    try:
        server.bind(SOCKET)
    finally:
        os.umask(previous)
    server.listen(4)
    while True:
        connection, _ = server.accept()
        threading.Thread(target=handle, args=(connection,), daemon=True).start()


bpy.app.timers.register(drain, persistent=True)
threading.Thread(target=serve, daemon=True).start()
