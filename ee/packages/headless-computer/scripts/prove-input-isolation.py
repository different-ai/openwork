"""Run in a disposable X11 desktop guest, with the worker source path as argv[1]."""
import ctypes as C
import importlib.util
import json
import os
import socket
import subprocess
import sys
import threading
import time
from unittest.mock import patch

assert '--dedicated-guest' in sys.argv and sys.platform == 'linux' and os.geteuid() == 0
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('worker', sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)

# The command account keeps ordinary local previews, but cannot bypass the
# broker through CDP, any VNC variant, or the guest HTTP listener.
vnc = []
for port in [5900, 5901, 5902, 5903]:
    listener = socket.socket(); listener.bind(('127.0.0.1', port)); listener.listen(4)
    vnc.append(listener)
for port in [6080, 9222]:
    with socket.create_connection(('127.0.0.1', port), 1):
        pass
preview = socket.socket(); preview.bind(('127.0.0.1', 0)); preview.listen(4)
ipv6 = socket.socket(socket.AF_INET6); ipv6.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
ipv6.bind(('::1', 6080)); ipv6.listen(4)
try:
    probe = '''import socket
for port in [5900,5901,5902,5903,6080,9222]:
    s=socket.socket(); s.settimeout(1)
    assert s.connect_ex(('127.0.0.1',port)) != 0, port
    s.close()
s=socket.socket(socket.AF_INET6); s.settimeout(1)
assert s.connect_ex(('::1',6080)) != 0
s.close()
'''+f"with socket.create_connection(('127.0.0.1',{preview.getsockname()[1]}),1): pass\n"
    subprocess.run(['runuser', '-u', 'openwork-command', '--', 'python3', '-c', probe], check=True)
finally:
    preview.close(); ipv6.close()
    for listener in vnc: listener.close()


class Key(C.Structure):
    _fields_ = [('type', C.c_int), ('serial', C.c_ulong), ('send_event', C.c_int), ('display', C.c_void_p),
                ('window', C.c_ulong), ('root', C.c_ulong), ('subwindow', C.c_ulong), ('time', C.c_ulong),
                ('x', C.c_int), ('y', C.c_int), ('x_root', C.c_int), ('y_root', C.c_int),
                ('state', C.c_uint), ('keycode', C.c_uint), ('same_screen', C.c_int)]


class Event(C.Union):
    _fields_ = [('key', Key), ('padding', C.c_long * 24)]


x = C.CDLL('libX11.so.6')
x.XOpenDisplay.argtypes = [C.c_char_p]; x.XOpenDisplay.restype = C.c_void_p
x.XDefaultRootWindow.argtypes = [C.c_void_p]; x.XDefaultRootWindow.restype = C.c_ulong
x.XCreateSimpleWindow.argtypes = [C.c_void_p, C.c_ulong, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint, C.c_ulong, C.c_ulong]
x.XCreateSimpleWindow.restype = C.c_ulong
x.XSelectInput.argtypes = [C.c_void_p, C.c_ulong, C.c_long]
x.XMapWindow.argtypes = [C.c_void_p, C.c_ulong]
x.XSetInputFocus.argtypes = [C.c_void_p, C.c_ulong, C.c_int, C.c_ulong]
x.XSync.argtypes = [C.c_void_p, C.c_int]
x.XPending.argtypes = [C.c_void_p]; x.XPending.restype = C.c_int
x.XNextEvent.argtypes = [C.c_void_p, C.POINTER(Event)]
x.XLookupString.argtypes = [C.POINTER(Key), C.c_char_p, C.c_int, C.c_void_p, C.c_void_p]
x.XLookupString.restype = C.c_int
x.XDestroyWindow.argtypes = [C.c_void_p, C.c_ulong]
x.XCloseDisplay.argtypes = [C.c_void_p]
display = x.XOpenDisplay(None)
assert display, 'The dedicated guest needs a running X server and XAUTHORITY'
windows = []
try:
    for left in [20, 450]:
        window = x.XCreateSimpleWindow(display, x.XDefaultRootWindow(display), left, 40, 320, 200, 0, 0, 0xffffff)
        windows.append(window)
        x.XSelectInput(display, window, 3)
        x.XMapWindow(display, window)
    x.XSync(display, 0)
    time.sleep(.2)
    approved, other = windows

    def steal_focus_after_check():
        x.XSetInputFocus(display, other, 1, 0)
        x.XSync(display, 0)
        return {approved}

    x.XSetInputFocus(display, approved, 1, 0); x.XSync(display, 0)
    with patch.object(worker, 'focused_windows', side_effect=steal_focus_after_check):
        result = worker.run_actions({'windowId': approved, 'steps': [{'type': 'type', 'text': 'windowsecret'}, {'type': 'key', 'key': 'enter'}]}, threading.Event())
    assert result.get('completed') == 2, result
    x.XSync(display, 0)
    received = {window: b'' for window in windows}
    while x.XPending(display):
        event = Event(); x.XNextEvent(display, C.byref(event))
        if event.key.type == 2 and event.key.window in received:
            buffer = C.create_string_buffer(64)
            count = x.XLookupString(C.byref(event.key), buffer, 64, None, None)
            received[event.key.window] += buffer.raw[:count]
    assert received[approved] == b'windowsecret\r', received
    assert received[other] == b'', received
    print(json.dumps({'focusStolenBeforeDispatch': True, 'approvedWindowReceivedTextAndKey': True, 'otherWindowReceivedNothing': True,
                      'commandControlPortsBlocked': True, 'ipv6ControlBlocked': True, 'ordinaryLoopbackAvailable': True}))
finally:
    for window in windows: x.XDestroyWindow(display, window)
    x.XCloseDisplay(display)
