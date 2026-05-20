const fallbackState = {
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
  summary: { sent: 1, opened: 1, unopened: 0, clicked: 0, attachmentOpened: 1, openRate: 100 }
};

let currentState = fallbackState;
let currentFilter = "all";
let currentSearch = "";
let popupRefreshTimer = null;
let realtimeSource = null;
let activeRealtimeUrl = null;
let realtimeConnected = false;
let lastFullStateRefreshAt = 0;
let openMessageIds = new Set();

const POPUP_REFRESH_MS = 2500;
const REALTIME_HEALTH_REFRESH_MS = 5 * 60 * 1000;

const elements = {
  openRate: document.querySelector("#openRate"),
  sentCount: document.querySelector("#sentCount"),
  openedCount: document.querySelector("#openedCount"),
  unopenedCount: document.querySelector("#unopenedCount"),
  clickedCount: document.querySelector("#clickedCount"),
  attachmentCount: document.querySelector("#attachmentCount"),
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

  elements.openOptions.addEventListener("click", () => {
    if (globalThis.chrome?.runtime?.openOptionsPage) {
      chrome.runtime.openOptionsPage();
    }
  });

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
  const response = await sendMessage({ type: "simpleTrack:getState" });
  if (!response?.ok) return fallbackState;
  lastFullStateRefreshAt = Date.now();
  return response;
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
  const { summary, settings } = currentState;

  elements.openRate.textContent = `${summary.openRate}%`;
  elements.sentCount.textContent = summary.sent;
  elements.openedCount.textContent = summary.opened;
  elements.unopenedCount.textContent = summary.unopened;
  elements.clickedCount.textContent = summary.clicked;
  elements.attachmentCount.textContent = summary.attachmentOpened || 0;
  elements.trackingToggle.checked = Boolean(settings.trackingEnabled);

  renderMessages();
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
    node.dataset.messageId = message.id;
    node.open = openMessageIds.has(message.id);
    node.classList.toggle("is-opened", message.opens > 0);
    node.classList.toggle("is-clicked", message.clicks > 0);
    node.classList.toggle("is-attachment-opened", message.attachmentOpens > 0);
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

  if (message.clicks > 0) return { key: "clicked", label: `${openLabel} / ${clickLabel} / ${fileLabel}`, shortLabel: "Clicked" };
  if (message.attachmentOpens > 0) return { key: "opened", label: `${openLabel} / ${clickLabel} / ${fileLabel}`, shortLabel: "File opened" };
  if (message.opens > 0) return { key: "opened", label: `${openLabel} / ${clickLabel} / ${fileLabel}`, shortLabel: "Opened" };
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
  if (status.key === "clicked") {
    return `had a link clicked ${formatRelativeDate(message.lastActivityAt)} at ${formatTime(message.lastActivityAt)}`;
  }

  if (message.attachmentOpens > 0 && getLastEventType(message) === "attachment_open") {
    return `had a file opened ${formatRelativeDate(message.lastActivityAt)} at ${formatTime(message.lastActivityAt)}`;
  }

  if (status.key === "opened") {
    return `was last opened ${formatRelativeDate(message.lastActivityAt)} at ${formatTime(message.lastActivityAt)}`;
  }

  return "has not been opened yet";
}

function renderEventTimeline(node, message) {
  const timeline = node.querySelector(".event-timeline");
  const eventCount = node.querySelector(".event-count");
  const events = Array.isArray(message.events) ? message.events : [];

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
  const events = Array.isArray(message.events) ? message.events : [];
  return events[0]?.type || "";
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
