const fallbackState = {
  ok: true,
  messages: [
    {
      id: "preview",
      subject: "Question About Lawncare From Your Webpage",
      recipients: ["gardening@usask.ca", "gardenline@usask.ca"],
      status: "opened",
      opens: 3,
      clicks: 0,
      attachmentOpens: 1,
      lastActivityAt: "2026-05-18T18:44:14.000Z",
      sentAt: "2026-05-18T17:09:25.000Z",
      events: [
        {
          type: "open",
          createdAt: "2026-05-18T18:44:14.000Z",
          device: "Chrome on Windows",
          location: "Saskatoon, SK",
          url: null
        },
        {
          type: "attachment_open",
          createdAt: "2026-05-18T18:46:08.000Z",
          device: "Chrome on Windows",
          location: "Saskatoon, SK",
          label: "Lawncare quote PDF",
          kind: "pdf",
          url: "https://example.com/lawncare"
        }
      ],
      muted: false
    }
  ],
  settings: { trackingEnabled: true },
  summary: { sent: 1, opened: 1, unopened: 0, clicked: 0, attachmentOpened: 1, openRate: 100 },
  connectedAccounts: [],
  activeAccountEmail: "",
  accountStatus: { status: "unknown_account", accountEmail: "", connectedAccounts: [] },
  activeTabAccount: { accountEmail: "", client: "", isMailTab: false, detected: false }
};

let currentState = fallbackState;
let currentFilter = "all";
let currentSearch = "";
let accountActionBusy = false;
let popupRefreshTimer = null;
let realtimeSource = null;
let activeRealtimeUrl = null;
let realtimeConnected = false;
let lastFullStateRefreshAt = 0;
let openMessageIds = new Set();

const POPUP_REFRESH_MS = 2500;
const REALTIME_HEALTH_REFRESH_MS = 5 * 60 * 1000;
const WEB_APP_URL = "https://simple-track-prod-app.web.app";
const MAIL_HOST_PATTERN = /mail\.google\.com|outlook\.live\.com|outlook\.office\.com|outlook\.office365\.com/i;

const elements = {
  accountPanel: document.querySelector("#accountPanel"),
  accountAvatar: document.querySelector("#accountAvatar"),
  accountEmail: document.querySelector("#accountEmail"),
  accountStatus: document.querySelector("#accountStatus"),
  connectAccount: document.querySelector("#connectAccount"),
  disconnectAccount: document.querySelector("#disconnectAccount"),
  activityList: document.querySelector("#activityList"),
  template: document.querySelector("#messageTemplate"),
  searchInput: document.querySelector("#searchInput"),
  trackingToggle: document.querySelector("#trackingToggle"),
  openOptions: document.querySelector("#openOptions"),
  tabs: [...document.querySelectorAll(".tab")]
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  currentState = await getState();
  lastFullStateRefreshAt = Date.now();
  render();
  syncRealtimeStream(currentState.realtimeUrl);

  elements.connectAccount.addEventListener("click", connectCurrentAccount);
  elements.disconnectAccount.addEventListener("click", disconnectCurrentAccount);

  elements.searchInput.addEventListener("input", (event) => {
    currentSearch = event.target.value.trim().toLowerCase();
    renderMessages();
  });

  elements.trackingToggle.addEventListener("change", async (event) => {
    currentState.settings.trackingEnabled = event.target.checked;
    await sendMessage({
      type: "simpleTrack:updateSettings",
      settings: { trackingEnabled: event.target.checked }
    });
  });

  elements.openOptions.addEventListener("click", () => openWebAppForCurrentAccount());

  for (const tab of elements.tabs) {
    tab.addEventListener("click", () => {
      currentFilter = tab.dataset.filter;
      elements.tabs.forEach((button) => button.classList.toggle("is-active", button === tab));
      renderMessages();
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      stopPopupRefresh();
      closeRealtimeStream();
      return;
    }

    refreshPopupState();
    startPopupRefresh();
    syncRealtimeStream(activeRealtimeUrl);
  });

  startPopupRefresh();
}

async function getState() {
  const activeTabAccount = await getActiveTabAccountContext();
  const response = await sendMessage({
    type: "simpleTrack:getState",
    accountEmail: activeTabAccount.accountEmail || "",
    client: activeTabAccount.client || ""
  });
  if (!response?.ok) return normalizePopupState(fallbackState, activeTabAccount);
  lastFullStateRefreshAt = Date.now();
  return normalizePopupState(response, activeTabAccount);
}

