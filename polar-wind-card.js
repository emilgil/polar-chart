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
 *   show_max_wind: false                  # optional: highlight max wind in current view
 *   show_wind_rose: false                 # optional: frequency-of-direction overlay behind spiral
 *   view_mode: spiral                     # optional: "spiral" (default) | "daily"
 *
 * No ha_url or ha_token needed — auth is handled automatically via the Lovelace hass object.
 * Speed unit is auto-detected from sensor's unit_of_measurement attribute.
 * speed_unit in YAML overrides auto-detection. Supported: m/s, km/h, mph, knop (kn).
 * Values are converted to m/s internally — color thresholds are always in m/s.
 * Language defaults to the HA locale setting (e.g. sv-SE → sv, en-GB → en).
 */

const AUTO_REFRESH_MS = 10 * 60 * 1000;
const CACHE_HORIZON_H = 168;

// Anchor stops for both the data-point color interpolation and the legend
// gradient bar. Speeds are always in m/s.
const COLOR_STOPS = [
  { v: 0,  r: 96,  g: 165, b: 250 }, // #60a5fa
  { v: 3,  r: 74,  g: 222, b: 128 }, // #4ade80
  { v: 8,  r: 250, g: 204, b: 21  }, // #facc15
  { v: 14, r: 251, g: 146, b: 60  }, // #fb923c
  { v: 20, r: 248, g: 113, b: 113 }, // #f87171
];

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

const COMPASS_LABELS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

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
    maxWind:     'Maxvind',
    windRose:    'Vindros',
    today:       'Idag',
    days:        'dygn',
    modeSpiral:  'Spiral',
    modeDaily:   'Dagsmönster',
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
    maxWind:     'Max wind',
    windRose:    'Wind rose',
    today:       'Today',
    days:        'days',
    modeSpiral:  'Spiral',
    modeDaily:   'Daily pattern',
  },
};

function speedToRgb(ms) {
  if (ms <= COLOR_STOPS[0].v) {
    const s = COLOR_STOPS[0];
    return { r: s.r, g: s.g, b: s.b };
  }
  const last = COLOR_STOPS[COLOR_STOPS.length - 1];
  if (ms >= last.v) return { r: last.r, g: last.g, b: last.b };
  const hi = COLOR_STOPS.findIndex(s => s.v > ms);
  const lo = COLOR_STOPS[hi - 1];
  const f = (ms - lo.v) / (COLOR_STOPS[hi].v - lo.v);
  return {
    r: Math.round(lo.r + f * (COLOR_STOPS[hi].r - lo.r)),
    g: Math.round(lo.g + f * (COLOR_STOPS[hi].g - lo.g)),
    b: Math.round(lo.b + f * (COLOR_STOPS[hi].b - lo.b)),
  };
}

function speedToColor(ms) {
  const c = speedToRgb(ms);
  return `rgb(${c.r},${c.g},${c.b})`;
}

function msToDisplay(ms, unit) {
  return Math.round(ms * FROM_MS[unit]);
}

function formatRingLabel(hoursAgo, nowLabel) {
  if (hoursAgo === 0) return nowLabel;
  const rounded = hoursAgo < 2 ? Math.round(hoursAgo * 10) / 10 : Math.round(hoursAgo);
  return `-${rounded}h`;
}

function _findMaxPoint(buckets) {
  if (!buckets || buckets.length === 0) return null;
  return buckets.reduce((max, p) => p.speed > max.speed ? p : max, buckets[0]);
}

function _computeWindRose(buckets, numSectors = 16) {
  const counts = new Array(numSectors).fill(0);
  const width = 360 / numSectors;
  for (const p of buckets) {
    const i = Math.floor((((p.bearing % 360) + 360) % 360) / width) % numSectors;
    counts[i]++;
  }
  const max = Math.max(...counts, 1);
  return counts.map(c => c / max);
}

function _resolveLanguage(config, hass) {
  // Explicit YAML value is already validated in setConfig — accept as-is.
  if (config.language) return config.language;
  const supported = Object.keys(I18N);
  const locale = hass?.locale?.language?.split('-')[0]?.toLowerCase();
  if (locale && supported.includes(locale)) return locale;
  return 'sv';
}

function _resolveSpeedUnit(config, hass) {
  // Explicit YAML value is already validated in setConfig — accept as-is.
  if (config.speed_unit) return config.speed_unit;
  const haUnit = hass?.states?.[config.speed_sensor]?.attributes?.unit_of_measurement;
  if (haUnit && HA_UNIT_MAP[haUnit]) return HA_UNIT_MAP[haUnit];
  return 'm/s';
}

