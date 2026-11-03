import type { RequestHandler } from 'express';
import { ObjectId } from 'mongodb';
import type { Database } from '../db.js';
import type { Admin, Session } from '../types.js';
import { HttpError, unauthorized } from '../http.js';
import { digest, hashPassword, secret, verifyPassword } from './crypto.js';
import type { ResetMailer } from './email.js';

const ACCESS_MS = 15 * 60_000;
const SESSION_MS = 30 * 24 * 60 * 60_000;
const RESET_MS = 30 * 60_000;
export const adminDto = (admin: Admin) => ({ id: admin._id.toHexString(), email: admin.email,
  username: admin.username ?? null, displayName: admin.displayName, role: admin.role, status: admin.status });

function parseToken(token: string) {
  const match = /^([a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!match) throw unauthorized();
  return { sessionId: new ObjectId(match[1]), hash: digest(token) };
}

export class AuthService {
  private readonly dummyPassword = hashPassword(secret());
  constructor(private readonly db: Database, private readonly mailer?: ResetMailer) {}

  private tokenPair(id: ObjectId) {
    return { accessToken: `${id.toHexString()}.${secret()}`, refreshToken: `${id.toHexString()}.${secret()}` };
  }

  async login(identifier: string, password: string) {
    const normalized = identifier.trim().toLowerCase();
    const filter = normalized.includes('@') ? { email: normalized } : { username: normalized };
    const admin = await this.db.admins.findOne(filter);
    const valid = await verifyPassword(password, admin?.passwordHash ?? await this.dummyPassword);
    if (!valid || !admin || admin.status !== 'active' || admin.role !== 'admin') throw unauthorized();
    const now = new Date();
    const id = new ObjectId();
    const pair = this.tokenPair(id);
    const session: Session = {
      _id: id, adminId: admin._id, authVersion: admin.authVersion,
      accessTokenHash: digest(pair.accessToken), accessExpiresAt: new Date(now.getTime() + ACCESS_MS),
      refreshTokenHash: digest(pair.refreshToken), usedRefreshTokenHashes: [],
      expiresAt: new Date(now.getTime() + SESSION_MS), revokedAt: null, createdAt: now, updatedAt: now,
    };
    await this.db.sessions.insertOne(session);
    return { ...pair, accessExpiresAt: session.accessExpiresAt, sessionExpiresAt: session.expiresAt, admin: adminDto(admin) };
  }

  async authenticate(token: string) {
    const parsed = parseToken(token);
    const now = new Date();
    const session = await this.db.sessions.findOne({ _id: parsed.sessionId, accessTokenHash: parsed.hash,
      accessExpiresAt: { $gt: now }, expiresAt: { $gt: now }, revokedAt: null });
    if (!session) throw unauthorized();
    const admin = await this.db.admins.findOne({ _id: session.adminId, status: 'active', role: 'admin', authVersion: session.authVersion });
    if (!admin) throw unauthorized();
    return { admin, session };
  }

  async refresh(token: string) {
    const parsed = parseToken(token);
    const now = new Date();
    const existing = await this.db.sessions.findOne({ _id: parsed.sessionId, expiresAt: { $gt: now }, revokedAt: null });
    if (!existing) throw unauthorized();
    const admin = await this.db.admins.findOne({ _id: existing.adminId, status: 'active', role: 'admin', authVersion: existing.authVersion });
    if (!admin) throw unauthorized();
    const pair = this.tokenPair(existing._id);
    const rotated = await this.db.sessions.findOneAndUpdate({ _id: existing._id, refreshTokenHash: parsed.hash,
      revokedAt: null, expiresAt: { $gt: now }, 'usedRefreshTokenHashes.4999': { $exists: false } }, {
      $set: { accessTokenHash: digest(pair.accessToken), refreshTokenHash: digest(pair.refreshToken),
        accessExpiresAt: new Date(Math.min(now.getTime() + ACCESS_MS, existing.expiresAt.getTime())), updatedAt: now },
      $push: { usedRefreshTokenHashes: parsed.hash },
    }, { returnDocument: 'after' });
    if (!rotated) {
      // Atomic compare-and-swap makes simultaneous refreshes single-use as well.
      await this.db.sessions.updateOne({ _id: existing._id, $or: [
        { usedRefreshTokenHashes: parsed.hash },
        { refreshTokenHash: parsed.hash, 'usedRefreshTokenHashes.4999': { $exists: true } },
      ] }, { $set: { revokedAt: now, updatedAt: now } });
      throw unauthorized();
    }
    return { ...pair, accessExpiresAt: rotated.accessExpiresAt, sessionExpiresAt: rotated.expiresAt, admin: adminDto(admin) };
  }

  async logout(token: string) {
    const parsed = parseToken(token);
    const now = new Date();
    await this.db.sessions.updateOne({ _id: parsed.sessionId, $or: [
      { refreshTokenHash: parsed.hash }, { usedRefreshTokenHashes: parsed.hash },
    ] }, { $set: { revokedAt: now, updatedAt: now } });
  }

  async forgotPassword(identifier: string) {
    if (!this.mailer) throw new HttpError(503, 'EMAIL_UNAVAILABLE', 'Password recovery is not configured.');
    const normalized = identifier.trim().toLowerCase();
    const admin = await this.db.admins.findOne({ ...(normalized.includes('@') ? { email: normalized } : { username: normalized }), status: 'active' });
    if (!admin) return;
    const token = secret();
    const now = new Date();
    await this.db.resets.insertOne({ _id: new ObjectId(), adminId: admin._id, tokenHash: digest(token),
      expiresAt: new Date(now.getTime() + RESET_MS), consumedAt: null, createdAt: now, updatedAt: now });
    // SMTP latency must not reveal whether the identifier exists. Delivery is
    // best-effort in-process; a durable mail queue is a future deployment choice.
    void this.mailer.sendReset(admin.email, token).catch(() => {
      console.error(JSON.stringify({ event: 'reset_delivery_failed' }));
    });
  }

  async resetPassword(token: string, password: string) {
    const passwordHash = await hashPassword(password);
    await this.db.transaction(async session => {
      const now = new Date();
      const reset = await this.db.resets.findOneAndUpdate({ tokenHash: digest(token), consumedAt: null, expiresAt: { $gt: now } },
        { $set: { consumedAt: now, updatedAt: now } }, { session });
      if (!reset) throw new HttpError(400, 'INVALID_RESET_TOKEN', 'Reset token is invalid or expired.');
      const updated = await this.db.admins.updateOne({ _id: reset.adminId, status: 'active' },
        { $set: { passwordHash, updatedAt: now }, $inc: { authVersion: 1 } }, { session });
      if (!updated.matchedCount) throw new HttpError(400, 'INVALID_RESET_TOKEN', 'Reset token is invalid or expired.');
      await this.db.sessions.updateMany({ adminId: reset.adminId }, { $set: { revokedAt: now, updatedAt: now } }, { session });
      await this.db.resets.updateMany({ adminId: reset.adminId, consumedAt: null }, { $set: { consumedAt: now, updatedAt: now } }, { session });
    });
  }

  optionalAuthentication: RequestHandler = async (req, res, next) => {
    if (req.headers.authorization !== undefined) {
      const match = /^Bearer (\S+)$/.exec(req.headers.authorization);
      if (!match?.[1]) throw unauthorized();
      res.locals.auth = await this.authenticate(match[1]);
    }
    next();
  };
}

export const requireAdmin: RequestHandler = (_req, res, next) => {
  if (!res.locals.auth) throw unauthorized();
  next();
};
