import { Redis } from "@upstash/redis";

export function getRedisClient() {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Upstash ENV ausente (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN).");
  }

  return new Redis({ url, token });
}
