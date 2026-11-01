import { createClient } from "@supabase/supabase-js";
import { botEnvironment } from "../config/runtime";

// Utilisation de la clé Service Role pour le bot (contourne les RLS)
export const supabase = createClient(botEnvironment.SUPABASE_URL, botEnvironment.SUPABASE_SERVICE_ROLE_KEY);
