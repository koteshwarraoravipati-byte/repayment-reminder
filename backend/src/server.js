import 'dotenv/config';
import { createDb } from './db.js';
import { createApp } from './app.js';
import { startReminderScheduler } from './services/scheduler.js';

const PORT = Number(process.env.PORT || 4000);

async function main() {
  const db = createDb();
  await db.init();

  const settings = await db.queryOne('SELECT daily_cron FROM reminder_settings WHERE id = $1', [1]);
  const scheduler = startReminderScheduler(db, settings?.daily_cron || process.env.REMINDER_CRON || '0 9 * * *');

  const app = createApp(db, {
    onCronChange: (expr) => scheduler.reschedule(expr),
  });

  const server = app.listen(PORT, '127.0.0.1', () => {
    console.log(`Debt Repayment AI Assistant API running at http://127.0.0.1:${PORT} (${db.dialect})`);
  });

  const shutdown = async () => {
    scheduler.stop();
    server.close();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('Failed to start backend server:', err);
  process.exit(1);
});
