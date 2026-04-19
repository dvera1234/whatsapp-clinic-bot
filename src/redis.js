import { Redis } from "@upstash/redis";
import {
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
} from "./config/env.js";

function readString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function getRedisClient() {
  const url = readString(UPSTASH_REDIS_REST_URL);
  const token = readString(UPSTASH_REDIS_REST_TOKEN);

  if (!url) {
    throw new Error("UPSTASH_REDIS_REST_URL_MISSING");
  }

  if (!token) {
    throw new Error("UPSTASH_REDIS_REST_TOKEN_MISSING");
  }

  return new Redis({
    url,
    token,
  });
}

export const redis = getRedisClient();
