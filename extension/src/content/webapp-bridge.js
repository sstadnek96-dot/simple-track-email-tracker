const SIMPLE_TRACK_WEB_ORIGINS = new Set([
  "https://simple-track-prod-app.web.app",
  "https://simple-track-prod-app.firebaseapp.com"
]);

const SIMPLE_TRACK_WEB_REQUESTS = new Set([
  "simpleTrack:createWebAppSession",
  "simpleTrack:getConnectedAccounts",
  "simpleTrack:disconnectAccount",
  "simpleTrack:startAccountConnection",
  "simpleTrack:refreshAccountConnection",
  "simpleTrack:connectSignedInAccount"
]);

let extensionContextInvalidated = false;

window.addEventListener("message", (event) => {
  if (event.source !== window || !SIMPLE_TRACK_WEB_ORIGINS.has(event.origin)) return;

  const request = event.data || {};
  if (request.source !== "simple-track-web-app" || !SIMPLE_TRACK_WEB_REQUESTS.has(request.type)) return;
  if (extensionContextInvalidated || !globalThis.chrome?.runtime?.sendMessage) {
    postExtensionResponse(event, request, { ok: false, error: "Extension context unavailable. Reload this page after reloading Simple Track." });
    return;
  }

  try {
    chrome.runtime.sendMessage(request.payload || { type: request.type }, (response) => {
      const error = chrome.runtime.lastError?.message;
      if (isExtensionContextInvalidatedError(error)) extensionContextInvalidated = true;
      postExtensionResponse(event, request, error ? { ok: false, error } : response);
    });
  } catch (error) {
    if (isExtensionContextInvalidatedError(error)) extensionContextInvalidated = true;
    postExtensionResponse(event, request, { ok: false, error: getErrorMessage(error) });
  }
});

if (globalThis.chrome?.runtime?.onMessage) {
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (!["simpleTrack:accountDisconnected", "simpleTrack:accountConnectionChanged"].includes(message?.type)) return false;

      const eventDetail = {
        type: message.type,
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
  } catch (error) {
    if (!isExtensionContextInvalidatedError(error)) {
      console.warn("Simple Track web bridge listener failed", getErrorMessage(error));
    }
    extensionContextInvalidated = true;
  }
}

function postExtensionResponse(event, request, response) {
  const ok = Boolean(response?.ok);
  window.postMessage({
    source: "simple-track-extension",
    requestId: request.requestId || "",
    ok,
    response: response || { ok: false, error: "No extension response" }
  }, event.origin);
}

function isExtensionContextInvalidatedError(error) {
  return /extension context invalidated/i.test(getErrorMessage(error));
}

function getErrorMessage(error) {
  return String(error?.message || error || "");
}
