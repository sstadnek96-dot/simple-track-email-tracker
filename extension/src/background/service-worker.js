const STORAGE_KEYS = {
  messages: "simpleTrack.messages",
  settings: "simpleTrack.settings",
  installId: "simpleTrack.installId",
  pairing: "simpleTrack.pairing",
  deletedMessageIds: "simpleTrack.deletedMessageIds"
};

const PRODUCTION_API_URL = "https://us-central1-simple-track-prod.cloudfunctions.net/api";
const ROW_MATCH_DELAY_MS = 3500;
const BACKEND_REFRESH_ALARM_MINUTES = 15;
const SIMULATE_ACTIVITY_ALARM_MINUTES = 2;

const DEFAULT_SETTINGS = {
  trackingEnabled: true,
  notificationsEnabled: true,
  autoTrackNewMessages: true,
  showUnreadDots: true,
  showOpenedChecks: true,
  compactRows: false,
  backendBaseUrl: PRODUCTION_API_URL,
  trackClicks: true,
  retentionDays: 30,
  privacyMode: false
};

const SAMPLE_MESSAGES = [
  {
    id: "demo-lawncare-2026-05-18",
    subject: "Question About Lawncare From Your Webpage",
    recipients: ["gardening@usask.ca", "gardenline@usask.ca"],
    client: "Gmail",
    status: "opened",
    opens: 3,
    clicks: 0,
    lastActivityAt: "2026-05-18T18:44:14.000Z",
    sentAt: "2026-05-18T17:09:25.000Z",
    device: "Chrome on Windows",
    location: "Saskatoon, SK",
    muted: false
  },
  {
    id: "demo-banking-2026-05-16",
    subject: "Re: Stadnyk-128285- Banking info received",
    recipients: ["Sarah-Lee Suranyi <SSuranyi@sk.bluecross.ca>"],
    client: "Outlook",
    status: "opened",
    opens: 4,
    clicks: 1,
    lastActivityAt: "2026-05-16T16:02:13.000Z",
    sentAt: "2026-05-16T15:10:42.000Z",
    device: "Edge on Windows",
    location: "Regina, SK",
    muted: false
  },
  {
    id: "demo-test-2026-05-19",
    subject: "test",
    recipients: ["me"],
    client: "Gmail",
    status: "sent",
    opens: 0,
    clicks: 0,
    lastActivityAt: null,
    sentAt: "2026-05-19T18:04:00.000Z",
    device: null,
    location: null,
    muted: false
  }
];

chrome.runtime.onInstalled.addListener(() => {
  ensureSeedData();
  configureAlarms();
});

chrome.runtime.onStartup.addListener(() => {
  ensureSeedData();
  configureAlarms();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "simpleTrack.refreshBackend") {
    refreshBackendMessagesForNotifications();
  }

  if (alarm.name === "simpleTrack.simulateActivity") {
    simulateTrackingActivity();
  }
});

function configureAlarms() {
  chrome.alarms.clear("simpleTrack.refreshBackend", () => {
    chrome.alarms.create("simpleTrack.refreshBackend", { periodInMinutes: BACKEND_REFRESH_ALARM_MINUTES });
  });
  chrome.alarms.clear("simpleTrack.simulateActivity", () => {
    chrome.alarms.create("simpleTrack.simulateActivity", { periodInMinutes: SIMULATE_ACTIVITY_ALARM_MINUTES });
  });
}

