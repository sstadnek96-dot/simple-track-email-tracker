const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
const { getStorage } = require("firebase-admin/storage");
const { defineSecret } = require("firebase-functions/params");
const { setGlobalOptions } = require("firebase-functions/v2");
const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");

initializeApp();
setGlobalOptions({
  region: process.env.SIMPLE_TRACK_REGION || "us-central1",
  maxInstances: Number(process.env.SIMPLE_TRACK_MAX_INSTANCES || 10)
});

const db = getFirestore();
const storage = getStorage();
const simpleTrackIpHashSalt = defineSecret("SIMPLE_TRACK_IP_HASH_SALT");
const TRACKED_MESSAGES = "trackedMessages";
const USERS = "users";
const ORGS = "orgs";
const INSTALLS = "installs";
const PAIRING_CODES = "pairingCodes";
const PDF_FILES = "pdfFiles";
const RATE_LIMITS = "rateLimits";
const MAIL_ACCOUNTS = "mailAccounts";
const OPEN_GRACE_PERIOD_MS = Number(process.env.SIMPLE_TRACK_OPEN_GRACE_PERIOD_MS || 0);
const INTERACTION_GRACE_PERIOD_MS = Number(process.env.SIMPLE_TRACK_INTERACTION_GRACE_PERIOD_MS || 0);
const TRANSPARENT_GIF = Buffer.from(
  "R0lGODlhAQABAPAAAP///wAAACH5BAAAAAAALAAAAAABAAEAAAICRAEAOw==",
  "base64"
);

exports.api = onRequest({ secrets: [simpleTrackIpHashSalt], timeoutSeconds: 3600 }, async (req, res) => {
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.status(204).send("");
    return;
  }

  try {
    const route = normalizeRoute(req.path);

    if (req.method === "GET" && route === "/install/status") {
      await getExtensionInstallStatus(req, res);
      return;
    }

    if (route === "/app" || route.startsWith("/app/")) {
      await handleAppRequest(req, res, route);
      return;
    }

    if (req.method === "POST" && route === "/messages") {
      await createTrackedMessage(req, res);
      return;
    }

    if (req.method === "POST" && route === "/messages/activate") {
      await activateTrackedMessage(req, res);
      return;
    }

    if (req.method === "GET" && route === "/messages") {
      await listTrackedMessages(req, res);
      return;
    }

    if (req.method === "GET" && route === "/events") {
      streamTrackedEvents(req, res);
      return;
    }

    res.status(404).json({ ok: false, error: "Not found" });
  } catch (error) {
    logger.error("Simple Track API error", error);
    res.status(error.statusCode || 500).json({ ok: false, error: error.statusCode ? error.message : "Internal server error" });
  }
});

exports.pixel = onRequest({ secrets: [simpleTrackIpHashSalt] }, async (req, res) => {
  applyPixelHeaders(res);

  try {
    if (req.method === "GET") {
      await recordEventFromRequest(req, "open");
    }
  } catch (error) {
    logger.warn("Pixel event was not recorded", { error: error.message });
  }

  res.status(200).send(TRANSPARENT_GIF);
});

exports.click = onRequest({ secrets: [simpleTrackIpHashSalt] }, async (req, res) => {
  const destination = safeRedirectUrl(req.query.u);

  try {
    if (req.method === "GET") {
      const kind = normalizeEventKind(req.query.k);
      const eventType = isAttachmentEventKind(kind) ? "attachment_open" : "click";

      await recordEventFromRequest(req, eventType, {
        url: cleanString(destination, 1000),
        label: cleanString(req.query.l, 240),
        kind
      });
    }
  } catch (error) {
    logger.warn("Click event was not recorded", { error: error.message });
  }

  res.redirect(302, destination || "https://www.google.com");
});

exports.file = onRequest({ secrets: [simpleTrackIpHashSalt] }, async (req, res) => {
  try {
    if (req.method !== "GET") {
      res.status(405).send("Method not allowed");
      return;
    }

    await recordPdfFileView(req, res);
  } catch (error) {
    logger.warn("PDF file event was not recorded", { error: error.message });
    res.redirect(302, "https://simple-track-prod-app.web.app");
  }
});

async function createTrackedMessage(req, res) {
  const body = await readJson(req);
  const installId = cleanString(body.installId, 120);
  const installSecret = getInstallSecretFromRequest(req, body);
  const accountEmail = normalizeEmail(body.accountEmail);
  const subject = cleanString(body.subject, 300) || "Tracked email";
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.map((recipient) => cleanString(recipient, 320)).filter(Boolean).slice(0, 25)
    : [];
  const client = cleanString(body.client, 80) || "Webmail";
  const now = Timestamp.now();
  const trackingToken = randomToken();
  const docRef = db.collection(TRACKED_MESSAGES).doc();
  const linkedInstall = installId ? await getInstallForId(installId) : null;
  const installAuthorized = isInstallSecretValid(linkedInstall, installSecret);
  const connectedAccount = installAuthorized ? getConnectedAccount(linkedInstall, accountEmail) : null;

  if (linkedInstall?.installSecretHash && !installAuthorized) {
    res.status(401).json({ ok: false, error: "Install authentication failed" });
    return;
  }

  if (accountEmail && hasConnectedAccounts(linkedInstall) && !connectedAccount) {
    res.status(403).json({ ok: false, error: "This Gmail account is not connected to Simple Track yet" });
    return;
  }

  const message = {
    installId,
    orgId: connectedAccount?.orgId || linkedInstall?.orgId || null,
    accountEmail,
    subject,
    recipients,
    client,
    trackingTokenHash: hashSecret(trackingToken),
    senderFingerprint: getRequestFingerprint(req),
    status: "sent",
    opens: 0,
    clicks: 0,
    attachmentOpens: 0,
    sentAt: now,
    lastActivityAt: null,
    lastOpenAt: null,
    lastClickAt: null,
    muted: false,
    createdAt: now,
    updatedAt: now
  };

  await docRef.set(message);

  const publicBaseUrl = getPublicBaseUrl(req);
  const apiBaseUrl = `${publicBaseUrl}/api`;
  const pixelUrl = `${publicBaseUrl}/pixel?m=${encodeURIComponent(docRef.id)}&t=${encodeURIComponent(trackingToken)}`;
  const clickPrefix = `${publicBaseUrl}/click?m=${encodeURIComponent(docRef.id)}&t=${encodeURIComponent(trackingToken)}&u=`;
  const activationUrl = `${apiBaseUrl}/messages/activate?m=${encodeURIComponent(docRef.id)}&t=${encodeURIComponent(trackingToken)}`;

  res.status(201).json({
    ok: true,
    message: serializeMessage(docRef.id, message),
    tracking: {
      pixelUrl,
      clickPrefix,
      activationUrl,
      pixelHtml: `<img src="${escapeHtml(pixelUrl)}" width="1" height="1" alt="" style="width:1px;height:1px;opacity:0;border:0;display:block;" />`
    }
  });
}

