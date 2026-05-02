import dotenv from "dotenv";
import mongoose from "mongoose";
import { createApp } from "./server/app.js";
import { ErixStore } from "./core/Store.js";
import { JobQueueService } from "./services/JobQueue.js";
import { PubSubService } from "./services/PubSub.js";
import { RateLimiterService } from "./services/RateLimiter.js";
import { PersistenceManager } from "./core/Persistence.js";

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
    const queue = new JobQueueService();
    const pubsub = new PubSubService();
    const rateLimiter = new RateLimiterService();
    const persistence = new PersistenceManager(store, queue, rateLimiter);

    // Restore from snapshot
    await persistence.restore();

    // Start Auto-save (5 mins)
    persistence.startAutoSave();

    // Create & Start Server
    const app = createApp(store, queue, pubsub, rateLimiter);
    app.listen(PORT, () => {
      console.log(`🚀 ErixStore running on http://localhost:${PORT}`);
    });

    // Graceful Shutdown
    process.on("SIGINT", async () => {
      console.log("\n[ErixStore] Shutting down...");
      persistence.stopAutoSave();
      await persistence.save();
      await mongoose.disconnect();
      process.exit(0);
    });
  } catch (error) {
    console.error("[ErixStore] Bootstrap failed:", error);
    process.exit(1);
  }
}

bootstrap();
