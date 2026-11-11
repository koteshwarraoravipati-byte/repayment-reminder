import 'dotenv/config';
import { createDb } from '../src/db.js';
import { createApp } from '../src/app.js';

let appPromise = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const db = createDb();
      await db.init();
      return createApp(db);
    })().catch((err) => {
      appPromise = null;
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(req, res) {
  const app = await getApp();
  return app(req, res);
}
