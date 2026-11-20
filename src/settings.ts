import { readFileSync } from 'node:fs';

export const PLATFORM_NAME = 'OpenLinko';
export const PLUGIN_NAME = 'homebridge-openlinko';

export const PLUGIN_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
  } catch {
    return '0.0.0';
  }
})();

export const HOMEPAGE = 'https://github.com/pirates-killer/homebridge-openlinko';

/**
 * Sent on every map tile request. OSM's tile policy requires a distinct, stable User-Agent naming
 * the app, with contact details: keep the product name and URL unchanged across releases.
 */
export const TILE_USER_AGENT = `homebridge-openlinko/${PLUGIN_VERSION} (+${HOMEPAGE})`;
