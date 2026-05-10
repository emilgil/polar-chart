# Polar Wind Card – Feature Extensions Spec

Three additive features for `polar-wind-card.js`. Each feature is independent
and can be implemented in any order. All features reuse existing infrastructure:
`_cache`, `_rebucket()`, `speedToColor()`, `I18N`, `_speedUnit`, `_lang`.

---

## Shared context

- Existing card: `custom:polar-wind-card` in `/config/www/polar-wind-card.js`
- Canvas coordinate system: North = up, `cx/cy` = center, `max_radius = size * 0.42`
- Polar → canvas: `x = cx + r × max_radius × sin(theta)`, `y = cy - r × max_radius × cos(theta)`
- All new YAML keys are optional and default to `false`/off unless stated otherwise
- All new i18n strings must be added to both `sv` and `en` entries in `I18N`

---

## Feature 1: Max Wind Marker

### Purpose

Highlight the single strongest wind measurement in the current view —
useful for spotting gusts at a glance.

### YAML key

```yaml
show_max_wind: true   # optional, default false
```

### Visual design

The max-wind marker is drawn **after** all data points (on top) and consists of:

1. **Outer ring:** Circle at the max point's canvas position
   - Radius: 10px
   - Stroke: white, 1.5px, opacity 0.9
   - No fill

2. **Inner dot:** Normal data point dot drawn on top of the ring
   - Same color as `speedToColor(maxSpeed)` — consistent with the spiral

