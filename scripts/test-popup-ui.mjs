import { chromium } from "playwright";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const popupUrl = pathToFileURL(path.join(root, "extension/src/popup/popup.html")).toString();
const browser = await chromium.launch({ headless: true });

try {
  await testKnownLoggedOutAccountShowsLoginPrompt();
  console.log("Popup UI automation passed.");
} finally {
  await browser.close();
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
