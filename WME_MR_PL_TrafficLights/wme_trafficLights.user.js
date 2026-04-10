// ==UserScript==
// @name                WME MapRaid PL Traffic Lights
// @name:pl             WME MapRaid PL Sygnalizacja
// @version             0.2.0
// @tag                 WME
// @description         MapRaid coordination grid – mark traffic-light work tiles on the map.
// @description:pl      Siatka koordynacyjna MapRaid – oznaczanie kafelków sygnalizacji świetlnej.
// @author            Falcon4Tech
// @run-at            document-idle
// @namespace         https://wazepolska.pl
// @match             https://*.waze.com/editor*
// @match             https://*.waze.com/*/editor*
// @grant             GM_xmlhttpRequest
// @connect           mqtt2api.labtool.pl
// @supportURL        https://github.com/Falcon4Tech/WME/issues
// @updateURL         https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_MR_PL_TrafficLights/wme_trafficLights.meta.js
// @downloadURL       https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_MR_PL_TrafficLights/wme_trafficLights.user.js
// ==/UserScript==

(function () {
  'use strict';

  const UW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const SCRIPT_ID   = 'WME_MR_PL_TrafficLights';
  const SCRIPT_NAME = 'MapRaid TL';
  const START_GUARD = '__WME_MAPRAID_TL_BOOTSTRAPPED__';
  const LAYER_NAME  = 'tl.grid';

  // ── API ────────────────────────────────────────────────────────────────
  const API_BASE       = 'https://mqtt2api.labtool.pl/mapraid';
  const API_CONFIG_ID  = 1;
  const SYNC_INTERVAL  = 15_000; // ms

  // ── UI config (not fetched from API) ──────────────────────────────────
  const UI_CONFIG = {
    renderZoomMin:  11,    // don't render grid at zoom 10 and below
    uiZoomMin:      13,    // status buttons visible from this zoom
    uiZoomMax:      14,    // status buttons visible up to this zoom
    maxRenderTiles: 5000,  // hard cap on features added in one pass
  };

  if (UW[START_GUARD]) return;
  UW[START_GUARD] = true;

  const DEBUG = true;
  const log   = (...args) => console.log(`[${SCRIPT_NAME}]`, ...args);
  const dbg   = (...args) => { if (DEBUG) console.log(`[${SCRIPT_NAME}:dbg]`, ...args); };

  // ── State ──────────────────────────────────────────────────────────────
  // null = not yet evaluated (no row in DB)
  // 1    = empty       – tile reviewed, no roads requiring lights
  // 2    = in_progress – work started
  // 3    = done        – fully mapped
  const STATUS = Object.freeze({ EMPTY: 1, IN_PROGRESS: 2, DONE: 3 });

  let CONFIG         = null; // set after fetchConfig()
  const tileStatuses = new Map(); // tileId → 1 | 2 | 3
  let tilesEtag      = null;
  let configEtag     = null;

  let sdk            = null;
  let layerVisible   = true;
  let selectedTileId = null;
  let panel          = null;
  let renderTimer    = null;

  // ── Grid config builder ────────────────────────────────────────────────
  function buildConfig(apiData) {
    // API bbox is already an array [west, south, east, north]
    const [west, south, east, north] = apiData.bbox;
    const latDeg = apiData.tileSizeKm / 111.0;
    const lonDeg = apiData.tileSizeKm / (111.32 * Math.cos(south * Math.PI / 180));
    return Object.freeze({
      ...UI_CONFIG,
      tileSizeKm:    apiData.tileSizeKm,
      bbox:          apiData.bbox,
      gridOriginLat: south,
      gridOriginLon: west,
      latStep:       latDeg,
      lonStep:       lonDeg,
      gridRows:      Math.ceil((north - south) / latDeg),
      gridCols:      Math.ceil((east  - west)  / lonDeg),
    });
  }

  // ── API helpers ────────────────────────────────────────────────────────
  function apiFetch(url, options = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method:       options.method || 'GET',
        url,
        headers:      options.headers || {},
        data:         options.body !== undefined ? JSON.stringify(options.body) : undefined,
        responseType: 'json',
        onload:       resolve,
        onerror:      reject,
        ontimeout:    reject,
      });
    });
  }

  function extractEtag(responseHeaders) {
    // Matches both strong ("abc") and weak (W/"abc") ETags, preserving quotes.
    const match = responseHeaders?.match(/etag:\s*(W\/"[^"]*"|"[^"]*")/i)?.[1] ?? null;
    dbg('extractEtag raw headers:', responseHeaders);
    dbg('extractEtag result:', match);
    return match;
  }

  async function fetchConfig() {
    const headers = { Accept: 'application/json' };
    if (configEtag) headers['If-None-Match'] = configEtag;
    dbg('fetchConfig → sending headers:', headers);

    const res = await apiFetch(`${API_BASE}/config/${API_CONFIG_ID}`, { headers });
    dbg('fetchConfig ← status:', res.status, '| response ETag:', extractEtag(res.responseHeaders));

    if (res.status === 304) { dbg('fetchConfig: 304 – config unchanged'); return; }
    if (res.status !== 200) throw new Error(`Config fetch failed: HTTP ${res.status}`);

    configEtag = extractEtag(res.responseHeaders) ?? configEtag;
    dbg('fetchConfig: stored configEtag:', configEtag);
    CONFIG = buildConfig(res.response);
    log(`Config loaded: ${CONFIG.gridRows}×${CONFIG.gridCols} tiles, ${CONFIG.tileSizeKm} km each.`);
  }

  async function fetchTiles() {
    const headers = { Accept: 'application/json' };
    if (tilesEtag) headers['If-None-Match'] = tilesEtag;
    dbg('fetchTiles → sending headers:', headers);

    const res = await apiFetch(`${API_BASE}/config/${API_CONFIG_ID}/tiles`, { headers });
    dbg('fetchTiles ← status:', res.status, '| response ETag:', extractEtag(res.responseHeaders));

    if (res.status === 304) { dbg('fetchTiles: 304 – tiles unchanged'); return false; }
    if (res.status !== 200) throw new Error(`Tiles fetch failed: HTTP ${res.status}`);

    tilesEtag = extractEtag(res.responseHeaders) ?? tilesEtag;
    dbg('fetchTiles: stored tilesEtag:', tilesEtag);

    tileStatuses.clear();
    for (const tile of res.response.tiles) {
      tileStatuses.set(tile.id, tile.status);
    }
    dbg('fetchTiles: loaded', tileStatuses.size, 'tiles');
    return true; // data changed
  }

  // ── Grid math ──────────────────────────────────────────────────────────
  function latLonToTileId(lat, lon) {
    const row = Math.floor((lat - CONFIG.gridOriginLat) / CONFIG.latStep);
    const col = Math.floor((lon - CONFIG.gridOriginLon) / CONFIG.lonStep);
    if (row < 0 || row >= CONFIG.gridRows || col < 0 || col >= CONFIG.gridCols) return null;
    return `${row}_${col}`;
  }

  function tileIdToGeometry(id) {
    const [row, col] = id.split('_').map(Number);
    const south = CONFIG.gridOriginLat + row * CONFIG.latStep;
    const north  = south + CONFIG.latStep;
    const west   = CONFIG.gridOriginLon + col * CONFIG.lonStep;
    const east   = west + CONFIG.lonStep;
    return {
      type: 'Polygon',
      coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]],
    };
  }

  function getVisibleTileIds(south, west, north, east) {
    const allRowMin = Math.max(0, Math.floor((south - CONFIG.gridOriginLat) / CONFIG.latStep));
    const allRowMax = Math.min(CONFIG.gridRows - 1, Math.ceil((north - CONFIG.gridOriginLat) / CONFIG.latStep));
    const allColMin = Math.max(0, Math.floor((west - CONFIG.gridOriginLon) / CONFIG.lonStep));
    const allColMax = Math.min(CONFIG.gridCols - 1, Math.ceil((east - CONFIG.gridOriginLon) / CONFIG.lonStep));

    const totalRows = allRowMax - allRowMin + 1;
    const totalCols = allColMax - allColMin + 1;

    let rowMin = allRowMin, rowMax = allRowMax;
    let colMin = allColMin, colMax = allColMax;

    if (totalRows * totalCols > CONFIG.maxRenderTiles) {
      const ratio   = Math.sqrt(CONFIG.maxRenderTiles / (totalRows * totalCols));
      const halfR   = Math.floor(totalRows * ratio / 2);
      const halfC   = Math.floor(totalCols * ratio / 2);
      const centerR = Math.floor((allRowMin + allRowMax) / 2);
      const centerC = Math.floor((allColMin + allColMax) / 2);
      rowMin = Math.max(allRowMin, centerR - halfR);
      rowMax = Math.min(allRowMax, centerR + halfR);
      colMin = Math.max(allColMin, centerC - halfC);
      colMax = Math.min(allColMax, centerC + halfC);
    }

    const ids = [];
    for (let r = rowMin; r <= rowMax; r++)
      for (let c = colMin; c <= colMax; c++)
        ids.push(`${r}_${c}`);
    return ids;
  }

  // ── Viewport bounds via SDK ────────────────────────────────────────────
  function getViewportBounds() {
    try {
      const [west, south, east, north] = sdk.Map.getMapExtent();
      return { south, west, north, east };
    } catch (_) {
      return null;
    }
  }

  // ── Zoom fade ──────────────────────────────────────────────────────────
  // zoom ≤ 15 → factor 1.0  (full opacity)
  // zoom 16-20 → linear fade from 1.0 down to 0.05  (95% transparent)
  // zoom 21    → factor 0.0  (fully invisible)
  function zoomFade(zoom) {
    if (zoom <= 15) return 1;
    if (zoom >= 21) return 0;
    if (zoom <= 20) return 1 - ((zoom - 15) / 5) * 0.95; // 1 → 0.05
    return 0.05 * (21 - zoom); // 0.05 → 0 between z20 and z21
  }

  // ── Layer init & rendering ─────────────────────────────────────────────
  function initLayer() {
    // Base opacities for each status (before zoom fade is applied).
    const BASE_FILL = { 1: 0.35, 2: 0.55, 3: 0.55 };

    sdk.Map.addLayer({
      layerName: LAYER_NAME,
      styleContext: {
        // fillOpacity: 0 for null tiles, BASE_FILL value for colored tiles × zoom fade.
        getFillOpacity: ({ feature, zoomLevel }) => {
          const base = BASE_FILL[feature?.properties?.status] ?? 0;
          return base * zoomFade(zoomLevel);
        },
        // strokeOpacity: only null-status tiles have a stroke (red grid border) – always full.
        getStrokeOpacity: ({ feature }) => {
          return feature?.properties?.status !== null ? 0 : 0.7;
        },
      },
      styleRules: [
        {
          predicate: (p) => p.status === null,
          style: { fillOpacity: '${getFillOpacity}', strokeColor: '#ff0000', strokeWidth: 1, strokeOpacity: '${getStrokeOpacity}' },
        },
        {
          predicate: (p) => p.status === 1,
          style: { fillColor: '#ff3939', fillOpacity: '${getFillOpacity}', strokeOpacity: 0 },
        },
        {
          predicate: (p) => p.status === 2,
          style: { fillColor: '#f5c400', fillOpacity: '${getFillOpacity}', strokeOpacity: 0 },
        },
        {
          predicate: (p) => p.status === 3,
          style: { fillColor: '#00a650', fillOpacity: '${getFillOpacity}', strokeOpacity: 0 },
        },
      ],
    });

    try {
      sdk.LayerSwitcher.addLayerCheckbox({ name: '▸ MapRaid TL Grid', isChecked: true });
    } catch (_) {
      // LayerSwitcher optional
    }
  }

  function renderVisibleTiles() {
    if (!layerVisible) return;

    const zoom = sdk.Map.getZoomLevel();
    if (zoom < CONFIG.renderZoomMin) {
      try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_NAME }); } catch (_) {}
      return;
    }

    const bounds = getViewportBounds();
    if (!bounds) return;

    const ids = getVisibleTileIds(bounds.south, bounds.west, bounds.north, bounds.east);

    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_NAME }); } catch (_) {}
    if (ids.length === 0) return;

    const features = ids.map((id) => ({
      type: 'Feature',
      id,
      geometry: tileIdToGeometry(id),
      properties: { status: tileStatuses.get(id) ?? null },
    }));

    try {
      sdk.Map.addFeaturesToLayer({ layerName: LAYER_NAME, features });
    } catch (e) {
      log('addFeaturesToLayer error:', e);
    }
  }

  function scheduleRender(delay = 150) {
    clearTimeout(renderTimer);
    renderTimer = setTimeout(renderVisibleTiles, delay);
  }

  // ── Status update with API + rollback ─────────────────────────────────
  function applyTileStatus(tileId, status) {
    if (status === null) {
      tileStatuses.delete(tileId);
    } else {
      tileStatuses.set(tileId, status);
    }
    try { sdk.Map.removeFeatureFromLayer({ layerName: LAYER_NAME, featureId: tileId }); } catch (_) {}
    try {
      sdk.Map.addFeatureToLayer({
        layerName: LAYER_NAME,
        feature: {
          type: 'Feature',
          id: tileId,
          geometry: tileIdToGeometry(tileId),
          properties: { status: tileStatuses.get(tileId) ?? null },
        },
      });
    } catch (e) {
      log('addFeatureToLayer error:', e);
    }
  }

  async function updateTileStatus(tileId, newStatus) {
    const prevStatus = tileStatuses.get(tileId) ?? null;
    applyTileStatus(tileId, newStatus); // optimistic

    try {
      if (newStatus === null) {
        const res = await apiFetch(
          `${API_BASE}/config/${API_CONFIG_ID}/tiles/${tileId}`,
          { method: 'DELETE' },
        );
        if (res.status !== 204) throw new Error(`DELETE failed: HTTP ${res.status}`);
      } else {
        const user = sdk.State.getUserInfo()?.userName ?? '';
        const res = await apiFetch(
          `${API_BASE}/config/${API_CONFIG_ID}/tiles/${tileId}`,
          {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Waze-User': user },
            body:    { status: newStatus },
          },
        );
        if (res.status !== 200) throw new Error(`PATCH failed: HTTP ${res.status}`);
      }
    } catch (e) {
      log('Status update failed, rolling back:', e);
      applyTileStatus(tileId, prevStatus); // rollback
    }
  }

  // ── Auto-sync ──────────────────────────────────────────────────────────
  function startSync() {
    setInterval(async () => {
      try {
        const changed = await fetchTiles();
        if (changed) renderVisibleTiles();
      } catch (e) {
        log('Sync error (non-fatal):', e);
      }
    }, SYNC_INTERVAL);
  }

  // ── Status panel ───────────────────────────────────────────────────────
  const STATUS_BUTTONS = [
    { label: 'Brak dróg', status: STATUS.EMPTY,       bg: '#888888', fg: '#ffffff' },
    { label: 'W trakcie', status: STATUS.IN_PROGRESS, bg: '#f5c400', fg: '#333333' },
    { label: 'Gotowe',    status: STATUS.DONE,        bg: '#00a650', fg: '#ffffff' },
    { label: '✕ Resetuj', status: null,               bg: '#dddddd', fg: '#333333' },
  ];

  function createStatusPanel() {
    panel = document.createElement('div');
    panel.id = 'tl-status-panel';
    panel.style.cssText = [
      'position:absolute',
      'background:#fff',
      'border:1px solid #888',
      'border-radius:6px',
      'padding:6px 8px',
      'z-index:9000',
      'display:none',
      'box-shadow:2px 2px 8px rgba(0,0,0,.35)',
      'font:13px/1.4 sans-serif',
      'white-space:nowrap',
      'pointer-events:auto',
    ].join(';');

    STATUS_BUTTONS.forEach(({ label, status, bg, fg }) => {
      const btn = document.createElement('button');
      btn.textContent = label;
      btn.style.cssText = [
        `background:${bg}`,
        `color:${fg}`,
        'border:none',
        'border-radius:4px',
        'padding:4px 9px',
        'margin:0 2px',
        'cursor:pointer',
        'font-size:12px',
      ].join(';');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectedTileId) updateTileStatus(selectedTileId, status);
        hideStatusPanel();
      });
      panel.appendChild(btn);
    });

    try {
      const viewport = sdk.Map.getMapViewportElement();
      viewport.appendChild(panel);
    } catch (e) {
      log('Could not find map viewport for status panel:', e);
    }
  }

  function showStatusPanel(tileId, px, py) {
    if (!panel) return;
    selectedTileId = tileId;
    panel.style.display = 'block';
    const h = panel.offsetHeight || 40;
    panel.style.left = `${px}px`;
    panel.style.top  = `${Math.max(4, py - h - 8)}px`;
  }

  function hideStatusPanel() {
    if (panel) panel.style.display = 'none';
    selectedTileId = null;
  }

  // ── Click detection ────────────────────────────────────────────────────
  function handleMapClick(event) {
    const zoom = sdk.Map.getZoomLevel();
    if (zoom < CONFIG.uiZoomMin || zoom > CONFIG.uiZoomMax) {
      hideStatusPanel();
      return;
    }

    const tileId = latLonToTileId(event.lat, event.lon);
    if (!tileId) { hideStatusPanel(); return; }

    showStatusPanel(tileId, event.x, event.y);
  }

  // ── Events ─────────────────────────────────────────────────────────────
  function onViewChange() {
    hideStatusPanel();
    scheduleRender();
  }

  function registerEvents() {
    sdk.Events.on({ eventName: 'wme-map-zoom-changed', eventHandler: onViewChange });
    sdk.Events.on({ eventName: 'wme-map-move-end',     eventHandler: onViewChange });

    sdk.Events.on({
      eventName: 'wme-layer-checkbox-toggled',
      eventHandler: (payload) => {
        if (payload?.name === '▸ MapRaid TL Grid') {
          layerVisible = !!payload.checked;
          if (!layerVisible) {
            try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_NAME }); } catch (_) {}
            hideStatusPanel();
          } else {
            renderVisibleTiles();
          }
        }
      },
    });

    sdk.Events.on({ eventName: 'wme-map-mouse-click', eventHandler: handleMapClick });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────
  async function initScript() {
    try {
      await fetchConfig();
      initLayer();
      createStatusPanel();
      registerEvents();
      await fetchTiles();
      renderVisibleTiles();
      startSync();
      log(`Ready. ${CONFIG.gridRows}×${CONFIG.gridCols} tiles, ${CONFIG.tileSizeKm} km each.`);
    } catch (e) {
      log('Initialization error:', e);
    }
  }

  function bootstrap() {
    if (!UW.SDK_INITIALIZED || typeof UW.SDK_INITIALIZED.then !== 'function') {
      log('window.SDK_INITIALIZED unavailable, aborting.');
      return;
    }

    UW.SDK_INITIALIZED
      .then(() => {
        try {
          sdk = UW.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
        } catch (e) {
          log('getWmeSdk failed:', e);
          return;
        }

        if (sdk.State.isReady()) {
          initScript();
          return;
        }

        sdk.Events.once({ eventName: 'wme-ready' })
          .then(() => initScript())
          .catch((e) => log('wme-ready error:', e));
      })
      .catch((e) => log('SDK_INITIALIZED rejected:', e));
  }

  bootstrap();
})();
