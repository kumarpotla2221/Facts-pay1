# Facts Pay mobile

React Native + Expo + TypeScript app for Android and iOS. Uses the existing Fastify backend; no database credentials belong in this app.

## Run

1. Install both workspaces from the repository root: `npm install`. Use the single root `package-lock.json`.
2. Configure backend secrets in `apps/api/.env` and school connections in `apps/api/schools.json`, then start the backend from the repository root: `npm run dev:api`.
3. Copy `apps/mobile/.env.example` to `apps/mobile/.env` if it does not exist. Set `EXPO_PUBLIC_API_URL` to the backend URL and `EXPO_PUBLIC_SCHOOL_SLUG` to the school slug. Existing local environment files were moved with the apps.
4. In another terminal at the repository root, run `npm run dev:mobile` and open using a compatible Expo Go app or a development build. You can also run `npm start` from `apps/mobile/`.

For a physical phone, use the computer's LAN IPv4 address, e.g. `http://192.168.1.10:4000`; both devices must be on the same network. Allow the backend port through the local firewall if needed. Android emulator uses `http://10.0.2.2:4000`; iOS simulator uses `http://localhost:4000`. Restart Expo after changing environment variables. For device builds and production use an HTTPS backend URL.

The generated project uses Expo SDK 58. The device's Expo Go must support that SDK; otherwise use a development build. Local iOS builds require macOS/Xcode. Cloud builds require separately configured Expo and Apple/Google developer accounts. This repository does not publish or sign builds.

## Included

- School branding and logo fetched from the existing backend.
- Bundled Poppins fonts and mobile layout using the website's colours.
- Admission-number lookup, fee selection, server-defined partial-payment minimums.
- Annual statement display and native PDF sharing/saving.
- Optional email and phone, explicit demo checkout, confirmation and text receipt sharing.
- Loading/error states and locked order details while checkout is active.

## Demo payments

Checkout is disabled by default. Against a TEST database only, set `EXPO_PUBLIC_DEMO_CHECKOUT=1` and backend `MOCK_GATEWAY=1`. Simulating success creates an actual PAID row in that test database, reducing displayed dues; no money moves. A confirmed failure (HTTP 402) returns to fee selection and displays the error. A timeout or transport error keeps the order and does not prove failure: check the order in the database before creating another attempt. The existing backend has no order-status endpoint.

The app never calls mock settlement automatically. Real gateway SDK integration, verified webhooks, payment-status/recovery APIs, persistent receipts, and stronger student authentication are still required before live payments. EXPO_PUBLIC settings are embedded in the app and must contain no secrets.

Receipt sharing is text; the existing backend emails receipt PDFs but has no receipt-download API. Statement PDFs are fetched by POST, shared from temporary app cache, then deleted. Customer data is kept in memory only.

## Checks

From the repository root, `npm run typecheck` checks both workspaces.

`npm run lint` lints the mobile app and its tests.

From the repository root, run the mobile API and PDF tests without connecting to SQL Server:

`npm test`

`npm run test:integration` runs database integration tests that write payment records. Run those only against a disposable test database.

`npm run build:mobile` exports Android and iOS bundles. Mobile-only commands can also be run from `apps/mobile/`.

Physical-device validation is still required, including lookup, PDF sharing and network failures. Do not run demo payments against a live school database.

## Run Expo Go over Android USB

The local checkout includes ADB at `.tools/platform-tools/adb.exe` (not committed to Git). On a fresh checkout, install Android SDK Platform Tools and use its `adb` command instead. Enable USB debugging and accept the phone's authorization prompt. Start the backend with `npm run dev:api` from the repository root. In another terminal, also from the repository root:

```powershell
.\.tools\platform-tools\adb.exe devices
.\.tools\platform-tools\adb.exe reverse tcp:4000 tcp:4000
.\.tools\platform-tools\adb.exe reverse tcp:8081 tcp:8081
npm run dev:mobile -- --go --localhost --port 8081 --clear
```

Set `EXPO_PUBLIC_API_URL=http://127.0.0.1:4000` in `apps/mobile/.env` for this USB setup. Scan the newly generated QR code in compatible Expo Go, and keep both servers running and USB connected. If you choose a different Metro port, reverse that port too. Repeat forwarding after reconnecting USB.

## Build an APK using the hosted API

The `preview` profile builds a standalone APK using `https://facts-pay1-fks1.vercel.app`.
It includes the app's JavaScript and uses the hosted demo API, so Expo Go, Metro, USB forwarding,
and a running laptop are not required after installation. The phone still needs internet access.
Checkout is simulated and the app displays a demo label; no real money is collected.

Review the local `eas.json` changes before starting a build. From `apps/mobile/`:

```powershell
npx --yes eas-cli@latest login
npx --yes eas-cli@latest build --platform android --profile preview
```

The build command uploads the project to Expo's cloud build service. On the first build, follow the prompts to
create/link an Expo project and generate an Android signing keystore. This can update the app's project configuration;
review those changes and keep the signing credentials for future builds. These commands do not push to GitHub
or deploy the Vercel backend.

When the build finishes, open its Expo build page and download the `.apk` from the build artifact link.
Open that link on the Android phone, allow installation from that browser if prompted, and install the APK.
The `preview` profile's public API URL is embedded at build time; changing it requires another APK build.

See Expo's [APK build instructions](https://docs.expo.dev/build-reference/apk/).

## Build an Android APK for the local USB demo

The `demo` profile in `eas.json` produces a standalone, internally distributed APK. It embeds the JavaScript and does not need Expo Go or Metro. It still needs the backend and database.

From `apps/mobile/` (EAS configuration belongs in this app directory):

```powershell
npx --yes eas-cli@latest login
npx --yes eas-cli@latest build --platform android --profile demo
```

On the first build, follow the CLI prompts to create/link an Expo project and generate an Android signing keystore. Keep the signing credentials for future builds. Download the APK from the resulting build link, transfer it to the phone and install it. Allow installation from that source if Android asks.

This profile uses the existing local backend via USB (`http://127.0.0.1:4000`). Start the backend and SQL Server on the computer, connect an authorized USB-debugging phone, then from the repository root run:

```powershell
.\.tools\platform-tools\adb.exe reverse tcp:4000 tcp:4000
```

Only port 4000 is required for the APK; port 8081 is for Expo development only. Repeat forwarding after reconnecting USB. Local HTTP is allowed only by this demo build profile. Simulated successful payments modify the local database; no real money is charged.

To demonstrate without USB or your computer, deploy the API with reachable database access and rebuild with its HTTPS API URL. Installing an APK alone does not host the API or SQL Server. Do not use this demo profile for production.
