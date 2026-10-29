import os, sys, tempfile, unittest
from pathlib import Path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scripts.clone_chrome_profile import clone, profiles


class CloneTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        t = Path(self.tmp.name)
        self.src, self.dest = t / "src", t / "dest"
        (self.src / "Profile 1" / "Network").mkdir(parents=True)
        (self.src / "Profile 1" / "Cache").mkdir()
        (self.src / "Local State").write_bytes(b"ls")
        (self.src / "Profile 1" / "Preferences").write_bytes(b"{}")
        (self.src / "Profile 1" / "Network" / "Cookies").write_bytes(b"opaque")
        (self.src / "Profile 1" / "Cache" / "junk").write_bytes(b"x")
    def tearDown(self): self.tmp.cleanup()

    def test_lists_profiles(self):
        self.assertEqual(profiles(self.src), ["Profile 1"])

    def test_clone_copies_session_not_cache(self):
        clone(self.src, "Profile 1", self.dest)
        self.assertTrue((self.dest / "Local State").exists())
        self.assertEqual((self.dest / "Profile 1" / "Network" / "Cookies").read_bytes(), b"opaque")
        self.assertFalse((self.dest / "Profile 1" / "Cache").exists())

    def test_existing_dest_needs_force_and_is_backed_up_not_deleted(self):
        clone(self.src, "Profile 1", self.dest)
        with self.assertRaises(SystemExit):
            clone(self.src, "Profile 1", self.dest)
        clone(self.src, "Profile 1", self.dest, force=True)
        self.assertEqual(len(list(self.dest.parent.glob("dest.bak-*"))), 1)

    def test_missing_profile_fails(self):
        with self.assertRaises(SystemExit):
            clone(self.src, "Profile 9", self.dest)


if __name__ == "__main__":
    unittest.main()
