"use strict";

const DEFAULT_SETTINGS = Object.freeze({
  taxPercent: 6,
  packagingCost: 1.5,
  classicCommission: 12,
  premiumCommission: 17,
  defaultWeight: 1000,
  considerSubsidy: true
});

const form = document.querySelector("#settings-form");
const statusElement = document.querySelector("#status");
let statusTimer;

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
    taxPercent: Number(form.taxPercent.value),
    packagingCost: Number(form.packagingCost.value),
    classicCommission: Number(form.classicCommission.value),
    premiumCommission: Number(form.premiumCommission.value),
    considerSubsidy: form.considerSubsidy.checked
  };

  try {
    await chrome.storage.sync.set(settings);
    showStatus("Configurações salvas.");
  } catch (error) {
    console.error("Calculadora Livre: falha ao salvar configurações", error);
    showStatus("Não foi possível salvar.", true);
  }
});

loadSettings();
