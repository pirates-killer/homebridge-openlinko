# Changelog

## Unreleased

Fixes from the first evening of driving with the plugin (Tiggo 7 CSH, 2026-11-20).

- **Lock notifications said the opposite** ("was unlocked" when the car locked itself). The lock
  now tells Home its target state before its current state, as the liftgate already did, so Home
  never sees a lock "in progress the other way". The window and sunroof tiles do the same.
- A request Home sends twice is still sent to the car once, and the log now says so (*"already on
  its way, not sent again"*) instead of looking like two commands.
- New option **Log what Home shows** (`logStates`, off by default): one log line per change of a
  tile's state, to compare with the phone's notifications.
- The car-at-home sensor checks OpenLinko's position every 30 s (was 60 s).

## 0.1.0 (2026-11-20)

First release.

- Lock / unlock, with drive battery level, charging state and low-battery alert
- A/C on/off and set temperature (car's own range and step)
- Find car (horn + lights)
- Windows: open/close-all tile, Windows Vent switch, four window status sensors
- Sunroof: open/close tile and Sunroof Tilt switch (the Tiggo 7's 0x07 "open" reading understood)
- Charging sensor; power liftgate
- Doors contact sensor
- "Car at home" occupancy sensor from OpenLinko's car location + a home geofence
- Tiles created only for what the car supports (from OpenLinko `/api/controls`)
- Live updates over OpenLinko `/api/stream`, with fallback polling
- Works with password-protected OpenLinko dashboards
- Settings page: OpenLinko IP/port/HTTPS/password with a "Test connection" button, and a map for
  the home location (click, drag, paste coordinates or a Google/Apple Maps link, or use the car's
  current position). Map tiles follow the OSMF Tile Usage Policy: loaded by the browser with the
  page's origin as Referer, only what's on screen, the OpenStreetMap credit always on the map
- Engine start deliberately not exposed (command allow-list)
- Refusals explained in plain words (result-byte meanings from the CarLinko app), e.g. "a door is
  open (0x21)"; duplicate commands from Home are not re-sent, and a queued command is replaced by a
  newer one from the same tile
