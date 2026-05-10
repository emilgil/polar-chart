# Polar Wind Card – Implementation Spec for Claude Code

## Goal

Build a Home Assistant Lovelace **custom card** that displays wind data as a **polar spiral**
– where the center is N hours ago and the outer edge is now. Each data point is positioned
by wind direction (angle) and time (radius), and colored by wind speed. The time window
is controllable via GUI inputs and by scrolling the mouse wheel over the canvas, with
all rebucketing done locally from a cached raw dataset.

All connection details and sensor names are configured via Lovelace YAML — no editing
of the JS file is needed per instance.

---

## Context

- **Lovelace card type:** `custom:polar-wind-card`
- **File to deliver:** `/config/www/polar-wind-card.js`
- **Lovelace resource:** `url: /local/polar-wind-card.js`, `type: module`
- **Data source:** Home Assistant REST API (`/api/history/period/`)
- **Auth:** Uses the `hass` object injected by Lovelace — no token needed in config
- **Speed unit:** Auto-detected from `hass.states[speed_sensor].attributes.unit_of_measurement`.
  Can be overridden via optional `speed_unit` YAML key. All values converted to m/s internally.

---

## Lovelace YAML Interface

```yaml
type: custom:polar-wind-card
bearing_sensor: sensor.subbeberget_wind_bearing   # required
speed_sensor: sensor.subbeberget_wind_strength    # required
hours: 12          # optional, default 12
num_points: 100    # optional, default 100
speed_unit: m/s    # optional override. Auto-detected from sensor's unit_of_measurement.
                   # Only needed to override HA's reported unit.
                   # Allowed: "m/s", "km/h", "mph", "knop"
language: sv       # optional. Defaults to HA locale (hass.locale.language).
                   # Allowed: "sv", "en". Falls back to "sv" if locale not supported.
```

`ha_url` and `ha_token` are **not needed** — the card uses the `hass` object that
Lovelace injects automatically, which already carries a valid token and the correct
base URL (`this._hass.hassUrl`, `this._hass.auth.data.access_token`).

All keys except `type` are passed to the card via `setConfig()`. The card must
throw a descriptive error if `bearing_sensor` or `speed_sensor` are missing.

---

## Custom Card Architecture

The card is a standard Web Component registered with `customElements.define`.

### Lifecycle order (important)

Lovelace calls `setConfig()` **before** `connectedCallback()`. DOM and shadow root
must therefore be initialised in `setConfig()`, not `connectedCallback()`.

```javascript
class PolarWindCard extends HTMLElement {
  setConfig(config) {
    // 1. Validate required keys — throw on missing
    // 2. Store config: this._config = config
    // 3. Initialise state defaults (viewHours, cache, fetching flag)
    // 4. Build shadow DOM if not already built: if (!this.shadowRoot) this._buildDOM()
    // 5. Pre-fill GUI inputs from config values
    // Note: language and speed_unit are resolved in set hass() once hass is available
  }

  // Called by Lovelace on every hass state update.
  // Stores the hass object and triggers first load once both config and hass are available.
  set hass(hass) {
    this._hass = hass;
    // Trigger first load exactly once — when hass arrives after setConfig has run
    if (!this._hasStarted && this._config) {
      this._hasStarted = true;
      this._lang      = _resolveLanguage(this._config, hass);
      this._speedUnit = _resolveSpeedUnit(this._config, hass);
      this._applyI18n();
      this._startLoading();
      this._interval = setInterval(() => this._invalidateAndFetch(), AUTO_REFRESH_MS);
    }
  }

  connectedCallback() {
    // Loading is triggered by set hass(), not here.
    // connectedCallback may fire before hass is available.
  }

  disconnectedCallback() {
    clearInterval(this._interval);
  }

  // Required by Lovelace for layout calculations
  getCardSize() { return 5; }
}

customElements.define('polar-wind-card', PolarWindCard);
```

The card uses a **shadow DOM** (`this.attachShadow({ mode: 'open' })`) so styles
are scoped and do not leak into the rest of Lovelace.

---

## Internal DOM Structure (built in `_buildDOM`)

