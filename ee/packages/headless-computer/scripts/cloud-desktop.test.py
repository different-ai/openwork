import ast
import os
from pathlib import Path
import stat
import tempfile
import unittest

script = Path(__file__).resolve().parents[3] / 'apps/den-worker-runtime/scripts/cloud-desktop.sh'
source = script.read_text().split("<<'PY'\n", 1)[1].split('\nPY', 1)[0]
tree = ast.parse(source)
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'prepare_state')
namespace = {'os': os, 'stat': stat}
exec(compile(ast.Module(body=[function], type_ignores=[]), str(script), 'exec'), namespace)
prepare = namespace['prepare_state']


class DesktopRootStateSafety(unittest.TestCase):
    def layout(self, temporary):
        root = Path(temporary).resolve()
        base = root / 'state'; base.mkdir(mode=0o711)
        run = root / 'run'; run.mkdir()
        return root, base, run / 'openwork-desktop/99'

    def test_browser_state_symlinks_are_never_opened_by_root_setup(self):
        with tempfile.TemporaryDirectory() as temporary:
            root, base, runtime = self.layout(temporary)
            profile = base / 'cloud-desktop'; profile.mkdir()
            missing = root / 'must-not-be-created'
            private = root / 'private'; private.write_text('unchanged'); private.chmod(0o600)
            (profile / '.Xauthority').symlink_to(missing)
            for name in ['display.log', 'window-manager.log', 'taskbar.log', 'browser.log']:
                (profile / name).symlink_to(private)
            prepare(str(base), str(runtime), os.getuid(), os.getgid())
            self.assertFalse(missing.exists())
            self.assertEqual(private.read_text(), 'unchanged')
            self.assertEqual(private.stat().st_mode & 0o777, 0o600)
            self.assertEqual((runtime / '.Xauthority').stat().st_mode & 0o777, 0o640)
            self.assertEqual((runtime / 'browser.log').stat().st_mode & 0o777, 0o600)

    def test_runtime_rejects_symlinks_and_hard_links_without_touching_targets(self):
        for kind in ['directory', 'authority', 'log', 'hard-link']:
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as temporary:
                root, base, runtime = self.layout(temporary)
                private = root / 'private'; private.write_text('unchanged'); private.chmod(0o600)
                runtime.parent.mkdir()
                if kind == 'directory':
                    other = root / 'other'; other.mkdir(mode=0o700)
                    runtime.symlink_to(other, target_is_directory=True)
                else:
                    runtime.mkdir(mode=0o710)
                    destination = runtime / ('.Xauthority' if kind == 'authority' else 'browser.log')
                    os.link(private, destination) if kind == 'hard-link' else destination.symlink_to(private)
                with self.assertRaises((OSError, PermissionError)):
                    prepare(str(base), str(runtime), os.getuid(), os.getgid())
                self.assertEqual(private.read_text(), 'unchanged')
                self.assertEqual(private.stat().st_mode & 0o777, 0o600)

    def test_untrusted_runtime_or_base_permissions_fail_closed(self):
        for target in ['base', 'runtime']:
            with self.subTest(target=target), tempfile.TemporaryDirectory() as temporary:
                _, base, runtime = self.layout(temporary)
                if target == 'base': base.chmod(0o777)
                else: runtime.mkdir(parents=True); runtime.chmod(0o777)
                with self.assertRaises(PermissionError):
                    prepare(str(base), str(runtime), os.getuid(), os.getgid())


if __name__ == '__main__':
    unittest.main()
