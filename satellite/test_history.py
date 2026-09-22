#!/usr/bin/env python3
import json
import tempfile
import unittest
from pathlib import Path

from manage_history import archive, load_index


class SatelliteHistoryTest(unittest.TestCase):
    def write_snapshot(self, output: Path, observed_at: str, marker: str) -> None:
        (output / "geocolour.webp").write_bytes(f"geo-{marker}".encode())
        (output / "geocolour-raw.webp").write_bytes(f"raw-{marker}".encode())
        (output / "ir105-bt.f32.gz").write_bytes(f"grid-{marker}".encode())
        metadata = {
            "generated_at": observed_at,
            "backend": "satpy-native-fci-l1c",
            "products": {
                "ir105": {"observed_at": observed_at},
                "geocolour": {"observed_at": observed_at},
            },
        }
        (output / "latest.json").write_text(json.dumps(metadata), encoding="utf-8")

    def test_archive_deduplicates_and_prunes_to_limit(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary)
            times = [f"2026-09-22T0{hour}:00:00Z" for hour in range(5)]
            for index, observed in enumerate(times):
                self.write_snapshot(output, observed, str(index))
                archive(output, 4)

            index = load_index(output)
            self.assertEqual(len(index["snapshots"]), 4)
            self.assertEqual(index["snapshots"][0]["observed_at"], times[-1])
            self.assertFalse((output / "history/20260922T000000Z").exists())
            self.assertTrue((output / "history/20260922T040000Z/latest.json").exists())

            self.write_snapshot(output, times[-1], "replacement")
            archive(output, 4)
            index = load_index(output)
            self.assertEqual(len(index["snapshots"]), 4)
            payload = (output / "history/20260922T040000Z/geocolour.webp").read_bytes()
            self.assertEqual(payload, b"geo-replacement")


if __name__ == "__main__":
    unittest.main()
