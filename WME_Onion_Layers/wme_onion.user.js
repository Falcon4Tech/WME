// ==UserScript==
// @name                                     WME Onion Layers
// @name:pl                                     WME Cebula
// @version                                       Beta.1
// @tag                                            WME
// @description                 Adds Polish WMS overlays from e-mapa.net to WME (works only in Poland territory).
// @description:pl              Cebula ma warstwy, WME ma WMSy! Dodaje polskie nakładki WMS z e-mapa.net do WME.
// @grant             GM_xmlhttpRequest
// @connect           cdn.jsdelivr.net
// @author            Falcon4Tech
// @run-at            document-idle
// @namespace         https://wazepolska.pl
// @match             https://*.waze.com/editor*
// @match             https://*.waze.com/*/editor*
// @supportURL        https://github.com/Falcon4Tech/WME/issues
// @icon              https://polska.e-mapa.net/implementation/polska/images/icon.ico
// @updateURL         https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_Onion_Layers/wme_onion.meta.js
// @downloadURL       https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_Onion_Layers/wme_onion.user.js
// ==/UserScript==

(function () {
  'use strict';

  const UW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const SCRIPT_KEY = 'WME_Onion_Layers';
  const SCRIPT_NAME = 'WME Cebula';

  const DATA_BASE_URL = `https://cdn.jsdelivr.net/gh/Falcon4Tech/WME@main/${SCRIPT_KEY}/data/`;

  const log = (...a) => console.log(`🗺️ ${SCRIPT_NAME}`, ...a);

  // Referencje do UI w runtime
  const UI = {
    groupSwitch: null,
    layerItems: [], // { def, layer, checkbox }
    runtimeLayers: {} // { [id]: boolean } – dla warstw z saveState:false
  };


  // === Konfiguracja warstw ===
  // Opcjonalnie per warstwa:
  //   requestSrs: 'EPSG:900913' | 'EPSG:3857' | 'EPSG:4326'
  //   saveState: true|false  (domyślnie true; false = brak zapisu do localStorage)
  const LAYERS = [
    {
      id: 'opp',
      type: 'wms',
      name: 'OPP - fotoradary',
      url: 'https://wms.e-mapa.net/cgi-bin/mapserv7',
      version: '1.1.1',
      requestSrs: 'EPSG:4326',
      params: {
        map: '/home/www/emapa/shp2wms/fotoradary/fotoradary.map',
        layers: 'projektowane,istniejace',
        format: 'image/png',
        transparent: 'TRUE',
        styles: ''
      },
      defaultOn: false
    },
    {
      id: 'granice',
      type: 'wms',
      name: 'Granice - obręby',
      url: 'https://granice.e-mapa.net/cgi-bin/granice_prg',
      version: '1.1.1',
      requestSrs: 'EPSG:4326',
      params: {
        layers: 'obreby,jednostki',
        format: 'image/png',
        transparent: 'TRUE',
        styles: ''
      },
      defaultOn: false
    },
    {
      id: 'miasta',
      type: 'wms',
      name: 'Miasta',
      url: 'https://granice.e-mapa.net/cgi-bin/mapserv',
      version: '1.1.1',
      requestSrs: 'EPSG:4326',
      params: {
        map: '/srv/webgis/polska/miasta.map',
        layers: 'miasta',
        format: 'image/png',
        transparent: 'TRUE',
        styles: ''
      },
      defaultOn: false
    }
    ,{
      id: 'sct-warszawa',
      type: 'geojson',
      name: 'SCT – Warszawa',
      defaultOn: false,
      saveState: false,
      style: {
        strokeColor: '#ff0000',
        strokeWidth: 3,
        strokeOpacity: 0.9,
        fillColor: '#ff0000',
        fillOpacity: 0.15
      }
    }
    ,{
      id: 'sct-krakow',
      type: 'geojson',
      name: 'SCT – Kraków',
      defaultOn: false,
      saveState: false,
      style: {
        strokeColor: '#ff0000',
        strokeWidth: 3,
        strokeOpacity: 0.9,
        fillColor: '#ff0000',
        fillOpacity: 0.15
      }
    }
  ];

  // ---------- Ustawienia localStorage: JSON pod SCRIPT_KEY ----------
  const DEFAULT_STATE = {
    groupEnabled: true,
    groupCollapsed: false,
    layers: {}
  };

  // Odczyt stanu z localStorage z bezpiecznym fallbackiem na domyślne wartości.
  function readState() {
    try {
      const raw = localStorage.getItem(SCRIPT_KEY);
      if (!raw) return { ...DEFAULT_STATE };
      const parsed = JSON.parse(raw);
      return {
        groupEnabled: typeof parsed.groupEnabled === 'boolean' ? parsed.groupEnabled : DEFAULT_STATE.groupEnabled,
        groupCollapsed: typeof parsed.groupCollapsed === 'boolean' ? parsed.groupCollapsed : DEFAULT_STATE.groupCollapsed,
        layers: parsed.layers && typeof parsed.layers === 'object' ? parsed.layers : {}
      };
    } catch (e) {
      return { ...DEFAULT_STATE };
    }
  }

  function writeState(next) {
    localStorage.setItem(SCRIPT_KEY, JSON.stringify(next));
  }

  function shouldSaveLayerState(def) {
    return def?.saveState !== false;
  }

  function getWantedLayerState(def) {
    if (!def) return false;

    // Warstwy "sesyjne" (bez zapisu do localStorage)
    if (!shouldSaveLayerState(def)) {
      if (typeof UI.runtimeLayers[def.id] === 'boolean') return UI.runtimeLayers[def.id];
      return !!def.defaultOn;
    }

    // Warstwy zapisywane w localStorage
    const st = readState();
    const v = st.layers?.[def.id];
    if (typeof v === 'boolean') return v;
    return !!def.defaultOn;
  }

  function setWantedLayerState(def, enabled) {
    if (!def) return;

    if (!shouldSaveLayerState(def)) {
      UI.runtimeLayers[def.id] = !!enabled;
      return;
    }

    const st = readState();
    st.layers = st.layers || {};
    st.layers[def.id] = !!enabled;
    writeState(st);
  }

  function getGroupEnabled(fallback = true) {
    const st = readState();
    return typeof st.groupEnabled === 'boolean' ? st.groupEnabled : !!fallback;
  }

  function setGroupEnabled(enabled) {
    const st = readState();
    st.groupEnabled = !!enabled;
    // Natywnie: gdy grupa jest wyłączona, zostaje zwinięta.
    if (!st.groupEnabled) st.groupCollapsed = true;
    writeState(st);
  }

  function getGroupCollapsed(fallback = false) {
    const st = readState();
    return typeof st.groupCollapsed === 'boolean' ? st.groupCollapsed : !!fallback;
  }

  function setGroupCollapsed(collapsed) {
    const st = readState();
    st.groupCollapsed = !!collapsed;
    writeState(st);
  }

  // ---------- Czekanie na WME ----------
  function whenWmeReady(cb) {
    const tick = () => {
      try {
        if (UW.W && UW.W.map && UW.OpenLayers) cb();
        else setTimeout(tick, 800);
      } catch (e) {
        setTimeout(tick, 800);
      }
    };
    tick();
  }


  function getLayerSwitcherUL() {
    // Główna lista z grupami: <ul class="list-unstyled togglers">
    const menuRoot = document.querySelector('#layer-switcher-region .menu .scrollable ul.list-unstyled.togglers')
      || document.querySelector('#layer-switcher-region .menu ul.list-unstyled.togglers')
      || document.querySelector('#layer-switcher-region .menu .list-unstyled.togglers');
    if (!menuRoot) return null;

    // Odrzuć, jeśli grupa już istnieje
    const existing = menuRoot.querySelector('li.group[data-custom-group="onion"] ul');
    if (existing) return existing;

    // Wstawiamy przed grupą "Widok"
    const displayToggle = menuRoot.querySelector('#layer-switcher-group_display');
    const displayGroupLi = displayToggle ? displayToggle.closest('li.group') : null;

    const liGroup = document.createElement('li');
    liGroup.className = 'group';
    liGroup.dataset.customGroup = 'onion';

    const header = document.createElement('div');
    header.className = 'layer-switcher-toggler-tree-category';

    const caretBtn = document.createElement('wz-button');
    caretBtn.setAttribute('color', 'clear-icon');
    caretBtn.setAttribute('size', 'xs');
    caretBtn.setAttribute('type', 'button');

    const caretIcon = document.createElement('i');
    caretIcon.className = 'toggle-category w-icon w-icon-caret-down';
    caretBtn.appendChild(caretIcon);

    const groupSwitch = document.createElement('wz-toggle-switch');
    groupSwitch.className = 'layer-switcher-group_onion';
    groupSwitch.id = 'layer-switcher-group_onion';
    groupSwitch.setAttribute('tabindex', '0');

    // Przywróć stan z localStorage
    const initialGroupEnabled = getGroupEnabled(true);
    UI.groupSwitch = groupSwitch;
    setSwitchChecked(groupSwitch, initialGroupEnabled);

    const label = document.createElement('label');
    label.className = 'label-text';
    label.setAttribute('for', 'layer-switcher-group_onion');
    label.textContent = 'Warstwy';

    header.appendChild(caretBtn);
    header.appendChild(groupSwitch);
    header.appendChild(label);

    const ul = document.createElement('ul');
    ul.className = 'collapsible-GROUP_ONION';

    // Zwiń/rozwiń jak natywne WME (klasa CSS + odwrócona strzałka)
    const COLLAPSE_CLASS = 'collapse-layer-switcher-group';

    const syncCollapseUI = (collapsed) => {
      if (collapsed) ul.classList.add(COLLAPSE_CLASS);
      else ul.classList.remove(COLLAPSE_CLASS);

      caretIcon.className = collapsed
        ? 'toggle-category w-icon w-icon-caret-down upside-down'
        : 'toggle-category w-icon w-icon-caret-down';
    };

    const applyGroupEnabledUI = (enabled) => {
      // Natywne: gdy WYŁ. => wymuszone zwinięcie
      if (!enabled) {
        syncCollapseUI(true);
      } else {
        syncCollapseUI(getGroupCollapsed(false));
      }
    };

    // Strzałka zwija/rozwija TYLKO gdy grupa jest włączona
    caretBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const enabled = getSwitchChecked(groupSwitch);
      if (!enabled) return;

      const nextCollapsed = !ul.classList.contains(COLLAPSE_CLASS);
      setGroupCollapsed(nextCollapsed);
      syncCollapseUI(nextCollapsed);
    });

    liGroup.appendChild(header);
    liGroup.appendChild(ul);

    if (displayGroupLi && displayGroupLi.parentElement === menuRoot) {
      menuRoot.insertBefore(liGroup, displayGroupLi);
    } else {
      menuRoot.appendChild(liGroup);
    }

    wireToggleSwitch(groupSwitch, (enabled) => {
      setGroupEnabled(enabled);

      // UX: po włączeniu grupy automatycznie ją rozwiń.
      if (enabled) setGroupCollapsed(false);

      applyGroupEnabledUI(enabled);
      applyGroupState();
    });

    // Stan początkowy: OFF => wymuszone zwinięcie, inaczej użyj zapisanego
    applyGroupEnabledUI(initialGroupEnabled);

    // Upewnij się, że warstwy i checkboxy od razu odzwierciedlają stan grupy
    applyGroupState();

    return ul;
  }

  // --- Helpery dla wz-toggle-switch / wz-checkbox ---
  function getSwitchChecked(el) {
    if (!el) return true;
    if (typeof el.checked === 'boolean') return !!el.checked;
    return el.hasAttribute('checked');
  }

  function setSwitchChecked(el, checked) {
    if (!el) return;
    // większość buildów reaguje na atrybut `checked`
    if (checked) el.setAttribute('checked', '');
    else el.removeAttribute('checked');

    // część buildów ma też property `checked`
    try { el.checked = !!checked; } catch (e) { /* ignore */ }
  }

  function setCheckboxDisabled(el, disabled) {
    if (!el) return;
    if (disabled) el.setAttribute('disabled', '');
    else el.removeAttribute('disabled');
  }
  function wireToggleSwitch(toggleEl, onToggle) {
    if (!toggleEl) return;

    const fire = () => {
      try {
        onToggle(getSwitchChecked(toggleEl));
      } catch (e) {
        // ignoruj
      }
    };

    // Minimal: host events only
    toggleEl.addEventListener('change', () => setTimeout(fire, 0));
    toggleEl.addEventListener('click', () => setTimeout(fire, 0));
  }

  function applyGroupState() {
    const groupEnabled = getGroupEnabled(true);

    for (const item of UI.layerItems) {
      const wanted = getWantedLayerState(item.def);

      // Nie nadpisuj wyboru użytkownika dla warstwy, gdy grupa jest wyłączona.
      // Tylko wymuszamy niewidoczność na czas wyłączenia grupy.
      const effective = groupEnabled && wanted;
      // Lazy-load GeoJSON kiedy ma się stać widoczny
      if (effective && item.def.type === 'geojson') {
        // fire-and-forget (nie blokuj UI)
        ensureGeoJsonLoaded(item);
      }
      item.layer.setVisibility(!!effective);

      // Wyłącz checkboxy warstw, gdy grupa jest wyłączona (zachowaj ich stan)
      if (item.checkbox) {
        // Zachowaj "checked" zgodnie z zapisanym stanem per warstwa
        item.checkbox.checked = !!wanted;
        setCheckboxDisabled(item.checkbox, !groupEnabled);
      }
    }
  }


  function addToggleRow(ul, layer, def, defaultChecked) {
    const li = document.createElement('li');

    const wrap = document.createElement('div');
    wrap.className = 'layer-selector';

    const chk = document.createElement('wz-checkbox');
    chk.appendChild(document.createTextNode(layer.name));

    // Checkbox odzwierciedla zapisany wybór dla danej warstwy.
    chk.checked = !!defaultChecked;

    chk.addEventListener('change', async (e) => {
      const enabled = !!e.target.checked;
      setWantedLayerState(def, enabled);

      // Dla GeoJSON dociągnij dane dopiero przy włączeniu.
      const item = UI.layerItems.find((x) => x.def.id === def.id);
      if (enabled && item && item.def.type === 'geojson') {
        await ensureGeoJsonLoaded(item);
      }

      applyGroupState();
    });

    wrap.appendChild(chk);
    li.appendChild(wrap);
    ul.appendChild(li);
    return chk;
  }

  // ---------- GeoJSON (jsDelivr) ----------
  function httpGetText(url) {
    return new Promise((resolve, reject) => {
      if (typeof GM_xmlhttpRequest !== 'function') {
        reject(new Error('GM_xmlhttpRequest niedostępny (brak @grant lub menedżera userscriptów)'));
        return;
      }
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (res) => {
          if (res.status >= 200 && res.status < 300) resolve(res.responseText);
          else reject(new Error(`HTTP ${res.status} dla ${url}`));
        },
        onerror: () => reject(new Error(`Błąd sieci dla ${url}`))
      });
    });
  }

  function buildVectorLayer(def, mapProj) {
    const style = def.style || {};
    const styleMap = new UW.OpenLayers.StyleMap({
      'default': new UW.OpenLayers.Style({
        strokeColor: style.strokeColor || '#ff0000',
        strokeWidth: style.strokeWidth ?? 3,
        strokeOpacity: style.strokeOpacity ?? 0.9,
        fillColor: style.fillColor || '#ff0000',
        fillOpacity: style.fillOpacity ?? 0.15
      })
    });

    const layer = new UW.OpenLayers.Layer.Vector(def.name, {
      styleMap,
      visibility: false
    });

    // Wewnętrzne flagi runtime
    layer.__onion = {
      type: 'geojson',
      loaded: false,
      loading: false
    };

    return layer;
  }

  async function ensureGeoJsonLoaded(item) {
    const layer = item.layer;
    const rt = layer.__onion;
    if (!rt || rt.loaded || rt.loading) return;

    rt.loading = true;
    const url = `${DATA_BASE_URL}${item.def.id}.${item.def.type}`;

    try {
      const text = await httpGetText(url);
      const geo = JSON.parse(text);

      const fmt = new UW.OpenLayers.Format.GeoJSON({
        externalProjection: new UW.OpenLayers.Projection('EPSG:4326'),
        internalProjection: UW.W.map.getProjectionObject()
      });

      const features = fmt.read(geo);
      if (features && features.length) {
        layer.addFeatures(features);
      } else {
        log('GeoJSON bez obiektów:', item.def.id);
      }

      rt.loaded = true;
    } catch (e) {
      log('Błąd ładowania GeoJSON:', item.def.id, e);
      // Jeśli nie udało się załadować, wyłącz warstwę w stanie użytkownika.
      setWantedLayerState(item.def, false);
      if (item.checkbox) item.checkbox.checked = false;
    } finally {
      rt.loading = false;
    }
  }

  // ---------- Budowanie requestów WMS (1.1.1) ----------
  function getUrlAsWms111(bounds) {
    bounds = bounds.clone();
    bounds = this.adjustBounds(bounds);

    const imageSize = this.getImageSize(bounds);
    const newParams = {};

    const mapProj = this.map.getProjectionObject();
    const mapCode = mapProj?.getCode ? mapProj.getCode() : 'EPSG:900913';

    // Żądany SRS dla serwera WMS (domyślnie: taki jak mapa)
    const reqSrs = this.requestSrs || this.params.SRS || mapCode;

    // Transformuj BBOX tylko na potrzeby requestu
    if (reqSrs !== mapCode) {
      try {
        const reqProj = new UW.OpenLayers.Projection(reqSrs);
        bounds.transform(mapProj, reqProj);
      } catch (e) {
        // jeśli transformacja nie jest dostępna, zostaw BBOX w projekcji mapy
      }
    }

    newParams.BBOX = bounds.toArray(false);
    newParams.WIDTH = imageSize.w;
    newParams.HEIGHT = imageSize.h;

    return this.getFullRequestString(newParams);
  }

  function setWmsSrs111(newParams, altUrl) {
    // Wymuś parametr SRS w stylu WMS 1.1.1
    const srs = this.requestSrs || this.params.SRS;
    if (srs) this.params.SRS = srs;
    if (this.params.CRS) delete this.params.CRS;
    return UW.OpenLayers.Layer.Grid.prototype.getFullRequestString.apply(this, arguments);
  }

  // ---------- Tworzenie warstw ----------
  function buildWmsLayer(def, mapSrs) {
    const params = Object.assign({}, def.params);

    // Request SRS: domyślnie projekcja mapy WME.
    const requestSrs = def.requestSrs || mapSrs;
    params.SRS = requestSrs;

    // Normalizacja nazw parametrów do formatu OpenLayers WMS.
    params.layers = params.layers || '';
    params.styles = params.styles ?? '';
    params.format = params.format || 'image/png';
    params.transparent = params.transparent ?? 'TRUE';
    params.version = def.version || '1.1.1';
    // Przydatne, gdy serwer zwraca 200 z pustym/przezroczystym kafelkiem.
    params.exceptions = params.exceptions || 'application/vnd.ogc.se_xml';

    // UWAGA: OpenLayers dopisze SERVICE/REQUEST/VERSION itd.
    // Polegamy na nadpisaniu getFullRequestString, aby wymusić SRS.
    const layer = new UW.OpenLayers.Layer.WMS(def.name, def.url, params, {
      isBaseLayer: false,
      visibility: false,
      singleTile: false,
      tileSize: new UW.OpenLayers.Size(1600, 1600),
      buffer: 0,
      transitionEffect: null,
      getURL: getUrlAsWms111,
      getFullRequestString: setWmsSrs111
    });
    layer.requestSrs = requestSrs;
    return layer;
  }

  function init() {
    const map = UW.W.map;

    // Bez duplikatów
    const already = map.getLayersByName(LAYERS[0].name);
    if (already && already.length) {
      log('Already initialized; skipping.');
      return;
    }

    const ul = getLayerSwitcherUL();
    if (!ul) {
      throw new Error('Layer switcher list not found');
    }

    // Pobierz kod SRS mapy do requestów w projekcji mapy
    const mapSrs = map.getProjectionObject()?.getCode ? map.getProjectionObject().getCode() : 'EPSG:900913';

    for (const def of LAYERS) {
      const enabled = getWantedLayerState(def);

      let layer;
      if (def.type === 'geojson') {
        layer = buildVectorLayer(def, map.getProjectionObject());
      } else {
        layer = buildWmsLayer(def, mapSrs);
      }

      map.addLayer(layer);
      layer.setZIndex(2050);

      const checkbox = addToggleRow(ul, layer, def, enabled);
      UI.layerItems.push({ def, layer, checkbox });

      // Jeśli warstwa GeoJSON była już włączona w stanie, spróbuj ją dociągnąć od razu.
      if (enabled && def.type === 'geojson') {
        ensureGeoJsonLoaded(UI.layerItems[UI.layerItems.length - 1]);
      }
    }

    // Zastosuj stan grupy nadrzędnej (odświeża też checkboxy warstw)
    applyGroupState();

    // Niektóre buildy WME/OpenLayers potrafią chwilowo ustawić widoczność po dodaniu warstwy.
    // Ponów po następnym tyknięciu i chwilę później, by stan "grupa wył." wygrał.
    setTimeout(applyGroupState, 0);
    setTimeout(applyGroupState, 500);

    log('Initialized.');
  }

  // ---------- Start ----------
  function initBootstrap() {
    try {
      // Czekamy aż menu warstw będzie gotowe
      if (document.getElementById('layer-switcher-group_display') != null && getLayerSwitcherUL()) {
        init();
      } else {
        setTimeout(initBootstrap, 800);
      }
    } catch (e) {
      setTimeout(initBootstrap, 800);
    }
  }

  whenWmeReady(() => {
    initBootstrap();
  });

  // === Dodanie nowych warstw do LAYERS[] ===
  // LAYERS.push({
  //   id: 'nowa',
  //   name: 'Nowa warstwa',
  //   url: 'https://example.com/wms',
  //   version: '1.1.1',
  //   params: { layers: 'foo', format: 'image/png', transparent: 'TRUE', styles: '' },
  //   defaultOn: false
  // });

})();
