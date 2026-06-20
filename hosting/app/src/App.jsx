import { useEffect, useMemo, useState } from "react";
import { getAdditionalUserInfo, GoogleAuthProvider, onAuthStateChanged, signInWithCustomToken, signInWithPopup, signOut } from "firebase/auth";
import {
  Activity,
  BarChart3,
  Bell,
  Check,
  ChevronDown,
  Download,
  Eye,
  FileText,
  Gauge,
  Link as LinkIcon,
  Loader2,
  LogOut,
  Mail,
  Menu,
  MoreHorizontal,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Upload,
  Users,
  X
} from "lucide-react";
import { auth, googleProvider, microsoftProvider } from "./firebase";
import {
  createContact,
  connectExtension,
  createPdfFile,
  fetchBootstrap,
  fetchDashboard,
  updateSettings
} from "./api";
import { mockBootstrap, mockDashboard } from "./mockData";

const NAV = [
  { id: "activity", label: "Latest activity", icon: Activity, group: "Home" },
  { id: "email", label: "Email tracking", icon: Mail, group: "Reports" },
  { id: "links", label: "Link clicks", icon: LinkIcon, group: "Reports" },
  { id: "pdf", label: "PDF analytics", icon: FileText, group: "Reports" },
  { id: "performance", label: "My performance", icon: BarChart3, group: "Reports" },
  { id: "crm", label: "MyCRM", icon: Users, group: "Data hub" },
  { id: "settings", label: "Settings & account", icon: Settings, group: "Settings" }
];

const HOUR_LABELS = Array.from({ length: 24 }, (_, hour) => `${hour}:00`);
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PROFILE_PHOTO_CACHE_KEY = "simpleTrack.profilePhotos";
const EXTENSION_SESSION_CACHE_KEY = "simpleTrack.extensionSession";
const EXTENSION_BRIDGE_TIMEOUT_MS = 2200;

function harnessAllowed() {
  const params = new URLSearchParams(window.location.search);
  return params.has("harness") || ["localhost", "127.0.0.1"].includes(window.location.hostname);
}

function readAppRouteParams() {
  const params = new URLSearchParams(window.location.search);
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const page = params.get("page") || hash.get("page");
  const accountEmail = normalizeAccountEmail(params.get("accountEmail") || hash.get("accountEmail"));
  return {
    activePage: NAV.some((item) => item.id === page) ? page : "activity",
    focusedMessageId: params.get("messageId") || hash.get("messageId") || "",
    accountEmail,
    extensionContext: readExtensionContext(params, hash)
  };
}

function readExtensionContext(searchParams, hashParams) {
  const encoded = hashParams.get("stContext") || searchParams.get("stContext") || "";
  const context = decodeRouteContext(encoded);
  const connectedAccounts = Array.isArray(context?.connectedAccounts)
    ? context.connectedAccounts.map(normalizeAccountRecord).filter(Boolean)
    : [];
  const knownAccounts = Array.isArray(context?.knownAccounts)
    ? context.knownAccounts.map(normalizeAccountRecord).filter(Boolean)
    : [];

  return {
    extensionId: String(context?.extensionId || ""),
    installId: String(context?.installId || ""),
    activeAccountEmail: normalizeAccountEmail(context?.activeAccountEmail),
    handoffAccountEmail: normalizeAccountEmail(context?.handoffAccountEmail),
    handoffToken: String(context?.handoffToken || ""),
    handoffTokens: normalizeHandoffTokens(context),
    connectedAccounts,
    knownAccounts
  };
}

function normalizeHandoffTokens(context) {
  const tokens = {};
  const rawTokens = context?.handoffTokens && typeof context.handoffTokens === "object" ? context.handoffTokens : {};

  for (const [email, token] of Object.entries(rawTokens)) {
    const normalizedEmail = normalizeAccountEmail(email);
    if (normalizedEmail && token) tokens[normalizedEmail] = String(token);
  }

  const legacyEmail = normalizeAccountEmail(context?.handoffAccountEmail);
  if (legacyEmail && context?.handoffToken) {
    tokens[legacyEmail] = String(context.handoffToken);
  }

  return tokens;
}

function getHandoffToken(extensionContext, accountEmail = "") {
  const normalizedEmail = normalizeAccountEmail(accountEmail);
  if (!normalizedEmail) return "";
  return extensionContext?.handoffTokens?.[normalizedEmail] || "";
}

function extensionContextHasAccount(extensionContext, accountEmail = "") {
  const normalizedEmail = normalizeAccountEmail(accountEmail);
  if (!normalizedEmail) return false;
  return Boolean(
    getHandoffToken(extensionContext, normalizedEmail) ||
    (extensionContext?.connectedAccounts || []).some((account) => normalizeAccountEmail(account.email) === normalizedEmail)
  );
}

function hasExtensionContext(context) {
  return Boolean(
    context?.extensionId ||
    context?.installId ||
    Object.keys(context?.handoffTokens || {}).length ||
    context?.connectedAccounts?.length ||
    context?.knownAccounts?.length
  );
}

function mergeExtensionContexts(...contexts) {
  const merged = {
    extensionId: "",
    installId: "",
    activeAccountEmail: "",
    handoffAccountEmail: "",
    handoffToken: "",
    handoffTokens: {},
    connectedAccounts: [],
    knownAccounts: []
  };
  const byEmail = new Map();
  const knownByEmail = new Map();

  for (const context of contexts) {
    if (!context) continue;
    merged.extensionId = context.extensionId || merged.extensionId;
    merged.installId = context.installId || merged.installId;
    merged.activeAccountEmail = context.activeAccountEmail || merged.activeAccountEmail;
    merged.handoffAccountEmail = context.handoffAccountEmail || merged.handoffAccountEmail;
    merged.handoffToken = context.handoffToken || merged.handoffToken;
    merged.handoffTokens = { ...merged.handoffTokens, ...(context.handoffTokens || {}) };

    for (const account of context.connectedAccounts || []) {
      const normalized = normalizeAccountRecord(account);
      if (!normalized) continue;
      const existing = byEmail.get(normalized.email);
      byEmail.set(normalized.email, {
        ...existing,
        ...normalized,
        photoURL: existing?.photoURL || normalized.photoURL
      });
    }

    for (const account of context.knownAccounts || []) {
      const normalized = normalizeAccountRecord(account);
      if (!normalized) continue;
      const existing = knownByEmail.get(normalized.email);
      knownByEmail.set(normalized.email, {
        ...existing,
        ...normalized,
        photoURL: existing?.photoURL || normalized.photoURL
      });
    }
  }

  merged.connectedAccounts = [...byEmail.values()];
  merged.knownAccounts = [...knownByEmail.values()];
  return merged;
}

function readStoredExtensionContext() {
  if (typeof window === "undefined") return null;

  try {
    const stored = JSON.parse(window.localStorage.getItem(EXTENSION_SESSION_CACHE_KEY) || "null");
    if (!stored) return null;
    return {
      extensionId: String(stored.extensionId || ""),
      installId: String(stored.installId || ""),
      activeAccountEmail: normalizeAccountEmail(stored.activeAccountEmail),
      handoffAccountEmail: normalizeAccountEmail(stored.handoffAccountEmail),
      handoffToken: String(stored.handoffToken || ""),
      handoffTokens: normalizeHandoffTokens(stored),
      connectedAccounts: Array.isArray(stored.connectedAccounts)
        ? stored.connectedAccounts.map(normalizeAccountRecord).filter(Boolean)
        : [],
      knownAccounts: Array.isArray(stored.knownAccounts)
        ? stored.knownAccounts.map(normalizeAccountRecord).filter(Boolean)
        : []
    };
  } catch {
    return null;
  }
}

function writeStoredExtensionContext(context) {
  if (typeof window === "undefined") return;

  try {
    if (!hasExtensionContext(context)) {
      window.localStorage.removeItem(EXTENSION_SESSION_CACHE_KEY);
      return;
    }

    window.localStorage.setItem(EXTENSION_SESSION_CACHE_KEY, JSON.stringify({
      ...context,
      handoffAccountEmail: "",
      handoffToken: "",
      handoffTokens: {},
      savedAt: Date.now()
    }));
  } catch {
    // Switching still works from the current URL context if local storage is unavailable.
  }
}

function decodeRouteContext(encoded) {
  if (!encoded) return null;

  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(encoded.length / 4) * 4, "=");
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function normalizeAccountRecord(account) {
  const email = normalizeAccountEmail(account?.email);
  if (!email) return null;

  return {
    email,
    displayName: account.displayName || account.name || email,
    photoURL: account.photoURL || account.photoUrl || "",
    provider: account.provider || "google",
    client: account.client || "Gmail",
    status: account.status || "connected"
  };
}

