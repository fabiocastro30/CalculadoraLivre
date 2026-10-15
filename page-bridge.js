"use strict";

(() => {
  if (globalThis.__CALCULADORA_LIVRE_PAGE_BRIDGE__) return;
  globalThis.__CALCULADORA_LIVRE_PAGE_BRIDGE__ = true;

  const SOURCE = "calculadora-livre-page-bridge";
  const CONTENT_SOURCE = "calculadora-livre-content";
  const MAX_PAYLOAD_LENGTH = 3_000_000;
  const snapshots = new Map();

  const isMercadoLivreUrl = (value) => {
    try {
      const hostname = new URL(value, location.href).hostname;
      return hostname === "mercadolivre.com.br" || hostname.endsWith(".mercadolivre.com.br");
    } catch {
      return false;
    }
  };

  const hasUsefulData = (text) => /sold_quantity|date_created|start_time|item_id|user_product_id|picture_id/i.test(text);

  function publish(kind, text, url = location.href, cacheKey = "") {
    if (typeof text !== "string" || !text || text.length > MAX_PAYLOAD_LENGTH || !hasUsefulData(text)) return;
    if (cacheKey) snapshots.set(cacheKey, { kind, text, url });
    window.postMessage({ source: SOURCE, version: 1, kind, text, url }, location.origin);
  }

  function inspectScript(script) {
    if (!(script instanceof HTMLScriptElement)) return;
    const id = script.id;
    const type = (script.type || "").toLowerCase();
    const text = script.textContent || "";
    if (id !== "__NORDIC_RENDERING_CTX__" && id !== "__NEXT_DATA__" && !type.includes("json") && !hasUsefulData(text)) return;
    publish("embedded-state", text, location.href, `${id || type || "inline"}:${text.length}:${location.href}`);
  }

  function scanNode(node) {
    if (!(node instanceof Element)) return;
    if (node.matches("script")) inspectScript(node);
    node.querySelectorAll?.("script").forEach(inspectScript);
  }

  const observer = new MutationObserver((records) => {
    records.forEach((record) => record.addedNodes.forEach(scanNode));
  });
  observer.observe(document, { childList: true, subtree: true });

  function scanExistingScripts() {
    document.querySelectorAll("script").forEach(inspectScript);
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== CONTENT_SOURCE) return;
    if (event.data.type === "request-snapshot") {
      snapshots.forEach((snapshot) => publish(snapshot.kind, snapshot.text, snapshot.url));
      scanExistingScripts();
    }
  });

  const nativeFetch = window.fetch;
  if (typeof nativeFetch === "function") {
    window.fetch = new Proxy(nativeFetch, {
      apply(target, thisArg, args) {
        const result = Reflect.apply(target, thisArg, args);
        Promise.resolve(result).then(async (response) => {
          try {
            if (!response?.ok || !isMercadoLivreUrl(response.url)) return;
            const type = response.headers.get("content-type") || "";
            const length = Number(response.headers.get("content-length") || 0);
            if (!/json|javascript|text/i.test(type) || length > MAX_PAYLOAD_LENGTH) return;
            const text = await response.clone().text();
            publish("page-response", text, response.url);
          } catch {
            // A observação nunca pode alterar a requisição original da página.
          }
        });
        return result;
      }
    });
  }

  const nativeOpen = XMLHttpRequest.prototype.open;
  const nativeSend = XMLHttpRequest.prototype.send;
  const requestUrls = new WeakMap();

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    requestUrls.set(this, String(url));
    return nativeOpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    this.addEventListener("load", () => {
      try {
        const url = this.responseURL || requestUrls.get(this) || "";
        if (this.status < 200 || this.status >= 300 || !isMercadoLivreUrl(url)) return;
        const type = this.getResponseHeader("content-type") || "";
        if (!/json|javascript|text/i.test(type)) return;
        const text = this.responseType === "json" ? JSON.stringify(this.response) : this.responseType === "" || this.responseType === "text" ? this.responseText : "";
        publish("page-response", text, url);
      } catch {
        // Respostas binárias ou protegidas são ignoradas.
      }
    }, { once: true });
    return nativeSend.apply(this, args);
  };

  scanExistingScripts();
  document.addEventListener("DOMContentLoaded", scanExistingScripts, { once: true });
})();
