import { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
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
  UserRound,
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

function harnessAllowed() {
  const params = new URLSearchParams(window.location.search);
  return params.has("harness") || ["localhost", "127.0.0.1"].includes(window.location.hostname);
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

function toUser(authUser) {
  return {
    displayName: authUser.displayName || authUser.email || "Simple Track User",
    email: authUser.email || "",
    photoURL: authUser.photoURL || "",
    getIdToken: () => authUser.getIdToken()
  };
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
  const [authReady, setAuthReady] = useState(false);
  const [user, setUser] = useState(null);
  const [bootstrap, setBootstrap] = useState(null);
  const [data, setData] = useState(null);
  const [activePage, setActivePage] = useState("activity");
  const [activeMailAccount, setActiveMailAccount] = useState("all");
  const [query, setQuery] = useState("");
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const allowHarness = harnessAllowed();
  const isConnectPage = window.location.pathname === "/connect-extension";

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

  async function getToken() {
    return user?.getIdToken ? user.getIdToken() : "";
  }

  async function loadWorkspace() {
    setLoading(true);
    setError("");
    try {
      const [boot, dashboard] = await Promise.all([
        fetchBootstrap(getToken),
        fetchDashboard(getToken)
      ]);
      setBootstrap(boot);
      setData(dashboard.data);
      const firstAccount = dashboard.data?.connectedAccounts?.[0]?.email || boot.connectedAccounts?.[0]?.email || "all";
      setActiveMailAccount(firstAccount);
    } catch (loadError) {
      if (allowHarness) {
        setBootstrap(mockBootstrap);
        setData(mockDashboard);
        setActiveMailAccount(mockDashboard.connectedAccounts?.[0]?.email || "all");
      } else {
        setError(loadError.message);
      }
    } finally {
      setLoading(false);
    }
  }

  async function login(providerName) {
    setError("");
    try {
      const provider = providerName === "microsoft" ? microsoftProvider : googleProvider;
      const result = await signInWithPopup(auth, provider);
      setUser(toUser(result.user));
    } catch (loginError) {
      setError(loginError.message);
    }
  }

  function loginHarness() {
    setError("");
    setUser(createHarnessUser());
    setBootstrap(mockBootstrap);
    setData(mockDashboard);
  }

  async function logout() {
    setProfileOpen(false);
    setUser(null);
    setBootstrap(null);
    setData(null);
    if (auth.currentUser) await signOut(auth);
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
                {user?.photoURL ? <img src={user.photoURL} alt="" /> : <span>{getInitials(user)}</span>}
              </button>
              {profileOpen ? (
                <div className="profile-menu">
                  <strong>{user?.displayName}</strong>
                  <small>{user?.email}</small>
                  <ProfileAccountSwitcher
                    accounts={data?.connectedAccounts || bootstrap?.connectedAccounts || []}
                    activeMailAccount={activeMailAccount}
                    setActiveMailAccount={setActiveMailAccount}
                  />
                  <button type="button" onClick={() => login("google")}>
                    <Users size={15} />
                    Change account
                  </button>
                  <button type="button" onClick={logout}>
                    <LogOut size={15} />
                    Sign out
                  </button>
                </div>
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
            <MicrosoftLogo />
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

function MicrosoftLogo() {
  return (
    <svg className="brand-login-logo" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F25022" d="M2 2h9.5v9.5H2V2Z" />
      <path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5V2Z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2v-9.5Z" />
      <path fill="#FFB900" d="M12.5 12.5H22V22h-9.5v-9.5Z" />
    </svg>
  );
}

function ConnectExtensionPage({ user, authReady, allowHarness, error, setError, login, loginHarness, getToken, logout }) {
  const [params] = useState(() => readConnectionParams());
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");
  const [connectedAccount, setConnectedAccount] = useState(null);
  const requestedEmail = params.accountEmail || "";

  async function continueWithGoogle() {
    setStatus("signing-in");
    setError("");
    setMessage("");
    try {
      if (!user) {
        await login("google");
      } else {
        await connectSignedInUser();
      }
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
      setMessage("The extension connection link is missing required details. Return to Gmail and click Enable again.");
      return;
    }

    setStatus("connecting");
    try {
      const response = await connectExtension(getToken, {
        installId: params.installId,
        installSecret: params.installSecret,
        accountEmail: requestedEmail,
        client: params.client || "Gmail",
        provider: "google",
        accountDisplayName: user?.displayName || requestedEmail
      });
      setConnectedAccount(response.account);
      setStatus("connected");
      setMessage(`${requestedEmail} is connected. You can return to Gmail.`);
    } catch (connectError) {
      setStatus("failed");
      setMessage(connectError.message);
    }
  }

  async function chooseAnotherAccount() {
    if (user) await logout();
    setStatus("idle");
    setMessage("");
    await login("google");
    setStatus("signing-in");
  }

  function useHarnessAccount() {
    loginHarness();
    setStatus("signing-in");
  }

  const isBusy = status === "signing-in" || status === "connecting";
  const isConnected = status === "connected";
  const isFailed = status === "failed";

  return (
    <main className="connect-page">
      <section className="connect-panel">
        <div className="connect-brand-row">
          <div className="logo-mark">ST</div>
          <span />
          <GoogleLogo />
        </div>
        <h1>{isConnected ? "Gmail connected" : isFailed ? "Connection needs attention" : "Connect Gmail"}</h1>
        <p className="connect-lede">
          {isConnected
            ? `${connectedAccount?.email || requestedEmail} can now use Simple Track from Gmail without access keys.`
            : `Connect ${requestedEmail || "this Gmail account"} to Simple Track so the extension can track only the right account.`}
        </p>

        <div className="permissions-card">
          <PermissionItem icon={ShieldCheck} title="Permissions we need" text="Simple Track links this browser install to the Google account you choose." />
          <PermissionItem icon={Eye} title="No mailbox harvesting" text="The web app receives tracking metadata, not your full inbox or password." />
          <PermissionItem icon={Check} title="You are in control" text="Disconnect or change accounts from the app profile menu or extension settings." />
        </div>

        {user ? (
          <div className="signed-in-strip">
            <UserRound size={18} />
            <span>Signed in as <strong>{user.email}</strong></span>
          </div>
        ) : null}

        {message || error ? (
          <div className={isConnected ? "success-banner" : "error-banner compact"}>
            {message || error}
          </div>
        ) : null}

        <div className="connect-actions">
          {!isConnected ? (
            <button type="button" onClick={continueWithGoogle} disabled={!authReady || isBusy}>
              {isBusy ? <Loader2 className="spin" size={18} /> : <GoogleLogo />}
              {user ? "Connect this Gmail" : "Continue to Google"}
            </button>
          ) : (
            <a className="connect-done-button" href="https://mail.google.com/">Return to Gmail</a>
          )}
          {user && !isConnected ? (
            <button className="ghost-button" type="button" onClick={chooseAnotherAccount}>
              Choose another Google account
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
    source: get("source")
  };
}

function PageRouter({ activePage, query, activeMailAccount, data, setData, getToken, bootstrap }) {
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
  if (activePage === "email") return <EmailTracking messages={filtered.messages} />;
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

function EmailTracking({ messages }) {
  const [sort, setSort] = useState("lastActivity");
  const rows = [...messages].sort((a, b) => {
    if (sort === "opens") return Number(b.opens || 0) - Number(a.opens || 0);
    if (sort === "sent") return new Date(b.sentAt || 0) - new Date(a.sentAt || 0);
    return new Date(b.lastActivityAt || b.sentAt || 0) - new Date(a.lastActivityAt || a.sentAt || 0);
  });

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
          <button className="icon-button table-action" type="button" aria-label="More actions"><MoreHorizontal size={18} /></button>
        ])}
      />
    </section>
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
              <span>{link.device || "Unknown device"}</span>
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
                <p>Open Gmail, click Enable in the Simple Track prompt, then sign in here. No install keys or pasted codes are required.</p>
                <div className="connected-account-list">
                  {connectedAccounts.length ? connectedAccounts.map((account) => (
                    <span key={account.email}>
                      <Check size={14} />
                      {account.email}
                    </span>
                  )) : <em>No Gmail accounts connected yet</em>}
                </div>
              </div>
              <a className="settings-link-button" href="https://mail.google.com/" target="_blank" rel="noreferrer">Open Gmail</a>
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
            <Toggle
              label="Privacy mode"
              text="Hide detailed device and location values in app surfaces where possible."
              checked={settings.privacyMode}
              onChange={(value) => saveSettings({ ...settings, privacyMode: value })}
            />
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
