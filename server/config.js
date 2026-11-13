import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`\n✖ Missing ${name} in .env — run "npm run setup" first.\n`);
    process.exit(1);
  }
  return v;
}

export const config = {
  root,
  publicDir: path.join(root, 'public'),
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '0.0.0.0',
  dataDir: path.resolve(root, process.env.DATA_DIR || 'data'),
  masterKey: required('MASTER_KEY'),
  sessionSecret: required('SESSION_SECRET'),
  adminUser: required('ADMIN_USER').toLowerCase(),
  adminPassHash: required('ADMIN_PASS_HASH'),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  printMode: process.env.PRINT_MODE === 'simulate' ? 'simulate' : 'auto',
  fileRetentionHours: Math.max(1, Number(process.env.FILE_RETENTION_HOURS || 72)),
  piiRetentionDays: Math.max(1, Number(process.env.PII_RETENTION_DAYS || 90)),
  // Firebase Authentication (customer sign-in). These web-config values are public by design.
  firebase: {
    apiKey: process.env.FIREBASE_API_KEY || '',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || '',
    projectId: process.env.FIREBASE_PROJECT_ID || '',
    appId: process.env.FIREBASE_APP_ID || '',
  },
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chatId: process.env.TELEGRAM_CHAT_ID || '',
  },
};
