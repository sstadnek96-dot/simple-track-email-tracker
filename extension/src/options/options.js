const DEFAULT_SETTINGS = {
  trackingEnabled: true,
  notificationsEnabled: true,
  autoTrackNewMessages: true,
  showUnreadDots: true,
  showOpenedChecks: true,
  compactRows: false,
  backendBaseUrl: "https://us-central1-simple-track-prod.cloudfunctions.net/api",
  trackClicks: true,
  retentionDays: 30,
  privacyMode: false
};

const form = document.querySelector("#settingsForm");
const saveState = document.querySelector("#saveState");

document.addEventListener("DOMContentLoaded", init);

async function init() {
  const response = await sendMessage({ type: "simpleTrack:getState" });
  const settings = { ...DEFAULT_SETTINGS, ...(response?.settings || {}) };
  fillForm(settings);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const nextSettings = readForm();
    const saved = await sendMessage({
      type: "simpleTrack:updateSettings",
      settings: nextSettings
    });

    if (saved?.ok) {
      saveState.textContent = saved.syncError ? `Saved, sync failed: ${saved.syncError}` : "Saved";
      setTimeout(() => {
        saveState.textContent = "";
      }, saved.syncError ? 5000 : 1800);
    }
  });
}

async function sendMessage(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return { ok: true, settings: DEFAULT_SETTINGS };
  }

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn("Simple Track settings fallback", error);
    return { ok: true, settings: DEFAULT_SETTINGS };
  }
}

function fillForm(settings) {
  for (const [key, value] of Object.entries(settings)) {
    const field = form.elements[key];
    if (!field) continue;

    if (field.type === "checkbox") {
      field.checked = Boolean(value);
    } else {
      field.value = value;
    }
  }
}

function readForm() {
  return {
    trackingEnabled: form.elements.trackingEnabled.checked,
    notificationsEnabled: form.elements.notificationsEnabled.checked,
    autoTrackNewMessages: form.elements.autoTrackNewMessages.checked,
    showUnreadDots: form.elements.showUnreadDots.checked,
    showOpenedChecks: form.elements.showOpenedChecks.checked,
    compactRows: form.elements.compactRows.checked,
    backendBaseUrl: form.elements.backendBaseUrl.value.trim(),
    trackClicks: form.elements.trackClicks.checked,
    retentionDays: Number(form.elements.retentionDays.value || DEFAULT_SETTINGS.retentionDays),
    privacyMode: form.elements.privacyMode.checked
  };
}
