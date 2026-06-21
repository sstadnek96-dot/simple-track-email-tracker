const STORAGE_KEYS = {
  messages: "simpleTrack.messages",
  settings: "simpleTrack.settings",
  installId: "simpleTrack.installId",
  installSecret: "simpleTrack.installSecret",
  pairing: "simpleTrack.pairing",
  connectedAccounts: "simpleTrack.connectedAccounts",
  knownAccounts: "simpleTrack.knownAccounts",
  activeAccountEmail: "simpleTrack.activeAccountEmail",
  deletedMessageIds: "simpleTrack.deletedMessageIds"
};

const PRODUCTION_API_URL = "https://us-central1-simple-track-prod.cloudfunctions.net/api";
const WEB_APP_URL = "https://simple-track-prod-app.web.app";
const ROW_MATCH_DELAY_MS = 3500;
const BACKEND_REFRESH_ALARM_MINUTES = 15;
const CONNECTION_POLL_ATTEMPTS = 24;
const CONNECTION_POLL_INTERVAL_MS = 2500;
const EXTERNAL_MESSAGE_ORIGINS = new Set([
  "https://simple-track-prod-app.web.app",
  "https://simple-track-prod-app.firebaseapp.com"
]);

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
});

function configureAlarms() {
  chrome.alarms.clear("simpleTrack.refreshBackend", () => {
    chrome.alarms.create("simpleTrack.refreshBackend", { periodInMinutes: BACKEND_REFRESH_ALARM_MINUTES });
  });
  chrome.alarms.clear("simpleTrack.simulateActivity");
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
      console.warn("Simple Track message failed", error);
      sendResponse({ ok: false, error: error.message });
    });

  return true;
});

if (chrome.runtime.onMessageExternal) {
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    handleExternalMessage(message, sender)
      .then((response) => sendResponse(response))
      .catch((error) => {
        console.warn("Simple Track external message failed", error);
        sendResponse({ ok: false, error: error.message });
      });

    return true;
  });
}

