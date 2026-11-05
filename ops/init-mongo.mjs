import { setTimeout as delay } from 'node:timers/promises';
import { MongoClient, MongoServerError } from 'mongodb';

const endpoint = '127.0.0.1:27028';
const database = 'scoutapotres';
const appUri = process.env.MONGODB_URI;
const managerPassword = process.env.SCOUT_MONGO_MANAGER_PASSWORD;
const appPassword = process.env.SCOUT_MONGO_APP_PASSWORD;
if (!appUri || !managerPassword || !appPassword) throw new Error('Missing deployment database configuration.');

async function withClient(uri, operation) {
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 4000 });
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

const localUri = `mongodb://${endpoint}/?directConnection=true`;
const managerUri = `mongodb://scout_manager:${encodeURIComponent(managerPassword)}@${endpoint}/admin?directConnection=true`;

async function initialize() {
  await withClient(localUri, async client => {
    const admin = client.db('admin');
    let hello = await admin.command({ hello: 1 });
    if (!hello.setName && hello.isreplicaset) {
      await admin.command({ replSetInitiate: { _id: 'scout', members: [{ _id: 0, host: 'localhost:27028' }] } });
    }
    for (let attempt = 0; attempt < 40 && !hello.isWritablePrimary; attempt++) {
      await delay(500);
      hello = await admin.command({ hello: 1 });
    }
    if (hello.setName !== 'scout' || !hello.isWritablePrimary) throw new Error('Scout MongoDB replica set is not primary.');

    try {
      await withClient(managerUri, manager => manager.db('admin').command({ ping: 1 }));
    } catch (error) {
      if (!(error instanceof MongoServerError && error.code === 18)) throw error;
      await admin.command({ createUser: 'scout_manager', pwd: managerPassword, roles: ['userAdminAnyDatabase'] });
    }
  });

  await withClient(managerUri, async manager => {
    const db = manager.db(database);
    const { users } = await db.command({ usersInfo: 'scout_api' });
    if (users.length === 0) {
      await db.command({ createUser: 'scout_api', pwd: appPassword, roles: [{ role: 'readWrite', db: database }] });
    }
  });
  await withClient(appUri, client => client.db(database).command({ ping: 1 }));
}

await initialize();
