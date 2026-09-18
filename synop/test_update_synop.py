import unittest

from update_synop import parse_records


SAMPLE = """WMO_ID,ANO,MES,DIA,HORA,MINUTO,PARTE
10384,2026,09,18,15,00,AAXX 18151 10384 25784 12604 10198 20087 30075 40132 52004 333 60007 81/50==
10384,2026,09,18,15,00,OOXX 10384 21123 00471 26/// /2604 10191==
99999,2026,09,18,15,00,AAXX 18151 99999 46/// /0000==
"""


class ParseRecordsTest(unittest.TestCase):
    def test_keeps_selected_aaxx_reports_only(self):
        records = parse_records(SAMPLE)
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["wmo"], "10384")
        self.assertEqual(records[0]["observation_time"], "2026-09-18T15:00:00Z")
        self.assertTrue(records[0]["raw"].startswith("AAXX 18151"))


if __name__ == "__main__":
    unittest.main()
