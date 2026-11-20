import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as hapNs from '@homebridge/hap-nodejs';
import { LockAccessory, windowsVentSwitch } from '../src/accessories.js';
import type { OpenLinkoPlatform } from '../src/platform.js';
import { OP, type ControlResult, type Summary } from '../src/state.js';

// The real HAP library (Homebridge's own dependency), so services and characteristics behave as in Home.
const hap = (hapNs as unknown as { default?: typeof hapNs }).default ?? hapNs;
const C = hap.Characteristic;
type Svc = InstanceType<typeof hap.Service>;

/** Just enough of a PlatformAccessory for the tiles: services by type/subtype, and a context. */
class FakeAccessory {
  readonly context: Record<string, unknown>;
  readonly services: Svc[] = [];
  readonly displayName = 'Test';
  constructor(kind: string) {
    this.context = { kind };
  }
  getService(t: { UUID: string }): Svc | undefined {
    return this.services.find((s) => s.UUID === t.UUID && !s.subtype);
  }
  getServiceById(t: { UUID: string }, sub: string): Svc | undefined {
    return this.services.find((s) => s.UUID === t.UUID && s.subtype === sub);
  }
  addService(s: Svc | (new (...a: unknown[]) => Svc), ...args: unknown[]): Svc {
    const svc = typeof s === 'function' ? new s(...args) : s;     // like Homebridge: an instance or a class
    this.services.push(svc);
    return svc;
  }
}

/** A platform stand-in. Its client shares a command that's already on its way, like the real one. */
function fakePlatform(opts: { logStates?: boolean } = {}) {
  const lines: string[] = [];
  const sent: string[] = [];
  const slots = new Map<string, { op: string; p: Promise<ControlResult> }>();
  const pending: Array<() => void> = [];
  const client = {
    isQueued: (op: string, slot?: string) => !!slot && slots.get(slot)?.op === op,
    control(op: string, slot = '') {
      const s = slots.get(slot);
      if (s && s.op === op) {
        return s.p;
      }
      sent.push(op);
      const p = new Promise<ControlResult>((resolve) => {
        pending.push(() => {
          slots.delete(slot);
          resolve({ ok: true, confirmed: true });
        });
      });
      slots.set(slot, { op, p });
      return p;
    },
  };
  const log = {
    info: (m: string) => lines.push(m),
    warn: (m: string) => lines.push(`WARN ${m}`),
    error: (m: string) => lines.push(`ERROR ${m}`),
    debug: () => undefined,
  };
  const platform = {
    api: { hap }, log, client, model: 'Test', serial: 'SN', version: '0.0.0', carName: 'Tiggo',
    defaultTemp: 22, lowBattery: 20, logStates: !!opts.logStates, summary: {} as Summary,
    liveSummary(): Summary {
      return this.summary;
    },
    refreshSoon: () => undefined,
  };
  return { platform: platform as unknown as OpenLinkoPlatform, lines, sent, finishAll: () => pending.splice(0).forEach((f) => f()) };
}

/** Record the names of the characteristics a service is told about, in order. */
function recordPushes(svc: Svc): string[] {
  const order: string[] = [];
  const orig = svc.updateCharacteristic.bind(svc);
  svc.updateCharacteristic = ((c: { name?: string } | string, v: unknown) => {
    order.push(typeof c === 'string' ? c : String(c.name));
    return orig(c as never, v as never);
  }) as typeof svc.updateCharacteristic;
  return order;
}

const tick = () => new Promise((r) => setImmediate(r));

test('lock: Home is told the target state before the current one, both ways', () => {
  const { platform } = fakePlatform();
  const acc = new FakeAccessory('lock');
  const lock = new LockAccessory(platform, acc as never, 'Tiggo');
  const svc = acc.services.find((s) => s.UUID === hap.Service.LockMechanism.UUID)!;
  const order = recordPushes(svc);
  lock.update({ unlocked: true });     // parked: the car unlocks itself
  lock.update({ unlocked: false });    // driving off: the car locks itself
  assert.deepEqual(order, ['LockTargetState', 'LockCurrentState', 'LockTargetState', 'LockCurrentState']);
  assert.equal(svc.getCharacteristic(C.LockTargetState).value, C.LockTargetState.SECURED);
  assert.equal(svc.getCharacteristic(C.LockCurrentState).value, C.LockCurrentState.SECURED);
});

test('logStates: one line per change of what Home shows, none when it is off', () => {
  const on = fakePlatform({ logStates: true });
  const acc = new FakeAccessory('lock');
  const lock = new LockAccessory(on.platform, acc as never, 'Tiggo');
  lock.update({ unlocked: false });
  lock.update({ unlocked: false });    // same state again: no new line
  lock.update({ unlocked: true });
  assert.deepEqual(on.lines, [
    'Tiggo: Home shows lock target Locked (start)',
    'Tiggo: Home shows lock Locked (start)',
    'Tiggo: Home shows lock target Unlocked',
    'Tiggo: Home shows lock Unlocked',
  ]);

  const off = fakePlatform();
  const lock2 = new LockAccessory(off.platform, new FakeAccessory('lock') as never, 'Tiggo');
  lock2.update({ unlocked: false });
  lock2.update({ unlocked: true });
  assert.deepEqual(off.lines, []);
});

test('a request Home sends twice goes to the car once, and the log says so', async () => {
  const { platform, lines, sent, finishAll } = fakePlatform();
  const acc = new FakeAccessory('windowsVent');
  windowsVentSwitch(platform, acc as never, 'Tiggo Windows Vent');
  const sw = acc.services.find((s) => s.UUID === hap.Service.Switch.UUID)!;
  await sw.getCharacteristic(C.On).setValue(true);
  await tick();
  await sw.getCharacteristic(C.On).setValue(true);     // Home asks again before the car answered
  await tick();
  assert.deepEqual(sent, [OP.windowsVent]);             // exactly one command went out
  finishAll();
  await tick();
  await tick();
  assert.deepEqual(lines, [
    'Tiggo Windows Vent: vent the windows',
    'Tiggo Windows Vent: vent the windows (already on its way, not sent again)',
    'Tiggo Windows Vent: vent the windows — done',
  ]);
});
