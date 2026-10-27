import importlib.util
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('x11_worker', Path(__file__).with_name('computer-x11-worker.py'))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


class ScopedKeys(unittest.TestCase):
    def test_scoped_text_and_shortcuts_name_the_destination_even_after_focus_check(self):
        commands = []
        with patch.object(worker, 'focused_windows', return_value={17}), patch.object(worker, 'command', side_effect=lambda *args: commands.append(args)):
            result = worker.run_actions({'windowId': 17, 'steps': [{'type': 'type', 'text': 'private text'}, {'type': 'key', 'key': 'enter'}]}, threading.Event())
        self.assertEqual(result['completed'], 2)
        self.assertEqual(commands, [('type', '--window', '17', '--delay', '1', '--', 'private text'), ('key', '--window', '17', '--clearmodifiers', 'Return')])

    def test_lost_focus_does_not_dispatch_any_keys(self):
        with patch.object(worker, 'focused_windows', return_value={99}), patch.object(worker, 'command') as command:
            result = worker.run_actions({'windowId': 17, 'steps': [{'type': 'type', 'text': 'private text'}]}, threading.Event())
        self.assertEqual(result['completed'], 0)
        self.assertFalse(result['attempted'])
        command.assert_not_called()

    def test_cancellation_between_focus_check_and_dispatch_sends_nothing(self):
        stop = threading.Event()
        def focus():
            stop.set()
            return {17}
        with patch.object(worker, 'focused_windows', side_effect=focus), patch.object(worker, 'command') as command:
            result = worker.run_actions({'windowId': 17, 'steps': [{'type': 'key', 'key': 'enter'}]}, stop)
        self.assertFalse(result['attempted'])
        command.assert_not_called()


if __name__ == '__main__':
    unittest.main()
