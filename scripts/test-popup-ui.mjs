import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const popupUrl = pathToFileURL(path.join(root, "extension/src/popup/popup.html")).toString();
const browser = await chromium.launch({ headless: true });

try {
  await testConnectedAccountSwitcherChangesVisibleAccount();
  await testKnownLoggedOutAccountShowsLoginPrompt();
  console.log("Popup UI automation passed.");
} finally {
  await browser.close();
}

async function testConnectedAccountSwitcherChangesVisibleAccount() {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    let selectedAccountEmail = "s.stadnek96@gmail.com";
    const connectedAccounts = [
      { email: "s.stadnek96@gmail.com", displayName: "Spencer Davidson", provider: "google", client: "Gmail", status: "connected" },
      { email: "spencer.tpp@gmail.com", displayName: "Spencer Stadnek", provider: "google", client: "Gmail", status: "connected" }
    ];
    const messages = {
      "s.stadnek96@gmail.com": [{
        id: "first-account-message",
        accountEmail: "s.stadnek96@gmail.com",
        subject: "First account report",
        recipients: ["first@example.com"],
        status: "sent",
        opens: 0,
        clicks: 0,
        attachmentOpens: 0,
        sentAt: "2026-06-16T16:00:00.000Z",
        lastActivityAt: null,
        events: []
      }],
      "spencer.tpp@gmail.com": [{
        id: "second-account-message",
        accountEmail: "spencer.tpp@gmail.com",
        subject: "Second account report",
        recipients: ["second@example.com"],
        status: "opened",
        opens: 1,
        clicks: 0,
        attachmentOpens: 0,
        sentAt: "2026-06-16T16:00:00.000Z",
        lastActivityAt: "2026-06-16T16:05:00.000Z",
        events: [{ type: "open", createdAt: "2026-06-16T16:05:00.000Z" }]
      }]
    };

    function getAccountStatus(accountEmail) {
      const account = connectedAccounts.find((entry) => entry.email === accountEmail);
      return {
        status: account ? "connected" : "not_connected",
        accountEmail,
        account,
        connectedAccounts,
        knownAccounts: connectedAccounts
      };
    }

    window.chrome = {
      runtime: {
        sendMessage(message) {
          if (message?.type === "simpleTrack:getState") {
            const accountEmail = message.accountEmail || selectedAccountEmail;
            return Promise.resolve({
              ok: true,
              messages: messages[accountEmail] || [],
              settings: { trackingEnabled: true },
              summary: { sent: 1, opened: accountEmail === "spencer.tpp@gmail.com" ? 1 : 0, unopened: accountEmail === "spencer.tpp@gmail.com" ? 0 : 1, clicked: 0, attachmentOpened: 0, openRate: accountEmail === "spencer.tpp@gmail.com" ? 100 : 0 },
              connectedAccounts,
              knownAccounts: connectedAccounts,
              activeAccountEmail: accountEmail,
              accountStatus: getAccountStatus(accountEmail)
            });
          }

          if (message?.type === "simpleTrack:selectAccount") {
            selectedAccountEmail = message.accountEmail;
            window.__simpleTrackSelectedPopupAccount = message.accountEmail;
            return Promise.resolve({
              ok: true,
              connectedAccounts,
              knownAccounts: connectedAccounts,
              activeAccountEmail: selectedAccountEmail,
              accountStatus: getAccountStatus(selectedAccountEmail)
            });
          }

          return Promise.resolve({ ok: true });
        }
      },
      tabs: {
        query() {
          return Promise.resolve([{ id: 8, url: "https://mail.google.com/mail/u/0/#inbox" }]);
        },
        sendMessage(tabId, message) {
          if (message?.type === "simpleTrack:detectAccount") {
            return Promise.resolve({
              ok: true,
              accountEmail: "s.stadnek96@gmail.com",
              client: "Gmail",
              returnUrl: "https://mail.google.com/mail/u/0/#inbox",
              accountStatus: getAccountStatus("s.stadnek96@gmail.com")
            });
          }
          return Promise.resolve({ ok: true });
        },
        create() {
          return Promise.resolve({});
        }
      }
    };
  });

  await page.goto(popupUrl);
  await page.waitForSelector("#accountSwitcher:not([hidden])");
  await page.waitForSelector("text=First account report");
  await page.getByRole("button", { name: /Viewing s\.stadnek96@gmail\.com/i }).click();
  await page.getByRole("option", { name: "Switch to spencer.tpp@gmail.com" }).click();
  await page.waitForFunction(() => window.__simpleTrackSelectedPopupAccount === "spencer.tpp@gmail.com");
  await page.waitForSelector("#accountEmail:text('spencer.tpp@gmail.com')");
  await page.waitForSelector("text=Second account report");
  if (await page.getByText("First account report").count()) {
    throw new Error("Popup account switcher did not replace the first account's messages");
  }
  await page.close();
}

async function testKnownLoggedOutAccountShowsLoginPrompt() {
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const activeAccountEmail = "spencer.tpp@gmail.com";
    const connectedAccounts = [
      { email: "s.stadnek96@gmail.com", displayName: "Spencer Davidson", provider: "google", client: "Gmail", status: "connected" }
    ];
    const knownAccounts = [
      ...connectedAccounts,
      { email: activeAccountEmail, displayName: "Spencer Stadnek", provider: "google", client: "Gmail", status: "login_required" }
    ];

    window.chrome = {
      runtime: {
        sendMessage(message) {
          if (message?.type === "simpleTrack:getState") {
            return Promise.resolve({
              ok: true,
              messages: [],
              settings: { trackingEnabled: true },
              summary: { sent: 0, opened: 0, unopened: 0, clicked: 0, attachmentOpened: 0, openRate: 0 },
              connectedAccounts,
              knownAccounts,
              activeAccountEmail,
              accountStatus: {
                status: "login_required",
                accountEmail: activeAccountEmail,
                account: knownAccounts[1],
                connectedAccounts,
                knownAccounts
              }
            });
          }

          if (message?.type === "simpleTrack:startAccountConnection") {
            window.__simpleTrackPopupConnection = message;
            return Promise.resolve({
              ok: false,
              accountStatus: {
                status: "login_required",
                accountEmail: activeAccountEmail,
                account: knownAccounts[1],
                connectedAccounts,
                knownAccounts
              }
            });
          }

          return Promise.resolve({ ok: true });
        }
      },
      tabs: {
        query() {
          return Promise.resolve([{ id: 7, url: "https://mail.google.com/mail/u/3/#inbox" }]);
        },
        sendMessage(tabId, message) {
          if (message?.type === "simpleTrack:detectAccount") {
            return Promise.resolve({
              ok: true,
              accountEmail: activeAccountEmail,
              client: "Gmail",
              returnUrl: "https://mail.google.com/mail/u/3/#inbox",
              accountStatus: {
                status: "login_required",
                accountEmail: activeAccountEmail,
                account: knownAccounts[1],
                connectedAccounts,
                knownAccounts
              }
            });
          }
          return Promise.resolve({ ok: true });
        },
        create(options) {
          window.__simpleTrackOpenedUrl = options?.url || "";
          return Promise.resolve({});
        }
      }
    };
  });

  await page.goto(popupUrl);
  await page.waitForSelector("#accountStatus:text('Log back in to re-enable email tracking for this Gmail account.')");
  await page.waitForSelector("#connectAccount:text('Log back in')");
  await page.getByRole("button", { name: "Log back in" }).click();
  await page.waitForFunction(() => window.__simpleTrackPopupConnection?.accountEmail === "spencer.tpp@gmail.com");
  await page.close();
}
