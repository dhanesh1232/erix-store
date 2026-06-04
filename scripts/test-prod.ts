/**
 * Test erix-store production via @ecodrix/erix-client
 * against https://store.ecodrix.com
 */

import { ErixClient } from "@ecodrix/erix-client";

const store = new ErixClient({
  baseUrl: "https://store.ecodrix.com",
  apiKey: "ecod_live_sk_a5c4f3262dda08ef82918632fcc366b1e8fddd7756383197",
  tenantId: "DHANESHM_E16CD5",
  transport: "http",
  timeoutMs: 15_000,
});

async function main() {
  console.log("─── Production ERIX Store Test ───");
  console.log("  URL: https://store.ecodrix.com");
  console.log("  Tenant: DHANESHM_E16CD5");
  console.log("");

  // 1. Ping
  const ping = await store.ping();
  console.log("✅ PING:", ping);

  // 2. SET
  await store.set("prod:test:hello", "world from npm package");
  console.log("✅ SET prod:test:hello");

  // 3. GET
  const val = await store.get("prod:test:hello");
  console.log("✅ GET prod:test:hello =", val);

  // 4. Hash
  await store.hash.hset("prod:test:user", "name", "Dhanesh");
  await store.hash.hset("prod:test:user", "source", "npm-package-test");
  const user = await store.hash.hgetall("prod:test:user");
  console.log("✅ HGETALL prod:test:user =", user);

  // 5. List
  await store.list.lpush(
    "prod:test:queue",
    JSON.stringify({ job: "email", ts: Date.now() }),
  );
  const popped = await store.list.lpop("prod:test:queue");
  console.log("✅ LPUSH + LPOP prod:test:queue =", popped);

  // 6. Cleanup
  await store.del("prod:test:hello");
  await store.del("prod:test:user");
  await store.del("prod:test:queue");
  console.log("✅ DEL cleanup done");

  console.log("");
  console.log("🎉 All production tests passed via @ecodrix/erix-client!");
}

main().catch((err) => {
  console.error("❌ FAILED:", err.message);
  process.exit(1);
});
