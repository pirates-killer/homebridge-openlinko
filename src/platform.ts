import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig } from 'homebridge';
import {
  CarAccessory, ClimateAccessory, DoorsAccessory, FindAccessory, LiftgateAccessory, LockAccessory,
  PresenceAccessory, SunroofAccessory, WindowsAccessory,
} from './accessories.js';
import { OpenLinkoClient } from './client.js';
import { baseUrl } from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME, PLUGIN_VERSION } from './settings.js';
import type { Caps, Summary } from './state.js';

export interface OpenLinkoConfig extends PlatformConfig {
  host?: string;
  port?: number;
  https?: boolean;
  url?: string;          // legacy single-URL setting, used only when host is empty
  password?: string;
  carName?: string;
  lock?: boolean;
  climate?: boolean;
  defaultTemp?: number;
  find?: boolean;
  windows?: boolean;
  sunroof?: boolean;
  liftgate?: boolean;
  doors?: boolean;
  lowBattery?: number;
  home?: { enabled?: boolean; lat?: number; lng?: number; radius?: number };
}

type Kind = 'lock' | 'climate' | 'find' | 'windows' | 'sunroof' | 'liftgate' | 'doors' | 'home';

interface Cache {
  key?: string;
  model?: string;
  caps?: Caps;
}

const UNREACHABLE_MS = 5 * 60_000;   // OpenLinko silent this long (stream down, polls failing) -> "No Response"
const POLL_MS = 60_000;              // fallback poll while the stream is down
const LOCATION_MS = 60_000;          // /api/location is a local DB read on the OpenLinko side
const RETRY_SETUP_MS = 60_000;

export class OpenLinkoPlatform implements DynamicPlatformPlugin {
  readonly client: OpenLinkoClient;
  readonly url: string;
  readonly version = PLUGIN_VERSION;
  readonly carName: string;
  readonly defaultTemp: number;
  readonly lowBattery: number;
  model = '';
  serial = 'OpenLinko';
  summary: Summary = {};
  private lastOk = 0;
  private haveData = false;
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly handlers: CarAccessory[] = [];
  private presence: PresenceAccessory | null = null;
  private readonly cachePath: string;
  private refreshTimer?: NodeJS.Timeout;
  private warnedGuard = false;

