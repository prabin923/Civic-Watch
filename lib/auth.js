import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const sessionCookie = 'civicwatch_session';
const sessionDays = 7;

function digest(value) { return createHash('sha256').update(value).digest('hex'); }

export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}

export function verifyPassword(password, encoded) {
  const [, salt, expected] = String(encoded || '').split(':');
  if (!salt || !expected) return false;
  const actual = scryptSync(password, salt, 64);
  const target = Buffer.from(expected, 'hex');
  return target.length === actual.length && timingSafeEqual(actual, target);
}

export function publicUser(user) { return { id: user.id, email: user.email, displayName: user.displayName, role: user.role, status: user.status }; }

export async function ensureDemoUser(client) {
  const existing = await client.user.findUnique({ where: { email: 'admin@civicwatch.local' } });
  if (existing) return existing;
  return client.user.create({ data: { id: 'user_demo_admin', email: 'admin@civicwatch.local', displayName: 'Asha Shrestha', passwordHash: hashPassword('CivicWatchDemo!2026', 'civicwatch-demo-salt'), role: 'administrator' } });
}

export function readCookie(headers = {}, name) {
  const source = headers.cookie || '';
  const match = source.split(';').map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

export async function sessionUser(client, headers = {}) {
  const token = readCookie(headers, sessionCookie);
  if (!token) return null;
  const session = await client.session.findUnique({ where: { tokenHash: digest(token) }, include: { user: true } });
  if (!session || session.expiresAt <= new Date() || session.user.status !== 'active') return null;
  await client.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date() } });
  return session.user;
}

export async function createSession(client, userId) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionDays * 24 * 60 * 60 * 1000);
  await client.session.create({ data: { id: `session_${randomBytes(12).toString('hex')}`, tokenHash: digest(token), userId, expiresAt } });
  return { token, expiresAt };
}

export async function deleteSession(client, headers = {}) {
  const token = readCookie(headers, sessionCookie);
  if (token) await client.session.deleteMany({ where: { tokenHash: digest(token) } });
}

export function sessionCookieHeader(token, expiresAt) { return `${sessionCookie}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000))}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
export function clearSessionCookie() { return `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`; }
