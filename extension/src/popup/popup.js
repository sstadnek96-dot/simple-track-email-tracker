const fallbackState = {
  messages: [
    {
      id: "preview",
      subject: "Question About Lawncare From Your Webpage",
      recipients: ["gardening@usask.ca", "gardenline@usask.ca"],
      status: "opened",
      opens: 3,
      clicks: 0,
      lastActivityAt: "2026-05-18T18:44:14.000Z",
      sentAt: "2026-05-18T17:09:25.000Z",
      muted: false
    }
  ],
  settings: { trackingEnabled: true },
  summary: { sent: 1, opened: 1, unopened: 0, clicked: 0, openRate: 100 }
};

let currentState = fallbackState;
let currentFilter = "all";
let currentSearch = "";

const elements = {
  openRate: document.querySelector("#openRate"),
  sentCount: document.querySelector("#sentCount"),
  openedCount: document.querySelector("#openedCount"),
  unopenedCount: document.querySelector("#unopenedCount"),
  clickedCount: document.querySelector("#clickedCount"),
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
  render();

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
}

async function getState() {
  const response = await sendMessage({ type: "simpleTrack:getState" });
  if (!response?.ok) return fallbackState;
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

function render() {
  const { summary, settings } = currentState;

  elements.openRate.textContent = `${summary.openRate}%`;
  elements.sentCount.textContent = summary.sent;
  elements.openedCount.textContent = summary.opened;
  elements.unopenedCount.textContent = summary.unopened;
  elements.clickedCount.textContent = summary.clicked;
  elements.trackingToggle.checked = Boolean(settings.trackingEnabled);

  renderMessages();
}

function renderMessages() {
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
    node.classList.toggle("is-opened", message.opens > 0);
    node.classList.toggle("is-clicked", message.clicks > 0);

    const status = getStatus(message);
    const statusPill = node.querySelector(".status-pill");
    statusPill.classList.add(status.key);
    statusPill.textContent = status.label;

    node.querySelector("time").textContent = formatShortDate(message.lastActivityAt || message.sentAt);
    node.querySelector(".recipients").textContent = getRecipientLabel(message);
    renderActivity(node.querySelector(".activity"), message, status);
    node.querySelector(".opens").textContent = String(message.opens);
    node.querySelector(".clicks").textContent = String(message.clicks);
    node.querySelector(".status-value").textContent = status.shortLabel;
    node.querySelector(".subject").textContent = message.subject;
    node.querySelector(".last-activity").textContent = formatDetailedDate(message.lastActivityAt) || "Not opened yet";
    node.querySelector(".device").textContent = message.device || "Pending";
    node.querySelector(".location").textContent = message.location || "Unknown";

    const muteButton = node.querySelector(".mute-button");
    muteButton.textContent = message.muted ? "Muted" : "Mute";
    muteButton.addEventListener("click", () => toggleMuted(message.id, !message.muted));

    elements.activityList.append(node);
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

function matchesFilter(message) {
  if (currentFilter === "opened") return message.opens > 0;
  if (currentFilter === "unopened") return message.opens === 0;
  if (currentFilter === "clicked") return message.clicks > 0;
  return true;
}

function matchesSearch(message) {
  if (!currentSearch) return true;
  const haystack = [message.subject, ...message.recipients].join(" ").toLowerCase();
  return haystack.includes(currentSearch);
}

function getStatus(message) {
  if (message.clicks > 0) return { key: "clicked", label: `${message.clicks} click${message.clicks === 1 ? "" : "s"}`, shortLabel: "Clicked" };
  if (message.opens > 0) return { key: "opened", label: `${message.opens} open${message.opens === 1 ? "" : "s"}`, shortLabel: "Opened" };
  return { key: "sent", label: "Sent, not read", shortLabel: "Unread" };
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
    return `had a link clicked ${formatRelativeDate(message.lastActivityAt)}`;
  }

  if (status.key === "opened") {
    return `was last opened ${formatRelativeDate(message.lastActivityAt)}`;
  }

  return "has not been opened yet";
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
