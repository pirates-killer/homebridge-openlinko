# homebridge-openlinko

[![npm](https://img.shields.io/npm/v/homebridge-openlinko)](https://www.npmjs.com/package/homebridge-openlinko)
[![build](https://github.com/pirates-killer/homebridge-openlinko/actions/workflows/build.yml/badge.svg)](https://github.com/pirates-killer/homebridge-openlinko/actions/workflows/build.yml)

Apple Home for **CarLinko** cars (Chery, Jaecoo, Omoda and other Chery-group models), through your
own [OpenLinko](https://github.com/GodrezJr2/openlinko) dashboard.

> "Hey Siri, lock the Tiggo." · "Turn on the Tiggo A/C." · *When the car gets home, turn on the porch light.*

**New here? Read the [full guide](docs/GUIDE.md):** CarLinko accounts and permissions, setup,
every tile, Siri and automations, refusal codes, troubleshooting.

This is a **companion to OpenLinko, not a replacement**. The plugin only talks to your OpenLinko
server's local API. It never logs in to CarLinko itself, so:

- there's no second CarLinko session (CarLinko allows one per account, so a second one would log the first out),
- OpenLinko stays the only thing talking to the car's cloud, with its own rate limits and login guard,
- your CarLinko credentials stay in OpenLinko. The plugin never sees them.

## What you get

| Home tile | What it does | Comes from |
|---|---|---|
| **Lock** | Lock / unlock. Home asks for Face ID before unlocking | lock state in the car's status |
| **Battery** (on the lock) | Level, charging, low-battery alert; Siri: "what's the Tiggo battery level?" | battery %, charging state |
| **Charging** | Sensor, detected while charging. For automations ("charging stopped → notify me") | charging state |
| **A/C** | On / off, set temperature (car's own range and step, e.g. 15.5–30.5 °C in 0.5) | A/C flag and set-point |
| **Find car** | Horn and lights, then the switch turns itself off | none (no state) |
| **Windows** | Open / close **all windows** with a tap. The car has no per-window command | per-window state |
| **Windows Vent** | Switch: on = vent all windows, off = close them | per-window state |
| **Window Status** | Four read-only sensors (driver, passenger, rear driver-side, rear passenger-side): which window is open | per-window state |
| **Sunroof** *(off by default)* | Open / close with a tap | sunroof state |
| **Sunroof Tilt** *(with Sunroof)* | Switch: on = tilt, off = close | sunroof state |
| **Liftgate** *(off by default)* | Open / close the power boot (a garage door tile, so Home asks for Face ID before opening it) | boot state |
| **Doors** | Contact sensor: any door or the boot open | door bitmask |
| **Car at home** *(optional)* | Occupancy sensor inside a geofence around your home | OpenLinko's car location |

Only tiles **your car supports** get created. The plugin reads the car's own control config
through OpenLinko (`/api/controls`), so a car without a sunroof never gets a sunroof tile.

**Engine start is not exposed, on purpose.** A stray tap or a badly written automation should
never be able to start a car. The plugin keeps an allow-list of commands, and engine on/off isn't on it.

### Tested on

- **Chery Tiggo 7 CSH PHEV** (Malaysia, T-Box `2.3.1_050F01R`): all tiles. Lock, unlock and A/C
  control have been confirmed through OpenLinko on two cars of this model
  ([OpenLinko #18](https://github.com/GodrezJr2/openlinko/issues/18)).
- Other CarLinko cars should work wherever OpenLinko works. Please open an issue with your model either way.

## Requirements

1. A running **OpenLinko** server (any install: Pi, Docker, PC) that this Homebridge can reach.
   On the same machine that's `http://127.0.0.1:8088`.
2. For remote commands: OpenLinko must be logged in with a CarLinko account that the car's T-Box
   accepts. If commands fail with *"No operation permission"* (`0x44`), that account isn't on the
   car's authorised list. See [OpenLinko #18](https://github.com/GodrezJr2/openlinko/issues/18).
   Read-only tiles work with any account.
3. For **Car at home**: OpenLinko's car location feature, with `"location": true` in OpenLinko's `creds.json`.
4. Homebridge 1.8+ or 2.x, Node.js 20+.

## Install

Search for **OpenLinko** in the Homebridge UI's Plugins tab, or:

```sh
npm install -g homebridge-openlinko
```

Before it's on npm, install from GitHub: `npm install -g github:pirates-killer/homebridge-openlinko`
(more in the [guide](docs/GUIDE.md#4-install-the-plugin)).

I recommend running it as a **child bridge** (Homebridge UI → plugin → *Bridge Settings*), so a hiccup
here can't affect your other accessories.

## Configuration

Open the plugin's **Settings** in the Homebridge UI. You get a page with three parts:

1. **OpenLinko server.** IP address or host name, port, HTTPS (only if OpenLinko is behind an HTTPS
   proxy), and the dashboard password if you set one in OpenLinko. **Test connection** checks it
   and shows your car model, battery and last report time.
2. **Car at home.** A map. Click it or drag the pin to set home, paste coordinates or a full
   Google / Apple Maps link, or press **Use the car's location**, which works well while the car is
   parked at home. The circle shows the radius. (Short `maps.app.goo.gl` links hide the coordinates:
   open one in a browser first, then paste the full address.)
3. **Tiles.** The car name and which tiles to show.

The equivalent `config.json`:

```json
{
  "platform": "OpenLinko",
  "name": "OpenLinko",
  "host": "127.0.0.1",
  "port": 8088,
  "carName": "Tiggo",
  "lock": true,
  "climate": true,
  "defaultTemp": 22,
  "find": true,
  "windows": true,
  "sunroof": false,
  "liftgate": false,
  "doors": true,
  "lowBattery": 20,
  "home": { "enabled": true, "lat": 3.1579, "lng": 101.7116, "radius": 150 }
}
```

| Key | Default | Notes |
|---|---|---|
| `host` | `127.0.0.1` | OpenLinko's IP address or host name |
| `port` | `8088` | OpenLinko's port |
| `https` | `false` | Only for an OpenLinko behind an HTTPS proxy |
| `password` | none | Only if OpenLinko has a dashboard password |
| `carName` | `Car` | Prefix for tile names, which is also what you say to Siri |
| `lock`, `charging`, `climate`, `find`, `windows`, `windowsVent`, `windowSensors`, `doors` | `true` | Turn off tiles you don't want |
| `sunroof`, `liftgate` | `false` | Opt in (`sunroofTilt` follows `sunroof`) |
| `defaultTemp` | `22` | A/C temperature shown until the car reports its own |
| `lowBattery` | `20` | Low-battery alert threshold (%) |
| `home` | off | `lat`, `lng`, `radius` (m, min 50). Leaving needs 1.5 × radius, so the sensor doesn't flap at the edge |
| `mapTileUrl` | OpenStreetMap | Settings-page map only. Another tile server: https, with `{z}`, `{x}`, `{y}`. You then follow its terms |
| `mapAttribution` | none | The credit that other server requires, shown on the map |

### Pairing tip

If Home sticks at "Connecting…" when you add the bridge, put your iPhone on the Wi-Fi of the router
Homebridge is wired to. Some mesh systems don't pass the bridge's announcement (mDNS) from the wired
network to Wi-Fi clients on a satellite. You only need this while pairing.

## How it behaves

- **Live updates:** the plugin follows OpenLinko's `/api/stream`, so a tile changes as soon as the car
  reports. If the stream drops, it reconnects and polls `/api/summary` every 60 s in the meantime.
- **Commands** go through OpenLinko's `/api/control`, one at a time and at least 3 s apart. A command
  that's already queued or on its way isn't sent twice (Home re-sends targets), and if you change
  your mind before a queued command goes out (open, then close), only the latest is sent.
  Home shows *"Locking…"* until the car confirms or its next status report agrees. If the car
  refuses, the tile goes back and the reason is logged in plain words, with the meanings the
  CarLinko app itself uses: *"Car refused: a door is open (0x21)"*, *"a door is unlocked; lock the car
  first (0x22)"*, *"the car is moving (0x2A)"*. Permission errors keep OpenLinko's wording (*"No
  operation permission"*).
- A **sleeping car** may accept a command without confirming it. The tile keeps the new state for up to 2 minutes
  while the car wakes up and reports, then follows the car.
- **Windows and sunroof** are tap-to-open/close tiles, plus Vent and Tilt switches, because the car
  only knows those moves. There's no position to drag to. Locking the car also closes its windows
  (the car does this itself).
- **A/C:** the car reports no cabin temperature, so "current temperature" shows the set-point.
  Dragging the slider sends one command, where you let go.
- If OpenLinko can't be reached for 5 minutes, the tiles show **No Response** rather than stale values.

## Privacy

- The plugin (the part running in Homebridge) talks only to your own OpenLinko server.
- The settings page's map loads tiles for the area you're looking at, straight from OpenStreetMap
  in your browser. OSM sees your IP address and the Homebridge UI's address (as the Referer).
  See *Licences and policies*.
  Pasted links and coordinates are read on your machine; nothing is looked up online.
- The VIN never appears in logs or in Home. Accessory IDs come from a one-way hash of it.
- No telemetry and no analytics.

## Licences and policies

- This plugin: MIT.
- Bundled: [Leaflet](https://leafletjs.com) 1.9.4, BSD-2-Clause. Its licence ships with it. See
  [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Settings-page map: © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, data
  under the ODbL. Tiles are used under the [OSMF Tile Usage Policy](https://operations.osmfoundation.org/policies/tiles/)
  the way it expects of web pages: your browser loads them directly, sends the page's origin as
  Referer, and its cache honours OSM's caching headers. Only the tiles on screen are loaded, with no
  prefetch, and the credit is always visible on the map.
  Details in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
- Contact: [GitHub issues](https://github.com/pirates-killer/homebridge-openlinko/issues).

## Development

```sh
npm install
npm test          # builds, then runs unit tests + a fake-OpenLinko client test
npm pack          # homebridge-openlinko-x.y.z.tgz
```

Code layout, safe testing next to a real Homebridge, and releasing: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Credits

- [Leaflet](https://leafletjs.com) (BSD-2-Clause, bundled in the settings page) and map data from
  [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL).
- [OpenLinko](https://github.com/GodrezJr2/openlinko) by [GodrezJr2](https://github.com/GodrezJr2),
  which does all the heavy lifting: CarLinko login, telemetry decoding, and encrypted control frames.
- The OpenLinko community, for model decodes and testing.

Not affiliated with Chery, CarLinko, or Apple.

## License

MIT
