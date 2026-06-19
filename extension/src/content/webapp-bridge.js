const SIMPLE_TRACK_WEB_ORIGINS = new Set([
  "https://simple-track-prod-app.web.app",
  "https://simple-track-prod-app.firebaseapp.com"
]);

const SIMPLE_TRACK_WEB_REQUESTS = new Set([
  "simpleTrack:createWebAppSession",
  "simpleTrack:getConnectedAccounts"
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
