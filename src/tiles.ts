// Map tiles for the settings page, fetched by the settings page's backend and cached on disk.
//
// Why not straight from the browser: the Homebridge UI serves every page with
// "Referrer-Policy: no-referrer", and OpenStreetMap blocks anonymous browser requests. So the
// backend fetches tiles as an app, following the OSMF Tile Usage Policy
// (https://operations.osmfoundation.org/policies/tiles/):
//   - the exact URL https://tile.openstreetmap.org/{z}/{x}/{y}.png (configurable, as the policy
//     recommends, so it can be switched without a software update)
//   - a distinct, stable User-Agent naming the app with a contact URL (never a library default)
//   - server caching headers honoured (Cache-Control / Expires / ETag); 7 days when there are none.
//     That includes stale-while-revalidate and stale-if-error (RFC 5861), which OSM sends: within
//     those windows a stale tile is shown at once and re-checked in the background, or kept on errors.
//   - conditional requests (If-None-Match / If-Modified-Since) once a cached tile has expired
//   - never a no-cache request header
//   - only tiles someone is looking at: no prefetch, no bulk download, plus a hard budget so this
//     endpoint can't be turned into a scraper
// Attribution is shown on the map itself, by the page.

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const OSM_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const DEFAULT_TTL_MS = 7 * 86400_000;      // policy: "at least 7 days" when headers can't be used
const MAX_ZOOM = 19;
const RECHECK_MS = 10 * 60_000;                  // minimum gap between background re-checks of a tile

export interface TileFetcherOptions {
  dir: string;                 // disk cache root; each tile server gets its own folder
  userAgent: string;           // required: names the app, with a contact URL
  url?: string;                // tile URL template ({z}, {x}, {y}); https only
  maxFiles?: number;           // disk cap per tile server; the oldest tiles go first
  maxParallel?: number;        // upstream requests at once
  budget?: { fetches: number; perMs: number };   // upstream requests allowed per window
  memTiles?: number;           // in-memory cache size
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface Meta {
  expires: number;             // ms epoch; fresh until then
  swrUntil?: number;           // may be served stale (re-checking in the background) until then
  sieUntil?: number;           // may be served stale when the server errors, until then
  checkedAt?: number;          // last time the tile server was asked about this tile
  etag?: string;
  lastModified?: string;
}

interface Entry {
  png: Buffer;
  meta: Meta;
}

/** Only real tile coordinates: keeps the fetcher from being pointed at anything else. */
export function validTile(z: unknown, x: unknown, y: unknown): { z: number; x: number; y: number } | null {
  const [zi, xi, yi] = [Number(z), Number(x), Number(y)];
  if (![zi, xi, yi].every(Number.isInteger) || zi < 0 || zi > MAX_ZOOM) {
    return null;
  }
  const n = 2 ** zi;
  return xi >= 0 && xi < n && yi >= 0 && yi < n ? { z: zi, x: xi, y: yi } : null;
}

/** An https tile template with {z}, {x} and {y}, or null. */
export function validTileUrl(url: unknown): string | null {
  const u = String(url ?? '').trim();
  if (!/^https:\/\/[^/\s]+\/\S*$/i.test(u) || !['{z}', '{x}', '{y}'].every((p) => u.includes(p))) {
    return null;
  }
  try {
    new URL(u.replace(/\{[zxy]\}/g, '0'));
  } catch {
    return null;
  }
  return u;
}

export interface CacheWindows {
  expires: number;             // fresh until (ms epoch)
  swrUntil: number;            // stale-while-revalidate allowed until
  sieUntil: number;            // stale-if-error allowed until
}

/**
 * How long a response may be used, from its caching headers (RFC 9111 private cache, RFC 5861
 * extensions). null = no-store (never cache). max-age wins over Expires and is reduced by Age;
 * no-cache / max-age=0 -> revalidate every time; no usable header -> the policy's 7-day minimum.
 * The stale windows are counted from the moment the response became stale, as RFC 5861 defines.
 */
export function cacheWindows(headers: Headers, now: number): CacheWindows | null {
  const cc = (headers.get('cache-control') ?? '').toLowerCase();
  const directive = (name: string): number | null => {
    const m = new RegExp(`(^|,)\\s*${name}\\s*=\\s*"?(\\d+)"?`).exec(cc);
    return m ? Number(m[2]) : null;
  };
  if (/(^|,)\s*no-store\b/.test(cc)) {
    return null;
  }
  const age = Math.max(0, Number(headers.get('age')) || 0);
  let expires: number;
  const maxAge = directive('max-age');
  if (/(^|,)\s*no-cache\b/.test(cc)) {
    expires = now;
  } else if (maxAge !== null) {
    expires = now + (maxAge - age) * 1000;        // may be in the past: already stale on arrival
  } else if (headers.get('expires')) {
    const t = Date.parse(headers.get('expires') as string);
    expires = Number.isFinite(t) ? t : now;      // an invalid Expires means "already expired"
  } else {
    expires = now + DEFAULT_TTL_MS;
  }
  const noStale = /(^|,)\s*(no-cache|must-revalidate|proxy-revalidate)\b/.test(cc);
  const swr = noStale ? 0 : (directive('stale-while-revalidate') ?? 0);
  const sie = /(^|,)\s*must-revalidate\b/.test(cc) ? 0 : (directive('stale-if-error') ?? 0);
  return { expires, swrUntil: expires + swr * 1000, sieUntil: expires + sie * 1000 };
}

/** Fresh-until time only (kept for callers and tests that need just that). */
export function expiryFrom(headers: Headers, now: number): number | null {
  const w = cacheWindows(headers, now);
  return w ? Math.max(w.expires, now) : null;
}

export class TileError extends Error {}

export class TileFetcher {
  private readonly url: string;
  private readonly dir: string;
  private readonly ua: string;
  private readonly maxFiles: number;
  private readonly maxParallel: number;
  private readonly budget: { fetches: number; perMs: number };
  private readonly memTiles: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly mem = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<Buffer>>();
  private readonly waiting: (() => void)[] = [];
  private readonly recent: number[] = [];
  private readonly checked = new Map<string, number>();   // last background re-check per tile
  private active = 0;
  private writes = 0;

