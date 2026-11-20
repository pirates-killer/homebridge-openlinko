import type { CharacteristicValue, PlatformAccessory, Service, WithUUID } from 'homebridge';
import type { OpenLinkoPlatform } from './platform.js';
import {
  OP, Pending, WINDOW_NAMES, anyDoorOpen, anyWindowOpen, atHome, controlError, decodeSetPoint, snapTemp,
  sunroofState, tempOp, windowOpen, windowsVented,
  type Caps, type ControlResult, type Location, type Summary,
} from './state.js';

const HOLD_MS = 120_000;   // how long a commanded state wins over not-yet-updated telemetry

/** Base: owns one PlatformAccessory, gets every summary, sends commands through the platform. */
export abstract class CarAccessory {
  protected readonly hap;
  protected readonly C;
  protected readonly S;

  constructor(protected readonly platform: OpenLinkoPlatform, readonly accessory: PlatformAccessory, protected readonly label: string) {
    this.hap = platform.api.hap;
    this.C = this.hap.Characteristic;
    this.S = this.hap.Service;
    const info = accessory.getService(this.S.AccessoryInformation) ?? accessory.addService(this.S.AccessoryInformation);
    info
      .setCharacteristic(this.C.Manufacturer, 'OpenLinko')
      .setCharacteristic(this.C.Model, platform.model || 'CarLinko car')
      .setCharacteristic(this.C.SerialNumber, `${platform.serial}-${accessory.context.kind as string}`)
      .setCharacteristic(this.C.FirmwareRevision, platform.version);
  }

  /** Get-or-add a service. The name is only set on creation, so a rename in Home sticks. */
  protected service(type: WithUUID<typeof Service>, name: string, subtype?: string): Service {
    const found = subtype ? this.accessory.getServiceById(type, subtype) : this.accessory.getService(type);
    if (found) {
      return found;
    }
    // every concrete HAP service takes (displayName?, subtype?); the base-class typing doesn't say so
    const Ctor = type as unknown as new (displayName: string, subtype?: string) => Service;
    const s = this.accessory.addService(new Ctor(name, subtype));
    if (!s.testCharacteristic(this.C.ConfiguredName)) {
      s.addOptionalCharacteristic(this.C.ConfiguredName);
    }
    s.setCharacteristic(this.C.ConfiguredName, name);
    return s;
  }

  /** For onGet: the latest summary, or "No Response" while OpenLinko is unreachable. */
  protected get s(): Summary {
    return this.platform.liveSummary();
  }

  abstract update(s: Summary): void;

  /**
   * Fire a command without blocking HomeKit (the car can take 20 s; Home shows "No Response"
   * after ~10 s). onDone gets the verdict; failures are logged with OpenLinko's own reason.
   */
  protected send(op: string, what: string, onDone: (ok: boolean, confirmed: boolean) => void,
    slot = String(this.accessory.context.kind)): void {
    this.platform.log.info(`${this.label}: ${what}`);
    this.platform.client.control(op, slot).then(
      (r: ControlResult) => {
        if (r.ok) {
          this.platform.log.info(`${this.label}: ${what} — ${r.confirmed ? 'done' : 'sent (the car did not confirm yet)'}`);
        } else {
          this.platform.log.warn(`${this.label}: ${what} failed — ${controlError(r)}`);
        }
        onDone(!!r.ok, !!r.confirmed);
        this.platform.refreshSoon();
      },
      (e: unknown) => {
        this.platform.log.error(`${this.label}: ${what} failed — ${e instanceof Error ? e.message : String(e)}`);
        onDone(false, false);
      },
    );
  }
}

// ---------------------------------------------------------------------------------------------

