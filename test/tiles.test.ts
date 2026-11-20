import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TTL_MS, TileFetcher, expiryFrom, validTile, validTileUrl } from '../src/tiles.js';

const PNG = Buffer.alloc(1000, 7);
const UA = 'homebridge-openlinko/0.0.0 (+https://example.invalid/repo)';

type Reply = { status?: number; headers?: Record<string, string | undefined>; body?: Buffer | string };

function fakeServer(reply: (req: { url: string; headers: Headers }) => Reply, delayMs = 1) {
  const calls: { url: string; headers: Headers }[] = [];
  let active = 0;
  let maxActive = 0;
  const impl = (async (url: string, init?: RequestInit) => {
    const req = { url, headers: new Headers(init?.headers) };
    calls.push(req);
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, delayMs));
    active--;
    const r = reply(req);
    const status = r.status ?? 200;
    return new Response(status === 304 ? null : (r.body ?? PNG), {
      status,
      headers: Object.fromEntries(Object.entries({ 'content-type': 'image/png', ...(r.headers ?? {}) })
        .filter((kv): kv is [string, string] => typeof kv[1] === 'string')),
    });
  }) as unknown as typeof fetch;
  return { impl, calls, max: () => maxActive };
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'ol-tiles-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const settle = () => new Promise((r) => setTimeout(r, 30));   // disk writes are async

test('validTile and validTileUrl', () => {
  assert.deepEqual(validTile(16, 52064, 31784), { z: 16, x: 52064, y: 31784 });
  assert.equal(validTile(3, 8, 0), null);
  assert.equal(validTile(20, 0, 0), null);
  assert.equal(validTile('../etc', 0, 0), null);
  assert.equal(validTileUrl('https://tile.openstreetmap.org/{z}/{x}/{y}.png'), 'https://tile.openstreetmap.org/{z}/{x}/{y}.png');
  assert.equal(validTileUrl('http://tile.openstreetmap.org/{z}/{x}/{y}.png'), null);   // https only
  assert.equal(validTileUrl('https://tiles.example/{z}/{x}.png'), null);              // missing {y}
  assert.equal(validTileUrl('file:///etc/{z}{x}{y}'), null);
});

test('expiryFrom follows the caching headers', () => {
  const now = 1_000_000;
  assert.equal(expiryFrom(new Headers({ 'cache-control': 'max-age=3600' }), now), now + 3600_000);
  assert.equal(expiryFrom(new Headers({ 'cache-control': 'public, max-age=3600', age: '600' }), now), now + 3000_000);
  assert.equal(expiryFrom(new Headers({ 'cache-control': 'max-age=60', expires: 'Wed, 01 Jan 2031 00:00:00 GMT' }), now), now + 60_000);
  assert.equal(expiryFrom(new Headers({ expires: 'Wed, 01 Jan 2031 00:00:00 GMT' }), now), Date.parse('2031-01-01T00:00:00Z'));
  assert.equal(expiryFrom(new Headers({ expires: 'garbage' }), now), now);
  assert.equal(expiryFrom(new Headers({ 'cache-control': 'no-cache' }), now), now);
  assert.equal(expiryFrom(new Headers({ 'cache-control': 'no-store' }), now), null);
  assert.equal(expiryFrom(new Headers({}), now), now + DEFAULT_TTL_MS);       // the 7-day floor
});

test('requires a real User-Agent; sends it and no no-cache headers', async () => {
  assert.throws(() => new TileFetcher({ dir: '/tmp/x', userAgent: '' }), /User-Agent/);
  assert.throws(() => new TileFetcher({ dir: '/tmp/x', userAgent: UA, url: 'http://x/{z}/{x}/{y}' }), /https/);
  await withDir(async (dir) => {
    const s = fakeServer(() => ({ headers: { 'cache-control': 'max-age=86400' } }));
    const t = new TileFetcher({ dir, userAgent: UA, fetchImpl: s.impl });
    await t.get(5, 10, 12);
    const h = s.calls[0].headers;
    assert.equal(s.calls[0].url, 'https://tile.openstreetmap.org/5/10/12.png');
    assert.equal(h.get('user-agent'), UA);
    assert.equal(h.get('cache-control'), null);
    assert.equal(h.get('pragma'), null);
  });
});

