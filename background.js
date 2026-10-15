"use strict";

const REQUEST_INTERVAL_MS = 2400;
const CACHE_TTL_MS = 20 * 60 * 1000;
const MAX_HTML_LENGTH = 4_000_000;
const pageCache = new Map();
let requestQueue = Promise.resolve();
let lastRequestAt = 0;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function normalizeProductUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || (hostname !== "mercadolivre.com.br" && !hostname.endsWith(".mercadolivre.com.br"))) {
    throw new Error("URL de anúncio não permitida.");
  }
  url.hash = "";
  ["matt_tool", "matt_word", "matt_source", "matt_campaign_id", "matt_ad_group", "matt_match_type", "matt_network", "matt_device", "matt_creative", "matt_keyword", "matt_ad_position", "matt_ad_type", "matt_merchant_id", "matt_product_id", "matt_product_partition_id", "matt_target_id"].forEach((key) => url.searchParams.delete(key));
  return url.href;
}

async function fetchProductPage(rawUrl) {
  const url = normalizeProductUrl(rawUrl);
  const cached = pageCache.get(url);
  if (cached && Date.now() - cached.savedAt < CACHE_TTL_MS) return { html: cached.html, url, cached: true };

  const remaining = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
  if (remaining > 0) await wait(remaining);
  lastRequestAt = Date.now();

  const response = await fetch(url, {
    method: "GET",
    credentials: "include",
    cache: "default",
    redirect: "follow",
    headers: { "Accept": "text/html,application/xhtml+xml" }
  });
  if (!response.ok) throw new Error(`O anúncio respondeu com HTTP ${response.status}.`);
  if (/\/gz\/(?:account-verification|security|challenge)/i.test(new URL(response.url).pathname)) {
    throw new Error("O Mercado Livre solicitou a validação da sessão do navegador.");
  }
  const declaredLength = Number(response.headers.get("content-length") || 0);
  if (declaredLength > MAX_HTML_LENGTH) throw new Error("A página do anúncio excedeu o limite seguro de leitura.");
  const html = await response.text();
  if (!html || html.length > MAX_HTML_LENGTH) throw new Error("A página do anúncio não pôde ser processada com segurança.");

  pageCache.set(url, { html, savedAt: Date.now() });
  while (pageCache.size > 40) pageCache.delete(pageCache.keys().next().value);
  return { html, url, cached: false };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "calculadora-livre:fetch-product") return false;
  requestQueue = requestQueue.catch(() => undefined).then(() => fetchProductPage(message.url));
  requestQueue.then(
    (result) => sendResponse({ ok: true, ...result }),
    (error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : "Falha ao carregar o anúncio." })
  );
  return true;
});
