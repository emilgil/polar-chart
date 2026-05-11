/*
 * polar-chart.js — Home Assistant Lovelace custom card
 *
 * Visualises any two HA sensors as a polar time-spiral:
 *   angle (required)  → angular position
 *   color (optional)  → dot color via a configurable palette
 *
 * INSTALLATION
 * 1. Copy this file to /config/www/polar-chart.js
 * 2. In Lovelace: Settings → Dashboards → Resources → Add resource
 *      URL:  /local/polar-chart.js
 *      Type: JavaScript module
 * 3. Reload the browser, then add a card.
 *
 * BACKWARDS COMPATIBLE — legacy wind config keeps working unchanged:
 *
 *   type: custom:polar-chart
 *   bearing_sensor: sensor.your_bearing
 *   speed_sensor:   sensor.your_speed
 *
 * GENERIC config:
 *
 *   type: custom:polar-chart
 *   angle:
 *     sensor: sensor.x
 *     min: 0
 *     max: 360
 *     cyclic: true
 *     labels: { 0: "N", 90: "E", 180: "S", 270: "W" }
 *   color:                       # optional
 *     sensor: sensor.y
 *     min: 0
 *     max: 100
 *     unit: "%"
 *     palette:
 *       - { value: 0,   color: "#60a5fa" }
 *       - { value: 50,  color: "#facc15" }
 *       - { value: 100, color: "#f87171" }
 *   refresh_interval: 10         # optional, minutes (>=1, default 10)
 *
 * No ha_url or ha_token needed — auth is handled via the Lovelace hass object.
 * Daily-pattern view is only available for legacy wind configs.
 * Wind-rose overlay is only shown when angle is a full 0–360 cyclic axis.
 */

const CACHE_HORIZON_H = 168;

// 10° gap at top for non-cyclic angle axes (between max and min endpoints)
const NON_CYCLIC_GAP_RAD = 10 * Math.PI / 180;

const TO_MS = {
  'm/s':  1.0,
  'km/h': 1 / 3.6,
  'mph':  0.44704,
  'knop': 0.514444,
};

const FROM_MS = {
  'm/s':  1,
  'km/h': 3.6,
  'mph':  2.23694,
  'knop': 1.94384,
};

// HA reports knots as "kn"; map to internal key "knop".
const HA_UNIT_MAP = {
  'm/s':  'm/s',
  'km/h': 'km/h',
  'mph':  'mph',
  'kn':   'knop',
};

// Default wind palette (m/s) — used by legacy normalization
const LEGACY_WIND_PALETTE = [
  { value: 0,  color: '#60a5fa' },
  { value: 3,  color: '#4ade80' },
  { value: 8,  color: '#facc15' },
  { value: 14, color: '#fb923c' },
  { value: 20, color: '#f87171' },
];

const LEGACY_WIND_LABELS = {
  0: 'N', 45: 'NE', 90: 'E', 135: 'SE',
  180: 'S', 225: 'SW', 270: 'W', 315: 'NW',
};

const I18N = {
  sv: {
    hoursLabel:  'Timmar bakåt',
    pointsLabel: 'Datapunkter',
    applyButton: 'Uppdatera',
    legendTitle: 'Vind',
    loading:     'Hämtar data…',
    fetchError:  'Kunde inte hämta data',
    updated:     'Uppdaterad',
    showing:     'Visar',
    points:      'punkter',
    now:         'Nu',
    speedLabels: ['Lugnt', 'Lätt', 'Måttligt', 'Friskt', 'Hård vind'],
    unitName:    { 'm/s': 'm/s', 'km/h': 'km/h', 'mph': 'mph', 'knop': 'knop' },
    maxWindBtn:  'Visa max',
    windRoseBtn: 'Visa vindros',
    today:       'Idag',
    days:        'dygn',
  },
  en: {
    hoursLabel:  'Hours back',
    pointsLabel: 'Data points',
    applyButton: 'Update',
    legendTitle: 'Wind',
    loading:     'Loading…',
    fetchError:  'Could not fetch data',
    updated:     'Updated',
    showing:     'Showing',
    points:      'points',
    now:         'Now',
    speedLabels: ['Calm', 'Light', 'Moderate', 'Fresh', 'Storm'],
    unitName:    { 'm/s': 'm/s', 'km/h': 'km/h', 'mph': 'mph', 'knop': 'knots' },
    maxWindBtn:  'Show max',
    windRoseBtn: 'Show wind rose',
    today:       'Today',
    days:        'days',
  },
};

function _hexToRgb(hex) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

function _valueToRgb(value, palette) {
  if (!palette || palette.length === 0) return { r: 150, g: 150, b: 150 };
  const stops = palette.map(s => ({ value: s.value, ...(_hexToRgb(s.color)) }));
  if (stops.length === 1 || value <= stops[0].value) {
    const s = stops[0];
    return { r: s.r, g: s.g, b: s.b };
  }
  const last = stops[stops.length - 1];
  if (value >= last.value) return { r: last.r, g: last.g, b: last.b };
  const hi = stops.findIndex(s => s.value > value);
  const lo = stops[hi - 1];
  const f = (value - lo.value) / (stops[hi].value - lo.value);
  return {
    r: Math.round(lo.r + f * (stops[hi].r - lo.r)),
    g: Math.round(lo.g + f * (stops[hi].g - lo.g)),
    b: Math.round(lo.b + f * (stops[hi].b - lo.b)),
  };
}

function _valueToColorString(value, palette) {
  const c = _valueToRgb(value, palette);
  return `rgb(${c.r},${c.g},${c.b})`;
}

