# Heebee Review Hub — GitHub Pages SPA

Apple-inspired luxury UI for the Heebee customer review intelligence platform.
Frontend on GitHub Pages, Google Apps Script as the backend API.

---

## What's in this repo

```
heebee-review-hub/
├── index.html         ← full SPA (luxury UI, optimistic updates, PWA)
├── manifest.json      ← PWA manifest (installable, shortcuts, app badge)
├── sw.js              ← service worker (offline, background sync, push)
├── Code_API.gs        ← PASTE into your existing GAS project
├── icon-192.png       ← (TODO — copy from your old project)
└── icon-512.png       ← (TODO — copy from your old project)
```

---

## One-time setup

### 1. Add the API layer to your GAS project
1. Open your existing GAS project (the one that has `Code.gs` with `fetchReviews`, `postToSlack` etc.)
2. **Delete** the old `doGet()` at the top
3. Open `Code_API.gs` from this repo, copy the entire file
4. Paste it at the **end** of your `Code.gs`
5. Change `const API_SECRET = 'heebee_review_hub_2026_changeme';` to any random string (keep it safe)
6. **Save** (⌘+S)
7. Deploy → **Manage Deployments** → click the pencil → **New version** → Deploy
   - The `/exec` URL stays the same — no need to change `API_URL` in `index.html`

### 2. Copy your icons
```bash
cp ~/Desktop/heebee-haos/heebee-haos/icon-192.png ~/Desktop/heebee-review-hub/
cp ~/Desktop/heebee-haos/heebee-haos/icon-512.png ~/Desktop/heebee-review-hub/
```
(or replace with new branded icons later)

### 3. Push to GitHub Pages
```bash
cd ~/Desktop/heebee-review-hub
git init
git add .
git commit -m "Initial Review Hub on GitHub Pages"
git branch -M main
gh repo create heebee-review-hub --public --source=. --push
# Then in GitHub: Settings → Pages → Source: main / root → Save
```
Your app will be live at:
`https://<your-username>.github.io/heebee-review-hub/`

---

## Features built in

### ✅ Heebee luxury design system
- Nunito Sans + Space Mono typography
- Frosted glass surfaces with `backdrop-filter`
- Ambient drifting orbs + grain texture
- Light/dark theme with full token transition
- Gold accents, never overused

### ✅ Optimistic UI with auto-revert
Every action flips instantly:
- **Mark read** → updates UI before server confirms; reverts + toast on failure
- **Reply** → shows as posted immediately; reverts if API fails
- **Notes** → save locally first, sync in background
- **Status changes** (escalate, etc.) → optimistic with revert

If you're offline, failed writes are queued in `localStorage` and replayed via Background Sync when you're back online.

### ✅ Latency fixes
| Problem in old version | Fix |
|---|---|
| Every reload re-fetched 1000+ reviews | 5-min localStorage cache + background revalidate |
| Slow first paint on big lists | Skeleton loaders + paginated render (30 at a time, "Load more" button) |
| Every keypress in search triggered re-render | 180ms debounce |
| Theme switch reflowed everything | All transitions on CSS tokens (no JS re-render) |
| No visual feedback during API calls | Toast system + optimistic flips |
| Reviews list re-fetched on every tab switch | Filters work on already-loaded data |

### ✅ 30-day session
- Token stored in `localStorage`, expires after 30 days
- Token is **stateless and signed** server-side (`SHA256(email|exp|secret)`) — no DB lookup per request
- "Keep me signed in" checkbox on login
- Auto-redirects to login screen when expired
- Server re-verifies user is still active on every protected call (so deactivating in the Users sheet logs them out)

### ✅ Face ID / fingerprint sign-in (WebAuthn)
- After first password login, prompts to enable biometric on this device
- Uses platform authenticator (Face ID on iPhone, Touch ID on Mac, fingerprint on Android, Windows Hello on PC)
- Credential ID stored against the user in the `BiometricCreds` sheet (auto-created)
- Subsequent logins: tap "Sign in with Face ID" → biometric → done
- Password still works as fallback always

