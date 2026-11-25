# Gift Inventory

Tracks promotional gifts (bags, pens, toys…) across Locations. A server on an always-on Windows PC provides the API and the Admin dashboard on the local network. Staff record Counts and Movements on an Android/iPhone app that works offline and syncs over the office Wi-Fi.

- Vocabulary: [CONTEXT.md](CONTEXT.md)
- Key decisions: [docs/adr/](docs/adr/)

## Layout

| Folder | What |
|---|---|
| `packages/shared` | Domain rules shared by server and phone: stock calculation, validation, Void window, Event auto-close, scanning |
| `apps/server-py` | Python server: API + SQLite + backups, also serves the built dashboard. Started by `start-server.bat` |
| `apps/server` | Original Node.js (Fastify) server, kept for reference; same API and database |
| `apps/dashboard` | React admin dashboard (Vite) |
| `apps/mobile` | Expo (React Native) phone app: Android `.apk`, iPhone, and a web version served by the server at `/app` |
| `scripts` | Server install/uninstall, demo data |

## Install on the server PC

1. Install **Python 3.10 or newer** from [python.org](https://www.python.org/downloads/). In the installer, tick **Add python.exe to PATH**. No administrator rights are needed ("Install for me only" is fine).
2. Copy this folder to the PC (e.g. `C:\GiftInventory`), including the built dashboard in `apps\dashboard\dist` and the phone web app in `apps\mobile\dist`. To build them, run `npm run build -w @gifts/dashboard` and `npm run build:phone-web` on a development PC with Node.js.
3. Double-click **`start-server.bat`**. The first start sets up Python packages (needs internet, about a minute). The window then shows the dashboard address, e.g. `http://192.168.1.37:8080`.
4. Open that address and create the first Admin.
5. **Settings & backup**: set the backup folder to your network share (e.g. `\\NAS\Backups\Gifts`) and press *Back up now* once to check it works. Backups run at 02:00 while the server is running.
6. In your router, give the PC a fixed IP (DHCP reservation). Make sure the PC doesn't sleep, or phones can't sync.

**Phones can't connect?** The first time the server starts, Windows may ask whether Python may use the network. Allow it on **Private networks**. If Windows treats the office network as *Public*, change it to *Private* in Windows Settings → Network → your connection.

Data lives in `data\` (database `gifts.db`, `photos\`, `logs\server.log`). The Python server uses the same database as the old Node server, so existing data, Users and paired phones keep working.

**Moving from the old Node.js startup task:** if `scripts\install-server.ps1` was run on this PC, remove that task once so it doesn't hold port 8080. In PowerShell as administrator: `scripts\uninstall-server.ps1` (data is kept).

## Managing the server

- **Start:** double-click `start-server.bat`. Keep the window open (minimise it) while the server should run.
- **Stop:** close the window, or press **Ctrl+C** in it.
- **Restart:** stop, then start.
- **Change the ports:** edit `GIFTS_PORT` (dashboard, default 8080) and `GIFTS_HTTPS_PORT` (phone web app, default 8443) near the top of `start-server.bat`.
- **Logs:** shown in the window, and saved to `data\logs\server.log`:
  ```powershell
  Get-Content data\logs\server.log -Tail 50
  ```
- **Start with Windows (optional):** press Win+R, type `shell:startup`, and put a shortcut to `start-server.bat` in that folder. It then starts when you sign in to Windows.

### Reset the server: delete all data, including demo data

> ⚠️ This permanently deletes every Gift, Location, Event, entry, User, paired phone, photo and setting (including the backup folder setting). It cannot be undone, except by restoring a backup. Unsynced entries still on phones will be refused afterwards, so sync phones first.

Use it to remove demo data (from `node scripts/seed-demo.mjs`, or a `data` folder copied from a development PC) and start clean.

1. Stop the server (close its window).
2. Delete the data. The `logs` folder is kept because the server writes to it:
   ```powershell
   Remove-Item data\gifts.db, data\gifts.db-wal, data\gifts.db-shm, data\photos, data\dev-credentials.txt -Recurse -Force -ErrorAction SilentlyContinue
   ```
3. Start the server (`start-server.bat`).
4. Open the dashboard. It shows **“Create the first Admin”** again.
5. Re-pair every phone: in the app, **Settings → Disconnect this phone**, then scan a new code from **Devices → Pair a phone**.

## Importing and exporting Gifts (CSV)

On the dashboard, **Gifts & labels** has **Export CSV / Export Excel** and **Import CSV / Excel**. Export and import use the same format, so the usual way to change many Gifts is to export, edit in Excel, and import.

### Columns

| Column | Required | What to put in it |
|---|---|---|
| `ID` | no | Leave **empty for a new Gift**. Exports fill it in; keep it to update that Gift, even if you change its name. |
| `Name` | **yes** | e.g. `Blue logo pen`. Without an `ID`, an existing Gift with this name (ignoring case) is updated; otherwise a new one is created. |
| `Category` | no | e.g. `Pens`. A new name creates the Category. |
| `Unit Cost` | no | e.g. `0.85` (a `$` sign is fine). |
| `Low Stock Threshold` | no | Whole number of Pieces across all Locations, e.g. `100`. |
| `Packs` | no | `Name=Pieces`, separated by `;`, e.g. `Carton=50; Box=10`. |
| `Barcodes` | no | Codes printed on the packaging, separated by `;`, e.g. `0123456789012; 0812345000017`. |
| `Archived` | no | `yes` or `no`. Empty keeps the Gift as it is (new Gifts are not archived). |
| `Stock: <Location>` | no | One column per Location, e.g. `Stock: Storeroom`, `Stock: Event booth`. The number of Pieces on that shelf. |

Example:

```csv
ID,Name,Category,Unit Cost,Low Stock Threshold,Packs,Barcodes,Archived,Stock: Storeroom,Stock: Event booth
,Blue logo pen,Pens,0.85,100,Carton=50; Box=10,0123456789012,no,420,30
,Canvas tote bag,Bags,2.10,40,Bundle=10,,no,200,
```

### Rules

- **Column names** ignore upper/lower case, and columns can be in any order. Only `Name` is required; leave out columns you don't use.
- **Each row describes the whole Gift.** An empty cell clears that field: an empty `Packs` removes the Gift's Packs, for example. The exception is an empty `Archived`, which keeps the current state.
- **Stock numbers set the shelf** (they're recorded as Counts by you, with the note "Imported"). An empty cell leaves that Location alone, and a number equal to the current stock is skipped, so re-importing an unchanged export records nothing. A `Stock:` column for a Location that doesn't exist yet creates it. Numbers must be whole and 0 or more.
- **Bad rows are skipped, the rest are imported.** The import then lists each problem with its row number (the header is row 1), so you can fix those rows and import again.
- **Excel** files (`.xlsx`) use the same columns. When saving from Excel, choose **CSV UTF-8** so names with accents survive.

### Loading your existing data for the first time

1. Create your Locations on **Locations & categories**, or just name them in `Stock:` columns.
2. On **Gifts & labels → Import CSV / Excel**, download the **CSV template**. It already has a `Stock:` column for each Location.
3. Fill one row per Gift, leaving `ID` empty, and put what's on each shelf in the `Stock:` columns.
4. Import it. Check **Stock** and **Activity**: each starting quantity shows as a Count with the note "Imported".

## Phones

There are two ways to put the app on a phone:

| | Web app (recommended) | Installed app |
|---|---|---|
| iPhone | ✅ No Apple account needed | Needs a paid Apple Developer account (TestFlight, below) |
| Android | ✅ | ✅ `.apk` (below) |
| Updates | Automatic: rebuild on the PC, phones get it next time they open the app | Install each new build |

### Web app (iPhone and Android)

The server also serves the phone app as a web page at `https://<PC address>:8443/app`. Added to the home screen, it opens full-screen with its own icon, like an installed app. Scanning, offline entries and sync work as in the installed app.

**On the server PC (once, and after each change to the phone app):** on a PC with Node.js, in the project folder, run:

```powershell
npm run build:phone-web
```

This creates `apps\mobile\dist`. Copy that folder to the server PC (same place) and restart the server. Phones pick up the new version the next time they open the app while on the office Wi-Fi.

**On each phone (once):** the phone must be on the office Wi-Fi. Open the **Phone setup** address in the phone's browser: Safari on iPhone, Chrome on Android. It is `http://<PC address>:8080/phone`, e.g. `http://192.168.1.37:8080/phone`, and is also shown on the dashboard under **Settings & backup** and in the server window. The page has the steps and buttons for the following.

1. **Install the security certificate.** Browsers allow the camera only on HTTPS, and the PC makes its own HTTPS certificate. Each phone has to trust it once.
   - **iPhone:** tap **Download certificate**, then **Allow**. Open **Settings** → **Profile Downloaded** (or **General → VPN & Device Management**) → **Install**, and enter the passcode. Then go to **Settings → General → About → Certificate Trust Settings** and turn on **Gift Inventory local CA**.
   - **Android:** tap **Download certificate**. Open **Settings**, search for **CA certificate** (usually **Security → More security settings → Encryption & credentials → Install a certificate → CA certificate**), tap **Install anyway** and choose `gift-inventory-ca.crt` from Downloads.
2. **Open the app:** tap **Open Gift Inventory** on the setup page (`https://<PC address>:8443/app`).
3. **Add it to the home screen:**
   - **iPhone (Safari):** tap **Share** (the square with an arrow), then **Add to Home Screen**.
   - **Android (Chrome):** tap **⋮**, then **Add to Home screen** or **Install app**.
4. **Connect:** open **Gift Inventory** from the home screen. On the PC dashboard open **Devices → Pair a phone**, then scan the code in the app or tap **Type the code instead**. Sign in.

**About the certificate:** the PC creates a private certificate authority, valid for 20 years. That's what phones install. It signs the server's HTTPS certificate, which is valid for 825 days, the longest iPhones accept. The server renews that certificate by itself before it expires, and when the PC's IP address changes, so phones never need to install anything again. Both are stored in `data\certs`. Keep that folder (it's included when you copy `data`). If it is deleted, every phone has to install the new certificate.

