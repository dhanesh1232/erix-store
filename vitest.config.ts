import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		globals: true,
		environment: "node",
		testTimeout: 30000,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts", "client/src/**/*.ts", "worker/src/**/*.ts"],
			exclude: ["**/node_modules/**", "**/dist/**"],
		},
	},
});
