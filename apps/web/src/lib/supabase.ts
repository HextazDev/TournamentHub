import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://placeholder.supabase.co";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || "placeholder-anon-key";

// Client public (clé anon) : lecture seule des tournois publics et Realtime, filtrés par la RLS (SEC-10 / SEC-12).
// Les données privées sont lues côté serveur via supabaseAdmin, après vérification d'accès (lib/viewer.ts).
export const supabase = createClient(supabaseUrl, supabaseAnonKey);
