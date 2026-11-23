-- #67 (SEC-24 / DISC-08) : l'annuaire guild_admins accepte le motif TOURNAMENT_TO_ROLE (membre qui ne porte que le
-- rôle TO d'un tournoi non archivé). Annuaire du hub uniquement : il n'autorise rien, le bot décide de l'accès.
-- RLS et droits inchangés : RLS active, aucune politique, SELECT/écritures révoqués pour anon et authenticated
-- (seul service_role lit et écrit). Aucune fonction créée.
-- Idempotente : toute contrainte CHECK portant sur la colonne reason est retrouvée par pg_constraint (quel que soit
-- son nom), supprimée, puis recréée sous le nom explicite guild_admins_reason_check.
DO $$
DECLARE
  con record;
BEGIN
  FOR con IN
    SELECT c.conname
    FROM pg_constraint c
    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
    WHERE c.conrelid = 'public.guild_admins'::regclass
      AND c.contype = 'c'
      AND a.attname = 'reason'
  LOOP
    EXECUTE format('ALTER TABLE public.guild_admins DROP CONSTRAINT %I', con.conname);
  END LOOP;
END $$;

ALTER TABLE public.guild_admins
  ADD CONSTRAINT guild_admins_reason_check
  CHECK (reason IN ('SERVER_OWNER', 'ADMINISTRATOR', 'MANAGE_GUILD', 'TO_ROLE', 'TOURNAMENT_TO_ROLE'));
