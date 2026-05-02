"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv_1 = __importDefault(require("dotenv"));
const mongoose_1 = __importDefault(require("mongoose"));
const app_js_1 = require("./server/app.js");
const Store_js_1 = require("./core/Store.js");
const JobQueue_js_1 = require("./services/JobQueue.js");
const PubSub_js_1 = require("./services/PubSub.js");
const RateLimiter_js_1 = require("./services/RateLimiter.js");
const Persistence_js_1 = require("./core/Persistence.js");
dotenv_1.default.config();
const PORT = process.env.PORT || 6399;
const MONGO_URI = process.env.MONGODB_URI;
async function bootstrap() {
    if (!MONGO_URI) {
        console.error("MONGODB_URI is not defined in .env");
        process.exit(1);
    }
    try {
        // Connect to MongoDB
        await mongoose_1.default.connect(MONGO_URI);
        console.log("[ErixStore] Connected to MongoDB");
        // Initialize Components
        const store = new Store_js_1.ErixStore();
        const queue = new JobQueue_js_1.JobQueueService();
        const pubsub = new PubSub_js_1.PubSubService();
        const rateLimiter = new RateLimiter_js_1.RateLimiterService();
        const persistence = new Persistence_js_1.PersistenceManager(store, queue, rateLimiter);
        // Restore from snapshot
        await persistence.restore();
        // Start Auto-save (5 mins)
        persistence.startAutoSave();
        // Create & Start Server
        const app = (0, app_js_1.createApp)(store, queue, pubsub, rateLimiter);
        app.listen(PORT, () => {
            console.log(`🚀 ErixStore running on http://localhost:${PORT}`);
        });
        // Graceful Shutdown
        process.on("SIGINT", async () => {
            console.log("\n[ErixStore] Shutting down...");
            persistence.stopAutoSave();
            await persistence.save();
            await mongoose_1.default.disconnect();
            process.exit(0);
        });
    }
    catch (error) {
        console.error("[ErixStore] Bootstrap failed:", error);
        process.exit(1);
    }
}
bootstrap();