async function activateTrackedMessage(req, res) {
  const messageId = cleanString(req.query.m, 160);
  const token = cleanString(req.query.t, 240);

  if (!messageId || !token) {
    res.status(400).json({ ok: false, error: "Missing activation token" });
    return;
  }

  const messageRef = db.collection(TRACKED_MESSAGES).doc(messageId);
  const now = Timestamp.now();
  let activated = false;

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(messageRef);
    if (!snapshot.exists) return;

    const message = snapshot.data();
    if (message.trackingTokenHash !== hashSecret(token)) return;

    activated = true;
    transaction.update(messageRef, {
      activatedAt: message.activatedAt || now,
      sentAt: message.activatedAt ? message.sentAt : now,
      updatedAt: now
    });
  });

  if (!activated) {
    res.status(404).json({ ok: false, error: "Tracked message not found" });
    return;
  }

  const snapshot = await messageRef.get();
  res.status(200).json({
    ok: true,
    message: await serializeMessageWithEffectiveStats(snapshot)
  });
}

async function listTrackedMessages(req, res) {
  const installId = cleanString(req.query.installId, 120);
  const accountEmail = normalizeEmail(req.query.accountEmail);

  if (!installId) {
    res.status(400).json({ ok: false, error: "Missing installId" });
    return;
  }

  const install = await getInstallForId(installId);
  if (install?.installSecretHash && !isInstallSecretValid(install, getInstallSecretFromRequest(req))) {
    res.status(401).json({ ok: false, error: "Install authentication failed" });
    return;
  }

  const snapshot = await db
    .collection(TRACKED_MESSAGES)
    .where("installId", "==", installId)
    .limit(100)
    .get();

  const messages = (await Promise.all(snapshot.docs.map((doc) => serializeMessageWithEffectiveStats(doc))))
    .filter((message) => !accountEmail || message.accountEmail === accountEmail)
    .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());

  res.status(200).json({ ok: true, messages });
}

function streamTrackedEvents(req, res) {
  const installId = cleanString(req.query.installId, 120);
  const accountEmail = normalizeEmail(req.query.accountEmail);

  if (!installId) {
    res.status(400).json({ ok: false, error: "Missing installId" });
    return;
  }

  getInstallForId(installId).then((install) => {
    if (install?.installSecretHash && !isInstallSecretValid(install, getInstallSecretFromRequest(req))) {
      res.status(401).json({ ok: false, error: "Install authentication failed" });
      return;
    }

    startTrackedEventStream(req, res, installId, accountEmail);
  }).catch((error) => {
    logger.warn("Simple Track event stream auth failed", { error: error.message });
    res.status(500).json({ ok: false, error: "Event stream failed" });
  });
}

function startTrackedEventStream(req, res, installId, accountEmail = "") {
  res.set("Content-Type", "text/event-stream");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.set("Connection", "keep-alive");
  res.set("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  let closed = false;

  const sendEvent = (eventName, payload) => {
    if (closed || res.destroyed) return;
    res.write(`event: ${eventName}\n`);
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  const heartbeat = setInterval(() => {
    if (closed || res.destroyed) return;
    res.write(`: simple-track ${Date.now()}\n\n`);
  }, 25000);

  let unsubscribe = () => {};

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe();
  };

  unsubscribe = db
    .collection(TRACKED_MESSAGES)
    .where("installId", "==", installId)
    .limit(100)
    .onSnapshot(
      async (snapshot) => {
        for (const change of snapshot.docChanges()) {
          if (closed) return;
          const message = await serializeMessageWithEffectiveStats(change.doc);
          if (accountEmail && message.accountEmail !== accountEmail) continue;
          sendEvent("message", {
            ok: true,
            changeType: change.type,
            message
          });
        }
      },
      (error) => {
        logger.warn("Simple Track event stream failed", { error: error.message });
        sendEvent("stream-error", { ok: false, error: "Event stream failed" });
        cleanup();
        res.end();
      }
    );

  req.on("close", cleanup);
  sendEvent("ready", { ok: true });
}

async function handleAppRequest(req, res, route) {
  const appRoute = route.replace(/^\/app/, "") || "/";

  if (req.method === "POST" && appRoute === "/pair-install") {
    await enforceAppRateLimit(req, "pair-install", 20, 15 * 60);
    await pairInstallWithCode(req, res);
    return;
  }

  if (req.method === "POST" && appRoute === "/extension-session") {
    await enforceAppRateLimit(req, "extension-session", 60, 15 * 60);
    await createExtensionAppSession(req, res);
    return;
  }

  const context = await requireAppContext(req);

  if (req.method === "GET" && appRoute === "/bootstrap") {
    const connectedAccounts = await getOrgMailAccounts(context.org.id);
    res.status(200).json({
      ok: true,
      user: context.user,
      org: context.org,
      membership: context.membership,
      plan: context.org.plan || getDefaultPlan(),
      installCount: await countOrgInstalls(context.org.id),
      connectedAccounts
    });
    return;
  }

  if (req.method === "GET" && appRoute === "/dashboard") {
    res.status(200).json({ ok: true, data: await buildDashboardData(context) });
    return;
  }

  if (req.method === "GET" && appRoute === "/activity") {
    const messages = await getOrgMessages(context.org.id);
    const files = await getOrgFiles(context.org.id);
    res.status(200).json({ ok: true, activity: buildActivityTimeline(messages, files) });
    return;
  }

  if (req.method === "GET" && appRoute === "/messages") {
    res.status(200).json({ ok: true, messages: await getOrgMessages(context.org.id) });
    return;
  }

  if (req.method === "GET" && appRoute === "/link-clicks") {
    const messages = await getOrgMessages(context.org.id);
    res.status(200).json({ ok: true, links: buildLinkClickReport(messages) });
    return;
  }

  if (req.method === "GET" && appRoute === "/pdf-analytics") {
    res.status(200).json({ ok: true, files: await getOrgFiles(context.org.id), plan: context.org.plan || getDefaultPlan() });
    return;
  }

  if (req.method === "GET" && appRoute === "/performance") {
    const messages = await getOrgMessages(context.org.id);
    const files = await getOrgFiles(context.org.id);
    res.status(200).json({ ok: true, performance: buildPerformanceReport(messages, files) });
    return;
  }

  if (req.method === "GET" && appRoute === "/contacts") {
    const messages = await getOrgMessages(context.org.id);
    res.status(200).json({ ok: true, contacts: await buildContactsReport(context.org.id, messages) });
    return;
  }

  if (req.method === "POST" && appRoute === "/contacts") {
    await enforceAppRateLimit(req, "contacts", 60, 60 * 60);
    await createContact(context, req, res);
    return;
  }

  if (req.method === "POST" && appRoute === "/files") {
    await enforceAppRateLimit(req, "files", 30, 60 * 60);
    await createPdfFile(context, req, res);
    return;
  }

  if (req.method === "POST" && appRoute === "/connect-extension") {
    await enforceAppRateLimit(req, "connect-extension", 30, 15 * 60);
    await connectExtensionAccount(context, req, res);
    return;
  }

  if (req.method === "GET" && appRoute === "/settings") {
    res.status(200).json({ ok: true, settings: context.org.settings || getDefaultOrgSettings(), plan: context.org.plan || getDefaultPlan() });
    return;
  }

  if (req.method === "PATCH" && appRoute === "/settings") {
    await enforceAppRateLimit(req, "settings", 60, 60 * 60);
    await updateOrgSettings(context, req, res);
    return;
  }

  if (req.method === "POST" && appRoute === "/pairing-codes") {
    await enforceAppRateLimit(req, "pairing-codes", 20, 15 * 60);
    await createPairingCode(context, res);
    return;
  }

  if (req.method === "GET" && appRoute === "/export") {
    await exportOrgCsv(context, req, res);
    return;
  }

  res.status(404).json({ ok: false, error: "App route not found" });
}

async function requireAppContext(req) {
  const token = getBearerToken(req);
  if (!token) {
    const error = new Error("Missing authentication token");
    error.statusCode = 401;
    throw error;
  }

  const decoded = await getAuth().verifyIdToken(token);
  return ensureUserWorkspace(decoded);
}

async function ensureUserWorkspace(decoded) {
  const uid = cleanString(decoded.uid, 160);
  const email = cleanString(decoded.email, 320);
  const displayName = cleanString(decoded.name, 160) || email || "Simple Track User";
  const photoURL = cleanString(decoded.picture, 1000);
  const now = Timestamp.now();
  const userRef = db.collection(USERS).doc(uid);
  const orgRef = db.collection(ORGS).doc(uid);
  const membershipRef = orgRef.collection("memberships").doc(uid);

  await db.runTransaction(async (transaction) => {
    const [userSnapshot, orgSnapshot, membershipSnapshot] = await Promise.all([
      transaction.get(userRef),
      transaction.get(orgRef),
      transaction.get(membershipRef)
    ]);

    transaction.set(userRef, {
      uid,
      email,
      displayName,
      photoURL,
      providers: Array.isArray(decoded.firebase?.sign_in_provider) ? decoded.firebase.sign_in_provider : [decoded.firebase?.sign_in_provider].filter(Boolean),
      lastLoginAt: now,
      updatedAt: now,
      createdAt: userSnapshot.exists ? userSnapshot.data().createdAt : now
    }, { merge: true });

    if (!orgSnapshot.exists) {
      transaction.set(orgRef, {
        name: displayName ? `${displayName}'s workspace` : "Simple Track workspace",
        ownerUid: uid,
        plan: getDefaultPlan(),
        settings: getDefaultOrgSettings(),
        createdAt: now,
        updatedAt: now
      });
    } else {
      transaction.update(orgRef, { updatedAt: now });
    }

    if (!membershipSnapshot.exists) {
      transaction.set(membershipRef, {
        uid,
        email,
        role: "owner",
        createdAt: now,
        updatedAt: now
      });
    }
  });

  const [userSnapshot, orgSnapshot, membershipSnapshot] = await Promise.all([
    userRef.get(),
    orgRef.get(),
    membershipRef.get()
  ]);

  const org = { id: orgSnapshot.id, ...serializeTimestamps(orgSnapshot.data()) };
  return {
    uid,
    user: { id: userSnapshot.id, ...serializeTimestamps(userSnapshot.data()) },
    org,
    membership: { id: membershipSnapshot.id, ...serializeTimestamps(membershipSnapshot.data()) }
  };
}

async function buildDashboardData(context) {
  const messages = await getOrgMessages(context.org.id);
  const files = await getOrgFiles(context.org.id);
  const contacts = await buildContactsReport(context.org.id, messages);

  return {
    messages,
    activity: buildActivityTimeline(messages, files),
    links: buildLinkClickReport(messages),
    files,
    contacts,
    connectedAccounts: await getOrgMailAccounts(context.org.id),
    performance: buildPerformanceReport(messages, files),
    settings: context.org.settings || getDefaultOrgSettings(),
    plan: context.org.plan || getDefaultPlan()
  };
}

async function getOrgMailAccounts(orgId) {
  const snapshot = await db
    .collection(ORGS)
    .doc(orgId)
    .collection(MAIL_ACCOUNTS)
    .orderBy("updatedAt", "desc")
    .limit(25)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...serializeTimestamps(doc.data()) }));
}

