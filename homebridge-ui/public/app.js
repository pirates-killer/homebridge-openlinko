/* global L */
// Settings page: connection + home-location map. Everything else (tiles, names) stays in the
// standard schema form, which Homebridge draws below this page.

(() => {
  const hb = window.homebridge;
  const $ = (id) => document.getElementById(id);
  const DEFAULT = { platform: 'OpenLinko', name: 'OpenLinko' };
  const RADIUS = { min: 50, max: 5000, dflt: 150 };

  let map = null;
  let pin = null;
  let circle = null;
  let car = null;

  // ---- config ----

  async function current() {
    const blocks = await hb.getPluginConfig();
    return { blocks, cfg: blocks[0] ? { ...blocks[0] } : { ...DEFAULT } };
  }

  /**
   * Read-modify-write against the LIVE config (which includes edits made in the schema form
   * below), then redraw that form so it holds the same object and can't write back a stale copy.
   */
  async function patch(fn) {
    const { blocks, cfg } = await current();
    fn(cfg);
    await hb.updatePluginConfig([cfg, ...blocks.slice(1)]);
    hb.hideSchemaForm();
    hb.showSchemaForm();
    return cfg;
  }

  function connFromFields() {
    return {
      host: $('ol-host').value.trim() || undefined,
      port: $('ol-port').value ? Number($('ol-port').value) : undefined,
      https: $('ol-https').checked,
      password: $('ol-password').value || undefined,
    };
  }

  function say(el, text, kind) {
    text = String(text);
    el.textContent = text.charAt(0).toUpperCase() + text.slice(1);
    el.className = 'ol-result' + (kind ? ' ' + kind : '');
    hb.fixScrollHeight();
  }

  // ---- connection card ----

  async function saveConnection() {
    const port = Number($('ol-port').value);
    if ($('ol-port').value && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      say($('ol-test-result'), 'Port must be a number from 1 to 65535.', 'bad');
      return;
    }
    await patch((c) => {
      const conn = connFromFields();
      for (const k of ['host', 'port', 'https', 'password']) {
        if (conn[k] === undefined || conn[k] === false) {
          delete c[k];
        } else {
          c[k] = conn[k];
        }
      }
      delete c.url;                                // replaced by host/port/https
    });
    say($('ol-test-result'), '');                   // an old error or result no longer applies
  }

  async function testConnection() {
    const out = $('ol-test-result');
    say(out, 'Connecting…');
    $('ol-test').disabled = true;
    try {
      const r = await hb.request('/test', connFromFields());
      if (r.ok) {
        const age = typeof r.ageMin === 'number' ? (r.ageMin < 2 ? 'just now' : `${Math.round(r.ageMin)} min ago`) : '?';
        const loc = { on: 'car location on', off: 'car location off', missing: 'no car location feature', unknown: '' }[r.location] || '';
        say(out, `Connected to ${r.url}: ${r.model || 'car'}, battery ${r.battery ?? '?'}%, last report ${age}`
          + (loc ? `, ${loc}` : '') + '.', 'ok');
        if (r.location === 'on' && !car) {
          showCar(false);
        }
      } else {
        say(out, `Can't reach OpenLinko at ${r.url}: ${r.error}.`, 'bad');
      }
    } catch (e) {
      say(out, `Test failed: ${e.message || e}`, 'bad');
    } finally {
      $('ol-test').disabled = false;
    }
  }

  // ---- home card ----

  function radius() {
    const r = Number($('ol-radius').value);
    return Number.isFinite(r) ? Math.min(RADIUS.max, Math.max(RADIUS.min, Math.round(r))) : RADIUS.dflt;
  }

  function drawHome(lat, lng, pan) {
    const ll = [lat, lng];
    if (!pin) {
      pin = L.marker(ll, { draggable: true, icon: L.divIcon({ className: 'ol-pin', iconSize: [20, 20] }), title: 'Home' }).addTo(map);
      pin.on('dragend', () => {
        const p = pin.getLatLng();
        setHome(p.lat, p.lng, false);
      });
      circle = L.circle(ll, { radius: radius(), color: '#e5383b', weight: 2, fillOpacity: 0.12 }).addTo(map);
    } else {
      pin.setLatLng(ll);
      circle.setLatLng(ll);
    }
    circle.setRadius(radius());
    if (pan) {
      map.fitBounds(circle.getBounds(), { padding: [30, 30], maxZoom: 17, animate: false });
    }
  }

  async function setHome(lat, lng, pan, note) {
    lat = Math.round(lat * 1e6) / 1e6;
    lng = Math.round(lng * 1e6) / 1e6;
    $('ol-lat').value = lat;
    $('ol-lng').value = lng;
    $('ol-home-on').checked = true;
    $('ol-map').classList.remove('ol-off');
    drawHome(lat, lng, pan);
    await patch((c) => {
      c.home = { ...(c.home || {}), enabled: true, lat, lng, radius: radius() };
    });
    say($('ol-home-result'), note || `Home set to ${lat}, ${lng} (radius ${radius()} m).`, 'ok');
  }

  async function showCar(useAsHome) {
    const out = $('ol-home-result');
    if (useAsHome) {
      say(out, 'Asking OpenLinko where the car is…');
    }
    try {
      const r = await hb.request('/car-location', connFromFields());
      if (!r.ok) {
        if (useAsHome) {
          say(out, r.error + '.', 'bad');
        }
        return;
      }
      const ll = [r.lat, r.lng];
      if (!car) {
        car = L.marker(ll, { icon: L.divIcon({ className: 'ol-car', iconSize: [14, 14] }), title: 'Car (now)', interactive: false }).addTo(map);
      } else {
        car.setLatLng(ll);
      }
      if (useAsHome) {
        const age = typeof r.ageS === 'number' ? ` (position from ${Math.max(1, Math.round(r.ageS / 60))} min ago)` : '';
        await setHome(r.lat, r.lng, true, `Home set to where the car is${age}: ${r.lat}, ${r.lng}.`
          + (r.moving ? ' Note: the car is moving.' : ''));
      } else if (!pin) {
        map.setView(ll, 16, { animate: false });
      }
    } catch (e) {
      if (useAsHome) {
        say(out, `Couldn't get the car's location: ${e.message || e}`, 'bad');
      }
    }
  }

  async function usePasted() {
    const text = $('ol-paste').value.trim();
    const out = $('ol-home-result');
    if (!text) {
      say(out, 'Paste coordinates or a maps link first.', 'bad');
      return;
    }
    say(out, 'Reading…');
    try {
      const r = await hb.request('/parse', { text });
      if (r.ok) {
        $('ol-paste').value = '';
        await setHome(r.lat, r.lng, true);
      } else {
        say(out, `${r.error}. Try "lat, lng", e.g. 3.1579, 101.7116.`, 'bad');
      }
    } catch (e) {
      say(out, e.message || String(e), 'bad');
    }
  }

  async function typedCoords() {
    const lat = Number($('ol-lat').value);
    const lng = Number($('ol-lng').value);
    if ($('ol-lat').value === '' || $('ol-lng').value === '') {
      return;
    }
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      say($('ol-home-result'), 'Latitude must be -90 to 90 and longitude -180 to 180.', 'bad');
      return;
    }
    await setHome(lat, lng, true);
  }

  async function toggleHome() {
    const on = $('ol-home-on').checked;
    $('ol-map').classList.toggle('ol-off', !on);
    await patch((c) => {
      c.home = { ...(c.home || {}), enabled: on };
    });
    if (on && !pin) {
      say($('ol-home-result'), 'Now set the location: click the map, paste coordinates, or use the car\'s location.');
    } else {
      say($('ol-home-result'), on ? 'Car Home sensor on.' : 'Car Home sensor off (location kept).');
    }
  }

  async function radiusChanged() {
    $('ol-radius').value = radius();
    if (circle) {
      circle.setRadius(radius());
    }
    await patch((c) => {
      c.home = { ...(c.home || {}), radius: radius() };
    });
  }

  // ---- map tiles ----
  // Tiles come through the settings backend (see src/tiles.ts for why and for the OSM tile policy
  // it follows). Attribution stays visible on the map, bottom-right, as the policy requires.

  const OSM_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
    + ' | <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noopener">Report a map issue</a>';
  let tileNoteShown = false;

  function escapeHtml(t) {
    return String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function tileFailed(why) {
    if (tileNoteShown) {
      return;
    }
    tileNoteShown = true;
    say($('ol-map-note'), `The map background couldn't load (${why}). Setting home still works: click the map, paste coordinates, or use the car's location.`, 'bad');
  }

  function tileLayer(cfg) {
    const custom = typeof cfg.mapTileUrl === 'string' && cfg.mapTileUrl.trim() ? cfg.mapTileUrl.trim() : '';
    const attribution = custom
      ? escapeHtml(cfg.mapAttribution || `Map tiles: ${(() => { try { return new URL(custom.replace(/\{[zxy]\}/g, '0')).hostname; } catch { return 'custom server'; } })()}`)
      : OSM_ATTRIBUTION;
    const Layer = L.TileLayer.extend({
      createTile(coords, done) {
        const img = document.createElement('img');
        img.alt = '';
        img.setAttribute('role', 'presentation');
        hb.request('/tile', { z: coords.z, x: coords.x, y: coords.y, url: custom || undefined }).then((r) => {
          if (r && r.ok) {
            img.onload = () => done(null, img);
            img.onerror = () => done(new Error('bad tile'), img);
            img.src = 'data:image/png;base64,' + r.data;
          } else {
            tileFailed((r && r.error) || 'no tile');
            done(new Error((r && r.error) || 'no tile'), img);
          }
        }, (e) => {
          tileFailed(e.message || String(e));
          done(e, img);
        });
        return img;
      },
    });
    // Only the tiles in view, once panning/zooming settles: no in-between zoom levels, no prefetch.
    return new Layer(custom || OSM_URL, {
      maxZoom: 19,
      attribution,
      updateWhenIdle: true,
      updateWhenZooming: false,
      keepBuffer: 1,
    });
  }

  // ---- start ----

  async function start() {
    const { blocks, cfg } = await current();
    if (!blocks.length) {
      await hb.updatePluginConfig([cfg]);          // first run: create the block so Save works
    }

    // Older configs had one "url": show it as host/port/https.
    let host = cfg.host;
    let port = cfg.port;
    let https = cfg.https === true;
    if (!host && cfg.url) {
      try {
        const u = new URL(cfg.url);
        host = u.hostname.replace(/^\[|\]$/g, '');
        port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
        https = u.protocol === 'https:';
      } catch {
        // leave the defaults
      }
    }
    $('ol-host').value = host || '';
    $('ol-port').value = port || '';
    $('ol-https').checked = https;
    $('ol-password').value = cfg.password || '';

    const home = cfg.home || {};
    $('ol-home-on').checked = home.enabled === true;
    $('ol-radius').value = home.radius || RADIUS.dflt;
    $('ol-map').classList.toggle('ol-off', home.enabled !== true);

    map = L.map('ol-map', { worldCopyJump: true }).setView([20, 100], 3);
    tileLayer(cfg).addTo(map);
    map.on('click', (e) => setHome(e.latlng.lat, e.latlng.lng, false));

    if (typeof home.lat === 'number' && typeof home.lng === 'number') {
      $('ol-lat').value = home.lat;
      $('ol-lng').value = home.lng;
      drawHome(home.lat, home.lng, true);
    }
    void showCar(false);                            // blue dot = car now; centres the map if no home yet

    for (const id of ['ol-host', 'ol-port', 'ol-https', 'ol-password']) {
      $(id).addEventListener('change', () => void saveConnection());
    }
    $('ol-test').addEventListener('click', () => void testConnection());
    $('ol-home-on').addEventListener('change', () => void toggleHome());
    $('ol-paste-go').addEventListener('click', () => void usePasted());
    $('ol-paste').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        void usePasted();
      }
    });
    $('ol-car').addEventListener('click', () => void showCar(true));
    $('ol-lat').addEventListener('change', () => void typedCoords());
    $('ol-lng').addEventListener('change', () => void typedCoords());
    $('ol-radius').addEventListener('change', () => void radiusChanged());

    hb.showSchemaForm();
    setTimeout(() => {
      map.invalidateSize();
      hb.fixScrollHeight();
    }, 200);
  }

  hb.addEventListener('ready', () => {
    start().catch((e) => hb.toast.error(String(e.message || e), 'OpenLinko settings'));
  });
})();
