import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import types
import tempfile
import unittest
from unittest.mock import patch
sys.dont_write_bytecode = True

ROOT = Path(__file__).resolve().parents[1] / 'src/scripting'


def load(name, mocks):
    spec = importlib.util.spec_from_file_location(name, ROOT / f'{name}.py')
    module = importlib.util.module_from_spec(spec)
    with patch.dict(sys.modules, mocks):
        spec.loader.exec_module(module)
    return module


class AppScriptingSafety(unittest.TestCase):
    def test_stop_during_render_prevents_the_following_save(self):
        bpy = types.ModuleType('bpy')
        saves = []
        bpy.data = types.SimpleNamespace(filepath='/workspace/out/scene.blend')
        bpy.ops = types.SimpleNamespace(wm=types.SimpleNamespace(save_mainfile=lambda: saves.append(True)))
        blender = load('openwork_blender', {'bpy': bpy})
        stopped = False

        def render(*args):
            nonlocal stopped
            stopped = True
            return {'path': '/workspace/out/render.png'}

        with patch.object(blender, '_view3d', return_value=None), patch.object(blender, 'summary', return_value={'unsaved': True}), patch.object(blender, '_render', render):
            result = blender.execute({'code': 'result = 1', 'render': 'final', 'output': '/workspace/out/render.png', 'save': True}, lambda: stopped)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], 'cancelled')
        self.assertEqual(saves, [])

    def test_blender_bridge_uses_the_instance_pid(self):
        blender = load('openwork_blender', {'bpy': types.ModuleType('bpy')})
        with patch.object(blender.sys, 'argv', ['bridge.py', '--', 'serve', '/tmp/scripting']), patch.object(blender.os, 'getpid', return_value=1234), patch.object(blender, 'Bridge') as bridge:
            blender.main()
            bridge.assert_called_once_with('/tmp/scripting/blender-1234.sock')

    def office(self):
        uno = types.ModuleType('uno')
        uno.systemPathToFileUrl = lambda path: 'file://' + path
        uno.fileUrlToSystemPath = lambda path: path.removeprefix('file://')
        beans = types.ModuleType('com.sun.star.beans')
        beans.PropertyValue = type('PropertyValue', (), {})
        connection = types.ModuleType('com.sun.star.connection')
        connection.NoConnectException = type('NoConnectException', (Exception,), {})
        return load('openwork_office', {'uno': uno, 'com.sun.star.beans': beans, 'com.sun.star.connection': connection})

    def test_direct_file_is_saved_and_closed_without_closing_existing_windows(self):
        for already_open in [False, True]:
            with self.subTest(already_open=already_open):
                office = self.office()
                document = types.SimpleNamespace(URL='file:///workspace/out/budget.ods', supportsService=lambda service: True,
                                                 isModified=lambda: True)
                from unittest.mock import Mock
                document.store = Mock()
                document.close = Mock()
                desktop = types.SimpleNamespace(loadComponentFromURL=lambda *args: document, getCurrentComponent=lambda: document)
                data = json.dumps({'path': '/workspace/out/budget.ods', 'operation': 'write_range'})
                with patch.object(office, 'connect', return_value=desktop), patch.object(office, 'find_open', return_value=document if already_open else None), patch.object(office, 'operate', return_value={'changedCount': 1}), patch.object(office.sys, 'stdin', io.StringIO(data)):
                    result = office.main()
                self.assertEqual(document.store.call_count, 0 if already_open else 1)
                self.assertEqual(document.close.call_count, 0 if already_open else 1)
                self.assertEqual(result['target'], 'open window' if already_open else 'file')

    def test_pdf_export_confines_real_destination_and_preserves_uploads(self):
        office = self.office()
        from unittest.mock import Mock
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            out = root / 'out'
            files = root / 'files'
            out.mkdir(); files.mkdir()
            upload = files / 'original.pdf'
            upload.write_bytes(b'original upload')
            (out / 'file-link.pdf').symlink_to(upload)
            (out / 'directory-link').symlink_to(files, target_is_directory=True)
            os.link(upload, out / 'hard-link.pdf')
            document = types.SimpleNamespace(storeToURL=Mock(), supportsService=lambda service: True)
            with patch.object(office, 'OUTPUT_DIRECTORY', str(out)):
                for destination in [str(upload), str(out / '../files/original.pdf'),
                                    str(out / 'file-link.pdf'), str(out / 'directory-link/original.pdf'),
                                    str(out / 'hard-link.pdf'), str(root / 'out-other/result.pdf'),
                                    'relative.pdf', str(out / 'result.txt')]:
                    with self.subTest(destination=destination), self.assertRaises(office.Failure):
                        office.operate(document, {'operation': 'export_pdf', 'output': destination})
                document.storeToURL.assert_not_called()
                self.assertEqual(upload.read_bytes(), b'original upload')
                destination = out / 'result.pdf'
                document.storeToURL.side_effect = lambda *args: destination.write_bytes(b'%PDF-proof')
                result = office.operate(document, {'operation': 'export_pdf', 'output': str(destination)})
                self.assertEqual(result['exported'], str(destination))
                self.assertEqual(result['bytes'], 10)
                self.assertEqual(document.storeToURL.call_args.args[0], 'file://' + str(destination))

    def test_pdf_export_rejects_replaced_output_root(self):
        office = self.office()
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary).resolve()
            files = root / 'files'
            files.mkdir()
            out = root / 'out'
            out.symlink_to(files, target_is_directory=True)
            with patch.object(office, 'OUTPUT_DIRECTORY', str(out)), self.assertRaises(office.Failure):
                office.pdf_output(str(out / 'result.pdf'))

    def test_external_image_formulas_refuse_the_whole_write_before_mutating_cells(self):
        from unittest.mock import Mock
        office = self.office()
        address = types.SimpleNamespace(StartColumn=0, EndColumn=1, StartRow=0, EndRow=0)
        formulas = ['=IMAGE(A1&ENCODEURL(B1))', '=image (A1)',
                    '=_xlfn.IMAGE(A1)', '=COM.MICROSOFT.IMAGE(A1)',
                    '=IF(B1;IMAGE(A1);"no image")']
        for formula in formulas:
            with self.subTest(formula=formula):
                cells = Mock()
                with patch.object(office, 'sheet_range', return_value=(Mock(), cells, address)):
                    with self.assertRaises(office.Failure):
                        office.operate(Mock(), {'operation': 'write_range', 'range': 'A1:B1',
                                               'values': [['Keep the existing value', {'formula': formula}]]})
                cells.getDataArray.assert_not_called()
                cells.getCellByPosition.assert_not_called()

    def test_workbook_math_still_runs_and_formula_shaped_text_stays_literal(self):
        from unittest.mock import Mock
        office = self.office()
        address = types.SimpleNamespace(StartColumn=0, EndColumn=0, StartRow=0, EndRow=0)
        for value, setter, text in [({'formula': '=SUM(B2:B4)'}, 'setFormula', '=SUM(B2:B4)'),
                                    ('=IMAGE(A1&ENCODEURL(B1))', 'setString', '=IMAGE(A1&ENCODEURL(B1))')]:
            with self.subTest(value=value):
                cell = Mock()
                cells = Mock(getDataArray=Mock(return_value=[['']]), getCellByPosition=Mock(return_value=cell))
                sheet = Mock(getName=Mock(return_value='Sheet1'))
                with patch.object(office, 'sheet_range', return_value=(sheet, cells, address)):
                    office.operate(Mock(), {'operation': 'write_range', 'range': 'A1', 'values': [[value]]})
                getattr(cell, setter).assert_called_once_with(text)
                getattr(cell, 'setString' if setter == 'setFormula' else 'setFormula').assert_not_called()


if __name__ == '__main__':
    unittest.main()
