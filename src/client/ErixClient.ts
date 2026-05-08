import axios, { type AxiosInstance } from "axios";

/** JSON-serializable value — the acceptable type for all store operations */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

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
	async set(key: string, value: JsonValue, ttlSeconds?: number): Promise<void> {
		await this.http.post("/core/set", {
			key,
			value: JSON.stringify(value),
			ttl: ttlSeconds,
		});
	}

	async get<T>(key: string): Promise<T | null> {
		const res = await this.http.get("/core/get", { params: { key } });
		if (!res.data.value) return null;
		try {
			return JSON.parse(res.data.value) as T;
		} catch {
			return res.data.value as T;
		}
	}

	async del(key: string): Promise<void> {
		await this.http.delete("/core/del", { data: { key } });
	}

	// Hash Operations
	public hash = {
		hset: async (
			key: string,
			field: string,
			value: JsonValue,
		): Promise<void> => {
			await this.http.post("/hash/hset", {
				key,
				field,
				value: JSON.stringify(value),
			});
		},
		hget: async <T>(key: string, field: string): Promise<T | null> => {
			const res = await this.http.get("/hash/hget", { params: { key, field } });
			if (!res.data.value) return null;
			try {
				return JSON.parse(res.data.value) as T;
			} catch {
				return res.data.value as T;
			}
		},
		hgetall: async (key: string): Promise<Record<string, string>> => {
			const res = await this.http.get("/hash/hgetall", { params: { key } });
			return res.data.data as Record<string, string>;
		},
	};

	// List Operations
	public list = {
		lpush: async (key: string, value: JsonValue): Promise<void> => {
			await this.http.post("/list/lpush", {
				key,
				value: JSON.stringify(value),
			});
		},
		rpush: async (key: string, value: JsonValue): Promise<void> => {
			await this.http.post("/list/rpush", {
				key,
				value: JSON.stringify(value),
			});
		},
		lpop: async <T>(key: string): Promise<T | null> => {
			const res = await this.http.get("/list/lpop", { params: { key } });
			if (!res.data.value) return null;
			try {
				return JSON.parse(res.data.value) as T;
			} catch {
				return res.data.value as T;
			}
		},
	};

	// Queue Operations (maps to list under the hood — like Redis LPUSH/RPOP)
	public queue = {
		push: async (name: string, data: JsonValue): Promise<void> => {
			await this.list.rpush(`q:${name}`, data);
		},
		pop: async <T>(name: string): Promise<T | null> => {
			return await this.list.lpop<T>(`q:${name}`);
		},
	};

	// PubSub Operations
	public pubsub = {
		publish: async (channel: string, message: JsonValue): Promise<void> => {
			await this.http.post("/pubsub/publish", { channel, message });
		},
	};

	// Rate Limit
	async rateLimit(
		key: string,
		limit: number,
		window: number,
	): Promise<unknown> {
		const res = await this.http.post("/ratelimit", { key, limit, window });
		return res.data;
	}
}
