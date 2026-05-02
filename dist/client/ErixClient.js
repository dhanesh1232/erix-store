"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ErixClient = void 0;
const axios_1 = __importDefault(require("axios"));
class ErixClient {
    http;
    tenantId;
    constructor(options) {
        this.tenantId = options.tenantId;
        this.http = axios_1.default.create({
            baseURL: options.baseUrl,
            headers: {
                "x-erix-key": options.apiKey,
                "x-tenant-id": options.tenantId,
                "Content-Type": "application/json",
            },
        });
    }
    // Core Operations
    async set(key, value, ttlSeconds) {
        await this.http.post("/core/set", { key, value: JSON.stringify(value), ttl: ttlSeconds });
    }
    async get(key) {
        const res = await this.http.get("/core/get", { params: { key } });
        if (!res.data.value)
            return null;
        try {
            return JSON.parse(res.data.value);
        }
        catch {
            return res.data.value;
        }
    }
    async del(key) {
        await this.http.delete("/core/del", { data: { key } });
    }
    // Hash Operations
    hash = {
        hset: async (key, field, value) => {
            await this.http.post("/hash/hset", { key, field, value: JSON.stringify(value) });
        },
        hget: async (key, field) => {
            const res = await this.http.get("/hash/hget", { params: { key, field } });
            if (!res.data.value)
                return null;
            try {
                return JSON.parse(res.data.value);
            }
            catch {
                return res.data.value;
            }
        },
        hgetall: async (key) => {
            const res = await this.http.get("/hash/hgetall", { params: { key } });
            return res.data.data;
        }
    };
    // List Operations
    list = {
        lpush: async (key, value) => {
            await this.http.post("/list/lpush", { key, value: JSON.stringify(value) });
        },
        rpush: async (key, value) => {
            await this.http.post("/list/rpush", { key, value: JSON.stringify(value) });
        },
        lpop: async (key) => {
            const res = await this.http.get("/list/lpop", { params: { key } });
            if (!res.data.value)
                return null;
            try {
                return JSON.parse(res.data.value);
            }
            catch {
                return res.data.value;
            }
        }
    };
    // Queue Operations
    queue = {
        push: async (name, data) => {
            await this.http.post("/queue/push", { queue: name, data });
        },
        pop: async (name) => {
            const res = await this.http.get("/queue/pop", { params: { queue: name } });
            return res.data.data;
        }
    };
    // PubSub Operations
    pubsub = {
        publish: async (channel, message) => {
            await this.http.post("/pubsub/publish", { channel, message });
        }
    };
    // Rate Limit
    async rateLimit(key, limit, window) {
        const res = await this.http.post("/ratelimit", { key, limit, window });
        return res.data;
    }
}
exports.ErixClient = ErixClient;