/** Lock tile: lock/unlock, plus the drive battery (level, charging, low) on the same accessory. */
export class LockAccessory extends CarAccessory {
  private readonly lock: Service;
  private readonly battery: Service;
  private readonly target = new Pending<number>(HOLD_MS);
  private readonly current = new Pending<number>(HOLD_MS);

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string) {
    super(platform, accessory, label);
    const { C } = this;
    this.lock = this.service(this.S.LockMechanism, label);
    this.lock.getCharacteristic(C.LockCurrentState).onGet(() => this.currentState(this.s));
    this.lock.getCharacteristic(C.LockTargetState)
      .onGet(() => this.targetState(this.s))
      .onSet((v) => this.setTarget(v));
    this.battery = this.service(this.S.Battery, `${platform.carName} Battery`);
    this.battery.getCharacteristic(C.BatteryLevel).onGet(() => this.s.battery ?? 0);
    this.battery.getCharacteristic(C.ChargingState).onGet(() => this.charging(this.s));
    this.battery.getCharacteristic(C.StatusLowBattery).onGet(() => this.low(this.s));
  }

  private actual(s: Summary): number | null {
    const { C } = this;
    if (s.unlocked === true) {
      return C.LockCurrentState.UNSECURED;
    }
    if (s.unlocked === false) {
      return C.LockCurrentState.SECURED;
    }
    return null;
  }

  private currentState(s: Summary): number {
    return this.current.target(this.actual(s)) ?? this.C.LockCurrentState.UNKNOWN;
  }

  private targetState(s: Summary): number {
    const { C } = this;
    const cur = this.currentState(s);
    const fallback = cur === C.LockCurrentState.UNSECURED ? C.LockTargetState.UNSECURED : C.LockTargetState.SECURED;
    return this.target.target(cur === C.LockCurrentState.UNKNOWN ? null : cur) ?? fallback;
  }

  private charging(s: Summary): number {
    return s.charging?.active ? this.C.ChargingState.CHARGING : this.C.ChargingState.NOT_CHARGING;
  }

  private low(s: Summary): number {
    const { C } = this;
    return typeof s.battery === 'number' && s.battery < this.platform.lowBattery
      ? C.StatusLowBattery.BATTERY_LEVEL_LOW : C.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private setTarget(v: CharacteristicValue): void {
    const { C } = this;
    const lock = v === C.LockTargetState.SECURED;
    this.target.set(v as number);
    this.send(lock ? OP.lock : OP.unlock, lock ? 'lock' : 'unlock', (ok, confirmed) => {
      if (!ok) {
        this.target.clear();
        this.current.clear();
      } else if (confirmed) {
        // the car itself said done: show it now rather than waiting for its next status push
        this.current.set(lock ? C.LockCurrentState.SECURED : C.LockCurrentState.UNSECURED);
      }
      this.update(this.platform.summary);
    });
  }

  update(s: Summary): void {
    const { C } = this;
    this.lock.updateCharacteristic(C.LockCurrentState, this.currentState(s));
    this.lock.updateCharacteristic(C.LockTargetState, this.targetState(s));
    if (typeof s.battery === 'number') {
      this.battery.updateCharacteristic(C.BatteryLevel, Math.max(0, Math.min(100, s.battery)));
    }
    this.battery.updateCharacteristic(C.ChargingState, this.charging(s));
    this.battery.updateCharacteristic(C.StatusLowBattery, this.low(s));
  }
}

// ---------------------------------------------------------------------------------------------

/** A/C as a heater-cooler: on/off + set-point. The car reports no cabin temperature, so the
 *  "current temperature" shows the set-point. */