async function handleMessage(message) {
  if (!message || typeof message.type !== "string") {
    return { ok: false, error: "Invalid message" };
  }

  if (message.type === "simpleTrack:getState") {
    const settings = await getSettings();
    const installId = await getInstallId();
    const installSecret = await getInstallSecret();
    const pairing = await getPairing();
    let connectedAccounts = await getConnectedAccounts();
    let knownAccounts = await getKnownAccounts();
    const requestedAccountEmail = normalizeEmail(message.accountEmail);
    const includeAllAccounts = Boolean(message.includeAllAccounts && !requestedAccountEmail);
    const activeAccountEmail = normalizeEmail(requestedAccountEmail || (await getActiveAccountEmail()));
    let accountStatus = getAccountStatus(activeAccountEmail, connectedAccounts, knownAccounts);
    let syncError = null;
    let messages = [];

    try {
      if (settings.backendBaseUrl && installId && installSecret && activeAccountEmail) {
        const status = await fetchInstallStatus(settings, installId, installSecret, activeAccountEmail);
        const saved = await saveInstallAccountState(status, activeAccountEmail);
        connectedAccounts = saved.connectedAccounts;
        knownAccounts = saved.knownAccounts;
        accountStatus = status.accountStatus || getAccountStatus(activeAccountEmail, connectedAccounts, knownAccounts);
      }
    } catch (error) {
      syncError = error.message;
    }

    try {
      messages = await getMessages({
        settings,
        syncBackend: true,
        accountEmail: includeAllAccounts ? "" : activeAccountEmail
      });
    } catch (error) {
      syncError = error.message;
      messages = await getMessages({
        settings,
        syncBackend: false,
        accountEmail: includeAllAccounts ? "" : activeAccountEmail
      });
    }

    return {
      ok: true,
      installId,
      realtimeUrl: getRealtimeUrl(settings, installId, installSecret, activeAccountEmail),
      pairing,
      connectedAccounts,
      knownAccounts,
      activeAccountEmail,
      accountStatus,
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

  if (message.type === "simpleTrack:startAccountConnection") {
    return startAccountConnection(message);
  }

  if (message.type === "simpleTrack:refreshAccountConnection") {
    return refreshAccountConnection(message);
  }

  if (message.type === "simpleTrack:connectSignedInAccount") {
    return connectSignedInAccount(message);
  }

  if (message.type === "simpleTrack:selectAccount") {
    return selectAccount(message);
  }

  if (message.type === "simpleTrack:createWebAppSession") {
    return createWebAppSession(message);
  }

  if (message.type === "simpleTrack:disconnectAccount") {
    return disconnectAccount(message);
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

async function handleExternalMessage(message, sender = {}) {
  if (!isAllowedExternalSender(sender)) {
    return { ok: false, error: "Simple Track web app origin is not allowed." };
  }

  if (message?.type === "simpleTrack:createWebAppSession") {
    return createWebAppSession(message);
  }

  if (message?.type === "simpleTrack:getConnectedAccounts") {
    const connectedAccounts = await getConnectedAccounts();
    const knownAccounts = await getKnownAccounts();
    return {
      ok: true,
      extensionId: chrome.runtime.id,
      connectedAccounts,
      knownAccounts,
      activeAccountEmail: await getActiveAccountEmail()
    };
  }

  if (message?.type === "simpleTrack:disconnectAccount") {
    return disconnectAccount(message);
  }

  if (message?.type === "simpleTrack:startAccountConnection") {
    return startAccountConnection(message);
  }

  if (message?.type === "simpleTrack:refreshAccountConnection") {
    return refreshAccountConnection(message);
  }

  if (message?.type === "simpleTrack:connectSignedInAccount") {
    return connectSignedInAccount(message);
  }

  return { ok: false, error: "Unsupported Simple Track web app request." };
}

function isAllowedExternalSender(sender = {}) {
  const origin = sender.origin || safeOrigin(sender.url);
  return EXTERNAL_MESSAGE_ORIGINS.has(origin);
}

function safeOrigin(url = "") {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

async function createTrackedMessage(message) {
  const settings = await getSettings();
  const accountEmail = normalizeEmail(message.accountEmail || (await getActiveAccountEmail()));
  const connectedAccounts = await getConnectedAccounts();
  const accountStatus = getAccountStatus(accountEmail, connectedAccounts);

  if (accountEmail && accountStatus.status !== "connected") {
    return {
      ok: false,
      code: "account_not_connected",
      accountEmail,
      accountStatus,
      error: `${accountEmail} is not connected to Simple Track yet.`
    };
  }

  const messages = await getMessages({ settings, accountEmail });
  const draftMessage = {
    subject: message.subject || "Untitled message",
    recipients: message.recipients || [],
    client: message.client || "Webmail",
    accountEmail,
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
    const installSecret = await getInstallSecret();
    const backendResponse = await createBackendMessage(settings, installId, installSecret, draftMessage);
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
    headers: getBackendHeaders(await getSettings(), await getInstallSecret())
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
    STORAGE_KEYS.installId,
    STORAGE_KEYS.installSecret,
    STORAGE_KEYS.connectedAccounts,
    STORAGE_KEYS.knownAccounts
  ]);

  const updates = {};

  if (!Array.isArray(existing[STORAGE_KEYS.messages])) {
    updates[STORAGE_KEYS.messages] = [];
  }

  if (!existing[STORAGE_KEYS.settings]) {
    updates[STORAGE_KEYS.settings] = DEFAULT_SETTINGS;
  }

  if (!existing[STORAGE_KEYS.installId]) {
    updates[STORAGE_KEYS.installId] = crypto.randomUUID();
  }

  if (!existing[STORAGE_KEYS.installSecret]) {
    updates[STORAGE_KEYS.installSecret] = randomInstallSecret();
  }

  if (!Array.isArray(existing[STORAGE_KEYS.connectedAccounts])) {
    updates[STORAGE_KEYS.connectedAccounts] = [];
  }

  if (!Array.isArray(existing[STORAGE_KEYS.knownAccounts])) {
    updates[STORAGE_KEYS.knownAccounts] = normalizeConnectedAccounts(existing[STORAGE_KEYS.connectedAccounts] || []);
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
    messages = await refreshBackendMessages(options.settings, messages, { accountEmail: options.accountEmail });
  }

  const deletedIds = await getDeletedMessageIds();
  return messages
    .filter((message) => !deletedIds.has(message.id))
    .filter((message) => !options.accountEmail || message.accountEmail === options.accountEmail);
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

async function getInstallSecret() {
  await ensureSeedData();
  const result = await chrome.storage.local.get(STORAGE_KEYS.installSecret);
  return result[STORAGE_KEYS.installSecret];
}

async function getPairing() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.pairing);
  return result[STORAGE_KEYS.pairing] || null;
}

async function getConnectedAccounts() {
  await ensureSeedData();
  const result = await chrome.storage.local.get(STORAGE_KEYS.connectedAccounts);
  return normalizeConnectedAccounts(result[STORAGE_KEYS.connectedAccounts]);
}

async function getKnownAccounts() {
  await ensureSeedData();
  const result = await chrome.storage.local.get([STORAGE_KEYS.knownAccounts, STORAGE_KEYS.messages]);
  const storedAccounts = normalizeConnectedAccounts(result[STORAGE_KEYS.knownAccounts]);
  const messageAccounts = Array.isArray(result[STORAGE_KEYS.messages])
    ? result[STORAGE_KEYS.messages]
        .map((message) => accountFromMessage(message))
        .filter(Boolean)
    : [];
  return mergeAccountLists(storedAccounts, messageAccounts);
}

async function getActiveAccountEmail() {
  const result = await chrome.storage.local.get(STORAGE_KEYS.activeAccountEmail);
  return normalizeEmail(result[STORAGE_KEYS.activeAccountEmail]);
}

async function setConnectedAccounts(accounts, activeAccountEmail = "") {
  const connectedAccounts = normalizeConnectedAccounts(accounts);
  const knownAccounts = mergeAccountLists(await getKnownAccounts(), connectedAccounts);
  const activeEmail = normalizeEmail(activeAccountEmail) || connectedAccounts[0]?.email || "";
  await chrome.storage.local.set({
    [STORAGE_KEYS.connectedAccounts]: connectedAccounts,
    [STORAGE_KEYS.knownAccounts]: knownAccounts,
    [STORAGE_KEYS.activeAccountEmail]: activeEmail
  });
  return { connectedAccounts, knownAccounts, activeAccountEmail: activeEmail };
}

async function rememberKnownAccounts(accounts) {
  const knownAccounts = mergeAccountLists(await getKnownAccounts(), accounts);
  await chrome.storage.local.set({ [STORAGE_KEYS.knownAccounts]: knownAccounts });
  return knownAccounts;
}

function getAccountStatus(accountEmail, connectedAccounts, knownAccounts = []) {
  const normalizedEmail = normalizeEmail(accountEmail);
  const accounts = normalizeConnectedAccounts(connectedAccounts);
  const known = normalizeConnectedAccounts(knownAccounts);
  if (!normalizedEmail) {
    return {
      status: accounts.length ? "unknown_account" : "not_connected",
      accountEmail: "",
      connectedAccounts: accounts,
      knownAccounts: known
    };
  }

  const account = accounts.find((entry) => entry.email === normalizedEmail);
  const knownAccount = known.find((entry) => entry.email === normalizedEmail);
  return {
    status: account ? "connected" : knownAccount ? "login_required" : "not_connected",
    accountEmail: normalizedEmail,
    account: account || knownAccount || null,
    connectedAccounts: accounts,
    knownAccounts: known
  };
}

function mergeAccountLists(...accountLists) {
  return normalizeConnectedAccounts(accountLists.flat());
}

function accountFromMessage(message) {
  const email = normalizeEmail(message?.accountEmail);
  if (!email) return null;
  const client = String(message?.client || "");
  const provider = getProviderForClient(client || email);
  return {
    email,
    displayName: email,
    provider,
    client: client || (provider === "microsoft" ? "Outlook" : "Gmail"),
    status: "known"
  };
}

function normalizeConnectedAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];
  const byEmail = new Map();

  for (const account of accounts) {
    const email = normalizeEmail(account?.email);
    if (!email) continue;
    byEmail.set(email, {
      email,
      displayName: String(account.displayName || account.name || email),
      photoURL: String(account.photoURL || account.photoUrl || ""),
      provider: String(account.provider || "google"),
      client: String(account.client || "Gmail"),
      connectedAt: account.connectedAt || new Date().toISOString(),
      status: account.status || "connected"
    });
  }

  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

async function pairInstallWithCode(message) {
  const settings = await getSettings();
  const installId = await getInstallId();
  const installSecret = await getInstallSecret();
  const code = String(message.code || "").trim().toUpperCase();

  if (!code) {
    return { ok: false, error: "Enter a pairing code from the web app." };
  }

  if (!settings.backendBaseUrl) {
    return { ok: false, error: "Tracking service is not configured." };
  }

  const response = await fetch(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/app/pair-install`, {
    method: "POST",
    headers: getBackendHeaders(settings, installSecret),
    body: JSON.stringify({ code, installId, installSecret })
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

async function startAccountConnection(message) {
  const settings = await getSettings();
  const installId = await getInstallId();
  const installSecret = await getInstallSecret();
  const accountEmail = normalizeEmail(message.accountEmail);
  const client = String(message.client || "Gmail");
  const returnUrl = sanitizeConnectionReturnUrl(message.returnUrl || "");
  const source = message.source === "web-app" ? "web-app" : "chrome-extension";
  const knownAccounts = await getKnownAccounts();
  const connectedAccounts = await getConnectedAccounts();
  const accountStatus = getAccountStatus(accountEmail, connectedAccounts, knownAccounts);
  const mode = accountStatus.status === "login_required" ? "reconnect" : "connect";

  if (!accountEmail) {
    return { ok: false, error: "Could not detect the active mail account." };
  }

  if (message.silentReconnect && message.idToken) {
    return connectSignedInAccount(message);
  }

  const connectUrl = buildConnectUrl({ installId, installSecret, accountEmail, client, returnUrl, mode, source });

  if (globalThis.chrome?.tabs?.create) {
    await chrome.tabs.create({ url: connectUrl, active: true });
  } else if (globalThis.chrome?.windows?.create) {
    await chrome.windows.create({ url: connectUrl, type: "popup", width: 920, height: 760 });
  }

  if (message.openOnly) {
    return {
      ok: true,
      connectUrl,
      accountStatus
    };
  }

  const status = await pollInstallConnection(settings, installId, installSecret, accountEmail);
  return {
    ok: status.accountStatus?.status === "connected",
    connectUrl,
    ...status
  };
}

async function refreshAccountConnection(message = {}) {
  const settings = await getSettings();
  const installId = await getInstallId();
  const installSecret = await getInstallSecret();
  const accountEmail = normalizeEmail(message.accountEmail || (await getActiveAccountEmail()));
  const status = await fetchInstallStatus(settings, installId, installSecret, accountEmail);

  const saved = await saveInstallAccountState(status, accountEmail);
  const result = { ok: true, ...status, ...saved };
  notifyWebAppAccountConnectionChanged(accountEmail, result).catch((error) => {
    console.warn("Simple Track could not notify web app account refresh", error);
  });
  return result;
}

async function connectSignedInAccount(message = {}) {
  const settings = await getSettings();
  const installId = await getInstallId();
  const installSecret = await getInstallSecret();
  const accountEmail = normalizeEmail(message.accountEmail);
  const idToken = String(message.idToken || "");
  const client = String(message.client || "Gmail");
  const provider = String(message.provider || getProviderForClient(client));
  const accountDisplayName = String(message.accountDisplayName || accountEmail);
  const accountPhotoURL = String(message.accountPhotoURL || "");

  if (!settings.backendBaseUrl) {
    return { ok: false, error: "Tracking service is not configured." };
  }

  if (!installId || !installSecret || !accountEmail || !idToken) {
    return { ok: false, error: "Missing extension install or signed-in account details." };
  }

  let response;
  try {
    const headers = getBackendHeaders(settings, installSecret);
    headers.Authorization = `Bearer ${idToken}`;
    response = await fetch(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/app/connect-extension`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        installId,
        installSecret,
        accountEmail,
        client,
        provider,
        accountDisplayName,
        accountPhotoURL
      })
    });
  } catch (error) {
    return { ok: false, error: error.message || "Could not reach the tracking service." };
  }

  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    return { ok: false, error: body?.error || `Account reconnect failed (${response.status})` };
  }

  let state;
  try {
    state = await fetchInstallStatus(settings, installId, installSecret, accountEmail);
  } catch {
    const connectedAccount = {
      email: accountEmail,
      displayName: accountDisplayName,
      photoURL: accountPhotoURL,
      provider,
      client,
      status: "connected"
    };
    state = {
      ok: true,
      connectedAccounts: mergeAccountLists(await getConnectedAccounts(), [connectedAccount]),
      knownAccounts: mergeAccountLists(await getKnownAccounts(), [connectedAccount]),
      activeAccountEmail: accountEmail,
      accountStatus: {
        status: "connected",
        accountEmail,
        account: connectedAccount
      }
    };
  }

  const saved = await saveInstallAccountState(state, accountEmail);
  const result = {
    ok: true,
    ...body,
    ...saved,
    accountStatus: state.accountStatus || getAccountStatus(accountEmail, saved.connectedAccounts, saved.knownAccounts)
  };
  notifyWebAppAccountConnectionChanged(accountEmail, result).catch((error) => {
    console.warn("Simple Track could not notify web app account reconnect", error);
  });
  return result;
}

