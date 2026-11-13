import express from 'express';
import helmet from 'helmet';
import multer from 'multer';
import path from 'node:path';
import { config } from './config.js';
import './db.js';
import publicRoutes from './routes/public.js';
import adminRoutes from './routes/admin.js';
import meRoutes from './routes/me.js';
import { attachCustomer } from './customers.js';
import { startWorker } from './printer.js';
import { startMaintenance } from './maintenance.js';

const app = express();
app.disable('x-powered-by');
// Requests arriving from a local tunnel (cloudflared) carry the real client IP in X-Forwarded-For.
app.set('trust proxy', 'loopback');

// Firebase Authentication needs its SDK (gstatic), its token APIs, and the sign-in popup/iframe.
const fbAuthDomain = config.firebase.authDomain ? [`https://${config.firebase.authDomain}`] : [];
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'", 'https://www.gstatic.com', 'https://apis.google.com'],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'", 'https://identitytoolkit.googleapis.com', 'https://securetoken.googleapis.com', 'https://www.googleapis.com'],
      'frame-src': [...fbAuthDomain, 'https://accounts.google.com', 'https://apis.google.com'],
      'form-action': ["'self'"],
      'frame-ancestors': ["'none'"],
      'upgrade-insecure-requests': null, // allow plain-http use on the shop Wi-Fi
    },
  },
  crossOriginEmbedderPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }, // Google sign-in popup
}));

app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '64kb' }));
app.use('/api/admin', adminRoutes);
app.use('/api', attachCustomer);
app.use('/api/me', meRoutes);
app.use('/api', publicRoutes);
app.use('/api', (req, res) => res.status(404).json({ error: { code: 'not_found', message: 'Not found' } }));

app.use('/admin', (req, res, next) => {
  res.set('X-Robots-Tag', 'noindex, nofollow');
  next();
});
app.use(express.static(config.publicDir, {
  extensions: ['html'],
  setHeaders: (res, p) => {
    if (p.endsWith('.html')) res.set('Cache-Control', 'no-cache');
  },
}));
app.use((req, res) => res.status(404).sendFile(path.join(config.publicDir, 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const code = err.code === 'LIMIT_FILE_SIZE' ? 'file_too_big' : err.code === 'LIMIT_FILE_COUNT' ? 'too_many_files' : 'upload_error';
    return res.status(400).json({ error: { code, message: err.message } });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ error: { code: 'bad_request', message: 'Bad request' } });
  }
  if (err.status && err.code) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...err.extra } });
  }
  console.error(err);
  res.status(500).json({ error: { code: 'server_error', message: 'Something went wrong. Please try again.' } });
});

startWorker();
startMaintenance();

app.listen(config.port, config.host, () => {
  console.log(`\n  e-Mitra Print Studio running`);
  console.log(`   Customers: http://localhost:${config.port}/`);
  console.log(`   Owner:     http://localhost:${config.port}/admin/`);
  console.log(`   Print mode: ${config.printMode}${config.publicUrl ? `\n   Public URL: ${config.publicUrl}` : ''}\n`);
});
