// ==UserScript==
// @name                                     WME Node Finder
// @version                                       2602.15
// @tag                                            WME
// @description       [Only for Poland] Tab in Scripts with a search engine for GDDKiA road nodes and border crossings.
// @description:pl    Zakładka w Scripts (WME SDK) z wyszukiwarką węzłów drogowych GDDKiA i przejść granicznych.
// @author            Falcon4Tech
// @grant             GM_xmlhttpRequest
// @grant             unsafeWindow
// @connect           kpd.gddkia.gov.pl
// @namespace         https://wazepolska.pl
// @match             https://*.waze.com/editor*
// @match             https://*.waze.com/*/editor*
// @icon              https://drogi.gddkia.gov.pl/templates/webster/favicon.ico
// @supportURL        https://github.com/Falcon4Tech/WME/issues
// @updateURL         https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_Node_Finder/wme_node_finder.meta.js
// @downloadURL       https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_Node_Finder/wme_node_finder.user.js
// @run-at            document-idle
// ==/UserScript==

/** @typedef {import("../types").WmeSDK} WmeSDK */
/** @typedef {import("../types").Venue} Venue */
/** @typedef {import("../types").SelectionWithLocalizedTypeName} SelectionWithLocalizedTypeName */
/** @typedef {import("../types").LonLat} LonLat */
/** @typedef {{ ts: number, json: any }} CachePayload */
/** @typedef {"junctions" | "borders"} DataKind */
/** @typedef {{ value: string, label: string }} SelectOption */
/** @typedef {{ label: string, options: SelectOption[] }} SelectOptionGroup */
/** @typedef {{ road?: string, branch?: string, name?: string, number?: string | number | null }} JunctionFilters */
/** @typedef {{ neighbor?: string, geographical_border?: string, name?: string, onlyClosed?: boolean }} BorderFilters */
/** @typedef {{ id: string | number | null, branch: string, name: string, road_number: string, mileage: number | string | null, number: number | string | null, latitude: number | string | null, longitude: number | string | null }} JunctionItem */
/** @typedef {{ id: string | number | null, geographical_border: string, neighbor: string, type_of_traffic: string, name_border_crossing: string, road_number: string, latitude: number | string | null, longitude: number | string | null, limitations: string, border_kind: string, other: string }} BorderItem */

/**
 * CHANGELOG:
 *    2602.15 - Poprawka wstawiania nazwy węzła z numerem do venue
 *    2602.14 - Dodanie typów JSDoc dla uniknięcia błędów i lepszej czytelności kodu
 *    2602.12 - Refaktor kodu pod pełne wsparcie WME SDK
 *    2602.6  - Po zaznaczeniu węzła na mpapie, przycisk zmienia się na "↪︎" do wstawiania nazwy węzła
 *    2602.5  - Przy braku wybranych filtrów, wyświetlane są węzły w promieniu 25 km, węzeł w centrum mapy jest podświetlany na liście
 *    2602.3  - Wersja stabilna - opubikowana
 *    2602.1  - Zoom mapy przy centrowaniu na węzeł/przejście zgodnie z SDK
 *    2601.3  - Zmniejszenie ilości filtrów (do najważniejszych)
 *    2601.1  - Poprawki UI i wydajności
 *    Beta.5  - Wersja stabilna
 *    Alpha.3 - Dodanie listy przejść granicznych
 *    Alpha.1 - Wersja początkowa - lista węzłów drogowych wg. danych GDDKiA
 */

