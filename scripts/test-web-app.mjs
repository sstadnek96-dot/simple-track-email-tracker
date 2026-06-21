import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { mockBootstrap, mockDashboard } from "../hosting/app/src/mockData.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const appUrl = "http://127.0.0.1:4173/?harness=1";
const gmailReturnUrl = "https://mail.google.com/mail/u/3/#inbox";
const outlookReturnUrl = "https://outlook.live.com/mail/0/inbox";
const connectUrl = `http://127.0.0.1:4173/connect-extension?harness=1#installId=harness-install&installSecret=harness-secret&accountEmail=s.stadnek96@gmail.com&client=Gmail&source=chrome-extension&returnUrl=${encodeURIComponent(gmailReturnUrl)}`;
const reconnectUrl = `http://127.0.0.1:4173/connect-extension?harness=1#installId=harness-install&installSecret=harness-secret&accountEmail=spencer.tpp@gmail.com&client=Gmail&mode=reconnect&source=chrome-extension&returnUrl=${encodeURIComponent(gmailReturnUrl)}`;
const connectOutlookUrl = `http://127.0.0.1:4173/connect-extension?harness=1#installId=harness-install&installSecret=harness-secret&accountEmail=spencer.stadnek@outlook.com&client=Outlook&provider=microsoft&source=chrome-extension&returnUrl=${encodeURIComponent(outlookReturnUrl)}`;
const apiBase = "https://us-central1-simple-track-prod.cloudfunctions.net/api";
const extensionContext = Buffer.from(JSON.stringify({
  extensionId: "harness-extension",
  installId: "harness-install",
  activeAccountEmail: "s.stadnek96@gmail.com",
  handoffAccountEmail: "s.stadnek96@gmail.com",
  handoffTokens: {
    "s.stadnek96@gmail.com": "harness-token-s"
  },
  connectedAccounts: [
    {
      email: "s.stadnek96@gmail.com",
      displayName: "Spencer Davidson",
      provider: "google",
      client: "Gmail"
    },
    {
      email: "spencer.tpp@gmail.com",
      displayName: "Spencer Stadnek",
      provider: "google",
      client: "Gmail"
    }
  ]
}), "utf8").toString("base64url");

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

async function run() {
  buildApp();
  const server = startPreviewServer();

  try {
    await waitForServer(appUrl);
    await runBrowserChecks();
    console.log("Web app harness passed");
  } finally {
    server.kill();
    killPreviewPort();
  }
}

function buildApp() {
  const result = spawnSync(commandForNpm("build").command, commandForNpm("build").args, {
    cwd: rootDir,
    stdio: "inherit"
  });
  assert.equal(result.status, 0, "Vite app build failed");
}

function startPreviewServer() {
  const preview = commandForNpm("preview");
  const server = spawn(preview.command, preview.args, {
    cwd: rootDir,
    stdio: "ignore"
  });
  return server;
}

function commandForNpm(script) {
  if (process.platform === "win32") {
    const command = script === "build"
      ? "npm --prefix hosting/app run build"
      : "npm --prefix hosting/app run preview -- --host 127.0.0.1 --port 4173";
    return { command: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }

  if (script === "build") {
    return { command: "npm", args: ["--prefix", "hosting/app", "run", "build"] };
  }
  return { command: "npm", args: ["--prefix", "hosting/app", "run", "preview", "--", "--host", "127.0.0.1", "--port", "4173"] };
}

function killPreviewPort() {
  if (process.platform !== "win32") return;
  spawnSync("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Get-NetTCPConnection -LocalPort 4173 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"
  ], { stdio: "ignore" });
}

async function waitForServer(url) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw new Error("Timed out waiting for Vite preview server");
}

