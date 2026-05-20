(() => {
  if (window.__simpleTrackEmailTrackerLoaded) return;
  window.__simpleTrackEmailTrackerLoaded = true;

  const SELECTORS = {
    gmailRows: [
      "tr.zA",
      "tr[role='row']",
      "div[role='main'] div[role='listitem']"
    ],
    outlookRows: [
      "div[role='listitem']",
      "div[role='option']",
      "div[aria-label*='message' i]"
    ],
    gmailSendButtons: [
      "div[role='dialog'] div[role='button'][data-tooltip*='Send' i]",
      "div[role='dialog'] div[role='button'][aria-label*='Send' i]"
    ],
    outlookSendButtons: [
      "button[aria-label*='Send' i]",
      "div[role='button'][aria-label*='Send' i]"
    ]
  };
  const BADGE_VERSION = "4";
  const ROW_TIME_MATCH_WINDOW_MS = 75 * 1000;
  const ACTIVE_STATE_REFRESH_MS = 2500;
  const BACKGROUND_STATE_REFRESH_MS = 30000;
  const HOVER_STATE_REFRESH_MS = 1500;
  const DOCUMENT_EXTENSION_PATTERN = /\.(pdf|docx?|xlsx?|pptx?|csv|rtf|txt|pages|numbers|key)(?:$|[?#])/i;
  const DOCUMENT_LABEL_PATTERN = /\.(pdf|docx?|xlsx?|pptx?|csv|rtf|txt|pages|numbers|key)\b/i;

  let cachedMessages = [];
  let cachedSettings = {};
  let decorateQueued = false;
  let activeHoverCard = null;
  let activeHoverAnchor = null;
  let hoverCloseTimer = null;
  let rowMatchRetryTimer = null;
  let stateRefreshTimer = null;
  let stateRefreshInFlight = null;
  let realtimeSource = null;
  let activeRealtimeUrl = null;
  let lastHoverStateRefreshAt = 0;
  let lastLocation = location.href;

  init();

  async function init() {
    await refreshState();
    decoratePage();

    const observer = new MutationObserver(() => {
      if (activeHoverAnchor && !activeHoverAnchor.isConnected) {
        hideHoverCard();
      }
      queueDecorate();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    window.addEventListener("scroll", hideHoverCard, true);
    window.addEventListener("resize", hideHoverCard);
    window.addEventListener("hashchange", hideHoverCard);
    window.addEventListener("popstate", hideHoverCard);
    document.addEventListener("pointerdown", hideHoverCardUnlessInsideHover, true);
    document.addEventListener("click", hideHoverCardUnlessInsideHover, true);
    document.addEventListener("mousemove", handleGlobalPointerMove, true);
    document.addEventListener("pointermove", handleGlobalPointerMove, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") hideHoverCard();
    }, true);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        closeRealtimeStream();
      } else {
        syncRealtimeStream(activeRealtimeUrl);
      }
      scheduleStateRefresh(document.hidden ? BACKGROUND_STATE_REFRESH_MS : 250);
    });

    if (globalThis.chrome?.storage?.onChanged) {
      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (areaName !== "local") return;
        if (changes["simpleTrack.messages"] || changes["simpleTrack.settings"]) {
          refreshState().then(queueDecorate);
        }
      });
    }

    scheduleStateRefresh(ACTIVE_STATE_REFRESH_MS);
  }

  async function refreshState() {
    const response = await sendMessage({ type: "simpleTrack:getState" });
    if (!response?.ok) return;
    cachedMessages = response.messages || [];
    cachedSettings = response.settings || {};
    syncRealtimeStream(response.realtimeUrl);
  }

  function syncRealtimeStream(nextUrl) {
    activeRealtimeUrl = nextUrl || null;

    if (!activeRealtimeUrl || !cachedSettings.trackingEnabled || document.hidden || !globalThis.EventSource) {
      closeRealtimeStream();
      return;
    }

    if (realtimeSource && realtimeSource.url === activeRealtimeUrl) return;

    closeRealtimeStream();

    realtimeSource = new EventSource(activeRealtimeUrl);
    realtimeSource.addEventListener("message", (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (payload?.message) {
          applyRealtimeMessage(payload.message);
        }
      } catch (error) {
        console.warn("Simple Track realtime event was not readable", error);
      }
    });
    realtimeSource.addEventListener("stream-error", () => {
      closeRealtimeStream();
    });
  }

  function closeRealtimeStream() {
    if (!realtimeSource) return;
    realtimeSource.close();
    realtimeSource = null;
  }

  function applyRealtimeMessage(message) {
    if (!message?.id) return;

    const existingIndex = cachedMessages.findIndex((trackedMessage) => trackedMessage.id === message.id);
    const existingMessage = existingIndex >= 0 ? cachedMessages[existingIndex] : null;
    const nextMessage = {
      ...existingMessage,
      ...message,
      rowMatchAfter: existingMessage?.rowMatchAfter || message.rowMatchAfter || null,
      muted: existingMessage?.muted ?? Boolean(message.muted)
    };

    if (existingIndex >= 0) {
      cachedMessages = cachedMessages.map((trackedMessage, index) => index === existingIndex ? nextMessage : trackedMessage);
    } else {
      cachedMessages = [nextMessage, ...cachedMessages];
    }

    cachedMessages.sort(compareMessagesByActivity);
    queueDecorate();
    refreshActiveHoverCard();
  }

  function scheduleStateRefresh(delay = getStateRefreshDelay()) {
    if (stateRefreshTimer) {
      window.clearTimeout(stateRefreshTimer);
      stateRefreshTimer = null;
    }

    stateRefreshTimer = window.setTimeout(async () => {
      stateRefreshTimer = null;
      await refreshStateAndDecorate();
      scheduleStateRefresh();
    }, delay);
  }

  async function refreshStateAndDecorate() {
    if (lastLocation !== location.href) {
      lastLocation = location.href;
      hideHoverCard();
    }

    if (document.hidden) return;
    await refreshStateOnce();
    queueDecorate();
    refreshActiveHoverCard();
  }

  function refreshStateOnce() {
    if (!stateRefreshInFlight) {
      stateRefreshInFlight = refreshState().finally(() => {
        stateRefreshInFlight = null;
      });
    }

    return stateRefreshInFlight;
  }

  function getStateRefreshDelay() {
    if (document.hidden) return BACKGROUND_STATE_REFRESH_MS;
    if (isSentFolderView()) return ACTIVE_STATE_REFRESH_MS;
    return BACKGROUND_STATE_REFRESH_MS;
  }

  function queueDecorate() {
    if (decorateQueued) return;
    decorateQueued = true;
    window.requestAnimationFrame(() => {
      decorateQueued = false;
      if (activeHoverAnchor && !activeHoverAnchor.isConnected) {
        hideHoverCard();
      }
      decoratePage();
    });
  }

  function decoratePage() {
    removeLegacyComposeControls();
    if (!cachedSettings.trackingEnabled) return;
    decorateMessageRows();
    decorateComposeToolbars();
  }

  function removeLegacyComposeControls() {
    document.querySelectorAll(".simple-track-compose-toggle").forEach((control) => control.remove());
  }

  function decorateMessageRows() {
    removeLegacyBadges();
    removeBadgesOutsideSentView();
    if (!isSentFolderView()) return;

    schedulePendingRowMatchRetry();

    const rows = getMessageRows().slice(0, 120);
    const assignmentCounts = new Map();

    for (const row of rows) {
      if (!isLikelyMessageRow(row)) continue;

      const message = findMessageForRow(row, assignmentCounts);
      if (!message) continue;
      if (message.opens === 0 && cachedSettings.showUnreadDots === false) continue;
      if (message.opens > 0 && cachedSettings.showOpenedChecks === false) continue;

      const target = findDateCell(row);
      if (!target) continue;

      const badge = getOrCreateInlineBadge(target, message);
      updateRowBadge(badge, message);
    }
  }

  function decorateComposeToolbars() {
    const sendButtons = getSendButtons().slice(0, 12);

    for (const sendButton of sendButtons) {
      if (sendButton.dataset.simpleTrackSendBound === "true") continue;
      if (!isPrimarySendButton(sendButton)) continue;

      sendButton.dataset.simpleTrackSendBound = "true";

      sendButton.addEventListener(
        "click",
        async (event) => {
          if (cachedSettings.autoTrackNewMessages === false) return;

          if (sendButton.dataset.simpleTrackPrepared === "true") {
            delete sendButton.dataset.simpleTrackPrepared;
            return;
          }

          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();

          const composeRoot = getComposeRoot(sendButton);
          if (composeRoot.dataset.simpleTrackPreparing === "true") return;
          composeRoot.dataset.simpleTrackPreparing = "true";

          const details = extractComposeDetails(composeRoot);

          try {
            const response = await sendMessage({
              type: "simpleTrack:createTrackedMessage",
              subject: details.subject,
              recipients: details.recipients,
              client: getClientName()
            });

            if (response?.ok) {
              injectTrackingAssets(composeRoot, response.tracking);
            }
          } catch (error) {
            console.warn("Simple Track could not prepare tracking before send", error);
          }

          sendButton.dataset.simpleTrackPrepared = "true";

          window.setTimeout(() => {
            sendButton.click();
          }, 250);

          window.setTimeout(() => {
            delete sendButton.dataset.simpleTrackPrepared;
            delete composeRoot.dataset.simpleTrackPreparing;
          }, 3000);
        },
        true
      );
    }
  }

  function getMessageRows() {
    const selectorList = isOutlook()
      ? [...SELECTORS.outlookRows, ...SELECTORS.gmailRows]
      : [...SELECTORS.gmailRows, ...SELECTORS.outlookRows];

    return uniqueElements(selectorList.flatMap((selector) => [...document.querySelectorAll(selector)]));
  }

  function getSendButtons() {
    const selectorList = isOutlook()
      ? [...SELECTORS.outlookSendButtons, ...SELECTORS.gmailSendButtons]
      : [...SELECTORS.gmailSendButtons, ...SELECTORS.outlookSendButtons];

    return uniqueElements(selectorList.flatMap((selector) => [...document.querySelectorAll(selector)]));
  }

  function uniqueElements(elements) {
    return [...new Set(elements)].filter((element) => element instanceof HTMLElement);
  }

  function removeBadgesOutsideSentView() {
    if (isSentFolderView()) return;
    document.querySelectorAll(".simple-track-row-badge").forEach((badge) => badge.remove());
    document.querySelectorAll(".simple-track-status-cell").forEach((cell) => cell.remove());
  }

  function removeLegacyBadges() {
    document.querySelectorAll(".simple-track-row-badge").forEach((badge) => {
      if (!badge.closest(".simple-track-status-cell")) {
        badge.remove();
      }
    });
  }

  function isSentFolderView() {
    const url = decodeURIComponent(location.href).toLowerCase();

    if (isOutlook()) {
      return /sentitems|sent items|\/sent\b|folderid=sent|folder\/sent/.test(url);
    }

    return /[#/]sent(?:[/?&]|$)/.test(url);
  }

  function isPrimarySendButton(element) {
    const label = normalizeText([
      element.getAttribute("aria-label"),
      element.getAttribute("data-tooltip"),
      element.getAttribute("title"),
      element.textContent
    ].filter(Boolean).join(" "));

    if (!label.includes("send")) return false;
    if (/(more|option|schedule|later|arrow|dropdown)/.test(label)) return false;
    return true;
  }

  function isLikelyMessageRow(row) {
    const text = normalizeText(row.innerText);
    if (text.length < 3 || text.length > 1200) return false;
    if (text.includes("simple track")) return false;
    return Boolean(findMessageForRow(row));
  }

  function findMessageForRow(row, assignmentCounts = null) {
    const text = normalizeText(row.innerText);
    const subjectText = getRowSubjectText(row);
    const matchedSubject = getBestMatchedSubject(text, subjectText);
    const subjectCandidates = matchedSubject
      ? cachedMessages
        .filter(isMessageReadyForRowMatching)
        .filter((message) => normalizeText(message.subject) === matchedSubject)
      : [];

    const rowDate = getRowDateInfo(row);
    const candidates = filterCandidatesByRowDate(subjectCandidates, rowDate);

    if (candidates.length === 0) return null;

    const sortedCandidates = [...candidates].sort(compareMessagesBySentAt);

    if (!assignmentCounts) return sortedCandidates[0];

    const assignmentKey = getRowAssignmentKey(text, matchedSubject, sortedCandidates, rowDate);
    const assignedCount = assignmentCounts.get(assignmentKey) || 0;
    const message = sortedCandidates[assignedCount] || null;

    assignmentCounts.set(assignmentKey, assignedCount + 1);
    return message;
  }

  function getRowSubjectText(row) {
    const selectors = [
      ".bog",
      ".bqe",
      ".y6",
      "[data-testid*='subject' i]",
      "[aria-label*='subject' i]"
    ];

    const element = selectors
      .map((selector) => row.querySelector(selector))
      .find((candidate) => candidate instanceof HTMLElement && normalizeText(candidate.textContent));

    return element ? normalizeText(element.textContent) : "";
  }

  function getBestMatchedSubject(rowText, subjectText = "") {
    const subjects = cachedMessages
      .map((message) => normalizeText(message.subject))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);

    if (subjectText) {
      return subjects.find((subject) => subjectText === subject) ||
        subjects.find((subject) => subject.length >= 8 && textIncludesPhrase(subjectText, subject)) ||
        "";
    }

    return subjects.find((subject) => textIncludesPhrase(rowText, subject)) || "";
  }

  function getRowAssignmentKey(text, subject, candidates, rowDate = null) {
    const recipient = candidates
      .flatMap((message) => message.recipients)
      .map(normalizeText)
      .find((normalizedRecipient) => normalizedRecipient && text.includes(normalizedRecipient));
    const dateKey = rowDate
      ? `${rowDate.granularity}:${rowDate.date.toISOString()}`
      : "any-date";

    return `${subject || "recipient-only"}|${recipient || "any-recipient"}|${dateKey}`;
  }

  function compareMessagesBySentAt(a, b) {
    return getTimeValue(b.sentAt) - getTimeValue(a.sentAt);
  }

  function compareMessagesByActivity(a, b) {
    const aTime = getTimeValue(a.lastActivityAt || a.sentAt);
    const bTime = getTimeValue(b.lastActivityAt || b.sentAt);
    return bTime - aTime;
  }

  function isMessageReadyForRowMatching(message) {
    if (!message.rowMatchAfter) return true;
    return Date.now() >= getTimeValue(message.rowMatchAfter);
  }

  function schedulePendingRowMatchRetry() {
    if (rowMatchRetryTimer) {
      window.clearTimeout(rowMatchRetryTimer);
      rowMatchRetryTimer = null;
    }

    const now = Date.now();
    const nextTime = cachedMessages
      .map((message) => getTimeValue(message.rowMatchAfter))
      .filter((time) => time > now)
      .sort((a, b) => a - b)[0];

    if (!nextTime) return;

    rowMatchRetryTimer = window.setTimeout(() => {
      rowMatchRetryTimer = null;
      queueDecorate();
    }, Math.max(100, nextTime - now + 100));
  }

  function filterCandidatesByRowDate(candidates, rowDate) {
    if (!rowDate) return candidates;

    return candidates.filter((message) => messageMatchesRowDate(message, rowDate));
  }

  function getRowDateInfo(row) {
    const dateCell = findDateCell(row);
    return dateCell ? parseRowDateText(dateCell.textContent) : null;
  }

  function parseRowDateText(value) {
    const text = normalizeText(value);
    if (!text) return null;

    const now = new Date();
    const timeMatch = text.match(/\b(\d{1,2}):(\d{2})\s?(am|pm)?\b/);
    if (timeMatch) {
      let hour = Number(timeMatch[1]);
      const minute = Number(timeMatch[2]);
      const meridiem = timeMatch[3];

      if (meridiem === "pm" && hour < 12) hour += 12;
      if (meridiem === "am" && hour === 12) hour = 0;

      return {
        date: new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, minute),
        granularity: "minute"
      };
    }

    if (text === "today") {
      return {
        date: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
        granularity: "day"
      };
    }

    if (text === "yesterday") {
      return {
        date: new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1),
        granularity: "day"
      };
    }

    const monthMatch = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+(\d{1,2})\b/);
    if (monthMatch) {
      const month = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"].indexOf(monthMatch[1]);
      const day = Number(monthMatch[2]);
      let date = new Date(now.getFullYear(), month, day);

      if (date.getTime() - now.getTime() > 14 * 24 * 60 * 60 * 1000) {
        date = new Date(now.getFullYear() - 1, month, day);
      }

      return { date, granularity: "day" };
    }

    const slashMatch = text.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/);
    if (slashMatch) {
      const month = Number(slashMatch[1]) - 1;
      const day = Number(slashMatch[2]);
      const yearText = slashMatch[3];
      const year = yearText
        ? Number(yearText.length === 2 ? `20${yearText}` : yearText)
        : now.getFullYear();

      return {
        date: new Date(year, month, day),
        granularity: "day"
      };
    }

    return null;
  }

  function messageMatchesRowDate(message, rowDate) {
    const sentAt = new Date(message.sentAt || 0);
    if (!Number.isFinite(sentAt.getTime())) return false;

    if (rowDate.granularity === "minute") {
      return Math.abs(sentAt.getTime() - rowDate.date.getTime()) <= ROW_TIME_MATCH_WINDOW_MS;
    }

    return isSameLocalDate(sentAt, rowDate.date);
  }

  function isSameLocalDate(a, b) {
    return (
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate()
    );
  }

  function findDateCell(row) {
    const cells = [...row.querySelectorAll("td, [role='gridcell']")]
      .filter((cell) => cell instanceof HTMLElement)
      .filter((cell) => !cell.classList.contains("simple-track-status-cell"))
      .filter((cell) => {
        const rect = cell.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });

    const dateLikeCells = cells
      .filter((cell) => looksLikeDateCell(cell))
      .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right);

    if (dateLikeCells[0]) return dateLikeCells[0];

    return cells.sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] || null;
  }

  function looksLikeDateCell(cell) {
    const text = normalizeText(cell.textContent);
    if (!text || text.length > 40) return false;

    return (
      /\b\d{1,2}:\d{2}\s?(am|pm)?\b/.test(text) ||
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}\b/.test(text) ||
      /\b(mon|tue|wed|thu|fri|sat|sun)\b/.test(text) ||
      /\b(yesterday|today)\b/.test(text) ||
      /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/.test(text)
    );
  }

  function getOrCreateInlineBadge(target, message) {
    const markerHost = getOrCreateMarkerHost(target);
    bindMarkerHostHover(markerHost);
    const existingBadge = markerHost.querySelector(".simple-track-row-badge");
    if (existingBadge) {
      if (existingBadge.dataset.simpleTrackVersion === BADGE_VERSION) {
        return existingBadge;
      }
      existingBadge.remove();
    }

    const badge = createRowBadge(message);
    markerHost.append(badge);
    return badge;
  }

  function bindMarkerHostHover(markerHost) {
    if (markerHost.dataset.simpleTrackHoverBound === "true") return;
    markerHost.dataset.simpleTrackHoverBound = "true";

    const showHoverFromHost = (event) => {
      stopGmailHoverUi(event);
      const badge = markerHost.querySelector(".simple-track-row-badge");
      if (badge) showHoverCardForBadge(badge);
    };

    markerHost.addEventListener("mouseover", showHoverFromHost, true);
    markerHost.addEventListener("mouseenter", showHoverFromHost, true);
    markerHost.addEventListener("pointerover", showHoverFromHost, true);
    markerHost.addEventListener("mousemove", stopGmailHoverUi, true);
    markerHost.addEventListener("pointermove", stopGmailHoverUi, true);
    markerHost.addEventListener("mouseleave", scheduleHoverCardClose);
    markerHost.addEventListener("pointerleave", scheduleHoverCardClose);
  }

  function getOrCreateMarkerHost(target) {
    const row = target.closest("tr");

    if (row && target.tagName === "TD") {
      const existingHosts = [...row.querySelectorAll(":scope > .simple-track-status-cell")];
      const existingHost = existingHosts[0];
      existingHosts.slice(1).forEach((host) => host.remove());

      if (existingHost) {
        if (target.nextElementSibling !== existingHost) {
          target.insertAdjacentElement("afterend", existingHost);
        }
        return existingHost;
      }

      const statusCell = document.createElement("td");
      statusCell.className = "simple-track-status-cell";
      statusCell.setAttribute("aria-label", "Simple Track status");
      target.insertAdjacentElement("afterend", statusCell);
      return statusCell;
    }

    let existingHost = target.querySelector(":scope > .simple-track-status-cell");
    if (existingHost) return existingHost;

    existingHost = document.createElement("span");
    existingHost.className = "simple-track-status-cell";
    target.append(existingHost);
    return existingHost;
  }

  function createRowBadge(message) {
    const state = getMessageState(message);
    const badge = document.createElement("span");
    badge.className = "simple-track-row-badge";
    badge.dataset.simpleTrackMessageId = message.id;
    badge.dataset.simpleTrackVersion = BADGE_VERSION;
    badge.setAttribute("role", "img");
    const showHoverAndStopGmail = (event) => {
      stopGmailHoverUi(event);
      showHoverCardForBadge(badge);
    };
    badge.addEventListener("mouseover", showHoverAndStopGmail, true);
    badge.addEventListener("mousemove", stopGmailHoverUi, true);
    badge.addEventListener("mouseenter", showHoverAndStopGmail, true);
    badge.addEventListener("pointerover", showHoverAndStopGmail, true);
    badge.addEventListener("pointermove", stopGmailHoverUi, true);
    badge.addEventListener("mouseleave", scheduleHoverCardClose);
    badge.addEventListener("pointerleave", scheduleHoverCardClose);

    const glyph = document.createElement("span");
    glyph.className = "simple-track-glyph";

    badge.append(glyph);
    updateRowBadge(badge, message);
    return badge;
  }

  function updateRowBadge(badge, message) {
    const state = getMessageState(message);
    badge.dataset.simpleTrackState = state.key;
    badge.dataset.simpleTrackCompact = String(Boolean(cachedSettings.compactRows));
    badge.dataset.simpleTrackMessageId = message.id;
    badge.setAttribute("aria-label", state.label);
  }

  function stopGmailHoverUi(event) {
    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  }

  function showHoverCard(anchor, message, state) {
    clearHoverCloseTimer();

    if (activeHoverCard && activeHoverAnchor === anchor) {
      activeHoverCard.replaceChildren(createHoverCardContent(message, state));
      positionHoverCard(anchor, activeHoverCard);
      return;
    }

    hideHoverCard();

    const hoverCard = document.createElement("span");
    hoverCard.className = "simple-track-hover-card";
    hoverCard.append(createHoverCardContent(message, state));
    hoverCard.addEventListener("mouseenter", clearHoverCloseTimer);
    hoverCard.addEventListener("mouseleave", scheduleHoverCardClose);
    hoverCard.addEventListener("pointerenter", clearHoverCloseTimer);
    hoverCard.addEventListener("pointerleave", scheduleHoverCardClose);
    document.body.append(hoverCard);

    positionHoverCard(anchor, hoverCard);
    activeHoverCard = hoverCard;
    activeHoverAnchor = anchor;
  }

  function positionHoverCard(anchor, hoverCard) {
    const anchorRect = anchor.getBoundingClientRect();
    const cardRect = hoverCard.getBoundingClientRect();
    const left = Math.min(
      Math.max(8, anchorRect.right - cardRect.width + 16),
      window.innerWidth - cardRect.width - 8
    );
    const top = Math.min(anchorRect.bottom + 10, window.innerHeight - cardRect.height - 8);

    hoverCard.style.left = `${left}px`;
    hoverCard.style.top = `${top}px`;
  }

  function showHoverCardForBadge(badge) {
    const message = cachedMessages.find((trackedMessage) => trackedMessage.id === badge.dataset.simpleTrackMessageId);
    if (!message) return;
    showHoverCard(badge, message, getMessageState(message));
    refreshHoverStateForBadge(badge);
  }

  async function refreshHoverStateForBadge(badge) {
    const now = Date.now();
    if (now - lastHoverStateRefreshAt < HOVER_STATE_REFRESH_MS) return;
    lastHoverStateRefreshAt = now;

    await refreshStateOnce();
    queueDecorate();

    if (activeHoverAnchor !== badge || !activeHoverCard || !badge.isConnected) return;
    refreshActiveHoverCard();
  }

  function refreshActiveHoverCard() {
    if (!activeHoverCard || !activeHoverAnchor) return;
    const message = cachedMessages.find((trackedMessage) => trackedMessage.id === activeHoverAnchor.dataset.simpleTrackMessageId);
    if (!message) return;
    showHoverCard(activeHoverAnchor, message, getMessageState(message));
  }

  function hideHoverCard() {
    clearHoverCloseTimer();
    if (!activeHoverCard) return;
    activeHoverCard.remove();
    activeHoverCard = null;
    activeHoverAnchor = null;
  }

  function scheduleHoverCardClose() {
    clearHoverCloseTimer();
    hoverCloseTimer = window.setTimeout(() => {
      hideHoverCard();
    }, 60);
  }

  function clearHoverCloseTimer() {
    if (!hoverCloseTimer) return;
    window.clearTimeout(hoverCloseTimer);
    hoverCloseTimer = null;
  }

  function hideHoverCardUnlessInsideHover(event) {
    if (!activeHoverCard || !activeHoverAnchor) return;
    if (activeHoverCard.contains(event.target) || activeHoverAnchor.contains(event.target)) return;
    hideHoverCard();
  }

  function handleGlobalPointerMove(event) {
    const badge = findBadgeAtPoint(event.clientX, event.clientY);

    if (badge) {
      stopGmailHoverUi(event);
      showHoverCardForBadge(badge);
      return;
    }

    hideHoverCardWhenPointerLeaves(event);
  }

  function findBadgeAtPoint(clientX, clientY) {
    const badges = [...document.querySelectorAll(".simple-track-row-badge")]
      .filter((badge) => badge instanceof HTMLElement);

    return badges.find((badge) => {
      const host = badge.closest(".simple-track-status-cell");
      const hostRect = host?.getBoundingClientRect();
      const badgeRect = badge.getBoundingClientRect();
      return (
        (hostRect && isPointInsideRect(clientX, clientY, hostRect, 6)) ||
        isPointInsideRect(clientX, clientY, badgeRect, 10)
      );
    }) || null;
  }

  function isPointInsideRect(clientX, clientY, rect, padding = 0) {
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      clientX >= rect.left - padding &&
      clientX <= rect.right + padding &&
      clientY >= rect.top - padding &&
      clientY <= rect.bottom + padding
    );
  }

  function hideHoverCardWhenPointerLeaves(event) {
    if (!activeHoverCard || !activeHoverAnchor) return;
    const target = event.target;
    if (activeHoverCard.contains(target) || activeHoverAnchor.contains(target)) return;

    const anchorRect = activeHoverAnchor.getBoundingClientRect();
    const cardRect = activeHoverCard.getBoundingClientRect();
    const padding = 8;
    const withinAnchor =
      event.clientX >= anchorRect.left - padding &&
      event.clientX <= anchorRect.right + padding &&
      event.clientY >= anchorRect.top - padding &&
      event.clientY <= anchorRect.bottom + padding;
    const withinCard =
      event.clientX >= cardRect.left - padding &&
      event.clientX <= cardRect.right + padding &&
      event.clientY >= cardRect.top - padding &&
      event.clientY <= cardRect.bottom + padding;

    if (!withinAnchor && !withinCard) {
      hideHoverCard();
    }
  }

  function createHoverCardContent(message, state) {
    const fragment = document.createDocumentFragment();

    const title = document.createElement("p");
    title.className = "simple-track-hover-title";
    title.textContent = message.subject;

    const status = document.createElement("span");
    status.className = "simple-track-hover-status";
    status.dataset.simpleTrackState = state.key;
    status.textContent = state.label;

    const grid = document.createElement("span");
    grid.className = "simple-track-hover-grid";
    grid.append(
      createMetric(String(message.opens), "Opens"),
      createMetric(String(message.clicks), "Links"),
      createMetric(String(message.attachmentOpens || 0), "Files")
    );

    const detail = document.createElement("span");
    detail.className = "simple-track-hover-detail";

    detail.append(createDetail("Last activity", formatDateTime(message.lastActivityAt) || "Not opened yet"));

    if (!cachedSettings.privacyMode) {
      detail.append(createDetail("Device", message.device || "Pending"));
    }

    fragment.append(title, status, grid, detail);
    return fragment;
  }

  function createMetric(value, label) {
    const metric = document.createElement("span");
    metric.className = "simple-track-hover-metric";

    const strong = document.createElement("strong");
    strong.textContent = value;

    const caption = document.createElement("span");
    caption.textContent = label;

    metric.append(strong, caption);
    return metric;
  }

  function createDetail(label, value) {
    const detail = document.createElement("span");

    const strong = document.createElement("strong");
    strong.textContent = value;

    const caption = document.createElement("span");
    caption.textContent = label;

    detail.append(strong, caption);
    return detail;
  }

  function getMessageState(message) {
    if (message.clicks > 0) {
      return { key: "clicked", label: `${message.clicks} click${message.clicks === 1 ? "" : "s"}` };
    }

    if (message.opens > 0) {
      return { key: "opened", label: `${message.opens} open${message.opens === 1 ? "" : "s"}` };
    }

    return { key: "sent", label: "Sent, not read" };
  }

  function getComposeRoot(sendButton) {
    return (
      sendButton.closest("div[role='dialog']") ||
      sendButton.closest("form") ||
      sendButton.closest("[aria-label*='Message' i]") ||
      sendButton.parentElement ||
      document.body
    );
  }

  function extractComposeDetails(composeRoot) {
    const subjectSelectors = [
      "input[name='subjectbox']",
      "input[aria-label*='subject' i]",
      "[aria-label*='subject' i][contenteditable='true']"
    ];
    const recipientSelectors = [
      "[email]",
      "span[email]",
      "[data-hovercard-id*='@']",
      "[aria-label*='To' i] span"
    ];

    const subjectElement = subjectSelectors
      .map((selector) => composeRoot.querySelector(selector))
      .find(Boolean);
    const subject = getElementValue(subjectElement) || "Tracked email";

    const recipients = uniqueElements(
      recipientSelectors.flatMap((selector) => [...composeRoot.querySelectorAll(selector)])
    )
      .map((element) => element.getAttribute("email") || element.getAttribute("data-hovercard-id") || element.textContent)
      .map((value) => value.trim())
      .filter((value) => value.includes("@") || value.length > 0)
      .slice(0, 8);

    return { subject, recipients };
  }

  function injectTrackingAssets(composeRoot, tracking) {
    if (!tracking?.pixelUrl) return;

    const body = findComposeBody(composeRoot);
    if (!body) return;

    if (!body.querySelector("img[data-simple-track-pixel='true']")) {
      insertHtmlIntoComposeBody(
        body,
        `<br><img src="${escapeAttribute(tracking.pixelUrl)}" width="1" height="1" alt="" data-simple-track-pixel="true" style="border:0;width:1px;height:1px;">`
      );

      if (!body.querySelector("img[data-simple-track-pixel='true']")) {
        const pixel = document.createElement("img");
        pixel.src = tracking.pixelUrl;
        pixel.width = 1;
        pixel.height = 1;
        pixel.alt = "";
        pixel.dataset.simpleTrackPixel = "true";
        pixel.style.border = "0";
        pixel.style.width = "1px";
        pixel.style.height = "1px";
        body.append(document.createElement("br"), pixel);
      }
    }

    if (cachedSettings.trackClicks !== false && tracking.clickPrefix) {
      wrapComposeLinks(body, tracking.clickPrefix);
    }

    notifyComposeBodyChanged(body);
  }

  function insertHtmlIntoComposeBody(body, html) {
    body.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(body);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);

    if (!document.execCommand || !document.execCommand("insertHTML", false, html)) {
      const template = document.createElement("template");
      template.innerHTML = html;
      body.append(template.content);
    }
  }

  function notifyComposeBodyChanged(body) {
    for (const eventName of ["input", "change", "keyup"]) {
      body.dispatchEvent(new Event(eventName, { bubbles: true }));
    }
  }

  function findComposeBody(composeRoot) {
    const selectors = [
      "div[aria-label='Message Body'][contenteditable='true']",
      "div[aria-label*='message body' i][contenteditable='true']",
      "div[role='textbox'][contenteditable='true']",
      "[contenteditable='true'][aria-multiline='true']",
      "[contenteditable='true']"
    ];

    return selectors
      .map((selector) => composeRoot.querySelector(selector))
      .find((element) => element instanceof HTMLElement && element.offsetParent !== null);
  }

  function wrapComposeLinks(body, clickPrefix) {
    const links = [...body.querySelectorAll("a[href]")];

    for (const link of links) {
      const href = link.getAttribute("href");
      if (!href || link.dataset.simpleTrackWrapped === "true") continue;
      if (!/^https?:\/\//i.test(href)) continue;
      if (href.startsWith(clickPrefix)) continue;

      const label = getLinkLabel(link, href);
      const kind = getLinkKind(href, label);
      link.dataset.simpleTrackOriginalHref = href;
      link.dataset.simpleTrackWrapped = "true";
      link.href = getTrackedClickUrl(clickPrefix, href, label, kind);
    }
  }

  function getTrackedClickUrl(clickPrefix, href, label, kind) {
    const url = `${clickPrefix}${encodeURIComponent(href)}`;
    const params = new URLSearchParams();
    if (label) params.set("l", label);
    if (kind) params.set("k", kind);
    const query = params.toString();
    return query ? `${url}&${query}` : url;
  }

  function getLinkLabel(link, href) {
    const explicitLabel = normalizeWhitespace(
      link.textContent ||
      link.getAttribute("aria-label") ||
      link.getAttribute("title") ||
      link.getAttribute("download")
    );

    if (explicitLabel) return explicitLabel.slice(0, 160);

    const filename = getLinkFileName(href);
    if (filename) return filename.slice(0, 160);

    try {
      return new URL(href).hostname.slice(0, 160);
    } catch {
      return "tracked link";
    }
  }

  function getLinkKind(href, label) {
    if (isPdfLink(href) || /\.pdf\b/i.test(label)) return "pdf";
    if (isDocumentLink(href) || DOCUMENT_LABEL_PATTERN.test(label)) return "document";
    return "link";
  }

  function isPdfLink(href) {
    try {
      return /\.pdf$/i.test(new URL(href).pathname);
    } catch {
      return /\.pdf(?:$|[?#])/i.test(href);
    }
  }

  function isDocumentLink(href) {
    try {
      const url = new URL(href);
      return DOCUMENT_EXTENSION_PATTERN.test(url.pathname) || DOCUMENT_EXTENSION_PATTERN.test(href);
    } catch {
      return DOCUMENT_EXTENSION_PATTERN.test(href);
    }
  }

  function getLinkFileName(href) {
    try {
      const pathname = new URL(href).pathname;
      const filename = pathname.split("/").filter(Boolean).pop();
      return filename ? decodeURIComponent(filename) : "";
    } catch {
      return "";
    }
  }

  function escapeAttribute(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function getElementValue(element) {
    if (!element) return "";
    if ("value" in element) return element.value.trim();
    return element.textContent.trim();
  }

  function getClientName() {
    return isOutlook() ? "Outlook" : "Gmail";
  }

  function isOutlook() {
    return /outlook\./i.test(location.hostname) || /office365\./i.test(location.hostname);
  }

  function normalizeText(value) {
    return String(value || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  function normalizeWhitespace(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function textIncludesPhrase(text, phrase) {
    const escapedPhrase = escapeRegExp(phrase);
    return new RegExp(`(^|[^a-z0-9@._-])${escapedPhrase}($|[^a-z0-9@._-])`, "i").test(text);
  }

  function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function getTimeValue(value) {
    const time = new Date(value || 0).getTime();
    return Number.isFinite(time) ? time : 0;
  }

  function formatDateTime(value) {
    if (!value) return "";
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(value));
  }

  async function sendMessage(message) {
    if (!globalThis.chrome?.runtime?.sendMessage) return null;

    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      console.warn("Simple Track content script message failed", error);
      return null;
    }
  }
})();