async function selectAccount(message = {}) {
  const accountEmail = normalizeEmail(message.accountEmail);
  const connectedAccounts = await getConnectedAccounts();
  const knownAccounts = await getKnownAccounts();
  const accountStatus = getAccountStatus(accountEmail, connectedAccounts, knownAccounts);

  if (!accountEmail) {
    return { ok: false, error: "Choose a connected mail account." };
  }

  if (accountStatus.status !== "connected") {
    return {
      ok: false,
      error: `${accountEmail} is not connected to Simple Track.`,
      connectedAccounts,
      knownAccounts,
      activeAccountEmail: await getActiveAccountEmail(),
      accountStatus
    };
  }

  await chrome.storage.local.set({ [STORAGE_KEYS.activeAccountEmail]: accountEmail });
  return {
    ok: true,
    connectedAccounts,
    knownAccounts,
    activeAccountEmail: accountEmail,
    accountStatus
  };
}

async function createWebAppSession(message = {}) {
  const settings = await getSettings();
  const installId = await getInstallId();
  const installSecret = await getInstallSecret();
  const accountEmail = normalizeEmail(message.accountEmail || (await getActiveAccountEmail()));
  const connectedAccounts = await getConnectedAccounts();
  const accountStatus = getAccountStatus(accountEmail, connectedAccounts);

  if (!settings.backendBaseUrl) {
    return { ok: false, error: "Tracking service is not configured." };
  }

  if (!installId || !installSecret || !accountEmail) {
    return { ok: false, error: "A connected account is required to open the web app session." };
  }

  if (accountStatus.status !== "connected") {
    return { ok: false, error: `${accountEmail} is not connected to this extension install.` };
  }

  let response;
  try {
    response = await fetch(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/app/extension-session`, {
      method: "POST",
      headers: getBackendHeaders(settings, installSecret),
      body: JSON.stringify({ installId, accountEmail })
    });
  } catch (error) {
    return { ok: false, error: error.message || "Could not reach the tracking service." };
  }
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.ok) {
    return { ok: false, error: body?.error || `Web app session failed (${response.status})` };
  }

  if (body.connectedAccounts) {
    await saveInstallAccountState(body, accountEmail);
  }

  return body;
}

async function disconnectAccount(message = {}) {
  const settings = await getSettings();
  const installId = await getInstallId();
  const installSecret = await getInstallSecret();
  const accountEmail = normalizeEmail(message.accountEmail || (await getActiveAccountEmail()));
  const currentAccounts = await getConnectedAccounts();
  const currentActiveEmail = await getActiveAccountEmail();

  if (!accountEmail) {
    return {
      ok: false,
      error: "No mail account was selected to log out."
    };
  }

  if (settings.backendBaseUrl && installId && installSecret) {
    await rememberKnownAccounts(currentAccounts);
    let response;
    try {
      response = await fetch(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/app/extension-disconnect`, {
        method: "POST",
        headers: getBackendHeaders(settings, installSecret),
        body: JSON.stringify({ installId, accountEmail })
      });
    } catch (error) {
      return { ok: false, error: error.message || "Could not reach the tracking service." };
    }
    const body = await response.json().catch(() => null);

    if (!response.ok || !body?.ok) {
      return { ok: false, error: body?.error || `Account disconnect failed (${response.status})` };
    }

    const saved = await saveInstallAccountState(body, "");
    notifyWebAppAccountDisconnected(accountEmail, saved).catch((error) => {
      console.warn("Simple Track could not notify web app logout", error);
    });
    return {
      ok: true,
      ...body,
      ...saved,
      accountStatus: body.accountStatus || getAccountStatus(accountEmail, saved.connectedAccounts, saved.knownAccounts)
    };
  }

  await rememberKnownAccounts(currentAccounts);
  const remainingAccounts = currentAccounts.filter((account) => account.email !== accountEmail);
  const requestedActiveEmail = currentActiveEmail === accountEmail ? "" : currentActiveEmail;
  const nextActiveEmail = remainingAccounts.some((account) => account.email === requestedActiveEmail)
    ? requestedActiveEmail
    : remainingAccounts[0]?.email || "";
  const saved = await setConnectedAccounts(remainingAccounts, nextActiveEmail);
  notifyWebAppAccountDisconnected(accountEmail, saved).catch((error) => {
    console.warn("Simple Track could not notify web app logout", error);
  });

  return {
    ok: true,
    ...saved,
    accountStatus: getAccountStatus(accountEmail, saved.connectedAccounts, saved.knownAccounts)
  };
}

