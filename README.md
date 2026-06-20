# Simple Track Email Tracker

A Chrome MV3 extension project for Gmail and Outlook webmail email tracking.

This repo is intentionally separate from any transcription project. It contains a Chrome MV3 extension plus a Firebase Functions/Firestore backend for real open and click tracking.

## Load In Chrome

1. Open `chrome://extensions`.
2. Enable `Developer mode`.
3. Choose `Load unpacked`.
4. Select this folder: `C:\Users\Spencer\Downloads\simple-track-email-tracker\extension`.

Do not load the repo root in Chrome. The repo root contains Firebase backend code and test tooling; the clean extension root is `extension`.

## What Works Now

- Gmail and Outlook webmail content script support.
- Row indicators for tracked messages:
  - blue dot for sent/not-yet-read,
  - red dot for opened or clicked.
- Hover cards with open count, click count, file activity, last activity, and event timeline.
- Silent automatic tracking on send.
- Popup dashboard with tabs, stats, search, account switching, and settings link.
- Options page for defaults, notifications, retention, and privacy controls.
- Firebase Functions backend for message creation, tracking pixels, click redirects, and event storage.
- Background service worker that syncs real backend status when configured.

## Firebase Setup

The Firebase project for production is `simple-track-prod`.

You do not need to register a Firebase Web app for this version. The extension calls HTTPS Functions, and the Functions Admin SDK writes to Firestore.

In the Firebase console:

1. Set the project environment type to `Production` in Project settings.
2. Create a Firestore database in Native mode. Start in production mode; this repo deploys rules that deny direct client reads/writes.
3. Upgrade the project to the Blaze plan so Cloud Functions can make outbound responses.
4. Keep the region as `us-central1` for the first deploy unless you intentionally change `SIMPLE_TRACK_REGION`.

From this repo:

```powershell
cd C:\Users\Spencer\Downloads\simple-track-email-tracker
firebase login
firebase use simple-track-prod
firebase functions:secrets:set SIMPLE_TRACK_IP_HASH_SALT
cd functions
npm install
cd ..
npm run firebase:deploy
```

After deploy, reload the extension from `chrome://extensions`. The production API URL is built into the extension.

## Project Structure

```text
extension/                    Clean unpacked Chrome extension root
extension/assets/icons/       Extension icons
extension/src/background/     MV3 service worker
extension/src/content/        Gmail and Outlook content scripts/styles
extension/src/options/        Extension options page
extension/src/popup/          Popup dashboard
functions/                    Firebase Functions backend
scripts/                      Validation, packaging, icon generation
```

## Scripts

```powershell
npm test
npm run icons
npm run package
npm run firebase:deploy
```

`npm test` validates the manifest, checks referenced files, runs syntax checks, and runs Playwright regression tests for Gmail-style sent rows, duplicate subjects, pending sends, hover switching, and hover closing.

## Production Notes

Email open tracking records when the recipient's email client loads the tracking image. Some clients proxy or cache images, so timestamps and locations can be approximate. Click tracking works by redirecting links through the Firebase `click` function before sending users to the original URL.

Before publishing broadly, finish the Chrome Web Store privacy disclosures, publish a public privacy policy, and review quota/abuse controls for the production launch shape.
