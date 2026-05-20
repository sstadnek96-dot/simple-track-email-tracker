const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { FieldValue, Timestamp, getFirestore } = require("firebase-admin/firestore");
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
const simpleTrackIpHashSalt = defineSecret("SIMPLE_TRACK_IP_HASH_SALT");
const TRACKED_MESSAGES = "trackedMessages";
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
    res.status(500).json({ ok: false, error: "Internal server error" });
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

async function createTrackedMessage(req, res) {
  const body = await readJson(req);
  const installId = cleanString(body.installId, 120);
  const subject = cleanString(body.subject, 300) || "Tracked email";
  const recipients = Array.isArray(body.recipients)
    ? body.recipients.map((recipient) => cleanString(recipient, 320)).filter(Boolean).slice(0, 25)
    : [];
  const client = cleanString(body.client, 80) || "Webmail";
  const now = Timestamp.now();
  const trackingToken = randomToken();
  const docRef = db.collection(TRACKED_MESSAGES).doc();

  const message = {
    installId,
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

  if (!installId) {
    res.status(400).json({ ok: false, error: "Missing installId" });
    return;
  }

  const snapshot = await db
    .collection(TRACKED_MESSAGES)
    .where("installId", "==", installId)
    .limit(100)
    .get();

  const messages = (await Promise.all(snapshot.docs.map((doc) => serializeMessageWithEffectiveStats(doc))))
    .sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());

  res.status(200).json({ ok: true, messages });
}

function streamTrackedEvents(req, res) {
  const installId = cleanString(req.query.installId, 120);

  if (!installId) {
    res.status(400).json({ ok: false, error: "Missing installId" });
    return;
  }

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
  res.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.set("Access-Control-Allow-Headers", "Content-Type,X-Simple-Track-Client");
  res.set("Access-Control-Max-Age", "3600");
}

function applyPixelHeaders(res) {
  res.set("Content-Type", "image/gif");
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("X-Content-Type-Options", "nosniff");
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

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
