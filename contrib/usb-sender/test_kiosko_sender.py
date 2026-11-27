"""Tests of the sender that need neither trcc nor a panel: python3 -m unittest discover contrib/usb-sender"""
import importlib.util
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("kiosko_sender", Path(__file__).with_name("kiosko-sender.py"))
sender = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sender)


class FakeLyLcd:
    """Stands for trcc's LyLcd: counts how often a payload is cut into chunks."""

    def __init__(self):
        self.prepared = 0

    def _prepare_frame(self, payload: bytes) -> bytes:
        self.prepared += 1
        return b"chunks:" + payload


class PreparedFrameTest(unittest.TestCase):
    def test_the_same_frame_sent_again_is_not_cut_into_chunks_again(self):
        lcd = sender.make_checked_lcd(FakeLyLcd)()
        frame = b"jpeg-1"
        for _ in range(5):  # what the keepalive does: the same bytes, every second
            self.assertEqual(lcd._prepare_frame(frame), b"chunks:jpeg-1")
        self.assertEqual(lcd.prepared, 1)
        self.assertEqual(lcd._prepare_frame(b"jpeg-2"), b"chunks:jpeg-2")
        self.assertEqual(lcd.prepared, 2)


class FrameWatchTest(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.watch = sender.FrameWatch()
        if self.watch._fd < 0:
            self.skipTest("no inotify here")

    def replace_frame(self, data: bytes) -> None:
        tmp = self.dir / ".frame.tmp"
        tmp.write_bytes(data)
        os.rename(tmp, self.dir / "frame.jpg")  # what Kiosko's file connection does

    def test_it_sleeps_the_whole_time_when_nothing_changes(self):
        self.watch.watch(self.dir)
        t0 = time.monotonic()
        self.watch.wait(0.3)
        self.assertGreaterEqual(time.monotonic() - t0, 0.28)

    def test_a_new_frame_wakes_it_at_once(self):
        self.watch.watch(self.dir)
        threading.Timer(0.05, self.replace_frame, [b"x"]).start()
        t0 = time.monotonic()
        self.watch.wait(5)
        self.assertLess(time.monotonic() - t0, 1)

    def test_a_folder_that_does_not_exist_yet_is_polled_then_watched(self):
        later = self.dir / "later"
        self.watch.watch(later)
        t0 = time.monotonic()
        self.watch.wait(5)  # no watch yet: it only waits POLL_S
        self.assertLess(time.monotonic() - t0, 0.5)
        later.mkdir()
        self.watch._retry_at = 0.0  # don't wait the second it waits between tries
        self.watch.watch(later)
        self.assertGreaterEqual(self.watch._wd, 0)


if __name__ == "__main__":
    unittest.main()
