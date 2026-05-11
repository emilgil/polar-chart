# Polar Chart – Rename Spec

## Goal

Rename the card from `polar-wind-card` to `polar-chart` throughout the codebase.
This is a pure rename — no functional changes.

---

## Changes

### File

| Old | New |
|-----|-----|
| `polar-wind-card.js` | `polar-chart.js` |

### Custom element registration

```javascript
// Before
customElements.define('polar-wind-card', PolarWindCard);

// After
customElements.define('polar-chart', PolarChart);
```

### Class name

```javascript
// Before
class PolarWindCard extends HTMLElement { ... }

// After
class PolarChart extends HTMLElement { ... }
```

### Error messages

All `throw new Error(...)` and `console.error(...)` strings:
```javascript
// Before
'polar-wind-card: missing required config key: ...'

// After
'polar-chart: missing required config key: ...'
```

### Installation comment block at top of file

```javascript
// Before
* polar-wind-card.js — Home Assistant Lovelace custom card
* ...
*   type: custom:polar-wind-card

// After
* polar-chart.js — Home Assistant Lovelace custom card
* ...
*   type: custom:polar-chart
```

---

## Manual steps in Home Assistant (not done by Claude Code)

After deploying the renamed file:

1. **Remove old resource:**
   Settings → Dashboards → Resources → delete `/local/polar-wind-card.js`

2. **Add new resource:**
   Settings → Dashboards → Resources → Add resource
   - URL: `/local/polar-chart.js`
   - Type: JavaScript module

3. **Update all dashboard cards** that use the old type:
   Change `type: custom:polar-wind-card` → `type: custom:polar-chart`
   in every Lovelace card config.

4. **Hard reload** the browser (Ctrl+Shift+R).

---

## Acceptance criteria

- [ ] File renamed to `polar-chart.js`
- [ ] `customElements.define('polar-chart', PolarChart)`
- [ ] Class named `PolarChart`
- [ ] All error strings prefixed with `polar-chart:`
- [ ] Installation comment updated
- [ ] No remaining references to `polar-wind-card` anywhere in the JS file
