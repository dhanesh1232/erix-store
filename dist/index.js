import dotenv from "dotenv";
import mongoose from "mongoose";
import { PersistenceManager } from "./core/Persistence.js";
import { ErixStore } from "./core/Store.js";
import { createApp } from "./server/app.js";
import { CacheService } from "./services/CacheService.js";
import { DistributedLockService } from "./services/DistributedLock.js";
import { JobQueueV2 } from "./services/JobQueueV2.js";
import { PubSubService } from "./services/PubSub.js";
import { RateLimiterService } from "./services/RateLimiter.js";
dotenv.config();
const PORT = process.env.PORT || 6399;
const MONGO_URI = process.env.MONGODB_URI;
async function bootstrap() {
    if (!MONGO_URI) {
        console.error("MONGODB_URI is not defined in .env");
        process.exit(1);
    }
    try {
        // Connect to MongoDB
        await mongoose.connect(MONGO_URI);
        console.log("[ErixStore] Connected to MongoDB");
        // Initialize Components
        const store = new ErixStore();
        const queueV2 = new JobQueueV2({
            maxConcurrency: 10,
            defaultMaxAttempts: 3,
            retryBackoff: "exponential",
            dlqEnabled: true,
        });
        const pubsub = new PubSubService();
        const rateLimiter = new RateLimiterService();
        const lock = new DistributedLockService();
        const cache = new CacheService({
            strategy: "LRU",
            maxSize: 500 * 1024 * 1024, // 500MB
            maxEntries: 50000,
            defaultTTL: 3600000, // 1 hour
            enableStats: true,
        });
        const persistence = new PersistenceManager(store, rateLimiter, {
            queueV2,
            lock,
            cache,
        });
        // Restore from snapshot
        await persistence.restore();
        // Start Auto-save (5 mins)
        persistence.startAutoSave();
        // Setup event listeners for monitoring
        queueV2.on("job:completed", (job) => {
            console.log(`[Queue] Job completed: ${job.id}`);
        });
        queueV2.on("job:failed", (job) => {
            console.error(`[Queue] Job failed: ${job.id} - ${job.error}`);
        });
        queueV2.on("job:dlq", (job) => {
            console.error(`[Queue] Job moved to DLQ: ${job.id}`);
        });
        lock.on("lock:acquired", ({ key }) => {
            console.log(`[Lock] Acquired: ${key}`);
        });
        cache.on("cache:evicted", ({ strategy, count }) => {
            console.log(`[Cache] Evicted ${count} entries using ${strategy}`);
        });
        // Create & Start Server
        const app = createApp(store, pubsub, rateLimiter, {
            queueV2,
            lock,
            cache,
        });
        app.listen(PORT, () => {
            console.log(`🚀 ErixStore running on http://localhost:${PORT}`);
            console.log(`📊 Features enabled:`);
            console.log(`   - Advanced Job Queue (Priority, Delays, DLQ)`);
            console.log(`   - Distributed Locks (Mutex, RW, Semaphore)`);
            console.log(`   - Intelligent Cache (LRU, Tag-based)`);
            console.log(`   - Pub/Sub Messaging`);
            console.log(`   - Rate Limiting`);
        });
        // Graceful Shutdown
        process.on("SIGINT", async () => {
            console.log("\n[ErixStore] Shutting down...");
            persistence.stopAutoSave();
            await persistence.save();
            // Cleanup services
            queueV2.destroy();
            lock.destroy();
            cache.destroy();
            await mongoose.disconnect();
            process.exit(0);
        });
    }
    catch (error) {
        console.error("[ErixStore] Bootstrap failed:", error);
        process.exit(1);
    }
}
bootstrap();
