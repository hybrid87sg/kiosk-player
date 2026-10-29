// Starts the server. Settings come from environment variables:
//   PORT                         port to listen on (default 3000)
//   DATA_DIR                     where the database lives (default ./data)
//   SUPERADMIN_EMAIL             your Google account; always a superadmin
//   GOOGLE_WEB_CLIENT_ID         "Web" OAuth client ID from Google Cloud Console
//   GOOGLE_SERVICE_ACCOUNT_FILE  path to the service account's JSON key
//   DRIVE_FOLDER_ID              the Drive folder holding the signage content

const fs = require('node:fs');
const path = require('node:path');
const { createApp } = require('./app');
const { createGoogle } = require('./google');

const required = ['SUPERADMIN_EMAIL', 'GOOGLE_WEB_CLIENT_ID', 'GOOGLE_SERVICE_ACCOUNT_FILE', 'DRIVE_FOLDER_ID'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Missing settings: ${missing.join(', ')}`);
  console.error('Set them as environment variables before starting (see the comment at the top of src/index.js).');
  process.exit(1);
}

const port = Number(process.env.PORT) || 3000;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(dataDir, { recursive: true });

const app = createApp({
  dataDir,
  superadminEmail: process.env.SUPERADMIN_EMAIL,
  googleWebClientId: process.env.GOOGLE_WEB_CLIENT_ID,
  google: createGoogle({
    webClientId: process.env.GOOGLE_WEB_CLIENT_ID,
    serviceAccountFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE,
    folderId: process.env.DRIVE_FOLDER_ID,
  }),
});

// "0.0.0.0" means: accept connections from other devices too, not just this computer.
app.listen(port, '0.0.0.0', () => {
  console.log(`Kiosk server running on http://localhost:${port} (data in ${dataDir})`);
});