async function sendMessage(message) {
  if (!globalThis.chrome?.runtime?.sendMessage) {
    return fallbackState;
  }

  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    console.warn("Simple Track popup fell back to preview data", error);
    return fallbackState;
  }
}

async function getActiveTabAccountContext() {
  if (!globalThis.chrome?.tabs?.query || !globalThis.chrome?.tabs?.sendMessage) {
    return { accountEmail: "", client: "", isMailTab: false, detected: false };
  }

  let tabContext = { accountEmail: "", client: "", isMailTab: false, detected: false };

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs?.[0];
    const url = String(tab?.url || "");
    const isMailTab = MAIL_HOST_PATTERN.test(url);
    const client = getClientFromUrl(url);
    tabContext = { accountEmail: "", client, isMailTab, detected: false };

    if (!tab?.id || !isMailTab) {
      return tabContext;
    }

    const response = await detectAccountFromTab(tab.id);
    const accountEmail = normalizeEmail(response?.accountEmail);
    return {
      accountEmail,
      client: response?.client || client,
      isMailTab: true,
      detected: Boolean(accountEmail),
      accountStatus: response?.accountStatus || null
    };
  } catch (error) {
    return {
      ...tabContext,
      detected: false,
      error: error.message
    };
  }
}

async function detectAccountFromTab(tabId) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "simpleTrack:detectAccount" });
  } catch (error) {
    if (!globalThis.chrome?.scripting?.executeScript) throw error;
    await injectContentScript(tabId);
    return retryDetectAccountFromTab(tabId);
  }
}

async function retryDetectAccountFromTab(tabId) {
  let lastError = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await delay(150 + attempt * 100);
    try {
      return await chrome.tabs.sendMessage(tabId, { type: "simpleTrack:detectAccount" });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("Could not reach the Simple Track content script.");
}

async function injectContentScript(tabId) {
  try {
    if (globalThis.chrome?.scripting?.insertCSS) {
      await chrome.scripting.insertCSS({
        target: { tabId },
        files: ["src/content/email-tracker-content.css"]
      });
    }
  } catch (error) {
    console.warn("Simple Track popup could not inject CSS into the active mail tab", error);
  }

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/content/email-tracker-content.js"]
  });
}

function normalizePopupState(response, activeTabAccount) {
  const connectedAccounts = Array.isArray(response.connectedAccounts) ? response.connectedAccounts : [];
  const accountEmail = normalizeEmail(
    activeTabAccount.accountEmail ||
    response.accountStatus?.accountEmail ||
    response.activeAccountEmail
  );
  const accountStatus = response.accountStatus || activeTabAccount.accountStatus || getLocalAccountStatus(accountEmail, connectedAccounts);

  return {
    ...fallbackState,
    ...response,
    connectedAccounts,
    activeTabAccount,
    activeAccountEmail: accountEmail || normalizeEmail(response.activeAccountEmail),
    accountStatus: {
      ...accountStatus,
      accountEmail: normalizeEmail(accountStatus.accountEmail || accountEmail),
      connectedAccounts
    }
  };
}

function startPopupRefresh() {
  stopPopupRefresh();
  popupRefreshTimer = window.setInterval(refreshPopupState, POPUP_REFRESH_MS);
}

function stopPopupRefresh() {
  if (!popupRefreshTimer) return;
  window.clearInterval(popupRefreshTimer);
  popupRefreshTimer = null;
}

async function refreshPopupState() {
  if (document.hidden) return;
  if (!shouldRefreshFromBackend()) return;
  const nextState = await getState();
  if (!nextState?.ok) return;
  currentState = nextState;
  syncRealtimeStream(currentState.realtimeUrl);
  render();
}

