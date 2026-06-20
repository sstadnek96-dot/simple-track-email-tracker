const baseMessages = [
  {
    id: "msg-1001",
    accountEmail: "s.stadnek96@gmail.com",
    recipients: ["spencer.tpp@gmail.com"],
    subject: "test",
    sentAt: "2026-05-23T14:38:00.000Z",
    lastActivityAt: "2026-05-23T14:42:00.000Z",
    opens: 3,
    clicks: 2,
    attachmentOpens: 0,
    status: "clicked",
    events: [
      {
        type: "open",
        createdAt: "2026-05-23T14:38:20.000Z"
      },
      {
        type: "click",
        label: "simpletrack.app/pricing",
        url: "https://simpletrack.app/pricing",
        createdAt: "2026-05-23T14:41:00.000Z"
      },
      {
        type: "click",
        label: "simpletrack.app/demo",
        url: "https://simpletrack.app/demo",
        createdAt: "2026-05-23T14:42:00.000Z"
      }
    ]
  },
  {
    id: "msg-1002",
    accountEmail: "s.stadnek96@gmail.com",
    recipients: ["gardening@usask.ca", "gardenline@usask.ca"],
    subject: "Question About Lawncare From Your Webpage",
    sentAt: "2026-05-19T23:59:00.000Z",
    lastActivityAt: "2026-05-20T00:14:00.000Z",
    opens: 2,
    clicks: 0,
    attachmentOpens: 1,
    status: "opened",
    events: [
      {
        type: "open",
        createdAt: "2026-05-20T00:14:00.000Z"
      },
      {
        type: "attachment_open",
        kind: "pdf",
        label: "lawncare-pricing.pdf",
        url: "https://simpletrack.app/file/lawncare-pricing.pdf",
        createdAt: "2026-05-20T00:16:00.000Z"
      }
    ]
  },
  {
    id: "msg-1003",
    accountEmail: "sstadnek96@gmail.com",
    recipients: ["ops@truepoint.ca"],
    subject: "Signed intake package",
    sentAt: "2026-05-18T18:25:00.000Z",
    lastActivityAt: "2026-05-18T20:10:00.000Z",
    opens: 1,
    clicks: 1,
    attachmentOpens: 0,
    status: "clicked",
    events: [
      {
        type: "open",
        createdAt: "2026-05-18T20:03:00.000Z"
      },
      {
        type: "click",
        label: "Proposal portal",
        url: "https://simpletrack.app/proposal",
        createdAt: "2026-05-18T20:10:00.000Z"
      }
    ]
  },
  {
    id: "msg-1004",
    accountEmail: "sstadnek96@gmail.com",
    recipients: ["noreply@github.com"],
    subject: "Payment receipt follow-up",
    sentAt: "2026-05-17T17:20:00.000Z",
    lastActivityAt: null,
    opens: 0,
    clicks: 0,
    attachmentOpens: 0,
    status: "sent",
    events: []
  }
];

const files = [
  {
    id: "pdf-1",
    name: "FRM-15-e-2023-11 - Filled Out - True Point Products Inc.pdf",
    views: 4,
    downloads: 1,
    visitedPages: 6,
    timeSpentSeconds: 325,
    createdAt: "2026-05-18T18:25:00.000Z",
    lastActivityAt: "2026-05-18T20:16:00.000Z",
    trackingUrl: "https://simpletrack.app/file/pdf-1"
  }
];

