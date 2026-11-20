import type { ObjectId } from 'mongodb';

export const categories = ['article', 'atelier', 'installation', 'jeux'] as const;
export type Category = typeof categories[number];
export interface Timestamps { createdAt: Date; updatedAt: Date }

export interface GroupAccount extends Timestamps {
  _id: ObjectId;
  email: string;
  username: string;
  name: string;
  description: string;
  logoMediaId: ObjectId | null;
  coverMediaId: ObjectId | null;
  passwordHash: string;
  status: 'active' | 'disabled';
  authVersion: number;
}

export interface Session extends Timestamps {
  _id: ObjectId;
  groupId: ObjectId;
  authVersion: number;
  accessTokenHash: string;
  accessExpiresAt: Date;
  refreshTokenHash: string;
  usedRefreshTokenHashes: string[];
  expiresAt: Date;
  revokedAt: Date | null;
}

export interface PasswordReset extends Timestamps {
  _id: ObjectId;
  groupId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  consumedAt: Date | null;
}

export interface Post extends Timestamps {
  _id: ObjectId;
  groupId: ObjectId;
  category: Category;
  title: string;
  text: string;
  mediaIds: ObjectId[];
  mediaTypes: ('image' | 'video')[];
  publishedAt: Date;
  deletedAt: Date | null;
}

export interface Media extends Timestamps {
  _id: ObjectId;
  uploadedByGroupId: ObjectId;
  storageKey: string;
  type: 'image' | 'video';
  mimeType: string;
  sizeBytes: number;
  width: number;
  height: number;
  durationSeconds?: number;
  state: 'processing' | 'ready' | 'failed' | 'deleting';
  referenceCount: number;
}

export interface AuditEvent {
  _id: ObjectId;
  actorGroupId: ObjectId;
  action: string;
  targetType: 'post' | 'group';
  targetId: ObjectId;
  timestamp: Date;
  requestId: string;
}
