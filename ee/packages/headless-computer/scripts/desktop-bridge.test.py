import importlib.util
import json
import io
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
                    bridge.start('0' * 64)
                run.assert_not_called()

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
