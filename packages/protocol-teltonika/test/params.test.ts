import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  paramId, profileParamIds, buildSetParam, buildGetParam, parseGetParamResponse,
  setParamAccepted, validateProfile, ParamValueError,
} from '../src/params.ts';

// Every ID here is copied from the wiki "Data acquisition mode parameters"
// table. If the device would receive a wrong ID, this is where it must fail.
test('parameter IDs match the Teltonika wiki table exactly', () => {
  // Home / On Stop
  assert.equal(paramId('home', 'stop', 'minPeriodSec'), 10000);
  assert.equal(paramId('home', 'stop', 'minSavedRecords'), 10004);
  assert.equal(paramId('home', 'stop', 'sendPeriodSec'), 10005);
  // Home / Moving
  assert.equal(paramId('home', 'moving', 'minPeriodSec'), 10050);
  assert.equal(paramId('home', 'moving', 'minDistanceM'), 10051);
  assert.equal(paramId('home', 'moving', 'minAngleDeg'), 10052);
  assert.equal(paramId('home', 'moving', 'minSpeedDeltaKph'), 10053);
  assert.equal(paramId('home', 'moving', 'minSavedRecords'), 10054);
  assert.equal(paramId('home', 'moving', 'sendPeriodSec'), 10055);
  // Roaming
  assert.equal(paramId('roaming', 'stop', 'minPeriodSec'), 10100);
  assert.equal(paramId('roaming', 'stop', 'sendPeriodSec'), 10105);
  assert.equal(paramId('roaming', 'moving', 'minPeriodSec'), 10150);
  assert.equal(paramId('roaming', 'moving', 'sendPeriodSec'), 10155);
  // Unknown network
  assert.equal(paramId('unknown', 'stop', 'minPeriodSec'), 10200);
  assert.equal(paramId('unknown', 'moving', 'minPeriodSec'), 10250);
  assert.equal(paramId('unknown', 'moving', 'sendPeriodSec'), 10255);
});

test('On-Stop profile has no distance/angle/speed-delta parameters', () => {
  assert.throws(() => paramId('home', 'stop', 'minDistanceM'), RangeError);
  assert.deepEqual(profileParamIds('home', 'stop').map((p) => p.id), [10000, 10004, 10005]);
  assert.deepEqual(profileParamIds('home', 'moving').map((p) => p.id), [10050, 10051, 10052, 10053, 10054, 10055]);
});

test('setparam command uses the wiki GPRS syntax: no password, no leading space, id:value;id:value', () => {
  assert.equal(buildSetParam('home', 'moving', { minPeriodSec: 5, minDistanceM: 50 }), 'setparam 10050:5;10051:50');
  assert.equal(buildSetParam('home', 'stop', { minPeriodSec: 600 }), 'setparam 10000:600');
  assert.equal(buildGetParam('home', 'moving'), 'getparam 10050;10051;10052;10053;10054;10055');
});

test('values outside the documented range are refused before reaching a device', () => {
  assert.throws(() => buildSetParam('home', 'moving', { minAngleDeg: 181 }), ParamValueError);      // Uint8 0..180
  assert.throws(() => buildSetParam('home', 'moving', { minSpeedDeltaKph: 101 }), ParamValueError); // 0..100
  assert.throws(() => buildSetParam('home', 'moving', { minSavedRecords: 0 }), ParamValueError);    // 1..255
  assert.throws(() => buildSetParam('home', 'moving', { minSavedRecords: 256 }), ParamValueError);
  assert.throws(() => buildSetParam('home', 'moving', { minPeriodSec: 2_592_001 }), ParamValueError);
  assert.throws(() => buildSetParam('home', 'moving', { minPeriodSec: 1.5 }), ParamValueError);      // integers only
  assert.throws(() => buildSetParam('home', 'stop', { minDistanceM: 10 }), ParamValueError);         // not on stop profile
  assert.throws(() => buildSetParam('home', 'moving', {}), ParamValueError);                          // nothing to set
  assert.doesNotThrow(() => validateProfile('moving', { minPeriodSec: 0, minAngleDeg: 180, minSavedRecords: 255 })); // boundaries ok
});

test('getparam response parsing tolerates both reply shapes and ignores noise', () => {
  const a = parseGetParamResponse('home', 'moving', 'Param ID:10050 Val:5;Param ID:10051 Val:100;Param ID:10052 Val:10');
  assert.deepEqual(a, { minPeriodSec: 5, minDistanceM: 100, minAngleDeg: 10 });
  const b = parseGetParamResponse('home', 'moving', '10050:3;10055:120;99999:7');
  assert.deepEqual(b, { minPeriodSec: 3, sendPeriodSec: 120 }); // 99999 unknown → dropped
  assert.deepEqual(parseGetParamResponse('home', 'moving', 'garbage'), {});
});

test('setparam acknowledgement: strict on the negative', () => {
  assert.equal(setParamAccepted('New value 10050:5 was successfully applied'), true);
  assert.equal(setParamAccepted('Param ID:10050 New Val:5'), true);
  assert.equal(setParamAccepted('Error: invalid parameter'), false);
  assert.equal(setParamAccepted('Unknown command'), false);
});