export class ClimateAccessory extends CarAccessory {
  private readonly svc: Service;
  private readonly active = new Pending<number>(HOLD_MS);
  private readonly wanted = new Pending<number>(HOLD_MS);
  private setPoint: number;
  private tempTimer?: NodeJS.Timeout;

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string, private readonly caps: Caps['ac']) {
    super(platform, accessory, label);
    const { C } = this;
    this.setPoint = snapTemp(platform.defaultTemp, caps);
    const min = caps?.min ?? 15.5;
    const max = caps?.max ?? 30.5;
    const step = caps?.step || 0.5;
    this.svc = this.service(this.S.HeaterCooler, label);
    this.svc.getCharacteristic(C.Active)
      .onGet(() => this.activeState(this.s))
      .onSet((v) => this.setActive(v));
    this.svc.getCharacteristic(C.CurrentHeaterCoolerState).onGet(() => this.coolerState(this.s));
    this.svc.getCharacteristic(C.TargetHeaterCoolerState)
      .updateValue(C.TargetHeaterCoolerState.COOL)   // value first, or HAP warns the default AUTO is invalid
      .setProps({ validValues: [C.TargetHeaterCoolerState.COOL] })
      .onGet(() => C.TargetHeaterCoolerState.COOL)
      .onSet(() => undefined);
    this.svc.getCharacteristic(C.CurrentTemperature)
      .setProps({ minValue: 0, maxValue: 50, minStep: 0.5 })
      .onGet(() => this.temp(this.s));
    const thr = this.svc.getCharacteristic(C.CoolingThresholdTemperature);
    thr.updateValue(this.setPoint);                     // HAP's default 10 is below the car's minimum
    thr.setProps({ minValue: min, maxValue: max, minStep: step });
    thr.onGet(() => this.temp(this.s)).onSet((v) => this.setTemp(v));
    if (caps?.temp === false) {
      thr.setProps({ perms: [this.hap.Perms.PAIRED_READ, this.hap.Perms.NOTIFY] });
    }
  }

  private actual(s: Summary): number | null {
    if (s.ac_on === true) {
      return this.C.Active.ACTIVE;
    }
    if (s.ac_on === false) {
      return this.C.Active.INACTIVE;
    }
    return null;
  }

  private activeState(s: Summary): number {
    return this.active.target(this.actual(s)) ?? this.C.Active.INACTIVE;
  }

  private coolerState(s: Summary): number {
    const { C } = this;
    return s.ac_on ? C.CurrentHeaterCoolerState.COOLING : C.CurrentHeaterCoolerState.INACTIVE;
  }

  private temp(s: Summary): number {
    const reported = decodeSetPoint(s.ac_temp_c);
    return snapTemp(this.wanted.target(reported === null ? null : snapTemp(reported, this.caps)) ?? this.setPoint, this.caps);
  }

  private setActive(v: CharacteristicValue): void {
    const on = v === this.C.Active.ACTIVE;
    if (this.activeState(this.platform.summary) === v && !this.active.active) {
      return;   // Home re-sends Active alongside a temperature change; don't toggle the car twice
    }
    this.active.set(v as number);
    this.send(on ? OP.acOn : OP.acOff, on ? 'A/C on' : 'A/C off', (ok) => {
      if (!ok) {
        this.active.clear();
      }
      this.update(this.platform.summary);
    });
  }

  private setTemp(v: CharacteristicValue): void {
    const c = snapTemp(Number(v), this.caps);
    this.setPoint = c;
    this.wanted.set(c);
    // The slider sends a value per step while dragging: send only where it comes to rest.
    clearTimeout(this.tempTimer);
    this.tempTimer = setTimeout(() => {
      this.send(tempOp(c), `A/C to ${c} °C`, (ok) => {
        if (!ok) {
          this.wanted.clear();
        }
        this.update(this.platform.summary);
      }, 'climate-temp');                       // own slot: never replaces a queued A/C on/off
    }, 2_000);
  }

  update(s: Summary): void {
    const { C } = this;
    const reported = decodeSetPoint(s.ac_temp_c);
    if (reported !== null && !this.wanted.active) {
      this.setPoint = snapTemp(reported, this.caps);
    }
    this.svc.updateCharacteristic(C.Active, this.activeState(s));
    this.svc.updateCharacteristic(C.CurrentHeaterCoolerState, this.coolerState(s));
    this.svc.updateCharacteristic(C.CurrentTemperature, this.temp(s));
    this.svc.updateCharacteristic(C.CoolingThresholdTemperature, this.temp(s));
  }
}

// ---------------------------------------------------------------------------------------------

