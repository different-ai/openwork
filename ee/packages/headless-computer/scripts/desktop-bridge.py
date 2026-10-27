#!/usr/bin/python3 -I
"""The command user's only privileged desktop entry point. All executable inputs are image-owned."""
import fcntl
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import secrets
import signal
import subprocess
import sys
import time

ROOT = Path('/usr/local/share/openwork-desktop')
STATE = Path('/var/lib/openwork-desktop')
ROUTES = {'/health', '/viewer', '/continue', '/stop', '/browser/task', '/computer/task', '/computer/program', '/browser/demonstration'}
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
       'LANG': 'C.UTF-8', 'DISPLAY': ':99', 'XAUTHORITY': '/run/openwork-desktop/99/.Xauthority'}


def arguments(argv):
    if argv == ['command']:
        return 'command', None
    if len(argv) == 2 and argv[0] == 'start' and re.fullmatch('[a-f0-9]{64}', argv[1]):
        return 'start', argv[1]
    if len(argv) == 2 and argv[0] == 'call' and argv[1] in ROUTES:
        return 'call', argv[1]
    raise ValueError('Use command, start VERSION or call with a supported desktop route.')


def call(route, body):
    # Never return the bearer, accept a destination URL, or follow a redirect.
    token = (STATE / 'token').read_text().strip()
    connection = http.client.HTTPConnection('127.0.0.1', 6080, timeout=2 if route == '/health' else 10 if route == '/stop' else 125)
    try:
        connection.request('POST', route, body, {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
        response = connection.getresponse()
        data = response.read(32 * 1024 * 1024)
        if response.status != 200:
            raise RuntimeError('Desktop operation did not finish. Inspect it before retrying.')
        return json.loads(data)
    finally:
        connection.close()


def version():
    digest = hashlib.sha256()
    digest.update((ROOT / 'guest.version').read_bytes())
    # Diagnostics can only be configured by the image operator, never through sudo arguments.
    private = Path('/etc/openwork-desktop/private-browsing').is_file()
    if private:
        digest.update(b'private-browsing')
    return digest.hexdigest(), private


def start(expected):
    actual, private = version()
    if expected != actual:
        raise RuntimeError('The desktop image is out of date. Rebuild its snapshot for this runner.')
    STATE.mkdir(mode=0o711, parents=True, exist_ok=True)
    os.chmod(STATE, 0o711)
    with (STATE / 'start.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if call('/health', '{}').get('version') == actual:
                return {'ok': True, 'version': actual}
        except (OSError, ValueError, RuntimeError, http.client.HTTPException):
            pass
        pidfile = STATE / 'guest.pid'
        if pidfile.exists():
            pid = int(pidfile.read_text())
            try:
                command = Path(f'/proc/{pid}/cmdline').read_bytes().split(b'\0')
                if command[:2] == [b'/usr/local/bin/node', os.fsencode(ROOT / 'guest.mjs')]:
                    os.kill(pid, signal.SIGTERM)
                    for _ in range(50):
                        if not Path(f'/proc/{pid}').exists():
                            break
                        time.sleep(0.1)
                    else:
                        os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            except FileNotFoundError:
                pass
        subprocess.run(['/bin/sh', str(ROOT / 'start.sh'), str(STATE), ':99'],
                       env={**ENV, 'WORKBOT_DESKTOP_VNC': '1'}, check=True, timeout=30)
        if not (STATE / 'token').exists():
            (STATE / 'token').write_text(secrets.token_urlsafe(32))
        env = {**ENV, 'WORKBOT_DESKTOP_STATE': str(STATE), 'WORKBOT_DESKTOP_VERSION': actual}
        if private:
            env['WORKBOT_DESKTOP_PRIVATE_BROWSING'] = '1'
        with (STATE / 'guest.log').open('ab') as log:
            child = subprocess.Popen(['/usr/local/bin/node', str(ROOT / 'guest.mjs')], env=env,
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        pidfile.write_text(str(child.pid))
    return {'ok': True, 'version': actual}


def main(argv):
    operation, argument = arguments(argv)
    if os.geteuid() != 0:
        raise PermissionError('The desktop helper must run through its installed sudo rule.')
    os.umask(0o077)
    if operation == 'start':
        return start(argument)
    limit = 1024 * 1024 if operation == 'command' else 65536
    body = sys.stdin.buffer.read(limit + 1)
    if len(body) > limit:
        raise ValueError('Desktop request is too large.')
    parsed = json.loads(body)
    if not isinstance(parsed, dict):
        raise ValueError('Desktop requests must be JSON objects.')
    if operation == 'command':
        if set(parsed) != {'command'} or not isinstance(parsed['command'], str):
            raise ValueError('Provide only a shell command.')
        # The provider account can operate the bridge; the model's shell cannot.
        # No host or desktop bearer enters the command process environment.
        env = {'PATH': ENV['PATH'] + ':/home/openwork-command/.local/bin', 'HOME': '/home/openwork-command', 'LANG': 'C.UTF-8',
               'WORKBOT_COMMAND': parsed['command']}
        os.execve('/usr/sbin/runuser', ['runuser', '-u', 'openwork-command', '--', '/bin/bash', '-c',
                  'umask 007; cd /workspace; exec bash -c "$WORKBOT_COMMAND"'], env)
    return call(argument, body)


if __name__ == '__main__':
    try:
        print(json.dumps(main(sys.argv[1:])))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
