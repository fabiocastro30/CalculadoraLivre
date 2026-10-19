"use strict";

(() => {
  if (globalThis.__CALCULADORA_LIVRE_SHOPEE_ACTIVE__) return;
  globalThis.__CALCULADORA_LIVRE_SHOPEE_ACTIVE__ = true;

  const APP = "Calculadora Livre (Shopee)";

  const DEFAULT_SHOPEE_SETTINGS = Object.freeze({
    shopeeCommissionPercent: 20, // 20% Programa de Frete Grátis Extra (ou 14% padrão)
    shopeeFixedFee: 4.0,         // R$ 4,00 taxa fixa por item vendido
    shopeeMaxCommission: 105.0,  // R$ 105,00 teto máximo de comissão por item na Shopee Brasil
    shopeeTaxPercent: 6.0,       // Imposto padrão configurável
    shopeePackagingCost: 1.5,    // Custo de embalagem
    shopeeAdsPercent: 0.0,       // Publicidade (Shopee Ads)
    shopeeDefaultWeight: 1000,   // Peso padrão em gramas
    shopeeFreeShippingProgram: true
  });

  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
  const shortDate = new Intl.DateTimeFormat("pt-BR");
  const asNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;"
  })[char]);
  const debounce = (fn, delay = 120) => {
    let timer;
    return (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), delay);
    };
  };

  function normalizeShopeePrice(val) {
    if (val == null) return 0;
    const num = Number(val);
    if (isNaN(num) || num <= 0) return 0;
    if (num >= 1000000) return num / 100000;
    if (num >= 10000 && Number.isInteger(num)) return num / 100000;
    return num;
  }

  function parseBrlPrice(text) {
    if (!text) return 0;
    const match = text.match(/R\$\s*([\d\.]+,\d{2})/i) || text.match(/([\d\.]+,\d{2})/);
    if (!match) return 0;
    return parseFloat(match[1].replace(/\./g, "").replace(",", "."));
  }

  function parseShopeeSoldCount(raw) {
    if (typeof raw === "number") return { display: String(raw), count: raw, isLowerBound: false };
    const str = String(raw || "").trim();
    if (!str) return { display: "0", count: 0, isLowerBound: false };
    const milMatch = str.match(/([\d,\.]+)\s*(?:mil|k)\+?/i);
    if (milMatch) {
      const num = parseFloat(milMatch[1].replace(",", "."));
      return {
        display: str,
        count: Math.round(num * 1000),
        isLowerBound: str.includes("+")
      };
    }
    const digitsMatch = str.match(/[\d\.]+/);
    if (digitsMatch) {
      const count = parseInt(digitsMatch[0].replace(/\./g, ""), 10);
      return {
        display: str,
        count: isNaN(count) ? 0 : count,
        isLowerBound: str.includes("+")
      };
    }
    return { display: str, count: 0, isLowerBound: false };
  }

  // =========================================================================
  // PLATFORM DETECTOR
  // =========================================================================
  class PlatformDetector {
    static isShopee() {
      return location.hostname.includes("shopee.com.br") || location.hostname.includes("shopee.com");
    }

    static isProductPage() {
      if (!this.isShopee()) return false;
      const pathname = location.pathname.toLowerCase();

      // Exclude non-product routes
      const excludedPrefixes = [
        "/search", "/cart", "/checkout", "/user", "/seller", "/portal",
        "/all-categories", "/flash_sale", "/daily_discover", "/mms", "/help"
      ];
      if (pathname === "/" || excludedPrefixes.some((prefix) => pathname.startsWith(prefix))) {
        return false;
      }

      // Check product URL structures:
      // 1) /product/{shopId}/{itemId}
      // 2) /{title-slug}-i.{shopId}.{itemId}
      // 3) /universal-link/product/...
      if (/\/product\/\d+\/\d+/i.test(pathname)) return true;
      if (/-i\.\d+\.\d+/i.test(pathname)) return true;

      // Check URL query parameters
      const params = new URLSearchParams(location.search);
      if (params.get("itemid") || params.get("item_id")) return true;

      // Check DOM structure if URL is obscure
      const hasProductDom = Boolean(
        document.querySelector(".SQguX_, .xvTkTc, h1.auau1S, .AP_iE1, .nt0EaI, .product-briefing, [class*='product-briefing'], .page-product__detail, div.page-product")
      );
      if (hasProductDom) return true;

      // Check MFE initial data
      const mfeScripts = document.querySelectorAll('script[type="text/mfe-initial-data"]');
      if (mfeScripts.length > 0) {
        for (const s of mfeScripts) {
          const txt = s.textContent || "";
          if (txt.includes("DOMAIN_PDP") || txt.includes('"item":') || txt.includes('"shop_detailed":')) {
            return true;
          }
        }
      }

      return false;
    }

    static getProductIds() {
      const pathname = location.pathname;
      const m1 = pathname.match(/-i\.(\d+)\.(\d+)/i);
      if (m1) return { shopId: m1[1], itemId: m1[2] };

      const m2 = pathname.match(/\/product\/(\d+)\/(\d+)/i);
      if (m2) return { shopId: m2[1], itemId: m2[2] };

      const params = new URLSearchParams(location.search);
      const itemId = params.get("itemid") || params.get("item_id");
      const shopId = params.get("shopid") || params.get("shop_id");
      if (itemId && shopId) return { shopId, itemId };

      return { shopId: null, itemId: null };
    }
  }

  // =========================================================================
  // STORAGE MANAGER (SHOPEE ISOLATED)
  // =========================================================================
  class ShopeeStorageManager {
    static async get() {
      try {
        const stored = await chrome.storage.sync.get(DEFAULT_SHOPEE_SETTINGS);
        return { ...DEFAULT_SHOPEE_SETTINGS, ...stored };
      } catch (error) {
        console.warn(`${APP}: configurações padrão em uso`, error);
        return { ...DEFAULT_SHOPEE_SETTINGS };
      }
    }

    static subscribe(callback) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        const patch = {};
        for (const [key, item] of Object.entries(changes)) {
          if (key in DEFAULT_SHOPEE_SETTINGS) {
            patch[key] = item.newValue;
          }
        }
        if (Object.keys(patch).length > 0) callback(patch);
      });
    }
  }

  // =========================================================================
  // PRICING ENGINE (EXCLUSIVO DA SHOPEE)
  // =========================================================================
  class ShopeePricingEngine {
    static calculate(input) {
      const price = Math.max(0, asNumber(input.price, 0));
      const commissionPercent = asNumber(input.commissionPercent, 20);
      const fixedFee = asNumber(input.fixedFee, 4.0);
      const maxCommission = asNumber(input.maxCommission, 105.0);
      const taxPercent = asNumber(input.taxPercent, 6.0);
      const adsPercent = asNumber(input.adsPercent, 0.0);
      const packagingCost = asNumber(input.packagingCost, 1.5);
      const productCost = Math.max(0, asNumber(input.productCost, 0));
      const sellerShippingContribution = Math.max(0, asNumber(input.sellerShippingContribution, 0));
      const additionalFees = Math.max(0, asNumber(input.additionalFees, 0));

      // Comissão percentual com teto (cap) por item na Shopee
      const uncappedCommission = price * (commissionPercent / 100);
      const isCapped = maxCommission > 0 && uncappedCommission > maxCommission;
      const commission = price > 0 ? (isCapped ? maxCommission : uncappedCommission) : 0;
      const itemFixedFee = price > 0 ? fixedFee : 0;

      // Repasse líquido da Shopee
      const netPayout = Math.max(0, price - commission - itemFixedFee - sellerShippingContribution - additionalFees);
      const netPayoutPercent = price > 0 ? (netPayout / price) * 100 : 0;

      // Despesas operacionais do vendedor
      const tax = price * (taxPercent / 100);
      const adsCost = price * (adsPercent / 100);
      const extras = tax + adsCost + packagingCost;

      // Sobra após custos e margem real
      const availableAfterCosts = netPayout - extras;
      const totalCosts = commission + itemFixedFee + sellerShippingContribution + additionalFees + extras + productCost;
      const realProfit = netPayout - extras - productCost;
      const realMargin = price > 0 ? (realProfit / price) * 100 : 0;

      return {
        price,
        commissionPercent,
        commission,
        uncappedCommission,
        isCapped,
        maxCommission,
        fixedFee: itemFixedFee,
        sellerShippingContribution,
        additionalFees,
        netPayout,
        netPayoutPercent,
        tax,
        taxPercent,
        adsCost,
        adsPercent,
        packagingCost,
        extras,
        availableAfterCosts,
        productCost,
        totalCosts,
        realProfit,
        realMargin
      };
    }

    static stepOpportunity(input) {
      const price = asNumber(input.price, 0);
      const commissionPercent = asNumber(input.commissionPercent, 20);
      const maxCommission = asNumber(input.maxCommission, 105);
      if (!maxCommission || commissionPercent <= 0) return null;

      // Threshold where commission reaches the cap
      const capThreshold = maxCommission / (commissionPercent / 100);
      if (price >= capThreshold * 0.75 && price < capThreshold) {
        return {
          type: "cap_threshold",
          capThreshold,
          maxCommission,
          message: `💡 <strong>Oportunidade Shopee:</strong> A partir de ${money.format(capThreshold)}, a comissão atinge o teto fixo de ${money.format(maxCommission)}. Acima desse valor, 100% de qualquer acréscimo de preço vai direto para o seu repasse.`
        };
      }
      return null;
    }
  }

  // =========================================================================
  // DATA EXTRACTOR (JSON & STRUCTURED DATA)
  // =========================================================================
  class ShopeeDataExtractor {
    static fromDocument() {
      const ids = PlatformDetector.getProductIds();
      let structured = null;

      const mfeScripts = document.querySelectorAll('script[type="text/mfe-initial-data"]');
      for (const script of mfeScripts) {
        try {
          const raw = script.textContent?.trim();
          if (!raw) continue;
          const json = JSON.parse(raw);
          const parsed = this.extractFromJson(json, ids);
          if (parsed) {
            structured = parsed;
            break;
          }
        } catch {
          // ignore invalid json chunks
        }
      }

      // Check ld+json fallback
      if (!structured) {
        structured = this.extractFromLdJson();
      }

      return structured;
    }

    static extractFromJson(json, ids = {}) {
      if (!json || typeof json !== "object") return null;

      let item = null;
      let shop = null;

      // 0. Path: Direct Shopee API payload (pdp/get_pc, item/get, etc.)
      const apiData = json.data || json;
      if (apiData && typeof apiData === "object") {
        if (apiData.item && typeof apiData.item === "object") {
          item = apiData.item;
        } else if (apiData.item_id || apiData.itemid || apiData.name || apiData.price != null) {
          item = apiData;
        }
        if (apiData.shop_detailed || apiData.shop_info || apiData.shop) {
          shop = apiData.shop_detailed || apiData.shop_info || apiData.shop;
        }
      }

      // 1. Path: initialState.item.items
      if (!item) {
        const itemsMap = json.initialState?.item?.items || json.item?.items;
        if (itemsMap && typeof itemsMap === "object") {
          if (ids.itemId && itemsMap[ids.itemId]) {
            item = itemsMap[ids.itemId];
          } else {
            const keys = Object.keys(itemsMap);
            if (keys.length > 0) item = itemsMap[keys[0]];
          }
        }
      }

      // 2. Path: DOMAIN_PDP.data.PDP_BFF_DATA.cachedMap
      if (!item || !shop) {
        const cachedMap = json.initialState?.DOMAIN_PDP?.data?.PDP_BFF_DATA?.cachedMap ||
                          json.DOMAIN_PDP?.data?.PDP_BFF_DATA?.cachedMap;
        if (cachedMap && typeof cachedMap === "object") {
          const values = Object.values(cachedMap);
          if (values.length > 0) {
            const bffData = values[0];
            if (!item && bffData?.item) item = bffData.item;
            if (!shop && bffData?.shop_detailed) shop = bffData.shop_detailed;
          }
        }
      }

      // 3. Fallback direct objects
      if (!item) {
        item = json.initialState?.item || json.item || json.initialState?.product || json.product;
      }
      if (!shop) {
        shop = json.initialState?.shop_detailed || json.shop_detailed || json.initialState?.shop || json.shop;
      }

      if (!item || (!item.item_id && !item.itemid && !item.name && !item.title)) {
        return null;
      }

      const itemId = item.item_id || item.itemid || ids.itemId;
      const shopId = item.shop_id || item.shopid || ids.shopId;

      const rawPrice = item.price || item.price_min || item.price_max;
      const price = normalizeShopeePrice(rawPrice);
      const rawOriginalPrice = item.price_before_discount || item.price_min_before_discount || item.price_max_before_discount;
      const originalPrice = normalizeShopeePrice(rawOriginalPrice);

      const soldObj = parseShopeeSoldCount(item.historical_sold_display || item.historical_sold || item.global_sold_display || item.global_sold);

      // Models / Variations
      const models = Array.isArray(item.models) ? item.models.map((m) => ({
        modelId: m.model_id || m.modelid,
        name: m.name || "",
        price: normalizeShopeePrice(m.price),
        originalPrice: normalizeShopeePrice(m.price_before_discount),
        stock: m.stock || m.normal_stock || 0,
        sku: m.sku || ""
      })) : [];

      const tierVariations = Array.isArray(item.tier_variations) ? item.tier_variations.map((t) => ({
        name: t.name || "",
        options: Array.isArray(t.options) ? t.options : []
      })) : [];

      // Wholesale
      const wholesaleTiers = Array.isArray(item.wholesale_tier_list) ? item.wholesale_tier_list.map((w) => ({
        minCount: w.min_count || 0,
        maxCount: w.max_count || null,
        price: normalizeShopeePrice(w.price)
      })) : [];

      // Rating
      const ratingInfo = item.item_rating || {};
      const ratingStar = Number(ratingInfo.rating_star || item.rating_star || 0);
      const ratingCount = Number(ratingInfo.total_rating_count || item.total_rating_count || 0);
      const commentCount = Number(ratingInfo.cmt_count || 0);
      const likedCount = Number(item.liked_count || 0);

      // Attributes & Description
      const attributes = Array.isArray(item.attributes) ? item.attributes : [];
      const description = String(item.description || "");

      // Ctime
      const ctime = Number(item.ctime || 0);

      // Shop detailed
      const shopInfo = shop ? {
        shopId: shop.shopid || shop.shop_id || shopId,
        name: shop.name || "",
        location: shop.shop_location || shop.location || "",
        itemCount: Number(shop.item_count || 0),
        ratingStar: Number(shop.rating_star || 0),
        ratingGood: Number(shop.rating_good || 0),
        ratingBad: Number(shop.rating_bad || 0),
        followerCount: Number(shop.follower_count || 0),
        responseRate: Number(shop.response_rate || 0),
        responseTime: shop.response_time || "",
        isOfficial: Boolean(shop.is_official_shop || shop.is_shopee_verified || shop.official_mall),
        ctime: Number(shop.ctime || 0)
      } : null;

      return {
        itemId,
        shopId,
        title: item.name || item.title || "",
        price,
        originalPrice: originalPrice > price ? originalPrice : null,
        stock: Number(item.stock || item.normal_stock || 0),
        soldQuantity: soldObj.count,
        soldDisplay: soldObj.display,
        soldIsLowerBound: soldObj.isLowerBound,
        ctime,
        ratingStar,
        ratingCount,
        commentCount,
        likedCount,
        imagesCount: Array.isArray(item.images) ? item.images.length : (item.images ? 1 : 0),
        videoCount: Array.isArray(item.video_info_list) ? item.video_info_list.length : 0,
        brand: item.brand || "",
        models,
        tierVariations,
        wholesaleTiers,
        attributes,
        description,
        shop: shopInfo,
        hasStructured: true
      };
    }

    static extractFromLdJson() {
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent || "");
          if (data["@type"] === "Product" || data.offers) {
            const offer = Array.isArray(data.offers) ? data.offers[0] : data.offers;
            const price = parseFloat(offer?.price || 0);
            return {
              title: data.name || "",
              price: price > 0 ? price : 0,
              brand: data.brand?.name || "",
              ratingStar: parseFloat(data.aggregateRating?.ratingValue || 0),
              ratingCount: parseInt(data.aggregateRating?.reviewCount || 0, 10),
              hasStructured: true
            };
          }
        } catch {
          // ignore
        }
      }
      return null;
    }
  }

  // =========================================================================
  // DOM FALLBACK & LIVE EXTRACTOR
  // =========================================================================
  class ShopeeDomFallbackExtractor {
    static fromDocument() {
      const title = document.querySelector("h1.auau1S, h1, .qaNIZv, [class*='title'], [class*='product-title']")?.textContent?.trim() || document.title;

      // Extract current live price from the DOM briefing
      let price = 0;
      let originalPrice = null;
      let discountText = "";

      // Shopee price elements: modern layout (.nt0EaI, .pyzxvq.pw3J3G) + legacy selectors
      const priceSelectors = [
        ".nt0EaI .pyzxvq.pw3J3G",
        ".nt0EaI .pyzxvq",
        ".pyzxvq.pw3J3G",
        ".pyzxvq",
        ".flex.flex-column.AP_iE1 .pyzxvq",
        "section[aria-live='polite'] .pyzxvq",
        ".product-briefing [class*='flex-column'] [class*='items-center']",
        ".product-briefing div[class*='price']",
        ".page-product div[class*='price']",
        "div[class*='flex-column'] div[class*='items-center']",
        "[class*='G27w2Q']",
        "[class*='Y3DfxN']",
        "[class*='_0Z3Idn']"
      ];

      for (const sel of priceSelectors) {
        const els = document.querySelectorAll(sel);
        for (const el of els) {
          const txt = el.textContent || "";
          if (txt.includes("R$")) {
            const parsed = parseBrlPrice(txt);
            if (parsed > 0) {
              price = parsed;
              break;
            }
          }
        }
        if (price > 0) break;
      }

      // If price still not found, search all text nodes with R$ in the briefing
      if (price === 0) {
        const briefing = document.querySelector(".xvTkTc, .SQguX_, .product-briefing, [class*='product-briefing'], .page-product");
        if (briefing) {
          const match = briefing.innerText.match(/R\$\s*([\d\.]+,\d{2})/);
          if (match) price = parseBrlPrice(match[0]);
        }
      }

      // Alternate price / price without coupon
      const altPriceEl = document.querySelector(".zmROP0, [class*='zmROP0']");
      if (altPriceEl) {
        const matchAlt = altPriceEl.textContent?.match(/ou\s+R\$\s*([\d\.]+,\d{2})/i) || altPriceEl.textContent?.match(/R\$\s*([\d\.]+,\d{2})/);
        if (matchAlt) {
          const parsedAlt = parseBrlPrice(matchAlt[0]);
          if (parsedAlt > price) originalPrice = parsedAlt;
        }
      }

      // Strikethrough original price
      const originalEl = document.querySelector(".product-briefing s, [class*='price-before-discount'], [class*='original-price']");
      if (originalEl) {
        const parsedOrig = parseBrlPrice(originalEl.textContent || "");
        if (parsedOrig > price) originalPrice = parsedOrig;
      }

      // Discount tag
      const discountEl = document.querySelector(".product-briefing [class*='discount'], .product-briefing [class*='badge'], [class*='discount-badge']");
      if (discountEl && /%\s*(?:OFF)?/i.test(discountEl.textContent || "")) {
        discountText = discountEl.textContent.trim();
      }

      // Sold count from DOM (Modern Shopee .PfWbfd / .Ocv3B8 / .zrnbj5 + legacy fallback)
      let soldDisplay = "";
      let soldQuantity = 0;
      let soldIsLowerBound = false;

      // 1. Direct modern selector
      const soldSpan = document.querySelector(".PfWbfd, .Ocv3B8, [class*='PfWbfd'], [class*='Ocv3B8']");
      if (soldSpan) {
        const parsed = parseShopeeSoldCount(soldSpan.textContent?.trim() || "");
        if (parsed.count > 0 || parsed.display) {
          soldDisplay = parsed.display;
          soldQuantity = parsed.count;
          soldIsLowerBound = parsed.isLowerBound;
        }
      }

      // 2. Scan briefing elements for "vendido" / "vendidos"
      if (soldQuantity === 0) {
        const searchScope = document.querySelectorAll(".xvTkTc span, .xvTkTc div, .SQguX_ span, .SQguX_ div, .product-briefing span, .product-briefing div, .zrnbj5, [class*='zrnbj5']");
        for (const el of searchScope) {
          const t = el.textContent?.trim() || "";
          if (/(?:vendido|vendidos)/i.test(t) && !t.includes("avaliar")) {
            const parsed = parseShopeeSoldCount(t);
            if (parsed.count > 0 || parsed.display) {
              soldDisplay = parsed.display;
              soldQuantity = parsed.count;
              soldIsLowerBound = parsed.isLowerBound;
              break;
            }
          }
        }
      }

      // 3. Regex on briefing innerHTML
      if (soldQuantity === 0) {
        const briefingEl = document.querySelector(".xvTkTc, .SQguX_, .product-briefing");
        if (briefingEl) {
          const matchSold = briefingEl.innerHTML.match(/<span[^>]*class="[^"]*PfWbfd[^"]*"[^>]*>([^<]+)<\/span>\s*Vendidos/i) ||
                            briefingEl.innerText.match(/([\d,\.]+\s*(?:mil|k)?\+?)\s*Vendidos/i);
          if (matchSold) {
            const parsed = parseShopeeSoldCount(matchSold[1]);
            soldDisplay = parsed.display;
            soldQuantity = parsed.count;
            soldIsLowerBound = parsed.isLowerBound;
          }
        }
      }

      // Stock from DOM
      let stock = 0;
      let hasAvailableStock = false;
      const allTextElements = document.querySelectorAll(".xvTkTc span, .xvTkTc div, .product-briefing span, .product-briefing div, .SQguX_ span, .SQguX_ div");
      for (const el of allTextElements) {
        const t = el.textContent?.trim() || "";
        const stockMatch = t.match(/(\d+)\s*(?:peças disponíveis|itens disponíveis|disponíveis)/i);
        if (stockMatch) {
          stock = parseInt(stockMatch[1], 10);
          hasAvailableStock = true;
          break;
        }
        if (/estoque disponível/i.test(t)) {
          hasAvailableStock = true;
        }
      }

      // Rating from DOM
      let ratingStar = 0;
      let ratingCount = 0;
      const modernRating = document.querySelector(".FllsTu.JXtSdn.bv0Mz_, .FllsTu.bv0Mz_, .uLEz5u .FllsTu");
      if (modernRating) {
        const parsedStar = parseFloat(modernRating.textContent?.trim() || "0");
        if (parsedStar > 0) ratingStar = parsedStar;
      }
      if (ratingStar === 0) {
        const ratingEl = document.querySelector(".product-briefing [class*='rating'], .product-briefing [class*='stars']");
        if (ratingEl) {
          const starMatch = ratingEl.textContent?.match(/(\d\.\d)/);
          if (starMatch) ratingStar = parseFloat(starMatch[1]);
        }
      }

      // Reviews count from DOM
      const revElements = document.querySelectorAll("button.k_fvNr, .uLEz5u button, .product-briefing [class*='rating']");
      for (const btn of revElements) {
        if (/avaliaç/i.test(btn.textContent || "")) {
          const numEl = btn.querySelector(".FllsTu") || btn;
          const matchNum = numEl.textContent?.match(/(\d+[\d\.,]*)/);
          if (matchNum) {
            ratingCount = parseInt(matchNum[1].replace(/\./g, ""), 10);
            break;
          }
        }
      }

      // Shop info from DOM
      let shopName = "";
      let shopLocation = "";
      let shopIsOfficial = Boolean(document.querySelector("img.ZZO5kF[alt*='mall'], img[alt*='mall'], .kG0FxG img[alt*='mall']"));
      let shopItemCount = 0;
      let shopRatingStar = 0;
      let shopFollowerCount = 0;
      let shopResponseRate = 0;
      let shopResponseTime = "";

      const shopCard = document.querySelector(".page-product__shop, [class*='page-product__shop'], [class*='shop-info'], [class*='shop-header']");
      if (shopCard) {
        shopName = shopCard.querySelector("h1, [class*='shop-name'], a[href*='/shop/'], a[href*='/from_same_shop']")?.textContent?.trim() || "";
        if (!shopIsOfficial) {
          shopIsOfficial = Boolean(shopCard.querySelector("[class*='official'], [class*='mall'], [class*='preferred']"));
        }
        const shopText = shopCard.innerText || "";
        const locMatch = shopText.match(/(?:enviar de|localização|de)\s*:\s*([^\n\r]+)/i);
        if (locMatch) shopLocation = locMatch[1].trim();

        // Extrair métricas do vendedor diretamente do DOM
        const itemsMatch = shopText.match(/produtos\s*:\s*([\d\.,]+(?:\s*(?:mil|k))?)/i) || shopText.match(/([\d\.,]+(?:\s*(?:mil|k))?)\s*produtos/i);
        if (itemsMatch) {
          const p = parseShopeeSoldCount(itemsMatch[1]);
          if (p.count > 0) shopItemCount = p.count;
        }

        const ratingsMatch = shopText.match(/avaliações\s*:\s*([\d\.,]+(?:\s*(?:mil|k))?)/i) || shopText.match(/([\d\.,]+(?:\s*(?:mil|k))?)\s*avaliações/i);
        if (ratingsMatch) {
          const p = parseShopeeSoldCount(ratingsMatch[1]);
          if (p.count > 0) shopRatingStar = p.count >= 10 ? 4.8 : p.count;
        }

        const followersMatch = shopText.match(/seguidores\s*:\s*([\d\.,]+(?:\s*(?:mil|k))?)/i) || shopText.match(/([\d\.,]+(?:\s*(?:mil|k))?)\s*seguidores/i);
        if (followersMatch) {
          const p = parseShopeeSoldCount(followersMatch[1]);
          if (p.count > 0) shopFollowerCount = p.count;
        }

        const respRateMatch = shopText.match(/taxa de resposta\s*:\s*(\d+)%?/i) || shopText.match(/(\d+)%\s*(?:de taxa de resposta|taxa de resposta)/i);
        if (respRateMatch) {
          shopResponseRate = parseInt(respRateMatch[1], 10);
        }

        const respTimeMatch = shopText.match(/tempo de resposta\s*:\s*([^\n\r]+)/i) || shopText.match(/(?:responde em|geralmente responde)\s*([^\n\r]+)/i);
        if (respTimeMatch) {
          shopResponseTime = respTimeMatch[1].trim();
        }
      }

      // Location from PDP shipping section (e.g. "Ferraz de Vasconcelos, São Paulo")
      if (!shopLocation) {
        const locEl = document.querySelector(".AzJBIW .lrcnAZ, .JCTCWp + .lrcnAZ, .dtIfxg");
        if (locEl) shopLocation = locEl.textContent?.trim() || "";
      }

      // Vouchers / Coupons
      const coupons = [];
      document.querySelectorAll("[class*='voucher-ticket'], [class*='voucher-item'], [class*='shop-voucher'], .u_3JMT p").forEach((v) => {
        const ct = v.textContent?.trim();
        if (ct && ct.length < 40 && !coupons.includes(ct)) coupons.push(ct);
      });

      return {
        title,
        price,
        originalPrice,
        discountText,
        soldQuantity,
        soldDisplay,
        soldIsLowerBound,
        stock,
        hasAvailableStock,
        ratingStar,
        ratingCount,
        shopName,
        shopLocation,
        shopIsOfficial,
        shopItemCount,
        shopRatingStar,
        shopFollowerCount,
        shopResponseRate,
        shopResponseTime,
        coupons
      };
    }
  }

  // =========================================================================
  // QUALITY & SOCIAL PROOF ENGINE
  // =========================================================================
  class ShopeeQualityEngine {
    static evaluate(data) {
      const checks = [
        [data.imagesCount >= 8, `Galeria de fotos: ${data.imagesCount || 0} fotos (ideal ≥ 8)`],
        [data.imagesCount > 0, "Imagem principal do produto cadastrada"],
        [data.videoCount > 0, data.videoCount > 0 ? "Vídeo demonstrativo publicado" : "Sem vídeo demonstrativo"],
        [Boolean(data.shop?.isOfficial || data.shopIsOfficial), "Selo Loja Oficial ou Vendedor Indicado"],
        [Boolean(data.wholesaleTiers?.length || data.models?.length > 1), "Variações ou compra por quantidade disponível"],
        [data.ratingStar >= 4.5 && data.ratingCount > 0, `Avaliação do anúncio: ${number.format(data.ratingStar || 0)} ★ (ideal ≥ 4.5)`],
        [data.ratingCount >= 50, `Volume de avaliações: ${compact.format(data.ratingCount || 0)} (ideal ≥ 50)`],
        [Array.isArray(data.attributes) && data.attributes.length >= 3, `Ficha técnica: ${data.attributes?.length || 0} atributos preenchidos`],
        [String(data.description || "").length >= 200, "Descrição comercial detalhada (≥ 200 caracteres)"]
      ];

      const passed = checks.filter(([ok]) => ok).length;
      const score = Math.round((passed / checks.length) * 100);

      return {
        score,
        checks,
        socialProof: {
          ratingStar: data.ratingStar || 0,
          ratingCount: data.ratingCount || 0,
          commentCount: data.commentCount || 0,
          likedCount: data.likedCount || 0,
          soldDisplay: data.soldDisplay || "0",
          soldCount: data.soldQuantity || 0
        }
      };
    }
  }

  // =========================================================================
  // PDP WIDGET INJECTOR (SHOPEE NATIVE UI)
  // =========================================================================
  class ShopeePdpWidgetInjector {
    constructor(settings) {
      this.settings = settings;
      this.data = null;
      this.root = null;
      this.observer = null;
      this.manualCost = "";
      this.manualPrice = "";
      this.lastProductId = null;
      this.mountTimer = null;
      this.isMounting = false;
    }

    input(data, overrides = {}) {
      return {
        price: data.price,
        commissionPercent: this.settings.shopeeCommissionPercent,
        fixedFee: this.settings.shopeeFixedFee,
        maxCommission: this.settings.shopeeMaxCommission,
        taxPercent: this.settings.shopeeTaxPercent,
        adsPercent: this.settings.shopeeAdsPercent,
        packagingCost: this.settings.shopeePackagingCost,
        ...overrides
      };
    }

    findBriefingContainer() {
      const candidates = [
        "div.flex-auto.flex-column.xvTkTc",
        "div.xvTkTc",
        "section.flex.flex-auto.SQguX_",
        "section.SQguX_",
        ".SQguX_",
        ".xvTkTc",
        ".product-briefing",
        "[class*='product-briefing']",
        ".page-product__detail",
        "section.page-product",
        "div.page-product"
      ];
      for (const sel of candidates) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    }

    findPriceContainer(briefing) {
      const container = briefing || document;
      const candidates = [
        container.querySelector("div[style*='margin-top'] .flex.flex-column.AP_iE1")?.closest("div[style*='margin-top']"),
        container.querySelector(".flex.flex-column.AP_iE1")?.closest("div[style*='margin-top']"),
        container.querySelector(".flex.flex-column.AP_iE1"),
        container.querySelector("section[aria-live='polite']")?.closest("div[style*='margin-top']"),
        container.querySelector("section[aria-live='polite']"),
        container.querySelector(".nt0EaI")?.closest(".AP_iE1")?.parentElement,
        container.querySelector(".nt0EaI"),
        container.querySelector(".product-briefing [class*='flex-column'] [class*='items-center']"),
        container.querySelector(".product-briefing div[class*='price']"),
        container.querySelector("div[class*='price-box'], div[class*='price-wrapper']"),
        document.querySelector("div[style*='margin-top'] .AP_iE1")?.parentElement,
        document.querySelector(".AP_iE1")
      ];
      return candidates.find(Boolean) || null;
    }

    expandAnnouncementContainer(briefing) {
      try {
        const containers = [
          briefing,
          document.querySelector("section.SQguX_"),
          document.querySelector("div.xvTkTc"),
          document.querySelector(".page-product"),
          document.querySelector(".page-product__detail"),
          document.querySelector(".product-briefing")
        ].filter(Boolean);

        containers.forEach((el) => {
          el.style.setProperty("height", "auto", "important");
          el.style.setProperty("min-height", "auto", "important");
          el.style.setProperty("max-height", "none", "important");
          el.style.setProperty("overflow", "visible", "important");
        });

        const rightCol = document.querySelector("div.xvTkTc") || (briefing?.classList?.contains("xvTkTc") ? briefing : briefing?.querySelector?.(".xvTkTc"));
        if (rightCol) {
          rightCol.style.setProperty("flex", "1 1 auto", "important");
          rightCol.style.setProperty("width", "auto", "important");
          rightCol.style.setProperty("max-width", "100%", "important");
        }

        const outerSection = document.querySelector("section.SQguX_");
        if (outerSection) {
          outerSection.style.setProperty("align-items", "flex-start", "important");
        }
      } catch {
        // Safe fallback
      }
    }

    findPurchaseSection(briefing) {
      const container = briefing || document;
      const actionCandidates = [
        container.querySelector("[class*='purchase-section']"),
        container.querySelector("[class*='item-quantity']"),
        container.querySelector("button[class*='btn-solid-primary']"),
        [...container.querySelectorAll("button")].find((b) => /comprar|adicionar/i.test(b.textContent || ""))?.parentElement
      ];
      return actionCandidates.find(Boolean) || null;
    }

    placeAnalysis(root, briefing) {
      this.expandAnnouncementContainer(briefing);

      const editingField = root.contains(document.activeElement);
      if (editingField) return;

      const priceContainer = this.findPriceContainer(briefing);
      if (priceContainer) {
        if (root.previousElementSibling !== priceContainer) {
          priceContainer.insertAdjacentElement("afterend", root);
        }
        return;
      }

      const purchaseSection = this.findPurchaseSection(briefing);
      if (purchaseSection && purchaseSection !== briefing) {
        if (root.nextElementSibling !== purchaseSection) {
          purchaseSection.before(root);
        }
        return;
      }

      if (briefing) {
        const targetCol = briefing.querySelector("[class*='xvTkTc']") || briefing.querySelector("[class*='flex-column']") || briefing;
        if (!targetCol.contains(root)) {
          targetCol.appendChild(root);
        }
      }
    }

    mountPricePayout() {
      // Clean up standalone payout banner when full panel is positioned below the sales price
      const payoutEl = document.querySelector("#cl-shopee-price-payout");
      if (payoutEl) payoutEl.remove();
    }

    startMountingSequence() {
      if (this.mountTimer) {
        clearInterval(this.mountTimer);
        this.mountTimer = null;
      }

      let attempts = 0;
      const maxAttempts = 35; // 35 tentativas * 200ms = 7s

      const attemptMount = () => {
        attempts++;
        if (!PlatformDetector.isProductPage()) {
          if (this.mountTimer) {
            clearInterval(this.mountTimer);
            this.mountTimer = null;
          }
          return;
        }

        this.mount();

        const widgetMounted = Boolean(document.querySelector("#cl-shopee-pdp-widget"));
        if (widgetMounted || attempts >= maxAttempts) {
          if (this.mountTimer) {
            clearInterval(this.mountTimer);
            this.mountTimer = null;
          }
        }
      };

      attemptMount();
      if (!document.querySelector("#cl-shopee-pdp-widget")) {
        this.mountTimer = setInterval(attemptMount, 200);
      }
    }

    onUrlChanged() {
      if (!PlatformDetector.isProductPage()) {
        this.teardown();
        return;
      }

      const currentIds = PlatformDetector.getProductIds();
      const currentKey = `${currentIds.shopId}_${currentIds.itemId}`;
      if (this.lastProductId && this.lastProductId !== currentKey) {
        this.teardown();
      }
      this.lastProductId = currentKey;
      this.startMountingSequence();
    }

    handleNavigation(url) {
      this.onUrlChanged();
    }

    handleApiData(url, rawText) {
      try {
        const json = typeof rawText === "string" ? JSON.parse(rawText) : rawText;
        const ids = PlatformDetector.getProductIds();
        const parsed = ShopeeDataExtractor.extractFromJson(json, ids);
        if (!parsed) return;

        this.data = {
          ...(this.data ?? {}),
          ...parsed,
          // Preservar valores mais recentes de preço e variação se já presentes no DOM
          price: (this.data?.price && this.data.price > 0) ? this.data.price : parsed.price,
          originalPrice: (this.data?.originalPrice && this.data.originalPrice > 0) ? this.data.originalPrice : parsed.originalPrice
        };

        if (this.root && document.body.contains(this.root)) {
          this.render();
        } else if (PlatformDetector.isProductPage()) {
          this.mount();
        }
      } catch (err) {
        console.warn(`${APP}: erro ao processar dados da API Shopee`, err);
      }
    }

    mount() {
      if (!PlatformDetector.isProductPage()) {
        this.teardown();
        return;
      }

      const currentIds = PlatformDetector.getProductIds();
      const currentKey = `${currentIds.shopId}_${currentIds.itemId}`;
      if (this.lastProductId && this.lastProductId !== currentKey) {
        // Navigated to different product in SPA
        this.teardown();
      }
      this.lastProductId = currentKey;

      const structured = ShopeeDataExtractor.fromDocument();
      const domData = ShopeeDomFallbackExtractor.fromDocument();

      this.data = {
        ...(this.data ?? {}),
        ...(domData ?? {}),
        ...(structured ?? {})
      };

      // Prefer live DOM price if detected and valid
      if (domData.price > 0) {
        this.data.price = domData.price;
      }
      if (domData.originalPrice > 0) {
        this.data.originalPrice = domData.originalPrice;
      }

      if (!this.data?.price) return;

      this.mountPricePayout();

      const briefing = this.findBriefingContainer();
      if (!briefing) return;

      const existing = document.querySelector("#cl-shopee-pdp-widget");
      if (existing) {
        this.placeAnalysis(existing, briefing);
        this.root = existing;
        if (this.mountTimer) {
          clearInterval(this.mountTimer);
          this.mountTimer = null;
        }
        return;
      }

      this.root = document.createElement("section");
      this.root.id = "cl-shopee-pdp-widget";
      this.root.className = "cl-shopee-root cl-shopee-pdp-panel";
      this.placeAnalysis(this.root, briefing);
      this.render();

      if (this.mountTimer) {
        clearInterval(this.mountTimer);
        this.mountTimer = null;
      }
    }

    teardown() {
      if (this.mountTimer) {
        clearInterval(this.mountTimer);
        this.mountTimer = null;
      }
      const existing = document.querySelector("#cl-shopee-pdp-widget");
      if (existing) existing.remove();
      const payout = document.querySelector("#cl-shopee-price-payout");
      if (payout) payout.remove();
      this.root = null;
      this.data = null;
    }

    observe() {
      // Registrar listener para eventos do shopee-bridge (navegação e tráfego de API)
      window.addEventListener("message", (event) => {
        if (event.source !== window || !event.data || event.data.source !== "cl-shopee-bridge") return;
        if (event.data.type === "navigation") {
          this.handleNavigation(event.data.url);
        } else if (event.data.type === "api-data") {
          this.handleApiData(event.data.url, event.data.data);
        }
      });

      // Disparar sequência inicial de montagem
      this.startMountingSequence();

      const ensureMounted = debounce(() => {
        if (PlatformDetector.isProductPage()) {
          this.mount();
        }
      }, 250);

      this.observer = new MutationObserver((mutations) => {
        // Detect price text change or variation selection changes
        let shouldRefresh = false;
        for (const mut of mutations) {
          if (mut.type === "childList" || (mut.type === "characterData" && mut.target.textContent?.includes("R$"))) {
            shouldRefresh = true;
            break;
          }
        }
        if (shouldRefresh) ensureMounted();
      });

      this.observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });

      // Listen to popstate and history changes for Shopee SPA
      window.addEventListener("popstate", () => this.onUrlChanged());

      // Heartbeat a cada 250ms para blindagem completa contra navegação SPA
      let lastHref = location.href;
      setInterval(() => {
        if (location.href !== lastHref) {
          lastHref = location.href;
          this.onUrlChanged();
        } else if (PlatformDetector.isProductPage() && !document.querySelector("#cl-shopee-pdp-widget")) {
          this.mount();
        }
      }, 250);
    }

    render() {
      if (!this.root || !this.data?.price) return;
      const data = this.data;
      const calc = ShopeePricingEngine.calculate(this.input(data));
      this.mountPricePayout();

      const quality = ShopeeQualityEngine.evaluate(data);
      const isOfficial = data.shop?.isOfficial || data.shopIsOfficial;
      const shopLoc = data.shop?.location || data.shopLocation;

      this.root.innerHTML = `
        <header class="cl-shopee-header">
          <div class="cl-shopee-header__title">
            <span class="cl-shopee-brand-badge">SHOPEE</span>
            <h2>Calculadora Livre</h2>
          </div>
          <p class="cl-shopee-header__subtitle">Análise financeira e resumo do anúncio</p>
        </header>

        <div class="cl-shopee-payout-banner">
          <div class="cl-shopee-payout-banner__main">
            <div class="cl-shopee-payout-banner__col">
              <span class="cl-shopee-payout-banner__label">Você recebe da Shopee (estimado)</span>
              <span class="cl-shopee-payout-banner__percent">${number.format(calc.netPayoutPercent)}% do valor</span>
            </div>
            <strong class="cl-shopee-payout-banner__value">${money.format(calc.netPayout)}</strong>
          </div>
          <small class="cl-shopee-payout-banner__note">Após comissão (${number.format(calc.commissionPercent)}%${calc.isCapped ? " · Teto R$ 105 atingido" : ""}) e taxa fixa (${money.format(calc.fixedFee)}).</small>
        </div>

        <div class="cl-shopee-badges">
          <span class="cl-shopee-badge cl-shopee-badge--orange">
            🏷️ Comissão ${number.format(calc.commissionPercent)}%${calc.isCapped ? " (Teto R$ 105)" : ""}
          </span>
          <span class="cl-shopee-badge cl-shopee-badge--gray">
            📦 Taxa Fixa ${money.format(calc.fixedFee)}
          </span>
          ${isOfficial ? `<span class="cl-shopee-badge cl-shopee-badge--red">✨ Loja Oficial</span>` : ""}
          ${shopLoc ? `<span class="cl-shopee-badge">📍 ${escapeHtml(shopLoc)}</span>` : ""}
          ${data.discountText ? `<span class="cl-shopee-badge cl-shopee-badge--orange">🔥 ${escapeHtml(data.discountText)}</span>` : ""}
        </div>

        ${this.pricingHtml(calc)}

        <section class="cl-shopee-intelligence-section">
          <h3 class="cl-shopee-section-title">Inteligência completa do anúncio</h3>
          ${this.intelligenceHtml(calc)}
          
          <h3 class="cl-shopee-section-title">Qualidade do anúncio e prova social</h3>
          ${this.qualityHtml(quality)}
        </section>
      `;

      this.bind();
    }

    pricingHtml(calc) {
      const step = ShopeePricingEngine.stepOpportunity(this.input(this.data));
      const wholesale = this.data.wholesaleTiers?.[0];
      const wholesaleCalc = wholesale ? ShopeePricingEngine.calculate(this.input(this.data, { price: wholesale.price })) : null;

      const costValue = this.manualCost;
      const simulatedPriceValue = this.manualPrice === "" ? calc.price.toFixed(2) : this.manualPrice;
      const hasCost = costValue !== "" && Number.isFinite(Number(costValue));
      const cost = hasCost ? Math.max(0, Number(costValue)) : 0;

      const competitorCalc = hasCost ? ShopeePricingEngine.calculate(this.input(this.data, { productCost: cost })) : null;
      const simulatedPrice = Math.max(0, asNumber(simulatedPriceValue, calc.price));
      const simulatedCalc = hasCost ? ShopeePricingEngine.calculate(this.input(this.data, { price: simulatedPrice, productCost: cost })) : null;

      return `
        <dl class="cl-shopee-list">
          <div class="cl-shopee-row">
            <div class="cl-shopee-item__col">
              <dt>Preço de venda atual</dt>
              ${this.data.originalPrice && this.data.originalPrice > calc.price ? `
                <span class="cl-shopee-subtext">De <s>${money.format(this.data.originalPrice)}</s> (${Math.round((1 - calc.price / this.data.originalPrice) * 100)}% OFF)</span>
              ` : ""}
            </div>
            <dd><strong>${money.format(calc.price)}</strong></dd>
          </div>

          <div class="cl-shopee-row">
            <div class="cl-shopee-item__col">
              <dt>Comissão Shopee — estimada</dt>
              <span class="cl-shopee-subtext">${number.format(calc.commissionPercent)}% ${calc.isCapped ? "(Teto atingido: R$ 105,00)" : "sobre a venda"}</span>
            </div>
            <dd class="cl-shopee-negative">− ${money.format(calc.commission)}</dd>
          </div>

          <div class="cl-shopee-row">
            <div class="cl-shopee-item__col">
              <dt>Tarifa fixa por item</dt>
              <span class="cl-shopee-subtext">Taxa de transação Shopee Brasil</span>
            </div>
            <dd class="cl-shopee-negative">− ${money.format(calc.fixedFee)}</dd>
          </div>

          <div class="cl-shopee-row">
            <div class="cl-shopee-item__col">
              <dt>Imposto + publicidade + embalagem</dt>
              <span class="cl-shopee-subtext">${money.format(calc.tax)} imposto (${number.format(calc.taxPercent)}%) + ${money.format(calc.adsCost)} ads + ${money.format(calc.packagingCost)} emb.</span>
            </div>
            <dd class="cl-shopee-negative">− ${money.format(calc.extras)}</dd>
          </div>

          <div class="cl-shopee-highlight">
            <div class="cl-shopee-highlight__main">
              <div class="cl-shopee-item__col">
                <dt>Você recebe da Shopee — estimado</dt>
                <span class="cl-shopee-subtext cl-shopee-subtext--green">${number.format(calc.netPayoutPercent)}% do valor anunciado</span>
              </div>
              <dd class="cl-shopee-payout-number">${money.format(calc.netPayout)}</dd>
            </div>
            <div class="cl-shopee-net-after-costs">
              <dt>Sobra real após custos operacionais</dt>
              <dd class="${calc.availableAfterCosts < 0 ? "cl-shopee-negative" : "cl-shopee-money--green"}">
                ${money.format(calc.availableAfterCosts)}
              </dd>
            </div>
            <small class="cl-shopee-disclaimer">Nota: Saldo antes do seu custo de aquisição do produto.</small>
          </div>
        </dl>

        <div class="cl-shopee-simulator">
          <div class="cl-shopee-manual-entry">
            <label class="cl-shopee-field">
              <span class="cl-shopee-field__label">Meu custo do produto (R$)</span>
              <input class="cl-shopee-input" data-input="cost" type="number" inputmode="decimal" min="0" step="0.01" autocomplete="off" placeholder="Digite seu custo (ex: 45,00)" value="${escapeHtml(costValue)}">
            </label>
            <div class="cl-shopee-output${competitorCalc ? (competitorCalc.realProfit < 0 ? " cl-shopee-output--negative" : " cl-shopee-output--positive") : ""}" data-output="competitor">
              ${competitorCalc ? `No preço do anúncio: lucro ${money.format(competitorCalc.realProfit)} · margem ${number.format(competitorCalc.realMargin)}%` : "Informe seu custo para calcular o lucro e a margem no preço do anúncio."}
            </div>
          </div>

          <div class="cl-shopee-manual-entry">
            <label class="cl-shopee-field">
              <span class="cl-shopee-field__label">Simular meu preço de venda (R$)</span>
              <input class="cl-shopee-input" data-input="price" type="number" inputmode="decimal" min="0" step="0.01" autocomplete="off" placeholder="Digite o preço para simulação" value="${escapeHtml(simulatedPriceValue)}">
            </label>
            <div class="cl-shopee-output${simulatedCalc ? (simulatedCalc.realProfit < 0 ? " cl-shopee-output--negative" : " cl-shopee-output--positive") : ""}" data-output="simulation">
              ${simulatedCalc ? `Repasse Shopee ${money.format(simulatedCalc.netPayout)} · lucro ${money.format(simulatedCalc.realProfit)} · margem ${number.format(simulatedCalc.realMargin)}%` : "Informe seu custo para calcular o resultado deste preço."}
            </div>
          </div>
        </div>

        ${step ? `<div class="cl-shopee-step-alert">${step.message}</div>` : ""}
        ${wholesale ? `
          <div class="cl-shopee-wholesale">
            📦 <strong>Compra por quantidade / Atacado:</strong> A partir de ${wholesale.minCount} un. a ${money.format(wholesale.price)} — repasse estimado de ${money.format(wholesaleCalc.netPayout)}/un.
          </div>
        ` : ""}
      `;
    }

    intelligenceHtml(calc) {
      const data = this.data;
      const ctime = data.ctime;
      const parsedDate = ctime > 0 ? new Date(ctime < 10000000000 ? ctime * 1000 : ctime) : null;
      const hasDate = parsedDate && !isNaN(parsedDate.getTime());
      const dateLabel = hasDate ? shortDate.format(parsedDate) : "Identificando...";
      const daysActive = hasDate ? Math.max(1, Math.floor((Date.now() - parsedDate.getTime()) / 86400000)) : null;

      const soldCount = data.soldQuantity || 0;
      const salesPerDay = daysActive && soldCount > 0 ? (soldCount / daysActive) : 0;
      const salesPerMonth = salesPerDay * 30;
      const monthlyRevenue = salesPerMonth * data.price;
      const monthlyPayout = salesPerMonth * calc.netPayout;

      // Faturamento e repasse totais acumulados deste anúncio
      const totalRevenue = soldCount * data.price;
      const totalPayout = soldCount * calc.netPayout;

      // Métricas combinadas do vendedor (API bridge + DOM fallback)
      const sellerRating = data.shop?.ratingStar || data.shopRatingStar || 0;
      const sellerItems = data.shop?.itemCount || data.shopItemCount || 0;
      const sellerFollowers = data.shop?.followerCount || data.shopFollowerCount || 0;
      const sellerRespRate = data.shop?.responseRate || data.shopResponseRate || 0;
      const sellerRespTime = data.shop?.responseTime || data.shopResponseTime || "";
      const sellerLocation = data.shop?.location || data.shopLocation || "Nacional";

      return `
        <div class="cl-shopee-stats">
          <div class="cl-shopee-stat">
            <span class="cl-shopee-stat__label">Vendas acumuladas</span>
            <strong class="cl-shopee-stat__value">${escapeHtml(data.soldDisplay || number.format(soldCount))} un.</strong>
            ${data.soldIsLowerBound ? `<small class="cl-shopee-muted">Limite inferior informado</small>` : `<small class="cl-shopee-muted">Total confirmado</small>`}
          </div>

          <div class="cl-shopee-stat">
            <span class="cl-shopee-stat__label">Estoque atual</span>
            <strong class="cl-shopee-stat__value">${data.stock > 0 ? `${number.format(data.stock)} un.` : (data.hasAvailableStock ? "Disponível" : "Em estoque")}</strong>
            <small class="cl-shopee-muted">${data.stock > 0 ? money.format(data.stock * data.price) + " valor bruto" : "Estoque ativo"}</small>
          </div>

          <div class="cl-shopee-stat">
            <span class="cl-shopee-stat__label">Data do anúncio</span>
            <strong class="cl-shopee-stat__value">${escapeHtml(dateLabel)}</strong>
            <small class="cl-shopee-muted">${daysActive ? `${number.format(daysActive)} dias no ar` : (hasDate ? "Recente" : "Identificando histórico...")}</small>
          </div>

          <div class="cl-shopee-stat">
            <span class="cl-shopee-stat__label">Giro histórico</span>
            <strong class="cl-shopee-stat__value">${salesPerDay > 0 ? `${number.format(salesPerDay)} un./dia` : (soldCount > 0 ? `${number.format(soldCount)} un. acumuladas` : "—")}</strong>
            <small class="cl-shopee-muted">${salesPerMonth > 0 ? `~${number.format(salesPerMonth)} un./mês` : (soldCount > 0 ? "Giro histórico acumulado" : "Sem histórico")}</small>
          </div>

          <div class="cl-shopee-stat cl-shopee-stat--full">
            <span class="cl-shopee-stat__label">Faturamento acumulado das vendas</span>
            <strong class="cl-shopee-stat__value">${totalRevenue > 0 ? money.format(totalRevenue) : "—"}</strong>
            <small class="cl-shopee-muted">${soldCount > 0 ? `Calculado sobre ${escapeHtml(data.soldDisplay || number.format(soldCount))} un. vendidas no preço atual` : "Baseado no histórico do anúncio"}</small>
          </div>

          <div class="cl-shopee-stat cl-shopee-stat--full">
            <span class="cl-shopee-stat__label">Repasse acumulado estimado</span>
            <strong class="cl-shopee-stat__value">${totalPayout > 0 ? money.format(totalPayout) : "—"}</strong>
            <small class="cl-shopee-muted">Total que o concorrente recebeu da Shopee após taxas</small>
          </div>

          ${monthlyRevenue > 0 ? `
            <div class="cl-shopee-stat cl-shopee-stat--full">
              <span class="cl-shopee-stat__label">Faturamento mensal projetado</span>
              <strong class="cl-shopee-stat__value">${money.format(monthlyRevenue)}</strong>
              <small class="cl-shopee-muted">Giro médio mensal (~${number.format(salesPerMonth)} un./mês)</small>
            </div>
          ` : ""}
        </div>

        <h3 class="cl-shopee-section-title">Raio-X do vendedor</h3>
        <div class="cl-shopee-seller-card">
          <div class="cl-shopee-seller-header">
            <strong>${escapeHtml(data.shop?.name || data.shopName || "Loja Shopee")}</strong>
            ${data.shop?.shopId ? `<span class="cl-shopee-seller-id">(ID: ${escapeHtml(data.shop.shopId)})</span>` : ""}
            ${data.shop?.isOfficial || data.shopIsOfficial ? `<span class="cl-shopee-seller-tag">Oficial</span>` : ""}
          </div>
          <div class="cl-shopee-seller-grid">
            <div><span>Avaliações da loja:</span> <strong>${sellerRating > 0 ? `${number.format(sellerRating)} ★` : (data.ratingStar > 0 ? `${number.format(data.ratingStar)} ★` : "—")}</strong></div>
            <div><span>Produtos cadastrados:</span> <strong>${sellerItems > 0 ? number.format(sellerItems) : "—"}</strong></div>
            <div><span>Seguidores:</span> <strong>${sellerFollowers > 0 ? compact.format(sellerFollowers) : "—"}</strong></div>
            <div><span>Taxa de resposta:</span> <strong>${sellerRespRate > 0 ? `${sellerRespRate}%` : "—"}</strong></div>
            <div><span>Tempo de resposta:</span> <strong>${escapeHtml(sellerRespTime || "em poucas horas")}</strong></div>
            <div><span>Localização:</span> <strong>${escapeHtml(sellerLocation)}</strong></div>
          </div>
        </div>
      `;
    }

    qualityHtml(quality) {
      const { score, checks, socialProof } = quality;
      return `
        <div class="cl-shopee-score">
          <div class="cl-shopee-score__circle">${score}</div>
          <div class="cl-shopee-score__text">
            <strong>Score de Qualidade Shopee</strong>
            <span class="cl-shopee-muted">Critérios recomendados para aumentar a conversão do anúncio.</span>
          </div>
        </div>

        <ul class="cl-shopee-checklist">
          ${checks.map(([ok, label]) => `
            <li class="${ok ? "cl-shopee-check--ok" : "cl-shopee-check--fail"}">
              ${ok ? "✅" : "❌"} ${escapeHtml(label)}
            </li>
          `).join("")}
        </ul>

        <div class="cl-shopee-social-proof">
          <div class="cl-shopee-proof-item">
            <span class="cl-shopee-proof-label">Nota média</span>
            <strong class="cl-shopee-proof-value">${socialProof.ratingStar > 0 ? `${number.format(socialProof.ratingStar)} ★` : "—"}</strong>
          </div>
          <div class="cl-shopee-proof-item">
            <span class="cl-shopee-proof-label">Avaliações</span>
            <strong class="cl-shopee-proof-value">${socialProof.ratingCount > 0 ? compact.format(socialProof.ratingCount) : "0"}</strong>
          </div>
          <div class="cl-shopee-proof-item">
            <span class="cl-shopee-proof-label">Comentários</span>
            <strong class="cl-shopee-proof-value">${socialProof.commentCount > 0 ? compact.format(socialProof.commentCount) : "—"}</strong>
          </div>
          <div class="cl-shopee-proof-item">
            <span class="cl-shopee-proof-label">Favoritos</span>
            <strong class="cl-shopee-proof-value">${socialProof.likedCount > 0 ? compact.format(socialProof.likedCount) : "—"}</strong>
          </div>
        </div>
      `;
    }

    bind() {
      if (!this.root) return;
      const costInput = this.root.querySelector('[data-input="cost"]');
      const priceInput = this.root.querySelector('[data-input="price"]');
      const competitorOutput = this.root.querySelector('[data-output="competitor"]');
      const simulationOutput = this.root.querySelector('[data-output="simulation"]');

      if (!costInput || !priceInput) return;

      const protectInput = (event) => {
        event.stopPropagation();
        if (event.type === "keydown" && event.key === "Enter") event.preventDefault();
      };

      [costInput, priceInput].forEach((input) => {
        ["pointerdown", "mousedown", "click", "keydown", "beforeinput", "input", "change"].forEach((eventName) => {
          input.addEventListener(eventName, protectInput);
        });
      });

      const recalculate = () => {
        this.manualCost = costInput.value;
        this.manualPrice = priceInput.value;
        const hasCost = costInput.value !== "" && Number.isFinite(Number(costInput.value));

        if (!hasCost) {
          competitorOutput.textContent = "Informe seu custo para calcular o lucro e a margem no preço do anúncio.";
          simulationOutput.textContent = "Informe seu custo para calcular o resultado deste preço.";
          [competitorOutput, simulationOutput].forEach((el) => {
            el.classList.remove("cl-shopee-output--positive", "cl-shopee-output--negative");
          });
          return;
        }

        const cost = Math.max(0, Number(costInput.value));
        const competitor = ShopeePricingEngine.calculate(this.input(this.data, { productCost: cost }));
        competitorOutput.textContent = `No preço do anúncio: lucro ${money.format(competitor.realProfit)} · margem ${number.format(competitor.realMargin)}%`;
        competitorOutput.classList.toggle("cl-shopee-output--negative", competitor.realProfit < 0);
        competitorOutput.classList.toggle("cl-shopee-output--positive", competitor.realProfit >= 0);

        const simulatedPrice = Math.max(0, asNumber(priceInput.value, this.data.price));
        const simulated = ShopeePricingEngine.calculate(this.input(this.data, { price: simulatedPrice, productCost: cost }));
        simulationOutput.textContent = `Repasse Shopee ${money.format(simulated.netPayout)} · lucro ${money.format(simulated.realProfit)} · margem ${number.format(simulated.realMargin)}%`;
        simulationOutput.classList.toggle("cl-shopee-output--negative", simulated.realProfit < 0);
        simulationOutput.classList.toggle("cl-shopee-output--positive", simulated.realProfit >= 0);
      };

      costInput.addEventListener("input", recalculate);
      priceInput.addEventListener("input", recalculate);

      // Listen to variation button clicks on the Shopee page
      const variationButtons = document.querySelectorAll(
        ".product-briefing button, [class*='tier-variation'] button, [class*='variation'] button"
      );
      variationButtons.forEach((btn) => {
        btn.addEventListener("click", () => {
          setTimeout(() => {
            const domData = ShopeeDomFallbackExtractor.fromDocument();
            if (domData.price > 0 && domData.price !== this.data.price) {
              this.data.price = domData.price;
              if (domData.stock > 0) this.data.stock = domData.stock;
              this.render();
            }
          }, 150);
        });
      });
    }
  }

  // =========================================================================
  // BOOTSTRAP SHOPEE
  // =========================================================================
  async function initializeShopee() {
    if (!PlatformDetector.isShopee()) return;

    let settings = await ShopeeStorageManager.get();
    if (document.readyState === "loading") {
      await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    }

    const injector = new ShopeePdpWidgetInjector(settings);
    injector.observe();

    ShopeeStorageManager.subscribe((patch) => {
      settings = { ...settings, ...patch };
      injector.settings = settings;
      if (injector.root) injector.render();
    });
  }

  initializeShopee().catch((err) => console.error(`${APP}: falha na inicialização`, err));
})();
