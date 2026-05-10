# polar-wind-card

A Home Assistant Lovelace custom card that displays wind history as a polar spiral.
Wind direction determines the angle, time determines the radius (center = oldest, edge = now),
and wind speed determines the color of each data point.

## Features

- Polar spiral visualization with compass rose
- Configurable time window and number of data points
- Mouse wheel zoom (scroll in = higher resolution, scroll out = longer history)
- Progressive loading — fast initial render, full 7-day cache in background
- All settings configured via Lovelace YAML — no editing of JS needed

## Installation

### 1. Copy the card file to Home Assistant

```bash
scp polar-wind-card.js homeassistant@192.168.1.97:/config/www/
```

Or copy manually to `/config/www/polar-wind-card.js` via the HA file editor or Samba share.

### 2. Register as a Lovelace resource

In Home Assistant:
**Settings → Dashboards → (three-dot menu) → Resources → Add resource**

| Field | Value |
|-------|-------|
| URL   | `/local/polar-wind-card.js` |
| Type  | JavaScript module |

Reload the browser after adding the resource.

### 3. Add the card to a dashboard

In Lovelace, add a new card and choose **Manual** (YAML editor), then paste:

```yaml
type: custom:polar-wind-card
ha_url: http://192.168.1.97:8123
ha_token: YOUR_LONG_LIVED_TOKEN_HERE
bearing_sensor: sensor.subbeberget_wind_bearing
speed_sensor: sensor.subbeberget_wind_strength
hours: 12
num_points: 100
```

### Generating a Long-Lived Access Token

In Home Assistant:
**Profile (bottom-left) → Security → Long-lived access tokens → Create token**

Copy the token and paste it as the value of `ha_token` in the card config.

## Configuration

| Key              | Required | Default | Description |
|------------------|----------|---------|-------------|
| `ha_url`         | ✅       | —       | Full URL to your HA instance, e.g. `http://192.168.1.97:8123` |
| `ha_token`       | ✅       | —       | Long-lived access token |
| `bearing_sensor` | ✅       | —       | Entity ID for wind direction sensor (degrees 0–360) |
| `speed_sensor`   | ✅       | —       | Entity ID for wind speed sensor (m/s) |
| `hours`          | ❌       | `12`    | Initial time window in hours |
| `num_points`     | ❌       | `100`   | Number of data points to display |

> **Note:** The color scale assumes wind speed in **m/s**.
> If your sensor reports knots or km/h the color thresholds will be inaccurate.

## Color scale

| Color  | Speed (m/s) | Label     |
|--------|-------------|-----------|
| 🔵 Blue   | 0 – 3    | Lugnt     |
| 🟢 Green  | 3 – 8    | Lätt      |
| 🟡 Yellow | 8 – 14   | Måttligt  |
| 🟠 Orange | 14 – 20  | Friskt    |
| 🔴 Red    | 20+      | Hård vind |

## Usage

- **Scroll up** on the canvas to zoom in (fewer hours, higher resolution)
- **Scroll down** to zoom out (more hours, up to 168h / 7 days)
- Edit the **Timmar bakåt** or **Datapunkter** inputs and click **Uppdatera** to change settings
- The card auto-refreshes every 10 minutes

## Development

```bash
git clone <your-repo>
cd polar-wind-card
claude   # start Claude Code
```

To deploy after changes:
```bash
scp polar-wind-card.js homeassistant@192.168.1.97:/config/www/
```

Then do a hard reload in the browser (Ctrl+Shift+R) to pick up the new version.
