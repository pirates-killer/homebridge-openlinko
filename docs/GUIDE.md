# homebridge-openlinko: the full guide

From a CarLinko car to Apple Home: what you need, how to set it up, what each tile does, and
what to do when something doesn't work.

- [1. How it fits together](#1-how-it-fits-together)
- [2. Before you start: CarLinko accounts and permissions](#2-before-you-start-carlinko-accounts-and-permissions)
- [3. OpenLinko](#3-openlinko)
- [4. Install the plugin](#4-install-the-plugin)
- [5. Set it up](#5-set-it-up)
- [6. Add it to Apple Home](#6-add-it-to-apple-home)
- [7. The tiles](#7-the-tiles)
- [8. Siri and automations](#8-siri-and-automations)
- [9. When the car says no: refusal codes](#9-when-the-car-says-no-refusal-codes)
- [10. Troubleshooting](#10-troubleshooting)
- [11. Performance](#11-performance)
- [12. FAQ](#12-faq)

---

## 1. How it fits together

```
Apple Home  ⇄  Homebridge + this plugin  ⇄  OpenLinko  ⇄  CarLinko cloud  ⇄  your car
 (iPhone,       (your Pi / server)          (your server)  (Chery's servers)  (its T-Box)
  Apple TV)
```

- **CarLinko** is the connected-car service behind the Chery, Jaecoo and Omoda apps. The car's
  telematics box (T-Box) reports to CarLinko's cloud over mobile data and takes remote commands from it.
- **[OpenLinko](https://github.com/GodrezJr2/openlinko)** is an open-source dashboard that logs
  in to CarLinko for you. It records the car's telemetry and sends remote commands, encrypted the
  same way as the official app.
- **This plugin** only talks to OpenLinko's local API. It never logs in to CarLinko and never
  sees your CarLinko password. OpenLinko stays the single thing that talks to the cloud.

What the plugin uses:

| OpenLinko endpoint | For |
|---|---|
| `GET /api/stream` | live status (server-sent events), one long-lived connection |
| `GET /api/summary` | status when the stream is down, and right after a command |
| `GET /api/controls` | what your car supports, so only those tiles are created |
| `POST /api/control` | sending a command |
| `GET /api/location` | the car's position, for the optional "Car Home" sensor |
| `POST /api/unlock` | only if your OpenLinko has a dashboard password |

## 2. Before you start: CarLinko accounts and permissions

Two CarLinko rules decide whether remote commands will work.

**One session per account.** If OpenLinko and the phone app log in with the same account, they
keep logging each other out. Use a second account for OpenLinko: in the official app, share the
car with another CarLinko account (*authorised user*), then log OpenLinko in with that account.

**The T-Box keeps its own list of who may send commands.** Being the owner in the cloud isn't
always enough. If an account isn't on the car's own list, every command is refused with
**`0x44` "No operation permission"**, even from the official app. Read-only tiles (battery, lock
state, doors…) work with any account; commands need an account the car accepts. This was worked
out on a Chery Tiggo 7 CSH in
[OpenLinko #18](https://github.com/GodrezJr2/openlinko/issues/18).

Quick test before installing anything: lock and unlock the car from OpenLinko's own dashboard.
If that works, the plugin will work too.

## 3. OpenLinko

Install OpenLinko by following [its README](https://github.com/GodrezJr2/openlinko), on the same
machine as Homebridge or anywhere Homebridge can reach (same LAN, or Tailscale). Then check:

- the dashboard opens at `http://<host>:8088` and shows your car
- lock / unlock from the dashboard works (see section 2)
- optional, for the **Car Home** sensor: OpenLinko's car location feature is on (`"location": true` in
  its `creds.json`, see OpenLinko's `docs/LOCATION.md`)

If you set a **dashboard password** in OpenLinko, give the plugin the same password.

## 4. Install the plugin

**Homebridge UI:** Plugins → search **OpenLinko** → Install. Search works once the plugin is
published to npm.

**Command line:**
```sh
npm install -g homebridge-openlinko
```

**Before it's on npm, or to test the latest code from GitHub:**
```sh
npm install -g github:pirates-killer/homebridge-openlinko
```
On the official Homebridge Raspberry Pi image, install into Homebridge's own folder instead:
```sh
sudo -u homebridge /opt/homebridge/bin/npm install --prefix /var/lib/homebridge github:pirates-killer/homebridge-openlinko
sudo hb-service restart
```

**Run it as a child bridge** (Homebridge UI → the plugin → *Bridge Settings*). It then runs in
its own process, so a problem here can't affect your other accessories, and it can be restarted
on its own.

## 5. Set it up

Homebridge UI → Plugins → **OpenLinko** → *Settings*.

**OpenLinko server**
- **IP address or host name** and **port** of OpenLinko: same machine = `127.0.0.1`, `8088`.
  Pasting a whole `http://192.168.1.50:8088` into the IP box works too.
- **HTTPS** only if OpenLinko sits behind an HTTPS proxy.
- **Dashboard password** only if you set one in OpenLinko.
- **Test connection** shows your car model, battery and last report time, or the reason it
  can't connect ("connection refused", "timed out", "password rejected").

**Car at home** (optional)
- Tick **Show a "Car Home" sensor**, then set home in any of these ways:
  - click the map, or drag the red pin
  - paste coordinates (`3.1579, 101.7116`, `3°09'28.4"N 101°42'41.8"E`) or a full Google Maps /
    Apple Maps link. Short `maps.app.goo.gl` links hide the coordinates: open the link in a browser,
    then paste the full address from the address bar.
  - **Use the car's location**: easiest while the car is parked at home
- **Radius:** the circle on the map, 150 m by default. To count as "left", the car has to go past
  1.5 × the radius, so the sensor doesn't flicker at the edge.
- The blue dot is where the car is now.

**Tiles:** car name (used in every tile name and for Siri) and which tiles to show. Only tiles your
car supports are created, whatever is ticked.

Save, then restart the child bridge (or Homebridge).

## 6. Add it to Apple Home

1. Home app → **+** → **Add Accessory** → scan the QR code from the child bridge's settings in the
   Homebridge UI, or choose *More options…* and enter the setup code.
2. "Uncertified accessory" → **Add Anyway** (normal for every Homebridge bridge).
3. Put the tiles in a room, e.g. "Car".

**Stuck at "Connecting…"?** Put the iPhone on the Wi-Fi of the router Homebridge is plugged into.
Some mesh Wi-Fi systems don't pass the bridge's announcement (mDNS) from the wired network to
phones on a satellite. Once paired, it works from anywhere (through your home hub when you're
away).

**Restarts keep the pairing.** You only need to re-pair if the bridge's identity changes: a new
`username` in the bridge settings, or its `persist` folder deleted.

## 7. The tiles

The tile names start with your **car name** (examples below use "Tiggo").

| Tile | Type in Home | What it does | Car command |
|---|---|---|---|
| **Tiggo** | Lock | Lock / unlock. Home asks for Face ID / passcode before unlocking. | `740100` / `740200` |
| *(on the lock)* | Battery | Battery level, charging, low-battery alert (threshold in settings) | — |
| **Tiggo Charging** | Occupancy sensor | "Detected" while charging | — |
| **Tiggo A/C** | Heater/cooler | On / off, set temperature (your car's own range and step) | `741001` / `741000`, `7411xx` |
| **Find Tiggo** | Switch | Horn and lights, then switches itself off | `740400` |
| **Tiggo Windows** | Window | Tap: open / close **all** windows | `740600` / `740500` |
| **Tiggo Windows Vent** | Switch | On = vent all windows, off = close them | `740E00` / `740500` |
| **Tiggo Window Status** | 4 contact sensors | Driver, Passenger, Rear driver-side, Rear passenger-side: which window is open | — |
| **Tiggo Sunroof** *(opt-in)* | Window | Tap: open / close | `740F01` / `740F00` |
| **Tiggo Sunroof Tilt** *(with Sunroof)* | Switch | On = tilt, off = close | `740F02` / `740F00` |
| **Tiggo Liftgate** *(opt-in)* | Garage door | Open / close the power boot. Home asks for Face ID before opening. | `740300` / `740A00` |
| **Tiggo Doors** | Contact sensor | "Open" if any door or the boot is open | — |
| **Tiggo Home** *(optional)* | Occupancy sensor | "Detected" while the car is inside your home circle | — |

Good to know:
- **Windows move together.** CarLinko has no command for a single window (true for every app,
  including the official one). The car does *report* each window, hence the four status sensors.
- **Some cars close the windows when you lock.** A Tiggo 7 CSH does this by itself.
- **Remote A/C needs a locked car** on many models. Unlocked, it's refused with `0x22` (section 9).
- **The A/C tile's "current temperature" is the set temperature.** The car doesn't report a cabin
  temperature.
- **Engine start isn't offered, on purpose.** The plugin keeps an allow-list of commands, and
  engine start/stop (`740700` / `740800`) isn't on it.

**How a command plays out:** Home shows *"Locking…"*. The plugin sends the command through
OpenLinko, and the car answers within a few seconds. Then:
- if the car confirms, the tile settles on the new state
- if the car refuses, the tile goes back and the reason is logged in plain words (section 9)
- if a sleeping car doesn't confirm, the tile keeps the new state for up to 2 minutes while the car
  wakes and reports, then follows the car

Commands go out one at a time, at least 3 s apart. If Home sends the same command twice, it goes
to the car once. If you change your mind before a queued command has gone out (open, then close),
only the latest one is sent.

## 8. Siri and automations

**Siri:** "Lock the Tiggo" · "Is the Tiggo locked?" · "Turn on the Tiggo A/C" · "Set the Tiggo
A/C to 22 degrees" · "Open the Tiggo windows" · "Turn on Tiggo Windows Vent" · "What's the Tiggo
battery level?"

**Automation ideas** (Home app → Automation → +). Automations run on your home hub (Apple TV,
HomePod or iPad).

| When | Do |
|---|---|
| **Tiggo Home** detects occupancy (car arrives) | porch light on, open the gate |
| **Tiggo Home** stops detecting, and **Tiggo** is unlocked | notify: "car left unlocked?" (via a shortcut) |
| **Tiggo Charging** stops detecting | notify: charging finished or stopped |
| 22:00, and a **Tiggo Window Status** sensor is open | notify, or close the windows |
| A **Tiggo Doors** sensor opens while you're away | notify |
| Weekday 07:30 | **Tiggo A/C** on, 22 °C (lock the car first) |

## 9. When the car says no: refusal codes

The car answers every command with a result byte. `00` means done. Anything else is a refusal,
and the plugin logs it in plain words, using the meanings from the CarLinko app itself (they're
the same for every command type). Example: `Tiggo Windows: open the windows failed — Car refused:
a door is open (0x21)`.

| Code | Meaning | What to do |
|---|---|---|
| `21` | a door is open | close the doors |
| `22` | a door is unlocked | lock the car first (A/C and similar) |
| `23` | the car is switched on | switch it off |
| `2A` | the car is moving | — |
| `2B` | the bonnet is open | close it |
| `35` | the boot isn't fully closed | close it |
| `44` | no operation permission | this CarLinko account isn't on the car's own list (section 2) |
| `4D` | maintenance mode is on | only lock and unlock work |
| `66` | car control system error | try again later |
| `75` | firmware update in progress | try again later |
| `91` | driver's seat occupied | — |
| `92` | the A/C failed to start | — |
| `93` | not in remote mode | — |
| `94` / `9D` | high-voltage system fault | check the car |
| `95` / `A8` | battery too low / 12 V below 11.5 V | charge / drive |
| `96` | a key is inside the car | take the key out |
| `97` | the boot is open | close it |
| `98` | registered VIN doesn't match the car | contact the dealer |
| `99` | T-Box authentication failed | — |
| `9A` / `A9` | not in P | — |
| `9B` | hazard lights on | switch them off |
| `9C` / `A1` / `A5` | another vehicle condition | — |
| `9E` | high-voltage battery too low | charge |
| `9F` | the car is unlocked | lock it first |
| `A0` | abnormal battery voltage | — |
| `A2` | the car's power isn't OFF | switch off |
| `A3` / `A4` | remote start limit reached | start the car by hand once |
| `A6` / `A7` | low fuel pressure / high coolant temperature | — |

A bare `7404` (*"Car control system error (0x04)"*) is different: the car couldn't read the
command frame at all. That usually means an old OpenLinko that doesn't encrypt commands. Update it.

## 10. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Tiles show **No Response** | OpenLinko unreachable for 5+ minutes | check OpenLinko is running; **Test connection** in settings |
| *"the OpenLinko dashboard is password-protected"* in the log | OpenLinko has a dashboard password | enter it in settings |
| Every command: **`0x44`** | the account isn't on the car's list | section 2 |
| Commands: **`7404`** | OpenLinko too old (unencrypted commands) | update OpenLinko |
| A command "sent (the car did not confirm yet)" | car asleep / weak signal | the tile follows once the car reports; retry if needed |
| A tile doesn't change after you used the key fob | waits for the car's next report | normal; usually within a minute |
| Fewer tiles than expected | your car's config says it doesn't support them, or they're off in settings | check `/api/controls` in OpenLinko |
| Map on the settings page shows "blocked" tiles | the page was opened as `localhost` (OpenStreetMap refuses that), or no internet | open the Homebridge UI on its LAN address |
| "Car Home" never changes | location off in OpenLinko, or no position yet | `"location": true` in OpenLinko; check its Location card |
| A lock notification at every stop | the car unlocks itself in P and locks itself once moving; each is a real change | normal; turn off notifications on the lock tile in Home if you don't want them |
| A notification says "unlocked" when the car locked | plugin 0.1.0 told Home the current state before the target | update the plugin (fixed after 0.1.0) |
| The log shows a command twice | Home asked twice; the second line says *"already on its way, not sent again"* | nothing to do: the car got it once |
| Pairing stuck at "Connecting…" | mesh Wi-Fi drops mDNS | section 6 |
| Had to re-pair after a change | bridge identity changed | section 6 |

**Logs:** every command and its result is in the Homebridge log, e.g.
`[OpenLinko] Tiggo: lock — done`. To see what Home was shown and when, turn on **Log what Home
shows** (`logStates`, under Troubleshooting in settings): each change gets a line like
`[OpenLinko] Tiggo: Home shows lock Locked`. When asking for help, include your car model, region, OpenLinko
version and those lines. **Never post your VIN, plate, account email or location.**

## 11. Performance

The plugin itself is light: about 100 MB of RAM and ~0% CPU when idle.

It keeps OpenLinko's live stream open, so tiles update the moment the car reports. While any live
client is connected (this plugin, or an OpenLinko dashboard tab left open), OpenLinko rebuilds its
whole summary each time the car reports, roughly every 30 s. That rebuild goes through your whole
history. With a big history it costs real CPU on OpenLinko's side. On a Raspberry Pi 5 with ~760k
stored frames, that's about 5 s at 100% of one core per rebuild, ~15–20% of one core on average,
and a few degrees warmer. It's safe, but it grows as the history grows. It's an OpenLinko
characteristic rather than this plugin's (an open dashboard tab costs the same), and the place to
improve it is upstream.

## 12. FAQ

**Why not talk to CarLinko directly, like other integrations?** CarLinko allows one session per
account. Going through OpenLinko means one login, one place that handles CarLinko's quirks
(encryption, rate limits, login guard), and the plugin never holds your CarLinko password.

**Can I open just the driver's window?** No: CarLinko has no per-window command (section 7).

**Can it start the engine?** It deliberately won't (section 7).

**Can Home show the battery % on a tile?** Apple Home has no tile type for a plain number. The
level is in the Lock tile's details, Home warns when it's low, and Siri can tell you.

**Which cars?** Anything OpenLinko supports. Tested end to end on a Chery Tiggo 7 CSH PHEV
(Malaysia). Please report other models, working or not.