async function connectExtensionAccount(context, req, res) {
  const body = await readJson(req);
  const installId = cleanString(body.installId, 120);
  const installSecret = cleanString(body.installSecret, 240);
  const accountEmail = normalizeEmail(body.accountEmail);
  const provider = cleanString(body.provider, 40) || "google";
  const client = cleanString(body.client, 80) || "Gmail";
  const accountDisplayName = cleanString(body.accountDisplayName, 160) || context.user.displayName || accountEmail;
  const accountPhotoURL = cleanString(body.accountPhotoURL || body.accountPhotoUrl || context.user.photoURL, 1000);

  if (!installId || !installSecret || !accountEmail) {
    res.status(400).json({ ok: false, error: "Install ID, install secret, and account email are required" });
    return;
  }

  if (normalizeEmail(context.user.email) !== accountEmail) {
    res.status(409).json({
      ok: false,
      code: "account_mismatch",
      error: `Sign in with ${accountEmail} to connect this Gmail account.`,
      signedInEmail: context.user.email,
      requestedEmail: accountEmail
    });
    return;
  }

  const now = Timestamp.now();
  const account = {
    email: accountEmail,
    displayName: accountDisplayName,
    photoURL: accountPhotoURL,
    provider,
    client,
    orgId: context.org.id,
    userUid: context.uid,
    installId,
    connectedAt: now,
    updatedAt: now,
    status: "connected"
  };
  const installRef = db.collection(INSTALLS).doc(installId);
  const accountRef = db.collection(ORGS).doc(context.org.id).collection(MAIL_ACCOUNTS).doc(accountEmail);
  const installAccountRef = installRef.collection(MAIL_ACCOUNTS).doc(accountEmail);
  const installSnapshot = await installRef.get();
  const messagesSnapshot = await db
    .collection(TRACKED_MESSAGES)
    .where("installId", "==", installId)
    .limit(450)
    .get();
  const batch = db.batch();

  batch.set(installRef, {
    installId,
    installSecretHash: hashSecret(installSecret),
    orgId: context.org.id,
    ownerUid: context.uid,
    activeAccountEmail: accountEmail,
    accounts: {
      [accountEmail]: {
        email: accountEmail,
        displayName: accountDisplayName,
        photoURL: accountPhotoURL,
        orgId: context.org.id,
        userUid: context.uid,
        provider,
        client,
        connectedAt: now,
        updatedAt: now,
        status: "connected"
      }
    },
    updatedAt: now,
    createdAt: installSnapshot.exists ? (installSnapshot.data().createdAt || now) : now
  }, { merge: true });
  batch.set(accountRef, account, { merge: true });
  batch.set(installAccountRef, account, { merge: true });

  for (const doc of messagesSnapshot.docs) {
    const message = doc.data();
    if (message.accountEmail && message.accountEmail !== accountEmail) continue;
    batch.update(doc.ref, { orgId: context.org.id, accountEmail, updatedAt: now });
  }

  await batch.commit();
  await writeAuditLog(context, "mail_account.connect", "mailAccount", accountEmail, {
    installId,
    linkedMessages: messagesSnapshot.size
  });

  res.status(200).json({
    ok: true,
    account: { id: accountEmail, ...serializeTimestamps(account) },
    installId,
    linkedMessages: messagesSnapshot.size
  });
}

