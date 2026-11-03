#!/usr/bin/python3 -I
"""The command user's only privileged desktop entry point.

Every executable input is image-owned except the guest bundle, which the provider account replaces with `install` so a
new runner's guest reaches a running computer without rebuilding it. The model's shell can't run this helper.
"""
import fcntl
import gzip
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import pwd
import re
import secrets
import shutil
import signal
import subprocess
import sys
import tarfile
import time

ROOT = Path('/usr/local/share/openwork-desktop')
STATE = Path('/var/lib/openwork-desktop')
ROUTES = {'/health', '/viewer', '/continue', '/stop', '/browser/task', '/computer/task', '/computer/program', '/browser/demonstration'}
ENV = {'PATH': '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', 'HOME': '/root',
       'LANG': 'C.UTF-8', 'DISPLAY': ':99', 'XAUTHORITY': '/run/openwork-desktop/99/.Xauthority'}
IDENTITY = '[a-f0-9]{64}'
# What a replacement computer carries over: the browser's profile and the workspace.
CARRIED = {'profile': STATE / 'cloud-desktop' / 'profile', 'workspace': Path('/workspace')}
# What the browser rebuilds or locks to its host, by folder or file name at any depth: never carried.
BROWSER_REBUILDS = {'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'GraphiteDawnCache', 'ShaderCache', 'DawnCache',
                    'DawnGraphiteCache', 'DawnWebGPUCache', 'CacheStorage', 'ScriptCache', 'component_crx_cache',
                    'extensions_crx_cache', 'optimization_guide_model_store', 'Crashpad', 'BrowserMetrics',
                    'SingletonLock', 'SingletonSocket', 'SingletonCookie'}
MAX_GUEST_BYTES = 64 * 1024 * 1024
MAX_CARRIED_BYTES = 100 * 1024 * 1024


def arguments(argv):
    if argv in (['command'], ['versions']):
        return argv[0], None
    if len(argv) == 3 and argv[0] == 'start' and all(re.fullmatch(IDENTITY, value) for value in argv[1:]):
        return 'start', argv[1:]
    if len(argv) == 4 and argv[0] == 'install' and all(re.fullmatch(IDENTITY, value) for value in argv[1:]):
        return 'install', argv[1:]
    if len(argv) == 2 and argv[0] in ('export', 'import') and argv[1] in CARRIED:
        return argv[0], argv[1]
    if len(argv) == 2 and argv[0] == 'call' and argv[1] in ROUTES:
        return 'call', argv[1]
    raise ValueError('Use command, versions, start IMAGE GUEST, install IMAGE GUEST SHA256, export or import profile|workspace, or call a supported desktop route.')


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


def identities():
    # A computer built before images and guests had separate identities has no image.version.
    image = ROOT / 'image.version'
    return (image.read_text().strip() if image.is_file() else ''), (ROOT / 'guest.version').read_text().strip()


def version():
    digest = hashlib.sha256()
    image = ROOT / 'image.version'
    if image.is_file():
        digest.update(image.read_bytes())
    digest.update((ROOT / 'guest.version').read_bytes())
    # Diagnostics can only be configured by the image operator, never through sudo arguments.
    private = Path('/etc/openwork-desktop/private-browsing').is_file()
    if private:
        digest.update(b'private-browsing')
    return digest.hexdigest(), private


