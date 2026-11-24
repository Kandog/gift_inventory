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

## Phones

**For testing now:** install **Expo Go** from the App Store / Play Store, then on a dev PC on the same Wi-Fi:

```powershell
npm run dev:mobile
```

Scan the QR code shown with Expo Go (Android) or the Camera app (iPhone). In the app, scan the pairing code from **Dashboard → Devices → Pair a phone**, then sign in.

**For everyday use** the app needs a real build (Expo Go is for development). Build with EAS (`npx eas-cli build`). Android produces an `.apk` you can install directly. iPhones need an Apple Developer account to install outside the App Store (TestFlight or ad-hoc). `apps/mobile/app.json` uses placeholder bundle ids (`com.example.giftinventory`) that must be changed to your own first.

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
