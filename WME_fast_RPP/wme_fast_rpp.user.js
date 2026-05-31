// ==UserScript==
// @name                WME fast RPP
// @version             0.3.0
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
  const MAX_HISTORY     = 20;  // max entries in history list
  const NUM_ROW_SIZE    = 8;   // numbers visible in number row
  const LETTER_ROW_SIZE = 8;   // letters visible in letter row

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
  //   pure number  "8"  → "9"   (increment)
  //   with letter  "8b" → "8c"  (next letter, same number base)
  function autoAdvance(nr) {
    const { num, letter } = parseHouseNumber(nr);
    if (num === null) return nr;
    if (!letter) return String(num + 1);
    return String(num) + String.fromCharCode(letter.charCodeAt(0) + 1);
  }

  // ── City / street resolution (street always = city name) ───────────────
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

  // ── UI refs ────────────────────────────────────────────────────────────
  let elCity, elNr, elModeBtn, elSave, elStatus, elHistoryList, elCityList;
  let elNumRow, elLetRow;

  // ── Dynamic row rendering ──────────────────────────────────────────────
  function updateRows() {
    renderNumberRow();
    renderLetterRow();
  }

  function renderNumberRow() {
    if (!elNumRow) return;
    const { num } = parseHouseNumber(elNr?.value || '');
    elNumRow.innerHTML = '';
    if (num === null) return;

    // Show [n-1, n, n+1, n+2, n+3], clamped so minimum is 1
    const start = Math.max(1, num - 1);
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

    // Window of LETTER_ROW_SIZE letters starting from letter-1 (or A if at start)
    // A=0, B=1, C=2, ...
    let startIdx;
    let highlightIdx; // position of current letter in the rendered window, -1 if none

    if (!letter) {
      startIdx     = 0;  // start from A
      highlightIdx = -1; // nothing selected
    } else {
      const letterIdx = letter.charCodeAt(0) - 65;
      startIdx     = Math.max(0, letterIdx - 1);
      highlightIdx = letterIdx - startIdx;
    }

    for (let i = 0; i < LETTER_ROW_SIZE; i++) {
      const code = 65 + startIdx + i;
      if (code > 90) break; // past 'Z'
      const l = String.fromCharCode(code);
      const btn = document.createElement('button');
      btn.className = 'rpp-row-btn' + (i === highlightIdx ? ' active' : '');
      btn.textContent = l;
      // Capture num at render time; input event re-renders row on any change
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
      #rpp-panel input[type=text] {
        box-sizing: border-box; padding: 4px 6px;
        border: 1px solid #ccc; border-radius: 3px; font-size: 13px;
      }
      #rpp-city { width: 100%; }
      #rpp-panel input[type=text]:focus { outline: none; border-color: #2196f3; }
      #rpp-nr-row { display: flex; gap: 6px; align-items: center; margin-bottom: 5px; }
      #rpp-nr { width: 70px; }
      #rpp-skip {
        padding: 4px 8px; border: 1px solid #bbb; border-radius: 3px;
        cursor: pointer; background: #f5f5f5; font-size: 12px; white-space: nowrap;
      }
      #rpp-skip:hover { background: #e0e0e0; }
      #rpp-num-row, #rpp-let-row { display: flex; gap: 3px; margin-bottom: 3px; }
      .rpp-row-btn {
        padding: 4px 0; border: 1px solid #ddd; border-radius: 3px;
        cursor: pointer; background: #f9f9f9; font-size: 12px; font-weight: 600;
        min-width: 28px; text-align: center; flex-shrink: 0;
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
        font-size: 12px; color: #444; max-height: 130px; overflow-y: auto;
      }
      #rpp-history li { padding: 2px 0; border-bottom: 1px solid #f0f0f0; }
      #rpp-history li::before { content: "✓ "; color: #4caf50; font-weight: 700; }
    `;
    pane.appendChild(style);

    const div = document.createElement('div');
    div.id = 'rpp-panel';
    div.innerHTML = `
      <label>Miasto / Ulica</label>
      <input type="text" id="rpp-city" list="rpp-city-list" autocomplete="off" placeholder="np. Sikorz" />
      <datalist id="rpp-city-list"></datalist>

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
    `;
    pane.appendChild(div);

    elCity        = div.querySelector('#rpp-city');
    elNr          = div.querySelector('#rpp-nr');
    elModeBtn     = div.querySelector('#rpp-mode-btn');
    elSave        = div.querySelector('#rpp-save');
    elStatus      = div.querySelector('#rpp-status');
    elHistoryList = div.querySelector('#rpp-history');
    elCityList    = div.querySelector('#rpp-city-list');
    elNumRow      = div.querySelector('#rpp-num-row');
    elLetRow      = div.querySelector('#rpp-let-row');

    div.querySelector('#rpp-skip').addEventListener('click', () => {
      const { num } = parseHouseNumber(elNr?.value || '');
      if (num !== null && elNr) { elNr.value = String(num + 1); updateRows(); }
    });

    elNr.addEventListener('input', updateRows);

    elModeBtn.addEventListener('click', toggleMode);
    elSave.addEventListener('click', () => {
      sdk.Editing.save()
        .then(() => setStatus('✓ Zapisano', 'ok'))
        .catch(() => setStatus('Błąd zapisu', 'err'));
    });

    restorePrefs();
    fillCityDatalist();
    updateRows();
    updateModeUI();
  }

  function setStatus(msg, cls = 'info') {
    if (!elStatus) return;
    elStatus.textContent = msg;
    elStatus.className = cls;
  }

  function fillCityDatalist() {
    if (!elCityList) return;
    elCityList.innerHTML = '';
    try {
      sdk.DataModel.Cities.getAll()
        .filter(c => c.name && !c.isEmpty)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach(c => {
          const opt = document.createElement('option');
          opt.value = c.name;
          elCityList.appendChild(opt);
        });
    } catch (_) {}
  }

  function pushHistory(city, nr) {
    historyEntries.unshift(city ? `${city} ${nr}` : nr);
    if (historyEntries.length > MAX_HISTORY) historyEntries.pop();
    if (!elHistoryList) return;
    elHistoryList.innerHTML = '';
    historyEntries.forEach(entry => {
      const li = document.createElement('li');
      li.textContent = entry;
      elHistoryList.appendChild(li);
    });
  }

  function updateModeUI() {
    if (!elModeBtn) return;
    if (activeMode) {
      elModeBtn.textContent = '■ STOP  [Esc]';
      elModeBtn.className = 'active';
      setStatus('● Kliknij na mapie…', 'info');
    } else {
      elModeBtn.textContent = `▶ START  [${SHORTCUT_KEY.toUpperCase()}]`;
      elModeBtn.className = 'idle';
    }
  }

  function restorePrefs() {
    const prefs = loadPrefs();
    if (elCity && prefs.cityName)   elCity.value = prefs.cityName;
    if (elNr   && prefs.lastNumber) elNr.value   = prefs.lastNumber;
  }

  function persistPrefs() {
    savePrefs({
      cityName:   elCity?.value.trim() || '',
      lastNumber: elNr?.value.trim()   || '',
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

    try {
      const city   = resolveCity(cityName);
      // street name = city name (always)
      const street = city ? resolveStreet(city.id, cityName) : null;

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

      pushHistory(cityName, nr);

      // Auto-advance: pure number → next number; with letter → next letter (same base)
      if (elNr) {
        elNr.value = autoAdvance(nr);
        updateRows();
      }

      persistPrefs();
      setStatus(`✓ ${cityName ? cityName + ' ' : ''}${nr}`, 'ok');
      log(`Added: ${cityName} / ${nr}`, point.coordinates);

    } catch (e) {
      setStatus(`Błąd: ${e?.message || String(e)}`, 'err');
      log('Placement error:', e);
    }
  }

  // ── Continuous placement mode ──────────────────────────────────────────
  // Y → enter loop; each map click places one RPP; Esc exits loop.
  async function toggleMode() {
    if (activeMode) {
      activeMode = false;
      updateModeUI();
      return;
    }

    if (drawing) return; // previous loop still winding down

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

      if (!activeMode) break; // STOP was pressed while waiting for click

      doPlace(point);
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
        eventHandler: fillCityDatalist,
      });

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