// value → angle in radians, where theta=0 means "up" (north) and increases clockwise.
// Cyclic: full 360°, min and max coincide.
// Non-cyclic: full 360° minus a small gap at top, so min and max are visually distinct.
function _valueToTheta(value, min, max, cyclic) {
  const norm = (value - min) / (max - min);
  if (cyclic) return norm * 2 * Math.PI;
  return NON_CYCLIC_GAP_RAD / 2 + norm * (2 * Math.PI - NON_CYCLIC_GAP_RAD);
}

function _findMaxColorPoint(buckets) {
  if (!buckets || buckets.length === 0) return null;
  let max = null;
  for (const p of buckets) {
    if (p.color == null || !isFinite(p.color)) continue;
    if (!max || p.color > max.color) max = p;
  }
  return max;
}

function _computeAngleRose(buckets, angleConfig, numSectors = 16) {
  const counts = new Array(numSectors).fill(0);
  const range = angleConfig.max - angleConfig.min;
  for (const p of buckets) {
    if (p.angle == null || !isFinite(p.angle)) continue;
    const norm = ((p.angle - angleConfig.min) % range + range) % range / range;
    const i = Math.floor(norm * numSectors) % numSectors;
    counts[i]++;
  }
  const max = Math.max(...counts, 1);
  return counts.map(c => c / max);
}

// Parse a bucket spec like "15m", "30m", "1h", "12h", "1d" (or legacy "hour")
// into milliseconds. Returns null if invalid or undefined.
function _parseBucket(spec) {
  if (spec == null) return null;
  if (spec === 'hour') return 3_600_000;
  const m = String(spec).trim().match(/^(\d+(?:\.\d+)?)\s*(m|min|h|hour|hours|d|day|days)?$/i);
  if (!m) throw new Error(
    `polar-chart: invalid bucket "${spec}". Examples: "15m", "30m", "1h", "12h", "1d"`
  );
  const n = parseFloat(m[1]);
  const unit = (m[2] || 'm').toLowerCase();
  let ms;
  if (unit === 'm' || unit === 'min') ms = n * 60_000;
  else if (unit === 'h' || unit === 'hour' || unit === 'hours') ms = n * 3_600_000;
  else if (unit === 'd' || unit === 'day' || unit === 'days') ms = n * 86_400_000;
  else ms = n * 60_000;
  if (!isFinite(ms) || ms < 60_000) {
    throw new Error(`polar-chart: bucket "${spec}" must be at least 1 minute`);
  }
  return ms;
}

function _resolveLanguage(config, hass) {
  if (config.language) return config.language;
  const supported = Object.keys(I18N);
  const locale = hass?.locale?.language?.split('-')[0]?.toLowerCase();
  if (locale && supported.includes(locale)) return locale;
  return 'sv';
}

function _resolveColorUnit(config, hass) {
  if (!config.color?.sensor) return '';
  if (config._isLegacyWind) {
    if (config._legacySpeedUnitOverride) return config._legacySpeedUnitOverride;
    const haUnit = hass?.states?.[config.color.sensor]?.attributes?.unit_of_measurement;
    if (haUnit && HA_UNIT_MAP[haUnit]) return HA_UNIT_MAP[haUnit];
    return 'm/s';
  }
  if (config.color.unit) return config.color.unit;
  const haUnit = hass?.states?.[config.color.sensor]?.attributes?.unit_of_measurement;
  return haUnit || '';
}

function _normalizeConfig(config) {
  if (!config) throw new Error('polar-chart: missing config');

  const isLegacy = !!(config.bearing_sensor || config.speed_sensor);

  if (isLegacy) {
    // bearing_sensor is optional in daily mode (angle comes from timestamp hour),
    // but still required for spiral mode when speed_sensor is set.
    const isDailyNoBearing = config.view_mode === 'daily' && !config.bearing_sensor;
    if (!config.bearing_sensor && !isDailyNoBearing) {
      throw new Error(
        'polar-chart: bearing_sensor is required when speed_sensor is set ' +
        '(except when view_mode is "daily")'
      );
    }
    if (config.speed_unit !== undefined && !(config.speed_unit in TO_MS)) {
      throw new Error(
        `polar-chart: invalid speed_unit "${config.speed_unit}". ` +
        `Allowed: ${Object.keys(TO_MS).join(', ')}`
      );
    }
    return {
      angle: config.bearing_sensor ? {
        sensor: config.bearing_sensor,
        min: 0, max: 360, cyclic: true,
        labels: { ...LEGACY_WIND_LABELS },
      } : undefined,
      color: config.speed_sensor ? {
        sensor: config.speed_sensor,
        min: 0, max: 20,
        palette: LEGACY_WIND_PALETTE.map(s => ({ ...s })),
        legend: LEGACY_WIND_PALETTE.map((s, i) => ({ value: s.value, labelIndex: i })),
      } : undefined,
      hours: config.hours,
      num_points: config.num_points,
      language: config.language,
      view_mode: config.view_mode,
      refresh_interval: config.refresh_interval,
      bucket: config.bucket,
      line_width: config.line_width,
      dot_size: config.dot_size,
      _isLegacyWind: true,
      _legacySpeedUnitOverride: config.speed_unit,
    };
  }

  return {
    angle: config.angle ? { ...config.angle } : undefined,
    color: config.color ? { ...config.color } : undefined,
    hours: config.hours,
    num_points: config.num_points,
    language: config.language,
    view_mode: config.view_mode,
    refresh_interval: config.refresh_interval,
    bucket: config.bucket,
    line_width: config.line_width,
    dot_size: config.dot_size,
    _isLegacyWind: false,
  };
}

