// Pure mapping between OpenLinko's JSON and what the HomeKit services show. No Homebridge imports
// here, so all of it is unit-tested in test/state.test.ts.

/** The subset of OpenLinko's GET /api/summary (and each /api/stream event) this plugin reads. */
export interface Summary {
  vehicle?: { plate?: string; model?: string; vin?: string };
  online?: boolean;
  age_min?: number | null;
  battery?: number | null;
  range_km?: number | null;
  unlocked?: boolean | null;
  moving?: boolean | null;
  volt12?: number | null;
  charging?: { active?: boolean; rate_kw?: number | null } | null;
  doors?: number | null;
  trunk_open?: boolean | null;
  window_state?: (string | number)[] | null;
  sunroof?: string | number | null;
  ac_on?: boolean | null;
  ac_temp_c?: number | null;
  login_guard?: unknown;
}

/** GET /api/controls -> caps: what this car's vehicleControlConfig says it supports. */
export interface Caps {
  lock?: boolean;
  windows?: { open?: boolean; close?: boolean; vent?: boolean };
  sunroof?: { open?: boolean; tilt?: boolean };
  liftgate?: boolean;
  trunk?: boolean;
  find?: boolean;
  ac?: { switch?: boolean; temp?: boolean; min?: number | null; max?: number | null; step?: number | null };
  plate?: string;
}

/** GET /api/location (OpenLinko's opt-in car location feature). */
export interface Location {
  enabled?: boolean;
  lat?: number | null;
  lng?: number | null;
  ts?: number | null;
  age_s?: number | null;
  moving?: boolean;
}

/** POST /api/control reply. ok = reached the T-Box and not refused; confirmed = the car said 00. */
export interface ControlResult {
  ok?: boolean;
  confirmed?: boolean;
  code?: string;
  result?: string | null;
  reason?: string | null;
  msg?: string | null;
  error?: string | null;
}

// The only commands this plugin will ever send. Engine start/stop (740700/740800) is deliberately
// absent: a stray tap or automation should never be able to start a car.
export const OP = {
  lock: '740100',
  unlock: '740200',
  acOn: '741001',
  acOff: '741000',
  windowsClose: '740500',
  windowsVent: '740E00',
  windowsOpen: '740600',
  sunroofClose: '740F00',
  sunroofOpen: '740F01',
  sunroofTilt: '740F02',
  liftgateOpen: '740300',
  liftgateClose: '740A00',
  find: '740400',
} as const;

const ALLOWED = new Set<string>(Object.values(OP));
const TEMP_OP = /^7411[0-9A-F]{2}$/;

/** True for an opcode this plugin is allowed to send. */
export function isAllowedOp(op: string): boolean {
  const k = op.toUpperCase();
  return ALLOWED.has(k) || TEMP_OP.test(k);
}

/** A/C set-point command: 7411 + one byte = 0x80 + 2 x degC (half degrees fit; 22.0 C = 7411AC). */
export function tempOp(c: number): string {
  const b = 0x80 + Math.round(c * 2);
  if (b < 0x80 || b > 0xff) {
    throw new RangeError(`temperature out of range: ${c}`);
  }
  return '7411' + b.toString(16).toUpperCase().padStart(2, '0');
}

/** Byte 24 as the A/C set-point (2 x degC, optional 0x80 flag), or null when it isn't one. */
export function decodeSetPoint(raw: number | null | undefined): number | null {
  if (raw === null || raw === undefined || !raw) {
    return null;
  }
  const c = (raw & 0x7f) / 2;
  return c >= 15 && c <= 32 ? c : null;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** Snap a temperature onto the car's own range and step. */
export function snapTemp(c: number, caps: Caps['ac']): number {
  const min = caps?.min ?? 15.5;
  const max = caps?.max ?? 30.5;
  const step = caps?.step || 0.5;
  return clamp(Math.round((c - min) / step) * step + min, min, max);
}

// ---- windows ----
// HomeKit windows are a 0-100 position; the car only knows close / vent / open.
export const WINDOW_VENT_POS = 20;

export type WindowCmd = 'close' | 'vent' | 'open';

export function windowCmdFor(pos: number, canVent: boolean): WindowCmd {
  if (pos <= 10) {
    return 'close';
  }
  if (canVent && pos <= 60) {
    return 'vent';
  }
  return 'open';
}

export function windowPosFor(cmd: WindowCmd): number {
  return cmd === 'close' ? 0 : cmd === 'vent' ? WINDOW_VENT_POS : 100;
}

/** Current window position from window_state: all closed -> 0, any open -> 100, else vent. */
export function windowsPosition(ws: Summary['window_state']): number | null {
  if (!Array.isArray(ws) || ws.length === 0) {
    return null;
  }
  if (ws.some((w) => w === 'open')) {
    return 100;
  }
  if (ws.every((w) => w === 'closed')) {
    return 0;
  }
  return WINDOW_VENT_POS;
}

export type RoofCmd = 'close' | 'tilt' | 'open';

export function roofCmdFor(pos: number, canTilt: boolean): RoofCmd {
  if (pos <= 10) {
    return 'close';
  }
  if (canTilt && pos <= 60) {
    return 'tilt';
  }
  return 'open';
}

export function roofPosFor(cmd: RoofCmd): number {
  return cmd === 'close' ? 0 : cmd === 'tilt' ? WINDOW_VENT_POS : 100;
}

export function sunroofPosition(s: Summary['sunroof']): number | null {
  if (s === 'closed') {
    return 0;
  }
  if (s === 'tilt') {
    return WINDOW_VENT_POS;
  }
  if (s === 'open') {
    return 100;
  }
  return null;
}

/** Door bitmask (bits 0-3 = the four doors). null = unknown. */
export function anyDoorOpen(doors: number | null | undefined): boolean | null {
  return doors === null || doors === undefined ? null : (doors & 0x0f) !== 0;
}

// ---- location ----

/** Great-circle distance in metres. */
export function haversineM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Is the car at home? Hysteresis so a fix wobbling on the edge doesn't flap the sensor:
 * it must come within `radius` to count as home, and leave `radius * 1.5` to count as away.
 */
export function atHome(loc: Location, home: { lat: number; lng: number; radius: number }, prev: boolean | null): boolean | null {
  if (!loc.enabled || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
    return null;
  }
  const d = haversineM(loc.lat, loc.lng, home.lat, home.lng);
  if (prev === true) {
    return d <= home.radius * 1.5;
  }
  return d <= home.radius;
}

// ---- optimistic targets ----

/**
 * After a command, HomeKit shows the target ("Unlocking...") while the car catches up. Telemetry
 * that arrives in the meantime may still be the old state, so the target only follows telemetry
 * again once it agrees or the hold expires.
 */
export class Pending<T> {
  private value: T | null = null;
  private until = 0;

  constructor(private readonly holdMs: number, private readonly now: () => number = Date.now) {}

  set(v: T): void {
    this.value = v;
    this.until = this.now() + this.holdMs;
  }

  clear(): void {
    this.value = null;
    this.until = 0;
  }

  /** The target to show, given what telemetry currently says. */
  target(actual: T | null): T | null {
    if (this.value === null) {
      return actual;
    }
    if (actual === this.value || this.now() >= this.until) {
      this.clear();
      return actual;
    }
    return this.value;
  }

  get active(): boolean {
    return this.value !== null && this.now() < this.until;
  }
}

/** A short human message for a failed control reply. */
export function controlError(r: ControlResult): string {
  return r.reason || r.error || r.msg || (r.code ? `CarLinko code ${r.code}` : 'unknown error');
}
