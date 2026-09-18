import unittest

from update_synop import parse_station_list


STATIONS = """#ID;wigosIdentifier;Kennung;Stationsname;Geraetetyp;Messnetz;von_Datum;Geog_Breite;Geog_Laenge;Stationshoehe
433;0-20000-0-10384;10384;Berlin-Tempelhof;MODES H;15;01.04.1918;52.467551;13.401981;47.74
427;0-20000-0-10385;10385;Berlin Brandenburg;AMDA II;15;01.05.1938;52.380535;13.530429;45.64
"""


class SynopStationListTest(unittest.TestCase):
    def test_station_catalog(self):
        stations = parse_station_list(STATIONS)
        self.assertEqual({station["wmo"] for station in stations}, {"10384", "10385"})
        tempelhof = next(station for station in stations if station["wmo"] == "10384")
        self.assertEqual(tempelhof["name"], "Berlin-Tempelhof")
        self.assertAlmostEqual(tempelhof["lat"], 52.467551)
        self.assertAlmostEqual(tempelhof["lon"], 13.401981)
        self.assertAlmostEqual(tempelhof["elev_m"], 47.74)


if __name__ == "__main__":
    unittest.main()
