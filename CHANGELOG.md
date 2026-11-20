# Changelog

## 0.1.0 (2026-11-20)

First release.

- Lock / unlock, with drive battery level, charging state and low-battery alert
- A/C on/off and set temperature (car's own range and step)
- Find car (horn + lights)
- Windows (close / vent / open), sunroof (close / tilt / open), power liftgate
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