function syncRealtimeStream(nextUrl) {
  activeRealtimeUrl = nextUrl || null;

  if (!activeRealtimeUrl || document.hidden || !globalThis.EventSource) {
    closeRealtimeStream();
    return;
  }

  if (realtimeSource && realtimeSource.url === activeRealtimeUrl) return;

  closeRealtimeStream();

  realtimeConnected = false;
  realtimeSource = new EventSource(activeRealtimeUrl);
  realtimeSource.addEventListener("ready", () => {
    realtimeConnected = true;
  });
  realtimeSource.addEventListener("message", (event) => {
    try {
      realtimeConnected = true;
      const payload = JSON.parse(event.data);
      if (payload?.message) {
        applyRealtimeMessage(payload.message);
      }
    } catch (error) {
      console.warn("Simple Track popup realtime event was not readable", error);
    }
  });
  realtimeSource.addEventListener("stream-error", closeRealtimeStream);
  realtimeSource.addEventListener("error", () => {
    realtimeConnected = false;
  });
}

function closeRealtimeStream() {
  realtimeConnected = false;
  if (!realtimeSource) return;
  realtimeSource.close();
  realtimeSource = null;
}

function shouldRefreshFromBackend() {
  return !isRealtimeHealthy() || Date.now() - lastFullStateRefreshAt >= REALTIME_HEALTH_REFRESH_MS;
}

function isRealtimeHealthy() {
  return Boolean(
    realtimeConnected &&
    realtimeSource &&
    globalThis.EventSource &&
    realtimeSource.readyState !== EventSource.CLOSED
  );
}

function applyRealtimeMessage(message) {
  if (!message?.id) return;

  const existingIndex = currentState.messages.findIndex((trackedMessage) => trackedMessage.id === message.id);
  const existingMessage = existingIndex >= 0 ? currentState.messages[existingIndex] : null;
  const nextMessage = {
    ...existingMessage,
    ...message,
    muted: existingMessage?.muted ?? Boolean(message.muted)
  };

  if (existingIndex >= 0) {
    currentState.messages = currentState.messages.map((trackedMessage, index) => index === existingIndex ? nextMessage : trackedMessage);
  } else {
    currentState.messages = [nextMessage, ...currentState.messages];
  }

  currentState.messages.sort(compareMessagesByActivity);
  currentState.summary = summarizeMessages(currentState.messages);
  render();
}

function render() {
  const { settings } = currentState;
  elements.trackingToggle.checked = Boolean(settings.trackingEnabled);

  renderAccountPanel();
  renderMessages();
}

function renderAccountPanel() {
  const accountEmail = getCurrentPopupAccountEmail();
  const status = getCurrentPopupAccountStatus();
  const activeTab = currentState.activeTabAccount || {};
  const isConnected = status.status === "connected";
  const isDisconnected = Boolean(activeTab.isMailTab && accountEmail && !isConnected);

  elements.accountPanel.classList.toggle("is-connected", isConnected);
  elements.accountPanel.classList.toggle("is-disconnected", isDisconnected);
  renderAccountAvatar(accountEmail, status.account);
  elements.accountEmail.textContent = accountEmail || "No mail account detected";
  elements.accountStatus.textContent = getAccountStatusLabel(status, activeTab);

  elements.connectAccount.hidden = !accountEmail || isConnected;
  elements.disconnectAccount.hidden = !accountEmail || !isConnected;
  elements.connectAccount.disabled = accountActionBusy;
  elements.disconnectAccount.disabled = accountActionBusy;
  elements.connectAccount.textContent = accountActionBusy ? "Opening..." : "Connect";
  elements.disconnectAccount.textContent = accountActionBusy ? "Saving..." : "Log out";
}

function renderAccountAvatar(accountEmail, account = null) {
  const photoURL = account?.photoURL || account?.photoUrl || "";
  elements.accountAvatar.replaceChildren();
  elements.accountAvatar.classList.toggle("has-photo", Boolean(photoURL));

  if (photoURL) {
    const image = document.createElement("img");
    image.src = photoURL;
    image.alt = "";
    image.referrerPolicy = "no-referrer";
    elements.accountAvatar.append(image);
    return;
  }

  elements.accountAvatar.textContent = getAccountInitials(accountEmail || account?.displayName || "ST");
}

function getCurrentPopupAccountEmail() {
  const activeTab = currentState.activeTabAccount || {};

  return normalizeEmail(
    activeTab.accountEmail ||
    currentState.accountStatus?.accountEmail ||
    currentState.activeAccountEmail
  );
}

function getCurrentPopupAccountStatus() {
  const accountEmail = getCurrentPopupAccountEmail();
  return currentState.accountStatus || getLocalAccountStatus(accountEmail, currentState.connectedAccounts || []);
}

