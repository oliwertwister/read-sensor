import unittest

from update_synop import parse_oscar_stations, wmo_index


PAYLOAD = {
    "stationSearchResults": [
        {
            "name": "BERLIN-TEMPELHOF",
            "territory": "Germany",
            "region": "Europe",
            "declaredStatus": "Operational",
            "latitude": 52.467551,
            "longitude": 13.401981,
            "elevation": 47.74,
            "wigosStationIdentifiers": [{"wigosStationIdentifier": "0-20000-0-10384", "primary": True}],
        },
        {
            "name": "CLOSED",
            "territory": "Germany",
            "region": "Europe",
            "declaredStatus": "Closed",
            "latitude": 52.0,
            "longitude": 13.0,
            "wigosStationIdentifiers": [{"wigosStationIdentifier": "0-20000-0-99999", "primary": True}],
        },
        {
            "name": "NON-WMO",
            "territory": "Germany",
            "region": "Europe",
            "declaredStatus": "Operational",
            "latitude": 52.0,
            "longitude": 13.0,
            "wigosStationIdentifiers": [{"wigosStationIdentifier": "0-203-1-VP1885", "primary": True}],
        },
    ]
}


class OscarCatalogTest(unittest.TestCase):
    def test_extracts_traditional_wmo_index(self):
        self.assertEqual(wmo_index(PAYLOAD["stationSearchResults"][0]), "10384")
        self.assertIsNone(wmo_index(PAYLOAD["stationSearchResults"][2]))

    def test_keeps_operational_wmo_stations_only(self):
        stations = parse_oscar_stations(PAYLOAD)
        self.assertEqual(len(stations), 1)
        self.assertEqual(stations[0]["wmo"], "10384")
        self.assertEqual(stations[0]["territory"], "Germany")
        self.assertAlmostEqual(stations[0]["lat"], 52.467551)


if __name__ == "__main__":
    unittest.main()
