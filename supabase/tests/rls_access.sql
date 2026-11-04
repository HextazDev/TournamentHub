-- Vérifie les invariants SEC-07 / SEC-10 / SEC-12 / SEC-20 / SEC-24 / SEC-27 / SEC-28 / SEC-29
-- sur une base où toutes les migrations sont appliquées.
-- Usage : make db-test-rls (base jetable, ON_ERROR_STOP) ; toute violation lève une exception.
-- Les assertions ne portent que sur les fixtures et tout est annulé (ROLLBACK) : le script peut viser une base existante.
BEGIN;

INSERT INTO organizations (id, slug, name, language) VALUES
  ('00000000-0000-0000-0000-000000000011', 'org-public', 'Public Org', 'fr'),
  ('00000000-0000-0000-0000-000000000022', 'org-private', 'Private Org', 'en');

INSERT INTO organization_members (organization_id, user_id, role) VALUES
  ('00000000-0000-0000-0000-000000000011', 'owner-1', 'ORG_OWNER'),
  ('00000000-0000-0000-0000-000000000022', 'owner-2', 'ORG_OWNER');

INSERT INTO organization_integrations (id, organization_id, provider, external_id, enabled, status) VALUES
  ('00000000-0000-0000-0000-000000000311', '00000000-0000-0000-0000-000000000011', 'DISCORD', 'g-public', TRUE, 'CONNECTED'),
  ('00000000-0000-0000-0000-000000000322', '00000000-0000-0000-0000-000000000022', 'DISCORD', 'g-private', TRUE, 'CONNECTED');

INSERT INTO organization_integration_secrets (integration_id, encrypted_payload) VALUES
  ('00000000-0000-0000-0000-000000000311', 'v1:iv:tag:ciphertext');

INSERT INTO tournaments (id, organization_id, guild_id, name, is_public) VALUES
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000011', 'g-public', 'Public', TRUE),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-000000000022', 'g-private', 'Private', FALSE);

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

INSERT INTO integration_access_grants (organization_id, provider, user_id, scope_type, granted_role, reason) VALUES
  ('00000000-0000-0000-0000-000000000011', 'DISCORD', '1', 'ORGANIZATION', 'ORG_TO', 'TO_ROLE');

-- SEC-24 : le motif TOURNAMENT_TO_ROLE est accepté pour service_role sur un grant de portée TOURNAMENT.
INSERT INTO integration_access_grants (organization_id, provider, user_id, scope_type, tournament_id, granted_role, reason) VALUES
  ('00000000-0000-0000-0000-000000000011', 'DISCORD', '2', 'TOURNAMENT', '00000000-0000-0000-0000-0000000000a1', 'TOURNAMENT_TO', 'TOURNAMENT_TO_ROLE');

DO $$
BEGIN
  INSERT INTO integration_access_grants (organization_id, provider, user_id, scope_type, granted_role, reason) VALUES
    ('00000000-0000-0000-0000-000000000011', 'DISCORD', '3', 'ORGANIZATION', 'ORG_TO', 'UNKNOWN_REASON');
  RAISE EXCEPTION 'SEC-24: motif integration_access_grants inconnu accepté';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- SEC-29 : un même guild_id Discord ne peut pas être rattaché à deux organisations.
DO $$
BEGIN
  INSERT INTO organization_integrations (organization_id, provider, external_id, enabled) VALUES
    ('00000000-0000-0000-0000-000000000022', 'DISCORD', 'g-public', TRUE);
  RAISE EXCEPTION 'SEC-29: même external_id Discord accepté sur deux organisations';
EXCEPTION WHEN unique_violation THEN NULL;
END $$;

-- SEC-27 : impossible de supprimer ou rétrograder le dernier ORG_OWNER d'une organisation active.
DO $$
DECLARE
  v_caught boolean := false;
BEGIN
  BEGIN
    DELETE FROM organization_members
    WHERE organization_id = '00000000-0000-0000-0000-000000000011' AND user_id = 'owner-1';
  EXCEPTION WHEN raise_exception THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'SEC-27: suppression du dernier ORG_OWNER acceptée';
  END IF;
END $$;

DO $$
DECLARE
  v_caught boolean := false;
BEGIN
  BEGIN
    UPDATE organization_members
    SET role = 'ORG_ADMIN'
    WHERE organization_id = '00000000-0000-0000-0000-000000000011' AND user_id = 'owner-1';
  EXCEPTION WHEN raise_exception THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'SEC-27: rétrogradation du dernier ORG_OWNER acceptée';
  END IF;
END $$;

SET LOCAL ROLE anon;

