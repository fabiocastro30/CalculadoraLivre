"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  taxPercent: 6,
  packagingCost: 1.5,
  classicCommission: 12,
  premiumCommission: 17,
  defaultWeight: 1000,
  considerSubsidy: true,
  // Shopee
  shopeeAutoTier: true,
  shopeeCommissionPercent: 20,
  shopeeFixedFee: 4.5,
  shopeeTaxPercent: 6.0,
  shopeePackagingCost: 1.5,
  shopeeAdsPercent: 0.0
});

const form = document.querySelector("#settings-form");
const statusElement = document.querySelector("#status");
const submitBtn = document.querySelector("#submit-btn");
const tabBtns = document.querySelectorAll(".tab-btn");
const tabPanes = document.querySelectorAll(".tab-pane");
let statusTimer;

tabBtns.forEach((btn) => {
  btn.addEventListener("click", () => {
    tabBtns.forEach((b) => b.classList.remove("active"));
    tabPanes.forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    const target = document.getElementById(btn.dataset.tab);
    if (target) target.classList.add("active");
    if (btn.dataset.tab === "tab-shopee") {
      submitBtn.classList.add("shopee-active");
    } else {
      submitBtn.classList.remove("shopee-active");
    }
  });
});

function showStatus(message, isError = false) {
  clearTimeout(statusTimer);
  statusElement.textContent = message;
  statusElement.style.color = isError ? "#f23d4f" : "#00a650";
  statusTimer = setTimeout(() => { statusElement.textContent = ""; }, 2500);
}

function setFormValues(settings) {
  for (const [key, defaultValue] of Object.entries(DEFAULT_SETTINGS)) {
    const input = form.elements.namedItem(key);
    if (!input) continue;
    const value = settings[key] ?? defaultValue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
  }
}

async function loadSettings() {
  try {
    const saved = await chrome.storage.sync.get(DEFAULT_SETTINGS);
    setFormValues(saved);
  } catch (error) {
    console.error("Calculadora Livre: falha ao carregar configurações", error);
    setFormValues(DEFAULT_SETTINGS);
    showStatus("Não foi possível carregar as configurações.", true);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!form.reportValidity()) return;

  const settings = {
    taxPercent: Number(form.taxPercent?.value ?? 6),
    packagingCost: Number(form.packagingCost?.value ?? 1.5),
    classicCommission: Number(form.classicCommission?.value ?? 12),
    premiumCommission: Number(form.premiumCommission?.value ?? 17),
    considerSubsidy: Boolean(form.considerSubsidy?.checked),
    // Shopee
    shopeeAutoTier: Boolean(form.shopeeAutoTier?.checked),
    shopeeCommissionPercent: Number(form.shopeeCommissionPercent?.value || 20),
    shopeeFixedFee: Number(form.shopeeFixedFee?.value || 4.5),
    shopeeTaxPercent: Number(form.shopeeTaxPercent?.value ?? 6.0),
    shopeePackagingCost: Number(form.shopeePackagingCost?.value ?? 1.5),
    shopeeAdsPercent: Number(form.shopeeAdsPercent?.value ?? 0.0)
  };

  try {
    await chrome.storage.sync.set(settings);
    showStatus("Configurações salvas com sucesso.");
  } catch (error) {
    console.error("Calculadora Livre: falha ao salvar configurações", error);
    showStatus("Não foi possível salvar.", true);
  }
});

loadSettings();
