import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from './db.js';

const scrypt = promisify(crypto.scrypt);

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scrypt(password, salt, 64);
  return `scrypt:${salt}:${Buffer.from(derived).toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [algorithm, salt, expectedHex] = String(stored || '').split(':');
  if (algorithm !== 'scrypt' || !salt || !expectedHex) return false;
  const actual = Buffer.from(await scrypt(password, salt, 64));
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

export async function seedAdmin() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) throw new Error('ADMIN_EMAIL e ADMIN_PASSWORD são obrigatórios');
  const existing = await pool.query('SELECT id FROM users WHERE email=$1', [email]);
  if (existing.rowCount) return;
  const passwordHash = await hashPassword(password);
  await pool.query(`INSERT INTO users(email,password_hash,role,active)
    VALUES($1,$2,'admin',true)`, [email, passwordHash]);
}

export async function authenticate(email, password) {
  const result = await pool.query(`SELECT id,email,password_hash,role FROM users
    WHERE email=$1 AND active=true`, [String(email || '').trim().toLowerCase()]);
  const user = result.rows[0];
  if (!user || !(await verifyPassword(String(password || ''), user.password_hash))) return null;
  await pool.query('UPDATE users SET last_login_at=now() WHERE id=$1', [user.id]);
  return { id: user.id, email: user.email, role: user.role };
}

