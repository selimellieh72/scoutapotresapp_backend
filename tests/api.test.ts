import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { LocalMediaStore } from '../src/storage/local.js';
import { hashPassword } from '../src/services/crypto.js';
import type { Admin } from '../src/types.js';

const api = '/api/v1';
// These credentials exist only inside the disposable test database.
const password = 'test-only-password-123';
let repl: MongoMemoryReplSet;
let client: MongoClient;
let db: Database;
let directory: string;
let store: LocalMediaStore;
let app: ReturnType<typeof createApp>;
let admin: Admin;
let second: Admin;
let passwordHash: string;
let image: Buffer;
const delivered: { email: string; token: string }[] = [];

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
  client = await new MongoClient(repl.getUri()).connect();
  db = new Database(client, 'scoutapotres_test');
  directory = await mkdtemp(join(tmpdir(), 'scoutapotres-'));
  store = new LocalMediaStore(directory);
  passwordHash = await hashPassword(password);
  image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#245536' } }).png().toBuffer();
});

beforeEach(async () => {
  for (const collection of [db.admins, db.sessions, db.resets, db.group, db.posts, db.media, db.audit]) await collection.deleteMany({});
  await db.initialize();
  const now = new Date();
  admin = { _id: new ObjectId(), email: 'admin@example.test', username: 'admin', displayName: 'Test admin',
    passwordHash, role: 'admin', status: 'active', authVersion: 0, createdAt: now, updatedAt: now };
  second = { ...admin, _id: new ObjectId(), email: 'second@example.test', username: 'second', displayName: 'Second admin' };
  await db.admins.insertMany([admin, second]);
  delivered.length = 0;
  app = createApp({ db, config: loadConfig({ NODE_ENV: 'test' }), store, rateLimits: false,
    mailer: { async sendReset(email, token) { delivered.push({ email, token }); } } });
});

