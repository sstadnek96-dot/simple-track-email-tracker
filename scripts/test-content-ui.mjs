import { chromium } from "playwright";
import path from "node:path";

const root = process.cwd();
const contentScriptPath = path.join(root, "extension/src/content/email-tracker-content.js");
const contentCssPath = path.join(root, "extension/src/content/email-tracker-content.css");

const browser = await chromium.launch({ headless: true });

try {
  await testUnconnectedGmailAccountShowsEnablePrompt();
  await testKnownGmailAccountShowsLoginPrompt();
  await testPopupCanDetectActiveMailAccount();
  await testInvalidatedExtensionContextIsQuiet();
  await testTrackingArmsPixelAndActivatesQuickly();
  await testDuplicateSubjectsMapToDistinctRows();
  await testBadgeDoesNotRegressFromStaleStorage();
  await testPendingMessagesDoNotBindToRows();
  console.log("Content UI automation passed.");
} finally {
  await browser.close();
}

async function testUnconnectedGmailAccountShowsEnablePrompt() {
  const page = await openGmailFixture([], "", {
    activeAccountEmail: "other.account@gmail.com",
    connectedAccounts: [{ email: "s.stadnek96@gmail.com", displayName: "Spencer Stadnek", provider: "google", client: "Gmail" }],
    connectionResponse: {
      ok: true,
      accountStatus: { status: "connected", accountEmail: "other.account@gmail.com" },
      connectedAccounts: [
        { email: "s.stadnek96@gmail.com", displayName: "Spencer Stadnek", provider: "google", client: "Gmail" },
        { email: "other.account@gmail.com", displayName: "Other Account", provider: "google", client: "Gmail" }
      ]
    }
  });

  await page.waitForSelector(".simple-track-account-overlay");
  const promptText = await page.locator(".simple-track-account-overlay").innerText();
  if (!promptText.includes("other.account@gmail.com") || !promptText.includes("Connect this Gmail account to add it to the same workspace")) {
    throw new Error(`Account prompt did not explain the unconnected account:\n${promptText}`);
  }

  await page.getByRole("button", { name: "Enable" }).click();
  await page.waitForFunction(() => window.__simpleTrackStartedConnection === "other.account@gmail.com");
  const connectionMessage = await page.evaluate(() => window.__simpleTrackStartedConnectionMessage);
  if (!connectionMessage?.returnUrl?.includes("https://mail.google.com/")) {
    throw new Error(`Connection did not include the current mail return URL:\n${JSON.stringify(connectionMessage, null, 2)}`);
  }
  await page.waitForSelector(".simple-track-account-overlay", { state: "detached" });
  await page.close();
}

async function testKnownGmailAccountShowsLoginPrompt() {
  const page = await openGmailFixture([], "", {
    activeAccountEmail: "spencer.tpp@gmail.com",
    connectedAccounts: [{ email: "s.stadnek96@gmail.com", displayName: "Spencer Stadnek", provider: "google", client: "Gmail" }],
    knownAccounts: [
      { email: "s.stadnek96@gmail.com", displayName: "Spencer Stadnek", provider: "google", client: "Gmail" },
      { email: "spencer.tpp@gmail.com", displayName: "Spencer TPP", provider: "google", client: "Gmail" }
    ],
    connectionResponse: {
      ok: true,
      accountStatus: { status: "connected", accountEmail: "spencer.tpp@gmail.com" },
      connectedAccounts: [
        { email: "s.stadnek96@gmail.com", displayName: "Spencer Stadnek", provider: "google", client: "Gmail" },
        { email: "spencer.tpp@gmail.com", displayName: "Spencer TPP", provider: "google", client: "Gmail" }
      ]
    }
  });

  await page.waitForSelector(".simple-track-account-overlay");
  const promptText = await page.locator(".simple-track-account-overlay").innerText();
  if (!promptText.includes("Log back in to enable email tracking for spencer.tpp@gmail.com") || !promptText.includes("was connected before")) {
    throw new Error(`Known account prompt showed the wrong copy:\n${promptText}`);
  }
  if (await page.getByRole("button", { name: "Log back in" }).count() !== 1) {
    throw new Error("Known account prompt did not expose a Log back in action");
  }

  await page.close();
}

async function testPopupCanDetectActiveMailAccount() {
  const page = await openGmailFixture([], "", {
    activeAccountEmail: "s.stadnek96@gmail.com",
    connectedAccounts: [{ email: "s.stadnek96@gmail.com", displayName: "Spencer Stadnek", provider: "google", client: "Gmail" }]
  });

  const response = await page.evaluate(() => new Promise((resolve) => {
    const listener = window.__simpleTrackRuntimeListeners?.[0];
    listener({ type: "simpleTrack:detectAccount" }, {}, resolve);
  }));

  if (!response?.ok || response.accountEmail !== "s.stadnek96@gmail.com" || response.client !== "Gmail") {
    throw new Error(`Popup account detection returned the wrong active account:\n${JSON.stringify(response, null, 2)}`);
  }

  await page.close();
}

