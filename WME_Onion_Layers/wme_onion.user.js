// ==UserScript==
// @name                                     WME Onion Layers
// @name:pl                                     WME Cebula
// @version                                       Alpha.4
// @tag                                            WME
// @description                 Adds Polish WMS overlays from e-mapa.net to WME (works only in Poland territory).
// @description:pl              Cebula ma warstwy, WME ma WMSy! Dodaje polskie nakładki WMS z e-mapa.net do WME.
// @grant             none
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

  const SCRIPT_KEY = 'WME_Onion_Layers';
  const SCRIPT_NAME = 'WME Cebula';

  const log = (...a) => console.log(`🗺️ ${SCRIPT_NAME}`, ...a);

  // Referencje do UI w runtime
  const UI = {
    groupSwitch: null,
    layerItems: [] // { def, layer, checkbox }
  };


  // === Konfiguracja warstw ===
  // Opcjonalnie per warstwa:
  //   requestSrs: 'EPSG:900913' | 'EPSG:3857' | 'EPSG:4326'
  const LAYERS = [
    {
      id: 'opp',
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

  function getLayerEnabled(id, fallback) {
    const st = readState();
    const v = st.layers?.[id];
    if (typeof v === 'boolean') return v;
    return !!fallback;
  }

  function setLayerEnabled(id, enabled) {
    const st = readState();
    st.layers = st.layers || {};
    st.layers[id] = !!enabled;
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
        if (window.W && window.W.map && window.OpenLayers) cb();
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

    // Ochrona przed "phantom toggle" web-componentu.
    let allowPersist = false;
    let userInteracted = false;

    // Oznacz realną intencję użytkownika
    groupSwitch.addEventListener('pointerdown', () => { userInteracted = true; }, true);
    groupSwitch.addEventListener('mousedown', () => { userInteracted = true; }, true);
    groupSwitch.addEventListener('touchstart', () => { userInteracted = true; }, true);

    // W niektórych buildach realna interakcja zachodzi na wewnętrznym input
    const markShadowInput = () => {
      try {
        const sr = groupSwitch.shadowRoot;
        if (!sr) return false;
        const input = sr.querySelector('input[type="checkbox"]');
        if (!input) return false;
        if (input.__geoMarkWired) return true;
        input.__geoMarkWired = true;
        input.addEventListener('pointerdown', () => { userInteracted = true; }, true);
        input.addEventListener('mousedown', () => { userInteracted = true; }, true);
        input.addEventListener('touchstart', () => { userInteracted = true; }, true);
        return true;
      } catch (e) {
        return false;
      }
    };

    if (!markShadowInput()) {
      let tries = 0;
      const t = setInterval(() => {
        tries += 1;
        if (markShadowInput() || tries > 20) clearInterval(t);
      }, 250);
    }

    // Po krótkim czasie możemy bezpiecznie zapisywać zmiany,
    // nawet jeśli użytkownik jeszcze nie kliknął.
    setTimeout(() => { allowPersist = true; }, 1200);

    wireToggleSwitch(groupSwitch, (enabled) => {
      const stored = getGroupEnabled(true);

      // Jeśli nie było jeszcze interakcji użytkownika, a jesteśmy w oknie hydracji,
      // traktuj pierwszy toggle jako fantom: przywróć stan i nie zapisuj.
      if (!userInteracted && !allowPersist && enabled !== stored) {
        setSwitchChecked(groupSwitch, stored);
        applyGroupEnabledUI(stored);
        applyGroupState();
        return;
      }

      setGroupEnabled(enabled);

      // UX: po włączeniu grupy automatycznie ją rozwiń.
      if (enabled) {
        setGroupCollapsed(false);
      }

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

    // Preferuj realny stan wewnętrzny, jeśli jest dostępny
    try {
      if (el.shadowRoot) {
        const span = el.shadowRoot.querySelector('span.wz-toggle-switch');
        if (span) return span.classList.contains('checked');
        const input = el.shadowRoot.querySelector('input[type="checkbox"]');
        if (input) return !!input.checked;
      }
    } catch (e) {
      // ignoruj
    }

    // Ścieżki awaryjne
    if (typeof el.checked === 'boolean') return !!el.checked;
    return el.hasAttribute('checked');
  }

  // Ustawianie w trybie najlepszej próby dla wz-toggle-switch.
  // Używamy tego tylko do synchronizacji STANU POCZĄTKOWEGO.
  function setSwitchChecked(el, checked) {
    if (!el) return;
    if (checked) el.setAttribute('checked', '');
    else el.removeAttribute('checked');

    // Spróbuj zsynchronizować wewnętrzny checkbox, jeśli jest shadowRoot.
    try {
      if (el.shadowRoot) {
        const input = el.shadowRoot.querySelector('input[type="checkbox"]');
        if (input) input.checked = !!checked;
        const span = el.shadowRoot.querySelector('span.wz-toggle-switch');
        if (span) {
          if (checked) span.classList.add('checked');
          else span.classList.remove('checked');
        }
      }
    } catch (e) {
      // ignoruj
    }
  }

  function setCheckboxDisabled(el, disabled) {
    if (!el) return;
    if (disabled) el.setAttribute('disabled', '');
    else el.removeAttribute('disabled');
  }
  // Zapewnij, że wz-toggle-switch wywoła handler w różnych buildach WME.
  // Niektóre wersje nie emitują użytecznego `change` z hosta,
  // więc nasłuchujemy też wewnętrznego <input type="checkbox">.
  function wireToggleSwitch(toggleEl, onToggle) {
    if (!toggleEl) return;

    const fire = () => {
      try {
        onToggle(getSwitchChecked(toggleEl));
      } catch (e) {
        // ignoruj
      }
    };

    // Zdarzenia na hoście (na ile się da)
    toggleEl.addEventListener('change', fire);
    toggleEl.addEventListener('click', () => {
      // Klik może zmienić stan po wywołaniu handlera; odrocz.
      setTimeout(fire, 0);
    });

    // Zdarzenia shadow input
    const tryWireShadowInput = () => {
      try {
        const sr = toggleEl.shadowRoot;
        if (!sr) return false;
        const input = sr.querySelector('input[type="checkbox"]');
        if (!input) return false;

        // Uniknij podwójnego podpinania
        if (input.__geoWired) return true;
        input.__geoWired = true;

        input.addEventListener('change', () => setTimeout(fire, 0));
        input.addEventListener('click', () => setTimeout(fire, 0));
        return true;
      } catch (e) {
        return false;
      }
    };

    if (tryWireShadowInput()) return;

    // Shadow root może pojawić się chwilę później; spróbuj ponownie za chwilę.
    let tries = 0;
    const t = setInterval(() => {
      tries += 1;
      if (tryWireShadowInput() || tries > 20) clearInterval(t);
    }, 250);
  }

  function applyGroupState() {
    const groupEnabled = getGroupEnabled(true);

    // Odzwierciedl zachowanie natywne:
    // - gdy grupa WYŁ.: wymuszone zwinięcie + strzałka do góry
    // - gdy grupa WŁ.: nie wymuszaj zwinięcia (kontroluje użytkownik)
    if (UI.groupSwitch) {
      const groupLi = UI.groupSwitch.closest('li.group');
      const ul = groupLi?.querySelector('ul');
      const caretIcon = groupLi?.querySelector('i.toggle-category');
      const collapsed = !groupEnabled ? true : (ul ? ul.classList.contains('collapse-layer-switcher-group') : false);

      if (ul) {
        if (!groupEnabled) ul.classList.add('collapse-layer-switcher-group');
        // jeśli włączone: nie ruszaj klas ul
      }

      if (caretIcon) {
        caretIcon.className = collapsed
          ? 'toggle-category w-icon w-icon-caret-down upside-down'
          : 'toggle-category w-icon w-icon-caret-down';
      }
    }

    for (const item of UI.layerItems) {
      const wanted = getLayerEnabled(item.def.id, item.def.defaultOn);

      // Nie nadpisuj wyboru użytkownika dla warstwy, gdy grupa jest wyłączona.
      // Tylko wymuszamy niewidoczność na czas wyłączenia grupy.
      const effective = groupEnabled && wanted;
      item.layer.setVisibility(!!effective);

      // Wyłącz checkboxy warstw, gdy grupa jest wyłączona (zachowaj ich stan)
      if (item.checkbox) {
        // Zachowaj "checked" zgodnie z zapisanym stanem per warstwa
        item.checkbox.checked = !!wanted;
        setCheckboxDisabled(item.checkbox, !groupEnabled);
      }
    }
  }


  function addToggleRow(ul, layer, id, defaultChecked) {
    const li = document.createElement('li');

    const wrap = document.createElement('div');
    wrap.className = 'layer-selector';

    const chk = document.createElement('wz-checkbox');
    chk.appendChild(document.createTextNode(layer.name));

    // Checkbox odzwierciedla zapisany wybór dla danej warstwy.
    chk.checked = !!defaultChecked;

    chk.addEventListener('change', (e) => {
      const enabled = !!e.target.checked;
      // Zapisz wybór użytkownika i przelicz widoczność warstw.
      setLayerEnabled(id, enabled);
      applyGroupState();
    });

    wrap.appendChild(chk);
    li.appendChild(wrap);
    ul.appendChild(li);
    return chk;
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
        const reqProj = new window.OpenLayers.Projection(reqSrs);
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
    return window.OpenLayers.Layer.Grid.prototype.getFullRequestString.apply(this, arguments);
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
    const layer = new window.OpenLayers.Layer.WMS(def.name, def.url, params, {
      isBaseLayer: false,
      visibility: false,
      singleTile: false,
      tileSize: new window.OpenLayers.Size(1600, 1600),
      buffer: 0,
      transitionEffect: null,
      getURL: getUrlAsWms111,
      getFullRequestString: setWmsSrs111
    });
    layer.requestSrs = requestSrs;
    return layer;
  }

  function init() {
    const map = window.W.map;

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
      const enabled = getLayerEnabled(def.id, def.defaultOn);
      const layer = buildWmsLayer(def, mapSrs);
      map.addLayer(layer);
      // Z-index wyżej niż standardowe warstwy WME.
      layer.setZIndex(2050);

      const checkbox = addToggleRow(ul, layer, def.id, enabled);
      UI.layerItems.push({ def, layer, checkbox });
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
