import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { resolvePublicSupabaseConfig } from "./config";

let cachedClient: SupabaseClient | null = null;
let cachedKey = "";

function getSupabaseClient(): SupabaseClient {
  const { supabaseUrl, supabaseAnonKey } = resolvePublicSupabaseConfig();
  const nextKey = `${supabaseUrl}::${supabaseAnonKey}`;
  if (!cachedClient || cachedKey !== nextKey) {
    cachedClient = createClient(supabaseUrl, supabaseAnonKey);
    cachedKey = nextKey;
  }
  return cachedClient;
}

// Client public (clé anon) : lecture seule des tournois publics et Realtime, filtrés par la RLS (SEC-10 / SEC-12).
// Les données privées sont lues côté serveur via supabaseAdmin, après vérification d'accès (lib/viewer.ts).
export const supabase: SupabaseClient = new Proxy({} as SupabaseClient, {
  get(_target, prop, receiver) {
    const client = getSupabaseClient();
    const value = Reflect.get(client, prop, receiver);
    return typeof value === "function" ? value.bind(client) : value;
  },
});