async function createExtensionAppSession(req, res) {
  const body = await readJson(req);
  const installId = cleanString(body.installId, 120);
  const accountEmail = normalizeEmail(body.accountEmail);

  if (!installId || !accountEmail) {
    res.status(400).json({ ok: false, error: "Install ID and account email are required" });
    return;
  }

  const install = await getInstallForId(installId);
  if (!install?.installSecretHash || !isInstallSecretValid(install, getInstallSecretFromRequest(req, body))) {
    res.status(401).json({ ok: false, error: "Install authentication failed" });
    return;
  }

  const connectedAccount = getConnectedAccount(install, accountEmail);
  if (!connectedAccount?.userUid) {
    res.status(403).json({ ok: false, error: `${accountEmail} is not connected to this extension install` });
    return;
  }

  const customToken = await getAuth().createCustomToken(connectedAccount.userUid, {
    simpleTrackAccountEmail: accountEmail,
    simpleTrackInstallId: installId
  });

  res.status(200).json({
    ok: true,
    customToken,
    accountEmail,
    activeAccountEmail: accountEmail,
    connectedAccounts: getInstallConnectedAccounts(install),
    account: serializeTimestamps({
      ...connectedAccount,
      email: accountEmail
    })
  });
}

async function getExtensionInstallStatus(req, res) {
  const installId = cleanString(req.query.installId, 120);
  const accountEmail = normalizeEmail(req.query.accountEmail);

  if (!installId) {
    res.status(400).json({ ok: false, error: "Missing installId" });
    return;
  }

  const install = await getInstallForId(installId);
  if (!install?.installSecretHash || !isInstallSecretValid(install, getInstallSecretFromRequest(req))) {
    res.status(401).json({ ok: false, error: "Install authentication failed" });
    return;
  }

  const connectedAccounts = getInstallConnectedAccounts(install);
  const selectedAccount = accountEmail
    ? connectedAccounts.find((account) => account.email === accountEmail)
    : null;

  res.status(200).json({
    ok: true,
    installId,
    activeAccountEmail: install.activeAccountEmail || connectedAccounts[0]?.email || "",
    connectedAccounts,
    accountStatus: getAccountConnectionStatus(install, accountEmail),
    account: selectedAccount || null
  });
}

async function getOrgMessages(orgId) {
  const snapshot = await db
    .collection(TRACKED_MESSAGES)
    .where("orgId", "==", orgId)
    .limit(250)
    .get();

  return (await Promise.all(snapshot.docs.map((doc) => serializeMessageWithEffectiveStats(doc))))
    .sort((a, b) => new Date(b.lastActivityAt || b.sentAt).getTime() - new Date(a.lastActivityAt || a.sentAt).getTime());
}

async function getOrgFiles(orgId) {
  const snapshot = await db
    .collection(ORGS)
    .doc(orgId)
    .collection(PDF_FILES)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  return snapshot.docs.map((doc) => ({ id: doc.id, ...serializeTimestamps(doc.data()) }));
}

function buildActivityTimeline(messages, files = []) {
  const messageEvents = messages.flatMap((message) => {
    const events = Array.isArray(message.events) ? message.events : [];
    if (events.length === 0 && message.lastActivityAt) {
      return [{
        id: `${message.id}:summary`,
        type: message.status === "clicked" ? "click" : "open",
        subject: message.subject,
        recipient: message.recipients?.[0] || "",
        accountEmail: message.accountEmail || "",
        createdAt: message.lastActivityAt,
        source: "email",
        messageId: message.id
      }];
    }

    return events.map((event, index) => ({
      id: `${message.id}:${index}:${event.createdAt}`,
      type: event.type,
      subject: message.subject,
      recipient: message.recipients?.[0] || "",
      accountEmail: message.accountEmail || "",
      label: event.label || null,
      url: event.url || null,
      device: event.device || message.device || null,
      location: event.location || message.location || null,
      createdAt: event.createdAt,
      source: "email",
      messageId: message.id
    }));
  });

  const fileEvents = files
    .filter((file) => Number(file.views || 0) > 0 || Number(file.downloads || 0) > 0)
    .map((file) => ({
      id: `file:${file.id}`,
      type: Number(file.downloads || 0) > 0 ? "pdf_download" : "pdf_view",
      subject: file.name,
      recipient: "",
      createdAt: file.lastActivityAt || file.createdAt,
      source: "pdf",
      fileId: file.id
    }));

  return [...messageEvents, ...fileEvents]
    .sort((a, b) => new Date(b.createdAt || 0).getTime() - new Date(a.createdAt || 0).getTime())
    .slice(0, 200);
}

function buildLinkClickReport(messages) {
  return messages.flatMap((message) => {
    const events = Array.isArray(message.events) ? message.events : [];
    return events
      .filter((event) => event.type === "click" || event.type === "attachment_open")
      .map((event, index) => ({
        id: `${message.id}:${index}:${event.createdAt}`,
        messageId: message.id,
        accountEmail: message.accountEmail || "",
        subject: message.subject,
        recipient: message.recipients?.[0] || "",
        label: event.label || getUrlHost(event.url),
        url: event.url || "",
        kind: event.kind || (event.type === "attachment_open" ? "document" : "link"),
        type: event.type,
        clickedAt: event.createdAt,
        device: event.device || message.device || null,
        location: event.location || message.location || null
      }));
  }).sort((a, b) => new Date(b.clickedAt || 0).getTime() - new Date(a.clickedAt || 0).getTime());
}

async function buildContactsReport(orgId, messages) {
  const contacts = new Map();

  for (const message of messages) {
    for (const recipient of message.recipients || []) {
      const key = String(recipient).toLowerCase();
      if (!key) continue;
      const existing = contacts.get(key) || {
        id: key,
        name: recipient,
        email: recipient,
        domain: recipient.includes("@") ? recipient.split("@").pop() : "",
        lastContactedAt: null,
        lastHeardFromAt: null,
        opens: 0,
        clicks: 0,
        unsubscribed: false,
        hardBounced: false
      };

      existing.lastContactedAt = maxIso(existing.lastContactedAt, message.sentAt);
      existing.lastHeardFromAt = maxIso(existing.lastHeardFromAt, message.lastActivityAt);
      existing.opens += Number(message.opens || 0);
      existing.clicks += Number(message.clicks || 0);
      contacts.set(key, existing);
    }
  }

  const manualSnapshot = await db
    .collection(ORGS)
    .doc(orgId)
    .collection("contacts")
    .limit(500)
    .get();

  for (const doc of manualSnapshot.docs) {
    const contact = { id: doc.id, ...serializeTimestamps(doc.data()) };
    const key = String(contact.email || doc.id).toLowerCase();
    contacts.set(key, { ...(contacts.get(key) || {}), ...contact, id: doc.id });
  }

  return [...contacts.values()].sort((a, b) => new Date(b.lastHeardFromAt || b.lastContactedAt || 0).getTime() - new Date(a.lastHeardFromAt || a.lastContactedAt || 0).getTime());
}

