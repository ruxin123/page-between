import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import patch
import local_backup as backup
from storage import save


class LocalBackup(unittest.TestCase):
    def test_rotation_keeps_three_automatic_backups_and_preserves_user_files(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            cache = root / 'cache'
            (cache / 'exports').mkdir(parents=True)
            directory = root / 'Backups'
            directory.mkdir()
            previous = []
            for index in range(4):
                path = directory / ('页间-20260101-000000-' + str(index) * 32 + '.pbbackup')
                path.write_bytes(b'previous snapshot')
                os.utime(path, (index + 1, index + 1))
                previous.append(path)
            manual = directory / 'my-manual.pbbackup'
            manual.write_bytes(b'keep this file')
            linked = directory / ('页间-20260101-000000-' + 'e' * 32 + '.pbbackup')
            linked.symlink_to(manual)
            name = 'f' * 32 + '.pbbackup'
            (cache / 'exports' / name).write_bytes(b'new snapshot')
            with patch.object(backup, 'DATA', root / 'Library'), patch.object(backup, 'CACHE', cache), patch.object(backup.library_data, 'backup', return_value={'id': name}):
                backup.configure('daily')
                self.assertTrue(backup.automatic(lambda: {}))
            self.assertFalse(previous[0].exists())
            self.assertFalse(previous[1].exists())
            self.assertTrue(previous[2].exists())
            self.assertTrue(previous[3].exists())
            self.assertEqual(manual.read_bytes(), b'keep this file')
            self.assertTrue(linked.is_symlink())
            self.assertEqual(len([path for path in directory.glob('页间-*.pbbackup') if not path.is_symlink()]), 3)

    def test_disabled_schedule_then_success_rotation_and_failure_preserve_last_good_backup(self):
        with tempfile.TemporaryDirectory() as folder:
            root=Path(folder); library=root/'Library'; cache=root/'cache'; (cache/'exports').mkdir(parents=True)
            with patch.object(backup,'DATA',library),patch.object(backup,'CACHE',cache),patch.object(backup.time,'time',return_value=200000):
                snapshot=lambda: {'library.json':{'books':[]}}
                self.assertFalse(backup.automatic(snapshot))
                backup.configure('daily')
                def create(value):
                    self.assertNotIn('services',value)
                    (cache/'exports'/'a.pbbackup').write_bytes(b'original snapshot')
                    return {'id':'a.pbbackup'}
                with patch.object(backup.library_data,'backup',side_effect=create) as writer:
                    self.assertTrue(backup.automatic(snapshot))
                    self.assertFalse(backup.automatic(snapshot))
                    self.assertEqual(writer.call_count,1)
                before=backup.configuration()['lastSuccess']
                with patch.object(backup.time,'time',return_value=400000),patch.object(backup.library_data,'backup',side_effect=OSError('disk full')):
                    self.assertFalse(backup.automatic(snapshot))
                self.assertEqual(backup.configuration()['lastSuccess'],before)
                self.assertEqual(len(list((root/'Backups').glob('*.pbbackup'))),1)
                self.assertIn('error',backup.configuration())
                with self.assertRaises(ValueError): backup.configure('hourly')