class PolarWindCard extends HTMLElement {
  setConfig(config) {
    const required = ['bearing_sensor', 'speed_sensor'];
    for (const key of required) {
      if (!config || !config[key]) {
        throw new Error(`polar-wind-card: missing required config key: ${key}`);
      }
    }

    if (config.speed_unit !== undefined && !(config.speed_unit in TO_MS)) {
      throw new Error(
        `polar-wind-card: invalid speed_unit "${config.speed_unit}". ` +
        `Allowed: ${Object.keys(TO_MS).join(', ')}`
      );
    }

    if (config.language !== undefined && !(config.language in I18N)) {
      throw new Error(
        `polar-wind-card: invalid language "${config.language}". ` +
        `Allowed: ${Object.keys(I18N).join(', ')}`
      );
    }

    const view_mode = config.view_mode || 'spiral';
    if (view_mode !== 'spiral' && view_mode !== 'daily') {
      throw new Error(
        `polar-wind-card: invalid view_mode "${view_mode}". Allowed: "spiral", "daily"`
      );
    }

    this._config = {
      bearing_sensor: config.bearing_sensor,
      speed_sensor: config.speed_sensor,
      hours: Number(config.hours) || 12,
      num_points: Number(config.num_points) || 100,
      speed_unit: config.speed_unit, // possibly undefined; resolved in set hass()
      language: config.language,     // possibly undefined; resolved in set hass()
      show_max_wind: !!config.show_max_wind,
      show_wind_rose: !!config.show_wind_rose,
      view_mode,
    };

    this._viewMode = view_mode;

    this._viewHours = this._config.hours;
    this._cache = { raw: null, fetchedAt: null, fetchedHours: null };
    this._fetching = false;
    this._fetchError = false;
    this._hasStarted = false;

    if (!this.shadowRoot) this._buildDOM();

    this.shadowRoot.getElementById('pw-hours').value = this._viewHours;
    this.shadowRoot.getElementById('pw-points').value = this._config.num_points;

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
    this._speedUnit = _resolveSpeedUnit(this._config, this._hass);
    this._applyI18n();
    this._startLoading();
    this._interval = setInterval(() => this._invalidateAndFetch(), AUTO_REFRESH_MS);
  }

  connectedCallback() {
    // Loading is triggered by set hass(), not here — connectedCallback may fire
    // before hass is available. Set up ResizeObserver here since canvas is in DOM.
    if (!this._resizeObserver && this.shadowRoot) {
      const canvas = this.shadowRoot.getElementById('pw-canvas');
      this._resizeObserver = new ResizeObserver(() => this._redrawFromCache());
      this._resizeObserver.observe(canvas);
    }
  }

