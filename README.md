# Gift Inventory

Tracks promotional gifts (bags, pens, toys…) across Locations. A server on an always-on Windows PC provides the API and the Admin dashboard on the local network. Staff record Counts and Movements on an Android/iPhone app that works offline and syncs over the office Wi-Fi.

- Vocabulary: [CONTEXT.md](CONTEXT.md)
- Key decisions: [docs/adr/](docs/adr/)

## Layout

| Folder | What |
|---|---|
| `packages/shared` | Domain rules shared by server and phone: stock calculation, validation, Void window, Event auto-close, scanning |
| `apps/server` | Fastify API + SQLite + backups, also serves the built dashboard |
| `apps/dashboard` | React admin dashboard (Vite) |
| `apps/mobile` | Expo (React Native) phone app |
| `scripts` | Server install/uninstall, demo data |

## Install on the server PC

1. Install **Node.js 24 LTS** from nodejs.org.
2. Copy this folder to the PC (e.g. `C:\GiftInventory`).
3. Open **PowerShell as administrator** in that folder and run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\install-server.ps1 -DisableSleep
   ```
   Enter the Windows account the server should run as. It must be able to write to your backup share.
4. Open the dashboard address it prints (e.g. `http://192.168.1.37:8080`) and create the first Admin.
5. **Settings & backup**: set the backup folder to your network share (e.g. `\\NAS\Backups\Gifts`) and press *Back up now* once to check it works.
6. In your router, give the PC a fixed IP (DHCP reservation).

Data lives in `data\` (database `gifts.db`, `photos\`, `logs\server.log`). To remove: `scripts\uninstall-server.ps1` (data is kept).

## Managing the server

Run these in **PowerShell as administrator** in the install folder (e.g. `C:\GiftInventory`).

**Check that it is running:**

```powershell
Get-ScheduledTask GiftInventory | Select-Object TaskName, State
```

**See the latest log lines:**

```powershell
Get-Content data\logs\server.log -Tail 50
```

**Stop the server.** Stopping the task alone leaves Node running, so this also ends the server's Node process:

```powershell
Stop-ScheduledTask GiftInventory; Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object CommandLine -like '*apps\server\src\main.ts*' | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
```

**Start the server:**

```powershell
Start-ScheduledTask GiftInventory
```

**Restart:** run the stop command, then the start command.

### Reset the server: delete all data, including demo data

> ⚠️ This permanently deletes every Gift, Location, Event, entry, User, paired phone, photo and setting (including the backup folder setting). It cannot be undone, except by restoring a backup. Unsynced entries still on phones will be refused afterwards, so sync phones first.

Use it to remove demo data (from `node scripts/seed-demo.mjs`, or a `data` folder copied from a development PC) and start clean.

1. Stop the server (command above).
2. Delete the data. The `logs` folder is kept because the server writes to it:
   ```powershell
   Remove-Item data\gifts.db, data\gifts.db-wal, data\gifts.db-shm, data\photos, data\dev-credentials.txt -Recurse -Force -ErrorAction SilentlyContinue
   ```
3. Start the server (command above).
4. Open the dashboard. It shows **“Create the first Admin”** again.
5. Re-pair every phone: in the app, **Settings → Disconnect this phone**, then scan a new code from **Devices → Pair a phone**.

## Phones

**For testing now:** install **Expo Go** from the App Store / Play Store, then on a dev PC on the same Wi-Fi:

```powershell
npm run dev:mobile
```

Scan the QR code shown with Expo Go (Android) or the Camera app (iPhone). In the app, scan the pairing code from **Dashboard → Devices → Pair a phone**, then sign in.

**For everyday use** the app needs a real build. Expo Go is for development only.

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

### iPhone app

iPhones need an Apple Developer account (Apple's paid program) to install apps outside the App Store, through TestFlight or registered devices. `ios.bundleIdentifier` in `apps/mobile/app.json` is still the placeholder `com.example.giftinventory` and must be set before the first iPhone build.

## Development

```powershell
npm install
npm test
npm run typecheck
npm run dev:server
npm run dev:dashboard
```

`dev:server` serves the API on :8080. `dev:dashboard` serves the dashboard on :5173 and proxies `/api` to the server.

Demo data on an empty server: `node scripts/seed-demo.mjs`. Sign-ins are written to `data/dev-credentials.txt`.
