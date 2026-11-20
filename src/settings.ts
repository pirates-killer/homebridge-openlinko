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

