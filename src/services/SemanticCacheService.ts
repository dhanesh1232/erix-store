/**
 * SemanticCacheService
 *
 * Extends the standard CacheService with embedding-based similarity lookup.
 * Uses Google's text-embedding-004 model (768-dim vectors).
 *
 * On a semantic miss the entry is computed and stored exactly once (single-flight).
 * All lookups use cosine similarity — O(n) over cached vector index.
 *
 * For < 10,000 entries this is fast enough in-process. At larger scales
 * migrate the vector index to pgvector.
 */

export interface SemanticEntry {
	key: string;
	text: string; // the text that was embedded
	embedding: Float32Array;
}

export interface SemanticGetResult<T> {
	value: T;
	key: string;
	similarity: number;
	isExact: boolean;
}

export class SemanticCacheService {
	/** key → { text, embedding } */
	private vectorIndex = new Map<string, SemanticEntry>();
	/** key → value */
	private valueStore = new Map<string, unknown>();
	/** key → expiresAt (ms epoch) */
	private expiry = new Map<string, number>();
	/** key → tags */
	private tagIndex = new Map<string, Set<string>>(); // tag → keys

	private apiKey: string;
	private similarityThreshold: number;

	constructor(options: {
		googleApiKey: string;
		similarityThreshold?: number;
	}) {
		this.apiKey = options.googleApiKey;
		this.similarityThreshold = options.similarityThreshold ?? 0.92;
	}

	// ─── Public API ────────────────────────────────────────────────────────

	/**
	 * Store a value alongside its embedding.
	 * @param key       Unique cache key
	 * @param text      The text to embed (query, question, prompt, etc.)
	 * @param value     The value to store
	 * @param ttlMs     Optional TTL in milliseconds
	 * @param tags      Optional tags for bulk invalidation
	 */
	async set(
		key: string,
		text: string,
		value: unknown,
		ttlMs?: number,
		tags: string[] = [],
	): Promise<void> {
		const embedding = await this.embed(text);
		this.vectorIndex.set(key, { key, text, embedding });
		this.valueStore.set(key, value);
		if (ttlMs) this.expiry.set(key, Date.now() + ttlMs);

		// Update tag index
		for (const tag of tags) {
			if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
			this.tagIndex.get(tag)!.add(key);
		}
	}

	/**
	 * Exact key lookup (standard cache behaviour).
	 */
	get<T = unknown>(key: string): T | null {
		if (!this.valueStore.has(key)) return null;
		const exp = this.expiry.get(key);
		if (exp && Date.now() > exp) {
			this.delete(key);
			return null;
		}
		return this.valueStore.get(key) as T;
	}

	/**
	 * Semantic lookup — finds the most similar cached entry.
	 * Returns null if no entry exceeds the similarity threshold.
	 */
	async semanticGet<T = unknown>(
		query: string,
		threshold?: number,
	): Promise<SemanticGetResult<T> | null> {
		const minSim = threshold ?? this.similarityThreshold;
		if (this.vectorIndex.size === 0) return null;

		const queryVec = await this.embed(query);
		let bestScore = 0;
		let bestKey: string | null = null;

		for (const [key, entry] of this.vectorIndex.entries()) {
			// Skip expired
			const exp = this.expiry.get(key);
			if (exp && Date.now() > exp) continue;

			const score = cosineSimilarity(queryVec, entry.embedding);
			if (score > bestScore) {
				bestScore = score;
				bestKey = key;
			}
		}

		if (bestScore < minSim || !bestKey) return null;
		const value = this.get<T>(bestKey);
		if (value === null) return null;

		return {
			value,
			key: bestKey,
			similarity: bestScore,
			isExact: bestScore >= 0.9999,
		};
	}

	/**
	 * Invalidate all keys with a specific tag.
	 */
	invalidateByTag(tag: string): number {
		const keys = this.tagIndex.get(tag) ?? new Set();
		let count = 0;
		for (const key of keys) {
			this.delete(key);
			count++;
		}
		this.tagIndex.delete(tag);
		return count;
	}

	delete(key: string): void {
		this.vectorIndex.delete(key);
		this.valueStore.delete(key);
		this.expiry.delete(key);
	}

	keys(): string[] {
		return [...this.vectorIndex.keys()];
	}

	size(): number {
		return this.valueStore.size;
	}

	// ─── Embeddings ────────────────────────────────────────────────────────

	/**
	 * Call Google's text-embedding-004 via the REST API.
	 * Returns a Float32Array of 768 dimensions.
	 */
	private async embed(text: string): Promise<Float32Array> {
		const url = `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${this.apiKey}`;
		const res = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				model: "models/text-embedding-004",
				content: { parts: [{ text }] },
			}),
		});

		if (!res.ok) {
			const body = (await res.json().catch(() => ({}))) as { error?: { message: string } };
			throw new Error(
				`[SemanticCache] Embedding API error ${res.status}: ${body.error?.message ?? res.statusText}`,
			);
		}

		const data = (await res.json()) as {
			embedding: { values: number[] };
		};
		return new Float32Array(data.embedding.values);
	}
}

// ─── Math ───────────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length Float32Arrays.
 * Returns 1.0 for identical vectors, 0.0 for orthogonal.
 */
function cosineSimilarity(a: Float32Array, b: Float32Array): number {
	let dot = 0;
	let normA = 0;
	let normB = 0;

	for (let i = 0; i < a.length; i++) {
		dot += a[i] * b[i];
		normA += a[i] * a[i];
		normB += b[i] * b[i];
	}

	const denom = Math.sqrt(normA) * Math.sqrt(normB);
	if (denom === 0) return 0;
	return dot / denom;
}
