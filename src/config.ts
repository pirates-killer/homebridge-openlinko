// Where OpenLinko lives, from the plugin config. Shared by the platform and the settings page.

export interface ConnectionConfig {
  host?: string;
  port?: number | string;
  https?: boolean;
  /** Legacy (0.1.0 drafts): one combined URL. Still honoured when no host is set. */
  url?: string;
}

export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8088;

/**
 * The dashboard's base URL. host/port/https win; a pasted "http://1.2.3.4:8088" in the host box
 * is understood too, so nobody has to know which part goes where.
 */
export function baseUrl(c: ConnectionConfig): string {
  let host = String(c.host ?? '').trim();
  let port = c.port === undefined || c.port === null || c.port === '' ? NaN : Number(c.port);
  let https = c.https === true;

  if (!host && c.url) {
    return String(c.url).trim().replace(/\/+$/, '');
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(host)) {
    const u = new URL(host);
    https = u.protocol === 'https:';
    if (u.port && !Number.isFinite(port)) {
      port = Number(u.port);
    }
    host = u.hostname;
  }
  host = host.replace(/\/.*$/, '');                     // stray path
  if (!host) {
    host = DEFAULT_HOST;
  }
  host = host.replace(/^\[(.*)\]$/, '$1');            // "[fd7a::1]" -> fd7a::1
  const v6 = (host.match(/:/g) ?? []).length >= 2;      // one colon = host:port, two or more = IPv6
  if (!v6 && /:\d+$/.test(host)) {                     // "192.168.1.50:8088" in the host box
    const i = host.lastIndexOf(':');
    if (!Number.isFinite(port)) {
      port = Number(host.slice(i + 1));
    }
    host = host.slice(0, i);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    port = DEFAULT_PORT;
  }
  return `${https ? 'https' : 'http'}://${v6 ? `[${host}]` : host}:${port}`;
}