```html
<!-- inside shadow root -->
<style>
  :host { display: block; }
  #pw-controls { display:flex; gap:16px; align-items:center;
                 padding:8px 4px; font-size:13px; color:#ccc; flex-wrap:wrap; }
  #pw-canvas   { display:block; width:100%; aspect-ratio:1/1; cursor:crosshair; }
</style>

<div id="pw-controls">
  <label id="pw-label-hours"><!-- filled by i18n -->
    <input id="pw-hours" type="number" min="0.5" max="168" step="0.5">
  </label>
  <label id="pw-label-points"><!-- filled by i18n -->
    <input id="pw-points" type="number" min="10" max="500">
  </label>
  <button id="pw-apply" title="<!-- filled by i18n -->">🔃</button>
</div>

<canvas id="pw-canvas"></canvas>
```

- Input default values are set from `config.hours` and `config.num_points` in `setConfig()`
- Label text and button text are set by `_applyI18n()` once at init, based on `this._lang`
- Canvas has **no fixed `width`/`height` attributes** — these are set dynamically (see Sizing)

---

## Canvas Sizing and Responsiveness

The canvas must fill the available card width while remaining square.

```javascript
function _resizeCanvas() {
  const canvas = this.shadowRoot.getElementById('pw-canvas');
  const size   = canvas.clientWidth;   // CSS-determined width
  canvas.width  = size;                // set backing buffer to match
  canvas.height = size;
}
```

- `_resizeCanvas()` is called at the start of every `_draw()` call
- A `ResizeObserver` on the canvas triggers `_redrawFromCache()` when the card is resized
- All drawing parameters (`cx`, `cy`, `max_radius`) are derived from `canvas.width`
  at draw time:
  ```javascript
  const size       = canvas.width;
  const cx         = size / 2;
  const cy         = size / 2;
  const max_radius = size * 0.42;  // leaves margin for labels
  ```

---

## State

All mutable state lives as private properties on the card instance:

```javascript
this._config       // validated config from setConfig()
this._hass         // hass object injected by Lovelace (set via set hass())
this._hasStarted   // boolean — true after first _startLoading() has been called
this._viewHours    // current visible time window (float, default = config.hours)
this._cache = {
  raw:          null,  // [{ts:ms, bearing:float, speed:float}] sorted asc
  fetchedAt:    null,  // Date.now() when cache was last populated
  fetchedHours: null,  // how many hours back was fetched
}
this._fetching     // boolean — true while a fetch is in flight (prevents concurrent fetches)
this._interval     // setInterval handle
```

---

## Visualization Design

### Coordinate system

```
r     = (timestamp - t_start) / (t_now - t_start)   // 0.0 = viewHours ago, 1.0 = now
theta = bearing_degrees × (π / 180)
x     = cx + r × max_radius × sin(theta)
y     = cy - r × max_radius × cos(theta)
```

North (0°/360°) = up, East (90°) = right, South (180°) = down, West (270°) = left.

### Speed unit detection and conversion

The speed unit is resolved in `set hass()` using this priority order:

```javascript
// HA uses "kn" for knots; map to internal key "knop"
const HA_UNIT_MAP = {
  'm/s':  'm/s',
  'km/h': 'km/h',
  'mph':  'mph',
  'kn':   'knop',
};

function _resolveSpeedUnit(config, hass) {
  // 1. Explicit YAML override
  if (config.speed_unit) return config.speed_unit;
  // 2. Auto-detect from sensor attributes
  const haUnit = hass.states[config.speed_sensor]?.attributes?.unit_of_measurement;
  if (haUnit && HA_UNIT_MAP[haUnit]) return HA_UNIT_MAP[haUnit];
  // 3. Fallback
  return 'm/s';
}
```

Stored as `this._speedUnit`. Sensor values are then converted to m/s internally:

```javascript
const TO_MS = {
  'm/s':  1.0,
  'km/h': 1 / 3.6,
  'mph':  0.44704,
  'knop': 0.514444,
};
const speedMs = rawValue * TO_MS[this._speedUnit];
```

All downstream logic (color classification, legend thresholds) uses the converted m/s
value. The original unit is only used for display in the legend header.

### Color scale — continuous gradient (thresholds always in m/s internally)

Colors transition **smoothly** between five anchor points using linear interpolation.
There are no hard steps — a value halfway between two anchors gets a color halfway
between their hues.

#### Anchor points

| m/s | km/h | mph | knop | Color          | Hex     | Label (sv/en)       |
|-----|------|-----|------|----------------|---------|---------------------|
| 0   | 0    | 0   | 0    | Blue           | #60a5fa | Lugnt / Calm        |
| 3   | 11   | 7   | 6    | Green          | #4ade80 | Lätt / Light        |
| 8   | 29   | 18  | 16   | Yellow         | #facc15 | Måttligt / Moderate |
| 14  | 50   | 31  | 27   | Orange         | #fb923c | Friskt / Fresh      |
| 20  | 72   | 45  | 39   | Red            | #f87171 | Hård vind / Storm   |