### ✅ PWA — installable + offline
- Add to home screen on iPhone/Android → opens full-screen with no browser chrome
- **Offline mode**: cached reviews readable without network
- **Background Sync**: replies/notes queued offline auto-send when reconnected
- **App badge**: unread review count shows on the home-screen icon
- **Push notifications**: ready to wire up (see below)
- **Shortcuts**: long-press app icon → jump to Unread / Low ratings / Pending

### ✅ Minor glitches fixed (vs old version)
- Search no longer freezes UI on every keystroke (debounced)
- Stars rendered as actual `<span>` not Unicode (so they color correctly per theme)
- Long review text now clamps to 3 lines on cards, full text in modal
- Branch/platform filters scroll horizontally without breaking layout on iPhone
- Reply modal closes properly on iOS Safari (sheet animation)
- Theme toggle persists across sessions
- Avatar initials handle empty/short names safely
- All inputs have `-webkit-appearance: none` (no ugly iOS styling)

---

## Suggested next PWA upgrades

I built the foundation — these are the features you should add **next** to make it a fully native-feeling app:

1. **Push notifications for low ratings**
   You already post to Slack. Add a parallel `webpush` to subscribed devices so floor managers get a phone notification when a 1-2★ lands at their branch. SW already has the `push` handler — you just need to:
   - Add a `subscribeUser()` flow in `index.html` (`PushManager.subscribe`)
   - Store the subscription in a `PushSubscriptions` sheet
   - In `processNewReviewsForSlack()`, also call a `sendWebPush(subscription, payload)` for each subscribed device
   - Requires VAPID keys — generate once with `npx web-push generate-vapid-keys`

2. **Periodic Background Sync** (Android Chrome)
   Auto-refresh reviews every hour even when the app is closed:
   ```js
   await registration.periodicSync.register('refresh-reviews', { minInterval: 60 * 60 * 1000 });
   ```

3. **File System Access API for export**
   Add an "Export reviews to CSV/Excel" button that uses `showSaveFilePicker()` so the user can save reports directly to their Mac/PC without downloads folder.

4. **Web Share Target**
   Let users share a Google Maps review screenshot → opens Heebee Reviews app → auto-creates a manual review entry. Add `share_target` to `manifest.json`.

5. **Contact Picker API**
   In the "Add manual review" form, let staff pick a customer's phone from their contacts: `navigator.contacts.select(['name','tel'])`.

6. **iOS install instructions banner**
   iOS doesn't fire `beforeinstallprompt`. Detect iOS Safari and show a custom "Tap Share → Add to Home Screen" hint.

7. **Differential sync** (heavy optimization)
   Instead of fetching all reviews, send `since=lastSyncTimestamp` and only get new/changed ones. Cuts data transfer by ~95% after first load.

8. **Skeleton ratings + ghost transitions**
   The number cards at the top could fade smoothly from `—` to the real number with a spring animation, rather than jumping.

9. **Pull-to-refresh**
   Native iOS pattern — drag down on the list to force-refresh. ~30 lines of touch event handling.

10. **Speech-to-text replies**
    `webkitSpeechRecognition` on the reply textarea — barista can dictate replies between orders.

---

## API contract (for reference)

All endpoints are POST to your `/exec` URL with `Content-Type: text/plain` (avoids CORS preflight) and JSON body:

| action | params | requires token |
|---|---|---|
| `ping` | — | no |
| `login` | `email`, `pin` | no |
| `verifyBiometric` | `email`, `credentialId` | no |
| `verifySession` | `token` | yes |
| `fetchReviews` | — | yes |
| `fetchRatings` | `branch` | yes |
| `fetchTemplates` | — | yes |
| `updateReview` | `id`, `updates: {read, status, replyText, note}` | yes |
| `postGoogleReply` | `reviewId`, `replyText` | yes |
| `saveManualReview` | `review: {...}` | yes |
| `registerBiometric` | `credentialId` | yes |
| `clearCache` | — | yes |

All responses: `{ ok: true, ... }` or `{ ok: false, error: '...', code?: 'SESSION_EXPIRED' }`.

---

## Local dev

```bash
cd ~/Desktop/heebee-review-hub
python3 -m http.server 8000
# open http://localhost:8000
```

Note: service worker only works on `localhost` or HTTPS. GitHub Pages serves HTTPS by default. ✓
