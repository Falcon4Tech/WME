// ==UserScript==
// @name                WME MapRaid PL Traffic Lights
// @name:pl             WME MapRaid PL Sygnalizacja
// @version             0.6.5
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
// @connect           raw.githubusercontent.com
// @supportURL        https://github.com/Falcon4Tech/WME/issues
// @updateURL         https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_MR_PL_TrafficLights/wme_trafficLights.meta.js
// @downloadURL       https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_MR_PL_TrafficLights/wme_trafficLights.user.js
// ==/UserScript==

(function () {
  'use strict';

  const UW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const SCRIPT_ID      = 'WME_MR_PL_TrafficLights';
  const SCRIPT_VERSION = '0.6.5';
  const SCRIPT_NAME = 'MapRaid TL';
  const START_GUARD = '__WME_MAPRAID_TL_BOOTSTRAPPED__';
  const LAYER_NAME         = 'tl.grid';
  const BORDERS_LAYER_NAME = 'tl.borders';

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
  const warn  = (...args) => console.warn(`[${SCRIPT_NAME}]`, ...args);
  const dbg   = DEBUG ? (...args) => console.log(`[${SCRIPT_NAME}:dbg]`, ...args) : () => {};

  function parseVersion(v) {
    const [x, y, z] = v.split('.').map(Number);
    return x * (1 << 14) + y * (1 << 7) + z;
  }

  // ── State ──────────────────────────────────────────────────────────────
  // null = not yet evaluated (no row in DB)
  // Status definitions are loaded dynamically from server config.
  // id → { id, label, color, ro (bool), _g (int, access threshold), _vb (bool) }
  let STATUS_MAP   = new Map();
  let borderDefs   = new Map(); // id → { id, name, url, color, default }
  const borderFeatures = new Map(); // id → LineString features array (cache)
  const borderFetching = new Set(); // ids currently being fetched

  // ── Settings / LocalStorage ────────────────────────────────────────────────
  const SETTINGS_KEY = SCRIPT_ID;
  const DEFAULT_SETTINGS = {
    configId:     null,
    layerVisible: true,
    colors:       { grid: null },
    statusColors: {},
    borderLayers: {}, // borderId → { visible?, color? }
  };

  function _mergePerConfig(stored, configId) {
    const p = stored.configs?.[configId] ?? {};
    return {
      configId,
      colors:       { ...DEFAULT_SETTINGS.colors,  ...(p.colors       ?? {}) },
      statusColors: { ...(p.statusColors ?? {}) },
      borderLayers: { ...(p.borderLayers ?? {}) },
    };
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return structuredClone(DEFAULT_SETTINGS);
      const stored = JSON.parse(raw);
      if (!stored.configs) return structuredClone(DEFAULT_SETTINGS);
      const merged = _mergePerConfig(stored, stored.configId);
      merged.layerVisible = stored.layerVisible ?? DEFAULT_SETTINGS.layerVisible;
      return merged;
    } catch (_) {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  function saveSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const stored = (raw && JSON.parse(raw)) || {};
      stored.configId     = userSettings.configId;
      stored.layerVisible = userSettings.layerVisible;
      stored.configs  = stored.configs ?? {};
      stored.configs[userSettings.configId] = {
        colors:       userSettings.colors,
        statusColors: userSettings.statusColors,
        borderLayers: userSettings.borderLayers,
      };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
    } catch (_) {}
  }

  function loadPerConfigSettings(configId) {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      const stored = raw ? JSON.parse(raw) : {};
      const merged = _mergePerConfig(stored, configId);
      userSettings.colors       = merged.colors;
      userSettings.statusColors = merged.statusColors;
      userSettings.borderLayers = merged.borderLayers;
    } catch (_) {
      userSettings.colors       = { ...DEFAULT_SETTINGS.colors };
      userSettings.statusColors = {};
      userSettings.borderLayers = {};
    }
  }

  let userSettings = loadSettings();

  let _serverGridColor    = '#ff0000'; // fallback until server config arrives
  let CONFIG              = null; // set after fetchConfig()
  let _serverConfig       = null; // raw config JSON from server, for color reset
  const tileStatuses      = new Map(); // tileId → 1 | 3 | 4 | 5 | 6 | 9
  const tileUpdatedBy     = new Map(); // tileId → string
  const tileValidatedBy   = new Map(); // tileId → string (only for VERIFIED tiles)
  let tilesEtag           = null;
  let configEtag      = null;

  let sdk            = null;
  let layerVisible   = userSettings.layerVisible ?? true;
  let selectedTileId = null;
  let panel          = null;
  let renderTimer    = null;
  let altPressed     = false;
  let panelUserLabel  = null;
  let panelBtnRow     = null;
  let _configTabPane  = null;
  const statusButtonEls = [];
  const runtimeListeners = new Set();

  function cloneJson(value) {
    return value == null ? value : JSON.parse(JSON.stringify(value));
  }

  function getTileStatusCounts() {
    const counts = {};
    for (const status of tileStatuses.values()) {
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }

  function emitRuntimeChange(reason) {
    const detail = { reason, api: UW.WME_MR_PL_TrafficLights_API };
    try {
      window.dispatchEvent(new CustomEvent('WME_MR_PL_TrafficLights:change', { detail }));
    } catch (_) {}
    for (const fn of runtimeListeners) {
      try { fn(detail); } catch (e) { log('Runtime listener error:', e); }
    }
  }

  async function refreshRuntimeConfig() {
    configEtag = null;
    await fetchConfig();
    borderFeatures.clear();
    borderFetching.clear();
    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: BORDERS_LAYER_NAME }); } catch (_) {}
    for (const [id] of borderDefs) {
      if (isBorderVisible(id)) fetchAndRenderBorderLayer(id);
    }
    _rebuildGridColorRow();
    _rebuildStatusColorRows();
    _rebuildBorderRows();
    rebuildStatusPanelButtons();
    updateButtonColors();
    scheduleRender();
    emitRuntimeChange('config-refresh');
  }

  function publishRuntimeApi() {
    UW.WME_MR_PL_TrafficLights_API = {
      scriptId: SCRIPT_ID,
      scriptVersion: SCRIPT_VERSION,
      apiBase: API_BASE,
      apiFetch,
      get sdk() { return sdk; },
      get configId() { return userSettings.configId; },
      get tabPane() { return _configTabPane; },
      get rawConfig() { return cloneJson(_serverConfig); },
      get statuses() { return Array.from(STATUS_MAP.values()).map(cloneJson); },
      get borders() { return Array.from(borderDefs.values()).map(cloneJson); },
      get statusCounts() { return getTileStatusCounts(); },
      refreshConfig: refreshRuntimeConfig,
      onChange(fn) {
        if (typeof fn !== 'function') return () => {};
        runtimeListeners.add(fn);
        return () => runtimeListeners.delete(fn);
      },
    };
    emitRuntimeChange('api-published');
  }

  // ── Config helpers ─────────────────────────────────────────────────────
  function resolveConfigId(list) {
    if (!list?.length) return 1;
    const ids = list.map((c) => c.id);
    if (userSettings.configId && ids.includes(userSettings.configId)) return userSettings.configId;
    return Math.min(...ids);
  }

  function applyServerConfig(cfg) {
    STATUS_MAP.clear();
    borderDefs.clear();
    if (!cfg) return;
    if (cfg.statuses) {
      for (const s of cfg.statuses) {
        STATUS_MAP.set(s.id, { ...s, color: userSettings.statusColors[s.id] ?? s.color });
      }
    }
    if (cfg.borders) {
      for (const b of cfg.borders) borderDefs.set(b.id, b);
    }
    if (cfg.gridColor) _serverGridColor = cfg.gridColor;
  }

  function getEffectiveGridColor() {
    return userSettings.colors.grid ?? _serverGridColor;
  }

  function isBorderVisible(id) {
    const ov = userSettings.borderLayers[id];
    if (ov?.visible !== undefined) return !!ov.visible;
    return !!(borderDefs.get(id)?.default);
  }

  function getBorderColor(id) {
    return userSettings.borderLayers[id]?.color ?? borderDefs.get(id)?.color ?? '#0000ff';
  }

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
        timeout:      20_000,
        onload:       resolve,
        onerror:      reject,
        ontimeout:    reject,
      });
    });
  }

  // Shared GET with ETag support. Returns { status, data, etag } or throws.
  async function fetchWithEtag(label, url, currentEtag) {
    const headers = { Accept: 'application/json' };
    if (currentEtag) headers['If-None-Match'] = currentEtag;
    dbg(`${label} → GET ${url}`, headers);

    const res = await apiFetch(url, { headers });
    const etag = res.responseHeaders?.match(/etag:\s*(W\/"[^"]*"|"[^"]*")/i)?.[1] ?? null;
    dbg(`${label} ← status:`, res.status, '| ETag:', etag);

    return { status: res.status, data: res.response, etag };
  }

  async function fetchConfigList() {
    const res = await apiFetch(`${API_BASE}/config/list`, { headers: { Accept: 'application/json' } });
    if (res.status !== 200) throw new Error(`Config list fetch failed: HTTP ${res.status}`);
    return res.response; // array of { id, country, name, ... }
  }

  let _switchConfigLock = false;

  async function switchConfig(configId) {
    if (userSettings.configId === configId) return;
    if (_switchConfigLock) return;
    _switchConfigLock = true;
    try {
      hideStatusPanel();
      userSettings.configId = configId;
      loadPerConfigSettings(configId);
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
      borderFeatures.clear();
      borderFetching.clear();
      try { sdk.Map.removeAllFeaturesFromLayer({ layerName: BORDERS_LAYER_NAME }); } catch (_) {}
      for (const [id] of borderDefs) {
        if (isBorderVisible(id)) fetchAndRenderBorderLayer(id);
      }
      _rebuildGridColorRow();
      _rebuildStatusColorRows();
      _rebuildBorderRows();
      rebuildStatusPanelButtons();
      const changed = await fetchTiles();
      if (changed) renderVisibleTiles();
      scheduleSync();
      emitRuntimeChange('config-switch');
      log(`Switched to config ${configId}.`);
    } finally {
      _switchConfigLock = false;
    }
  }

  async function fetchConfig() {
    const { status, data, etag } = await fetchWithEtag('fetchConfig', `${API_BASE}/config/${userSettings.configId}`, configEtag);
    if (status === 304) { dbg('fetchConfig: 304 – unchanged'); return; }
    if (status !== 200) throw new Error(`Config fetch failed: HTTP ${status}`);

    configEtag = etag ?? configEtag;
    dbg('fetchConfig: stored configEtag:', configEtag);
    if (data.version && parseVersion(data.version) > parseVersion(SCRIPT_VERSION)) {
      warn(`Version mismatch: script=${SCRIPT_VERSION}, API=${data.version}. Consider updating.`);
    }
    CONFIG = buildConfig(data);
    _serverConfig = data.config ?? null;
    applyServerConfig(_serverConfig);
    emitRuntimeChange('config-loaded');
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
    emitRuntimeChange('tiles-loaded');
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

    sdk.Map.addLayer({
      layerName: LAYER_NAME,
      styleContext: {
        getFillColor:    ({ feature }) => STATUS_MAP.get(feature?.properties?.status)?.color ?? '#888888',
        getFillOpacity:  ({ feature, zoomLevel }) => {
          const base = feature?.properties?.status != null ? 0.55 : 0;
          return base * zoomFade(zoomLevel);
        },
        getStrokeColor:  () => getEffectiveGridColor(),
        getStrokeOpacity: ({ zoomLevel }) => zoomLevel >= CONFIG.renderZoomMin ? 0.7 : 0,
      },
      styleRules: [
        {
          predicate: (p) => p.status === null,
          style: { fillOpacity: 0, strokeColor: '${getStrokeColor}', strokeWidth: 1, strokeOpacity: '${getStrokeOpacity}' },
        },
        {
          predicate: (p) => p.status !== null,
          style: { fillColor: '${getFillColor}', fillOpacity: '${getFillOpacity}', strokeColor: '${getStrokeColor}', strokeWidth: 1, strokeOpacity: '${getStrokeOpacity}' },
        },
      ],
    });

    try {
      sdk.LayerSwitcher.addLayerCheckbox({ name: '▸ MapRaid TL Grid', isChecked: layerVisible });
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

    let bounds;
    try { const [west, south, east, north] = sdk.Map.getMapExtent(); bounds = { south, west, north, east }; }
    catch (_) { return; }

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

  // ── Borders layer ──────────────────────────────────────────────────────

  // Convert Polygon/MultiPolygon features to LineString features (one per ring).
  // SDK requires uniform geometry type; LineString is correct for border lines.
  function geoJsonToLineFeatures(features) {
    const out = [];
    for (const f of features) {
      const polygons =
        f.geometry?.type === 'MultiPolygon' ? f.geometry.coordinates :
        f.geometry?.type === 'Polygon'      ? [f.geometry.coordinates] : [];
      const baseId = f.id ?? f.properties?.JPT_KOD_JE ?? 'brd';
      polygons.forEach((rings, pi) => {
        rings.forEach((ring, ri) => {
          out.push({
            type: 'Feature',
            id: `${baseId}_${pi}_${ri}`,
            geometry: { type: 'LineString', coordinates: ring },
            properties: {},
          });
        });
      });
    }
    return out;
  }

  function initBordersLayer() {
    sdk.Map.addLayer({
      layerName: BORDERS_LAYER_NAME,
      styleContext: {
        getBordersColor: ({ feature }) => getBorderColor(feature?.properties?.borderId),
      },
      styleRules: [
        {
          predicate: () => true,
          style: { strokeColor: '${getBordersColor}', strokeWidth: 2, strokeOpacity: 1 },
        },
      ],
    });
    for (const [id] of borderDefs) {
      if (isBorderVisible(id)) fetchAndRenderBorderLayer(id);
    }
  }

  async function fetchAndRenderBorderLayer(borderId) {
    const cached = borderFeatures.get(borderId);
    if (cached) {
      try { sdk.Map.addFeaturesToLayer({ layerName: BORDERS_LAYER_NAME, features: cached }); } catch (_) {}
      return;
    }
    if (borderFetching.has(borderId)) return;
    borderFetching.add(borderId);
    try {
      const def = borderDefs.get(borderId);
      if (!def) return;
      const res = await apiFetch(def.url);
      if (res.status !== 200) { log(`Borders[${borderId}] fetch failed: ${res.status}`); return; }
      const features = geoJsonToLineFeatures(res.response?.features ?? []).map((f) => ({
        ...f, id: `b${borderId}_${f.id}`, properties: { borderId },
      }));
      borderFeatures.set(borderId, features);
      if (isBorderVisible(borderId))
        sdk.Map.addFeaturesToLayer({ layerName: BORDERS_LAYER_NAME, features });
      log(`Borders[${borderId}] loaded: ${features.length} features`);
    } catch (e) {
      log(`Borders[${borderId}] fetch error:`, e);
    } finally {
      borderFetching.delete(borderId);
    }
  }

  function refreshBordersLayer() {
    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: BORDERS_LAYER_NAME }); } catch (_) {}
    for (const [id] of borderDefs) {
      if (!isBorderVisible(id)) continue;
      const features = borderFeatures.get(id);
      if (features) {
        try { sdk.Map.addFeaturesToLayer({ layerName: BORDERS_LAYER_NAME, features }); } catch (_) {}
      } else {
        fetchAndRenderBorderLayer(id);
      }
    }
  }

  // ── Status update with API + rollback ─────────────────────────────────
  const _pendingTiles = new Set(); // prevents concurrent updates on the same tile
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
    if (_pendingTiles.has(tileId)) return;
    _pendingTiles.add(tileId);

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
    } finally {
      _pendingTiles.delete(tileId);
    }
  }

  // ── Sync lifecycle ─────────────────────────────────────────────────────
  const MIN_SYNC_GAP = 15_000; // ms – minimum time between any two syncs
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
    const delay = SYNC_INTERVAL + Math.random() * 1777;
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
    }, delay);
    dbg(`Sync scheduled in ${(delay / 1000).toFixed(2)}s`);
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
  function _attachStatusColorListeners(container) {
    container.querySelectorAll('input[data-status-id]').forEach((input) => {
      input.addEventListener('input', () => {
        const id = Number(input.dataset.statusId);
        userSettings.statusColors[id] = input.value;
        const entry = STATUS_MAP.get(id);
        if (entry) entry.color = input.value;
        saveSettings();
        updateButtonColors();
        scheduleRender();
      });
    });
  }

  function _rebuildGridColorRow() {
    if (!_configTabPane) return;
    const input = _configTabPane.querySelector(`#${SCRIPT_ID}__gridColor`);
    if (input) input.value = getEffectiveGridColor();
  }

  function _rebuildStatusColorRows() {
    if (!_configTabPane) return;
    const container = _configTabPane.querySelector(`#${SCRIPT_ID}__statusColors`);
    if (!container) return;
    container.innerHTML = '';
    for (const s of STATUS_MAP.values()) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';
      const label = document.createElement('label');
      label.style.cssText = 'flex:1;font-size:13px';
      label.textContent = s.label;
      const input = document.createElement('input');
      input.type = 'color';
      input.dataset.statusId = String(s.id);
      input.value = s.color;
      input.style.cssText = 'width:40px;height:28px;border:none;cursor:pointer;border-radius:3px;padding:0';
      row.appendChild(label);
      row.appendChild(input);
      container.appendChild(row);
    }
    _attachStatusColorListeners(container);
  }

  function _populateStatusButtons(container) {
    statusButtonEls.length = 0;
    const _ur = sdk.State.getUserInfo()?.rank ?? 0;
    const defs = [];
    for (const [id, s] of STATUS_MAP) {
      if (!s.ro && (_ur ?? 0) >= (s._g ?? 0))
        defs.push({ label: s.label, status: id, bg: s.color, fg: '#ffffff' });
    }
    defs.push({ label: '✕ Wyczyść', status: null, bg: '#dddddd', fg: '#333333' });
    for (const { label, status, bg, fg } of defs) {
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
        if (selectedTileId) {
          scheduleSync();
          updateTileStatus(selectedTileId, status);
        }
        hideStatusPanel();
      });
      container.appendChild(btn);
      statusButtonEls.push(btn);
    }
  }

  function rebuildStatusPanelButtons() {
    if (!panelBtnRow) return;
    panelBtnRow.innerHTML = '';
    _populateStatusButtons(panelBtnRow);
  }

  function updateButtonColors() {
    statusButtonEls.forEach((btn) => {
      const s = btn.dataset.s ? Number(btn.dataset.s) : null;
      const color = s !== null ? STATUS_MAP.get(s)?.color : null;
      if (color) btn.style.background = color;
    });
  }

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

    panelBtnRow = document.createElement('div');
    _populateStatusButtons(panelBtnRow);
    panel.appendChild(panelBtnRow);

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
    const _sd = STATUS_MAP.get(tileStatuses.get(tileId));
    const _ro = _sd?.ro || (_ur < (_sd?._g ?? 0));

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

  function _rebuildBorderRows() {
    if (!_configTabPane) return;
    const container = _configTabPane.querySelector(`#${SCRIPT_ID}__borderLayers`);
    if (!container) return;
    container.innerHTML = '';
    for (const [id, def] of borderDefs) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:6px';

      const chk = document.createElement('input');
      chk.type = 'checkbox';
      chk.checked = isBorderVisible(id);
      chk.style.cssText = 'cursor:pointer;flex-shrink:0';
      chk.addEventListener('change', () => {
        userSettings.borderLayers[id] = { ...(userSettings.borderLayers[id] ?? {}), visible: chk.checked };
        saveSettings();
        refreshBordersLayer();
      });

      const lbl = document.createElement('label');
      lbl.style.cssText = 'flex:1;font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer';
      lbl.appendChild(chk);
      const span = document.createElement('span');
      span.textContent = def.name;
      lbl.appendChild(span);

      const colorPicker = document.createElement('input');
      colorPicker.type = 'color';
      colorPicker.value = getBorderColor(id);
      colorPicker.style.cssText = 'width:40px;height:28px;border:none;cursor:pointer;border-radius:3px;padding:0';
      colorPicker.addEventListener('input', () => {
        userSettings.borderLayers[id] = { ...(userSettings.borderLayers[id] ?? {}), color: colorPicker.value };
        saveSettings();
        refreshBordersLayer();
      });

      row.appendChild(lbl);
      row.appendChild(colorPicker);
      container.appendChild(row);
    }
  }

  // ── Config sidebar tab ─────────────────────────────────────────────────
  async function buildConfigTab(configList) {
    const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = 'MapRaid';
    tabLabel.title = SCRIPT_NAME;
    _configTabPane = tabPane;

    tabPane.innerHTML = `
      <div style="padding:10px;font:13px/1.5 sans-serif">
        <strong>${SCRIPT_NAME}</strong>
        <span style="color:#999;font-size:11px;margin-left:4px">v${SCRIPT_VERSION}</span>
        <hr style="margin:8px 0;border:none;border-top:1px solid #ddd">
        <div style="margin-bottom:4px;font-weight:bold">Konfiguracja:</div>
        <select id="${SCRIPT_ID}__configSelect"
                style="width:100%;padding:4px;font-size:12px;margin-bottom:10px;border-radius:3px;border:1px solid #ccc">
        </select>
        <hr style="margin:8px 0;border:none;border-top:1px solid #ddd">
        <div style="margin-bottom:8px;font-weight:bold">Kolory:</div>
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
          <label style="flex:1;font-size:13px">Siatka</label>
          <input type="color" id="${SCRIPT_ID}__gridColor" data-color-key="grid" value="${getEffectiveGridColor()}"
                 style="width:40px;height:28px;border:none;cursor:pointer;border-radius:3px;padding:0">
        </div>
        <div id="${SCRIPT_ID}__statusColors"></div>
        <button id="${SCRIPT_ID}__resetColors"
                style="margin-top:4px;padding:4px 10px;font-size:12px;cursor:pointer;border-radius:3px">
          Resetuj kolory
        </button>
        <hr style="margin:10px 0;border:none;border-top:1px solid #ddd">
        <div style="margin-bottom:8px;font-weight:bold">Granice:</div>
        <div id="${SCRIPT_ID}__borderLayers"></div>
      </div>`;

    // Fill dynamic rows now (STATUS_MAP + borderDefs already populated from fetchConfig)
    _rebuildStatusColorRows();
    _rebuildBorderRows();

    // ── Config select ──────────────────────────────────────────────────────
    const elSelect = tabPane.querySelector(`#${SCRIPT_ID}__configSelect`);
    if (configList?.length) {
      for (const c of configList) {
        const opt = document.createElement('option');
        opt.value = String(c.id);
        opt.textContent = `${c.country} – ${c.name}`;
        opt.selected = c.id === userSettings.configId;
        elSelect.appendChild(opt);
      }
    } else {
      const opt = document.createElement('option');
      opt.value = String(userSettings.configId);
      opt.textContent = `Config #${userSettings.configId}`;
      elSelect.appendChild(opt);
    }
    elSelect.addEventListener('change', () => {
      const id = Number(elSelect.value);
      if (id && id !== userSettings.configId) switchConfig(id);
    });

    // ── Grid color picker ──────────────────────────────────────────────────
    tabPane.querySelectorAll('input[data-color-key]').forEach((input) => {
      input.addEventListener('input', () => {
        userSettings.colors[input.dataset.colorKey] = input.value;
        saveSettings();
        scheduleRender();
      });
    });

    tabPane.querySelector(`#${SCRIPT_ID}__resetColors`).addEventListener('click', () => {
      userSettings.statusColors = {};
      userSettings.borderLayers = {};
      userSettings.colors.grid = null;
      applyServerConfig(_serverConfig);
      saveSettings();
      _rebuildGridColorRow();
      _rebuildStatusColorRows();
      _rebuildBorderRows();
      rebuildStatusPanelButtons();
      updateButtonColors();
      refreshBordersLayer();
      scheduleRender();
    });
    emitRuntimeChange('tab-ready');
  }

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
      .filter((s) => s !== undefined && !STATUS_MAP.get(s)?.ro && s !== 1);
    if (statuses.length === 0) return null;
    return Math.min(...statuses); // 3 < 4 < 5 < 6 numerically — Math.min picks the most urgent
  }

  function handleMapClick(event) {
    if (!layerVisible) { hideStatusPanel(); return; }
    const zoom = sdk.Map.getZoomLevel();
    if ((!altPressed && zoom < CONFIG.uiZoomMin) || zoom > CONFIG.uiZoomMax) {
      hideStatusPanel();
      return;
    }

    const tileId = latLonToTileId(event.lat, event.lon);
    if (!tileId) { hideStatusPanel(); return; }

    // Tiles with ro=true are system-set and cannot be changed by users.
    const _ts = tileStatuses.get(tileId);
    if (STATUS_MAP.get(_ts)?.ro || _ts === 1) { hideStatusPanel(); return; }

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
          userSettings.layerVisible = layerVisible;
          saveSettings();
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
      let configList;
      try {
        configList = await fetchConfigList();
        const resolved = resolveConfigId(configList);
        if (resolved !== userSettings.configId) {
          userSettings.configId = resolved;
          saveSettings();
        }
      } catch (e) {
        log('Config list fetch failed (non-fatal):', e);
        configList = null;
      }
      await fetchConfig();
      initLayer();
      initBordersLayer();
      createStatusPanel();
      updateButtonColors();
      buildConfigTab(configList); // no await – doesn't block map init
      registerEvents();
      await fetchTiles();
      lastSyncTime = Date.now();
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
          publishRuntimeApi();
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
