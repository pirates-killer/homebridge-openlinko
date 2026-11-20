// HTTP client for an OpenLinko dashboard. This is the plugin's only way to the car: it never talks
// to CarLinko itself, so it never opens a second CarLinko session (CarLinko allows one per account)
// and OpenLinko's logger stays the single caller, with its own rate limits and login guard.

import { EventEmitter } from 'node:events';
import type { Caps, ControlResult, Location, Summary } from './state.js';
import { isAllowedOp } from './state.js';

export interface Log {
  info(msg: string, ...a: unknown[]): void;
  warn(msg: string, ...a: unknown[]): void;
  error(msg: string, ...a: unknown[]): void;
  debug(msg: string, ...a: unknown[]): void;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const STREAM_IDLE_MS = 60_000;        // OpenLinko pings every 15 s; 60 s of silence = dead stream
const BACKOFF_MS = [3_000, 6_000, 15_000, 30_000, 60_000];
const CONTROL_GAP_MS = 3_000;         // minimum time between two commands to the car

interface Slot {
  op: string;
  started: boolean;
  promise: Promise<ControlResult>;
}

/**
 * Events:
 *  - 'summary' (Summary): every stream push, and every fallback poll
 *  - 'connected' / 'disconnected'
 */
export class OpenLinkoClient extends EventEmitter {
  private readonly base: string;
  private cookie = '';
  private stopped = false;
  private abort: AbortController | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastControl = 0;
  private readonly slots = new Map<string, Slot>();
  connected = false;

  constructor(url: string, private readonly password: string | undefined, private readonly log: Log) {
    super();
    this.base = url.replace(/\/+$/, '');
  }

  // ---- plain requests ----

  private async request(path: string, init: RequestInit = {}, timeoutMs = 15_000, retried = false): Promise<Response> {
    const headers = new Headers(init.headers);
    if (this.cookie) {
      headers.set('Cookie', this.cookie);
    }
    const res = await fetch(this.base + path, { ...init, headers, signal: init.signal ?? AbortSignal.timeout(timeoutMs) });
    if (res.status === 401 && !retried) {
      await res.body?.cancel();
      await this.unlock();
      return this.request(path, init, timeoutMs, true);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new HttpError(res.status, `${path}: HTTP ${res.status}`);
    }
    return res;
  }

  /** Dashboard password -> session cookie (only when the dashboard is gated). */
  private async unlock(): Promise<void> {
    if (!this.password) {
      throw new HttpError(401, 'the OpenLinko dashboard is password-protected: set "password" in the plugin config');
    }
    const res = await fetch(this.base + '/api/unlock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: this.password }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
    const sid = res.headers.getSetCookie().map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='));
    if (!body.ok || !sid) {
      throw new HttpError(401, `OpenLinko dashboard password rejected${body.error ? ': ' + body.error : ''}`);
    }
    this.cookie = sid;
    this.log.debug('Unlocked the OpenLinko dashboard');
  }

  async summary(): Promise<Summary> {
    return (await (await this.request('/api/summary')).json()) as Summary;
  }

  async caps(): Promise<Caps> {
    const j = (await (await this.request('/api/controls')).json()) as { caps?: Caps; error?: string };
    if (!j.caps) {
      throw new Error(`OpenLinko could not read the car's controls: ${j.error ?? 'no caps'}`);
    }
    return j.caps;
  }

  /** null when this OpenLinko has no location endpoint (a version without the feature). */
  async location(): Promise<Location | null> {
    try {
      return (await (await this.request('/api/location')).json()) as Location;
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) {
        return null;
      }
      throw e;
    }
  }

  /**
   * Send one remote command through OpenLinko. Commands are serialised (the car handles one at a
   * time anyway) and spaced CONTROL_GAP_MS apart. Only opcodes from the plugin's allow-list go out.
   *
   * `slot` names the tile asking (e.g. "liftgate"). Within a slot:
   *  - the same command already queued or on its way is not sent again (Home re-sends targets);
   *  - a command that hasn't gone out yet is replaced by a newer one (open then close: only close
   *    is sent; a dragged temperature slider: only the last value).
   */
  /** True when control(op, slot) would share a command that's already queued or on its way. */
  isQueued(op: string, slot?: string): boolean {
    return !!slot && this.slots.get(slot)?.op === op;
  }

