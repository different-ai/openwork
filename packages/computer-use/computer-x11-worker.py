"""Private X11 input worker. Requests are framed JSON on an owner-only Unix socket.

Input runs here so a text/action batch crosses the provider only once. A separate
cancel connection interrupts between text chunks/events and always releases held
buttons/modifiers. An idle worker expires instead of leaking VM processes.
"""
import json
import concurrent.futures
import os
import re
import signal
import socket
import socketserver
import subprocess
import sys
import threading
import time

SOCKET = sys.argv[1]
os.umask(0o077)
LOCK = threading.Lock()
STATE = threading.Lock()
ACTIVE = {}
CANCELED = {}
LAST_USED = time.monotonic()
MODIFIERS = {"command": "ctrl", "control": "ctrl", "shift": "shift", "option": "alt"}
KEYS = {"enter": "Return", "return": "Return", "escape": "Escape", "esc": "Escape", "tab": "Tab", "backspace": "BackSpace", "delete": "Delete", "space": "space", "arrowup": "Up", "arrowdown": "Down", "arrowleft": "Left", "arrowright": "Right", "up": "Up", "down": "Down", "left": "Left", "right": "Right", "home": "Home", "end": "End", "pageup": "Page_Up", "pagedown": "Page_Down", "page_up": "Page_Up", "page_down": "Page_Down"}


def command(*args):
    return subprocess.run(["xdotool", *map(str, args)], check=True, capture_output=True, text=True, timeout=3).stdout.strip()


def check(event, deadline):
    if event.is_set() or time.monotonic() >= deadline:
        raise RuntimeError("Input stopped before the remaining steps")


def run_actions(request, event):
    completed = 0
    attempted = False
    deadline = time.monotonic() + min(60, max(1, request.get("timeoutMs", 20000) / 1000))
    held_keys = []
    button_down = False
    def send(*args):
        nonlocal attempted
        check(event, deadline)
        attempted = True
        return command(*args)
    def move(point):
        position = ["mousemove"]
        if request.get("windowId") is not None:
            position += ["--window", int(request["windowId"])]
        send(*position, round(point["x"]), round(point["y"]))
    try:
        for action in request["steps"]:
            check(event, deadline)
            kind = action["type"]
            if kind == "type":
                text = action.get("text", "")
                # Local chunks bound cancellation latency without provider round trips.
                for offset in range(0, len(text), 32):
                    send("type", "--delay", "1", "--", text[offset:offset + 32])
            elif kind == "key":
                key = KEYS.get(action["key"].lower(), action["key"])
                if key.startswith("-") or not re.fullmatch(r"[A-Za-z0-9_+.-]{1,24}", key):
                    raise RuntimeError("Unsupported key; use type for ordinary text")
                chord = "+".join([MODIFIERS[m] for m in action.get("modifiers", [])] + [key])
                send("key", "--clearmodifiers", chord)
            elif kind == "wait":
                until = min(deadline, time.monotonic() + min(3, max(0, action.get("ms", 0) / 1000)))
                while time.monotonic() < until:
                    check(event, deadline)
                    event.wait(min(0.02, until - time.monotonic()))
            elif kind == "move":
                move(action)
            elif kind in ["click", "double_click", "triple_click"]:
                for modifier in action.get("modifiers", []):
                    key = MODIFIERS[modifier]
                    send("keydown", key)
                    held_keys.append(key)
                move(action)
                for _ in range({"click": 1, "double_click": 2, "triple_click": 3}[kind]):
                    send("mousedown", 1)
                    button_down = True
                    # Release must happen even if cancellation races the down event.
                    command("mouseup", 1)
                    button_down = False
                    event.wait(0.04)
                for key in held_keys:
                    command("keyup", key)
                held_keys = []
            elif kind == "drag":
                points = action["path"]
                move(points[0])
                send("mousedown", 1)
                button_down = True
                for point in points[1:]:
                    move(point)
                    event.wait(0.01)
                command("mouseup", 1)
                button_down = False
            elif kind == "scroll":
                move(action)
                for name, positive, negative in [("delta_y", 4, 5), ("delta_x", 6, 7)]:
                    distance = action.get(name, 0)
                    for _ in range(min(24, round(abs(distance) / 100))):
                        send("click", positive if distance > 0 else negative)
                        event.wait(0.01)
            elif kind in ["press", "set_value"]:
                attempted = True
                semantic_action(action, request, event, deadline)
            else:
                raise RuntimeError("Unsupported input action")
            completed += 1
        return {"completed": completed, "attempted": attempted}
    except Exception as error:
        return {"completed": completed, "attempted": attempted, "error": str(error)[:300]}
    finally:
        if button_down:
            try: command("mouseup", 1)
            except Exception: pass
        for key in held_keys:
            try: command("keyup", key)
            except Exception: pass


