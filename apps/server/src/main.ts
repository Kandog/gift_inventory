import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp, lanAddresses } from './app.js';
import { scheduleBackups } from './backup.js';
import { openDb } from './db.js';
import { ensureDefaultLocation } from './store.js';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.GIFTS_PORT ?? 8080);
const dataDir = resolve(process.env.GIFTS_DATA_DIR ?? join(here, '../../../data'));
const dashboardDir = resolve(process.env.GIFTS_DASHBOARD_DIR ?? join(here, '../../dashboard/dist'));

mkdirSync(dataDir, { recursive: true });
const db = openDb(join(dataDir, 'gifts.db'));
ensureDefaultLocation(db);

const app = await buildApp({ db, dataDir, port, dashboardDir, logger: true });
await app.listen({ host: '0.0.0.0', port });
scheduleBackups(db, join(dataDir, 'photos'), (msg) => app.log.info(msg));

app.log.info(`Data folder: ${dataDir}`);
for (const ip of lanAddresses()) app.log.info(`Dashboard: http://${ip}:${port}`);

const shutdown = async () => {
  await app.close();
  db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