class PolarChart extends HTMLElement {
  setConfig(config) {
    const cfg = _normalizeConfig(config);

    let view_mode = cfg.view_mode || 'spiral';
    if (view_mode !== 'spiral' && view_mode !== 'daily') {
      throw new Error(
        `polar-chart: invalid view_mode "${view_mode}". Allowed: "spiral", "daily"`
      );
    }
    // angle is optional in daily mode (angle is computed from timestamp hour);
    // required in all other modes.
    const isDailyNoAngle = view_mode === 'daily' && !cfg.angle;
    if (!isDailyNoAngle) {
      if (!cfg.angle || !cfg.angle.sensor) {
        throw new Error('polar-chart: angle.sensor is required');
      }
      if (cfg.angle.min == null || cfg.angle.max == null) {
        throw new Error('polar-chart: angle.min and angle.max are required');
      }
      if (cfg.angle.min >= cfg.angle.max) {
        throw new Error('polar-chart: angle.min must be less than angle.max');
      }
      cfg.angle.cyclic = !!cfg.angle.cyclic;
    }
    if (cfg.color !== undefined) {
      if (!cfg.color.sensor) {
        throw new Error('polar-chart: color.sensor is required when color block is present');
      }
      if (!Array.isArray(cfg.color.palette) || cfg.color.palette.length < 2) {
        throw new Error('polar-chart: color.palette must have at least 2 entries');
      }
      if (cfg.color.min == null || cfg.color.max == null) {
        throw new Error('polar-chart: color.min and color.max are required');
      }
    }
    if (cfg.line_width !== undefined) {
      const lw = Number(cfg.line_width);
      if (!isFinite(lw) || lw < 0) {
        throw new Error(`polar-chart: invalid line_width "${cfg.line_width}". Must be a number >= 0`);
      }
      cfg.line_width = lw;
    }
    if (cfg.dot_size !== undefined) {
      const ds = Number(cfg.dot_size);
      if (!isFinite(ds) || ds < 0) {
        throw new Error(`polar-chart: invalid dot_size "${cfg.dot_size}". Must be a number >= 0`);
      }
      cfg.dot_size = ds;
    }
    this._bucketMs = _parseBucket(cfg.bucket);
    if (cfg.language !== undefined && !(cfg.language in I18N)) {
      throw new Error(
        `polar-chart: invalid language "${cfg.language}". ` +
        `Allowed: ${Object.keys(I18N).join(', ')}`
      );
    }

    cfg.hours = Number(cfg.hours) || 12;
    cfg.num_points = Number(cfg.num_points) || 100;
    cfg.view_mode = view_mode;

    if (cfg.refresh_interval !== undefined) {
      const ri = Number(cfg.refresh_interval);
      if (!isFinite(ri) || ri < 1) {
        throw new Error(
          `polar-chart: invalid refresh_interval "${cfg.refresh_interval}". ` +
          `Must be a number >= 1 (minutes).`
        );
      }
      cfg.refresh_interval = ri;
    } else {
      cfg.refresh_interval = 10;
    }

    this._config = cfg;
    this._viewMode = view_mode;
    this._showMaxWind = false;
    this._showWindRose = false;

    this._viewHours = cfg.hours;
    this._cache = { raw: null, fetchedAt: null, fetchedHours: null };
    this._fetching = false;
    this._fetchError = false;
    this._hasStarted = false;

    if (!this.shadowRoot) this._buildDOM();

    this.shadowRoot.getElementById('pw-hours').value = this._viewHours;
    this.shadowRoot.getElementById('pw-points').value = cfg.num_points;

    this._maybeStart();
  }

  set hass(hass) {
    this._hass = hass;
    this._maybeStart();
  }

  _maybeStart() {
    if (this._hasStarted || !this._hass || !this._config) return;
    this._hasStarted = true;
    this._lang      = _resolveLanguage(this._config, this._hass);
    this._colorUnit = _resolveColorUnit(this._config, this._hass);
    this._applyI18n();
    this._applyButtonVisibility();
    this._startLoading();
    const refreshMs = (this._config.refresh_interval || 10) * 60 * 1000;
    this._interval = setInterval(() => this._invalidateAndFetch(), refreshMs);
  }

  connectedCallback() {
    if (!this._resizeObserver && this.shadowRoot) {
      const canvas = this.shadowRoot.getElementById('pw-canvas');
      this._resizeObserver = new ResizeObserver(() => this._redrawFromCache());
      this._resizeObserver.observe(canvas);
    }
  }

  disconnectedCallback() {
    clearInterval(this._interval);
    this._stopMaxWindAnimation();
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
  }

  getCardSize() { return 5; }

