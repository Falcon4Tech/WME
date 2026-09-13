// ==UserScript==
// @name                                     WME Onion Layers
// @name:pl                                     WME Cebula
// @version                                      Beta.17
// @tag                                            WME
// @description                 Adds custom SDK layers to WME (GeoJSON + raster tiles).
// @description:pl              Dodaje niestandardowe warstwy SDK do WME (GeoJSON + raster tile).
// @grant             GM_xmlhttpRequest
// @connect           cdn.jsdelivr.net
// @author            FalconTech
// @run-at            document-idle
// @namespace         https://wazepolska.pl
// @match             https://*.waze.com/editor*
// @match             https://*.waze.com/*/editor*
// @exclude           https://*.waze.com/user/editor*
// @exclude           https://*.waze.com/*/user/editor*
// @exclude           https://*.waze.com/editor/sdk/*
// @supportURL        https://github.com/Falcon4Tech/WME/issues
// @icon              https://polska.e-mapa.net/implementation/polska/images/icon.ico
// @updateURL         https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_Onion_Layers/wme_onion.meta.js
// @downloadURL       https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_Onion_Layers/wme_onion.user.js
// ==/UserScript==

/* eslint-disable no-multi-spaces */

(function () {
  'use strict';

  const UW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const SCRIPT_ID   = 'WME_Onion_Layers';
  const SCRIPT_NAME = 'WME Cebula';
  const START_GUARD = '__WME_ONION_SDK_BOOTSTRAPPED__';

  const STATE_KEY     = SCRIPT_ID;
  const STATE_VERSION = 2;
  const DEBUG_TILES   = false;

  const LAYER_NAME_PREFIX     = 'onion.';
  const CHECKBOX_NAME_PREFIX  = '⫸ ';
  const ROADS_LAYER_NAME      = 'segments';
  const ROW_BASE_LAYER_ID     = 'row_live_base';
  const GEOPORTAL_STANDARD_LAYER_ID = 'geoportal_orto_standard';
  const GRANICE_LAYER_ID    = 'granice';
  const MIASTA_LAYER_ID     = 'miasta';
  const PRG_ULICE_LAYER_ID  = 'prg-ulice';
  const PRG_ADRESY_LAYER_ID = 'prg-adresy';
  const PRG_PLACE_LAYER_ID  = 'prg-place';

  // Basemaps should live below WME roads.
  const BASEMAP_LAYER_IDS = [
    ROW_BASE_LAYER_ID,
    GEOPORTAL_STANDARD_LAYER_ID,
  ];

  // Overlays should live above WME roads.
  // wms-snapped layers manage their own DOM element and z-index; they are not listed here.
  const OVERLAY_LAYER_IDS = [
    GRANICE_LAYER_ID,
    MIASTA_LAYER_ID,
  ];

  const ROW_TARGET_ZINDEX_FALLBACK      = 2011;
  const ROW_OFFSET_BELOW_ROADS          = 49;
  const OVERLAY_TARGET_ZINDEX_FALLBACK  = 2200;
  const OVERLAY_OFFSET_ABOVE_ROADS      = 10;
  const MAX_REASONABLE_ROADS_ZINDEX     = 2150;

  const DATA_BASE_URL     = `https://cdn.jsdelivr.net/gh/Falcon4Tech/WME@main/${SCRIPT_ID}/data`;

  const PROXY_WMS_BASE    = 'https://proxy.labtool.pl/wms?url=';
  const PROXY_HOST        = 'proxy.labtool.pl';
  const MAX_CONCURRENT_PROXY_REQUESTS = 4;
  const SNAPPED_REFRESH_DEBOUNCE_MS = 575;
  const WEB_MERCATOR_HALF = 20037508.342789244;

  const DEFAULT_GEOJSON_STYLE = {
    strokeColor: '#ff0000',
    strokeWidth: 3,
    strokeOpacity: 0.9,
    fillColor: '#ff0000',
    fillOpacity: 0.15,
  };

  if (UW[START_GUARD]) {
    return;
  }
  UW[START_GUARD] = true;

  const log = (...args) => console.log(`[${SCRIPT_NAME}]`, ...args);

  const LAYERS = [
    {
      id: 'row_live_base',
      type: 'tile',
      name: 'ROW LiveMap',
      defaultOn: false,
      tileWidth: 256,
      tileHeight: 256,
      servers: ['https://www.waze.com'],
      fileName: 'row-tiles/live/base/${z}/${x}/${y}/tile.png',
      params: {
        'highres': true,
      },
    },
    {
      id: GEOPORTAL_STANDARD_LAYER_ID,
      type: 'tile',
      name: 'Geoportal Orto',
      defaultOn: false,
      tileWidth: 256,
      tileHeight: 256,
      servers: ['https://proxy.labtool.pl'],
      fileName: 'onion/geoportal-orto-standard~${z}~${x}~${y}@256.jpg',
      maxZoom: 19, // upstream WMTS (EPSG:3857) has no TileMatrixSetLimits beyond z19
      params: {},
    },
    {
      id: GRANICE_LAYER_ID,
      type: 'tile',
      name: 'Granice - obręby',
      defaultOn: false,
      tileWidth: 1024,
      tileHeight: 1024,
      servers: ['https://proxy.labtool.pl'],
      fileName: 'onion/granice~${z}~${x}~${y}@1024.png',
      minZoom: 13,
      params: {},
    },
    {
      id: MIASTA_LAYER_ID,
      type: 'tile',
      name: 'Miasta',
      defaultOn: false,
      tileWidth: 512,
      tileHeight: 512,
      servers: ['https://proxy.labtool.pl'],
      fileName: 'onion/miasta~${z}~${x}~${y}@512.png',
      params: {},
    },
    {
      id: 'kieg-dzialki',
      type: 'tile',
      name: 'Działki',
      defaultOn: false,
      tileWidth: 1024,
      tileHeight: 1024,
      servers: ['https://proxy.labtool.pl'],
      fileName: 'onion/kieg-dzialki~${z}~${x}~${y}@1024.png',
      minZoom: 15,
      params: {},
    },
    {
      id: 'sct-warszawa',
      type: 'geojson',
      name: 'SCT - Warszawa',
      defaultOn: false,
      saveState: false,
      lazyLoad: true,
      dataUrl: `${DATA_BASE_URL}/sct-warszawa.geojson`,
      styleRules: [{ style: DEFAULT_GEOJSON_STYLE }],
    },
    {
      id: 'sct-krakow',
      type: 'geojson',
      name: 'SCT - Krakow',
      defaultOn: false,
      saveState: false,
      lazyLoad: true,
      dataUrl: `${DATA_BASE_URL}/sct-krakow.geojson`,
      styleRules: [{ style: DEFAULT_GEOJSON_STYLE }],
    },
    {
      id: PRG_ULICE_LAYER_ID,
      type: 'wms-snapped',
      name: 'Ulice',
      defaultOn: false,
      wmsLayers: 'A08_Ulice_Linie',
      snapPixels: 256,
      minZoom: 15,
    },
    {
      id: PRG_ADRESY_LAYER_ID,
      type: 'wms-snapped',
      name: 'Adresy',
      defaultOn: false,
      wmsLayers: 'A07_Punkty_adresowe',
      snapPixels: 256,
      minZoom: 17,
    },
    {
      id: PRG_PLACE_LAYER_ID,
      type: 'wms-snapped',
      name: 'Miejsca',
      defaultOn: false,
      wmsLayers: 'A08_Ulice_Powierzchnie',
      snapPixels: 256,
      minZoom: 15,
    },
  ];

  const RUNTIME = {
    initialized: false,
    layerByCheckboxName: new Map(),
    layerById: new Map(),
    sdk: null,
    sessionLayerState: new Map(),
    state: null,
    stopEventListeners: [],
    zIndexSyncTimer: null,
    snappedRefreshTimer: null,
  };

  function normalizeBooleanRecord(value) {
    const result = {};
    if (!value || typeof value !== 'object') return result;

    for (const [key, val] of Object.entries(value)) {
      if (typeof val === 'boolean') {
        result[key] = val;
      }
    }
    return result;
  }

  function getDefaultState() {
    return {
      version: STATE_VERSION,
      layers: {},
    };
  }

  function parseState(raw) {
    if (!raw) {
      return { migrated: false, state: getDefaultState() };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { migrated: true, state: getDefaultState() };
    }

    if (parsed && typeof parsed === 'object' && parsed.version === STATE_VERSION) {
      return {
        migrated: false,
        state: {
          version: STATE_VERSION,
          layers: normalizeBooleanRecord(parsed.layers),
        },
      };
    }

    // Legacy V1 shape: { groupEnabled, groupCollapsed, layers: { [id]: boolean } }
    if (parsed && typeof parsed === 'object' && parsed.layers && typeof parsed.layers === 'object') {
      return {
        migrated: true,
        state: {
          version: STATE_VERSION,
          layers: normalizeBooleanRecord(parsed.layers),
        },
      };
    }

    // Defensive migration for any stale format.
    return { migrated: true, state: getDefaultState() };
  }

  function persistState() {
    localStorage.setItem(STATE_KEY, JSON.stringify(RUNTIME.state));
  }

  function initializeState() {
    const raw = localStorage.getItem(STATE_KEY);
    const { state, migrated } = parseState(raw);
    RUNTIME.state = state;

    if (migrated) {
      persistState();
    }
  }

  function shouldPersistLayerState(layerDefinition) {
    return layerDefinition.saveState !== false;
  }

  function getWantedLayerState(layerDefinition) {
    if (!layerDefinition) return false;

    if (!shouldPersistLayerState(layerDefinition)) {
      if (RUNTIME.sessionLayerState.has(layerDefinition.id)) {
        return RUNTIME.sessionLayerState.get(layerDefinition.id);
      }
      return !!layerDefinition.defaultOn;
    }

    const stored = RUNTIME.state.layers[layerDefinition.id];
    if (typeof stored === 'boolean') {
      return stored;
    }

    return !!layerDefinition.defaultOn;
  }

  function setWantedLayerState(layerDefinition, enabled) {
    if (!layerDefinition) return;

    if (!shouldPersistLayerState(layerDefinition)) {
      RUNTIME.sessionLayerState.set(layerDefinition.id, !!enabled);
      return;
    }

    RUNTIME.state.layers[layerDefinition.id] = !!enabled;
    persistState();
  }

  function getLayerName(layerDefinition) {
    return `${LAYER_NAME_PREFIX}${layerDefinition.id}`;
  }

  function getCheckboxName(layerDefinition) {
    return `${CHECKBOX_NAME_PREFIX}${layerDefinition.name}`;
  }

  function isAlreadyExistsError(error) {
    if (!error || error.name !== 'InvalidStateError') return false;
    const message = String(error.message ?? '').toLowerCase();
    return message.includes('already exists');
  }

  function isMissingStateError(error) {
    if (!error || error.name !== 'InvalidStateError') return false;
    const message = String(error.message ?? '').toLowerCase();
    return message.includes('does not exist') || message.includes('not found');
  }

  function safeSetLayerVisibility(layerName, visibility) {
    try {
      RUNTIME.sdk.Map.setLayerVisibility({ layerName, visibility: !!visibility });
      return true;
    } catch (error) {
      if (!isMissingStateError(error)) {
        log('Failed to set layer visibility:', layerName, error);
      }
      return false;
    }
  }

  function safeSetLayerZIndex(layerName, zIndex) {
    try {
      RUNTIME.sdk.Map.setLayerZIndex({ layerName, zIndex });
    } catch (error) {
      if (!isMissingStateError(error)) {
        log('Failed to set layer z-index:', layerName, error);
      }
    }
  }

  function safeGetLayerZIndex(layerName) {
    try {
      const value = RUNTIME.sdk.Map.getLayerZIndex({ layerName });
      return value;
    } catch (error) {
      if (!isMissingStateError(error)) {
        log('Failed to get layer z-index:', layerName, error);
      }
      return null;
    }
  }

  function resolveRowTargetZIndex() {
    const roadsZIndex = safeGetLayerZIndex(ROADS_LAYER_NAME);

    if (
      roadsZIndex !== null &&
      Number.isFinite(roadsZIndex) &&
      roadsZIndex <= MAX_REASONABLE_ROADS_ZINDEX
    ) {
      return roadsZIndex - ROW_OFFSET_BELOW_ROADS;
    }

    return ROW_TARGET_ZINDEX_FALLBACK;
  }

  function resolveOverlayTargetZIndex() {
    const roadsZIndex = safeGetLayerZIndex(ROADS_LAYER_NAME);

    if (
      roadsZIndex !== null &&
      Number.isFinite(roadsZIndex) &&
      roadsZIndex <= MAX_REASONABLE_ROADS_ZINDEX
    ) {
      return roadsZIndex + OVERLAY_OFFSET_ABOVE_ROADS;
    }

    return OVERLAY_TARGET_ZINDEX_FALLBACK;
  }

  function applyRelativeLayerStacking() {
    const targetRowZIndex = resolveRowTargetZIndex();
    for (const layerId of BASEMAP_LAYER_IDS) {
      const layerRuntime = RUNTIME.layerById.get(layerId);
      if (!layerRuntime) continue;
      if (layerRuntime.definition.type === 'tile' && !layerRuntime.tileRegistered) continue;
      safeSetLayerZIndex(layerRuntime.layerName, targetRowZIndex);
    }

    const targetOverlayZIndex = resolveOverlayTargetZIndex();
    for (const layerId of OVERLAY_LAYER_IDS) {
      const layerRuntime = RUNTIME.layerById.get(layerId);
      if (!layerRuntime) continue;
      if (layerRuntime.definition.type === 'tile' && !layerRuntime.tileRegistered) continue;
      safeSetLayerZIndex(layerRuntime.layerName, targetOverlayZIndex);
    }
  }

  function scheduleRelativeLayerStacking(delayMs = 0) {
    if (RUNTIME.zIndexSyncTimer !== null) {
      clearTimeout(RUNTIME.zIndexSyncTimer);
      RUNTIME.zIndexSyncTimer = null;
    }

    RUNTIME.zIndexSyncTimer = setTimeout(() => {
      RUNTIME.zIndexSyncTimer = null;
      applyRelativeLayerStacking();
    }, delayMs);
  }

  // --- Zoom refresh helpers ---

  function getCurrentZoomLevel() {
    try {
      return RUNTIME.sdk.Map.getZoomLevel();
    } catch (error) {
      log('Failed to read zoom level from SDK:', error);
      return null;
    }
  }

  // Returns true when zoomLevel is within the layer's optional minZoom/maxZoom range.
  // Missing bounds are treated as unbounded. Null/undefined zoomLevel always passes.
  function isZoomAllowed(layerDefinition, zoomLevel) {
    if (zoomLevel === null || zoomLevel === undefined) return true;
    if (layerDefinition.minZoom !== undefined && zoomLevel < layerDefinition.minZoom) return false;
    if (layerDefinition.maxZoom !== undefined && zoomLevel > layerDefinition.maxZoom) return false;
    return true;
  }

  // Applies zoom-based visibility gating to all tile layers.
  // Does NOT touch checkbox state or localStorage.
  async function applyZoomGatingForTiles() {
    const zoomLevel = getCurrentZoomLevel();
    for (const [, layerRuntime] of RUNTIME.layerById) {
      if (layerRuntime.definition.type !== 'tile') continue;
      const wanted = getWantedLayerState(layerRuntime.definition);
      if (!wanted) continue;
      if (!isZoomAllowed(layerRuntime.definition, zoomLevel)) {
        safeSetLayerVisibility(layerRuntime.layerName, false);
      } else {
        ensureTileLayerRegistered(layerRuntime);
        safeSetLayerVisibility(layerRuntime.layerName, true);
      }
    }
  }

  // During zoom animation WME may keep showing tiles from the previous zoom level.
  function scheduleOverlayTileRefreshAfterZoom() {
    const zoomLevel = getCurrentZoomLevel();

    for (const layerId of OVERLAY_LAYER_IDS) {
      const layerRuntime = RUNTIME.layerById.get(layerId);
      if (!layerRuntime) continue;
      if (layerRuntime.definition.type !== 'tile') continue;

      const wanted = getWantedLayerState(layerRuntime.definition);
      if (!wanted) continue;

      if (!isZoomAllowed(layerRuntime.definition, zoomLevel)) {
        safeSetLayerVisibility(layerRuntime.layerName, false);
        continue;
      }

      ensureTileLayerRegistered(layerRuntime);
      safeSetLayerVisibility(layerRuntime.layerName, true);
    }

    // Refresh composite WMS layers — their sublayer zoom gates may have changed.
    for (const [, layerRuntime] of RUNTIME.layerById) {
      if (layerRuntime.definition.type === 'wms-composite') {
        applyCompositeLayerVisibility(layerRuntime);
      }
    }

    // Reload snapped WMS layers
    if (RUNTIME.snappedRefreshTimer !== null) {
      clearTimeout(RUNTIME.snappedRefreshTimer);
    }
    RUNTIME.snappedRefreshTimer = setTimeout(() => {
      RUNTIME.snappedRefreshTimer = null;
      updateAllSnappedLayers();
    }, SNAPPED_REFRESH_DEBOUNCE_MS);
  }

  function safeSetLayerCheckboxChecked(checkboxName, isChecked) {
    try {
      const current = RUNTIME.sdk.LayerSwitcher.isLayerCheckboxChecked({ name: checkboxName });
      if (current !== !!isChecked) {
        RUNTIME.sdk.LayerSwitcher.setLayerCheckboxChecked({ name: checkboxName, isChecked: !!isChecked });
      }
    } catch (error) {
      if (!isMissingStateError(error)) {
        log('Failed to set checkbox state:', checkboxName, error);
      }
    }
  }

  function ensureScriptSdk() {
    if (typeof UW.getWmeSdk !== 'function') {
      throw new Error('window.getWmeSdk is unavailable');
    }

    return UW.getWmeSdk({
      scriptId: SCRIPT_ID,
      scriptName: SCRIPT_NAME,
    });
  }

  function requestText(url) {
    if (typeof GM_xmlhttpRequest === 'function') {
      return new Promise((resolve, reject) => {
        GM_xmlhttpRequest({
          method: 'GET',
          onerror: () => reject(new Error(`Network error for ${url}`)),
          onload: (response) => {
            if (response.status >= 200 && response.status < 300) {
              resolve(response.responseText);
              return;
            }
            reject(new Error(`HTTP ${response.status} for ${url}`));
          },
          url,
        });
      });
    }

    return fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }
      return response.text();
    });
  }

  function normalizeFeatureProperties(properties) {
    if (!properties || typeof properties !== 'object') {
      return undefined;
    }

    const result = {};
    for (const [key, value] of Object.entries(properties)) {
      if (value === null || typeof value === 'string' || typeof value === 'number') {
        result[key] = value;
      } else if (typeof value === 'boolean') {
        result[key] = String(value);
      }
    }

    return Object.keys(result).length ? result : undefined;
  }

  function splitGeometryToAtomic(geometry) {
    if (!geometry || typeof geometry !== 'object' || typeof geometry.type !== 'string') {
      return [];
    }

    switch (geometry.type) {
      case 'Point':
      case 'LineString':
      case 'Polygon':
        return [geometry];
      case 'MultiPoint':
        return Array.isArray(geometry.coordinates)
          ? geometry.coordinates.map((coordinates) => ({ type: 'Point', coordinates }))
          : [];
      case 'MultiLineString':
        return Array.isArray(geometry.coordinates)
          ? geometry.coordinates.map((coordinates) => ({ type: 'LineString', coordinates }))
          : [];
      case 'MultiPolygon':
        return Array.isArray(geometry.coordinates)
          ? geometry.coordinates.map((coordinates) => ({ type: 'Polygon', coordinates }))
          : [];
      case 'GeometryCollection': {
        if (!Array.isArray(geometry.geometries)) {
          return [];
        }

        const parts = [];
        for (const innerGeometry of geometry.geometries) {
          parts.push(...splitGeometryToAtomic(innerGeometry));
        }
        return parts;
      }
      default:
        return [];
    }
  }

  function normalizeSourceFeatures(geojson) {
    if (!geojson || typeof geojson !== 'object') {
      return [];
    }

    if (geojson.type === 'FeatureCollection') {
      return Array.isArray(geojson.features) ? geojson.features : [];
    }

    if (geojson.type === 'Feature') {
      return [geojson];
    }

    return [
      {
        geometry: geojson,
        properties: {},
        type: 'Feature',
      },
    ];
  }

  function buildSdkFeatures(layerDefinition, geojson) {
    const sourceFeatures = normalizeSourceFeatures(geojson);
    const sdkFeatures = [];
    let index = 0;

    for (const sourceFeature of sourceFeatures) {
      const atomicGeometries = splitGeometryToAtomic(sourceFeature.geometry);
      if (!atomicGeometries.length) continue;

      const properties = normalizeFeatureProperties(sourceFeature.properties);

      for (const geometry of atomicGeometries) {
        sdkFeatures.push({
          geometry,
          id: `${layerDefinition.id}-${index}`,
          properties,
          type: 'Feature',
        });
        index += 1;
      }
    }

    return sdkFeatures;
  }

  // ---------- WMS 1.3.0 URL builders (OpenLayers hooks) ----------

  function getUrlAsWms130(bounds) {
    bounds = bounds.clone();
    bounds = this.adjustBounds(bounds);
    const imageSize = this.getImageSize(bounds);
    const mapProj = this.map.getProjectionObject();
    const mapCode = mapProj?.getCode ? mapProj.getCode() : 'EPSG:900913';
    const reqSrs = this.requestSrs || this.params.CRS || mapCode;
    if (reqSrs !== mapCode) {
      try {
        bounds.transform(mapProj, new UW.OpenLayers.Projection(reqSrs));
      } catch (_) { }
    }
    return this.getFullRequestString({ BBOX: bounds.toArray(false), WIDTH: imageSize.w, HEIGHT: imageSize.h });
  }

  function setWmsCrs130(newParams, altUrl) {
    const crs = this.requestSrs || this.params.CRS;
    if (crs) this.params.CRS = crs;
    if (this.params.SRS) delete this.params.SRS;
    return UW.OpenLayers.Layer.Grid.prototype.getFullRequestString.apply(this, arguments);
  }

  function buildWmsOlLayer(definition) {
    const layer = new UW.OpenLayers.Layer.WMS(definition.name, definition.url, {
      layers: '',
      styles: '',
      format: 'image/png',
      transparent: 'TRUE',
      version: definition.version || '1.3.0',
      exceptions: 'xml',
      CRS: definition.requestSrs || 'EPSG:3857',
    }, {
      isBaseLayer: false,
      visibility: false,
      singleTile: false,
      tileSize: new UW.OpenLayers.Size(1024, 1024),
      buffer: 0,
      transitionEffect: null,
      getURL: getUrlAsWms130,
      getFullRequestString: setWmsCrs130,
    });
    layer.requestSrs = definition.requestSrs || 'EPSG:3857';
    return layer;
  }

  // ---------- WMS composite layer ----------

  function getActiveSublayerWmsNames(compositeDefinition) {
    const zoomLevel = getCurrentZoomLevel();
    return compositeDefinition.sublayers
      .filter(sub => {
        if (!getWantedLayerState(sub)) return false;
        if (sub.minZoom !== undefined && zoomLevel !== null && zoomLevel < sub.minZoom) return false;
        return true;
      })
      .map(sub => sub.wmsName);
  }

  function applyCompositeLayerVisibility(compositeRuntime) {
    if (!compositeRuntime.olLayer) return;
    const activeNames = getActiveSublayerWmsNames(compositeRuntime.definition);
    if (activeNames.length === 0) {
      compositeRuntime.olLayer.setVisibility(false);
      return;
    }
    compositeRuntime.olLayer.mergeNewParams({ layers: activeNames.join(',') });
    compositeRuntime.olLayer.setVisibility(true);
  }

  function registerWmsCompositeLayer(layerDefinition) {
    const olLayer = buildWmsOlLayer(layerDefinition);
    UW.W.map.addLayer(olLayer);
    olLayer.setZIndex(2200);

    const layerRuntime = {
      checkboxName: getCheckboxName(layerDefinition),
      definition: layerDefinition,
      geojsonLoaded: false,
      geojsonLoadPromise: null,
      layerName: getLayerName(layerDefinition),
      olLayer,
      tileRegistered: false,
      sublayerRuntimes: [],
    };

    // Try parent group checkbox (graceful fallback if SDK build doesn't support it)
    let groupSupported = false;
    try {
      if (typeof RUNTIME.sdk.LayerSwitcher.addLayerCheckboxGroup === 'function') {
        RUNTIME.sdk.LayerSwitcher.addLayerCheckboxGroup({ name: layerRuntime.checkboxName });
        groupSupported = true;
      }
    } catch (_) { }

    for (const sub of layerDefinition.sublayers) {
      const subCheckboxName = `${CHECKBOX_NAME_PREFIX}${sub.name}`;
      const subChecked = getWantedLayerState(sub);

      const subRuntime = {
        checkboxName: subCheckboxName,
        definition: sub,
        compositeRuntime: layerRuntime,
      };

      layerRuntime.sublayerRuntimes.push(subRuntime);
      RUNTIME.layerByCheckboxName.set(subCheckboxName, subRuntime);

      try {
        const opts = { isChecked: subChecked, name: subCheckboxName };
        if (groupSupported) opts.groupName = layerRuntime.checkboxName;
        RUNTIME.sdk.LayerSwitcher.addLayerCheckbox(opts);
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
        safeSetLayerCheckboxChecked(subCheckboxName, subChecked);
      }
    }

    RUNTIME.layerById.set(layerDefinition.id, layerRuntime);
  }

  async function ensureGeoJsonLayerLoaded(layerRuntime) {
    if (layerRuntime.geojsonLoaded) {
      return true;
    }

    if (layerRuntime.geojsonLoadPromise) {
      return layerRuntime.geojsonLoadPromise;
    }

    layerRuntime.geojsonLoadPromise = (async () => {
      try {
        const payload = await requestText(layerRuntime.definition.dataUrl);
        const parsed = JSON.parse(payload);
        const features = buildSdkFeatures(layerRuntime.definition, parsed);

        if (features.length) {
          RUNTIME.sdk.Map.addFeaturesToLayer({
            features,
            layerName: layerRuntime.layerName,
          });
        }

        layerRuntime.geojsonLoaded = true;
        return true;
      } catch (error) {
        log('GeoJSON load failed:', layerRuntime.definition.id, error);
        return false;
      } finally {
        layerRuntime.geojsonLoadPromise = null;
      }
    })();

    return layerRuntime.geojsonLoadPromise;
  }

  async function applyLayerVisibility(layerRuntime, visibility, options = {}) {
    const nextVisibility = !!visibility;

    if (layerRuntime.definition.type === 'geojson' && nextVisibility) {
      const loaded = await ensureGeoJsonLayerLoaded(layerRuntime);
      if (!loaded) {
        setWantedLayerState(layerRuntime.definition, false);

        if (options.syncCheckbox !== false) {
          safeSetLayerCheckboxChecked(layerRuntime.checkboxName, false);
        }

        safeSetLayerVisibility(layerRuntime.layerName, false);
        return;
      }
    }

    if (layerRuntime.definition.type === 'tile' && nextVisibility) {
      ensureTileLayerRegistered(layerRuntime);
    }

    safeSetLayerVisibility(layerRuntime.layerName, nextVisibility);
  }

  function registerTileLayer(layerRuntime) {
    const definition = layerRuntime.definition;
    try {
      RUNTIME.sdk.Map.addTileLayer({
        layerName: layerRuntime.layerName,
        layerOptions: {
          tileHeight: definition.tileHeight,
          tileWidth: definition.tileWidth,
          url: {
            fileName: definition.fileName,
            params: definition.params || {},
            servers: definition.servers,
          },
        },
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  // Registers a tile layer in the SDK on first use.
  // Idempotent: does nothing if already registered or if layerRuntime is not a tile layer.
  function ensureTileLayerRegistered(layerRuntime) {
    if (layerRuntime.definition.type !== 'tile' || layerRuntime.tileRegistered) return;
    registerTileLayer(layerRuntime); // swallows "already exists", throws on other errors
    layerRuntime.tileRegistered = true;
  }

  function registerGeoJsonLayer(layerRuntime) {
    const definition = layerRuntime.definition;
    try {
      RUNTIME.sdk.Map.addLayer({
        layerName: layerRuntime.layerName,
        styleRules: Array.isArray(definition.styleRules) && definition.styleRules.length
          ? definition.styleRules
          : [{ style: DEFAULT_GEOJSON_STYLE }],
        zIndexing: true,
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  function registerDebugOverlays() {
    for (const layerDefinition of LAYERS) {
      if (layerDefinition.type !== 'tile') continue;
      const debugLayerName = `${getLayerName(layerDefinition)}.debug`;
      const r = layerDefinition.tileWidth || 512;
      try {
        RUNTIME.sdk.Map.addTileLayer({
          layerName: debugLayerName,
          layerOptions: {
            tileHeight: r,
            tileWidth: r,
            url: {
              fileName: `onion/debug-border~\${z}~\${x}~\${y}@${r}.svg`,
              params: {},
              servers: layerDefinition.servers,
            },
          },
        });
        safeSetLayerVisibility(debugLayerName, true);
      } catch (error) {
        if (!isAlreadyExistsError(error)) {
          log('Debug overlay registration failed:', layerDefinition.id, error);
        }
      }
    }
  }

  // ---- wms-snapped helpers ----

  function lonToMercatorX(lon) {
    return lon * WEB_MERCATOR_HALF / 180;
  }

  function latToMercatorY(lat) {
    const rad = lat * Math.PI / 180;
    return Math.log(Math.tan(Math.PI / 4 + rad / 2)) * WEB_MERCATOR_HALF / Math.PI;
  }

  function mercatorXToLon(x) {
    return x * 180 / WEB_MERCATOR_HALF;
  }

  function mercatorYToLat(y) {
    return (2 * Math.atan(Math.exp(y * Math.PI / WEB_MERCATOR_HALF)) - Math.PI / 2) * 180 / Math.PI;
  }

  function getLayerContainerEl() {
    const viewport = RUNTIME.sdk.Map.getMapViewportElement();
    return viewport.querySelector('.olLayerContainer') || viewport.firstElementChild || viewport;
  }

  function buildWmsGetMapUrl(wmsLayers, minX, minY, maxX, maxY, width, height) {
    const wmsBase = 'https://mapy.geoportal.gov.pl/wss/ext/KrajowaIntegracjaNumeracjiAdresowej';
    const params = new URLSearchParams([
      ['SERVICE', 'WMS'],
      ['REQUEST', 'GetMap'],
      ['VERSION', '1.3.0'],
      ['CRS', 'EPSG:3857'],
      ['LAYERS', wmsLayers],
      ['STYLES', ''],
      ['FORMAT', 'image/png'],
      ['TRANSPARENT', 'TRUE'],
      ['EXCEPTIONS', 'XML'],
      ['BBOX', `${minX},${minY},${maxX},${maxY}`],
      ['WIDTH', String(width)],
      ['HEIGHT', String(height)],
    ]);
    return PROXY_WMS_BASE + encodeURIComponent(`${wmsBase}?${params.toString()}`);
  }

  function updateSnappedWmsLayer(layerRuntime) {
    const { definition, snappedImg } = layerRuntime;
    if (!snappedImg) return;

    const sdk = RUNTIME.sdk;
    const zoomLevel = getCurrentZoomLevel();
    const wanted = getWantedLayerState(definition);

    if (!wanted || !isZoomAllowed(definition, zoomLevel)) {
      snappedImg.style.display = 'none';
      return;
    }

    const vpEl = sdk.Map.getMapViewportElement();
    const vpW = vpEl.clientWidth;
    const vpH = vpEl.clientHeight;
    const snapPixels = definition.snapPixels || 256;
    const resolution = sdk.Map.getMapResolution();

    const imgW = Math.max(1024, Math.round(vpW * 0.8));
    const imgH = Math.max(1024, Math.round(vpH * 0.9));

    const snapSizeM = snapPixels * resolution;
    const center = sdk.Map.getMapCenter();
    const mx = lonToMercatorX(center.lon);
    const my = latToMercatorY(center.lat);

    const snappedMx = Math.round(mx / snapSizeM) * snapSizeM;
    const snappedMy = Math.round(my / snapSizeM) * snapSizeM;

    const halfW = (imgW / 2) * resolution;
    const halfH = (imgH / 2) * resolution;
    const url = buildWmsGetMapUrl(
      definition.wmsLayers,
      snappedMx - halfW, snappedMy - halfH,
      snappedMx + halfW, snappedMy + halfH,
      imgW, imgH,
    );

    const applyPosition = () => {
      const pixel = sdk.Map.getMapPixelFromLonLat({
        lonLat: { lon: mercatorXToLon(snappedMx), lat: mercatorYToLat(snappedMy) },
      });
      if (pixel) {
        // Convert viewport pixel → layer-container pixel so the img follows the map during panning.
        const container = layerRuntime.snappedContainer;
        const vpRect = vpEl.getBoundingClientRect();
        const cRect  = container.getBoundingClientRect();
        snappedImg.style.left = `${pixel.x - (cRect.left - vpRect.left) - imgW / 2}px`;
        snappedImg.style.top  = `${pixel.y - (cRect.top  - vpRect.top)  - imgH / 2}px`;
      }
      snappedImg.style.width  = `${imgW}px`;
      snappedImg.style.height = `${imgH}px`;
      snappedImg.style.display = '';
    };

    layerRuntime.snappedCenter = { mx: snappedMx, my: snappedMy, imgW, imgH };

    if (layerRuntime.snappedUrl !== url) {
      const zoomChanged = layerRuntime.snappedResolution !== resolution;
      layerRuntime.snappedUrl = url;
      layerRuntime.snappedResolution = resolution;
      if (zoomChanged) snappedImg.style.display = 'none';
      snappedImg.onload = () => { snappedImg.onload = null; applyPosition(); };
      snappedImg.src = url;
    } else {
      applyPosition();
    }
  }

  function updateAllSnappedLayers() {
    for (const [, layerRuntime] of RUNTIME.layerById) {
      if (layerRuntime.definition.type === 'wms-snapped') {
        updateSnappedWmsLayer(layerRuntime);
      }
    }
  }

  function registerSnappedWmsLayer(layerRuntime) {
    const { definition } = layerRuntime;

    const img = document.createElement('img');
    img.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:2250;display:none;';
    img.alt = '';

    const container = getLayerContainerEl();
    container.appendChild(img);
    layerRuntime.snappedImg = img;
    layerRuntime.snappedContainer = container;
    layerRuntime.snappedCenter = null;

    const checked = getWantedLayerState(definition);

    try {
      RUNTIME.sdk.LayerSwitcher.addLayerCheckbox({
        isChecked: checked,
        name: layerRuntime.checkboxName,
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
      safeSetLayerCheckboxChecked(layerRuntime.checkboxName, checked);
    }

    RUNTIME.layerByCheckboxName.set(layerRuntime.checkboxName, layerRuntime);
    RUNTIME.layerById.set(definition.id, layerRuntime);

    if (checked) {
      updateSnappedWmsLayer(layerRuntime);
    }
  }

  // ---- end wms-snapped ----

  function registerLayerInSdk(layerDefinition) {
    if (layerDefinition.type === 'wms-composite') {
      registerWmsCompositeLayer(layerDefinition);
      return;
    }

    if (layerDefinition.type === 'wms-snapped') {
      const layerRuntime = {
        checkboxName: getCheckboxName(layerDefinition),
        definition: layerDefinition,
        layerName: getLayerName(layerDefinition),
        snappedImg: null,
        snappedContainer: null,
        snappedCenter: null,
        snappedUrl: null,
        snappedResolution: null,
      };
      registerSnappedWmsLayer(layerRuntime);
      return;
    }

    const layerRuntime = {
      checkboxName: getCheckboxName(layerDefinition),
      definition: layerDefinition,
      geojsonLoaded: false,
      geojsonLoadPromise: null,
      layerName: getLayerName(layerDefinition),
      tileRegistered: false,
    };

    const checked = getWantedLayerState(layerDefinition);

    if (layerDefinition.type === 'tile') {
      // Only register in SDK if layer should be ON — avoids tile requests on startup.
      if (checked) {
        ensureTileLayerRegistered(layerRuntime);
      }
    } else if (layerDefinition.type === 'geojson') {
      registerGeoJsonLayer(layerRuntime);
    } else {
      throw new Error(`Unsupported layer type: ${layerDefinition.type}`);
    }

    try {
      RUNTIME.sdk.LayerSwitcher.addLayerCheckbox({
        isChecked: checked,
        name: layerRuntime.checkboxName,
      });
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }

      safeSetLayerCheckboxChecked(layerRuntime.checkboxName, checked);
    }

    RUNTIME.layerByCheckboxName.set(layerRuntime.checkboxName, layerRuntime);
    RUNTIME.layerById.set(layerDefinition.id, layerRuntime);
  }

  async function syncLayerRuntimeState(layerRuntime) {
    if (layerRuntime.definition.type === 'wms-composite') {
      for (const subRuntime of layerRuntime.sublayerRuntimes) {
        safeSetLayerCheckboxChecked(subRuntime.checkboxName, getWantedLayerState(subRuntime.definition));
      }
      applyCompositeLayerVisibility(layerRuntime);
      return;
    }

    if (layerRuntime.definition.type === 'wms-snapped') {
      safeSetLayerCheckboxChecked(layerRuntime.checkboxName, getWantedLayerState(layerRuntime.definition));
      updateSnappedWmsLayer(layerRuntime);
      return;
    }

    const wanted = getWantedLayerState(layerRuntime.definition);

    safeSetLayerCheckboxChecked(layerRuntime.checkboxName, wanted);

    if (layerRuntime.definition.type === 'tile') {
      // Registration and zoom-gated visibility for tiles are fully handled by
      // applyZoomGatingForTiles(), called right after syncAllLayersRuntimeState().
      // We only need to hide tiles that are already registered but no longer wanted.
      if (!wanted && layerRuntime.tileRegistered) {
        safeSetLayerVisibility(layerRuntime.layerName, false);
      }
      return;
    }

    await applyLayerVisibility(layerRuntime, wanted, { syncCheckbox: false });
  }

  async function syncAllLayersRuntimeState() {
    const layers = Array.from(RUNTIME.layerById.values());
    for (const layerRuntime of layers) {
      await syncLayerRuntimeState(layerRuntime);
    }
  }

  async function onLayerCheckboxToggled(payload) {
    if (!payload || typeof payload.name !== 'string') {
      return;
    }

    const layerRuntime = RUNTIME.layerByCheckboxName.get(payload.name);
    if (!layerRuntime) {
      return;
    }

    // Composite sub-checkbox toggle
    if (layerRuntime.compositeRuntime) {
      setWantedLayerState(layerRuntime.definition, !!payload.checked);
      applyCompositeLayerVisibility(layerRuntime.compositeRuntime);
      scheduleRelativeLayerStacking(0);
      return;
    }

    const checked = !!payload.checked;
    setWantedLayerState(layerRuntime.definition, checked);
    if (layerRuntime.definition.type === 'wms-snapped') {
      updateSnappedWmsLayer(layerRuntime);
      scheduleRelativeLayerStacking(0);
      return;
    }
    if (layerRuntime.definition.type === 'tile' && checked) {
      // For tile ON: use zoom-aware gating (may defer registration if zoom out of range).
      await applyZoomGatingForTiles();
    } else {
      await applyLayerVisibility(layerRuntime, checked);
    }
    scheduleRelativeLayerStacking(0);
  }

  function onMapLayerStackChanged() {
    scheduleRelativeLayerStacking(50);
  }

  function registerEventListeners() {
    for (const stop of RUNTIME.stopEventListeners) {
      try {
        stop();
      } catch (error) {
        log('Failed to stop event listener:', error);
      }
    }
    RUNTIME.stopEventListeners = [];

    RUNTIME.stopEventListeners.push(RUNTIME.sdk.Events.on({
      eventHandler: onLayerCheckboxToggled,
      eventName: 'wme-layer-checkbox-toggled',
    }));

    RUNTIME.stopEventListeners.push(RUNTIME.sdk.Events.on({
      eventHandler: onMapLayerStackChanged,
      eventName: 'wme-map-layer-added',
    }));

    RUNTIME.stopEventListeners.push(RUNTIME.sdk.Events.on({
      eventHandler: onMapLayerStackChanged,
      eventName: 'wme-map-layer-changed',
    }));

    RUNTIME.stopEventListeners.push(RUNTIME.sdk.Events.on({
      eventHandler: onMapLayerStackChanged,
      eventName: 'wme-map-layer-removed',
    }));

    RUNTIME.stopEventListeners.push(RUNTIME.sdk.Events.on({
      eventHandler: updateAllSnappedLayers,
      eventName: 'wme-map-move-end',
    }));

    RUNTIME.stopEventListeners.push(RUNTIME.sdk.Events.on({
      eventHandler: scheduleOverlayTileRefreshAfterZoom,
      eventName: 'wme-map-zoom-changed',
    }));
  }

  async function initializeScript() {
    if (RUNTIME.initialized) {
      return;
    }
    RUNTIME.initialized = true;

    initializeState();

    try {
      for (const layerDefinition of LAYERS) {
        registerLayerInSdk(layerDefinition);
      }

      registerEventListeners();
      await syncAllLayersRuntimeState();
      await applyZoomGatingForTiles();
      if (DEBUG_TILES) registerDebugOverlays();
      scheduleRelativeLayerStacking(0);
      setTimeout(() => scheduleRelativeLayerStacking(0), 400);
      setTimeout(() => scheduleRelativeLayerStacking(0), 1200);

      log(`Initialized (${LAYERS.length} layers, strict SDK mode).`);
    } catch (error) {
      log('Initialization failed:', error);
    }
  }

  function bootstrapWithSdk() {
    if (!UW.SDK_INITIALIZED || typeof UW.SDK_INITIALIZED.then !== 'function') {
      log('window.SDK_INITIALIZED is unavailable, aborting.');
      return;
    }

    UW.SDK_INITIALIZED
      .then(() => {
        try {
          RUNTIME.sdk = ensureScriptSdk();
        } catch (error) {
          log('SDK is unavailable:', error);
          return;
        }

        if (RUNTIME.sdk.State.isReady()) {
          initializeScript();
          return;
        }

        RUNTIME.sdk.Events.once({ eventName: 'wme-ready' })
          .then(() => initializeScript())
          .catch((error) => {
            log('Failed while waiting for wme-ready:', error);
          });
      })
      .catch((error) => {
        log('SDK initialization promise rejected:', error);
      });
  }

  // ── Proxy tile queue ────────────────────────────────────────────────────────
  // Intercepts img.src assignments for proxy.labtool.pl tiles, queues them with
  // center-first sort, and dispatches up to MAX_CONCURRENT_PROXY_REQUESTS at once.
  // Concurrency (not a fixed delay) is the throttle: a slot frees the instant the
  // browser resolves the image — near-instantly for a cache hit, after the real
  // round-trip for a network fetch — so cached tiles never wait behind a timer.

  let _proxyQueue = [];
  let _proxyActiveCount = 0;

  function _proxyDistSq(url) {
    try {
      const c = UW.W?.map?.getCenter();
      if (!c) return 0;
      const cx = c.lon;
      const cy = c.lat;

      // WMS tile: .../wms?url=<encoded-inner-url-with-BBOX=minx,miny,maxx,maxy>
      const qi = url.indexOf('?url=');
      if (qi !== -1) {
        const inner = decodeURIComponent(url.slice(qi + 5));
        const m = inner.match(/[?&]BBOX=(-?[\d.]+),(-?[\d.]+),(-?[\d.]+),(-?[\d.]+)/i);
        if (m) {
          const dx = (+m[1] + +m[3]) / 2 - cx;
          const dy = (+m[2] + +m[4]) / 2 - cy;
          return dx * dx + dy * dy;
        }
      }

      // XYZ tile: ~z~x~y@size
      const t = url.match(/~(\d+)~(\d+)~(\d+)@/);
      if (t) {
        const n = 2 ** +t[1];
        const lon = (+t[2] + 0.5) / n * 360 - 180;
        const latRad = Math.atan(Math.sinh(Math.PI * (1 - 2 * (+t[3] + 0.5) / n)));
        const mx = lon * WEB_MERCATOR_HALF / 180;
        const my = Math.log(Math.tan(Math.PI / 4 + latRad / 2)) * WEB_MERCATOR_HALF / Math.PI;
        return (mx - cx) ** 2 + (my - cy) ** 2;
      }
    } catch (_) {}
    return 0;
  }

  // Extracts the zoom level baked into a Geoportal Orto XYZ tile URL
  // (onion/geoportal-orto-standard~z~x~y@size). Returns null for anything else
  // (other tile layers, the WMS ?url= pattern) — those are left untouched.
  function _proxyOrtoTileZoom(url) {
    if (!url.includes('geoportal-orto-standard~')) return null;
    const t = url.match(/~(\d+)~\d+~\d+@/);
    return t ? +t[1] : null;
  }

  function _proxyFlush() {
    while (_proxyActiveCount < MAX_CONCURRENT_PROXY_REQUESTS && _proxyQueue.length) {
      _proxyQueue.forEach(q => { q.dist = _proxyDistSq(q.url); });
      _proxyQueue.sort((a, b) => a.dist - b.dist);
      const next = _proxyQueue.shift();

      // Orto only
      const tileZoom = _proxyOrtoTileZoom(next.url);
      if (tileZoom !== null) {
        const currentZoom = getCurrentZoomLevel();
        if (currentZoom !== null && tileZoom !== currentZoom) continue;
      }

      _proxyDispatch(next);
    }
  }

  // Frees the concurrency slot held by img's current in-flight dispatch (if any) —
  // called both when its load/error fires and when OL2 recycles the element by
  // reassigning .src again before the previous request ever resolved.
  function _proxyCancelActive(img) {
    const settle = img.__proxySettle;
    if (settle) settle();
  }

  function _proxyDispatch(entry) {
    _proxyActiveCount++;
    const img = entry.img;

    const settle = () => {
      if (img.__proxySettle !== settle) return;
      img.__proxySettle = null;
      img.removeEventListener('load', settle);
      img.removeEventListener('error', settle);
      _proxyActiveCount--;
      _proxyFlush();
    };

    img.__proxySettle = settle;
    img.addEventListener('load', settle, { once: true });
    img.addEventListener('error', settle, { once: true });

    entry.fire();
  }

  function _proxyEnqueue(url, img, fire) {
    _proxyCancelActive(img);
    _proxyQueue = _proxyQueue.filter(q => q.img !== img);
    _proxyQueue.push({ url, img, dist: _proxyDistSq(url), fire });
    _proxyFlush();
  }

  function installProxyImageQueue() {
    const proto = UW.HTMLImageElement?.prototype;
    if (!proto) return;
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc?.set) return;
    const nativeSet = desc.set;

    Object.defineProperty(proto, 'src', {
      get: desc.get,
      set(value) {
        const img = this;
        if (typeof value === 'string' && value.includes(PROXY_HOST)) {
          _proxyEnqueue(value, img, () => nativeSet.call(img, value));
        } else {
          _proxyCancelActive(img);
          _proxyQueue = _proxyQueue.filter(q => q.img !== img);
          nativeSet.call(img, value);
        }
      },
      configurable: true,
    });
    log('Proxy tile queue ready — max concurrent:', MAX_CONCURRENT_PROXY_REQUESTS, ', center-first sort.');
  }

  installProxyImageQueue();
  bootstrapWithSdk();
})();