**Troubleshooting:**
- *"This connection is not private" / "Not secure"*: the certificate isn't installed or trusted yet (on iPhone, check **Certificate Trust Settings**).
- *Can't open the setup page*: check the phone is on the office Wi-Fi, and that Windows allowed Python on Private networks (see above). Port 8443 must be allowed too; Windows asks for Python once, which covers both ports.
- *The app shows old screens after an update*: close it completely and open it again while on the office Wi-Fi.
- *iPhone and storage*: entries waiting to sync are kept in the web app's storage. Open the app on the office Wi-Fi at least every few days so they sync.
- The HTTPS port is set by `GIFTS_HTTPS_PORT` in `start-server.bat` (default `8443`; `0` turns the web app off).

### Expo Go (development only)

Install **Expo Go** from the App Store / Play Store, then on a dev PC on the same Wi-Fi:

```powershell
npm run dev:mobile
```

Scan the QR code shown with Expo Go (Android) or the Camera app (iPhone). In the app, scan the pairing code from **Dashboard → Devices → Pair a phone**, then sign in.

### Android app (.apk)

Builds run in the cloud on Expo's build service (EAS), so no Android Studio is needed. The app ID is `com.kandog.giftinventory`. Don't change it after people have installed the app, or phones will treat it as a different app.