async function testInvalidatedExtensionContextIsQuiet() {
  const page = await openGmailFixture([], "", {
    activeAccountEmail: "s.stadnek96@gmail.com",
    throwRuntimeInvalidated: true
  });

  await page.waitForTimeout(200);
  const warnings = await page.evaluate(() => window.__simpleTrackWarnings || []);
  const invalidatedWarnings = warnings.filter((warning) => (
    warning.includes("Extension context invalidated") ||
    warning.includes("content script message failed")
  ));

  if (invalidatedWarnings.length) {
    throw new Error(`Invalidated extension context was reported as a visible warning:\n${invalidatedWarnings.join("\n")}`);
  }

  await page.close();
}

async function testTrackingArmsPixelAndActivatesQuickly() {
  const page = await openGmailFixture([], "", {
    activeAccountEmail: "s.stadnek96@gmail.com",
    connectedAccounts: [{ email: "s.stadnek96@gmail.com", displayName: "Spencer Stadnek", provider: "google", client: "Gmail" }],
    createTrackedMessageResponse: {
      ok: true,
      message: createMessage("m-new-send", "compose activation test", todayAt(12, 30), 0, null, null),
      tracking: {
        pixelUrl: "https://track.simple.test/pixel?m=m-new-send&t=test-token",
        activationUrl: "https://track.simple.test/api/messages/activate?m=m-new-send&t=test-token"
      }
    },
    activationResponse: {
      ok: true,
      message: createMessage("m-new-send", "compose activation test", todayAt(12, 30), 0, null, null)
    },
    extraHtml: `
      <div role="dialog" aria-label="New Message" style="display:block;width:420px;height:260px;">
        <input name="subjectbox" value="compose activation test" />
        <span email="recipient@example.com">recipient@example.com</span>
        <div aria-label="Message Body" contenteditable="true" style="display:block;min-height:80px;">Hello</div>
        <div role="button" aria-label="Send" data-tooltip="Send" tabindex="0">Send</div>
      </div>
    `
  });

  await page.getByRole("button", { name: "Send" }).click();
  await page.waitForSelector("img[data-simple-track-pixel='true']");

  const pixelState = await page.$eval("img[data-simple-track-pixel='true']", (pixel) => ({
    src: pixel.getAttribute("src"),
    trackingSrc: pixel.getAttribute("data-simple-track-src")
  }));
  if (!pixelState.src || pixelState.src !== pixelState.trackingSrc) {
    throw new Error(`Tracking pixel was not armed before the send click:\n${JSON.stringify(pixelState, null, 2)}`);
  }

  await page.waitForFunction(() => window.__simpleTrackActivationCalls.length === 1, null, { timeout: 1200 });

  await page.close();
}

async function testDuplicateSubjectsMapToDistinctRows() {
  const midLastActivityAt = todayAt(13, 39);
  const messages = [
    createMessage("m-new", "test", todayAt(12, 55), 0, null, null),
    createMessage("m-mid", "test", todayAt(12, 53), 2, "Chrome on Windows", midLastActivityAt),
    createMessage("m-old", "test", todayAt(12, 4), 4, "Firefox on Windows", todayAt(13, 26))
  ];
  const midLastActivityLabel = hoverDateTime(midLastActivityAt);

  const page = await openGmailFixture(messages, `
    ${gmailRow("To: me", "test", "12:55 PM")}
    ${gmailRow("To: me", "test", "12:53 PM")}
    ${gmailRow("To: me", "test", "12:04 PM")}
    ${gmailRow("To: me", "Transcript ready: Logo Integration Test for Web App", "11:44 AM")}
  `);

  const rows = await getRowBadgeState(page);
  assertRow(rows[0], { id: "m-new", state: "sent", label: "Sent, not read", badgeCount: 1 }, "first duplicate row");
  assertRow(rows[1], { id: "m-mid", state: "opened", label: "2 opens", badgeCount: 1 }, "second duplicate row");
  assertRow(rows[2], { id: "m-old", state: "opened", label: "4 opens", badgeCount: 1 }, "third duplicate row");
  assertRow(rows[3], { id: null, state: null, label: null, badgeCount: 0 }, "unrelated test-word row");

  await page.locator(".simple-track-row-badge").nth(0).hover();
  await page.waitForSelector(".simple-track-hover-card");
  let hoverText = await page.locator(".simple-track-hover-card").innerText();
  if (!hoverText.includes("Sent, not read") || !hoverText.includes("Not opened yet")) {
    throw new Error(`First hover card showed the wrong message:\n${hoverText}`);
  }

  await page.locator(".simple-track-row-badge").nth(1).hover();
  await page.waitForFunction(() => document.querySelector(".simple-track-hover-card")?.innerText.includes("2 opens"));
  hoverText = await page.locator(".simple-track-hover-card").innerText();
  if (!hoverText.includes("2 opens") || !hoverText.includes(midLastActivityLabel)) {
    throw new Error(`Second hover card did not replace the first card:\n${hoverText}`);
  }

  const cardCount = await page.locator(".simple-track-hover-card").count();
  if (cardCount !== 1) throw new Error(`Expected exactly one hover card after switching dots, got ${cardCount}`);

  await page.mouse.move(4, 4);
  await page.waitForTimeout(120);
  const remainingCards = await page.locator(".simple-track-hover-card").count();
  if (remainingCards !== 0) throw new Error(`Hover card stayed open after leaving dots, got ${remainingCards}`);

  const overlayPoint = await page.locator(".simple-track-status-cell").nth(1).evaluate((cell) => {
    const rect = cell.getBoundingClientRect();
    const overlay = document.createElement("div");
    overlay.id = "gmail-hover-overlay";
    overlay.style.position = "fixed";
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.zIndex = "2147483647";
    overlay.style.pointerEvents = "auto";
    document.body.append(overlay);
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  });

  await page.mouse.move(overlayPoint.x, overlayPoint.y);
  await page.waitForFunction(() => document.querySelector(".simple-track-hover-card")?.innerText.includes("2 opens"));
  hoverText = await page.locator(".simple-track-hover-card").innerText();
  if (!hoverText.includes("2 opens") || !hoverText.includes(midLastActivityLabel)) {
    throw new Error(`Coordinate hover did not work through an overlay:\n${hoverText}`);
  }

  await page.close();
}

