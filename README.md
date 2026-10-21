# BloodLink OneSignal backend

This server replaces the Firebase Cloud Function that watched Firestore for new notification documents. It verifies a Firebase sign-in token, checks that the caller is allowed to trigger each notification, then sends the push through OneSignal. The OneSignal REST API key stays in server environment variables.

## Run locally

1. Install Node.js 22 or newer and run `npm install` from this directory.
2. The ignored local `backend/.env` contains the Firebase project and OneSignal App ID. The start script also reads the existing ignored `functions/.secret.local` for `ONESIGNAL_REST_API_KEY`.
3. Give Firebase Admin SDK access to the project. Either set `GOOGLE_APPLICATION_CREDENTIALS` to a local service-account JSON path, or put the service-account JSON in `FIREBASE_SERVICE_ACCOUNT_JSON` in `backend/.env`.
4. Run `npm start`. The health endpoint is `http://localhost:8787/health`.
5. Run Flutter with the backend URL, for example Android emulator: `flutter run --dart-define=PUSH_BACKEND_URL=http://10.0.2.2:8787`. For a physical phone, use the computer's LAN IP. For web, allow the app origin in `CORS_ORIGINS`.

## Deploy to a Node hosting service

On Render, create a Node web service with root directory `backend`, build command `npm install`, and start command `npm start`. For another Node hosting service, use the same commands. Configure these server environment variables in the hosting dashboard:

- `FIREBASE_PROJECT_ID`: `bloodlinkapp-3d914`
- `FIREBASE_SERVICE_ACCOUNT_JSON`: service-account JSON for this Firebase project; grant only the Firestore read/write access the server needs
- `ONESIGNAL_APP_ID`: the OneSignal App ID
- `ONESIGNAL_REST_API_KEY`: the OneSignal REST API key
- `CORS_ORIGINS`: optional comma-separated allowed origins for Flutter Web

After deploy, set the app's server URL at build/run time with `--dart-define=PUSH_BACKEND_URL=https://YOUR-HOST`. Do not add the OneSignal REST API key or Firebase service-account JSON to Flutter, Git, or the APK.

## Delivery coverage and authorization

The app submits notification document IDs after writing them to Firestore. The server validates the caller against the request/direct-request document and current profile role before sending. This covers blood requests, responses, direct requests, admin messages, and the test push. Existing in-app notification records remain in Firestore.

If the old Firebase `sendPushForNotification` function was ever deployed, remove that trigger after the hosted backend is live so the same Firestore write does not send duplicate pushes. The old function is not needed by this backend.
