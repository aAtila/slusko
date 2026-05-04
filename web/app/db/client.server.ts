import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to connect to Postgres");
}

export const sqlClient = postgres(databaseUrl, {
  max: 10,
});

export const db = drizzle(sqlClient, { schema });
