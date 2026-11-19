"""Runs agent scripts inside Blender and reports the scene compactly.

GUI sessions load this with ``--python`` and serve one Unix socket owned by the
desktop user, so scripts edit the scene the person sees. The desktop egress
guard refuses loopback TCP for that user, so there is no port. Background runs
(``blender --background --python``) use the same execution and summary code.
"""
import bpy
import contextlib
import io
import json
import os
import queue
import socket
import sys
import threading
import time
import traceback

OUTPUT_LIMIT = 8000
LIMIT = 60


class Cancelled(BaseException):
    """Raised inside the script when the caller stopped or the time ran out."""


def _round(values):
    return [round(float(value), 3) for value in values]


def _color(material):
    if material.use_nodes and material.node_tree:
        for node in material.node_tree.nodes:
            if node.type == "BSDF_PRINCIPLED":
                return _round(node.inputs["Base Color"].default_value)
    return _round(material.diffuse_color)


def summary():
    scene = bpy.context.scene
    view_layer = bpy.context.view_layer
    objects = []
    for item in list(scene.objects)[:LIMIT]:
        entry = {"name": item.name, "type": item.type, "location": _round(item.location)}
        materials = [slot.material.name for slot in getattr(item, "material_slots", []) if slot.material]
        if materials:
            entry["materials"] = materials
        if not item.visible_get(view_layer=view_layer):
            entry["hidden"] = True
        objects.append(entry)
    materials = [{"name": material.name, "color": _color(material)} for material in list(bpy.data.materials)[:LIMIT] if material.users]
    active = view_layer.objects.active
    return {
        "file": bpy.data.filepath or None, "unsaved": bpy.data.is_dirty, "scene": scene.name,
        "engine": scene.render.engine, "frame": scene.frame_current,
        "camera": scene.camera.name if scene.camera else None, "active": active.name if active else None,
        "objectCount": len(scene.objects), "objects": objects, "materials": materials,
    }


def _view3d():
    manager = bpy.context.window_manager
    for window in manager.windows if manager else []:
        for area in window.screen.areas:
            if area.type == "VIEW_3D":
                region = next((region for region in area.regions if region.type == "WINDOW"), None)
                if region:
                    return {"window": window, "area": area, "region": region}
    return None


def _render(kind, output):
    scene = bpy.context.scene
    previous = scene.render.filepath
    scene.render.filepath = output
    try:
        view = _view3d() if kind == "viewport" else None
        if view:
            with bpy.context.temp_override(**view):
                bpy.ops.render.opengl(write_still=True)
        else:
            bpy.ops.render.render(write_still=True)
    finally:
        scene.render.filepath = previous
    return {"path": output, "kind": "viewport" if view else "final"}


def execute(job, should_stop):
    """Runs one script. Returns a JSON-safe result; never raises."""
    stdout = io.StringIO()
    namespace = {"bpy": bpy, "__name__": "__openwork__", "result": None}

    def trace(frame, event, arg):
        if should_stop():
            raise Cancelled()
        return trace

    error = None
    started = time.monotonic()
    view = _view3d()
    try:
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stdout):
            sys.settrace(trace)
            try:
                code = compile(job["code"], "<script>", "exec")
                if view:
                    with bpy.context.temp_override(**view):
                        exec(code, namespace)
                else:
                    exec(code, namespace)
            finally:
                sys.settrace(None)
                if view:
                    # One undo step per script, so the person can undo it with Ctrl+Z.
                    with bpy.context.temp_override(**view):
                        bpy.ops.ed.undo_push(message="OpenWork script")
    except Cancelled:
        return {"ok": False, "error": "cancelled", "outcome": "uncertain", "scene": summary()}
    except Exception:
        error = traceback.format_exc(limit=4)[-OUTPUT_LIMIT:]
    payload = {"ok": error is None, "seconds": round(time.monotonic() - started, 2), "scene": summary()}
    if error:
        payload["error"] = error
        payload["outcome"] = "partial"
    try:
        json.dumps(namespace.get("result"))
        if namespace.get("result") is not None:
            payload["result"] = namespace["result"]
    except (TypeError, ValueError):
        payload["result"] = repr(namespace["result"])[:OUTPUT_LIMIT]
    text = stdout.getvalue()
    if text:
        payload["output"] = text[-OUTPUT_LIMIT:]
    def check_stopped():
        if should_stop():
            raise Cancelled()
    # Native renders may not yield to Python tracing. Check each boundary and
    # acknowledge cancellation only after the native operation has returned.
    if error is None and job.get("render"):
        try:
            check_stopped()
            payload["render"] = _render(job["render"], job["output"])
            check_stopped()
        except Cancelled:
            return {"ok": False, "error": "cancelled", "outcome": "uncertain", "scene": summary()}
        except Exception:
            payload["ok"] = False
            payload["error"] = "Render failed: " + traceback.format_exc(limit=2)[-2000:]
    if error is None and job.get("save"):
        if should_stop():
            return {"ok": False, "error": "cancelled", "outcome": "uncertain", "scene": summary()}
        if bpy.data.filepath:
            bpy.ops.wm.save_mainfile()
            payload["saved"] = bpy.data.filepath
            payload["scene"]["unsaved"] = False
        else:
            payload["saved"] = None
            payload["note"] = "This scene has no file yet; save with bpy.ops.wm.save_as_mainfile(filepath=...)."
    if should_stop():
        return {"ok": False, "error": "cancelled", "outcome": "uncertain", "scene": summary()}
    return payload