test('fresh tiles come from cache (memory, then disk in a new session)', async () => {
  await withDir(async (dir) => {
    const s = fakeServer(() => ({ headers: { 'cache-control': 'max-age=86400' } }));
    const t = new TileFetcher({ dir, userAgent: UA, fetchImpl: s.impl });
    assert.deepEqual(await t.get(5, 10, 12), PNG);
    assert.deepEqual(await t.get(5, 10, 12), PNG);
    assert.equal(s.calls.length, 1);
    await settle();
    const s2 = fakeServer(() => ({}));
    assert.deepEqual(await new TileFetcher({ dir, userAgent: UA, fetchImpl: s2.impl }).get(5, 10, 12), PNG);
    assert.equal(s2.calls.length, 0);
  });
});

test('an expired tile is revalidated conditionally; 304 reuses the copy', async () => {
  await withDir(async (dir) => {
    let now = 0;
    const s = fakeServer((req) => req.headers.get('if-none-match') === '"v1"'
      ? { status: 304, headers: { 'cache-control': 'max-age=100' } }
      : { headers: { 'cache-control': 'max-age=100', etag: '"v1"', 'last-modified': 'Tue, 01 Jan 2030 00:00:00 GMT' } });
    const t = new TileFetcher({ dir, userAgent: UA, fetchImpl: s.impl, now: () => now });
    await t.get(7, 1, 1);
    now = 50_000;
    await t.get(7, 1, 1);                          // still fresh: no request
    assert.equal(s.calls.length, 1);
    now = 101_000;
    assert.deepEqual(await t.get(7, 1, 1), PNG);   // expired: conditional request, 304
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1].headers.get('if-none-match'), '"v1"');
    assert.equal(s.calls[1].headers.get('if-modified-since'), 'Tue, 01 Jan 2030 00:00:00 GMT');
    now = 150_000;
    await t.get(7, 1, 1);                          // the 304 renewed it for another 100 s
    assert.equal(s.calls.length, 2);
  });
});

test('no-store is never written to disk; no-cache revalidates every time', async () => {
  await withDir(async (dir) => {
    const s = fakeServer((req) => req.url.endsWith('/1/1/1.png') ? { headers: { 'cache-control': 'no-store' } } : { headers: { 'cache-control': 'no-cache', etag: '"e"' } });
    const t = new TileFetcher({ dir, userAgent: UA, fetchImpl: s.impl });
    await t.get(1, 1, 1);
    await settle();
    assert.deepEqual(await readdir(dir).catch(() => []), []);
    await t.get(2, 1, 1);
    await t.get(2, 1, 1);
    assert.equal(s.calls.filter((c) => c.url.endsWith('/2/1/1.png')).length, 2);
    assert.equal(s.calls.at(-1)?.headers.get('if-none-match'), '"e"');
  });
});

test('blocked placeholders and errors are never cached', async () => {
  await withDir(async (dir) => {
    const s = fakeServer((req) => req.url.includes('/2/') ? { body: Buffer.alloc(103) } : { status: 503, body: 'nope', headers: { 'content-type': 'text/plain' } });
    const t = new TileFetcher({ dir, userAgent: UA, fetchImpl: s.impl });
    await assert.rejects(t.get(2, 1, 1), /blocked placeholder/);
    await assert.rejects(t.get(3, 1, 1), /HTTP 503/);
    await settle();
    assert.deepEqual(await readdir(dir).catch(() => []), []);
  });
});

test('parallel requests are capped and duplicates share one fetch', async () => {
  await withDir(async (dir) => {
    const s = fakeServer(() => ({}), 20);
    const t = new TileFetcher({ dir, userAgent: UA, fetchImpl: s.impl, maxParallel: 2 });
    await Promise.all([0, 1, 2, 3, 4, 5].map((i) => t.get(6, i, 1)).concat([t.get(6, 0, 1), t.get(6, 0, 1)]));
    assert.equal(s.calls.length, 6);
    assert.ok(s.max() <= 2, `max parallel ${s.max()}`);
  });
});

test('budget stops bulk fetching through this endpoint', async () => {
  await withDir(async (dir) => {
    let now = 0;
    const s = fakeServer(() => ({}));
    const t = new TileFetcher({ dir, userAgent: UA, fetchImpl: s.impl, budget: { fetches: 3, perMs: 60_000 }, now: () => now });
    for (let i = 0; i < 3; i++) {
      await t.get(10, i, 0);
    }
    await assert.rejects(t.get(10, 9, 0), /limit reached/);
    await t.get(10, 0, 0);                         // cached tiles still work
    now = 61_000;
    await t.get(10, 9, 0);                         // the window moved on
    assert.equal(s.calls.length, 4);
  });
});

