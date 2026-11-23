-- RFC 0001 / Issue #101 (Option 5A — Finalisation de la bascule organization_id) :
-- 1. Backfill sans perte des colonnes `discord_*` des tournois dans `tournaments.discord_config`
-- 2. Suppression de `tournaments.guild_id`, du trigger `sync_tournament_organization` et des colonnes `discord_*`
-- 3. Suppression des rôles historiques `OWNER`, `ADMIN`, `ORGANIZER` dans `organization_members`

-- 1. Migration des identifiants Discord des tournois vers `discord_config` (en préservant les clés existantes, ex. registration_message_id)
UPDATE public.tournaments
SET discord_config = COALESCE(discord_config, '{}'::jsonb) || jsonb_strip_nulls(
  jsonb_build_object(
    'category_id', COALESCE(discord_config ->> 'category_id', discord_category_id),
    'announcement_channel_id', COALESCE(discord_config ->> 'announcement_channel_id', discord_announcement_channel_id),
    'registration_channel_id', COALESCE(discord_config ->> 'registration_channel_id', discord_registration_channel_id),
    'checkin_channel_id', COALESCE(discord_config ->> 'checkin_channel_id', discord_checkin_channel_id),
    'captain_role_id', COALESCE(discord_config ->> 'captain_role_id', discord_captain_role_id),
    'to_role_id', COALESCE(discord_config ->> 'to_role_id', discord_to_role_id)
  )
);

-- 2. Suppression du trigger de transition `sync_tournament_organization` et des colonnes héritées
DROP TRIGGER IF EXISTS trg_sync_tournament_organization ON public.tournaments;
DROP FUNCTION IF EXISTS public.sync_tournament_organization();

ALTER TABLE public.tournaments
  DROP COLUMN IF EXISTS guild_id,
  DROP COLUMN IF EXISTS discord_category_id,
  DROP COLUMN IF EXISTS discord_announcement_channel_id,
  DROP COLUMN IF EXISTS discord_registration_channel_id,
  DROP COLUMN IF EXISTS discord_checkin_channel_id,
  DROP COLUMN IF EXISTS discord_captain_role_id,
  DROP COLUMN IF EXISTS discord_to_role_id;

-- 3. Suppression des rôles historiques (`OWNER`, `ADMIN`, `ORGANIZER`) sur `organization_members`
UPDATE public.organization_members SET role = 'ORG_OWNER' WHERE role = 'OWNER';
UPDATE public.organization_members SET role = 'ORG_ADMIN' WHERE role = 'ADMIN';
UPDATE public.organization_members SET role = 'ORG_TO' WHERE role = 'ORGANIZER';

ALTER TABLE public.organization_members DROP CONSTRAINT IF EXISTS organization_members_role_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_role_check
  CHECK (role IN ('ORG_OWNER', 'ORG_ADMIN', 'ORG_TO', 'CASTER', 'STATISTICIAN', 'MEMBER'));

-- Conserve SEC-27 (quota 5 organisations et dernier ORG_OWNER sérialisés par verrous consultatifs) sans alias historiques.
CREATE OR REPLACE FUNCTION public.check_organization_member_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_owned_count INT;
  v_other_owners INT;
BEGIN
  IF NEW.role = 'ORG_OWNER' AND (TG_OP = 'INSERT' OR OLD.role IS DISTINCT FROM 'ORG_OWNER') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('org_owner_quota:' || NEW.user_id, 0));
    SELECT count(*) INTO v_owned_count
    FROM public.organization_members
    WHERE user_id = NEW.user_id
      AND role = 'ORG_OWNER'
      AND organization_id <> NEW.organization_id;

    IF v_owned_count >= 5 THEN
      RAISE EXCEPTION 'SEC-27: un utilisateur ne peut être propriétaire (ORG_OWNER) que de 5 organisations maximum'
        USING ERRCODE = 'HT001';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.role = 'ORG_OWNER' AND NEW.role <> 'ORG_OWNER' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('org_last_owner:' || OLD.organization_id::text, 0));
    SELECT count(*) INTO v_other_owners
    FROM public.organization_members
    WHERE organization_id = OLD.organization_id
      AND role = 'ORG_OWNER'
      AND user_id <> OLD.user_id;

    IF v_other_owners = 0 THEN
      RAISE EXCEPTION 'SEC-27: impossible de rétrograder le dernier propriétaire (ORG_OWNER) de l''organisation'
        USING ERRCODE = 'HT002';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_organization_member_invariants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_organization_member_invariants() TO service_role;