function getAccountStatusLabel(status, activeTab) {
  const client = activeTab.client || status.account?.client || "mail";

  if (activeTab.isMailTab && !activeTab.detected) {
    if (status.status === "connected" && status.accountEmail) {
      return `Tracking is connected. Gmail did not expose the active tab address yet.`;
    }

    return `Could not detect this ${client} account yet.`;
  }

  if (status.status === "connected") {
    return `Tracking is connected for this ${client} account.`;
  }

  if (activeTab.isMailTab && status.accountEmail) {
    return `Connect this ${client} account before tracking sends.`;
  }

  if (status.accountEmail) {
    return "Last connected account. Open Gmail or Outlook to switch context.";
  }

  return "Open Gmail or Outlook to connect tracking.";
}

function getAccountInitials(value) {
  const source = String(value || "ST").trim();
  if (source.includes("@")) return source[0]?.toUpperCase() || "ST";
  return source
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "ST";
}

async function connectCurrentAccount() {
  const accountEmail = getCurrentPopupAccountEmail();
  if (!accountEmail) return;

  accountActionBusy = true;
  renderAccountPanel();
  try {
    const response = await sendMessage({
      type: "simpleTrack:startAccountConnection",
      accountEmail,
      client: currentState.activeTabAccount?.client || "Gmail"
    });
    if (response?.connectedAccounts) {
      currentState = normalizePopupState({
        ...currentState,
        connectedAccounts: response.connectedAccounts,
        activeAccountEmail: response.activeAccountEmail || accountEmail,
        accountStatus: response.accountStatus
      }, currentState.activeTabAccount || {});
    }
    currentState = await getState();
    syncRealtimeStream(currentState.realtimeUrl);
  } finally {
    accountActionBusy = false;
    render();
  }
}

async function disconnectCurrentAccount() {
  const accountEmail = getCurrentPopupAccountEmail();
  if (!accountEmail) return;

  accountActionBusy = true;
  renderAccountPanel();
  try {
    const response = await sendMessage({ type: "simpleTrack:disconnectAccount", accountEmail });
    if (response?.ok) {
      currentState = normalizePopupState({
        ...currentState,
        connectedAccounts: response.connectedAccounts || [],
        activeAccountEmail: response.activeAccountEmail || "",
        accountStatus: response.accountStatus
      }, currentState.activeTabAccount || {});
      syncRealtimeStream(currentState.realtimeUrl);
    }
  } finally {
    accountActionBusy = false;
    render();
  }
}

function renderMessages() {
  rememberOpenCards();
  elements.activityList.replaceChildren();

  const messages = currentState.messages
    .filter(matchesFilter)
    .filter(matchesSearch)
    .sort((a, b) => {
      const aTime = new Date(a.lastActivityAt || a.sentAt).getTime();
      const bTime = new Date(b.lastActivityAt || b.sentAt).getTime();
      return bTime - aTime;
    });

  if (messages.length === 0) {
    const emptyState = document.createElement("p");
    emptyState.className = "empty-state";
    emptyState.textContent = "No tracked messages match this view.";
    elements.activityList.append(emptyState);
    return;
  }

  for (const message of messages) {
    const node = elements.template.content.firstElementChild.cloneNode(true);
    const activityType = getLatestActivityType(message);
    node.dataset.messageId = message.id;
    node.open = openMessageIds.has(message.id);
    node.classList.toggle("is-opened", message.opens > 0 || message.clicks > 0 || message.attachmentOpens > 0);
    node.classList.toggle("is-clicked", activityType === "click");
    node.classList.toggle("is-attachment-opened", activityType === "attachment_open");
    node.addEventListener("toggle", () => {
      if (node.open) {
        openMessageIds.add(message.id);
      } else {
        openMessageIds.delete(message.id);
      }
    });

    const status = getStatus(message);
    const statusPill = node.querySelector(".status-pill");
    statusPill.classList.add(status.key);
    statusPill.textContent = status.label;

    node.querySelector("time").textContent = formatShortDate(message.lastActivityAt || message.sentAt);
    node.querySelector(".recipients").textContent = getRecipientLabel(message);
    renderActivity(node.querySelector(".activity"), message, status);
    node.querySelector(".opens").textContent = String(message.opens);
    node.querySelector(".clicks").textContent = String(message.clicks);
    node.querySelector(".attachment-opens").textContent = String(message.attachmentOpens || 0);
    node.querySelector(".status-value").textContent = status.shortLabel;
    node.querySelector(".subject").textContent = message.subject;
    node.querySelector(".last-activity").textContent = formatDetailedDate(message.lastActivityAt) || "Not opened yet";
    node.querySelector(".device").textContent = message.device || "Pending";
    node.querySelector(".location").textContent = message.location || "Unknown";
    renderEventTimeline(node, message);

    const muteButton = node.querySelector(".mute-button");
    muteButton.textContent = message.muted ? "Muted" : "Mute";
    muteButton.addEventListener("click", () => toggleMuted(message.id, !message.muted));

    const webReportButton = node.querySelector(".web-report-button");
    webReportButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      openMessageInWebApp(message);
    });

    const deleteButton = node.querySelector(".delete-button");
    deleteButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteMessage(message.id);
    });

    elements.activityList.append(node);
  }
}

