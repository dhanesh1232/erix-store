export class StringStore {
  private data = new Map<string, string>();

  set(key: string, value: string) {
    this.data.set(key, value);
  }

  get(key: string): string | null {
    return this.data.get(key) || null;
  }

  delete(key: string) {
    this.data.delete(key);
  }

  export() {
    return Object.fromEntries(this.data);
  }

  import(data: Record<string, string>) {
    this.data = new Map(Object.entries(data));
  }
}
