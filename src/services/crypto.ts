import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

export const secret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

async function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64,
    { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 },
    (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  return `scrypt$32768$8$3$${salt}$${(await derive(password, salt)).toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const [algorithm, n, r, p, salt, hash, extra] = encoded.split('$');
  if (algorithm !== 'scrypt' || n !== '32768' || r !== '8' || p !== '3' || extra !== undefined ||
      !salt || !/^[a-f0-9]{32}$/.test(salt) || !hash || !/^[a-f0-9]{128}$/.test(hash)) return false;
  return timingSafeEqual(await derive(password, salt), Buffer.from(hash, 'hex'));
}
