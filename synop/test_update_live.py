import unittest
from datetime import datetime, timezone

from update_live import decode_temperature, parse_germany, parse_international


CATALOG = {
    "10384": {"wmo": "10384", "name": "BERLIN-TEMPELHOF", "territory": "Germany", "lat": 52.467551, "lon": 13.401981},
    "04038": {"wmo": "04038", "name": "Eyrarbakki", "territory": "Iceland", "lat": 63.8692, "lon": -21.16018},
}


class LiveSynopTest(unittest.TestCase):
    def test_decodes_section_one_temperature(self):
        self.assertEqual(decode_temperature(["36///", "/0404", "10078", "20063"]), 7.8)
        self.assertEqual(decode_temperature(["36///", "/0404", "11025", "20063"]), -2.5)
        self.assertIsNone(decode_temperature(["36///", "/0404", "333", "10078"]))

    def test_parses_international_aaxx(self):
        text = "AAXX 18214\n04038 36/// /0404 10078 20063 49808 52003 333 10079 20078=\n"
        reports = parse_international(text, datetime(2026, 9, 18, 21, 8, tzinfo=timezone.utc), CATALOG)
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]["wmo"], "04038")
        self.assertEqual(reports[0]["temperature_c"], 7.8)
        self.assertTrue(reports[0]["raw"].startswith("AAXX 18214 04038"))

    def test_parses_german_bufr_subset(self):
        payload = {"messages": [[
            {"key": "subsetNumber", "value": 1},
            {"key": "blockNumber", "value": 10},
            {"key": "stationNumber", "value": 384},
            {"key": "year", "value": 2026},
            {"key": "month", "value": 9},
            {"key": "day", "value": 18},
            {"key": "hour", "value": 21},
            {"key": "minute", "value": 0},
            {"key": "airTemperature", "value": 287.65},
        ]]}
        reports = parse_germany(payload, CATALOG)
        self.assertEqual(len(reports), 1)
        self.assertEqual(reports[0]["wmo"], "10384")
        self.assertEqual(reports[0]["temperature_c"], 14.5)
        self.assertIsNone(reports[0]["raw"])


if __name__ == "__main__":
    unittest.main()
