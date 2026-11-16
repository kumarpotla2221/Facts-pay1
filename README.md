# Facts Pay

School fee and transport payments, organized as an npm workspaces monorepo. The Fastify API serves the existing web payment page and connects to each school's SQL Server database. The Expo app uses the same API on Android and iOS.

```text
apps/
  api/
    src/                 Fastify API and payment logic
    public/              Hosted payment page, fonts and school branding
    demo-site/           Demo school website
    schools.json         School and database connection settings
    schools-sql/         School queries and database setup contract
    test/                Resource/PDF tests and database integration tests
    .env.example         Backend environment template
  mobile/
    App.tsx              Expo / React Native app
    src/                 Mobile API client and UI styles
    assets/              App icons and bundled fonts
    test/                Mobile API client tests
    .env.example         Public mobile environment template
package.json             Workspace commands
package-lock.json        One lockfile for both apps
Dockerfile               API production image, built from the repository root
```

## Local development

Use Node.js 22 or newer and npm. Run dependency installation once from the repository root:

```powershell
npm install
```

On a fresh checkout, create the two environment files:

```powershell
Copy-Item apps/api/.env.example apps/api/.env
Copy-Item apps/mobile/.env.example apps/mobile/.env
```

Existing local environment files were moved with their apps during the monorepo migration; keep those files rather than overwriting them. Backend secrets belong in `apps/api/.env`; school connection settings are in `apps/api/schools.json`. Configure a reachable database using the [API setup instructions](apps/api/README.md). Mobile `EXPO_PUBLIC_*` values are embedded in the app and must contain no secrets.

Start the API from the repository root:

```powershell
npm run dev:api
```

In a second terminal, also from the repository root:

```powershell
npm run dev:mobile
```

The API defaults to port 4000. Set `EXPO_PUBLIC_API_URL` in `apps/mobile/.env` for your device:

| Device connection | API URL |
| --- | --- |
| Physical phone on the same Wi-Fi | `http://<computer-LAN-IP>:4000` |
| Android emulator | `http://10.0.2.2:4000` |
| Android phone with USB forwarding | `http://127.0.0.1:4000` |
| iOS simulator on macOS | `http://localhost:4000` |

Restart Expo after environment changes. The app uses Expo SDK 58, so use compatible Expo Go or a development build. See the [mobile README](apps/mobile/README.md) for USB forwarding and APK builds. Expo's [monorepo support](https://docs.expo.dev/guides/monorepos/) handles workspace resolution automatically.

## Root commands

| Command | Purpose |
| --- | --- |
| `npm run dev:api` | Start the API with reload |
| `npm run dev` | Alias for API development |
| `npm run dev:mobile` | Start Expo; append flags after `--` |
| `npm run android` | Open Expo on an Android device or emulator |
| `npm run ios` | Open Expo in an iOS simulator on macOS |
| `npm run typecheck` | Check both apps |
| `npm run lint` | Lint the mobile app and its tests |
| `npm test` | Run API resource, PDF and mobile client tests without connecting to SQL Server |
| `npm run test:integration` | Run API integration tests against the configured database |
| `npm run build` | Compile the API and export both native mobile bundles |
| `npm run build:api` | Compile only the API |
| `npm run build:mobile` | Export Android and iOS mobile bundles |
| `npm start` | Run the compiled API with production environment variables |

Integration tests and simulated successful checkouts write payment records. Use only a disposable test database for those actions.

Each app owns its dependencies. Add or update backend dependencies with `npm install <package> --workspace @facts-pay/api`. For Expo packages, run `npx expo install <package>` from `apps/mobile/` so Expo selects compatible versions. Commit the root lockfile; do not create app-specific lockfiles. npm's [workspace documentation](https://docs.npmjs.com/cli/v11/using-npm/workspaces/) covers running other app commands with `--workspace`.

## Deployment

Build the API container from the repository root with `docker build -t facts-pay .`. The Dockerfile installs only API dependencies and preserves the API's runtime assets and school queries. Supply backend secrets through the deployment environment.

Run EAS commands from `apps/mobile/`; its `eas.json` remains alongside the app. The root `.easignore` excludes local secrets, generated outputs, tools, and the separate nested checkout. An APK still needs a reachable API and database; it does not host them.

The separate pre-existing `facts-pay/` checkout is outside the workspace configuration and has been left unchanged.