async function refreshBackendMessagesForNotifications() {
  const settings = await getSettings();
  if (!settings.notificationsEnabled || !settings.backendBaseUrl) return;

  refreshBackendMessages(settings).catch((error) => {
    console.warn("Simple Track backend refresh failed", error);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("Simple Track message error", error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Invalid message" };
  }

  if (message.type === "simpleTrack:getState") {
    const settings = await getSettings();
    const installId = await getInstallId();
    const pairing = await getPairing();
    let syncError = null;
    let messages = [];

    try {
      messages = await getMessages({ settings, syncBackend: true });
    } catch (error) {
      syncError = error.message;
      messages = await getMessages({ settings, syncBackend: false });
    }

    return {
      ok: true,
      installId,
      realtimeUrl: getRealtimeUrl(settings, installId),
      pairing,
      messages,
      settings,
      summary: summarize(messages),
      syncError
    };
  }

  if (message.type === "simpleTrack:updateSettings") {
    const settings = { ...(await getSettings()), ...message.settings };
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    try {
      await refreshBackendMessages(settings);
      return { ok: true, settings, syncError: null };
    } catch (error) {
      return { ok: true, settings, syncError: error.message };
    }
  }

  if (message.type === "simpleTrack:pairInstall") {
    return pairInstallWithCode(message);
  }

  if (message.type === "simpleTrack:createTrackedMessage") {
    return createTrackedMessage(message);
  }

  if (message.type === "simpleTrack:activateTrackedMessage") {
    return activateTrackedMessage(message);
  }

  if (message.type === "simpleTrack:setMuted") {
    const messages = await getMessages();
    const updatedMessages = messages.map((trackedMessage) => {
      if (trackedMessage.id !== message.id) return trackedMessage;
      return { ...trackedMessage, muted: Boolean(message.muted) };
    });

    await chrome.storage.local.set({ [STORAGE_KEYS.messages]: updatedMessages });
    return { ok: true, messages: updatedMessages };
  }

  if (message.type === "simpleTrack:deleteMessage") {
    const deletedIds = await getDeletedMessageIds();
    deletedIds.add(String(message.id));
    const messages = (await getMessages()).filter((trackedMessage) => trackedMessage.id !== message.id);

    await chrome.storage.local.set({
      [STORAGE_KEYS.deletedMessageIds]: [...deletedIds],
      [STORAGE_KEYS.messages]: messages
    });

    return { ok: true, messages };
  }

  return { ok: false, error: `Unknown message type: ${message.type}` };
}

async function createTrackedMessage(message) {
  const settings = await getSettings();
  const messages = await getMessages({ settings });
  const draftMessage = {
    subject: message.subject || "Untitled message",
    recipients: message.recipients || [],
    client: message.client || "Webmail",
    status: "sent",
    opens: 0,
    clicks: 0,
    lastActivityAt: null,
    sentAt: new Date().toISOString(),
    device: null,
    location: null,
    muted: false
  };

  if (settings.backendBaseUrl) {
    const installId = await getInstallId();
    const backendResponse = await createBackendMessage(settings, installId, draftMessage);
    backendResponse.tracking = normalizeTrackingResponse(settings, backendResponse);
    const nextMessage = normalizeMessage({
      ...backendResponse.message,
      rowMatchAfter: new Date(Date.now() + ROW_MATCH_DELAY_MS).toISOString()
    });
    const mergedMessages = upsertMessages(messages, [nextMessage]);
    await chrome.storage.local.set({ [STORAGE_KEYS.messages]: mergedMessages });
    return { ok: true, message: nextMessage, tracking: backendResponse.tracking };
  }

  const nextMessage = normalizeMessage({
    id: crypto.randomUUID(),
    ...draftMessage
  });

  await chrome.storage.local.set({
    [STORAGE_KEYS.messages]: [nextMessage, ...messages]
  });

  return { ok: true, message: nextMessage, tracking: null };
}

async function activateTrackedMessage(message) {
  if (!message.activationUrl) {
    return { ok: false, error: "Missing activation URL" };
  }

  const response = await fetch(message.activationUrl, {
    method: "POST",
    headers: getBackendHeaders(await getSettings())
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `Tracking activation failed (${response.status})`);
  }

  if (body.message) {
    const messages = await getMessages();
    const mergedMessages = upsertMessages(messages, [normalizeMessage(body.message)]);
    await chrome.storage.local.set({ [STORAGE_KEYS.messages]: mergedMessages });
    return { ok: true, message: normalizeMessage(body.message) };
  }

  return { ok: true };
}

async function ensureSeedData() {
  const existing = await chrome.storage.local.get([
    STORAGE_KEYS.messages,
    STORAGE_KEYS.settings,
    STORAGE_KEYS.installId
  ]);

  const updates = {};

  if (!Array.isArray(existing[STORAGE_KEYS.messages])) {
    updates[STORAGE_KEYS.messages] = SAMPLE_MESSAGES.map(normalizeMessage);
  }

  if (!existing[STORAGE_KEYS.settings]) {
    updates[STORAGE_KEYS.settings] = DEFAULT_SETTINGS;
  }

  if (!existing[STORAGE_KEYS.installId]) {
    updates[STORAGE_KEYS.installId] = crypto.randomUUID();
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

async function getMessages(options = {}) {
  await ensureSeedData();
  const result = await chrome.storage.local.get(STORAGE_KEYS.messages);
  let messages = (result[STORAGE_KEYS.messages] || []).map(normalizeMessage);

  if (options.syncBackend && options.settings?.backendBaseUrl) {
    messages = await refreshBackendMessages(options.settings, messages);
  }

  const deletedIds = await getDeletedMessageIds();
  return messages.filter((message) => !deletedIds.has(message.id));
}

async function getDeletedMessageIds() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.deletedMessageIds);
  return new Set(Array.isArray(result[STORAGE_KEYS.deletedMessageIds]) ? result[STORAGE_KEYS.deletedMessageIds] : []);
}

async function getSettings() {
  await ensureSeedData();
  const result = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const settings = { ...DEFAULT_SETTINGS, ...(result[STORAGE_KEYS.settings] || {}) };
  if (!settings.backendBaseUrl) {
    settings.backendBaseUrl = PRODUCTION_API_URL;
  }
  return settings;
}

async function getInstallId() {
  await ensureSeedData();
  const result = await chrome.storage.local.get(STORAGE_KEYS.installId);
  return result[STORAGE_KEYS.installId];
}

async function getPairing() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.pairing);
  return result[STORAGE_KEYS.pairing] || null;
}

