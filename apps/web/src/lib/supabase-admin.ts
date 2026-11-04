import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolveServerSupabaseAdminConfig } from "./config";

let cachedAdminClient: SupabaseClient | null = null;
let cachedAdminKey = "";

function getSupabaseAdminClient(): SupabaseClient {
  const { supabaseUrl, supabaseServiceKey } = resolveServerSupabaseAdminConfig();
  const nextKey = `${supabaseUrl}::${supabaseServiceKey}`;
  if (!cachedAdminClient || cachedAdminKey !== nextKey) {
    cachedAdminClient = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    cachedAdminKey = nextKey;
  }
  return cachedAdminClient;
}

// Attention: Ce client contourne TOUTES les règles RLS !
// Il ne doit être utilisé QUE côté serveur après avoir vérifié les permissions manuellement (lib/viewer.ts).
// Résolu paresseusement au runtime (OPS-06) pour ne jamais rester figé sur une URL de build.
export const supabaseAdmin: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getSupabaseAdminClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
