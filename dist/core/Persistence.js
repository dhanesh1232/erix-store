"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PersistenceManager = exports.SnapshotModel = void 0;
const mongoose_1 = __importDefault(require("mongoose"));
const SnapshotSchema = new mongoose_1.default.Schema({
    timestamp: { type: Date, default: Date.now },
    data: { type: mongoose_1.default.Schema.Types.Mixed, required: true },
});
exports.SnapshotModel = mongoose_1.default.model("ErixSnapshot", SnapshotSchema);
class PersistenceManager {
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
            await exports.SnapshotModel.create({ data: snapshotData });
            console.log("[Persistence] Snapshot saved to MongoDB");
            // Cleanup old snapshots (keep last 5)
            const count = await exports.SnapshotModel.countDocuments();
            if (count > 5) {
                const oldest = await exports.SnapshotModel.find()
                    .sort({ timestamp: 1 })
                    .limit(count - 5);
                await exports.SnapshotModel.deleteMany({
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
            const latest = await exports.SnapshotModel.findOne().sort({ timestamp: -1 });
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
exports.PersistenceManager = PersistenceManager;
