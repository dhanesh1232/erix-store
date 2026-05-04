import { Router } from "express";
import type { JobQueueService } from "../../services/JobQueue.js";
import { getTenantKey } from "../middleware/auth.js";

export const createQueueRoutes = (queue: JobQueueService) => {
	const router = Router();

	router.post("/push", (req, res) => {
		const { queue: queueName, data } = req.body;
		const tenantQueue = getTenantKey((req as any).tenantId, queueName);
		queue.push(tenantQueue, data);
		res.json({ success: true });
	});

	router.get("/pop", (req, res) => {
		const { queue: queueName } = req.query;
		const tenantQueue = getTenantKey(
			(req as any).tenantId,
			queueName as string,
		);
		res.json({ data: queue.pop(tenantQueue) });
	});

	return router;
};
