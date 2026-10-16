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

  class IQVPanelInjector {
    constructor(settings, cards) {
      this.settings = settings;
      this.cards = cards;
      this.root = null;
      this.detailsOpen = false;
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
    }

    render() {
      if (!this.root) return;
      const items = this.cards.values();
      const analysis = IQVAnalysisEngine.analyze(items, (data) => this.cards.calculation(data));

      const signature = `${analysis.state}|${analysis.generalScore?.toFixed(1)}|${analysis.totalEvaluated}|${analysis.totalAds}|${this.detailsOpen}`;
      if (this.lastSignature === signature && this.root.children.length > 0) return;
      this.lastSignature = signature;

      const hasGeneral = analysis.generalScore != null && Number.isFinite(analysis.generalScore);
      const scoreNum = hasGeneral ? analysis.generalScore : 0;
      const scoreFormatted = hasGeneral ? number.format(scoreNum) : "—";
      const tierColor = analysis.generalClassification.color;
      const tierLabel = analysis.generalClassification.label;

      const circumference = 226.19; // 2 * PI * 36
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

      const tableRowsHtml = ["baixo", "medio", "alto"].map((tierId) => {
        const t = analysis.tiers[tierId];
        if (!t.hasData) {
          return `<tr>
            <td><strong>${escapeHtml(t.label)}</strong></td>
            <td>0 / ${t.totalCount}</td>
            <td colspan="4" style="color: var(--cl-muted); font-style: italic;">Dados insuficientes no momento</td>
          </tr>`;
        }
        return `<tr>
          <td><strong>${escapeHtml(t.label)}</strong></td>
          <td>${t.validCount} / ${t.totalCount}</td>
          <td>${number.format(t.medianGiro)}/d</td>
          <td>${money.format(t.medianRevenue)}</td>
          <td>${(t.medianReturnRatio * 100).toFixed(1)}%</td>
          <td>${money.format(t.medianPayout)}</td>
        </tr>`;
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

        <button type="button" class="cl-iqv-details-btn" data-iqv-toggle>
          <span>${this.detailsOpen ? "Ocultar detalhes" : "Ver detalhes"}</span>
          <svg class="cl-iqv-chevron ${this.detailsOpen ? 'is-open' : ''}" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M6 9l6 6 6-6"/></svg>
        </button>

        <div class="cl-iqv-details-pane ${this.detailsOpen ? 'is-open' : ''}">
          <div class="cl-iqv-pilares">
            <div class="cl-iqv-pilar-box">
              <span>Giro Comercial</span>
              <strong>40%</strong>
            </div>
            <div class="cl-iqv-pilar-box">
              <span>Receita Bruta</span>
              <strong>35%</strong>
            </div>
            <div class="cl-iqv-pilar-box">
              <span>Retorno Líquido</span>
              <strong>25%</strong>
            </div>
          </div>

          <div class="cl-iqv-table-wrap">
            <table class="cl-iqv-table">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Amostra</th>
                  <th>Giro</th>
                  <th>Receita</th>
                  <th>Retorno</th>
                  <th>Repasse</th>
                </tr>
              </thead>
              <tbody>
                ${tableRowsHtml}
              </tbody>
            </table>
          </div>

          <div class="cl-iqv-disclaimer">
            Baseado na mediana dos anúncios da pesquisa. Não deduz impostos individuais, custo do produto ou publicidade real do vendedor.
          </div>
        </div>
      `;

      this.bind();
    }

    bind() {
      const btn = this.root.querySelector("[data-iqv-toggle]");
      btn?.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        this.detailsOpen = !this.detailsOpen;
        const pane = this.root.querySelector(".cl-iqv-details-pane");
        const chevron = this.root.querySelector(".cl-iqv-chevron");
        const label = btn.querySelector("span");
        if (pane) pane.classList.toggle("is-open", this.detailsOpen);
        if (chevron) chevron.classList.toggle("is-open", this.detailsOpen);
        if (label) label.textContent = this.detailsOpen ? "Ocultar detalhes" : "Ver detalhes";
        this.lastSignature = "";
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
      document.querySelectorAll("#calculadora-livre-searchbar, #calculadora-livre-iqv, .cl-poly").forEach((node) => node.remove());
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