  constructor(readonly log: Logging, readonly config: OpenLinkoConfig, readonly api: API) {
    this.url = baseUrl(config);
    this.client = new OpenLinkoClient(this.url, config.password || undefined, log);
    this.carName = (config.carName || 'Car').trim();
    this.defaultTemp = Number(config.defaultTemp) || 22;
    this.lowBattery = Number.isFinite(config.lowBattery) ? Number(config.lowBattery) : 20;
    this.cachePath = join(api.user.storagePath(), 'homebridge-openlinko.json');
    api.on('didFinishLaunching', () => void this.setup());
    api.on('shutdown', () => this.client.stop());
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  // ---- data ----

  /** Latest summary for onGet; throws "No Response" while OpenLinko can't be reached. */
  liveSummary(): Summary {
    if (!this.haveData || (!this.client.connected && Date.now() - this.lastOk > UNREACHABLE_MS)) {
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
    return this.summary;
  }

  private onSummary(s: Summary): void {
    this.summary = s;
    this.haveData = true;
    this.lastOk = Date.now();
    if (s.login_guard && !this.warnedGuard) {
      this.warnedGuard = true;
      this.log.warn('OpenLinko reports its CarLinko login is paused (login guard); data may be stale and commands may fail.');
    } else if (!s.login_guard) {
      this.warnedGuard = false;
    }
    for (const h of this.handlers) {
      try {
        h.update(s);
      } catch (e) {
        this.log.debug(`update failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** After a command: re-read the summary a little later, in case the stream has nothing new yet. */
  refreshSoon(): void {
    clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.client.summary().then((s) => this.onSummary(s), () => undefined);
    }, 10_000);
  }

  // ---- setup ----

  private readCache(): Cache {
    try {
      return JSON.parse(readFileSync(this.cachePath, 'utf8')) as Cache;
    } catch {
      return {};
    }
  }

  private writeCache(c: Cache): void {
    try {
      writeFileSync(this.cachePath, JSON.stringify(c, null, 2));
    } catch (e) {
      this.log.debug(`could not write ${this.cachePath}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async setup(): Promise<void> {
    let cache = this.readCache();
    try {
      const [caps, summary] = await Promise.all([this.client.caps(), this.client.summary()]);
      const vin = summary.vehicle?.vin || caps.plate || 'car';
      // A stable, non-reversible id: the VIN itself never leaves OpenLinko through this plugin.
      cache = { key: createHash('sha256').update('openlinko:' + vin).digest('hex').slice(0, 16), model: summary.vehicle?.model, caps };
      this.writeCache(cache);
      this.onSummary(summary);
      this.log.info(`Connected to OpenLinko: ${summary.vehicle?.model ?? 'car'}, battery ${summary.battery ?? '?'}%`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (!cache.caps) {
        this.log.error(`Can't reach OpenLinko (${msg}). Retrying in 60 s. Is the dashboard running at ${this.url}?`);
        // keep restored accessories as they are (showing No Response) until OpenLinko answers
        setTimeout(() => void this.setup(), RETRY_SETUP_MS);
        return;
      }
      this.log.warn(`OpenLinko isn't answering yet (${msg}); using the car's saved capabilities.`);
    }
    this.model = cache.model ?? '';
    this.serial = `OL-${cache.key?.slice(0, 8) ?? '0'}`;
    await this.buildAccessories(cache.key ?? 'car', cache.caps ?? {});
    this.client.on('summary', (s: Summary) => this.onSummary(s));
    this.client.on('connected', () => this.log.debug('OpenLinko stream connected'));
    this.client.start();
    setInterval(() => {
      if (!this.client.connected) {
        this.client.summary().then((s) => this.onSummary(s), (e: unknown) => {
          this.log.debug(`poll failed: ${e instanceof Error ? e.message : String(e)}`);
        });
      }
    }, POLL_MS);
  }

  private async buildAccessories(key: string, caps: Caps): Promise<void> {
    const c = this.config;
    const name = this.carName;
    const want = new Map<Kind, string>();
    const on = (v: boolean | undefined, dflt: boolean) => (v === undefined ? dflt : v);
    if (on(c.lock, true) && caps.lock !== false) {
      want.set('lock', name);
    }
    if (on(c.climate, true) && caps.ac?.switch) {
      want.set('climate', `${name} A/C`);
    }
    if (on(c.find, true) && caps.find) {
      want.set('find', `Find ${name}`);
    }
    if (on(c.windows, true) && (caps.windows?.open || caps.windows?.close)) {
      want.set('windows', `${name} Windows`);
    }
    if (on(c.sunroof, false) && caps.sunroof?.open) {
      want.set('sunroof', `${name} Sunroof`);
    }
    if (on(c.liftgate, false) && (caps.liftgate || caps.trunk)) {
      want.set('liftgate', `${name} Liftgate`);
    }
    if (on(c.doors, true)) {
      want.set('doors', `${name} Doors`);
    }
    const fence = this.fence();
    if (fence) {
      const loc = await this.client.location().catch(() => undefined);
      if (loc === null) {
        this.log.warn('"Car at home" needs an OpenLinko with the car location feature (/api/location); skipping it.');
      } else {
        if (loc && !loc.enabled) {
          this.log.warn('"Car at home": location is off in OpenLinko. Set "location": true in its creds.json.');
        }
        want.set('home', `${name} Home`);
      }
    }

    const keep = new Set<string>();
    for (const [kind, label] of want) {
      const uuid = this.api.hap.uuid.generate(`${PLUGIN_NAME}:${key}:${kind}`);
      keep.add(uuid);
      let acc = this.cached.get(uuid);
      if (!acc) {
        acc = new this.api.platformAccessory(label, uuid);
        acc.context.kind = kind;
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [acc]);
        this.log.info(`Added ${label}`);
      }
      acc.context.kind = kind;
      const h = this.handler(kind, acc, label, caps, fence);
      this.handlers.push(h);
      if (h instanceof PresenceAccessory) {
        this.presence = h;
      }
    }
    const stale = [...this.cached.values()].filter((a) => !keep.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      this.log.info(`Removed ${stale.map((a) => a.displayName).join(', ')}`);
    }
    if (this.haveData) {
      this.onSummary(this.summary);
    }
    if (this.presence) {
      const tick = () => this.client.location().then((l) => l && this.presence?.updateLocation(l), () => undefined);
      void tick();
      setInterval(tick, LOCATION_MS);
    }
  }

  private fence(): { lat: number; lng: number; radius: number } | null {
    const h = this.config.home;
    if (!h?.enabled) {
      return null;
    }
    const lat = Number(h.lat);
    const lng = Number(h.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
      this.log.warn('"Car at home" is on but the home latitude/longitude are missing or invalid; skipping it.');
      return null;
    }
    return { lat, lng, radius: Math.max(50, Number(h.radius) || 150) };
  }

  private handler(kind: Kind, acc: PlatformAccessory, label: string, caps: Caps,
    fence: { lat: number; lng: number; radius: number } | null): CarAccessory {
    switch (kind) {
      case 'lock': return new LockAccessory(this, acc, label);
      case 'climate': return new ClimateAccessory(this, acc, label, caps.ac);
      case 'find': return new FindAccessory(this, acc, label);
      case 'windows': return new WindowsAccessory(this, acc, label, caps.windows);
      case 'sunroof': return new SunroofAccessory(this, acc, label, caps.sunroof);
      case 'liftgate': return new LiftgateAccessory(this, acc, label);
      case 'doors': return new DoorsAccessory(this, acc, label);
      case 'home': return new PresenceAccessory(this, acc, label, fence!);
    }
  }
}
