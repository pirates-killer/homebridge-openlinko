# homebridge-openlinko

[![npm](https://img.shields.io/npm/v/homebridge-openlinko)](https://www.npmjs.com/package/homebridge-openlinko)
[![build](https://github.com/pirates-killer/homebridge-openlinko/actions/workflows/build.yml/badge.svg)](https://github.com/pirates-killer/homebridge-openlinko/actions/workflows/build.yml)

Apple Home for **CarLinko** cars (Chery, Jaecoo, Omoda and other Chery-group models), through your
own [OpenLinko](https://github.com/GodrezJr2/openlinko) dashboard.

> "Hey Siri, lock the Tiggo." · "Turn on the Tiggo A/C." · *When the car gets home, turn on the porch light.*

This is a **companion to OpenLinko, not a replacement**. The plugin only talks to your OpenLinko
server's local API. It never logs in to CarLinko itself, so:

- there's no second CarLinko session (CarLinko allows one per account, so a second one would log the first out),
- OpenLinko stays the only thing talking to the car's cloud, with its own rate limits and login guard,
- your CarLinko credentials stay in OpenLinko. The plugin never sees them.

## What you get

| Home tile | What it does | Comes from |
|---|---|---|
| **Lock** | Lock / unlock. Home asks for Face ID before unlocking | lock state in the car's status |
| **Battery** (on the lock) | Level, charging, low-battery alert | battery %, charging state |
| **A/C** | On / off, set temperature (car's own range and step, e.g. 15.5–30.5 °C in 0.5) | A/C flag and set-point |
| **Find car** | Horn and lights, then the switch turns itself off | none (no state) |
| **Windows** | Close / vent / open (slider snaps: 0 = close, ~20 = vent, 100 = open) | per-window state |
| **Sunroof** *(off by default)* | Close / tilt / open | sunroof state |
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

I recommend running it as a **child bridge** (Homebridge UI → plugin → *Bridge Settings*), so a hiccup
here can't affect your other accessories.

## Configuration

Everything can be set in the Homebridge UI. The equivalent `config.json`:

```json
{
  "platform": "OpenLinko",
  "name": "OpenLinko",
  "url": "http://127.0.0.1:8088",
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
| `url` | `http://127.0.0.1:8088` | Your OpenLinko dashboard |
| `password` | none | Only if OpenLinko has a dashboard password |
| `carName` | `Car` | Prefix for tile names, which is also what you say to Siri |
| `lock`, `climate`, `find`, `windows`, `doors` | `true` | Turn tiles off you don't want |
| `sunroof`, `liftgate` | `false` | Opt in |
| `defaultTemp` | `22` | A/C temperature shown until the car reports its own |
| `lowBattery` | `20` | Low-battery alert threshold (%) |
| `home` | off | `lat`, `lng`, `radius` (m, min 50). Leaving needs 1.5 × radius, so the sensor doesn't flap at the edge |

## How it behaves

- **Live updates:** the plugin follows OpenLinko's `/api/stream`, so a tile changes as soon as the car
  reports. If the stream drops, it reconnects and polls `/api/summary` every 60 s in the meantime.
- **Commands** go through OpenLinko's `/api/control`, one at a time and at least 3 s apart.
  Home shows *"Locking…"* until the car confirms or its next status report agrees. If the car
  refuses, the tile goes back and the reason is logged, using OpenLinko's own wording:
  *"A door is unlocked"*, *"Vehicle in motion"*, *"No operation permission"*…
- A **sleeping car** may accept a command without confirming it. The tile keeps the new state for up to 2 minutes
  while the car wakes up and reports, then follows the car.
- **A/C:** the car reports no cabin temperature, so "current temperature" shows the set-point.
  Dragging the slider sends one command, where you let go.
- If OpenLinko can't be reached for 5 minutes, the tiles show **No Response** rather than stale values.

## Privacy

- The plugin sends nothing anywhere except your own OpenLinko server.
- The VIN never appears in logs or in Home. Accessory IDs come from a one-way hash of it.
- No telemetry and no analytics.

## Development

```sh
npm install
npm test          # builds, then runs unit tests + a fake-OpenLinko client test
npm pack          # homebridge-openlinko-x.y.z.tgz
```

## Credits

- [OpenLinko](https://github.com/GodrezJr2/openlinko) by [GodrezJr2](https://github.com/GodrezJr2),
  which does all the heavy lifting: CarLinko login, telemetry decoding, and encrypted control frames.
- The OpenLinko community, for model decodes and testing.

Not affiliated with Chery, CarLinko, or Apple.

## License

MIT
