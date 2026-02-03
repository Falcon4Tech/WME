// ==UserScript==
// @name                                     WME Node Finder
// @version                                       2602.3
// @tag                                            WME
// @description       [Only for Poland] Tab in Scripts with a search engine for GDDKiA road nodes and border crossings.
// @description:pl    Zakładka w Scripts (WME SDK) z wyszukiwarką węzłów drogowych GDDKiA i przejść granicznych.
// @author            Falcon4Tech
// @grant             GM_xmlhttpRequest
// @connect           kpd.gddkia.gov.pl
// @namespace         https://wazepolska.pl
// @match             https://*.waze.com/editor*
// @match             https://*.waze.com/*/editor*
// @icon              https://drogi.gddkia.gov.pl/templates/webster/favicon.ico
// @supportURL        https://github.com/Falcon4Tech/WME/issues
// @updateURL         https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_Node_Finder/wme_node_finder.meta.js
// @downloadURL       https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_Node_Finder/wme_node_finder.user.js
// ==/UserScript==

(function () {
  "use strict";

  const SCRIPT_ID = "pl-gddkia-junction-search";
  const SCRIPT_NAME = "PL: Węzły GDDKiA";

  const ENDPOINTS = {
    junctions: "https://kpd.gddkia.gov.pl/amp/api/waypoints/junctions.json",
    borders: "https://kpd.gddkia.gov.pl/amp/api/waypoints/borders.json",
  };

  // Lokalny cache po stronie przeglądarki (niezależny od nagłówków Cache-Control serwera)
  const CACHE_KEYS = {
    junctions: `${SCRIPT_ID}::junctions_cache_v1`,
    borders: `${SCRIPT_ID}::borders_cache_v1`,
  };
  const CACHE_TTL_MS = 60 * 60 * 60 * 1000; // 60h

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

  function saveCache(key, json) {
    try {
      const payload = { ts: Date.now(), json };
      localStorage.setItem(key, JSON.stringify(payload));
      return payload;
    } catch (_) {
      return null;
    }
  }

  // Kanał komunikacji userscript <-> page script

  const MSG_SOURCE = "WME_PL_GDDKIA_JUNCTIONS";

  // Debug logs (set to false to silence)
  const DEBUG = false;
  const log = (...args) => {
    if (DEBUG) console.log(`[${SCRIPT_NAME}]`, ...args);
  };

  // ---------------------------
  // GM fetch (userscript context)
  // ---------------------------
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

  // ---------------------------
  // Message bridge (userscript context)
  // ---------------------------
  function installBridge() {
    window.addEventListener("message", async (event) => {
      // Uwaga: w userscript sandbox `event.source` bywa innym Window proxy.
      // Filtrujemy po `msg.source` zamiast po `event.source`.
      const msg = event.data;
      if (!msg || msg.source !== MSG_SOURCE) return;
      log("bridge: inbound", msg.type, { requestId: msg.requestId });

      if (msg.type === "REQUEST_DATA") {
        const requestId = msg.requestId || "";
        const force = Boolean(msg.force);
        const kind = msg.kind === "borders" ? "borders" : "junctions";
        const endpoint = ENDPOINTS[kind];
        const cacheKey = CACHE_KEYS[kind];

        if (!endpoint || !cacheKey) {
          window.postMessage(
            {
              source: MSG_SOURCE,
              type: "DATA",
              requestId,
              kind,
              ok: false,
              error: "Unknown data kind",
            },
            "*"
          );
          return;
        }

        if (!force) {
          const cached = loadCache(cacheKey);
          if (cached && Date.now() - cached.ts <= CACHE_TTL_MS) {
            const count = Array.isArray(cached.json?.response) ? cached.json.response.length : null;
            log("bridge: using cache", { requestId, count, ageMs: Date.now() - cached.ts });
            window.postMessage(
              {
                source: MSG_SOURCE,
                type: "DATA",
                requestId,
                kind,
                ok: true,
                json: cached.json,
                fetchedAt: cached.ts,
                fromCache: true,
              },
              "*"
            );
            return;
          }
        }
        log("bridge: REQUEST_DATA", { requestId, endpoint, kind });
        try {
          const json = await gmFetchJson(endpoint);
          const saved = saveCache(cacheKey, json);
          const count = Array.isArray(json?.response) ? json.response.length : null;
          log("bridge: sending DATA ok", { requestId, count, cached: Boolean(saved) });
          window.postMessage(
            {
              source: MSG_SOURCE,
              type: "DATA",
              requestId,
              kind,
              ok: true,
              json,
              fetchedAt: (saved && saved.ts) ? saved.ts : Date.now(),
              fromCache: false,
            },
            "*"
          );
        } catch (e) {
          log("bridge: sending DATA error", { requestId, error: String(e && e.message ? e.message : e) });
          window.postMessage(
            {
              source: MSG_SOURCE,
              type: "DATA",
              requestId,
              kind,
              ok: false,
              error: String(e && e.message ? e.message : e),
            },
            "*"
          );
        }
      }
    });
  }

  // ---------------------------
  // Page script injection (page context)
  // ---------------------------
  function injectPageScript() {
    // unikamy wielokrotnego wstrzykiwania
    if (document.getElementById(`${SCRIPT_ID}__injected`)) return;

    const code = `(function(){
      "use strict";

      const SCRIPT_ID = ${JSON.stringify(SCRIPT_ID)};
      const SCRIPT_NAME = ${JSON.stringify(SCRIPT_NAME)};
      const MSG_SOURCE = ${JSON.stringify(MSG_SOURCE)};

      /** @type {any} */
      let sdk = null;

      /** @type {Array<any>} */
      let dataJunctions = [];
      /** @type {Array<any>} */
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
        .replace(/[\\u0300-\\u036f]/g, "");

      const formatKm = (mileage) => {
        const n = Number(mileage);
        if (!Number.isFinite(n)) return "—";
        return n.toFixed(3) + " km";
      };

      const debounce = (fn, ms = 200) => {
        let t = null;
        return (...args) => {
          clearTimeout(t);
          t = setTimeout(() => fn(...args), ms);
        };
      };

      function injectStyles() {
        const css = \`
          .\${SCRIPT_ID}__wrap { padding: 10px; }
          .\${SCRIPT_ID}__h { margin: 0 0 8px; font-size: 16px; font-weight: 600; }
          .\${SCRIPT_ID}__grid { display: grid; grid-template-columns: 1fr; gap: 8px; }
          .\${SCRIPT_ID}__grid3 { display: grid; grid-template-columns: 1fr; gap: 8px; }
          .\${SCRIPT_ID}__field label { display:block; font-size: 12px; opacity: .85; margin-bottom: 2px; }
          .\${SCRIPT_ID}__field input { width: 100%; }
          .\${SCRIPT_ID}__bar { display:flex; gap: 8px; align-items:center; margin: 8px 0; }
          .\${SCRIPT_ID}__meta { margin: 6px 0; font-size: 12px; opacity: .85; }
          .\${SCRIPT_ID}__list { display:flex; flex-direction:column; gap: 6px; }
          .\${SCRIPT_ID}__row { display:flex; justify-content:space-between; gap: 8px; padding: 8px; border-radius: 8px; background: rgba(0,0,0,.04); }
          .\${SCRIPT_ID}__title { line-height: 1.2; }
          .\${SCRIPT_ID}__sub { font-size: 12px; opacity: .85; }
          .\${SCRIPT_ID}__right { display:flex; align-items:center; }
          .\${SCRIPT_ID}__note { font-size: 12px; opacity: .75; margin-top: 8px; line-height: 1.25; }
          .\${SCRIPT_ID}__small { font-size: 12px; opacity: .8; }
          .\${SCRIPT_ID}__tabs { display:flex; gap: 8px; margin: 0 0 8px; }
          .\${SCRIPT_ID}__tab-btn { flex: 1; }
          .\${SCRIPT_ID}__tab-btn.is-active { background: #4a8cca; border-color: #4a8cca; color: #fff; }
          .\${SCRIPT_ID}__panel--hidden { display: none; }
          .\${SCRIPT_ID}__grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
          .\${SCRIPT_ID}__grid2 .\${SCRIPT_ID}__field { min-width: 0; }
          .\${SCRIPT_ID}__grid2 .\${SCRIPT_ID}__field--full { grid-column: 1 / -1; }
          .\${SCRIPT_ID}__border-row { display:grid; grid-template-columns: 1fr auto; gap: 8px; }
          .\${SCRIPT_ID}__border-top { display:flex; flex-direction:column; gap: 2px; }
          .\${SCRIPT_ID}__border-bottom { grid-column: 1 / -1; display:flex; flex-direction:column; gap: 2px; }
          .\${SCRIPT_ID}__border-row .\${SCRIPT_ID}__right { justify-self: end; }
          .\${SCRIPT_ID}__closed { color: #c00; font-weight: 600; }
          .form-control { border: 1px solid #ccc !important; }
        \`;
        const style = document.createElement("style");
        style.textContent = css;
        document.head.appendChild(style);
      }

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

      function applyBorderFilters(filters) {
        const fNeighbor = norm(filters.neighbor);
        const fGeo = norm(filters.geographical_border);
        const fName = norm(filters.name);

        return dataBorders.filter((b) => {
          if (fNeighbor && !norm(b.neighbor).includes(fNeighbor)) return false;
          if (fGeo && !norm(b.geographical_border).includes(fGeo)) return false;
          if (fName && !norm(b.name_border_crossing).includes(fName)) return false;
          return true;
        });
      }

      function centerOnJunction(j) {
        const lat = Number(j.latitude);
        const lon = Number(j.longitude);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
        try {
          sdk.Map.setMapCenter({ lonLat: { lon, lat } });
          sdk.Map.setZoomLevel({ zoomLevel: 17 });
        } catch (e) {
          console.error(\`[\${SCRIPT_NAME}] setMapCenter failed\`, e);
        }
      }

      function renderResults(listEl, results, metaEl, sortKey, sortDir) {
        listEl.innerHTML = "";
        metaEl.textContent = results.length === 0 ? "Brak wyników." : \`Wyniki: \${results.length}\`;

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
          // ostatecznie, gdy sortujemy np. mileage, zostaw stabilny tie-breaker
          return cmpNum(a.mileage, b.mileage);
        });

        for (const j of results) {
          const row = document.createElement("div");
          row.className = SCRIPT_ID + "__row";

          const left = document.createElement("div");
          left.className = SCRIPT_ID + "__left";

          const title = document.createElement("div");
          title.className = SCRIPT_ID + "__title";

          const numPart = (j.number === null || j.number === undefined || j.number === "")
            ? ""
            : \` [\${esc(j.number)}]\`;

          title.innerHTML = \`<b>\${esc(j.name || "—")}</b>\${numPart}\`;

          const sub = document.createElement("div");
          sub.className = SCRIPT_ID + "__sub";
          sub.innerHTML = \`\${esc(j.road_number || "—")} • \${esc(j.branch || "—")} • \${esc(formatKm(j.mileage))}\`;

          left.appendChild(title);
          left.appendChild(sub);

          const right = document.createElement("div");
          right.className = SCRIPT_ID + "__right";

          const btn = document.createElement("button");
          btn.type = "button";
          btn.className = "waze-btn waze-btn-blue waze-btn-smaller";
          btn.textContent = "Centruj";
          btn.addEventListener("click", () => centerOnJunction(j));

          right.appendChild(btn);
          row.appendChild(left);
          row.appendChild(right);
          listEl.appendChild(row);
        }
      }

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
          if (/przejście\\s+zamknięte/i.test(closedCheck)) {
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

      function requestData(kind, fetchedEl, force = false) {
        const requestId = String(Date.now()) + ":" + Math.random().toString(16).slice(2);

        const onMsg = (event) => {
          if (event.source !== window) return;
          const msg = event.data;
          console.log("[" + SCRIPT_NAME + "] requestData: got message", msg && msg.type, { requestId, msgRequestId: msg && msg.requestId, ok: msg && msg.ok, kind });
          if (!msg || msg.source !== MSG_SOURCE) return;
          if (msg.type !== "DATA") return;
          if (msg.requestId !== requestId) return;
          if (msg.kind !== kind) return;

          window.removeEventListener("message", onMsg);
          clearTimeout(timeout);
          console.log("[" + SCRIPT_NAME + "] requestData: matched DATA", { requestId, ok: msg.ok, kind });

          if (!msg.ok) {
            if (kind === "borders") {
              dataBorders = [];
            } else {
              dataJunctions = [];
            }
            return;
          }

          const fetchedAt = new Date(msg.fetchedAt || Date.now());
          if (fetchedEl) fetchedEl.textContent = "Ostatnie pobranie: " + fetchedAt.toLocaleString("pl-PL");
        };

        window.addEventListener("message", onMsg);
        console.log("[" + SCRIPT_NAME + "] requestData: listener installed", { requestId, kind });
        const timeoutMs = 15000;
        const timeout = setTimeout(() => {
          console.warn("[" + SCRIPT_NAME + "] requestData: timeout waiting for DATA", { requestId, timeoutMs, kind });
          if (kind === "borders") {
            dataBorders = [];
          } else {
            dataJunctions = [];
          }
          window.removeEventListener("message", onMsg);
        }, timeoutMs);
        console.log("[" + SCRIPT_NAME + "] requestData: postMessage REQUEST_DATA", { requestId, source: MSG_SOURCE, force, kind });
        window.postMessage({ source: MSG_SOURCE, type: "REQUEST_DATA", requestId, force, kind }, "*");
      }

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

      function parseRoadId(v) {
        const s = String(v ?? "")
          .trim()
          .toUpperCase()
          .replace(/[^0-9A-Z]/g, "");
        // Typical patterns: S7, S61, DK91, A1, 10a, S32b
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

      function roadBase(v) {
        // Base used for filtering: S7a -> S7, 10b -> 10, DK91 -> 91
        const s = String(v ?? "").toUpperCase();
        let m = s.match(/([AS])\s*0*([0-9]{1,2})(?![0-9])/);
        if (m) return m[1] + String(Number(m[2]));
        m = s.match(/(?:^|[^0-9])([0-9]{2})(?![0-9])/);
        if (m) return m[1];
        return "";
      }

      function cmpRoad(a, b) {
        const pa = parseRoadId(a);
        const pb = parseRoadId(b);
        let c = pa.prefix.localeCompare(pb.prefix, "pl");
        if (c) return c;
        c = (pa.num - pb.num);
        if (c) return c;
        return pa.suffix.localeCompare(pb.suffix, "pl");
      }

      function buildRoadBaseOptions(items) {
        const set = new Set();
        for (const it of items) {
          const v = String(it.road_number ?? "").trim();
          if (!v) continue;
          const base = roadBase(v); // 10a/10b -> 10, S32b -> S32
          if (!base) continue;
          set.add(base);
        }
        const arr = Array.from(set);
        arr.sort((a, b) => a.localeCompare(b, "pl", { numeric: true })); // naturalnie: S3, S6, S7, S33, S61
        return [{ value: "", label: "—" }, ...arr.map((x) => ({ value: x, label: x }))];
      }

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
                '<div class="__SID____field">' +
                  '<button type="button" class="waze-btn waze-btn-blue" id="__SID____borderReload">Odśwież dane</button>' +
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
        const elBorderFetched = tabPane.querySelector("#" + SCRIPT_ID + "__borderFetched");
        const elBorderMeta = tabPane.querySelector("#" + SCRIPT_ID + "__borderMeta");
        const elBorderList = tabPane.querySelector("#" + SCRIPT_ID + "__borderList");

        let currentTab = "junctions";

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
            if (!dataBorders || dataBorders.length === 0) {
              requestData("borders", elBorderFetched, false);
            }
          } else if (!dataJunctions || dataJunctions.length === 0) {
            requestData("junctions", elFetched, false);
          }
        };

        for (const btn of elTabButtons) {
          btn.addEventListener("click", () => setActiveTab(btn.dataset.tab));
        }

        // Pobieraj dane dopiero po otwarciu zakładki (albo po kliknięciu przycisku Odśwież).
        tabLabel.addEventListener("click", () => {
          if (currentTab === "borders") {
            if (!dataBorders || dataBorders.length === 0) {
              requestData("borders", elBorderFetched, false);
            }
          } else if (!dataJunctions || dataJunctions.length === 0) {
            requestData("junctions", elFetched, false);
          }
        });

        // Sort options (junctions)
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

        // Initial empty options for filters
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
            elList.innerHTML = "";
            elMeta.textContent = "Wybierz co najmniej jeden filtr, aby wyświetlić listę.";
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
            (elBorderName.value && String(elBorderName.value).trim())
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
        elBorderName.addEventListener("input", rerenderBordersDebounced);

        elReload.addEventListener("click", () => {
          requestData("junctions", elFetched, true);
          // wyniki odświeżymy po przyjściu danych
          setTimeout(rerenderJunctions, 0);
        });

        elBorderReload.addEventListener("click", () => {
          requestData("borders", elBorderFetched, true);
          // wyniki odświeżymy po przyjściu danych
          setTimeout(rerenderBorders, 0);
        });

        elMeta.textContent = "Wybierz co najmniej jeden filtr, aby wyświetlić listę.";

        elBorderMeta.textContent = "Wybierz co najmniej jeden filtr, aby wyświetlić listę.";

        // re-render po załadowaniu danych i uzupełnij selecty
        window.addEventListener("message", (event) => {
          if (event.source !== window) return;
          const msg = event.data;
          if (!msg || msg.source !== MSG_SOURCE) return;
          if (msg.type !== "DATA" || !msg.ok) return;

          const arr = Array.isArray(msg.json && msg.json.response) ? msg.json.response : [];
          if (msg.kind === "borders") {
            const mapped = arr
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

            dataBorders = mapped;

            setSelectOptions(elBorderNeighbor, buildUniqueOptions(mapped, (x) => x.neighbor), true);
            setSelectOptions(elBorderGeo, buildUniqueOptions(mapped, (x) => x.geographical_border), true);

            rerenderBorders();
            return;
          }

          const mapped = arr
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

          dataJunctions = mapped;

          setSelectOptionsGrouped(elRoad, buildRoadBaseGroupedOptions(mapped), true);
          setSelectOptions(elBranch, buildUniqueOptions(mapped, (x) => x.branch), true);
          setSelectOptions(elNumber, buildNumberOptions(mapped), true);

          rerenderJunctions();
        });

        setActiveTab("junctions", { fetch: false });
      }

      // ---------------------------
      // SDK init (zgodnie z dokumentacją)
      // ---------------------------
      if (!window.SDK_INITIALIZED || typeof window.SDK_INITIALIZED.then !== "function") {
        console.error(\`[\${SCRIPT_NAME}] window.SDK_INITIALIZED not available (SDK not loaded?)\`);
        return;
      }

      window.SDK_INITIALIZED.then(() => {
        if (!window.getWmeSdk) {
          console.error(\`[\${SCRIPT_NAME}] window.getWmeSdk not available.\`);
          return;
        }

        sdk = window.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
        sdk.Events.once({ eventName: "wme-ready" }).then(() => {
          buildTab().catch((e) => console.error(\`[\${SCRIPT_NAME}] buildTab error:\`, e));
        });
      });
    })();`;

    const el = document.createElement("script");
    el.id = `${SCRIPT_ID}__injected`;
    el.type = "text/javascript";
    el.textContent = code;
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  }

  // Install bridge and inject the page-context SDK UI code
  log("userscript: starting", { url: location.href });
  installBridge();
  injectPageScript();
})();
