# Chrome Web Store Compliance Checklist

Last reviewed: June 20, 2026

## Current Status

- Chrome extension package builds successfully at `dist/simple-track-email-tracker.zip`.
- Manifest uses MV3 and no remote hosted code was found in the extension source.
- Broad backend host permissions were narrowed to `https://us-central1-simple-track-prod.cloudfunctions.net/*`.
- The broad `tabs` permission was removed; the extension now uses `activeTab` plus existing host permissions.
- Prototype demo tracking data and simulated open events were removed from the extension runtime.

## Submission Blockers

- Publish a public privacy policy URL before submitting.
- Complete Chrome Developer Dashboard privacy disclosures for all collected data.
- Add clear permission justifications in the Developer Dashboard.
- Confirm the store listing has a single-purpose description: email tracking for Gmail and Outlook webmail, with reporting for opens, link clicks, and file views.
- Get legal review before using compliance language such as GDPR, SOC 2, audited, certified, or similar.

## Permission Justification Draft

- `activeTab`: Lets the popup communicate with and, if needed, inject the content script into the active Gmail or Outlook webmail tab after the user opens Simple Track.
- `alarms`: Refreshes tracking state periodically so open/click notifications can be delivered without leaving the popup open.
- `notifications`: Shows desktop notifications when a tracked email is opened.
- `scripting`: Injects the Gmail/Outlook content script into the active mail tab when Chrome did not load it yet.
- `storage`: Stores extension settings, install credentials, connected mail accounts, and cached tracking metadata locally.
- Gmail and Outlook host permissions: Detect the active mail account, add tracking controls to compose windows, insert tracking pixels, rewrite tracked links, and display tracking indicators in sent mail rows.
- Simple Track app host permissions and `externally_connectable`: Let the web app and extension exchange signed connection/session handoff messages for connected accounts.
- Firebase Functions host permission: Calls the Simple Track backend for message creation, account connection, report sync, realtime events, click redirects, and tracking state.

## Data Disclosure Draft

Simple Track collects or processes the following data for email tracking:

- Mail account email address and connected account display name.
- Tracked email subject, recipient email addresses, send timestamp, and webmail client.
- Tracking event type: email open, link click, or file view.
- Event timestamps, link labels, destination URLs, and file labels when link/file tracking is enabled.
- Hashed IP-derived request fingerprint, user-agent string, summarized browser/platform, and coarse platform-provided location for abuse prevention, duplicate filtering, and event context.
- Local extension settings such as tracking toggle, notification toggle, retention preference, connected accounts, known accounts, install ID, and install secret.

Simple Track should disclose that it does not collect mailbox passwords or full inbox contents, and that direct Firestore/Storage client access is denied by Firebase rules.

## Store Listing Guidance

- Keep the purpose narrow: "Track email opens, link clicks, and file views in Gmail and Outlook webmail."
- Do not imply guaranteed open detection; tracking can be affected by image blocking, client caching, security scanners, and proxy behavior.
- Do not claim SOC 2 compliance until an actual audit is complete.
- Do not claim GDPR compliance unless the privacy policy, data processing terms, deletion/export process, lawful basis, and subprocessors are ready.

## Official References

- Chrome Web Store Program Policies: https://developer.chrome.com/docs/webstore/program-policies/
- Chrome privacy practices form: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy/
- Chrome extension permissions: https://developer.chrome.com/docs/extensions/develop/concepts/declare-permissions/
- `activeTab` permission: https://developer.chrome.com/docs/extensions/develop/concepts/activeTab/
- `tabs` API permission guidance: https://developer.chrome.com/docs/extensions/reference/api/tabs/
