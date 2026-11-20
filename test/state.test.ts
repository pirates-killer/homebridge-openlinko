import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OP, Pending, anyDoorOpen, atHome, decodeSetPoint, haversineM, isAllowedOp, roofCmdFor, snapTemp,
  sunroofPosition, tempOp, windowCmdFor, windowsPosition,
} from '../src/state.js';

test('temperature command matches OpenLinko/app encoding (0x80 + 2 x degC)', () => {
  assert.equal(tempOp(22), '7411AC');
  assert.equal(tempOp(15.5), '74119F');
  assert.equal(tempOp(30.5), '7411BD');
  assert.throws(() => tempOp(70));
});

test('byte-24 set-point decode', () => {
  assert.equal(decodeSetPoint(49), 24.5);        // Tiggo 7 CSH live value
  assert.equal(decodeSetPoint(0xac), 22);        // with the 0x80 flag
  assert.equal(decodeSetPoint(22), null);        // E5 raw degC -> 11, not a set-point
  assert.equal(decodeSetPoint(0), null);
  assert.equal(decodeSetPoint(null), null);
});

test('snapTemp honours the car range and step', () => {
  const ac = { min: 15.5, max: 30.5, step: 0.5 };
  assert.equal(snapTemp(22.2, ac), 22);
  assert.equal(snapTemp(22.3, ac), 22.5);
  assert.equal(snapTemp(10, ac), 15.5);
  assert.equal(snapTemp(40, ac), 30.5);
  assert.equal(snapTemp(22, undefined), 22);
});

test('allow-list: no engine start, no arbitrary opcodes', () => {
  for (const op of Object.values(OP)) {
    assert.ok(isAllowedOp(op), op);
  }
  assert.ok(isAllowedOp('7411AC'));
  assert.ok(isAllowedOp('7411ac'));
  assert.equal(isAllowedOp('740700'), false);    // engine on
  assert.equal(isAllowedOp('740800'), false);    // engine off
  assert.equal(isAllowedOp('742401'), false);
  assert.equal(isAllowedOp('77'), false);
  assert.equal(isAllowedOp('7411'), false);
});

test('window position <-> command', () => {
  assert.equal(windowCmdFor(0, true), 'close');
  assert.equal(windowCmdFor(30, true), 'vent');
  assert.equal(windowCmdFor(30, false), 'open');
  assert.equal(windowCmdFor(100, true), 'open');
  assert.equal(windowsPosition(['closed', 'closed', 'closed', 'closed']), 0);
  assert.equal(windowsPosition(['closed', 'partial', 'closed', 'closed']), 20);
  assert.equal(windowsPosition(['open', 'partial', 'closed', 'closed']), 100);
  assert.equal(windowsPosition(null), null);
  assert.equal(roofCmdFor(40, true), 'tilt');
  assert.equal(roofCmdFor(40, false), 'open');
  assert.equal(sunroofPosition('tilt'), 20);
  assert.equal(sunroofPosition(11), null);
});

test('doors bitmask', () => {
  assert.equal(anyDoorOpen(0), false);
  assert.equal(anyDoorOpen(4), true);
  assert.equal(anyDoorOpen(0x30), false);         // only the low nibble is doors
  assert.equal(anyDoorOpen(null), null);
});

test('geofence with hysteresis', () => {
  const home = { lat: 5.3, lng: 100.4, radius: 150 };
  assert.ok(Math.abs(haversineM(0, 0, 0, 1) - 111195) < 10);
  const at = (dm: number) => ({ enabled: true, lat: 5.3 + dm / 111195, lng: 100.4 });
  assert.equal(atHome(at(100), home, null), true);
  assert.equal(atHome(at(200), home, null), false);
  assert.equal(atHome(at(200), home, true), true);   // inside 1.5 x radius: still home
  assert.equal(atHome(at(260), home, true), false);
  assert.equal(atHome({ enabled: false, lat: 5.3, lng: 100.4 }, home, null), null);
  assert.equal(atHome({ enabled: true, lat: null, lng: null }, home, true), null);
});

test('Pending holds the commanded state until telemetry agrees or the hold ends', () => {
  let now = 0;
  const p = new Pending<number>(1000, () => now);
  assert.equal(p.target(0), 0);
  p.set(1);
  assert.equal(p.target(0), 1);    // stale telemetry: keep showing the target
  now = 500;
  assert.equal(p.target(1), 1);    // telemetry caught up: cleared
  assert.equal(p.active, false);
  p.set(0);
  now = 2000;
  assert.equal(p.target(1), 1);    // hold expired: telemetry wins
});
