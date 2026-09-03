export interface AppConfig {
  databaseUrl: string; // sqlite file path, or :memory:
  port: number;
  pepper: string;
  pageSize: number;
  maxPageSize: number;
  batchMaxItems: number;
  webhookTimeoutMs: number;
  webhookMaxAttempts: number;
}

function env(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === "" ? fallback : v;
}

export function loadConfig(): AppConfig {
  const pepper = env("CLAIMCHECK_PEPPER", "dev-pepper-change-me");
  if (pepper === "dev-pepper-change-me") {
    console.warn("WARNING: default API-key pepper; set CLAIMCHECK_PEPPER in production");
  }
  return {
    databaseUrl: env("CLAIMCHECK_DATABASE_URL", "./claimcheck.db"),
    port: Number(env("CLAIMCHECK_PORT", "8000")),
    pepper,
    pageSize: 50,
    maxPageSize: 200,
    batchMaxItems: 200,
    webhookTimeoutMs: 5000,
    webhookMaxAttempts: 8,
  };
}