class Bridge:
    """One listener thread; scripts run on Blender's main thread through a timer."""

    def __init__(self, path):
        self.path = path
        self.jobs = queue.Queue()
        self.finished = []

    def start(self):
        directory = os.path.dirname(self.path)
        os.makedirs(directory, mode=0o700, exist_ok=True)
        os.chmod(directory, 0o700)
        probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            probe.connect(self.path)
            probe.close()
            print("openwork: another Blender session already serves scripts", file=sys.stderr)
            return
        except OSError:
            probe.close()
        with contextlib.suppress(FileNotFoundError):
            os.unlink(self.path)
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        previous = os.umask(0o177)
        try:
            server.bind(self.path)
        finally:
            os.umask(previous)
        server.listen(4)
        threading.Thread(target=self.accept, args=(server,), daemon=True).start()
        bpy.app.timers.register(self.tick, first_interval=0.2, persistent=True)

    def accept(self, server):
        while True:
            connection, _ = server.accept()
            threading.Thread(target=self.serve, args=(connection,), daemon=True).start()

    def serve(self, connection):
        with connection:
            data = b""
            while b"\n" not in data and len(data) < 200_000:
                chunk = connection.recv(65536)
                if not chunk:
                    return
                data += chunk
            try:
                job = json.loads(data.split(b"\n", 1)[0])
            except ValueError:
                return
            if job.get("id") in self.finished:
                connection.sendall(json.dumps({"ok": False, "error": "already_ran", "outcome": "uncertain"}).encode() + b"\n")
                return
            job["deadline"] = time.monotonic() + min(float(job.get("timeout", 60)), 600)
            job["cancelled"] = False
            job["done"] = threading.Event()
            self.jobs.put(job)
            pending = data.split(b"\n", 1)[1]
            # Keep the connection until completion: Stop is a message followed
            # by an acknowledgement, not evidence that input has already ended.
            connection.settimeout(0.2)
            while not job["done"].is_set():
                try:
                    chunk = connection.recv(4096)
                    if chunk == b"":
                        job["cancelled"] = True
                        break
                    pending += chunk
                    while b"\n" in pending:
                        line, pending = pending.split(b"\n", 1)
                        try:
                            cancel = json.loads(line)
                        except ValueError:
                            job["cancelled"] = True
                            continue
                        if cancel.get("cancel") == job.get("id"):
                            job["cancelled"] = True
                except socket.timeout:
                    continue
                except OSError:
                    job["cancelled"] = True
                    break
            job["done"].wait()
            with contextlib.suppress(OSError):
                connection.sendall(json.dumps(job["result"]).encode() + b"\n")

    def tick(self):
        try:
            job = self.jobs.get_nowait()
        except queue.Empty:
            return 0.1
        should_stop = lambda: job["cancelled"] or time.monotonic() > job["deadline"]
        if should_stop():
            job["result"] = {"ok": False, "error": "cancelled", "outcome": "not_started"}
        else:
            self.finished = (self.finished + [job.get("id")])[-32:]
            try:
                job["result"] = execute(job, should_stop)
            except Exception:
                job["result"] = {"ok": False, "error": traceback.format_exc(limit=3)[-2000:], "outcome": "uncertain"}
            # Reply after the next redraw, so a screenshot taken next shows the change.
            for window in bpy.context.window_manager.windows:
                for area in window.screen.areas:
                    area.tag_redraw()
            bpy.app.timers.register(lambda: job["done"].set(), first_interval=0.15)
            return 0.2
        job["done"].set()
        return 0.05


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if len(argv) == 2 and argv[0] == "serve":
        Bridge(os.path.join(argv[1], f"blender-{os.getpid()}.sock")).start()
    elif argv == ["run"]:
        job = json.load(sys.stdin)
        deadline = time.monotonic() + float(job.get("timeout", 60))
        result = execute(job, lambda: time.monotonic() > deadline)
        # Blender prints its own log lines to stdout; the caller reads this marker.
        sys.stdout.write("\nOPENWORK_RESULT " + json.dumps(result) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