Values above 20 m/s are clamped to red (#f87171).

#### Interpolation function

```javascript
function speedToColor(ms) {
  const stops = [
    { v: 0,  r: 96,  g: 165, b: 250 }, // #60a5fa
    { v: 3,  r: 74,  g: 222, b: 128 }, // #4ade80
    { v: 8,  r: 250, g: 204, b: 21  }, // #facc15
    { v: 14, r: 251, g: 146, b: 60  }, // #fb923c
    { v: 20, r: 248, g: 113, b: 113 }, // #f87171
  ];
  if (ms <= stops[0].v) return stops[0];
  if (ms >= stops[stops.length - 1].v) return stops[stops.length - 1];
  const hi = stops.findIndex(s => s.v > ms);
  const lo = stops[hi - 1];
  const t  = (ms - lo.v) / (stops[hi].v - lo.v);  // 0.0–1.0
  return {
    r: Math.round(lo.r + t * (stops[hi].r - lo.r)),
    g: Math.round(lo.g + t * (stops[hi].g - lo.g)),
    b: Math.round(lo.b + t * (stops[hi].b - lo.b)),
  };
}
// Returns {r, g, b} → use as `rgb(${r},${g},${b})`
```

#### Legend

The legend renders a **vertical gradient bar** (canvas `LinearGradient` from top to bottom)
spanning the full blue→red range, with the 5 anchor labels and their speed values (in the
configured unit) as tick marks alongside. This replaces the 5 discrete color blocks.

```javascript
// Gradient bar: top = #60a5fa (0 m/s), bottom = #f87171 (≥20 m/s)
const grad = ctx.createLinearGradient(x, yTop, x, yBottom);
grad.addColorStop(0.00, '#60a5fa');
grad.addColorStop(0.15, '#4ade80');
grad.addColorStop(0.40, '#facc15');
grad.addColorStop(0.70, '#fb923c');
grad.addColorStop(1.00, '#f87171');
```

Tick positions correspond to the anchor speeds: 0, 3, 8, 14, 20 m/s mapped linearly
to the bar height. Each tick shows `speedLabels[i]` and the threshold in configured unit
(via `msToDisplay`).

The legend header shows the configured unit, e.g. **"Vind (knop)"** or **"Wind (knots)"**.
Legend threshold values are converted from m/s to the configured unit for display:

```javascript
function msToDisplay(ms, unit) {
  const FROM_MS = { 'm/s': 1, 'km/h': 3.6, 'mph': 2.23694, 'knop': 1.94384 };
  return Math.round(ms * FROM_MS[unit]);
}
// Example: threshold 8 m/s displayed as "16 knop" when speed_unit = "knop"
```

### Canvas elements (draw in this order)

1. **Background:** Dark fill (`#1e2130`)
2. **Concentric rings:** 4 rings at r = 0.25, 0.5, 0.75, 1.0
   - Color: `rgba(255,255,255,0.1)`, 1px stroke
   - Label at top of each ring: dynamically from `_viewHours`
     Formula: label_i = `-${round(viewHours × (1 - (i+1)/4))}h`, outermost = `I18N[lang].now`
     Round to one decimal if < 2h, otherwise round to nearest integer.
3. **Compass lines:** 8 lines from center at 0°/45°/90°/135°/180°/225°/270°/315°
   - Color: `rgba(255,255,255,0.07)`, 1px stroke
4. **Compass labels:** N, NE, E, SE, S, SW, W, NW at outer edge
   - Font: 11px, color `rgba(255,255,255,0.5)`
5. **Data points:** Circle for each rebucketed sample
   - Radius: 4px, fill from color scale, oldest first (newest drawn on top)
6. **Center dot:** White dot at `(cx, cy)`, radius 3px
7. **Legend:** Bottom-right, header **"[legendTitle] ([unitName])"** using i18n strings,
   then a vertical **gradient bar** (blue→red) with 5 anchor tick marks (label + speed value
   in configured unit). See gradient bar spec in Color Scale section.
8. **"[updated]: HH:MM"** bottom-left, 10px gray — **local time** (`toLocaleTimeString`); `updated` from i18n
9. **"[showing]: Xh | Y [points]"** one line below timestamp, 10px gray — strings from i18n
10. **Loading overlay** (only while `_fetching === true` AND cache is empty):
    Centered text from `I18N[lang].loading` in white, no data points drawn

---

## Internationalisation (i18n)

### Language state

```javascript
this._lang       // 'sv' or 'en', resolved once at init — never changes during runtime
this._speedUnit  // resolved unit key ('m/s'|'km/h'|'mph'|'knop'), set in set hass()
```

### Language resolution order

```javascript
function _resolveLanguage(config, hass) {
  const supported = ['sv', 'en'];
  // 1. Explicit config key
  if (config.language && supported.includes(config.language)) return config.language;
  // 2. HA locale (e.g. "sv-SE" → "sv", "en-GB" → "en")
  const locale = hass?.locale?.language?.split('-')[0]?.toLowerCase();
  if (locale && supported.includes(locale)) return locale;
  // 3. Fallback
  return 'sv';
}
```

Called once in `set hass()` when both `_config` and `_hass` are available, before
`_startLoading()`. Result stored in `this._lang` and never mutated again.

### String table

```javascript
const I18N = {
  sv: {
    hoursLabel:   'Timmar bakåt',
    pointsLabel:  'Datapunkter',
    applyButton:  'Uppdatera',
    legendTitle:  'Vind',
    loading:      'Hämtar data…',
    fetchError:   'Kunde inte hämta data',
    updated:      'Uppdaterad',
    showing:      'Visar',
    points:       'punkter',
    now:          'Nu',
    speedLabels:  ['Lugnt', 'Lätt', 'Måttligt', 'Friskt', 'Hård vind'],
    unitName:     { 'm/s': 'm/s', 'km/h': 'km/h', 'mph': 'mph', 'knop': 'knop' },
  },
  en: {
    hoursLabel:   'Hours back',
    pointsLabel:  'Data points',
    applyButton:  'Update',
    legendTitle:  'Wind',
    loading:      'Loading…',
    fetchError:   'Could not fetch data',
    updated:      'Updated',
    showing:      'Showing',
    points:       'points',
    now:          'Now',
    speedLabels:  ['Calm', 'Light', 'Moderate', 'Fresh', 'Storm'],
    unitName:     { 'm/s': 'm/s', 'km/h': 'km/h', 'mph': 'mph', 'knop': 'knots' },
  },
};
```

Note: `unitName` maps the `speed_unit` config value to its display string in each language
— `knop` displays as **"knop"** in Swedish and **"knots"** in English. All other units
are identical in both languages.

### `_applyI18n()` method

Called **once** at init (after `_lang` is resolved), updates all DOM text labels:

```javascript
_applyI18n() {
  const t = I18N[this._lang];
  const sr = this.shadowRoot;
  sr.getElementById('pw-label-hours').firstChild.textContent = t.hoursLabel + ': ';
  sr.getElementById('pw-label-points').firstChild.textContent = t.pointsLabel + ': ';
  sr.getElementById('pw-apply').textContent = t.applyButton;
  // Canvas text strings are picked up from I18N[this._lang] at draw time
}
```


---

## Data Fetching & Caching

### Progressive loading strategy

On first load (and after cache invalidation), fetch in two stages to minimise
time-to-first-render:

**Stage 1 — fast paint (synchronous fetch chain):**
```
fetch viewHours of data  →  populate cache  →  draw
```

**Stage 2 — background backfill (non-blocking):**
```
fetch CACHE_HORIZON_H (168h) silently  →  merge into cache  →  redraw
```

Stage 2 starts immediately after Stage 1 completes. It must not block the UI or
show a loading indicator (cache already has data from Stage 1). When Stage 2
completes, `cache.raw` is replaced with the full dataset and the canvas redraws
silently.

```javascript
async _startLoading() {
  await this._fetchRange(this._viewHours);   // Stage 1: fast
  this._redrawFromCache();
  this._fetchRange(CACHE_HORIZON_H);         // Stage 2: background, no await
}
```

### Cache invalidation

- **Auto-refresh** (every 10 min): invalidate → `_startLoading()`
- **Uppdatera button**: invalidate → `_startLoading()`
- **Zoom beyond fetchedHours**: trigger `_fetchRange(CACHE_HORIZON_H)` (background)

### Fetch guard

```javascript
async _fetchRange(hours) {
  if (this._fetching) return;   // prevent concurrent fetches
  this._fetching = true;
  try {
    // ... fetch, parse, store in cache
  } finally {
    this._fetching = false;
  }
}
```

The loading overlay (canvas element 10) is only shown when `_fetching && !cache.raw`
(i.e. Stage 1 only — Stage 2 is silent).

### Endpoint

```
GET {hassUrl}/api/history/period/{iso_start}
  ?filter_entity_id={bearing_sensor},{speed_sensor}
  &minimal_response=true
  &significant_changes_only=false
```

- `hassUrl` = `this._hass.hassUrl` (e.g. `http://192.168.1.97:8123`)
- `iso_start` = now minus `hours` (parameter to `_fetchRange`), ISO 8601
- Header: `Authorization: Bearer ${this._hass.auth.data.access_token}`

No token or URL is needed in YAML config — both come from the injected `hass` object.

### Parsing raw data

Merge both sensor arrays into a paired flat array:
- For each entry in the bearing array, find the nearest speed entry within ±60 seconds
- Store as `cache.raw = [{ts, bearing, speed}]` sorted by `ts` ascending
- Discard entries where either value is `'unavailable'` or non-numeric
- Update `cache.fetchedAt = Date.now()` and `cache.fetchedHours = hours`

### Rebucketing (local, from cache)

```javascript
function _rebucket(raw, viewHours, numPoints) {
  const t_now   = Date.now();
  const t_start = t_now - viewHours * 3_600_000;
  const width   = (t_now - t_start) / numPoints;
  const result  = [];
  for (let i = 0; i < numPoints; i++) {
    const bStart = t_start + i * width;
    const bEnd   = bStart + width;
    const pts    = raw.filter(p => p.ts >= bStart && p.ts < bEnd);
    if (pts.length > 0) result.push(pts[pts.length - 1]);
  }
  return result;
}
```

---

## Zoom via Mouse Wheel

```javascript
canvas.addEventListener('wheel', e => {
  e.preventDefault();
  const factor    = e.deltaY > 0 ? 1.2 : 1 / 1.2;
  this._viewHours = Math.min(168, Math.max(0.5, this._viewHours * factor));
  this.shadowRoot.getElementById('pw-hours').value = this._viewHours.toFixed(1);
  this._redrawFromCache();
  // If zoomed beyond cached range, backfill silently
  if (this._viewHours > this._cache.fetchedHours) {
    this._fetchRange(CACHE_HORIZON_H);
  }
}, { passive: false });
```

- Scroll up → fewer hours → zoom in → higher temporal resolution at outer edge
- Scroll down → more hours → zoom out → up to 168h max
- `numPoints` unchanged by zoom

---

## GUI Behaviour

- **pw-hours input** changed manually → update `_viewHours` → `_redrawFromCache()`
  (trigger background fetch if `_viewHours > cache.fetchedHours`)
- **Uppdatera / Update button** → invalidate cache → `_startLoading()`
- **Mouse wheel on canvas** → update `_viewHours` + input → `_redrawFromCache()`
- **Auto-refresh** every 10 min → invalidate cache → `_startLoading()`

---

## Error Handling

- Missing required config key → `throw new Error('polar-wind-card: missing required config key: X')`
- Fetch fails → if cache empty: draw background + rings + compass + centered text from `I18N[lang].fetchError`;
  if cache has data: keep showing existing data silently
- `state === 'unavailable'` or non-numeric → skip silently
- Fewer than 5 valid points after rebucketing → draw what's available, no error message
- Wheel `e.preventDefault()` prevents page scroll conflict

---

## Installation Instructions (include as comment block at top of JS file)

```javascript
/*
 * polar-wind-card.js — Home Assistant Lovelace custom card
 *
 * INSTALLATION
 * 1. Copy this file to /config/www/polar-wind-card.js
 * 2. In Lovelace: Settings → Dashboards → Resources → Add resource
 *      URL:  /local/polar-wind-card.js
 *      Type: JavaScript module
 * 3. Reload the browser, then add a card:
 *
 *   type: custom:polar-wind-card
 *   bearing_sensor: sensor.your_bearing   # required — must report degrees 0–360
 *   speed_sensor: sensor.your_speed       # required
 *   hours: 12                             # optional, default 12
 *   num_points: 100                       # optional, default 100
 *   speed_unit: m/s                       # optional: "m/s" | "km/h" | "mph" | "knop"
 *   language: sv                          # optional: "sv" | "en"
 *                                         # defaults to HA locale, falls back to "sv"
 *
 * No ha_url or ha_token needed — auth is handled automatically via the Lovelace hass object.
 * Speed unit is auto-detected from sensor's unit_of_measurement attribute.
 * speed_unit in YAML overrides auto-detection. Supported: m/s, km/h, mph, knop (kn).
 * Values are converted to m/s internally — color thresholds are always in m/s.
 * Language defaults to the HA locale setting (e.g. sv-SE → sv, en-GB → en).
 */
```

---

## Acceptance Criteria

- [ ] Card registers as `custom:polar-wind-card` via `customElements.define`
- [ ] `setConfig()` validates required keys (`bearing_sensor`, `speed_sensor`) and throws on missing
- [ ] Shadow DOM built in `setConfig()` (before `connectedCallback`)
- [ ] `getCardSize()` returns 5
- [ ] No `ha_url` or `ha_token` in YAML — URL and token come from `this._hass`
- [ ] `set hass()` stores `hass` object and triggers first load when both config and hass are ready
- [ ] `_hasStarted` flag ensures `_startLoading()` is only called once on initial load
- [ ] Sensor names come from YAML config — nothing else hardcoded
- [ ] Canvas fills card width, maintains square aspect ratio via CSS `aspect-ratio:1/1`
- [ ] `cx`, `cy`, `max_radius` derived from actual `canvas.width` at draw time
- [ ] `ResizeObserver` triggers redraw on card resize
- [ ] Stage 1 fetch (viewHours) runs first → canvas draws as soon as data arrives
- [ ] Stage 2 fetch (168h) runs silently in background — no loading indicator shown
- [ ] Loading overlay `"Hämtar data…"` only shown during Stage 1 (cache empty)
- [ ] Concurrent fetch guard (`_fetching` flag) prevents duplicate requests
- [ ] Canvas renders dark background, 4 concentric rings, compass labels
- [ ] Ring time labels calculated dynamically from `_viewHours`, rounded sensibly
- [ ] Data points plotted as colored dots (count = `numPoints`)
- [ ] North up, East right
- [ ] Speed unit auto-detected from `hass.states[speed_sensor].attributes.unit_of_measurement`
- [ ] HA unit `"kn"` correctly mapped to internal key `"knop"`
- [ ] `speed_unit` YAML key overrides auto-detection when present
- [ ] Falls back to `m/s` if unit missing or unrecognised
- [ ] `_speedUnit` resolved in `set hass()` before first load
- [ ] Speed values converted to m/s at parse time using correct factor
- [ ] Dot color uses continuous interpolation between 5 anchor points (no hard steps)
- [ ] `speedToColor()` correctly interpolates between adjacent anchor colors
- [ ] Values above 20 m/s clamped to red
- [ ] `language` config key accepted (`sv`/`en`)
- [ ] Invalid `language` value throws descriptive error
- [ ] Language defaults to `hass.locale.language` (e.g. `sv-SE` → `sv`) if not set in config
- [ ] Falls back to `sv` if locale is unsupported
- [ ] `_lang` resolved once in `set hass()` before first load — never mutated again
- [ ] `_applyI18n()` called once at init, sets all DOM text labels
- [ ] All UI strings (labels, buttons, legend, status, errors) use i18n table
- [ ] `knop` displays as "knop" in Swedish and "knots" in English
- [ ] Legend renders a vertical gradient bar (blue→red) with 5 tick marks
- [ ] Legend tick labels use `speedLabels[i]` from active language
- [ ] Legend tick speed values shown in configured unit (converted from m/s)
- [ ] Legend header shows **"[Wind/Vind] ([unit])"** with configured unit in active language
- [ ] Legend visible and correct
- [ ] Newest point at outer edge, oldest near center
- [ ] GUI controls visible above canvas with config defaults pre-filled
- [ ] Mouse wheel changes `_viewHours` and redraws without fetching (unless beyond cache)
- [ ] Scroll up = zoom in = fewer hours = higher resolution
- [ ] `pw-hours` input updates live during wheel scroll
- [ ] New fetch only when cache stale or insufficient
- [ ] Uppdatera always invalidates cache and calls `_startLoading()`
- [ ] Auto-refresh every 10 minutes
- [ ] "Updated/Uppdaterad: HH:MM" uses local time and active language
- [ ] "Showing/Visar: Xh | Y points/punkter" reflects live values and active language
- [ ] Fetch error with empty cache shows error string in active language
- [ ] Fetch error with existing cache keeps showing old data silently
- [ ] Shadow DOM used — styles scoped to card
- [ ] Installation comment block at top of file lists all supported speed units
- [ ] No external JS dependencies