function rememberOpenCards() {
  for (const card of elements.activityList.querySelectorAll(".message-card[data-message-id]")) {
    if (card.open) {
      openMessageIds.add(card.dataset.messageId);
    } else {
      openMessageIds.delete(card.dataset.messageId);
    }
  }
}

async function toggleMuted(id, muted) {
  currentState.messages = currentState.messages.map((message) => {
    if (message.id !== id) return message;
    return { ...message, muted };
  });
  renderMessages();
  await sendMessage({ type: "simpleTrack:setMuted", id, muted });
}

async function deleteMessage(id) {
  openMessageIds.delete(id);
  currentState.messages = currentState.messages.filter((message) => message.id !== id);
  render();
  await sendMessage({ type: "simpleTrack:deleteMessage", id });
}

async function openMessageInWebApp(message) {
  await openWebApp({
    page: "email",
    messageId: message.id,
    accountEmail: getCurrentPopupAccountEmail() || message.accountEmail
  });
}

async function openWebAppForCurrentAccount() {
  await openWebApp({
    page: "activity",
    accountEmail: getCurrentPopupAccountEmail()
  });
}

async function openWebApp({ page = "activity", messageId = "", accountEmail = "" } = {}) {
  const url = new URL(WEB_APP_URL);
  url.searchParams.set("page", page);
  const normalizedAccountEmail = normalizeEmail(accountEmail);
  if (normalizedAccountEmail) url.searchParams.set("accountEmail", normalizedAccountEmail);
  if (messageId) url.searchParams.set("messageId", messageId);
  url.searchParams.set("source", "chrome-extension");
  const context = buildWebAppContext(normalizedAccountEmail);
  const handoff = await createWebAppSessions(normalizedAccountEmail);
  if (context) {
    url.hash = new URLSearchParams({
      stContext: encodeWebAppContext({
        ...context,
        handoffToken: handoff?.activeToken || "",
        handoffAccountEmail: handoff?.activeAccountEmail || normalizedAccountEmail,
        handoffTokens: handoff?.tokens || {}
      })
    }).toString();
  }

  openUrl(url.toString());
}

async function createWebAppSessions(activeAccountEmail) {
  const emails = new Set(
    (currentState.connectedAccounts || [])
      .map((account) => normalizeEmail(account.email))
      .filter(Boolean)
  );
  const normalizedActiveEmail = normalizeEmail(activeAccountEmail);
  if (normalizedActiveEmail) emails.add(normalizedActiveEmail);

  const tokens = {};
  await Promise.all([...emails].map(async (email) => {
    const session = await createWebAppSession(email);
    if (session?.customToken) tokens[email] = session.customToken;
  }));

  return {
    tokens,
    activeAccountEmail: normalizedActiveEmail,
    activeToken: tokens[normalizedActiveEmail] || ""
  };
}

async function createWebAppSession(accountEmail) {
  if (!accountEmail) return null;

  try {
    const response = await sendMessage({
      type: "simpleTrack:createWebAppSession",
      accountEmail
    });
    if (!response?.ok) return null;
    return response;
  } catch (error) {
    console.warn("Simple Track could not create a web app handoff session", error);
    return null;
  }
}