async function testBadgeDoesNotRegressFromStaleStorage() {
  const sentAt = todayAt(12, 53);
  const unopened = createMessage("m-live", "live update", sentAt, 0, null, null);
  const opened = createMessage("m-live", "live update", sentAt, 1, "Chrome on Windows", todayAt(13, 2));

  const page = await openGmailFixture([unopened], `
    ${gmailRow("To: me", "live update", "12:53 PM")}
  `);

  let rows = await getRowBadgeState(page);
  assertRow(rows[0], { id: "m-live", state: "sent", label: "Sent, not read", badgeCount: 1 }, "live row before refresh");

  await page.evaluate((message) => {
    window.__simpleTrackMockMessages = [message];
  }, opened);

  await page.locator(".simple-track-row-badge").hover();
  await page.waitForFunction(() => document.querySelector(".simple-track-row-badge")?.dataset.simpleTrackState === "opened");

  await page.evaluate((message) => {
    const changes = { "simpleTrack.messages": { newValue: [message] } };
    for (const listener of window.__simpleTrackStorageListeners || []) {
      listener(changes, "local");
    }
  }, unopened);

  await page.waitForTimeout(120);
  rows = await getRowBadgeState(page);
  assertRow(rows[0], { id: "m-live", state: "opened", label: "1 open", badgeCount: 1 }, "live row after stale storage");

  await page.close();
}

async function testPendingMessagesDoNotBindToRows() {
  const now = new Date();
  now.setSeconds(0, 0);
  const previous = new Date(now);
  previous.setHours(now.getHours() - 1);

  const messages = [
    {
      ...createMessage("m-pending", "test", now, 0, null, null),
      rowMatchAfter: new Date(Date.now() + 60000).toISOString()
    },
    createMessage("m-previous", "test", previous, 3, "Chrome on Windows", previous)
  ];

  const page = await openGmailFixture(messages, `
    ${gmailRow("To: me", "test", gmailTime(now))}
    ${gmailRow("To: me", "test", gmailTime(previous))}
  `);

  const rows = await getRowBadgeState(page);
  assertRow(rows[0], { id: null, state: null, label: null, badgeCount: 0 }, "pending unsent row");
  assertRow(rows[1], { id: "m-previous", state: "opened", label: "3 opens", badgeCount: 1 }, "previous sent row");

  await page.close();
}

