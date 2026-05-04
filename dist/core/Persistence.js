import mongoose from "mongoose";
const SnapshotSchema = new mongoose.Schema({
    timestamp: { type: Date, default: Date.now },
    data: { type: mongoose.Schema.Types.Mixed, required: true },
});
export const SnapshotModel = mongoose.model("ErixSnapshot", SnapshotSchema);
export class PersistenceManager {
    store;
    queue;
    rateLimiter;
    saveInterval = null;
    constructor(store, queue, rateLimiter) {
        this.store = store;
        this.queue = queue;
        this.rateLimiter = rateLimiter;
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
                queues: this.queue.export(),
                rateLimits: this.rateLimiter.export(),
            };
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
            const { store, queues, rateLimits } = latest.data;
            if (store)
                this.store.importAll(store);
            if (queues)
                this.queue.import(queues);
            if (rateLimits)
                this.rateLimiter.import(rateLimits);
            console.log("[Persistence] Restore complete.");
        }
        catch (error) {
            console.error("[Persistence] Failed to restore snapshot:", error);
        }
    }
    stopAutoSave() {
        if (this.saveInterval)
            clearInterval(this.saveInterval);
    }
}
