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
      const price = asNumber(eventData.price?.value ?? eventData.price ?? candidate.price?.value ?? candidate.price);
      const estimatedDaysActive = creationDate ? Math.max(1, Math.ceil((Date.now() - creationDate.valueOf()) / 86400000)) : 0;
      const salesPerDay = soldQuantity && estimatedDaysActive ? soldQuantity / estimatedDaysActive : 0;
      return {
        identifiers,
        title: eventData.title ?? candidate.title ?? "",
        price,
        soldQuantity,
        creationDate,
        creationDateIsEstimated: !explicitCreationDate,
        estimatedDaysActive,
        salesPerDay,
        salesPerMonth: salesPerDay * 30,
        monthlyRevenue: salesPerDay * 30 * price,
        advancedSource: explicitCreationDate ? "structured" : "picture-date"
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
            advancedSource: record.advancedSource || previous.advancedSource
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
          records.push({
            identifiers, title, price, soldQuantity, creationDate,
            creationDateIsEstimated: !explicitCreationDate,
            estimatedDaysActive, salesPerDay, salesPerMonth: salesPerDay * 30,
            monthlyRevenue: salesPerDay * 30 * price,
            advancedSource: explicitCreationDate ? "structured" : "picture-date"
          });
        }
      }
      return records;
    }

    static normalize(initialState) {
      if (!initialState) return null;
      const track = initialState.track ?? this.findObjectWithKey(initialState, "melidata_event")?.track ?? this.findObjectWithKey(initialState, "event_data");
      const eventData = track?.melidata_event?.event_data ?? track?.event_data ?? initialState?.track?.melidata_event?.event_data ?? {};
      const components = initialState.components ?? {};
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
      const price = asNumber(eventData.price);
      const salesPerDay = estimatedDaysActive > 0 ? soldQuantity / estimatedDaysActive : 0;
      const fulfillmentOrigin = eventData.shipping_promise?.address_options?.[0]?.origins?.[0];
      const tags = Array.isArray(eventData.tags) ? eventData.tags : [];
      const subtitles = Array.isArray(eventData.subtitle_types) ? eventData.subtitle_types : [];
      const reviewRate = asNumber(eventData.review_rate ?? reviewsComponent?.rating_average);
      const reviewCount = asNumber(reviewsComponent?.reviews_count ?? reviewsComponent?.total ?? reviews.length);

      return {
        hasDeepData: true,
        title: eventData.title ?? initialState.title ?? "",
        itemId: eventData.item_id ?? "", userProductId: eventData.user_product_id ?? "", familyId: eventData.family_id ?? "",
        pageType: eventData.page_type ?? "", categoryId: eventData.category_id ?? "", domainId: eventData.domain_id ?? "",
        price, originalPrice: asNumber(eventData.original_price), meliSubsidy: asNumber(promotion.discount_meli_amount),
        campaignType: promotion.type ?? "", wholesaleShortcuts: shortcuts.map((item) => ({ quantity: asNumber(item.quantity), price: asNumber(item.price?.value) })).filter((item) => item.quantity && item.price),
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

    static fromDocument(documentNode = document) {
      const script = documentNode.querySelector("#__NORDIC_RENDERING_CTX__");
      return this.normalize(this.parseScriptText(script?.textContent ?? ""));
    }

    static fromText(text) {
      const parsed = this.parseScriptText(text);
      return { root: parsed, pdp: this.normalize(parsed), searchRecords: [...this.collectSearchRecords(parsed), ...this.collectSearchRecordsFromText(text)] };
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

  class StructuredDataRegistry {
    constructor() {
      this.byIdentifier = new Map();
      this.byTitle = new Map();
      this.records = new Set();
      this.pdpData = null;
      this.listeners = new Set();
      this.seenPayloads = new Set();
      this.notify = debounce(() => this.listeners.forEach((listener) => listener()), 120);
      bridgeInbox.forEach((payload) => this.schedule(payload));
      bridgeSubscribers.add((payload) => this.schedule(payload));
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
        const { pdp, searchRecords } = NordicJsonExtractor.fromText(text);
        searchRecords.forEach((record) => this.upsert(record));
        if (pdp && (pdp.itemId || pdp.price || pdp.soldQuantity)) this.upsertPdp(pdp);
        if (searchRecords.length || pdp?.itemId) this.notify();
      } catch (error) {
        console.debug(`${APP}: bloco estruturado ignorado`, error);
      }
    }

    upsert(record) {
      if (!record?.identifiers?.length) return;
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
        advancedSource: record.advancedSource || previous.advancedSource
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
        picture_id: data.creationDateIsEstimated && data.creationDate ? `_01${new Date(data.creationDate).getFullYear()}` : ""
      });
      if (record) this.upsert({ ...record, creationDate: data.creationDate, creationDateIsEstimated: data.creationDateIsEstimated, estimatedDaysActive: data.estimatedDaysActive, salesPerDay: data.salesPerDay, salesPerMonth: data.salesPerMonth, monthlyRevenue: data.monthlyRevenue });
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
      const price = data.price || record.price;
      const days = record.creationDate ? Math.max(1, Math.ceil((Date.now() - new Date(record.creationDate).valueOf()) / 86400000)) : record.estimatedDaysActive || 0;
      const salesPerDay = record.soldQuantity && days ? record.soldQuantity / days : record.salesPerDay || 0;
      return {
        ...record,
        price,
        estimatedDaysActive: days,
        salesPerDay,
        salesPerMonth: salesPerDay * 30,
        monthlyRevenue: salesPerDay * 30 * price
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
      const fraction = container.querySelector(".andes-money-amount__fraction")?.textContent?.replace(/\D/g, "") ?? "0";
      const cents = container.querySelector(".andes-money-amount__cents")?.textContent?.replace(/\D/g, "") ?? "0";
      return asNumber(`${fraction}.${cents.padEnd(2, "0")}`);
    }

    static fromSearchCard(card) {
      const titleLink = card.querySelector("a.poly-component__title, a.ui-search-link, a[href*='/MLB-']");
      const installment = card.querySelector(".poly-price__installments, .ui-search-price__second-line")?.textContent ?? "";
      const fullNode = card.querySelector('svg use[href="#poly_full"], .poly-component__shipped-from, .ui-search-item__shipping');
      const moneyNodes = [...card.querySelectorAll(".andes-money-amount")];
      const current = card.querySelector(".poly-price__current .andes-money-amount, .poly-price__current, .ui-search-price__part--medium:not(.andes-money-amount--previous)")
        ?? moneyNodes.find((node) => !node.matches("s, .andes-money-amount--previous") && !node.closest("s") && !node.classList.contains("andes-money-amount--previous"));
      const original = card.querySelector("s.andes-money-amount, .andes-money-amount--previous");
      const text = card.textContent ?? "";
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
      return {
        hasDeepData: false,
        title: titleLink?.textContent?.trim() ?? "Produto sem título",
        permalink: titleLink?.href ?? "", identifiers,
        price: this.parseMoney(current), originalPrice: this.parseMoney(original),
        listingTypeId: /sem\s+juros/i.test(installment) || /rgb\(0,\s*166,\s*80\)|#00a650/i.test(card.querySelector(".poly-price__installments")?.getAttribute("style") ?? "") ? "gold_pro" : "gold_special",
        logisticType: fullNode ? "fulfillment" : "", isFull: Boolean(fullNode), isSponsored: /patrocinado/i.test(text) || Boolean(card.querySelector('[aria-label="Patrocinado"], .poly-component__ads-promotions')),
        soldQuantity, reviewRate: ratingMatch ? asNumber(ratingMatch[1].replace(",", ".")) : 0
      };
    }

    static fromPdp() {
      const priceRoot = document.querySelector("[data-testid='price-part'] .andes-money-amount, [data-testid='price-part'], .ui-pdp-price__second-line .andes-money-amount, .ui-pdp-price__main-part .andes-money-amount, meta[itemprop='price'], .ui-pdp-price__second-line, #price");
      const price = this.parseMoney(priceRoot);
      const text = document.body.textContent ?? "";
      const quantityText = document.querySelector("#buybox_available_quantity, [data-testid='quantity-selector-trigger'], .ui-pdp-buybox__quantity")?.textContent ?? "";
      const quantityMatch = quantityText.match(/\((\d+)\s+dispon/i);
      const ratingText = document.querySelector(".ui-pdp-review__rating, .ui-pdp-review__ratings, [data-testid='review-summary']")?.textContent ?? "";
      const ratingMatch = ratingText.match(/(\d+(?:[.,]\d+)?)/);
      return {
        hasDeepData: false,
        title: document.querySelector("h1.ui-pdp-title")?.textContent?.trim() ?? document.title,
        itemId: document.querySelector('input[name="item_id"]')?.value ?? document.querySelector('[data-item-id]')?.getAttribute("data-item-id") ?? "",
        price,
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
          <dt>Preço de venda atual</dt>
          <dd>${money.format(calc.price)}</dd>
        </div>
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
      requestAnimationFrame(() => {
        panel.getBoundingClientRect();
        this.onUpdate?.();
      });
    }
    render(item) {
      const { data, panel } = item;
      const calc = this.calculation(data);
      panel.innerHTML = `<div class="cl-poly__header"><div><strong>Calculadora Livre</strong><span>Estimativa do anúncio</span></div></div>
        <div class="cl-badges"><span class="cl-badge cl-badge--blue">${data.listingTypeId === "gold_pro" ? "Premium" : "Clássico"} · ${number.format(this.commission(data))}%</span>${data.logisticType === "fulfillment" ? '<span class="cl-badge cl-badge--green">Full</span>' : ""}${data.isSponsored ? '<span class="cl-badge cl-badge--yellow">Publicidade 3%</span>' : ""}</div>
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
      const record = this.registry.find(item.data);
      if (!record?.creationDate || !record.soldQuantity) return false;
      item.advanced = record;
      item.advancedState = "ready";
      this.queued.delete(item);
      return true;
    }

    syncStructured() {
      let changed = false;
      this.items.forEach((item) => {
        if (this.applyStructured(item)) { this.render(item); changed = true; }
      });
      if (changed) this.onUpdate?.();
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
        this.onUpdate?.();
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
      const refresh = debounce(() => { this.scan(); this.onUpdate?.(); }, 350);
      this.observer = new MutationObserver((records) => {
        const hasExternalChange = records.some((record) => !(record.target instanceof Element) || !record.target.closest(".cl-root"));
        if (hasExternalChange) refresh();
      });
      this.observer.observe(document.body, { childList: true, subtree: true });
      let pass = 0;
      const warmup = setInterval(() => {
        this.scan(); this.onUpdate?.(); pass += 1;
        if (pass >= 8) clearInterval(warmup);
      }, 800);
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
        const binMax = s + step - 0.01;
        const inBin = valid.filter((it) => it.data.price >= binMin && it.data.price <= binMax);
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
          label: `R$ ${binMin.toFixed(0)} a R$ ${(s + step - 0.01).toFixed(2).replace('.', ',')}`,
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
        return {
          rank: idx + 1,
          title: it.data.title || "Anúncio do Mercado Livre",
          price: it.data.price,
          permalink: it.data.permalink,
          salesPerDay: it.advanced.salesPerDay ?? 0,
          monthlyRevenue: rev,
          share,
          isSponsored: Boolean(it.data.isSponsored),
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
          price: it.data.price,
          daysActive: it.advanced.estimatedDaysActive,
          creationDate: it.advanced.creationDate,
          isEstimatedDate: isEstimated,
          salesPerDay: it.advanced.salesPerDay,
          monthlyRevenue: it.advanced.monthlyRevenue,
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
      if (productCost != null) {
        for (let p = 10; p <= 5000; p += 0.50) {
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
          const testMargin = (testProfit / p) * 100;
          if (testMargin >= targetMargin) {
            minViablePrice = p;
            break;
          }
        }
      }

      return {
        price,
        productCost,
        repasse,
        commission: calc.commission,
        shippingFee: calc.shippingFee,
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
  }

  class MarketIntelligenceModal {
    static instance = null;

    constructor() {
      this.root = null;
      this.cards = null;
      this.settings = null;
      this.iqvAnalysis = null;
      this.activeTab = "demand";
      this.selectedSegment = "all";
      this.priceGrouping = "10";
      this.priceMetric = "efficiency";
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

      const tabContentHtml = this.renderActiveTab(items, allItems);

      this.root.innerHTML = `
        <div class="cl-intel-modal" role="dialog" aria-modal="true" aria-labelledby="cl-intel-title">
          <header class="cl-intel-modal__header">
            <div class="cl-intel-modal__title-group">
              <h2 id="cl-intel-title" class="cl-intel-modal__title">
                <span>CalcuLivre Intelligence</span>
                <span class="cl-intel-badge-pro">Fase 1 Pro</span>
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
              <span style="color: #64748b;">Amostra: <strong>${iqv.totalEvaluated}</strong> de <strong>${iqv.totalAds}</strong> anúncios com dados consolidados</span>
            </div>
            <div>
              <span class="cl-iqv-rel-badge cl-iqv-rel--${iqv.reliability}">Confiabilidade ${iqv.reliabilityLabel}</span>
            </div>
          </div>

          <nav class="cl-intel-tabs" role="tablist">
            <button type="button" class="cl-intel-tab ${this.activeTab === 'demand' ? 'is-active' : ''}" data-intel-tab="demand">📊 Visão de Mercado</button>
            <button type="button" class="cl-intel-tab ${this.activeTab === 'pricing' ? 'is-active' : ''}" data-intel-tab="pricing">🏷️ Preços e Tickets</button>
            <button type="button" class="cl-intel-tab ${this.activeTab === 'competition' ? 'is-active' : ''}" data-intel-tab="competition">🏆 Concorrência</button>
            <button type="button" class="cl-intel-tab ${this.activeTab === 'entrants' ? 'is-active' : ''}" data-intel-tab="entrants">🚀 Novos Entrantes</button>
            <button type="button" class="cl-intel-tab ${this.activeTab === 'simulator' ? 'is-active' : ''}" data-intel-tab="simulator">🧮 Simulador</button>
          </nav>

          <div class="cl-intel-body">
            ${tabContentHtml}
          </div>

          <footer class="cl-intel-modal__footer">
            <span>Fonte dos dados: processamento local de anúncios visíveis na pesquisa do Mercado Livre. Sem chamadas externas.</span>
            <span>CalcuLivre v1.14.0 • Projeto Gratuito por <a href="https://www.linkedin.com/in/fabio-castro-943649286/?isSelfProfile=true" target="_blank" style="color: #3483fa; text-decoration: none; font-weight: 700;">Fabio Castro</a></span>
          </footer>
        </div>
      `;

      this.bindEvents();
    }

    renderActiveTab(items, allItems) {
      if (this.activeTab === "demand") return this.renderDemandTab(items);
      if (this.activeTab === "pricing") return this.renderPricingTab(items);
      if (this.activeTab === "competition") return this.renderCompetitionTab(items);
      if (this.activeTab === "entrants") return this.renderEntrantsTab(items, allItems);
      if (this.activeTab === "simulator") return this.renderSimulatorTab(items);
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

        <div class="cl-intel-card" style="padding: 0; overflow: hidden;">
          <div style="padding: 14px 16px; border-bottom: 1px solid #e2e8f0;">
            <div class="cl-intel-section-title" style="margin: 0;">Top 5 Anúncios com Maior Faturamento da Pesquisa</div>
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
        ? entrants.topEntrants.map((ad) => `
          <div class="cl-intel-card" style="display: flex; flex-direction: column; justify-content: space-between; gap: 10px;">
            <div>
              <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px;">
                <span class="cl-intel-badge-pro" style="background: ${ad.isUnconfirmed ? '#fee2e2; color:#991b1b;' : (ad.multiplier >= 2 ? '#bbf7d0; color:#166534;' : '#e0e7ff; color:#3730a3;')};">
                  ${ad.isUnconfirmed ? '⚠️ ' + ad.status : '🔥 ' + ad.multiplier.toFixed(1) + 'x da mediana do ticket'}
                </span>
                <span style="font-size: 11px; color: #64748b;">${ad.daysActive} dias (${ad.isEstimatedDate ? 'Data aproximada' : 'Data confirmada'})</span>
              </div>
              <h4 style="margin: 0; font-size: 13px; font-weight: 700; line-height: 1.35;">
                <a href="${escapeHtml(ad.permalink)}" target="_blank" style="color: #1e293b; text-decoration: none;">${escapeHtml(ad.title)}</a>
              </h4>
            </div>

            <div style="display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; border-top: 1px solid #f1f5f9; padding-top: 8px; margin-top: 4px;">
              <div>
                <span style="font-size: 10.5px; color: #64748b; display: block;">Preço</span>
                <strong style="font-size: 14px; color: #0f172a;">${money.format(ad.price)}</strong>
              </div>
              <div>
                <span style="font-size: 10.5px; color: #64748b; display: block;">Giro estimado</span>
                <strong style="font-size: 14px; color: #059669;">${number.format(ad.salesPerDay)} un./dia</strong>
              </div>
              <div>
                <span style="font-size: 10.5px; color: #64748b; display: block;">Faturamento projetado</span>
                <strong style="font-size: 14px; color: #1e293b;">${money.format(ad.monthlyRevenue)}</strong>
              </div>
            </div>
          </div>
        `).join("")
        : `<div class="cl-intel-card" style="grid-column: 1 / -1; text-align: center; color: #64748b; padding: 24px;">
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
          <span>Novos Entrantes com Sinais de Alto Giro (Top Anúncios Recentes)</span>
        </div>

        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 14px;">
          ${cardsHtml}
        </div>
      `;
    }

    // 5. Simulador
    renderSimulatorTab(items) {
      const sim = MarketIntelligenceEngine.calculateSimulator(this.simForm, MeliPricingEngine2026);

      const p25 = MarketIntelligenceEngine.percentile(items.map((it) => it.advanced?.salesPerDay).filter(Boolean), 0.25) || 2;
      const p50 = MarketIntelligenceEngine.percentile(items.map((it) => it.advanced?.salesPerDay).filter(Boolean), 0.50) || 4;
      const p75 = MarketIntelligenceEngine.percentile(items.map((it) => it.advanced?.salesPerDay).filter(Boolean), 0.75) || 8;

      const scenConservador = MarketIntelligenceEngine.calculateSimulator({ ...this.simForm, dailySales: p25 }, MeliPricingEngine2026);
      const scenReferencia = MarketIntelligenceEngine.calculateSimulator({ ...this.simForm, dailySales: p50 }, MeliPricingEngine2026);
      const scenExpansivo = MarketIntelligenceEngine.calculateSimulator({ ...this.simForm, dailySales: p75 }, MeliPricingEngine2026);

      const hasCost = sim.productCost != null;

      return `
        <div class="cl-intel-sim-grid">
          <!-- Coluna 1: Formulário de Configuração Operacional -->
          <div class="cl-intel-card">
            <div class="cl-intel-section-title">
              <span>Parâmetros da Sua Operação</span>
              <span style="font-size: 11px; color: #64748b;">Ajuste em tempo real</span>
            </div>

            <form class="cl-intel-form-grid" data-sim-form>
              <div class="cl-intel-field">
                <label>Preço Pretendido de Venda (R$)</label>
                <input type="number" step="0.01" min="0.01" data-sim="price" value="${escapeHtml(this.simForm.price)}" required placeholder="Ex: 99.90">
              </div>

              <div class="cl-intel-field">
                <label>Seu Custo do Produto (R$)</label>
                <input type="number" step="0.01" min="0" data-sim="productCost" value="${escapeHtml(this.simForm.productCost)}" placeholder="Deixe em branco p/ calcular custo máx.">
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
          <div class="cl-intel-sim-results">
            <div class="cl-intel-sim-callout">
              <div style="display: flex; align-items: baseline; justify-content: space-between;">
                <strong>Você Recebe do Mercado Livre</strong>
                <span style="font-size: 11px; color: #166534;">(Após comissão de ${money.format(sim.commission)} e frete de ${money.format(sim.shippingFee)})</span>
              </div>
              <div class="cl-val">${money.format(sim.repasse)} <small style="font-size: 13px; font-weight: 600; color: #15803d;">/ venda</small></div>
            </div>

            <div class="cl-intel-kpis" style="grid-template-columns: 1fr 1fr;">
              <div class="cl-intel-kpi">
                <div class="cl-intel-kpi__label">Sobra Operacional Líquida</div>
                <div class="cl-intel-kpi__value" style="color: ${hasCost && sim.unitProfit >= 0 ? '#059669' : (hasCost ? '#dc2626' : '#64748b')};">
                  ${hasCost ? money.format(sim.unitProfit) : 'Informe seu custo'}
                </div>
                <div class="cl-intel-kpi__sub">${hasCost ? `Margem de <strong>${sim.marginPercent.toFixed(1)}%</strong>` : 'Livre de impostos e despesas'}</div>
              </div>

              <div class="cl-intel-kpi">
                <div class="cl-intel-kpi__label">Lucro Mensal Simulado</div>
                <div class="cl-intel-kpi__value" style="color: ${hasCost && sim.monthlyProfit >= 0 ? '#059669' : (hasCost ? '#dc2626' : '#64748b')};">
                  ${hasCost ? money.format(sim.monthlyProfit) : '—'}
                </div>
                <div class="cl-intel-kpi__sub">${hasCost ? `Faturamento de ${money.format(sim.monthlyRevenue)}` : 'Preencha seu custo para projetar'}</div>
              </div>
            </div>

            <div class="cl-intel-card">
              <div class="cl-intel-section-title">
                <span>Inteligência de Viabilidade & Decisão</span>
              </div>

              <div style="display: flex; flex-direction: column; gap: 8px; font-size: 12.5px;">
                <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9;">
                  <span>💡 <strong>Quanto posso pagar no produto?</strong></span>
                  <strong style="color: ${sim.maxAcquisitionCost >= 0 ? '#059669' : '#dc2626'};">
                    ${sim.maxAcquisitionCost >= 0 ? 'Até ' + money.format(sim.maxAcquisitionCost) : 'Margem inatingível neste preço'}
                  </strong>
                </div>

                <div style="display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid #f1f5f9;">
                  <span>🎯 <strong>Preço mínimo de venda viável:</strong></span>
                  <strong style="color: #1e293b;">
                    ${sim.minViablePrice ? money.format(sim.minViablePrice) : (hasCost ? 'Acima do teto de simulação' : 'Informe seu custo')}
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
                  <small>${hasCost ? money.format(scenConservador.monthlyProfit) + '/mês' : money.format(scenConservador.monthlyRevenue)}</small>
                </div>

                <div class="cl-intel-scenario-card is-ref">
                  <span>Referência (P50)</span>
                  <strong>${number.format(p50)} un./dia</strong>
                  <small>${hasCost ? money.format(scenReferencia.monthlyProfit) + '/mês' : money.format(scenReferencia.monthlyRevenue)}</small>
                </div>

                <div class="cl-intel-scenario-card">
                  <span>Expansivo (P75)</span>
                  <strong>${number.format(p75)} un./dia</strong>
                  <small>${hasCost ? money.format(scenExpansivo.monthlyProfit) + '/mês' : money.format(scenExpansivo.monthlyRevenue)}</small>
                </div>
              </div>
            </div>
          </div>
        </div>
      `;
    }

    bindEvents() {
      // Close button
      this.root.querySelector("[data-intel-close]")?.addEventListener("click", () => this.close());

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

      // Pricing grouping & metric
      this.root.querySelector("[data-intel-pricing-group]")?.addEventListener("change", (e) => {
        this.priceGrouping = e.target.value;
        this.render();
      });
      this.root.querySelector("[data-intel-pricing-metric]")?.addEventListener("change", (e) => {
        this.priceMetric = e.target.value;
        this.render();
      });

      // Live simulator inputs
      this.root.querySelectorAll("[data-sim]").forEach((input) => {
        const key = input.dataset.sim;
        input.addEventListener("input", (e) => {
          this.simForm[key] = e.target.value;
          this.render();
          // Restore focus
          const refocused = this.root.querySelector(`[data-sim="${key}"]`);
          if (refocused) {
            refocused.focus();
            const len = refocused.value.length;
            refocused.setSelectionRange?.(len, len);
          }
        });
        input.addEventListener("change", (e) => {
          this.simForm[key] = e.target.value;
          this.render();
        });
      });
    }
  }

  class IQVPanelInjector {
    constructor(settings, cards) {
      this.settings = settings;
      this.cards = cards;
      this.root = null;
      this.debouncedUpdate = debounce(() => this.executeUpdate(), 160);
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

      const searchbar = document.querySelector("#calculadora-livre-searchbar");
      if (searchbar && searchbar.isConnected) {
        if (this.root.parentElement !== searchbar.parentElement || this.root.nextElementSibling !== searchbar) {
          searchbar.before(this.root);
        }
      } else {
        const offersSidebar = document.querySelector("[data-testid='filters'], .items-filters-section .sidebar");
        const filters = document.querySelector(".ui-search-filter-groups") ?? offersSidebar?.querySelector(".qcat-filters");
        const sidebar = document.querySelector(".ui-search-sidebar") ?? offersSidebar;
        const offersList = document.querySelector("[data-testid='items-list']");
        if (!filters && !sidebar && !offersList) return;

        if (filters && (this.root.parentElement !== filters.parentElement || this.root.nextElementSibling !== filters)) {
          filters.before(this.root);
        } else if (!filters && sidebar && sidebar.firstElementChild !== this.root) {
          sidebar.prepend(this.root);
        } else if (!filters && !sidebar && this.root.nextElementSibling !== offersList) {
          offersList.before(this.root);
        }
      }
      if (!existing) this.render();
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

      this.root.innerHTML = `
        <div class="cl-iqv-header">
          <div class="cl-iqv-header__text">
            <div class="cl-iqv-title-row">
              <h2 class="cl-iqv-title">IQV — Qualidade e Viabilidade</h2>
              <span class="cl-iqv-badge-tag">Índice Comercial</span>
            </div>
            <span class="cl-iqv-subtitle">Atratividade estimada desta pesquisa</span>
          </div>
        </div>

        ${mainIndicatorHtml}

        <div class="cl-iqv-tiers">
          ${tiersHtml}
        </div>

        <div class="cl-iqv-footer">
          <span class="cl-iqv-count-text">
            <strong>${analysis.totalEvaluated}</strong> de <strong>${analysis.totalAds}</strong> avaliados
          </span>
          <span class="cl-iqv-rel-badge cl-iqv-rel--${analysis.reliability}">
            Confiabilidade ${analysis.reliabilityLabel}
          </span>
        </div>

        <button type="button" class="cl-iqv-details-btn" data-iqv-open-modal>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>
          <span>Ver detalhes da inteligência (Painel Pro)</span>
        </button>
      `;

      this.bind();
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

      const iqv = document.querySelector("#calculadora-livre-iqv");
      if (iqv && iqv.isConnected) {
        if (this.root.previousElementSibling !== iqv) iqv.after(this.root);
      } else if (filters && (this.root.parentElement !== filters.parentElement || this.root.nextElementSibling !== filters)) {
        filters.before(this.root);
      } else if (!filters && sidebar && sidebar.firstElementChild !== this.root) {
        sidebar.prepend(this.root);
      } else if (!filters && !sidebar && this.root.nextElementSibling !== offersList) {
        offersList.before(this.root);
      }
      if (!existing) this.render();
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
      this.root.querySelector("[data-count]").textContent = `${count} anúncios`;
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
      await new Promise((resolve) => {
        const start = () => setTimeout(resolve, 1200);
        if (document.readyState === "complete") start();
        else window.addEventListener("load", start, { once: true });
      });
      document.querySelectorAll("#calculadora-livre-searchbar, #calculadora-livre-iqv, #calculadora-livre-intel-modal, .cl-poly").forEach((node) => node.remove());
      document.querySelectorAll("[data-calculadora-livre-ready]").forEach((node) => node.removeAttribute("data-calculadora-livre-ready"));
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
