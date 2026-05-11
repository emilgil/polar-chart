# polar-chart

A Home Assistant Lovelace custom card that displays wind history as a polar spiral.
Wind direction determines the angle, time determines the radius (center = oldest, edge = now),
and wind speed determines the color of each data point.

## Features

- **Polar spiral** visualization with compass rose
- **Daily pattern view** (`view_mode: daily` or 🔄 button) — angle = hour-of-day, radius = days back, for spotting recurring daily wind patterns
- **Continuous color gradient** between 5 anchor points based on wind speed
- **Wind rose overlay** (🌹 toggle) — sector frequency distribution behind the spiral
- **Max wind marker** (⚡ toggle) — animated ring + label on the strongest measurement in view
- **Mouse wheel zoom** — scroll in for higher resolution, scroll out for up to 7 days
- **Progressive loading** — fast initial render, full 7-day cache filled in background
- **Auto-detect** of language (from HA locale) and speed unit (from sensor `unit_of_measurement`)
- **No token in YAML** — auth comes from the Lovelace `hass` object

## Installation

### 1. Copy the card file to Home Assistant

```bash
scp polar-chart.js hassio:/config/www/
```

(Replace `hassio` with your own SSH alias / `user@host:path`, or copy via Samba / HA File Editor.)

### 2. Register as a Lovelace resource

In Home Assistant: **Settings → Dashboards → (three-dot menu) → Resources → Add resource**

| Field | Value |
|-------|-------|
| URL   | `/local/polar-chart.js?v=1` |
| Type  | JavaScript module |

The `?v=1` suffix lets you bypass aggressive browser cache after deploys — bump it to `?v=2`, `?v=3`, etc. each time the JS changes.

Reload the browser after adding the resource.

### 3. Add the card to a dashboard

In Lovelace, add a new card and choose **Manual** (YAML editor), then paste:

```yaml
type: custom:polar-chart
bearing_sensor: sensor.your_wind_bearing
speed_sensor: sensor.your_wind_strength
```

That's the minimum — everything else is optional.

## Configuration

| Key              | Required | Default       | Description |
|------------------|----------|---------------|-------------|
| `bearing_sensor` | ✅       | —             | Entity ID for wind direction (degrees 0–360) |
| `speed_sensor`   | ✅       | —             | Entity ID for wind speed |
| `hours`          | ❌       | `12`          | Initial time window in hours |
| `num_points`     | ❌       | `100`         | Number of buckets for the rebucketed display |
| `speed_unit`     | ❌       | auto-detect   | Override sensor unit. Allowed: `m/s`, `km/h`, `mph`, `knop` |
| `language`       | ❌       | auto-detect   | UI language. Allowed: `sv`, `en`. Defaults to HA locale, falls back to `sv` |
| `view_mode`      | ❌       | `spiral`      | Initial view: `spiral` or `daily` |

The card uses the `hass` object that Lovelace already injects, so you don't need
`ha_url` or `ha_token` in the config.

## Color scale

Speed is mapped via a smooth gradient between 5 anchor points (no hard steps).
Color thresholds are always evaluated in m/s; legend tick values are converted
to your configured unit at draw time.

| Color  | Speed (m/s) | Label (sv / en)        |
|--------|-------------|------------------------|
| 🔵 Blue   | 0     | Lugnt / Calm        |
| 🟢 Green  | 3     | Lätt / Light        |
| 🟡 Yellow | 8     | Måttligt / Moderate |
| 🟠 Orange | 14    | Friskt / Fresh      |
| 🔴 Red    | 20+   | Hård vind / Storm   |

## Usage

- **🔃 Uppdatera / Update** — re-fetch from HA and redraw
- **⚡ pw-maxwind** — toggle the max-wind marker (with pulse animation)
- **🌹 pw-windrose** — toggle the wind-rose frequency overlay
- **🔄 pw-mode** — toggle between spiral and daily-pattern mode
- **Hours / Datapoints inputs** — change time window or bucket count
- **Mouse wheel** on the canvas — zoom in/out (0.5h to 168h)
- **Auto-refresh** every 10 minutes

## Development

```bash
git clone git@github.com:emilgil/polar-chart.git
cd polar-chart
claude   # start Claude Code, or edit the JS directly
```

To deploy after changes:

```bash
scp polar-chart.js hassio:/config/www/
```

Then hard-reload the browser (Ctrl+F5 or Shift+F5) and bump the `?v=` suffix
on the Lovelace resource to bypass cache.