function buildWebAppContext(activeAccountEmail = "") {
  const connectedAccounts = Array.isArray(currentState.connectedAccounts)
    ? currentState.connectedAccounts
        .map((account) => ({
          email: normalizeEmail(account.email),
          displayName: account.displayName || account.name || account.email || "",
          photoURL: account.photoURL || account.photoUrl || "",
          provider: account.provider || "google",
          client: account.client || "Gmail",
          status: account.status || "connected"
        }))
        .filter((account) => account.email)
    : [];

  if (!connectedAccounts.length && !currentState.installId) return null;

  return {
    extensionId: globalThis.chrome?.runtime?.id || "",
    installId: currentState.installId || "",
    activeAccountEmail: normalizeEmail(activeAccountEmail || currentState.activeAccountEmail),
    connectedAccounts
  };
}

function encodeWebAppContext(context) {
  const bytes = new TextEncoder().encode(JSON.stringify(context));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function openUrl(url) {
  if (globalThis.chrome?.tabs?.create) {
    chrome.tabs.create({ url, active: true });
  } else {
    globalThis.open(url, "_blank", "noopener");
  }
}

function matchesFilter(message) {
  if (currentFilter === "opened") return message.opens > 0;
  if (currentFilter === "unopened") return message.opens === 0;
  if (currentFilter === "clicked") return message.clicks > 0;
  if (currentFilter === "files") return message.attachmentOpens > 0;
  return true;
}

function matchesSearch(message) {
  if (!currentSearch) return true;
  const haystack = [message.subject, ...message.recipients].join(" ").toLowerCase();
  return haystack.includes(currentSearch);
}

function getStatus(message) {
  const openLabel = `${message.opens} open${message.opens === 1 ? "" : "s"}`;
  const clickLabel = `${message.clicks} click${message.clicks === 1 ? "" : "s"}`;
  const fileLabel = `${message.attachmentOpens || 0} file${message.attachmentOpens === 1 ? "" : "s"}`;
  const activityType = getLatestActivityType(message);

  if (activityType === "click") return { key: "clicked", label: `${openLabel} / ${clickLabel} / ${fileLabel}`, shortLabel: "Clicked" };
  if (activityType === "attachment_open") return { key: "opened", label: `${openLabel} / ${clickLabel} / ${fileLabel}`, shortLabel: "File opened" };
  if (activityType === "open" || message.opens > 0) return { key: "opened", label: `${openLabel} / ${clickLabel} / ${fileLabel}`, shortLabel: "Opened" };
  return { key: "sent", label: `${openLabel} / ${clickLabel} / ${fileLabel}`, shortLabel: "Unread" };
}

function getRecipientLabel(message) {
  const recipients = Array.isArray(message.recipients) ? message.recipients.filter(Boolean) : [];
  if (recipients.length === 0) return "No recipients";
  if (recipients.length === 1) return recipients[0];
  return `${recipients[0]} +${recipients.length - 1}`;
}

function renderActivity(container, message, status) {
  const subject = document.createElement("span");
  subject.className = "subject-link";
  subject.textContent = message.subject;

  container.replaceChildren(subject, document.createTextNode(` ${getActivityPhrase(message, status)}`));
}

function getActivityPhrase(message, status) {
  const activityType = getLatestActivityType(message);
  const activityAt = getLatestActivityAt(message);

  if (activityType === "click") {
    return `had a link clicked ${formatRelativeDate(activityAt)} at ${formatTime(activityAt)}`;
  }

  if (activityType === "attachment_open") {
    return `had a file opened ${formatRelativeDate(activityAt)} at ${formatTime(activityAt)}`;
  }

  if (activityType === "open" || status.key === "opened") {
    return `was last opened ${formatRelativeDate(activityAt)} at ${formatTime(activityAt)}`;
  }

  return "has not been opened yet";
}

function renderEventTimeline(node, message) {
  const timeline = node.querySelector(".event-timeline");
  const eventCount = node.querySelector(".event-count");
  const events = getSortedEvents(message);

  timeline.replaceChildren();
  eventCount.textContent = events.length ? `${events.length} recent` : "No events";

  if (events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "event-row is-empty";
    empty.textContent = message.clicks > 0
      ? "Older click events were counted before URL details were stored."
      : "No opens or clicks recorded yet.";
    timeline.append(empty);
    return;
  }

  for (const event of events.slice(0, 12)) {
    const item = document.createElement("li");
    item.className = `event-row ${getEventClass(event)}`;

    const icon = document.createElement("span");
    icon.className = "event-icon";
    icon.textContent = getEventIcon(event);

    const copy = document.createElement("span");
    copy.className = "event-copy";

    const title = document.createElement("strong");
    title.textContent = getEventTitle(event);

    const meta = document.createElement("em");
    meta.textContent = [formatDetailedDate(event.createdAt), event.device, event.location]
      .filter(Boolean)
      .join(" - ");

    copy.append(title, meta);
    item.append(icon, copy);
    timeline.append(item);
  }
}

function getEventTitle(event) {
  if (event.type === "attachment_open") {
    if (event.kind === "pdf") {
      return `Email attachment opened: ${getEventTarget(event)}`;
    }

    return `Document opened: ${getEventTarget(event)}`;
  }

  if (event.type === "click") {
    return `Link clicked: ${getEventTarget(event)}`;
  }

  return "Opened email";
}

function getEventClass(event) {
  if (event.type === "click") return "is-click";
  if (event.type === "attachment_open") return "is-attachment";
  return "is-open";
}

function getEventIcon(event) {
  if (event.type === "click") return "L";
  if (event.type === "attachment_open") return "F";
  return "O";
}

function getLastEventType(message) {
  return getLatestEvent(message)?.type || "";
}

function getLatestActivityType(message) {
  const eventType = getLastEventType(message);
  if (eventType) return eventType;
  if ((message.attachmentOpens || 0) > 0) return "attachment_open";
  if ((message.clicks || 0) > 0) return "click";
  if ((message.opens || 0) > 0) return "open";
  return "";
}

function getLatestActivityAt(message) {
  return getLatestEvent(message)?.createdAt || message.lastActivityAt || message.sentAt;
}

function getLatestEvent(message) {
  return getSortedEvents(message)[0] || null;
}

function getSortedEvents(message) {
  const events = Array.isArray(message.events) ? message.events.filter(Boolean) : [];
  return [...events].sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime());
}

