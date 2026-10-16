"use strict";

(() => {
  if (globalThis.__CALCULADORA_LIVRE_ACTIVE__) return;
  globalThis.__CALCULADORA_LIVRE_ACTIVE__ = true;

  const APP = "Calculadora Livre";
  const BRIDGE_SOURCE = "calculadora-livre-page-bridge";
  const CONTENT_SOURCE = "calculadora-livre-content";
  const CARD_SELECTOR = ".ui-search-layout__item, [data-testid='items-list'] .items-with-smart-groups > .poly-card";
  const bridgeInbox = [];
  const bridgeSubscribers = new Set();

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== BRIDGE_SOURCE) return;
    if (typeof event.data.text !== "string" || event.data.text.length > 3_000_000) return;
    bridgeInbox.push(event.data);
    if (bridgeInbox.length > 20) bridgeInbox.shift();
    bridgeSubscribers.forEach((subscriber) => subscriber(event.data));
  });

  window.postMessage({ source: CONTENT_SOURCE, type: "request-snapshot" }, location.origin);
  const DEFAULT_SETTINGS = Object.freeze({
    taxPercent: 6,
    packagingCost: 1.5,
    classicCommission: 12,
    premiumCommission: 17,
    defaultWeight: 1000,
    considerSubsidy: true
  });

  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
  const compact = new Intl.NumberFormat("pt-BR", { notation: "compact", maximumFractionDigits: 1 });
  const shortDate = new Intl.DateTimeFormat("pt-BR");
  const asNumber = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[char]);
  const debounce = (fn, delay = 120) => { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; };

  class StorageManager {
    static async get() {
      try { return { ...DEFAULT_SETTINGS, ...(await chrome.storage.sync.get(DEFAULT_SETTINGS)) }; }
      catch (error) { console.warn(`${APP}: configurações padrão em uso`, error); return { ...DEFAULT_SETTINGS }; }
    }

    static subscribe(callback) {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        const patch = Object.fromEntries(Object.entries(changes).map(([key, item]) => [key, item.newValue]));
        callback(patch);
      });
    }
  }

  class MeliPricingEngine2026 {
    static PRICE_LIMITS = [19, 49, 79, 100, 120, 150, 200, Infinity];
    static WEIGHT_MATRIX = [
      [300, [5.65, 6.85, 8.15, 12.95, 14.95, 16.95, 19.05, 21.65]],
      [500, [5.95, 6.95, 8.25, 13.85, 16.15, 18.15, 20.45, 23.25]],
      [1000, [6.05, 7.15, 8.45, 14.45, 16.85, 19.05, 21.35, 24.45]],
      [1500, [6.15, 7.35, 8.65, 14.75, 17.15, 19.45, 21.75, 25.45]],
      [2000, [6.25, 7.45, 8.75, 15.05, 17.65, 19.85, 22.25, 25.55]],
      [3000, [6.35, 8.65, 9.15, 16.45, 19.15, 21.65, 24.35, 27.05]],
      [4000, [6.45, 8.75, 9.75, 17.85, 20.75, 23.35, 26.35, 29.25]],
      [5000, [6.55, 8.85, 10.25, 19.75, 22.85, 26.05, 29.25, 32.45]],
      [9000, [6.65, 8.95, 10.75, 29.35, 33.95, 38.65, 43.45, 48.25]],
      [Infinity, [6.75, 9.15, 11.25, 41.25, 47.75, 54.35, 61.15, 67.85]]
    ];

    static priceTierIndex(price) { return this.PRICE_LIMITS.findIndex((limit) => price < limit); }
    static priceTierLabel(price) { return `T${this.priceTierIndex(price) + 1}`; }

    static shippingFee(price, weightGrams = 1000, logisticType = "") {
      const p = Math.max(0, asNumber(price));
      if (logisticType === "self_service") {
        if (p < 19) return Math.min(6.25, p * .5);
        if (p < 49) return 6.65;
        if (p < 79) return 7.75;
        return 0;
      }
      const weight = Math.max(1, asNumber(weightGrams, 1000));
      const row = this.WEIGHT_MATRIX.find(([limit]) => weight <= limit) ?? this.WEIGHT_MATRIX.at(-1);
      const fee = row[1][this.priceTierIndex(p)];
      return p < 19 ? Math.min(fee, p * .5) : fee;
    }

    static calculate(input) {
      const price = Math.max(0, asNumber(input.price));
      const commissionPercent = clamp(asNumber(input.commissionPercent, 12), 0, 100);
      const taxPercent = clamp(asNumber(input.taxPercent, 6), 0, 100);
      const adsPercent = clamp(asNumber(input.adsPercent), 0, 100);
      const packagingCost = Math.max(0, asNumber(input.packagingCost, 1.5));
      const subsidy = input.considerSubsidy ? Math.max(0, asNumber(input.meliSubsidy)) : 0;
      const shippingFee = this.shippingFee(price, input.weightGrams, input.logisticType);
      const commission = price * commissionPercent / 100;
      const netPayout = price - commission - shippingFee + subsidy;
      const tax = price * taxPercent / 100;
      const adsCost = price * adsPercent / 100;
      const extras = tax + adsCost + packagingCost;
      const productCost = input.productCost === null || input.productCost === undefined || input.productCost === "" ? 0 : Math.max(0, asNumber(input.productCost));
      const realProfit = netPayout - extras - productCost;
      const realMargin = price > 0 ? realProfit / price * 100 : 0;
      return {
        price, commissionPercent, commission, shippingFee, subsidy, netPayout, tax, adsCost, extras,
        productCost, realProfit, realMargin,
        netPayoutPercent: price > 0 ? netPayout / price * 100 : 0,
        priceTier: this.priceTierLabel(price)
      };
    }

    static stepOpportunity(input) {
      const price = asNumber(input.price);
      if (price < 79 || price > 88) return null;
      const current = this.calculate(input);
      const alternative = this.calculate({ ...input, price: 78.9 });
      const difference = alternative.netPayout - current.netPayout;
      return difference > 0 ? { difference, current, alternative } : null;
    }
  }

  class NordicJsonExtractor {
    static findBalancedObject(text, start) {
      let depth = 0, inString = false, escaped = false;
      for (let index = start; index < text.length; index += 1) {
        const char = text[index];
        if (inString) {
          if (escaped) escaped = false;
          else if (char === "\\") escaped = true;
          else if (char === '"') inString = false;
          continue;
        }
        if (char === '"') inString = true;
        else if (char === "{") depth += 1;
        else if (char === "}") { depth -= 1; if (depth === 0) return text.slice(start, index + 1); }
      }
      return null;
    }

    static locateInitialState(value, seen = new WeakSet()) {
      if (!value || typeof value !== "object" || seen.has(value)) return null;
      seen.add(value);
      if (value.initialState && typeof value.initialState === "object") return value.initialState;
      for (const child of Object.values(value)) {
        const found = this.locateInitialState(child, seen);
        if (found) return found;
      }
      return null;
    }

    static parseScriptText(text) {
      if (!text) return null;
      try { const parsed = JSON.parse(text); return parsed?.appProps?.pageProps?.initialState ?? this.locateInitialState(parsed) ?? parsed; }
      catch { /* O conteúdo frequentemente é uma atribuição JavaScript. */ }
      const rootStart = text.indexOf("{");
      if (rootStart >= 0) {
        const rootText = this.findBalancedObject(text, rootStart);
        if (rootText) {
          try {
            const parsed = JSON.parse(rootText);
            return parsed?.appProps?.pageProps?.initialState ?? this.locateInitialState(parsed) ?? parsed;
          } catch { /* Procura ocorrências menores abaixo. */ }
        }
      }
      const quotedPayload = /(?:\.q|push)\(\s*(")/g;
      let quotedMatch;
      while ((quotedMatch = quotedPayload.exec(text))) {
        const quoteStart = quotedMatch.index + quotedMatch[0].lastIndexOf('"');
        let escaped = false, quoteEnd = -1;
        for (let index = quoteStart + 1; index < text.length; index += 1) {
          const char = text[index];
          if (escaped) { escaped = false; continue; }
          if (char === "\\") { escaped = true; continue; }
          if (char === '"') { quoteEnd = index; break; }
        }
        if (quoteEnd < 0) continue;
        try {
          const decoded = JSON.parse(text.slice(quoteStart, quoteEnd + 1));
          const decodedStart = decoded.indexOf("{");
          const decodedObject = decodedStart >= 0 ? this.findBalancedObject(decoded, decodedStart) : null;
          if (!decodedObject) continue;
          const parsed = JSON.parse(decodedObject);
          return parsed?.appProps?.pageProps?.initialState ?? this.locateInitialState(parsed) ?? parsed;
        } catch { /* Tenta o próximo payload serializado. */ }
      }
      const patterns = [/"initialState"\s*:/g, /initialState\s*:/g];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(text))) {
          const start = text.indexOf("{", match.index + match[0].length);
          if (start < 0) continue;
          const objectText = this.findBalancedObject(text, start);
          if (!objectText) continue;
          try { return JSON.parse(objectText); } catch { /* Tenta a próxima ocorrência. */ }
        }
      }
      return null;
    }

    static getByPath(object, path) { return path.split(".").reduce((value, key) => value?.[key], object); }

    static findObjectWithKey(root, key) {
      const queue = [root];
      const seen = new WeakSet();
      let cursor = 0;
      while (cursor < queue.length) {
        const value = queue[cursor++];
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value);
        if (Object.prototype.hasOwnProperty.call(value, key)) return value;
        for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
      }
      return null;
    }

    static extractIdentifiers(value) {
      const text = Array.isArray(value) ? value.filter(Boolean).join(" ") : String(value ?? "");
      return [...new Set((text.match(/MLBU?[-_]?\d+/gi) ?? []).map((id) => id.toUpperCase().replace(/[-_]/g, "")))];
    }

    static parseQuantity(value) {
      if (value && typeof value === "object") return this.parseQuantity(value.text ?? value.value ?? value.quantity ?? 0);
      if (Number.isFinite(Number(value))) return Number(value);
      const match = String(value ?? "").toLocaleLowerCase("pt-BR").match(/([\d.,]+)\s*(milh(?:a|ã)o|mil|mi|m)?/i);
      if (!match) return 0;
      const base = asNumber(match[1].replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", "."));
      const unit = match[2] ?? "";
      return Math.round(base * (/milh|^mi$|^m$/.test(unit) ? 1_000_000 : unit === "mil" ? 1_000 : 1));
    }

    static validDate(value) {
      if (!value) return null;
      const date = new Date(value);
      return Number.isNaN(date.valueOf()) ? null : date;
    }

    static pictureDate(value) {
      const match = String(value ?? "").match(/_(0[1-9]|1[0-2])(20\d{2})(?:\D|$)/);
      return match ? new Date(Number(match[2]), Number(match[1]) - 1, 1) : null;
    }

    static recordFromCandidate(candidate) {
      if (!candidate || typeof candidate !== "object") return null;
      const eventData = candidate.event_data && typeof candidate.event_data === "object" ? candidate.event_data : candidate;
      const identifierValues = [candidate.id, candidate.item_id, candidate.itemId, candidate.pid, candidate.pid_extended, candidate.user_product_id, candidate.permalink, candidate.url, eventData.id, eventData.item_id, eventData.user_product_id];
      const identifiers = this.extractIdentifiers(identifierValues);
      if (!identifiers.length) return null;

      const soldQuantity = this.parseQuantity(eventData.sold_quantity ?? candidate.sold_quantity);
      const explicitCreationDate = this.validDate(eventData.date_created ?? eventData.start_time ?? candidate.date_created ?? candidate.start_time);
      const pictureId = eventData.picture_id ?? candidate.picture_id ?? eventData.thumbnail_id ?? candidate.thumbnail_id
        ?? eventData.pictures?.[0]?.id ?? candidate.pictures?.[0]?.id ?? eventData.gallery?.pictures?.[0]?.id ?? candidate.gallery?.pictures?.[0]?.id ?? "";
      const estimatedCreationDate = this.pictureDate(pictureId);
      const creationDate = explicitCreationDate ?? estimatedCreationDate;
      if (!soldQuantity && !creationDate) return null;
      const price = asNumber(candidate.components?.price?.price?.value ?? candidate.schema?.[0]?.offers?.price ?? eventData.price?.value ?? eventData.price ?? candidate.price?.value ?? candidate.price);
      const estimatedDaysActive = creationDate ? Math.max(1, Math.ceil((Date.now() - creationDate.valueOf()) / 86400000)) : 0;
      const salesPerDay = soldQuantity && estimatedDaysActive ? soldQuantity / estimatedDaysActive : 0;
      const domainId = eventData.domain_id ?? candidate.domain_id ?? candidate.domainId ?? "";
      const categoryId = eventData.category_id ?? candidate.category_id ?? candidate.categoryId ?? "";
      const categoryName = candidate.category_name ?? eventData.category_name ?? "";
      const brand = eventData.brand ?? candidate.brand ?? candidate.components?.header?.brand?.text ?? "";
      const dataQuality = explicitCreationDate && soldQuantity ? "complete" : (creationDate ? "estimated" : "basic");
      return {
        identifiers,
        title: eventData.title ?? candidate.title ?? candidate.components?.header?.title?.text ?? candidate.schema?.[0]?.name ?? "",
        price,
        soldQuantity,
        creationDate,
        creationDateIsEstimated: !explicitCreationDate,
        estimatedDaysActive,
        salesPerDay,
        salesPerMonth: salesPerDay * 30,
        monthlyRevenue: salesPerDay * 30 * price,
        advancedSource: explicitCreationDate ? "structured" : "picture-date",
        domainId,
        categoryId,
        categoryName,
        brand,
        dataQuality
      };
    }

    static collectSearchRecords(root) {
      if (!root || typeof root !== "object") return [];
      const queue = [root];
      const seen = new WeakSet();
      const byIdentifier = new Map();
      let visited = 0, cursor = 0;
      while (cursor < queue.length && visited < 120_000) {
        const value = queue[cursor++];
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value); visited += 1;
        const record = this.recordFromCandidate(value);
        if (record) {
          const previous = record.identifiers.map((id) => byIdentifier.get(id)).find(Boolean);
          const merged = previous ? {
            ...previous,
            ...record,
            identifiers: [...new Set([...previous.identifiers, ...record.identifiers])],
            title: record.title || previous.title,
            price: record.price || previous.price,
            soldQuantity: record.soldQuantity || previous.soldQuantity,
            creationDate: record.creationDate ?? previous.creationDate,
            creationDateIsEstimated: record.creationDate ? record.creationDateIsEstimated : previous.creationDateIsEstimated,
            estimatedDaysActive: record.estimatedDaysActive || previous.estimatedDaysActive,
            salesPerDay: record.salesPerDay || previous.salesPerDay,
            salesPerMonth: record.salesPerMonth || previous.salesPerMonth,
            monthlyRevenue: record.monthlyRevenue || previous.monthlyRevenue,
            advancedSource: record.advancedSource || previous.advancedSource,
            domainId: record.domainId || previous.domainId || "",
            categoryId: record.categoryId || previous.categoryId || "",
            categoryName: record.categoryName || previous.categoryName || "",
            brand: record.brand || previous.brand || "",
            dataQuality: record.dataQuality || previous.dataQuality || "basic"
          } : record;
          merged.identifiers.forEach((id) => byIdentifier.set(id, merged));
        }
        for (const child of Object.values(value)) if (child && typeof child === "object") queue.push(child);
      }
      return [...new Set(byIdentifier.values())];
    }

    static decodedTransportPayloads(text) {
      const payloads = [text];
      const pattern = /(?:\.q|push)\(\s*(")/g;
      let match;
      while ((match = pattern.exec(text))) {
        const quoteStart = match.index + match[0].lastIndexOf('"');
        let escaped = false, quoteEnd = -1;
        for (let index = quoteStart + 1; index < text.length; index += 1) {
          const char = text[index];
          if (escaped) { escaped = false; continue; }
          if (char === "\\") { escaped = true; continue; }
          if (char === '"') { quoteEnd = index; break; }
        }
        if (quoteEnd < 0) continue;
        try {
          const decoded = JSON.parse(text.slice(quoteStart, quoteEnd + 1));
          if (decoded && decoded.length <= 3_000_000) payloads.push(decoded);
        } catch { /* Payload não compatível com uma string JSON. */ }
      }
      return payloads;
    }

    static collectSearchRecordsFromText(text) {
      const records = [];
      for (const payload of this.decodedTransportPayloads(text)) {
        const soldPattern = /"sold_quantity"\s*:\s*(?:\{[^{}]{0,240}?"text"\s*:\s*"([^"]+)"[^{}]*\}|"([^"]+)"|(\d+(?:\.\d+)?))/g;
        let soldMatch;
        while ((soldMatch = soldPattern.exec(payload))) {
          const soldQuantity = this.parseQuantity(soldMatch[1] ?? soldMatch[2] ?? soldMatch[3]);
          if (!soldQuantity) continue;
          const start = Math.max(0, soldMatch.index - 1200);
          const end = Math.min(payload.length, soldMatch.index + soldMatch[0].length + 1200);
          const segment = payload.slice(start, end);
          const relativeSold = soldMatch.index - start;
          const identifierFields = [...segment.matchAll(/"(?:id|item_id|itemId|pid|pid_extended|user_product_id)"\s*:\s*"([^"]+)"/g)]
            .map((match) => ({ distance: Math.abs(match.index - relativeSold), value: match[1] }))
            .filter((item) => item.distance <= 700)
            .sort((a, b) => a.distance - b.distance);
          const identifiers = this.extractIdentifiers(identifierFields.slice(0, 3).map((item) => item.value));
          if (!identifiers.length) continue;
          const nearest = (pattern, maxDistance = 1200) => [...segment.matchAll(pattern)]
            .map((match) => ({ distance: Math.abs(match.index - relativeSold), value: match[1] }))
            .filter((item) => item.distance <= maxDistance)
            .sort((a, b) => a.distance - b.distance)[0]?.value;
          const pictureId = nearest(/"(?:picture_id|thumbnail_id)"\s*:\s*"([^"]+)"/g);
          const dateValue = nearest(/"(?:date_created|start_time)"\s*:\s*"([^"]+)"/g);
          const priceValue = nearest(/"price"\s*:\s*(?:\{[^{}]{0,100}?"value"\s*:\s*)?(\d+(?:\.\d+)?)/g, 800);
          const title = nearest(/"title"\s*:\s*"([^"]+)"/g, 1000) ?? "";
          const explicitCreationDate = this.validDate(dateValue);
          const creationDate = explicitCreationDate ?? this.pictureDate(pictureId);
          const estimatedDaysActive = creationDate ? Math.max(1, Math.ceil((Date.now() - creationDate.valueOf()) / 86400000)) : 0;
          const salesPerDay = estimatedDaysActive ? soldQuantity / estimatedDaysActive : 0;
          const price = asNumber(priceValue);
          const domainId = nearest(/"domain_id"\s*:\s*"([^"]+)"/g, 1500) ?? "";
          const categoryId = nearest(/"category_id"\s*:\s*"([^"]+)"/g, 1500) ?? "";
          const categoryName = nearest(/"category_name"\s*:\s*"([^"]+)"/g, 1500) ?? "";
          const brand = nearest(/"brand"\s*:\s*"([^"]+)"/g, 1500) ?? "";
          records.push({
            identifiers, title, price, soldQuantity, creationDate,
            creationDateIsEstimated: !explicitCreationDate,
            estimatedDaysActive, salesPerDay, salesPerMonth: salesPerDay * 30,
            monthlyRevenue: salesPerDay * 30 * price,
            advancedSource: explicitCreationDate ? "structured" : "picture-date",
            domainId,
            categoryId,
            categoryName,
            brand,
            dataQuality: explicitCreationDate ? "complete" : "estimated"
          });
        }
      }
      return records;
    }

    static normalize(initialState) {
      if (!initialState) return null;
      const components = initialState.components ?? {};
      const track = initialState.track ?? components.track ?? this.findObjectWithKey(initialState, "melidata_event")?.track ?? this.findObjectWithKey(initialState, "event_data");
      const eventData = track?.melidata_event?.event_data ?? track?.event_data ?? initialState?.track?.melidata_event?.event_data ?? {};
      const gallery = components.gallery ?? eventData.gallery ?? {};
      const promotions = Array.isArray(eventData.available_promotions) ? eventData.available_promotions : [];
      const promotion = promotions[0] ?? {};
      const recommended = eventData.credit_view_components?.pricing?.recommended_methods?.[0] ?? {};
      const shortcuts = components.price_per_quantity_shortcuts?.shortcuts ?? [];
      const reviewsComponent = components.reviews_capability_v3 ?? this.findObjectWithKey(components, "reviews_capability_v3")?.reviews_capability_v3;
      const reviews = reviewsComponent?.reviews ?? [];
      const reviewDates = reviews.map((review) => review?.track?.event_data?.review?.created_date).filter(Boolean).map((date) => new Date(date)).filter((date) => !Number.isNaN(date.valueOf()));
      const oldestReview = reviewDates.length ? new Date(Math.min(...reviewDates.map(Number))) : null;
      const firstPictureId = gallery?.pictures?.[0]?.id ?? eventData.gallery?.pictures?.[0]?.id ?? "";
      const firstPictureDate = this.pictureDate(firstPictureId);
      const candidateDates = [oldestReview, firstPictureDate].filter(Boolean);
      const oldestDate = candidateDates.length ? new Date(Math.min(...candidateDates.map(Number))) : null;
      const explicitCreationValue = eventData.date_created ?? eventData.start_time
        ?? this.findObjectWithKey(initialState, "date_created")?.date_created
        ?? this.findObjectWithKey(initialState, "start_time")?.start_time;
      const parsedCreationDate = explicitCreationValue ? new Date(explicitCreationValue) : null;
      const explicitCreationDate = parsedCreationDate && !Number.isNaN(parsedCreationDate.valueOf()) ? parsedCreationDate : null;
      const creationDate = explicitCreationDate ?? oldestDate;
      const creationDateIsEstimated = !explicitCreationDate;
      const estimatedDaysActive = creationDate ? Math.max(1, Math.ceil((Date.now() - creationDate.valueOf()) / 86400000)) : 0;
      const soldQuantity = asNumber(eventData.sold_quantity);

      const priceComponent = components.price ?? {};
      const lightningComponent = components.lightning_promotions ?? {};
      const schemaOffer = (Array.isArray(initialState.schema) ? initialState.schema : [initialState.schema]).map((s) => s?.offers).find(Boolean) ?? {};

      const componentPrice = asNumber(priceComponent.price?.value);
      const schemaPrice = asNumber(schemaOffer.price);
      const eventPrice = asNumber(eventData.price);
      const price = componentPrice || schemaPrice || eventPrice;

      const componentOriginal = asNumber(priceComponent.price?.original_value);
      const eventOriginal = asNumber(eventData.original_price);
      const promoOriginal = asNumber(promotion.original_value);
      const originalPrice = componentOriginal || promoOriginal || eventOriginal;

      const isLightning = lightningComponent.state === "VISIBLE"
        || /rel[aâ]mpago/i.test(lightningComponent.promotion_title?.accessibility_text ?? "")
        || promotions.some((p) => p.type === "lightning");
      const campaignType = isLightning ? "lightning" : (promotion.type ?? "");

      const otherMethodsPrice = asNumber(priceComponent.subtitles?.[0]?.values?.total_price?.value) || eventPrice;
      const pixDiscount = asNumber(priceComponent.price_breakdown?.discount?.action?.track?.melidata_event?.event_data?.campaigns?.[0]?.amount?.value);

      const salesPerDay = estimatedDaysActive > 0 ? soldQuantity / estimatedDaysActive : 0;
      const fulfillmentOrigin = eventData.shipping_promise?.address_options?.[0]?.origins?.[0];
      const tags = Array.isArray(eventData.tags) ? eventData.tags : [];
      const subtitles = Array.isArray(eventData.subtitle_types) ? eventData.subtitle_types : [];
      const reviewRate = asNumber(eventData.review_rate ?? reviewsComponent?.rating_average);
      const reviewCount = asNumber(reviewsComponent?.reviews_count ?? reviewsComponent?.total ?? reviews.length);
      const title = eventData.title ?? initialState.title ?? components.header?.title?.text ?? initialState.schema?.[0]?.name ?? "";

      return {
        hasDeepData: true,
        title,
        itemId: eventData.item_id ?? "", userProductId: eventData.user_product_id ?? "", familyId: eventData.family_id ?? "",
        pageType: eventData.page_type ?? "", categoryId: eventData.category_id ?? "", domainId: eventData.domain_id ?? "",
        price, otherMethodsPrice, pixDiscount, originalPrice, meliSubsidy: asNumber(promotion.discount_meli_amount),
        campaignType, wholesaleShortcuts: shortcuts.map((item) => ({ quantity: asNumber(item.quantity), price: asNumber(item.price?.value) })).filter((item) => item.quantity && item.price),
        installments: { installments: asNumber(recommended.installments), installmentAmount: asNumber(recommended.installment_amount), isFreeInstallment: Boolean(recommended.is_free_installment) },
        listingTypeId: eventData.listing_type_id ?? "gold_special", logisticType: eventData.logistic_type ?? "", shippingMode: eventData.shipping_mode ?? "",
        billableWeightGrams: asNumber(eventData.shipping_promise?.billable_weight, 0), fulfillmentCenter: fulfillmentOrigin?.value ?? "",
        fulfillmentCity: fulfillmentOrigin?.city?.name ?? eventData.shipping_promise?.address_options?.[0]?.city?.name ?? "", freeShipping: Boolean(eventData.free_shipping),
        soldQuantity, availableStock: asNumber(eventData.quantity), firstPictureDate, oldestReviewDate: oldestReview, oldestDate,
        creationDate, creationDateIsEstimated, estimatedDaysActive,
        salesPerDay, salesPerMonth: salesPerDay * 30, monthlyRevenue: salesPerDay * 30 * price,
        sellerId: eventData.seller_id ?? "", sellerName: eventData.seller_name ?? "", reputationLevel: eventData.reputation_level ?? "",
        powerSellerStatus: eventData.power_seller_status ?? "", hasNfe: subtitles.includes("BILLING"), hasClips: tags.includes("has_published_clips"),
        hasGoodThumbnail: tags.includes("good_quality_thumbnail"), picturesCount: asNumber(eventData.gallery?.pictures_count ?? gallery?.pictures_count ?? gallery?.pictures?.length),
        reviewRate, reviewCount, raw: initialState
      };
    }

    static collectCatalogMetadata(root) {
      if (!root || typeof root !== "object") return [];
      const queue = [root];
      const seen = new WeakSet();
      const items = [];
      let visited = 0, cursor = 0;
      while (cursor < queue.length && visited < 120_000) {
        const value = queue[cursor++];
        if (!value || typeof value !== "object" || seen.has(value)) continue;
        seen.add(value); visited += 1;

        const eventData = value.event_data && typeof value.event_data === "object" ? value.event_data : value;
        const domainId = eventData.domain_id ?? value.domain_id ?? value.domainId ?? "";
        const categoryId = eventData.category_id ?? value.category_id ?? value.categoryId ?? "";
        const categoryName = value.category_name ?? eventData.category_name ?? "";
        const brand = eventData.brand ?? value.brand ?? value.components?.header?.brand?.text ?? "";

        if (domainId || categoryId || categoryName || brand) {
          const identifierValues = [value.id, value.item_id, value.itemId, value.pid, value.pid_extended, value.user_product_id, value.permalink, value.url, eventData.id, eventData.item_id, eventData.user_product_id];
          const identifiers = this.extractIdentifiers(identifierValues);
          const title = eventData.title ?? value.title ?? value.components?.header?.title?.text ?? value.schema?.[0]?.name ?? "";
          if (identifiers.length || title) {
            items.push({
              identifiers,
              title,
              domainId,
              categoryId,
              categoryName,
              brand
            });
          }
        }

        for (const child of Object.values(value)) {
          if (child && typeof child === "object") queue.push(child);
        }
      }
      return items;
    }

    static collectCatalogMetadataFromText(text) {
      const items = [];
      if (!text || typeof text !== "string") return items;
      for (const payload of this.decodedTransportPayloads(text)) {
        const pattern1 = /"(?:id|item_id)"\s*:\s*"(MLB\d+)"[^{}]{0,500}?"(?:domain_id|category_id)"\s*:\s*"([^"]+)"/g;
        let m1;
        while ((m1 = pattern1.exec(payload))) {
          const isDomain = m1[0].includes("domain_id");
          items.push({
            identifiers: [m1[1]],
            title: "",
            domainId: isDomain ? m1[2] : "",
            categoryId: !isDomain ? m1[2] : "",
            categoryName: "",
            brand: ""
          });
        }
        const pattern2 = /"(?:domain_id|category_id)"\s*:\s*"([^"]+)"[^{}]{0,500}?"(?:id|item_id)"\s*:\s*"(MLB\d+)"/g;
        let m2;
        while ((m2 = pattern2.exec(payload))) {
          const isDomain = m2[0].includes("domain_id");
          items.push({
            identifiers: [m2[2]],
            title: "",
            domainId: isDomain ? m2[1] : "",
            categoryId: !isDomain ? m2[1] : "",
            categoryName: "",
            brand: ""
          });
        }
      }
      return items;
    }

    static fromDocument(documentNode = document) {
      const script = documentNode.querySelector("#__NORDIC_RENDERING_CTX__");
      return this.normalize(this.parseScriptText(script?.textContent ?? ""));
    }

    static fromText(text) {
      const parsed = this.parseScriptText(text);
      return {
        root: parsed,
        pdp: this.normalize(parsed),
        searchRecords: [...this.collectSearchRecords(parsed), ...this.collectSearchRecordsFromText(text)],
        catalogItems: [...this.collectCatalogMetadata(parsed), ...this.collectCatalogMetadataFromText(text)]
      };
    }

    static fromHtml(html) {
      const parsed = new DOMParser().parseFromString(html, "text/html");
      const results = [...parsed.querySelectorAll("script")]
        .map((script) => script.textContent ?? "")
        .filter((text) => /sold_quantity|date_created|start_time|item_id|picture_id|__NORDIC/i.test(text))
        .map((text) => this.fromText(text));
      const score = (data) => [data?.itemId, data?.price, data?.soldQuantity, data?.creationDate, data?.billableWeightGrams].filter(Boolean).length;
      const pdp = results.map((result) => result.pdp).filter(Boolean).sort((a, b) => score(b) - score(a))[0];
      if (pdp && score(pdp) >= 3) return pdp;
      const record = results.flatMap((result) => result.searchRecords).sort((a, b) => score(b) - score(a))[0];
      if (!record) return pdp ?? null;
      return {
        ...(pdp ?? {}), hasDeepData: true, title: record.title, itemId: record.identifiers.find((id) => /^MLB\d+$/.test(id)) ?? "",
        price: record.price, soldQuantity: record.soldQuantity, creationDate: record.creationDate,
        creationDateIsEstimated: record.creationDateIsEstimated, estimatedDaysActive: record.estimatedDaysActive,
        salesPerDay: record.salesPerDay, salesPerMonth: record.salesPerMonth, monthlyRevenue: record.monthlyRevenue
      };
    }
  }

  class CategoryIntelligenceExtractor {
    static DOMAIN_NAMES = {
      "MLB-COLLECTIBLE_CARD_GAMES": "Cartas Colecionáveis (TCG)",
      "MLB-ACTION_FIGURES": "Bonecos e Figuras de Ação",
      "MLB-PLUSH_TOYS": "Pelúcias",
      "MLB-BOARD_GAMES": "Jogos de Tabuleiro",
      "MLB-SMARTWATCHES": "Smartwatches e Pulseiras",
      "MLB-WRISTWATCHES": "Relógios de Pulso",
      "MLB-HEADPHONES": "Fones de Ouvido",
      "MLB-CELLPHONES": "Celulares e Smartphones",
      "MLB-SNEAKERS": "Tênis e Calçados",
      "MLB-T_SHIRTS": "Camisetas e Roupas",
      "MLB-SUPPLEMENTS": "Suplementos Alimentares",
      "MLB-THERMAL_BOTTLES": "Garrafas Térmicas",
      "MLB-BACKPACKS": "Mochilas e Bolsas",
      "MLB-VIDEO_GAMES": "Videogames e Consoles",
      "MLB-DOLLS": "Bonecas e Acessórios",
      "MLB-SUNGLASSES": "Óculos de Sol",
      "MLB-TABLETS": "Tablets",
      "MLB-NOTEBOOKS": "Notebooks e Laptops",
      "MLB-BEAUTY_AND_PERSONAL_CARE": "Beleza e Cuidado Pessoal",
      "MLB-AUTO_PARTS": "Peças Automotivas",
      "MLB-TOOLS": "Ferramentas",
      "MLB-LAMPS": "Lâmpadas e Iluminação",
      "MLB-ALBUMS": "Álbuns e Figurinhas",
      "MLB-BUILDING_SETS": "Brinquedos de Montar",
      "MLB-FIDGET_TOYS": "Anti-stress e Engenho"
    };

    static normalizeDomainName(domainId, fallback = "") {
      if (!domainId) return fallback || "Geral";
      const raw = String(domainId).toUpperCase().trim();
      const withPrefix = raw.startsWith("MLB-") ? raw : `MLB-${raw}`;
      const withoutPrefix = raw.replace(/^ML[A-Z]-/, "");
      if (this.DOMAIN_NAMES[withPrefix]) return this.DOMAIN_NAMES[withPrefix];
      if (this.DOMAIN_NAMES[raw]) return this.DOMAIN_NAMES[raw];
      if (this.DOMAIN_NAMES[withoutPrefix]) return this.DOMAIN_NAMES[withoutPrefix];
      const cleaned = withoutPrefix.replace(/_/g, " ").toLowerCase();
      if (!cleaned) return fallback || "Geral";
      return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    }

    static getCategoryKeywords(categoryName) {
      if (!categoryName) return [];
      const lower = categoryName.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const keywords = [lower];

      lower.split(/\s+/).forEach((w) => {
        if (w.length >= 4 && !["para", "com", "sem", "sobre", "jogos"].includes(w)) {
          keywords.push(w);
          if (w.endsWith("s")) keywords.push(w.slice(0, -1));
        }
      });

      if (lower.includes("cartas") || lower.includes("tabuleiro") || lower.includes("jogos")) {
        keywords.push("carta", "cartas", "cartinhas", "tcg", "booster", "blister", "deck", "baralho", "tabuleiro", "copag", "monopoly");
      }
      if (lower.includes("boneco") || lower.includes("figura") || lower.includes("boneca")) {
        keywords.push("boneco", "boneca", "bonecos", "bonecas", "action figure", "figure", "miniatura", "miniaturas", "pokebola", "pokébola", "pokeball", "funko", "pop", "articulado", "takara tomy");
      }
      if (lower.includes("pelucia")) {
        keywords.push("pelucia", "pelúcia", "pelucias", "pelúcias", "plush", "pantufa");
      }
      if (lower.includes("album") || lower.includes("figurinha")) {
        keywords.push("album", "álbum", "albuns", "álbuns", "figurinha", "figurinhas", "fichario", "fichário");
      }
      if (lower.includes("montar")) {
        keywords.push("montar", "lego", "bloco", "blocos", "nanoblock");
      }
      if (lower.includes("anti-stress") || lower.includes("engenho")) {
        keywords.push("stress", "fidget", "spinner", "cubo magico", "cubo mágico", "pop it");
      }
      if (lower.includes("celular") || lower.includes("smartphone")) {
        keywords.push("celular", "celulares", "smartphone", "smartphones", "iphone", "galaxy", "xiaomi", "motorola");
      }
      if (lower.includes("relogio") || lower.includes("smartwatch")) {
        keywords.push("smartwatch", "relogio", "relógio", "pulseira", "smart band");
      }
      if (lower.includes("tenis") || lower.includes("calcado")) {
        keywords.push("tenis", "tênis", "calcado", "calçado", "sapato", "sneaker", "chuteira");
      }
      if (lower.includes("fone") || lower.includes("audio")) {
        keywords.push("fone", "fones", "headphone", "headset", "earbuds", "airpods");
      }
      if (lower.includes("roupa") || lower.includes("camiseta") || lower.includes("camisa")) {
        keywords.push("camisa", "camiseta", "blusa", "casaco", "jaqueta", "calca", "calça", "vestido");
      }

      return [...new Set(keywords)];
    }

    static classifyByTaxonomy(text) {
      if (!text) return null;
      const lower = text.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const taxonomies = [
        { key: "MLB-COLLECTIBLE_CARD_GAMES", name: "Cartas Colecionáveis (TCG)", match: /\b(tcg|cartas?|cartinhas?|boosters?|blisters?|decks?|baralhos?|copag)\b/ },
        { key: "MLB-PLUSH_TOYS", name: "Pelúcias", match: /\b(pelucias?|plush)\b/ },
        { key: "MLB-ACTION_FIGURES", name: "Bonecos e Figuras de Ação", match: /\b(action figure|figures?|bonecos?|bonecas?|miniaturas?|pokebolas?|pokeballs?|funko|funkos?)\b/ },
        { key: "MLB-BOARD_GAMES", name: "Jogos de Tabuleiro", match: /\b(tabuleiro|board games?|monopoly|war|banco imobiliario)\b/ },
        { key: "MLB-ALBUMS", name: "Álbuns e Figurinhas", match: /\b(albuns?|figurinhas?|ficharios?)\b/ },
        { key: "MLB-SMARTWATCHES", name: "Smartwatches e Pulseiras", match: /\b(smartwatch(es)?|relogio inteligente|smart band|pulseira inteligente)\b/ },
        { key: "MLB-HEADPHONES", name: "Fones de Ouvido", match: /\b(fones? de ouvido|headphones?|headsets?|earbuds?|airpods?)\b/ },
        { key: "MLB-CELLPHONES", name: "Celulares e Smartphones", match: /\b(smartphones?|celulares?|iphone|galaxy|redmi|poco)\b/ },
        { key: "MLB-SNEAKERS", name: "Tênis e Calçados", match: /\b(tenis|sneakers?|sapatos?|sandalias?|chuteiras?)\b/ },
        { key: "MLB-VIDEO_GAMES", name: "Videogames e Consoles", match: /\b(nintendo switch|playstation|ps4|ps5|xbox|jogos? ps|jogos? switch)\b/ }
      ];

      for (const tax of taxonomies) {
        if (tax.match.test(lower)) {
          return {
            key: tax.key,
            domainId: tax.key,
            categoryId: "",
            name: tax.name
          };
        }
      }
      return null;
    }

    static classifyItemCategory(it, searchContext) {
      const data = it?.data || {};
      const adv = it?.advanced || {};

      // 1. Explicit domainId
      const domainId = adv.domainId || data.domainId || "";
      if (domainId) {
        return {
          key: domainId,
          domainId,
          categoryId: adv.categoryId || data.categoryId || "",
          name: this.normalizeDomainName(domainId)
        };
      }

      // 2. Explicit categoryName (if not generic)
      const categoryName = adv.categoryName || data.categoryName || "";
      if (categoryName && !/^(geral|outros|principal)/i.test(categoryName.trim())) {
        return {
          key: categoryName,
          domainId: "",
          categoryId: adv.categoryId || data.categoryId || "",
          name: categoryName
        };
      }

      // 3. Explicit categoryId matching official filters
      const catFilters = searchContext?.filters?.find((f) => /categor/i.test(f.name))?.values || [];
      const categoryId = adv.categoryId || data.categoryId || "";
      if (categoryId) {
        const matchedFilter = catFilters.find((v) => (v.id && v.id === categoryId) || (v.applied_value_id && v.applied_value_id === categoryId));
        if (matchedFilter?.name) {
          return {
            key: matchedFilter.name,
            domainId: "",
            categoryId,
            name: matchedFilter.name
          };
        }
        const normalized = this.normalizeDomainName(categoryId, "");
        if (normalized && normalized !== "Geral") {
          return {
            key: categoryId,
            domainId: "",
            categoryId,
            name: normalized
          };
        }
      }

      // 4. Semantic matching against official search categories from the sidebar
      const title = (data.title || adv.title || "").toLowerCase();
      const permalink = (data.permalink || "").toLowerCase();
      const combined = `${title} ${permalink}`;

      if (catFilters.length > 0) {
        const sortedFilters = [...catFilters].sort((a, b) => (b.name?.length || 0) - (a.name?.length || 0));
        for (const filterVal of sortedFilters) {
          const filterName = filterVal.name;
          if (!filterName) continue;
          const kws = this.getCategoryKeywords(filterName);
          if (kws.some((kw) => combined.includes(kw))) {
            return {
              key: filterName,
              domainId: "",
              categoryId: filterVal.id || "",
              name: filterName
            };
          }
        }
      }

      // 5. Taxonomy matching for standard e-commerce verticals
      const tax = this.classifyByTaxonomy(combined);
      if (tax) {
        return tax;
      }

      // 6. Fallback
      const fallback = searchContext?.categoryName && !/^(geral|busca|resultados)/i.test(searchContext.categoryName)
        ? searchContext.categoryName
        : "Geral / Principal";

      return {
        key: fallback === "Geral / Principal" ? "GERAL" : fallback,
        domainId: "",
        categoryId: "",
        name: fallback
      };
    }

    static extractAppliedValueResults(urlOrObjOrStr) {
      if (!urlOrObjOrStr) return null;
      if (typeof urlOrObjOrStr === "object") {
        if (Number.isFinite(Number(urlOrObjOrStr.applied_value_results))) return Number(urlOrObjOrStr.applied_value_results);
        if (Number.isFinite(Number(urlOrObjOrStr.results))) return Number(urlOrObjOrStr.results);
        if (urlOrObjOrStr.url) return this.extractAppliedValueResults(urlOrObjOrStr.url);
      }
      const str = String(urlOrObjOrStr);
      const matchParam = str.match(/[?&]applied_value_results=(\d+)/i) || str.match(/_applied_value_results_(\d+)/i);
      if (matchParam) return Number(matchParam[1]);
      const matchResults = str.match(/[?&]results=(\d+)/i);
      if (matchResults) return Number(matchResults[1]);
      const matchParen = str.match(/\((\d[\d.,]*)\)/);
      if (matchParen) return Number(matchParen[1].replace(/\D/g, ""));
      return null;
    }

    static extractSearchContext(nordicRoot, doc = (typeof document !== "undefined" ? document : null)) {
      const context = {
        totalResults: 0,
        categoryId: "",
        categoryName: "",
        domainId: "",
        domainName: "",
        filters: [],
        appliedFilters: [],
        relatedSearches: []
      };

      try {
        if (nordicRoot) {
          const pagination = nordicRoot.pagination ?? nordicRoot.paging ?? nordicRoot.components?.pagination;
          if (pagination?.total) context.totalResults = asNumber(pagination.total);
          else if (nordicRoot.results?.length) context.totalResults = nordicRoot.results.length;

          const categoryObj = nordicRoot.category ?? nordicRoot.category_id ?? nordicRoot.components?.category;
          if (typeof categoryObj === "object" && categoryObj) {
            context.categoryId = categoryObj.id || "";
            context.categoryName = categoryObj.name || "";
          } else if (typeof categoryObj === "string") {
            context.categoryId = categoryObj;
          }
          if (nordicRoot.domain_id) {
            context.domainId = nordicRoot.domain_id;
            context.domainName = this.normalizeDomainName(nordicRoot.domain_id);
          }
        }

        if (!context.totalResults && doc) {
          const qtyText = doc.querySelector(".ui-search-search-result__quantity-results")?.textContent ?? "";
          const qtyMatch = qtyText.match(/([\d.,]+)\s*resultado/i);
          if (qtyMatch) {
            context.totalResults = asNumber(qtyMatch[1].replace(/\./g, "").replace(",", "."));
          }
        }

        if (!context.categoryName && doc) {
          const breadcrumbs = [...doc.querySelectorAll(".andes-breadcrumb__item, .ui-search-breadcrumb__item")];
          if (breadcrumbs.length) {
            const lastBreadcrumb = breadcrumbs[breadcrumbs.length - 1]?.textContent?.trim();
            if (lastBreadcrumb) context.categoryName = lastBreadcrumb;
          }
        }

        const filtersMap = new Map();

        if (nordicRoot) {
          const sidebarFilters = nordicRoot.sidebar?.filters ?? nordicRoot.filters ?? nordicRoot.available_filters ?? nordicRoot.components?.sidebar?.filters ?? [];
          if (Array.isArray(sidebarFilters)) {
            sidebarFilters.forEach((grp) => {
              if (!grp || !grp.name) return;
              const groupName = grp.name;
              const values = (grp.values ?? grp.applied_values ?? []).map((val) => {
                const count = this.extractAppliedValueResults(val);
                const valId = val.id || val.value_id || val.applied_value_id || "";
                return {
                  id: valId,
                  name: val.name || String(val),
                  count: count || 0,
                  isActive: Boolean(val.applied || val.is_applied || grp.applied_values?.includes(val))
                };
              });
              if (values.length) filtersMap.set(groupName, { name: groupName, values });
            });
          }
        }

        if (doc && (!filtersMap.size || filtersMap.size < 3)) {
          const domGroups = doc.querySelectorAll(".ui-search-filter-dl, .ui-search-filter-group");
          domGroups.forEach((groupEl) => {
            const titleEl = groupEl.querySelector(".ui-search-filter-dt-title, .ui-search-filter-group-title, h3, h4");
            const groupName = titleEl?.textContent?.trim() || "";
            if (!groupName || groupName.length > 40) return;

            const items = [...groupEl.querySelectorAll(".ui-search-filter-container, li.ui-search-filter-item")];
            const values = items.map((itemEl) => {
              const nameEl = itemEl.querySelector(".ui-search-filter-name");
              const valName = nameEl?.textContent?.trim() || itemEl.textContent?.trim()?.split("(")[0]?.trim() || "";
              const link = itemEl.querySelector("a");
              const linkHref = link?.href || "";
              let valId = "";
              if (linkHref) {
                const idMatch = decodeURIComponent(decodeURIComponent(linkHref)).match(/[?&#](?:applied_value_id|category_id)(?:=|%3D|%253D)(MLB\d+)/i);
                if (idMatch) valId = idMatch[1];
              }
              const count = this.extractAppliedValueResults(linkHref) || this.extractAppliedValueResults(itemEl.textContent);
              const isActive = Boolean(itemEl.querySelector(".ui-search-filter-applied, .andes-checkbox--checked"));
              return { id: valId, name: valName, count: count || 0, isActive };
            }).filter((v) => v.name && v.name.length < 50);

            if (values.length && !filtersMap.has(groupName)) {
              filtersMap.set(groupName, { name: groupName, values });
            }
          });
        }
        context.filters = Array.from(filtersMap.values());

        const relatedSet = new Set();
        const relatedList = [];

        if (nordicRoot) {
          const rawRelated = nordicRoot.related_searches ?? nordicRoot.components?.related_searches ?? nordicRoot.top_keywords ?? [];
          if (Array.isArray(rawRelated)) {
            rawRelated.forEach((item) => {
              const text = typeof item === "string" ? item : (item.name || item.text || item.keyword || "");
              if (text && !relatedSet.has(text.toLowerCase())) {
                relatedSet.add(text.toLowerCase());
                relatedList.push(text);
              }
            });
          }
        }

        if (doc) {
          const domRelated = doc.querySelectorAll(".ui-search-related-keywords a, .ui-search-related-keywords__item a");
          domRelated.forEach((el) => {
            const text = el.textContent?.trim() || "";
            if (text && !relatedSet.has(text.toLowerCase())) {
              relatedSet.add(text.toLowerCase());
              relatedList.push(text);
            }
          });
        }

        const mainQuery = (doc?.querySelector?.("input.nav-search-input")?.value || context.categoryName || "").toLowerCase().trim();
        const queryTokens = mainQuery.split(/\s+/).filter(Boolean);

        context.relatedSearches = relatedList.slice(0, 12).map((term) => {
          const lower = term.toLowerCase();
          let score = 50;
          if (lower === mainQuery) score = 100;
          else {
            const matches = queryTokens.filter((tk) => lower.includes(tk)).length;
            score = Math.min(95, 50 + matches * 20);
          }
          let relevanceLabel = "Moderada";
          let badgeColor = "#64748b";
          if (score >= 80) { relevanceLabel = "Alta Relevância"; badgeColor = "#00a650"; }
          else if (score >= 65) { relevanceLabel = "Boa Aderência"; badgeColor = "#3483fa"; }
          return { term, score, relevanceLabel, badgeColor };
        });
      } catch (err) {
        console.debug(`${APP}: Erro na extração do SearchContext:`, err);
      }

      return context;
    }

    static groupAdsByDomainOrCategory(items, calculationFn, searchContext = null) {
      const byIdentity = new Map();
      let totalPositions = items.length;
      let duplicatedPositions = 0;

      items.forEach((it) => {
        const id = it.data.identifiers?.[0] || it.data.itemId || it.data.permalink;
        if (!id) return;
        if (byIdentity.has(id)) {
          duplicatedPositions++;
          const existing = byIdentity.get(id);
          if (!existing.advanced && it.advanced) {
            byIdentity.set(id, it);
          }
        } else {
          byIdentity.set(id, it);
        }
      });

      const uniqueItems = Array.from(byIdentity.values());
      const groupsMap = new Map();

      uniqueItems.forEach((it) => {
        const classification = this.classifyItemCategory(it, searchContext);
        const key = classification.key;

        if (!groupsMap.has(key)) {
          groupsMap.set(key, {
            key,
            domainId: classification.domainId,
            categoryId: classification.categoryId,
            name: classification.name,
            items: []
          });
        }
        groupsMap.get(key).items.push(it);
      });

      let aggregatedRevenue = 0;
      let aggregatedGiro = 0;

      const groups = Array.from(groupsMap.values()).map((grp) => {
        const gItems = grp.items;
        const prices = gItems.map((it) => asNumber(it.data.price)).filter((p) => p > 0);
        const validSales = gItems.filter((it) => it.advanced?.salesPerDay != null && Number.isFinite(it.advanced.salesPerDay) && it.advanced.salesPerDay >= 0);
        const dailyGiros = validSales.map((it) => it.advanced.salesPerDay);
        const monthlyRevenues = validSales.map((it) => it.advanced.monthlyRevenue ?? (it.advanced.salesPerDay * 30 * it.data.price));

        const returnRatios = gItems.map((it) => {
          const calc = calculationFn ? calculationFn(it.data) : { netPayout: it.data.price * 0.8 };
          return it.data.price > 0 ? (calc.netPayout / it.data.price) : 0;
        });

        const medianPrice = IQVAnalysisEngine.median(prices) || 0;
        const medianDailyGiro = IQVAnalysisEngine.median(dailyGiros) || 0;
        const totalDailyGiro = dailyGiros.reduce((a, b) => a + b, 0);
        const projectedMonthlyRevenue = monthlyRevenues.reduce((a, b) => a + b, 0);
        const medianMonthlyRevenue = IQVAnalysisEngine.median(monthlyRevenues) || 0;
        const medianReturnRatio = IQVAnalysisEngine.median(returnRatios) || 0;

        aggregatedRevenue += projectedMonthlyRevenue;
        aggregatedGiro += totalDailyGiro;

        const iqv = IQVAnalysisEngine.analyze(gItems, calculationFn);

        const sponsoredCount = gItems.filter((it) => it.data.isSponsored).length;
        const fullCount = gItems.filter((it) => it.data.isFull || it.data.logisticType === "fulfillment").length;

        const totalAppearances = items.filter((it) => {
          const itClass = this.classifyItemCategory(it, searchContext);
          return itClass.key === grp.key || itClass.name === grp.name;
        }).length;

        return {
          key: grp.key,
          domainId: grp.domainId,
          categoryId: grp.categoryId,
          name: grp.name,
          uniqueCount: gItems.length,
          totalPositions: Math.max(gItems.length, totalAppearances),
          sponsoredCount,
          fullCount,
          medianPrice,
          medianDailyGiro,
          totalDailyGiro,
          projectedMonthlyRevenue,
          medianMonthlyRevenue,
          medianReturnRatio,
          iqv,
          items: gItems
        };
      });

      groups.forEach((g) => {
        g.revenueShare = aggregatedRevenue > 0 ? (g.projectedMonthlyRevenue / aggregatedRevenue * 100) : 0;
        g.giroShare = aggregatedGiro > 0 ? (g.totalDailyGiro / aggregatedGiro * 100) : 0;
        g.adShare = uniqueItems.length > 0 ? (g.uniqueCount / uniqueItems.length * 100) : 0;
      });

      groups.sort((a, b) => b.projectedMonthlyRevenue - a.projectedMonthlyRevenue);

      const topGroup = groups[0] || null;

      const insight = groups.length > 1
        ? `Foram identificadas <strong>${groups.length} subcategorias/domínios comerciais</strong> nesta pesquisa. O segmento líder é <strong>${topGroup ? escapeHtml(topGroup.name) : "Geral"}</strong>, concentrando <strong>${topGroup ? topGroup.revenueShare.toFixed(1) : 0}%</strong> do faturamento mensal estimado (<strong>${money.format(topGroup ? topGroup.projectedMonthlyRevenue : 0)}</strong>). Foram desduplicadas <strong>${duplicatedPositions} aparições patrocinadas</strong> sobrepostas no ranking.`
        : (groups.length === 1
          ? `Foram identificadas <strong>1 subcategoria principal</strong> nesta pesquisa: <strong>${topGroup ? escapeHtml(topGroup.name) : "Geral"}</strong>, concentrando <strong>100%</strong> do faturamento projetado (<strong>${money.format(topGroup ? topGroup.projectedMonthlyRevenue : 0)}</strong>).`
          : "Dados insuficientes para estruturar agrupamento por categoria.");

      return {
        totalPositions,
        uniqueAdsCount: uniqueItems.length,
        duplicatedPositions,
        aggregatedRevenue,
        aggregatedGiro,
        groups,
        topGroup,
        insight
      };
    }
  }

  class StructuredDataRegistry {
    constructor() {
      this.byIdentifier = new Map();
      this.byTitle = new Map();
      this.records = new Set();
      this.catalogMetadata = new Map();
      this.catalogByTitle = new Map();
      this.pdpData = null;
      this.searchContext = null;
      this.listeners = new Set();
      this.seenPayloads = new Set();
      this.notify = debounce(() => this.listeners.forEach((listener) => listener()), 120);
      bridgeInbox.forEach((payload) => this.schedule(payload));
      bridgeSubscribers.add((payload) => this.schedule(payload));
    }

    registerCategoryMetadata(identifiers, title, metadata) {
      if (!metadata || (!metadata.domainId && !metadata.categoryId && !metadata.categoryName && !metadata.brand)) return;
      const meta = {
        domainId: metadata.domainId || "",
        categoryId: metadata.categoryId || "",
        categoryName: metadata.categoryName || "",
        brand: metadata.brand || ""
      };
      (identifiers || []).forEach((id) => {
        if (!id) return;
        const prev = this.catalogMetadata.get(id) || {};
        this.catalogMetadata.set(id, {
          domainId: meta.domainId || prev.domainId || "",
          categoryId: meta.categoryId || prev.categoryId || "",
          categoryName: meta.categoryName || prev.categoryName || "",
          brand: meta.brand || prev.brand || ""
        });
      });
      const tKey = this.titleKey(title);
      if (tKey) {
        const prevT = this.catalogByTitle.get(tKey) || {};
        this.catalogByTitle.set(tKey, {
          domainId: meta.domainId || prevT.domainId || "",
          categoryId: meta.categoryId || prevT.categoryId || "",
          categoryName: meta.categoryName || prevT.categoryName || "",
          brand: meta.brand || prevT.brand || ""
        });
      }
    }

    getCategoryMetadata(data) {
      if (!data) return null;
      for (const id of (data.identifiers || [])) {
        if (this.catalogMetadata.has(id)) return this.catalogMetadata.get(id);
      }
      if (data.itemId && this.catalogMetadata.has(data.itemId)) return this.catalogMetadata.get(data.itemId);
      if (data.permalink && this.catalogMetadata.has(data.permalink)) return this.catalogMetadata.get(data.permalink);
      const tKey = this.titleKey(data.title);
      if (tKey && this.catalogByTitle.has(tKey)) return this.catalogByTitle.get(tKey);
      return null;
    }

    getSearchContext() {
      if (this.searchContext && (this.searchContext.totalResults > 0 || this.searchContext.filters?.length > 0)) {
        return this.searchContext;
      }
      const fallback = CategoryIntelligenceExtractor.extractSearchContext(null, document);
      if (!this.searchContext || (fallback.filters?.length || 0) > (this.searchContext.filters?.length || 0)) {
        this.searchContext = fallback;
      }
      return this.searchContext;
    }

    titleKey(value) {
      return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("pt-BR").replace(/[^a-z0-9]+/g, " ").trim();
    }

    schedule(payload) {
      const signature = `${payload.kind}:${payload.url}:${payload.text.length}:${payload.text.slice(0, 80)}:${payload.text.slice(-80)}`;
      if (this.seenPayloads.has(signature)) return;
      this.seenPayloads.add(signature);
      setTimeout(() => this.ingestText(payload.text), 0);
    }

    ingestText(text) {
      try {
        const { root, pdp, searchRecords, catalogItems } = NordicJsonExtractor.fromText(text);
        if (root) {
          const ctx = CategoryIntelligenceExtractor.extractSearchContext(root, document);
          if (ctx && (ctx.totalResults > 0 || ctx.filters?.length > 0)) {
            if (!this.searchContext || (ctx.filters?.length || 0) >= (this.searchContext.filters?.length || 0)) {
              this.searchContext = ctx;
            }
          }
        }
        (catalogItems || []).forEach((cat) => this.registerCategoryMetadata(cat.identifiers, cat.title, cat));
        searchRecords.forEach((record) => {
          this.registerCategoryMetadata(record.identifiers, record.title, record);
          this.upsert(record);
        });
        if (pdp && (pdp.itemId || pdp.price || pdp.soldQuantity)) this.upsertPdp(pdp);
        if (searchRecords.length || pdp?.itemId || (catalogItems && catalogItems.length)) this.notify();
      } catch (error) {
        console.debug(`${APP}: bloco estruturado ignorado`, error);
      }
    }

    upsert(record) {
      if (!record?.identifiers?.length) return;
      const catMeta = this.getCategoryMetadata(record);
      if (catMeta) {
        record.domainId = record.domainId || catMeta.domainId || "";
        record.categoryId = record.categoryId || catMeta.categoryId || "";
        record.categoryName = record.categoryName || catMeta.categoryName || "";
        record.brand = record.brand || catMeta.brand || "";
      }
      const previous = record.identifiers.map((id) => this.byIdentifier.get(id)).find(Boolean);
      const merged = previous ? {
        ...previous,
        ...record,
        identifiers: [...new Set([...previous.identifiers, ...record.identifiers])],
        title: record.title || previous.title,
        price: record.price || previous.price,
        soldQuantity: record.soldQuantity || previous.soldQuantity,
        creationDate: record.creationDate ?? previous.creationDate,
        creationDateIsEstimated: record.creationDate ? record.creationDateIsEstimated : previous.creationDateIsEstimated,
        advancedSource: record.advancedSource || previous.advancedSource,
        domainId: record.domainId || previous.domainId || "",
        categoryId: record.categoryId || previous.categoryId || "",
        categoryName: record.categoryName || previous.categoryName || "",
        brand: record.brand || previous.brand || "",
        dataQuality: record.dataQuality || previous.dataQuality || "basic"
      } : record;
      merged.identifiers.forEach((id) => this.byIdentifier.set(id, merged));
      this.records.add(merged);
      const title = this.titleKey(merged.title);
      if (title) this.byTitle.set(title, merged);
    }

    upsertPdp(data) {
      const score = (value) => [value?.itemId, value?.price, value?.soldQuantity, value?.creationDate, value?.billableWeightGrams].filter(Boolean).length;
      if (!this.pdpData || score(data) >= score(this.pdpData)) this.pdpData = { ...(this.pdpData ?? {}), ...data };
      const record = NordicJsonExtractor.recordFromCandidate({
        item_id: data.itemId,
        user_product_id: data.userProductId,
        title: data.title,
        price: data.price,
        sold_quantity: data.soldQuantity,
        date_created: data.creationDateIsEstimated ? null : data.creationDate,
        picture_id: data.creationDateIsEstimated && data.creationDate ? `_01${new Date(data.creationDate).getFullYear()}` : "",
        domain_id: data.domainId ?? "",
        category_id: data.categoryId ?? "",
        category_name: data.categoryName ?? "",
        brand: data.brand ?? ""
      });
      if (record) this.upsert({
        ...record,
        creationDate: data.creationDate,
        creationDateIsEstimated: data.creationDateIsEstimated,
        estimatedDaysActive: data.estimatedDaysActive,
        salesPerDay: data.salesPerDay,
        salesPerMonth: data.salesPerMonth,
        monthlyRevenue: data.monthlyRevenue,
        domainId: data.domainId ?? "",
        categoryId: data.categoryId ?? "",
        categoryName: data.categoryName ?? "",
        brand: data.brand ?? "",
        dataQuality: data.creationDateIsEstimated ? "estimated" : "complete"
      });
    }

    addFetchedPdp(data) {
      if (!data) return;
      this.upsertPdp(data);
      this.notify();
    }

    find(data) {
      let record = (data.identifiers ?? []).map((id) => this.byIdentifier.get(id)).find(Boolean);
      if (!record) record = this.byTitle.get(this.titleKey(data.title));
      if (!record) return null;
      const catMeta = this.getCategoryMetadata(data) || this.getCategoryMetadata(record);
      const domainId = record.domainId || catMeta?.domainId || "";
      const categoryId = record.categoryId || catMeta?.categoryId || "";
      const categoryName = record.categoryName || catMeta?.categoryName || "";
      const brand = record.brand || catMeta?.brand || "";
      const price = data.price || record.price;
      const days = record.creationDate ? Math.max(1, Math.ceil((Date.now() - new Date(record.creationDate).valueOf()) / 86400000)) : record.estimatedDaysActive || 0;
      const salesPerDay = record.soldQuantity && days ? record.soldQuantity / days : record.salesPerDay || 0;
      return {
        ...record,
        price,
        estimatedDaysActive: days,
        salesPerDay,
        salesPerMonth: salesPerDay * 30,
        monthlyRevenue: salesPerDay * 30 * price,
        domainId,
        categoryId,
        categoryName,
        brand,
        dataQuality: record.dataQuality || "basic"
      };
    }

    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    bestPdp() {
      if (this.pdpData && (this.pdpData.soldQuantity || this.pdpData.creationDate)) return this.pdpData;
      const urlIdentifiers = NordicJsonExtractor.extractIdentifiers(location.href);
      const record = urlIdentifiers.map((id) => this.byIdentifier.get(id)).find(Boolean)
        ?? ([...this.records].filter((item) => item.soldQuantity && item.creationDate).length === 1 ? [...this.records].find((item) => item.soldQuantity && item.creationDate) : null);
      if (!record) return this.pdpData;
      return {
        ...(this.pdpData ?? {}), hasDeepData: true, title: record.title, itemId: record.identifiers.find((id) => /^MLB\d+$/.test(id)) ?? "",
        userProductId: record.identifiers.find((id) => /^MLBU\d+$/.test(id)) ?? "", price: record.price,
        soldQuantity: record.soldQuantity, creationDate: record.creationDate, creationDateIsEstimated: record.creationDateIsEstimated,
        estimatedDaysActive: record.estimatedDaysActive, salesPerDay: record.salesPerDay,
        salesPerMonth: record.salesPerMonth, monthlyRevenue: record.monthlyRevenue
      };
    }
  }

  class DomFallbackExtractor {
    static parseMoney(container) {
      if (!container) return 0;
      const metaPrice = container.matches?.('meta[itemprop="price"]') ? container.getAttribute("content") : container.querySelector?.('meta[itemprop="price"]')?.getAttribute("content");
      if (metaPrice && Number.isFinite(Number(metaPrice))) return Number(metaPrice);
      const target = container.matches?.("s, .andes-money-amount--previous, .ui-pdp-price__original-value") ? container
        : (container.querySelector?.(".andes-money-amount:not(s *):not(.andes-money-amount--previous):not(.ui-pdp-price__original-value *)") ?? container);
      const fraction = target.querySelector?.(".andes-money-amount__fraction")?.textContent?.replace(/\D/g, "")
        ?? container.querySelector?.(".andes-money-amount__fraction")?.textContent?.replace(/\D/g, "") ?? "0";
      const cents = target.querySelector?.(".andes-money-amount__cents")?.textContent?.replace(/\D/g, "")
        ?? container.querySelector?.(".andes-money-amount__cents")?.textContent?.replace(/\D/g, "") ?? "0";
      return asNumber(`${fraction}.${cents.padEnd(2, "0")}`);
    }

    static fromSearchCard(card) {
      const titleLink = card.querySelector("a.poly-component__title, a.ui-search-link, a[href*='/MLB-']");
      const img = card.querySelector(".poly-card__portada img, .ui-search-result-image__element, img.poly-component__picture, img");
      const thumbnail = img?.getAttribute("src") || img?.getAttribute("data-src") || "";
      const installment = card.querySelector(".poly-price__installments, .ui-search-price__second-line")?.textContent ?? "";
      const fullNode = card.querySelector('svg use[href="#poly_full"], .poly-component__shipped-from, .ui-search-item__shipping');
      const moneyNodes = [...card.querySelectorAll(".andes-money-amount")];
      const current = card.querySelector(".poly-price__current .andes-money-amount, .poly-price__current, .ui-search-price__part--medium:not(.andes-money-amount--previous)")
        ?? moneyNodes.find((node) => !node.matches("s, .andes-money-amount--previous, .ui-search-price__part--previous") && !node.closest("s, .andes-money-amount--previous") && !node.classList.contains("andes-money-amount--previous"));
      const original = card.querySelector("s.andes-money-amount, .andes-money-amount--previous, .ui-search-price__part--previous .andes-money-amount");
      const text = card.textContent ?? "";
      const isLightning = Boolean(card.querySelector(".poly-component__promotions, .poly-tag, [aria-label*='relâmpago' i], [aria-label*='relampago' i]"))
        || /oferta\s+rel[aâ]mpago/i.test(text);
      const soldMatch = text.match(/(?:mais\s+de\s+|\+\s*)?([\d.,]+)\s*(milh(?:a|ã)o|mil|mi|m)?\s+(?:produtos?\s+)?vendidos?/i);
      const soldBase = soldMatch ? asNumber(soldMatch[1].replace(/\.(?=\d{3}(?:\D|$))/g, "").replace(",", ".")) : 0;
      const soldUnit = soldMatch?.[2]?.toLocaleLowerCase("pt-BR") ?? "";
      const soldQuantity = Math.round(soldBase * (/milh|^mi$|^m$/.test(soldUnit) ? 1000000 : soldUnit === "mil" ? 1000 : 1));
      const ratingMatch = text.match(/(?:classifica(?:ç|c)[aã]o\s*)?([0-5](?:[.,]\d+)?)\s*(?:de\s*5|\([\d.]+\))/i);
      const identifiers = NordicJsonExtractor.extractIdentifiers([
        titleLink?.href,
        card.getAttribute("data-id"),
        card.getAttribute("id"),
        card.querySelector("[data-id]")?.getAttribute("data-id"),
        card.querySelector("[data-item-id]")?.getAttribute("data-item-id")
      ]);
      let cardCategoryId = "";
      let cardDomainId = "";

      const cardLinks = [titleLink?.href, ...Array.from(card.querySelectorAll("a[href]")).map((a) => a.href)].filter(Boolean);
      for (const linkHref of cardLinks) {
        if (!cardCategoryId) {
          const catMatch = decodeURIComponent(decodeURIComponent(linkHref)).match(/[?&#](?:category_id|applied_value_id)(?:=|%3D|%253D)(MLB\d+)/i);
          if (catMatch) cardCategoryId = catMatch[1];
        }
        if (!cardDomainId) {
          const domMatch = decodeURIComponent(decodeURIComponent(linkHref)).match(/[?&#]domain_id(?:=|%3D|%253D)(MLB-[A-Z0-9_]+)/i);
          if (domMatch) cardDomainId = domMatch[1];
        }
        if (cardCategoryId && cardDomainId) break;
      }

      if (!cardCategoryId) {
        cardCategoryId = card.getAttribute("data-category-id") || card.querySelector("[data-category-id]")?.getAttribute("data-category-id") || "";
      }
      if (!cardDomainId) {
        cardDomainId = card.getAttribute("data-domain-id") || card.querySelector("[data-domain-id]")?.getAttribute("data-domain-id") || "";
      }

      const trackAttr = card.getAttribute("data-track") || titleLink?.getAttribute("data-track") || card.querySelector("[data-track]")?.getAttribute("data-track");
      if (trackAttr && (!cardCategoryId || !cardDomainId)) {
        try {
          const trackJson = JSON.parse(trackAttr);
          const evData = trackJson?.event_data || trackJson;
          if (!cardDomainId && evData?.domain_id) cardDomainId = evData.domain_id;
          if (!cardCategoryId && evData?.category_id) cardCategoryId = evData.category_id;
        } catch { /* ignore */ }
      }

      return {
        hasDeepData: false,
        title: titleLink?.textContent?.trim() ?? "Produto sem título",
        permalink: titleLink?.href ?? "", identifiers,
        thumbnail,
        price: this.parseMoney(current), originalPrice: this.parseMoney(original),
        campaignType: isLightning ? "lightning" : "",
        listingTypeId: /sem\s+juros/i.test(installment) || /rgb\(0,\s*166,\s*80\)|#00a650/i.test(card.querySelector(".poly-price__installments")?.getAttribute("style") ?? "") ? "gold_pro" : "gold_special",
        logisticType: fullNode ? "fulfillment" : "", isFull: Boolean(fullNode), isSponsored: /patrocinado/i.test(text) || Boolean(card.querySelector('[aria-label="Patrocinado"], .poly-component__ads-promotions')),
        soldQuantity, reviewRate: ratingMatch ? asNumber(ratingMatch[1].replace(",", ".")) : 0,
        domainId: cardDomainId,
        categoryId: cardCategoryId
      };
    }

    static fromPdp() {
      const moneyNodes = [...document.querySelectorAll(".ui-pdp-price .andes-money-amount, [data-testid='price-part'] .andes-money-amount, .ui-pdp-price__second-line .andes-money-amount, .andes-money-amount")];
      const current = document.querySelector(".ui-pdp-price__second-line .andes-money-amount:not(.andes-money-amount--previous):not(s *), .ui-pdp-price__main-part .andes-money-amount:not(.andes-money-amount--previous):not(s *):not(.ui-pdp-price__original-value *), [data-testid='price-part'] .andes-money-amount:not(.andes-money-amount--previous):not(s *)")
        ?? moneyNodes.find((node) => !node.matches("s, .andes-money-amount--previous, .ui-pdp-price__original-value") && !node.closest("s, .andes-money-amount--previous, .ui-pdp-price__original-value, .ui-pdp-price__subtitles, .ui-pdp-price__installments, [data-testid='installments']"));
      const original = document.querySelector("s.andes-money-amount, .andes-money-amount--previous, .ui-pdp-price__original-value .andes-money-amount, .ui-pdp-price__original-value");
      const metaPrice = document.querySelector('meta[itemprop="price"]')?.getAttribute("content");
      const price = this.parseMoney(current) || asNumber(metaPrice);
      const originalPrice = this.parseMoney(original);
      const text = document.body?.textContent ?? "";
      const isLightning = Boolean(document.querySelector(".ui-pdp-promotions-pill, [aria-label*='relâmpago' i], [aria-label*='relampago' i]"))
        || /oferta\s+rel[aâ]mpago/i.test(text);
      const quantityText = document.querySelector("#buybox_available_quantity, [data-testid='quantity-selector-trigger'], .ui-pdp-buybox__quantity")?.textContent ?? "";
      const quantityMatch = quantityText.match(/\((\d+)\s+dispon/i);
      const ratingText = document.querySelector(".ui-pdp-review__rating, .ui-pdp-review__ratings, [data-testid='review-summary']")?.textContent ?? "";
      const ratingMatch = ratingText.match(/(\d+(?:[.,]\d+)?)/);
      return {
        hasDeepData: false,
        title: document.querySelector("h1.ui-pdp-title")?.textContent?.trim() ?? document.title,
        itemId: document.querySelector('input[name="item_id"]')?.value ?? document.querySelector('[data-item-id]')?.getAttribute("data-item-id") ?? "",
        price,
        originalPrice,
        campaignType: isLightning ? "lightning" : "",
        listingTypeId: /sem\s+juros/i.test(document.querySelector(".ui-pdp-price")?.textContent ?? "") ? "gold_pro" : "gold_special",
        logisticType: /FULL/i.test(text) ? "fulfillment" : "",
        billableWeightGrams: 0, meliSubsidy: 0, soldQuantity: 0, availableStock: quantityMatch ? asNumber(quantityMatch[1]) : 0, salesPerDay: 0, salesPerMonth: 0,
        monthlyRevenue: 0, estimatedDaysActive: 1, wholesaleShortcuts: [], picturesCount: document.querySelectorAll(".ui-pdp-gallery__figure, .ui-pdp-thumbnail").length,
        reviewRate: ratingMatch ? asNumber(ratingMatch[1].replace(",", ".")) : 0, reviewCount: 0,
        sellerName: document.querySelector(".ui-pdp-seller-summary__link, .ui-pdp-seller__link-trigger")?.textContent?.trim() ?? "",
        hasNfe: /NF-e verificada/i.test(text), freeShipping: /frete gr[aá]tis/i.test(text)
      };
    }
  }

  class PdpWidgetInjector {
    constructor(settings, registry) { this.settings = settings; this.registry = registry; this.data = null; this.root = null; this.observer = null; this.manualCost = ""; this.manualPrice = ""; }
    commission(data) { return data.listingTypeId === "gold_pro" ? this.settings.premiumCommission : this.settings.classicCommission; }
    input(data, overrides = {}) { return { price: data.price, commissionPercent: this.commission(data), taxPercent: this.settings.taxPercent, packagingCost: this.settings.packagingCost, weightGrams: data.billableWeightGrams || this.settings.defaultWeight, logisticType: data.logisticType, meliSubsidy: data.meliSubsidy, considerSubsidy: this.settings.considerSubsidy, adsPercent: 0, ...overrides }; }
    listingName(data) { return data.listingTypeId === "gold_pro" ? "PREMIUM" : "CLÁSSICO"; }
    logisticsName(type) { return ({ fulfillment: "FULL", xd_drop_off: "AGÊNCIA", cross_docking: "COLETA", self_service: "FLEX" })[type] ?? "LOGÍSTICA NÃO DETECTADA"; }

    findPaymentContainer(buybox) {
      const productColumn = buybox.closest(".ui-pdp-container__col, .ui-vip-core-container__right") ?? document;
      const directContainer = productColumn.querySelector(".ui-pdp-price__payments-link")
        ?? document.querySelector(".ui-pdp-price__payments-link");
      const paymentAction = directContainer?.querySelector("#ui-pdp-price__payments-link, a, button")
        ?? [...productColumn.querySelectorAll("a, button")].find((element) => /ver os meios de pagamento/i.test(element.textContent ?? ""));
      return directContainer
        ?? paymentAction?.closest(".ui-pdp-price__payments-link, .ui-pdp-media")
        ?? paymentAction;
    }

    movePaymentLinkBelowAnalysis(root, buybox, paymentContainer = this.findPaymentContainer(buybox)) {
      if (!paymentContainer || root.contains(paymentContainer)) return;
      if (root.nextElementSibling !== paymentContainer) root.after(paymentContainer);
    }

    placeAnalysis(root, buybox) {
      const purchaseStart = buybox.querySelector(".ui-pdp-container__row--shipping-chunk, .ui-pdp-container__row--shipping-section, .xprod-lib-shipping-section, .ui-pdp-container__row--outside-variations, .ui-pdp-container__row--stock-and-full, #main_actions, form.ui-pdp-actions");
      const paymentContainer = this.findPaymentContainer(buybox);
      const editingManualField = root.contains(document.activeElement);
      if (purchaseStart && purchaseStart !== buybox) {
        const paymentBetweenAnalysisAndPurchase = root.nextElementSibling === paymentContainer && paymentContainer?.nextElementSibling === purchaseStart;
        const alreadyPlaced = root.parentElement === purchaseStart.parentElement && (root.nextElementSibling === purchaseStart || paymentBetweenAnalysisAndPurchase);
        if (!alreadyPlaced && !editingManualField) purchaseStart.before(root);
      } else if (buybox.firstElementChild !== root && !editingManualField) {
        buybox.prepend(root);
      }
      this.movePaymentLinkBelowAnalysis(root, buybox, paymentContainer);
    }

    findBuybox() {
      const selectorTiers = [
        "form#buybox-form.ui-pdp-buybox",
        "form#buybox-form",
        "form.ui-pdp-buybox",
        "[data-testid='buybox']",
        "[data-testid='buy-box']",
        ".ui-pdp-buybox-container",
        ".xprod-lib-buybox",
        ".ui-pdp-container__col.col-1.ui-pdp-container--column-right",
        ".ui-vip-core-container__right",
        "#main_actions",
        "form.ui-pdp-actions"
      ];
      for (const selector of selectorTiers) {
        const nodes = [...document.querySelectorAll(selector)];
        const candidate = nodes.find((node) => node.offsetParent !== null) ?? nodes[0];
        if (candidate) return candidate;
      }
      return null;
    }

    mount() {
      const fallback = DomFallbackExtractor.fromPdp();
      const nordic = this.registry?.bestPdp() ?? NordicJsonExtractor.fromDocument();
      this.data = { ...fallback, ...(this.data ?? {}), ...(nordic ?? {}) };
      if (!this.data.title) this.data.title = document.querySelector("h1")?.textContent?.trim() ?? document.title;
      if (!this.data?.price) return;
      this.mountPricePayout();

      const buybox = this.findBuybox();
      const existing = document.querySelector("#calculadora-livre-pdp");
      if (existing) {
        if (buybox) this.placeAnalysis(existing, buybox);
        this.root = existing;
        return;
      }
      if (!buybox) return;
      this.root = document.createElement("section");
      this.root.id = "calculadora-livre-pdp"; this.root.className = "cl-root cl-buybox-analysis";
      this.placeAnalysis(this.root, buybox);
      this.render();
    }

    mountPricePayout() {
      const priceLine = document.querySelector(".ui-pdp-price__second-line");
      if (!priceLine) return;
      const calc = MeliPricingEngine2026.calculate(this.input(this.data));
      let payout = document.querySelector("#calculadora-livre-price-payout");
      if (!payout) {
        payout = document.createElement("div");
        payout.id = "calculadora-livre-price-payout";
        payout.className = "cl-root cl-price-payout";
        priceLine.insertAdjacentElement("afterend", payout);
      }
      const payoutHtml = `<span>Repasse líquido estimado</span><strong>${money.format(calc.netPayout)}</strong><small>Após comissão e tarifa de envio do Mercado Livre.</small>`;
      if (payout.innerHTML !== payoutHtml) payout.innerHTML = payoutHtml;
    }

    observe() {
      this.mount();
      const ensureMounted = debounce(() => this.mount(), 180);
      this.observer = new MutationObserver(ensureMounted);
      this.observer.observe(document.body, { childList: true, subtree: true });
    }

    render() {
      const data = this.data;
      const calc = MeliPricingEngine2026.calculate(this.input(data));
      this.mountPricePayout();
      const commission = this.commission(data);
      const center = [data.fulfillmentCity, data.fulfillmentCenter].filter(Boolean).join(" · ");
      this.root.innerHTML = `
        <header class="cl-buybox-analysis__header">
          <div>
            <h2>Calculadora Livre</h2>
            <p>Análise financeira deste anúncio</p>
          </div>
        </header>
        <div class="cl-badges cl-buybox-analysis__badges">
          ${data.campaignType === "lightning" ? `<span class="cl-badge cl-badge--yellow">⚡ Oferta Relâmpago</span>` : ""}
          <span class="cl-badge cl-badge--blue">🏷️ ${this.listingName(data)} ${number.format(commission)}%</span>
          <span class="cl-badge cl-badge--green">⚡ ${this.logisticsName(data.logisticType)}${center ? ` · ${escapeHtml(center)}` : ""}</span>
          <span class="cl-badge">⚖️ ${data.billableWeightGrams ? `${number.format(data.billableWeightGrams)} g real` : `${number.format(this.settings.defaultWeight)} g padrão`}</span>
          ${data.meliSubsidy ? `<span class="cl-badge cl-badge--green">🎁 +${money.format(data.meliSubsidy)}</span>` : ""}
        </div>
        ${this.pricingHtml(calc)}
        <section class="cl-buybox-intelligence"><h3 class="cl-section-title">Inteligência completa do anúncio</h3>${this.intelligenceHtml(calc)}<h3 class="cl-section-title">Qualidade do anúncio</h3>${this.qualityHtml()}</section>
        <div class="cl-purchase-divider" aria-hidden="true"><span>Opções de compra</span></div>`;
      this.bind();
    }

    pricingHtml(calc) {
      const step = MeliPricingEngine2026.stepOpportunity(this.input(this.data));
      const wholesale = this.data.wholesaleShortcuts?.[0];
      const wholesaleCalc = wholesale ? MeliPricingEngine2026.calculate(this.input(this.data, { price: wholesale.price })) : null;
      const costValue = this.manualCost;
      const simulatedPriceValue = this.manualPrice === "" ? calc.price.toFixed(2) : this.manualPrice;
      const hasCost = costValue !== "" && Number.isFinite(Number(costValue));
      const cost = hasCost ? Math.max(0, Number(costValue)) : 0;
      const competitorCalc = hasCost ? MeliPricingEngine2026.calculate(this.input(this.data, { productCost: cost })) : null;
      const simulatedPrice = Math.max(0, asNumber(simulatedPriceValue, calc.price));
      const simulatedCalc = hasCost ? MeliPricingEngine2026.calculate(this.input(this.data, { price: simulatedPrice, productCost: cost })) : null;
      const availableAfterCosts = calc.netPayout - calc.extras;
      return `<dl class="cl-buybox-list">
        <div>
          <div class="cl-buybox-item__col">
            <dt>Preço de venda atual</dt>
            ${this.data.originalPrice && this.data.originalPrice > calc.price ? `<span class="cl-subtext">De <s>${money.format(this.data.originalPrice)}</s> (${Math.round((1 - calc.price / this.data.originalPrice) * 100)}% OFF)</span>` : ""}
          </div>
          <dd>${money.format(calc.price)}</dd>
        </div>
        ${this.data.otherMethodsPrice && this.data.otherMethodsPrice > calc.price ? `<div>
          <div class="cl-buybox-item__col">
            <dt>Outros meios de pagamento</dt>
            <span class="cl-subtext">Cartão / parcelado</span>
          </div>
          <dd>${money.format(this.data.otherMethodsPrice)}</dd>
        </div>` : ""}
        <div>
          <div class="cl-buybox-item__col">
            <dt>Comissão do Mercado Livre</dt>
            <span class="cl-subtext">${number.format(calc.commissionPercent)}% sobre a venda</span>
          </div>
          <dd class="cl-negative">− ${money.format(calc.commission)}</dd>
        </div>
        <div>
          <div class="cl-buybox-item__col">
            <dt>Tarifa de envio estimada</dt>
            <span class="cl-subtext">${number.format(this.data.billableWeightGrams || this.settings.defaultWeight)} g · ${calc.priceTier}</span>
          </div>
          <dd class="cl-negative">− ${money.format(calc.shippingFee)}</dd>
        </div>
        ${calc.subsidy ? `<div>
          <dt>Subsídio do Mercado Livre</dt>
          <dd class="cl-money--green">+ ${money.format(calc.subsidy)}</dd>
        </div>` : ""}
        <div>
          <div class="cl-buybox-item__col">
            <dt>Imposto + publicidade + embalagem</dt>
            <span class="cl-subtext">${money.format(calc.tax)} imposto + ${money.format(calc.adsCost)} ads + ${money.format(this.settings.packagingCost)} emb.</span>
          </div>
          <dd class="cl-negative">− ${money.format(calc.extras)}</dd>
        </div>
        <div class="cl-buybox-list__highlight">
          <div class="cl-buybox-list__highlight-main">
            <div class="cl-buybox-item__col">
              <dt>Repasse líquido do ML</dt>
              <span class="cl-subtext cl-subtext--green">${number.format(calc.netPayoutPercent)}% do valor da venda</span>
            </div>
            <dd>${money.format(calc.netPayout)}</dd>
          </div>
          <div class="cl-net-after-costs">
            <dt>Sobra real após custos</dt>
            <dd class="${availableAfterCosts < 0 ? "cl-negative" : "cl-money--green"}">${money.format(availableAfterCosts)}</dd>
          </div>
        </div>
      </dl>
      <div class="cl-buybox-simulator">
        <div class="cl-manual-entry">
          <label class="cl-field">
            <span class="cl-field__label">Meu custo do produto (R$)</span>
            <input class="cl-input" data-input="cost" type="number" inputmode="decimal" min="0" step="0.01" autocomplete="off" placeholder="Digite seu custo (ex: 45,00)" value="${escapeHtml(costValue)}">
          </label>
          <div class="cl-output${competitorCalc ? competitorCalc.realProfit < 0 ? " cl-output--negative" : " cl-output--positive" : ""}" data-output="competitor">
            ${competitorCalc ? `No preço do anúncio: lucro ${money.format(competitorCalc.realProfit)} · margem ${number.format(competitorCalc.realMargin)}%` : "Informe seu custo para calcular o lucro e a margem no preço do anúncio."}
          </div>
        </div>
        <div class="cl-manual-entry">
          <label class="cl-field">
            <span class="cl-field__label">Simular meu preço de venda (R$)</span>
            <input class="cl-input" data-input="price" type="number" inputmode="decimal" min="0" step="0.01" autocomplete="off" placeholder="Digite o preço para simulação" value="${escapeHtml(simulatedPriceValue)}">
          </label>
          <div class="cl-output${simulatedCalc ? simulatedCalc.realProfit < 0 ? " cl-output--negative" : " cl-output--positive" : ""}" data-output="simulation">
            ${simulatedCalc ? `Repasse ML ${money.format(simulatedCalc.netPayout)} · lucro ${money.format(simulatedCalc.realProfit)} · margem ${number.format(simulatedCalc.realMargin)}%` : "Informe seu custo para calcular o resultado deste preço."}
          </div>
        </div>
      </div>
      <div data-dynamic-alert>${step ? `<div class="cl-step-alert">💡 Oportunidade de Degrau: a ${money.format(78.9)}, a tarifa cai de ${money.format(step.current.shippingFee)} para ${money.format(step.alternative.shippingFee)} e sobram +${money.format(step.difference)} no repasse.</div>` : ""}</div>
      ${wholesale ? `<div class="cl-wholesale">📦 No atacado: ${number.format(wholesale.quantity)} un. a ${money.format(wholesale.price)} — repasse estimado de ${money.format(wholesaleCalc.netPayout)}/un.</div>` : ""}`;
    }

    intelligenceHtml(calc) {
      const data = this.data;
      const referenceDate = data.creationDate ?? data.oldestDate;
      const parsedReferenceDate = referenceDate ? new Date(referenceDate) : null;
      const dateLabel = parsedReferenceDate && !Number.isNaN(parsedReferenceDate.valueOf()) ? parsedReferenceDate.toLocaleDateString("pt-BR") : "não identificada";
      const stats = data.hasDeepData ? `<div class="cl-stats">
        <div class="cl-stat"><span class="cl-stat__label">Vendas totais</span><strong class="cl-stat__value">${number.format(data.soldQuantity)} unidades</strong></div>
        <div class="cl-stat"><span class="cl-stat__label">Estoque atual</span><strong class="cl-stat__value">${number.format(data.availableStock)} un. · ${money.format(data.availableStock * data.price)}</strong></div>
        <div class="cl-stat"><span class="cl-stat__label">${data.creationDateIsEstimated ? "Data estimada" : "Data de criação"}</span><strong class="cl-stat__value">${escapeHtml(dateLabel)}</strong><small>${data.estimatedDaysActive ? `${number.format(data.estimatedDaysActive)} dias de atividade` : "Idade não identificada"}</small></div>
        <div class="cl-stat"><span class="cl-stat__label">Velocidade</span><strong class="cl-stat__value">${number.format(data.salesPerDay)} venda/dia</strong><small>~${number.format(data.salesPerMonth)} por mês</small></div>
        <div class="cl-stat cl-stat--full"><span class="cl-stat__label">Faturamento mensal estimado</span><strong class="cl-stat__value">${money.format(data.monthlyRevenue)}</strong></div>
        <div class="cl-stat cl-stat--full"><span class="cl-stat__label">Repasse mensal estimado</span><strong class="cl-stat__value">${money.format(data.salesPerMonth * calc.netPayout)}</strong><small>Antes de imposto, embalagem e custo do produto</small></div>
      </div>` : `<div class="cl-data-notice">Vendas, idade e velocidade não foram expostas por este tipo de anúncio. A análise financeira continua disponível com o preço visível.</div>`;
      return `${stats}<h3 class="cl-section-title">Raio-X do vendedor</h3><div class="cl-stat cl-stat--full"><strong>${escapeHtml(data.sellerName || "Nome não disponível")}</strong> ${data.sellerId ? `(ID: ${escapeHtml(data.sellerId)})` : ""}<br><span class="cl-muted">${escapeHtml(data.powerSellerStatus || data.reputationLevel || "Reputação não detectada")} ${data.hasNfe ? "· NF-e verificada" : ""}</span></div>`;
    }

    qualityHtml() {
      const data = this.data;
      const checks = [
        [data.picturesCount >= 8, `Quantidade de fotos: ${data.picturesCount || "não detectada"} (ideal ≥ 8)`],
        [data.hasGoodThumbnail, "Qualidade da imagem principal"], [data.hasClips, "Vídeo / Clip publicado"],
        [data.logisticType === "fulfillment", "Logística Full"], [Boolean(data.wholesaleShortcuts?.length), "Preço por quantidade / B2B"],
        [data.reviewRate >= 4.5 && data.reviewCount > 0, `Avaliação: ${number.format(data.reviewRate)} ★ (${number.format(data.reviewCount)})`]
      ];
      const score = Math.round(checks.filter(([ok]) => ok).length / checks.length * 100);
      return `<div class="cl-score"><div class="cl-score__number">${score}</div><div><strong>Score de qualidade</strong><br><span class="cl-muted">Use os itens pendentes para superar o anúncio.</span></div></div><ul class="cl-checklist">${checks.map(([ok, label]) => `<li>${ok ? "✅" : "❌"} ${escapeHtml(label)}</li>`).join("")}</ul>`;
    }

    bind() {
      const costInput = this.root.querySelector('[data-input="cost"]');
      const priceInput = this.root.querySelector('[data-input="price"]');
      const competitorOutput = this.root.querySelector('[data-output="competitor"]');
      const simulationOutput = this.root.querySelector('[data-output="simulation"]');
      const protectInput = (event) => {
        event.stopPropagation();
        if (event.type === "keydown" && event.key === "Enter") event.preventDefault();
      };
      [costInput, priceInput].forEach((input) => {
        ["pointerdown", "mousedown", "click", "keydown", "beforeinput", "input", "change"].forEach((eventName) => input.addEventListener(eventName, protectInput));
      });
      const recalculate = () => {
        this.manualCost = costInput.value;
        this.manualPrice = priceInput.value;
        const hasCost = costInput.value !== "" && Number.isFinite(Number(costInput.value));
        if (!hasCost) {
          competitorOutput.textContent = "Informe seu custo para calcular o lucro e a margem no preço do anúncio.";
          simulationOutput.textContent = "Informe seu custo para calcular o resultado deste preço.";
          [competitorOutput, simulationOutput].forEach((output) => output.classList.remove("cl-output--negative", "cl-output--positive"));
          return;
        }
        const productCost = Math.max(0, Number(costInput.value));
        const price = Math.max(0, asNumber(priceInput.value, this.data.price));
        const competitorCalc = MeliPricingEngine2026.calculate(this.input(this.data, { productCost }));
        const simulatedCalc = MeliPricingEngine2026.calculate(this.input(this.data, { price, productCost }));
        competitorOutput.textContent = `No preço do anúncio: lucro ${money.format(competitorCalc.realProfit)} · margem ${number.format(competitorCalc.realMargin)}%`;
        simulationOutput.textContent = `Repasse ML ${money.format(simulatedCalc.netPayout)} · lucro ${money.format(simulatedCalc.realProfit)} · margem ${number.format(simulatedCalc.realMargin)}%`;
        competitorOutput.classList.toggle("cl-output--negative", competitorCalc.realProfit < 0);
        competitorOutput.classList.toggle("cl-output--positive", competitorCalc.realProfit >= 0);
        simulationOutput.classList.toggle("cl-output--negative", simulatedCalc.realProfit < 0);
        simulationOutput.classList.toggle("cl-output--positive", simulatedCalc.realProfit >= 0);
        const step = MeliPricingEngine2026.stepOpportunity(this.input(this.data, { price }));
        this.root.querySelector("[data-dynamic-alert]").innerHTML = step ? `<div class="cl-step-alert">💡 A ${money.format(78.9)}, sobram +${money.format(step.difference)} no repasse devido ao degrau da tarifa.</div>` : "";
      };
      costInput.addEventListener("input", recalculate);
      priceInput.addEventListener("input", recalculate);
    }
  }

  class SearchPolycardInjector {
    constructor(settings, registry, onUpdate) {
      this.settings = settings;
      this.registry = registry;
      this.onUpdate = onUpdate;
      this.items = new Map();
      this.observer = null;
      this.visibilityObserver = null;
      this.sequence = 0;
      this.queue = [];
      this.queued = new Set();
      this.processing = false;
      this.debouncedUpdate = debounce(() => this.onUpdate?.(), 100);
      this.registry.subscribe(() => this.syncStructured());
    }
    commission(data) { return data.listingTypeId === "gold_pro" ? this.settings.premiumCommission : this.settings.classicCommission; }
    calculation(data, overrides = {}) { return MeliPricingEngine2026.calculate({ price: data.price, commissionPercent: this.commission(data), taxPercent: this.settings.taxPercent, packagingCost: this.settings.packagingCost, weightGrams: 1000, logisticType: data.logisticType, meliSubsidy: data.meliSubsidy, considerSubsidy: this.settings.considerSubsidy, adsPercent: data.isSponsored ? 3 : 0, ...overrides }); }
    prune() {
      this.items.forEach((item, card) => {
        if (!card.isConnected || !item.panel.isConnected) {
          this.visibilityObserver?.unobserve(card);
          card.removeAttribute("data-calculadora-livre-ready");
          this.queued.delete(item);
          this.items.delete(card);
        }
      });
    }
    scan(root = document) {
      this.prune();
      root.querySelectorAll?.(CARD_SELECTOR).forEach((card) => this.inject(card));
    }
    inject(card) {
      if (card.dataset.calculadoraLivreReady === "1") return;
      if (card.closest(".andes-carousel-snapped, [data-andes-carousel-snapped-main], .poly-component__carousel")) return;
      const data = DomFallbackExtractor.fromSearchCard(card);
      if (!data.price || !data.permalink) return;
      const catMeta = this.registry.getCategoryMetadata(data);
      if (catMeta) {
        data.domainId = data.domainId || catMeta.domainId || "";
        data.categoryId = data.categoryId || catMeta.categoryId || "";
        data.categoryName = data.categoryName || catMeta.categoryName || "";
        data.brand = data.brand || catMeta.brand || "";
      }
      card.dataset.calculadoraLivreReady = "1";
      const panel = document.createElement("section"); panel.className = "cl-root cl-poly";
      const mountPoint = card.querySelector(".poly-card__content") ?? card.querySelector(".poly-card") ?? card;
      const layoutItem = card.closest(".ui-search-layout__item") ?? card;
      layoutItem.classList.add("cl-poly-card-host");
      mountPoint.classList.add("cl-poly-host");
      mountPoint.append(panel);
      const item = { card, panel, data, advanced: null, advancedState: "idle", originalIndex: this.sequence++, bound: false };
      this.items.set(card, item);
      this.applyStructured(item);
      this.render(item);
      this.visibilityObserver?.observe(card);
      this.debouncedUpdate();
    }
    render(item) {
      const { data, panel } = item;
      const calc = this.calculation(data);
      panel.innerHTML = `<div class="cl-poly__header"><div><strong>Calculadora Livre</strong><span>Estimativa do anúncio</span></div></div>
        <div class="cl-badges">${data.campaignType === "lightning" ? '<span class="cl-badge cl-badge--yellow">⚡ Oferta Relâmpago</span>' : ""}<span class="cl-badge cl-badge--blue">${data.listingTypeId === "gold_pro" ? "Premium" : "Clássico"} · ${number.format(this.commission(data))}%</span>${data.logisticType === "fulfillment" ? '<span class="cl-badge cl-badge--green">Full</span>' : ""}${data.isSponsored ? '<span class="cl-badge cl-badge--yellow">Publicidade 3%</span>' : ""}</div>
        <dl class="cl-search-metrics">
          <div><dt>Preço</dt><dd>${money.format(calc.price)}</dd></div>
          <div><dt>Comissão</dt><dd class="cl-negative">− ${money.format(calc.commission)}</dd></div>
          <div><dt>Envio estimado</dt><dd class="cl-negative">− ${money.format(calc.shippingFee)}</dd></div>
          <div class="cl-search-metrics__total"><dt>Você recebe do ML</dt><dd>${money.format(calc.netPayout)}</dd></div>
        </dl>${this.intelligenceHtml(item)}`;
      this.bind(item);
    }

    intelligenceHtml(item) {
      const data = item.advanced;
      if (data) {
        const creation = data.creationDate ? new Date(data.creationDate) : null;
        const validCreation = creation && !Number.isNaN(creation.valueOf());
        const creationLabel = validCreation ? shortDate.format(creation) : "Não identificada";
        const ageLabel = data.estimatedDaysActive ? `${number.format(data.estimatedDaysActive)} dias` : "Sem idade";
        return `<dl class="cl-search-metrics cl-search-intelligence-list">
          <div><dt>${data.creationDateIsEstimated ? "Criação estimada" : "Criação"}</dt><dd>${escapeHtml(creationLabel)} <small>(${escapeHtml(ageLabel)})</small></dd></div>
          <div><dt>Vendas registradas</dt><dd>${number.format(data.soldQuantity)} un.</dd></div>
          <div><dt>Média diária</dt><dd>${number.format(data.salesPerDay)} /dia</dd></div>
          <div><dt>Faturamento mensal</dt><dd>${money.format(data.monthlyRevenue)}</dd></div>
        </dl>`;
      }
      if (item.data.soldQuantity) {
        return `<dl class="cl-search-metrics cl-search-intelligence-list">
          <div><dt>Vendas registradas</dt><dd>${number.format(item.data.soldQuantity)} un.</dd></div>
        </dl>`;
      }
      if (item.advancedState === "queued" || item.advancedState === "loading") return `<dl class="cl-search-metrics cl-search-intelligence-list" aria-label="Carregando dados adicionais"><div class="cl-skeleton"><dt>Criação</dt><dd>Carregando</dd></div><div class="cl-skeleton"><dt>Vendas</dt><dd>Carregando</dd></div><div class="cl-skeleton"><dt>Média diária</dt><dd>Carregando</dd></div><div class="cl-skeleton"><dt>Faturamento</dt><dd>Carregando</dd></div></dl>`;
      return "";
    }

    applyStructured(item) {
      const catMeta = this.registry.getCategoryMetadata(item.data);
      if (catMeta) {
        item.data.domainId = item.data.domainId || catMeta.domainId || "";
        item.data.categoryId = item.data.categoryId || catMeta.categoryId || "";
        item.data.categoryName = item.data.categoryName || catMeta.categoryName || "";
        item.data.brand = item.data.brand || catMeta.brand || "";
      }
      const record = this.registry.find(item.data);
      if (!record?.creationDate || !record.soldQuantity) return false;
      item.advanced = record;
      if (catMeta) {
        item.advanced.domainId = item.advanced.domainId || catMeta.domainId || "";
        item.advanced.categoryId = item.advanced.categoryId || catMeta.categoryId || "";
        item.advanced.categoryName = item.advanced.categoryName || catMeta.categoryName || "";
        item.advanced.brand = item.advanced.brand || catMeta.brand || "";
      }
      item.advancedState = "ready";
      this.queued.delete(item);
      return true;
    }

    syncStructured() {
      let changed = false;
      this.items.forEach((item) => {
        if (this.applyStructured(item)) { this.render(item); changed = true; }
      });
      if (changed) this.debouncedUpdate();
    }

    enqueue(item, force = false) {
      if (!item?.card.isConnected || this.applyStructured(item)) { this.render(item); return; }
      if (this.queued.has(item) || item.advancedState === "loading") return;
      if (!force && item.advancedState === "error") return;
      item.advancedState = "queued";
      this.queued.add(item);
      this.queue.push(item);
      this.render(item);
      this.processQueue();
    }

    async processQueue() {
      if (this.processing) return;
      this.processing = true;
      while (this.queue.length) {
        const item = this.queue.shift();
        this.queued.delete(item);
        if (!item?.card.isConnected || this.applyStructured(item)) { if (item?.panel.isConnected) this.render(item); continue; }
        item.advancedState = "loading";
        this.render(item);
        try {
          const response = await chrome.runtime.sendMessage({ type: "calculadora-livre:fetch-product", url: item.data.permalink });
          if (!response?.ok || !response.html) throw new Error(response?.error || "Resposta vazia.");
          const pdp = NordicJsonExtractor.fromHtml(response.html);
          if (!pdp || (!pdp.soldQuantity && !pdp.creationDate)) throw new Error("O anúncio não expôs vendas ou data.");
          this.registry.addFetchedPdp(pdp);
          item.advanced = this.registry.find(item.data) ?? {
            identifiers: NordicJsonExtractor.extractIdentifiers([pdp.itemId, pdp.userProductId, item.data.permalink]),
            title: pdp.title || item.data.title,
            price: item.data.price,
            soldQuantity: pdp.soldQuantity,
            creationDate: pdp.creationDate,
            creationDateIsEstimated: pdp.creationDateIsEstimated,
            estimatedDaysActive: pdp.estimatedDaysActive,
            salesPerDay: pdp.estimatedDaysActive ? pdp.soldQuantity / pdp.estimatedDaysActive : 0,
            salesPerMonth: pdp.estimatedDaysActive ? pdp.soldQuantity / pdp.estimatedDaysActive * 30 : 0,
            monthlyRevenue: pdp.estimatedDaysActive ? pdp.soldQuantity / pdp.estimatedDaysActive * 30 * item.data.price : 0
          };
          item.advancedState = "ready";
        } catch (error) {
          item.advancedState = "error";
          console.debug(`${APP}: inteligência indisponível para ${item.data.permalink}`, error);
        }
        this.render(item);
        this.debouncedUpdate();
      }
      this.processing = false;
    }

    bind(item) {
      if (item.bound) return;
      item.bound = true;
      item.panel.addEventListener("click", (event) => {
        event.stopPropagation();
        const retry = event.target.closest("[data-retry]");
        if (retry) {
          event.preventDefault();
          item.advancedState = "idle";
          this.enqueue(item, true);
        } else if (event.target.closest("button, input, select")) event.preventDefault();
      });
    }
    observe() {
      this.visibilityObserver = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) this.enqueue(this.items.get(entry.target));
        });
      }, { rootMargin: "280px 0px", threshold: 0.01 });
      this.scan();
      const refresh = debounce(() => { this.scan(); this.debouncedUpdate(); }, 350);
      this.observer = new MutationObserver((records) => {
        const hasExternalChange = records.some((record) => !(record.target instanceof Element) || !record.target.closest(".cl-root"));
        if (hasExternalChange) refresh();
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { this.scan(); this.debouncedUpdate(); }, 1200);
    }
    values() { return [...this.items.values()]; }
  }

  class IQVAnalysisEngine {
    static CONFIG = Object.freeze({
      WEIGHTS: {
        GIRO: 0.40,
        RECEITA: 0.35,
        RETORNO: 0.25
      },
      REFERENCES: {
        MAX_GIRO_DAILY: 40,
        MAX_REVENUE_MONTHLY: 50000,
        MIN_RETURN_RATIO: 0.50,
        MAX_RETURN_RATIO: 0.85
      },
      TIERS: [
        { id: "baixo", label: "Ticket Baixo", rangeLabel: "Até R$ 50", max: 50.00 },
        { id: "medio", label: "Ticket Médio", rangeLabel: "R$ 50,01 a R$ 99,99", max: 99.999999 },
        { id: "alto", label: "Ticket Alto", rangeLabel: "A partir de R$ 100", max: Infinity }
      ]
    });

    static median(values) {
      if (!Array.isArray(values) || values.length === 0) return null;
      const valid = values.filter((v) => typeof v === "number" && Number.isFinite(v));
      if (valid.length === 0) return null;
      valid.sort((a, b) => a - b);
      const mid = Math.floor(valid.length / 2);
      return valid.length % 2 !== 0 ? valid[mid] : (valid[mid - 1] + valid[mid]) / 2;
    }

    static scoreGiro(G) {
      if (G == null || !Number.isFinite(G) || G <= 0) return 0;
      return 100 * Math.min(1, Math.log(1 + G) / Math.log(1 + this.CONFIG.REFERENCES.MAX_GIRO_DAILY));
    }

    static scoreReceita(F) {
      if (F == null || !Number.isFinite(F) || F <= 0) return 0;
      return 100 * Math.min(1, Math.log(1 + F) / Math.log(1 + this.CONFIG.REFERENCES.MAX_REVENUE_MONTHLY));
    }

    static scoreRetorno(R) {
      if (R == null || !Number.isFinite(R)) return 0;
      const { MIN_RETURN_RATIO, MAX_RETURN_RATIO } = this.CONFIG.REFERENCES;
      const range = MAX_RETURN_RATIO - MIN_RETURN_RATIO;
      return 100 * clamp((R - MIN_RETURN_RATIO) / range, 0, 1);
    }

    static scoreTier(sg, sf, sr) {
      const { GIRO, RECEITA, RETORNO } = this.CONFIG.WEIGHTS;
      return clamp((sg * GIRO) + (sf * RECEITA) + (sr * RETORNO), 0, 100);
    }

    static getTierId(price) {
      if (!Number.isFinite(price) || price <= 50.00) return "baixo";
      if (price < 100.00) return "medio";
      return "alto";
    }

    static getClassification(score) {
      if (score == null || !Number.isFinite(score)) return { label: "Dados insuficientes", color: "#737373", class: "none" };
      if (score < 20) return { label: "Muito baixa", color: "#f23d4f", class: "low" };
      if (score < 40) return { label: "Baixa", color: "#f57916", class: "low" };
      if (score < 60) return { label: "Moderada", color: "#d97706", class: "medium" };
      if (score < 80) return { label: "Boa", color: "#00a650", class: "high" };
      return { label: "Muito alta", color: "#007a37", class: "high" };
    }

    static analyze(items, calculationFn) {
      const totalAds = items.length;
      let loadingCount = 0;
      let estimatedDatesCount = 0;

      const tiers = {
        baixo: { config: this.CONFIG.TIERS[0], all: [], valid: [] },
        medio: { config: this.CONFIG.TIERS[1], all: [], valid: [] },
        alto: { config: this.CONFIG.TIERS[2], all: [], valid: [] }
      };

      items.forEach((item) => {
        if (!item?.card?.isConnected) return;
        if (item.advancedState === "queued" || item.advancedState === "loading") loadingCount += 1;
        const price = asNumber(item.data?.price);
        if (price <= 0) return;
        const tierId = this.getTierId(price);
        const tier = tiers[tierId];
        tier.all.push(item);

        const hasGiro = item.advanced?.salesPerDay != null && Number.isFinite(item.advanced.salesPerDay) && item.advanced.salesPerDay >= 0;
        if (hasGiro) {
          tier.valid.push(item);
          if (item.advanced.creationDateIsEstimated) estimatedDatesCount += 1;
        }
      });

      const tierResults = {};
      let totalEvaluated = 0;
      let weightedScoreSum = 0;
      let totalWeight = 0;

      for (const [tierId, tier] of Object.entries(tiers)) {
        const validCount = tier.valid.length;
        totalEvaluated += validCount;

        if (validCount === 0) {
          tierResults[tierId] = {
            id: tierId,
            label: tier.config.label,
            rangeLabel: tier.config.rangeLabel,
            hasData: false,
            validCount: 0,
            totalCount: tier.all.length,
            score: null,
            sg: null,
            sf: null,
            sr: null,
            medianGiro: null,
            medianRevenue: null,
            medianReturnRatio: null,
            medianPayout: null,
            classification: { label: "Dados insuficientes", color: "#737373" }
          };
          continue;
        }

        // Prioriza anúncios orgânicos para diminuir distorção por posicionamento patrocinado (se amostra >= 3)
        const organicValid = tier.valid.filter((it) => !it.data?.isSponsored);
        const sample = organicValid.length >= 3 ? organicValid : tier.valid;

        const medianGiro = this.median(sample.map((it) => it.advanced.salesPerDay));
        const medianRevenue = this.median(sample.map((it) => it.advanced.monthlyRevenue ?? (it.advanced.salesPerDay * 30 * it.data.price)));

        const returnRatios = sample.map((it) => {
          const calc = calculationFn(it.data);
          return it.data.price > 0 ? (calc.netPayout / it.data.price) : 0;
        });
        const payouts = sample.map((it) => calculationFn(it.data).netPayout);
        const medianReturnRatio = this.median(returnRatios);
        const medianPayout = this.median(payouts);

        const sg = this.scoreGiro(medianGiro);
        const sf = this.scoreReceita(medianRevenue);
        const sr = this.scoreRetorno(medianReturnRatio);
        const tScore = this.scoreTier(sg, sf, sr);

        tierResults[tierId] = {
          id: tierId,
          label: tier.config.label,
          rangeLabel: tier.config.rangeLabel,
          hasData: true,
          validCount,
          totalCount: tier.all.length,
          score: tScore,
          sg,
          sf,
          sr,
          medianGiro,
          medianRevenue,
          medianReturnRatio,
          medianPayout,
          classification: this.getClassification(tScore)
        };

        weightedScoreSum += tScore * validCount;
        totalWeight += validCount;
      }

      const generalScore = totalWeight > 0 ? (weightedScoreSum / totalWeight) : null;
      const generalClassification = this.getClassification(generalScore);

      let state = "available";
      let reliability = "none";
      let reliabilityLabel = "Nenhuma";

      if (totalAds === 0) {
        state = "empty";
      } else if (totalEvaluated === 0) {
        state = loadingCount > 0 ? "analyzing" : "insufficient";
      } else if (totalEvaluated < 5) {
        state = "preview";
        reliability = "low";
        reliabilityLabel = "Baixa";
      } else if (totalEvaluated < 15) {
        state = "available";
        reliability = "medium";
        reliabilityLabel = "Média";
      } else {
        state = "available";
        const estimatedRatio = estimatedDatesCount / totalEvaluated;
        if (estimatedRatio > 0.70) {
          reliability = "medium";
          reliabilityLabel = "Média (datas estimadas)";
        } else {
          reliability = "high";
          reliabilityLabel = "Alta";
        }
      }

      return {
        state,
        generalScore,
        generalClassification,
        tiers: tierResults,
        totalEvaluated,
        totalAds,
        loadingCount,
        reliability,
        reliabilityLabel
      };
    }
  }

  class MarketIntelligenceEngine {
    static percentile(arr, p) {
      if (!Array.isArray(arr) || arr.length === 0) return 0;
      const sorted = arr.filter((v) => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
      if (!sorted.length) return 0;
      const index = (sorted.length - 1) * p;
      const lower = Math.floor(index);
      const upper = Math.ceil(index);
      const weight = index - lower;
      return sorted[lower] * (1 - weight) + sorted[upper] * weight;
    }

    static filterBySegment(items, segment) {
      if (!segment || segment === "all") return items;
      return items.filter((item) => {
        const p = asNumber(item.data?.price);
        if (p <= 0) return false;
        return IQVAnalysisEngine.getTierId(p) === segment;
      });
    }

    // 1. Radar de Demanda
    static calculateDemand(items) {
      const valid = items.filter((it) => it.advanced?.salesPerDay != null && Number.isFinite(it.advanced.salesPerDay) && it.advanced.salesPerDay >= 0);
      const validCount = valid.length;
      const totalAds = items.length;

      const salesList = valid.map((it) => it.advanced.salesPerDay);
      const revenueList = valid.map((it) => it.advanced.monthlyRevenue ?? (it.advanced.salesPerDay * 30 * it.data.price));

      const totalGiro = salesList.reduce((a, b) => a + b, 0);
      const medianGiro = IQVAnalysisEngine.median(salesList) ?? 0;
      const totalRevenue = revenueList.reduce((a, b) => a + b, 0);
      const medianRevenue = IQVAnalysisEngine.median(revenueList) ?? 0;

      const p25 = this.percentile(salesList, 0.25);
      const p50 = this.percentile(salesList, 0.50);
      const p75 = this.percentile(salesList, 0.75);

      const brackets = [
        { label: "Até 2 un./dia", count: 0, min: 0, max: 2 },
        { label: "2 a 5 un./dia", count: 0, min: 2.0001, max: 5 },
        { label: "5 a 10 un./dia", count: 0, min: 5.0001, max: 10 },
        { label: "10 a 20 un./dia", count: 0, min: 10.0001, max: 20 },
        { label: "Mais de 20 un./dia", count: 0, min: 20.0001, max: Infinity }
      ];
      salesList.forEach((s) => {
        const b = brackets.find((br) => s <= br.max) ?? brackets.at(-1);
        b.count += 1;
      });

      const tiers = ["baixo", "medio", "alto"].map((tId) => {
        const tItems = valid.filter((it) => IQVAnalysisEngine.getTierId(it.data.price) === tId);
        const tGiroList = tItems.map((it) => it.advanced.salesPerDay);
        const tRevList = tItems.map((it) => it.advanced.monthlyRevenue ?? (it.advanced.salesPerDay * 30 * it.data.price));
        const tGiroSum = tGiroList.reduce((a, b) => a + b, 0);
        return {
          id: tId,
          label: tId === "baixo" ? "Ticket Baixo" : tId === "medio" ? "Ticket Médio" : "Ticket Alto",
          validCount: tItems.length,
          medianGiro: IQVAnalysisEngine.median(tGiroList) ?? 0,
          medianRevenue: IQVAnalysisEngine.median(tRevList) ?? 0,
          totalGiro: tGiroSum,
          giroShare: totalGiro > 0 ? (tGiroSum / totalGiro * 100) : 0
        };
      });

      const avgGiro = validCount > 0 ? (totalGiro / validCount) : 0;
      const skew = avgGiro > medianGiro * 1.5 ? "forte influência de anúncios excepcionais puxando a média para cima" : "distribuição comercial relativamente equilibrada";
      const leadTier = tiers.reduce((prev, curr) => curr.giroShare > prev.giroShare ? curr : prev, tiers[0]);
      const insight = validCount > 0
        ? `A amostra analisada apresenta giro diário mediano de <strong>${number.format(medianGiro)} un./dia</strong> e faturamento mensal mediano de <strong>${money.format(medianRevenue)}</strong> por anúncio. O <strong>${leadTier.label}</strong> concentra <strong>${leadTier.giroShare.toFixed(1)}%</strong> do volume de giro agregado. A diferença entre média (${number.format(avgGiro)} un./dia) e mediana (${number.format(medianGiro)} un./dia) indica ${skew}.`
        : "Dados comerciais insuficientes na amostra atual para construir o radar de demanda.";

      return {
        validCount,
        totalAds,
        coveragePercent: totalAds > 0 ? Math.round(validCount / totalAds * 100) : 0,
        totalGiro,
        medianGiro,
        totalRevenue,
        medianRevenue,
        p25,
        p50,
        p75,
        brackets,
        tiers,
        insight
      };
    }

    // 2. Faixas de Preço Mais Eficientes
    static calculatePriceEfficiency(items, calculationFn, mode = "10") {
      const valid = items.filter((it) => asNumber(it.data?.price) > 0);
      if (!valid.length) return { bins: [], best: null, highestGiro: null, highestRevenue: null, highestReturn: null, insight: "Sem dados suficientes." };

      const prices = valid.map((it) => it.data.price);
      const minP = Math.min(...prices);
      const maxP = Math.max(...prices);

      let step = 10;
      if (mode === "20") step = 20;
      else if (mode === "auto") {
        const range = maxP - minP;
        if (range <= 50) step = 10;
        else if (range <= 150) step = 25;
        else if (range <= 300) step = 50;
        else step = 100;
      }

      const start = Math.floor(minP / step) * step;
      const end = Math.ceil(maxP / step) * step;
      const bins = [];

      for (let s = start; s < end; s += step) {
        const binMin = s;
        const isLast = (s + step >= end);
        const binMax = s + step;
        const inBin = valid.filter((it) => isLast ? (it.data.price >= binMin && it.data.price <= binMax) : (it.data.price >= binMin && it.data.price < binMax));
        if (!inBin.length) continue;

        const withSales = inBin.filter((it) => it.advanced?.salesPerDay != null && Number.isFinite(it.advanced.salesPerDay) && it.advanced.salesPerDay >= 0);
        const giroList = withSales.map((it) => it.advanced.salesPerDay);
        const revList = withSales.map((it) => it.advanced.monthlyRevenue ?? (it.advanced.salesPerDay * 30 * it.data.price));

        const returnRatios = inBin.map((it) => {
          const calc = calculationFn(it.data);
          return it.data.price > 0 ? (calc.netPayout / it.data.price) : 0;
        });
        const payouts = inBin.map((it) => calculationFn(it.data).netPayout);

        const medianGiro = IQVAnalysisEngine.median(giroList) ?? 0;
        const totalGiro = giroList.reduce((a, b) => a + b, 0);
        const medianRevenue = IQVAnalysisEngine.median(revList) ?? 0;
        const totalRevenue = revList.reduce((a, b) => a + b, 0);
        const medianReturnRatio = IQVAnalysisEngine.median(returnRatios) ?? 0;
        const medianPayout = IQVAnalysisEngine.median(payouts) ?? 0;

        const sg = IQVAnalysisEngine.scoreGiro(medianGiro);
        const sf = IQVAnalysisEngine.scoreReceita(medianRevenue);
        const sr = IQVAnalysisEngine.scoreRetorno(medianReturnRatio);
        const efficiencyScore = IQVAnalysisEngine.scoreTier(sg, sf, sr);

        bins.push({
          label: `R$ ${binMin.toFixed(0)} a R$ ${binMax.toFixed(2).replace('.', ',')}`,
          min: binMin,
          max: binMax,
          count: inBin.length,
          validCount: withSales.length,
          medianGiro,
          totalGiro,
          medianRevenue,
          totalRevenue,
          medianReturnRatio,
          medianPayout,
          sg,
          sf,
          sr,
          efficiencyScore
        });
      }

      const qualified = bins.filter((b) => b.validCount >= 1);
      const robust = bins.filter((b) => b.validCount >= 2);
      const targetPool = robust.length ? robust : (qualified.length ? qualified : bins);

      const best = [...targetPool].sort((a, b) => b.efficiencyScore - a.efficiencyScore)[0] ?? null;
      const highestGiro = [...targetPool].sort((a, b) => b.medianGiro - a.medianGiro)[0] ?? null;
      const highestRevenue = [...targetPool].sort((a, b) => b.medianRevenue - a.medianRevenue)[0] ?? null;
      const highestReturn = [...targetPool].sort((a, b) => b.medianReturnRatio - a.medianReturnRatio)[0] ?? null;

      const insight = best
        ? `Entre as faixas analisadas com amostra consistente, a faixa de <strong>${best.label}</strong> apresenta a maior eficiência comercial (nota <strong>${best.efficiencyScore.toFixed(1)}/100</strong>), equilibrando giro diário (${number.format(best.medianGiro)} un/dia), faturamento mensal (${money.format(best.medianRevenue)}) e repasse líquido de ${(best.medianReturnRatio * 100).toFixed(1)}%.`
        : "Dados insuficientes para determinar faixas de preço eficientes.";

      return { bins, best, highestGiro, highestRevenue, highestReturn, insight };
    }

    // 3. Concentração de Concorrentes
    static calculateCompetition(items) {
      const valid = items.filter((it) => it.advanced?.monthlyRevenue != null && Number.isFinite(it.advanced.monthlyRevenue) && it.advanced.monthlyRevenue > 0);
      const totalRevenue = valid.reduce((a, it) => a + (it.advanced.monthlyRevenue ?? 0), 0);
      const validCount = valid.length;

      if (!validCount || totalRevenue <= 0) {
        return {
          validCount: 0,
          totalRevenue: 0,
          c5: 0,
          c10: 0,
          hhi: 0,
          hhiClassification: "Dados insuficientes",
          top5: [],
          insight: "Dados de faturamento insuficientes para análise de concentração."
        };
      }

      const sorted = [...valid].sort((a, b) => (b.advanced.monthlyRevenue ?? 0) - (a.advanced.monthlyRevenue ?? 0));
      const top5Items = sorted.slice(0, 5);
      const top10Items = sorted.slice(0, 10);

      const top5Revenue = top5Items.reduce((a, it) => a + it.advanced.monthlyRevenue, 0);
      const top10Revenue = top10Items.reduce((a, it) => a + it.advanced.monthlyRevenue, 0);

      const c5 = (top5Revenue / totalRevenue) * 100;
      const c10 = validCount >= 10 ? (top10Revenue / totalRevenue) * 100 : null;

      const hhi = sorted.reduce((acc, it) => {
        const share = ((it.advanced.monthlyRevenue ?? 0) / totalRevenue) * 100;
        return acc + (share * share);
      }, 0);

      let hhiClassification = "Demanda distribuída";
      let hhiDesc = "baixa concentração entre os anúncios observados, permitindo espaço para novos concorrentes.";
      if (hhi >= 2500 || c5 >= 75) {
        hhiClassification = "Demanda concentrada nos líderes";
        hhiDesc = "elevada concentração nos líderes da busca, sugerindo um mercado dominado por poucos anúncios de alto volume.";
      } else if (hhi >= 1500 || c5 >= 50) {
        hhiClassification = "Concentração intermediária";
        hhiDesc = "concentração intermediária, com liderança relevante porém sem monopólio de vendas.";
      }

      const top5 = top5Items.map((it, idx) => {
        const rev = it.advanced.monthlyRevenue ?? 0;
        const share = (rev / totalRevenue) * 100;
        const thumb = it.data.thumbnail || it.card?.querySelector(".poly-card__portada img, .ui-search-result-image__element, img")?.getAttribute("src") || "";
        return {
          rank: idx + 1,
          title: it.data.title || "Anúncio do Mercado Livre",
          price: it.data.price,
          permalink: it.data.permalink,
          thumbnail: thumb,
          salesPerDay: it.advanced.salesPerDay ?? 0,
          monthlyRevenue: rev,
          share,
          isSponsored: Boolean(it.data.isSponsored),
          isFull: Boolean(it.data.isFull || it.data.logisticType === "fulfillment"),
          logisticType: it.data.logisticType,
          listingTypeId: it.data.listingTypeId
        };
      });

      const insight = `Os cinco maiores anúncios representam <strong>${c5.toFixed(1)}%</strong> do faturamento estimado da amostra (Índice HHI de ${Math.round(hhi)} pontos). Isso indica ${hhiDesc}`;

      return {
        validCount,
        totalRevenue,
        c5,
        c10,
        hhi: Math.round(hhi),
        hhiClassification,
        top5,
        insight
      };
    }

    // 4. Novos Entrantes — Sinais de Alto Giro
    static calculateNewEntrants(items, ticketMedians) {
      const candidates = items.filter((it) => {
        const days = it.advanced?.estimatedDaysActive;
        const salesPerDay = it.advanced?.salesPerDay;
        return days != null && Number.isFinite(days) && days > 0 && days <= 90 && salesPerDay != null && Number.isFinite(salesPerDay) && salesPerDay > 0;
      });

      const count = candidates.length;
      if (!count) {
        return {
          count: 0,
          aboveMedianCount: 0,
          topEntrants: [],
          insight: "Nenhum anúncio recente (com até 90 dias de atividade identificada) com vendas detectado na amostra atual."
        };
      }

      const evaluated = candidates.map((it) => {
        const tierId = IQVAnalysisEngine.getTierId(it.data.price);
        const tMedian = ticketMedians[tierId] || 1;
        const mult = it.advanced.salesPerDay / tMedian;
        const isEstimated = Boolean(it.advanced.creationDateIsEstimated);
        const thumb = it.data.thumbnail || it.card?.querySelector(".poly-card__portada img, .ui-search-result-image__element, img")?.getAttribute("src") || "";

        let status = "Giro em linha com a mediana";
        let isUnconfirmed = false;
        if (mult > 2.0) status = "Giro muito acima da mediana";
        else if (mult >= 1.5) status = "Giro acima da mediana";
        else if (mult < 0.8) status = "Giro abaixo da mediana";

        if (isEstimated && mult > 4.0 && (it.advanced.soldQuantity >= 500)) {
          isUnconfirmed = true;
          status = "Sinal não confirmado (velocidade extrema com data aproximada)";
        }

        return {
          title: it.data.title || "Anúncio recente",
          permalink: it.data.permalink,
          thumbnail: thumb,
          price: it.data.price,
          daysActive: it.advanced.estimatedDaysActive,
          creationDate: it.advanced.creationDate,
          isEstimatedDate: isEstimated,
          salesPerDay: it.advanced.salesPerDay,
          monthlyRevenue: it.advanced.monthlyRevenue,
          isFull: Boolean(it.data.isFull || it.data.logisticType === "fulfillment"),
          logisticType: it.data.logisticType,
          tierId,
          multiplier: mult,
          status,
          isUnconfirmed
        };
      });

      evaluated.sort((a, b) => b.multiplier - a.multiplier);
      const topEntrants = evaluated.slice(0, 5);
      const aboveMedianCount = evaluated.filter((e) => e.multiplier >= 1.2).length;

      const insight = `Foram encontrados <strong>${count} anúncios</strong> aparentemente recentes (até 90 dias). <strong>${aboveMedianCount}</strong> deles apresentam velocidade de giro superior à mediana dos respectivos tickets, indicando ${aboveMedianCount > 0 ? "movimentação de novos concorrentes ganhando tração rápida" : "entrada tímida de novos anúncios sem tração extraordinária"}.`;

      return {
        count,
        aboveMedianCount,
        topEntrants,
        insight
      };
    }

    // 5. Simulador de Entrada no Mercado
    static calculateSimulator(input, pricingEngine) {
      const price = Math.max(0.01, asNumber(input.price, 99.90));
      const productCost = input.productCost !== "" && input.productCost != null ? Math.max(0, asNumber(input.productCost, 0)) : null;
      const taxPercent = clamp(asNumber(input.taxPercent, 6), 0, 100);
      const packagingCost = Math.max(0, asNumber(input.packagingCost, 1.50));
      const adsPercent = clamp(asNumber(input.adsPercent, 0), 0, 100);
      const weightGrams = Math.max(1, asNumber(input.weightGrams, 1000));
      const listingTypeId = input.listingTypeId === "gold_pro" ? "gold_pro" : "gold_special";
      const logisticType = input.logisticType || "fulfillment";
      const dailySales = Math.max(0, asNumber(input.dailySales, 4));
      const targetMargin = clamp(asNumber(input.targetMargin, 15), 0, 100);
      const monthlyGoal = Math.max(0, asNumber(input.monthlyGoal, 5000));

      const commissionPercent = listingTypeId === "gold_pro" ? 17 : 12;
      const calc = pricingEngine.calculate({
        price,
        commissionPercent,
        taxPercent,
        packagingCost,
        weightGrams,
        logisticType,
        adsPercent,
        productCost: productCost ?? 0,
        considerSubsidy: false
      });

      const repasse = calc.netPayout;
      const taxes = price * taxPercent / 100;
      const adsCost = price * adsPercent / 100;
      const knownExpenses = taxes + adsCost + packagingCost;

      const unitProfit = productCost != null ? (repasse - knownExpenses - productCost) : null;
      const marginPercent = unitProfit != null && price > 0 ? (unitProfit / price * 100) : null;
      const monthlyRevenue = price * dailySales * 30;
      const monthlyProfit = unitProfit != null ? (unitProfit * dailySales * 30) : null;
      const unitsForGoal = unitProfit != null && unitProfit > 0 ? Math.ceil(monthlyGoal / unitProfit) : null;

      const maxAcquisitionCost = repasse - knownExpenses - (price * targetMargin / 100);

      let minViablePrice = null;
      if (productCost != null && productCost > 0) {
        let low = Math.max(1, productCost);
        let high = 50000;
        const evalMargin = (p) => {
          const testCalc = pricingEngine.calculate({
            price: p,
            commissionPercent,
            taxPercent,
            packagingCost,
            weightGrams,
            logisticType,
            adsPercent,
            productCost,
            considerSubsidy: false
          });
          const testProfit = testCalc.netPayout - (p * taxPercent / 100 + p * adsPercent / 100 + packagingCost + productCost);
          return (testProfit / p) * 100;
        };

        if (evalMargin(high) >= targetMargin) {
          for (let i = 0; i < 28; i++) {
            const mid = (low + high) / 2;
            if (evalMargin(mid) >= targetMargin) high = mid;
            else low = mid;
          }
          minViablePrice = Math.ceil(high * 2) / 2;
        }
      }

      return {
        price,
        productCost,
        repasse,
        commission: calc.commission,
        commissionPercent,
        shippingFee: calc.shippingFee,
        taxes,
        adsCost,
        packagingCost,
        knownExpenses,
        unitProfit,
        marginPercent,
        monthlyRevenue,
        monthlyProfit,
        unitsForGoal,
        maxAcquisitionCost,
        minViablePrice,
        dailySales,
        targetMargin,
        monthlyGoal
      };
    }

    // 6. Inteligência de Categorias
    static calculateCategories(items, calculationFn, searchContext) {
      const grouping = CategoryIntelligenceExtractor.groupAdsByDomainOrCategory(items, calculationFn, searchContext);
      return {
        ...grouping,
        searchContext: searchContext || { totalResults: 0, filters: [], relatedSearches: [] }
      };
    }
  }

  class CalculadoraLivreXlsxExporter {
    static crcTable = (() => {
      const t = new Uint32Array(256);
      for (let i = 0; i < 256; i++) {
        let c = i;
        for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        t[i] = c >>> 0;
      }
      return t;
    })();

    static crc32(buf) {
      let crc = -1;
      const table = this.crcTable;
      for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
      return (crc ^ -1) >>> 0;
    }

    static escapeXml(str) {
      if (str == null) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");
    }

    static colLetter(colIdx) {
      let temp, letter = "";
      while (colIdx > 0) {
        temp = (colIdx - 1) % 26;
        letter = String.fromCharCode(65 + temp) + letter;
        colIdx = Math.floor((colIdx - temp - 1) / 26);
      }
      return letter;
    }

    static formatMoney(val) {
      if (val == null || val === "" || Number.isNaN(Number(val))) return "—";
      const num = Number(val);
      return "R$ " + num.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    static formatPercent(val) {
      if (val == null || val === "" || Number.isNaN(Number(val))) return "—";
      return Number(val).toFixed(1).replace(".", ",") + "%";
    }

    static formatNumber(val, unit = "") {
      if (val == null || val === "" || Number.isNaN(Number(val))) return "—";
      const num = Number(val);
      const formatted = num.toLocaleString("pt-BR");
      return unit ? `${formatted} ${unit}` : formatted;
    }

    static createZip(files) {
      const encoder = new TextEncoder();
      const fileRecords = [];
      let offset = 0;
      const parts = [];

      for (const file of files) {
        const data = typeof file.content === "string" ? encoder.encode(file.content) : file.content;
        const nameBuf = encoder.encode(file.name);
        const crc = this.crc32(data);
        const size = data.length;

        const localHeader = new Uint8Array(30 + nameBuf.length);
        const view = new DataView(localHeader.buffer);
        view.setUint32(0, 0x04034b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 0, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0, true);
        view.setUint32(14, crc, true);
        view.setUint32(18, size, true);
        view.setUint32(22, size, true);
        view.setUint16(26, nameBuf.length, true);
        view.setUint16(28, 0, true);
        localHeader.set(nameBuf, 30);

        fileRecords.push({ nameBuf, crc, size, offset });
        parts.push(localHeader, data);
        offset += localHeader.length + size;
      }

      const centralDirOffset = offset;
      let centralDirSize = 0;

      for (const rec of fileRecords) {
        const cdHeader = new Uint8Array(46 + rec.nameBuf.length);
        const view = new DataView(cdHeader.buffer);
        view.setUint32(0, 0x02014b50, true);
        view.setUint16(4, 20, true);
        view.setUint16(6, 20, true);
        view.setUint16(8, 0, true);
        view.setUint16(10, 0, true);
        view.setUint16(12, 0, true);
        view.setUint16(14, 0, true);
        view.setUint32(16, rec.crc, true);
        view.setUint32(20, rec.size, true);
        view.setUint32(24, rec.size, true);
        view.setUint16(28, rec.nameBuf.length, true);
        view.setUint16(30, 0, true);
        view.setUint16(32, 0, true);
        view.setUint16(34, 0, true);
        view.setUint16(36, 0, true);
        view.setUint32(38, 0, true);
        view.setUint32(42, rec.offset, true);
        cdHeader.set(rec.nameBuf, 46);

        parts.push(cdHeader);
        centralDirSize += cdHeader.length;
      }

      const eocd = new Uint8Array(22);
      const eocdView = new DataView(eocd.buffer);
      eocdView.setUint32(0, 0x06054b50, true);
      eocdView.setUint16(4, 0, true);
      eocdView.setUint16(6, 0, true);
      eocdView.setUint16(8, fileRecords.length, true);
      eocdView.setUint16(10, fileRecords.length, true);
      eocdView.setUint32(12, centralDirSize, true);
      eocdView.setUint32(16, centralDirOffset, true);
      eocdView.setUint16(20, 0, true);
      parts.push(eocd);

      const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
      const result = new Uint8Array(totalLen);
      let curPos = 0;
      for (const p of parts) {
        result.set(p, curPos);
        curPos += p.length;
      }
      return result;
    }

    static buildSheetXml(rows) {
      let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n<sheetData>\n';
      rows.forEach((row, rowIdx) => {
        const rNum = rowIdx + 1;
        xml += `<row r="${rNum}">\n`;
        row.forEach((cell, colIdx) => {
          const cRef = this.colLetter(colIdx + 1) + rNum;
          if (cell == null || cell === "") return;
          let val = cell;
          let isHeader = false;
          if (typeof cell === "object" && cell !== null && "v" in cell) {
            val = cell.v;
            if (cell.bold) isHeader = true;
          }
          const isNum = typeof val === "number" && Number.isFinite(val);
          const styleAttr = isHeader ? ' s="1"' : "";
          if (isNum) {
            xml += `<c r="${cRef}"${styleAttr} t="n"><v>${val}</v></c>\n`;
          } else {
            xml += `<c r="${cRef}"${styleAttr} t="inlineStr"><is><t>${this.escapeXml(val)}</t></is></c>\n`;
          }
        });
        xml += '</row>\n';
      });
      xml += '</sheetData>\n</worksheet>';
      return xml;
    }

    static buildWorkbook(sheets) {
      const files = [];

      let ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n<Default Extension="xml" ContentType="application/xml"/>\n<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>\n<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>\n';
      sheets.forEach((_, idx) => {
        ct += `<Override PartName="/xl/worksheets/sheet${idx + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>\n`;
      });
      ct += '</Types>';
      files.push({ name: '[Content_Types].xml', content: ct });

      files.push({
        name: '_rels/.rels',
        content: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>\n</Relationships>'
      });

      let wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
      sheets.forEach((_, idx) => {
        wbRels += `<Relationship Id="rId${idx + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${idx + 1}.xml"/>\n`;
      });
      wbRels += `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n</Relationships>`;
      files.push({ name: 'xl/_rels/workbook.xml.rels', content: wbRels });

      let wb = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n<sheets>\n';
      sheets.forEach((s, idx) => {
        wb += `<sheet name="${this.escapeXml(s.name)}" sheetId="${idx + 1}" r:id="rId${idx + 1}"/>\n`;
      });
      wb += '</sheets>\n</workbook>';
      files.push({ name: 'xl/workbook.xml', content: wb });

      const stylesXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">\n<fonts count="2">\n<font><name val="Calibri"/><sz val="11"/></font>\n<font><b/><name val="Calibri"/><sz val="11"/></font>\n</fonts>\n<fills count="3">\n<fill><patternFill patternType="none"/></fill>\n<fill><patternFill patternType="gray125"/></fill>\n<fill><patternFill patternType="solid"><fgColor rgb="FFF2F2F2"/></patternFill></fill>\n</fills>\n<borders count="1">\n<border><left/><right/><top/><bottom/><diagonal/></border>\n</borders>\n<cellStyleXfs count="1">\n<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>\n</cellStyleXfs>\n<cellXfs count="2">\n<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>\n<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>\n</cellXfs>\n</styleSheet>';
      files.push({ name: 'xl/styles.xml', content: stylesXml });

      sheets.forEach((s, idx) => {
        files.push({
          name: `xl/worksheets/sheet${idx + 1}.xml`,
          content: this.buildSheetXml(s.rows)
        });
      });

      return this.createZip(files);
    }

    static showProgressModal() {
      document.querySelector("#cl-export-modal-backdrop")?.remove();
      const backdrop = document.createElement("div");
      backdrop.id = "cl-export-modal-backdrop";
      backdrop.className = "cl-export-backdrop";
      backdrop.innerHTML = `
        <div class="cl-export-modal" role="dialog" aria-modal="true" aria-labelledby="cl-exp-title">
          <div class="cl-export-modal__header">
            <span class="cl-export-modal__icon">📊</span>
            <div>
              <h3 id="cl-exp-title" class="cl-export-modal__title">Exportando Lista de Anúncios</h3>
              <span class="cl-export-modal__subtitle">Calculadora Livre • Gerando planilha Excel (.xlsx)</span>
            </div>
          </div>
          <div class="cl-export-modal__body">
            <div class="cl-export-progress-wrap">
              <div class="cl-export-progress-bar" id="cl-export-bar" style="width: 10%;"></div>
            </div>
            <div class="cl-export-status">
              <span class="cl-export-status__text" id="cl-export-status-text">Iniciando coleta dos anúncios...</span>
              <strong class="cl-export-status__pct" id="cl-export-pct">10%</strong>
            </div>
            <div class="cl-export-checklist">
              <div class="cl-export-chk" id="cl-chk-1">⏳ 1. Coletando anúncios da página</div>
              <div class="cl-export-chk" id="cl-chk-2">⏳ 2. Calculando comissões, fretes e repasses</div>
              <div class="cl-export-chk" id="cl-chk-3">⏳ 3. Formatando dados e valores em R$</div>
              <div class="cl-export-chk" id="cl-chk-4">⏳ 4. Gerando e baixando arquivo Excel (.xlsx)</div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(backdrop);
      return backdrop;
    }

    static updateProgress(pct, message, activeStep) {
      const bar = document.querySelector("#cl-export-bar");
      const text = document.querySelector("#cl-export-status-text");
      const pctEl = document.querySelector("#cl-export-pct");
      if (bar) bar.style.width = `${pct}%`;
      if (text) text.textContent = message;
      if (pctEl) pctEl.textContent = `${pct}%`;
      if (activeStep != null) {
        for (let i = 1; i <= 4; i++) {
          const chk = document.querySelector(`#cl-chk-${i}`);
          if (!chk) continue;
          if (i < activeStep) {
            chk.className = "cl-export-chk is-done";
            chk.textContent = chk.textContent.replace(/^[⏳⚡]/, "✅");
          } else if (i === activeStep) {
            chk.className = "cl-export-chk is-active";
            chk.textContent = chk.textContent.replace(/^[⏳]/, "⚡");
          }
        }
      }
    }

    static async runExport({ cards, settings, iqvAnalysis, simForm }) {
      const modal = this.showProgressModal();
      const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

      try {
        await sleep(100);
        this.updateProgress(20, "Coletando anúncios capturados na busca...", 1);
        await sleep(150);

        const allItems = cards.values();
        const searchTerm = document.querySelector("input.nav-search-input")?.value || document.title.split("|")[0].trim() || "Busca no Mercado Livre";
        const searchCtx = cards.registry?.getSearchContext?.() || CategoryIntelligenceExtractor.extractSearchContext(null, document);

        this.updateProgress(45, `Calculando inteligência, comissões e repasses de ${allItems.length} anúncios...`, 2);
        await sleep(150);

        let totalRevenueSum = 0;
        let totalNetPayoutSum = 0;

        const calculatedItems = allItems.map((it) => {
          const calc = cards.calculation(it.data);
          const repasseMargin = it.data.price > 0 ? (calc.netPayout / it.data.price * 100) : 0;
          const monthlyRev = it.advanced?.monthlyRevenue ?? (it.advanced?.salesPerDay != null ? it.advanced.salesPerDay * 30 * it.data.price : null);
          const monthlyNet = it.advanced?.salesPerMonth != null ? it.advanced.salesPerMonth * calc.netPayout : null;

          if (monthlyRev != null && monthlyRev > 0) {
            totalRevenueSum += monthlyRev;
          }
          if (calc.netPayout > 0) {
            totalNetPayoutSum += calc.netPayout;
          }

          return { it, calc, repasseMargin, monthlyRev, monthlyNet };
        });

        this.updateProgress(70, "Estruturando abas: Anúncios, Categorias, Filtros e Metodologia...", 3);
        await sleep(150);

        const avgPayout = allItems.length > 0 ? (totalNetPayoutSum / allItems.length) : 0;

        // ABA 1: Lista de Anúncios
        const sheetRows1 = [
          [{ v: "CALCULADORA LIVRE — LISTAGEM DE ANÚNCIOS DA PESQUISA", bold: true }],
          ["Data da Exportação", new Date().toLocaleString("pt-BR")],
          ["Termo Pesquisado", searchTerm],
          ["Total de Anúncios na Lista", allItems.length],
          ["Faturamento Mensal Estimado da Amostra", this.formatMoney(totalRevenueSum)],
          ["Repasse Médio Estimado por Anúncio", this.formatMoney(avgPayout)],
          [],
          [
            { v: "#", bold: true },
            { v: "Título do Produto", bold: true },
            { v: "Categoria / Domínio", bold: true },
            { v: "Preço de Venda (R$)", bold: true },
            { v: "Repasse Líquido ML (R$)", bold: true },
            { v: "Margem de Repasse (%)", bold: true },
            { v: "Comissão ML (%)", bold: true },
            { v: "Tarifa de Comissão (R$)", bold: true },
            { v: "Frete Estimado (R$)", bold: true },
            { v: "Tipo de Anúncio", bold: true },
            { v: "Modalidade Logística", bold: true },
            { v: "Envio Full?", bold: true },
            { v: "Patrocinado (Ads)?", bold: true },
            { v: "Vendas Totais", bold: true },
            { v: "Idade do Anúncio", bold: true },
            { v: "Data de Criação", bold: true },
            { v: "Precisão da Data", bold: true },
            { v: "Qualidade dos Dados", bold: true },
            { v: "Giro Diário (Velocidade)", bold: true },
            { v: "Vendas Estimadas / Mês", bold: true },
            { v: "Faturamento Mensal Estimado (R$)", bold: true },
            { v: "Repasse Mensal Estimado (R$)", bold: true },
            { v: "Estoque Disponível", bold: true },
            { v: "Link do Anúncio (URL)", bold: true }
          ]
        ];

        calculatedItems.forEach(({ it, calc, repasseMargin, monthlyRev, monthlyNet }, idx) => {
          const creation = it.advanced?.creationDate ? new Date(it.advanced.creationDate) : null;
          const validCreation = creation && !Number.isNaN(creation.valueOf());
          const catClassification = CategoryIntelligenceExtractor.classifyItemCategory(it, searchCtx);
          const catLabel = catClassification?.name || "Geral";
          const qualityLabel = it.advanced?.dataQuality === "complete" ? "Completa (Data confirmada)" : (it.advanced?.dataQuality === "estimated" ? "Estimada (Via foto/revisão)" : "Básica (Sem idade)");

          sheetRows1.push([
            idx + 1,
            it.data.title || "Produto sem título",
            catLabel,
            this.formatMoney(it.data.price),
            this.formatMoney(calc.netPayout),
            this.formatPercent(repasseMargin),
            `${cards.commission(it.data)}%`,
            this.formatMoney(calc.commission),
            this.formatMoney(calc.shippingFee),
            it.data.listingTypeId === "gold_pro" ? "Premium" : "Clássico",
            it.data.logisticType === "fulfillment" ? "Mercado Envios Full" : (it.data.logisticType || "Normal"),
            it.data.isFull ? "Sim" : "Não",
            it.data.isSponsored ? "Sim" : "Não",
            it.advanced?.soldQuantity != null ? this.formatNumber(it.advanced.soldQuantity, "un.") : (it.data.soldQuantity ? this.formatNumber(it.data.soldQuantity, "un.") : "—"),
            it.advanced?.estimatedDaysActive != null ? this.formatNumber(it.advanced.estimatedDaysActive, "dias") : "—",
            validCreation ? shortDate.format(creation) : "—",
            it.advanced ? (it.advanced.creationDateIsEstimated ? "Data Estimada" : "Data Confirmada") : "—",
            qualityLabel,
            it.advanced?.salesPerDay != null ? `${Number(it.advanced.salesPerDay.toFixed(2)).toLocaleString("pt-BR")} un./dia` : "—",
            it.advanced?.salesPerMonth != null ? this.formatNumber(Math.round(it.advanced.salesPerMonth), "un./mês") : "—",
            this.formatMoney(monthlyRev),
            this.formatMoney(monthlyNet),
            it.advanced?.availableStock != null && it.advanced.availableStock > 0 ? this.formatNumber(it.advanced.availableStock, "un.") : "—",
            it.data.permalink || ""
          ]);
        });

        // ABA 2: Resumo de Categorias
        const catGrouping = CategoryIntelligenceExtractor.groupAdsByDomainOrCategory(allItems, (d) => cards.calculation(d), searchCtx);
        const sheetRows2 = [
          [{ v: "CALCULADORA LIVRE — RESUMO DE CATEGORIAS E SUBDOMÍNIOS", bold: true }],
          ["Data da Exportação", new Date().toLocaleString("pt-BR")],
          ["Termo Pesquisado", searchTerm],
          ["Subcategorias Identificadas", catGrouping.groups.length],
          ["Total de Anúncios Únicos", catGrouping.uniqueAdsCount],
          ["Aparições Patrocinadas Desduplicadas", catGrouping.duplicatedPositions],
          ["Faturamento Mensal Projetado da Pesquisa", this.formatMoney(catGrouping.aggregatedRevenue)],
          [],
          [
            { v: "#", bold: true },
            { v: "Subcategoria / Domínio", bold: true },
            { v: "Anúncios Únicos", bold: true },
            { v: "Posições Totais", bold: true },
            { v: "Preço Mediano (R$)", bold: true },
            { v: "Giro Diário Mediano", bold: true },
            { v: "Giro Diário Total", bold: true },
            { v: "Faturamento Projetado (R$)", bold: true },
            { v: "Share Faturamento (%)", bold: true },
            { v: "Share Giro (%)", bold: true },
            { v: "Repasse Líquido Médio (%)", bold: true },
            { v: "IQV Subcategoria", bold: true },
            { v: "Classificação IQV", bold: true }
          ]
        ];

        catGrouping.groups.forEach((grp, idx) => {
          const iqvVal = grp.iqv?.generalScore != null ? grp.iqv.generalScore.toFixed(1) : "—";
          const iqvClass = grp.iqv?.generalClassification?.label || "—";

          sheetRows2.push([
            idx + 1,
            grp.name,
            grp.uniqueCount,
            grp.totalPositions,
            this.formatMoney(grp.medianPrice),
            `${number.format(grp.medianDailyGiro)} un./dia`,
            `${number.format(grp.totalDailyGiro)} un./dia`,
            this.formatMoney(grp.projectedMonthlyRevenue),
            this.formatPercent(grp.revenueShare),
            this.formatPercent(grp.giroShare),
            this.formatPercent(grp.medianReturnRatio * 100),
            iqvVal,
            iqvClass
          ]);
        });

        // ABA 3: Distribuição de Filtros Oficiais ML
        const filtersList = searchCtx.filters || [];
        const sheetRows3 = [
          [{ v: "CALCULADORA LIVRE — DISTRIBUIÇÃO DE FILTROS OFICIAIS DO MERCADO LIVRE", bold: true }],
          ["Data da Exportação", new Date().toLocaleString("pt-BR")],
          ["Termo Pesquisado", searchTerm],
          ["Total de Resultados Declarados pelo ML", searchCtx.totalResults ? this.formatNumber(searchCtx.totalResults, "produtos") : "Não informado"],
          [],
          [
            { v: "#", bold: true },
            { v: "Grupo de Filtro", bold: true },
            { v: "Opção do Filtro", bold: true },
            { v: "Quantidade de Anúncios no ML", bold: true },
            { v: "Status do Filtro", bold: true }
          ]
        ];

        let filterRowIdx = 1;
        filtersList.forEach((grp) => {
          grp.values.forEach((val) => {
            sheetRows3.push([
              filterRowIdx++,
              grp.name,
              val.name,
              val.count > 0 ? this.formatNumber(val.count, "produtos") : "Disponível",
              val.isActive ? "Filtro Ativo" : "Disponível para Filtragem"
            ]);
          });
        });

        if (sheetRows3.length <= 6) {
          sheetRows3.push([1, "Geral", "Filtros oficiais sincronizados diretamente da busca", "—", "Normal"]);
        }

        // ABA 4: Metodologia e Critérios
        const sheetRows4 = [
          [{ v: "CALCULADORA LIVRE — METODOLOGIA, FÓRMULAS E CRITÉRIOS DE ANÁLISE", bold: true }],
          ["Versão do Sistema", "Calculadora Livre v1.15.0"],
          ["Data de Emissão", new Date().toLocaleString("pt-BR")],
          [],
          [{ v: "1. ÍNDICE DE QUALIDADE E VIABILIDADE (IQV)", bold: true }],
          ["Definição", "Nota consolidada de 0 a 100 que avalia a atratividade comercial de um nicho ou subcategoria no Mercado Livre."],
          ["Pilares de Avaliação", "1. Velocidade de Giro (35%): avalia a velocidade diária de saída de produtos (unidades por dia)."],
          ["", "2. Volume de Faturamento (35%): avalia a capacidade financeira mensal gerada pelo produto ou categoria."],
          ["", "3. Razão de Repasse Líquido (30%): avalia a margem de retenção que sobra para o vendedor após comissões e taxas."],
          ["Faixas de Classificação", "0 a 39,9: Muito Baixa (Vermelho) | 40 a 54,9: Baixa (Laranja) | 55 a 69,9: Média (Amarelo) | 70 a 84,9: Alta (Verde Claro) | 85 a 100: Muito Alta (Verde Escuro)"],
          [],
          [{ v: "2. SEGMENTAÇÃO DE TICKETS", bold: true }],
          ["Ticket Baixo", "Anúncios com preço de venda de até R$ 50,00."],
          ["Ticket Médio", "Anúncios com preço de venda entre R$ 50,01 e R$ 99,99."],
          ["Ticket Alto", "Anúncios com preço de venda a partir de R$ 100,00."],
          [],
          [{ v: "3. CRITÉRIOS DE DATA E ESTIMATIVA DE VELOCIDADE", bold: true }],
          ["Data Confirmada", "Obtida através de registros explícitos do anúncio (data_created ou start_time na estrutura da página)."],
          ["Data Estimada por Foto", "Quando a data explícita não está presente, a data é estimada pelo timestamp codificado na imagem principal do Mercado Livre."],
          ["Giro Diário (un./dia)", "Quantidade total vendida dividida pelos dias ativos calculados desde a data de criação."],
          ["Faturamento Mensal Estimado", "Giro diário multiplicado por 30 dias e pelo preço atual de venda."],
          [],
          [{ v: "4. DEDUPLICAÇÃO DE ANÚNCIOS", bold: true }],
          ["Patrocinados vs Orgânicos", "No Mercado Livre, anúncios patrocinados (Product Ads) costumam aparecer duplicados em posições superiores."],
          ["Critério", "Nas métricas consolidadas (IQV, giro agregado e faturamento por categoria), cada anúncio é contabilizado apenas uma vez."],
          [],
          [{ v: "5. TARIFAS E CUSTOS OPERACIONAIS (MERCADO LIVRE 2026)", bold: true }],
          ["Tipo Clássico", "Comissão padrão do Mercado Livre (configurável pelo usuário, padrão 12%)."],
          ["Tipo Premium", "Comissão ampliada com parcelamento sem juros (configurável pelo usuário, padrão 17%)."],
          ["Tarifa Fixa", "Incide sobre produtos com preço inferior a R$ 79,00 (tabelado de R$ 6,00 a R$ 6,50 conforme a faixa)."],
          ["Frete Grátis Mercado Envios", "Obrigatório para produtos a partir de R$ 79,00, custeado parcialmente pelo vendedor conforme peso e reputação."]
        ];

        this.updateProgress(95, "Gerando arquivo Excel (.xlsx)...", 4);
        await sleep(100);

        const sheets = [
          { name: "Lista de Anúncios", rows: sheetRows1 },
          { name: "Resumo de Categorias", rows: sheetRows2 },
          { name: "Distribuição de Filtros", rows: sheetRows3 },
          { name: "Metodologia", rows: sheetRows4 }
        ];

        const xlsxBytes = this.buildWorkbook(sheets);

        this.updateProgress(100, "🎉 Concluído! Iniciando download da planilha...", 4);
        const chk4 = document.querySelector("#cl-chk-4");
        if (chk4) {
          chk4.className = "cl-export-chk is-done";
          chk4.textContent = chk4.textContent.replace(/^[⏳⚡]/, "✅");
        }

        const blob = new Blob([xlsxBytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        const dateStr = new Date().toISOString().slice(0, 10);
        a.href = url;
        a.download = `Calculadora_Livre_Anuncios_${dateStr}.xlsx`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);

        await sleep(1200);
        modal.remove();
      } catch (err) {
        console.error(`${APP}: Erro durante exportação XLSX:`, err);
        this.updateProgress(100, "Erro ao gerar arquivo. Tente novamente.");
        await sleep(2500);
        modal.remove();
      }
    }
  }

  class MarketIntelligenceModal {
    static instance = null;

    constructor() {
      this.root = null;
      this.cards = null;
      this.settings = null;
      this.iqvAnalysis = null;
      this.activeTab = "pricing";
      this.selectedSegment = "all";
      this.priceGrouping = "10";
      this.priceMetric = "efficiency";
      this.categorySort = "revenue";
      this.categoryMetric = "revenue";
      this.selectedSubcategory = null;
      this.simForm = {
        price: "",
        productCost: "",
        listingTypeId: "gold_special",
        logisticType: "fulfillment",
        weightGrams: 1000,
        taxPercent: "",
        packagingCost: "",
        adsPercent: "0",
        dailySales: "",
        targetMargin: "15",
        monthlyGoal: "5000"
      };
      this.boundKeyHandler = (e) => {
        if (e.key === "Escape") this.close();
      };
    }

    formatMeliPrice(price) {
      const val = asNumber(price, 0);
      const integerPart = Math.floor(val);
      const centsPart = Math.round((val - integerPart) * 100);
      const fractionStr = integerPart.toLocaleString("pt-BR");
      const centsStr = centsPart.toString().padStart(2, "0");
      return `<span class="cl-ml-price"><span class="cl-ml-price__symbol">R$&nbsp;</span><span class="cl-ml-price__fraction">${fractionStr}</span><span class="cl-ml-price__cents">,${centsStr}</span></span>`;
    }

    static getInstance() {
      if (!this.instance) this.instance = new MarketIntelligenceModal();
      return this.instance;
    }

    static isOpen() {
      return Boolean(this.getInstance().root?.isConnected);
    }

    static open(cards, settings, iqvAnalysis) {
      const modal = this.getInstance();
      modal.cards = cards;
      modal.settings = settings;
      modal.iqvAnalysis = iqvAnalysis;

      if (!modal.simForm.price && iqvAnalysis?.generalScore != null) {
        const prices = cards.values().map((it) => it.data?.price).filter(Boolean);
        const medP = IQVAnalysisEngine.median(prices);
        if (medP) modal.simForm.price = medP.toFixed(2);
      }
      if (!modal.simForm.taxPercent && settings.taxPercent != null) modal.simForm.taxPercent = String(settings.taxPercent);
      if (!modal.simForm.packagingCost && settings.packagingCost != null) modal.simForm.packagingCost = String(settings.packagingCost);
      if (!modal.simForm.dailySales) {
        const medGiro = iqvAnalysis ? IQVAnalysisEngine.median(cards.values().map((it) => it.advanced?.salesPerDay).filter(Boolean)) : 4;
        modal.simForm.dailySales = medGiro ? Math.max(1, Math.round(medGiro)) : 4;
      }

      modal.mount();
      modal.render();
    }

    static update(cards, settings, iqvAnalysis) {
      const modal = this.getInstance();
      if (!modal.root?.isConnected) return;
      modal.cards = cards;
      modal.settings = settings;
      modal.iqvAnalysis = iqvAnalysis;
      modal.render();
    }

    static close() {
      this.getInstance().close();
    }

    close() {
      if (this.root) {
        this.root.remove();
        this.root = null;
        document.removeEventListener("keydown", this.boundKeyHandler);
      }
    }

    mount() {
      if (this.root?.isConnected) return;
      this.root = document.createElement("div");
      this.root.id = "calculadora-livre-intel-modal";
      this.root.className = "cl-root cl-intel-backdrop";
      document.body.appendChild(this.root);
      document.addEventListener("keydown", this.boundKeyHandler);
    }

    render() {
      if (!this.root) return;
      const allItems = this.cards.values();
      const items = MarketIntelligenceEngine.filterBySegment(allItems, this.selectedSegment);

      const iqv = this.iqvAnalysis || IQVAnalysisEngine.analyze(allItems, (d) => this.cards.calculation(d));
      const hasGeneral = iqv.generalScore != null && Number.isFinite(iqv.generalScore);
      const scoreFormatted = hasGeneral ? number.format(iqv.generalScore) : "—";
      const tierColor = iqv.generalClassification?.color || "#737373";
      const tierLabel = iqv.generalClassification?.label || "Aguardando dados";

      const modalEl = this.root.querySelector(".cl-intel-modal");
      if (!modalEl) {
        this.root.innerHTML = `
          <div class="cl-intel-modal" role="dialog" aria-modal="true" aria-labelledby="cl-intel-title">
            <header class="cl-intel-modal__header">
              <div class="cl-intel-modal__title-group">
                <h2 id="cl-intel-title" class="cl-intel-modal__title">
                  <span>Calculadora Livre</span>
                  <span class="cl-intel-badge-pro">Inteligência</span>
                </h2>
                <span class="cl-intel-modal__subtitle">Análise avançada de atratividade comercial e viabilidade</span>
              </div>

              <div class="cl-intel-modal__actions">
                <label style="font-size: 11px; font-weight: 700; color: #555; display: flex; align-items: center; gap: 6px;">
                  Segmento:
                  <select class="cl-intel-segment-select" data-intel-segment>
                    <option value="all" ${this.selectedSegment === "all" ? "selected" : ""}>Todos os tickets (${allItems.length} anúncios)</option>
                    <option value="baixo" ${this.selectedSegment === "baixo" ? "selected" : ""}>Ticket Baixo (até R$ 50,00)</option>
                    <option value="medio" ${this.selectedSegment === "medio" ? "selected" : ""}>Ticket Médio (R$ 50,01 a R$ 99,99)</option>
                    <option value="alto" ${this.selectedSegment === "alto" ? "selected" : ""}>Ticket Alto (a partir de R$ 100,00)</option>
                  </select>
                </label>

                <button type="button" class="cl-intel-export-btn" data-intel-export title="Exportar lista de anúncios em Excel (.xlsx)">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  <span>Exportar Anúncios (Excel)</span>
                </button>

                <button type="button" class="cl-intel-modal__close-btn" data-intel-close title="Fechar (Esc)">✕</button>
              </div>
            </header>

            <div class="cl-intel-summary-strip">
              <div class="cl-intel-summary-strip__left">
                <div class="cl-intel-iqv-pill" style="background: ${iqv.generalClassification?.class ? 'rgba(0,0,0,0.06)' : '#eee'};">
                  <span style="display:inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${tierColor};"></span>
                  <strong>IQV Geral: ${scoreFormatted} / 100</strong>
                  <span style="color: ${tierColor}; font-weight: 700;">(${tierLabel})</span>
                </div>
                <span class="cl-intel-summary-sample" style="color: #64748b;">Amostra: <strong>${iqv.totalEvaluated}</strong> de <strong>${iqv.totalAds}</strong> anúncios com dados consolidados</span>
              </div>
            </div>

            <nav class="cl-intel-tabs" role="tablist">
              <button type="button" class="cl-intel-tab ${this.activeTab === 'pricing' ? 'is-active' : ''}" data-intel-tab="pricing">🏷️ Preços e Tickets</button>
              <button type="button" class="cl-intel-tab ${this.activeTab === 'demand' ? 'is-active' : ''}" data-intel-tab="demand">📊 Visão de Mercado</button>
              <button type="button" class="cl-intel-tab ${this.activeTab === 'competition' ? 'is-active' : ''}" data-intel-tab="competition">🏆 Concorrência</button>
              <button type="button" class="cl-intel-tab ${this.activeTab === 'entrants' ? 'is-active' : ''}" data-intel-tab="entrants">🚀 Novos Entrantes</button>
              <button type="button" class="cl-intel-tab ${this.activeTab === 'simulator' ? 'is-active' : ''}" data-intel-tab="simulator">🧮 Simulador</button>
              <button type="button" class="cl-intel-tab ${this.activeTab === 'categories' ? 'is-active' : ''}" data-intel-tab="categories">🗂️ Categorias</button>
            </nav>

            <div class="cl-intel-body">
              ${this.renderActiveTab(items, allItems)}
            </div>

            <footer class="cl-intel-modal__footer">
              <span>Fonte dos dados: processamento local de anúncios visíveis na pesquisa do Mercado Livre. Sem chamadas externas.</span>
              <span>Calculadora Livre v1.15.0 • Projeto Gratuito por <a href="https://www.linkedin.com/in/fabio-castro-943649286/?isSelfProfile=true" target="_blank" style="color: #3483fa; text-decoration: none; font-weight: 700;">Fabio Castro</a></span>
            </footer>
          </div>
        `;
        this.bindEvents();
      } else {
        const pillEl = this.root.querySelector(".cl-intel-iqv-pill");
        if (pillEl) {
          pillEl.innerHTML = `
            <span style="display:inline-block; width: 8px; height: 8px; border-radius: 50%; background: ${tierColor};"></span>
            <strong>IQV Geral: ${scoreFormatted} / 100</strong>
            <span style="color: ${tierColor}; font-weight: 700;">(${tierLabel})</span>
          `;
        }
        const sampleEl = this.root.querySelector(".cl-intel-summary-sample");
        if (sampleEl) {
          sampleEl.innerHTML = `Amostra: <strong>${iqv.totalEvaluated}</strong> de <strong>${iqv.totalAds}</strong> anúncios com dados consolidados`;
        }

        this.root.querySelectorAll("[data-intel-tab]").forEach((btn) => {
          btn.classList.toggle("is-active", btn.dataset.intelTab === this.activeTab);
        });

        const bodyEl = this.root.querySelector(".cl-intel-body");
        if (bodyEl) {
          const activeEl = document.activeElement;
          const isSimulatorTyping = this.activeTab === "simulator" && activeEl && activeEl.matches("input, select, textarea") && bodyEl.contains(activeEl);
          if (!isSimulatorTyping) {
            bodyEl.innerHTML = this.renderActiveTab(items, allItems);
            this.bindTabEvents();
          }
        }
      }
    }

    renderActiveTab(items, allItems) {
      if (this.activeTab === "demand") return this.renderDemandTab(items);
      if (this.activeTab === "pricing") return this.renderPricingTab(items);
      if (this.activeTab === "competition") return this.renderCompetitionTab(items);
      if (this.activeTab === "entrants") return this.renderEntrantsTab(items, allItems);
      if (this.activeTab === "simulator") return this.renderSimulatorTab(items);
      if (this.activeTab === "categories") return this.renderCategoriesTab(items, allItems);
      return "";
    }

    // 1. Visão de Mercado
    renderDemandTab(items) {
      const demand = MarketIntelligenceEngine.calculateDemand(items);
      const maxCount = Math.max(...demand.brackets.map((b) => b.count), 1);

      const bracketsBarsHtml = demand.brackets.map((b) => {
        const pct = Math.round((b.count / maxCount) * 100);
        return `<div class="cl-intel-bar-row">
          <div class="cl-intel-bar-meta">
            <strong>${escapeHtml(b.label)}</strong>
            <span><strong>${b.count}</strong> anúncios (${demand.validCount > 0 ? Math.round(b.count / demand.validCount * 100) : 0}%)</span>
          </div>
          <div class="cl-intel-bar-track">
            <div class="cl-intel-bar-fill" style="width: ${pct}%; background-color: #3483fa;"></div>
          </div>
        </div>`;
      }).join("");

      const ticketRowsHtml = demand.tiers.map((t) => `<tr>
        <td><strong>${escapeHtml(t.label)}</strong></td>
        <td>${t.validCount}</td>
        <td><strong>${number.format(t.medianGiro)}</strong> un./dia</td>
        <td><strong>${money.format(t.medianRevenue)}</strong></td>
        <td><span class="cl-intel-badge-pro" style="background:#eef2ff;color:#4338ca;">${t.giroShare.toFixed(1)}%</span></td>
      </tr>`).join("");

      return `
        <div class="cl-intel-kpis">
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Giro Diário Agregado</div>
            <div class="cl-intel-kpi__value">${number.format(demand.totalGiro)} <small style="font-size: 13px; font-weight: 600;">un./dia</small></div>
            <div class="cl-intel-kpi__sub">Volume diário somado dos anúncios válidos</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Giro Diário Mediano</div>
            <div class="cl-intel-kpi__value">${number.format(demand.medianGiro)} <small style="font-size: 13px; font-weight: 600;">un./dia</small></div>
            <div class="cl-intel-kpi__sub">Ritmo típico de vendas da amostra</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Faturamento da Amostra</div>
            <div class="cl-intel-kpi__value">${money.format(demand.totalRevenue)}</div>
            <div class="cl-intel-kpi__sub">Faturamento mensal projetado da amostra</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Faturamento Mediano</div>
            <div class="cl-intel-kpi__value">${money.format(demand.medianRevenue)}</div>
            <div class="cl-intel-kpi__sub">Mediana mensal por anúncio</div>
          </div>
        </div>

        <div class="cl-intel-insight">
          <span style="font-size: 18px;">💡</span>
          <div>${demand.insight}</div>
        </div>

        <div class="cl-intel-grid-2">
          <div class="cl-intel-card">
            <div class="cl-intel-section-title">
              <span>Distribuição de Velocidade de Vendas</span>
              <span style="font-size: 11px; font-weight: 500; color: #64748b;">P25: ${number.format(demand.p25)} • P50: ${number.format(demand.p50)} • P75: ${number.format(demand.p75)} un/dia</span>
            </div>
            <div class="cl-intel-bars">
              ${bracketsBarsHtml}
            </div>
          </div>

          <div class="cl-intel-card">
            <div class="cl-intel-section-title">
              <span>Comparativo Comercial por Faixa de Ticket</span>
            </div>
            <div class="cl-intel-table-wrap">
              <table class="cl-intel-table">
                <thead>
                  <tr>
                    <th>Ticket</th>
                    <th>Válidos</th>
                    <th>Giro Mediano</th>
                    <th>Fat. Mediano</th>
                    <th>Share Giro</th>
                  </tr>
                </thead>
                <tbody>
                  ${ticketRowsHtml}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      `;
    }

    // 2. Preços e Tickets
    renderPricingTab(items) {
      const pricing = MarketIntelligenceEngine.calculatePriceEfficiency(items, (d) => this.cards.calculation(d), this.priceGrouping);

      const maxVal = Math.max(...pricing.bins.map((b) => {
        if (this.priceMetric === "giro") return b.medianGiro;
        if (this.priceMetric === "revenue") return b.medianRevenue;
        if (this.priceMetric === "return") return b.medianReturnRatio * 100;
        return b.efficiencyScore;
      }), 1);

      const barsHtml = pricing.bins.map((b) => {
        let val = b.efficiencyScore;
        let formatted = `${val.toFixed(1)}/100`;
        let color = "#3483fa";
        if (this.priceMetric === "giro") { val = b.medianGiro; formatted = `${number.format(val)} un/d`; color = "#00a650"; }
        else if (this.priceMetric === "revenue") { val = b.medianRevenue; formatted = money.format(val); color = "#d97706"; }
        else if (this.priceMetric === "return") { val = b.medianReturnRatio * 100; formatted = `${val.toFixed(1)}%`; color = "#7c3aed"; }

        const pct = Math.round((val / maxVal) * 100);
        const isBest = pricing.best && pricing.best.label === b.label && this.priceMetric === "efficiency";
        return `<div class="cl-intel-bar-row">
          <div class="cl-intel-bar-meta">
            <div style="display:flex; align-items:center; gap:6px;">
              <strong>${escapeHtml(b.label)}</strong>
              ${isBest ? '<span class="cl-intel-badge-pro" style="background:#bbf7d0; color:#15803d;">🏆 Melhor Eficiência</span>' : ''}
            </div>
            <span><strong>${formatted}</strong> (${b.count} anúncios)</span>
          </div>
          <div class="cl-intel-bar-track">
            <div class="cl-intel-bar-fill" style="width: ${pct}%; background-color: ${isBest ? '#00a650' : color};"></div>
          </div>
        </div>`;
      }).join("");

      const tableRowsHtml = pricing.bins.map((b) => `<tr>
        <td><strong>${escapeHtml(b.label)}</strong></td>
        <td>${b.count}</td>
        <td><strong>${number.format(b.medianGiro)}</strong> un/d</td>
        <td>${money.format(b.medianRevenue)}</td>
        <td><strong>${(b.medianReturnRatio * 100).toFixed(1)}%</strong></td>
        <td>${money.format(b.medianPayout)}</td>
        <td><strong style="color: ${b.efficiencyScore >= 60 ? '#00a650' : '#333'};">${b.efficiencyScore.toFixed(1)}</strong></td>
      </tr>`).join("");

      return `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <label style="font-size: 11.5px; font-weight: 700; color: #475569;">Agrupamento de Faixas:</label>
            <select class="cl-intel-segment-select" data-intel-pricing-group>
              <option value="10" ${this.priceGrouping === '10' ? 'selected' : ''}>Faixas de R$ 10</option>
              <option value="20" ${this.priceGrouping === '20' ? 'selected' : ''}>Faixas de R$ 20</option>
              <option value="auto" ${this.priceGrouping === 'auto' ? 'selected' : ''}>Agrupamento Automático</option>
            </select>
          </div>

          <div style="display: flex; align-items: center; gap: 8px;">
            <label style="font-size: 11.5px; font-weight: 700; color: #475569;">Métrica no Gráfico:</label>
            <select class="cl-intel-segment-select" data-intel-pricing-metric>
              <option value="efficiency" ${this.priceMetric === 'efficiency' ? 'selected' : ''}>Índice de Eficiência (0-100)</option>
              <option value="giro" ${this.priceMetric === 'giro' ? 'selected' : ''}>Giro Diário Mediano</option>
              <option value="revenue" ${this.priceMetric === 'revenue' ? 'selected' : ''}>Faturamento Mensal Mediano</option>
              <option value="return" ${this.priceMetric === 'return' ? 'selected' : ''}>Repasse Percentual (%)</option>
            </select>
          </div>
        </div>

        <div class="cl-intel-kpis">
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">🏆 Faixa Mais Eficiente</div>
            <div class="cl-intel-kpi__value" style="font-size: 17px; color: #00a650;">${pricing.best ? escapeHtml(pricing.best.label) : "—"}</div>
            <div class="cl-intel-kpi__sub">Nota ${pricing.best ? pricing.best.efficiencyScore.toFixed(1) : "—"}/100</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">⚡ Maior Giro Mediano</div>
            <div class="cl-intel-kpi__value" style="font-size: 17px;">${pricing.highestGiro ? escapeHtml(pricing.highestGiro.label) : "—"}</div>
            <div class="cl-intel-kpi__sub">${pricing.highestGiro ? number.format(pricing.highestGiro.medianGiro) + " un./dia" : "—"}</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">💰 Maior Faturamento</div>
            <div class="cl-intel-kpi__value" style="font-size: 17px;">${pricing.highestRevenue ? escapeHtml(pricing.highestRevenue.label) : "—"}</div>
            <div class="cl-intel-kpi__sub">${pricing.highestRevenue ? money.format(pricing.highestRevenue.medianRevenue) : "—"}</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">🛡️ Maior Retorno %</div>
            <div class="cl-intel-kpi__value" style="font-size: 17px;">${pricing.highestReturn ? escapeHtml(pricing.highestReturn.label) : "—"}</div>
            <div class="cl-intel-kpi__sub">${pricing.highestReturn ? (pricing.highestReturn.medianReturnRatio * 100).toFixed(1) + "% líquido" : "—"}</div>
          </div>
        </div>

        <div class="cl-intel-insight">
          <span style="font-size: 18px;">💡</span>
          <div>${pricing.insight}</div>
        </div>

        <div class="cl-intel-card">
          <div class="cl-intel-section-title">
            <span>Comparativo por Faixa de Preço</span>
          </div>
          <div class="cl-intel-bars">
            ${barsHtml}
          </div>
        </div>

        <div class="cl-intel-table-wrap">
          <table class="cl-intel-table">
            <thead>
              <tr>
                <th>Faixa de Preço</th>
                <th>Anúncios</th>
                <th>Giro Mediano</th>
                <th>Fat. Mediano</th>
                <th>Retorno %</th>
                <th>Repasse Médio</th>
                <th>Eficiência (0-100)</th>
              </tr>
            </thead>
            <tbody>
              ${tableRowsHtml}
            </tbody>
          </table>
        </div>
      `;
    }

    // 3. Concorrência
    renderCompetitionTab(items) {
      const comp = MarketIntelligenceEngine.calculateCompetition(items);

      const top5CardsHtml = comp.top5.length ? `
        <div class="cl-ml-cards-grid">
          ${comp.top5.map((ad) => {
            const imgHtml = ad.thumbnail
              ? `<img class="cl-ml-card__img" src="${escapeHtml(ad.thumbnail)}" alt="${escapeHtml(ad.title)}" loading="lazy" />`
              : `<div style="font-size: 40px; color: #cbd5e1;">📦</div>`;
            return `
              <div class="cl-ml-card">
                <div class="cl-ml-card__portada">
                  <span class="cl-ml-card__badge-top" style="background: #3483fa; color: #ffffff;">#${ad.rank} Líder • ${ad.share.toFixed(1)}%</span>
                  ${imgHtml}
                </div>
                <div class="cl-ml-card__body">
                  <div>
                    <h4 class="cl-ml-card__title" title="${escapeHtml(ad.title)}">
                      <a href="${escapeHtml(ad.permalink)}" target="_blank">${escapeHtml(ad.title)}</a>
                    </h4>
                    <div style="margin-top: 6px;">
                      ${this.formatMeliPrice(ad.price)}
                    </div>
                    <div class="cl-ml-card__tags" style="margin-top: 6px;">
                      ${ad.isFull ? '<span class="cl-ml-tag-full">⚡ FULL</span>' : ''}
                      ${ad.price >= 79 ? '<span class="cl-ml-tag-shipping">Frete grátis</span>' : ''}
                      <span class="cl-badge ${ad.listingTypeId === 'gold_pro' ? 'cl-badge--blue' : ''}">${ad.listingTypeId === 'gold_pro' ? 'Premium' : 'Clássico'}</span>
                    </div>
                  </div>

                  <div>
                    <div class="cl-ml-card__intel">
                      <div class="cl-ml-card__intel-row">
                        <dt>Giro diário</dt>
                        <dd style="color: #00a650;">${number.format(ad.salesPerDay)} un./dia</dd>
                      </div>
                      <div class="cl-ml-card__intel-row">
                        <dt>Faturamento mês</dt>
                        <dd>${money.format(ad.monthlyRevenue)}</dd>
                      </div>
                      <div class="cl-ml-card__intel-row">
                        <dt>Share na busca</dt>
                        <dd style="color: #3483fa;">${ad.share.toFixed(1)}%</dd>
                      </div>
                    </div>
                    <a class="cl-ml-card__btn" href="${escapeHtml(ad.permalink)}" target="_blank">
                      Ver no Mercado Livre ↗
                    </a>
                  </div>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      ` : `<div class="cl-intel-card" style="text-align: center; color: #666666; padding: 24px;">Dados de faturamento insuficientes para listar concorrentes.</div>`;

      const top5RowsHtml = comp.top5.map((ad) => `<tr>
        <td><strong style="color: #3483fa;">#${ad.rank}</strong></td>
        <td style="max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          <a href="${escapeHtml(ad.permalink)}" target="_blank" title="${escapeHtml(ad.title)}">${escapeHtml(ad.title)}</a>
        </td>
        <td><strong>${money.format(ad.price)}</strong></td>
        <td>${number.format(ad.salesPerDay)} un/d</td>
        <td><strong>${money.format(ad.monthlyRevenue)}</strong></td>
        <td><span class="cl-intel-badge-pro" style="background:#eef2ff; color:#312e81;">${ad.share.toFixed(1)}%</span></td>
        <td>
          <span class="cl-badge ${ad.listingTypeId === 'gold_pro' ? 'cl-badge--blue' : ''}">${ad.listingTypeId === 'gold_pro' ? 'Premium' : 'Clássico'}</span>
          ${ad.logisticType === 'fulfillment' ? '<span class="cl-badge cl-badge--green">Full</span>' : ''}
          ${ad.isSponsored ? '<span class="cl-badge cl-badge--yellow">Ads</span>' : ''}
        </td>
      </tr>`).join("");

      return `
        <div class="cl-intel-kpis">
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Concentração Top 5 (C5)</div>
            <div class="cl-intel-kpi__value">${comp.c5.toFixed(1)}%</div>
            <div class="cl-intel-kpi__sub">Fatia dos 5 maiores anúncios da amostra</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Concentração Top 10 (C10)</div>
            <div class="cl-intel-kpi__value">${comp.c10 != null ? comp.c10.toFixed(1) + '%' : '—'}</div>
            <div class="cl-intel-kpi__sub">${comp.c10 != null ? 'Fatia dos 10 maiores anúncios' : 'Amostra menor que 10 anúncios'}</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Índice HHI</div>
            <div class="cl-intel-kpi__value">${comp.hhi} <small style="font-size: 13px; font-weight:600;">pts</small></div>
            <div class="cl-intel-kpi__sub">${comp.hhiClassification}</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Faturamento Analisado</div>
            <div class="cl-intel-kpi__value">${money.format(comp.totalRevenue)}</div>
            <div class="cl-intel-kpi__sub">${comp.validCount} anúncios com vendas na busca</div>
          </div>
        </div>

        <div class="cl-intel-insight">
          <span style="font-size: 18px;">💡</span>
          <div>${comp.insight}</div>
        </div>

        <div class="cl-intel-card">
          <div class="cl-intel-section-title">
            <span>Distribuição de Participação dos Líderes</span>
            <span style="font-size: 11px; color: #64748b;">Top 5 líderes vs Demais anúncios</span>
          </div>
          <div style="height: 18px; width: 100%; border-radius: 999px; overflow: hidden; display: flex; background: #e2e8f0; margin-top: 8px;">
            ${comp.top5.map((ad, idx) => {
              const colors = ["#3483fa", "#2563eb", "#1d4ed8", "#1e40af", "#1e3a8a"];
              return `<div style="width: ${ad.share}%; background: ${colors[idx]}; height: 100%;" title="#${ad.rank}: ${ad.share.toFixed(1)}%"></div>`;
            }).join("")}
            <div style="width: ${Math.max(0, 100 - comp.c5)}%; background: #cbd5e1; height: 100%;" title="Demais anúncios: ${(100 - comp.c5).toFixed(1)}%"></div>
          </div>
          <div style="display: flex; gap: 14px; flex-wrap: wrap; margin-top: 10px; font-size: 11px;">
            ${comp.top5.map((ad, idx) => `<span style="display: flex; align-items: center; gap: 4px;">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: ${['#3483fa', '#2563eb', '#1d4ed8', '#1e40af', '#1e3a8a'][idx]};"></span>
              #${ad.rank} (${ad.share.toFixed(1)}%)
            </span>`).join("")}
            <span style="display: flex; align-items: center; gap: 4px;">
              <span style="width: 8px; height: 8px; border-radius: 50%; background: #cbd5e1;"></span>
              Demais concorrentes (${(100 - comp.c5).toFixed(1)}%)
            </span>
          </div>
        </div>

        <div class="cl-intel-section-title" style="margin-top: 20px;">
          <span>Vitrine dos Líderes de Mercado (Top 5 Anúncios)</span>
        </div>
        ${top5CardsHtml}

        <div class="cl-intel-card" style="padding: 0; overflow: hidden; margin-top: 16px;">
          <div style="padding: 14px 16px; border-bottom: 1px solid rgba(0, 0, 0, 0.08);">
            <div class="cl-intel-section-title" style="margin: 0;">Comparativo Estruturado dos Líderes</div>
          </div>
          <div class="cl-intel-table-wrap" style="border: 0; border-radius: 0;">
            <table class="cl-intel-table">
              <thead>
                <tr>
                  <th>Rank</th>
                  <th>Anúncio</th>
                  <th>Preço</th>
                  <th>Giro Diário</th>
                  <th>Faturamento Projetado</th>
                  <th>Share Amostra</th>
                  <th>Configuração</th>
                </tr>
              </thead>
              <tbody>
                ${top5RowsHtml}
              </tbody>
            </table>
          </div>
        </div>
      `;
    }

    // 4. Novos Entrantes
    renderEntrantsTab(items, allItems) {
      const ticketMedians = {
        baixo: IQVAnalysisEngine.median(allItems.filter((it) => IQVAnalysisEngine.getTierId(it.data.price) === "baixo").map((it) => it.advanced?.salesPerDay).filter(Boolean)) || 1,
        medio: IQVAnalysisEngine.median(allItems.filter((it) => IQVAnalysisEngine.getTierId(it.data.price) === "medio").map((it) => it.advanced?.salesPerDay).filter(Boolean)) || 1,
        alto: IQVAnalysisEngine.median(allItems.filter((it) => IQVAnalysisEngine.getTierId(it.data.price) === "alto").map((it) => it.advanced?.salesPerDay).filter(Boolean)) || 1
      };

      const entrants = MarketIntelligenceEngine.calculateNewEntrants(items, ticketMedians);

      const cardsHtml = entrants.topEntrants.length
        ? `
          <div class="cl-ml-cards-grid">
            ${entrants.topEntrants.map((ad) => {
              const imgHtml = ad.thumbnail
                ? `<img class="cl-ml-card__img" src="${escapeHtml(ad.thumbnail)}" alt="${escapeHtml(ad.title)}" loading="lazy" />`
                : `<div style="font-size: 40px; color: #cbd5e1;">📦</div>`;
              const badgeBg = ad.isUnconfirmed ? '#e11d48' : (ad.multiplier >= 2 ? '#00a650' : '#3483fa');
              const badgeText = ad.isUnconfirmed ? '⚠️ Giro extremo' : (ad.multiplier >= 2 ? `🔥 ${ad.multiplier.toFixed(1)}x mediana` : `🚀 ${ad.multiplier.toFixed(1)}x mediana`);
              return `
                <div class="cl-ml-card">
                  <div class="cl-ml-card__portada">
                    <span class="cl-ml-card__badge-top" style="background: ${badgeBg}; color: #ffffff;">${badgeText}</span>
                    ${imgHtml}
                  </div>
                  <div class="cl-ml-card__body">
                    <div>
                      <h4 class="cl-ml-card__title" title="${escapeHtml(ad.title)}">
                        <a href="${escapeHtml(ad.permalink)}" target="_blank">${escapeHtml(ad.title)}</a>
                      </h4>
                      <div style="margin-top: 6px;">
                        ${this.formatMeliPrice(ad.price)}
                      </div>
                      <div class="cl-ml-card__tags" style="margin-top: 6px;">
                        ${ad.isFull ? '<span class="cl-ml-tag-full">⚡ FULL</span>' : ''}
                        ${ad.price >= 79 ? '<span class="cl-ml-tag-shipping">Frete grátis</span>' : ''}
                        <span style="font-size: 11px; color: #666666;">${ad.daysActive} dias ativos</span>
                      </div>
                    </div>

                    <div>
                      <div class="cl-ml-card__intel">
                        <div class="cl-ml-card__intel-row">
                          <dt>Idade</dt>
                          <dd>${ad.daysActive} dias (${ad.isEstimatedDate ? 'aprox.' : 'conf.'})</dd>
                        </div>
                        <div class="cl-ml-card__intel-row">
                          <dt>Giro diário</dt>
                          <dd style="color: #00a650;">${number.format(ad.salesPerDay)} un./dia</dd>
                        </div>
                        <div class="cl-ml-card__intel-row">
                          <dt>Fat. mensal</dt>
                          <dd>${money.format(ad.monthlyRevenue)}</dd>
                        </div>
                        <div class="cl-ml-card__intel-row">
                          <dt>Status</dt>
                          <dd style="font-size: 10.5px;">${escapeHtml(ad.status)}</dd>
                        </div>
                      </div>
                      <a class="cl-ml-card__btn" href="${escapeHtml(ad.permalink)}" target="_blank">
                        Ver no Mercado Livre ↗
                      </a>
                    </div>
                  </div>
                </div>
              `;
            }).join("")}
          </div>
        `
        : `<div class="cl-intel-card" style="text-align: center; color: #666666; padding: 24px;">
            Nenhum anúncio com até 90 dias e vendas registradas foi encontrado nesta seleção.
          </div>`;

      return `
        <div class="cl-intel-kpis">
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Anúncios Recentes</div>
            <div class="cl-intel-kpi__value">${entrants.count}</div>
            <div class="cl-intel-kpi__sub">Com idade $\\le$ 90 dias na amostra</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Velocidade Acima da Mediana</div>
            <div class="cl-intel-kpi__value" style="color: #059669;">${entrants.aboveMedianCount}</div>
            <div class="cl-intel-kpi__sub">Giro superior à média do seu segmento</div>
          </div>
        </div>

        <div class="cl-intel-insight">
          <span style="font-size: 18px;">💡</span>
          <div>${entrants.insight}</div>
        </div>

        <div class="cl-intel-section-title">
          <span>Novos Entrantes com Sinais de Alto Giro (Vitrine de Recentes)</span>
        </div>

        ${cardsHtml}
      `;
    }

    getItems() {
      const allItems = this.cards ? this.cards.values() : [];
      return MarketIntelligenceEngine.filterBySegment(allItems, this.selectedSegment);
    }

    // 5. Simulador
    renderSimulatorTab(items) {
      return `
        <div class="cl-intel-sim-grid">
          <!-- Coluna 1: Formulário de Configuração Operacional -->
          <div class="cl-intel-card">
            <div class="cl-intel-section-title">
              <span>Parâmetros da Sua Operação</span>
              <span style="font-size: 11px; color: #64748b;">Ajuste em tempo real</span>
            </div>

            <form class="cl-intel-form-grid" data-sim-form onsubmit="return false;">
              <div class="cl-intel-field">
                <label>Preço Pretendido de Venda (R$)</label>
                <input type="number" step="0.01" min="0.01" data-sim="price" value="${escapeHtml(this.simForm.price)}" placeholder="Ex: 99.90">
              </div>

              <div class="cl-intel-field">
                <label>Seu Custo do Produto (R$)</label>
                <input type="number" step="0.01" min="0" data-sim="productCost" value="${escapeHtml(this.simForm.productCost)}" placeholder="Ex: 35.00">
              </div>

              <div class="cl-intel-field">
                <label>Tipo de Anúncio</label>
                <select data-sim="listingTypeId">
                  <option value="gold_special" ${this.simForm.listingTypeId === 'gold_special' ? 'selected' : ''}>Clássico (${this.settings.classicCommission}%)</option>
                  <option value="gold_pro" ${this.simForm.listingTypeId === 'gold_pro' ? 'selected' : ''}>Premium (${this.settings.premiumCommission}%)</option>
                </select>
              </div>

              <div class="cl-intel-field">
                <label>Modalidade Logística</label>
                <select data-sim="logisticType">
                  <option value="fulfillment" ${this.simForm.logisticType === 'fulfillment' ? 'selected' : ''}>Mercado Envios Full</option>
                  <option value="cross_docking" ${this.simForm.logisticType === 'cross_docking' ? 'selected' : ''}>Mercado Envios Normal</option>
                </select>
              </div>

              <div class="cl-intel-field">
                <label>Peso Estimado (g)</label>
                <input type="number" step="50" min="1" data-sim="weightGrams" value="${escapeHtml(this.simForm.weightGrams)}">
              </div>

              <div class="cl-intel-field">
                <label>Alíquota de Impostos (%)</label>
                <input type="number" step="0.1" min="0" max="100" data-sim="taxPercent" value="${escapeHtml(this.simForm.taxPercent)}">
              </div>

              <div class="cl-intel-field">
                <label>Custo de Embalagem (R$)</label>
                <input type="number" step="0.1" min="0" data-sim="packagingCost" value="${escapeHtml(this.simForm.packagingCost)}">
              </div>

              <div class="cl-intel-field">
                <label>Publicidade / Ads Estimado (%)</label>
                <input type="number" step="0.5" min="0" max="100" data-sim="adsPercent" value="${escapeHtml(this.simForm.adsPercent)}">
              </div>

              <div class="cl-intel-field">
                <label>Vendas Diárias Projetadas (un/dia)</label>
                <input type="number" step="1" min="0" data-sim="dailySales" value="${escapeHtml(this.simForm.dailySales)}">
              </div>

              <div class="cl-intel-field">
                <label>Margem Operacional Desejada (%)</label>
                <input type="number" step="0.5" min="0" max="100" data-sim="targetMargin" value="${escapeHtml(this.simForm.targetMargin)}">
              </div>

              <div class="cl-intel-field" style="grid-column: 1 / -1;">
                <label>Meta Mensal de Lucro Limpo (R$)</label>
                <input type="number" step="100" min="0" data-sim="monthlyGoal" value="${escapeHtml(this.simForm.monthlyGoal)}">
              </div>
            </form>
          </div>

          <!-- Coluna 2: Resultados Financeiros Operacionais -->
          ${this.renderSimulatorResultsHtml(items)}
        </div>
      `;
    }

    renderSimulatorResultsHtml(items) {
      const sim = MarketIntelligenceEngine.calculateSimulator(this.simForm, MeliPricingEngine2026);

      const p25 = MarketIntelligenceEngine.percentile(items.map((it) => it.advanced?.salesPerDay).filter(Boolean), 0.25) || 2;
      const p50 = MarketIntelligenceEngine.percentile(items.map((it) => it.advanced?.salesPerDay).filter(Boolean), 0.50) || 4;
      const p75 = MarketIntelligenceEngine.percentile(items.map((it) => it.advanced?.salesPerDay).filter(Boolean), 0.75) || 8;

      const scenConservador = MarketIntelligenceEngine.calculateSimulator({ ...this.simForm, dailySales: p25 }, MeliPricingEngine2026);
      const scenReferencia = MarketIntelligenceEngine.calculateSimulator({ ...this.simForm, dailySales: p50 }, MeliPricingEngine2026);
      const scenExpansivo = MarketIntelligenceEngine.calculateSimulator({ ...this.simForm, dailySales: p75 }, MeliPricingEngine2026);

      const hasCost = sim.productCost != null && sim.productCost > 0;

      return `
        <div class="cl-intel-sim-results" data-sim-results>
          <!-- Callout Principal Dinâmico -->
          <div class="cl-intel-sim-callout" style="${hasCost ? 'background: #f0fdf4; border-color: #86efac;' : ''}">
            <div style="display: flex; align-items: baseline; justify-content: space-between; flex-wrap: wrap; gap: 6px;">
              <strong>${hasCost ? 'Sobra Líquida no Seu Bolso (Lucro Real)' : 'Você Recebe do Mercado Livre'}</strong>
              <span style="font-size: 11px; color: ${hasCost ? '#15803d' : '#166534'};">
                ${hasCost ? `Margem Real de <strong>${sim.marginPercent.toFixed(1)}%</strong> limpa` : `(Após comissão de ${money.format(sim.commission)} e frete de ${money.format(sim.shippingFee)})`}
              </span>
            </div>
            <div class="cl-val" style="color: ${hasCost && sim.unitProfit < 0 ? '#dc2626' : '#00a650'};">
              ${hasCost ? money.format(sim.unitProfit) : money.format(sim.repasse)}
              <small style="font-size: 13px; font-weight: 600; color: #15803d;">/ venda</small>
            </div>
            <div style="margin-top: 6px; font-size: 11.5px; color: #475569;">
              ${hasCost
                ? `Repasse que entra do ML: <strong>${money.format(sim.repasse)}</strong> • Seu custo do produto: <strong>- ${money.format(sim.productCost)}</strong> • Impostos/Despesas: <strong>- ${money.format(sim.knownExpenses)}</strong>`
                : 'Informe seu custo do produto ao lado para calcular o lucro líquido real e a sobra exata no seu bolso.'}
            </div>
          </div>

          <div class="cl-intel-kpis" style="grid-template-columns: 1fr 1fr;">
            <div class="cl-intel-kpi">
              <div class="cl-intel-kpi__label">Repasse Transferido pelo ML</div>
              <div class="cl-intel-kpi__value" style="color: #00a650;">
                ${money.format(sim.repasse)}
              </div>
              <div class="cl-intel-kpi__sub">Valor que cai na conta Mercado Pago</div>
            </div>

            <div class="cl-intel-kpi">
              <div class="cl-intel-kpi__label">Lucro Mensal Simulado</div>
              <div class="cl-intel-kpi__value" style="color: ${hasCost && sim.monthlyProfit >= 0 ? '#059669' : (hasCost ? '#dc2626' : '#64748b')};">
                ${hasCost ? money.format(sim.monthlyProfit) : '—'}
              </div>
              <div class="cl-intel-kpi__sub">${hasCost ? `Projeção de ${number.format(sim.dailySales * 30)} vendas/mês` : 'Preencha o custo para projetar'}</div>
            </div>
          </div>

          <!-- Demonstrativo Financeiro Completo da Venda -->
          <div class="cl-intel-card" style="padding: 14px 16px;">
            <div class="cl-intel-section-title">
              <span>Raio-X Financeiro da Venda Unitária</span>
              <span style="font-size: 11px; color: #64748b;">DRE por pedido</span>
            </div>

            <div style="display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; margin-top: 8px;">
              <div style="display: flex; justify-content: space-between; padding: 4px 0;">
                <span>Preço de Venda Praticado:</span>
                <strong>+ ${money.format(sim.price)}</strong>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #dc2626;">
                <span>(-) Tarifa de Comissão ML (${sim.commissionPercent}%):</span>
                <span>- ${money.format(sim.commission)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #dc2626;">
                <span>(-) Tarifa de Envio ML:</span>
                <span>- ${money.format(sim.shippingFee)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 6px 0; border-top: 1px dashed #cbd5e1; border-bottom: 1px dashed #cbd5e1; font-weight: 700; color: #166534; background: #f0fdf4; margin: 2px -6px; padding-left: 6px; padding-right: 6px; border-radius: 4px;">
                <span>(=) Repasse Líquido do ML:</span>
                <span>${money.format(sim.repasse)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 4px 0; color: ${hasCost ? '#dc2626' : '#64748b'};">
                <span>(-) Seu Custo do Produto:</span>
                <span>${hasCost ? '- ' + money.format(sim.productCost) : 'Não informado'}</span>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #dc2626;">
                <span>(-) Impostos (${this.simForm.taxPercent || 0}%):</span>
                <span>- ${money.format(sim.taxes)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 4px 0; color: #dc2626;">
                <span>(-) Embalagem e Publicidade:</span>
                <span>- ${money.format(sim.packagingCost + sim.adsCost)}</span>
              </div>
              <div style="display: flex; justify-content: space-between; padding: 8px 6px; border-top: 2px solid #00a650; font-size: 13.5px; font-weight: 800; color: ${hasCost && sim.unitProfit < 0 ? '#dc2626' : '#00a650'}; background: #e8f8ee; border-radius: 4px; margin-top: 4px;">
                <span>(=) Sobra Real no Seu Bolso:</span>
                <span>${hasCost ? money.format(sim.unitProfit) + ` (${sim.marginPercent.toFixed(1)}%)` : 'Informe o custo'}</span>
              </div>
            </div>
          </div>

          <!-- Decisão & Viabilidade -->
          <div class="cl-intel-card">
            <div class="cl-intel-section-title">
              <span>Inteligência de Viabilidade & Decisão</span>
            </div>

            <div style="display: flex; flex-direction: column; gap: 8px; font-size: 12.5px;">
              <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9;">
                <span>🎯 <strong>Preço sugerido para sua margem (${sim.targetMargin}%):</strong></span>
                <strong style="color: #1e293b; font-size: 13.5px;">
                  ${sim.minViablePrice ? money.format(sim.minViablePrice) : (hasCost ? 'Acima do teto de simulação' : 'Informe seu custo')}
                </strong>
              </div>

              <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9;">
                <span>💡 <strong>Custo máximo que pode pagar no produto:</strong></span>
                <strong style="color: ${sim.maxAcquisitionCost >= 0 ? '#059669' : '#dc2626'};">
                  ${sim.maxAcquisitionCost >= 0 ? 'Até ' + money.format(sim.maxAcquisitionCost) : 'Margem inatingível neste preço'}
                </strong>
              </div>

              <div style="display: flex; justify-content: space-between; padding: 6px 0;">
                <span>📦 <strong>Vendas para meta de ${money.format(sim.monthlyGoal)}:</strong></span>
                <strong>
                  ${sim.unitsForGoal ? number.format(sim.unitsForGoal) + ' vendas/mês (' + (sim.unitsForGoal / 30).toFixed(1) + '/dia)' : '—'}
                </strong>
              </div>
            </div>
          </div>

          <!-- Cenários de Venda -->
          <div class="cl-intel-card">
            <div class="cl-intel-section-title">
              <span>Cenários de Vendas Baseados na Busca</span>
            </div>

            <div class="cl-intel-scenarios-grid">
              <div class="cl-intel-scenario-card">
                <span>Conservador (P25)</span>
                <strong>${number.format(p25)} un./dia</strong>
                <small>${hasCost ? money.format(scenConservador.monthlyProfit) + '/mês lucro' : money.format(scenConservador.monthlyRevenue) + '/mês fat.'}</small>
              </div>

              <div class="cl-intel-scenario-card is-ref">
                <span>Referência (P50)</span>
                <strong>${number.format(p50)} un./dia</strong>
                <small>${hasCost ? money.format(scenReferencia.monthlyProfit) + '/mês lucro' : money.format(scenReferencia.monthlyRevenue) + '/mês fat.'}</small>
              </div>

              <div class="cl-intel-scenario-card">
                <span>Expansivo (P75)</span>
                <strong>${number.format(p75)} un./dia</strong>
                <small>${hasCost ? money.format(scenExpansivo.monthlyProfit) + '/mês lucro' : money.format(scenExpansivo.monthlyRevenue) + '/mês fat.'}</small>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    // 6. Inteligência de Categorias
    renderCategoriesTab(items, allItems) {
      const calcFn = (d) => this.cards.calculation(d);
      const searchCtx = this.cards?.registry?.getSearchContext?.();
      const catData = MarketIntelligenceEngine.calculateCategories(items, calcFn, searchCtx);

      // Apply sorting on groups
      const sortedGroups = [...catData.groups];
      if (this.categorySort === "revenue") sortedGroups.sort((a, b) => b.projectedMonthlyRevenue - a.projectedMonthlyRevenue);
      else if (this.categorySort === "giro") sortedGroups.sort((a, b) => b.medianDailyGiro - a.medianDailyGiro);
      else if (this.categorySort === "ads") sortedGroups.sort((a, b) => b.uniqueCount - a.uniqueCount);
      else if (this.categorySort === "iqv") sortedGroups.sort((a, b) => (b.iqv?.generalScore || 0) - (a.iqv?.generalScore || 0));
      else if (this.categorySort === "margin") sortedGroups.sort((a, b) => b.medianReturnRatio - a.medianReturnRatio);

      // Section A: Resumo Geral
      const topName = catData.topGroup ? catData.topGroup.name : "N/D";
      const topShare = catData.topGroup ? catData.topGroup.revenueShare.toFixed(1) : "0";

      // Section C: Bar chart data
      const metricKey = this.categoryMetric;
      const maxVal = Math.max(
        ...sortedGroups.map((g) => metricKey === "revenue" ? g.projectedMonthlyRevenue : metricKey === "giro" ? g.totalDailyGiro : g.uniqueCount),
        1
      );

      const barsHtml = sortedGroups.map((g) => {
        const val = metricKey === "revenue" ? g.projectedMonthlyRevenue : metricKey === "giro" ? g.totalDailyGiro : g.uniqueCount;
        const pct = Math.round((val / maxVal) * 100);
        const valFormatted = metricKey === "revenue" ? money.format(val) : metricKey === "giro" ? `${number.format(val)} un./dia` : `${g.uniqueCount} anúncios`;
        const sharePct = metricKey === "revenue" ? g.revenueShare : metricKey === "giro" ? g.giroShare : g.adShare;
        return `
          <div class="cl-intel-bar-row">
            <div class="cl-intel-bar-meta">
              <strong>${escapeHtml(g.name)}</strong>
              <span><strong>${valFormatted}</strong> (${sharePct.toFixed(1)}%)</span>
            </div>
            <div class="cl-intel-bar-track">
              <div class="cl-intel-bar-fill" style="width: ${pct}%; background-color: #3483fa;"></div>
            </div>
          </div>
        `;
      }).join("");

      // Section B: Table rows
      const tableRowsHtml = sortedGroups.map((g, idx) => {
        const iqvScore = g.iqv?.generalScore != null ? number.format(g.iqv.generalScore) : "—";
        const iqvClass = g.iqv?.generalClassification?.label || "—";
        const iqvColor = g.iqv?.generalClassification?.color || "#737373";
        const isSelected = this.selectedSubcategory === g.key;
        return `
          <tr class="${isSelected ? 'is-selected' : ''}" style="${isSelected ? 'background-color: #f0fdf4;' : ''}">
            <td><strong>#${idx + 1}</strong></td>
            <td>
              <strong style="color: #333; font-size: 13px;">${escapeHtml(g.name)}</strong>
              ${g.domainId ? `<div style="font-size: 10.5px; color: #888;">${escapeHtml(g.domainId)}</div>` : ''}
            </td>
            <td>
              <strong>${g.uniqueCount}</strong> un.
              ${g.totalPositions > g.uniqueCount ? `<span style="font-size: 10.5px; color: #888;">(${g.totalPositions} pos.)</span>` : ''}
            </td>
            <td>${this.formatMeliPrice(g.medianPrice)}</td>
            <td><strong>${number.format(g.medianDailyGiro)}</strong> un./dia</td>
            <td><strong>${money.format(g.projectedMonthlyRevenue)}</strong></td>
            <td><span class="cl-intel-badge-pro" style="background: #eef2ff; color: #4338ca;">${g.revenueShare.toFixed(1)}%</span></td>
            <td><strong style="color: #00a650;">${(g.medianReturnRatio * 100).toFixed(1)}%</strong></td>
            <td>
              <span class="cl-iqv-pill" style="padding: 2px 7px; border-radius: 999px; background: ${iqvColor}15; color: ${iqvColor}; font-weight: 700; font-size: 11.5px; display: inline-flex; align-items: center; gap: 4px;">
                <span style="width: 6px; height: 6px; border-radius: 50%; background: ${iqvColor};"></span>
                ${iqvScore} (${iqvClass})
              </span>
            </td>
            <td>
              <button type="button" class="cl-intel-cat-btn" data-cat-select="${escapeHtml(g.key)}">
                ${isSelected ? 'Fechar' : `Ver anúncios (${g.uniqueCount})`}
              </button>
            </td>
          </tr>
        `;
      }).join("");

      // Section D: Filters distribution
      const filters = catData.searchContext?.filters || [];
      const filtersHtml = filters.length > 0
        ? filters.slice(0, 8).map((grp) => {
            const pills = grp.values.slice(0, 10).map((val) => `
              <span class="cl-intel-filter-pill ${val.isActive ? 'is-active' : ''}">
                ${escapeHtml(val.name)} ${val.count > 0 ? `<small>(${number.format(val.count)})</small>` : ''}
              </span>
            `).join("");
            return `
              <div class="cl-intel-filter-group">
                <span class="cl-intel-filter-group__title">${escapeHtml(grp.name)}</span>
                <div class="cl-intel-filter-group__pills">${pills}</div>
              </div>
            `;
          }).join("")
        : `<div style="color: #888; font-size: 12px; padding: 8px 0;">Filtros oficiais do Mercado Livre sincronizados localmente conforme o carregamento da busca.</div>`;

      // Section E: Selected Subcategory Products Drawer
      let drawerHtml = "";
      if (this.selectedSubcategory) {
        const selectedGroup = sortedGroups.find((g) => g.key === this.selectedSubcategory);
        if (selectedGroup) {
          const cardsHtml = selectedGroup.items.map((it) => {
            const img = it.data.thumbnail
              ? `<img class="cl-ml-card__img" src="${escapeHtml(it.data.thumbnail)}" alt="${escapeHtml(it.data.title)}" loading="lazy" />`
              : `<div style="font-size: 40px; color: #cbd5e1;">📦</div>`;
            const giro = it.advanced?.salesPerDay != null ? `${number.format(it.advanced.salesPerDay)} un./dia` : "—";
            const fat = it.advanced?.monthlyRevenue != null ? money.format(it.advanced.monthlyRevenue) : "—";
            return `
              <div class="cl-ml-card" style="padding: 10px;">
                <div class="cl-ml-card__portada" style="height: 120px;">
                  ${img}
                </div>
                <div class="cl-ml-card__body" style="padding: 8px 4px 4px;">
                  <h4 class="cl-ml-card__title" style="font-size: 12px; line-height: 1.3;" title="${escapeHtml(it.data.title)}">
                    <a href="${escapeHtml(it.data.permalink)}" target="_blank">${escapeHtml(it.data.title)}</a>
                  </h4>
                  <div style="margin-top: 4px;">
                    ${this.formatMeliPrice(it.data.price)}
                  </div>
                  <div class="cl-ml-card__tags" style="margin-top: 4px;">
                    ${it.data.isFull ? '<span class="cl-ml-tag-full">⚡ FULL</span>' : ''}
                    ${it.data.isSponsored ? '<span class="cl-intel-badge-pro" style="background:#fef3c7;color:#92400e;">Patrocinado</span>' : ''}
                  </div>
                  <div style="margin-top: 8px; font-size: 11px; color: #555; display: flex; flex-direction: column; gap: 2px;">
                    <div>Giro diário: <strong style="color: #00a650;">${giro}</strong></div>
                    <div>Fat. mensal: <strong>${fat}</strong></div>
                  </div>
                  <a class="cl-ml-card__btn" style="margin-top: 8px; padding: 5px;" href="${escapeHtml(it.data.permalink)}" target="_blank">
                    Ver no Mercado Livre ↗
                  </a>
                </div>
              </div>
            `;
          }).join("");

          drawerHtml = `
            <div class="cl-intel-card" style="margin-top: 20px; border: 1.5px solid #3483fa; background: #fafbff;">
              <div style="display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid #e2e8f0; padding-bottom: 12px; margin-bottom: 14px;">
                <div>
                  <h3 style="font-size: 15px; font-weight: 700; color: #1e293b; margin: 0;">
                    Anúncios da Subcategoria: <span style="color: #3483fa;">${escapeHtml(selectedGroup.name)}</span>
                  </h3>
                  <span style="font-size: 11.5px; color: #64748b;">Mostrando ${selectedGroup.items.length} anúncios capturados</span>
                </div>
                <button type="button" class="cl-intel-cat-close-btn" data-cat-clear>✕ Fechar lista</button>
              </div>
              <div class="cl-ml-cards-grid" style="grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px;">
                ${cardsHtml}
              </div>
            </div>
          `;
        }
      }

      // Section F: Related searches
      const related = catData.searchContext?.relatedSearches || [];
      const relatedHtml = related.length > 0
        ? `
          <div class="cl-intel-card" style="margin-top: 16px;">
            <div class="cl-intel-section-title">
              <span>Palavras-chave e Buscas Relacionadas pelo Mercado Livre</span>
            </div>
            <div style="display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;">
              ${related.map((r) => `
                <div class="cl-intel-related-pill">
                  <span>${escapeHtml(r.term)}</span>
                  <span class="cl-intel-badge-pro" style="background: ${r.badgeColor}15; color: ${r.badgeColor};">
                    ${r.relevanceLabel} (${r.score}%)
                  </span>
                </div>
              `).join("")}
            </div>
          </div>
        `
        : "";

      return `
        <!-- Seção A: KPIs Gerais -->
        <div class="cl-intel-kpis">
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Subcategorias Detectadas</div>
            <div class="cl-intel-kpi__value">${sortedGroups.length}</div>
            <div class="cl-intel-kpi__sub">Segmentos mapeados na busca</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Subcategoria Líder</div>
            <div class="cl-intel-kpi__value" style="font-size: 18px; color: #3483fa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;" title="${escapeHtml(topName)}">${escapeHtml(topName)}</div>
            <div class="cl-intel-kpi__sub">Concentra <strong>${topShare}%</strong> do faturamento</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Deduplicação de Anúncios</div>
            <div class="cl-intel-kpi__value" style="color: #059669;">${catData.uniqueAdsCount} <small style="font-size: 13px; font-weight: 500; color: #64748b;">únicos</small></div>
            <div class="cl-intel-kpi__sub">${catData.duplicatedPositions > 0 ? `${catData.duplicatedPositions} patrocinados duplicados unificados` : 'Sem sobreposições patrocinadas'}</div>
          </div>
          <div class="cl-intel-kpi">
            <div class="cl-intel-kpi__label">Faturamento Total Projetado</div>
            <div class="cl-intel-kpi__value">${money.format(catData.aggregatedRevenue)}</div>
            <div class="cl-intel-kpi__sub">Soma consolidada sem duplicações</div>
          </div>
        </div>

        <!-- Insight -->
        <div class="cl-intel-insight">
          <span style="font-size: 18px;">💡</span>
          <div>${catData.insight}</div>
        </div>

        <!-- Seção C: Gráfico de Composição Comercial -->
        <div class="cl-intel-card" style="margin-top: 16px;">
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin-bottom: 12px;">
            <div class="cl-intel-section-title" style="margin: 0;">
              <span>Composição da Pesquisa por Subcategoria</span>
            </div>
            <div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #555;">
              <span>Métrica do gráfico:</span>
              <select class="cl-intel-select" data-cat-metric>
                <option value="revenue" ${this.categoryMetric === 'revenue' ? 'selected' : ''}>Faturamento Projetado (R$)</option>
                <option value="giro" ${this.categoryMetric === 'giro' ? 'selected' : ''}>Giro Diário Agregado (un./dia)</option>
                <option value="ads" ${this.categoryMetric === 'ads' ? 'selected' : ''}>Quantidade de Anúncios</option>
              </select>
            </div>
          </div>
          <div class="cl-intel-bars">
            ${barsHtml}
          </div>
        </div>

        <!-- Seção B: Mapa Comparativo de Subcategorias -->
        <div class="cl-intel-card" style="padding: 0; overflow: hidden; margin-top: 16px;">
          <div style="padding: 14px 16px; border-bottom: 1px solid rgba(0, 0, 0, 0.08); display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px;">
            <div class="cl-intel-section-title" style="margin: 0;">Mapa Comparativo de Subcategorias / Domínios</div>
            <div style="display: flex; align-items: center; gap: 8px; font-size: 12px; color: #555;">
              <span>Ordenar por:</span>
              <select class="cl-intel-select" data-cat-sort>
                <option value="revenue" ${this.categorySort === 'revenue' ? 'selected' : ''}>Maior Faturamento</option>
                <option value="giro" ${this.categorySort === 'giro' ? 'selected' : ''}>Maior Giro Diário</option>
                <option value="ads" ${this.categorySort === 'ads' ? 'selected' : ''}>Mais Anúncios</option>
                <option value="iqv" ${this.categorySort === 'iqv' ? 'selected' : ''}>Maior IQV</option>
                <option value="margin" ${this.categorySort === 'margin' ? 'selected' : ''}>Maior Repasse Líquido</option>
              </select>
            </div>
          </div>
          <div class="cl-intel-table-wrap" style="border: 0; border-radius: 0;">
            <table class="cl-intel-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Subcategoria / Domínio</th>
                  <th>Anúncios</th>
                  <th>Preço Mediano</th>
                  <th>Giro Diário</th>
                  <th>Faturamento Projetado</th>
                  <th>Share Fat.</th>
                  <th>Repasse Líquido</th>
                  <th>IQV da Subcategoria</th>
                  <th>Ação</th>
                </tr>
              </thead>
              <tbody>
                ${tableRowsHtml}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Seção E: Gaveta de Anúncios da Subcategoria -->
        ${drawerHtml}

        <!-- Seção D: Filtros Oficiais do Mercado Livre -->
        <div class="cl-intel-card" style="margin-top: 16px;">
          <div class="cl-intel-section-title">
            <span>Filtros Oficiais do Mercado Livre (Segmentação de Catálogo)</span>
          </div>
          <div style="margin-top: 10px; display: flex; flex-direction: column; gap: 12px;">
            ${filtersHtml}
          </div>
        </div>

        <!-- Seção F: Termos e Buscas Relacionadas -->
        ${relatedHtml}
      `;
    }

    bindGlobalEvents() {
      // Close button
      this.root.querySelector("[data-intel-close]")?.addEventListener("click", () => this.close());

      // Export XLSX
      this.root.querySelector("[data-intel-export]")?.addEventListener("click", () => {
        CalculadoraLivreXlsxExporter.runExport({
          cards: this.cards,
          settings: this.settings,
          iqvAnalysis: this.iqvAnalysis,
          simForm: this.simForm
        });
      });

      // Backdrop click closes modal
      this.root.addEventListener("click", (e) => {
        if (e.target === this.root) this.close();
      });

      // Segment selector
      this.root.querySelector("[data-intel-segment]")?.addEventListener("change", (e) => {
        this.selectedSegment = e.target.value;
        this.render();
      });

      // Tab switcher
      this.root.querySelectorAll("[data-intel-tab]").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          this.activeTab = btn.dataset.intelTab;
          this.render();
        });
      });
    }

    bindTabEvents() {
      // Pricing grouping & metric
      this.root.querySelector("[data-intel-pricing-group]")?.addEventListener("change", (e) => {
        this.priceGrouping = e.target.value;
        this.render();
      });
      this.root.querySelector("[data-intel-pricing-metric]")?.addEventListener("change", (e) => {
        this.priceMetric = e.target.value;
        this.render();
      });

      // Category tab events
      this.root.querySelector("[data-cat-sort]")?.addEventListener("change", (e) => {
        this.categorySort = e.target.value;
        this.render();
      });
      this.root.querySelector("[data-cat-metric]")?.addEventListener("change", (e) => {
        this.categoryMetric = e.target.value;
        this.render();
      });
      this.root.querySelectorAll("[data-cat-select]").forEach((btn) => {
        btn.addEventListener("click", () => {
          const key = btn.dataset.catSelect;
          this.selectedSubcategory = this.selectedSubcategory === key ? null : key;
          this.render();
        });
      });
      this.root.querySelector("[data-cat-clear]")?.addEventListener("click", () => {
        this.selectedSubcategory = null;
        this.render();
      });

      // Live simulator inputs (atualização pontual dos resultados sem perda de foco)
      const updateSimulator = (key, val) => {
        this.simForm[key] = val;
        const resultsEl = this.root.querySelector("[data-sim-results]");
        if (resultsEl) {
          const items = this.getItems();
          resultsEl.outerHTML = this.renderSimulatorResultsHtml(items);
        }
      };

      this.root.querySelectorAll("[data-sim]").forEach((input) => {
        const key = input.dataset.sim;
        input.addEventListener("input", (e) => {
          updateSimulator(key, e.target.value);
        });
        input.addEventListener("change", (e) => {
          updateSimulator(key, e.target.value);
        });
      });
    }

    bindEvents() {
      this.bindGlobalEvents();
      this.bindTabEvents();
    }
  }

  class IQVPanelInjector {
    constructor(settings, cards) {
      this.settings = settings;
      this.cards = cards;
      this.root = null;
      this.debouncedUpdate = debounce(() => this.executeUpdate(), 250);
      this.lastSignature = "";
    }

    mount() {
      const isOffers = /^\/ofertas(?:\/|$)/i.test(location.pathname);
      if (isOffers) {
        document.querySelector("#calculadora-livre-iqv")?.remove();
        this.root = null;
        return;
      }
      const existing = document.querySelector("#calculadora-livre-iqv");
      this.root = existing ?? document.createElement("section");
      this.root.id = "calculadora-livre-iqv";
      this.root.className = "cl-root cl-iqv-panel";

      if (!this.root.isConnected) {
        const searchbar = document.querySelector("#calculadora-livre-searchbar");
        if (searchbar && searchbar.isConnected) {
          searchbar.before(this.root);
        } else {
          const offersSidebar = document.querySelector("[data-testid='filters'], .items-filters-section .sidebar");
          const filters = document.querySelector(".ui-search-filter-groups") ?? offersSidebar?.querySelector(".qcat-filters");
          const sidebar = document.querySelector(".ui-search-sidebar") ?? offersSidebar;
          const offersList = document.querySelector("[data-testid='items-list']");
          if (!filters && !sidebar && !offersList) return;

          if (filters) filters.before(this.root);
          else if (sidebar) sidebar.prepend(this.root);
          else if (offersList) offersList.before(this.root);
        }
      }
    }

    update() {
      this.debouncedUpdate();
    }

    executeUpdate() {
      this.mount();
      if (!this.root?.isConnected) return;
      this.render();
      if (MarketIntelligenceModal.isOpen()) {
        const items = this.cards.values();
        const analysis = IQVAnalysisEngine.analyze(items, (data) => this.cards.calculation(data));
        MarketIntelligenceModal.update(this.cards, this.settings, analysis);
      }
    }

    render() {
      if (!this.root) return;
      const items = this.cards.values();
      const analysis = IQVAnalysisEngine.analyze(items, (data) => this.cards.calculation(data));

      const signature = `${analysis.state}|${analysis.generalScore?.toFixed(1)}|${analysis.totalEvaluated}|${analysis.totalAds}`;
      if (this.lastSignature === signature && this.root.children.length > 0) return;
      this.lastSignature = signature;

      const hasGeneral = analysis.generalScore != null && Number.isFinite(analysis.generalScore);
      const scoreNum = hasGeneral ? analysis.generalScore : 0;
      const scoreFormatted = hasGeneral ? number.format(scoreNum) : "—";
      const tierColor = analysis.generalClassification.color;
      const tierLabel = analysis.generalClassification.label;

      const circumference = 226.19;
      const dashoffset = hasGeneral ? circumference * (1 - clamp(scoreNum, 0, 100) / 100) : circumference;

      const tiersHtml = ["baixo", "medio", "alto"].map((tierId) => {
        const t = analysis.tiers[tierId];
        const tHasData = t.hasData && t.score != null;
        const tScoreFormatted = tHasData ? number.format(t.score) : "";
        const tColor = tHasData ? t.classification.color : "#999";
        const fillWidth = tHasData ? clamp(t.score, 0, 100) : 0;
        return `<div class="cl-iqv-tier-row">
          <div class="cl-iqv-tier-row__head">
            <div class="cl-iqv-tier-name-wrap">
              <span class="cl-iqv-tier-name">${escapeHtml(t.label)}</span>
              <span class="cl-iqv-tier-range">(${escapeHtml(t.rangeLabel)})</span>
            </div>
            <div class="cl-iqv-tier-score-wrap">
              ${tHasData ? `<strong class="cl-iqv-tier-score" style="color: ${tColor}">${tScoreFormatted}</strong><small class="cl-iqv-tier-max">/100</small>` : `<span class="cl-iqv-tier-nodata">Dados insuficientes</span>`}
            </div>
          </div>
          <div class="cl-iqv-progress-track">
            <div class="cl-iqv-progress-fill" style="width: ${fillWidth}%; background-color: ${tColor};"></div>
          </div>
        </div>`;
      }).join("");

      const mainIndicatorHtml = analysis.state === "analyzing"
        ? `<div class="cl-iqv-main">
            <div class="cl-iqv-gauge-wrapper">
              <svg viewBox="0 0 88 88" class="cl-iqv-gauge">
                <circle class="cl-iqv-gauge__bg" cx="44" cy="44" r="36" />
                <circle class="cl-iqv-gauge__fill" cx="44" cy="44" r="36" stroke="#3483fa" stroke-dasharray="226.19" stroke-dashoffset="150" />
              </svg>
              <div class="cl-iqv-gauge__inner"><span class="cl-iqv-gauge__val" style="font-size: 13px;">...</span></div>
            </div>
            <div class="cl-iqv-main__info">
              <div class="cl-iqv-main__label" style="color: var(--cl-blue);">Analisando anúncios...</div>
              <div class="cl-iqv-main__desc">Calculando giro, receita e repasse da lista</div>
            </div>
          </div>`
        : `<div class="cl-iqv-main">
            <div class="cl-iqv-gauge-wrapper">
              <svg viewBox="0 0 88 88" class="cl-iqv-gauge">
                <circle class="cl-iqv-gauge__bg" cx="44" cy="44" r="36" />
                <circle class="cl-iqv-gauge__fill" cx="44" cy="44" r="36" stroke="${tierColor}" stroke-dasharray="226.19" stroke-dashoffset="${dashoffset}" />
              </svg>
              <div class="cl-iqv-gauge__inner">
                <span class="cl-iqv-gauge__val">${scoreFormatted}</span>
                ${hasGeneral ? '<span class="cl-iqv-gauge__max">/ 100</span>' : ''}
              </div>
            </div>
            <div class="cl-iqv-main__info">
              <div class="cl-iqv-main__label" style="color: ${tierColor}">${tierLabel}</div>
              <div class="cl-iqv-main__desc">${hasGeneral ? "Atratividade comercial ponderada da pesquisa" : "Aguardando histórico comercial suficiente dos anúncios"}</div>
            </div>
          </div>`;

      const isInitial = !this.root.querySelector(".cl-iqv-header");
      if (isInitial) {
        this.root.innerHTML = `
          <div class="cl-iqv-header">
            <div class="cl-iqv-header__text">
              <div class="cl-iqv-title-row">
                <h2 class="cl-iqv-title">IQV — Qualidade e Viabilidade</h2>
                <span class="cl-iqv-badge-tag">Índice Comercial</span>
              </div>
            </div>
          </div>

          <div class="cl-iqv-main-host">
            ${mainIndicatorHtml}
          </div>

          <div class="cl-iqv-tiers">
            ${tiersHtml}
          </div>

          <div class="cl-iqv-footer">
            <span class="cl-iqv-count-text">
              <strong>${analysis.totalEvaluated}</strong> de <strong>${analysis.totalAds}</strong> avaliados
            </span>
          </div>

          <button type="button" class="cl-iqv-details-btn" data-iqv-open-modal>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>
            <span>Ver detalhes da inteligência</span>
          </button>
        `;
        this.bind();
      } else {
        const mainHost = this.root.querySelector(".cl-iqv-main-host");
        if (mainHost) mainHost.innerHTML = mainIndicatorHtml;

        const tiersEl = this.root.querySelector(".cl-iqv-tiers");
        if (tiersEl) tiersEl.innerHTML = tiersHtml;

        const countText = this.root.querySelector(".cl-iqv-count-text");
        if (countText) {
          countText.innerHTML = `<strong>${analysis.totalEvaluated}</strong> de <strong>${analysis.totalAds}</strong> avaliados`;
        }
      }
    }

    bind() {
      const btn = this.root.querySelector("[data-iqv-open-modal]");
      btn?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        const items = this.cards.values();
        const analysis = IQVAnalysisEngine.analyze(items, (data) => this.cards.calculation(data));
        MarketIntelligenceModal.open(this.cards, this.settings, analysis);
      });
    }
  }

  class SearchTopBarInjector {
    constructor(settings, cards) { this.settings = settings; this.cards = cards; this.root = null; this.sortMode = "default"; }
    mount() {
      const isOffers = /^\/ofertas(?:\/|$)/i.test(location.pathname);
      if (isOffers) {
        document.querySelector("#calculadora-livre-searchbar")?.remove();
        this.root = null;
        return;
      }
      const offersSidebar = document.querySelector("[data-testid='filters'], .items-filters-section .sidebar");
      const filters = document.querySelector(".ui-search-filter-groups") ?? offersSidebar?.querySelector(".qcat-filters");
      const sidebar = document.querySelector(".ui-search-sidebar") ?? offersSidebar;
      const offersList = document.querySelector("[data-testid='items-list']");
      if (!filters && !sidebar && !offersList) return;

      const existing = document.querySelector("#calculadora-livre-searchbar");
      this.root = existing ?? document.createElement("section");
      this.root.id = "calculadora-livre-searchbar";
      this.root.className = `cl-root cl-market-filters${offersList && !sidebar ? " cl-market-filters--offers" : ""}`;

      if (!this.root.isConnected) {
        const iqv = document.querySelector("#calculadora-livre-iqv");
        if (iqv && iqv.isConnected) {
          iqv.after(this.root);
        } else if (filters) {
          filters.before(this.root);
        } else if (sidebar) {
          sidebar.prepend(this.root);
        } else if (offersList) {
          offersList.before(this.root);
        }
      }
      if (!existing || this.root.children.length === 0) this.render();
    }
    render() {
      if (!this.root) return;
      this.root.innerHTML = `<div class="cl-market-filters__head"><div><h2>Filtros Calculadora Livre</h2><span>Cálculos e inteligência dos anúncios</span></div><span class="cl-badge cl-badge--yellow" data-count>0</span></div><div class="cl-market-actions"><label class="cl-field">Ordenar resultados<select class="cl-select" data-sort><option value="default">Ordem do Mercado Livre</option><option value="payout">Maior repasse líquido</option><option value="daily-sales">Maior média de vendas diária</option><option value="monthly-revenue">Maior faturamento mensal</option><option value="oldest">Mais antigos primeiro</option><option value="newest">Mais recentes primeiro</option></select></label></div>`;
      this.bind(); this.update();
    }
    update() {
      this.mount();
      if (!this.root?.isConnected) return;
      this.cards.prune();
      const items = this.cards.values(); const count = items.length;
      const countEl = this.root.querySelector("[data-count]");
      if (countEl) countEl.textContent = `${count} anúncios`;
      if (this.sortMode !== "default") this.applyView();
    }
    bind() {
      this.root.querySelector("[data-sort]").addEventListener("change", (event) => { this.sortMode = event.target.value; this.applyView(); });
    }
    applyView() {
      if (this.sortMode === "default") return;
      const items = this.cards.values();
      if (this.sortMode === "payout") items.sort((a, b) => this.cards.calculation(b.data).netPayout - this.cards.calculation(a.data).netPayout);
      else if (this.sortMode === "daily-sales") items.sort((a, b) => (b.advanced?.salesPerDay ?? -1) - (a.advanced?.salesPerDay ?? -1));
      else if (this.sortMode === "monthly-revenue") items.sort((a, b) => (b.advanced?.monthlyRevenue ?? -1) - (a.advanced?.monthlyRevenue ?? -1));
      else if (this.sortMode === "oldest") items.sort((a, b) => (b.advanced?.estimatedDaysActive ?? -1) - (a.advanced?.estimatedDaysActive ?? -1));
      else if (this.sortMode === "newest") items.sort((a, b) => {
        const ageA = a.advanced?.estimatedDaysActive;
        const ageB = b.advanced?.estimatedDaysActive;
        if (!ageA && !ageB) return a.originalIndex - b.originalIndex;
        if (!ageA) return 1;
        if (!ageB) return -1;
        return ageA - ageB;
      });
      const groups = new Map();
      items.forEach((item) => {
        const parent = item.card.parentElement;
        if (!parent) return;
        if (parent.closest(".andes-carousel-snapped, .poly-component__carousel, [data-andes-carousel-snapped-main], .andes-carousel-snapped__wrapper")) return;
        if (!groups.has(parent)) groups.set(parent, []);
        groups.get(parent).push(item.card);
      });
      groups.forEach((cards, parent) => {
        const cardSet = new Set(cards);
        const current = [...parent.children].filter((child) => cardSet.has(child));
        if (!cards.every((card, index) => current[index] === card)) cards.forEach((card) => parent.append(card));
      });
    }
  }

  async function initialize() {
    const registry = new StructuredDataRegistry();
    let settings = await StorageManager.get();
    if (document.readyState === "loading") await new Promise((resolve) => document.addEventListener("DOMContentLoaded", resolve, { once: true }));
    document.querySelectorAll("script").forEach((script) => {
      const text = script.textContent ?? "";
      if (script.id === "__NORDIC_RENDERING_CTX__" || script.id === "__NEXT_DATA__" || script.type.includes("json") || /sold_quantity|date_created|start_time|item_id|picture_id/i.test(text)) registry.ingestText(text);
    });
    const hasProductStructure = Boolean(document.querySelector("#buybox-form, form.ui-pdp-buybox, .ui-pdp-price__second-line, [data-testid='price-part'], .ui-pdp-container__col.col-1.ui-pdp-container--column-right, #main_actions"));
    const isOffers = /^\/ofertas(?:\/|$)/i.test(location.pathname);
    const isSearch = !hasProductStructure && (isOffers || location.hostname.startsWith("lista.") || Boolean(document.querySelector(CARD_SELECTOR)));
    let pdp, cards, topbar, iqv;
    if (isSearch) {
      cards = new SearchPolycardInjector(settings, registry, () => {
        topbar?.update();
        iqv?.update();
      });
      topbar = new SearchTopBarInjector(settings, cards);
      iqv = new IQVPanelInjector(settings, cards);
      topbar.mount();
      iqv.mount();
      cards.observe();
      topbar.update();
      iqv.update();
    } else {
      pdp = new PdpWidgetInjector(settings, registry); pdp.observe();
    }
    StorageManager.subscribe((patch) => {
      settings = { ...settings, ...patch };
      if (pdp) { pdp.settings = settings; if (pdp.root) pdp.render(); }
      if (cards) { cards.settings = settings; cards.values().forEach((item) => cards.render(item)); }
      if (topbar) { topbar.settings = settings; topbar.update(); }
      if (iqv) { iqv.settings = settings; iqv.update(); }
    });
  }

  initialize().catch((error) => console.error(`${APP}: falha na inicialização`, error));
})();
