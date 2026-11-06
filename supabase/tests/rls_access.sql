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
  EXCEPTION WHEN SQLSTATE 'HT002' THEN
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
  EXCEPTION WHEN SQLSTATE 'HT002' THEN
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

-- ====================================================================
-- Audit PR #100 : invariants réels (quota, grants, invitations, tables fermées)
-- ====================================================================

-- SYNC-01 : l'upsert du registre Discord vise une contrainte réelle, y compris sans tournoi (NULL).
DO $$
DECLARE v_org UUID;
BEGIN
  INSERT INTO organizations (slug, name) VALUES ('rls-audit-sync', 'Sync') RETURNING id INTO v_org;
  FOR i IN 1..2 LOOP
    INSERT INTO integration_access_grants (organization_id, provider, user_id, scope_type, tournament_id, granted_role, reason)
    VALUES (v_org, 'DISCORD', 'u-sync', 'ORGANIZATION', NULL, 'ORG_ADMIN', 'ADMINISTRATOR')
    ON CONFLICT (organization_id, provider, user_id, scope_type, tournament_id) DO UPDATE SET synced_at = NOW();
  END LOOP;
  IF (SELECT count(*) FROM integration_access_grants WHERE organization_id = v_org) <> 1 THEN
    RAISE EXCEPTION 'SYNC-01: le grant d''organisation a été dupliqué';
  END IF;
END $$;

-- SEC-06 : création atomique et quota de 5 organisations (code HT001), sans organisation orpheline.
DO $$
DECLARE v_failed BOOLEAN := FALSE;
BEGIN
  FOR i IN 1..5 LOOP
    PERFORM create_organization_with_owner('rls-quota-' || i, 'Q', 'fr', NULL, NULL, 'u-quota');
  END LOOP;
  BEGIN
    PERFORM create_organization_with_owner('rls-quota-6', 'Q', 'fr', NULL, NULL, 'u-quota');
  EXCEPTION WHEN SQLSTATE 'HT001' THEN
    v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'SEC-06: 6e organisation acceptée'; END IF;
  IF EXISTS (SELECT 1 FROM organizations WHERE slug = 'rls-quota-6') THEN
    RAISE EXCEPTION 'SEC-06: organisation sans propriétaire persistée';
  END IF;
END $$;

-- CLN-01 : slug réservé refusé par la base.
DO $$
BEGIN
  INSERT INTO organizations (slug, name) VALUES ('admin', 'Réservé');
  RAISE EXCEPTION 'CLN-01: slug réservé accepté';
EXCEPTION WHEN check_violation THEN NULL;
END $$;

-- Transfert : refuse un non-admin (HT004) ; garde toujours un propriétaire.
DO $$
DECLARE v_org UUID; v_failed BOOLEAN := FALSE;
BEGIN
  v_org := (create_organization_with_owner('rls-transfer', 'T', 'fr', NULL, NULL, 'u-t-owner')).id;
  INSERT INTO organization_members (organization_id, user_id, role) VALUES (v_org, 'u-t-admin', 'ORG_ADMIN');
  BEGIN
    PERFORM transfer_organization_ownership(v_org, 'u-t-owner', 'u-absent', TRUE);
  EXCEPTION WHEN SQLSTATE 'HT004' THEN v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'transfert accepté vers un non-admin'; END IF;
  PERFORM transfer_organization_ownership(v_org, 'u-t-owner', 'u-t-admin', TRUE);
  IF (SELECT role FROM organization_members WHERE organization_id = v_org AND user_id = 'u-t-admin') <> 'ORG_OWNER'
     OR (SELECT role FROM organization_members WHERE organization_id = v_org AND user_id = 'u-t-owner') <> 'ORG_ADMIN' THEN
    RAISE EXCEPTION 'transfert de propriété incorrect';
  END IF;
END $$;

-- Invitation : usage unique, jamais de rétrogradation d'un membre existant.
DO $$
DECLARE v_org UUID; v_failed BOOLEAN := FALSE;
BEGIN
  v_org := (create_organization_with_owner('rls-invite', 'I', 'fr', NULL, NULL, 'u-i-owner')).id;
  INSERT INTO organization_invites (organization_id, token_hash, role, created_by, expires_at)
  VALUES (v_org, 'hash-1', 'ORG_TO', 'u-i-owner', NOW() + INTERVAL '1 hour'),
         (v_org, 'hash-2', 'MEMBER', 'u-i-owner', NOW() + INTERVAL '1 hour'),
         (v_org, 'hash-expired', 'MEMBER', 'u-i-owner', NOW() - INTERVAL '1 hour');
  PERFORM accept_organization_invite('hash-1', 'u-guest');
  IF (SELECT role FROM organization_members WHERE organization_id = v_org AND user_id = 'u-guest') <> 'ORG_TO' THEN
    RAISE EXCEPTION 'invitation non appliquée';
  END IF;
  BEGIN
    PERFORM accept_organization_invite('hash-1', 'u-other');
  EXCEPTION WHEN SQLSTATE 'HT003' THEN v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'invitation rejouée'; END IF;
  v_failed := FALSE;
  BEGIN
    PERFORM accept_organization_invite('hash-expired', 'u-other');
  EXCEPTION WHEN SQLSTATE 'HT003' THEN v_failed := TRUE;
  END;
  IF NOT v_failed THEN RAISE EXCEPTION 'invitation expirée acceptée'; END IF;
  PERFORM accept_organization_invite('hash-2', 'u-i-owner');
  IF (SELECT role FROM organization_members WHERE organization_id = v_org AND user_id = 'u-i-owner') <> 'ORG_OWNER' THEN
    RAISE EXCEPTION 'une invitation a rétrogradé le propriétaire';
  END IF;
END $$;

-- Nouvelles tables et RPC fermées à anon / authenticated.
DO $$
BEGIN
  IF has_table_privilege('anon', 'tournament_invite_tokens', 'SELECT')
     OR has_table_privilege('authenticated', 'tournament_invite_tokens', 'SELECT') THEN
    RAISE EXCEPTION 'tournament_invite_tokens lisible publiquement';
  END IF;
  IF has_function_privilege('anon', 'create_organization_with_owner(text,text,text,text,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'accept_organization_invite(text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'transfer_organization_ownership(uuid,text,text,boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'RPC d''organisation exécutable par anon';
  END IF;
END $$;

SELECT 'RLS OK' AS result;
ROLLBACK;
