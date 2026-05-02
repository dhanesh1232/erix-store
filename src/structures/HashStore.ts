export class HashStore {
  private data = new Map<string, Map<string, string>>();

  hset(key: string, field: string, value: string) {
    if (!this.data.has(key)) {
      this.data.set(key, new Map());
    }
    this.data.get(key)!.set(field, value);
  }

  hget(key: string, field: string): string | null {
    const hash = this.data.get(key);
    return hash ? hash.get(field) || null : null;
  }

  hgetall(key: string): Record<string, string> | null {
    const hash = this.data.get(key);
    return hash ? Object.fromEntries(hash) : null;
  }

  hdel(key: string, field: string) {
    const hash = this.data.get(key);
    if (hash) {
      hash.delete(field);
      if (hash.size === 0) {
        this.data.delete(key);
      }
    }
  }

  delete(key: string) {
    this.data.delete(key);
  }

  export() {
    const exported: Record<string, Record<string, string>> = {};
    for (const [key, hash] of this.data.entries()) {
      exported[key] = Object.fromEntries(hash);
    }
    return exported;
  }

  import(data: Record<string, Record<string, string>>) {
    this.data = new Map();
    for (const [key, hash] of Object.entries(data)) {
      this.data.set(key, new Map(Object.entries(hash)));
    }
  }
}
