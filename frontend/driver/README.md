# MedRush Driver (`@medrush/driver`)

Expo / React Native app for delivery drivers (BLUEPRINT §5, §20). Dark, high-
contrast, one-handed UX: go online, receive buzzing delivery offers, accept,
pick up, navigate, collect COD, complete with OTP, and manage wallet/payouts.

- **Stack:** Expo SDK 53 · React 19 · Expo Router 5 · TanStack Query · socket.io-client
- **Types:** consumes the frozen `@medrush/contracts` — no hand-written API types
- **Auth:** dev-login (`dev:<uid>:<phone>`) locally; Firebase phone-OTP is the
  production swap-in (only the token exchange changes)

> ⚠️ **This app has been typechecked (`tsc` clean) but not yet run on a device
> from this repo.** Build it with EAS or a local Android SDK and iterate — the
> API it talks to is covered by the backend test suite, so most issues will be
> UI/native, not contract.

---

## 1. Point it at your API

The app reads `EXPO_PUBLIC_API_URL`. Defaults to `http://10.0.2.2:4000` (the
Android **emulator's** alias for your PC's `localhost`).

- **Emulator:** no change needed (uses `10.0.2.2:4000`).
- **Physical phone:** must be your PC's LAN IP, same Wi-Fi:
  ```
  # frontend/driver/.env.local
  EXPO_PUBLIC_API_URL=http://192.168.1.5:4000
  ```
  (find your IP with `ipconfig`; the phone and PC must be on the same network).

Start the backend first (from repo root):
```
pnpm --filter @medrush/api db:seed      # seeds a verified driver: Ravi Kumar
pnpm --filter @medrush/api dev          # API on :4000  (portable Postgres must be up)
```

## 2. Build & run — pick one path

### Path A — Local build (needs Android Studio)
Install **Android Studio** (gives you the Android SDK + an emulator + `adb`), then
set `ANDROID_HOME`, create an AVD or plug in a phone with **USB debugging** on, and:
```
pnpm --filter @medrush/driver exec expo run:android
```
First run compiles the native app with Gradle (slow, downloads ~GB). After that,
JS changes hot-reload via Metro.

### Path B — EAS cloud build (no Android Studio)
```
npm i -g eas-cli
eas login
eas build --profile development --platform android   # builds an installable APK in the cloud
```
Install the APK on your phone, then start Metro and connect:
```
pnpm --filter @medrush/driver start --dev-client
```

> Both paths need a **development build** (this app uses native modules:
> location, haptics). Expo Go will not work.

## 3. Try the full flow
1. Open the app → **Sign in** (seeded driver is pre-filled).
2. **Go online** on Home.
3. Generate an order that reaches `READY` (place one in the customer PWA, pack &
   ready it in the ops console) — dispatch offers it to the online driver.
4. The offer **buzzes** and appears → **Accept** → navigate → **Picked up** →
   at the door enter the 4-digit **OTP** (+ collect COD) → **Complete**.
5. Check **Wallet** (commission credited) and request a **Payout**.

---

## Notes & gotchas

- **pnpm monorepo:** `metro.config.js` is already configured to watch the
  workspace root and resolve `@medrush/contracts`. If Metro can't find a module,
  re-run `pnpm install` at the repo root.
- **OneDrive:** building React Native inside a OneDrive-synced folder can cause
  Gradle file-lock/slow-sync errors. Pause OneDrive sync while building, or move
  the repo to a non-synced path (e.g. `C:\dev\medrush`).
- **Pin exact SDK versions:** the deps here use safe ranges. Before a production
  build, run `pnpm --filter @medrush/driver exec expo install --fix` to align
  every package to the exact Expo SDK 53 set.
- **App icons/splash:** none bundled yet — Expo uses defaults. Add branded
  `assets/` + re-reference them in `app.json` before shipping.

## Known follow-ups (need a device + more native config)
- **FCM push** for offers when the app is backgrounded/closed (today offers
  arrive over the socket while the app is foregrounded). Pair with
  `expo-notifications` + a high-priority channel.
- **Background location** while the app is not foregrounded (today GPS streams
  in the foreground during an active delivery). Needs `expo-task-manager` +
  `startLocationUpdatesAsync` + a foreground service.
- **Firebase phone-OTP** to replace dev-login for production.
- **In-app map** (currently deep-links to Google Maps for navigation).
