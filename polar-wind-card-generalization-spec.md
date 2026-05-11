# Polar Wind Card – Generalization Spec

## Goal

Refactor `polar-wind-card.js` to be **sensor-agnostic** — the card can visualize
any two HA sensors as a polar time-spiral, not just wind direction + wind speed.

The card remains registered as `custom:polar-wind-card` and remains fully
**backwards compatible**: any existing config using `bearing_sensor` and
`speed_sensor` continues to work without modification.

---

## Backwards compatibility contract

If the config contains `bearing_sensor` and/or `speed_sensor` keys, the card
**silently maps them to the new generic config format** before any other processing:

```javascript
function _normalizeConfig(config) {
  // Legacy wind config → generic format
  if (config.bearing_sensor || config.speed_sensor) {
    return {
      ...config,
      angle: {
        sensor:  config.bearing_sensor,
        min:     0,
        max:     360,
        cyclic:  true,
        unit:    config.speed_unit,        // may be undefined
        labels: {
          0:   'N', 45:  'NE', 90:  'E',  135: 'SE',
          180: 'S', 225: 'SW', 270: 'W',  315: 'NW',
        },
      },
      color: config.speed_sensor ? {
        sensor:  config.speed_sensor,
        min:     0,
        max:     20,
        unit:    config.speed_unit,        // may be undefined
        palette: [
          { value: 0,  color: '#60a5fa' },
          { value: 3,  color: '#4ade80' },
          { value: 8,  color: '#facc15' },
          { value: 14, color: '#fb923c' },
          { value: 20, color: '#f87171' },
        ],
        legend: [
          { value: 0,  labelKey: 'speedLabel0' },
          { value: 3,  labelKey: 'speedLabel1' },
          { value: 8,  labelKey: 'speedLabel2' },
          { value: 14, labelKey: 'speedLabel3' },
          { value: 20, labelKey: 'speedLabel4' },
        ],
      } : undefined,
    };
  }
  return config;
}
```

This normalization runs at the top of `setConfig()`. All internal logic works
exclusively with the normalized format from this point on.

---

## New generic YAML format

```yaml
type: custom:polar-wind-card

# Angle axis (required)
angle:
  sensor: sensor.wind_bearing   # required — entity to use for angle
  min: 0                        # required — minimum sensor value
  max: 360                      # required — maximum sensor value
  cyclic: true                  # optional, default false
                                # true = min and max are the same point (e.g. compass)
                                # false = linear range (e.g. SoC 0–100%)
  labels:                       # optional — tick labels at specific values
    0:   "N"                    # key = sensor value, value = display string
    90:  "E"
    180: "S"
    270: "W"
  label_count: 8                # optional — if no labels provided, auto-generate
                                # this many evenly-spaced numeric labels

# Color axis (optional — if omitted, all dots drawn in a single neutral color)
color:
  sensor: sensor.wind_strength  # required within block
  min: 0                        # required — sensor value at cool end of palette
  max: 20                       # required — sensor value at warm end of palette
  unit: m/s                     # optional — display unit (auto-detected from hass if omitted)
  palette:                      # required — at least 2 color stops
    - { value: 0,  color: "#60a5fa" }
    - { value: 10, color: "#facc15" }
    - { value: 20, color: "#f87171" }
  legend:                       # optional — labels for legend ticks
    - { value: 0,  label: "Calm" }
    - { value: 10, label: "Moderate" }
    - { value: 20, label: "Storm" }

# Time window
hours: 12          # optional, default 12
num_points: 100    # optional, default 100

# Language
language: sv       # optional, defaults to hass.locale.language, fallback "sv"
```

---

## Config validation

`setConfig()` must validate the **normalized** config and throw descriptive errors:

| Condition | Error message |
|-----------|---------------|
| `angle` block missing | `polar-wind-card: angle.sensor is required` |
| `angle.sensor` missing | `polar-wind-card: angle.sensor is required` |
| `angle.min` or `angle.max` missing | `polar-wind-card: angle.min and angle.max are required` |
| `angle.min >= angle.max` | `polar-wind-card: angle.min must be less than angle.max` |
| `color` block present but `color.sensor` missing | `polar-wind-card: color.sensor is required when color block is present` |
| `color.palette` has fewer than 2 stops | `polar-wind-card: color.palette must have at least 2 entries` |

---

## Internal state changes

Replace wind-specific properties with generic equivalents:

| Old | New | Notes |
|-----|-----|-------|
| `this._speedUnit` | `this._colorUnit` | resolved from `color.unit` or hass attributes |
| `this._config.bearing_sensor` | `this._config.angle.sensor` | after normalization |
| `this._config.speed_sensor` | `this._config.color.sensor` | after normalization |

