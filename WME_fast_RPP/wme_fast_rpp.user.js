// ==UserScript==
// @name                WME fast RPP
// @version             0.5.0
// @tag                 WME
// @description         Fast residential point place (RPP) insertion with smart house number incrementing.
// @description:pl      Szybkie wstawianie RPP z inteligentną inkrementacją numerów domów.
// @author              Falcon4Tech
// @run-at              document-idle
// @namespace           https://wazepolska.pl
// @match               https://*.waze.com/editor*
// @match               https://*.waze.com/*/editor*
// @grant               none
// @supportURL          https://github.com/Falcon4Tech/WME/issues
// @updateURL           https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_fast_RPP/wme_fast_rpp.meta.js
// @downloadURL         https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_fast_RPP/wme_fast_rpp.user.js
// ==/UserScript==

/* eslint-disable no-multi-spaces */
/** @typedef {import("wme-sdk-typings").WmeSDK} WmeSDK */

(function () {
  'use strict';

  const UW = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;

  const SCRIPT_ID       = 'WME_fast_RPP';
  const SCRIPT_NAME     = 'WME fast RPP';
  const START_GUARD     = '__WME_FAST_RPP_BOOTSTRAPPED__';
  const PREFS_KEY       = 'WME_fast_RPP_prefs';
  const SHORTCUT_ID     = 'rpp-place';
  const SHORTCUT_KEY    = 'y';
  const MAX_HISTORY     = 20;
  const NUM_ROW_SIZE    = 9;
  const LETTER_ROW_SIZE = 9;
  const LAYER_NAME      = 'rpp-unaddressed';
  const LAYER_NAME_DUP  = 'rpp-duplicate';

  if (UW[START_GUARD]) return;
  UW[START_GUARD] = true;

  const log = (...args) => console.log(`[${SCRIPT_NAME}]`, ...args);

  /** @type {WmeSDK | null} */
  let sdk        = null;
  let activeMode = false;
  let drawing    = false;

  /** @type {string[]} */
  const historyEntries = [];

  // ── Prefs ──────────────────────────────────────────────────────────────
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}'); }
    catch { return {}; }
  }
  function savePrefs(prefs) {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
  }

  // ── House number logic ─────────────────────────────────────────────────
  function parseHouseNumber(s) {
    const m = String(s || '').trim().match(/^(\d+)([A-Za-z]?)$/);
    if (!m) return { num: null, letter: '' };
    return { num: parseInt(m[1], 10), letter: m[2].toUpperCase() };
  }

  // Auto-advance after placement:
  //   pure number  "8"  → "9"
  //   with letter  "8b" → "8c"
  function autoAdvance(nr) {
    const { num, letter } = parseHouseNumber(nr);
    if (num === null) return nr;
    if (!letter) return String(num + 1);
    return String(num) + String.fromCharCode(letter.charCodeAt(0) + 1);
  }

  // ── City / street resolution ───────────────────────────────────────────
  // WME city names can carry regional qualifiers: "Grodziszcze (pow. świdnicki)".
  // Strip the parenthetical when deriving the default street name from the city name.
  function streetNameFromCity(cityName) {
    return cityName.replace(/\s*\(.*\)$/, '').trim();
  }

  function resolveCity(cityName) {
    if (!cityName) return sdk.DataModel.Cities.getTopCity();
    return sdk.DataModel.Cities.getCity({ cityName })
        ?? sdk.DataModel.Cities.addCity({ cityName });
  }

  function resolveStreet(cityId, streetName) {
    if (!streetName) return null;
    return sdk.DataModel.Streets.getStreet({ cityId, streetName })
        ?? sdk.DataModel.Streets.addStreet({ cityId, streetName });
  }

  // ── Unaddressed RPP highlight layer ───────────────────────────────────
  // Red semi-transparent circle rendered behind each residential venue that
  // has no street assigned (street === null or isEmpty).
  function initLayer() {
    const svg = '<svg width="34" height="40" xmlns="http://www.w3.org/2000/svg">'
              + '<circle cx="17" cy="22.5" r="16" fill="#dd0000" fill-opacity="0.5" stroke="#cc0000" stroke-width="2"/>'
              + '</svg>';
    const icon = 'data:image/svg+xml;base64,' + btoa(svg);
    const iconStyle = { externalGraphic: icon, fillOpacity: 1, graphicWidth: 34, graphicHeight: 40 };

    try {
      sdk.Map.addLayer({
        layerName: LAYER_NAME,
        styleRules: [{ style: iconStyle }],
      });
    } catch (_) {}
    try { sdk.Map.addLayerCheckbox({ name: LAYER_NAME, isChecked: true }); } catch (_) {}

    const svgDup = '<svg width="34" height="40" xmlns="http://www.w3.org/2000/svg">'
                 + '<circle cx="17" cy="22.5" r="16" fill="#ff8800" fill-opacity="0.6" stroke="#e06000" stroke-width="2"/>'
                 + '</svg>';
    const iconDup      = 'data:image/svg+xml;base64,' + btoa(svgDup);
    const iconStyleDup = { externalGraphic: iconDup, fillOpacity: 1, graphicWidth: 34, graphicHeight: 40 };
    try {
      sdk.Map.addLayer({
        layerName: LAYER_NAME_DUP,
        styleRules: [{ style: iconStyleDup }],
      });
    } catch (_) {}
    try { sdk.Map.addLayerCheckbox({ name: LAYER_NAME_DUP, isChecked: true }); } catch (_) {}

    sdk.Events.on({
      eventName: 'wme-layer-checkbox-toggled',
      eventHandler: ({ name, checked }) => {
        if (name === LAYER_NAME)
          try { sdk.Map.setLayerVisibility({ layerName: LAYER_NAME,     visibility: checked }); } catch (_) {}
        if (name === LAYER_NAME_DUP)
          try { sdk.Map.setLayerVisibility({ layerName: LAYER_NAME_DUP, visibility: checked }); } catch (_) {}
      },
    });
  }

  function refreshLayer() {
    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_NAME });     } catch (_) { return; }
    try { sdk.Map.removeAllFeaturesFromLayer({ layerName: LAYER_NAME_DUP }); } catch (_) {}

    // First pass: collect addresses and count occurrences per unique key.
    const addrCount = new Map();
    const venueData = [];
    for (const v of sdk.DataModel.Venues.getAll()) {
      if (!v.isResidential || v.geometry.type !== 'Point') continue;
      try {
        const addr    = sdk.DataModel.Venues.getAddress({ venueId: v.id });
        const noStreet = !addr.street || addr.street.isEmpty;
        const key      = noStreet ? null
          : `${addr.city?.id ?? ''}|${addr.street.id}|${(addr.houseNumber ?? '').toLowerCase()}`;
        venueData.push({ id: v.id, geometry: v.geometry, noStreet, key });
        if (key) addrCount.set(key, (addrCount.get(key) ?? 0) + 1);
      } catch (_) {}
    }

    // Second pass: assign to the appropriate layer.
    const featuresUnaddr = [];
    const featuresDup    = [];
    for (const { id, geometry, noStreet, key } of venueData) {
      if (noStreet) {
        featuresUnaddr.push({ id: `u-${id}`, type: 'Feature', geometry, properties: {} });
      } else if (key && addrCount.get(key) > 1) {
        featuresDup.push({ id: `d-${id}`, type: 'Feature', geometry, properties: {} });
      }
    }

    if (featuresUnaddr.length)
      try { sdk.Map.addFeaturesToLayer({ layerName: LAYER_NAME,     features: featuresUnaddr }); } catch (_) {}
    if (featuresDup.length)
      try { sdk.Map.addFeaturesToLayer({ layerName: LAYER_NAME_DUP, features: featuresDup    }); } catch (_) {}
  }

  // ── UI refs ────────────────────────────────────────────────────────────
  let elCity, elStreet, elNr;
  // let elCityList; // [old: datalist]
  let elNumRow, elLetRow;
  let elModeBtn, elSave, elStatus, elHistoryList;

  // ── Dynamic row rendering ──────────────────────────────────────────────
  function updateRows() {
    renderNumberRow();
    renderLetterRow();
    updateModeUI();
  }

  function renderNumberRow() {
    if (!elNumRow) return;
    const { num } = parseHouseNumber(elNr?.value || '');
    elNumRow.innerHTML = '';
    if (num === null) return;
    const start = Math.max(1, num - 3);
    for (let i = 0; i < NUM_ROW_SIZE; i++) {
      const n = start + i;
      const btn = document.createElement('button');
      btn.className = 'rpp-row-btn' + (n === num ? ' active' : '');
      btn.textContent = String(n);
      btn.addEventListener('click', () => {
        if (elNr) { elNr.value = String(n); updateRows(); }
      });
      elNumRow.appendChild(btn);
    }
  }

  function renderLetterRow() {
    if (!elLetRow) return;
    const { num, letter } = parseHouseNumber(elNr?.value || '');
    elLetRow.innerHTML = '';
    if (num === null) return;

    let startIdx, highlightIdx;
    if (!letter) {
      startIdx = 0; highlightIdx = -1;
    } else {
      const letterIdx = letter.charCodeAt(0) - 65;
      startIdx     = Math.max(0, letterIdx - 3);
      highlightIdx = letterIdx - startIdx;
    }

    for (let i = 0; i < LETTER_ROW_SIZE; i++) {
      const code = 65 + startIdx + i;
      if (code > 90) break;
      const l = String.fromCharCode(code);
      const btn = document.createElement('button');
      btn.className = 'rpp-row-btn' + (i === highlightIdx ? ' active' : '');
      btn.textContent = l;
      btn.addEventListener('click', () => {
        if (elNr) { elNr.value = String(num) + l; updateRows(); }
      });
      elLetRow.appendChild(btn);
    }
  }

  // ── Sidebar UI ─────────────────────────────────────────────────────────
  function buildUI(pane) {
    const style = document.createElement('style');
    style.textContent = `
      #rpp-panel { padding: 8px 10px; font-size: 13px; font-family: sans-serif; }
      #rpp-panel label { display: block; font-weight: 600; margin: 8px 0 2px; }
      #rpp-panel label span { font-weight: 400; font-size: 11px; color: #999; margin-left: 4px; }
      #rpp-panel input[type=text], #rpp-panel select {
        box-sizing: border-box; width: 100%; padding: 4px 6px;
        border: 1px solid #ccc; border-radius: 3px; font-size: 13px;
      }
      #rpp-panel input[type=text]:focus,
      #rpp-panel select:focus { outline: none; border-color: #2196f3; }
      #rpp-nr-row { display: flex; gap: 6px; align-items: center; margin-bottom: 5px; }
      #rpp-nr { width: 70px !important; }
      #rpp-skip {
        padding: 4px 8px; border: 1px solid #bbb; border-radius: 3px;
        cursor: pointer; background: #f5f5f5; font-size: 12px; white-space: nowrap;
      }
      #rpp-skip:hover { background: #e0e0e0; }
      #rpp-num-row, #rpp-let-row { display: flex; gap: 3px; margin-bottom: 3px; }
      .rpp-row-btn {
        padding: 4px 0; border: 1px solid #ddd; border-radius: 3px;
        cursor: pointer; background: #f9f9f9; font-size: 12px; font-weight: 600;
        flex: 1; text-align: center;
      }
      .rpp-row-btn:hover { background: #ddeeff; border-color: #2196f3; }
      .rpp-row-btn.active { background: #2196f3; color: #fff; border-color: #1565c0; }
      #rpp-mode-btn {
        display: block; width: 100%; margin-top: 8px; padding: 8px;
        border: none; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 700;
      }
      #rpp-mode-btn.idle        { background: #2196f3; color: #fff; }
      #rpp-mode-btn.idle:hover  { background: #1976d2; }
      #rpp-mode-btn.active      { background: #e53935; color: #fff; }
      #rpp-mode-btn.active:hover { background: #b71c1c; }
      #rpp-save {
        display: block; width: 100%; margin-top: 4px; padding: 5px;
        background: #4caf50; color: #fff; border: none; border-radius: 4px;
        cursor: pointer; font-size: 12px;
      }
      #rpp-save:hover { background: #388e3c; }
      #rpp-status { margin: 7px 0 3px; font-size: 12px; min-height: 15px; }
      #rpp-status.ok   { color: #2e7d32; }
      #rpp-status.err  { color: #c62828; }
      #rpp-status.info { color: #1565c0; }
      #rpp-hist-label {
        font-weight: 600; font-size: 11px; color: #999; margin-top: 10px;
        text-transform: uppercase; letter-spacing: .5px;
      }
      #rpp-history {
        list-style: none; margin: 3px 0 0; padding: 0;
        font-size: 12px; color: #444;
      }
      #rpp-history li { padding: 2px 0; border-bottom: 1px solid #f0f0f0; }
      #rpp-history li::before { content: "✓ "; color: #4caf50; font-weight: 700; }
      #rpp-notes-label {
        font-weight: 600; font-size: 11px; color: #999; margin-top: 10px;
        text-transform: uppercase; letter-spacing: .5px;
      }
      #rpp-inst {
        margin: 4px 0 0; padding: 0 0 0 16px;
        font-size: 12px; color: #444; line-height: 1.6;
      }
      #rpp-inst ul {
        padding-inline-start: 15px;
      }
    `;
    pane.appendChild(style);

    const div = document.createElement('div');
    div.id = 'rpp-panel';
    div.innerHTML = `
      <label>Miasto</label>
      <!-- [trial: select] -->
      <select id="rpp-city"><option value="">-- wybierz --</option></select>
      <!-- [old: text input]
      <input type="text" id="rpp-city" list="rpp-city-list" autocomplete="off" placeholder="np. Sikorz" />
      <datalist id="rpp-city-list"></datalist>
      -->

      <label>Ulica <span>(puste = nazwa miasta)</span></label>
      <input type="text" id="rpp-street" autocomplete="off" placeholder="np. Sikorz" />

      <label>Numer domu</label>
      <div id="rpp-nr-row">
        <input type="text" id="rpp-nr" placeholder="np. 5" />
        <button id="rpp-skip">→ skip</button>
      </div>
      <div id="rpp-num-row"></div>
      <div id="rpp-let-row"></div>

      <button id="rpp-mode-btn" class="idle">▶ START  [${SHORTCUT_KEY.toUpperCase()}]</button>
      <button id="rpp-save">💾 Zapisz zmiany</button>
      <div id="rpp-status" class="info"></div>
      <div id="rpp-hist-label">Historia</div>
      <ul id="rpp-history"></ul>
      <div id="rpp-notes-label">Instrukca</div>
      <p class="info">RPP dodajemy w przypadku braku nazwanej ulicy lub gdy dojazd pod adres jest od strony innej ulicy niż w adresie.</p>
      <ul id="rpp-inst">
        <li><b>Miejscowości samodzielne</b>
          <ul><li>- uzupełnij tylko "Miasto"</li></ul>
          </li>
        <li><b>Przysiółki, osady, kolonie, itp</b>
          <ul>
            <li>w pole "Miasto" wprowadź nazwę istniejącej miejscowości do której należy adresowany obszar</li>
            <li>w polu "Ulica" wprowadź nazwę adresownaego obszaru</li>
          </ul>
        </li>
        <li><b>Przykładowo:</b>
        <ul>
        <li><a href="https://waze.com/pl/editor?env=row&lat=50.74677&lon=16.57146&zoomLevel=18&venues=10879483.108598227.42809084">Piskorzów (pow. dzierżoniowski)</a> od 1 stycznia 2016 samodzielna wieś.<br/>
        – <i>Miasto</i> - Piskorzów (pow. dzierżoniowski)<br/>
        – <i>Ulica</i> - Piskorzów [możesz zostawić puste, skrypt sam uzupełni]
        </li>
        <li><a href="https://waze.com/pl/editor?env=row&lat=50.79111&lon=20.47522&marker=true&zoomLevel=18&venues=13435388.134157271.39124755">Wrzosy</a> - przysiółek wsi Starochęciny<br/>
        – <i>Miasto</i> - Starochęciny<br/>
        – <i>Ulica</i> - Wrzosy
        </li>
        </ul>
        </li>
      </ul>
    `;
    pane.appendChild(div);

    elCity        = div.querySelector('#rpp-city');
    elStreet      = div.querySelector('#rpp-street');
    elNr          = div.querySelector('#rpp-nr');
    // elCityList = div.querySelector('#rpp-city-list'); // [old: datalist]
    elNumRow      = div.querySelector('#rpp-num-row');
    elLetRow      = div.querySelector('#rpp-let-row');
    elModeBtn     = div.querySelector('#rpp-mode-btn');
    elSave        = div.querySelector('#rpp-save');
    elStatus      = div.querySelector('#rpp-status');
    elHistoryList = div.querySelector('#rpp-history');

    div.querySelector('#rpp-skip').addEventListener('click', () => {
      const { num } = parseHouseNumber(elNr?.value || '');
      if (num !== null && elNr) { elNr.value = String(num + 1); updateRows(); }
    });

    elNr.addEventListener('input', updateRows);
    elCity.addEventListener('change', () => { persistPrefs(); updateModeUI(); }); // [trial: change for select]
    // elCity.addEventListener('input', updateModeUI); // [old: input for text]
    elStreet.addEventListener('input', updateModeUI);

    elModeBtn.addEventListener('click', toggleMode);
    elSave.addEventListener('click', () => {
      sdk.Editing.save()
        .then(() => setStatus('✓ Zapisano', 'ok'))
        .catch(() => setStatus('Błąd zapisu', 'err'));
    });

    restorePrefs();
    fillCitySelect(); // [trial: select]
    // fillCityDatalist(); // [old: datalist]
    updateRows();
    updateModeUI();
  }

  function setStatus(msg, cls = 'info') {
    if (!elStatus) return;
    elStatus.textContent = msg;
    elStatus.className = cls;
  }

  // [trial: select instead of datalist]
  function fillCitySelect() {
    if (!elCity || elCity.tagName !== 'SELECT') return;
    const saved = elCity.value || loadPrefs().cityName || '';
    elCity.innerHTML = '<option value="">-- wybierz --</option>';
    try {
      const topCity = sdk.DataModel.Cities.getTopCity();
      const bbox   = sdk.Map.getMapExtent(); // [minLon, minLat, maxLon, maxLat]
      const padX   = (bbox[2] - bbox[0]) * 0.25;
      const padY   = (bbox[3] - bbox[1]) * 0.25;

      // Minimum radius: XX km from map center
      const ctr      = sdk.Map.getMapCenter();
      const kmPerLat = 111.32;
      const minDLat  = 15 / kmPerLat;
      const minDLon  = 15 / (kmPerLat * Math.cos(ctr.lat * Math.PI / 180));
      const minLon   = Math.min(bbox[0] - padX, ctr.lon - minDLon);
      const minLat   = Math.min(bbox[1] - padY, ctr.lat - minDLat);
      const maxLon   = Math.max(bbox[2] + padX, ctr.lon + minDLon);
      const maxLat   = Math.max(bbox[3] + padY, ctr.lat + minDLat);

      const all = sdk.DataModel.Cities.getAll().filter(c => c.name && !c.isEmpty);

      const inView = new Set();
      const visible = all.filter(c => {
        const [lon, lat] = c.geometry.coordinates;
        const ok = lon >= minLon && lat >= minLat && lon <= maxLon && lat <= maxLat;
        if (ok) inView.add(c.name);
        return ok;
      });

      // Always keep the saved city in the list regardless of viewport
      if (saved && !inView.has(saved)) {
        const savedCity = all.find(c => c.name === saved);
        if (savedCity) visible.push(savedCity);
      }

      visible
        .sort((a, b) => a.name.localeCompare(b.name, 'pl'))
        .forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.name;
          opt.textContent = c.name;
          elCity.appendChild(opt);
        });
      elCity.value = saved || topCity?.name || '';
    } catch (_) {}
  }

  // [old: datalist]
  // function fillCityDatalist() {
  //   if (!elCityList) return;
  //   elCityList.innerHTML = '';
  //   try {
  //     sdk.DataModel.Cities.getAll()
  //       .filter(c => c.name && !c.isEmpty)
  //       .sort((a, b) => a.name.localeCompare(b.name))
  //       .forEach(c => {
  //         const opt = document.createElement('option');
  //         opt.value = c.name;
  //         elCityList.appendChild(opt);
  //       });
  //   } catch (_) {}
  // }

  function pushHistory(city, street, nr) {
    const label = formatAddress(city, street, nr);
    historyEntries.unshift(label);
    if (historyEntries.length > MAX_HISTORY) historyEntries.pop();
    if (!elHistoryList) return;
    elHistoryList.innerHTML = '';
    historyEntries.forEach(entry => {
      const li = document.createElement('li');
      li.textContent = entry;
      elHistoryList.appendChild(li);
    });
  }

  function formatAddress(cityName, streetName, nr) {
    const cityBase = cityName ? streetNameFromCity(cityName) : '';
    const loc      = streetName || cityBase;
    const suffix   = (streetName && cityBase && streetName !== cityBase) ? `, ${cityBase}` : '';
    return `${loc ? loc + ' ' : ''}${nr || '?'}${suffix}`;
  }

  function buildAddressPreview() {
    return formatAddress(elCity?.value.trim(), elStreet?.value.trim(), elNr?.value.trim());
  }

  function updateModeUI() {
    if (!elModeBtn) return;
    if (activeMode) {
      elModeBtn.textContent = '■ STOP  [Esc]';
      elModeBtn.className = 'active';
      setStatus(`● Kliknij → ${buildAddressPreview()}`, 'info');
    } else {
      elModeBtn.textContent = `▶ START  [${SHORTCUT_KEY.toUpperCase()}]`;
      elModeBtn.className = 'idle';
      setStatus(`→ ${buildAddressPreview()}`, 'info');
    }
  }

  function restorePrefs() {
    const prefs = loadPrefs();
    // elCity (select) is populated by fillCitySelect() which reads prefs directly
    if (elStreet && prefs.streetName) elStreet.value = prefs.streetName;
    if (elNr     && prefs.lastNumber) elNr.value     = prefs.lastNumber;
  }

  function persistPrefs() {
    savePrefs({
      cityName:   elCity?.value.trim()   || '',
      streetName: elStreet?.value.trim() || '',
      lastNumber: elNr?.value.trim()     || '',
    });
  }

  // ── Place single RPP at given point ────────────────────────────────────
  function doPlace(point) {
    const cityName = elCity?.value.trim() || '';
    const nr       = elNr?.value.trim()   || '';

    if (!nr) {
      setStatus('Wpisz numer domu!', 'err');
      return;
    }

    // If street field is empty, fall back to city name (stripped of qualifier)
    const streetName = elStreet?.value.trim() || streetNameFromCity(cityName);

    try {
      const city   = resolveCity(cityName);
      const street = city ? resolveStreet(city.id, streetName) : null;

      // addVenue returns number — must convert to string for subsequent calls
      const numericId = sdk.DataModel.Venues.addVenue({
        category: 'RESIDENTIAL',
        geometry: point,
      });
      const venueId = String(numericId);

      // updateAddress BEFORE updateVenueIsResidential —
      // WME validates that a residential venue already has a house number
      sdk.DataModel.Venues.updateAddress({
        venueId,
        houseNumber: nr,
        ...(street ? { streetId: street.id } : {}),
      });
      sdk.DataModel.Venues.updateVenueIsResidential({ isResidential: true, venueId });

      pushHistory(cityName, streetName, nr);

      if (elNr) {
        elNr.value = autoAdvance(nr);
        updateRows();
      }

      persistPrefs();
      refreshLayer();
      setStatus(`✓ ${streetName ? streetName + ' ' : ''}${nr}`, 'ok');
      log(`Added: ${cityName} / ${streetName} / ${nr}`, point.coordinates);

    } catch (e) {
      setStatus(`Błąd: ${e?.message || String(e)}`, 'err');
      log('Placement error:', e);
    }
  }

  // ── Continuous placement mode ──────────────────────────────────────────
  async function toggleMode() {
    if (activeMode) {
      activeMode = false;
      updateModeUI();
      return;
    }

    if (drawing) return;

    activeMode = true;
    updateModeUI();

    while (activeMode) {
      let point;
      drawing = true;
      try {
        point = await sdk.Map.drawPoint();
      } catch {
        drawing = false;
        activeMode = false;
        break;
      }
      drawing = false;

      if (!activeMode) break;

      doPlace(point);
      updateModeUI();
    }

    activeMode = false;
    drawing = false;
    updateModeUI();
  }

  // ── Init ───────────────────────────────────────────────────────────────
  async function initScript() {
    try {
      const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
      tabLabel.textContent = 'RPP';
      tabLabel.title = 'WME fast RPP';
      buildUI(tabPane);
      initLayer();

      try {
        sdk.Shortcuts.createShortcut({
          shortcutId:   SHORTCUT_ID,
          shortcutKeys: SHORTCUT_KEY,
          description:  'WME fast RPP — włącz/wyłącz tryb wstawiania',
          callback:     toggleMode,
        });
        log(`Shortcut "${SHORTCUT_KEY}" registered.`);
      } catch (e) {
        log(`Shortcut "${SHORTCUT_KEY}" registration failed: ${e?.message}. Use the panel button.`);
      }

      sdk.Events.on({
        eventName:    'wme-map-data-loaded',
        eventHandler: () => { fillCitySelect(); refreshLayer(); },
      });

      refreshLayer();

      log('Ready.');
    } catch (e) {
      log('Init error:', e);
    }
  }

  // ── Bootstrap ──────────────────────────────────────────────────────────
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
