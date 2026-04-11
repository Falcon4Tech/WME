// ==UserScript==
// @name                WME MapRaid PL Traffic Lights
// @name:pl             WME MapRaid PL Sygnalizacja
// @version             0.5.1
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

  const SCRIPT_ID      = 'WME_MR_PL_TrafficLights';
  const SCRIPT_VERSION = '0.4.1';
  const SCRIPT_NAME = 'MapRaid TL';
  const START_GUARD = '__WME_MAPRAID_TL_BOOTSTRAPPED__';
  const LAYER_NAME  = 'tl.grid';

  // ── API ────────────────────────────────────────────────────────────────
  const API_BASE      = 'https://mqtt2api.labtool.pl/mapraid';
  const SYNC_INTERVAL = 15_559; // ms

  // ── UI config (not fetched from API) ──────────────────────────────────
  const UI_CONFIG = {
    colorsZoomMin:  7,     // zoom 7-10: only tiles without grid lines
    renderZoomMin:  11,    // zoom 11+: full grid including null tiles (red border)
    uiZoomMin:      13,    // status buttons visible from this zoom
    uiZoomMax:      14,    // status buttons visible up to this zoom
    maxRenderTiles: 5000,  // hard cap on features added in one pass
  };

  if (UW[START_GUARD]) return;
  UW[START_GUARD] = true;

  const DEBUG = false;
  const log   = (...args) => console.log(`[${SCRIPT_NAME}]`, ...args);
  const dbg   = (...args) => { if (DEBUG) console.log(`[${SCRIPT_NAME}:dbg]`, ...args); };

  // ── State ──────────────────────────────────────────────────────────────
  // null = not yet evaluated (no row in DB)
  // 1    = empty       – tile reviewed, no roads requiring lights
  // 2    = in_progress – work started
  // 3    = done        – fully mapped
  const STATUS = Object.freeze({ EMPTY: 1, IN_PROGRESS: 2, DONE: 3, VERIFIED: 7 });

  // ── Settings / LocalStorage ────────────────────────────────────────────────
  const SETTINGS_KEY = SCRIPT_ID;
  const DEFAULT_SETTINGS = {
    configId: 1,
    colors: {
      grid:       '#ff0000',
      empty:      '#ff3939',
      inProgress: '#f5c400',
      done:       '#00a650',
      verified:   '#9b59b6',
    },
  };

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return structuredClone(DEFAULT_SETTINGS);
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        colors: { ...DEFAULT_SETTINGS.colors, ...(parsed?.colors ?? {}) },
      };
    } catch (_) {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(userSettings));
    } catch (_) {}
  }

  let userSettings = loadSettings();
  const _t = Object.keys(DEFAULT_SETTINGS.colors).length;

  let CONFIG              = null; // set after fetchConfig()
  const tileStatuses      = new Map(); // tileId → 1 | 2 | 3 | 7
  const tileUpdatedBy     = new Map(); // tileId → string
  const tileValidatedBy   = new Map(); // tileId → string (only for VERIFIED tiles)
  let tilesEtag           = null;
  let configEtag      = null;

  let sdk            = null;
  let layerVisible   = true;
  let selectedTileId = null;
  let panel          = null;
  let renderTimer    = null;
  let altPressed     = false;

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
    const match = responseHeaders?.match(/etag:\s*(W\/"[^"]*"|"[^"]*")/i)?.[1] ?? null;
    dbg('extractEtag raw headers:', responseHeaders);
    dbg('extractEtag result:', match);
    return match;
  }

  // Shared GET with ETag support. Returns { status, data, etag } or throws.
  async function fetchWithEtag(label, url, currentEtag) {
    const headers = { Accept: 'application/json' };
    if (currentEtag) headers['If-None-Match'] = currentEtag;
    dbg(`${label} → GET ${url}`, headers);

    const res = await apiFetch(url, { headers });
    const etag = extractEtag(res.responseHeaders);
    dbg(`${label} ← status:`, res.status, '| ETag:', etag);

    return { status: res.status, data: res.response, etag };
  }

  async function fetchConfigList() {
    const res = await apiFetch(`${API_BASE}/config/list`, { headers: { Accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`Config list fetch failed: HTTP ${res.status}`);
    return res.response; // array of { id, country, name, ... }
  }

  async function switchConfig(configId) {
    if (userSettings.configId === configId) return;
    userSettings.configId = configId;
    saveSettings();
    configEtag = null;
    tilesEtag  = null;
    CONFIG     = null;
    tileStatuses.clear();
    tileUpdatedBy.clear();
    tileValidatedBy.clear();
    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_NAME }); } catch (_) {}
    clearTimeout(syncTimeout);
    syncTimeout = null;
    await fetchConfig();
    const changed = await fetchTiles();
    if (changed) renderVisibleTiles();
    scheduleSync();
    log(`Switched to config ${configId}.`);
  }

  async function fetchConfig() {
    const { status, data, etag } = await fetchWithEtag('fetchConfig', `${API_BASE}/config/${userSettings.configId}`, configEtag);
    if (status === 304) { dbg('fetchConfig: 304 – unchanged'); return; }
    if (status !== 200) throw new Error(`Config fetch failed: HTTP ${status}`);

    configEtag = etag ?? configEtag;
    dbg('fetchConfig: stored configEtag:', configEtag);
    if (data.version && data.version !== SCRIPT_VERSION) {
      log(`⚠ Version mismatch: script=${SCRIPT_VERSION}, API=${data.version}. Consider updating.`);
    }
    CONFIG = buildConfig(data);
    log(`Config loaded: ${CONFIG.gridRows}×${CONFIG.gridCols} tiles, ${CONFIG.tileSizeKm} km each.`);
  }

  async function fetchTiles() {
    const { status, data, etag } = await fetchWithEtag('fetchTiles', `${API_BASE}/config/${userSettings.configId}/tiles`, tilesEtag);
    if (status === 304) { dbg('fetchTiles: 304 – unchanged'); return false; }
    if (status !== 200) throw new Error(`Tiles fetch failed: HTTP ${status}`);

    tilesEtag = etag ?? tilesEtag;
    dbg('fetchTiles: stored tilesEtag:', tilesEtag);

    tileStatuses.clear();
    tileUpdatedBy.clear();
    tileValidatedBy.clear();
    for (const tile of data.tiles) {
      tileStatuses.set(tile.i, tile.s);
      if (tile.u) tileUpdatedBy.set(tile.i, tile.u);
      if (tile.v) tileValidatedBy.set(tile.i, tile.v);
    }
    dbg('fetchTiles: loaded', tileStatuses.size, 'tiles');
    return true;
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
    return 1 - ((zoom - 15) / 5) * 0.95; // 16–20: linear 1.0 → 0.05
  }

  // ── Layer init & rendering ─────────────────────────────────────────────
  function initLayer() {
    // Base opacities for each status (before zoom fade is applied).
    const BASE_FILL = { 1: 0.35, 2: 0.55, 3: 0.55, 7: 0.55 };

    sdk.Map.addLayer({
      layerName: LAYER_NAME,
      styleContext: {
        getFillColor: ({ feature }) => {
          const c = userSettings.colors;
          const s = feature?.properties?.status;
          if (s === STATUS.EMPTY)       return c.empty;
          if (s === STATUS.IN_PROGRESS) return c.inProgress;
          if (s === STATUS.DONE)        return c.done;
          if (s === STATUS.VERIFIED)    return c.verified;
          return '#000000';
        },
        // fillOpacity: 0 for null tiles, BASE_FILL value for colored tiles × zoom fade.
        getFillOpacity: ({ feature, zoomLevel }) => {
          const base = BASE_FILL[feature?.properties?.status] ?? 0;
          return base * zoomFade(zoomLevel);
        },
        getStrokeColor: () => userSettings.colors.grid,
        // strokeOpacity: only null-status tiles have a stroke (red grid border) – always full.
        getStrokeOpacity: ({ feature }) => {
          return feature?.properties?.status !== null ? 0 : 0.7;
        },
      },
      styleRules: [
        {
          predicate: (p) => p.status === null,
          style: { fillOpacity: '${getFillOpacity}', strokeColor: '${getStrokeColor}', strokeWidth: 1, strokeOpacity: '${getStrokeOpacity}' },
        },
        {
          predicate: (p) => p.status === STATUS.EMPTY,
          style: { fillColor: '${getFillColor}', fillOpacity: '${getFillOpacity}', strokeOpacity: 0 },
        },
        {
          predicate: (p) => p.status === STATUS.IN_PROGRESS,
          style: { fillColor: '${getFillColor}', fillOpacity: '${getFillOpacity}', strokeOpacity: 0 },
        },
        {
          predicate: (p) => p.status === STATUS.DONE,
          style: { fillColor: '${getFillColor}', fillOpacity: '${getFillOpacity}', strokeOpacity: 0 },
        },
        {
          predicate: (p) => p.status === STATUS.VERIFIED,
          style: { fillColor: '${getFillColor}', fillOpacity: '${getFillOpacity}', strokeOpacity: 0 },
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
    if (zoom < CONFIG.colorsZoomMin) {
      try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_NAME }); } catch (_) {}
      return;
    }

    const colorsOnly = zoom < CONFIG.renderZoomMin;

    const bounds = getViewportBounds();
    if (!bounds) return;

    let features;
    if (colorsOnly) {
      // At low zoom iterate only over the small set of colored tiles – avoids
      // the centering cap that would cut off tiles outside a central sub-rectangle.
      features = [];
      for (const [id, status] of tileStatuses) {
        const [row, col] = id.split('_').map(Number);
        const tileSouth = CONFIG.gridOriginLat + row * CONFIG.latStep;
        const tileWest  = CONFIG.gridOriginLon + col * CONFIG.lonStep;
        if (tileSouth + CONFIG.latStep < bounds.south || tileSouth > bounds.north) continue;
        if (tileWest  + CONFIG.lonStep < bounds.west  || tileWest  > bounds.east)  continue;
        features.push({ type: 'Feature', id, geometry: tileIdToGeometry(id), properties: { status } });
      }
    } else {
      const ids = getVisibleTileIds(bounds.south, bounds.west, bounds.north, bounds.east);
      features = ids.map((id) => ({
        type: 'Feature', id,
        geometry: tileIdToGeometry(id),
        properties: { status: tileStatuses.get(id) ?? null },
      }));
    }

    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_NAME }); } catch (_) {}

    if (features.length === 0) return;
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
  // updatedBy: string → set, null → delete, undefined → leave unchanged
  function applyTileStatus(tileId, status, updatedBy = undefined) {
    if (status === null) {
      tileStatuses.delete(tileId);
      tileUpdatedBy.delete(tileId);
      tileValidatedBy.delete(tileId);
    } else {
      tileStatuses.set(tileId, status);
      if (updatedBy === null)          tileUpdatedBy.delete(tileId);
      else if (updatedBy !== undefined) tileUpdatedBy.set(tileId, updatedBy);
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
    const prevStatus    = tileStatuses.get(tileId) ?? null;
    const prevUpdatedBy = tileUpdatedBy.get(tileId) ?? null;
    const user          = sdk.State.getUserInfo()?.userName ?? '';

    applyTileStatus(tileId, newStatus, newStatus === null ? undefined : user); // optimistic

    try {
      if (newStatus === null) {
        const res = await apiFetch(
          `${API_BASE}/config/${userSettings.configId}/tiles/${tileId}`,
          { method: 'DELETE' },
        );
        if (res.status !== 204) throw new Error(`DELETE failed: HTTP ${res.status}`);
      } else {
        const res = await apiFetch(
          `${API_BASE}/config/${userSettings.configId}/tiles/${tileId}`,
          {
            method:  'PATCH',
            headers: { 'Content-Type': 'application/json', 'X-Waze-User': user },
            body:    { status: newStatus },
          },
        );
        if (res.status !== 200) throw new Error(`PATCH failed: HTTP ${res.status}`);
        // Confirm server-side updatedBy (should match, but trust the response)
        if (res.response?.u) tileUpdatedBy.set(tileId, res.response.u);
      }
    } catch (e) {
      log('Status update failed, rolling back:', e);
      applyTileStatus(tileId, prevStatus, prevUpdatedBy); // rollback; null → delete author
    }
  }

  // ── Auto-sync ──────────────────────────────────────────────────────────
  // ── Sync lifecycle ─────────────────────────────────────────────────────
  const MIN_SYNC_GAP = 5_000; // ms – minimum time between any two syncs
  let syncTimeout    = null;
  let lastSyncTime   = 0;

  function syncShouldRun() {
    return layerVisible && document.visibilityState === 'visible';
  }

  function scheduleSync() {
    clearTimeout(syncTimeout);
    syncTimeout = null;
    if (!syncShouldRun()) {
      dbg('Sync paused (layer hidden or tab in background)');
      return;
    }
    syncTimeout = setTimeout(async () => {
      try {
        const changed = await fetchTiles();
        lastSyncTime = Date.now();
        if (changed) renderVisibleTiles();
      } catch (e) {
        log('Sync error (non-fatal):', e);
      } finally {
        scheduleSync();
      }
    }, SYNC_INTERVAL);
    dbg(`Sync scheduled in ${SYNC_INTERVAL / 1000}s`);
  }

  // Run an immediate sync if enough time has passed since last sync,
  // then (re)start the regular scheduler.
  async function syncNowAndResume(reason) {
    if (!syncShouldRun()) return;
    const elapsed = Date.now() - lastSyncTime;
    if (elapsed < MIN_SYNC_GAP) {
      dbg(`${reason} – skipping immediate sync (${elapsed}ms < ${MIN_SYNC_GAP}ms gap), rescheduling`);
      scheduleSync();
      return;
    }
    dbg(`${reason} – syncing immediately`);
    try {
      const changed = await fetchTiles();
      lastSyncTime = Date.now();
      if (changed) renderVisibleTiles();
    } catch (e) {
      log(`Sync error on ${reason} (non-fatal):`, e);
    }
    scheduleSync();
  }

  function startSync() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        syncNowAndResume('tab visible');
      } else {
        dbg('Tab hidden – pausing sync');
        clearTimeout(syncTimeout);
        syncTimeout = null;
      }
    });
    scheduleSync();
  }

  // ── Status panel ───────────────────────────────────────────────────────
  const STATUS_BUTTONS = [
    { label: 'Brak 🚦',    status: STATUS.EMPTY,       bg: '#888888', fg: '#ffffff' },
    { label: 'W trakcie',  status: STATUS.IN_PROGRESS,  bg: '#f5c400', fg: '#333333' },
    { label: 'Gotowe',     status: STATUS.DONE,         bg: '#00a650', fg: '#ffffff' },
    { label: 'Sprawdzone', status: STATUS.VERIFIED,     bg: '#9b59b6', fg: '#ffffff', _g: true },
    { label: '✕ Wyczyść', status: null,                bg: '#dddddd', fg: '#333333' },
  ];

  let panelUserLabel = null;
  let panelBtnRow    = null;
  const statusButtonEls = [];

  function updateButtonColors() {
    const c = userSettings.colors;
    const colorMap = {
      [STATUS.EMPTY]:       c.empty,
      [STATUS.IN_PROGRESS]: c.inProgress,
      [STATUS.DONE]:        c.done,
      [STATUS.VERIFIED]:    c.verified,
    };
    statusButtonEls.forEach((btn) => {
      const s = btn.dataset.s ? Number(btn.dataset.s) : null;
      if (s !== null && colorMap[s]) btn.style.background = colorMap[s];
    });
  }

  function createStatusPanel() {
    const _ur = sdk.State.getUserInfo()?.rank ?? 0;
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

    panelBtnRow = document.createElement('div');
    const btnRow = panelBtnRow;
    STATUS_BUTTONS.forEach(({ label, status, bg, fg, _g }) => {
      if (_g && _ur < _t) return;
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
      btn.dataset.s = String(status ?? '');
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (selectedTileId) updateTileStatus(selectedTileId, status);
        hideStatusPanel();
      });
      btnRow.appendChild(btn);
      statusButtonEls.push(btn);
    });
    panel.appendChild(btnRow);

    panelUserLabel = document.createElement('div');
    panelUserLabel.style.cssText = 'margin-top:5px;font-size:11px;color:#666;text-align:center';
    panel.appendChild(panelUserLabel);

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

    const _ur = sdk.State.getUserInfo()?.rank ?? 0;
    const _iv = tileStatuses.get(tileId) === STATUS.VERIFIED;
    const _ro = _iv && _ur < _t;

    panelBtnRow.style.display = _ro ? 'none' : '';

    // Build info lines: editor and (for VERIFIED) validator.
    const lines = [];
    const updatedBy   = tileUpdatedBy.get(tileId);
    const validatedBy = tileValidatedBy.get(tileId);
    if (updatedBy)   lines.push(`✎ ${updatedBy}`);
    if (validatedBy) lines.push(`☑︎ ${validatedBy}`);
    panelUserLabel.textContent = '';
    lines.forEach((line) => {
      const d = document.createElement('div');
      d.textContent = line;
      panelUserLabel.appendChild(d);
    });
    panelUserLabel.style.display = lines.length ? 'block' : 'none';

    panel.style.display = 'block';
    const h = panel.offsetHeight || 40;
    panel.style.left = `${px}px`;
    panel.style.top  = `${Math.max(4, py - h - 8)}px`;
  }

  function hideStatusPanel() {
    if (panel) panel.style.display = 'none';
    selectedTileId = null;
  }

  // ── Config sidebar tab ─────────────────────────────────────────────────
  async function buildConfigTab() {
    const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = 'MapRaid';
    tabLabel.title = SCRIPT_NAME;

    const colorRows = [
      { key: 'grid',       label: 'Siatka' },
      { key: 'empty',      label: 'Brak 🚦' },
      { key: 'inProgress', label: 'W trakcie' },
      { key: 'done',       label: 'Gotowe' },
      { key: 'verified',   label: 'Sprawdzone' },
    ].map(({ key, label }) => `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
        <label style="flex:1;font-size:13px">${label}</label>
        <input type="color" data-color-key="${key}" value="${userSettings.colors[key]}"
               style="width:40px;height:28px;border:none;cursor:pointer;border-radius:3px;padding:0">
      </div>`).join('');

    tabPane.innerHTML = `
      <div style="padding:10px;font:13px/1.5 sans-serif">
        <strong>${SCRIPT_NAME}</strong>
        <span style="color:#999;font-size:11px;margin-left:4px">v${SCRIPT_VERSION}</span>
        <hr style="margin:8px 0;border:none;border-top:1px solid #ddd">
        <div style="margin-bottom:4px;font-weight:bold">Konfiguracja:</div>
        <select id="${SCRIPT_ID}__configSelect"
                style="width:100%;padding:4px;font-size:12px;margin-bottom:10px;border-radius:3px;border:1px solid #ccc">
          <option value="">Ładowanie…</option>
        </select>
        <hr style="margin:8px 0;border:none;border-top:1px solid #ddd">
        <div style="margin-bottom:8px;font-weight:bold">Kolory statusów:</div>
        ${colorRows}
        <button id="${SCRIPT_ID}__resetColors"
                style="margin-top:4px;padding:4px 10px;font-size:12px;cursor:pointer;border-radius:3px">
          Resetuj kolory
        </button>
      </div>`;

    // ── Config select ──────────────────────────────────────────────────────
    const elSelect = tabPane.querySelector(`#${SCRIPT_ID}__configSelect`);
    fetchConfigList().then((list) => {
      elSelect.innerHTML = list.map((c) =>
        `<option value="${c.id}"${c.id === userSettings.configId ? ' selected' : ''}>${c.country} – ${c.name}</option>`
      ).join('');
    }).catch((e) => {
      log('Config list fetch failed:', e);
      elSelect.innerHTML = `<option value="${userSettings.configId}">Config #${userSettings.configId}</option>`;
    });

    elSelect.addEventListener('change', () => {
      const id = Number(elSelect.value);
      if (id && id !== userSettings.configId) switchConfig(id);
    });

    // ── Color pickers ──────────────────────────────────────────────────────
    tabPane.querySelectorAll('input[data-color-key]').forEach((input) => {
      input.addEventListener('input', () => {
        userSettings.colors[input.dataset.colorKey] = input.value;
        saveSettings();
        updateButtonColors();
        scheduleRender();
      });
    });

    tabPane.querySelector(`#${SCRIPT_ID}__resetColors`).addEventListener('click', () => {
      userSettings.colors = { ...DEFAULT_SETTINGS.colors };
      saveSettings();
      tabPane.querySelectorAll('input[data-color-key]').forEach((inp) => {
        inp.value = userSettings.colors[inp.dataset.colorKey];
      });
      updateButtonColors();
      scheduleRender();
    });
  }

  // ── Click detection ────────────────────────────────────────────────────
  // ── Neighbor status (alt+click) ────────────────────────────────────────
  function getNeighborStatus(tileId) {
    const [row, col] = tileId.split('_').map(Number);
    const neighbors = [
      `${row - 1}_${col - 1}`, `${row - 1}_${col}`, `${row - 1}_${col + 1}`,
      `${row}_${col - 1}`,                           `${row}_${col + 1}`,
      `${row + 1}_${col - 1}`, `${row + 1}_${col}`, `${row + 1}_${col + 1}`,
    ];
    const statuses = neighbors
      .map((id) => tileStatuses.get(id))
      .filter((s) => s !== undefined);
    if (statuses.length === 0) return null;
    return Math.min(...statuses); // priority: 1 > 2 > 3
  }

  function handleMapClick(event) {
    const zoom = sdk.Map.getZoomLevel();
    if ((!altPressed && zoom < CONFIG.uiZoomMin) || zoom > CONFIG.uiZoomMax) {
      hideStatusPanel();
      return;
    }

    const tileId = latLonToTileId(event.lat, event.lon);
    if (!tileId) { hideStatusPanel(); return; }

    if (altPressed) {
      const status = getNeighborStatus(tileId);
      dbg(`alt+click on ${tileId} → neighbor status: ${status}`);
      if (status !== null) updateTileStatus(tileId, status);
      hideStatusPanel();
      return;
    }

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
            clearTimeout(syncTimeout);
            syncTimeout = null;
            dbg('Sync paused (layer hidden via checkbox)');
          } else {
            renderVisibleTiles();
            syncNowAndResume('layer enabled');
          }
        }
      },
    });

    sdk.Events.on({ eventName: 'wme-map-mouse-click', eventHandler: handleMapClick });

    // Alt key tracking (SdkMouseEvent doesn't carry modifiers).
    document.addEventListener('keydown', (e) => { if (e.key === 'Alt') { altPressed = true;  e.preventDefault(); } });
    document.addEventListener('keyup',   (e) => { if (e.key === 'Alt') { altPressed = false; } });
    // Reset if focus lost (e.g. alt+tab).
    window.addEventListener('blur', () => { altPressed = false; });
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────
  async function initScript() {
    try {
      await fetchConfig();
      initLayer();
      createStatusPanel();
      updateButtonColors();
      buildConfigTab(); // no await – doesn't block map init
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