Add:
```javascript
this._colorUnit   // resolved unit string for the color axis sensor
this._angleRange  // { min, max, cyclic } — computed once from normalized config
```

---

## Angle axis rendering

### Axis lines

Replace the hardcoded 8 compass lines with dynamically generated lines based on config:

```javascript
function _drawAngleLines(ctx, cx, cy, max_radius, angleConfig) {
  // If cyclic: draw lines at each label value + evenly spaced intermediate lines
  // If not cyclic: draw lines only within [min, max] range
  const { min, max, cyclic, labels, label_count } = angleConfig;
  const range = max - min;
  const count = labels ? Object.keys(labels).length : (label_count || 8);
  const step  = range / count;
  for (let i = 0; i < count; i++) {
    const val   = min + i * step;
    const theta = _valueToTheta(val, min, max, cyclic);
    // draw line from center to max_radius
  }
}
```

### Angle labels

Replace hardcoded N/NE/E/... with labels from config:

```javascript
function _drawAngleLabels(ctx, cx, cy, max_radius, angleConfig, lang) {
  if (angleConfig.labels) {
    for (const [val, label] of Object.entries(angleConfig.labels)) {
      const theta = _valueToTheta(parseFloat(val), angleConfig.min, angleConfig.max, angleConfig.cyclic);
      // draw label at (cx + (max_radius + 14) × sin(theta), cy - (max_radius + 14) × cos(theta))
    }
  } else {
    // Auto-generate label_count numeric labels evenly spaced across [min, max]
  }
}
```

### Value → angle conversion

```javascript
function _valueToTheta(value, min, max, cyclic) {
  const range = max - min;
  const norm  = (value - min) / range;   // 0.0–1.0
  // North = up = -π/2 in canvas coordinates
  // For cyclic: full 2π rotation; for non-cyclic: map [0,1] → [−π/2, −π/2 + 2π × fraction]
  return cyclic
    ? norm * 2 * Math.PI - Math.PI / 2
    : norm * 2 * Math.PI * ((max - min) / 360) - Math.PI / 2;
}
```

For the non-cyclic case, the arc spans only `(max - min) / 360 × 360°` of the circle.
E.g. SoC 0–100% spans the full circle (100/100 = 1.0 → 360°).
E.g. temperature −20–40°C spans 60/360 × 360° = 60° of the circle — a narrow wedge.

---

## Color axis rendering

### Color interpolation

Replace `speedToColor()` with a generic function driven by the palette config:

```javascript
function _valueToColor(value, colorConfig) {
  if (!colorConfig) return { r: 150, g: 150, b: 150 };  // neutral gray if no color axis
  const { palette, min, max } = colorConfig;
  const clamped = Math.min(max, Math.max(min, value));
  // Find surrounding palette stops and interpolate
  // Same linear interpolation as existing speedToColor() but driven by palette array
  if (palette.length === 1) return _hexToRgb(palette[0].color);
  const stops = palette.map(s => ({ ...s, rgb: _hexToRgb(s.color) }));
  if (clamped <= stops[0].value) return stops[0].rgb;
  if (clamped >= stops[stops.length - 1].value) return stops[stops.length - 1].rgb;
  const hi = stops.findIndex(s => s.value > clamped);
  const lo = stops[hi - 1];
  const t  = (clamped - lo.value) / (stops[hi].value - lo.value);
  return {
    r: Math.round(lo.rgb.r + t * (stops[hi].rgb.r - lo.rgb.r)),
    g: Math.round(lo.rgb.g + t * (stops[hi].rgb.g - lo.rgb.g)),
    b: Math.round(lo.rgb.b + t * (stops[hi].rgb.b - lo.rgb.b)),
  };
}

function _hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}
```

### Legend

Replace the hardcoded 5-row legend with a generic gradient bar driven by `color.legend`:

```javascript
function _drawLegend(ctx, x, y, colorConfig, colorUnit, lang) {
  if (!colorConfig) return;
  const { palette, legend, min, max } = colorConfig;
  // Draw gradient bar using palette stops (same technique as existing legend)
  // Draw tick labels from legend array (if present) or from palette stops (if no legend)
  // Each tick label: legend[i].label (if present) or numeric value + unit
  // Unit display: colorUnit (resolved from config or hass)
  // Legend header: use I18N[lang].legendTitle if defined, else colorUnit
}
```

---

## Data fetching changes

### Two-sensor fetch

The existing fetch is already generic — it uses
`filter_entity_id=angle.sensor,color.sensor`. After normalization the fetch code
uses `this._config.angle.sensor` and `this._config.color?.sensor`.

If `color` is omitted from config, fetch only the angle sensor:
```
filter_entity_id=angle.sensor
```

