# Third-party notices

## Bundled in this package

### Leaflet 1.9.4

`homebridge-ui/public/vendor/leaflet.js` and `leaflet.css` are Leaflet (https://leafletjs.com),
redistributed unmodified under the BSD 2-Clause License. The licence text follows. It is also
shipped next to the files as `homebridge-ui/public/vendor/LEAFLET-LICENSE`.

```
BSD 2-Clause License

Copyright (c) 2010-2023, Volodymyr Agafonkin
Copyright (c) 2010-2011, CloudMade
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## Installed as a dependency (not bundled)

- **@homebridge/plugin-ui-utils** (MIT License), installed by npm with this plugin. Its own
  licence file comes with it.

## Services used by the settings page

### OpenStreetMap

The map on the plugin's settings page shows tiles from the OpenStreetMap Foundation's tile
servers. Map data © OpenStreetMap contributors, available under the Open Database License (ODbL):
https://www.openstreetmap.org/copyright.

Tile use follows the OSMF Tile Usage Policy (https://operations.osmfoundation.org/policies/tiles/),
in the way it expects of web pages:

- your browser loads the tiles straight from `https://tile.openstreetmap.org/{z}/{x}/{y}.png`, with
  its own User-Agent. Its HTTP cache honours OSM's caching headers. There is no proxy, which the
  policy doesn't recommend.
- a valid Referer is sent. The Homebridge UI serves its pages with `Referrer-Policy: no-referrer`,
  which the policy forbids for tile requests, so the map tiles set their own
  `referrerPolicy="strict-origin-when-cross-origin"`. The browser then sends only the page's
  origin (e.g. `http://192.168.1.50:8581`).
- only the tiles in view are requested, once panning or zooming stops. There's no prefetch, no bulk
  download and no offline use.
- the credit "© OpenStreetMap contributors" (linked to the copyright page) and a "Report a map
  issue" link stay visible on the map
- the tile server can be changed in the settings without a software update, as the policy
  recommends. Anyone who switches servers must follow that server's terms and show its credit.

The plugin itself, the part that runs in Homebridge, never contacts OpenStreetMap.
