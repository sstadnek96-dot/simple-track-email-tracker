export const API_BASE =
  import.meta.env.VITE_SIMPLE_TRACK_API_BASE ||
  "https://us-central1-simple-track-prod.cloudfunctions.net/api";

async function request(path, options = {}) {
  const token = await options.getToken?.();
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const contentType = response.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();

  if (!response.ok || body?.ok === false) {
    throw new Error(body?.error || `Request failed (${response.status})`);
  }

  return body;
}

export function fetchBootstrap(getToken) {
  return request("/app/bootstrap", { getToken });
}

export function fetchDashboard(getToken, accountEmail = "") {
  const query = accountEmail ? `?accountEmail=${encodeURIComponent(accountEmail)}` : "";
  return request(`/app/dashboard${query}`, { getToken });
}

export function createContact(getToken, contact) {
  return request("/app/contacts", { method: "POST", getToken, body: contact });
}

export function createPdfFile(getToken, file) {
  return request("/app/files", { method: "POST", getToken, body: file });
}

export function updateSettings(getToken, settings) {
  return request("/app/settings", { method: "PATCH", getToken, body: settings });
}

export function createPairingCode(getToken) {
  return request("/app/pairing-codes", { method: "POST", getToken });
}

export function connectExtension(getToken, connection) {
  return request("/app/connect-extension", { method: "POST", getToken, body: connection });
}

export function exportUrl(type) {
  return `${API_BASE}/app/export?type=${encodeURIComponent(type)}`;
}