# AT-SPI is optional: raw X11 desktops retain their visual tools. A real Linux
# accessibility session adds semantic controls without guessing image targets.
ACCESSIBLE = {}
OBSERVATION = None
OBSERVED_WINDOW = None
SCOPED_ROOT = None
try:
    import gi
    gi.require_version("Atspi", "2.0")
    from gi.repository import Atspi, GLib
    Atspi.set_timeout(500, 500)
except (ImportError, ValueError):
    Atspi = None


def window_root(window_id):
    """Resolve one X11 client to a unique accessible top-level window.

    PID alone is insufficient: one application can expose several overlapping
    windows. An ambiguous/missing match withholds semantics; pixels still work.
    """
    pid = int(command("getwindowpid", window_id))
    title = command("getwindowname", window_id)
    geometry = dict(line.split("=", 1) for line in command("getwindowgeometry", "--shell", window_id).splitlines() if "=" in line)
    expected = tuple(int(geometry[key]) for key in ["X", "Y", "WIDTH", "HEIGHT"])
    matches = []
    desktop = Atspi.get_desktop(0)
    if desktop.get_child_count() > 128: return None
    until = time.monotonic() + 3
    for index in range(desktop.get_child_count()):
        if time.monotonic() >= until: return None
        app = desktop.get_child_at_index(index)
        if app is None or app.get_process_id() != pid: continue
        if app.get_child_count() > 128: return None
        for child_index in range(app.get_child_count()):
            if time.monotonic() >= until: return None
            item = app.get_child_at_index(child_index)
            if item is None or item.get_name() != title: continue
            component = item.get_component_iface()
            if component is None: continue
            rect = component.get_extents(Atspi.CoordType.SCREEN)
            if (rect.x, rect.y, rect.width, rect.height) == expected:
                matches.append(item)
    return matches[0] if len(matches) == 1 else None


def read_accessibility(request):
    global ACCESSIBLE, OBSERVATION, OBSERVED_WINDOW, SCOPED_ROOT
    ACCESSIBLE = {}
    OBSERVATION = request["observationId"]
    OBSERVED_WINDOW = request.get("windowId")
    SCOPED_ROOT = None
    if Atspi is None:
        return {"elements": [], "capability": "unavailable"}
    region = request["region"]
    if OBSERVED_WINDOW:
        try: SCOPED_ROOT = window_root(OBSERVED_WINDOW)
        except Exception: return {"elements": [], "capability": "unavailable"}
        if SCOPED_ROOT is None: return {"elements": [], "capability": "unavailable"}
    result = []
    scanned = 0
    stack = [SCOPED_ROOT if SCOPED_ROOT is not None else Atspi.get_desktop(0)]
    until = time.monotonic() + 3
    while stack and scanned < 2500 and len(result) < 400 and time.monotonic() < until:
        item = stack.pop()
        scanned += 1
        try:
            if item is None: continue
            role = item.get_role_name().lower()
            if "password" in role: continue
            # Traverse even a nonvisual/container node whose other interfaces
            # are unavailable; otherwise a failed parent hides working controls.
            count = item.get_child_count()
            for index in range(min(count, 600) - 1, -1, -1):
                stack.append(item.get_child_at_index(index))
            states = item.get_state_set()
            component = item.get_component_iface()
            if component is not None and states.contains(Atspi.StateType.SHOWING):
                rect = component.get_extents(Atspi.CoordType.SCREEN)
                left, top = max(region["x"], rect.x), max(region["y"], rect.y)
                right, bottom = min(region["x"] + region["width"], rect.x + rect.width), min(region["y"] + region["height"], rect.y + rect.height)
                if right > left and bottom > top:
                    action = item.get_action_iface()
                    editable = item.get_editable_text_iface()
                    name = (item.get_name() or "")[:300]
                    normalized = {"push button": "button", "text": "textbox", "entry": "textbox", "check box": "checkbox", "radio button": "radio", "combo box": "combobox", "scroll pane": "region", "table row": "row", "menu item": "menuitem"}.get(role, role)
                    if name or action or editable:
                        ref = "a" + str(len(result) + 1)
                        ACCESSIBLE[ref] = item
                        result.append({"ref": ref, "role": normalized, "name": name, "label": name,
                          "press": bool(action and action.get_n_actions()), "settable": editable is not None,
                          "disabled": not states.contains(Atspi.StateType.SENSITIVE),
                          **({"checked": states.contains(Atspi.StateType.CHECKED)} if normalized in ["checkbox", "radio"] else {}),
                          "bounds": {"x": left - region["x"], "y": top - region["y"], "width": right - left, "height": bottom - top}})
        except Exception:
            continue
    return {"elements": result, "capability": "atspi", "truncated": bool(stack)}


