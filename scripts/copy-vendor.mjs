// Ship Leaflet inside the plugin: the Homebridge UI only runs scripts served by the plugin itself.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const src = dirname(require.resolve('leaflet/package.json'));
const out = new URL('../homebridge-ui/public/vendor/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const [from, to] of [['dist/leaflet.js', 'leaflet.js'], ['dist/leaflet.css', 'leaflet.css'], ['LICENSE', 'LEAFLET-LICENSE']]) {
  copyFileSync(join(src, from), new URL(to, out));
}
console.log('vendored leaflet', require('leaflet/package.json').version);

// Cache-bust the settings page's scripts per release, so an update never runs yesterday's app.js.
import { readFileSync, writeFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const page = new URL('../homebridge-ui/public/index.html', import.meta.url);
const html = readFileSync(page, 'utf8');
const stamped = html.replace(/\?v=[^"]*"/g, `?v=${version}"`);
if (stamped !== html) {
  writeFileSync(page, stamped);
}
