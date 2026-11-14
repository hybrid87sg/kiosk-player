// Starts a real Kiosk server for the integration tests, on a free port, with a fresh
// database and one superadmin. Prints {"port": …} on the first line, then keeps running
// until its input closes (the test ends).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const server = path.resolve(__dirname, '..', '..', '..', 'server');
const { createApp } = require(path.join(server, 'src', 'app'));
const { createFakeGoogle } = require(path.join(server, 'test', 'fake-google'));

// The test may restart the server on the same port and data (KIOSK_TEST_PORT / KIOSK_TEST_DATA).
const ownDir = !process.env.KIOSK_TEST_DATA;
const dataDir = process.env.KIOSK_TEST_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'kiosk-ha-test-'));
const app = createApp({
  dataDir, google: createFakeGoogle(), firstAdmin: { username: 'boss', password: 'correct-horse-9' },
  siteName: 'Main Centre', syncIntervalMs: 0, monitorIntervalMs: 0, log: () => {},
});
const http = app.listen(Number(process.env.KIOSK_TEST_PORT) || 0, '127.0.0.1', () => process.stdout.write(`${JSON.stringify({ port: http.address().port })}\n`));
const stop = () => {
  http.close();
  app.locals.db.close();
  if (ownDir) fs.rmSync(dataDir, { recursive: true, force: true });
  process.exit(0);
};
process.stdin.on('end', stop);
process.stdin.on('close', stop);
process.stdin.resume();
process.on('SIGTERM', stop);