async function saveInstallAccountState(status = {}, fallbackActiveAccountEmail = "") {
  const saved = await setConnectedAccounts(status.connectedAccounts || [], status.activeAccountEmail || fallbackActiveAccountEmail);
  const knownAccounts = status.knownAccounts
    ? await rememberKnownAccounts(status.knownAccounts)
    : saved.knownAccounts;
  return {
    ...saved,
    knownAccounts
  };
}

function buildConnectUrl({ installId, installSecret, accountEmail, client, returnUrl = "", mode = "connect", source = "chrome-extension" }) {
  const params = new URLSearchParams({
    installId,
    installSecret,
    accountEmail,
    client,
    provider: getProviderForClient(client),
    mode,
    source
  });
  if (returnUrl) params.set("returnUrl", returnUrl);
  const url = new URL(`${WEB_APP_URL}/connect-extension`);
  url.searchParams.set("v", String(Date.now()));
  url.hash = params.toString();
  return url.toString();
}

async function notifyWebAppAccountDisconnected(accountEmail, state = {}) {
  return notifyWebAppAccountState("simpleTrack:accountDisconnected", accountEmail, state);
}

async function notifyWebAppAccountConnectionChanged(accountEmail, state = {}) {
  return notifyWebAppAccountState("simpleTrack:accountConnectionChanged", accountEmail, state);
}

