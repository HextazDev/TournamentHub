-- Vérifie les invariants SEC-07 / SEC-10 / SEC-12 sur une base où toutes les migrations sont appliquées.
-- Usage : make db-test-rls (base jetable, ON_ERROR_STOP) ; toute violation lève une exception.
-- Les assertions ne portent que sur les fixtures et tout est annulé (ROLLBACK) : le script peut viser une base existante.
BEGIN;

INSERT INTO tournaments (id, guild_id, name, is_public) VALUES
  ('00000000-0000-0000-0000-0000000000a1', 'g-public', 'Public', TRUE),
  ('00000000-0000-0000-0000-0000000000b2', 'g-private', 'Private', FALSE);
INSERT INTO phases (id, tournament_id, name, phase_order, format) VALUES
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000000a1', 'P', 1, 'SINGLE_ELIM'),
  ('00000000-0000-0000-0000-0000000001b2', '00000000-0000-0000-0000-0000000000b2', 'P', 1, 'SINGLE_ELIM');
INSERT INTO teams (id, tournament_id, name, captain_discord_id) VALUES
  ('00000000-0000-0000-0000-0000000002a1', '00000000-0000-0000-0000-0000000000a1', 'A', '1'),
  ('00000000-0000-0000-0000-0000000002b2', '00000000-0000-0000-0000-0000000000b2', 'B', '2');
INSERT INTO team_members (team_id, ingame_name, friend_code) VALUES
  ('00000000-0000-0000-0000-0000000002a1', 'a', 'SW-0000-0000-0001');
INSERT INTO matches (phase_id, team1_id) VALUES
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1'),
  ('00000000-0000-0000-0000-0000000001b2', '00000000-0000-0000-0000-0000000002b2');
INSERT INTO server_settings (guild_id) VALUES ('g-public');
INSERT INTO guild_admins (guild_id, discord_id, reason) VALUES ('g-public', '1', 'TO_ROLE');

SET LOCAL ROLE anon;

DO $$
BEGIN
  -- SEC-10 : seules les données des tournois publics sont lisibles.
  IF (SELECT count(*) FROM tournaments WHERE guild_id IN ('g-public', 'g-private')) <> 1 THEN RAISE EXCEPTION 'SEC-10: tournoi privé lisible'; END IF;
  IF (SELECT count(*) FROM phases WHERE id::text LIKE '00000000-0000-0000-0000-0000000001%') <> 1 THEN RAISE EXCEPTION 'SEC-10: phase privée lisible'; END IF;
  IF (SELECT count(*) FROM teams WHERE id::text LIKE '00000000-0000-0000-0000-0000000002%') <> 1 THEN RAISE EXCEPTION 'SEC-10: équipe privée lisible'; END IF;
  IF (SELECT count(*) FROM matches WHERE phase_id::text LIKE '00000000-0000-0000-0000-0000000001%') <> 1 THEN RAISE EXCEPTION 'SEC-10: match privé lisible'; END IF;
  IF (SELECT count(*) FROM server_settings WHERE guild_id = 'g-public') <> 1 THEN RAISE EXCEPTION 'profil serveur illisible'; END IF;
END $$;

-- SEC-10 : codes ami et liste des admins jamais lisibles via les clés publiques.
DO $$
BEGIN
  PERFORM 1 FROM team_members;
  RAISE EXCEPTION 'SEC-10: team_members lisible';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  PERFORM 1 FROM guild_admins;
  RAISE EXCEPTION 'SEC-10: guild_admins lisible';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

-- SEC-07 / SEC-12 : aucune écriture ni RPC via les clés publiques.
DO $$
BEGIN
  INSERT INTO tournaments (guild_id, name) VALUES ('g-x', 'x');
  RAISE EXCEPTION 'SEC-12: insertion de tournoi autorisée';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  UPDATE server_settings SET to_role_id = 'g-public' WHERE guild_id = 'g-public';
  RAISE EXCEPTION 'SEC-12: modification de server_settings autorisée';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  INSERT INTO server_settings (guild_id) VALUES ('g-new');
  RAISE EXCEPTION 'SEC-12: insertion de server_settings autorisée';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  INSERT INTO guild_admins (guild_id, discord_id, reason) VALUES ('g-public', '9', 'TO_ROLE');
  RAISE EXCEPTION 'SEC-12: insertion dans guild_admins autorisée';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  PERFORM regenerate_phase_seeding('00000000-0000-0000-0000-0000000001a1', '[]'::jsonb);
  RAISE EXCEPTION 'SEC-12: RPC regenerate_phase_seeding exécutable';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

RESET ROLE;
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF (SELECT count(*) FROM tournaments WHERE guild_id IN ('g-public', 'g-private')) <> 1 THEN RAISE EXCEPTION 'SEC-10: tournoi privé lisible (authenticated)'; END IF;
  UPDATE matches SET team1_score = 5 WHERE phase_id = '00000000-0000-0000-0000-0000000001a1';
  RAISE EXCEPTION 'SEC-12: modification de match autorisée (authenticated)';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

RESET ROLE;
-- I18N-05 / contrainte d'invitation.
DO $$
BEGIN
  UPDATE server_settings SET invite_url = 'https://evil.example/x' WHERE guild_id = 'g-public';
  RAISE EXCEPTION 'invite_url hors Discord acceptée';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$
BEGIN
  UPDATE tournaments SET language = 'de' WHERE guild_id = 'g-public';
  RAISE EXCEPTION 'I18N-05: langue invalide acceptée';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

SELECT 'RLS OK' AS result;
ROLLBACK;
