import { MongoClient } from 'mongodb';

if (!process.env.MONGODB_URI || !process.env.MONGODB_DATABASE) {
  throw new Error('MONGODB_URI and MONGODB_DATABASE are required.');
}

const client = await MongoClient.connect(process.env.MONGODB_URI);
try {
  const db = client.db(process.env.MONGODB_DATABASE);
  const admins = db.collection('admins');
  const groups = db.collection('groups');
  const legacy = await admins.find({}).toArray();
  if (!legacy.length) {
    console.log('No legacy admin accounts found; nothing to migrate.');
    process.exitCode = 0;
  } else {
    const usernames = new Set();
    const emails = new Set();
    for (const account of legacy) {
      const username = String(account.username ?? '').trim().toLowerCase();
      const email = String(account.email ?? '').trim().toLowerCase();
      if (!/^[a-z0-9._-]{3,60}$/.test(username)) {
        throw new Error(`Legacy account ${account._id} does not have a valid username.`);
      }
      if (!email || usernames.has(username) || emails.has(email)) {
        throw new Error('Legacy accounts contain a missing or duplicate username/email.');
      }
      usernames.add(username);
      emails.add(email);
    }

    const legacyObjectIds = legacy.map(account => account._id);
    const legacyIds = new Set(legacyObjectIds.map(id => id.toHexString()));
    const assertOwners = async (collectionName, ownerField) => {
      const owners = await db.collection(collectionName).distinct(ownerField, { [ownerField]: { $exists: true } });
      const orphan = owners.find(owner => !legacyIds.has(owner.toHexString()));
      if (orphan) throw new Error(`${collectionName} contains an owner that is not a legacy account: ${orphan}`);
    };
    await assertOwners('media', 'uploadedByAdminId');
    await assertOwners('sessions', 'adminId');
    await assertOwners('passwordResetTokens', 'adminId');
    const orphanPosts = await db.collection('posts').find({
      createdByAdminId: { $nin: legacyObjectIds },
      deletedAt: null,
    }).project({ _id: 1, title: 1 }).toArray();
    const unsafeOrphan = orphanPosts.find(post => !String(post.title ?? '').startsWith('Démo ·'));
    if (unsafeOrphan) {
      throw new Error(`Post ${unsafeOrphan._id} has no group owner and is not recognized as demo content.`);
    }

    const legacyById = new Map(legacy.map(account => [account._id.toHexString(), account]));
    const existingGroups = await groups.find({}).toArray();
    const conflicting = existingGroups.find(group => {
      const account = legacyById.get(group._id.toHexString());
      return !account || group.username !== account.username.trim().toLowerCase() || group.email !== account.email.trim().toLowerCase();
    });
    if (conflicting) {
      throw new Error('The groups collection already contains non-legacy data; migration stopped without changes.');
    }

    const session = client.startSession();
    try {
      await session.withTransaction(async () => {
        for (const account of legacy) {
          await groups.updateOne({ _id: account._id }, { $setOnInsert: {
            _id: account._id,
            email: account.email.trim().toLowerCase(),
            username: account.username.trim().toLowerCase(),
            name: String(account.displayName || account.username).trim(),
            description: '',
            logoMediaId: null,
            coverMediaId: null,
            passwordHash: account.passwordHash,
            status: account.status,
            authVersion: account.authVersion,
            createdAt: account.createdAt,
            updatedAt: account.updatedAt,
          } }, { upsert: true, session });
        }
        await db.collection('sessions').updateMany({ adminId: { $exists: true } }, { $rename: { adminId: 'groupId' } }, { session });
        await db.collection('passwordResetTokens').updateMany({ adminId: { $exists: true } }, { $rename: { adminId: 'groupId' } }, { session });
        if (orphanPosts.length) await db.collection('posts').updateMany({ _id: { $in: orphanPosts.map(post => post._id) } }, {
          $set: { deletedAt: new Date(), updatedAt: new Date() },
        }, { session });
        await db.collection('posts').updateMany({ groupId: { $exists: false }, createdByAdminId: { $in: legacyObjectIds } }, [
          { $set: { groupId: '$createdByAdminId' } },
          { $unset: ['createdByAdminId', 'updatedByAdminId'] },
        ], { session });
        await db.collection('media').updateMany({ uploadedByAdminId: { $exists: true } }, { $rename: { uploadedByAdminId: 'uploadedByGroupId' } }, { session });
        await db.collection('auditEvents').updateMany({ actorAdminId: { $exists: true } }, { $rename: { actorAdminId: 'actorGroupId' } }, { session });
      });
    } finally {
      await session.endSession();
    }
    console.log(`Migrated ${legacy.length} legacy accounts into group accounts and archived ${orphanPosts.length} orphaned demo posts. Legacy collections were retained for rollback.`);
  }
} finally {
  await client.close();
}
