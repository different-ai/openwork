#!/usr/bin/python3 -I
"""One private RFB transport per viewer; no shared TCP listener to impersonate."""
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import threading


def serve(view, control, input_fd=0, output_fd=1):
    if os.geteuid() != 0 or view not in ('browser', 'computer') or control not in ('control', 'view'):
        raise PermissionError('The image-owned guest must start this viewer.')
    state = Path('/var/lib/openwork-desktop')
    extra = []
    if view == 'browser':
        window = (state / 'browser-window').read_text().strip()
        if not window.isdecimal():
            raise ValueError('The browser window is unavailable.')
        extra += ['-id', window]
    if control == 'view':
        extra += ['-viewonly']
    # x11vnc already sends only changed regions; also poll and send at most ~10 times a second
    # (default ~50) unless the viewer is typing or pointing, which cuts both to 25 ms.
    pacing = ['-wait', '100', '-defer', '100', '-wait_ui', '4']
    # x11vnc's inetd mode needs a duplex socket as fd 0, rather than a pipe.
    parent, child = socket.socketpair()
    process = None
    def interrupted(_signal, _frame):
        raise SystemExit(0)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        process = subprocess.Popen(['/usr/sbin/runuser', '-u', 'openwork-browser', '--', 'x11vnc', '-inetd', '-q',
                                    '-display', ':99', '-auth', '/run/openwork-desktop/99/.Xauthority',
                                    '-nopw', '-noxdamage', *pacing, *extra], stdin=child, stdout=child,
                                   stderr=subprocess.DEVNULL, start_new_session=True,
                                   env={'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/home/openwork-browser',
                                        'USER': 'openwork-browser', 'LOGNAME': 'openwork-browser', 'LANG': 'C.UTF-8'})
        child.close()
        def incoming():
            try:
                while data := os.read(input_fd, 65536):
                    parent.sendall(data)
            except OSError:
                pass
            finally:
                try: parent.shutdown(socket.SHUT_WR)
                except OSError: pass
        threading.Thread(target=incoming, daemon=True).start()
        while data := parent.recv(65536):
            while data:
                written = os.write(output_fd, data)
                data = data[written:]
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        parent.close(); child.close()
        if process is not None:
            # runuser forwards termination and reaps its browser-owned child.
            # Killing the group immediately can orphan that child before reap.
            try: process.terminate()
            except ProcessLookupError: pass
            try: process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try: os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError: pass
                process.wait()


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise ValueError('Choose browser/computer and control/view.')
    serve(*sys.argv[1:])