async function pairInstallWithCode(message) {
  const settings = await getSettings();
  const installId = await getInstallId();
  const code = String(message.code || "").trim().toUpperCase();

  if (!code) {
    return { ok: false, error: "Enter a pairing code from the web app." };
  }

  if (!settings.backendBaseUrl) {
    return { ok: false, error: "Tracking service is not configured." };
  }

  const response = await fetch(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/app/pair-install`, {
    method: "POST",
    headers: getBackendHeaders(settings),
    body: JSON.stringify({ code, installId })
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `Extension pairing failed (${response.status})`);
  }

  const pairing = {
    installId,
    orgId: body.orgId,
    linkedMessages: Number(body.linkedMessages || 0),
    pairedAt: new Date().toISOString()
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.pairing]: pairing });
  return { ok: true, ...body, pairing };
}

async function refreshBackendMessages(settings = null, currentMessages = null) {
  const activeSettings = settings || (await getSettings());
  if (!activeSettings.backendBaseUrl) return currentMessages || (await getMessages());

  const installId = await getInstallId();
  const localMessages = currentMessages || (await getMessages());
  const deletedIds = await getDeletedMessageIds();
  const backendMessages = await fetchBackendMessages(activeSettings, installId);
  const mergedMessages = upsertMessages(localMessages, backendMessages.map(normalizeMessage))
    .filter((message) => !deletedIds.has(message.id));

  await chrome.storage.local.set({ [STORAGE_KEYS.messages]: mergedMessages });
  notifyForNewOpens(localMessages, mergedMessages, activeSettings);

  return mergedMessages;
}

async function createBackendMessage(settings, installId, draftMessage) {
  const response = await fetch(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/messages`, {
    method: "POST",
    headers: getBackendHeaders(settings),
    body: JSON.stringify({
      installId,
      subject: draftMessage.subject,
      recipients: draftMessage.recipients,
      client: draftMessage.client
    })
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `Backend message create failed (${response.status})`);
  }

  return body;
}

function normalizeTrackingResponse(settings, backendResponse) {
  const tracking = { ...(backendResponse.tracking || {}) };

  if (!tracking.activationUrl && tracking.pixelUrl && backendResponse.message?.id) {
    const pixelUrl = new URL(tracking.pixelUrl);
    const token = pixelUrl.searchParams.get("t");
    const activationUrl = new URL(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/messages/activate`);
    activationUrl.searchParams.set("m", backendResponse.message.id);
    activationUrl.searchParams.set("t", token || "");
    tracking.activationUrl = activationUrl.toString();
  }

  return tracking;
}

async function fetchBackendMessages(settings, installId) {
  const url = new URL(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/messages`);
  url.searchParams.set("installId", installId);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getBackendHeaders(settings)
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `Backend message sync failed (${response.status})`);
  }

  return body.messages || [];
}