function buildPerformanceReport(messages, files = []) {
  const sent = messages.length;
  const opened = messages.filter((message) => Number(message.opens || 0) > 0).length;
  const clicked = messages.filter((message) => Number(message.clicks || 0) > 0).length;
  const pdfViewed = files.filter((file) => Number(file.views || 0) > 0).length;
  const totalOpens = messages.reduce((sum, message) => sum + Number(message.opens || 0), 0);
  const totalClicks = messages.reduce((sum, message) => sum + Number(message.clicks || 0), 0);

  return {
    totals: {
      sent,
      opened,
      clicked,
      pdfViewed,
      totalOpens,
      totalClicks,
      openRate: sent ? Math.round((opened / sent) * 100) : 0,
      clickRate: sent ? Math.round((clicked / sent) * 100) : 0,
      pdfRate: files.length ? Math.round((pdfViewed / files.length) * 100) : 0
    },
    heatmap: buildSendHeatmap(messages),
    sentByDay: groupMessagesByDay(messages, "sentAt"),
    openedByDay: groupMessagesByDay(messages, "lastActivityAt")
  };
}

function buildSendHeatmap(messages) {
  const grid = Array.from({ length: 7 }, (_, day) => (
    Array.from({ length: 24 }, (_, hour) => ({ day, hour, count: 0 }))
  ));

  for (const message of messages) {
    const date = new Date(message.sentAt || 0);
    if (!Number.isFinite(date.getTime())) continue;
    grid[date.getDay()][date.getHours()].count += 1;
  }

  return grid.flat();
}

function groupMessagesByDay(messages, field) {
  const counts = new Map();
  for (const message of messages) {
    const date = new Date(message[field] || 0);
    if (!Number.isFinite(date.getTime())) continue;
    const key = date.toISOString().slice(0, 10);
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, count]) => ({ date, count }));
}

async function createContact(context, req, res) {
  const body = await readJson(req);
  const email = cleanString(body.email, 320).toLowerCase();
  if (!email || !email.includes("@")) {
    res.status(400).json({ ok: false, error: "Valid email is required" });
    return;
  }

  const now = Timestamp.now();
  const contact = {
    email,
    name: cleanString(body.name, 160) || email,
    domain: email.split("@").pop(),
    phone: cleanString(body.phone, 80) || "",
    source: "manual",
    unsubscribed: Boolean(body.unsubscribed),
    hardBounced: Boolean(body.hardBounced),
    updatedAt: now,
    createdAt: now
  };
  const ref = db.collection(ORGS).doc(context.org.id).collection("contacts").doc(email);
  await ref.set(contact, { merge: true });
  await writeAuditLog(context, "contact.upsert", "contact", email, { email });
  res.status(201).json({ ok: true, contact: { id: ref.id, ...serializeTimestamps(contact) } });
}

async function createPdfFile(context, req, res) {
  const body = await readJson(req);
  const name = cleanString(body.name || body.filename, 240) || "Tracked PDF";
  const contentType = cleanString(body.contentType, 120) || "application/pdf";
  const size = Math.max(0, Number(body.size || 0));
  const now = Timestamp.now();
  const token = randomToken();
  const fileRef = db.collection(ORGS).doc(context.org.id).collection(PDF_FILES).doc();
  const storagePath = `orgs/${context.org.id}/pdfs/${fileRef.id}/${safeFileName(name)}`;
  const publicBaseUrl = getPublicBaseUrl(req);
  const trackingUrl = `${publicBaseUrl}/file?f=${encodeURIComponent(fileRef.id)}&o=${encodeURIComponent(context.org.id)}&t=${encodeURIComponent(token)}`;
  let uploadUrl = null;

  try {
    const [signedUrl] = await storage.bucket().file(storagePath).getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + 15 * 60 * 1000,
      contentType
    });
    uploadUrl = signedUrl;
  } catch (error) {
    logger.warn("Could not create signed upload URL", { error: error.message });
  }

  const file = {
    orgId: context.org.id,
    name,
    contentType,
    size,
    storagePath,
    trackingTokenHash: hashSecret(token),
    trackingUrl,
    views: 0,
    downloads: 0,
    timeSpentSeconds: 0,
    visitedPages: 0,
    createdByUid: context.uid,
    createdAt: now,
    updatedAt: now,
    lastActivityAt: null
  };

  await fileRef.set(file);
  await writeAuditLog(context, "pdf.create", "pdfFile", fileRef.id, { name, size });
  res.status(201).json({ ok: true, file: { id: fileRef.id, ...serializeTimestamps(file) }, uploadUrl });
}

async function recordPdfFileView(req, res) {
  const fileId = cleanString(req.query.f, 160);
  const orgId = cleanString(req.query.o, 160);
  const token = cleanString(req.query.t, 240);
  const isDownload = String(req.query.d || "") === "1";

  if (!fileId || !orgId || !token) {
    res.status(400).send("Missing file token");
    return;
  }

  const fileRef = db.collection(ORGS).doc(orgId).collection(PDF_FILES).doc(fileId);
  const snapshot = await fileRef.get();
  if (!snapshot.exists || snapshot.data().trackingTokenHash !== hashSecret(token)) {
    res.status(404).send("File not found");
    return;
  }

  const now = Timestamp.now();
  await fileRef.update({
    views: FieldValue.increment(isDownload ? 0 : 1),
    downloads: FieldValue.increment(isDownload ? 1 : 0),
    lastActivityAt: now,
    updatedAt: now
  });

  const file = snapshot.data();
  try {
    const [readUrl] = await storage.bucket().file(file.storagePath).getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + 10 * 60 * 1000
    });
    res.redirect(302, readUrl);
  } catch {
    res.status(200).send("PDF tracking recorded. Upload the file before sharing this link.");
  }
}

async function updateOrgSettings(context, req, res) {
  const body = await readJson(req);
  const current = context.org.settings || getDefaultOrgSettings();
  const settings = {
    ...current,
    trackEmailsByDefault: toBoolean(body.trackEmailsByDefault, current.trackEmailsByDefault),
    trackClicksByDefault: toBoolean(body.trackClicksByDefault, current.trackClicksByDefault),
    privacyMode: toBoolean(body.privacyMode, current.privacyMode),
    retentionDays: clampNumber(body.retentionDays, 1, 365, current.retentionDays),
    brandedDomain: cleanString(body.brandedDomain, 240) || current.brandedDomain || "",
    notifications: {
      ...current.notifications,
      emailOpened: toBoolean(body.notifications?.emailOpened, current.notifications.emailOpened),
      linkClicked: toBoolean(body.notifications?.linkClicked, current.notifications.linkClicked),
      pdfViewed: toBoolean(body.notifications?.pdfViewed, current.notifications.pdfViewed)
    }
  };

  await db.collection(ORGS).doc(context.org.id).update({
    settings,
    updatedAt: Timestamp.now()
  });
  await writeAuditLog(context, "settings.update", "org", context.org.id, { keys: Object.keys(body) });
  res.status(200).json({ ok: true, settings });
}