/** Find car (horn + lights) as a switch that turns itself back off. */
export class FindAccessory extends CarAccessory {
  private readonly svc: Service;

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string) {
    super(platform, accessory, label);
    this.svc = this.service(this.S.Switch, label);
    this.svc.getCharacteristic(this.C.On)
      .onGet(() => false)
      .onSet((v) => {
        if (v) {
          this.send(OP.find, 'find car (horn and lights)', () => undefined);
          setTimeout(() => this.svc.updateCharacteristic(this.C.On, false), 1_500);
        }
      });
  }

  update(): void {
    // stateless
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * Open/close tile (a HomeKit window, 0 or 100 only) for something the car moves as a whole: all
 * windows, or the sunroof. A tap opens or closes it; there's no slider to guess positions with.
 */
abstract class OpenCloseAccessory extends CarAccessory {
  protected readonly svc: Service;
  private readonly target = new Pending<number>(HOLD_MS);

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string,
    private readonly cmd: { open: string; close: string; thing: string; slot: string }) {
    super(platform, accessory, label);
    const { C } = this;
    this.svc = this.service(this.S.Window, label);
    this.svc.getCharacteristic(C.CurrentPosition).setProps({ minStep: 100 }).onGet(() => this.current(this.s));
    this.svc.getCharacteristic(C.TargetPosition)
      .setProps({ minStep: 100 })
      .onGet(() => this.targetPos(this.s))
      .onSet((v) => this.setTarget(Number(v) >= 50 ? 100 : 0));
    this.svc.getCharacteristic(C.PositionState).onGet(() => this.posState(this.s));
  }

  /** true = open (anything but fully closed), false = closed, null = unknown. */
  protected abstract isOpen(s: Summary): boolean | null;

  private current(s: Summary): number {
    const o = this.isOpen(s);
    return o === null ? 0 : o ? 100 : 0;
  }

  private targetPos(s: Summary): number {
    const o = this.isOpen(s);
    return this.target.target(o === null ? null : o ? 100 : 0) ?? this.current(s);
  }

  private posState(s: Summary): number {
    const { C } = this;
    const cur = this.current(s);
    const tgt = this.targetPos(s);
    return tgt > cur ? C.PositionState.INCREASING : tgt < cur ? C.PositionState.DECREASING : C.PositionState.STOPPED;
  }

  private setTarget(pos: number): void {
    const open = pos === 100;
    this.target.set(pos);
    this.send(open ? this.cmd.open : this.cmd.close, `${open ? 'open' : 'close'} the ${this.cmd.thing}`, (ok) => {
      if (!ok) {
        this.target.clear();
      }
      this.update(this.platform.summary);
    }, this.cmd.slot);
  }

  update(s: Summary): void {
    const { C } = this;
    this.svc.updateCharacteristic(C.CurrentPosition, this.current(s));
    this.svc.updateCharacteristic(C.TargetPosition, this.targetPos(s));
    this.svc.updateCharacteristic(C.PositionState, this.posState(s));
  }
}

/** All windows together: the car has no per-window command. */
export class WindowsAccessory extends OpenCloseAccessory {
  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string) {
    super(platform, accessory, label, { open: OP.windowsOpen, close: OP.windowsClose, thing: 'windows', slot: 'windows' });
  }

  protected isOpen(s: Summary): boolean | null {
    return anyWindowOpen(s.window_state);
  }
}

export class SunroofAccessory extends OpenCloseAccessory {
  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string) {
    super(platform, accessory, label, { open: OP.sunroofOpen, close: OP.sunroofClose, thing: 'sunroof', slot: 'sunroof' });
  }

  protected isOpen(s: Summary): boolean | null {
    const r = sunroofState(s.sunroof);
    return r === null ? null : r !== 'closed';
  }
}

// ---------------------------------------------------------------------------------------------

/**
 * A switch for a car mode that's undone by closing: Windows Vent (on = vent all, off = close all)
 * and Sunroof Tilt (on = tilt, off = close). It shares its slot with the matching open/close tile,
 * so the newest of the two wins if both are tapped quickly.
 */
