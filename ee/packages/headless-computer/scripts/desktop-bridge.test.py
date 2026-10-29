import gzip
import hashlib
import importlib.util
import json
import io
import tarfile
import types
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('desktop_bridge', Path(__file__).with_name('desktop-bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class DesktopPrivilegeBoundary(unittest.TestCase):
    def test_model_shell_drops_privileges_and_does_not_inherit_host_credentials(self):
        with patch.object(bridge.os, 'geteuid', return_value=0), patch.object(bridge.os, 'execve') as execute, patch.object(bridge.sys, 'stdin', types.SimpleNamespace(buffer=io.BytesIO(b'{"command":"id -un"}'))):
            # execve replaces the process; the sentinel prevents subsequent route dispatch in the test.
            execute.side_effect = SystemExit
            with self.assertRaises(SystemExit):
                bridge.main(['command'])
            program, argv, env = execute.call_args.args
            self.assertEqual(program, '/usr/sbin/runuser')
            self.assertEqual(argv[1:4], ['-u', 'openwork-command', '--'])
            self.assertEqual(env['HOME'], '/home/openwork-command')
            self.assertEqual(set(env), {'PATH', 'HOME', 'LANG', 'WORKBOT_COMMAND'})

    def test_rejects_commands_destinations_and_extra_arguments(self):
        for args in [['sh', '-c', 'id'], ['call', 'http://example.com'], ['call', '/health', 'extra'],
                     ['start', '/workspace/guest.mjs'], ['call', '/../../tokens'], ['call', '/token']]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                bridge.arguments(args)

    def test_mismatched_image_never_runs_uploaded_code(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'guest.mjs').write_text('trusted image guest')
            (root / 'start.sh').write_text('trusted image startup')
            (root / 'guest.version').write_text('trusted image version')
            with patch.object(bridge, 'ROOT', root), patch.object(bridge.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'out of date'):
                    bridge.start(['0' * 64, '0' * 64])
                run.assert_not_called()

    def test_start_says_whether_the_image_or_only_the_guest_is_out_of_date(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'image.version').write_text('a' * 64 + '\n')
            (root / 'guest.version').write_text('b' * 64 + '\n')
            with patch.object(bridge, 'ROOT', root), patch.object(bridge.subprocess, 'run') as run:
                with self.assertRaisesRegex(RuntimeError, 'image is out of date'):
                    bridge.start(['c' * 64, 'b' * 64])
                with self.assertRaisesRegex(RuntimeError, 'guest is out of date'):
                    bridge.start(['a' * 64, 'c' * 64])
                run.assert_not_called()
                self.assertEqual(bridge.identities(), ('a' * 64, 'b' * 64))


class GuestInstall(unittest.TestCase):
    def install(self, root, image, bundle, sha256):
        stdin = types.SimpleNamespace(buffer=io.BytesIO(gzip.compress(bundle)))
        with patch.object(bridge, 'ROOT', root), patch.object(bridge.os, 'chown'), patch.object(bridge.sys, 'stdin', stdin):
            return bridge.install([image, 'd' * 64, sha256])

    def test_installs_only_onto_its_own_image_and_only_the_bundle_it_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'image.version').write_text('a' * 64 + '\n')
            (root / 'guest.mjs').write_text('image guest')
            (root / 'guest.version').write_text('b' * 64 + '\n')
            bundle = b'new guest'
            with self.assertRaisesRegex(RuntimeError, 'image is out of date'):
                self.install(root, 'c' * 64, bundle, hashlib.sha256(bundle).hexdigest())
            with self.assertRaisesRegex(ValueError, 'checksum'):
                self.install(root, 'a' * 64, bundle, hashlib.sha256(b'other').hexdigest())
            self.assertEqual((root / 'guest.mjs').read_text(), 'image guest')
            self.assertEqual((root / 'guest.version').read_text(), 'b' * 64 + '\n')
            self.assertEqual(self.install(root, 'a' * 64, bundle, hashlib.sha256(bundle).hexdigest()), {'ok': True})
            self.assertEqual((root / 'guest.mjs').read_bytes(), bundle)
            self.assertEqual((root / 'guest.version').read_text(), 'd' * 64 + '\n')
            self.assertEqual(sorted(path.name for path in root.iterdir()), ['guest.mjs', 'guest.version', 'image.version'])

    def test_install_and_carry_arguments_are_checked(self):
        for args in [['install', 'a' * 64, 'b' * 64], ['install', 'a' * 64, 'b' * 64, '/tmp/x'], ['export', '/etc'],
                     ['import', 'profile', 'extra'], ['versions', 'extra'], ['start', 'a' * 64]]:
            with self.subTest(args=args), self.assertRaises(ValueError):
                bridge.arguments(args)


class CarriedState(unittest.TestCase):
    def export(self, name, source, limit=bridge.MAX_CARRIED_BYTES):
        stdout = types.SimpleNamespace(buffer=io.BytesIO())
        with patch.dict(bridge.CARRIED, {name: source}), patch.object(bridge, 'stop_browser') as stop, \
                patch.object(bridge.sys, 'stdout', stdout), patch.object(bridge, 'MAX_CARRIED_BYTES', limit):
            bridge.export(name)
            self.assertEqual(stop.called, name == 'profile')
        return stdout.buffer.getvalue()

    def test_export_leaves_out_browser_caches_locks_copies_of_files_and_running_jobs(self):
        with tempfile.TemporaryDirectory() as directory:
            profile, workspace = Path(directory, 'profile'), Path(directory, 'workspace')
            for path in ['Default/Cookies', 'Default/Cache/data', 'Default/Code Cache/js', 'SingletonLock', 'Local State']:
                Path(profile, path).parent.mkdir(parents=True, exist_ok=True)
                Path(profile, path).write_text('x')
            for path in ['notes.md', 'files/upload.pdf', 'out/report.pdf', '.jobs/build.log', '.jobs/build.running', 'project/files/keep.txt']:
                Path(workspace, path).parent.mkdir(parents=True, exist_ok=True)
                Path(workspace, path).write_text('x')
            names = lambda data: sorted(member.name for member in tarfile.open(fileobj=io.BytesIO(data)) if member.isfile())
            self.assertEqual(names(self.export('profile', profile)), ['./Default/Cookies', './Local State'])
            self.assertEqual(names(self.export('workspace', workspace)), ['./.jobs/build.log', './notes.md', './out/report.pdf', './project/files/keep.txt'])
            with self.assertRaisesRegex(ValueError, 'too much'):
                self.export('workspace', workspace, limit=64)

    def test_workspace_round_trip(self):
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory, 'source'), Path(directory, 'target')
            Path(source, 'out').mkdir(parents=True)
            Path(source, 'out/report.pdf').write_text('report')
            target.mkdir()
            archive = self.export('workspace', source)
            stdin = types.SimpleNamespace(buffer=io.BytesIO(archive))
            with patch.dict(bridge.CARRIED, {'workspace': target}), patch.object(bridge.sys, 'stdin', stdin):
                self.assertEqual(bridge.import_state('workspace'), {'ok': True})
            self.assertEqual(Path(target, 'out/report.pdf').read_text(), 'report')

    def test_unpacking_refuses_escapes_and_special_files_and_keeps_shared_modes(self):
        with tempfile.TemporaryDirectory() as directory:
            def member(name, kind=tarfile.REGTYPE, mode=0o644, linkname=''):
                info = tarfile.TarInfo(name)
                info.type, info.mode, info.linkname = kind, mode, linkname
                return info
            with self.assertRaises(tarfile.FilterError):
                bridge.carried(member('../escape'), directory)
            self.assertEqual(bridge.carried(member('/etc/passwd'), directory).name, 'etc/passwd')
            self.assertIsNone(bridge.carried(member('shadow', tarfile.LNKTYPE, linkname='../../etc/shadow'), directory))
            self.assertIsNone(bridge.carried(member('pipe', tarfile.FIFOTYPE), directory))
            self.assertIsNone(bridge.carried(member('disk', tarfile.BLKTYPE), directory))
            self.assertEqual(bridge.carried(member('out', tarfile.DIRTYPE, 0o2770), directory).mode, 0o2770)
            self.assertEqual(bridge.carried(member('shared.txt', mode=0o660), directory).mode, 0o660)
            self.assertEqual(bridge.carried(member('tool', mode=0o6755), directory).mode, 0o755)
            self.assertEqual(bridge.carried(member('python', tarfile.SYMTYPE, linkname='/usr/bin/python3'), directory).linkname, '/usr/bin/python3')
            self.assertEqual(bridge.carried(member('copy', tarfile.LNKTYPE, linkname='out/report.pdf'), directory).linkname, 'out/report.pdf')

    def test_only_fixed_loopback_destination_and_private_bearer_are_used(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            (state / 'token').write_text('fixture-bearer')
            with patch.object(bridge, 'STATE', state), patch.object(bridge.http.client, 'HTTPConnection') as connect:
                response = connect.return_value.getresponse.return_value
                response.status = 200
                response.read.return_value = b'{"ok":true}'
                self.assertEqual(bridge.call('/health', '{}'), {'ok': True})
                connect.assert_called_once_with('127.0.0.1', 6080, timeout=2)
                self.assertNotIn('fixture-bearer', json.dumps(bridge.call('/health', '{}')))


if __name__ == '__main__':
    unittest.main()