async function createPairingCode(context, res) {
  const code = randomPairingCode();
  const now = Timestamp.now();
  const expiresAt = Timestamp.fromMillis(Date.now() + 15 * 60 * 1000);
  const doc = {
    orgId: context.org.id,
    createdByUid: context.uid,
    createdAt: now,
    expiresAt,
    usedAt: null
  };

  await db.collection(PAIRING_CODES).doc(hashSecret(code)).set(doc);
  await writeAuditLog(context, "pairing_code.create", "org", context.org.id, {});
  res.status(201).json({ ok: true, code, expiresAt: toIsoString(expiresAt) });
}

async function pairInstallWithCode(req, res) {
  const body = await readJson(req);
  const code = cleanString(body.code, 40).toUpperCase();
  const installId = cleanString(body.installId, 120);

  if (!code || !installId) {
    res.status(400).json({ ok: false, error: "Pairing code and install ID are required" });
    return;
  }

  const pairingRef = db.collection(PAIRING_CODES).doc(hashSecret(code));
  const pairingSnapshot = await pairingRef.get();
  if (!pairingSnapshot.exists) {
    res.status(404).json({ ok: false, error: "Pairing code not found" });
    return;
  }

  const pairing = pairingSnapshot.data();
  if (pairing.usedAt || toDate(pairing.expiresAt)?.getTime() < Date.now()) {
    res.status(410).json({ ok: false, error: "Pairing code expired" });
    return;
  }

  const now = Timestamp.now();
  const installRef = db.collection(INSTALLS).doc(installId);
  const messagesSnapshot = await db
    .collection(TRACKED_MESSAGES)
    .where("installId", "==", installId)
    .limit(450)
    .get();
  const batch = db.batch();

  batch.set(installRef, {
    installId,
    orgId: pairing.orgId,
    pairedByUid: pairing.createdByUid,
    pairedAt: now,
    updatedAt: now
  }, { merge: true });
  batch.update(pairingRef, { usedAt: now, installId });
  for (const doc of messagesSnapshot.docs) {
    batch.update(doc.ref, { orgId: pairing.orgId, updatedAt: now });
  }
  await batch.commit();

  await writeAuditLog({ uid: pairing.createdByUid, org: { id: pairing.orgId } }, "install.pair", "install", installId, {
    messageCount: messagesSnapshot.size
  });
  res.status(200).json({ ok: true, installId, orgId: pairing.orgId, linkedMessages: messagesSnapshot.size });
}

