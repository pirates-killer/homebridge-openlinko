import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseUrl } from '../src/config.js';
import { isShortMapsLink, parseLatLng } from '../src/geo.js';

test('baseUrl from host/port/https', () => {
  assert.equal(baseUrl({}), 'http://127.0.0.1:8088');
  assert.equal(baseUrl({ host: '192.168.1.50', port: 8088 }), 'http://192.168.1.50:8088');
  assert.equal(baseUrl({ host: '192.168.1.50', port: '8090' }), 'http://192.168.1.50:8090');
  assert.equal(baseUrl({ host: 'pi.local', port: 443, https: true }), 'https://pi.local:443');
  assert.equal(baseUrl({ host: ' 10.0.0.5 ' }), 'http://10.0.0.5:8088');
  assert.equal(baseUrl({ host: 'fd7a::1', port: 8088 }), 'http://[fd7a::1]:8088');
  assert.equal(baseUrl({ host: '1.2.3.4', port: 70000 }), 'http://1.2.3.4:8088');   // invalid port -> default
});

test('baseUrl forgives pasting a URL or host:port into the host box', () => {
  assert.equal(baseUrl({ host: 'http://192.168.1.50:8090/' }), 'http://192.168.1.50:8090');
  assert.equal(baseUrl({ host: 'https://car.example.com' }), 'https://car.example.com:8088');
  assert.equal(baseUrl({ host: '192.168.1.50:8090' }), 'http://192.168.1.50:8090');
  assert.equal(baseUrl({ host: '192.168.1.50:8090', port: 9000 }), 'http://192.168.1.50:9000');  // explicit port wins
  assert.equal(baseUrl({ host: '192.168.1.50/api' }), 'http://192.168.1.50:8088');
});

test('baseUrl falls back to the legacy url setting', () => {
  assert.equal(baseUrl({ url: 'http://10.1.1.1:8088/' }), 'http://10.1.1.1:8088');
  assert.equal(baseUrl({ url: 'http://10.1.1.1:8088', host: '10.2.2.2' }), 'http://10.2.2.2:8088');
});

test('parseLatLng: plain coordinates', () => {
  assert.deepEqual(parseLatLng('3.1579, 101.7116'), { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('3.1579,101.7116'), { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('3.1579 101.7116'), { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('(-33.8568, 151.2153)'), { lat: -33.8568, lng: 151.2153 });
  assert.deepEqual(parseLatLng('51.50101, -0.14159'), { lat: 51.50101, lng: -0.14159 });
  assert.deepEqual(parseLatLng('3.15791234567, 101.71161234567'), { lat: 3.157912, lng: 101.711612 });
});

test('parseLatLng: hemispheres and degrees-minutes-seconds', () => {
  assert.deepEqual(parseLatLng('3.1579° N, 101.7116° E'), { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('33.8568° S 151.2153° E'), { lat: -33.8568, lng: 151.2153 });
  const d = parseLatLng('3°09\'28.4"N 101°42\'41.8"E');
  assert.ok(d && Math.abs(d.lat - 3.157889) < 1e-5 && Math.abs(d.lng - 101.711611) < 1e-5);
  const w = parseLatLng('51°30\'03.6"N 0°08\'29.7"W');
  assert.ok(w && w.lng < 0 && Math.abs(w.lat - 51.501) < 1e-3);
});

test('parseLatLng: map links', () => {
  // Google place link: the pin (!3d!4d) wins over the map view (@)
  assert.deepEqual(parseLatLng('https://www.google.com/maps/place/KLCC/@3.15,101.70,17z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d3.1579!4d101.7116'),
    { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('https://www.google.com/maps/@3.1579,101.7116,15z'), { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('https://maps.google.com/?q=3.1579,101.7116'), { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('https://www.google.com/maps/search/?api=1&query=3.1579%2C101.7116'), { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('https://maps.apple.com/?ll=3.1579,101.7116&q=Home'), { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('https://maps.apple.com/place?coordinate=3.1579,101.7116'), { lat: 3.1579, lng: 101.7116 });
  assert.deepEqual(parseLatLng('geo:3.1579,101.7116?z=17'), { lat: 3.1579, lng: 101.7116 });
});

test('parseLatLng: rejects nonsense', () => {
  assert.equal(parseLatLng(''), null);
  assert.equal(parseLatLng('hello world'), null);
  assert.equal(parseLatLng('0, 0'), null);
  assert.equal(parseLatLng('95, 100'), null);
  assert.equal(parseLatLng('45, 200'), null);
  assert.equal(parseLatLng('https://example.com/item/12/34'), null);
  assert.equal(parseLatLng('call me at 3.1579, 101.7116 tomorrow'), null);   // not only coordinates
});

test('isShortMapsLink', () => {
  assert.ok(isShortMapsLink('https://maps.app.goo.gl/AbCdEf123'));
  assert.ok(isShortMapsLink('https://goo.gl/maps/xyz'));
  assert.ok(!isShortMapsLink('https://www.google.com/maps/@3,101,15z'));
});
