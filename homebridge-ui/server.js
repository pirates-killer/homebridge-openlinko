// Backend of the plugin's settings page. Runs inside the Homebridge UI (admin login required),
// never inside the bridge. Same rule as the plugin: it only ever talks to OpenLinko -- plus, when you
// paste a short Google Maps share link, one request to Google to read where that link points.

import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { OpenLinkoClient } from '../dist/client.js';
import { baseUrl } from '../dist/config.js';
import { isShortMapsLink, parseLatLng } from '../dist/geo.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const SHORT_LINK_HOSTS = /(^|\.)(goo\.gl|google\.[a-z.]+)$/i;

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

/** Follow a short share link (up to 4 redirects) and return the coordinates it points at. */
async function resolveShortLink(link) {
  let url = link;
  for (let hop = 0; hop < 4; hop++) {
    const host = new URL(url).hostname;
    if (!SHORT_LINK_HOSTS.test(host)) {
      break;
    }
    const res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(8000) });
    const next = res.headers.get('location');
    if (next) {
      await res.body?.cancel();
      url = new URL(next, url).toString();
      const hit = parseLatLng(url);
      if (hit) {
        return hit;
      }
      continue;
    }
    const body = (await res.text()).slice(0, 200_000);   // some pages redirect in HTML instead
    return parseLatLng(url) ?? parseLatLng((/!3d-?[\d.]+!4d-?[\d.]+/.exec(body) ?? [''])[0])
      ?? parseLatLng((/@-?[\d.]+,-?[\d.]+/.exec(body) ?? [''])[0]);
  }
  return parseLatLng(url);
}

class OpenLinkoUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

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

    // Paste box: coordinates, Google/Apple Maps links, geo: URIs, DMS text.
    this.onRequest('/parse', async ({ text } = {}) => {
      const t = String(text ?? '').trim().slice(0, 4000);
      try {
        const hit = isShortMapsLink(t) ? await resolveShortLink(t) : parseLatLng(t);
        if (hit) {
          return { ok: true, ...hit };
        }
        return { ok: false, error: 'no coordinates found in that text' };
      } catch (e) {
        throw new RequestError(`could not read that link: ${reason(e)}`, { status: 400 });
      }
    });

    this.ready();
  }
}

(() => new OpenLinkoUiServer())();
