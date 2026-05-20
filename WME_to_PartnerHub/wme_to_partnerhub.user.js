// ==UserScript==
// @name                WME to PartnerHub link
// @version             1.2.0
// @tag                 WME
// @description         Adds a PartnerHub link in "Share location" popup for the same lat/lon/zoom.
// @author              Falcon4Tech
// @match               https://*.waze.com/editor*
// @match               https://*.waze.com/*/editor*
// @grant               none
// @run-at              document-idle
// @license             MIT
// @namespace           https://wazepolska.pl
// @supportURL          https://github.com/Falcon4Tech/WME/issues
// @updateURL           https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_to_PartnerHub/wme_to_partnerhub.meta.js
// @downloadURL         https://raw.githubusercontent.com/Falcon4Tech/WME/main/WME_to_PartnerHub/wme_to_partnerhub.user.js
// ==/UserScript==

/** @typedef {import("../types").WmeSDK} WmeSDK */

(function () {
  "use strict";

  const SCRIPT_ID = "wme-to-partnerhub";
  const SCRIPT_NAME = "WME to PartnerHub link";
  const PH_WRAPPER_ID = "ph-permalink-wrapper";
  const PH_INPUT_ID = "ph-permalink-input";
  const PERMALINK_OPEN_ID = "permalink-open-icon";
  const PARTNERHUB_BASE = "https://www.waze.com/partnerhub/map-tool";
  const PARTNER_LABEL = "PartnerHub";
  const PARTNER_PLACEHOLDER = "PartnerHub";
  const PROD_WRAPPER_ID = "prod-permalink-wrapper";
  const processedPopups = new WeakSet();
  /** @type {WmeSDK | null} */
  let sdk = null;

  const log   = (...args) => console.log(`[${SCRIPT_NAME}]`, ...args);

  function getLang() {
    try {
      return sdk?.Settings?.getLocale?.()?.localeCode?.toLowerCase() ?? "";
    } catch (_) {
      return (document.documentElement.getAttribute("lang") || "").toLowerCase();
    }
  }

  function getCopyTitle() {
    const lang = getLang();
    return lang.startsWith("pl") ? "Skopiuj link" : "Copy link";
  }

  function getOpenTitle(sameWindow) {
    const lang = getLang();
    if (lang.startsWith("pl")) return sameWindow ? "Odśwież ten widok" : "Otwórz w nowym oknie";
    return sameWindow ? "Refresh this window" : "Open in new window";
  }

  function getSdkPermalink() {
    try {
      return sdk?.Map?.getPermalink?.() ?? null;
    } catch (_) {
      return null;
    }
  }

  function buildPartnerHubUrl({ lat, lon, zoom }) {
    const u = new URL(PARTNERHUB_BASE);
    u.searchParams.set("lat", lat);
    u.searchParams.set("lon", lon);
    u.searchParams.set("initialZoom", zoom);
    return u.toString();
  }

  function getPartnerHubUrl() {
    try {
      const { lat, lon } = sdk.Map.getMapCenter();
      const zoom = sdk.Map.getZoomLevel();
      return buildPartnerHubUrl({ lat: String(lat), lon: String(lon), zoom: String(zoom) });
    } catch (_) {
      return null;
    }
  }

  function isBetaEditor() {
    return location.hostname.startsWith("beta.");
  }

  function getProductionPermalink() {
    const url = getSdkPermalink();
    if (!url) return null;
    try {
      const u = new URL(url);
      u.hostname = u.hostname.replace(/^beta\./, "");
      return u.toString();
    } catch (_) {
      return null;
    }
  }

  function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {
        fallbackCopyText(text);
      });
      return;
    }
    fallbackCopyText(text);
  }

  function fallbackCopyText(text) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.left = "-9999px";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
    } catch (_) {}
    document.body.removeChild(ta);
  }

  function addIconInteraction(el, handler) {
    el.addEventListener("click", handler);
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        handler();
      }
    });
  }

  function createOpenIcon(titleText) {
    const openIcon = document.createElement("span");
    openIcon.className = "icon";
    openIcon.style.cursor = "pointer";
    openIcon.style.display = "inline-flex";
    openIcon.style.alignItems = "center";
    openIcon.title = titleText;
    openIcon.setAttribute("role", "button");
    openIcon.tabIndex = 0;
    openIcon.innerHTML =
        '<svg width="20" height="20" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M3.33333 3.33333H7.33333V2H3.33333C2.59695 2 2 2.59695 2 3.33333V12.6667C2 13.403 2.59695 14 3.33333 14H12.6667C13.403 14 14 13.403 14 12.6667V8.66667H12.6667V12.6667H3.33333V3.33333ZM7.80483 9.13798L12.6908 4.25015V6.66667H14V2H9.33333V3.30916H11.7462L6.86184 8.19535L7.80483 9.13798Z" fill="currentColor"></path></svg>';
    return openIcon;
  }

  function createPermalinkOpenButton(titleText) {
    const btn = document.createElement("wz-button");
    btn.setAttribute("color", "clear-icon");
    btn.setAttribute("size", "sm");
    btn.setAttribute("type", "button");
    btn.setAttribute("name", "");
    btn.setAttribute("value", "");
    btn.title = titleText;
    btn.style.alignSelf = "center";
    btn.style.marginLeft = "5px";

    const icon = document.createElement("i");
    icon.className = "w-icon w-icon-refresh";
    btn.appendChild(icon);

    return btn;
  }

  function ensurePermalinkOpenIcon(popupRoot) {
    const input = popupRoot.querySelector("wz-text-input#permalink-input");
    if (!input) return;
    const wrapper = input.closest(".permalink-wrapper");
    if (!wrapper || wrapper.querySelector(`#${PERMALINK_OPEN_ID}`)) return;

    const openBtn = createPermalinkOpenButton(getOpenTitle(true));
    openBtn.id = PERMALINK_OPEN_ID;
    addIconInteraction(openBtn, () => {
      const url = getSdkPermalink();
      if (url) window.location.href = url;
    });
    wrapper.appendChild(openBtn);
  }

  function ensureProdPermalinkInPopup(popupRoot) {
    if (popupRoot.querySelector(`#${PROD_WRAPPER_ID}`)) return;
    const existingWrapper = popupRoot.querySelector(".permalink-wrapper");
    if (!existingWrapper?.parentElement) return;

    const prodUrl = getProductionPermalink() || "";

    const wrapper = document.createElement("div");
    wrapper.id = PROD_WRAPPER_ID;
    wrapper.className = "permalink-wrapper";
    wrapper.style.display = "flex";
    wrapper.style.gap = "8px";
    wrapper.style.alignItems = "baseline";

    const input = document.createElement("wz-text-input");
    input.setAttribute("value", prodUrl);
    input.setAttribute("placeholder", "Permalink");
    input.setAttribute("autocomplete", "on");
    input.setAttribute("type", "text");
    input.setAttribute("size", "md");
    input.value = prodUrl;

    const copyIcon = document.createElement("i");
    copyIcon.className = "w-icon w-icon-copy";
    copyIcon.style.cursor = "pointer";
    copyIcon.title = getCopyTitle();
    copyIcon.setAttribute("role", "button");
    copyIcon.tabIndex = 0;

    const openIcon = createOpenIcon(getOpenTitle(false));

    addIconInteraction(copyIcon, () => {
      const url = getProductionPermalink();
      if (url) copyToClipboard(url);
    });

    addIconInteraction(openIcon, () => {
      const url = getProductionPermalink();
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });

    copyIcon.style.alignSelf = "flex-start";
    openIcon.style.alignSelf = "flex-start";
    copyIcon.style.marginTop = "5px";
    openIcon.style.marginTop = "6px";

    wrapper.appendChild(input);
    wrapper.appendChild(copyIcon);
    wrapper.appendChild(openIcon);

    existingWrapper.parentElement.insertBefore(wrapper, existingWrapper.nextSibling);
  }

  function ensureLinkInPopup(popupRoot) {
    ensurePermalinkOpenIcon(popupRoot);
    if (isBetaEditor()) ensureProdPermalinkInPopup(popupRoot);

    if (popupRoot.querySelector(`#${PH_WRAPPER_ID}`)) return;

    const content = popupRoot.querySelector(".share-location-popup-content") || popupRoot;
    const anchor =
      popupRoot.querySelector(".coordinates-wrapper") ||
      popupRoot.querySelector(".permalink-wrapper") ||
      content;

    const partnerUrl = getPartnerHubUrl() || "";

    const wrapper = document.createElement("div");
    wrapper.id = PH_WRAPPER_ID;
    wrapper.className = "permalink-wrapper";
    wrapper.style.display = "flex";
    wrapper.style.gap = "8px";
    wrapper.style.alignItems = "center";

    const input = document.createElement("wz-text-input");
    input.id = PH_INPUT_ID;
    input.setAttribute("value", partnerUrl);
    input.setAttribute("label", PARTNER_LABEL);
    input.setAttribute("placeholder", PARTNER_PLACEHOLDER);
    input.setAttribute("autocomplete", "on");
    input.setAttribute("type", "text");
    input.setAttribute("size", "md");
    input.value = partnerUrl;

    const copyIcon = document.createElement("i");
    copyIcon.className = "w-icon w-icon-copy";
    copyIcon.style.cursor = "pointer";
    copyIcon.title = getCopyTitle();
    copyIcon.setAttribute("role", "button");
    copyIcon.tabIndex = 0;

    const openIcon = createOpenIcon(getOpenTitle(false));

    addIconInteraction(copyIcon, () => {
      const url = getPartnerHubUrl();
      if (url) copyToClipboard(url);
    });

    addIconInteraction(openIcon, () => {
      const url = getPartnerHubUrl();
      if (url) window.open(url, "_blank", "noopener,noreferrer");
    });

    wrapper.appendChild(input);
    wrapper.appendChild(copyIcon);
    wrapper.appendChild(openIcon);

    if (anchor && anchor.parentElement) {
      anchor.parentElement.insertBefore(wrapper, anchor.nextSibling);
    } else {
      content.appendChild(wrapper);
    }
  }

  function overrideGeoLocationButton() {
    const btn = document.querySelector("wz-button.geo-location-control");
    if (!btn || btn.dataset.refreshOverridden) return;
    btn.dataset.refreshOverridden = "1";
    btn.addEventListener("click", (e) => {
      e.stopImmediatePropagation();
      const url = getSdkPermalink();
      if (url) window.location.href = url;
    }, true);
  }

  function tryInject() {
    if (!isPartnerLinkAllowed()) return;
    const popups = document.querySelectorAll(".share-location-pop-up-wrapper");
    if (!popups.length) return;
    popups.forEach((popupRoot) => {
      if (processedPopups.has(popupRoot)) return;
      ensureLinkInPopup(popupRoot);
      processedPopups.add(popupRoot);
    });
  }

  function getUserRank() {
    if (!sdk?.State || typeof sdk.State.getUserInfo !== "function") return null;
    const info = sdk.State.getUserInfo();
    if (!info || typeof info.rank !== "number") return null;
    return info.rank;
  }

  function isPartnerLinkAllowed() {
    const rank = getUserRank();
    if (rank == null) return false;
    const minRank = Number.parseInt("10", 4);
    return rank >= minRank;
  }

  function tryInjectErrorDialogButton(node) {
    const emptyState = node.querySelector('wz-empty-state[image-src*="SystemError"]');
    if (!emptyState || emptyState.dataset.refreshInjected) return;
    emptyState.dataset.refreshInjected = "1";

    const btn = document.createElement("wz-button");
    btn.setAttribute("slot", "button");
    btn.textContent = getOpenTitle(true);
    btn.addEventListener("click", () => {
      const url = getSdkPermalink();
      window.location.href = url || window.location.href;
    });
    emptyState.appendChild(btn);
  }

  function watchErrorDialog() {
    const container = document.getElementById("wz-dialog-container");
    if (!container) return;
    new MutationObserver((mutations) => {
      for (const m of mutations) {
        for (const node of m.addedNodes) {
          if (node instanceof Element) tryInjectErrorDialogButton(node);
        }
      }
    }).observe(container, { childList: true });
  }

  const obs = new MutationObserver((mutations) => {
    const shouldCheck = mutations.some((m) =>
      Array.from(m.addedNodes || []).some((node) => {
        if (!(node instanceof Element)) return false;
        return (
          node.classList.contains("share-location-pop-up-wrapper") ||
          node.querySelector(".share-location-pop-up-wrapper")
        );
      })
    );
    if (shouldCheck) tryInject();
  });

  function initSdk() {
    /** @type {Window & { SDK_INITIALIZED?: Promise<void>, getWmeSdk?: (args: { scriptId: string, scriptName: string }) => WmeSDK }} */
    const UW = window;
    let started = false;

    const start = () => {
      if (started) return true;
      if (!UW.SDK_INITIALIZED || typeof UW.SDK_INITIALIZED.then !== "function") return false;
      started = true;
      UW.SDK_INITIALIZED.then(() => {
        if (typeof UW.getWmeSdk !== "function") return;
        sdk = UW.getWmeSdk({ scriptId: SCRIPT_ID, scriptName: SCRIPT_NAME });
        const onReady = () => {
          tryInject();
          watchErrorDialog();
          overrideGeoLocationButton();
          if (sdk?.Events?.on) {
            sdk.Events.on({ eventName: "wme-logged-in", eventHandler: tryInject });
          }
        };
        if (sdk?.State?.isReady && sdk.State.isReady()) {
          onReady();
          return;
        }
        if (!sdk?.Events || typeof sdk.Events.once !== "function") return;
        sdk.Events.once({ eventName: "wme-ready" }).then(onReady);
      });
      return true;
    };

    const waitForSdk = () => {
      let tries = 0;
      const tick = () => {
        if (start()) return;
        if (tries++ < 40) {
          setTimeout(tick, 250);
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

  obs.observe(document.documentElement, { childList: true, subtree: true });

  initSdk();
  tryInject();
})();