### Raw data parsing

Replace wind-specific pairing logic with generic pairing:

```javascript
function _parseHistory(data, config) {
  // Series keys: 'angle' and 'color' (or just 'angle' if no color sensor)
  // Pair by nearest timestamp within ±60s (same as existing logic)
  // Store as [{ts, angle, color}] — color may be undefined if no color sensor
}
```

### Rebucketing

No changes needed — the rebucket function operates on `{ts, ...}` objects and
is already generic.

---

## Wind rose feature (Feature 2) — generalization note

The wind rose is wind-specific by nature. It should only be shown when:
- `angle.cyclic === true`, AND
- `angle.min === 0` and `angle.max === 360`

If these conditions are not met, the `🌹` button should be hidden.

---

## Unit auto-detection

Replace `_resolveSpeedUnit()` with a generic `_resolveColorUnit()`:

```javascript
function _resolveColorUnit(config, hass) {
  // 1. Explicit config: color.unit
  if (config.color?.unit) return config.color.unit;
  // 2. Auto-detect from hass
  const haUnit = hass.states[config.color?.sensor]?.attributes?.unit_of_measurement;
  if (haUnit) return haUnit;
  // 3. Fallback
  return '';
}
```

Note: unlike `_resolveSpeedUnit()`, this function does **not** map `'kn'` → `'knop'`
— that was wind-specific. The returned unit is used as-is for display only.
No internal conversion is done for the generic case.

**Exception for backwards compatibility:** if the config was created from legacy
`bearing_sensor`/`speed_sensor` keys, apply the existing `HA_UNIT_MAP` and `TO_MS`
conversion as before. This is handled by `_normalizeConfig()` setting a flag:

```javascript
config._isLegacyWind = true   // set by _normalizeConfig when legacy keys detected
```

And in parsing:
```javascript
const speedFactor = config._isLegacyWind ? TO_MS[this._colorUnit] : 1.0;
```

---

## Example configs (non-wind)

### EV State of Charge over time

```yaml
type: custom:polar-wind-card
angle:
  sensor: sensor.enyaq_battery_level
  min: 0
  max: 100
  cyclic: true          # 0% and 100% are not the same, but map to full circle
  label_count: 4        # auto: 0%, 25%, 50%, 75%
color:
  sensor: sensor.enyaq_charging_power
  min: 0
  max: 11000
  unit: W
  palette:
    - { value: 0,     color: "#374151" }
    - { value: 1000,  color: "#60a5fa" }
    - { value: 11000, color: "#4ade80" }
  legend:
    - { value: 0,     label: "Idle" }
    - { value: 1000,  label: "Charging" }
    - { value: 11000, label: "Fast" }
hours: 48
num_points: 200
```

### Power consumption — hour of day pattern

```yaml
type: custom:polar-wind-card
angle:
  sensor: sensor.power_consumption
  min: 0
  max: 5000
  cyclic: false
  label_count: 5
color:
  sensor: sensor.electricity_price
  min: 0
  max: 2
  unit: kr/kWh
  palette:
    - { value: 0,   color: "#4ade80" }
    - { value: 1,   color: "#facc15" }
    - { value: 2,   color: "#f87171" }
hours: 72
num_points: 150
```

---

## Files to deliver

- `polar-wind-card.js` — refactored in place, same filename, same card type
- No new files needed

---

## Acceptance criteria

- [ ] Existing wind config (`bearing_sensor` + `speed_sensor`) works unchanged
- [ ] `_normalizeConfig()` maps legacy keys to generic format before all processing
- [ ] `_isLegacyWind` flag set when legacy keys detected — enables TO_MS conversion
- [ ] New generic YAML format with `angle` + `color` blocks works correctly
- [ ] `setConfig()` validates normalized config and throws descriptive errors
- [ ] `_valueToTheta()` correctly maps sensor values to canvas angles
- [ ] Cyclic mode: full 360° circle used
- [ ] Non-cyclic mode: arc spans proportional fraction of circle
- [ ] Angle lines and labels generated dynamically from config
- [ ] Explicit `labels` dict rendered at correct angles
- [ ] Auto `label_count` generates evenly-spaced numeric labels
- [ ] `_valueToColor()` interpolates generic palette correctly
- [ ] No color sensor: dots drawn in neutral gray
- [ ] Legend driven by `color.legend` array or falls back to palette stops
- [ ] `_resolveColorUnit()` replaces `_resolveSpeedUnit()` for generic case
- [ ] Wind rose button hidden when `angle.cyclic !== true` or range is not 0–360
- [ ] EV SoC example config produces sensible visualization
- [ ] Card registers as `custom:polar-wind-card` — no type name change
- [ ] No external JS dependencies added
