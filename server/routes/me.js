// Customer account endpoints: saved details, preferences, order history.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { audit } from '../db.js';
import { requireCustomer, getProfile, saveProfile, mergeGuest, deleteCustomer, verifyIdToken } from '../customers.js';
import { customerOrders } from '../orders.js';
import { HttpError, asyncH } from '../util.js';

const r = Router();
r.use(rateLimit({
  windowMs: 5 * 60e3, limit: 200, standardHeaders: 'draft-7', legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ error: { code: 'rate_limited', message: 'Too many requests' } }),
}));

// Signed-out visitors get { user: null } rather than an error, to keep the browser console clean.
r.get('/', (req, res) => {
  if (!req.customer) return res.json({ user: null });
  const c = req.customer;
  const profile = getProfile(c.uid);
  if (!profile.email && c.email) profile.email = c.email;
  if (!profile.name && c.name) profile.name = c.name;
  res.json({ user: { uid: c.uid, provider: c.provider, isAnonymous: c.isAnonymous }, profile });
});

r.put('/', requireCustomer, (req, res) => {
  res.json({ profile: saveProfile(req.customer.uid, req.body || {}) });
});

r.get('/orders', requireCustomer, (req, res) => res.json(customerOrders(req.customer.uid)));

r.post('/merge', requireCustomer, asyncH(async (req, res) => {
  let guest;
  try {
    guest = await verifyIdToken(req.body?.guestToken);
  } catch {
    throw new HttpError(400, 'bad_guest', 'Guest session could not be verified');
  }
  if (!guest.isAnonymous) throw new HttpError(400, 'bad_guest', 'Only guest sessions can be merged');
  mergeGuest(guest.uid, req.customer.uid);
  audit('customer', 'guest_merged');
  res.json({ ok: true });
}));

r.delete('/', requireCustomer, (req, res) => {
  deleteCustomer(req.customer.uid);
  audit('customer', 'account_deleted');
  res.json({ ok: true });
});

export default r;
