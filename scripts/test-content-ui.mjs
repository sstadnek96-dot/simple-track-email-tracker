import { chromium } from "playwright";
import path from "node:path";

const root = process.cwd();
const contentScriptPath = path.join(root, "extension/src/content/email-tracker-content.js");
const contentCssPath = path.join(root, "extension/src/content/email-tracker-content.css");

const browser = await chromium.launch({ headless: true });

try {
  await testDuplicateSubjectsMapToDistinctRows();
  await testBadgeDoesNotRegressFromStaleStorage();
  await testPendingMessagesDoNotBindToRows();
  console.log("Content UI automation passed.");
} finally {
  await browser.close();
}

async function testDuplicateSubjectsMapToDistinctRows() {
  const messages = [
    createMessage("m-new", "test", todayAt(12, 55), 0, null, null),
    createMessage("m-mid", "test", todayAt(12, 53), 2, "Chrome on Windows", todayAt(13, 39)),
    createMessage("m-old", "test", todayAt(12, 4), 4, "Firefox on Windows", todayAt(13, 26))
  ];

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
  if (!hoverText.includes("2 opens") || !hoverText.includes("Chrome on Windows")) {
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
  if (!hoverText.includes("2 opens") || !hoverText.includes("Chrome on Windows")) {
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

async function openGmailFixture(messages, rowsHtml) {
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
  await page.evaluate((mockMessages) => {
    window.__simpleTrackMockMessages = mockMessages;
    window.__simpleTrackStorageListeners = [];
    window.chrome = {
      runtime: {
        sendMessage: async (message) => {
          if (message.type === "simpleTrack:getState") {
            return {
              ok: true,
              messages: window.__simpleTrackMockMessages,
              settings: {
                trackingEnabled: true,
                showUnreadDots: true,
                showOpenedChecks: true,
                compactRows: false,
                privacyMode: false
              }
            };
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
  }, messages);

  await page.setContent(`
    <style>
      table { width: 100%; border-collapse: collapse; font-family: Arial, sans-serif; }
      tr.zA { height: 40px; }
      td { border-bottom: 1px solid #ddd; padding: 4px 8px; }
      td.sender { width: 180px; }
      td.subject { width: auto; }
      td.date { width: 86px; text-align: right; white-space: nowrap; }
    </style>
    <table><tbody>${rowsHtml}</tbody></table>
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

function assertRow(actual, expected, label) {
  for (const [key, value] of Object.entries(expected)) {
    if (actual[key] !== value) {
      throw new Error(`${label} expected ${key}=${value}, got ${actual[key]} in ${JSON.stringify(actual)}`);
    }
  }
}
