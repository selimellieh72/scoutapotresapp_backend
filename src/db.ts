import { MongoClient, type ClientSession } from 'mongodb';
import type { AuditEvent, GroupAccount, Media, PasswordReset, Post, Session } from './types.js';

export class Database {
  readonly db;
  readonly groups;
  readonly sessions;
  readonly resets;
  readonly posts;
  readonly media;
  readonly audit;

  constructor(readonly client: MongoClient, databaseName: string) {
    this.db = client.db(databaseName);
    this.groups = this.db.collection<GroupAccount>('groups');
    this.sessions = this.db.collection<Session>('sessions');
    this.resets = this.db.collection<PasswordReset>('passwordResetTokens');
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
      this.groups.createIndex({ email: 1 }, { unique: true }),
      this.groups.createIndex({ username: 1 }, { unique: true }),
      this.groups.createIndex({ status: 1, name: 1 }),
      this.sessions.createIndex({ refreshTokenHash: 1 }, { unique: true }),
      this.sessions.createIndex({ groupId: 1 }),
      this.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.resets.createIndex({ tokenHash: 1 }, { unique: true }),
      this.resets.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
      this.posts.createIndex({ deletedAt: 1, publishedAt: -1, _id: -1 }),
      this.posts.createIndex({ groupId: 1, deletedAt: 1, publishedAt: -1, _id: -1 }),
      this.posts.createIndex({ deletedAt: 1, category: 1, publishedAt: -1, _id: -1 }),
      this.posts.createIndex({ deletedAt: 1, mediaTypes: 1, publishedAt: -1, _id: -1 }),
      this.media.createIndex({ storageKey: 1 }, { unique: true }),
      this.media.createIndex({ uploadedByGroupId: 1, referenceCount: 1, createdAt: 1 }),
      this.audit.createIndex({ targetId: 1, timestamp: -1 }),
      this.audit.createIndex({ actorGroupId: 1, timestamp: -1 }),
    ]);
  }

  async transaction<T>(operation: (session: ClientSession) => Promise<T>): Promise<T> {
    return this.client.withSession(session => session.withTransaction(() => operation(session), {
      readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' },
    }));
  }
}
