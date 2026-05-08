/**
 * @ecodrix/erix-client
 *
 * Type-safe HTTP client for the erix-store in-memory data service.
 * Connects to a running erix-store instance without requiring the
 * consumer to know any of the underlying HTTP route structure.
 *
 * @example
 * ```ts
 * import { ErixClient } from '@ecodrix/erix-client'
 *
 * const store = new ErixClient({
 *   baseUrl: 'https://erix-store.onrender.com',
 *   apiKey: process.env.ERIX_API_KEY!,
 *   tenantId: 'org_abc123',
 * })
 *
 * await store.set('session:user1', { role: 'admin' }, 3600)
 * const session = await store.get<{ role: string }>('session:user1')
 * ```
 */

// ─── Types ──────────────────────────────────────────────────────────────────

/** Any value that can be serialized to and from JSON */
export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export interface ErixClientOptions {
	/** Full URL of the deployed erix-store instance, e.g. https://api.erix.ecodrix.com */
	baseUrl: string;
	/** Shared secret generated at deploy time — must match ERIX_API_KEY on the server */
	apiKey: string;
	/** Tenant namespace — all keys are automatically namespaced under this prefix */
	tenantId: string;
	/** Optional request timeout in milliseconds (default: 5000) */
	timeoutMs?: number;
}

export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	resetAt: number;
}

export interface JobV2<T = JsonValue> {
	id: string;
	queueName: string;
	data: T;
	status: "waiting" | "active" | "completed" | "failed" | "delayed";
	attempts: number;
	maxAttempts: number;
	priority: number;
	createdAt: string;
	runAt: string;
	clientCode?: string;
	progress?: number;
	error?: string;
	result?: JsonValue;
}

export interface EnqueueOptionsV2 {
	priority?: number;
	maxAttempts?: number;
	delayMs?: number;
	runAt?: Date | string;
	clientCode?: string;
	metadata?: Record<string, JsonValue>;
}

export interface CacheSetOptions {
	/** TTL in milliseconds */
	ttl?: number;
	/** Tags for bulk invalidation */
	tags?: string[];
	/**
	 * Stale-While-Revalidate window in milliseconds.
	 * The server serves the old value for this duration after TTL expires
	 * while refreshing in the background.
	 */
	staleFor?: number;
}

export interface SemanticGetResult<T = JsonValue> {
	value: T;
	key: string;
	similarity: number;
	isExact: boolean;
}

export interface QueueEventHandlers<T = JsonValue> {
	onAdded?: (job: JobV2<T>) => void;
	onActive?: (job: JobV2<T>) => void;
	onCompleted?: (job: JobV2<T>) => void;
	onFailed?: (job: JobV2<T>) => void;
	onZombie?: (job: JobV2<T>) => void;
	onError?: (err: Error) => void;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class ErixClient {
	private readonly baseUrl: string;
	private readonly headers: Record<string, string>;
	private readonly timeoutMs: number;

	constructor(options: ErixClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/$/, ""); // strip trailing slash
		this.timeoutMs = options.timeoutMs ?? 5000;
		this.headers = {
			"x-erix-key": options.apiKey,
			"x-tenant-id": options.tenantId,
			"Content-Type": "application/json",
		};
	}

	// ── Internal fetch helper ─────────────────────────────────────────────

