-- Aligne le schéma sur la production et durcit les accès.
-- Toutes les écritures passent par le bot (clé service_role, qui contourne la RLS) :
-- les rôles anon / authenticated sont strictement en lecture, et seulement sur les tournois publics.

-- 1. Statistiques de classement (créées à la main en production, jamais versionnées).
ALTER TABLE phase_teams
  ADD COLUMN IF NOT EXISTS played INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS wins INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS draws INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS losses INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS forfeits INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS score_for INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS score_against INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS differential INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS points INT DEFAULT 0;

-- 2. Profil public du serveur organisateur (renseigné par le bot) et invitation configurée par les TO.
ALTER TABLE server_settings
  ADD COLUMN IF NOT EXISTS guild_name TEXT,
  ADD COLUMN IF NOT EXISTS guild_icon TEXT,
  ADD COLUMN IF NOT EXISTS bot_present BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS invite_url TEXT;

ALTER TABLE server_settings DROP CONSTRAINT IF EXISTS server_settings_invite_url_check;
ALTER TABLE server_settings
  ADD CONSTRAINT server_settings_invite_url_check
  CHECK (invite_url IS NULL OR invite_url ~ '^https://(discord\.gg|discord\.com/invite)/[A-Za-z0-9-]+$');

-- 3. Repart d'un jeu de politiques connu : les bases existantes (production comprise) portent des politiques
-- créées à la main dans l'éditeur SQL, dont certaines autorisaient des écritures via la clé anon.
DO $$
DECLARE pol RECORD;
BEGIN
  FOR pol IN SELECT policyname, tablename FROM pg_policies WHERE schemaname = 'public' LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', pol.policyname, pol.tablename);
  END LOOP;
END $$;

-- Suppression du mécanisme admin_ids : la seule source de vérité des droits est guild_admins (synchronisée par le bot).
DROP FUNCTION IF EXISTS is_admin_of_tournament(UUID);
DROP FUNCTION IF EXISTS add_admin_to_all_tournaments(TEXT, TEXT);
DROP FUNCTION IF EXISTS remove_admin_from_all_tournaments(TEXT, TEXT);
ALTER TABLE tournaments DROP COLUMN IF EXISTS admin_ids;

-- 4. Politiques de lecture : uniquement les tournois publics et leurs données enfants.
CREATE OR REPLACE FUNCTION is_public_tournament(tid UUID)
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (SELECT 1 FROM tournaments WHERE id = tid AND is_public);
$$;

CREATE POLICY "Public server profiles are readable" ON server_settings
  FOR SELECT USING (true);
CREATE POLICY "Public tournaments are readable" ON tournaments
  FOR SELECT USING (is_public);
CREATE POLICY "Public phases are readable" ON phases
  FOR SELECT USING (is_public_tournament(tournament_id));
CREATE POLICY "Public teams are readable" ON teams
  FOR SELECT USING (is_public_tournament(tournament_id));
CREATE POLICY "Public groups are readable" ON groups
  FOR SELECT USING (is_public_tournament((SELECT tournament_id FROM phases WHERE id = phase_id)));
CREATE POLICY "Public phase_teams are readable" ON phase_teams
  FOR SELECT USING (is_public_tournament((SELECT tournament_id FROM phases WHERE id = phase_id)));
CREATE POLICY "Public matches are readable" ON matches
  FOR SELECT USING (is_public_tournament((SELECT tournament_id FROM phases WHERE id = phase_id)));
-- team_members (codes ami, IDs Discord) et guild_admins : aucune politique => illisibles hors service_role.

-- 5. Défense en profondeur : aucun droit d'écriture ni d'exécution RPC pour les clés publiques.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM anon, authenticated;
REVOKE SELECT ON team_members, guild_admins FROM anon, authenticated;
GRANT SELECT ON server_settings, tournaments, phases, teams, matches, groups, phase_teams TO anon, authenticated;

ALTER FUNCTION assign_team_to_match(UUID, UUID) SET search_path = public;
ALTER FUNCTION regenerate_phase_seeding(UUID, JSONB) SET search_path = public;
REVOKE EXECUTE ON FUNCTION assign_team_to_match(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION regenerate_phase_seeding(UUID, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION is_public_tournament(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION is_public_tournament(UUID) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION assign_team_to_match(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION regenerate_phase_seeding(UUID, JSONB) TO service_role;

-- 6. Realtime : seuls teams et matches sont diffusés (la RLS ci-dessus filtre les tournois privés).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'teams') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE teams;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND tablename = 'matches') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE matches;
    END IF;
  END IF;
END $$;
