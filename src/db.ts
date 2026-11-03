import { MongoClient, ObjectId, type ClientSession } from 'mongodb';
import type { Admin, AuditEvent, GroupProfile, Media, PasswordReset, Post, Session } from './types.js';

export class Database {
  readonly db;
  readonly admins;
  readonly sessions;
  readonly resets;
  readonly group;
  readonly posts;
  readonly media;
  readonly audit;

  constructor(readonly client: MongoClient, databaseName: string) {
    this.db = client.db(databaseName);
    this.admins = this.db.collection<Admin>('admins');
    this.sessions = this.db.collection<Session>('sessions');
    this.resets = this.db.collection<PasswordReset>('passwordResetTokens');
    this.group = this.db.collection<GroupProfile>('groupProfile');
    this.posts = this.db.collection<Post>('posts');
    this.media = this.db.collection<Media>('media');
    this.audit = this.db.collection<AuditEvent>('auditEvents');
  }

  async initialize() {
    const hello = await this.db.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== 'isdbgrid') {
      throw new Error('MongoDB must be a replica set or sharded cluster; writes use transactions.');
    }
    await Promise.all([
      this.admins.createIndex({ email: 1 }, { unique: true }),
      this.admins.createIndex({ username: 1 }, { unique: true, partialFilterExpression: { username: { $type: 'string' } } }),
      this.sessions.createIndex({ refreshTokenHash: 1 }, { unique: true }),
      this.sessions.createIndex({ adminId: 1 }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.resets.createIndex({ tokenHash: 1 }, { unique: true }),
      this.resets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.group.createIndex({ singletonKey: 1 }, { unique: true }),
      this.posts.createIndex({ deletedAt: 1, publishedAt: -1, _id: -1 }),
      this.posts.createIndex({ deletedAt: 1, category: 1, publishedAt: -1, _id: -1 }),
      this.posts.createIndex({ deletedAt: 1, mediaTypes: 1, publishedAt: -1, _id: -1 }),
      this.media.createIndex({ storageKey: 1 }, { unique: true }),
      this.media.createIndex({ referenceCount: 1, createdAt: 1 }),
      this.audit.createIndex({ targetId: 1, timestamp: -1 }),
      this.audit.createIndex({ actorAdminId: 1, timestamp: -1 }),
    ]);
    const now = new Date();
    try {
      await this.group.updateOne({ singletonKey: 'main' }, { $setOnInsert: {
        _id: new ObjectId(), singletonKey: 'main', name: 'Groupe Scout des Apôtres',
        description: '', logoMediaId: null, coverMediaId: null, createdAt: now, updatedAt: now,
      } }, { upsert: true });
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 11000)) throw error;
    }
  }

  async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.client.withSession(session => session.withTransaction(() => operation(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
    }));
  }
}
