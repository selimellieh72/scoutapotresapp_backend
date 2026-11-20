import { randomBytes } from 'node:crypto';
import { ObjectId } from 'mongodb';
import { Router } from 'express';
import { z } from 'zod';
import type { Database } from '../db.js';
import { HttpError, objectId } from '../http.js';
import { adminDto, requireAdmin } from '../services/auth.js';
import { hashPassword } from '../services/crypto.js';

const username = z.string().trim().toLowerCase().min(3).max(60)
  .regex(/^[a-z0-9._-]+$/, 'Use letters, numbers, dots, underscores, or dashes.');
const email = z.email().transform(value => value.trim().toLowerCase());
const password = z.string().min(12).max(256);
const createInput = z.object({ email, username: username.optional(), displayName: z.string().trim().min(2).max(120),
  password: password.optional() }).strict();
const updateInput = z.object({ email: email.optional(), username: username.nullable().optional(),
  displayName: z.string().trim().min(2).max(120).optional(), status: z.enum(['active', 'disabled']).optional(),
  password: password.optional() }).strict().refine(body => Object.keys(body).length > 0, 'Provide at least one field.');

async function writeAudit(db: Database, actorAdminId: ObjectId, action: string, targetId: ObjectId, requestId: string) {
  await db.audit.insertOne({ _id: new ObjectId(), actorAdminId, action, targetType: 'admin' as never, targetId,
    requestId, timestamp: new Date() });
}

export function opsRouter(db: Database) {
  const router = Router();
  router.use(requireAdmin);

  router.get('/overview', async (_req, res) => {
    const [admins, activeAdmins, sessions, posts, media, auditEvents] = await Promise.all([
      db.admins.countDocuments(), db.admins.countDocuments({ status: 'active' }),
      db.sessions.countDocuments({ revokedAt: null, expiresAt: { $gt: new Date() } }),
      db.posts.countDocuments({ deletedAt: null }), db.media.countDocuments({ state: 'ready' }),
      db.audit.countDocuments(),
    ]);
    res.json({ data: { admins, activeAdmins, activeSessions: sessions, posts, media, auditEvents,
      database: 'connected', updatedAt: new Date() } });
  });

  router.get('/activity', async (req, res) => {
    const limit = z.coerce.number().int().min(1).max(100).default(40).parse(req.query.limit);
    const events = await db.audit.find().sort({ timestamp: -1 }).limit(limit).toArray();
    const actorIds = [...new Map(events.map(event => [event.actorAdminId.toHexString(), event.actorAdminId])).values()];
    const actors = await db.admins.find({ _id: { $in: actorIds } }).project({ displayName: 1, email: 1 }).toArray();
    const actorMap = new Map(actors.map(actor => [actor._id.toHexString(), actor.displayName || actor.email]));
    res.json({ data: events.map(event => ({ id: event._id.toHexString(), action: event.action,
      targetType: event.targetType, targetId: event.targetId.toHexString(), actorAdminId: event.actorAdminId.toHexString(),
      actorName: actorMap.get(event.actorAdminId.toHexString()) ?? 'Former admin', timestamp: event.timestamp })) });
  });

  router.get('/admins', async (_req, res) => {
    const admins = await db.admins.find().sort({ displayName: 1, email: 1 }).toArray();
    res.json({ data: admins.map(adminDto) });
  });

  router.post('/admins', async (req, res) => {
    const input = createInput.parse(req.body);
    const initialPassword = input.password ?? randomBytes(18).toString('base64url');
    const now = new Date();
    const admin = { _id: new ObjectId(), email: input.email, ...(input.username ? { username: input.username } : {}),
      displayName: input.displayName, passwordHash: await hashPassword(initialPassword), status: 'active' as const,
      role: 'admin' as const, authVersion: 0, createdAt: now, updatedAt: now };
    await db.admins.insertOne(admin);
    await writeAudit(db, res.locals.auth.admin._id, 'admin.created', admin._id, res.locals.requestId);
    res.status(201).json({ data: { ...adminDto(admin), initialPassword } });
  });

  router.patch('/admins/:adminId', async (req, res) => {
    const id = objectId(req.params.adminId);
    const input = updateInput.parse(req.body);
    if (id.equals(res.locals.auth.admin._id) && input.status === 'disabled') {
      throw new HttpError(409, 'SELF_DISABLE', 'You cannot disable the account you are currently using.');
    }
    const existing = await db.admins.findOne({ _id: id });
    if (!existing) throw new HttpError(404, 'NOT_FOUND', 'Admin not found.');
    if (input.status === 'disabled' && existing.status === 'active' && await db.admins.countDocuments({ status: 'active' }) <= 1) {
      throw new HttpError(409, 'LAST_ADMIN', 'At least one active admin must remain.');
    }
    const passwordHash = input.password ? await hashPassword(input.password) : undefined;
    const securityChanged = Boolean(passwordHash || input.status === 'disabled');
    await db.admins.updateOne({ _id: id }, { $set: { ...(input.email ? { email: input.email } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.displayName ? { displayName: input.displayName } : {}), ...(input.status ? { status: input.status } : {}),
      ...(passwordHash ? { passwordHash } : {}), updatedAt: new Date() },
      ...(input.username === null ? { $unset: { username: '' } } : {}),
      ...(securityChanged ? { $inc: { authVersion: 1 } } : {}) });
    if (securityChanged) await db.sessions.updateMany({ adminId: id, revokedAt: null }, { $set: { revokedAt: new Date(), updatedAt: new Date() } });
    await writeAudit(db, res.locals.auth.admin._id, 'admin.updated', id, res.locals.requestId);
    const updated = await db.admins.findOne({ _id: id });
    res.json({ data: adminDto(updated!) });
  });

  router.delete('/admins/:adminId', async (req, res) => {
    const id = objectId(req.params.adminId);
    if (id.equals(res.locals.auth.admin._id)) throw new HttpError(409, 'SELF_DELETE', 'You cannot delete the account you are currently using.');
    if (await db.admins.countDocuments({ status: 'active' }) <= 1) throw new HttpError(409, 'LAST_ADMIN', 'At least one active admin must remain.');
    const deleted = await db.admins.findOneAndDelete({ _id: id });
    if (!deleted) throw new HttpError(404, 'NOT_FOUND', 'Admin not found.');
    await Promise.all([db.sessions.deleteMany({ adminId: id }), db.resets.deleteMany({ adminId: id })]);
    await writeAudit(db, res.locals.auth.admin._id, 'admin.deleted', id, res.locals.requestId);
    res.status(204).end();
  });

  return router;
}
