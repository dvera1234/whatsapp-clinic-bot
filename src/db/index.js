import pg from "pg";
import { DATABASE_URL } from "../config/env.js";

const { Pool } = pg;

function createPool() {
  if (!DATABASE_URL) {
    throw new Error("DATABASE_URL não configurado");
  }

  return new Pool({
    connectionString: DATABASE_URL,
    ssl: {
      rejectUnauthorized: false,
    },
  });
}

export const db = createPool();
