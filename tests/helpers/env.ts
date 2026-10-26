// Typed access to the env the suite needs (loaded from .env.local / .env by vitest.config.mts).
// Getters read lazily so pure unit tests never fail on a missing DB/Supabase variable.

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name} (expected in .env.local, see .env.example)`);
  return v;
}

export const env = {
  get supabaseUrl(): string {
    return required("NEXT_PUBLIC_SUPABASE_URL").replace(/\/+$/, "");
  },
  get publishableKey(): string {
    return required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  },
  get secretKey(): string {
    return required("SUPABASE_SECRET_KEY");
  },
  get databaseUrl(): string {
    return required("DATABASE_URL");
  },
  get gatewayKey(): string {
    return required("GATEWAY_X_SIGNATURE_KEY");
  },
  get seedPassword(): string {
    return required("SEED_PASSWORD");
  },
  /** Set by tests/setup/global.ts to whichever server answered (3000, or the 3100 fallback). */
  get baseUrl(): string {
    return (process.env.TEST_BASE_URL || "http://127.0.0.1:3000").replace(/\/+$/, "");
  },
};
