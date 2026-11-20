import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MongoClient, ObjectId } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { Database } from '../src/db.js';
import { LocalMediaStore } from '../src/storage/local.js';
import { hashPassword } from '../src/services/crypto.js';
import type { GroupAccount } from '../src/types.js';

const api = '/api/v1';
const password = 'test-only-password-123';
let repl: MongoMemoryReplSet;
let client: MongoClient;
let db: Database;
let directory: string;
let app: ReturnType<typeof createApp>;
let first: GroupAccount;
let second: GroupAccount;
let image: Buffer;
const delivered: { email: string; token: string }[] = [];

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ binary: { version: '8.0.17' }, replSet: { count: 1, storageEngine: 'wiredTiger' } });
  client = await new MongoClient(repl.getUri()).connect();
  db = new Database(client, 'scoutapotres_test');
  directory = join(await mkdtemp(join(tmpdir(), 'scoutapotres-')), '.media');
  image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#245536' } }).png().toBuffer();
});

beforeEach(async () => {
  for (const collection of [db.groups, db.sessions, db.resets, db.posts, db.media, db.audit]) await collection.deleteMany({});
  await db.initialize();
  const now = new Date();
  const passwordHash = await hashPassword(password);
  first = { _id: new ObjectId(), email: 'cedres@example.test', username: 'groupe_cedres', name: 'Groupe des Cèdres',
    description: 'Mountain and service', logoMediaId: null, coverMediaId: null, passwordHash,
    status: 'active', authVersion: 0, createdAt: now, updatedAt: now };
  second = { ...first, _id: new ObjectId(), email: 'maron@example.test', username: 'groupe_maron',
    name: 'Groupe Saint-Maron', description: 'Grandir ensemble' };
  await db.groups.insertMany([first, second]);
  delivered.length = 0;
  app = createApp({ db, config: loadConfig({ NODE_ENV: 'test' }), store: new LocalMediaStore(directory), rateLimits: false,
    mailer: { async sendReset(email, token) { delivered.push({ email, token }); } } });
});

