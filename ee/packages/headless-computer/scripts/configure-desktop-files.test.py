import ast
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

source = Path(__file__).with_name('configure-desktop-files.sh').read_text().split("python3 - <<'PY'\n", 1)[1].rsplit('\nPY', 1)[0]
tree = ast.parse(source)
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'configure_workspace')
namespace = {'os': os, 'subprocess': subprocess}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(__file__), 'exec'), namespace)
configure = namespace['configure_workspace']


class WorkspaceSetupSafety(unittest.TestCase):
    def test_rejects_symlinks_without_changing_the_target(self):
        for name in ('.jobs', 'files', 'out'):
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                workspace = root / 'workspace'; workspace.mkdir()
                target = root / 'private'; target.mkdir(mode=0o700)
                (target / 'secret').write_text('unchanged')
                (workspace / name).symlink_to(target, target_is_directory=True)
                before = target.stat()
                with patch.object(subprocess, 'run'), self.assertRaises(OSError):
                    configure(str(workspace), os.getuid(), os.getgid(), os.getgid())
                self.assertEqual(target.stat().st_mode, before.st_mode)
                self.assertEqual((target / 'secret').read_text(), 'unchanged')

    def test_acl_uses_held_inode_after_directory_is_replaced(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            workspace = root / 'workspace'; workspace.mkdir()
            target = root / 'private'; target.mkdir(mode=0o700)
            calls = []
            def acl(argv, *, pass_fds, check):
                fd = pass_fds[0]
                self.assertEqual(argv[-1], f'/proc/self/fd/{fd}')
                self.assertTrue(check)
                if len(calls) == 1:
                    original = workspace / 'out'
                    original.rename(workspace / 'held-out')
                    original.symlink_to(target, target_is_directory=True)
                    self.assertEqual(os.fstat(fd).st_ino, (workspace / 'held-out').stat().st_ino)
                    self.assertNotEqual(os.fstat(fd).st_ino, target.stat().st_ino)
                calls.append(argv)
            with patch.object(subprocess, 'run', side_effect=acl):
                configure(str(workspace), os.getuid(), os.getgid(), os.getgid())
            self.assertEqual(len(calls), 2)
            self.assertEqual(target.stat().st_mode & 0o777, 0o700)
            self.assertEqual((workspace / '.jobs').stat().st_mode & 0o7777, 0o2770)


if __name__ == '__main__':
    unittest.main()