async function openGmailFixture(messages, rowsHtml, options = {}) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    timezoneId: "America/Regina"
  });
  const page = await context.newPage();

  await page.route("**/*", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><html><head></head><body></body></html>"
  }));

  await page.goto("https://mail.google.com/mail/u/0/#sent");
  await page.evaluate(({ mockMessages, options }) => {
    window.__simpleTrackMockMessages = mockMessages;
    window.__simpleTrackStorageListeners = [];
    window.__simpleTrackRuntimeListeners = [];
    window.__simpleTrackStartedConnection = "";
    window.__simpleTrackActivationCalls = [];
    window.__simpleTrackWarnings = [];
    const originalWarn = console.warn.bind(console);
    console.warn = (...args) => {
      window.__simpleTrackWarnings.push(args.map((arg) => String(arg?.message || arg)).join(" "));
      originalWarn(...args);
    };
    window.chrome = {
      runtime: {
        getURL(path) {
          return `chrome-extension://simple-track/${path}`;
        },
        onMessage: {
          addListener(listener) {
            window.__simpleTrackRuntimeListeners.push(listener);
          }
        },
        sendMessage: async (message) => {
          if (options.throwRuntimeInvalidated) {
            throw new Error("Extension context invalidated.");
          }

          if (message.type === "simpleTrack:getState") {
            const accountEmail = options.activeAccountEmail || "";
            return {
              ok: true,
              messages: window.__simpleTrackMockMessages,
              activeAccountEmail: accountEmail,
              connectedAccounts: options.connectedAccounts || [],
              knownAccounts: options.knownAccounts || options.connectedAccounts || [],
              accountStatus: accountEmail
                ? {
                  status: (options.connectedAccounts || []).some((account) => account.email === accountEmail)
                    ? "connected"
                    : (options.knownAccounts || []).some((account) => account.email === accountEmail)
                      ? "login_required"
                      : "not_connected",
                  accountEmail,
                  connectedAccounts: options.connectedAccounts || []
                }
                : { status: "unknown_account", accountEmail: "", connectedAccounts: options.connectedAccounts || [] },
              settings: {
                trackingEnabled: true,
                showUnreadDots: true,
                showOpenedChecks: true,
                compactRows: false,
                privacyMode: false
              }
            };
          }
          if (message.type === "simpleTrack:startAccountConnection") {
            window.__simpleTrackStartedConnection = message.accountEmail;
            window.__simpleTrackStartedConnectionMessage = message;
            return options.connectionResponse || { ok: false, error: "No connection response" };
          }
          if (message.type === "simpleTrack:createTrackedMessage") {
            window.__simpleTrackCreatedMessage = message;
            return options.createTrackedMessageResponse || { ok: false, error: "No create response" };
          }
          if (message.type === "simpleTrack:activateTrackedMessage") {
            window.__simpleTrackActivationCalls.push(message);
            return options.activationResponse || { ok: true };
          }
          return { ok: true };
        }
      },
      storage: {
        onChanged: {
          addListener(listener) {
            window.__simpleTrackStorageListeners.push(listener);
          }
        }
      }
    };
  }, { mockMessages: messages, options });

  await page.setContent(`
    <style>
      table { width: 100%; border-collapse: collapse; font-family: Arial, sans-serif; }
      tr.zA { height: 40px; }
      td { border-bottom: 1px solid #ddd; padding: 4px 8px; }
      td.sender { width: 180px; }
      td.subject { width: auto; }
      td.date { width: 86px; text-align: right; white-space: nowrap; }
    </style>
    <a aria-label="Google Account: Spencer (${options.activeAccountEmail || ""})" href="https://accounts.google.com/SignOutOptions">Account</a>
    <table><tbody>${rowsHtml}</tbody></table>
    ${options.extraHtml || ""}
  `);

  await page.addStyleTag({ path: contentCssPath });
  await page.addScriptTag({ path: contentScriptPath });
  await page.waitForTimeout(120);
  page.on("close", () => context.close().catch(() => {}));
  return page;
}

async function getRowBadgeState(page) {
  return page.$$eval("tr.zA", (rows) => rows.map((row) => {
    const badge = row.querySelector(".simple-track-row-badge");
    return {
      id: badge?.dataset.simpleTrackMessageId || null,
      state: badge?.dataset.simpleTrackState || null,
      label: badge?.getAttribute("aria-label") || null,
      badgeCount: row.querySelectorAll(".simple-track-row-badge").length
    };
  }));
}

function createMessage(id, subject, sentAt, opens, device, lastActivityAt) {
  return {
    id,
    subject,
    recipients: ["me"],
    client: "Gmail",
    status: opens > 0 ? "opened" : "sent",
    opens,
    clicks: 0,
    sentAt: sentAt.toISOString(),
    lastActivityAt: lastActivityAt ? lastActivityAt.toISOString() : null,
    device,
    location: null,
    muted: false
  };
}

function gmailRow(sender, subject, dateText) {
  return `
    <tr class="zA">
      <td class="sender">${sender}</td>
      <td class="subject"><span class="bog">${subject}</span></td>
      <td class="date">${dateText}</td>
    </tr>
  `;
}

function todayAt(hour, minute) {
  const date = new Date();
  date.setHours(hour, minute, 0, 0);
  return date;
}

function gmailTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  }).format(date);
}

function hoverDateTime(date) {
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

function assertRow(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`${label} expected ${key}=${value}, got ${actual[key]} in ${JSON.stringify(actual)}`);
    }
  }
}
