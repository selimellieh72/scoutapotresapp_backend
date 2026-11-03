import { MongoClient } from 'mongodb';
import { loadConfig } from './config.js';
import { Database } from './db.js';
import { LocalMediaStore } from './storage/local.js';
import { createResetMailer } from './services/email.js';
import { createApp } from './app.js';

async function main() {
  const config = loadConfig();
  const client = new MongoClient(config.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  try {
    const db = new Database(client, config.MONGODB_DATABASE);
    await db.initialize();
    const app = createApp({ db, config, store: new LocalMediaStore(config.MEDIA_DIRECTORY), mailer: createResetMailer(config) });
    const server = app.listen(config.PORT, () => {
      console.info(JSON.stringify({ event: 'listening', port: config.PORT, emailConfigured: config.emailConfigured }));
    });
    server.on('error', () => { console.error(JSON.stringify({ event: 'listen_failed' })); void client.close().finally(() => process.exit(1)); });
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      const force = setTimeout(() => { server.closeAllConnections(); void client.close().finally(() => process.exit(1)); }, 10_000);
      force.unref();
      server.close(() => { void client.close().then(() => { clearTimeout(force); process.exit(0); }); });
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  } catch (error) { await client.close(); throw error; }
}

main().catch(() => {
  console.error(JSON.stringify({ event: 'startup_failed', message: 'Check environment configuration and replica-set availability.' }));
  process.exitCode = 1;
});
