// Turn whatever someone pastes into a home location: "3.1579, 101.7116", a Google Maps or Apple Maps
// link, a geo: URI, or the degrees-minutes-seconds text Google shows when you tap a spot.

export interface LatLng {
  lat: number;
  lng: number;
}

function valid(lat: number, lng: number): LatLng | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    return null;
  }
  if (lat === 0 && lng === 0) {
    return null;
  }
  return { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6 };
}

const NUM = '([-+]?\\d{1,3}(?:\\.\\d+)?)';

/** Degrees-minutes-seconds, e.g. 5°16'52.8"N 100°28'57.8"E. */
function dms(text: string): LatLng | null {
  const part = '(\\d{1,3})\\s*°\\s*(?:(\\d{1,2}(?:\\.\\d+)?)\\s*[\'′]\\s*)?(?:(\\d{1,2}(?:\\.\\d+)?)\\s*(?:"|″|\'\')\\s*)?([NSEW])';
  const m = new RegExp(`${part}[\\s,]+${part}`, 'i').exec(text);
  if (!m) {
    return null;
  }
  const one = (d: string, mi?: string, s?: string, h?: string) => {
    const v = Number(d) + Number(mi || 0) / 60 + Number(s || 0) / 3600;
    return /[SW]/i.test(h ?? '') ? -v : v;
  };
  let a = one(m[1], m[2], m[3], m[4]);
  let b = one(m[5], m[6], m[7], m[8]);
  if (/[EW]/i.test(m[4])) {                                // written longitude first
    [a, b] = [b, a];
  }
  return valid(a, b);
}

/** Decimal degrees with hemisphere letters, e.g. 3.1579° N, 101.7116° E. */
function hemis(text: string): LatLng | null {
  const m = /(\d{1,3}(?:\.\d+)?)\s*°?\s*([NS])[\s,]+(\d{1,3}(?:\.\d+)?)\s*°?\s*([EW])/i.exec(text);
  if (!m) {
    return null;
  }
  return valid(Number(m[1]) * (/S/i.test(m[2]) ? -1 : 1), Number(m[3]) * (/W/i.test(m[4]) ? -1 : 1));
}

export function parseLatLng(input: string): LatLng | null {
  let text = String(input ?? '').trim();
  if (!text) {
    return null;
  }
  try {
    text = decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    // not URL-encoded; use as is
  }

  // Google place links carry the pin itself as !3d<lat>!4d<lng>; "@lat,lng" is only the map view.
  let m = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(text);
  if (m) {
    return valid(Number(m[1]), Number(m[2]));
  }
  // Query parameters used by Google, Apple and others.
  m = new RegExp(`[?&](?:q|query|ll|sll|daddr|destination|coordinate|center)=${NUM}\\s*,\\s*${NUM}`, 'i').exec(text);
  if (m) {
    return valid(Number(m[1]), Number(m[2]));
  }
  m = new RegExp(`geo:${NUM},${NUM}`, 'i').exec(text);
  if (m) {
    return valid(Number(m[1]), Number(m[2]));
  }
  m = new RegExp(`@${NUM},${NUM}`).exec(text);
  if (m) {
    return valid(Number(m[1]), Number(m[2]));
  }
  const d = dms(text) ?? hemis(text);
  if (d) {
    return d;
  }
  // Plain "lat, lng" or "lat lng" -- only when that's all there is, so a random URL with two
  // numbers in it isn't mistaken for a location.
  m = new RegExp(`^\\(?\\s*${NUM}\\s*[,;\\s]\\s*${NUM}\\s*\\)?$`).exec(text);
  if (m) {
    return valid(Number(m[1]), Number(m[2]));
  }
  return null;
}

/** Short share links (maps.app.goo.gl, goo.gl/maps) hide the coordinates behind a redirect. */
export function isShortMapsLink(text: string): boolean {
  return /^https?:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps)\//i.test(String(text ?? '').trim());
}
