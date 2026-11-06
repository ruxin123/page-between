import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import local_backup as backup
from storage import save


class LocalBackup(unittest.TestCase):
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
