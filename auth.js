import { Router } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { db, getBusiness } from '../db/index.js';

export const authRouter = Router();

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

authRouter.post('/login', (req, res) => {
  const { email, password } = req.body;
  const business = getBusiness();
  if (!business || business.owner_email !== email) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const [salt, hash] = business.owner_password_hash.split(':');
  if (hashPassword(password, salt) !== hash) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const token = jwt.sign({ businessId: business.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, business: { name: business.name, email: business.owner_email } });
});

export function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.replace('Bearer ', '');
  try {
    req.auth = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Unauthorized' });
  }
}

export function hashForStorage(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return `${salt}:${hashPassword(password, salt)}`;
}
