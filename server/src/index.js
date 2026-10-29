// Starts the server. Settings come from environment variables:
//   PORT            port to listen on (default 3000)
//   DATA_DIR        where the database and uploads live (default ./data)
//   ADMIN_USER      admin username created on first start (default "admin")
//   ADMIN_PASSWORD  admin password; if missing, one is generated and printed

const path = require('node:path');
const { createApp } = require('./app');

const port = Number(process.env.PORT) || 3000;
const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));

const app = createApp({
  dataDir,
  adminUser: process.env.ADMIN_USER || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD,
});

// "0.0.0.0" means: accept connections from other devices too, not just this computer.
app.listen(port, '0.0.0.0', () => {
  console.log(`Kiosk server running on http://localhost:${port} (data in ${dataDir})`);
});