  _buildDOM() {
    this.attachShadow({ mode: 'open' });
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        #pw-card { background: #1e2130; border-radius: 8px; padding: 8px; }
        #pw-controls {
          display: flex; gap: 16px; align-items: center;
          padding: 8px 4px; font-size: 13px; color: #ccc; flex-wrap: wrap;
        }
        #pw-controls input {
          background: #2a2e3f; color: #eee; border: 1px solid #444;
          border-radius: 4px; padding: 2px 6px; width: 70px;
        }
        #pw-controls button {
          background: #3b82f6; color: #fff; border: none;
          border-radius: 4px; padding: 4px 12px; cursor: pointer;
          font-size: 13px;
        }
        #pw-controls button:hover { background: #2563eb; }
        #pw-maxwind, #pw-windrose, #pw-mode { background: #444; }
        #pw-maxwind:hover, #pw-windrose:hover, #pw-mode:hover { background: #555; }
        #pw-maxwind.active, #pw-windrose.active { background: #3b82f6; }
        #pw-maxwind.active:hover, #pw-windrose.active:hover { background: #2563eb; }
        #pw-canvas { display: block; width: 100%; aspect-ratio: 1/1; cursor: crosshair; }
      </style>
      <div id="pw-card">
        <div id="pw-controls">
          <label id="pw-label-hours">_<input id="pw-hours" type="number" min="0.5" max="168" step="0.5"></label>
          <label id="pw-label-points">_<input id="pw-points" type="number" min="10" max="500"></label>
          <button id="pw-apply" title="">🔃</button>
          <button id="pw-maxwind" title="">⚡</button>
          <button id="pw-windrose" title="">🌹</button>
          <button id="pw-mode" title="Byt visningsläge / Toggle view mode">🔄</button>
        </div>
        <canvas id="pw-canvas"></canvas>
      </div>
    `;

    const sr = this.shadowRoot;
    const hoursInput = sr.getElementById('pw-hours');
    const pointsInput = sr.getElementById('pw-points');
    const applyBtn = sr.getElementById('pw-apply');
    const maxwindBtn = sr.getElementById('pw-maxwind');
    const windroseBtn = sr.getElementById('pw-windrose');
    const modeBtn = sr.getElementById('pw-mode');
    const canvas = sr.getElementById('pw-canvas');

    hoursInput.addEventListener('change', () => {
      const v = parseFloat(hoursInput.value);
      if (!isFinite(v) || v <= 0) return;
      this._viewHours = Math.min(168, Math.max(0.5, v));
      hoursInput.value = this._viewHours;
      this._redrawFromCache();
      if (this._cache.fetchedHours != null && this._viewHours > this._cache.fetchedHours) {
        this._fetchRange(CACHE_HORIZON_H).then(() => this._redrawFromCache());
      }
    });

    pointsInput.addEventListener('change', () => {
      const v = parseInt(pointsInput.value, 10);
      if (!isFinite(v) || v < 1) return;
      this._config.num_points = Math.min(500, Math.max(10, v));
      pointsInput.value = this._config.num_points;
      this._redrawFromCache();
    });

    applyBtn.addEventListener('click', () => {
      this._invalidateAndFetch();
    });

    modeBtn.addEventListener('click', () => {
      // Without an angle sensor, spiral mode has no meaningful theta — stay in daily.
      if (!this._config.angle && this._viewMode === 'daily') return;
      this._viewMode = this._viewMode === 'spiral' ? 'daily' : 'spiral';
      this._redrawFromCache();
    });

    maxwindBtn.addEventListener('click', () => {
      this._showMaxWind = !this._showMaxWind;
      maxwindBtn.classList.toggle('active', this._showMaxWind);
      if (this._showMaxWind) {
        this._startMaxWindAnimation();
      } else {
        this._stopMaxWindAnimation();
        this._redrawFromCache();
      }
    });

    windroseBtn.addEventListener('click', () => {
      this._showWindRose = !this._showWindRose;
      windroseBtn.classList.toggle('active', this._showWindRose);
      this._redrawFromCache();
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      this._viewHours = Math.min(168, Math.max(0.5, this._viewHours * factor));
      hoursInput.value = this._viewHours.toFixed(1);
      this._redrawFromCache();
      if (this._cache.fetchedHours != null && this._viewHours > this._cache.fetchedHours) {
        this._fetchRange(CACHE_HORIZON_H).then(() => this._redrawFromCache());
      }
    }, { passive: false });
  }

  _applyI18n() {
    const t = I18N[this._lang];
    const sr = this.shadowRoot;
    if (!sr) return;
    sr.getElementById('pw-label-hours').firstChild.textContent = t.hoursLabel + ': ';
    sr.getElementById('pw-label-points').firstChild.textContent = t.pointsLabel + ': ';
    sr.getElementById('pw-apply').title = t.applyButton;
    sr.getElementById('pw-maxwind').title = t.maxWindBtn;
    sr.getElementById('pw-windrose').title = t.windRoseBtn;
  }

  _applyButtonVisibility() {
    const sr = this.shadowRoot;
    if (!sr) return;
    const cfg = this._config;
    const a = cfg.angle;

    // Max-wind toggle: only meaningful when there's a color sensor to find max of.
    sr.getElementById('pw-maxwind').style.display = cfg.color ? '' : 'none';

    // Wind rose: only for full-circle compass-style angle axes (requires angle sensor).
    const isCompass = !!a && a.cyclic && a.min === 0 && a.max === 360;
    sr.getElementById('pw-windrose').style.display = isCompass ? '' : 'none';

    // Daily-pattern toggle: wind-specific. Hidden when there's no angle sensor
    // (in that case the card is locked in daily mode — spiral would have nothing to plot).
    const showModeToggle = cfg._isLegacyWind && !!a;
    sr.getElementById('pw-mode').style.display = showModeToggle ? '' : 'none';
  }

  _startMaxWindAnimation() {
    if (this._maxWindRaf) return;
    const tick = () => {
      if (!this._showMaxWind) {
        this._maxWindRaf = null;
        return;
      }
      this._draw();
      this._maxWindRaf = requestAnimationFrame(tick);
    };
    this._maxWindRaf = requestAnimationFrame(tick);
  }

  _stopMaxWindAnimation() {
    if (this._maxWindRaf) {
      cancelAnimationFrame(this._maxWindRaf);
      this._maxWindRaf = null;
    }
  }

  async _startLoading() {
    this._fetchError = false;
    await this._fetchRange(this._viewHours);
    this._redrawFromCache();
    if (!this._fetchError) {
      this._fetchRange(CACHE_HORIZON_H).then(() => this._redrawFromCache());
    }
  }

  _invalidateAndFetch() {
    this._cache = { raw: null, fetchedAt: null, fetchedHours: null };
    this._startLoading();
  }

  async _fetchRange(hours) {
    if (this._fetching) return;
    if (!this._hass) return;
    this._fetching = true;

    try {
      const t_now = Date.now();
      const t_start_iso = new Date(t_now - hours * 3_600_000).toISOString();
      const t_end_iso = new Date(t_now).toISOString();
      // end_time is required: HA's /api/history/period/{start} defaults to a
      // 24h window from start, NOT "to now".
      const sensors = [];
      if (this._config.angle?.sensor) sensors.push(this._config.angle.sensor);
      if (this._config.color?.sensor) sensors.push(this._config.color.sensor);
      const path =
        `/api/history/period/${t_start_iso}` +
        `?filter_entity_id=${sensors.map(encodeURIComponent).join(',')}` +
        `&end_time=${encodeURIComponent(t_end_iso)}` +
        `&minimal_response=true&significant_changes_only=false`;
      const url = typeof this._hass.hassUrl === 'function'
        ? this._hass.hassUrl(path)
        : (this._hass.hassUrl || '') + path;
      const token = this._hass.auth?.data?.access_token;

      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      const raw = this._parseHistory(data);
      if (raw.length > 0) {
        this._cache.raw = raw;
        this._cache.fetchedHours = hours;
      }
      this._cache.fetchedAt = Date.now();
      this._fetchError = false;
    } catch (err) {
      console.error('polar-chart: fetch failed', err);
      if (!this._cache.raw) this._fetchError = true;
    } finally {
      this._fetching = false;
    }
  }

  _parseHistory(data) {
    if (!Array.isArray(data) || data.length === 0) return [];

    const angleSensor = this._config.angle?.sensor;
    const colorSensor = this._config.color?.sensor;
    const colorFactor = this._config._isLegacyWind ? (TO_MS[this._colorUnit] || 1) : 1;

    const series = { angle: [], color: [] };
    for (const arr of data) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const eid = arr[0].entity_id;
      const isAngle = !!angleSensor && eid === angleSensor;
      const isColor = !!colorSensor && eid === colorSensor;
      if (!isAngle && !isColor) continue;
      const target = isAngle ? series.angle : series.color;

      for (const entry of arr) {
        const state = entry.state;
        if (state === 'unavailable' || state === 'unknown' || state == null) continue;
        const num = parseFloat(state);
        if (!isFinite(num)) continue;
        const ts = new Date(entry.last_changed || entry.last_updated).getTime();
        if (!isFinite(ts)) continue;
        const value = isColor ? num * colorFactor : num;
        target.push({ ts, value });
      }
    }

    series.angle.sort((a, b) => a.ts - b.ts);
    series.color.sort((a, b) => a.ts - b.ts);

    // Angle-less mode (daily without bearing): color sensor drives the timeline.
    if (!angleSensor) {
      if (series.color.length === 0) return [];
      return series.color.map(c => ({ ts: c.ts, angle: undefined, color: c.value }));
    }

    if (series.angle.length === 0) return [];

    if (!colorSensor) {
      return series.angle.map(a => ({ ts: a.ts, angle: a.value, color: undefined }));
    }
    if (series.color.length === 0) return [];

    const out = [];
    let j = 0;
    for (const a of series.angle) {
      while (j + 1 < series.color.length &&
             Math.abs(series.color[j + 1].ts - a.ts) <= Math.abs(series.color[j].ts - a.ts)) {
        j++;
      }
      const c = series.color[j];
      if (!c) continue;
      if (Math.abs(c.ts - a.ts) > 60_000) continue;
      out.push({ ts: a.ts, angle: a.value, color: c.value });
    }

    return out;
  }

  _rebucket(raw, viewHours, numPoints) {
    if (!raw || raw.length === 0) return [];
    const t_now = Date.now();

    const bucketMs = this._bucketMs;
    if (bucketMs) {
      // Clock-aligned buckets (from local midnight), mean within each bucket.
      const localMidnight = new Date(t_now);
      localMidnight.setHours(0, 0, 0, 0);
      const anchor = localMidnight.getTime();
      const t_end = anchor + Math.ceil((t_now - anchor) / bucketMs) * bucketMs;
      const numBuckets = Math.max(1, Math.ceil((viewHours * 3_600_000) / bucketMs));
      const t_start = t_end - numBuckets * bucketMs;
      const colorSum = new Array(numBuckets).fill(0);
      const colorN   = new Array(numBuckets).fill(0);
      const angleLast = new Array(numBuckets).fill(null);
      const tsLast   = new Array(numBuckets).fill(0);
      for (const p of raw) {
        if (p.ts < t_start || p.ts >= t_end) continue;
        const i = Math.floor((p.ts - t_start) / bucketMs);
        if (p.color != null && isFinite(p.color)) {
          colorSum[i] += p.color;
          colorN[i]++;
        }
        if (p.angle != null) angleLast[i] = p.angle;
        if (p.ts > tsLast[i]) tsLast[i] = p.ts;
      }
      const result = [];
      for (let i = 0; i < numBuckets; i++) {
        if (tsLast[i] === 0) continue;
        result.push({
          ts: t_start + i * bucketMs + bucketMs / 2,
          color: colorN[i] > 0 ? colorSum[i] / colorN[i] : undefined,
          angle: angleLast[i] != null ? angleLast[i] : undefined,
        });
      }
      return result;
    }

    const t_start = t_now - viewHours * 3_600_000;
    const width = (t_now - t_start) / numPoints;
    const result = [];
    for (let i = 0; i < numPoints; i++) {
      const bStart = t_start + i * width;
      const bEnd = bStart + width;
      let last = null;
      for (const p of raw) {
        if (p.ts >= bStart && p.ts < bEnd) last = p;
        else if (p.ts >= bEnd) break;
      }
      if (last) result.push(last);
    }
    return result;
  }

  _resizeCanvas() {
    const canvas = this.shadowRoot.getElementById('pw-canvas');
    const size = canvas.clientWidth;
    if (size > 0 && (canvas.width !== size || canvas.height !== size)) {
      canvas.width = size;
      canvas.height = size;
    }
  }

  _redrawFromCache() {
    requestAnimationFrame(() => this._draw());
  }

  // Convert a stored color value to its display representation in the configured unit.
  _formatColorValue(value, decimals = 1) {
    if (this._config._isLegacyWind) {
      const factor = FROM_MS[this._colorUnit] || 1;
      return (value * factor).toFixed(decimals);
    }
    return Number(value).toFixed(decimals);
  }

  _displayColorValueRounded(value) {
    if (this._config._isLegacyWind) {
      const factor = FROM_MS[this._colorUnit] || 1;
      return Math.round(value * factor);
    }
    // Round only if integer-ish for cleanliness; otherwise 1 decimal.
    const n = Number(value);
    return Math.abs(n - Math.round(n)) < 0.05 ? Math.round(n) : n.toFixed(1);
  }

  _displayUnit() {
    const t = I18N[this._lang];
    if (this._config._isLegacyWind) return t.unitName[this._colorUnit] || this._colorUnit;
    return this._colorUnit || '';
  }

  _draw() {
    const canvas = this.shadowRoot?.getElementById('pw-canvas');
    if (!canvas) return;
    if (!this._lang) return;

    if (canvas.clientWidth <= 0) {
      if (!this._drawRetryScheduled) {
        this._drawRetryScheduled = true;
        setTimeout(() => {
          this._drawRetryScheduled = false;
          this._draw();
        }, 100);
      }
      return;
    }

    this._resizeCanvas();
    const ctx = canvas.getContext('2d');
    const size = canvas.width;
    if (size <= 0) return;
    const cx = size / 2;
    const cy = size / 2;
    const max_radius = size * 0.42;
    const t = I18N[this._lang];
    const cfg = this._config;
    const angleCfg = cfg.angle;
    const colorCfg = cfg.color;
    const unitDisplay = this._displayUnit();

    // 1. Background
    ctx.fillStyle = '#1e2130';
    ctx.fillRect(0, 0, size, size);

    // 2. Concentric rings + time labels
    ctx.strokeStyle = 'rgba(255,255,255,0.1)';
    ctx.lineWidth = 1;
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (let i = 0; i < 4; i++) {
      const frac = (i + 1) / 4;
      const r = max_radius * frac;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();

      let label;
      if (this._viewMode === 'daily') {
        if (frac === 1) {
          label = t.today;
        } else {
          const daysAgo = (this._viewHours / 24) * (1 - frac);
          label = `-${daysAgo.toFixed(1)}d`;
        }
      } else {
        const hoursAgo = this._viewHours * (1 - frac);
        if (hoursAgo === 0) label = t.now;
        else {
          const rounded = hoursAgo < 2 ? Math.round(hoursAgo * 10) / 10 : Math.round(hoursAgo);
          label = `-${rounded}h`;
        }
      }
      ctx.fillText(label, cx, cy - r - 2);
    }

    // 2b. Wind rose overlay (only for full 0–360 cyclic angle axis)
    const isCompass = !!angleCfg && angleCfg.cyclic && angleCfg.min === 0 && angleCfg.max === 360;
    if (this._showWindRose && isCompass && this._cache.raw && this._cache.raw.length > 0) {
      const roseBuckets = this._rebucket(this._cache.raw, this._viewHours, cfg.num_points);
      if (roseBuckets.length > 0) {
        const numSectors = 16;
        const sectorWidthDeg = 360 / numSectors;
        const sectorMaxRadius = max_radius * 0.38;
        const freqs = _computeAngleRose(roseBuckets, angleCfg, numSectors);
        ctx.fillStyle = 'rgba(255,255,255,0.15)';
        ctx.strokeStyle = 'rgba(255,255,255,0.35)';
        ctx.lineWidth = 0.5;
        for (let i = 0; i < numSectors; i++) {
          const sectorR = freqs[i] * sectorMaxRadius;
          if (sectorR <= 0) continue;
          const startAngle = (i * sectorWidthDeg - 90 - sectorWidthDeg / 2) * Math.PI / 180;
          const endAngle = startAngle + sectorWidthDeg * Math.PI / 180;
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.arc(cx, cy, sectorR, startAngle, endAngle);
          ctx.closePath();
          ctx.fill();
          ctx.stroke();
        }
      }
    }

    // 3 + 4. Radial lines and outer labels
    if (this._viewMode === 'daily') {
      // 24 hour lines, every 6th brighter
      for (let i = 0; i < 24; i++) {
        const theta = (i / 24) * 2 * Math.PI - Math.PI / 2;
        const x = cx + max_radius * Math.cos(theta);
        const y = cy + max_radius * Math.sin(theta);
        ctx.strokeStyle = (i % 6 === 0) ? 'rgba(255,255,255,0.12)' : 'rgba(255,255,255,0.05)';
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(x, y);
        ctx.stroke();
      }

      ctx.fillStyle = 'rgba(255,255,255,0.5)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const labelRadius = max_radius + 14;
      for (let h = 0; h < 24; h += 3) {
        const theta = (h / 24) * 2 * Math.PI - Math.PI / 2;
        const x = cx + labelRadius * Math.cos(theta);
        const y = cy + labelRadius * Math.sin(theta);
        ctx.fillText(String(h).padStart(2, '0'), x, y);
      }
    } else {
      this._drawAngleAxis(ctx, cx, cy, max_radius, angleCfg);
    }

    // 5. Data points
    const showLoading = this._fetching && (!this._cache.raw || this._cache.raw.length === 0);
    const showError = this._fetchError && (!this._cache.raw || this._cache.raw.length === 0);

    if (!showLoading && !showError && this._cache.raw && this._cache.raw.length > 0) {
      const points = this._rebucket(this._cache.raw, this._viewHours, cfg.num_points);
      const t_now = Date.now();
      const t_start = t_now - this._viewHours * 3_600_000;
      const bucketWidth = (t_now - t_start) / cfg.num_points;
      const maxGap = Math.max(2 * bucketWidth, 30 * 60_000);

      let screen;
      if (this._viewMode === 'daily') {
        const max_days = this._viewHours / 24;
        screen = points.map(p => {
          const d = new Date(p.ts);
          const hourOfDay = d.getHours() + d.getMinutes() / 60;
          const theta = (hourOfDay / 24) * 2 * Math.PI - Math.PI / 2;
          const daysAgo = (t_now - p.ts) / 86_400_000;
          const r = 1 - (daysAgo / max_days);
          return {
            ts: p.ts,
            color: p.color,
            day: d.getDate(),
            r,
            x: cx + r * max_radius * Math.cos(theta),
            y: cy + r * max_radius * Math.sin(theta),
          };
        });
      } else {
        screen = points.map(p => {
          const r = (p.ts - t_start) / (t_now - t_start);
          const theta = _valueToTheta(p.angle, angleCfg.min, angleCfg.max, angleCfg.cyclic);
          return {
            ts: p.ts,
            color: p.color,
            r,
            x: cx + r * max_radius * Math.sin(theta),
            y: cy - r * max_radius * Math.cos(theta),
          };
        });
      }

      // Connecting lines first.
      const lineWidth = cfg.line_width != null ? cfg.line_width : 1;
      const dotSize = cfg.dot_size != null ? cfg.dot_size : 4;
      ctx.lineWidth = lineWidth;
      for (let i = 0; i < screen.length - 1; i++) {
        const a = screen[i];
        const b = screen[i + 1];
        if (a.r < 0 || a.r > 1 || b.r < 0 || b.r > 1) continue;
        if (this._viewMode === 'daily') {
          if (a.day !== b.day) continue;
        } else {
          if (b.ts - a.ts > maxGap) continue;
        }
        let strokeStyle;
        if (colorCfg && a.color != null && b.color != null) {
          const c = _valueToRgb((a.color + b.color) / 2, colorCfg.palette);
          strokeStyle = `rgba(${c.r}, ${c.g}, ${c.b}, 0.6)`;
        } else {
          strokeStyle = 'rgba(150,150,150,0.6)';
        }
        ctx.strokeStyle = strokeStyle;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // Dots on top.
      for (const p of screen) {
        if (p.r < 0 || p.r > 1) continue;
        ctx.fillStyle = (colorCfg && p.color != null)
          ? _valueToColorString(p.color, colorCfg.palette)
          : 'rgb(150,150,150)';
        ctx.beginPath();
        ctx.arc(p.x, p.y, dotSize, 0, Math.PI * 2);
        ctx.fill();
      }

      // 5b. Max marker (only when there's a color sensor)
      if (this._showMaxWind && colorCfg) {
        const max = _findMaxColorPoint(screen);
        if (max && max.r >= 0 && max.r <= 1) {
          const phase = (performance.now() % 2000) / 2000;
          const pulseRadius = 10 + phase * 8;
          const pulseAlpha = 0.6 * (1 - phase);
          ctx.strokeStyle = `rgba(255,255,255,${pulseAlpha.toFixed(3)})`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(max.x, max.y, pulseRadius, 0, Math.PI * 2);
          ctx.stroke();

          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(max.x, max.y, 10, 0, Math.PI * 2);
          ctx.stroke();

          ctx.fillStyle = _valueToColorString(max.color, colorCfg.palette);
          ctx.beginPath();
          ctx.arc(max.x, max.y, 4, 0, Math.PI * 2);
          ctx.fill();

          const ringR = 10;
          const labelOffset = 14;
          const dx = (max.x < cx) ? +1 : -1;
          const dy = (max.y < cy) ? +1 : -1;
          const lx = max.x + dx * (ringR + labelOffset);
          const ly = max.y + dy * (ringR + labelOffset);
          const valueDisplay = this._formatColorValue(max.color, 1);
          ctx.font = 'bold 11px sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.textAlign = (max.x < cx) ? 'left' : 'right';
          ctx.textBaseline = (max.y < cy) ? 'top' : 'bottom';
          const lbl = unitDisplay ? `${valueDisplay} ${unitDisplay}` : valueDisplay;
          ctx.fillText(lbl, lx, ly);
        }
      }
    }

    // 6. Center dot
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // 7. Legend (only if color sensor configured)
    if (colorCfg) {
      this._drawLegend(ctx, size);
    }

    // 8. Updated timestamp (bottom-left)
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    if (this._cache.fetchedAt) {
      const ts = new Date(this._cache.fetchedAt).toLocaleTimeString();
      ctx.fillText(`${t.updated}: ${ts}`, 8, size - 18);
    }
    // 9. Showing line
    let showingValue;
    if (this._viewMode === 'daily') {
      const days = this._viewHours / 24;
      const daysLabel = days < 2
        ? (Math.round(days * 10) / 10).toFixed(1)
        : Math.round(days);
      showingValue = `${daysLabel} ${t.days}`;
    } else {
      const hoursLabel = this._viewHours < 2
        ? (Math.round(this._viewHours * 10) / 10).toFixed(1)
        : Math.round(this._viewHours);
      showingValue = `${hoursLabel}h`;
    }
    ctx.fillText(`${t.showing}: ${showingValue} | ${cfg.num_points} ${t.points}`, 8, size - 6);

    // 10. Loading / error overlay
    if (showLoading || showError) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(showLoading ? t.loading : t.fetchError, cx, cy);
    }
  }

  _drawAngleAxis(ctx, cx, cy, max_radius, angleCfg) {
    const labels = angleCfg.labels;
    const labelCount = angleCfg.label_count || 8;
    let entries; // Array of { value, label }
    if (labels && Object.keys(labels).length > 0) {
      entries = Object.entries(labels).map(([k, v]) => ({ value: parseFloat(k), label: String(v) }));
    } else {
      entries = [];
      const range = angleCfg.max - angleCfg.min;
      if (angleCfg.cyclic) {
        for (let i = 0; i < labelCount; i++) {
          const v = angleCfg.min + (i / labelCount) * range;
          entries.push({ value: v, label: this._formatAxisValue(v) });
        }
      } else {
        for (let i = 0; i < labelCount; i++) {
          const v = angleCfg.min + (i / (labelCount - 1)) * range;
          entries.push({ value: v, label: this._formatAxisValue(v) });
        }
      }
    }

    // Lines
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    for (const e of entries) {
      const theta = _valueToTheta(e.value, angleCfg.min, angleCfg.max, angleCfg.cyclic);
      const x = cx + max_radius * Math.sin(theta);
      const y = cy - max_radius * Math.cos(theta);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(x, y);
      ctx.stroke();
    }

    // Labels
    ctx.fillStyle = 'rgba(255,255,255,0.5)';
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const labelRadius = max_radius + 14;
    for (const e of entries) {
      const theta = _valueToTheta(e.value, angleCfg.min, angleCfg.max, angleCfg.cyclic);
      const x = cx + labelRadius * Math.sin(theta);
      const y = cy - labelRadius * Math.cos(theta);
      ctx.fillText(e.label, x, y);
    }
  }

  _formatAxisValue(v) {
    const n = Number(v);
    if (!isFinite(n)) return String(v);
    if (Math.abs(n - Math.round(n)) < 0.05) return String(Math.round(n));
    return n.toFixed(1);
  }

  _drawLegend(ctx, size) {
    const cfg = this._config;
    const colorCfg = cfg.color;
    const t = I18N[this._lang];
    const unitDisplay = this._displayUnit();

    const barWidth = 10;
    const barHeight = Math.min(160, Math.max(80, size * 0.32));
    const barRight = size - 8;
    const barLeft = barRight - barWidth;
    const barBottom = size - 8;
    const barTop = barBottom - barHeight;

    // Header
    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    let headerText;
    const customTitle = colorCfg && colorCfg.title;
    if (customTitle) {
      headerText = unitDisplay ? `${customTitle} (${unitDisplay})` : customTitle;
    } else if (cfg._isLegacyWind) {
      headerText = unitDisplay ? `${t.legendTitle} (${unitDisplay})` : t.legendTitle;
    } else {
      headerText = unitDisplay;
    }
    if (headerText) ctx.fillText(headerText, barRight, barTop - 4);

    // Gradient bar
    const grad = ctx.createLinearGradient(0, barTop, 0, barBottom);
    const range = colorCfg.max - colorCfg.min;
    for (const stop of colorCfg.palette) {
      const frac = Math.min(1, Math.max(0, (stop.value - colorCfg.min) / range));
      grad.addColorStop(frac, stop.color);
    }
    ctx.fillStyle = grad;
    ctx.fillRect(barLeft, barTop, barWidth, barHeight);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barLeft + 0.5, barTop + 0.5, barWidth - 1, barHeight - 1);

    // Tick labels — use legend array if present, otherwise palette stops
    const ticks = colorCfg.legend && colorCfg.legend.length > 0
      ? colorCfg.legend
      : colorCfg.palette.map(s => ({ value: s.value }));

    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const tick of ticks) {
      if (tick.value < colorCfg.min || tick.value > colorCfg.max) continue;
      const frac = (tick.value - colorCfg.min) / range;
      const y = barTop + frac * barHeight;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.moveTo(barLeft - 3, y);
      ctx.lineTo(barLeft, y);
      ctx.stroke();

      let label = tick.label;
      if (label == null && tick.labelIndex != null) {
        label = t.speedLabels[tick.labelIndex];
      }
      const valueText = this._displayColorValueRounded(tick.value);
      const text = label ? `${label} ${valueText}` : `${valueText}`;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(text, barLeft - 5, y);
    }
  }
}

customElements.define('polar-chart', PolarChart);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'polar-chart',
  name: 'Polar Chart',
  description: 'Polar time-spiral visualisation of any two HA sensors',
});
