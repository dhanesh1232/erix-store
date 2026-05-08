import mongoose from "mongoose";
const SnapshotSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
});
export const SnapshotModel = mongoose.model("ErixSnapshot", SnapshotSchema);
export class PersistenceManager {
    store;
    rateLimiter;
    queueV2;
    lock;
    cache;
    saveInterval = null;
    constructor(store, rateLimiter, enhanced) {
        this.store = store;
        this.rateLimiter = rateLimiter;
        this.queueV2 = enhanced?.queueV2;
        this.lock = enhanced?.lock;
        this.cache = enhanced?.cache;
    }
    async startAutoSave(intervalMs = 5 * 60 * 1000) {
        console.log(`[Persistence] Starting auto-save every ${intervalMs / 1000}s`);
        this.saveInterval = setInterval(() => this.save(), intervalMs);
    }
    async save() {
        try {
            console.log("[Persistence] Creating snapshot...");
            const snapshotData = {
                store: this.store.exportAll(),
                rateLimits: this.rateLimiter.export(),
            };
            // Save enhanced services if available
            if (this.queueV2) {
                snapshotData.queueV2 = this.queueV2.export();
            }
            if (this.lock) {
                snapshotData.lock = this.lock.export();
            }
            if (this.cache) {
                snapshotData.cache = this.cache.export();
            }
            await SnapshotModel.create({ data: snapshotData });
            console.log("[Persistence] Snapshot saved to MongoDB");
            // Cleanup old snapshots (keep last 5)
            const count = await SnapshotModel.countDocuments();
            if (count > 5) {
                const oldest = await SnapshotModel.find()
                    .sort({ timestamp: 1 })
                    .limit(count - 5);
                await SnapshotModel.deleteMany({
                    _id: { $in: oldest.map((s) => s._id) },
                });
            }
        }
        catch (error) {
            console.error("[Persistence] Failed to save snapshot:", error);
        }
    }
    async restore() {
        try {
            console.log("[Persistence] Restoring from latest snapshot...");
            const latest = await SnapshotModel.findOne().sort({ timestamp: -1 });
            if (!latest) {
                console.log("[Persistence] No snapshot found to restore.");
                return;
            }
            // Handle both old and new snapshot formats
            const data = latest.data;
            if (!data) {
                console.log("[Persistence] Snapshot data is empty, skipping restore.");
                return;
            }
            // Safely restore each component
            if (data.store) {
                this.store.importAll(data.store);
                console.log("[Persistence] Store data restored.");
            }
            if (data.rateLimits) {
                this.rateLimiter.import(data.rateLimits);
                console.log("[Persistence] Rate limiter data restored.");
            }
            // Restore enhanced services if available
            if (data.queueV2 && this.queueV2) {
                this.queueV2.import(data.queueV2);
                console.log("[Persistence] QueueV2 data restored.");
            }
            if (data.lock && this.lock) {
                this.lock.import(data.lock);
                console.log("[Persistence] Lock data restored.");
            }
            if (data.cache && this.cache) {
                this.cache.import(data.cache);
                console.log("[Persistence] Cache data restored.");
            }
            console.log("[Persistence] Restore complete.");
        }
        catch (error) {
            console.error("[Persistence] Failed to restore snapshot:", error);
            console.log("[Persistence] Starting with fresh state.");
        }
    }
    stopAutoSave() {
        if (this.saveInterval)
            clearInterval(this.saveInterval);
    }
}