  constructor(o: TileFetcherOptions) {
    if (!o.userAgent || !/\S+\/\S+/.test(o.userAgent)) {
      throw new TypeError('a distinct User-Agent ("app/version (+contact)") is required by the tile usage policy');
    }
    const url = validTileUrl(o.url ?? OSM_TILE_URL);
    if (!url) {
      throw new TypeError(`not an https tile URL with {z}/{x}/{y}: ${o.url}`);
    }
    this.url = url;
    this.ua = o.userAgent;
    // one folder per tile server, so switching servers never mixes their tiles
    this.dir = join(o.dir, createHash('sha256').update(url).digest('hex').slice(0, 12));
    this.maxFiles = o.maxFiles ?? 3000;
    this.maxParallel = o.maxParallel ?? 2;
    this.budget = o.budget ?? { fetches: 300, perMs: 10 * 60_000 };
    this.memTiles = o.memTiles ?? 300;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
  }

  /** PNG bytes for one tile the user is looking at. */
  async get(z: number, x: number, y: number): Promise<Buffer> {
    const t = validTile(z, x, y);
    if (!t) {
      throw new RangeError(`not a tile: ${z}/${x}/${y}`);
    }
    const key = `${t.z}-${t.x}-${t.y}`;
    const now = this.now();
    let cached: Entry | undefined = this.mem.get(key);
    if (!cached) {
      const pending = this.inflight.get(key);
      if (pending) {
        return pending;
      }
      cached = await this.readDisk(key);
    }
    if (cached && cached.meta.expires > now) {
      return this.remember(key, cached);                     // fresh
    }
    if (cached && (cached.meta.swrUntil ?? 0) > now) {
      // stale-while-revalidate: show it now, re-check it in the background -- at most once per
      // RECHECK_MS per tile, so panning back and forth doesn't repeat conditional requests
      const last = Math.max(this.checked.get(key) ?? -Infinity, cached.meta.checkedAt ?? -Infinity);
      if (!this.inflight.has(key) && now - last >= RECHECK_MS) {
        this.checked.set(key, now);
        if (this.checked.size > this.memTiles * 4) {
          this.checked.delete(this.checked.keys().next().value as string);
        }
        const p = this.revalidate(key, t, cached).finally(() => this.inflight.delete(key));
        this.inflight.set(key, p);
        p.catch(() => undefined);
      }
      return this.remember(key, cached);
    }
    let p = this.inflight.get(key);
    if (!p) {
      p = this.revalidate(key, t, cached).finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  private remember(key: string, e: Entry): Buffer {
    this.mem.delete(key);
    this.mem.set(key, e);
    while (this.mem.size > this.memTiles) {
      this.mem.delete(this.mem.keys().next().value as string);
    }
    return e.png;
  }

  private async readDisk(key: string): Promise<Entry | undefined> {
    try {
      const [png, meta] = await Promise.all([
        readFile(join(this.dir, `${key}.png`)),
        readFile(join(this.dir, `${key}.json`), 'utf8').then((s) => JSON.parse(s) as Meta),
      ]);
      return typeof meta.expires === 'number' ? { png, meta } : undefined;
    } catch {
      return undefined;
    }
  }

  /** Ask the tile server, conditionally when we hold a copy; stale-if-error keeps the copy on failure. */
  private async revalidate(key: string, t: { z: number; x: number; y: number }, cached?: Entry): Promise<Buffer> {
    let res;
    try {
      res = await this.fetchUpstream(t, cached?.meta);
    } catch (e) {
      if (cached && (cached.meta.sieUntil ?? 0) > this.now()) {
        return this.remember(key, cached);
      }
      throw e;
    }
    if (res.notModified && cached) {
      const e = { png: cached.png, meta: { ...cached.meta, ...res.meta } };
      if (res.storable) {
        void this.store(key, e);
      }
      return this.remember(key, e);
    }
    if (!res.png) {
      throw new TileError('tile server sent no tile');
    }
    const e = { png: res.png, meta: res.meta };
    if (res.storable) {
      void this.store(key, e);
    }
    return this.remember(key, e);
  }

  private takeBudget(): void {
    const now = this.now();
    while (this.recent.length && this.recent[0] <= now - this.budget.perMs) {
      this.recent.shift();
    }
    if (this.recent.length >= this.budget.fetches) {
      throw new TileError('map tile limit reached for now; try again in a few minutes');
    }
    this.recent.push(now);
  }

  private async fetchUpstream(t: { z: number; x: number; y: number }, have?: Meta):
    Promise<{ png?: Buffer; meta: Meta; notModified: boolean; storable: boolean }> {
    if (this.active >= this.maxParallel) {
      await new Promise<void>((r) => this.waiting.push(r));
    }
    this.active++;
    try {
      this.takeBudget();
      const headers: Record<string, string> = { 'User-Agent': this.ua, Accept: 'image/png,image/*' };
      if (have?.etag) {
        headers['If-None-Match'] = have.etag;
      }
      if (have?.lastModified) {
        headers['If-Modified-Since'] = have.lastModified;
      }
      const url = this.url.replace('{z}', String(t.z)).replace('{x}', String(t.x)).replace('{y}', String(t.y));
      const res = await this.fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) });
      const now = this.now();
      const w = cacheWindows(res.headers, now);
      const meta: Meta = {
        expires: w?.expires ?? now,
        swrUntil: w?.swrUntil ?? now,
        sieUntil: w?.sieUntil ?? now,
        checkedAt: now,
        etag: res.headers.get('etag') ?? have?.etag,
        lastModified: res.headers.get('last-modified') ?? have?.lastModified,
      };
      if (res.status === 304) {
        await res.body?.cancel();
        return { meta, notModified: true, storable: w !== null };
      }
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) {
        await res.body?.cancel();
        throw new TileError(`tile server answered HTTP ${res.status}`);
      }
      const png = Buffer.from(await res.arrayBuffer());
      if (png.length < 200) {
        // OSM's "access blocked" placeholder is a tiny image: never show or cache it as a map
        throw new TileError('tile server refused the request (blocked placeholder)');
      }
      return { png, meta, notModified: false, storable: w !== null };
    } finally {
      this.active--;
      this.waiting.shift()?.();
    }
  }

  private async store(key: string, e: Entry): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(join(this.dir, `${key}.png`), e.png);
      await writeFile(join(this.dir, `${key}.json`), JSON.stringify(e.meta));
      if (++this.writes % 100 === 0) {
        await this.prune();
      }
    } catch {
      // a cache that can't be written only means asking again next time
    }
  }

  /** Keep the disk cache under maxFiles tiles, least recently stored first. */
  async prune(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.png'));
    } catch {
      return;
    }
    if (names.length <= this.maxFiles) {
      return;
    }
    const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(this.dir, n))).mtimeMs })));
    withTime.sort((a, b) => a.t - b.t);
    for (const { n } of withTime.slice(0, names.length - this.maxFiles)) {
      await unlink(join(this.dir, n)).catch(() => undefined);
      await unlink(join(this.dir, n.replace(/\.png$/, '.json'))).catch(() => undefined);
    }
  }
}