afterAll(async () => {
  await client?.close();
  await repl?.stop();
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function login(identifier = first.username) {
  const response = await request(app).post(`${api}/auth/login`).send({ identifier, password }).expect(200);
  return response.body.data as { accessToken: string; refreshToken: string; group: { id: string; username: string } };
}
const bearer = (token: string) => `Bearer ${token}`;
const publish = (token: string, body: Record<string, unknown> = { category: 'article', text: 'A scout update' }) =>
  request(app).post(`${api}/posts`).set('Authorization', bearer(token)).send(body).expect(201);
const upload = (token: string) => request(app).post(`${api}/media`).set('Authorization', bearer(token)).attach('file', image, 'photo.png').expect(201);

describe('seeded group accounts and global public content', () => {
  it('lists every active group and starts with one empty global feed', async () => {
    const groups = await request(app).get(`${api}/groups`).expect(200);
    expect(groups.body.data.map((group: { name: string }) => group.name)).toEqual(['Groupe Saint-Maron', 'Groupe des Cèdres']);
    await request(app).get(`${api}/groups/${first._id}`).expect(200);
    expect((await request(app).get(`${api}/posts`).expect(200)).body.data).toEqual([]);
    expect(await db.groups.countDocuments()).toBe(2);
  });

  it('logs in as the group itself and stores only hashed session tokens', async () => {
    const session = await login(' GROUPE_CEDRES ');
    expect(session.group).toMatchObject({ id: first._id.toHexString(), username: first.username });
    expect(JSON.stringify(session)).not.toContain('passwordHash');
    const me = await request(app).get(`${api}/me`).set('Authorization', bearer(session.accessToken)).expect(200);
    expect(me.body.data.name).toBe(first.name);
    const stored = await db.sessions.findOne({ groupId: first._id });
    expect(stored?.accessTokenHash).not.toBe(session.accessToken);
    expect(stored?.refreshTokenHash).not.toBe(session.refreshToken);
  });

  it('publishes every group into the same feed while keeping management private to its owner', async () => {
    const firstSession = await login();
    const secondSession = await login(second.username);
    const firstPost = await publish(firstSession.accessToken, { category: 'article', text: 'From Cèdres' });
    const secondPost = await publish(secondSession.accessToken, { category: 'jeux', text: 'From Saint-Maron' });

    const publicFeed = await request(app).get(`${api}/posts`).expect(200);
    expect(publicFeed.body.data).toHaveLength(2);
    expect(new Set(publicFeed.body.data.map((post: { group: { id: string } }) => post.group.id)))
      .toEqual(new Set([first._id.toHexString(), second._id.toHexString()]));

    const own = await request(app).get(`${api}/me/posts`).set('Authorization', bearer(firstSession.accessToken)).expect(200);
    expect(own.body.data.map((post: { id: string }) => post.id)).toEqual([firstPost.body.data.id]);

    await request(app).patch(`${api}/posts/${secondPost.body.data.id}`).set('Authorization', bearer(firstSession.accessToken))
      .send({ text: 'Not mine' }).expect(404);
    await request(app).delete(`${api}/posts/${secondPost.body.data.id}`).set('Authorization', bearer(firstSession.accessToken)).expect(404);
    await request(app).patch(`${api}/posts/${firstPost.body.data.id}`).set('Authorization', bearer(firstSession.accessToken))
      .send({ text: 'Updated by owner' }).expect(200);
    await request(app).delete(`${api}/posts/${firstPost.body.data.id}`).set('Authorization', bearer(firstSession.accessToken)).expect(204);
  });

  it('accepts zero or one owned image and rejects foreign, video, or multiple assets', async () => {
    const firstSession = await login();
    const secondSession = await login(second.username);
    const firstImage = (await upload(firstSession.accessToken)).body.data;
    const secondImage = (await upload(secondSession.accessToken)).body.data;
    const created = await publish(firstSession.accessToken, { category: 'atelier', mediaIds: [firstImage.id] });
    expect(created.body.data.media).toHaveLength(1);
    expect(created.body.data.media[0].type).toBe('image');
    await publish(firstSession.accessToken, { category: 'article', text: 'Text only', mediaIds: [] });
    await request(app).post(`${api}/posts`).set('Authorization', bearer(firstSession.accessToken))
      .send({ category: 'article', mediaIds: [secondImage.id] }).expect(400);
    await request(app).post(`${api}/posts`).set('Authorization', bearer(firstSession.accessToken))
      .send({ category: 'article', mediaIds: [firstImage.id, secondImage.id] }).expect(400);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
    await request(app).post(`${api}/media`).set('Authorization', bearer(firstSession.accessToken))
      .attach('file', mp4, 'clip.mp4').expect(415);
    await request(app).delete(`${api}/media/${secondImage.id}`).set('Authorization', bearer(firstSession.accessToken)).expect(404);
  });

  it('lets a group update only its own public profile', async () => {
    const session = await login();
    const asset = (await upload(session.accessToken)).body.data;
    const updated = await request(app).patch(`${api}/me/group`).set('Authorization', bearer(session.accessToken))
      .send({ name: 'Cèdres Updated', description: 'A new description', logoMediaId: asset.id }).expect(200);
    expect(updated.body.data).toMatchObject({ id: first._id.toHexString(), name: 'Cèdres Updated', description: 'A new description' });
    expect(updated.body.data.logo.id).toBe(asset.id);
    const untouched = await request(app).get(`${api}/groups/${second._id}`).expect(200);
    expect(untouched.body.data.name).toBe(second.name);
  });

  it('searches the global feed and all group profiles', async () => {
    const firstSession = await login();
    const secondSession = await login(second.username);
    await publish(firstSession.accessToken, { category: 'article', text: 'Mountain hike' });
    await publish(secondSession.accessToken, { category: 'jeux', text: 'Neighbourhood service' });
    const result = await request(app).get(`${api}/search?q=mountain`).expect(200);
    expect(result.body.data.posts).toHaveLength(1);
    expect(result.body.data.groups).toHaveLength(1);
    const discover = await request(app).get(`${api}/discover`).expect(200);
    expect(discover.body.data.posts).toHaveLength(2);
    expect(discover.body.data.groups).toHaveLength(2);
  });

  it('rotates refresh tokens and revokes sessions after password reset', async () => {
    const session = await login();
    const rotated = await request(app).post(`${api}/auth/refresh`).send({ refreshToken: session.refreshToken }).expect(200);
    expect(rotated.body.data.refreshToken).not.toBe(session.refreshToken);
    await request(app).post(`${api}/auth/forgot-password`).send({ identifier: first.username }).expect(200);
    expect(delivered).toHaveLength(1);
    const nextPassword = 'a-new-password-1234';
    await request(app).post(`${api}/auth/reset-password`).send({ token: delivered[0]!.token, password: nextPassword }).expect(200);
    await request(app).get(`${api}/me`).set('Authorization', bearer(rotated.body.data.accessToken)).expect(401);
    await request(app).post(`${api}/auth/login`).send({ identifier: first.username, password }).expect(401);
    await request(app).post(`${api}/auth/login`).send({ identifier: first.username, password: nextPassword }).expect(200);
  });

  it('enforces unique seeded usernames and emails', async () => {
    await expect(db.groups.insertOne({ ...first, _id: new ObjectId() })).rejects.toMatchObject({ code: 11000 });
    await expect(db.groups.insertOne({ ...first, _id: new ObjectId(), username: 'another' })).rejects.toMatchObject({ code: 11000 });
  });
});
