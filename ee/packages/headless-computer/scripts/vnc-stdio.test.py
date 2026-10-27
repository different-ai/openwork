import importlib.util
import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('vnc_stdio', Path(__file__).with_name('vnc-stdio.py'))
vnc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(vnc)


class ViewerTests(unittest.TestCase):
    def test_private_duplex_socket_relays_input_and_output_without_a_tcp_listener(self):
        incoming, send = os.pipe()
        receive, outgoing = os.pipe()
        os.write(send, b'viewer input')
        os.close(send)
        popen = subprocess.Popen
        commands = []
        processes = []
        def server(command, **kwargs):
            commands.append(command)
            # Like x11vnc -inetd, the server reads and writes the same socket fd.
            process = popen([sys.executable, '-c', 'import socket; s=socket.socket(fileno=0); data=s.recv(65536); s.sendall(b"RFB private:"+data)'], **kwargs)
            processes.append(process)
            return process
        try:
            with patch.object(vnc.os, 'geteuid', return_value=0), patch.object(vnc.signal, 'signal'), patch.object(vnc.subprocess, 'Popen', side_effect=server):
                vnc.serve('computer', 'view', incoming, outgoing)
            os.close(outgoing); outgoing = None
            self.assertEqual(os.read(receive, 65536), b'RFB private:viewer input')
            self.assertIn('-inetd', commands[0])
            self.assertIn('-viewonly', commands[0])
            self.assertNotIn('-rfbport', commands[0])
            self.assertIn('-wait', commands[0])
            self.assertEqual(commands[0][commands[0].index('-wait') + 1], '100')
        finally:
            for fd in (incoming, receive, outgoing):
                if fd is not None: os.close(fd)

    def test_only_the_privileged_guest_can_start_valid_viewers(self):
        for uid, view, control in [(1000, 'computer', 'view'), (0, 'other', 'view'), (0, 'computer', 'other')]:
            with patch.object(vnc.os, 'geteuid', return_value=uid), self.assertRaises(PermissionError):
                vnc.serve(view, control)


if __name__ == '__main__':
    unittest.main()