afterAll(async () => {
  await client?.close();
  await repl?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function login(identifier = 'admin') {
  const response = await request(app).post(`${api}/auth/login`).send({ identifier, password }).expect(200);
  return response.body.data as { accessToken: string; refreshToken: string; admin: { id: string } };
}
const bearer = (token: string) => `Bearer ${token}`;
async function publish(token: string, body: Record<string, unknown> = { category: 'article', text: 'A scout update' }) {
  return request(app).post(`${api}/posts`).set('Authorization', bearer(token)).send(body).expect(201);
}
async function upload(token: string) {
  return request(app).post(`${api}/media`).set('Authorization', bearer(token)).attach('file', image, 'photo.png').expect(201);
}

describe('public reading and authorization', () => {
  it('serves guest endpoints, health, and a single group without an account', async () => {
    await request(app).get('/health').expect(200, { status: 'ok' });
    await request(app).get('/ready').expect(200, { status: 'ready' });
    for (const endpoint of ['/posts', '/group', '/discover', '/app-info', '/search?q=scout']) {
      const response = await request(app).get(`${api}${endpoint}`).expect(200);
      expect(response.headers['x-powered-by']).toBeUndefined();
      expect(response.body).toHaveProperty('data');
    }
    expect(await db.group.countDocuments()).toBe(1);
  });

  it('blocks every protected mutation and account read for guests', async () => {
    const id = new ObjectId().toHexString();
    await request(app).post(`${api}/posts`).send({ category: 'article', text: 'No' }).expect(401);
    await request(app).patch(`${api}/posts/${id}`).send({ text: 'No' }).expect(401);
    await request(app).delete(`${api}/posts/${id}`).expect(401);
    await request(app).post(`${api}/media`).attach('file', image, 'photo.png').expect(401);
    await request(app).delete(`${api}/media/${id}`).expect(401);
    await request(app).get(`${api}/me`).expect(401);
    await request(app).get(`${api}/posts`).set('Authorization', 'Bearer invalid').expect(401);
  });

  it('does not expose signup, competition, or social-feature routes', async () => {
    for (const path of ['/auth/signup', '/auth/register', '/competitions', '/likes', '/comments', '/reposts', '/following', '/messages']) {
      await request(app).post(`${api}${path}`).send({}).expect(404);
    }
  });

  it('uses structured validation errors and rejects malformed JSON and protected fields', async () => {
    const token = (await login()).accessToken;
    const invalid = await request(app).post(`${api}/posts`).set('Authorization', bearer(token))
      .send({ category: 'invalid', text: 'test', createdByAdminId: admin._id.toHexString() }).expect(400);
    expect(invalid.body.error).toMatchObject({ code: 'VALIDATION_ERROR', requestId: expect.any(String) });
    await request(app).post(`${api}/auth/login`).set('Content-Type', 'application/json').send('{ broken').expect(400);
    await request(app).get(`${api}/posts/not-an-id`).expect(400);
    await request(app).get(`${api}/posts?limit=101`).expect(400);
    await request(app).get(`${api}/posts?cursor=garbage`).expect(400);
    await request(app).get(`${api}/search?q[$ne]=x`).expect(400);
  });

  it('rate-limits authentication with the same JSON error envelope', async () => {
    const limited = createApp({ db, config: loadConfig({ NODE_ENV: 'test' }), store,
      mailer: { async sendReset() {} } });
    for (let i = 0; i < 30; i++) {
      await request(limited).post(`${api}/auth/forgot-password`).send({ identifier: 'unknown' }).expect(200);
    }
    const blocked = await request(limited).post(`${api}/auth/forgot-password`).send({ identifier: 'unknown' }).expect(429);
    expect(blocked.body.error).toMatchObject({ code: 'RATE_LIMITED', requestId: expect.any(String) });
  });
});

describe('admin sessions and password recovery', () => {
  it('logs in with normalized identifiers and returns only safe account fields', async () => {
    const session = await login(' ADMIN@EXAMPLE.TEST ');
    expect(session.admin.id).toBe(admin._id.toHexString());
    expect(session.admin).not.toHaveProperty('passwordHash');
    const me = await request(app).get(`${api}/me`).set('Authorization', bearer(session.accessToken)).expect(200);
    expect(me.body.data.role).toBe('admin');
    const stored = await db.sessions.findOne({ adminId: admin._id });
    expect(stored?.accessTokenHash).not.toBe(session.accessToken);
    expect(stored?.refreshTokenHash).not.toBe(session.refreshToken);
    await request(app).post(`${api}/auth/login`).send({ identifier: 'missing', password }).expect(401);
    await request(app).post(`${api}/auth/login`).send({ identifier: 'admin', password: 'wrong' }).expect(401);
  });

  it('rotates refresh tokens and revokes the entire session on refresh replay', async () => {
    const initial = await login();
    const rotated = await request(app).post(`${api}/auth/refresh`).send({ refreshToken: initial.refreshToken }).expect(200);
    expect(rotated.body.data.refreshToken).not.toBe(initial.refreshToken);
    await request(app).get(`${api}/me`).set('Authorization', bearer(initial.accessToken)).expect(401);
    await request(app).get(`${api}/me`).set('Authorization', bearer(rotated.body.data.accessToken)).expect(200);
    await request(app).post(`${api}/auth/refresh`).send({ refreshToken: initial.refreshToken }).expect(401);
    await request(app).get(`${api}/me`).set('Authorization', bearer(rotated.body.data.accessToken)).expect(401);
  });

  it('allows only one successor during simultaneous refresh requests', async () => {
    const initial = await login();
    const responses = await Promise.all([1, 2].map(() => request(app).post(`${api}/auth/refresh`).send({ refreshToken: initial.refreshToken })));
    expect(responses.map(response => response.status).sort()).toEqual([200, 401]);
    const success = responses.find(response => response.status === 200)!;
    await request(app).get(`${api}/me`).set('Authorization', bearer(success.body.data.accessToken)).expect(401);
  });

  it('revokes access immediately on logout and accepts repeated logout', async () => {
    const initial = await login();
    await request(app).post(`${api}/auth/logout`).send({ refreshToken: initial.refreshToken }).expect(204);
    await request(app).post(`${api}/auth/logout`).send({ refreshToken: initial.refreshToken }).expect(204);
    await request(app).get(`${api}/me`).set('Authorization', bearer(initial.accessToken)).expect(401);
    await request(app).post(`${api}/auth/refresh`).send({ refreshToken: initial.refreshToken }).expect(401);
  });

  it('rejects expired tokens and disabled admins without relying on TTL cleanup', async () => {
    const initial = await login();
    await db.sessions.updateMany({}, { $set: { accessExpiresAt: new Date(0) } });
    await request(app).get(`${api}/me`).set('Authorization', bearer(initial.accessToken)).expect(401);
    const active = await login();
    await db.admins.updateOne({ _id: admin._id }, { $set: { status: 'disabled' } });
    await request(app).get(`${api}/me`).set('Authorization', bearer(active.accessToken)).expect(401);
    await request(app).post(`${api}/auth/refresh`).send({ refreshToken: initial.refreshToken }).expect(401);
    await request(app).post(`${api}/auth/login`).send({ identifier: 'admin', password }).expect(401);
  });

  it('resets a password once and revokes all old sessions and reset tokens', async () => {
    const initial = await login();
    const known = await request(app).post(`${api}/auth/forgot-password`).send({ identifier: 'admin' }).expect(200);
    const unknown = await request(app).post(`${api}/auth/forgot-password`).send({ identifier: 'missing' }).expect(200);
    expect(known.body).toEqual(unknown.body);
    expect(delivered).toHaveLength(1);
    const token = delivered[0]!.token;
    const stored = await db.resets.findOne({ adminId: admin._id });
    expect(stored?.tokenHash).not.toBe(token);
    const newPassword = 'new-test-only-password-456';
    await request(app).post(`${api}/auth/reset-password`).send({ token, password: newPassword }).expect(200);
    await request(app).post(`${api}/auth/reset-password`).send({ token, password: newPassword }).expect(400);
    await request(app).get(`${api}/me`).set('Authorization', bearer(initial.accessToken)).expect(401);
    await request(app).post(`${api}/auth/login`).send({ identifier: 'admin', password }).expect(401);
    await request(app).post(`${api}/auth/login`).send({ identifier: 'admin', password: newPassword }).expect(200);
  });

  it('rejects expired reset tokens and reports unconfigured email equally for every identifier', async () => {
    await request(app).post(`${api}/auth/forgot-password`).send({ identifier: 'admin' }).expect(200);
    await db.resets.updateMany({}, { $set: { expiresAt: new Date(0) } });
    await request(app).post(`${api}/auth/reset-password`).send({ token: delivered[0]!.token, password }).expect(400);
    const unconfigured = createApp({ db, config: loadConfig({ NODE_ENV: 'test' }), store, rateLimits: false });
    for (const identifier of ['admin', 'missing']) {
      await request(unconfigured).post(`${api}/auth/forgot-password`).send({ identifier }).expect(503);
    }
  });

  it('does not expose an account through slow SMTP response times', async () => {
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const slowMail = createApp({ db, config: loadConfig({ NODE_ENV: 'test' }), store, rateLimits: false,
      mailer: { sendReset: () => pending } });
    try {
      const known = await request(slowMail).post(`${api}/auth/forgot-password`).send({ identifier: 'admin' }).timeout({ response: 1000 }).expect(200);
      const unknown = await request(slowMail).post(`${api}/auth/forgot-password`).send({ identifier: 'missing' }).timeout({ response: 1000 }).expect(200);
      expect(known.body).toEqual(unknown.body);
    } finally { release(); }
  });
});

describe('posts, profile, search, and media', () => {
  it('publishes under the group identity; any active admin can edit and soft-delete', async () => {
    const token = (await login()).accessToken;
    const other = (await login('second')).accessToken;
    const created = await publish(token);
    const id = created.body.data.id;
    expect(created.body.data.group.name).toBe('Groupe Scout des Apôtres');
    expect(JSON.stringify(created.body)).not.toContain('admin@example.test');
    expect(created.body.data).not.toHaveProperty('createdByAdminId');
    const edited = await request(app).patch(`${api}/posts/${id}`).set('Authorization', bearer(other)).send({ text: 'Updated update' }).expect(200);
    expect(edited.body.data.publishedAt).toBe(created.body.data.publishedAt);
    await request(app).get(`${api}/posts/${id}`).expect(200);
    await request(app).delete(`${api}/posts/${id}`).set('Authorization', bearer(other)).expect(204);
    await request(app).get(`${api}/posts/${id}`).expect(404);
    expect((await request(app).get(`${api}/posts`).expect(200)).body.data).toEqual([]);
    expect((await request(app).get(`${api}/search?q=Updated`).expect(200)).body.data.posts).toEqual([]);
    expect(await db.audit.countDocuments()).toBe(3);
    expect((await db.posts.findOne({ _id: new ObjectId(id) }))?.deletedAt).toBeInstanceOf(Date);
  });

  it('rejects empty posts, invalid attachments, duplicate attachments, and empty-result edits', async () => {
    const token = (await login()).accessToken;
    await request(app).post(`${api}/posts`).set('Authorization', bearer(token)).send({ category: 'article', title: 'Only a title' }).expect(400);
    await request(app).post(`${api}/posts`).set('Authorization', bearer(token)).send({ category: 'article', mediaIds: [new ObjectId().toHexString()] }).expect(400);
    const asset = (await upload(token)).body.data.id;
    await request(app).post(`${api}/posts`).set('Authorization', bearer(token)).send({ category: 'article', mediaIds: [asset, asset.toUpperCase()] }).expect(400);
    const post = await publish(token);
    await request(app).patch(`${api}/posts/${post.body.data.id}`).set('Authorization', bearer(token)).send({ text: '' }).expect(400);
    expect(await db.posts.countDocuments()).toBe(1);
    expect((await db.media.findOne({ _id: new ObjectId(asset) }))?.referenceCount).toBe(0);
  });

  it('pages tied publication dates deterministically and rejects changed cursor filters', async () => {
    const token = (await login()).accessToken;
    for (let i = 0; i < 5; i++) await publish(token, { category: 'atelier', text: `Scout activity ${i}` });
    await db.posts.updateMany({}, { $set: { publishedAt: new Date('2026-01-01T12:00:00Z') } });
    let cursor: string | null = null;
    const seen: string[] = [];
    let firstCursor = '';
    do {
      const response: request.Response = await request(app).get(`${api}/posts`).query({ category: 'atelier', limit: 2, ...(cursor ? { cursor } : {}) }).expect(200);
      seen.push(...response.body.data.map((post: { id: string }) => post.id));
      cursor = response.body.page.nextCursor;
      if (!firstCursor && cursor) firstCursor = cursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    await request(app).get(`${api}/posts`).query({ category: 'jeux', cursor: firstCursor }).expect(400);
    expect((await request(app).get(`${api}/posts?category=jeux`).expect(200)).body.data).toEqual([]);
  });

  it('keeps uploads private and makes them public only while referenced', async () => {
    const token = (await login()).accessToken;
    const uploaded = await upload(token);
    const asset = uploaded.body.data;
    expect(asset).toMatchObject({ type: 'image', mimeType: 'image/webp', width: 8, height: 8, state: 'ready' });
    await request(app).get(`${api}/media/${asset.id}`).expect(404);
    await request(app).get(asset.url).expect(404);
    await request(app).head(asset.url).expect(404);
    await request(app).get(asset.url).set('Authorization', bearer(token)).expect(200);
    const first = (await publish(token, { category: 'installation', mediaIds: [asset.id] })).body.data.id;
    const secondPost = (await publish(token, { category: 'jeux', text: 'Photo scout', mediaIds: [asset.id] })).body.data.id;
    const publicFile = await request(app).get(asset.url).expect(200);
    expect(publicFile.headers['cross-origin-resource-policy']).toBe('cross-origin');
    await request(app).get(asset.url).set('Range', 'bytes=0-9').expect(206);
    const rangeError = await request(app).get(asset.url).set('Range', 'bytes=999999-').expect(416);
    expect(rangeError.body.error.code).toBe('INVALID_RANGE');
    await request(app).delete(`${api}/media/${asset.id}`).set('Authorization', bearer(token)).expect(409);
    await request(app).delete(`${api}/posts/${first}`).set('Authorization', bearer(token)).expect(204);
    await request(app).get(asset.url).expect(200);
    await request(app).delete(`${api}/posts/${secondPost}`).set('Authorization', bearer(token)).expect(204);
    await request(app).get(asset.url).expect(404);
    await request(app).delete(`${api}/media/${asset.id}`).set('Authorization', bearer(token)).expect(204);
    await request(app).get(asset.url).set('Authorization', bearer(token)).expect(404);
  });

  it('serves group metadata read-only even for an active admin', async () => {
    const token = (await login()).accessToken;
    const before = await request(app).get(`${api}/group`).expect(200);
    const patch = { name: 'Changed name', description: 'Changed description', logoMediaId: null, coverMediaId: null };
    await request(app).patch(`${api}/group`).send(patch).expect(404);
    await request(app).patch(`${api}/group`).set('Authorization', bearer(token)).send(patch).expect(404);
    await request(app).get(`${api}/group`).expect(200, before.body);
  });

  it('verifies MP4 metadata and publishes mixed media', async () => {
    const token = (await login()).accessToken;
    const videoFile = await readFile(new URL('./fixtures/green.mp4', import.meta.url));
    const video = (await request(app).post(`${api}/media`).set('Authorization', bearer(token))
      .attach('file', videoFile, 'green.mp4').expect(201)).body.data;
    expect(video).toMatchObject({ type: 'video', mimeType: 'video/mp4', width: 16, height: 16, durationSeconds: 1, state: 'ready' });
    await request(app).get(video.url).expect(404);
    expect((await db.media.findOne({ _id: new ObjectId(video.id) }))?.referenceCount).toBe(0);
    const photo = (await upload(token)).body.data;
    const post = await publish(token, { category: 'atelier', text: 'Mixed activity', mediaIds: [video.id, photo.id] });
    expect(post.body.data.media.map((asset: { type: string }) => asset.type)).toEqual(['video', 'image']);
    for (const contentType of ['video', 'image']) {
      expect((await request(app).get(`${api}/posts`).query({ contentType }).expect(200)).body.data).toHaveLength(1);
    }
    await request(app).get(video.url).set('Range', 'bytes=0-99').expect(206);
    await request(app).post(`${api}/media`).set('Authorization', bearer(token))
      .attach('file', videoFile.subarray(0, 32), 'corrupted.mp4').expect(415);
  });

  it('filters category/content, searches literal text, and does not interpret regular expressions', async () => {
    const token = (await login()).accessToken;
    const asset = (await upload(token)).body.data.id;
    await publish(token, { category: 'article', text: 'A literal .* scout phrase' });
    await publish(token, { category: 'jeux', text: 'Other activity', mediaIds: [asset] });
    const images = await request(app).get(`${api}/posts?contentType=image&category=jeux`).expect(200);
    expect(images.body.data).toHaveLength(1);
    expect((await request(app).get(`${api}/posts?contentType=text`).expect(200)).body.data).toHaveLength(1);
    const literal = await request(app).get(`${api}/search`).query({ q: '.*' }).expect(200);
    expect(literal.body.data.posts).toHaveLength(1);
    expect((await request(app).get(`${api}/discover`).expect(200)).body.data.posts).toHaveLength(2);
  });

  it('rejects file spoofing and attachment/deletion races cannot create dangling media', async () => {
    const token = (await login()).accessToken;
    await request(app).post(`${api}/media`).set('Authorization', bearer(token)).attach('file', Buffer.from('not an image'), { filename: 'photo.png', contentType: 'image/png' }).expect(415);
    const asset = (await upload(token)).body.data.id;
    const [post, deletion] = await Promise.all([
      request(app).post(`${api}/posts`).set('Authorization', bearer(token)).send({ category: 'article', mediaIds: [asset] }),
      request(app).delete(`${api}/media/${asset}`).set('Authorization', bearer(token)),
    ]);
    if (post.status === 201) {
      expect(deletion.status).toBe(409);
      expect((await db.media.findOne({ _id: new ObjectId(asset) }))?.referenceCount).toBe(1);
    } else {
      expect([400, 409]).toContain(post.status);
      expect(deletion.status).toBe(204);
      expect(await db.posts.countDocuments()).toBe(0);
    }
  });

  it('enforces identifier and singleton uniqueness in MongoDB', async () => {
    await expect(db.admins.insertOne({ ...admin, _id: new ObjectId() })).rejects.toMatchObject({ code: 11000 });
    const group = (await db.group.findOne({ singletonKey: 'main' }))!;
    await expect(db.group.insertOne({ ...group, _id: new ObjectId() })).rejects.toMatchObject({ code: 11000 });
    const noUsername = { ...admin, _id: new ObjectId(), email: 'third@example.test' };
    delete noUsername.username;
    await db.admins.insertOne(noUsername);
    await db.admins.insertOne({ ...noUsername, _id: new ObjectId(), email: 'fourth@example.test' });
    const simultaneous = await Promise.allSettled([1, 2].map(() => db.admins.insertOne({ ...noUsername, _id: new ObjectId(), email: 'duplicate@example.test' })));
    expect(simultaneous.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(simultaneous.filter(result => result.status === 'rejected')).toHaveLength(1);
    await db.group.deleteMany({});
    await Promise.all([db.initialize(), db.initialize()]);
    expect(await db.group.countDocuments()).toBe(1);
  });
});
