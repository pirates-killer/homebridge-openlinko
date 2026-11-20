# Development

## Layout

| Path | What |
|---|---|
| `src/index.ts` | registers the `OpenLinko` platform |
| `src/platform.ts` | setup, which tiles to create (from `/api/controls` and settings), the live stream, fallback polling, "No Response" |
| `src/accessories.ts` | one class per tile (lock, A/C, windows, switches, sensors…) |
| `src/client.ts` | the only code that talks to OpenLinko: HTTP, SSE stream, dashboard-password cookie, command queue and per-tile slots, opcode allow-list |
| `src/state.ts` | pure logic: opcodes, temperature encoding, window/sunroof/door decoding, geofence, refusal meanings, optimistic `Pending` state |
| `src/config.ts` | `baseUrl()`: host / port / https (and the legacy `url`) → base URL |
| `src/geo.ts` | `parseLatLng()`: coordinates and map links → lat/lng (local parsing only) |
| `homebridge-ui/` | the settings page: `server.js` (backend: Test connection, car location, paste parsing) and `public/` (page + map) |
| `scripts/copy-vendor.mjs` | bundles Leaflet into the settings page and stamps the script cache-buster |
| `test/` | `node:test` unit tests, plus a fake OpenLinko server for the client |

## Build and test

```sh
npm install
npm test        # build + unit tests (pure logic + client against a fake OpenLinko)
npm pack        # homebridge-openlinko-x.y.z.tgz
```

## Trying it without touching your main Homebridge

Run a second, throwaway Homebridge with its own storage folder and port:

```sh
mkdir -p ~/hb-test/plugins ~/hb-test/storage
tar xzf homebridge-openlinko-*.tgz -C ~/hb-test/plugins && mv ~/hb-test/plugins/package ~/hb-test/plugins/homebridge-openlinko
# ~/hb-test/storage/config.json: its own "bridge" (unique username, port, pin) + the OpenLinko platform
homebridge -U ~/hb-test/storage -P ~/hb-test/plugins --strict-plugin-resolution
```

- Pair it in Home like any bridge. Keep the bridge `username` unchanged, or Home sees a new bridge.
- **Never run it with `-I` (insecure mode) while it's connected to a real car.** Insecure mode lets
  anyone on the LAN read and write characteristics without pairing, which includes unlocking.
- Homebridge renames its process to `homebridge`, so find a test instance by its working directory
  or port before stopping it. Don't use `pkill -f`.

The settings page can be tried the same way with a standalone Homebridge UI
(`homebridge-config-ui-x/dist/bin/standalone.js -U … -P …`). Bind it to `127.0.0.1` and reach it
through an SSH tunnel.

## Rules the code keeps

- **OpenLinko only.** No CarLinko calls, no CarLinko credentials. Everything goes through
  OpenLinko's API.
- **Command allow-list.** `isAllowedOp()` in `src/state.ts`. Engine start/stop stays off it.
- **Privacy.** No VIN, plate or coordinates in logs. Accessory IDs come from a one-way hash of the VIN.
- **Map tiles** follow the OSMF Tile Usage Policy (see `THIRD-PARTY-NOTICES.md`). Don't add a
  proxy or prefetching.

## Releasing

1. Bump `version` in `package.json` and add a `CHANGELOG.md` entry.
2. `npm test`, commit, tag `vX.Y.Z`, push with tags.
3. Publish a GitHub release for the tag. `.github/workflows/publish.yml` publishes to npm (needs
   the `NPM_TOKEN` repository secret).