function activityFromMessages(messages) {
  return messages
    .flatMap((message) => (message.events || []).map((event, index) => ({
      id: `${message.id}-${index}`,
      type: event.type,
      subject: message.subject,
      recipient: message.recipients[0],
      accountEmail: message.accountEmail,
      label: event.label,
      url: event.url,
      createdAt: event.createdAt,
      messageId: message.id
    })))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

function linksFromMessages(messages) {
  return messages
    .flatMap((message) => (message.events || [])
      .filter((event) => event.type === "click" || event.type === "attachment_open")
      .map((event, index) => ({
        id: `${message.id}-link-${index}`,
        subject: message.subject,
        recipient: message.recipients[0],
        accountEmail: message.accountEmail,
        label: event.label || "tracked link",
        url: event.url || "",
        type: event.type,
        kind: event.kind || "link",
        clickedAt: event.createdAt
      })))
    .sort((a, b) => new Date(b.clickedAt).getTime() - new Date(a.clickedAt).getTime());
}

export const mockBootstrap = {
  ok: true,
  user: {
    id: "harness-user",
    displayName: "Spencer Stadnek",
    email: "s.stadnek96@gmail.com",
    photoURL: ""
  },
  org: {
    id: "harness-org",
    name: "Simple Track Workspace"
  },
  membership: {
    role: "owner"
  },
  plan: {
    tier: "free",
    limits: {
      pdfs: 5,
      contacts: 500,
      trackedMessages: 1000
    }
  },
  installCount: 1,
  connectedAccounts: [
    {
      id: "s.stadnek96@gmail.com",
      email: "s.stadnek96@gmail.com",
      displayName: "Spencer Davidson",
      provider: "google",
      client: "Gmail",
      status: "connected",
      connectedAt: "2026-05-23T14:30:00.000Z"
    },
    {
      id: "sstadnek96@gmail.com",
      email: "sstadnek96@gmail.com",
      displayName: "Spencer Stadnek",
      provider: "google",
      client: "Gmail",
      status: "connected",
      connectedAt: "2026-05-18T18:20:00.000Z"
    }
  ]
};

export const mockDashboard = {
  messages: baseMessages,
  activity: activityFromMessages(baseMessages),
  links: linksFromMessages(baseMessages),
  files,
  contacts: [
    {
      id: "spencer.tpp@gmail.com",
      name: "spencer.tpp@gmail.com",
      email: "spencer.tpp@gmail.com",
      domain: "gmail.com",
      lastContactedAt: "2026-05-23T14:38:00.000Z",
      lastHeardFromAt: "2026-05-23T14:42:00.000Z",
      opens: 3,
      clicks: 2,
      unsubscribed: false,
      hardBounced: false
    },
    {
      id: "gardening@usask.ca",
      name: "gardening@usask.ca",
      email: "gardening@usask.ca",
      domain: "usask.ca",
      lastContactedAt: "2026-05-19T23:59:00.000Z",
      lastHeardFromAt: "2026-05-20T00:16:00.000Z",
      opens: 2,
      clicks: 0,
      unsubscribed: false,
      hardBounced: false
    },
    {
      id: "ops@truepoint.ca",
      name: "ops@truepoint.ca",
      email: "ops@truepoint.ca",
      domain: "truepoint.ca",
      lastContactedAt: "2026-05-18T18:25:00.000Z",
      lastHeardFromAt: "2026-05-18T20:10:00.000Z",
      opens: 1,
      clicks: 1,
      unsubscribed: false,
      hardBounced: false
    }
  ],
  performance: {
    totals: {
      sent: 4,
      opened: 3,
      clicked: 2,
      pdfViewed: 1,
      totalOpens: 6,
      totalClicks: 4,
      openRate: 75,
      clickRate: 50,
      pdfRate: 100
    },
    heatmap: Array.from({ length: 168 }, (_, index) => ({
      day: Math.floor(index / 24),
      hour: index % 24,
      count: index % 11 === 0 ? 3 : index % 7 === 0 ? 2 : index % 5 === 0 ? 1 : 0
    })),
    sentByDay: [
      { date: "2026-05-17", count: 1 },
      { date: "2026-05-18", count: 1 },
      { date: "2026-05-19", count: 1 },
      { date: "2026-05-23", count: 1 }
    ],
    openedByDay: [
      { date: "2026-05-18", count: 1 },
      { date: "2026-05-20", count: 2 },
      { date: "2026-05-23", count: 3 }
    ]
  },
  settings: {
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
  },
  plan: mockBootstrap.plan,
  connectedAccounts: mockBootstrap.connectedAccounts
};