3. **Label:** Speed value + unit, drawn adjacent to the ring
   - Format: `"12.3 m/s"` (use `_speedUnit` for unit, display value in configured unit
     via `FROM_MS` conversion, one decimal place)
   - Font: bold 11px, fill white, opacity 0.9
   - Position: offset 14px from ring center, towards the nearest canvas edge
     (so the label doesn't overlap the spiral center)
   - If the point is in the top half of canvas: label below; bottom half: label above
   - If the point is in the left half: label to the right; right half: label to the left

4. **Subtle pulse animation** (optional enhancement):
   - A second ring animates outward from radius 10px to 18px and fades out, looping
   - Implemented via `requestAnimationFrame` loop only when `show_max_wind: true`
   - Animation period: 2 seconds
   - This replaces the static `_redrawFromCache()` call with a continuous draw loop
     only when animation is active

### Logic

```javascript
function _findMaxPoint(buckets) {
  if (!buckets || buckets.length === 0) return null;
  return buckets.reduce((max, p) => p.speed > max.speed ? p : max, buckets[0]);
}
```

Called with the same rebucketed array used for drawing dots. The max point's
canvas coordinates are computed the same way as for regular points.

### i18n strings to add

```javascript
sv: { maxWind: 'Maxvind' }
en: { maxWind: 'Max wind' }
```

### Acceptance criteria

- [ ] `show_max_wind: true` enables the feature; absent or false disables it
- [ ] Outer ring drawn at correct canvas position for the highest-speed bucket
- [ ] Label shows speed in configured unit with one decimal place
- [ ] Label positioned to avoid overlapping canvas center
- [ ] Marker updates correctly when view changes (zoom, update button)
- [ ] Pulse animation loops continuously when feature is enabled
- [ ] No animation loop running when `show_max_wind` is false

---

## Feature 2: Wind Rose Overlay

### Purpose

Show a classical wind rose — frequency distribution of wind directions —
as a semi-transparent overlay behind the spiral. This reveals dominant
wind directions over the selected time window at a glance.

### YAML key

```yaml
show_wind_rose: true   # optional, default false
```

### Visual design

The wind rose is drawn **after** the background and rings but **before** the
compass lines and data points, so it sits under everything else.

1. **16 sectors**, each 22.5° wide, centered on N/NNE/NE/.../NNW
2. **Sector length** proportional to the frequency of bearings falling in that sector,
   relative to the most frequent sector (i.e. most frequent sector = `max_radius × 0.38`)
3. **Sector fill:** `rgba(255, 255, 255, 0.08)` — very subtle white
4. **Sector stroke:** `rgba(255, 255, 255, 0.2)`, 0.5px
5. **Sectors are drawn as arcs** from center outward (pie-slice shape):
   ```javascript
   ctx.beginPath();
   ctx.moveTo(cx, cy);
   ctx.arc(cx, cy, sectorRadius, startAngle, endAngle);
   ctx.closePath();
   ```

### Logic

```javascript
function _computeWindRose(buckets, numSectors = 16) {
  const counts = new Array(numSectors).fill(0);
  const width  = 360 / numSectors;
  for (const p of buckets) {
    const i = Math.floor(((p.bearing % 360) + 360) % 360 / width) % numSectors;
    counts[i]++;
  }
  const max = Math.max(...counts, 1);
  return counts.map(c => c / max);  // normalised 0.0–1.0
}
```

The sector index 0 corresponds to North (bearing 0°), increasing clockwise.
Sector angles are rotated to match canvas orientation (North = up):
```javascript
const startAngle = (i * width - 90 - width / 2) * Math.PI / 180;
const endAngle   = startAngle + width * Math.PI / 180;
```

### i18n strings to add

```javascript
sv: { windRose: 'Vindros' }
en: { windRose: 'Wind rose' }
```

### Acceptance criteria

- [ ] `show_wind_rose: true` enables the feature; absent or false disables it
- [ ] 16 sectors drawn as pie-slices from center
- [ ] Sector proportional to frequency of bearings in that direction
- [ ] Most frequent sector fills to `max_radius × 0.38`
- [ ] Wind rose drawn behind compass lines and data points
- [ ] Updates correctly on zoom and data refresh
- [ ] Subtle enough to not obscure the spiral (opacity as specified)

---

## Feature 3: Time-Angle View (Dagsmönster)

### Purpose

An alternative visualization mode where the **angle represents hour of day** (0–23h)
and the **radius represents days back in time** (center = oldest, edge = today).
This reveals recurring daily wind patterns — e.g. sea breezes that appear every
afternoon, or calm mornings.

### YAML key

```yaml
view_mode: spiral      # default — existing polar spiral
# or:
view_mode: daily       # new time-angle mode
```

When `view_mode: daily` the card switches to the new coordinate system.
All other settings (`hours`, `num_points`, zoom, etc.) remain active.

### Coordinate system

```
theta = (hour_of_day / 24) × 2π        // angle = time of day
                                         // midnight = top (North position)
r     = 1 - (days_ago / max_days)       // radius = recency
                                         // center = oldest, edge = today
```

Where:
- `hour_of_day` = local hour extracted from point's timestamp
- `days_ago` = `(t_now - point.ts) / 86_400_000`
- `max_days` = `viewHours / 24`

```javascript
const hourOfDay  = new Date(p.ts).getHours() + new Date(p.ts).getMinutes() / 60;
const theta      = (hourOfDay / 24) * 2 * Math.PI - Math.PI / 2;  // midnight = up
const daysAgo    = (Date.now() - p.ts) / 86_400_000;
const r          = 1 - (daysAgo / (viewHours / 24));
const x          = cx + r * max_radius * Math.cos(theta);
const y          = cy + r * max_radius * Math.sin(theta);
```

### Canvas elements (replaces spiral-specific elements)

The following change in `daily` mode:

1. **Concentric rings** — same 4 rings at r = 0.25/0.5/0.75/1.0
   - Labels change: outermost = `I18N[lang].today`, others = `-Xd` (days back)
   - Formula: `label_i = -${(max_days × (1 - (i+1)/4)).toFixed(1)}d`, outermost = `Idag/Today`

2. **Radial lines** — 24 lines (one per hour) instead of 8 compass lines
   - Every 6th line (0h, 6h, 12h, 18h) is slightly brighter: `rgba(255,255,255,0.12)`
   - Others: `rgba(255,255,255,0.05)`

3. **Hour labels** — at outer edge, every 3 hours: `00`, `03`, `06`, `09`, `12`, `15`, `18`, `21`
   - Font: 11px, color `rgba(255,255,255,0.5)`

4. **Data points** — same color scale and dot size as spiral mode, just different position

5. **Connecting lines** — connect consecutive points **only if** they are within the same
   calendar day (i.e. same `getDate()` value) to avoid lines crossing midnight

6. **Legend** — identical to spiral mode

7. **Status text** — replace `"Visar: Xh"` with `"Visar: X dygn"` / `"Showing: X days"`

### Mode toggle in GUI

Add a toggle button in `pw-controls` to switch between modes:

```html
<button id="pw-mode">🔄</button>
```

- Clicking toggles `this._viewMode` between `'spiral'` and `'daily'`
- Initial value from `config.view_mode` (default `'spiral'`)
- Button tooltip (title attribute): `"Byt visningsläge / Toggle view mode"`
- No fetch needed on toggle — rebuckets from cache and redraws

### i18n strings to add

```javascript
sv: {
  today:       'Idag',
  days:        'dygn',
  modeSpiral:  'Spiral',
  modeDaily:   'Dagsmönster',
}
en: {
  today:       'Today',
  days:        'days',
  modeSpiral:  'Spiral',
  modeDaily:   'Daily pattern',
}
```

### State variable

```javascript
this._viewMode  // 'spiral' | 'daily', initialised from config.view_mode
```

### Acceptance criteria

- [ ] `view_mode: daily` activates daily pattern mode on load
- [ ] `view_mode: spiral` (or absent) uses existing spiral mode
- [ ] Mode toggle button visible in controls row
- [ ] Clicking toggle switches mode and redraws without fetching
- [ ] `this._viewMode` state survives zoom and data refresh
- [ ] In daily mode: angle = hour of day, midnight at top, noon at bottom
- [ ] In daily mode: radius = recency, center = oldest, edge = today
- [ ] 24 radial hour lines, every 6th brighter
- [ ] Hour labels at 0/3/6/9/12/15/18/21
- [ ] Ring labels show days back (e.g. `-1.5d`, `-1.0d`, `-0.5d`, `Idag`)
- [ ] Connecting lines only within same calendar day
- [ ] Status text shows days instead of hours in daily mode
- [ ] Dot color scale identical to spiral mode
- [ ] Legend identical to spiral mode
- [ ] Zoom wheel works in daily mode (changes viewHours → max_days updates)

---

## Summary of new YAML keys

| Key             | Type    | Default    | Description                              |
|-----------------|---------|------------|------------------------------------------|
| `show_max_wind` | boolean | `false`    | Highlight max wind point with ring+label |
| `show_wind_rose`| boolean | `false`    | Wind rose frequency overlay              |
| `view_mode`     | string  | `'spiral'` | `'spiral'` or `'daily'`                  |

## Summary of new i18n strings

| Key          | sv             | en              |
|--------------|----------------|-----------------|
| `maxWind`    | Maxvind        | Max wind        |
| `windRose`   | Vindros        | Wind rose       |
| `today`      | Idag           | Today           |
| `days`       | dygn           | days            |
| `modeSpiral` | Spiral         | Spiral          |
| `modeDaily`  | Dagsmönster    | Daily pattern   |

