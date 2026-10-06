import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';

/** 记录已处理的消息 id，避免重复回复。 */
export class SeenStore {
  private seen = new Set<string>();
  private readonly file = path.join(config.dataDir, 'seen.json');

  async load(): Promise<this> {
    try {
      this.seen = new Set(JSON.parse(await fs.readFile(this.file, 'utf8')));
    } catch {
      /* 首次运行 */
    }
    return this;
  }
  has(id: string) {
    return this.seen.has(id);
  }
  add(id: string) {
    this.seen.add(id);
  }
  async save() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.file, JSON.stringify([...this.seen].slice(-5000)));
  }
}
