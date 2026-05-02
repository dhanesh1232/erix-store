import axios, { AxiosInstance } from "axios";

export interface ErixClientOptions {
  baseUrl: string;
  apiKey: string;
  tenantId: string;
}

export class ErixClient {
  private http: AxiosInstance;
  private tenantId: string;

  constructor(options: ErixClientOptions) {
    this.tenantId = options.tenantId;
    this.http = axios.create({
      baseURL: options.baseUrl,
      headers: {
        "x-erix-key": options.apiKey,
        "x-tenant-id": options.tenantId,
        "Content-Type": "application/json",
      },
    });
  }

  // Core Operations
  async set(key: string, value: any, ttlSeconds?: number) {
    await this.http.post("/core/set", { key, value: JSON.stringify(value), ttl: ttlSeconds });
  }

  async get<T>(key: string): Promise<T | null> {
    const res = await this.http.get("/core/get", { params: { key } });
    if (!res.data.value) return null;
    try {
      return JSON.parse(res.data.value);
    } catch {
      return res.data.value;
    }
  }

  async del(key: string) {
    await this.http.delete("/core/del", { data: { key } });
  }

  // Hash Operations
  public hash = {
    hset: async (key: string, field: string, value: any) => {
      await this.http.post("/hash/hset", { key, field, value: JSON.stringify(value) });
    },
    hget: async <T>(key: string, field: string): Promise<T | null> => {
      const res = await this.http.get("/hash/hget", { params: { key, field } });
      if (!res.data.value) return null;
      try {
        return JSON.parse(res.data.value);
      } catch {
        return res.data.value;
      }
    },
    hgetall: async (key: string) => {
      const res = await this.http.get("/hash/hgetall", { params: { key } });
      return res.data.data;
    }
  };

  // List Operations
  public list = {
    lpush: async (key: string, value: any) => {
      await this.http.post("/list/lpush", { key, value: JSON.stringify(value) });
    },
    rpush: async (key: string, value: any) => {
      await this.http.post("/list/rpush", { key, value: JSON.stringify(value) });
    },
    lpop: async <T>(key: string): Promise<T | null> => {
      const res = await this.http.get("/list/lpop", { params: { key } });
      if (!res.data.value) return null;
      try {
        return JSON.parse(res.data.value);
      } catch {
        return res.data.value;
      }
    }
  };

  // Queue Operations
  public queue = {
    push: async (name: string, data: any) => {
      await this.http.post("/queue/push", { queue: name, data });
    },
    pop: async <T>(name: string): Promise<T | null> => {
      const res = await this.http.get("/queue/pop", { params: { queue: name } });
      return res.data.data;
    }
  };

  // PubSub Operations
  public pubsub = {
    publish: async (channel: string, message: any) => {
      await this.http.post("/pubsub/publish", { channel, message });
    }
  };

  // Rate Limit
  async rateLimit(key: string, limit: number, window: number) {
    const res = await this.http.post("/ratelimit", { key, limit, window });
    return res.data;
  }
}
