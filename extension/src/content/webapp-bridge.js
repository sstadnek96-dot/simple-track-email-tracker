const SIMPLE_TRACK_WEB_ORIGINS = new Set([
  "https://simple-track-prod-app.web.app",
  "https://simple-track-prod-app.firebaseapp.com"
]);

const SIMPLE_TRACK_WEB_REQUESTS = new Set([
  "simpleTrack:createWebAppSession",
  "simpleTrack:getConnectedAccounts",
  "simpleTrack:disconnectAccount"
]);

window.addEventListener("message", (event) => {
  if (event.source !== window || !SIMPLE_TRACK_WEB_ORIGINS.has(event.origin)) return;

  const request = event.data || {};
  if (request.source !== "simple-track-web-app" || !SIMPLE_TRACK_WEB_REQUESTS.has(request.type)) return;

  chrome.runtime.sendMessage(request.payload || { type: request.type }, (response) => {
    const error = chrome.runtime.lastError?.message;
    window.postMessage({
      source: "simple-track-extension",
      requestId: request.requestId || "",
      ok: !error && Boolean(response?.ok),
      response: error ? { ok: false, error } : response
    }, event.origin);
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "simpleTrack:accountDisconnected") return false;

  const eventDetail = {
    type: "simpleTrack:accountDisconnected",
    accountEmail: message.accountEmail || "",
    connectedAccounts: message.connectedAccounts || [],
    knownAccounts: message.knownAccounts || [],
    activeAccountEmail: message.activeAccountEmail || ""
  };

  window.postMessage({
    source: "simple-track-extension-event",
    ...eventDetail
  }, window.location.origin);

  window.dispatchEvent(new CustomEvent("simple-track-extension-event", { detail: eventDetail }));

  return false;
});
