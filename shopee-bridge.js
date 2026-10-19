"use strict";

(() => {
  if (globalThis.__CALCULADORA_LIVRE_SHOPEE_BRIDGE__) return;
  globalThis.__CALCULADORA_LIVRE_SHOPEE_BRIDGE__ = true;

  const SOURCE = "cl-shopee-bridge";
  const MAX_PAYLOAD_LENGTH = 3_000_000;

  function postBridgeMessage(type, payload = {}) {
    try {
      window.postMessage({ source: SOURCE, type, ...payload }, location.origin);
    } catch {
      // Safe fallback
    }
  }

  // 1. Intercept SPA URL navigation (pushState and replaceState)
  const origPushState = history.pushState;
  if (typeof origPushState === "function") {
    history.pushState = function (...args) {
      const res = origPushState.apply(this, args);
      postBridgeMessage("navigation", { url: location.href, method: "pushState" });
      return res;
    };
  }

  const origReplaceState = history.replaceState;
  if (typeof origReplaceState === "function") {
    history.replaceState = function (...args) {
      const res = origReplaceState.apply(this, args);
      postBridgeMessage("navigation", { url: location.href, method: "replaceState" });
      return res;
    };
  }

  // 2. Intercept native fetch and XHR for Shopee PDP APIs
  const isShopeeUrl = (urlStr) => {
    try {
      const host = new URL(urlStr, location.href).hostname;
      return host.includes("shopee.com.br") || host.includes("shopee.com");
    } catch {
      return false;
    }
  };

  const isPdpOrItemApi = (urlStr) => {
    return /api\/v4\/(?:pdp\/get_pc|item\/get|product\/get_shop_info|shop\/get_shop_detail|item\/get_ratings)/i.test(urlStr) ||
           /(?:item_id|itemid|shop_id|shopid)/i.test(urlStr);
  };

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = new Proxy(nativeFetch, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args);
        Promise.resolve(result).then(async (response) => {
          try {
            if (!response?.ok || !isShopeeUrl(response.url)) return;
            if (!isPdpOrItemApi(response.url)) return;
            const type = response.headers.get("content-type") || "";
            if (!/json/i.test(type)) return;
            const length = Number(response.headers.get("content-length") || 0);
            if (length > MAX_PAYLOAD_LENGTH) return;
            const text = await response.clone().text();
            postBridgeMessage("api-data", { url: response.url, text });
          } catch {
            // Passive observation must never fail or affect page requests
          }
        });
        return result;
      }
    });
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const xhrUrls = new WeakMap();

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    xhrUrls.set(this, String(url));
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener("load", () => {
      try {
        const url = this.responseURL || xhrUrls.get(this) || "";
        if (this.status < 200 || this.status >= 300 || !isShopeeUrl(url) || !isPdpOrItemApi(url)) return;
        const type = this.getResponseHeader("content-type") || "";
        if (!/json/i.test(type)) return;
        const text = this.responseType === "json" ? JSON.stringify(this.response) : (this.responseType === "" || this.responseType === "text" ? this.responseText : "");
        if (text && text.length <= MAX_PAYLOAD_LENGTH) {
          postBridgeMessage("api-data", { url, text });
        }
      } catch {}
    }, { once: true });
    return nativeSend.apply(this, args);
  };

  // 3. Scan embedded MFE scripts if available on initial load
  function scanEmbeddedScripts() {
    const scripts = document.querySelectorAll('script[type="text/mfe-initial-data"]');
    for (const s of scripts) {
      const text = s.textContent?.trim();
      if (text && text.length <= MAX_PAYLOAD_LENGTH) {
        postBridgeMessage("api-data", { url: location.href, text });
      }
    }
  }

  scanEmbeddedScripts();
  document.addEventListener("DOMContentLoaded", scanEmbeddedScripts, { once: true });
})();
