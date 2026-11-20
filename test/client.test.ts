import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenLinkoClient, parseSseData } from '../src/client.js';
import type { Summary } from '../src/state.js';

const quiet = { info() {}, warn() {}, error() {}, debug() {} };

/** A tiny stand-in for OpenLinko's server: optional password gate, summary, stream, control. */
function fakeOpenLinko(opts: { password?: string } = {}) {
  const sent: string[] = [];
  const streams: ServerResponse[] = [];
  const authed = (req: IncomingMessage) => !opts.password || (req.headers.cookie ?? '').includes('sid=good');
  const server = createServer((req, res) => {
    const json = (code: number, body: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(code, { 'Content-Type': 'application/json', ...extra });
      res.end(JSON.stringify(body));
    };
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/api/unlock') {
        const ok = JSON.parse(body).password === opts.password;
        return json(200, ok ? { ok: true } : { ok: false, error: 'Wrong password.' },
          ok ? { 'Set-Cookie': 'sid=good; HttpOnly; Path=/' } : {});
      }
      if (!authed(req)) {
        return json(401, { error: 'auth' });
      }
      if (req.url === '/api/summary') {
        return json(200, { battery: 55, unlocked: false });
      }
      if (req.url === '/api/stream') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('retry: 3000\n\n');
        res.write(`data: ${JSON.stringify({ battery: 56, unlocked: true })}\n\n`);
        streams.push(res);
        return;
      }
      if (req.url === '/api/control') {
        sent.push(JSON.parse(body).data);
        return json(200, { ok: true, confirmed: true, code: '0000', result: '00' });
      }
      json(404, {});
    });
  });
  return new Promise<{ url: string; sent: string[]; streams: ServerResponse[]; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}/`, sent, streams,
        close: () => {
          streams.forEach((s) => s.destroy());
          server.closeAllConnections();
          server.close();
        },
      });
    });
  });
}

test('parseSseData', () => {
  assert.equal(parseSseData('retry: 3000'), null);
  assert.equal(parseSseData(': ping'), null);
  assert.equal(parseSseData('data: {"a":1}'), '{"a":1}');
  assert.equal(parseSseData('data: a\ndata: b'), 'a\nb');
});

test('summary + control on an open dashboard', async () => {
  const f = await fakeOpenLinko();
  try {
    const c = new OpenLinkoClient(f.url, undefined, quiet);
    assert.equal((await c.summary()).battery, 55);
    const r = await c.control('740100');
    assert.equal(r.confirmed, true);
    assert.deepEqual(f.sent, ['740100']);
    await assert.rejects(c.control('740700'), /not allowed/);   // engine start never goes out
    assert.deepEqual(f.sent, ['740100']);
  } finally {
    f.close();
  }
});

test('password-gated dashboard: 401 -> unlock -> retry', async () => {
  const f = await fakeOpenLinko({ password: 'pw' });
  try {
    assert.equal((await new OpenLinkoClient(f.url, 'pw', quiet).summary()).battery, 55);
    await assert.rejects(new OpenLinkoClient(f.url, 'nope', quiet).summary(), /password rejected/);
    await assert.rejects(new OpenLinkoClient(f.url, undefined, quiet).summary(), /password-protected/);
  } finally {
    f.close();
  }
});

test('stream delivers summaries, and pushes after the first', async () => {
  const f = await fakeOpenLinko();
  const c = new OpenLinkoClient(f.url, undefined, quiet);
  try {
    const got: Summary[] = [];
    const two = new Promise<void>((resolve) => c.on('summary', (s: Summary) => {
      got.push(s);
      if (got.length === 1) {
        f.streams[0].write(': ping\n\n');
        // split one event across two chunks, like a real TCP stream may
        f.streams[0].write('data: {"battery":');
        setTimeout(() => f.streams[0].write('57}\n\n'), 20);
      }
      if (got.length === 2) {
        resolve();
      }
    }));
    c.start();
    await two;
    assert.equal(c.connected, true);
    assert.deepEqual(got.map((s) => s.battery), [56, 57]);
  } finally {
    c.stop();
    f.close();
  }
});

test('commands are serialised and spaced', async () => {
  const f = await fakeOpenLinko();
  try {
    const c = new OpenLinkoClient(f.url, undefined, quiet);
    const t0 = Date.now();
    await Promise.all([c.control('740100'), c.control('740200')]);
    assert.deepEqual(f.sent, ['740100', '740200']);
    assert.ok(Date.now() - t0 >= 2900, 'second command waited the 3 s gap');
  } finally {
    f.close();
  }
});

test('per-tile slots: duplicates are not re-sent; a queued command is replaced by a newer one', async () => {
  const f = await fakeOpenLinko();
  try {
    const c = new OpenLinkoClient(f.url, undefined, quiet);
    // the liftgate test run: open, open again (Home re-send), then close before open went out
    const first = c.control('740100', 'lock');          // occupies the queue (another tile)
    const open1 = c.control('740300', 'liftgate');
    const open2 = c.control('740300', 'liftgate');      // duplicate -> same promise
    assert.equal(open1, open2);
    const close = c.control('740A00', 'liftgate');      // open hasn't gone out yet -> replaced
    assert.equal(close, open1);
    await Promise.all([first, close]);
    assert.deepEqual(f.sent, ['740100', '740A00']);
    // once a command is on its way, a different one for the same tile queues behind it
    const a = c.control('740500', 'windows');
    await new Promise((r) => setTimeout(r, 3100));      // let it start (3 s gap after the last send)
    const b = c.control('740600', 'windows');
    assert.notEqual(a, b);
    await Promise.all([a, b]);
    assert.deepEqual(f.sent, ['740100', '740A00', '740500', '740600']);
    // temperature and A/C power use separate slots, so neither replaces the other
    const on = c.control('741001', 'climate');
    const temp = c.control('7411AC', 'climate-temp');
    await Promise.all([on, temp]);
    assert.deepEqual(f.sent.slice(-2), ['741001', '7411AC']);
  } finally {
    f.close();
  }
});
