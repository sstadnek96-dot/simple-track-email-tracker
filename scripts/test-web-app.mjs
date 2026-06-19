import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { mockBootstrap, mockDashboard } from "../hosting/app/src/mockData.js";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const appUrl = "http://127.0.0.1:4173/?harness=1";
const connectUrl = "http://127.0.0.1:4173/connect-extension?harness=1#installId=harness-install&installSecret=harness-secret&accountEmail=s.stadnek96@gmail.com&client=Gmail";
const apiBase = "https://us-central1-simple-track-prod.cloudfunctions.net/api";
const extensionContext = Buffer.from(JSON.stringify({
  installId: "harness-install",
  activeAccountEmail: "s.stadnek96@gmail.com",
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

    if (path.endsWith("/bootstrap")) {
      await json(route, 200, mockBootstrap);
      return;
    }

    if (path.endsWith("/dashboard")) {
      await json(route, 200, { ok: true, data: mockDashboard });
      return;
    }

    if (path.endsWith("/connect-extension")) {
      await json(route, 200, {
        ok: true,
        account: mockBootstrap.connectedAccounts[0],
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
      ["Email tracking", "Email tracking"],
      ["Link clicks", "Link clicks"],
      ["PDF analytics", "PDF analytics"],
      ["My performance", "My performance"],
      ["MyCRM", "MyCRM"],
      ["Settings & account", "Settings & account"],
      ["Latest activity", "Latest activity"]
    ];

    for (const [nav, heading] of pageChecks) {
      await page.getByRole("button", { name: nav }).first().click();
      await page.waitForSelector(`h1:text("${heading}")`);
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
    await page.getByLabel("Close").click();

    await page.getByRole("button", { name: "Email tracking" }).first().click();
    await page.waitForSelector("text=Question About Lawncare");
    assert.equal(await page.getByText("Signed intake package").count(), 0, "default selected account should hide another account's messages");
    await page.locator(".profile-button").click();
    await page.getByRole("button", { name: "Switch to sstadnek96@gmail.com" }).click();
    await page.waitForSelector("text=Signed intake package");
    assert.equal(await page.getByText("Question About Lawncare").count(), 0, "selected account should hide the first account's messages");
    await page.locator(".profile-button").click();
    await page.getByRole("button", { name: "Show all accounts" }).click();
    await page.waitForSelector("text=Question About Lawncare");

    await page.goto(`${appUrl}&page=activity&accountEmail=s.stadnek96@gmail.com#stContext=${extensionContext}`);
    await page.waitForSelector(".auth-modal");
    await page.getByRole("button", { name: /Use harness account/i }).click();
    await page.locator(".profile-button").click();
    await page.waitForSelector("text=spencer.tpp@gmail.com");
    await page.waitForSelector("text=connected in this browser");
    assert.equal(
      await page.getByRole("button", { name: "Switch app login to spencer.tpp@gmail.com" }).count(),
      1,
      "extension-connected account should be switchable from the web app profile menu"
    );
    await page.getByLabel("Close account menu").click();

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

    await page.goto(connectUrl);
    await page.waitForSelector("h1:text('Connect Gmail')");
    await page.getByRole("button", { name: /Use harness account/i }).click();
    await page.waitForSelector("h1:text('Gmail connected')");
    await page.waitForSelector("text=without access keys");
  } finally {
    await browser.close();
  }
}

async function json(route, status, body) {
  await route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body)
  });
}