def perform_semantic_action(action, request, event, deadline):
    if request.get("observationId") != OBSERVATION:
        raise RuntimeError("The accessibility observation expired")
    item = ACCESSIBLE.get(action.get("ref"))
    if item is None:
        raise RuntimeError("The accessible control is unavailable")
    if request.get("windowId") != OBSERVED_WINDOW:
        raise RuntimeError("The accessibility observation belongs to another window scope")
    if SCOPED_ROOT is not None:
        if window_root(OBSERVED_WINDOW) != SCOPED_ROOT:
            raise RuntimeError("The selected accessible window changed")
        ancestor = item
        for _ in range(256):
            if ancestor is None or ancestor == SCOPED_ROOT: break
            ancestor = ancestor.get_parent()
        if ancestor != SCOPED_ROOT:
            raise RuntimeError("The control left the selected window")
    states = item.get_state_set()
    if not states.contains(Atspi.StateType.SHOWING) or not states.contains(Atspi.StateType.SENSITIVE):
        raise RuntimeError("The accessible control is no longer ready")
    if "password" in item.get_role_name().lower():
        raise RuntimeError("Use the desktop directly for protected fields")
    if action["type"] == "set_value":
        editable = item.get_editable_text_iface()
        check(event, deadline)
        if editable is None or not editable.set_text_contents(action["text"]):
            raise RuntimeError("The field refused its text")
    elif item.get_editable_text_iface() is not None:
        component = item.get_component_iface()
        check(event, deadline)
        if not component.grab_focus():
            raise RuntimeError("The text field refused focus")
    else:
        interface = item.get_action_iface()
        check(event, deadline)
        if interface is None or not interface.do_action(0):
            raise RuntimeError("The control refused its action")


ACCESSIBILITY_EXECUTOR = concurrent.futures.ThreadPoolExecutor(max_workers=1)


def semantic_call(function, *args):
    def execute():
        # libatspi and its cache stay on one thread. Running a separate GLib
        # loop while synchronous AT-SPI calls run elsewhere can steal replies.
        if Atspi is not None:
            context = GLib.MainContext.default()
            while context.pending(): context.iteration(False)
        return function(*args)
    future = ACCESSIBILITY_EXECUTOR.submit(execute)
    try: return future.result(timeout=8)
    except concurrent.futures.TimeoutError:
        future.cancel()
        raise RuntimeError("The accessibility operation timed out")


def accessibility(request):
    return semantic_call(read_accessibility, request)


def semantic_action(action, request, event, deadline):
    def execute():
        # A queued call must recheck cancellation when its thread actually runs.
        check(event, deadline)
        return perform_semantic_action(action, request, event, deadline)
    return semantic_call(execute)


class Handler(socketserver.StreamRequestHandler):
    def handle(self):
        global LAST_USED
        LAST_USED = time.monotonic()
        with STATE:
            for key in list(CANCELED):
                if LAST_USED - CANCELED[key] > 120: CANCELED.pop(key, None)
        try:
            line = self.rfile.readline(131073)
            if len(line) > 131072: raise RuntimeError("Input request is too large")
            request = json.loads(line)
            operation = request.get("operation")
            if operation == "cancel":
                with STATE:
                    CANCELED[request["id"]] = time.monotonic()
                    event = ACTIVE.get(request["id"])
                    if event: event.set()
                value = {"canceled": event is not None}
            elif operation == "ping":
                value = {"ready": True}
            else:
                event = threading.Event()
                with STATE:
                    if request["id"] in ACTIVE: raise RuntimeError("Duplicate request identity")
                    if request["id"] in CANCELED: event.set()
                    ACTIVE[request["id"]] = event
                try:
                    with LOCK:
                        check(event, time.monotonic() + 1)
                        value = accessibility(request) if operation == "observe" else run_actions(request, event)
                finally:
                    with STATE: ACTIVE.pop(request["id"], None)
            self.wfile.write((json.dumps(value) + "\n").encode())
        except Exception as error:
            self.wfile.write((json.dumps({"completed": 0, "error": str(error)[:300]}) + "\n").encode())


class Server(socketserver.ThreadingUnixStreamServer):
    daemon_threads = True


def idle_shutdown(server):
    while True:
        time.sleep(10)
        with STATE:
            if not ACTIVE and time.monotonic() - LAST_USED > 120:
                server.shutdown()
                return


try:
    with Server(SOCKET, Handler) as server:
        server.timeout = 1
        threading.Thread(target=idle_shutdown, args=(server,), daemon=True).start()
        server.serve_forever(poll_interval=0.1)
finally:
    try: os.unlink(SOCKET)
    except FileNotFoundError: pass