async function exportOrgCsv(context, req, res) {
  const type = cleanString(req.query.type, 40) || "email-tracking";
  const messages = await getOrgMessages(context.org.id);
  const files = await getOrgFiles(context.org.id);
  const contacts = await buildContactsReport(context.org.id, messages);
  const rows = getCsvRows(type, messages, files, contacts);

  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="simple-track-${type}.csv"`);
  res.status(200).send(toCsv(rows));
}

function getCsvRows(type, messages, files, contacts) {
  if (type === "link-clicks") {
    return [
      ["Recipient", "Subject", "Label", "URL", "Type", "Clicked At", "Device", "Location"],
      ...buildLinkClickReport(messages).map((row) => [row.recipient, row.subject, row.label, row.url, row.type, row.clickedAt, row.device, row.location])
    ];
  }

  if (type === "pdf-analytics") {
    return [
      ["Name", "Views", "Downloads", "Time Spent", "Created At", "Last Activity"],
      ...files.map((file) => [file.name, file.views || 0, file.downloads || 0, file.timeSpentSeconds || 0, file.createdAt, file.lastActivityAt])
    ];
  }

  if (type === "contacts") {
    return [
      ["Name", "Email", "Domain", "Last Contacted", "Last Heard From", "Opens", "Clicks", "Unsubscribed", "Hard Bounced"],
      ...contacts.map((contact) => [contact.name, contact.email, contact.domain, contact.lastContactedAt, contact.lastHeardFromAt, contact.opens || 0, contact.clicks || 0, contact.unsubscribed, contact.hardBounced])
    ];
  }

  return [
    ["Recipients", "Subject", "Sent At", "Last Activity", "Opens", "Clicks", "Files", "Status"],
    ...messages.map((message) => [(message.recipients || []).join("; "), message.subject, message.sentAt, message.lastActivityAt, message.opens, message.clicks, message.attachmentOpens, message.status])
  ];
}

async function writeAuditLog(context, action, targetType, targetId, metadata = {}) {
  const orgId = context.org?.id;
  if (!orgId) return;

  await db.collection(ORGS).doc(orgId).collection("auditLogs").add({
    actorUid: context.uid || null,
    action,
    targetType,
    targetId,
    metadata,
    createdAt: Timestamp.now()
  });
}

async function enforceAppRateLimit(req, action, maxRequests, windowSeconds) {
  const ipHash = hashIp(getRequestIp(req)) || "unknown";
  const windowMs = windowSeconds * 1000;
  const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
  const ref = db.collection(RATE_LIMITS).doc(hashSecret(`app:${action}:${ipHash}:${windowStart}`));

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref);
    const currentCount = snapshot.exists ? Number(snapshot.data().count || 0) : 0;
    if (currentCount >= maxRequests) {
      const error = new Error("Too many requests. Please try again shortly.");
      error.statusCode = 429;
      throw error;
    }

    transaction.set(ref, {
      action,
      ipHash,
      windowStart: Timestamp.fromMillis(windowStart),
      windowSeconds,
      count: currentCount + 1,
      updatedAt: Timestamp.now(),
      expiresAt: Timestamp.fromMillis(windowStart + (windowMs * 2))
    }, { merge: true });
  });
}

function getInstallConnectedAccounts(install) {
  const accounts = install?.accounts && typeof install.accounts === "object" ? install.accounts : {};
  return Object.values(accounts)
    .filter((account) => account && account.email)
    .map((account) => serializeTimestamps({
      email: normalizeEmail(account.email),
      displayName: cleanString(account.displayName, 160) || normalizeEmail(account.email),
      photoURL: cleanString(account.photoURL || account.photoUrl, 1000),
      provider: cleanString(account.provider, 40) || "google",
      client: cleanString(account.client, 80) || "Gmail",
      orgId: cleanString(account.orgId, 160),
      status: cleanString(account.status, 40) || "connected",
      connectedAt: account.connectedAt || null,
      updatedAt: account.updatedAt || null
    }))
    .sort((a, b) => new Date(b.updatedAt || b.connectedAt || 0).getTime() - new Date(a.updatedAt || a.connectedAt || 0).getTime());
}

function getConnectedAccount(install, accountEmail) {
  if (!install || !accountEmail) return null;
  const accounts = install.accounts && typeof install.accounts === "object" ? install.accounts : {};
  const account = accounts[accountEmail];
  return account?.status === "connected" ? account : null;
}

function hasConnectedAccounts(install) {
  return getInstallConnectedAccounts(install).length > 0;
}

function getAccountConnectionStatus(install, accountEmail) {
  const connectedAccounts = getInstallConnectedAccounts(install);
  if (!accountEmail) {
    return {
      status: connectedAccounts.length > 0 ? "connected_unknown_account" : "not_connected",
      accountEmail: "",
      connectedAccounts
    };
  }

  const account = connectedAccounts.find((entry) => entry.email === accountEmail);
  return {
    status: account ? "connected" : "not_connected",
    accountEmail,
    connectedAccounts,
    account: account || null
  };
}

function isInstallSecretValid(install, installSecret) {
  if (!install?.installSecretHash) return true;
  return Boolean(installSecret && install.installSecretHash === hashSecret(installSecret));
}

function getInstallSecretFromRequest(req, body = null) {
  return cleanString(
    body?.installSecret ||
    req.get("x-simple-track-install-secret") ||
    req.query.s ||
    req.query.installSecret,
    240
  );
}

async function getInstallForId(installId) {
  const snapshot = await db.collection(INSTALLS).doc(installId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function countOrgInstalls(orgId) {
  const snapshot = await db.collection(INSTALLS).where("orgId", "==", orgId).limit(1000).get();
  return snapshot.size;
}

async function recordEventFromRequest(req, eventType, extraEvent = {}) {
  const messageId = cleanString(req.query.m, 160);
  const token = cleanString(req.query.t, 240);

  if (!messageId || !token) return;

  const messageRef = db.collection(TRACKED_MESSAGES).doc(messageId);
  const now = Timestamp.now();
  const event = {
    type: eventType,
    createdAt: now,
    userAgent: cleanString(req.get("user-agent"), 500),
    referer: cleanString(req.get("referer"), 500),
    ipHash: hashIp(getRequestIp(req)),
    requestFingerprint: getRequestFingerprint(req),
    device: summarizeUserAgent(req.get("user-agent")),
    location: getRequestLocation(req),
    ...extraEvent
  };

  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(messageRef);
    if (!snapshot.exists) return;

    const message = snapshot.data();
    if (message.trackingTokenHash !== hashSecret(token)) return;

    if (!message.activatedAt) {
      transaction.set(messageRef.collection("events").doc(), {
        ...event,
        ignored: true,
        ignoreReason: "not_activated"
      });
      return;
    }

    const ignoreReason = getEventIgnoreReason(message, event, eventType, now);
    if (ignoreReason) {
      transaction.set(messageRef.collection("events").doc(), {
        ...event,
        ignored: true,
        ignoreReason
      });
      return;
    }

    const updates = {
      updatedAt: now,
      lastActivityAt: now,
      device: event.device,
      location: event.location
    };

    if (eventType === "open") {
      updates.status = Number(message.clicks || 0) > 0 ? "clicked" : "opened";
      updates.opens = FieldValue.increment(1);
      updates.lastOpenAt = now;
    }

    if (eventType === "click") {
      updates.status = "clicked";
      updates.clicks = FieldValue.increment(1);
      updates.lastClickAt = now;
    }

    if (eventType === "attachment_open") {
      updates.status = Number(message.clicks || 0) > 0 ? "clicked" : "opened";
      updates.attachmentOpens = FieldValue.increment(1);
      updates.lastAttachmentOpenAt = now;
    }

    updates.latestEvent = toPublicEvent(event);
    updates.recentEvents = [
      updates.latestEvent,
      ...(Array.isArray(message.recentEvents) ? message.recentEvents : [])
    ].slice(0, 20);

    transaction.set(messageRef.collection("events").doc(), event);
    transaction.update(messageRef, updates);
  });
}

async function serializeMessageWithEffectiveStats(doc) {
  const data = doc.data();
  const serialized = serializeMessage(doc.id, data);
  const storedOpenCount = Number(data.opens || 0);
  const storedClickCount = Number(data.clicks || 0);
  const storedAttachmentOpenCount = Number(data.attachmentOpens || 0);
  const storedEvents = getStoredRecentEvents(data);

  if (storedEvents.length > 0 || data.latestEvent) {
    const opens = storedClickCount > 0 || storedAttachmentOpenCount > 0
      ? Math.max(1, storedOpenCount)
      : storedOpenCount;

    return {
      ...serialized,
      status: getStatusFromCounts(opens, storedClickCount, storedAttachmentOpenCount),
      opens,
      clicks: storedClickCount,
      attachmentOpens: storedAttachmentOpenCount,
      events: storedEvents
    };
  }

  if (storedOpenCount === 0 && storedClickCount === 0 && storedAttachmentOpenCount === 0) {
    return serialized;
  }

  const eventsSnapshot = await doc.ref
    .collection("events")
    .orderBy("createdAt", "asc")
    .limit(500)
    .get();

  if (eventsSnapshot.empty) {
    return serialized;
  }

  const countableEvents = eventsSnapshot.docs
    .map((eventDoc) => eventDoc.data())
    .filter((event) => isCountableEvent(data, event));

  const trackedOpens = countableEvents.filter((event) => event.type === "open").length;
  const clicks = countableEvents.filter((event) => event.type === "click").length;
  const attachmentOpens = countableEvents.filter((event) => event.type === "attachment_open").length;
  const opens = clicks > 0 || attachmentOpens > 0 ? Math.max(1, trackedOpens) : trackedOpens;
  const lastEvent = countableEvents[countableEvents.length - 1] || null;

  return {
    ...serialized,
    status: getStatusFromCounts(opens, clicks, attachmentOpens),
    opens,
    clicks,
    attachmentOpens,
    lastActivityAt: toIsoString(lastEvent?.createdAt),
    device: lastEvent?.device || null,
    location: lastEvent?.location || null,
    events: countableEvents.slice(-20).reverse().map(serializeEvent)
  };
}

function serializeEvent(event) {
  return serializePublicEvent(event);
}

function toPublicEvent(event) {
  return {
    type: event.type,
    createdAt: event.createdAt,
    device: event.device || null,
    location: event.location || null,
    label: event.label || null,
    kind: event.kind || null,
    url: event.url || null
  };
}

function serializePublicEvent(event) {
  return {
    type: event.type,
    createdAt: toIsoString(event.createdAt),
    device: event.device || null,
    location: event.location || null,
    label: event.label || null,
    kind: event.kind || null,
    url: event.url || null
  };
}

function getStoredRecentEvents(data) {
  if (Array.isArray(data.recentEvents) && data.recentEvents.length > 0) {
    return data.recentEvents.slice(0, 20).map(serializePublicEvent);
  }

  if (data.latestEvent) return [serializePublicEvent(data.latestEvent)];
  return [];
}

function isCountableEvent(message, event) {
  if (!event || event.ignored) return false;
  if (event.type === "open") return !isSenderDirectOpen(message, event);
  if (event.type === "click" || event.type === "attachment_open") return true;
  return false;
}

function getEventIgnoreReason(message, event, eventType, eventTime) {
  if (eventType === "open" && isSenderDirectOpen(message, event)) return "sender_direct_open";

  if (eventType === "open") {
    return isWithinGracePeriod(message, eventTime, OPEN_GRACE_PERIOD_MS) ? "open_grace_period" : "";
  }

  if (eventType === "click" || eventType === "attachment_open") {
    return isWithinGracePeriod(message, eventTime, INTERACTION_GRACE_PERIOD_MS)
      ? getEarlyEventIgnoreReason(eventType)
      : "";
  }

  return "";
}

function getEarlyEventIgnoreReason(eventType) {
  if (eventType === "open") return "open_grace_period";
  if (eventType === "click") return "click_grace_period";
  if (eventType === "attachment_open") return "attachment_grace_period";
  return "event_grace_period";
}

function isSenderDirectOpen(message, event) {
  return Boolean(
    message.senderFingerprint &&
    event.requestFingerprint &&
    message.senderFingerprint === event.requestFingerprint &&
    !isKnownImageProxy(event.userAgent)
  );
}

function isKnownImageProxy(userAgent) {
  const value = String(userAgent || "").toLowerCase();
  return value.includes("googleimageproxy") ||
    value.includes("google image proxy") ||
    value.includes("microsoft outlook") ||
    value.includes("microsoft office");
}

function isWithinGracePeriod(message, eventTime, gracePeriodMs) {
  const sentAt = toDate(message.sentAt || message.createdAt);
  const occurredAt = toDate(eventTime);

  if (!sentAt || !occurredAt) return false;

  const age = occurredAt.getTime() - sentAt.getTime();
  return age >= 0 && age < gracePeriodMs;
}

function getStatusFromCounts(opens, clicks, attachmentOpens = 0) {
  if (clicks > 0) return "clicked";
  if (opens > 0 || attachmentOpens > 0) return "opened";
  return "sent";
}

function normalizeEventKind(value) {
  const kind = cleanString(value, 20).toLowerCase();
  return ["link", "pdf", "document"].includes(kind) ? kind : "link";
}

function isAttachmentEventKind(kind) {
  return kind === "pdf" || kind === "document";
}

function applyCors(req, res) {
  const origin = req.get("origin") || "*";
  res.set("Access-Control-Allow-Origin", origin);
  res.set("Vary", "Origin");
  res.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Authorization,Content-Type,X-Simple-Track-Client,X-Simple-Track-Install-Secret");
  res.set("Access-Control-Max-Age", "3600");
}

function applyPixelHeaders(res) {
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("X-Content-Type-Options", "nosniff");
}

function getBearerToken(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function getDefaultPlan() {
  return {
    tier: "free",
    limits: {
      pdfs: 5,
      contacts: 500,
      trackedMessages: 1000
    }
  };
}

function getDefaultOrgSettings() {
  return {
    trackEmailsByDefault: true,
    trackClicksByDefault: true,
    privacyMode: false,
    retentionDays: 90,
    brandedDomain: "",
    notifications: {
      emailOpened: true,
      linkClicked: true,
      pdfViewed: true
    }
  };
}

function serializeTimestamps(value) {
  if (!value || typeof value !== "object") return value;
  if (value instanceof Timestamp || typeof value.toDate === "function") return toIsoString(value);
  if (Array.isArray(value)) return value.map(serializeTimestamps);

  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, serializeTimestamps(entry)])
  );
}

function maxIso(a, b) {
  const aTime = new Date(a || 0).getTime();
  const bTime = new Date(b || 0).getTime();
  if (!Number.isFinite(aTime)) return b || null;
  if (!Number.isFinite(bTime)) return a || null;
  return bTime > aTime ? b : a;
}

function getUrlHost(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return "tracked link";
  }
}

function safeFileName(value) {
  return cleanString(value, 180)
    .replace(/[^a-z0-9._ -]/gi, "_")
    .replace(/\s+/g, "-") || "tracked-file.pdf";
}

function randomPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  return [...bytes].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function toBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  return Boolean(fallback);
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function toCsv(rows) {
  return rows
    .map((row) => row.map((cell) => {
      const value = String(cell ?? "");
      return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
    }).join(","))
    .join("\n");
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body.trim()) return JSON.parse(req.body);
  return {};
}

function normalizeRoute(pathname) {
  const route = `/${String(pathname || "").replace(/^\/+/, "")}`;
  return route === "/" ? "/messages" : route;
}

function getPublicBaseUrl(req) {
  const protocol = cleanString(req.get("x-forwarded-proto"), 20) || req.protocol || "https";
  const host = req.get("host");
  return `${protocol}://${host}`;
}