function getBackendHeaders(settings) {
  return {
    "Content-Type": "application/json",
    "X-Simple-Track-Client": "chrome-extension"
  };
}

async function simulateTrackingActivity() {
  const settings = await getSettings();
  if (!settings.trackingEnabled || settings.backendBaseUrl) return;

  const messages = await getMessages();
  const nextIndex = messages.findIndex((message) => message.status === "sent");
  if (nextIndex === -1) return;

  const updated = [...messages];
  updated[nextIndex] = {
    ...updated[nextIndex],
    status: "opened",
    opens: updated[nextIndex].opens + 1,
    lastActivityAt: new Date().toISOString(),
    device: "Chrome on Windows",
    location: "Regina, SK"
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.messages]: updated });

  if (settings.notificationsEnabled && !updated[nextIndex].muted) {
    createNotification(updated[nextIndex]);
  }
}

function notifyForNewOpens(previousMessages, nextMessages, settings) {
  if (!settings.notificationsEnabled) return;

  const previousById = new Map(previousMessages.map((message) => [message.id, message]));
  for (const nextMessage of nextMessages) {
    const previousMessage = previousById.get(nextMessage.id);
    if (!previousMessage) continue;
    if (previousMessage.opens === 0 && nextMessage.opens > 0 && !nextMessage.muted) {
      createNotification(nextMessage);
    }
  }
}

function createNotification(message) {
  chrome.notifications.create(`simple-track-open-${message.id}-${message.opens}`, {
    type: "basic",
    iconUrl: "assets/icons/icon-128.png",
    title: "Email opened",
    message: message.subject
  });
}

function upsertMessages(existingMessages, incomingMessages) {
  const existingById = new Map(existingMessages.map((message) => [message.id, message]));

  for (const incomingMessage of incomingMessages) {
    const existing = existingById.get(incomingMessage.id);
    existingById.set(incomingMessage.id, {
      ...existing,
      ...incomingMessage,
      muted: existing?.muted ?? incomingMessage.muted
    });
  }

  return [...existingById.values()].sort((a, b) => {
    const aTime = new Date(a.lastActivityAt || a.sentAt).getTime();
    const bTime = new Date(b.lastActivityAt || b.sentAt).getTime();
    return bTime - aTime;
  });
}

function normalizeBackendBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function normalizeMessage(message) {
  return {
    id: String(message.id),
    subject: String(message.subject || "Untitled message"),
    recipients: Array.isArray(message.recipients) ? message.recipients : [],
    client: String(message.client || "Webmail"),
    status: ["sent", "opened", "clicked"].includes(message.status) ? message.status : "sent",
    opens: Number(message.opens || 0),
    clicks: Number(message.clicks || 0),
    attachmentOpens: Number(message.attachmentOpens || 0),
    lastActivityAt: message.lastActivityAt || null,
    sentAt: message.sentAt || new Date().toISOString(),
    rowMatchAfter: message.rowMatchAfter || null,
    device: message.device || null,
    location: message.location || null,
    events: Array.isArray(message.events) ? message.events : [],
    muted: Boolean(message.muted)
  };
}

function summarize(messages) {
  const sent = messages.length;
  const opened = messages.filter((message) => message.opens > 0).length;
  const clicked = messages.filter((message) => message.clicks > 0).length;
  const attachmentOpened = messages.filter((message) => message.attachmentOpens > 0).length;
  const unopened = Math.max(0, sent - opened);

  return {
    sent,
    opened,
    clicked,
    attachmentOpened,
    unopened,
    openRate: sent > 0 ? Math.round((opened / sent) * 100) : 0
  };
}

function getRealtimeUrl(settings, installId) {
  if (!settings.backendBaseUrl || !installId) return null;

  const url = new URL(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/events`);
  url.searchParams.set("installId", installId);
  return url.toString();
}