function compareMessagesByActivity(a, b) {
  const aTime = new Date(a.lastActivityAt || a.sentAt).getTime();
  const bTime = new Date(b.lastActivityAt || b.sentAt).getTime();
  return bTime - aTime;
}

function summarizeMessages(messages) {
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

function getEventTarget(event) {
  const label = cleanEventLabel(event.label);
  const url = formatClickedUrl(event.url);

  if (label && url && !labelsMatch(label, url)) {
    return `${label} - ${url}`;
  }

  return label || url || "tracked link";
}

function cleanEventLabel(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function labelsMatch(label, url) {
  const normalizedLabel = label.toLowerCase();
  const normalizedUrl = url.toLowerCase();
  return normalizedLabel === normalizedUrl || normalizedUrl.includes(normalizedLabel);
}

function formatClickedUrl(value) {
  if (!value) return "tracked link";

  try {
    const url = new URL(value);
    return `${url.hostname}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return value;
  }
}

function formatRelativeDate(value) {
  if (!value) return "";

  const elapsedSeconds = Math.round((new Date(value).getTime() - Date.now()) / 1000);
  const ranges = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
    ["second", 1]
  ];
  const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

  for (const [unit, seconds] of ranges) {
    if (Math.abs(elapsedSeconds) >= seconds || unit === "second") {
      return formatter.format(Math.round(elapsedSeconds / seconds), unit);
    }
  }

  return "";
}

function formatShortDate(value) {
  if (!value) return "Pending";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function formatDetailedDate(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function getLocalAccountStatus(accountEmail, connectedAccounts = []) {
  const normalizedEmail = normalizeEmail(accountEmail);
  const accounts = Array.isArray(connectedAccounts) ? connectedAccounts : [];
  const account = accounts.find((entry) => normalizeEmail(entry.email) === normalizedEmail);

  return {
    status: account ? "connected" : normalizedEmail ? "not_connected" : "unknown_account",
    accountEmail: normalizedEmail,
    account: account || null,
    connectedAccounts: accounts
  };
}

function getClientFromUrl(url) {
  if (/outlook\.|office365\./i.test(url)) return "Outlook";
  if (/mail\.google\.com/i.test(url)) return "Gmail";
  return "";
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