function serializeMessage(id, data) {
  return {
    id,
    orgId: data.orgId || null,
    accountEmail: normalizeEmail(data.accountEmail),
    subject: data.subject || "Tracked email",
    recipients: Array.isArray(data.recipients) ? data.recipients : [],
    client: data.client || "Webmail",
    status: data.status || "sent",
    opens: Number(data.opens || 0),
    clicks: Number(data.clicks || 0),
    attachmentOpens: Number(data.attachmentOpens || 0),
    sentAt: toIsoString(data.sentAt),
    lastActivityAt: toIsoString(data.lastActivityAt),
    device: data.device || null,
    location: data.location || null,
    events: getStoredRecentEvents(data),
    muted: Boolean(data.muted)
  };
}

function toIsoString(value) {
  const date = toDate(value);
  if (date) return date.toISOString();
  if (typeof value === "string") return value;
  return null;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Timestamp) return value.toDate();
  if (typeof value.toDate === "function") return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === "string") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashSecret(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.SIMPLE_TRACK_IP_HASH_SALT || "simple-track-dev-salt";
  return crypto.createHash("sha256").update(`${salt}:${ip}`).digest("hex");
}

function getRequestFingerprint(req) {
  const ipHash = hashIp(getRequestIp(req));
  const userAgent = cleanString(req.get("user-agent"), 500);
  if (!ipHash || !userAgent) return null;
  return hashSecret(`${ipHash}:${userAgent}`);
}

function getRequestIp(req) {
  const forwarded = req.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return req.ip || "";
}

function getRequestLocation(req) {
  const country = req.get("x-appengine-country") || req.get("cf-ipcountry");
  const region = req.get("x-appengine-region");
  const city = req.get("x-appengine-city");
  return [city, region, country].filter(Boolean).join(", ") || "Unknown";
}

function summarizeUserAgent(userAgent) {
  const value = String(userAgent || "");
  const browser = value.includes("Edg/")
    ? "Edge"
    : value.includes("Chrome/")
      ? "Chrome"
      : value.includes("Firefox/")
        ? "Firefox"
        : value.includes("Safari/")
          ? "Safari"
          : "Unknown browser";
  const platform = value.includes("Windows")
    ? "Windows"
    : value.includes("Mac OS X")
      ? "macOS"
      : value.includes("Android")
        ? "Android"
        : value.includes("iPhone") || value.includes("iPad")
          ? "iOS"
          : "Unknown device";

  return `${browser} on ${platform}`;
}

function safeRedirectUrl(value) {
  const rawValue = Array.isArray(value) ? value[0] : value;
  try {
    const url = new URL(String(rawValue || ""));
    if (url.protocol === "https:" || url.protocol === "http:") return url.toString();
  } catch {
    return null;
  }

  return null;
}

function cleanString(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function normalizeEmail(value) {
  return cleanString(value, 320).toLowerCase();
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