  disconnectedCallback() {
    clearInterval(this._interval);
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
        #pw-canvas { display: block; width: 100%; aspect-ratio: 1/1; cursor: crosshair; }
      </style>
      <div id="pw-card">
        <div id="pw-controls">
          <label id="pw-label-hours">_<input id="pw-hours" type="number" min="0.5" max="168" step="0.5"></label>
          <label id="pw-label-points">_<input id="pw-points" type="number" min="10" max="500"></label>
          <button id="pw-apply" title="">🔃</button>
          <button id="pw-mode" title="Byt visningsläge / Toggle view mode">🔄</button>
        </div>
        <canvas id="pw-canvas"></canvas>
      </div>
    `;

    const sr = this.shadowRoot;
    const hoursInput = sr.getElementById('pw-hours');
    const pointsInput = sr.getElementById('pw-points');
    const applyBtn = sr.getElementById('pw-apply');
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
      this._viewMode = this._viewMode === 'spiral' ? 'daily' : 'spiral';
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
      // 24h window from start, NOT "to now". Without it, fetching 168h back
      // returns only the first 24h of that range (week-old data, no fresh).
      const path =
        `/api/history/period/${t_start_iso}` +
        `?filter_entity_id=${encodeURIComponent(this._config.bearing_sensor)},` +
        `${encodeURIComponent(this._config.speed_sensor)}` +
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
      // Only replace the cache when we actually got something — protects Stage 1
      // data from being wiped out if Stage 2 (or any retry) returns 0 points.
      if (raw.length > 0) {
        this._cache.raw = raw;
        this._cache.fetchedHours = hours;
      }
      this._cache.fetchedAt = Date.now();
      this._fetchError = false;
    } catch (err) {
      console.error('polar-wind-card: fetch failed', err);
      if (!this._cache.raw) this._fetchError = true;
    } finally {
      this._fetching = false;
    }
  }

  _parseHistory(data) {
    if (!Array.isArray(data) || data.length === 0) return [];

    const speedFactor = TO_MS[this._speedUnit];
    const series = { bearing: [], speed: [] };
    for (const arr of data) {
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const eid = arr[0].entity_id;
      const isBearing = eid === this._config.bearing_sensor;
      const isSpeed = eid === this._config.speed_sensor;
      if (!isBearing && !isSpeed) continue;
      const target = isBearing ? series.bearing : series.speed;

      for (const entry of arr) {
        const state = entry.state;
        if (state === 'unavailable' || state === 'unknown' || state == null) continue;
        const num = parseFloat(state);
        if (!isFinite(num)) continue;
        const ts = new Date(entry.last_changed || entry.last_updated).getTime();
        if (!isFinite(ts)) continue;
        const value = isSpeed ? num * speedFactor : num;
        target.push({ ts, value });
      }
    }

    series.bearing.sort((a, b) => a.ts - b.ts);
    series.speed.sort((a, b) => a.ts - b.ts);

    if (series.bearing.length === 0 || series.speed.length === 0) return [];

    const out = [];
    let j = 0;
    for (const b of series.bearing) {
      while (j + 1 < series.speed.length &&
             Math.abs(series.speed[j + 1].ts - b.ts) <= Math.abs(series.speed[j].ts - b.ts)) {
        j++;
      }
      const s = series.speed[j];
      if (!s) continue;
      if (Math.abs(s.ts - b.ts) > 60_000) continue;
      out.push({ ts: b.ts, bearing: b.value, speed: s.value });
    }

    return out;
  }

  _rebucket(raw, viewHours, numPoints) {
    if (!raw || raw.length === 0) return [];
    const t_now = Date.now();
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

  _draw() {
    const canvas = this.shadowRoot?.getElementById('pw-canvas');
    if (!canvas) return;
    // Wait until init has run — _lang and _speedUnit must be set.
    if (!this._lang || !this._speedUnit) return;

    // If the canvas hasn't been laid out yet (e.g. card not yet visible),
    // poll until it gets a real size. ResizeObserver should also catch this,
    // but some Lovelace setups (hidden tabs, lazy mounts) don't fire it
    // reliably on the initial show. Stop polling once we have a size.
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
    const unit = this._speedUnit;
    const unitDisplay = t.unitName[unit];

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
        label = formatRingLabel(hoursAgo, t.now);
      }
      ctx.fillText(label, cx, cy - r - 2);
    }

    // 2b. Wind rose overlay — drawn under compass lines and data points.
    if (this._config.show_wind_rose && this._cache.raw && this._cache.raw.length > 0) {
      const roseBuckets = this._rebucket(this._cache.raw, this._viewHours, this._config.num_points);
      if (roseBuckets.length > 0) {
        const numSectors = 16;
        const sectorWidthDeg = 360 / numSectors;
        const sectorMaxRadius = max_radius * 0.38;
        const freqs = _computeWindRose(roseBuckets, numSectors);
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

      // Hour labels every 3 hours
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
      // Spiral mode: 8 compass lines + N/E/S/W labels
      ctx.strokeStyle = 'rgba(255,255,255,0.07)';
      for (let i = 0; i < 8; i++) {
        const theta = i * Math.PI / 4;
        const x = cx + max_radius * Math.sin(theta);
        const y = cy - max_radius * Math.cos(theta);
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
      for (let i = 0; i < 8; i++) {
        const theta = i * Math.PI / 4;
        const x = cx + labelRadius * Math.sin(theta);
        const y = cy - labelRadius * Math.cos(theta);
        ctx.fillText(COMPASS_LABELS[i], x, y);
      }
    }

    // 5. Data points
    const showLoading = this._fetching && (!this._cache.raw || this._cache.raw.length === 0);
    const showError = this._fetchError && (!this._cache.raw || this._cache.raw.length === 0);

    if (!showLoading && !showError && this._cache.raw && this._cache.raw.length > 0) {
      const points = this._rebucket(this._cache.raw, this._viewHours, this._config.num_points);
      const t_now = Date.now();
      const t_start = t_now - this._viewHours * 3_600_000;
      const bucketWidth = (t_now - t_start) / this._config.num_points;
      // Floor at 30 min so lines stay drawn at small viewHours where bucket
      // width gets shorter than typical sensor cadence (~15–20 min).
      const maxGap = Math.max(2 * bucketWidth, 30 * 60_000);

      // Precompute screen positions once — used for both lines and dots.
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
            speed: p.speed,
            day: d.getDate(),
            r,
            x: cx + r * max_radius * Math.cos(theta),
            y: cy + r * max_radius * Math.sin(theta),
          };
        });
      } else {
        screen = points.map(p => {
          const r = (p.ts - t_start) / (t_now - t_start);
          const theta = (p.bearing % 360) * Math.PI / 180;
          return {
            ts: p.ts,
            speed: p.speed,
            r,
            x: cx + r * max_radius * Math.sin(theta),
            y: cy - r * max_radius * Math.cos(theta),
          };
        });
      }

      // Connecting lines first, so dots draw on top.
      ctx.lineWidth = 1;
      for (let i = 0; i < screen.length - 1; i++) {
        const a = screen[i];
        const b = screen[i + 1];
        if (a.r < 0 || a.r > 1 || b.r < 0 || b.r > 1) continue;
        if (this._viewMode === 'daily') {
          // Skip lines that would cross midnight (different calendar day)
          if (a.day !== b.day) continue;
        } else {
          if (b.ts - a.ts > maxGap) continue;
        }
        const c = speedToRgb((a.speed + b.speed) / 2);
        ctx.strokeStyle = `rgba(${c.r}, ${c.g}, ${c.b}, 0.6)`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      // Dots on top.
      for (const p of screen) {
        if (p.r < 0 || p.r > 1) continue;
        ctx.fillStyle = speedToColor(p.speed);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
      }

      // 5b. Max wind marker (drawn over dots so it stands out)
      if (this._config.show_max_wind) {
        const max = _findMaxPoint(screen);
        if (max && max.r >= 0 && max.r <= 1) {
          // Static outer ring
          ctx.strokeStyle = 'rgba(255,255,255,0.9)';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(max.x, max.y, 10, 0, Math.PI * 2);
          ctx.stroke();

          // Inner dot re-drawn on top of the ring, same color as the spiral
          ctx.fillStyle = speedToColor(max.speed);
          ctx.beginPath();
          ctx.arc(max.x, max.y, 4, 0, Math.PI * 2);
          ctx.fill();

          // Label "12.3 m/s" offset away from the nearest edge so it stays
          // on-canvas and doesn't overlap the spiral center.
          const ringR = 10;
          const labelOffset = 14;
          const dx = (max.x < cx) ? +1 : -1;
          const dy = (max.y < cy) ? +1 : -1;
          const lx = max.x + dx * (ringR + labelOffset);
          const ly = max.y + dy * (ringR + labelOffset);
          const valueDisplay = (max.speed * FROM_MS[unit]).toFixed(1);
          ctx.font = 'bold 11px sans-serif';
          ctx.fillStyle = 'rgba(255,255,255,0.9)';
          ctx.textAlign = (max.x < cx) ? 'left' : 'right';
          ctx.textBaseline = (max.y < cy) ? 'top' : 'bottom';
          ctx.fillText(`${valueDisplay} ${unitDisplay}`, lx, ly);
        }
      }
    }

    // 6. Center dot
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fill();

    // 7. Legend (bottom-right) — vertical gradient bar with anchor ticks
    const barWidth = 10;
    const barHeight = Math.min(160, Math.max(80, size * 0.32));
    const barRight = size - 8;
    const barLeft = barRight - barWidth;
    const barBottom = size - 8;
    const barTop = barBottom - barHeight;

    ctx.font = 'bold 11px sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${t.legendTitle} (${unitDisplay})`, barRight, barTop - 4);