async function runBrowserChecks() {
  const browser = await chromium.launch();
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const browserErrors = [];
  const dashboardRequests = [];
  const dashboardAuthRequests = [];

  await page.addInitScript(() => {
    Object.defineProperty(window, "chrome", {
      configurable: true,
      value: {
        runtime: {
          lastError: null,
          sendMessage(extensionId, message, callback) {
            window.__simpleTrackExternalRequests = window.__simpleTrackExternalRequests || [];
            window.__simpleTrackExternalRequests.push({ extensionId, type: message?.type || "", accountEmail: message?.accountEmail || "" });
            setTimeout(() => {
              const connectedAccounts = [
                {
                  email: "s.stadnek96@gmail.com",
                  displayName: "Spencer Davidson",
                  provider: "google",
                  client: "Gmail",
                  status: "connected"
                },
                {
                  email: "spencer.tpp@gmail.com",
                  displayName: "Spencer Stadnek",
                  provider: "google",
                  client: "Gmail",
                  status: "connected"
                }
              ];

              if (message?.type === "simpleTrack:disconnectAccount") {
                const remainingAccounts = connectedAccounts.filter((account) => account.email !== message.accountEmail);
                const disconnectedAccount = connectedAccounts.find((account) => account.email === message.accountEmail);
                const knownAccounts = disconnectedAccount
                  ? [...remainingAccounts, { ...disconnectedAccount, status: "login_required" }]
                  : remainingAccounts;
                callback({
                  ok: true,
                  connectedAccounts: remainingAccounts,
                  knownAccounts,
                  activeAccountEmail: remainingAccounts[0]?.email || "",
                  accountStatus: {
                    status: "login_required",
                    accountEmail: message.accountEmail,
                    connectedAccounts: remainingAccounts,
                    knownAccounts,
                    account: knownAccounts.find((account) => account.email === message.accountEmail) || null
                  }
                });
                return;
              }

              if (message?.type === "simpleTrack:startAccountConnection") {
                callback({
                  ok: true,
                  connectUrl: `https://simple-track-prod-app.web.app/connect-extension#accountEmail=${encodeURIComponent(message.accountEmail)}&mode=reconnect`,
                  accountStatus: {
                    status: "login_required",
                    accountEmail: message.accountEmail,
                    connectedAccounts,
                    knownAccounts: connectedAccounts
                  }
                });
                return;
              }

              if (message?.type === "simpleTrack:getConnectedAccounts") {
                callback({
                  ok: true,
                  extensionId,
                  connectedAccounts,
                  activeAccountEmail: "s.stadnek96@gmail.com"
                });
                return;
              }

              callback({
                ok: true,
                customToken: `harness-token-${message.accountEmail}`,
                accountEmail: message.accountEmail,
                activeAccountEmail: message.accountEmail,
                connectedAccounts
              });
            }, 0);
          }
        }
      }
    });
  });

  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => browserErrors.push(`pageerror: ${error.message}`));

  await page.route(`${apiBase}/app/**`, async (route) => {
    const request = route.request();
    const auth = request.headers().authorization || "";
    if (auth.includes("foreign-token")) {
      await json(route, 403, { ok: false, error: "Forbidden" });
      return;
    }

    const url = new URL(request.url());
    const path = url.pathname;
    const authEmail = authEmailFromHeader(auth);

    if (path.endsWith("/bootstrap")) {
      await json(route, 200, bootstrapForAuth(authEmail));
      return;
    }

    if (path.endsWith("/dashboard")) {
      const accountEmail = (url.searchParams.get("accountEmail") || "").toLowerCase();
      dashboardRequests.push(accountEmail || "all");
      dashboardAuthRequests.push({ accountEmail: accountEmail || "all", authEmail });
      await json(route, 200, { ok: true, data: dashboardForAccount(accountEmail, authEmail) });
      return;
    }

    if (path.endsWith("/connect-extension")) {
      const body = await request.postDataJSON();
      const accountEmail = body.accountEmail || mockBootstrap.connectedAccounts[0].email;
      const client = body.client || "Gmail";
      const provider = body.provider || (client === "Outlook" ? "microsoft" : "google");
      await json(route, 200, {
        ok: true,
        account: {
          id: accountEmail,
          email: accountEmail,
          displayName: body.accountDisplayName || accountEmail,
          photoURL: body.accountPhotoURL || "",
          provider,
          client,
          status: "connected"
        },
        installId: "harness-install",
        linkedMessages: 2
      });
      return;
    }

    if (path.endsWith("/pairing-codes")) {
      await json(route, 201, { ok: true, code: "STPAIR42", expiresAt: "2026-05-23T21:00:00.000Z" });
      return;
    }

    if (path.endsWith("/files")) {
      await json(route, 201, {
        ok: true,
        file: {
          id: "pdf-harness",
          name: "Harness upload.pdf",
          views: 0,
          downloads: 0,
          createdAt: "2026-05-23T20:00:00.000Z",
          trackingUrl: "https://simpletrack.app/file/pdf-harness"
        },
        uploadUrl: null
      });
      return;
    }

    if (path.endsWith("/contacts")) {
      await json(route, 201, {
        ok: true,
        contact: {
          id: "new@example.com",
          name: "New Contact",
          email: "new@example.com",
          domain: "example.com",
          lastContactedAt: null,
          lastHeardFromAt: null,
          unsubscribed: false,
          hardBounced: false
        }
      });
      return;
    }

    if (path.endsWith("/settings")) {
      await json(route, 200, { ok: true, settings: mockDashboard.settings });
      return;
    }

    await json(route, 404, { ok: false, error: "Not mocked" });
  });

  try {
    await page.goto(appUrl);
    await page.waitForTimeout(1000);
    if (browserErrors.length > 0) {
      throw new Error(browserErrors.join("\n"));
    }
    await page.waitForSelector(".auth-modal");
    await page.getByRole("button", { name: /Use harness account/i }).click();
    await page.waitForSelector(".profile-button");
    await page.waitForSelector("text=Latest activity");

    const pageChecks = [
      ["Email tracking", "Email tracking", "email"],
      ["Link clicks", "Link clicks", "links"],
      ["PDF analytics", "PDF analytics", "pdf"],
      ["My performance", "My performance", "performance"],
      ["MyCRM", "MyCRM", "crm"],
      ["Settings & account", "Settings & account", "settings"],
      ["Latest activity", "Latest activity", "activity"]
    ];

    for (const [nav, heading, pageId] of pageChecks) {
      await page.getByRole("button", { name: nav }).first().click();
      await page.waitForSelector(`h1:text("${heading}")`);
      assert.equal(
        await searchParam(page, "page"),
        pageId,
        `${nav} navigation should update the page URL parameter`
      );
    }

    await page.goto(`${appUrl}&page=activity&accountEmail=s.stadnek96@gmail.com`);
    await page.waitForSelector(".auth-modal");
    await page.getByRole("button", { name: /Use harness account/i }).click();
    await page.waitForSelector("h1:text('Latest activity')");
    await page.waitForSelector("text=Question About Lawncare");
    assert.equal(await page.getByText("Signed intake package").count(), 0, "activity route should scope to the requested mail account");

    await page.goto(`${appUrl}&page=email&messageId=msg-1002&accountEmail=s.stadnek96@gmail.com`);
    await page.waitForSelector(".auth-modal");
    await page.getByRole("button", { name: /Use harness account/i }).click();
    await page.waitForSelector("h1:text('Email tracking')");
    await page.waitForSelector("text=Message report");
    await page.waitForSelector("text=lawncare-pricing.pdf");
    assert.equal(await searchParam(page, "page"), "email", "message deep link should route to Email tracking");
    assert.equal(await searchParam(page, "messageId"), "msg-1002", "message deep link should keep messageId in the URL");
    await page.getByLabel("Close").click();
    await page.waitForFunction(() => !new URL(window.location.href).searchParams.has("messageId"));

    await page.getByRole("button", { name: /Open report for Question About Lawncare/i }).click();
    await page.waitForSelector("text=Message report");
    const openedMessageId = await searchParam(page, "messageId");
    assert.ok(openedMessageId, "opening a message report should push messageId into the URL");
    await page.goBack();
    await page.waitForSelector("h1:text('Email tracking')");
    await page.waitForFunction(() => !new URL(window.location.href).searchParams.has("messageId"));
    assert.equal(await page.getByText("Message report").count(), 0, "browser back should close the message report");

    await page.getByRole("button", { name: /Open report for Question About Lawncare/i }).click();
    await page.waitForSelector("text=Message report");
    const persistedMessageId = await searchParam(page, "messageId");
    await page.reload();
    await page.waitForSelector(".profile-button, .auth-modal");
    if (await page.locator(".auth-modal").count()) {
      await page.getByRole("button", { name: /Use harness account/i }).click();
    }
    await page.waitForSelector("text=Message report");
    assert.equal(await searchParam(page, "messageId"), persistedMessageId, "refresh should preserve the open message report route");
    await page.getByLabel("Close").click();
    await page.waitForFunction(() => !new URL(window.location.href).searchParams.has("messageId"));
    await page.getByRole("button", { name: "Link clicks" }).first().click();
    await page.waitForSelector("h1:text('Link clicks')");
    assert.equal(await searchParam(page, "page"), "links", "page URL should update after leaving an email report");
    await page.goBack();
    await page.waitForSelector("h1:text('Email tracking')");
    assert.equal(await searchParam(page, "messageId"), null, "back from another page should not reopen a cleared message report");

    await page.getByRole("button", { name: "Email tracking" }).first().click();
    await page.waitForSelector("text=Question About Lawncare");
    assert.equal(await page.getByText("Signed intake package").count(), 0, "default selected account should hide another account's messages");

    await page.goto(`${appUrl}&page=activity&accountEmail=s.stadnek96@gmail.com#stContext=${extensionContext}`);
    await page.waitForSelector(".profile-button, .auth-modal");
    if (await page.locator(".auth-modal").count()) {
      await page.getByRole("button", { name: /Use harness account/i }).click();
    }
    await page.waitForSelector(".profile-button");
    await page.waitForFunction(() => !new URL(window.location.href).hash.includes("stContext"));
    assert.equal(
      await page.evaluate(() => new URL(window.location.href).hash.includes("stContext")),
      false,
      "extension handoff context must be consumed once and removed before refresh"
    );
    await page.locator(".profile-button").click();
    const profileMenu = page.locator(".profile-menu");
    await page.waitForSelector("text=spencer.tpp@gmail.com");
    assert.equal(await profileMenu.getByText("All connected accounts").count(), 0, "profile menu should not show the combined accounts row");
    assert.equal(await profileMenu.getByText("Add another mail account").count(), 0, "profile menu should not show add-account shortcut");
    assert.equal(await profileMenu.getByText("Change app login").count(), 0, "profile menu should not show app-login shortcut");
    assert.equal(
      await page.getByRole("button", { name: "Switch to spencer.tpp@gmail.com" }).count(),
      1,
      "extension-connected account should be switchable from the web app profile menu"
    );
    await page.getByRole("button", { name: "Switch to spencer.tpp@gmail.com" }).click();
    await waitForDashboardRequest(dashboardRequests, "spencer.tpp@gmail.com");
    await waitForAuthorizedDashboardRequest(dashboardAuthRequests, "spencer.tpp@gmail.com", "spencer.tpp@gmail.com");
    await page.waitForSelector("text=Spencer Stadnek's workspace");
    await page.waitForSelector("text=TPP account follow-up");
    assert.equal(await page.getByText("Question About Lawncare").count(), 0, "switched workspace should not show the old account rows");
    assert.equal(
      await page.evaluate(() => new URL(window.location.href).hash.includes("stContext")),
      false,
      "switching accounts should not preserve stale extension handoff context"
    );
    assert.equal(
      await page.getByText("Open Simple Track from the Chrome extension").count(),
      0,
      "switching an extension-connected account should not show the no-handoff error"
    );
    assert.equal(
      await page.evaluate(() => new URL(window.location.href).searchParams.get("accountEmail")),
      "spencer.tpp@gmail.com",
      "switching accounts should sync the accountEmail URL parameter"
    );
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem("simpleTrack.activeMailAccount")),
      "spencer.tpp@gmail.com",
      "switching accounts should persist the active mail account for refresh"
    );
    await page.locator(".profile-button").click();
    const activeAccountRowText = await page.locator(".mail-account-row.is-active").innerText();
    assert.match(activeAccountRowText, /spencer\.tpp@gmail\.com[\s\S]*Active/, "switched account row should be marked active");
    await assertActiveAccountBadge(page, "spencer.tpp@gmail.com");
    await page.reload();
    await page.waitForSelector(".profile-button, .auth-modal");
    if (await page.locator(".auth-modal").count()) {
      await page.getByRole("button", { name: /Use harness account/i }).click();
    }
    await page.waitForSelector("text=Spencer Stadnek's workspace");
    await page.waitForSelector("text=TPP account follow-up");
    assert.equal(
      await page.evaluate(() => new URL(window.location.href).hash.includes("stContext")),
      false,
      "hard refresh should not restore stale extension handoff context"
    );
    assert.equal(await searchParam(page, "accountEmail"), "spencer.tpp@gmail.com", "refresh should preserve the selected mail account");
    assert.equal(await page.getByText("Question About Lawncare").count(), 0, "refresh should keep the switched account data scope");
    await page.locator(".profile-button").click();
    const reloadedActiveAccountText = await page.locator(".mail-account-row.is-active").innerText();
    assert.match(reloadedActiveAccountText, /spencer\.tpp@gmail\.com[\s\S]*Active/, "reloaded account row should remain active");
    await assertActiveAccountBadge(page, "spencer.tpp@gmail.com");
    await page.getByRole("button", { name: "Switch to s.stadnek96@gmail.com" }).click();
    await waitForAuthorizedDashboardRequest(dashboardAuthRequests, "s.stadnek96@gmail.com", "s.stadnek96@gmail.com");
    await page.waitForSelector("text=Spencer Davidson's workspace");
    await page.waitForSelector("text=Question About Lawncare");
    assert.equal(await page.getByText("TPP account follow-up").count(), 0, "switching back should hide the previous account data");
    await page.locator(".profile-button").click();
    const switchedBackActiveText = await page.locator(".mail-account-row.is-active").innerText();
    assert.match(switchedBackActiveText, /s\.stadnek96@gmail\.com[\s\S]*Active/, "switching back should mark s.stadnek96 active");
    await assertActiveAccountBadge(page, "s.stadnek96@gmail.com");
    await page.getByRole("button", { name: "Switch to spencer.tpp@gmail.com" }).click();
    await waitForAuthorizedDashboardRequest(dashboardAuthRequests, "spencer.tpp@gmail.com", "spencer.tpp@gmail.com");
    await page.waitForSelector("text=Spencer Stadnek's workspace");
    await page.waitForSelector("text=TPP account follow-up");
    await page.locator(".profile-button").click();
    await page.getByRole("button", { name: /Sign out/i }).click();
    await page.waitForFunction(() => (
      window.__simpleTrackExternalRequests || []
    ).some((request) => request.type === "simpleTrack:disconnectAccount" && request.accountEmail === "spencer.tpp@gmail.com"));
    await waitForDashboardRequest(dashboardRequests, "s.stadnek96@gmail.com");
    await page.waitForSelector("text=Question About Lawncare");
    await page.locator(".profile-button").click();
    const loginRequiredRowCount = await page.getByRole("button", { name: "Log back in to spencer.tpp@gmail.com" }).count();
    if (loginRequiredRowCount !== 1) {
      const state = await page.evaluate(() => ({
        activeMailAccount: window.localStorage.getItem("simpleTrack.activeMailAccount"),
        extensionSession: window.localStorage.getItem("simpleTrack.extensionSession"),
        url: window.location.href
      }));
      const menuText = await page.locator(".profile-menu").innerText();
      throw new Error(`signed-out account should stay in the web app account menu as a login-required row; count=${loginRequiredRowCount}; menu=${menuText}; state=${JSON.stringify(state)}`);
    }
    await page.getByRole("button", { name: "Log back in to spencer.tpp@gmail.com" }).click();
    await page.waitForFunction(() => (
      window.__simpleTrackExternalRequests || []
    ).some((request) => request.type === "simpleTrack:startAccountConnection" && request.accountEmail === "spencer.tpp@gmail.com"));

    await page.getByRole("button", { name: "Email tracking" }).first().click();
    await page.waitForSelector("h1:text('Email tracking')");
    await page.getByPlaceholder(/Search recipients/i).fill("lawncare");
    await page.waitForSelector("text=Question About Lawncare");
    await page.getByPlaceholder(/Search recipients/i).fill("");
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: /Download CSV/i }).click()
    ]);
    assert.match(download.suggestedFilename(), /email-tracking/);

    await page.getByRole("button", { name: "PDF analytics" }).first().click();
    const fixturePath = join(rootDir, "dist", "test-fixtures", "harness.pdf");
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, "%PDF-1.4\n% harness\n");
    await page.locator('input[type="file"]').setInputFiles(fixturePath);
    await page.getByRole("button", { name: /Create tracked PDF/i }).click();
    await page.waitForSelector("text=Harness upload.pdf");

    await page.getByRole("button", { name: "Settings & account" }).first().click();
    await page.waitForSelector("text=Chrome extension connection");
    await page.waitForSelector("text=s.stadnek96@gmail.com");

    const isolationStatus = await page.evaluate(async (url) => {
      const response = await fetch(`${url}/app/dashboard`, {
        headers: { Authorization: "Bearer foreign-token" }
      });
      return response.status;
    }, apiBase);
    assert.equal(isolationStatus, 403, "foreign org/token should be rejected");

    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByLabel("Open navigation").click();
    await page.getByRole("button", { name: "Link clicks" }).last().click();
    await page.waitForSelector("h1:text('Link clicks')");

    await page.evaluate(() => {
      window.postMessage({
        source: "simple-track-extension-event",
        type: "simpleTrack:accountDisconnected",
        accountEmail: "s.stadnek96@gmail.com",
        connectedAccounts: [],
        activeAccountEmail: ""
      }, window.location.origin);
    });
    try {
      await page.waitForSelector(".auth-modal", { timeout: 3000 });
    } catch (error) {
      const state = await page.evaluate(() => ({
        hasAuthModal: Boolean(document.querySelector(".auth-modal")),
        hasProfileButton: Boolean(document.querySelector(".profile-button")),
        text: document.body.innerText.slice(0, 800),
        storage: window.localStorage.getItem("simpleTrack.extensionSession"),
        requests: window.__simpleTrackExternalRequests || []
      }));
      throw new Error(`extension logout sync did not show auth modal: ${JSON.stringify(state, null, 2)}`);
    }

    await page.goto(appUrl);
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.goto(connectUrl);
    await page.waitForSelector("h1:text('Connect Gmail')");
    if (await page.getByRole("button", { name: /Use harness account/i }).count()) {
      await page.getByRole("button", { name: /Use harness account/i }).click();
    } else {
      await page.getByRole("button", { name: /Connect this Gmail|Continue with Gmail/i }).click();
    }
    await page.waitForSelector("h1:text('Gmail connected')");
    await page.waitForSelector("text=without access keys");
    assert.equal(
      await page.locator(".connect-done-button").getAttribute("href"),
      gmailReturnUrl,
      "Gmail connection should return to the exact Gmail account URL"
    );

    await page.goto(appUrl);
    await page.evaluate(() => {
      window.localStorage.clear();
      window.sessionStorage.clear();
    });
    await page.goto(reconnectUrl);
    await page.waitForSelector("h1:text('Reconnect Gmail')");
    assert.equal(await page.getByText("Signed in to Simple Track as").count(), 0, "reconnect page should not show confusing signed-in identity copy");
    assert.equal(
      await page.getByRole("button", { name: /Log back in with Gmail/i }).count(),
      1,
      "reconnect page should force provider SSO instead of silent reconnect"
    );
    if (await page.getByRole("button", { name: /Use harness account/i }).count()) {
      await page.getByRole("button", { name: /Use harness account/i }).click();
    }
    await page.waitForSelector("h1:text('Gmail connected')");

    await page.goto(connectOutlookUrl);
    await page.waitForSelector("h1:text('Connect Outlook')");
    if (await page.getByRole("button", { name: /Use harness account/i }).count()) {
      await page.getByRole("button", { name: /Use harness account/i }).click();
    } else {
      await page.getByRole("button", { name: /Connect this Outlook|Continue with Outlook/i }).click();
    }
    await page.waitForSelector("h1:text('Outlook connected')");
    await page.waitForSelector("text=spencer.stadnek@outlook.com can now use Simple Track from Outlook without access keys.");
    assert.equal(
      await page.locator(".connect-done-button").getAttribute("href"),
      outlookReturnUrl,
      "Outlook connection should return to the exact Outlook URL"
    );
    assert.equal(await page.getByText("Switch to spencer.stadnek@outlook.com").count(), 0, "connecting Outlook should not force switching the web login identity");
  } finally {
    await browser.close();
  }
}

