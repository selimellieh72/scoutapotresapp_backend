import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface MediaStore {
  put(key: string, contents: Buffer): Promise<void>;
  remove(key: string): Promise<void>;
  path(key: string): string;
}

// Files are never exposed with express.static. Every download checks publication.
export class LocalMediaStore implements MediaStore {
  private readonly directory: string;
  constructor(directory: string) { this.directory = resolve(directory); }
  path(key: string) {
    if (!/^[a-f0-9-]+\.(webp|mp4)$/.test(key)) throw new Error('Invalid storage key.');
    return join(this.directory, key);
  }
  async put(key: string, contents: Buffer) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await writeFile(this.path(key), contents, { flag: 'wx', mode: 0o600 });
  }
  async remove(key: string) { await rm(this.path(key), { force: true }); }
}
