import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const databaseUrl =
  process.env.DATABASE_URL ?? "postgres://berry:berry@localhost:5432/berry";

const client = postgres(databaseUrl, { max: 1 });
const db = drizzle(client);

await migrate(db, { migrationsFolder: new URL("../../drizzle", import.meta.url).pathname });

await client.end();
console.log("Migrations applied.");