test('prune keeps the newest maxFiles tiles (with their metadata)', async () => {
  await withDir(async (dir) => {
    const t = new TileFetcher({ dir, userAgent: UA, maxFiles: 2 });
    const sub = (t as unknown as { dir: string }).dir;
    await import('node:fs/promises').then((fs) => fs.mkdir(sub, { recursive: true }));
    for (let i = 0; i < 5; i++) {
      await writeFile(join(sub, `3-${i}-0.png`), PNG);
      await writeFile(join(sub, `3-${i}-0.json`), '{"expires":0}');
      const when = new Date(Date.now() - (10 - i) * 1000);
      await utimes(join(sub, `3-${i}-0.png`), when, when);
    }
    await t.prune();
    assert.deepEqual((await readdir(sub)).sort(), ['3-3-0.json', '3-3-0.png', '3-4-0.json', '3-4-0.png']);
  });
});

// The exact caching headers tile.openstreetmap.org returned on 2026-11-20.
const OSM_HEADERS = {
  'cache-control': 'max-age=25394, stale-while-revalidate=604800, stale-if-error=604800',
  age: '100194',
  etag: '"7c3e39dd1edd60d9480850bf45936f6b"',
};

test('cacheWindows on real OSM headers: stale on arrival, but 6+ days of stale-while-revalidate', async () => {
  const { cacheWindows } = await import('../src/tiles.js');
  const now = 1_000_000_000;
  const w = cacheWindows(new Headers(OSM_HEADERS), now);
  assert.ok(w);
  assert.equal(w.expires, now - (100194 - 25394) * 1000);           // already stale
  assert.equal(w.swrUntil, w.expires + 604800_000);                  // RFC 5861: counted from staleness
  assert.ok((w.swrUntil - now) / 86400_000 > 6);
  const strict = cacheWindows(new Headers({ 'cache-control': 'max-age=60, must-revalidate, stale-while-revalidate=99' }), now);
  assert.equal(strict?.swrUntil, now + 60_000);                       // must-revalidate disables stale use
  assert.equal(strict?.sieUntil, now + 60_000);
});

test('stale-while-revalidate: stale tile shown at once, one background conditional re-check', async () => {
  await withDir(async (dir) => {
    let now = 1_000_000_000;
    const s = fakeServer((req) => req.headers.get('if-none-match') ? { status: 304, headers: OSM_HEADERS } : { headers: OSM_HEADERS }, 30);
    const t = new TileFetcher({ dir, userAgent: UA, fetchImpl: s.impl, now: () => now });
    await t.get(8, 10, 10);                                          // first view: download
    assert.equal(s.calls.length, 1);
    now += 60_000;
    await t.get(8, 10, 10);                                          // 1 min later: just downloaded,
    await new Promise((r) => setTimeout(r, 60));                     // so no re-check yet
    assert.equal(s.calls.length, 1);
    now += 10 * 60_000;
    const t0 = Date.now();
    assert.deepEqual(await t.get(8, 10, 10), PNG);                  // stale but within SWR
    assert.ok(Date.now() - t0 < 25, 'served without waiting for the network');
    await Promise.all([t.get(8, 10, 10), t.get(8, 10, 10)]);        // no extra re-checks while one runs
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(s.calls.length, 2);
    assert.equal(s.calls[1].headers.get('if-none-match'), OSM_HEADERS.etag);
    now += 5 * 60_000;                                               // viewed again 5 min later
    await t.get(8, 10, 10);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(s.calls.length, 2, 'no re-check within 10 minutes');
    now += 6 * 60_000;
    await t.get(8, 10, 10);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(s.calls.length, 3, 're-checked again after 10 minutes');
    // a new settings-page session (new process) right after: the gap holds, read from disk
    await new Promise((r) => setTimeout(r, 30));
    now += 60_000;
    const s2 = fakeServer(() => ({ headers: OSM_HEADERS }));
    await new TileFetcher({ dir, userAgent: UA, fetchImpl: s2.impl, now: () => now }).get(8, 10, 10);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(s2.calls.length, 0, 'no re-check from a new session within 10 minutes');
  });
});

test('stale-if-error keeps the old tile when the server fails; past the window it errors', async () => {
  await withDir(async (dir) => {
    let now = 1_000_000_000;
    let fail = false;
    const s = fakeServer(() => fail
      ? { status: 503, body: 'down', headers: { 'content-type': 'text/plain' } }
      : { headers: { 'cache-control': 'max-age=10, stale-if-error=100' } });
    const t = new TileFetcher({ dir, userAgent: UA, fetchImpl: s.impl, now: () => now });
    await t.get(9, 1, 1);
    fail = true;
    now += 50_000;                                                   // stale, inside stale-if-error
    assert.deepEqual(await t.get(9, 1, 1), PNG);
    now += 100_000;                                                  // past it
    await assert.rejects(t.get(9, 1, 1), /HTTP 503/);
  });
});