function getInitials(user) {
  const source = user?.displayName || user?.email || "ST";
  return source
    .split(/\s+|@/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("") || "ST";
}

function toUser(authUser, photoURLOverride = "") {
  const email = normalizeAccountEmail(authUser.email);
  return {
    displayName: authUser.displayName || authUser.email || "Simple Track User",
    email: authUser.email || "",
    photoURL: photoURLOverride || getAuthUserPhotoURL(authUser) || getCachedProfilePhoto(email),
    getIdToken: () => authUser.getIdToken()
  };
}

function getAuthUserPhotoURL(authUser) {
  return authUser?.photoURL ||
    authUser?.providerData?.find((profile) => profile?.photoURL)?.photoURL ||
    "";
}

async function getLoginProfilePhoto(result, providerName) {
  const email = normalizeAccountEmail(result?.user?.email);
  const additionalProfile = getAdditionalUserInfo(result)?.profile || {};
  const candidates = [
    getAuthUserPhotoURL(result?.user),
    additionalProfile.picture,
    additionalProfile.avatar_url
  ].filter(Boolean);

  if (candidates[0]) {
    setCachedProfilePhoto(email, candidates[0]);
    return candidates[0];
  }

  if (providerName === "google") {
    const credential = GoogleAuthProvider.credentialFromResult(result);
    const photoURL = await fetchGoogleProfilePhoto(credential?.accessToken);
    if (photoURL) {
      setCachedProfilePhoto(email, photoURL);
      return photoURL;
    }
  }

  return getCachedProfilePhoto(email);
}

async function fetchGoogleProfilePhoto(accessToken = "") {
  if (!accessToken) return "";

  try {
    const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (!response.ok) return "";
    const profile = await response.json();
    return profile.picture || "";
  } catch {
    return "";
  }
}

function getCachedProfilePhoto(email) {
  if (!email || typeof window === "undefined") return "";

  try {
    const cache = JSON.parse(window.localStorage.getItem(PROFILE_PHOTO_CACHE_KEY) || "{}");
    return cache[email] || "";
  } catch {
    return "";
  }
}

function setCachedProfilePhoto(email, photoURL) {
  if (!email || !photoURL || typeof window === "undefined") return;

  try {
    const cache = JSON.parse(window.localStorage.getItem(PROFILE_PHOTO_CACHE_KEY) || "{}");
    window.localStorage.setItem(PROFILE_PHOTO_CACHE_KEY, JSON.stringify({ ...cache, [email]: photoURL }));
  } catch {
    // The avatar can still fall back to initials if local storage is unavailable.
  }
}

function createHarnessUser() {
  return {
    displayName: "Spencer Stadnek",
    email: "s.stadnek96@gmail.com",
    photoURL: "",
    getIdToken: async () => "harness-token"
  };
}

function App() {
  const [routeParams] = useState(() => readAppRouteParams());
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState(null);
  const [bootstrap, setBootstrap] = useState(null);
  const [data, setData] = useState(null);
  const [activePage, setActivePage] = useState(routeParams.activePage);
  const [activeMailAccount, setActiveMailAccount] = useState(routeParams.accountEmail || "all");
  const [focusedMessageId, setFocusedMessageId] = useState(routeParams.focusedMessageId);
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [extensionSessionContext, setExtensionSessionContext] = useState(() => (
    mergeExtensionContexts(readStoredExtensionContext(), routeParams.extensionContext)
  ));
  const allowHarness = harnessAllowed();
  const isConnectPage = window.location.pathname === "/connect-extension";
  const profileAccounts = useMemo(
    () => mergeProfileAccounts(
      data?.connectedAccounts || bootstrap?.connectedAccounts || [],
      [
        ...(extensionSessionContext?.connectedAccounts || []),
        ...(extensionSessionContext?.knownAccounts || [])
      ]
    ),
    [data?.connectedAccounts, bootstrap?.connectedAccounts, extensionSessionContext]
  );
  const enrichedProfileAccounts = useMemo(
    () => enrichProfileAccounts(profileAccounts, user),
    [profileAccounts, user]
  );
  const selectedProfileAccount = useMemo(
    () => getSelectedProfileAccount(enrichedProfileAccounts, activeMailAccount, user),
    [enrichedProfileAccounts, activeMailAccount, user]
  );

  useEffect(() => {
    return onAuthStateChanged(auth, (authUser) => {
      setAuthReady(true);
      if (authUser) setUser(toUser(authUser));
    });
  }, []);

  useEffect(() => {
    if (!user) return;
    loadWorkspace();
  }, [user]);

  useEffect(() => {
    refreshExtensionAccountsFromBridge();
  }, []);

  useEffect(() => {
    function handleDisconnectedMessage(message = {}) {
      const disconnectedEmail = normalizeAccountEmail(message.accountEmail);
      if (!disconnectedEmail) return;

      const remainingAccounts = replaceDisconnectedAccountState(
        disconnectedEmail,
        Array.isArray(message.connectedAccounts) ? message.connectedAccounts : null,
        message.activeAccountEmail || "",
        Array.isArray(message.knownAccounts) ? message.knownAccounts : null
      );
      const nextEmail = normalizeAccountEmail(message.activeAccountEmail) || remainingAccounts[0]?.email || "";

      if (!remainingAccounts.length) {
        logout();
        return;
      }

      if (normalizeAccountEmail(activeMailAccount) === disconnectedEmail) {
        setActiveMailAccount(nextEmail);
        refreshDashboardForAccount(nextEmail);
      }
    }

    function handleExtensionEvent(event) {
      if (event.origin !== window.location.origin) return;
      const message = event.data || {};
      if (message.source !== "simple-track-extension-event" || message.type !== "simpleTrack:accountDisconnected") return;
      handleDisconnectedMessage(message);
    }

    function handleExtensionCustomEvent(event) {
      const message = event.detail || {};
      if (message.type !== "simpleTrack:accountDisconnected") return;
      handleDisconnectedMessage(message);
    }

    window.addEventListener("message", handleExtensionEvent);
    window.addEventListener("simple-track-extension-event", handleExtensionCustomEvent);
    return () => {
      window.removeEventListener("message", handleExtensionEvent);
      window.removeEventListener("simple-track-extension-event", handleExtensionCustomEvent);
    };
  }, [activeMailAccount, profileAccounts]);

  useEffect(() => {
    if (!hasExtensionContext(routeParams.extensionContext)) return;
    setExtensionSessionContext((current) => {
      const next = mergeExtensionContexts(current, routeParams.extensionContext);
      writeStoredExtensionContext(next);
      return next;
    });
  }, [routeParams.extensionContext]);

  useEffect(() => {
    if (!authReady) return;
    if (!hasExtensionContext(extensionSessionContext)) return;
    const requestedEmail = extensionSessionContext.handoffAccountEmail || routeParams.accountEmail;
    if (!requestedEmail) return;
    if (!extensionContextHasAccount(extensionSessionContext, requestedEmail)) return;
    const loggedInEmail = normalizeAccountEmail(user?.email);
    if (requestedEmail && loggedInEmail === requestedEmail) return;
    signInToMailAccount(requestedEmail);
  }, [authReady, extensionSessionContext, routeParams.accountEmail, user?.email]);

  async function getToken() {
    if (auth.currentUser?.getIdToken) return auth.currentUser.getIdToken();
    return user?.getIdToken ? user.getIdToken() : "";
  }

  function getDashboardAccountParam(accountEmail = "") {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    if (!normalizedEmail || normalizedEmail === "all") return "";
    return normalizedEmail;
  }

  async function loadWorkspace(accountEmailOverride = "") {
    setLoading(true);
    setError("");
    try {
      const dashboardAccount = getDashboardAccountParam(accountEmailOverride || routeParams.accountEmail || activeMailAccount);
      const [boot, dashboard] = await Promise.all([
        fetchBootstrap(getToken),
        fetchDashboard(getToken, dashboardAccount)
      ]);
      setBootstrap(boot);
      setData(dashboard.data);
      const firstAccount = routeParams.accountEmail || dashboard.data?.connectedAccounts?.[0]?.email || boot.connectedAccounts?.[0]?.email || "all";
      setActiveMailAccount((current) => {
        const currentEmail = normalizeAccountEmail(current);
        return currentEmail && currentEmail !== "all" ? currentEmail : firstAccount;
      });
      if (routeParams.focusedMessageId) setActivePage("email");
    } catch (loadError) {
      if (allowHarness) {
        setBootstrap(mockBootstrap);
        setData(mockDashboard);
        setActiveMailAccount((current) => {
          const currentEmail = normalizeAccountEmail(current);
          return currentEmail && currentEmail !== "all"
            ? currentEmail
            : routeParams.accountEmail || mockDashboard.connectedAccounts?.[0]?.email || "all";
        });
        if (routeParams.focusedMessageId) setActivePage("email");
      } else {
        setError(loadError.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function refreshDashboardForAccount(accountEmail) {
    const dashboardAccount = getDashboardAccountParam(accountEmail);
    setError("");
    try {
      const dashboard = await fetchDashboard(getToken, dashboardAccount);
      setData(dashboard.data);
    } catch (refreshError) {
      setError(refreshError.message);
    }
  }

  async function login(providerName, loginHint = "", options = {}) {
    setError("");
    try {
      const provider = providerName === "microsoft" ? microsoftProvider : googleProvider;
      provider.setCustomParameters({
        prompt: "select_account",
        ...(loginHint ? { login_hint: normalizeAccountEmail(loginHint) } : {})
      });
      const result = await signInWithPopup(auth, provider);
      const photoURL = await getLoginProfilePhoto(result, providerName);
      const nextUser = toUser(result.user, photoURL);
      setUser(nextUser);
      return nextUser;
    } catch (loginError) {
      setError(loginError.message);
      if (options.rethrow) throw loginError;
      return null;
    }
  }

  async function signInFromExtensionHandoff(customToken, accountEmail = "") {
    setError("");
    try {
      if (allowHarness && String(customToken).startsWith("harness-token")) {
        const normalizedEmail = normalizeAccountEmail(accountEmail);
        setUser({
          ...createHarnessUser(),
          email: normalizedEmail || "s.stadnek96@gmail.com",
          displayName: normalizedEmail === "spencer.tpp@gmail.com" ? "Spencer Stadnek" : "Spencer Davidson"
        });
        setBootstrap(mockBootstrap);
        setData(mockDashboard);
        if (normalizedEmail) setActiveMailAccount(normalizedEmail);
        return;
      }

      const result = await signInWithCustomToken(auth, customToken);
      const nextUser = toUser(result.user);
      setUser(nextUser);
      if (accountEmail) setActiveMailAccount(normalizeAccountEmail(accountEmail));
      return nextUser;
    } catch (sessionError) {
      setError(`Could not open ${accountEmail || "that account"} automatically. ${sessionError.message}`);
      return null;
    }
  }

  async function signInToMailAccount(accountEmail = "") {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    if (!normalizedEmail) return;

    const existingToken = getHandoffToken(extensionSessionContext, normalizedEmail);
    if (existingToken) {
      return signInFromExtensionHandoff(existingToken, normalizedEmail);
    }

    const session = await requestExtensionWebAppSession(normalizedEmail);
    if (session?.customToken) {
      rememberExtensionSession({
        handoffAccountEmail: normalizedEmail,
        handoffToken: session.customToken,
        handoffTokens: { [normalizedEmail]: session.customToken },
        connectedAccounts: session.connectedAccounts || []
      });
      return signInFromExtensionHandoff(session.customToken, normalizedEmail);
    }

    return null;
  }

  function requestExtensionWebAppSession(accountEmail = "") {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    if (!normalizedEmail) return Promise.resolve(null);
    const payload = {
      type: "simpleTrack:createWebAppSession",
      accountEmail: normalizedEmail
    };

    return firstSuccessfulExtensionResponse([
      requestExtensionBridge("simpleTrack:createWebAppSession", payload),
      requestExtensionExternal(payload)
    ]);
  }

  function requestExtensionDisconnectAccount(accountEmail = "") {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    if (!normalizedEmail) return Promise.resolve(null);
    const payload = {
      type: "simpleTrack:disconnectAccount",
      accountEmail: normalizedEmail
    };

    return firstSuccessfulExtensionResponse([
      requestExtensionBridge("simpleTrack:disconnectAccount", payload),
      requestExtensionExternal(payload)
    ]);
  }

  function requestExtensionStartAccountConnection(accountEmail = "", account = {}) {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    if (!normalizedEmail) return Promise.resolve(null);
    const accountRecord = normalizeAccountRecord({ ...account, email: normalizedEmail }) || { email: normalizedEmail };
    const payload = {
      type: "simpleTrack:startAccountConnection",
      accountEmail: normalizedEmail,
      client: accountRecord.client || getMailClientLabel(accountRecord),
      returnUrl: "",
      openOnly: true
    };

    return firstSuccessfulExtensionResponse([
      requestExtensionBridge("simpleTrack:startAccountConnection", payload),
      requestExtensionExternal(payload)
    ]);
  }

  function requestExtensionExternal(payload) {
    const extensionId = extensionSessionContext?.extensionId;
    const runtime = window.chrome?.runtime;

    if (!extensionId || !runtime?.sendMessage) return Promise.resolve(null);

    return new Promise((resolve) => {
      try {
        runtime.sendMessage(extensionId, payload, (response) => {
          const lastError = runtime.lastError?.message;
          resolve(lastError || !response?.ok ? null : response);
        });
      } catch {
        resolve(null);
      }
    });
  }

  function firstSuccessfulExtensionResponse(promises) {
    return new Promise((resolve) => {
      let pending = promises.length;
      let settled = false;

      for (const promise of promises) {
        Promise.resolve(promise).then((response) => {
          if (settled) return;
          if (response?.ok) {
            settled = true;
            resolve(response);
            return;
          }
          pending -= 1;
          if (pending === 0) resolve(null);
        }).catch(() => {
          pending -= 1;
          if (!settled && pending === 0) resolve(null);
        });
      }
    });
  }

  async function refreshExtensionAccountsFromBridge() {
    const response = await requestExtensionBridge("simpleTrack:getConnectedAccounts", {
      type: "simpleTrack:getConnectedAccounts"
    });

    if (!response?.ok) return;

    rememberExtensionSession({
      extensionId: response.extensionId || "",
      activeAccountEmail: response.activeAccountEmail || "",
      connectedAccounts: response.connectedAccounts || []
    });
  }

  function requestExtensionBridge(type, payload) {
    if (typeof window === "undefined") return Promise.resolve(null);

    return new Promise((resolve) => {
      const requestId = `st-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const timeout = window.setTimeout(() => {
        window.removeEventListener("message", handleMessage);
        resolve(null);
      }, EXTENSION_BRIDGE_TIMEOUT_MS);

      function handleMessage(event) {
        if (event.source !== window || event.origin !== window.location.origin) return;
        const message = event.data || {};
        if (message.source !== "simple-track-extension" || message.requestId !== requestId) return;
        window.clearTimeout(timeout);
        window.removeEventListener("message", handleMessage);
        resolve(message.response || null);
      }

      window.addEventListener("message", handleMessage);
      window.postMessage({
        source: "simple-track-web-app",
        requestId,
        type,
        payload
      }, window.location.origin);
    });
  }

  function rememberExtensionSession(partialContext) {
    setExtensionSessionContext((current) => {
      const next = mergeExtensionContexts(current, partialContext);
      writeStoredExtensionContext(next);
      return next;
    });
  }

  function loginHarness(overrides = {}) {
    setError("");
    const baseUser = createHarnessUser();
    const overrideEmail = normalizeAccountEmail(overrides.email);
    const harnessUser = {
      ...baseUser,
      ...overrides,
      email: overrideEmail || overrides.email || baseUser.email
    };
    setUser(harnessUser);
    setBootstrap(mockBootstrap);
    setData(mockDashboard);
    setActiveMailAccount(routeParams.accountEmail || overrideEmail || mockDashboard.connectedAccounts?.[0]?.email || "all");
    if (routeParams.focusedMessageId) {
      setActivePage("email");
      setFocusedMessageId(routeParams.focusedMessageId);
    }
  }

  async function logout() {
    setProfileOpen(false);
    setUser(null);
    setBootstrap(null);
    setData(null);
    if (auth.currentUser) await signOut(auth);
  }

  async function disconnectSelectedMailAccount() {
    setProfileOpen(false);
    setError("");

    const selectedEmail = normalizeAccountEmail(activeMailAccount) || normalizeAccountEmail(selectedProfileAccount?.email) || normalizeAccountEmail(user?.email);
    if (!selectedEmail || selectedEmail === "all") {
      await logout();
      return;
    }

    const response = await requestExtensionDisconnectAccount(selectedEmail);
    const remainingAccounts = replaceDisconnectedAccountState(
      selectedEmail,
      response?.connectedAccounts || null,
      response?.activeAccountEmail || "",
      response?.knownAccounts || null
    );
    const nextEmail = normalizeAccountEmail(response?.activeAccountEmail) || remainingAccounts[0]?.email || "";

    if (nextEmail) {
      setActiveMailAccount(nextEmail);
      refreshDashboardForAccount(nextEmail);
      return;
    }

    await logout();
  }

  function replaceDisconnectedAccountState(disconnectedEmail, connectedAccounts = null, activeAccountEmail = "", knownAccounts = null) {
    const disconnected = normalizeAccountEmail(disconnectedEmail);
    const remainingConnectedAccounts = (Array.isArray(connectedAccounts)
      ? connectedAccounts
      : profileAccounts
    )
      .map(normalizeAccountRecord)
      .filter((account) => account && account.email !== disconnected);
    const disconnectedAccount = [
      ...(Array.isArray(knownAccounts) ? knownAccounts : []),
      ...profileAccounts
    ]
      .map(normalizeAccountRecord)
      .find((account) => account?.email === disconnected) || { email: disconnected };
    const remainingKnownAccounts = mergeAccountRecordLists(
      Array.isArray(knownAccounts) ? knownAccounts : profileAccounts,
      [{
        ...disconnectedAccount,
        email: disconnected,
        status: "login_required"
      }]
    ).filter((account) => account.email !== disconnected || account.status === "login_required");
    const nextActiveEmail = normalizeAccountEmail(activeAccountEmail) || remainingConnectedAccounts[0]?.email || "";

    setExtensionSessionContext((current) => {
      const handoffTokens = { ...(current?.handoffTokens || {}) };
      delete handoffTokens[disconnected];
      const next = {
        ...(current || {}),
        activeAccountEmail: nextActiveEmail,
        handoffAccountEmail: "",
        handoffToken: "",
        handoffTokens,
        connectedAccounts: remainingConnectedAccounts,
        knownAccounts: remainingKnownAccounts
      };
      writeStoredExtensionContext(next);
      return next;
    });

    setBootstrap((current) => current ? {
      ...current,
      connectedAccounts: mergeAccountRecordLists(
        (current.connectedAccounts || []).filter((account) => normalizeAccountEmail(account.email) !== disconnected),
        [{
          ...disconnectedAccount,
          email: disconnected,
          status: "login_required"
        }]
      )
    } : current);
    setData((current) => current ? {
      ...current,
      connectedAccounts: mergeAccountRecordLists(
        (current.connectedAccounts || []).filter((account) => normalizeAccountEmail(account.email) !== disconnected),
        [{
          ...disconnectedAccount,
          email: disconnected,
          status: "login_required"
        }]
      )
    } : current);

    return remainingConnectedAccounts;
  }

  function openSettingsPage() {
    setProfileOpen(false);
    setActivePage("settings");
  }

  async function switchMailAccount(accountEmail) {
    const normalizedEmail = normalizeAccountEmail(accountEmail);
    setActiveMailAccount(normalizedEmail || accountEmail);
    setProfileOpen(false);
    const account = enrichedProfileAccounts.find((entry) => entry.email === normalizedEmail);
    if (account?.status === "browser_connected") {
      await signInToMailAccount(normalizedEmail);
    }
    await refreshDashboardForAccount(normalizedEmail || accountEmail);
  }

  async function changeAppLogin(accountOrEmail = "") {
    setProfileOpen(false);
    setError("");
    const account = typeof accountOrEmail === "object" && accountOrEmail
      ? accountOrEmail
      : { email: accountOrEmail };
    const normalizedEmail = normalizeAccountEmail(account.email);

    if (normalizedEmail) {
      if (account.status === "login_required") {
        const response = await requestExtensionStartAccountConnection(normalizedEmail, account);
        if (!response?.ok) {
          await login(getAccountProviderType(account), normalizedEmail);
        }
        return;
      }

      setActiveMailAccount(normalizedEmail);
      signInToMailAccount(normalizedEmail);
      return;
    }
  }

  if (isConnectPage) {
    return (
      <ConnectExtensionPage
        user={user}
        authReady={authReady}
        allowHarness={allowHarness}
        error={error}
        setError={setError}
        login={login}
        loginHarness={loginHarness}
        getToken={getToken}
        logout={logout}
      />
    );
  }

  const page = NAV.find((item) => item.id === activePage) || NAV[0];
  const pageContent = data ? (
    <PageRouter
      activePage={activePage}
      query={query}
      activeMailAccount={activeMailAccount}
      data={data}
      setData={setData}
      getToken={getToken}
      bootstrap={bootstrap}
      focusedMessageId={focusedMessageId}
      setFocusedMessageId={setFocusedMessageId}
    />
  ) : null;

  return (
    <div className="app-shell">
      <Sidebar
        activePage={activePage}
        setActivePage={setActivePage}
        drawerOpen={drawerOpen}
        setDrawerOpen={setDrawerOpen}
      />

      <main className="main-shell">
        <header className="topbar">
          <button className="icon-button mobile-only" type="button" onClick={() => setDrawerOpen(true)} aria-label="Open navigation">
            <Menu size={20} />
          </button>
          <label className="search-box">
            <Search size={18} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search recipients, subjects, links"
            />
          </label>
          <div className="topbar-actions">
            <button className="upgrade-button" type="button">
              <Sparkles size={17} />
              Upgrade Plan
            </button>
            <button className="icon-button" type="button" aria-label="Notifications">
              <Bell size={19} />
            </button>
            <button className="icon-button" type="button" aria-label="Security controls">
              <ShieldCheck size={19} />
            </button>
            <div className="profile-wrap">
              <button className="profile-button" type="button" onClick={() => setProfileOpen(!profileOpen)}>
                {selectedProfileAccount?.photoURL ? <img src={selectedProfileAccount.photoURL} alt="" referrerPolicy="no-referrer" /> : <span>{getInitials(selectedProfileAccount || user)}</span>}
              </button>
              {profileOpen ? (
          <ProfileMenu
                  user={user}
                  accounts={enrichedProfileAccounts}
                  activeMailAccount={activeMailAccount}
                  onSwitchAccount={switchMailAccount}
                  onChangeLogin={changeAppLogin}
                  onOpenSettings={openSettingsPage}
                  onClose={() => setProfileOpen(false)}
                  onLogout={disconnectSelectedMailAccount}
                />
              ) : null}
            </div>
          </div>
        </header>

        <section className="page-header">
          <div>
            <p>{bootstrap?.org?.name || "Simple Track Workspace"}</p>
            <h1>{page.label}</h1>
          </div>
          <span className="compliance-chip">
            <ShieldCheck size={15} />
            SOC 2 ready foundations
          </span>
        </section>

        {error ? <div className="error-banner">{error}</div> : null}
        {loading ? <LoadingState /> : pageContent}
      </main>

      {!user && authReady ? (
        <LoginModal
          error={error}
          allowHarness={allowHarness}
          login={login}
          loginHarness={loginHarness}
        />
      ) : null}
    </div>
  );
}

function Sidebar({ activePage, setActivePage, drawerOpen, setDrawerOpen }) {
  const grouped = NAV.reduce((groups, item) => {
    groups[item.group] ||= [];
    groups[item.group].push(item);
    return groups;
  }, {});

  const content = (
    <>
      <div className="sidebar-brand">
        <div className="logo-mark">ST</div>
        <div>
          <strong>Simple Track</strong>
          <small>Email intelligence</small>
        </div>
      </div>
      <nav>
        {Object.entries(grouped).map(([group, items]) => (
          <div className="nav-group" key={group}>
            <p>{group}</p>
            {items.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  className={activePage === item.id ? "active" : ""}
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActivePage(item.id);
                    setDrawerOpen(false);
                  }}
                >
                  <Icon size={18} />
                  {item.label}
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    </>
  );

  return (
    <>
      <aside className="sidebar desktop-sidebar">{content}</aside>
      {drawerOpen ? (
        <div className="drawer-backdrop">
          <aside className="sidebar drawer">
            <button className="icon-button drawer-close" type="button" onClick={() => setDrawerOpen(false)} aria-label="Close navigation">
              <X size={20} />
            </button>
            {content}
          </aside>
        </div>
      ) : null}
    </>
  );
}

function LoginModal({ error, allowHarness, login, loginHarness }) {
  return (
    <div className="auth-overlay">
      <div className="auth-modal">
        <div className="logo-mark large">ST</div>
        <h2>Sign in to Simple Track</h2>
        <p>Use Google or Outlook SSO to access your tracked email activity, reports, PDFs, contacts, and account settings.</p>
        <div className="auth-actions">
          <button className="sso-button" type="button" onClick={() => login("google")}>
            <GoogleLogo />
            Continue with Google
          </button>
          <button className="sso-button" type="button" onClick={() => login("microsoft")}>
            <OutlookLogo />
            Continue with Outlook
          </button>
          {allowHarness ? (
            <button className="ghost-button" type="button" onClick={loginHarness}>
              <Gauge size={18} />
              Use harness account
            </button>
          ) : null}
        </div>
        {error ? <div className="error-banner compact">{error}</div> : null}
      </div>
    </div>
  );
}

function ProfileAccountSwitcher({ accounts = [], activeMailAccount, setActiveMailAccount }) {
  const normalizedAccounts = useMemo(() => {
    const byEmail = new Map();
    for (const account of accounts) {
      const email = String(account?.email || "").toLowerCase();
      if (!email) continue;
      byEmail.set(email, {
        email,
        displayName: account.displayName || account.name || email,
        client: account.client || "Gmail",
        status: account.status || "connected"
      });
    }
    return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
  }, [accounts]);

  if (normalizedAccounts.length === 0) {
    return (
      <div className="account-switcher empty">
        <Mail size={15} />
        <span>No connected mail accounts yet</span>
      </div>
    );
  }

  return (
    <label className="account-switcher">
      <span>Tracking account</span>
      <select value={activeMailAccount || "all"} onChange={(event) => setActiveMailAccount(event.target.value)}>
        <option value="all">All connected accounts</option>
        {normalizedAccounts.map((account) => (
          <option key={account.email} value={account.email}>
            {account.email}
          </option>
        ))}
      </select>
    </label>
  );
}

function GoogleLogo() {
  return (
    <svg className="brand-login-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09Z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" />
      <path fill="#FBBC05" d="M5.84 14.1c-.22-.66-.35-1.36-.35-2.1s.13-1.44.35-2.1V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.84Z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06L5.84 9.9C6.71 7.3 9.14 5.38 12 5.38Z" />
    </svg>
  );
}

function GmailLogo() {
  return <img className="brand-login-logo" src="/assets/provider/gmail.svg" alt="" />;
}

function OutlookLogo() {
  return <img className="brand-login-logo" src="/assets/provider/outlook.svg" alt="" />;
}

function ProfileMenu({
  user,
  accounts = [],
  activeMailAccount,
  onSwitchAccount,
  onChangeLogin,
  onOpenSettings,
  onClose,
  onLogout
}) {
  const mailAccounts = useMemo(
    () => buildProfileMailAccounts(accounts),
    [accounts]
  );
  const selectedAccount = useMemo(
    () => getSelectedProfileAccount(mailAccounts, activeMailAccount, user),
    [mailAccounts, activeMailAccount, user]
  );
  const firstName = (selectedAccount?.displayName || user?.displayName || user?.email || "there").split(/\s+|@/).filter(Boolean)[0];

  return (
    <div className="profile-menu account-popout">
      <div className="account-popout-top">
        <span>{selectedAccount?.email || user?.email}</span>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close account menu">
          <X size={18} />
        </button>
      </div>
      <div className="account-popout-hero">
        <AccountAvatar account={selectedAccount} className="large" />
        <h2>Hi, {firstName}!</h2>
        <button className="outline-button" type="button" onClick={onOpenSettings}>Manage Simple Track account</button>
      </div>
      <div className="account-popout-list">
        {mailAccounts.map((account) => (
          <MailAccountRow
            key={account.email}
            account={account}
            active={normalizeAccountEmail(activeMailAccount) === account.email}
            onSwitchAccount={onSwitchAccount}
            onChangeLogin={onChangeLogin}
          />
        ))}
        <button className="mail-account-row action-row" type="button" onClick={onLogout}>
          <span className="mail-account-avatar neutral"><LogOut size={18} /></span>
          <span className="mail-account-copy">
            <strong>Sign out</strong>
            <small>Disconnect this mail account</small>
          </span>
        </button>
      </div>
    </div>
  );
}

function MailAccountRow({ account, active, onSwitchAccount, onChangeLogin }) {
  const connected = account.status === "connected";
  const browserConnected = account.status === "browser_connected";
  const needsLoginSwitch = account.status === "login_required";
  const label = connected
    ? active ? "Active" : "Switch"
    : needsLoginSwitch ? "Log back in" : browserConnected ? "Switch" : "Connect";
  const secondaryText = browserConnected
    ? `${account.email} - tracking connected`
    : needsLoginSwitch ? `${account.email} - logged out` : account.email;

  return (
    <button
      className={[
        "mail-account-row",
        active ? "is-active" : "",
        connected ? "is-connected" : "",
        browserConnected ? "is-browser-connected" : "",
        needsLoginSwitch ? "is-browser-connected" : "",
        !connected && !browserConnected && !needsLoginSwitch ? "is-pending" : ""
      ].filter(Boolean).join(" ")}
      type="button"
      onClick={() => {
        if (connected || browserConnected) {
          onSwitchAccount(account.email);
          return;
        }
        onChangeLogin(account);
      }}
      aria-label={needsLoginSwitch ? `Log back in to ${account.email}` : connected || browserConnected ? `Switch to ${account.email}` : `Connect ${account.email}`}
    >
      <AccountAvatar account={account} />
      <span className="mail-account-copy">
        <strong>{account.displayName || account.email}</strong>
        <small>{secondaryText}</small>
      </span>
      <span className="account-state">{label}</span>
    </button>
  );
}

function AccountAvatar({ account, className = "" }) {
  const photoURL = account?.photoURL || account?.photoUrl || "";
  const providerType = getAccountProviderType(account);

  return (
    <span className={["mail-account-avatar", "google-style", className].filter(Boolean).join(" ")}>
      {photoURL ? (
        <img src={photoURL} alt="" referrerPolicy="no-referrer" />
      ) : (
        <span className="mail-account-initials">{getInitials(account)}</span>
      )}
      {providerType === "google" ? (
        <span className="provider-badge" aria-hidden="true">
          <GmailLogo />
        </span>
      ) : null}
      {providerType === "microsoft" ? (
        <span className="provider-badge microsoft" aria-hidden="true">
          <OutlookLogo />
        </span>
      ) : null}
    </span>
  );
}

function getAccountProviderType(account) {
  const provider = String(account?.provider || "").toLowerCase();
  const client = String(account?.client || "").toLowerCase();
  const email = String(account?.email || "").toLowerCase();
  if (provider.includes("microsoft") || provider.includes("outlook")) return "microsoft";
  if (client.includes("outlook") || email.includes("@outlook.") || email.includes("@hotmail.") || email.includes("@live.")) return "microsoft";
  return "google";
}

function buildProfileMailAccounts(accounts) {
  return mergeAccountRecordLists(accounts).sort((a, b) => {
    if (a.status === b.status) return a.email.localeCompare(b.email);
    return accountStatusRank(a.status) - accountStatusRank(b.status);
  });
}

function mergeAccountRecordLists(...accountLists) {
  const byEmail = new Map();
  for (const account of accountLists.flat()) {
    const normalized = normalizeAccountRecord(account);
    if (!normalized) continue;
    const existing = byEmail.get(normalized.email);
    byEmail.set(normalized.email, {
      ...existing,
      ...normalized,
      displayName: normalized.displayName || existing?.displayName,
      photoURL: normalized.photoURL || existing?.photoURL || "",
      provider: normalized.provider || existing?.provider,
      client: normalized.client || existing?.client
    });
  }
  return [...byEmail.values()];
}

function mergeProfileAccounts(workspaceAccounts = [], extensionAccounts = []) {
  const byEmail = new Map();

  for (const account of workspaceAccounts) {
    const normalized = normalizeAccountRecord({
      ...account,
      status: account?.status === "login_required" ? "login_required" : "connected"
    });
    if (!normalized) continue;
    byEmail.set(normalized.email, normalized);
  }

  for (const account of extensionAccounts) {
    const normalized = normalizeAccountRecord({
      ...account,
      status: account?.status === "login_required" ? "login_required" : "browser_connected"
    });
    if (!normalized) continue;
    const existing = byEmail.get(normalized.email);
    if (existing) {
      byEmail.set(normalized.email, {
        ...existing,
        displayName: existing.displayName || normalized.displayName,
        photoURL: existing.photoURL || normalized.photoURL,
        provider: existing.provider || normalized.provider,
        client: existing.client || normalized.client,
        status: getPreferredAccountStatus(existing.status, normalized.status)
      });
      continue;
    }
    byEmail.set(normalized.email, normalized);
  }

  return [...byEmail.values()];
}

function enrichProfileAccounts(accounts = [], user = null) {
  const userEmail = normalizeAccountEmail(user?.email);
  return accounts.map((account) => {
    if (account.photoURL || account.email !== userEmail) return account;
    return {
      ...account,
      displayName: account.displayName || user?.displayName || account.email,
      photoURL: user?.photoURL || getCachedProfilePhoto(account.email)
    };
  });
}

function getSelectedProfileAccount(accounts = [], activeMailAccount = "", user = null) {
  const activeEmail = normalizeAccountEmail(activeMailAccount);
  const userEmail = normalizeAccountEmail(user?.email);
  const selected = activeEmail && activeEmail !== "all"
    ? accounts.find((account) => account.email === activeEmail)
    : accounts.find((account) => account.email === userEmail) || accounts[0];

  if (selected) {
    return {
      ...selected,
      photoURL: selected.photoURL || (selected.email === userEmail ? user?.photoURL : "") || getCachedProfilePhoto(selected.email)
    };
  }

  return {
    email: userEmail || user?.email || "",
    displayName: user?.displayName || user?.email || "Simple Track User",
    photoURL: user?.photoURL || getCachedProfilePhoto(userEmail),
    provider: "google",
    client: "Gmail",
    status: "connected"
  };
}

function accountStatusRank(status) {
  if (status === "connected") return 0;
  if (status === "browser_connected") return 1;
  if (status === "login_required") return 1;
  return 2;
}

function getPreferredAccountStatus(currentStatus, nextStatus) {
  if (currentStatus === "connected" || nextStatus === "connected") return "connected";
  if (currentStatus === "browser_connected" || nextStatus === "browser_connected") return "browser_connected";
  if (currentStatus === "login_required" || nextStatus === "login_required") return "login_required";
  return nextStatus || currentStatus || "connected";
}

function getMailClientLabel(account) {
  return getAccountProviderType(account) === "microsoft" ? "Outlook" : "Gmail";
}

function getMailClientHomeUrl(account) {
  return getAccountProviderType(account) === "microsoft"
    ? "https://outlook.live.com/mail/"
    : "https://mail.google.com/";
}

function getSafeMailReturnUrl(value, account) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase();
    const isGmail = hostname === "mail.google.com";
    const isOutlook = hostname === "outlook.live.com" ||
      hostname === "outlook.office.com" ||
      hostname === "outlook.office365.com";
    if (!isGmail && !isOutlook) return "";
    if (getAccountProviderType(account) === "microsoft" && !isOutlook) return "";
    if (getAccountProviderType(account) !== "microsoft" && !isGmail) return "";
    return url.toString();
  } catch {
    return "";
  }
}

function ConnectExtensionPage({ user, authReady, allowHarness, error, setError, login, loginHarness, getToken, logout }) {
  const [params, setParams] = useState(() => readConnectionParams());
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [connectedAccount, setConnectedAccount] = useState(null);
  const requestedEmail = params.accountEmail || "";
  const mailProvider = getAccountProviderType({
    email: requestedEmail,
    client: params.client,
    provider: params.provider
  });
  const mailClientLabel = getMailClientLabel({
    email: requestedEmail,
    client: params.client,
    provider: params.provider
  });
  const MailProviderLogo = mailProvider === "microsoft" ? OutlookLogo : GmailLogo;
  const returnAccount = { email: requestedEmail, client: params.client, provider: params.provider };
  const returnUrl = getSafeMailReturnUrl(params.returnUrl, returnAccount) || getMailClientHomeUrl(returnAccount);
  const isReconnect = params.mode === "reconnect";
  const signedInEmail = normalizeAccountEmail(user?.email);
  const accountMatchesWebLogin = Boolean(user && requestedEmail && signedInEmail === requestedEmail);

  useEffect(() => {
    function refreshConnectionParams() {
      setParams(readConnectionParams());
      setStatus("idle");
      setMessage("");
      setConnectedAccount(null);
      setError("");
    }

    window.addEventListener("hashchange", refreshConnectionParams);
    window.addEventListener("popstate", refreshConnectionParams);
    return () => {
      window.removeEventListener("hashchange", refreshConnectionParams);
      window.removeEventListener("popstate", refreshConnectionParams);
    };
  }, [setError]);

  async function continueConnection() {
    setStatus("signing-in");
    setError("");
    setMessage("");
    try {
      if (isReconnect) {
        if (user) await logout();
        await login(mailProvider, requestedEmail, { rethrow: true });
        return;
      }

      if (!user) {
        await login(mailProvider, requestedEmail, { rethrow: true });
        return;
      }

      await connectSignedInUser();
    } catch (connectError) {
      setStatus("failed");
      setMessage(connectError.message);
    }
  }

  useEffect(() => {
    if (!user || status !== "signing-in") return;
    connectSignedInUser();
  }, [user, status]);

  async function connectSignedInUser() {
    if (!params.installId || !params.installSecret || !requestedEmail) {
      setStatus("failed");
      setMessage(`The extension connection link is missing required details. Return to ${mailClientLabel} and click Enable again.`);
      return;
    }

    if (isReconnect && requestedEmail && !accountMatchesWebLogin) {
      setStatus("failed");
      setMessage(`Sign in with ${requestedEmail} to re-enable tracking for this ${mailClientLabel} account.`);
      return;
    }

    setStatus("connecting");
    try {
      const response = await connectExtension(getToken, {
        installId: params.installId,
        installSecret: params.installSecret,
        accountEmail: requestedEmail,
        client: params.client || mailClientLabel,
        provider: mailProvider,
        accountDisplayName: accountMatchesWebLogin ? (user?.displayName || requestedEmail) : requestedEmail,
        accountPhotoURL: accountMatchesWebLogin ? (user?.photoURL || "") : ""
      });
      setConnectedAccount(response.account);
      setStatus("connected");
      setMessage(`${requestedEmail} is connected. You can return to ${mailClientLabel}.`);
    } catch (connectError) {
      setStatus("failed");
      setMessage(connectError.message);
    }
  }

  async function chooseAnotherAccount() {
    if (user) await logout();
    setMessage("");
    setError("");
    setStatus("signing-in");
    await login(mailProvider, requestedEmail);
  }

  function useHarnessAccount() {
    const normalizedEmail = normalizeAccountEmail(requestedEmail);
    loginHarness({
      email: normalizedEmail || undefined,
      displayName: normalizedEmail ? normalizedEmail.split("@")[0] : undefined
    });
    setStatus("signing-in");
  }

  const isBusy = status === "signing-in" || status === "connecting";
  const isConnected = status === "connected";
  const isFailed = status === "failed";
  const visibleMessage = message || error;
  const primaryActionText = isReconnect
    ? `Log back in with ${mailClientLabel}`
    : user ? `Connect this ${mailClientLabel}` : `Continue with ${mailClientLabel}`;

  useEffect(() => {
    if (!isConnected || allowHarness || params.source !== "chrome-extension") return undefined;
    const timeout = window.setTimeout(() => {
      window.location.assign(returnUrl);
    }, 900);
    return () => window.clearTimeout(timeout);
  }, [allowHarness, isConnected, params.source, returnUrl]);

  return (
    <main className="connect-page">
      <section className="connect-panel">
        <div className="connect-brand-row">
          <div className="logo-mark">ST</div>
          <span />
          <MailProviderLogo />
        </div>
        <h1>{isConnected ? `${mailClientLabel} connected` : isFailed ? "Connection needs attention" : isReconnect ? `Reconnect ${mailClientLabel}` : `Connect ${mailClientLabel}`}</h1>
        <p className="connect-lede">
          {isConnected
            ? `${connectedAccount?.email || requestedEmail} can now use Simple Track from ${mailClientLabel} without access keys.`
            : isReconnect
              ? `Log back in to restore tracking for ${requestedEmail || `this ${mailClientLabel} account`} on this browser.`
              : `Connect ${requestedEmail || `this ${mailClientLabel} account`} to Simple Track so this extension install tracks the right mailbox.`}
        </p>

        <div className="permissions-card">
          <PermissionItem icon={ShieldCheck} title="Permissions we need" text="Simple Track links this browser install to the mail account you are connecting." />
          <PermissionItem icon={Eye} title="No mailbox harvesting" text="The web app receives tracking metadata, not your full inbox or password." />
          <PermissionItem icon={Check} title="You are in control" text="Disconnect or change accounts from the app profile menu or extension settings." />
        </div>

        {visibleMessage ? (
          <div className={isConnected ? "success-banner" : "error-banner compact"}>
            {visibleMessage}
          </div>
        ) : null}

        <div className="connect-actions">
          {!isConnected ? (
            <button type="button" onClick={continueConnection} disabled={!authReady || isBusy}>
              {isBusy ? <Loader2 className="spin" size={18} /> : <MailProviderLogo />}
              {primaryActionText}
            </button>
          ) : (
            <a className="connect-done-button" href={returnUrl}>Return to {mailClientLabel}</a>
          )}
          {user && !isConnected ? (
            <button className="ghost-button" type="button" onClick={chooseAnotherAccount}>
              Use a different Simple Track login
            </button>
          ) : null}
          {allowHarness && !user && !isConnected ? (
            <button className="ghost-button" type="button" onClick={useHarnessAccount}>
              <Gauge size={17} />
              Use harness account
            </button>
          ) : null}
        </div>

        <p className="connect-footnote">
          By connecting, you agree to use Simple Track only for accounts you own or are authorized to track.
        </p>
      </section>
    </main>
  );
}

function PermissionItem({ icon: Icon, title, text }) {
  return (
    <article className="permission-item">
      <Icon size={20} />
      <div>
        <strong>{title}</strong>
        <p>{text}</p>
      </div>
    </article>
  );
}

function readConnectionParams() {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const search = new URLSearchParams(window.location.search);
  const get = (key) => hash.get(key) || search.get(key) || "";
  return {
    installId: get("installId"),
    installSecret: get("installSecret"),
    accountEmail: get("accountEmail").toLowerCase(),
    client: get("client") || "Gmail",
    provider: get("provider"),
    mode: get("mode"),
    returnUrl: get("returnUrl"),
    source: get("source")
  };
}

function PageRouter({ activePage, query, activeMailAccount, data, setData, getToken, bootstrap, focusedMessageId, setFocusedMessageId }) {
  const scopedMessages = useMemo(() => filterByAccount(data.messages || [], activeMailAccount), [data.messages, activeMailAccount]);
  const scopedMessageIds = useMemo(() => new Set(scopedMessages.map((message) => message.id)), [scopedMessages]);
  const scopedActivity = useMemo(() => filterEventsByAccount(data.activity || [], activeMailAccount, scopedMessageIds), [data.activity, activeMailAccount, scopedMessageIds]);
  const scopedLinks = useMemo(() => filterEventsByAccount(data.links || [], activeMailAccount, scopedMessageIds), [data.links, activeMailAccount, scopedMessageIds]);
  const scopedContacts = useMemo(() => filterContactsByMessages(data.contacts || [], scopedMessages, activeMailAccount), [data.contacts, scopedMessages, activeMailAccount]);
  const scopedPerformance = useMemo(() => buildClientPerformance(scopedMessages, data.files || []), [scopedMessages, data.files]);

  const filtered = useMemo(() => ({
    messages: filterRows(scopedMessages, query, ["subject", "recipients", "accountEmail"]),
    activity: filterRows(scopedActivity, query, ["subject", "recipient", "label", "accountEmail"]),
    links: filterRows(scopedLinks, query, ["subject", "recipient", "label", "url", "accountEmail"]),
    contacts: filterRows(scopedContacts, query, ["name", "email", "domain"]),
    files: filterRows(data.files || [], query, ["name", "trackingUrl"])
  }), [data.files, query, scopedActivity, scopedContacts, scopedLinks, scopedMessages]);

  if (activePage === "activity") return <LatestActivity activity={filtered.activity} />;
  if (activePage === "email") {
    return (
      <EmailTracking
        messages={filtered.messages}
        focusedMessageId={focusedMessageId}
        setFocusedMessageId={setFocusedMessageId}
      />
    );
  }
  if (activePage === "links") return <LinkClicks links={filtered.links} />;
  if (activePage === "pdf") return <PdfAnalytics files={filtered.files} data={data} setData={setData} getToken={getToken} />;
  if (activePage === "performance") return <Performance performance={activeMailAccount === "all" ? data.performance : scopedPerformance} />;
  if (activePage === "crm") return <CRM contacts={filtered.contacts} data={data} setData={setData} getToken={getToken} />;
  return <SettingsPage data={data} setData={setData} getToken={getToken} bootstrap={bootstrap} />;
}

function LatestActivity({ activity }) {
  const [tab, setTab] = useState("all");
  const rows = activity.filter((item) => {
    if (tab === "opens") return item.type === "open";
    if (tab === "insights") return item.type !== "open";
    return true;
  });

  return (
    <section className="content-card">
      <Tabs value={tab} onChange={setTab} items={[
        { id: "all", label: "All" },
        { id: "opens", label: "Opens" },
        { id: "insights", label: "Insights" }
      ]} />
      <div className="activity-list">
        {rows.map((item) => (
          <article className="activity-row" key={item.id}>
            <EventIcon type={item.type} />
            <div>
              <p>
                <strong>{item.recipient || "Recipient"}</strong>
                {" "}
                {eventVerb(item.type)}
              </p>
              <span>{item.subject}</span>
            </div>
            <time>{relativeTime(item.createdAt)}</time>
          </article>
        ))}
      </div>
    </section>
  );
}

function EmailTracking({ messages, focusedMessageId, setFocusedMessageId }) {
  const [sort, setSort] = useState("lastActivity");
  const rows = [...messages].sort((a, b) => {
    if (sort === "opens") return Number(b.opens || 0) - Number(a.opens || 0);
    if (sort === "sent") return new Date(b.sentAt || 0) - new Date(a.sentAt || 0);
    return new Date(b.lastActivityAt || b.sentAt || 0) - new Date(a.lastActivityAt || a.sentAt || 0);
  });
  const focusedMessage = focusedMessageId ? rows.find((message) => message.id === focusedMessageId) : null;

  return (
    <section className="content-card">
      <div className="toolbar">
        <Select value={sort} onChange={setSort} options={[
          ["lastActivity", "Last opened emails"],
          ["opens", "Most opened"],
          ["sent", "Newest sent"]
        ]} />
        <button className="text-button" type="button" onClick={() => downloadCsv("email-tracking", rows)}>
          <Download size={17} />
          Download CSV
        </button>
      </div>
      <ResponsiveTable
        columns={["Recipients", "Email", "Activity", "Actions"]}
        rows={rows.map((message) => [
          <RecipientPills recipients={message.recipients} />,
          <div>
            <strong>{message.subject}</strong>
            <span>Sent on {formatDate(message.sentAt)}</span>
          </div>,
          <ActivitySummary message={message} />,
          <button
            className="icon-button table-action"
            type="button"
            aria-label={`Open report for ${message.subject}`}
            onClick={() => setFocusedMessageId(message.id)}
          >
            <MoreHorizontal size={18} />
          </button>
        ])}
      />
      {focusedMessage ? (
        <MessageDetailDialog message={focusedMessage} onClose={() => setFocusedMessageId("")} />
      ) : null}
    </section>
  );
}

function MessageDetailDialog({ message, onClose }) {
  const events = getSortedMessageEvents(message);
  return (
    <div className="modal-backdrop">
      <section className="dialog report-dialog" role="dialog" aria-modal="true" aria-labelledby="message-report-title">
        <button className="icon-button dialog-close" type="button" onClick={onClose} aria-label="Close">
          <X size={18} />
        </button>
        <span className="detail-kicker">{message.accountEmail || "Tracked email"}</span>
        <h2 id="message-report-title">Message report</h2>
        <p className="detail-subject">{message.subject}</p>
        <div className="report-stat-grid">
          <Metric label="Opens" value={Number(message.opens || 0)} trend="email" />
          <Metric label="Clicks" value={Number(message.clicks || 0)} trend="links" />
          <Metric label="Files" value={Number(message.attachmentOpens || 0)} trend="attachments" />
        </div>
        <dl className="detail-grid">
          <div>
            <dt>Recipients</dt>
            <dd>{(message.recipients || []).join(", ") || "No recipients"}</dd>
          </div>
          <div>
            <dt>Sent</dt>
            <dd>{formatDate(message.sentAt)}</dd>
          </div>
          <div>
            <dt>Last activity</dt>
            <dd>{message.lastActivityAt ? formatDate(message.lastActivityAt) : "No activity yet"}</dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{summaryText(Number(message.opens || 0), Number(message.clicks || 0), Number(message.attachmentOpens || 0))}</dd>
          </div>
        </dl>
        <div className="detail-events">
          <div className="section-heading compact">
            <h3>Event timeline</h3>
            <span>{events.length} recent</span>
          </div>
          {events.length ? events.map((event, index) => (
            <article className="detail-event-row" key={`${event.type}-${event.createdAt}-${index}`}>
              <EventIcon type={event.type} />
              <div>
                <strong>{messageEventTitle(event)}</strong>
                <span>{formatDate(event.createdAt)}</span>
              </div>
            </article>
          )) : (
            <p className="detail-empty">No opens, clicks, or file events recorded yet.</p>
          )}
        </div>
      </section>
    </div>
  );
}

function LinkClicks({ links }) {
  return (
    <section className="content-stack">
      <div className="info-banner">
        <LinkIcon size={20} />
        <div>
          <strong>Use your own domain for link tracking</strong>
          <p>Custom tracking domains build trust and improve deliverability for branded links.</p>
        </div>
        <button type="button">Set up domain</button>
      </div>
      <section className="content-card">
        <div className="toolbar">
          <h2>Click report</h2>
          <button className="text-button" type="button" onClick={() => downloadCsv("link-clicks", links)}>
            <Download size={17} />
            Download CSV
          </button>
        </div>
        <ResponsiveTable
          columns={["Recipient", "Destination", "Email", "Clicked"]}
          rows={links.map((link) => [
            link.recipient,
            <div>
              <strong>{link.label}</strong>
              <span className="url-text">{link.url}</span>
            </div>,
            link.subject,
            <div>
              <strong>{formatDate(link.clickedAt)}</strong>
            </div>
          ])}
        />
      </section>
    </section>
  );
}

function PdfAnalytics({ files, data, setData, getToken }) {
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const used = data.files?.length || 0;
  const limit = data.plan?.limits?.pdfs || 5;

  async function uploadPdf() {
    if (!file) return;
    setBusy(true);
    try {
      const response = await createPdfFile(getToken, {
        name: file.name,
        contentType: file.type || "application/pdf",
        size: file.size
      });
      if (response.uploadUrl) {
        await fetch(response.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": file.type || "application/pdf" },
          body: file
        });
      }
      setData((current) => ({ ...current, files: [response.file, ...(current.files || [])] }));
      setFile(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="content-stack">
      <div className="toolbar page-toolbar">
        <span>{used}/{limit} PDFs used.</span>
        <label className="file-upload">
          <Upload size={17} />
          <input type="file" accept="application/pdf" onChange={(event) => setFile(event.target.files?.[0] || null)} />
          Upload PDF
        </label>
        <button type="button" onClick={uploadPdf} disabled={!file || busy}>
          {busy ? <Loader2 className="spin" size={17} /> : <FileText size={17} />}
          Create tracked PDF
        </button>
      </div>
      {files.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="You have not sent any PDF yet"
          text="Upload a PDF to create a tracked link with views, downloads, page progress, and time spent metadata."
        />
      ) : (
        <section className="content-card">
          <ResponsiveTable
            columns={["PDF", "Views", "Downloads", "Tracking link"]}
            rows={files.map((pdf) => [
              <strong>{pdf.name}</strong>,
              `${Number(pdf.views || 0)} views`,
              `${Number(pdf.downloads || 0)} downloads`,
              <span className="url-text">{pdf.trackingUrl || "Tracking link pending"}</span>
            ])}
          />
        </section>
      )}
    </section>
  );
}

function Performance({ performance }) {
  const totals = performance?.totals || {};
  return (
    <section className="content-stack">
      <div className="metric-grid">
        <Metric label="Sent emails" value={totals.sent || 0} trend="+12%" />
        <Metric label="Opened" value={totals.opened || 0} trend={`${totals.openRate || 0}%`} />
        <Metric label="Clicked" value={totals.clicked || 0} trend={`${totals.clickRate || 0}%`} />
        <Metric label="PDF viewed" value={totals.pdfViewed || 0} trend={`${totals.pdfRate || 0}%`} />
      </div>
      <section className="content-card">
        <div className="section-heading">
          <h2>When you send your emails</h2>
          <span>Last 30 days</span>
        </div>
        <Heatmap cells={performance?.heatmap || []} />
      </section>
      <div className="chart-grid">
        <LineChart title="Emails sent by day" rows={performance?.sentByDay || []} />
        <LineChart title="Emails opened by day" rows={performance?.openedByDay || []} />
        <Donut title="Opening rate" value={totals.openRate || 0} subtitle={`${totals.opened || 0}/${totals.sent || 0}`} />
      </div>
    </section>
  );
}

function CRM({ contacts, data, setData, getToken }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", phone: "" });

  async function saveContact(event) {
    event.preventDefault();
    const response = await createContact(getToken, form);
    setData((current) => ({ ...current, contacts: [response.contact, ...(current.contacts || [])] }));
    setForm({ name: "", email: "", phone: "" });
    setModalOpen(false);
  }

  return (
    <section className="content-card">
      <div className="toolbar">
        <div className="segmented-control">
          <button className="active" type="button">All contacts</button>
          <button type="button">Lists</button>
          <button type="button">Bounced</button>
        </div>
        <button type="button" onClick={() => setModalOpen(true)}>
          <Users size={17} />
          Add contact
        </button>
      </div>
      <ResponsiveTable
        columns={["Name", "Email", "Domain", "Last contacted", "Last heard from", "Unsubscribed", "Hard bounced"]}
        rows={contacts.map((contact) => [
          <ContactName contact={contact} />,
          contact.email,
          contact.domain || "",
          relativeTime(contact.lastContactedAt),
          relativeTime(contact.lastHeardFromAt),
          String(Boolean(contact.unsubscribed)),
          String(Boolean(contact.hardBounced))
        ])}
      />
      {modalOpen ? (
        <div className="modal-backdrop">
          <form className="dialog" onSubmit={saveContact}>
            <button className="icon-button dialog-close" type="button" onClick={() => setModalOpen(false)} aria-label="Close">
              <X size={18} />
            </button>
            <h2>Add contact</h2>
            <label>Name<input value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
            <label>Email<input required type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} /></label>
            <label>Phone<input value={form.phone} onChange={(event) => setForm({ ...form, phone: event.target.value })} /></label>
            <button type="submit">Save contact</button>
          </form>
        </div>
      ) : null}
    </section>
  );
}

function SettingsPage({ data, setData, getToken, bootstrap }) {
  const [tab, setTab] = useState("settings");
  const [settings, setSettings] = useState(data.settings || {});
  const [status, setStatus] = useState("");
  const connectedAccounts = data.connectedAccounts || bootstrap?.connectedAccounts || [];

  async function saveSettings(next) {
    setSettings(next);
    setData((current) => ({ ...current, settings: next }));
    setStatus("Saving...");
    try {
      await updateSettings(getToken, next);
      setStatus("Saved");
    } catch (error) {
      setStatus(error.message);
    }
  }

  return (
    <section className="settings-layout">
      <aside className="settings-tabs">
        {["settings", "notifications", "subscription", "account", "privacy", "integrations", "mobile"].map((item) => (
          <button className={tab === item ? "active" : ""} key={item} type="button" onClick={() => setTab(item)}>
            {titleCase(item)}
          </button>
        ))}
      </aside>
      <section className="content-card settings-panel">
        {tab === "settings" ? (
          <div className="settings-section">
            <h2>Tracking settings</h2>
            <Toggle
              label="Track emails by default"
              text="New extension-tracked sends start with open tracking enabled."
              checked={settings.trackEmailsByDefault}
              onChange={(value) => saveSettings({ ...settings, trackEmailsByDefault: value })}
            />
            <Toggle
              label="Track clicks by default"
              text="Wrapped links create click events and preserve the destination URL."
              checked={settings.trackClicksByDefault}
              onChange={(value) => saveSettings({ ...settings, trackClicksByDefault: value })}
            />
            <div className="pairing-panel">
              <div>
                <h3>Chrome extension connection</h3>
                <p>Open Gmail or Outlook, click Enable in the Simple Track prompt, then sign in here. No install keys or pasted codes are required.</p>
                <div className="connected-account-list">
                  {connectedAccounts.length ? connectedAccounts.map((account) => (
                    <span key={account.email}>
                      <Check size={14} />
                      {account.email}
                    </span>
                  )) : <em>No mail accounts connected yet</em>}
                </div>
              </div>
              <div className="settings-link-group">
                <a className="settings-link-button" href="https://mail.google.com/" target="_blank" rel="noreferrer">Open Gmail</a>
                <a className="settings-link-button" href="https://outlook.live.com/mail/" target="_blank" rel="noreferrer">Open Outlook</a>
              </div>
            </div>
          </div>
        ) : null}
        {tab === "notifications" ? (
          <div className="settings-section">
            <h2>Notifications</h2>
            {["emailOpened", "linkClicked", "pdfViewed"].map((key) => (
              <Toggle
                key={key}
                label={titleCase(key)}
                text="Desktop and email notification preference."
                checked={Boolean(settings.notifications?.[key])}
                onChange={(value) => saveSettings({
                  ...settings,
                  notifications: { ...(settings.notifications || {}), [key]: value }
                })}
              />
            ))}
          </div>
        ) : null}
        {tab === "subscription" ? (
          <div className="settings-section">
            <h2>Subscription</h2>
            <div className="plan-row">
              <div>
                <strong>Simple Track {data.plan?.tier || "free"}</strong>
                <span>Internal plan state, Stripe later.</span>
              </div>
              <button type="button">Upgrade Simple Track</button>
            </div>
          </div>
        ) : null}
        {tab === "account" ? (
          <div className="settings-section">
            <h2>Account</h2>
            <p><strong>Workspace:</strong> {bootstrap?.org?.name || "Simple Track Workspace"}</p>
            <p><strong>Role:</strong> {bootstrap?.membership?.role || "owner"}</p>
            <p><strong>Extension installs:</strong> {bootstrap?.installCount || 0}</p>
          </div>
        ) : null}
        {tab === "privacy" ? (
          <div className="settings-section">
            <h2>Privacy</h2>
            <label className="field-row">
              Retention days
              <input
                type="number"
                min="1"
                max="365"
                value={settings.retentionDays || 90}
                onChange={(event) => saveSettings({ ...settings, retentionDays: Number(event.target.value) })}
              />
            </label>
          </div>
        ) : null}
        {tab === "integrations" ? <Placeholder title="Integrations" text="CRM and Zapier-style integration requests will sit here after core reports are stable." /> : null}
        {tab === "mobile" ? <Placeholder title="Mobile" text="Mobile indicators and push controls will be wired after the web app core ships." /> : null}
        {status ? <p className="save-status">{status}</p> : null}
      </section>
    </section>
  );
}

function Tabs({ value, onChange, items }) {
  return (
    <div className="tabs">
      {items.map((item) => (
        <button className={value === item.id ? "active" : ""} type="button" key={item.id} onClick={() => onChange(item.id)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

function Select({ value, onChange, options }) {
  return (
    <label className="select-wrap">
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
      <ChevronDown size={17} />
    </label>
  );
}

function ResponsiveTable({ columns, rows }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => <td data-label={columns[index]} key={index}>{cell}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RecipientPills({ recipients = [] }) {
  const shown = recipients.slice(0, 2);
  return (
    <div className="pill-list">
      {shown.map((recipient) => <span key={recipient}>{recipient}</span>)}
      {recipients.length > shown.length ? <span>+{recipients.length - shown.length}</span> : null}
    </div>
  );
}

function ActivitySummary({ message }) {
  const opened = Number(message.opens || 0);
  const clicked = Number(message.clicks || 0);
  const files = Number(message.attachmentOpens || 0);
  return (
    <div className="activity-summary">
      <strong>{summaryText(opened, clicked, files)}</strong>
      <span>{message.lastActivityAt ? `Last activity ${formatDate(message.lastActivityAt)}` : "No activity yet"}</span>
    </div>
  );
}

function EventIcon({ type }) {
  if (type === "open") return <span className="event-icon open"><Eye size={16} /></span>;
  if (type === "attachment_open" || type === "pdf_view" || type === "pdf_download") return <span className="event-icon pdf"><FileText size={16} /></span>;
  return <span className="event-icon click"><LinkIcon size={16} /></span>;
}

function Metric({ label, value, trend }) {
  return (
    <article className="metric-card">
      <span>{label}</span>
      <strong>{value}</strong>
      <em>{trend}</em>
    </article>
  );
}

function Heatmap({ cells }) {
  const byCell = new Map(cells.map((cell) => [`${cell.day}:${cell.hour}`, Number(cell.count || 0)]));
  const max = Math.max(1, ...cells.map((cell) => Number(cell.count || 0)));
  return (
    <div className="heatmap">
      <div className="heatmap-hours">
        <span />
        {HOUR_LABELS.map((label) => <span key={label}>{label}</span>)}
      </div>
      {DAY_LABELS.map((day, dayIndex) => (
        <div className="heatmap-row" key={day}>
          <span>{day}</span>
          {HOUR_LABELS.map((_, hour) => {
            const count = byCell.get(`${dayIndex}:${hour}`) || 0;
            return <i key={hour} style={{ "--heat": count / max }} title={`${day} ${hour}:00 - ${count}`} />;
          })}
        </div>
      ))}
    </div>
  );
}

function LineChart({ title, rows }) {
  const max = Math.max(1, ...rows.map((row) => Number(row.count || 0)));
  const points = rows.map((row, index) => {
    const x = rows.length <= 1 ? 10 : 10 + (index / (rows.length - 1)) * 280;
    const y = 110 - (Number(row.count || 0) / max) * 90;
    return `${x},${y}`;
  }).join(" ");

  return (
    <section className="content-card mini-chart">
      <h2>{title}</h2>
      <svg viewBox="0 0 300 130" role="img" aria-label={title}>
        <polyline points={points} fill="none" stroke="#1967d2" strokeWidth="4" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    </section>
  );
}

function Donut({ title, value, subtitle }) {
  return (
    <section className="content-card donut-card">
      <h2>{title}</h2>
      <div className="donut" style={{ "--value": `${value}%` }}>
        <strong>{value}%</strong>
        <span>{subtitle}</span>
      </div>
    </section>
  );
}

function ContactName({ contact }) {
  return (
    <div className="contact-name">
      <span>{getInitials(contact)}</span>
      <strong>{contact.name || contact.email}</strong>
    </div>
  );
}

function Toggle({ label, text, checked, onChange }) {
  return (
    <label className="toggle-row">
      <span>
        <strong>{label}</strong>
        <small>{text}</small>
      </span>
      <input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function EmptyState({ icon: Icon, title, text }) {
  return (
    <section className="empty-state">
      <Icon size={42} />
      <h2>{title}</h2>
      <p>{text}</p>
    </section>
  );
}

function Placeholder({ title, text }) {
  return (
    <div className="placeholder">
      <Gauge size={36} />
      <h2>{title}</h2>
      <p>{text}</p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="loading-state">
      <Loader2 className="spin" size={24} />
      Loading workspace
    </div>
  );
}

function filterRows(rows, query, fields) {
  const value = query.trim().toLowerCase();
  if (!value) return rows;
  return rows.filter((row) => fields.some((field) => {
    const entry = row[field];
    const text = Array.isArray(entry) ? entry.join(" ") : String(entry || "");
    return text.toLowerCase().includes(value);
  }));
}

function filterByAccount(rows, activeMailAccount) {
  const account = normalizeAccountEmail(activeMailAccount);
  if (!account || account === "all") return rows;
  return rows.filter((row) => normalizeAccountEmail(row.accountEmail) === account);
}

function filterEventsByAccount(rows, activeMailAccount, scopedMessageIds) {
  const account = normalizeAccountEmail(activeMailAccount);
  if (!account || account === "all") return rows;
  return rows.filter((row) => {
    const rowAccount = normalizeAccountEmail(row.accountEmail);
    if (rowAccount) return rowAccount === account;
    return row.messageId ? scopedMessageIds.has(row.messageId) : false;
  });
}

function filterContactsByMessages(contacts, messages, activeMailAccount) {
  const account = normalizeAccountEmail(activeMailAccount);
  if (!account || account === "all") return contacts;
  const recipientEmails = new Set(
    messages
      .flatMap((message) => message.recipients || [])
      .map((recipient) => normalizeAccountEmail(extractEmail(recipient)))
      .filter(Boolean)
  );
  return contacts.filter((contact) => recipientEmails.has(normalizeAccountEmail(contact.email)));
}

function buildClientPerformance(messages, files = []) {
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
    heatmap: buildClientHeatmap(messages),
    sentByDay: groupClientMessagesByDay(messages, "sentAt"),
    openedByDay: groupClientMessagesByDay(messages, "lastActivityAt")
  };
}

function buildClientHeatmap(messages) {
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

function groupClientMessagesByDay(messages, field) {
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

function extractEmail(value) {
  const match = String(value || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return match ? match[0] : value;
}

function normalizeAccountEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function summaryText(opens, clicks, files) {
  const parts = [];
  if (opens) parts.push(`${opens} open${opens === 1 ? "" : "s"}`);
  if (clicks) parts.push(`${clicks} click${clicks === 1 ? "" : "s"}`);
  if (files) parts.push(`${files} file${files === 1 ? "" : "s"}`);
  return parts.length ? parts.join(" - ") : "Sent, not read";
}

function getSortedMessageEvents(message) {
  return [...(Array.isArray(message.events) ? message.events : [])]
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
}

function messageEventTitle(event) {
  if (event.type === "open") return "Opened email";
  if (event.type === "attachment_open") return `Opened file: ${messageEventTarget(event)}`;
  if (event.type === "pdf_view") return `Viewed PDF: ${messageEventTarget(event)}`;
  if (event.type === "pdf_download") return `Downloaded PDF: ${messageEventTarget(event)}`;
  return `Clicked link: ${messageEventTarget(event)}`;
}

function messageEventTarget(event) {
  if (event.label) return event.label;
  if (!event.url) return "tracked item";

  try {
    const url = new URL(event.url);
    return `${url.hostname}${url.pathname}`.replace(/\/$/, "");
  } catch {
    return event.url;
  }
}

function eventVerb(type) {
  if (type === "open") return "opened your email";
  if (type === "attachment_open") return "opened a tracked file";
  if (type === "pdf_view") return "viewed a PDF";
  if (type === "pdf_download") return "downloaded a PDF";
  return "clicked on a link";
}

function formatDate(value) {
  if (!value) return "Unknown";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
}

function relativeTime(value) {
  if (!value) return "Unknown";
  const diff = Date.now() - new Date(value).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} minutes ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return `${days} days ago`;
}

function titleCase(value) {
  return String(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function downloadCsv(name, rows) {
  const columns = Object.keys(rows[0] || { empty: "" });
  const csv = [
    columns.join(","),
    ...rows.map((row) => columns.map((column) => csvCell(row[column])).join(","))
  ].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `simple-track-${name}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = Array.isArray(value) ? value.join("; ") : String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export default App;