function authEmailFromHeader(authHeader = "") {
  const match = String(authHeader).match(/^Bearer\s+harness-token-(.+)$/i);
  return (match?.[1] || "").toLowerCase();
}

function bootstrapForAuth(authEmail = "") {
  const account = getMockAccount(authEmail) || mockBootstrap.connectedAccounts[0];
  return {
    ...mockBootstrap,
    user: {
      ...mockBootstrap.user,
      email: account.email,
      displayName: account.displayName || account.email
    },
    org: {
      ...mockBootstrap.org,
      id: `harness-org-${account.email}`,
      name: `${account.displayName || account.email}'s workspace`
    },
    connectedAccounts: [account]
  };
}

function getMockAccount(accountEmail = "") {
  const normalizedEmail = String(accountEmail || "").toLowerCase();
  return mockBootstrap.connectedAccounts.find((account) => account.email === normalizedEmail) || null;
}

function dashboardForAccount(accountEmail = "", authEmail = "") {
  const normalizedAuthEmail = String(authEmail || "").toLowerCase();
  const requestedAccountEmail = String(accountEmail || "").toLowerCase();
  const effectiveAccountEmail = requestedAccountEmail || normalizedAuthEmail;
  const canReadAccount = !effectiveAccountEmail || !normalizedAuthEmail || effectiveAccountEmail === normalizedAuthEmail;
  const accountScope = canReadAccount ? effectiveAccountEmail : "__no_access__";
  const connectedAccount = getMockAccount(normalizedAuthEmail);
  if (!accountScope && !connectedAccount) return mockDashboard;

  const messages = mockDashboard.messages.filter((message) => message.accountEmail === accountScope);
  const messageIds = new Set(messages.map((message) => message.id));

  return {
    ...mockDashboard,
    messages,
    activity: mockDashboard.activity.filter((item) => item.accountEmail === accountEmail || messageIds.has(item.messageId)),
    links: mockDashboard.links.filter((item) => item.accountEmail === accountEmail || messageIds.has(item.messageId)),
    contacts: mockDashboard.contacts.filter((contact) => (
      messages.some((message) => (
        (message.recipients || []).some((recipient) => recipient.toLowerCase().includes(contact.email))
      ))
    )),
    connectedAccounts: connectedAccount ? [connectedAccount] : []
  };
}