def start(expected):
    image, guest = identities()
    if expected[0] != image:
        raise RuntimeError('The desktop image is out of date. Rebuild its snapshot for this runner.')
    if expected[1] != guest:
        raise RuntimeError("The desktop guest is out of date. Install this runner's guest.")
    actual, private = version()
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
        subprocess.run(['/bin/sh', str(ROOT / 'start.sh'), str(STATE), ':99', ':100'],
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


def read_limited(limit, message):
    data = sys.stdin.buffer.read(limit + 1)
    if len(data) > limit:
        raise ValueError(message)
    return data


def install(expected):
    """Replaces the guest with the gzipped bundle on stdin, for this image only. `start` then runs it."""
    image, sha256 = expected[0], expected[2]
    if image != identities()[0]:
        raise RuntimeError('The desktop image is out of date. Rebuild its snapshot for this runner.')
    compressed = read_limited(MAX_GUEST_BYTES, 'The desktop guest is too large.')
    with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as source:
        bundle = source.read(MAX_GUEST_BYTES + 1)
    if len(bundle) > MAX_GUEST_BYTES:
        raise ValueError('The desktop guest is too large.')
    if hashlib.sha256(bundle).hexdigest() != sha256:
        raise ValueError('The desktop guest does not match its checksum.')
    # The bundle first, then the identity naming it: an interrupted install leaves an out-of-date guest, never a
    # current identity on old code.
    for name, data in (('guest.mjs', bundle), ('guest.version', f'{expected[1]}\n'.encode())):
        temporary = ROOT / f'.{name}.new'
        with open(temporary, 'wb') as file:
            file.write(data)
            file.flush()
            os.fsync(file.fileno())
        os.chown(temporary, 0, 0)
        os.chmod(temporary, 0o644)
        os.replace(temporary, ROOT / name)
    return {'ok': True}


def stop_browser():
    """Closes the browser and its display so its profile is quiet; `start` opens them again."""
    subprocess.run(['pkill', '-TERM', '-u', 'openwork-browser'], check=False)
    for _ in range(50):
        if subprocess.run(['pgrep', '-u', 'openwork-browser'], stdout=subprocess.DEVNULL, check=False).returncode != 0:
            return
        time.sleep(0.1)
    subprocess.run(['pkill', '-KILL', '-u', 'openwork-browser'], check=False)


class Limited:
    """A write-only stream that refuses to grow past `limit` bytes."""
    def __init__(self, stream, limit):
        self.stream, self.limit, self.written = stream, limit, 0

    def write(self, data):
        self.written += len(data)
        if self.written > self.limit:
            raise ValueError('There is too much to carry over.')
        return self.stream.write(data)

    def flush(self):
        self.stream.flush()


def export(name):
    """Writes the carried state as a gzipped tar to stdout. The browser is closed first, so its files are complete."""
    source = CARRIED[name]
    if name == 'profile':
        stop_browser()

    def keep(member):
        path = Path(member.name)
        if name == 'profile' and path.name in BROWSER_REBUILDS:
            return None
        # The runner copies the person's Files in again, and background jobs don't move with the computer.
        if name == 'workspace' and (path.parts[:1] == ('files',) or path.parts[:1] == ('.jobs',) and path.suffix == '.running'):
            return None
        return member
    with tarfile.open(fileobj=Limited(sys.stdout.buffer, MAX_CARRIED_BYTES), mode='w|gz') as archive:
        if source.is_dir():
            archive.add(source, arcname='.', filter=keep)
    sys.stdout.buffer.flush()


def carried(member, destination):
    """Extraction filter: tarfile's own refusals (absolute names, names outside the destination even through links made
    earlier), plus hard links only within it and no special files. Owners and group-shared modes are kept, which
    tarfile's filters drop; setuid never is, and setgid only on folders."""
    mode = member.mode
    member = tarfile.tar_filter(member, destination)
    if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
        return None
    if member.islnk():
        root = os.path.realpath(destination)
        if os.path.commonpath([root, os.path.realpath(os.path.join(root, member.linkname))]) != root:
            return None
    return member.replace(mode=mode & (0o2777 if member.isdir() else 0o777), deep=False) if mode is not None else member


def import_state(name):
    """Unpacks state another computer exported (stdin) into this one. A profile replaces the browser's own."""
    if not hasattr(tarfile, 'tar_filter'):
        raise RuntimeError("This computer's Python can't unpack carried state safely.")
    data = read_limited(MAX_CARRIED_BYTES, 'There is too much to carry over.')
    target = CARRIED[name]
    if name == 'workspace':
        with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
            archive.extractall(target, numeric_owner=True, filter=carried)
        return {'ok': True}
    # The browser's folder is its own account's: close every process of that account first, and unpack in root's
    # state folder, so nothing can swap a path out from under root while it writes.
    stop_browser()
    staged, previous = STATE / '.carried-profile', STATE / '.previous-profile'
    for path in (staged, previous):
        shutil.rmtree(path, ignore_errors=True)
    staged.mkdir(mode=0o700)
    with tarfile.open(fileobj=io.BytesIO(data), mode='r:gz') as archive:
        archive.extractall(staged, numeric_owner=True, filter=carried)
    browser = pwd.getpwnam('openwork-browser')
    for directory, folders, files in os.walk(staged):
        os.lchown(directory, browser.pw_uid, browser.pw_gid)
        for entry in folders + files:
            os.lchown(os.path.join(directory, entry), browser.pw_uid, browser.pw_gid)
    if target.exists():
        os.replace(target, previous)
    os.replace(staged, target)
    shutil.rmtree(previous, ignore_errors=True)
    return {'ok': True}


def main(argv):
    operation, argument = arguments(argv)
    if os.geteuid() != 0:
        raise PermissionError('The desktop helper must run through its installed sudo rule.')
    os.umask(0o077)
    if operation == 'versions':
        image, guest = identities()
        return {'image': image, 'guest': guest}
    if operation == 'start':
        return start(argument)
    if operation == 'install':
        return install(argument)
    if operation == 'export':
        return export(argument)
    if operation == 'import':
        return import_state(argument)
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
        result = main(sys.argv[1:])
        # `export` writes its archive to stdout itself.
        if result is not None:
            print(json.dumps(result))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