**One-time setup:**

1. Create a free account at [expo.dev](https://expo.dev).
2. From the project folder, sign in:
   ```powershell
   npx eas-cli@latest login
   ```

**Build:** from the project folder, run:

```powershell
npm run build:android
```

- **The first time**, it offers to create an Expo project for the app. Answer **Yes**: this adds the project id to `apps/mobile/app.json`, so commit that change afterwards. When asked about Android signing, choose **Generate new keystore**. Expo stores the keystore and reuses it for every later build, which lets updates install over the old app.
- **Build number:** each build gets the next one automatically.
- **Version name:** the user-visible version is `version` in `apps/mobile/app.json`. Raise it when you release changes, e.g. `1.0.0` to `1.1.0`.
- **Time:** builds take roughly 10–20 minutes, depending on Expo's queue.

**Install on phones:**

1. When the build finishes, the terminal prints a link to the build page on expo.dev. The page is also in your Expo account under the project's builds.
2. Open that link on the Android phone (or send it to staff) and download the `.apk`.
3. Open the downloaded file. Android asks to allow installing apps from this source (the browser or Files app). Allow it and install. Android warns because the app isn't from Google Play; that's expected.
4. Open **Gift Inventory**, scan the pairing code from **Dashboard → Devices → Pair a phone**, and sign in.

**Updating:** build again and install the new `.apk` over the old one. Data and pairing are kept.

> Anyone with the build link can download the app. That's harmless on its own, because the app does nothing without a pairing code from your dashboard. To require an Expo sign-in for downloads, change it in the project's settings on expo.dev.

### iPhone app (TestFlight)

Staff install the iPhone app through Apple's **TestFlight** app. The app ID is `com.kandog.giftinventory`. Builds run in the cloud, so no Mac is needed.

**One-time setup:**

1. **Join the Apple Developer Program** (US$99/year) at [developer.apple.com/programs](https://developer.apple.com/programs/) with your Apple ID. A free Apple ID can't install apps outside the App Store. Approval can take a day or two, longer for an organization.
2. Sign in to Expo from the project folder (skip if you already did this for Android):
   ```powershell
   npx eas-cli@latest login
   ```

**Build and upload to TestFlight:** from the project folder, in your own terminal (it needs your Apple sign-in), run:

```powershell
npm run build:ios
```

- **The first time**, it asks you to sign in to Apple: your Apple ID, password and a two-factor code, then your team if you have more than one. Let it create the **distribution certificate** and **provisioning profile**. Expo stores them for later builds.
- **The build** takes roughly 15–30 minutes plus Expo's queue. It then uploads to App Store Connect, creating the app there the first time.
- **Processing:** Apple then processes the upload for about 10–30 minutes before it appears in TestFlight.
- **Encryption question:** the app is marked as using no non-exempt encryption (`ios.config.usesNonExemptEncryption: false`), so builds don't get stuck at "Missing Compliance".

**Give staff access (internal testing, no Apple review needed):**

1. In [App Store Connect](https://appstoreconnect.apple.com), **Users and Access → +**: invite each staff member with their Apple ID email. The role can be anything; *Customer Support* is the least access. Up to 100 people.
2. **Apps → Gift Inventory → TestFlight → Internal Testing**: create a group, add those users, and add the build.
3. Each person gets an email. On their iPhone they install **TestFlight** from the App Store, accept the invite, and tap **Install**.
4. Open **Gift Inventory**. When iOS asks to find devices on the local network, tap **Allow**, or the app can't reach the server. Then scan the pairing code from **Dashboard → Devices → Pair a phone** and sign in.

**Updating:** run `npm run build:ios` again. TestFlight offers the update to everyone, and data and pairing are kept.

**Every build expires after 90 days**, after which the app stops opening. Rebuild at least every ~2–3 months, even with no changes.

> External testing (sharing a public TestFlight link with people who aren't App Store Connect users) needs Apple's Beta App Review. Apple's reviewers can't get past the pairing screen without your server, so stick to internal testers.

## Development

```powershell
npm install
npm test
npm run typecheck
npm run dev:server
npm run dev:dashboard
python -m unittest discover -s apps/server-py/tests
```

`dev:server` serves the API on :8080. `dev:dashboard` serves the dashboard on :5173 and proxies `/api` to the server.

Demo data on an empty server: `node scripts/seed-demo.mjs`. Sign-ins are written to `data/dev-credentials.txt`.