    const grad = ctx.createLinearGradient(0, barTop, 0, barBottom);
    grad.addColorStop(0.00, '#60a5fa');
    grad.addColorStop(0.15, '#4ade80');
    grad.addColorStop(0.40, '#facc15');
    grad.addColorStop(0.70, '#fb923c');
    grad.addColorStop(1.00, '#f87171');
    ctx.fillStyle = grad;
    ctx.fillRect(barLeft, barTop, barWidth, barHeight);
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = 1;
    ctx.strokeRect(barLeft + 0.5, barTop + 0.5, barWidth - 1, barHeight - 1);

    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const maxAnchor = COLOR_STOPS[COLOR_STOPS.length - 1].v;
    for (let i = 0; i < COLOR_STOPS.length; i++) {
      const stop = COLOR_STOPS[i];
      const frac = stop.v / maxAnchor;
      const y = barTop + frac * barHeight;
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.beginPath();
      ctx.moveTo(barLeft - 3, y);
      ctx.lineTo(barLeft, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(`${t.speedLabels[i]} ${msToDisplay(stop.v, unit)}`, barLeft - 5, y);
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
    ctx.fillText(`${t.showing}: ${showingValue} | ${this._config.num_points} ${t.points}`, 8, size - 6);

    // 10. Loading / error overlay
    if (showLoading || showError) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(showLoading ? t.loading : t.fetchError, cx, cy);
    }
  }
}

customElements.define('polar-wind-card', PolarWindCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: 'polar-wind-card',
  name: 'Polar Wind Card',
  description: 'Wind history as a polar spiral (direction × time × speed)',
});