async function waitForDashboardRequest(requests, accountEmail) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (requests.includes(accountEmail)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Expected dashboard request for ${accountEmail}; saw ${JSON.stringify(requests)}`);
}

async function waitForAuthorizedDashboardRequest(requests, accountEmail, authEmail) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (requests.some((request) => request.accountEmail === accountEmail && request.authEmail === authEmail)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Expected dashboard request for ${accountEmail} authenticated as ${authEmail}; saw ${JSON.stringify(requests)}`);
}

async function assertActiveAccountBadge(page, accountEmail) {
  const activeState = await page.locator(".mail-account-row.is-active").evaluate((row) => {
    const badge = row.querySelector(".account-state");
    const badgeStyle = badge ? getComputedStyle(badge) : null;
    return {
      rowText: row.textContent || "",
      badgeText: badge?.textContent?.trim() || "",
      badgeColor: badgeStyle?.color || "",
      badgeBackground: badgeStyle?.backgroundColor || ""
    };
  });

  assert.match(activeState.rowText, new RegExp(accountEmail.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "active row should be the requested account");
  assert.equal(activeState.badgeText, "Active", "active row should show Active");
  assert.match(activeState.badgeBackground, /rgb\(223, 248, 235\)|rgb\(231, 248, 240\)/, "active badge should use the green active background");
  assert.match(activeState.badgeColor, /rgb\(8, 116, 67\)|rgb\(8, 127, 91\)|rgb\(0, 128, 92\)/, "active badge should use green active text");
}

async function searchParam(page, name) {
  return page.evaluate((paramName) => new URL(window.location.href).searchParams.get(paramName), name);
}

async function json(route, status, body) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}