export class ModeSwitchAccessory extends CarAccessory {
  private readonly svc: Service;
  private readonly target = new Pending<boolean>(HOLD_MS);

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string,
    private readonly m: { on: string; off: string; onWhat: string; offWhat: string; slot: string; isOn: (s: Summary) => boolean | null }) {
    super(platform, accessory, label);
    this.svc = this.service(this.S.Switch, label);
    this.svc.getCharacteristic(this.C.On)
      .onGet(() => this.state(this.s))
      .onSet((v) => this.set(!!v));
  }

  private state(s: Summary): boolean {
    return this.target.target(this.m.isOn(s)) ?? false;
  }

  private set(on: boolean): void {
    this.target.set(on);
    this.send(on ? this.m.on : this.m.off, on ? this.m.onWhat : this.m.offWhat, (ok) => {
      if (!ok) {
        this.target.clear();
      }
      this.update(this.platform.summary);
    }, this.m.slot);
  }

  update(s: Summary): void {
    this.svc.updateCharacteristic(this.C.On, this.state(s));
  }
}

export function windowsVentSwitch(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string): ModeSwitchAccessory {
  return new ModeSwitchAccessory(platform, accessory, label, {
    on: OP.windowsVent, off: OP.windowsClose, onWhat: 'vent the windows', offWhat: 'close the windows',
    slot: 'windows', isOn: (s) => windowsVented(s.window_state),
  });
}

export function sunroofTiltSwitch(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string): ModeSwitchAccessory {
  return new ModeSwitchAccessory(platform, accessory, label, {
    on: OP.sunroofTilt, off: OP.sunroofClose, onWhat: 'tilt the sunroof', offWhat: 'close the sunroof',
    slot: 'sunroof', isOn: (s) => {
      const r = sunroofState(s.sunroof);
      return r === null ? null : r === 'tilt';
    },
  });
}

// ---------------------------------------------------------------------------------------------

/** Each window's state as a contact sensor (read-only): "open" when it isn't fully closed. */
export class WindowStatusAccessory extends CarAccessory {
  private readonly sensors: Service[];

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string) {
    super(platform, accessory, label);
    this.sensors = WINDOW_NAMES.map((name, i) => {
      const svc = this.service(this.S.ContactSensor, `${name} Window`, `window-${i}`);
      svc.getCharacteristic(this.C.ContactSensorState).onGet(() => this.state(this.s, i));
      return svc;
    });
  }

  private state(s: Summary, i: number): number {
    const { C } = this;
    return windowOpen(s.window_state, i) ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED;
  }

  update(s: Summary): void {
    this.sensors.forEach((svc, i) => svc.updateCharacteristic(this.C.ContactSensorState, this.state(s, i)));
  }
}

/** "Charging" as an occupancy sensor: detected while the car charges. For automations. */
export class ChargingAccessory extends CarAccessory {
  private readonly svc: Service;

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string) {
    super(platform, accessory, label);
    this.svc = this.service(this.S.OccupancySensor, label);
    this.svc.getCharacteristic(this.C.OccupancyDetected).onGet(() => this.state(this.s));
  }

  private state(s: Summary): number {
    const { C } = this;
    return s.charging?.active ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  update(s: Summary): void {
    this.svc.updateCharacteristic(this.C.OccupancyDetected, this.state(s));
  }
}

// ---------------------------------------------------------------------------------------------