DO $$
BEGIN
  -- SEC-10 : seules les données des tournois publics et le profil public d'organisation sont lisibles.
  IF (SELECT count(*) FROM tournaments WHERE organization_id IN ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000022')) <> 1 THEN
    RAISE EXCEPTION 'SEC-10: tournoi privé lisible';
  END IF;
  IF (SELECT count(*) FROM phases WHERE id::text LIKE '00000000-0000-0000-0000-0000000001%') <> 1 THEN RAISE EXCEPTION 'SEC-10: phase privée lisible'; END IF;
  IF (SELECT count(*) FROM teams WHERE id::text LIKE '00000000-0000-0000-0000-0000000002%') <> 1 THEN RAISE EXCEPTION 'SEC-10: équipe privée lisible'; END IF;
  IF (SELECT count(*) FROM matches WHERE phase_id::text LIKE '00000000-0000-0000-0000-0000000001%') <> 1 THEN RAISE EXCEPTION 'SEC-10: match privé lisible'; END IF;
  IF (SELECT count(*) FROM organizations WHERE slug = 'org-public') <> 1 THEN RAISE EXCEPTION 'profil organisation illisible'; END IF;
END $$;

-- SEC-10 / SEC-28 : codes ami, membres d'organisation, grants et secrets d'intégration jamais lisibles via les clés publiques.
DO $$
BEGIN
  PERFORM 1 FROM team_members;
  RAISE EXCEPTION 'SEC-10: team_members lisible';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  PERFORM 1 FROM organization_members;
  RAISE EXCEPTION 'SEC-10: organization_members lisible';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  PERFORM 1 FROM integration_access_grants;
  RAISE EXCEPTION 'SEC-10: integration_access_grants lisible';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  PERFORM 1 FROM organization_integration_secrets;
  RAISE EXCEPTION 'SEC-28: organization_integration_secrets lisible';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

-- SEC-07 / SEC-12 : aucune écriture ni RPC via les clés publiques.
DO $$
BEGIN
  INSERT INTO tournaments (organization_id, name) VALUES ('00000000-0000-0000-0000-000000000011', 'x');
  RAISE EXCEPTION 'SEC-12: insertion de tournoi autorisée';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  UPDATE organizations SET name = 'Hacked' WHERE slug = 'org-public';
  RAISE EXCEPTION 'SEC-12: modification de organizations autorisée';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  INSERT INTO organizations (slug, name) VALUES ('org-new', 'New Org');
  RAISE EXCEPTION 'SEC-12: insertion de organizations autorisée';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
DO $$
BEGIN
  INSERT INTO organization_members (organization_id, user_id, role) VALUES ('00000000-0000-0000-0000-000000000011', '9', 'ORG_OWNER');
  RAISE EXCEPTION 'SEC-12: insertion dans organization_members autorisée';
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
  IF (SELECT count(*) FROM tournaments WHERE organization_id IN ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-000000000022')) <> 1 THEN
    RAISE EXCEPTION 'SEC-10: tournoi privé lisible (authenticated)';
  END IF;
  UPDATE matches SET team1_score = 5 WHERE phase_id = '00000000-0000-0000-0000-0000000001a1';
  RAISE EXCEPTION 'SEC-12: modification de match autorisée (authenticated)';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;

RESET ROLE;
-- I18N-05 / contrainte d'invitation.
DO $$
BEGIN
  UPDATE organizations SET invite_url = 'https://evil.example/x' WHERE slug = 'org-public';
  RAISE EXCEPTION 'invite_url hors Discord acceptée';
EXCEPTION WHEN check_violation THEN NULL;
END $$;
DO $$
BEGIN
  UPDATE tournaments SET language = 'de' WHERE id = '00000000-0000-0000-0000-0000000000a1';
  RAISE EXCEPTION 'I18N-05: langue invalide acceptée';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- SEC-20 / #85 : intégrité des équipes par tournoi dans phase_teams et regenerate_phase_seeding
INSERT INTO phase_teams (phase_id, team_id, seed) VALUES
  ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002a1', 1);

-- 1. Le trigger trg_phase_teams_tournament_integrity bloque l'insertion directe d'une équipe étrangère
DO $$
DECLARE
  v_caught boolean := false;
BEGIN
  BEGIN
    INSERT INTO phase_teams (phase_id, team_id, seed) VALUES
      ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000002b2', 2);
  EXCEPTION WHEN raise_exception THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'SEC-20: insertion directe phase_teams équipe étrangère acceptée';
  END IF;
END $$;

-- 2. regenerate_phase_seeding avec une équipe étrangère lève une exception et n'efface rien
DO $$
DECLARE
  v_caught boolean := false;
BEGIN
  BEGIN
    PERFORM regenerate_phase_seeding(
      '00000000-0000-0000-0000-0000000001a1',
      '[{"team_id":"00000000-0000-0000-0000-0000000002b2","seed":1}]'::jsonb
    );
  EXCEPTION WHEN raise_exception THEN
    v_caught := true;
  END;
  IF NOT v_caught THEN
    RAISE EXCEPTION 'SEC-20: regenerate_phase_seeding avec équipe étrangère accepté';
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT count(*) FROM phase_teams WHERE phase_id = '00000000-0000-0000-0000-0000000001a1') <> 1 THEN
    RAISE EXCEPTION 'SEC-20: phase_teams a été altérée malgré l''exception';
  END IF;
  IF (SELECT count(*) FROM matches WHERE phase_id = '00000000-0000-0000-0000-0000000001a1') <> 1 THEN
    RAISE EXCEPTION 'SEC-20: matches a été altéré malgré l''exception';
  END IF;
END $$;

-- 3. regenerate_phase_seeding avec une équipe valide du tournoi réussit
DO $$
BEGIN
  PERFORM regenerate_phase_seeding(
    '00000000-0000-0000-0000-0000000001a1',
    '[{"team_id":"00000000-0000-0000-0000-0000000002a1","seed":2}]'::jsonb
  );
  IF (SELECT count(*) FROM phase_teams WHERE phase_id = '00000000-0000-0000-0000-0000000001a1' AND seed = 2) <> 1 THEN
    RAISE EXCEPTION 'SEC-20: regenerate_phase_seeding légitime échoué';
  END IF;
END $$;

SELECT 'RLS OK' AS result;
ROLLBACK;
