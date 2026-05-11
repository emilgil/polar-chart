# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Home Assistant Lovelace custom card that displays wind history as a polar spiral visualization. Wind direction determines angle, time determines radius (center = oldest, edge = now), and wind speed determines color.

## Key Files

- `polar-chart.js` - The custom card implementation (deploy to `/config/www/`)
- `polar-wind-card-spec.md` - Detailed implementation specification with acceptance criteria

## Development Commands

Deploy to Home Assistant:
```bash
scp polar-chart.js hassio:/config/www/
```

The `hassio` alias is defined in `~/.ssh/config` (HostName 192.168.1.97, User root, IdentityFile id_ed25519).

After deployment, hard reload the browser (Ctrl+F5 or Shift+F5) to pick up changes.

## Architecture

This is a standalone Web Component with no build process or external dependencies.

### Lovelace Card Lifecycle (Critical)

Lovelace calls `setConfig()` **before** `connectedCallback()`. Therefore:
- DOM and shadow root must be initialized in `setConfig()`, not `connectedCallback()`
- `connectedCallback()` must guard against `_config` being undefined

### Required Methods

- `setConfig(config)` - Validate config, build shadow DOM, initialize state
- `set hass(hass)` - Must exist (HA card contract) but not used for data fetching
- `connectedCallback()` - Start data loading and auto-refresh interval
- `disconnectedCallback()` - Clear interval
- `getCardSize()` - Return 5 for layout calculations

### Data Flow

1. **Stage 1 (fast paint)**: Fetch `viewHours` of data → populate cache → draw
2. **Stage 2 (background)**: Fetch 168h silently → merge into cache → redraw

Loading overlay only shown during Stage 1 when cache is empty.

### State Properties

```javascript
this._config       // validated config
this._viewHours    // current visible time window (float)
this._cache        // { raw: [], fetchedAt, fetchedHours }
this._fetching     // boolean fetch guard
this._interval     // auto-refresh handle
```

## Configuration (YAML)

```yaml
type: custom:polar-chart
ha_url: http://192.168.1.97:8123        # required
ha_token: YOUR_LONG_LIVED_TOKEN_HERE    # required
bearing_sensor: sensor.wind_bearing     # required, degrees 0-360
speed_sensor: sensor.wind_speed         # required, m/s assumed
hours: 12                               # optional, default 12
num_points: 100                         # optional, default 100
```

## Wind Speed Color Scale (m/s)

| Speed | Color | Label |
|-------|-------|-------|
| 0-3 | #60a5fa (blue) | Lugnt |
| 3-8 | #4ade80 (green) | Lätt |
| 8-14 | #facc15 (yellow) | Måttligt |
| 14-20 | #fb923c (orange) | Friskt |
| 20+ | #f87171 (red) | Hård vind |

## Coordinate System

- North (0°) = up, East (90°) = right
- `r = (timestamp - t_start) / (t_now - t_start)` where 0 = viewHours ago, 1 = now
- `x = cx + r × max_radius × sin(theta)`
- `y = cy - r × max_radius × cos(theta)`

## API Endpoint

```
GET {ha_url}/api/history/period/{iso_start}
  ?filter_entity_id={bearing_sensor},{speed_sensor}
  &minimal_response=true
  &significant_changes_only=false
```

Authorization: `Bearer {ha_token}`

## UI Labels (Swedish)

- "Timmar bakåt" - Hours back
- "Datapunkter" - Data points
- "Uppdatera" - Update button
- "Hämtar data…" - Loading indicator
- "Kunde inte hämta data" - Fetch error message
- "Uppdaterad:" - Last updated timestamp
- "Visar:" - Currently showing
