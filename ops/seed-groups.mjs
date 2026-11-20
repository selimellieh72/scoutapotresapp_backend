import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { MongoClient, ObjectId } from 'mongodb';
import { hashPassword } from '../dist/services/crypto.js';

const file = process.argv[2];
if (!file) throw new Error('Usage: pnpm seed:groups /absolute/path/to/groups.json');
if (!process.env.MONGODB_URI || !process.env.MONGODB_DATABASE) throw new Error('MONGODB_URI and MONGODB_DATABASE are required.');
const input = JSON.parse(await readFile(resolve(file), 'utf8'));
if (!Array.isArray(input) || !input.length) throw new Error('Seed file must contain a non-empty JSON array.');

const usernames = new Set();
const emails = new Set();
for (const [index, group] of input.entries()) {
  if (!group || typeof group !== 'object') throw new Error(`Group ${index + 1} must be an object.`);
  group.username = String(group.username ?? '').trim().toLowerCase();
  group.email = String(group.email ?? '').trim().toLowerCase();
  group.name = String(group.name ?? '').trim();
  group.description = String(group.description ?? '').trim();
  if (!/^[a-z0-9._-]{3,60}$/.test(group.username)) throw new Error(`Group ${index + 1} has an invalid username.`);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(group.email)) throw new Error(`Group ${index + 1} has an invalid email.`);
  if (!group.name || group.name.length > 120) throw new Error(`Group ${index + 1} has an invalid name.`);
  if (group.description.length > 2000) throw new Error(`Group ${index + 1} description is too long.`);
  if (typeof group.password !== 'string' || group.password.length < 12 || group.password.length > 256) throw new Error(`Group ${index + 1} password must contain 12-256 characters.`);
  if (usernames.has(group.username) || emails.has(group.email)) throw new Error('Seed file contains duplicate usernames or emails.');
  usernames.add(group.username); emails.add(group.email);
}

const client = await MongoClient.connect(process.env.MONGODB_URI);
try {
  const groups = client.db(process.env.MONGODB_DATABASE).collection('groups');
  const conflict = await groups.findOne({ $or: [{ username: { $in: [...usernames] } }, { email: { $in: [...emails] } }] });
  if (conflict) throw new Error('A seeded username or email already exists; no accounts were created.');
  const now = new Date();
  const documents = [];
  for (const group of input) documents.push({
    _id: new ObjectId(), username: group.username, email: group.email, name: group.name,
    description: group.description, logoMediaId: null, coverMediaId: null,
    passwordHash: await hashPassword(group.password), status: 'active', authVersion: 0,
    createdAt: now, updatedAt: now,
  });
  await groups.insertMany(documents, { ordered: true });
  console.log(`Seeded ${documents.length} group accounts.`);
} finally {
  await client.close();
}