	private async req<T>(
		method: string,
		path: string,
		body?: unknown,
		params?: Record<string, string>,
	): Promise<T> {
		const url = new URL(`${this.baseUrl}${path}`);
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				url.searchParams.set(k, v);
			}
		}
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await fetch(url.toString(), {
				method,
				headers: this.headers,
				body: body !== undefined ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			if (!res.ok) {
				const err = (await res.json().catch(() => ({}))) as { error?: string };
				throw new Error(
					`[erix-store] ${method} ${path} → ${res.status}: ${err.error ?? res.statusText}`,
				);
			}
			return (await res.json()) as T;
		} finally {
			clearTimeout(timer);
		}
	}

	// ─── Health ───────────────────────────────────────────────────────────

	/** Check if the erix-store instance is reachable */
	async ping(): Promise<{ status: string; uptime: number }> {
		return this.req("GET", "/health");
	}

	// ─── Core: Key / Value ────────────────────────────────────────────────

	/**
	 * Store any JSON value under a key.
	 * @param ttlSeconds  Optional expiry in seconds. Omit for no expiry.
	 */
	async set(key: string, value: JsonValue, ttlSeconds?: number): Promise<void> {
		await this.req("POST", "/core/set", {
			key,
			value: JSON.stringify(value),
			ttl: ttlSeconds,
		});
	}

	/**
	 * Retrieve a value by key. Returns `null` if the key doesn't exist or has expired.
	 */
	async get<T = JsonValue>(key: string): Promise<T | null> {
		const data = await this.req<{ value: string | null }>(
			"GET",
			"/core/get",
			undefined,
			{ key },
		);
		if (!data.value) return null;
		try {
			return JSON.parse(data.value) as T;
		} catch {
			return data.value as unknown as T;
		}
	}

	/** Delete a key */
	async del(key: string): Promise<void> {
		await this.req("DELETE", "/core/del", { key });
	}

	// ─── Hash ─────────────────────────────────────────────────────────────

	public hash = {
		/** Set a field in a hash */
		hset: async (
			key: string,
			field: string,
			value: JsonValue,
		): Promise<void> => {
			await this.req("POST", "/hash/hset", {
				key,
				field,
				value: JSON.stringify(value),
			});
		},
		/** Get a single field from a hash */
		hget: async <T = JsonValue>(
			key: string,
			field: string,
		): Promise<T | null> => {
			const data = await this.req<{ value: string | null }>(
				"GET",
				"/hash/hget",
				undefined,
				{ key, field },
			);
			if (!data.value) return null;
			try {
				return JSON.parse(data.value) as T;
			} catch {
				return data.value as unknown as T;
			}
		},
		/** Get all fields of a hash */
		hgetall: async (key: string): Promise<Record<string, string>> => {
			const data = await this.req<{ data: Record<string, string> }>(
				"GET",
				"/hash/hgetall",
				undefined,
				{ key },
			);
			return data.data;
		},
	};

	// ─── List ─────────────────────────────────────────────────────────────

	public list = {
		/** Prepend a value to a list */
		lpush: async (key: string, value: JsonValue): Promise<void> => {
			await this.req("POST", "/list/lpush", {
				key,
				value: JSON.stringify(value),
			});
		},
		/** Append a value to a list */
		rpush: async (key: string, value: JsonValue): Promise<void> => {
			await this.req("POST", "/list/rpush", {
				key,
				value: JSON.stringify(value),
			});
		},
		/** Pop from the left (FIFO front) */
		lpop: async <T = JsonValue>(key: string): Promise<T | null> => {
			const data = await this.req<{ value: string | null }>(
				"GET",
				"/list/lpop",
				undefined,
				{ key },
			);
			if (!data.value) return null;
			try {
				return JSON.parse(data.value) as T;
			} catch {
				return data.value as unknown as T;
			}
		},
	};

	// ─── Queue (FIFO job queue, built on List) ────────────────────────────

	public queue = {
		/** Enqueue a job payload into a named queue (simple list-based) */
		push: async (name: string, data: JsonValue): Promise<void> => {
			await this.list.rpush(`q:${name}`, data);
		},
		/** Dequeue the oldest job from a named queue. Returns `null` if empty. */
		pop: async <T = JsonValue>(name: string): Promise<T | null> => {
			return this.list.lpop<T>(`q:${name}`);
		},
	};

	/** Advanced Queue (v2) — supports priority, delay, retries, heartbeat, and SSE push */
	public queueV2 = {
		/** Enqueue a job into an advanced queue */
		push: async <T = JsonValue>(
			queueName: string,
			data: T,
			options: EnqueueOptionsV2 = {},
		): Promise<JobV2<T>> => {
			const res = await this.req<{ success: boolean; job: JobV2<T> }>(
				"POST",
				`/queue/v2/${queueName}/jobs`,
				{ data, ...options },
			);
			return res.job;
		},
		/** Claim the next eligible job from the queue */
		claim: async <T = JsonValue>(
			queueName: string,
		): Promise<JobV2<T> | null> => {
			const res = await this.req<{ success: boolean; job: JobV2<T> | null }>(
				"POST",
				`/queue/v2/${queueName}/claim`,
			);
			return res.job;
		},
		/** Mark a job as completed */
		complete: async (jobId: string, result?: JsonValue): Promise<void> => {
			await this.req("POST", `/queue/v2/jobs/${jobId}/complete`, { result });
		},
		/** Mark a job as failed */
		fail: async (jobId: string, error: string): Promise<void> => {
			await this.req("POST", `/queue/v2/jobs/${jobId}/fail`, { error });
		},
		/** Update job progress (0-100) */
		updateProgress: async (jobId: string, progress: number): Promise<void> => {
			await this.req("PATCH", `/queue/v2/jobs/${jobId}/progress`, { progress });
		},
		/**
		 * Send a worker heartbeat to keep the job alive in the reaper.
		 * Call every 15–30 seconds from inside a long-running job handler.
		 * If silent for 60s the reaper will fail and requeue the job.
		 */
		heartbeat: async (jobId: string): Promise<void> => {
			await this.req("PATCH", `/queue/v2/jobs/${jobId}/heartbeat`);
		},
		/** Get job by ID */
		get: async <T = JsonValue>(jobId: string): Promise<JobV2<T> | null> => {
			const res = await this.req<{ success: boolean; job: JobV2<T> | null }>(
				"GET",
				`/queue/v2/jobs/${jobId}`,
			);
			return res.job;
		},
		/**
		 * Subscribe to queue events via Server-Sent Events.
		 * Returns an EventSource-like object — call `.close()` to unsubscribe.
		 *
		 * Workers should use this instead of polling `claim()` on an interval.
		 * On `job:added` or `job:active` events, call `claim()` to get the job.
		 *
		 * @example
		 * const sub = client.queueV2.subscribe('crm', {
		 *   onAdded: () => processNextJob(),
		 *   onError: (e) => console.error(e),
		 * });
		 * // later:
		 * sub.close();
		 */
		subscribe: <T = JsonValue>(
			queueName: string,
			handlers: QueueEventHandlers<T>,
		): { close: () => void } => {
			return this.openEventStream(
				`/queue/v2/${queueName}/events`,
				(event, data) => {
					const job = data as JobV2<T>;
					if (event === "job:added") handlers.onAdded?.(job);
					else if (event === "job:active") handlers.onActive?.(job);
					else if (event === "job:completed") handlers.onCompleted?.(job);
					else if (event === "job:failed") handlers.onFailed?.(job);
					else if (event === "job:zombie") handlers.onZombie?.(job);
				},
				handlers.onError,
			);
		},
	};

	// ─── PubSub ───────────────────────────────────────────────────────────

	public pubsub = {
		/** Publish a message to a channel */
		publish: async (channel: string, message: JsonValue): Promise<void> => {
			await this.req("POST", "/pubsub/publish", { channel, message });
		},
		/**
		 * Subscribe to a pub/sub channel via Server-Sent Events.
		 * Returns a controller with a `.close()` method.
		 *
		 * @example
		 * const sub = client.pubsub.subscribe('alerts', (msg) => console.log(msg));
		 * sub.close(); // unsubscribe
		 */
		subscribe: (
			channel: string,
			onMessage: (message: JsonValue) => void,
			onError?: (err: Error) => void,
		): { close: () => void } => {
			return this.openEventStream(
				`/pubsub/${encodeURIComponent(channel)}/stream`,
				(_event, data) => onMessage(data as JsonValue),
				onError,
			);
		},
	};

	// ─── Rate Limiter ─────────────────────────────────────────────────────

	/**
	 * Check if an operation is within rate limits.
	 * @param key     Identifier (e.g. `"api:org_123"`)
	 * @param limit   Maximum allowed operations in the window
	 * @param window  Window duration in seconds
	 */
	async rateLimit(
		key: string,
		limit: number,
		window: number,
	): Promise<RateLimitResult> {
		return this.req<RateLimitResult>("POST", "/ratelimit", {
			key,
			limit,
			window,
		});
	}

	// ─── Set ──────────────────────────────────────────────────────────────

	public set_ = {
		/** Add a member to a set */
		sadd: async (key: string, value: string): Promise<{ added: number }> => {
			return this.req("POST", "/set/sadd", { key, value });
		},
		/** Get all members of a set */
		smembers: async (key: string): Promise<string[]> => {
			const data = await this.req<{ members: string[] }>(
				"GET",
				"/set/smembers",
				undefined,
				{ key },
			);
			return data.members;
		},
	};

	// ─── Cache (advanced) ────────────────────────────────────────────────

	public cache = {
		/** Get a cached value */
		get: async <T = JsonValue>(key: string): Promise<T | null> => {
			try {
				const res = await this.req<{ success: boolean; value: T }>(
					"GET",
					`/cache/${encodeURIComponent(key)}`,
				);
				return res.value ?? null;
			} catch {
				return null;
			}
		},
		/** Set a cached value with optional TTL, tags, and stale-while-revalidate */
		set: async (
			key: string,
			value: JsonValue,
			options: CacheSetOptions = {},
		): Promise<void> => {
			await this.req("POST", `/cache/${encodeURIComponent(key)}`, {
				value,
				...options,
			});
		},
		/** Delete a cached key */
		del: async (key: string): Promise<void> => {
			await this.req("DELETE", `/cache/${encodeURIComponent(key)}`);
		},
		/** Invalidate all keys with a specific tag */
		invalidateByTag: async (tag: string): Promise<number> => {
			const res = await this.req<{ success: boolean; count: number }>(
				"DELETE",
				`/cache/tags/${encodeURIComponent(tag)}`,
			);
			return res.count;
		},
		/** Invalidate all keys matching multiple tags */
		invalidateByTags: async (tags: string[]): Promise<number> => {
			const res = await this.req<{ success: boolean; count: number }>(
				"POST",
				"/cache/tags/invalidate",
				{ tags },
			);
			return res.count;
		},
		/** Get cache statistics (hit rate, size, evictions) */
		stats: async () => {
			const res = await this.req<{ success: boolean; stats: unknown }>(
				"GET",
				"/cache/_stats",
			);
			return res.stats;
		},
	};

	// ─── Semantic Cache (AI layer) ────────────────────────────────────────

	public semantic = {
		/**
		 * Store a value with its embedding for similarity lookups.
		 * @param key    Unique cache key
		 * @param text   Text to embed (the query/question this entry answers)
		 * @param value  The value to cache
		 * @param ttlMs  Optional TTL in milliseconds
		 * @param tags   Optional tags for bulk invalidation
		 */
		set: async (
			key: string,
			text: string,
			value: JsonValue,
			ttlMs?: number,
			tags?: string[],
		): Promise<void> => {
			await this.req("POST", `/semantic/${encodeURIComponent(key)}`, {
				text,
				value,
				ttlMs,
				tags,
			});
		},
		/**
		 * Exact key lookup in semantic cache.
		 */
		get: async <T = JsonValue>(key: string): Promise<T | null> => {
			try {
				const res = await this.req<{ success: boolean; value: T }>(
					"GET",
					`/semantic/${encodeURIComponent(key)}`,
				);
				return res.value ?? null;
			} catch {
				return null;
			}
		},
		/**
		 * Find the most similar cached entry to a query string.
		 * Returns null if no entry exceeds the similarity threshold.
		 *
		 * @example
		 * // Stored: "What are your pricing plans?" → { starter: '$29', pro: '$99' }
		 * // Query:  "How much does it cost?"
		 * const result = await client.semantic.search("How much does it cost?");
		 * // → { value: {...}, similarity: 0.97, isExact: false }
		 */
		search: async <T = JsonValue>(
			query: string,
			threshold?: number,
		): Promise<SemanticGetResult<T> | null> => {
			try {
				const res = await this.req<SemanticGetResult<T> & { success: boolean }>(
					"POST",
					"/semantic/search",
					{ query, threshold },
				);
				return res;
			} catch {
				return null;
			}
		},
		/** Invalidate all semantic cache entries with a specific tag */
		invalidateByTag: async (tag: string): Promise<number> => {
			const res = await this.req<{ success: boolean; count: number }>(
				"DELETE",
				`/semantic/tags/${encodeURIComponent(tag)}`,
			);
			return res.count;
		},
		/** Delete a single semantic cache entry */
		del: async (key: string): Promise<void> => {
			await this.req("DELETE", `/semantic/${encodeURIComponent(key)}`);
		},
		/** Get semantic cache stats */
		stats: async () => {
			return this.req<{ success: boolean; size: number; keys: string[] }>(
				"GET",
				"/semantic/_stats",
			);
		},
	};

	// ─── Analytics ────────────────────────────────────────────────────────

	public analytics = {
		/**
		 * Get live usage counts for this tenant (from in-memory buffer).
		 * Updated in real time — no waiting for the 10s DB flush.
		 */
		usage: async (): Promise<Record<string, number>> => {
			const res = await this.req<{
				success: boolean;
				usage: Record<string, number>;
			}>("GET", "/analytics/usage");
			return res.usage;
		},
		/**
		 * Get anomaly detector stats — mean, stddev, and sample count
		 * for each monitored metric of this tenant.
		 */
		anomalies: async () => {
			return this.req<{
				success: boolean;
				metrics: Array<{
					metric: string;
					mean: number;
					stddev: number;
					n: number;
				}>;
			}>("GET", "/analytics/anomalies");
		},
		/**
		 * Subscribe to real-time anomaly alerts via SSE.
		 * The server fires an event whenever a metric exceeds 3σ.
		 *
		 * @example
		 * const sub = client.analytics.subscribeAlerts((alert) => {
		 *   console.log(`ALERT: ${alert.message}`);
		 * });
		 * sub.close();
		 */
		subscribeAlerts: (
			onAlert: (alert: {
				metric: string;
				current: number;
				mean: number;
				zScore: number;
				message: string;
			}) => void,
			onError?: (err: Error) => void,
		): { close: () => void } => {
			return this.openEventStream(
				"/analytics/anomalies/stream",
				(_event, data) => onAlert(data as Parameters<typeof onAlert>[0]),
				onError,
			);
		},
	};

	// ─── Internal SSE helper ─────────────────────────────────────────────

	/**
	 * Opens a persistent SSE connection and dispatches named events to a handler.
	 * Returns a controller with `.close()` to terminate the connection.
	 *
	 * Uses native fetch with a ReadableStream reader — works in Node 18+.
	 */
	private openEventStream(
		path: string,
		onEvent: (event: string, data: unknown) => void,
		onError?: (err: Error) => void,
	): { close: () => void } {
		const controller = new AbortController();
		const url = `${this.baseUrl}${path}`;

		const run = async () => {
			try {
				const res = await fetch(url, {
					headers: this.headers,
					signal: controller.signal,
				});

				if (!res.ok || !res.body) {
					throw new Error(
						`[erix-store] SSE ${path} → ${res.status}: ${res.statusText}`,
					);
				}

				const reader = res.body.getReader();
				const decoder = new TextDecoder();
				let buffer = "";
				let currentEvent = "message";

				while (true) {
					const { done, value } = await reader.read();
					if (done) break;

					buffer += decoder.decode(value, { stream: true });
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";

					for (const line of lines) {
						if (line.startsWith("event:")) {
							currentEvent = line.slice(6).trim();
						} else if (line.startsWith("data:")) {
							try {
								const data = JSON.parse(line.slice(5).trim());
								onEvent(currentEvent, data);
							} catch {
								// non-JSON data line, skip
							}
							currentEvent = "message";
						}
					}
				}
			} catch (err) {
				if (!controller.signal.aborted) {
					onError?.(err instanceof Error ? err : new Error(String(err)));
				}
			}
		};

		run();
		return { close: () => controller.abort() };
	}
}