  control(op: string, slot?: string): Promise<ControlResult> {
    if (!isAllowedOp(op)) {
      return Promise.reject(new Error(`opcode ${op} is not allowed by this plugin`));
    }
    if (slot) {
      const s = this.slots.get(slot);
      if (s && s.op === op) {
        return s.promise;
      }
      if (s && !s.started) {
        s.op = op;
        return s.promise;
      }
    }
    const entry: Slot = { op, started: false, promise: Promise.resolve({}) };
    const run = async (): Promise<ControlResult> => {
      const wait = this.lastControl + CONTROL_GAP_MS - Date.now();
      if (wait > 0) {
        await new Promise((r) => setTimeout(r, wait));
      }
      entry.started = true;
      this.lastControl = Date.now();
      // OpenLinko waits up to 20 s for the car, plus CarLinko's own latency.
      const res = await this.request('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: entry.op }),
      }, 45_000);
      return (await res.json()) as ControlResult;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => undefined);
    entry.promise = p;
    if (slot) {
      this.slots.set(slot, entry);
      p.finally(() => {
        if (this.slots.get(slot) === entry) {
          this.slots.delete(slot);
        }
      }).catch(() => undefined);
    }
    return p;
  }

  // ---- live stream ----

  /** Follow /api/stream (server-sent events) forever, reconnecting with backoff. */
  start(): void {
    this.stopped = false;
    void this.streamLoop();
  }

  stop(): void {
    this.stopped = true;
    this.abort?.abort();
  }

  private setConnected(v: boolean): void {
    if (this.connected !== v) {
      this.connected = v;
      this.emit(v ? 'connected' : 'disconnected');
    }
  }

  private async streamLoop(): Promise<void> {
    let attempt = 0;
    while (!this.stopped) {
      try {
        await this.streamOnce(() => {
          attempt = 0;
        });
      } catch (e) {
        if (this.stopped) {
          break;
        }
        const msg = e instanceof Error ? e.message : String(e);
        (attempt === 0 ? this.log.warn : this.log.debug).call(this.log, `OpenLinko stream: ${msg}`);
      }
      this.setConnected(false);
      if (this.stopped) {
        break;
      }
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt++;
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  private async streamOnce(onData: () => void): Promise<void> {
    const ac = new AbortController();
    this.abort = ac;
    let idle: NodeJS.Timeout | undefined;
    const kick = () => {
      clearTimeout(idle);
      idle = setTimeout(() => ac.abort(new Error('no data for 60 s')), STREAM_IDLE_MS);
    };
    kick();
    try {
      const res = await this.request('/api/stream', { signal: ac.signal, headers: { Accept: 'text/event-stream' } });
      if (!res.body) {
        throw new Error('no response body');
      }
      this.setConnected(true);
      const decoder = new TextDecoder();
      let buf = '';
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        kick();
        buf += decoder.decode(chunk, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = parseSseData(event);
          if (data !== null) {
            try {
              this.emit('summary', JSON.parse(data) as Summary);
              onData();
            } catch {
              this.log.debug('OpenLinko stream: skipped a malformed event');
            }
          }
        }
      }
      throw new Error('stream closed');
    } catch (e) {
      // surface "no data for 60 s" rather than a bare AbortError
      const reason: unknown = ac.signal.reason;
      throw ac.signal.aborted && reason instanceof Error && !this.stopped ? reason : e;
    } finally {
      clearTimeout(idle);
    }
  }
}

/** The data payload of one SSE event block, or null for comments/pings/retry lines. */
export function parseSseData(event: string): string | null {
  const lines = event.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  if (lines.length === 0) {
    return null;
  }
  return lines.map((l) => l.slice(5).replace(/^ /, '')).join('\n');
}