/** Power liftgate / boot as a garage door (so Home asks for Face ID before opening it). */
export class LiftgateAccessory extends CarAccessory {
  private readonly svc: Service;
  private readonly target = new Pending<number>(HOLD_MS);

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string) {
    super(platform, accessory, label);
    const { C } = this;
    this.svc = this.service(this.S.GarageDoorOpener, label);
    this.svc.getCharacteristic(C.CurrentDoorState).onGet(() => this.currentState(this.s));
    this.svc.getCharacteristic(C.TargetDoorState)
      .onGet(() => this.targetState(this.s))
      .onSet((v) => this.setTarget(v));
    this.svc.getCharacteristic(C.ObstructionDetected).onGet(() => false);
  }

  private actual(s: Summary): number | null {
    const { C } = this;
    return s.trunk_open === true ? C.TargetDoorState.OPEN : s.trunk_open === false ? C.TargetDoorState.CLOSED : null;
  }

  private targetState(s: Summary): number {
    return this.target.target(this.actual(s)) ?? this.actual(s) ?? this.C.TargetDoorState.CLOSED;
  }

  private currentState(s: Summary): number {
    const { C } = this;
    const a = this.actual(s);
    const t = this.targetState(s);
    if (a === null) {
      return C.CurrentDoorState.STOPPED;
    }
    if (a !== t) {
      return t === C.TargetDoorState.OPEN ? C.CurrentDoorState.OPENING : C.CurrentDoorState.CLOSING;
    }
    return a === C.TargetDoorState.OPEN ? C.CurrentDoorState.OPEN : C.CurrentDoorState.CLOSED;
  }

  private setTarget(v: CharacteristicValue): void {
    const open = v === this.C.TargetDoorState.OPEN;
    this.target.set(v as number);
    this.send(open ? OP.liftgateOpen : OP.liftgateClose, open ? 'open the liftgate' : 'close the liftgate', (ok) => {
      if (!ok) {
        this.target.clear();
      }
      this.update(this.platform.summary);
    });
  }

  update(s: Summary): void {
    this.svc.updateCharacteristic(this.C.TargetDoorState, this.targetState(s));
    this.svc.updateCharacteristic(this.C.CurrentDoorState, this.currentState(s));
  }
}

// ---------------------------------------------------------------------------------------------

/** Any door (or the boot) open, as a contact sensor. */
export class DoorsAccessory extends CarAccessory {
  private readonly svc: Service;

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string) {
    super(platform, accessory, label);
    this.svc = this.service(this.S.ContactSensor, label);
    this.svc.getCharacteristic(this.C.ContactSensorState).onGet(() => this.state(this.s));
  }

  private state(s: Summary): number {
    const { C } = this;
    const open = anyDoorOpen(s.doors) || s.trunk_open === true;
    return open ? C.ContactSensorState.CONTACT_NOT_DETECTED : C.ContactSensorState.CONTACT_DETECTED;
  }

  update(s: Summary): void {
    this.svc.updateCharacteristic(this.C.ContactSensorState, this.state(s));
  }
}

// ---------------------------------------------------------------------------------------------

/** "Car at home": an occupancy sensor fed by OpenLinko's location feature + a home geofence. */
export class PresenceAccessory extends CarAccessory {
  private readonly svc: Service;
  private home: boolean | null = null;

  constructor(platform: OpenLinkoPlatform, accessory: PlatformAccessory, label: string,
    private readonly fence: { lat: number; lng: number; radius: number }) {
    super(platform, accessory, label);
    this.svc = this.service(this.S.OccupancySensor, label);
    this.svc.getCharacteristic(this.C.OccupancyDetected).onGet(() => this.state());
    if (typeof accessory.context.home === 'boolean') {
      this.home = accessory.context.home;
    }
  }

  private state(): number {
    const { C } = this;
    return this.home ? C.OccupancyDetected.OCCUPANCY_DETECTED : C.OccupancyDetected.OCCUPANCY_NOT_DETECTED;
  }

  updateLocation(loc: Location): void {
    const next = atHome(loc, this.fence, this.home);
    if (next === null || next === this.home) {
      return;
    }
    if (this.home !== null) {
      this.platform.log.info(`${this.label}: ${next ? 'the car is home' : 'the car left home'}`);
    }
    this.home = next;
    this.accessory.context.home = next;
    this.svc.updateCharacteristic(this.C.OccupancyDetected, this.state());
  }

  update(): void {
    // driven by updateLocation
  }
}
