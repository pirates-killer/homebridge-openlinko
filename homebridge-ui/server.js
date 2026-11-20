// Backend of the plugin's settings page. Runs inside the Homebridge UI (admin login required),
// never inside the bridge. It talks to two places only:
//   - your OpenLinko server (Test connection, the car's location), like the plugin itself
//   - the map tile server, for the tiles you are looking at, under the OSMF Tile Usage Policy
//     (see src/tiles.ts)

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { OpenLinkoClient } from '../dist/client.js';
import { baseUrl } from '../dist/config.js';
import { isShortMapsLink, parseLatLng } from '../dist/geo.js';
import { TILE_USER_AGENT } from '../dist/settings.js';
import { OSM_TILE_URL, TileError, TileFetcher, validTileUrl } from '../dist/tiles.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

function client(conn) {
  return new OpenLinkoClient(baseUrl(conn ?? {}), conn?.password || undefined, quiet);
}

function reason(e) {
  const msg = e instanceof Error ? e.message : String(e);
  const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : '';
  if (/ECONNREFUSED/.test(cause)) {
    return 'connection refused: nothing is listening on that IP and port';
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(cause)) {
    return 'that host name could not be found';
  }
  if (/timed? ?out|TimeoutError|aborted/i.test(msg + cause)) {
    return 'no answer (timed out): check the IP, the port and that OpenLinko is running';
  }
  return cause ? `${msg} (${cause})` : msg;
}

class OpenLinkoUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();
    const cacheRoot = join(this.homebridgeStoragePath || tmpdir(), 'homebridge-openlinko', 'tiles');
    const fetchers = new Map();
    const fetcherFor = (url) => {
      const u = validTileUrl(url || OSM_TILE_URL);
      if (!u) {
        throw new RequestError('the map tile URL must be https and contain {z}, {x} and {y}', { status: 400 });
      }
      if (!fetchers.has(u)) {
        fetchers.set(u, new TileFetcher({ dir: cacheRoot, userAgent: TILE_USER_AGENT, url: u }));
      }
      return fetchers.get(u);
    };

    // One map tile the page is showing, as a data URL (the page's own requests can't reach OSM).
    this.onRequest('/tile', async ({ z, x, y, url } = {}) => {
      try {
        const png = await fetcherFor(url).get(Number(z), Number(x), Number(y));
        return { ok: true, data: png.toString('base64') };
      } catch (e) {
        if (e instanceof RequestError) {
          throw e;
        }
        return { ok: false, error: e instanceof TileError || e instanceof RangeError ? e.message : reason(e) };
      }
    });

    // "Test connection": the same calls the plugin makes at startup.
    this.onRequest('/test', async (conn) => {
      const url = baseUrl(conn ?? {});
      try {
        const c = client(conn);
        const [summary, caps] = await Promise.all([c.summary(), c.caps().catch(() => null)]);
        const loc = await c.location().catch(() => undefined);
        return {
          ok: true,
          url,
          model: summary.vehicle?.model ?? null,
          battery: summary.battery ?? null,
          online: summary.online ?? null,
          ageMin: summary.age_min ?? null,
          controls: caps ? Object.entries(caps).filter(([, v]) => v === true || (v && typeof v === 'object' && Object.values(v).some((x) => x === true))).map(([k]) => k) : [],
          location: loc === null ? 'missing' : loc?.enabled ? 'on' : loc ? 'off' : 'unknown',
        };
      } catch (e) {
        return { ok: false, url, error: reason(e) };
      }
    });

    // "Use the car's current location".
    this.onRequest('/car-location', async (conn) => {
      try {
        const loc = await client(conn).location();
        if (loc === null) {
          return { ok: false, error: 'this OpenLinko has no car location feature (/api/location)' };
        }
        if (!loc.enabled) {
          return { ok: false, error: 'car location is off in OpenLinko: set "location": true in its creds.json' };
        }
        if (typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
          return { ok: false, error: 'OpenLinko has no position for the car yet' };
        }
        return { ok: true, lat: loc.lat, lng: loc.lng, ageS: loc.age_s ?? null, moving: !!loc.moving };
      } catch (e) {
        return { ok: false, error: reason(e) };
      }
    });

    // Paste box: coordinates, Google/Apple Maps links, geo: URIs, DMS text. Parsed locally only:
    // nothing is fetched. Short share links hide the coordinates behind a redirect, so the user is
    // asked to open the link and paste the full address instead of us requesting it.
    this.onRequest('/parse', async ({ text } = {}) => {
      const t = String(text ?? '').trim().slice(0, 4000);
      const hit = parseLatLng(t);
      if (hit) {
        return { ok: true, ...hit };
      }
      if (isShortMapsLink(t)) {
        return { ok: false, error: 'short share links hide the coordinates. Open the link in your browser, then copy the full address from the address bar (or the coordinates) and paste that' };
      }
      return { ok: false, error: 'no coordinates found in that text' };
    });

    this.ready();
  }
}

(() => new OpenLinkoUiServer())();