(function () {
  "use strict";

  const SCRIPT_ID = "pl-gddkia-junction-search";
  const SCRIPT_NAME = "PL: Węzły GDDKiA";

  const ENDPOINTS = {
    junctions: "https://kpd.gddkia.gov.pl/amp/api/waypoints/junctions.json",
    borders: "https://kpd.gddkia.gov.pl/amp/api/waypoints/borders.json",
  };

  const CACHE_KEYS = {
    junctions: `${SCRIPT_ID}::junctions_cache_v1`,
    borders: `${SCRIPT_ID}::borders_cache_v1`,
  };
  const CACHE_TTL_MS = 60 * 60 * 60 * 1000; // 60h

  const ACTIVE_RADIUS_M = 2500;
  const LIST_RADIUS_M = 10000;
  const REQUEST_RETRY_DELAY_MS = 1500;
  const REQUEST_MAX_RETRIES = 1;

  const DEBUG = false;
  const log = (...args) => {
    if (DEBUG) console.log(`[${SCRIPT_NAME}]`, ...args);
  };

  /**
   * @param {string} key
   * @returns {CachePayload | null}
   */
  function loadCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object") return null;
      if (typeof parsed.ts !== "number") return null;
      if (!parsed.json) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {string} key
   * @param {any} json
   * @returns {CachePayload | null}
   */
  function saveCache(key, json) {
    try {
      const payload = { ts: Date.now(), json };
      localStorage.setItem(key, JSON.stringify(payload));
      return payload;
    } catch (_) {
      return null;
    }
  }

  /**
   * @param {string} url
   * @returns {Promise<any>}
   */
  function gmFetchJson(url) {
    return new Promise((resolve, reject) => {
      log("gmFetchJson: start", url);
      if (typeof GM_xmlhttpRequest !== "function") {
        reject(new Error("GM_xmlhttpRequest unavailable"));
        return;
      }
      GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "json",
        onload: (resp) => {
          if (resp.status < 200 || resp.status >= 300) {
            reject(new Error(`HTTP ${resp.status}`));
            return;
          }
          const body = resp.response ?? resp.responseText;
          try {
            const parsed = typeof body === "string" ? JSON.parse(body) : body;
            const count = Array.isArray(parsed?.response) ? parsed.response.length : null;
            log("gmFetchJson: ok", { status: resp.status, count });
            resolve(parsed);
          } catch (e) {
            log("gmFetchJson: parse error", e);
            reject(e);
          }
        },
        onerror: () => {
          log("gmFetchJson: network error");
          reject(new Error("Network error"));
        },
        ontimeout: () => {
          log("gmFetchJson: timeout");
          reject(new Error("Timeout"));
        },
      });
    });
  }

  /**
   * @param {number} lat1
   * @param {number} lon1
   * @param {number} lat2
   * @param {number} lon2
   * @returns {number}
   */
  function distanceMeters(lat1, lon1, lat2, lon2) {
    const r = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * r * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /** @type {WmeSDK | null} */
  let sdk = null;
  /** @type {JunctionItem[]} */
  let dataJunctions = [];
  /** @type {BorderItem[]} */
  let dataBorders = [];

  const esc = (s) => String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const norm = (s) => String(s ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  /**
   * @param {number | string | null | undefined} mileage
   * @returns {string}
   */
  const formatKm = (mileage) => {
    const n = Number(mileage);
    if (!Number.isFinite(n)) return "—";
    return n.toFixed(3) + " km";
  };

  /**
   * @param {(...args: any[]) => void} fn
   * @param {number} [ms=200]
   * @returns {(...args: any[]) => void}
   */
  const debounce = (fn, ms = 200) => {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };

  function injectStyles() {
    const css = `
      .${SCRIPT_ID}__wrap { padding: 10px; }
      .${SCRIPT_ID}__h { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
      .${SCRIPT_ID}__grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
      .${SCRIPT_ID}__grid3 { display: grid; grid-template-columns: 1fr; gap: 8px; }
      .${SCRIPT_ID}__field label { display:block; font-size: 12px; opacity: .85; margin-bottom: 2px; }
      .${SCRIPT_ID}__field input { width: 100%; }
      .${SCRIPT_ID}__field input[type="checkbox"] { width: auto; }
      .${SCRIPT_ID}__field label.${SCRIPT_ID}__inline { display:flex; align-items:self-start; gap: 6px; }
      .${SCRIPT_ID}__bar { display:flex; gap: 8px; align-items:center; margin: 8px 0; }
      .${SCRIPT_ID}__meta { margin: 6px 0; font-size: 12px; opacity: .85; }
      .${SCRIPT_ID}__list { display:flex; flex-direction:column; gap: 6px; }
      .${SCRIPT_ID}__row { display:flex; justify-content:space-between; gap: 8px; padding: 8px; border-radius: 8px; background: rgba(0,0,0,.04); }
      .${SCRIPT_ID}__row--active { background: rgba(74,140,202,.18); box-shadow: inset 0 0 0 1px rgba(74,140,202,.5); }
      .${SCRIPT_ID}__title { line-height: 1.2; }
      .${SCRIPT_ID}__sub { font-size: 12px; opacity: .85; }
      .${SCRIPT_ID}__right { display:flex; align-items:center; }
      .${SCRIPT_ID}__note { font-size: 12px; opacity: .75; margin-top: 8px; line-height: 1.25; }
      .${SCRIPT_ID}__small { font-size: 12px; opacity: .8; }
      .${SCRIPT_ID}__tabs { display:flex; gap: 8px; margin: 0 0 8px; }
      .${SCRIPT_ID}__tab-btn { flex: 1; }
      .${SCRIPT_ID}__tab-btn.is-active { background: #4a8cca; border-color: #4a8cca; color: #fff; }
      .${SCRIPT_ID}__panel--hidden { display: none; }
      .${SCRIPT_ID}__grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
      .${SCRIPT_ID}__grid2 .${SCRIPT_ID}__field { min-width: 0; }
      .${SCRIPT_ID}__grid2 .${SCRIPT_ID}__field--full { grid-column: 1 / -1; }
      .${SCRIPT_ID}__field--actions { display:flex; justify-content:flex-end; gap: 10px; align-items:center; width: 100%; }
      .${SCRIPT_ID}__border-row { display:grid; grid-template-columns: 1fr auto; gap: 8px; }
      .${SCRIPT_ID}__border-top { display:flex; flex-direction:column; gap: 2px; }
      .${SCRIPT_ID}__border-bottom { grid-column: 1 / -1; display:flex; flex-direction:column; gap: 2px; }
      .${SCRIPT_ID}__border-row .${SCRIPT_ID}__right { justify-self: end; }
      .${SCRIPT_ID}__closed { color: #c00; font-weight: 600; }
      .form-control { border: 1px solid #ccc !important; }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }

  /**
   * @param {JunctionFilters} filters
   * @returns {JunctionItem[]}
   */
  function applyJunctionFilters(filters) {
    const fRoadRaw = String(filters.road ?? "").trim();
    const fRoadBase = fRoadRaw ? roadBase(fRoadRaw) : "";
    const fBranch = norm(filters.branch);
    const fName = norm(filters.name);
    const fNumberRaw = String(filters.number ?? "").trim();
    const fNumber = fNumberRaw === "" ? null : Number(fNumberRaw);

    return dataJunctions.filter((j) => {
      if (fRoadBase && roadBase(j.road_number) !== fRoadBase) return false;
      if (fBranch && !norm(j.branch).includes(fBranch)) return false;
      if (fName && !norm(j.name).includes(fName)) return false;
      if (fNumberRaw !== "") {
        if (!Number.isFinite(fNumber)) return false;
        if (Number(j.number) !== fNumber) return false;
      }
      return true;
    });
  }

  /**
   * @param {BorderFilters} filters
   * @returns {BorderItem[]}
   */
  function applyBorderFilters(filters) {
    const fNeighbor = norm(filters.neighbor);
    const fGeo = norm(filters.geographical_border);
    const rawName = String(filters.name ?? "").trim();
    const hasWildcard = rawName === "*";
    const fName = hasWildcard ? "" : norm(rawName);
    const onlyClosed = Boolean(filters.onlyClosed);

    return dataBorders.filter((b) => {
      if (fNeighbor && !norm(b.neighbor).includes(fNeighbor)) return false;
      if (fGeo && !norm(b.geographical_border).includes(fGeo)) return false;
      if (fName && !norm(b.name_border_crossing).includes(fName)) return false;
      if (onlyClosed) {
        const closedCheck = String(b.limitations ?? "") + " " + String(b.other ?? "");
        if (!/przejście\s+zamknięte/i.test(closedCheck)) return false;
      }
      return true;
    });
  }

  /**
   * @param {string} venueId
   * @returns {Venue | null}
   */
  function getVenueById(venueId) {
    return sdk.DataModel.Venues.getById({ venueId });
  }

  /**
   * @returns {SelectionWithLocalizedTypeName | null}
   */
  function getSelectionSafe() {
    return sdk.Editing.getSelection();
  }

  /**
   * @returns {string | null}
   */
  function getSelectedVenueId() {
    const sel = getSelectionSafe();
    if (!sel || !sel.ids || sel.ids.length === 0) return null;
    if (sel.objectType !== "venue") return null;
    return sel.ids[0];
  }

  /**
   * @returns {{ venueId: string, venue: Venue | null, categories: Venue["categories"] | null, isJunction: boolean } | null}
   */
  function getSelectedVenueInfo() {
    const venueId = getSelectedVenueId();
    if (!venueId) return null;
    const venue = getVenueById(venueId);
    if (!venue) return { venueId, venue: null, categories: null, isJunction: false };
    const categories = venue.categories;
    const isJunction = categories.some((c) => String(c).toUpperCase() === "JUNCTION_INTERCHANGE");
    return { venueId, venue, categories, isJunction };
  }

  /**
   * @returns {{ venueId: string, venue: Venue | null, categories: Venue["categories"] | null, isJunction: boolean } | null}
   */
  function canInsertIntoSelectedVenue() {
    const info = getSelectedVenueInfo();
    if (!info || !info.isJunction) return null;
    if (!sdk.Editing.isEditingAllowed()) return null;
    return info;
  }

  /**
   * @param {string} name
   * @param {string | number | null | undefined} number
   * @returns {boolean}
   */
  function insertJunctionName(name, number) {
    const info = canInsertIntoSelectedVenue();
    if (!info) {
      log("insertJunctionName: no venue or not allowed");
      return false;
    }
    const cleanName = String(name ?? "").trim();
    const num = number === null || number === undefined ? "" : String(number).trim();
    const label = num ? `↗${num} ${cleanName}` : `↗ ${cleanName}`;
    const venuesModel = sdk.DataModel.Venues;
    const update = venuesModel.updateVenue;
    if (!info.venue) {
      log("insertJunctionName: venue missing");
      return false;
    }
    const payload = { venueId: info.venueId, name: label, aliases: ["węzeł " + cleanName] };
    const v = info.venue;
    if (v && v.lockRank !== 2) payload.lockRank = 2;
    try {
      const res = update.call(venuesModel, payload);
      log("insertJunctionName: updated", { venueId: info.venueId, name: label, res, updateName: "sdk.DataModel.Venues.updateVenue" });
      return true;
    } catch (e) {
      console.warn("[" + SCRIPT_NAME + "] insertJunctionName: update failed", e);
    }
    return false;
  }

  let lastJunctionState = "";
  let delayedVenueCheckTimer = null;
  let delayedVenueCheckId = "";
  const DELAYED_VENUE_CHECK_MS = 200;
  /**
   * @returns {void}
   */
  function updateJunctionButtons() {
    const info = getSelectedVenueInfo();
    const editingAllowed = sdk.Editing.isEditingAllowed();
    const canInsert = Boolean(info && info.isJunction && editingAllowed);
    const stateKey = JSON.stringify({
      canInsert,
      venueId: info ? info.venueId : null,
      isJunction: info ? info.isJunction : false,
      editingAllowed,
    });
    if (stateKey !== lastJunctionState) {
      lastJunctionState = stateKey;
      log("junction button state", {
        canInsert,
        venueId: info ? info.venueId : null,
        isJunction: info ? info.isJunction : false,
        editingAllowed,
        categories: info ? info.categories : null,
      });
    }
    if (info && info.venueId && !info.venue) {
      if (delayedVenueCheckId !== info.venueId) {
        delayedVenueCheckId = info.venueId;
        if (delayedVenueCheckTimer) clearTimeout(delayedVenueCheckTimer);
        delayedVenueCheckTimer = setTimeout(() => {
          delayedVenueCheckTimer = null;
          updateJunctionButtons();
        }, DELAYED_VENUE_CHECK_MS);
      }
    }
    const text = canInsert ? "↪︎" : "Centruj";
    const mode = canInsert ? "insert" : "center";
    const buttons = document.querySelectorAll("." + SCRIPT_ID + "__junction-action");
    for (const btn of buttons) {
      btn.textContent = text;
      btn.dataset.mode = mode;
    }
  }

  /**
   * @param {{ latitude: number, longitude: number }} j
   */
  function centerOnJunction(j) {
    const lat = Number(j.latitude);
    const lon = Number(j.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
    try {
      sdk.Map.setMapCenter({ lonLat: { lon, lat } });
      sdk.Map.setZoomLevel({ zoomLevel: 17 });
      setTimeout(updateActiveRowsByCenter, 0);
    } catch (e) {
      console.error(`[${SCRIPT_NAME}] setMapCenter failed`, e);
    }
  }

  /**
   * @returns {LonLat | null}
   */
  function getMapCenterSafe() {
    const res = sdk.Map.getMapCenter();
    if (Number.isFinite(res.lat) && Number.isFinite(res.lon)) return res;
    return null;
  }

  /**
   * @returns {void}
   */
  function updateActiveRowsByCenter() {
    const center = getMapCenterSafe();
    const rows = document.querySelectorAll("." + SCRIPT_ID + "__row[data-lat][data-lon]");
    let bestRow = null;
    let bestDist = Number.POSITIVE_INFINITY;
    if (center) {
      for (const row of rows) {
        const lat = Number(row.dataset.lat);
        const lon = Number(row.dataset.lon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        const d = distanceMeters(center.lat, center.lon, lat, lon);
        if (d < bestDist) {
          bestDist = d;
          bestRow = row;
        }
      }
    }
    for (const row of rows) {
      row.classList.toggle(SCRIPT_ID + "__row--active", Boolean(bestRow && bestRow === row && bestDist <= ACTIVE_RADIUS_M));
    }
  }

  /**
   * @param {HTMLElement} listEl
   * @param {JunctionItem[]} results
   * @param {HTMLElement} metaEl
   * @param {"name" | "mileage" | string} sortKey
   * @param {"asc" | "desc" | string} sortDir
   * @returns {void}
   */
  function renderResults(listEl, results, metaEl, sortKey, sortDir) {
    listEl.innerHTML = "";
    metaEl.textContent = results.length === 0 ? "Brak wyników." : `Wyniki: ${results.length}`;

    const dir = sortDir === "desc" ? -1 : 1;

    const cmpText = (x, y) => String(x ?? "").localeCompare(String(y ?? ""), "pl") * dir;
    const cmpNum = (x, y) => {
      const nx = Number(x);
      const ny = Number(y);
      const ax = Number.isFinite(nx);
      const ay = Number.isFinite(ny);
      if (!ax && !ay) return 0;
      if (!ax) return 1 * dir;
      if (!ay) return -1 * dir;
      if (nx === ny) return 0;
      return (nx < ny ? -1 : 1) * dir;
    };

    const defaultChain = (a, b) => {
      let c = cmpRoad(a.road_number, b.road_number);
      if (c) return c;
      c = String(a.branch ?? "").localeCompare(String(b.branch ?? ""), "pl");
      if (c) return c;
      c = String(a.name ?? "").localeCompare(String(b.name ?? ""), "pl");
      if (c) return c;
      return 0;
    };

    const primary = (a, b) => {
      switch (sortKey) {
        case "name":
          return cmpText(a.name, b.name);
        case "mileage":
          return cmpNum(a.mileage, b.mileage);
        default:
          return 0;
      }
    };

    results.sort((a, b) => {
      const p = primary(a, b);
      if (p) return p;
      const d = defaultChain(a, b);
      if (d) return d;
      return cmpNum(a.mileage, b.mileage);
    });

    for (const j of results) {
      const row = document.createElement("div");
      row.className = SCRIPT_ID + "__row";
      const rowLat = Number(j.latitude);
      const rowLon = Number(j.longitude);
      row.dataset.lat = Number.isFinite(rowLat) ? String(rowLat) : "";
      row.dataset.lon = Number.isFinite(rowLon) ? String(rowLon) : "";

      const left = document.createElement("div");
      left.className = SCRIPT_ID + "__left";

      const title = document.createElement("div");
      title.className = SCRIPT_ID + "__title";

      const numPart = (j.number === null || j.number === undefined || j.number === "")
        ? ""
        : ` [${esc(j.number)}]`;

      title.innerHTML = `<b>${esc(j.name || "—")}</b>${numPart}`;

      const sub = document.createElement("div");
      sub.className = SCRIPT_ID + "__sub";
      sub.innerHTML = `${esc(j.road_number || "—")} • ${esc(j.branch || "—")} • ${esc(formatKm(j.mileage))}`;

      left.appendChild(title);
      left.appendChild(sub);

      const right = document.createElement("div");
      right.className = SCRIPT_ID + "__right";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "waze-btn waze-btn-blue waze-btn-smaller " + SCRIPT_ID + "__junction-action";
      btn.textContent = "Centruj";
      btn.dataset.junctionName = String(j.name ?? "");
      btn.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (btn.dataset.mode === "insert") {
          insertJunctionName(j.name, j.number);
          return;
        }
        centerOnJunction(j);
      });

      right.appendChild(btn);
      row.appendChild(left);
      row.appendChild(right);
      listEl.appendChild(row);
    }
    updateJunctionButtons();
    updateActiveRowsByCenter();
  }

  /**
   * @param {HTMLElement} listEl
   * @param {BorderItem[]} results
   * @param {HTMLElement} metaEl
   * @returns {void}
   */
  function renderBorderResults(listEl, results, metaEl) {
    listEl.innerHTML = "";
    metaEl.textContent = results.length === 0 ? "Brak wyników." : ("Wyniki: " + results.length);

    for (const b of results) {
      const row = document.createElement("div");
      row.className = SCRIPT_ID + "__row " + SCRIPT_ID + "__border-row";

      const top = document.createElement("div");
      top.className = SCRIPT_ID + "__border-top";

      const title = document.createElement("div");
      title.className = SCRIPT_ID + "__title";
      title.innerHTML = "<b>" + esc(b.name_border_crossing || "—") + "</b>";

      const sub = document.createElement("div");
      sub.className = SCRIPT_ID + "__sub";
      const kindRaw = String(b.border_kind ?? "");
      const isSchengen = /schengen/i.test(kindRaw);
      const lineParts = [
        esc(b.road_number || "—"),
        esc(b.neighbor || "—"),
        esc(b.geographical_border || "—"),
      ];
      if (isSchengen) lineParts.push("🇪🇺");
      sub.innerHTML = lineParts.join(" • ");

      top.appendChild(title);
      top.appendChild(sub);

      const right = document.createElement("div");
      right.className = SCRIPT_ID + "__right";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "waze-btn waze-btn-blue waze-btn-smaller";
      btn.textContent = "Centruj";
      btn.addEventListener("click", () => centerOnJunction(b));

      const bottom = document.createElement("div");
      bottom.className = SCRIPT_ID + "__border-bottom";

      const sub2 = document.createElement("div");
      sub2.className = SCRIPT_ID + "__sub";
      sub2.innerHTML = "Ruch: " + esc(b.type_of_traffic || "—") + ".";

      const sub3 = document.createElement("div");
      sub3.className = SCRIPT_ID + "__sub";
      sub3.innerHTML = "<i>- " + esc(b.limitations || "—") + "</i>";
      const closedCheck = String(b.limitations ?? "") + " " + String(b.other ?? "");
      if (/przejście\s+zamknięte/i.test(closedCheck)) {
        sub3.classList.add(SCRIPT_ID + "__closed");
      }

      bottom.appendChild(sub2);
      bottom.appendChild(sub3);

      right.appendChild(btn);
      row.appendChild(top);
      row.appendChild(right);
      row.appendChild(bottom);
      listEl.appendChild(row);
    }
  }

  /**
   * @param {HTMLSelectElement} selectEl
   * @param {SelectOption[]} options
   * @param {boolean} [keepValue=true]
   */
  function setSelectOptions(selectEl, options, keepValue = true) {
    const prev = keepValue ? String(selectEl.value ?? "") : "";
    selectEl.innerHTML = "";
    for (const opt of options) {
      const o = document.createElement("option");
      o.value = opt.value;
      o.textContent = opt.label;
      selectEl.appendChild(o);
    }
    if (keepValue) {
      const exists = Array.from(selectEl.options).some((o) => o.value === prev);
      if (exists) selectEl.value = prev;
    }
  }

  /**
   * @param {string} v
   * @returns {{ raw: string, prefix: string, num: number, suffix: string }}
   */
  function parseRoadId(v) {
    const s = String(v ?? "")
      .trim()
      .toUpperCase()
      .replace(/[^0-9A-Z]/g, "");
    const m = s.match(/^([A-Za-z]+)?(\d+)([A-Za-z]+)?$/);
    if (!m) {
      return { raw: s, prefix: s.toUpperCase(), num: Number.POSITIVE_INFINITY, suffix: "" };
    }
    return {
      raw: s,
      prefix: String(m[1] ?? "").toUpperCase(),
      num: Number(m[2]),
      suffix: String(m[3] ?? "").toUpperCase(),
    };
  }

  /**
   * @param {string} v
   * @returns {string}
   */
  function roadBase(v) {
    const s = String(v ?? "").toUpperCase();
    let m = s.match(/([AS])\s*0*([0-9]{1,2})(?![0-9])/);
    if (m) return m[1] + String(Number(m[2]));
    m = s.match(/(?:^|[^0-9])([0-9]{2})(?![0-9])/);
    if (m) return m[1];
    return "";
  }

  /**
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  function cmpRoad(a, b) {
    const pa = parseRoadId(a);
    const pb = parseRoadId(b);
    let c = pa.prefix.localeCompare(pb.prefix, "pl");
    if (c) return c;
    c = (pa.num - pb.num);
    if (c) return c;
    return pa.suffix.localeCompare(pb.suffix, "pl");
  }

  /**
   * @param {JunctionItem[]} items
   * @returns {SelectOptionGroup[]}
   */
  function buildRoadBaseGroupedOptions(items) {
    const groups = {
      DK: [],
      A: [],
      S: [],
      Inne: [],
    };
    const seen = new Set();

    for (const it of items) {
      const v = String(it.road_number ?? "").trim();
      if (!v) continue;
      const base = roadBase(v);
      if (!base || seen.has(base)) continue;
      seen.add(base);
      if (base.startsWith("A")) {
        groups.A.push(base);
      } else if (base.startsWith("S")) {
        groups.S.push(base);
      } else if (/^[0-9]{2}$/.test(base)) {
        groups.DK.push(base);
      } else {
        groups.Inne.push(base);
      }
    }

    const sort = (a, b) => a.localeCompare(b, "pl", { numeric: true });
    const make = (label, arr) => {
      arr.sort(sort);
      return arr.length ? { label, options: arr.map((x) => ({ value: x, label: x })) } : null;
    };

    return [
      make("DK", groups.DK),
      make("A", groups.A),
      make("S", groups.S),
      make("Inne", groups.Inne),
    ].filter(Boolean);
  }

  /**
   * @param {HTMLSelectElement} selectEl
   * @param {SelectOptionGroup[]} groups
   * @param {boolean} [keepValue=true]
   * @param {string} [emptyLabel="—"]
   */
  function setSelectOptionsGrouped(selectEl, groups, keepValue = true, emptyLabel = "—") {
    const prev = keepValue ? String(selectEl.value ?? "") : "";
    selectEl.innerHTML = "";

    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = emptyLabel;
    selectEl.appendChild(empty);

    for (const g of groups) {
      const og = document.createElement("optgroup");
      og.label = g.label;
      for (const opt of g.options) {
        const o = document.createElement("option");
        o.value = opt.value;
        o.textContent = opt.label;
        og.appendChild(o);
      }
      selectEl.appendChild(og);
    }

    if (keepValue) {
      const exists = Array.from(selectEl.querySelectorAll("option")).some((o) => o.value === prev);
      if (exists) selectEl.value = prev;
    }
  }

  /**
   * @template T
   * @param {T[]} items
   * @param {(item: T) => unknown} getValue
   * @param {string} [emptyLabel="—"]
   * @param {((a: string, b: string) => number) | null} [comparator=null]
   * @returns {SelectOption[]}
   */
  function buildUniqueOptions(items, getValue, emptyLabel = "—", comparator = null) {
    const set = new Set();
    for (const it of items) {
      const v = getValue(it);
      if (v === null || v === undefined) continue;
      const s = String(v).trim();
      if (!s) continue;
      set.add(s);
    }
    const arr = Array.from(set);
    if (typeof comparator === "function") {
      arr.sort(comparator);
    } else {
      arr.sort((a, b) => a.localeCompare(b, "pl"));
    }
    return [{ value: "", label: emptyLabel }, ...arr.map((x) => ({ value: x, label: x }))];
  }

  /**
   * @param {JunctionItem[]} items
   * @returns {SelectOption[]}
   */
  function buildNumberOptions(items) {
    const set = new Set();
    for (const it of items) {
      const n = it.number;
      if (n === null || n === undefined || n === "") continue;
      const nn = Number(n);
      if (!Number.isFinite(nn)) continue;
      set.add(nn);
    }
    const arr = Array.from(set);
    arr.sort((a, b) => a - b);
    return [{ value: "", label: "—" }, ...arr.map((x) => ({ value: String(x), label: String(x) }))];
  }

  /**
   * @param {any[]} arr
   * @returns {JunctionItem[]}
   */
  function mapJunctions(arr) {
    return arr
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        id: x.id ?? null,
        branch: x.branch ?? "",
        name: x.name ?? "",
        road_number: x.road_number ?? "",
        mileage: x.mileage,
        number: x.number,
        latitude: x.latitude,
        longitude: x.longitude,
      }));
  }

  /**
   * @param {any[]} arr
   * @returns {BorderItem[]}
   */
  function mapBorders(arr) {
    return arr
      .filter((x) => x && typeof x === "object")
      .map((x) => ({
        id: x.id ?? null,
        geographical_border: x.geographical_border ?? "",
        neighbor: x.neighbor ?? "",
        type_of_traffic: x.type_of_traffic ?? "",
        name_border_crossing: x.name_border_crossing ?? "",
        road_number: x.road_number ?? "",
        latitude: x.latitude,
        longitude: x.longitude,
        limitations: x.limitations ?? "",
        border_kind: x.border_kind ?? "",
        other: x.other ?? "",
      }));
  }

  /**
   * @returns {Promise<void>}
   */
  async function buildTab() {
    injectStyles();

    const { tabLabel, tabPane } = await sdk.Sidebar.registerScriptTab();
    tabLabel.textContent = "GDDKiA";
    tabLabel.title = SCRIPT_NAME;

    const html =
      '<div class="__SID____wrap">' +
        '<div class="__SID____h">__SNAME__</div>' +
        '<div class="__SID____tabs">' +
          '<button type="button" class="waze-btn __SID____tab-btn is-active" data-tab="junctions">Węzły</button>' +
          '<button type="button" class="waze-btn __SID____tab-btn" data-tab="borders">Granice</button>' +
        '</div><hr style="margin-top: 0">' +
        '<div class="__SID____panel" data-panel="junctions">' +
          '<div class="__SID____grid2">' +
            '<div class="__SID____field">' +
              '<label>Numer drogi' +
              '<select class="form-control" id="__SID____road"></select></label>' +
            '</div>' +
            '<div class="__SID____field">' +
              '<label>Numer węzła' +
              '<select class="form-control" id="__SID____number"></select></label>' +
            '</div>' +
            '<div class="__SID____field">' +
              '<label>Miasto / oddział' +
              '<select class="form-control" id="__SID____branch"></select></label>' +
            '</div>' +
            '<div class="__SID____field">' +
              '<label>Nazwa węzła' +
              '<input class="form-control" type="text" id="__SID____name" placeholder="np. Rusocin"></label>' +
            '</div>' +
            '<div class="__SID____field __SID____field--full">' +
              '<label>Sortowanie' +
              '<div style="display:flex; gap:8px;">' +
                '<select class="form-control" id="__SID____sortKey" style="flex: 1;"></select>' +
                '<select class="form-control" id="__SID____sortDir" style="width: 140px;"></select>' +
              '</div></label>' +
            '</div>' +
            '<div class="__SID____field __SID____field--full">' +
              '<button type="button" class="waze-btn waze-btn-blue" id="__SID____reload">Odśwież dane</button>' +
            '</div>' +
          '</div>' +
          '<div class="__SID____bar">' +
            '<div class="__SID____small" id="__SID____fetched"></div>' +
          '</div>' +
          '<div class="__SID____meta" id="__SID____meta">—</div>' +
          '<div class="__SID____list" id="__SID____list"></div>' +
          '<div class="__SID____note">Tip: kliknij „Centruj”, żeby przenieść mapę na współrzędne węzła.</div>' +
        '</div>' +
        '<div class="__SID____panel __SID____panel--hidden" data-panel="borders">' +
          '<div class="__SID____grid2">' +
            '<div class="__SID____field">' +
              '<label>Sąsiad' +
              '<select class="form-control" id="__SID____borderNeighbor"></select></label>' +
            '</div>' +
            '<div class="__SID____field">' +
              '<label>Granica' +
              '<select class="form-control" id="__SID____borderGeo"></select></label>' +
            '</div>' +
            '<div class="__SID____field __SID____field--full">' +
              '<label>Nazwa przejścia' +
              '<input class="form-control" type="text" id="__SID____borderName" placeholder="np. Jędrzychowice"></label>' +
            '</div>' +
            '<div class="__SID____field __SID____field--full __SID____field--actions">' +
              '<button type="button" class="waze-btn waze-btn-blue" id="__SID____borderReload">Odśwież dane</button><hr>' +
              '<label class="__SID____inline">' +
                '<input type="checkbox" id="__SID____borderClosed">' +
                'Tylko zamknięte' +
              '</label>' +
            '</div>' +
          '</div>' +
          '<div class="__SID____bar">' +
            '<div class="__SID____small" id="__SID____borderFetched"></div>' +
          '</div>' +
          '<div class="__SID____meta" id="__SID____borderMeta">—</div>' +
          '<div class="__SID____list" id="__SID____borderList"></div>' +
          '<div class="__SID____note">Tip: kliknij „Centruj”, żeby przenieść mapę na współrzędne przejścia.</div>' +
        '</div>' +
      '</div>';

    tabPane.innerHTML = html
      .replaceAll("__SID__", SCRIPT_ID)
      .replaceAll("__SNAME__", esc(SCRIPT_NAME));

    const elTabButtons = Array.from(tabPane.querySelectorAll("." + SCRIPT_ID + "__tab-btn"));
    const panelJunctions = tabPane.querySelector('[data-panel="junctions"]');
    const panelBorders = tabPane.querySelector('[data-panel="borders"]');
    const hiddenClass = SCRIPT_ID + "__panel--hidden";

    const elRoad = tabPane.querySelector("#" + SCRIPT_ID + "__road");
    const elBranch = tabPane.querySelector("#" + SCRIPT_ID + "__branch");
    const elNumber = tabPane.querySelector("#" + SCRIPT_ID + "__number");
    const elName = tabPane.querySelector("#" + SCRIPT_ID + "__name");
    const elReload = tabPane.querySelector("#" + SCRIPT_ID + "__reload");
    const elFetched = tabPane.querySelector("#" + SCRIPT_ID + "__fetched");
    const elMeta = tabPane.querySelector("#" + SCRIPT_ID + "__meta");
    const elList = tabPane.querySelector("#" + SCRIPT_ID + "__list");
    const elSortKey = tabPane.querySelector("#" + SCRIPT_ID + "__sortKey");
    const elSortDir = tabPane.querySelector("#" + SCRIPT_ID + "__sortDir");

    const elBorderNeighbor = tabPane.querySelector("#" + SCRIPT_ID + "__borderNeighbor");
    const elBorderGeo = tabPane.querySelector("#" + SCRIPT_ID + "__borderGeo");
    const elBorderName = tabPane.querySelector("#" + SCRIPT_ID + "__borderName");
    const elBorderReload = tabPane.querySelector("#" + SCRIPT_ID + "__borderReload");
    const elBorderClosed = tabPane.querySelector("#" + SCRIPT_ID + "__borderClosed");
    const elBorderFetched = tabPane.querySelector("#" + SCRIPT_ID + "__borderFetched");
    const elBorderMeta = tabPane.querySelector("#" + SCRIPT_ID + "__borderMeta");
    const elBorderList = tabPane.querySelector("#" + SCRIPT_ID + "__borderList");

    /** @type {DataKind} */
    let currentTab = "junctions";

    /** @type {Record<DataKind, string | null>} */
    const requestState = { junctions: null, borders: null };
    /** @type {Record<DataKind, number>} */
    const requestRetries = { junctions: 0, borders: 0 };

    /**
     * @param {DataKind} kind
     * @returns {CachePayload | null}
     */
    const getCached = (kind) => {
      const cached = loadCache(CACHE_KEYS[kind]);
      if (cached && Date.now() - cached.ts <= CACHE_TTL_MS) return cached;
      return null;
    };

    /**
     * @param {DataKind} kind
     * @param {any} json
     * @param {number} fetchedAt
     * @param {HTMLElement | null} fetchedEl
     */
    const handleData = (kind, json, fetchedAt, fetchedEl) => {
      const arr = Array.isArray(json && json.response) ? json.response : [];
      if (kind === "borders") {
        dataBorders = mapBorders(arr);
        setSelectOptions(elBorderNeighbor, buildUniqueOptions(dataBorders, (x) => x.neighbor), true);
        setSelectOptions(elBorderGeo, buildUniqueOptions(dataBorders, (x) => x.geographical_border), true);
        rerenderBorders();
      } else {
        dataJunctions = mapJunctions(arr);
        setSelectOptionsGrouped(elRoad, buildRoadBaseGroupedOptions(dataJunctions), true);
        setSelectOptions(elBranch, buildUniqueOptions(dataJunctions, (x) => x.branch), true);
        setSelectOptions(elNumber, buildNumberOptions(dataJunctions), true);
        rerenderJunctions();
      }
      const fetchedAtDate = new Date(fetchedAt || Date.now());
      if (fetchedEl) fetchedEl.textContent = "Ostatnie pobranie: " + fetchedAtDate.toLocaleString("pl-PL");
    };

    /**
     * @param {DataKind} kind
     * @param {HTMLElement | null} fetchedEl
     * @param {boolean} [force=false]
     */
    const ensureData = (kind, fetchedEl, force = false) => {
      const hasData = kind === "borders" ? dataBorders.length > 0 : dataJunctions.length > 0;
      if (!force && (hasData || requestState[kind])) return;
      requestData(kind, fetchedEl, force);
    };

    /**
     * @param {DataKind} kind
     * @param {HTMLElement | null} fetchedEl
     * @param {boolean} [force=false]
     * @returns {Promise<void>}
     */
    const requestData = async (kind, fetchedEl, force = false) => {
      const existing = requestState[kind];
      if (existing && !force) return;
      const requestId = String(Date.now()) + ":" + Math.random().toString(16).slice(2);
      requestState[kind] = requestId;
      if (force) requestRetries[kind] = 0;

      try {
        if (!force) {
          const cached = getCached(kind);
          if (cached) {
            if (requestState[kind] !== requestId) return;
            handleData(kind, cached.json, cached.ts, fetchedEl);
            requestState[kind] = null;
            return;
          }
        }
        const json = await gmFetchJson(ENDPOINTS[kind]);
        if (requestState[kind] !== requestId) return;
        const saved = saveCache(CACHE_KEYS[kind], json);
        const ts = saved && saved.ts ? saved.ts : Date.now();
        handleData(kind, json, ts, fetchedEl);
        requestRetries[kind] = 0;
        requestState[kind] = null;
      } catch (e) {
        if (requestState[kind] === requestId) requestState[kind] = null;
        if (kind === "borders") {
          dataBorders = [];
        } else {
          dataJunctions = [];
        }
        if (requestRetries[kind] < REQUEST_MAX_RETRIES) {
          requestRetries[kind] += 1;
          setTimeout(() => requestData(kind, fetchedEl, true), REQUEST_RETRY_DELAY_MS);
        }
        console.warn("[" + SCRIPT_NAME + "] requestData failed", e);
      }
    };

    /**
     * @param {DataKind} kind
     * @param {{ fetch?: boolean }} [opts]
     */
    const setActiveTab = (kind, opts = {}) => {
      const shouldFetch = opts.fetch !== false;

      for (const btn of elTabButtons) {
        const active = btn.dataset.tab === kind;
        btn.classList.toggle("is-active", active);
      }

      panelJunctions.classList.toggle(hiddenClass, kind !== "junctions");
      panelBorders.classList.toggle(hiddenClass, kind !== "borders");
      currentTab = kind;

      if (!shouldFetch) return;

      if (kind === "borders") {
        ensureData("borders", elBorderFetched, false);
      } else {
        ensureData("junctions", elFetched, false);
      }
    };

    for (const btn of elTabButtons) {
      btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
    }

    tabLabel.addEventListener("click", () => {
      if (currentTab === "borders") {
        ensureData("borders", elBorderFetched, false);
      } else {
        ensureData("junctions", elFetched, false);
      }
    });

    setSelectOptions(elSortKey, [
      { value: "name", label: "Nazwa węzła" },
      { value: "mileage", label: "Kilometraż (mileage)" },
    ], false);
    elSortKey.value = "name";

    setSelectOptions(elSortDir, [
      { value: "asc", label: "Rosnąco" },
      { value: "desc", label: "Malejąco" },
    ], false);
    elSortDir.value = "asc";

    setSelectOptions(elRoad, [{ value: "", label: "—" }], false);
    setSelectOptions(elBranch, [{ value: "", label: "—" }], false);
    setSelectOptions(elNumber, [{ value: "", label: "—" }], false);
    setSelectOptions(elBorderNeighbor, [{ value: "", label: "—" }], false);
    setSelectOptions(elBorderGeo, [{ value: "", label: "—" }], false);

    const rerenderJunctions = () => {
      const numberSource = applyJunctionFilters({
        road: elRoad.value,
        branch: elBranch.value,
        name: elName.value,
        number: "",
      });
      setSelectOptions(elNumber, buildNumberOptions(numberSource), true);

      const hasAnyFilter = Boolean(
        (elRoad.value && String(elRoad.value).trim()) ||
        (elBranch.value && String(elBranch.value).trim()) ||
        (elNumber.value && String(elNumber.value).trim()) ||
        (elName.value && String(elName.value).trim())
      );

      if (!hasAnyFilter) {
        const center = getMapCenterSafe();
        if (!center) {
          elList.innerHTML = "";
          elMeta.textContent = "Brak centrum mapy. Przesuń mapę, aby wyświetlić węzły w promieniu 10 km.";
          return;
        }
        const results = dataJunctions.filter((j) => {
          const lat = Number(j.latitude);
          const lon = Number(j.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
          return distanceMeters(center.lat, center.lon, lat, lon) <= LIST_RADIUS_M;
        });
        renderResults(elList, results, elMeta, elSortKey.value, elSortDir.value);
        return;
      }

      const results = applyJunctionFilters({
        road: elRoad.value,
        branch: elBranch.value,
        name: elName.value,
        number: elNumber.value,
      });
      renderResults(elList, results, elMeta, elSortKey.value, elSortDir.value);
    };

    const rerenderBorders = () => {
      const hasAnyFilter = Boolean(
        (elBorderNeighbor.value && String(elBorderNeighbor.value).trim()) ||
        (elBorderGeo.value && String(elBorderGeo.value).trim()) ||
        (elBorderName.value && String(elBorderName.value).trim()) ||
        elBorderClosed.checked
      );

      if (!hasAnyFilter) {
        elBorderList.innerHTML = "";
        elBorderMeta.textContent = "Wybierz co najmniej jeden filtr, aby wyświetlić listę.";
        return;
      }

      const results = applyBorderFilters({
        neighbor: elBorderNeighbor.value,
        geographical_border: elBorderGeo.value,
        name: elBorderName.value,
        onlyClosed: elBorderClosed.checked,
      });
      renderBorderResults(elBorderList, results, elBorderMeta);
    };

    const rerenderJunctionsDebounced = debounce(rerenderJunctions, 150);
    const rerenderBordersDebounced = debounce(rerenderBorders, 150);

    elRoad.addEventListener("change", rerenderJunctionsDebounced);
    elBranch.addEventListener("change", rerenderJunctionsDebounced);
    elNumber.addEventListener("change", rerenderJunctionsDebounced);
    elName.addEventListener("input", rerenderJunctionsDebounced);
    elSortKey.addEventListener("change", rerenderJunctionsDebounced);
    elSortDir.addEventListener("change", rerenderJunctionsDebounced);

    elBorderNeighbor.addEventListener("change", () => {
      if (elBorderNeighbor.value && String(elBorderNeighbor.value).trim()) {
        elBorderGeo.value = "";
      }
      rerenderBordersDebounced();
    });
    elBorderGeo.addEventListener("change", () => {
      if (elBorderGeo.value && String(elBorderGeo.value).trim()) {
        elBorderNeighbor.value = "";
      }
      rerenderBordersDebounced();
    });
    elBorderName.addEventListener("input", () => {
      if (String(elBorderName.value ?? "").trim() === "*") {
        elBorderNeighbor.value = "";
        elBorderGeo.value = "";
        elBorderClosed.checked = false;
      }
      rerenderBordersDebounced();
    });
    elBorderClosed.addEventListener("change", rerenderBordersDebounced);

    elReload.addEventListener("click", () => {
      requestData("junctions", elFetched, true);
      setTimeout(rerenderJunctions, 0);
    });

    elBorderReload.addEventListener("click", () => {
      requestData("borders", elBorderFetched, true);
      setTimeout(rerenderBorders, 0);
    });

    if (sdk && sdk.Events && typeof sdk.Events.on === "function") {
      const onSelectionChanged = () => {
        updateJunctionButtons();
      };
      const onMapMoveEnd = () => {
        updateActiveRowsByCenter();
        if (currentTab === "junctions") {
          rerenderJunctionsDebounced();
        }
      };
      try {
        sdk.Events.on({ eventName: "wme-selection-changed", eventHandler: onSelectionChanged });
        sdk.Events.on({ eventName: "wme-map-move-end", eventHandler: onMapMoveEnd });
      } catch (e) {
        console.warn("[" + SCRIPT_NAME + "] selection listener error", e);
      }
    }

    elMeta.textContent = "Wybierz co najmniej jeden filtr, aby wyświetlić listę.";
    elBorderMeta.textContent = "Wybierz co najmniej jeden filtr, aby wyświetlić listę.";

    setActiveTab("junctions");
  }

  function initSdk() {
    /** @type {Window & { SDK_INITIALIZED?: Promise<void>, getWmeSdk?: (args: { scriptId: string, scriptName: string }) => WmeSDK }} */
    const UW = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    let started = false;

    const start = () => {
      if (started) return true;
      if (!UW.SDK_INITIALIZED || typeof UW.SDK_INITIALIZED.then !== "function") return false;
      started = true;
      UW.SDK_INITIALIZED.then(() => {
        if (!UW.getWmeSdk) {
          console.error(`[${SCRIPT_NAME}] unsafeWindow.getWmeSdk not available.`);
          return;
        }
        sdk = UW.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
        sdk.Events.once({ eventName: "wme-ready" }).then(() => {
          buildTab().catch((e) => console.error(`[${SCRIPT_NAME}] buildTab error:`, e));
        });
      });
      return true;
    };

    const waitForSdk = () => {
      let tries = 0;
      const tick = () => {
        if (start()) return;
        if (tries++ < 40) {
          setTimeout(tick, 250);
        } else {
          console.error(`[${SCRIPT_NAME}] SDK_INITIALIZED not available.`);
        }
      };
      tick();
    };

    if (!start()) {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", waitForSdk);
      } else {
        waitForSdk();
      }
    }
  }

  initSdk();
})();
