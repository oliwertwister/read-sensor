"use strict";

const assert = require("node:assert/strict");
const { decode } = require("../synop.js");

const decoded = decode(
  "AAXX 18161 10384 45984 83005 10190 20092 30081 40138 53009 333 60007 88/58==",
);

assert.equal(decoded.station, "10384");
assert.equal(decoded.temp, 19);
assert.equal(decoded.dew, 9.2);
assert.equal(decoded.windDir, 300);
assert.equal(decoded.windSpeed, 5);
assert.equal(decoded.stationPressure, 1008.1);
assert.equal(decoded.mslPressure, 1013.8);
assert.equal(decoded.tendency, 0.9);
assert.equal(decoded.visibility, "50 km");
assert.equal(decoded.cloudCover, "8/8 oktas");
assert.equal(decoded.precipitation, "0 mm / 3 h");
assert.equal(decoded.cloudTypes, null, "Section 3 cloud groups must not be decoded as Section 1 cloud types");

console.log("SYNOP decoder test passed");
