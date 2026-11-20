import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OP, Pending, anyDoorOpen, anyWindowOpen, atHome, decodeSetPoint, haversineM, isAllowedOp, snapTemp,
  sunroofState, tempOp, windowOpen, windowsVented,
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

test('windows: all-together state, vent, and each window (Tiggo 7 CSH frames)', () => {
  const closed = ['closed', 'closed', 'closed', 'closed'];
  const allOpen = ['open', 'open', 'open', 'open'];            // byte 8 = 0x55, seen 12:25:50
  const vented = ['partial', 'partial', 'partial', 'partial'];
  assert.equal(anyWindowOpen(closed), false);
  assert.equal(anyWindowOpen(allOpen), true);
  assert.equal(anyWindowOpen(vented), true);
  assert.equal(anyWindowOpen(null), null);
  assert.equal(anyWindowOpen(['closed']), null);              // not a 4-window reading
  assert.equal(windowsVented(vented), true);
  assert.equal(windowsVented(allOpen), false);
  assert.equal(windowsVented(['partial', 'open', 'closed', 'closed']), false);
  assert.equal(windowsVented(closed), false);
  assert.equal(windowOpen(['closed', 'open', 'closed', 'partial'], 1), true);
  assert.equal(windowOpen(['closed', 'open', 'closed', 'partial'], 3), true);
  assert.equal(windowOpen(['closed', 'open', 'closed', 'partial'], 0), false);
  assert.equal(windowOpen(null, 0), null);
});

test('sunroof: E5 labels and the Tiggo 7 raw 0x07', () => {
  assert.equal(sunroofState('closed'), 'closed');
  assert.equal(sunroofState(0), 'closed');
  assert.equal(sunroofState('open'), 'open');
  assert.equal(sunroofState(7), 'open');                    // Tiggo 7 CSH, seen 12:24:39
  assert.equal(sunroofState('tilt'), 'tilt');
  assert.equal(sunroofState(0x0b), 'tilt');
  assert.equal(sunroofState(null), null);
  assert.equal(sunroofState(undefined), null);
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

test('refusal bytes get the meaning from the CarLinko app', async () => {
  const { controlError, refusalText } = await import('../src/state.js');
  assert.equal(refusalText('21'), 'a door is open');
  assert.equal(refusalText('9f'), 'the car is unlocked; lock it first');
  assert.equal(refusalText('ZZ'), null);
  // OpenLinko's generic text is replaced...
  assert.equal(controlError({ ok: false, result: '21', reason: 'Car refused (code 0x21)' }), 'Car refused: a door is open (0x21)');
  // ...and so is its short A/C text, which gains what to do...
  assert.equal(controlError({ ok: false, result: '22', reason: 'A door is unlocked' }), 'Car refused: a door is unlocked; lock the car first (0x22)');
  // ...while permission errors keep OpenLinko's wording
  assert.equal(controlError({ ok: false, result: '44', reason: "No operation permission: this CarLinko account isn't authorised on the car's T-Box" }),
    "No operation permission: this CarLinko account isn't authorised on the car's T-Box");
  // ...and frame rejections (bare 74RR) stay OpenLinko's
  assert.equal(controlError({ ok: false, result: '04', reason: 'Car control system error (0x04)' }), 'Car control system error (0x04)');
  assert.equal(controlError({ ok: false, error: 'boom' }), 'boom');
});