async function notifyWebAppAccountState(type, accountEmail, state = {}) {
  if (!globalThis.chrome?.tabs?.query || !globalThis.chrome?.tabs?.sendMessage) return;
  const tabs = await chrome.tabs.query({
    url: [
      "https://simple-track-prod-app.web.app/*",
      "https://simple-track-prod-app.firebaseapp.com/*"
    ]
  });
  await Promise.all(tabs.map((tab) => (
    tab.id
      ? chrome.tabs.sendMessage(tab.id, {
          type,
          accountEmail,
          connectedAccounts: state.connectedAccounts || [],
          knownAccounts: state.knownAccounts || [],
          activeAccountEmail: state.activeAccountEmail || ""
        }).catch(() => null)
      : Promise.resolve(null)
  )));
}

function sanitizeMailReturnUrl(value = "") {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase();
    const allowed = hostname === "mail.google.com" ||
      hostname === "outlook.live.com" ||
      hostname === "outlook.office.com" ||
      hostname === "outlook.office365.com";
    return allowed ? url.toString() : "";
  } catch {
    return "";
  }
}

function sanitizeConnectionReturnUrl(value = "") {
  const mailReturnUrl = sanitizeMailReturnUrl(value);
  if (mailReturnUrl) return mailReturnUrl;

  try {
    const url = new URL(String(value || ""));
    return EXTERNAL_MESSAGE_ORIGINS.has(url.origin) && url.pathname !== "/connect-extension"
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

function getProviderForClient(client) {
  return String(client || "").toLowerCase().includes("outlook") ? "microsoft" : "google";
}

async function pollInstallConnection(settings, installId, installSecret, accountEmail) {
  let lastStatus = null;

  for (let attempt = 0; attempt < CONNECTION_POLL_ATTEMPTS; attempt += 1) {
    await delay(attempt === 0 ? 1200 : CONNECTION_POLL_INTERVAL_MS);
    try {
      lastStatus = await fetchInstallStatus(settings, installId, installSecret, accountEmail);
      await saveInstallAccountState(lastStatus, accountEmail);
      if (lastStatus.accountStatus?.status === "connected") return lastStatus;
    } catch (error) {
      lastStatus = { ok: false, error: error.message };
    }
  }

  return lastStatus || { ok: false, error: "Connection timed out. Return to your mail tab and try again." };
}

async function fetchInstallStatus(settings, installId, installSecret, accountEmail = "") {
  const url = new URL(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/install/status`);
  url.searchParams.set("installId", installId);
  if (accountEmail) url.searchParams.set("accountEmail", accountEmail);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getBackendHeaders(settings, installSecret)
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `Install status failed (${response.status})`);
  }

  return body;
}

async function refreshBackendMessages(settings = null, currentMessages = null, options = {}) {
  const activeSettings = settings || (await getSettings());
  if (!activeSettings.backendBaseUrl) return currentMessages || (await getMessages());

  const installId = await getInstallId();
  const installSecret = await getInstallSecret();
  const accountEmail = normalizeEmail(options.accountEmail || "");
  const localMessages = currentMessages || (await getMessages());
  const deletedIds = await getDeletedMessageIds();
  const backendMessages = await fetchBackendMessages(activeSettings, installId, installSecret, accountEmail);
  const mergedMessages = upsertMessages(localMessages, backendMessages.map(normalizeMessage))
    .filter((message) => !deletedIds.has(message.id));

  await chrome.storage.local.set({ [STORAGE_KEYS.messages]: mergedMessages });
  await notifyForNewOpens(localMessages, mergedMessages, activeSettings);

  return mergedMessages;
}

async function createBackendMessage(settings, installId, installSecret, draftMessage) {
  const response = await fetch(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/messages`, {
    method: "POST",
    headers: getBackendHeaders(settings, installSecret),
    body: JSON.stringify({
      installId,
      installSecret,
      accountEmail: draftMessage.accountEmail,
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

async function fetchBackendMessages(settings, installId, installSecret, accountEmail = "") {
  const url = new URL(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/messages`);
  url.searchParams.set("installId", installId);
  if (accountEmail) url.searchParams.set("accountEmail", accountEmail);

  const response = await fetch(url.toString(), {
    method: "GET",
    headers: getBackendHeaders(settings, installSecret)
  });

  const body = await response.json().catch(() => null);

  if (!response.ok || !body?.ok) {
    throw new Error(body?.error || `Backend message sync failed (${response.status})`);
  }

  return body.messages || [];
}

function getBackendHeaders(settings, installSecret = "") {
  const headers = {
    "Content-Type": "application/json",
    "X-Simple-Track-Client": "chrome-extension"
  };
  if (installSecret) headers["X-Simple-Track-Install-Secret"] = installSecret;
  return headers;
}

async function notifyForNewOpens(previousMessages, nextMessages, settings) {
  if (!settings.notificationsEnabled) return;

  const previousById = new Map(previousMessages.map((message) => [message.id, message]));
  for (const nextMessage of nextMessages) {
    const previousMessage = previousById.get(nextMessage.id);
    if (!previousMessage) continue;
    if (previousMessage.opens === 0 && nextMessage.opens > 0 && !nextMessage.muted) {
      await createNotification(nextMessage);
    }
  }
}

async function createNotification(message) {
  if (!chrome.notifications?.create) return false;

  const notificationId = `simple-track-open-${message.id}-${message.opens}`;
  const baseOptions = {
    type: "basic",
    title: "Email opened",
    message: message.subject || "A tracked email was opened"
  };
  const iconUrls = [
    chrome.runtime.getURL("assets/icons/icon-48.png"),
    chrome.runtime.getURL("assets/icons/icon-128.png")
  ];

  for (const iconUrl of iconUrls) {
    const result = await tryCreateNotification(notificationId, { ...baseOptions, iconUrl });
    if (result.ok) return true;
  }

  console.warn("Simple Track notification could not be displayed: unable to load packaged notification icon.");
  return false;
}

function tryCreateNotification(notificationId, options) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    try {
      const maybePromise = chrome.notifications.create(notificationId, options, () => {
        const error = chrome.runtime.lastError;
        finish(error ? { ok: false, error } : { ok: true });
      });

      if (maybePromise && typeof maybePromise.then === "function") {
        maybePromise
          .then(() => finish({ ok: true }))
          .catch((error) => finish({ ok: false, error }));
      }
    } catch (error) {
      finish({ ok: false, error });
    }
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
    accountEmail: normalizeEmail(message.accountEmail),
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

function getRealtimeUrl(settings, installId, installSecret = "", accountEmail = "") {
  if (!settings.backendBaseUrl || !installId) return null;

  const url = new URL(`${normalizeBackendBaseUrl(settings.backendBaseUrl)}/events`);
  url.searchParams.set("installId", installId);
  if (installSecret) url.searchParams.set("s", installSecret);
  if (accountEmail) url.searchParams.set("accountEmail", accountEmail);
  return url.toString();
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function randomInstallSecret() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
