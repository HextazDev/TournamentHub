-- Remédiation de l'audit de la PR #100 (RFC 0001 / #97).
-- Codes d'erreur stables relayés par le bot : HT001 quota, HT002 dernier propriétaire, HT003 invitation invalide,
-- HT004 transfert invalide.

-- 1. Grants d'intégration : une contrainte nommable par `upsert(onConflict)` (SYNC-01).
-- PostgREST ne peut pas viser un index sur expression : NULLS NOT DISTINCT garde l'unicité des grants d'organisation.
DROP INDEX IF EXISTS public.uq_integration_access_grants_entry;
ALTER TABLE public.integration_access_grants
  ADD CONSTRAINT uq_integration_access_grants_entry
  UNIQUE NULLS NOT DISTINCT (organization_id, provider, user_id, scope_type, tournament_id);

-- 2. Slugs réservés : un slug ne doit jamais masquer une route du site (CLN-01).
ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_slug_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_slug_check
  CHECK (
    slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'
    AND slug !~ '^\d+$'
    AND slug !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND slug NOT IN ('admin', 'api', 'developers', 'invite', 'organizations', 'overlay', 'servers', 'settings', 'tournaments')
  );

-- 3. Rôles natifs d'organisation casteur / statisticien (RFC Q2).
ALTER TABLE public.organization_members DROP CONSTRAINT IF EXISTS organization_members_role_check;
ALTER TABLE public.organization_members ADD CONSTRAINT organization_members_role_check
  CHECK (role IN ('ORG_OWNER', 'ORG_ADMIN', 'ORG_TO', 'CASTER', 'STATISTICIAN', 'OWNER', 'ADMIN', 'ORGANIZER', 'MEMBER'));

-- 4. Quota sérialisé par utilisateur : sans verrou, des insertions concurrentes dépassaient le plafond (SEC-06).
CREATE OR REPLACE FUNCTION public.check_organization_member_invariants()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_owned_count INT;
  v_other_owners INT;
BEGIN
  IF NEW.role = 'OWNER' THEN
    NEW.role := 'ORG_OWNER';
  ELSIF NEW.role = 'ADMIN' THEN
    NEW.role := 'ORG_ADMIN';
  ELSIF NEW.role = 'ORGANIZER' THEN
    NEW.role := 'ORG_TO';
  END IF;

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

CREATE OR REPLACE FUNCTION public.prevent_last_org_owner_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.role = 'ORG_OWNER'
     AND EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id)
     AND NOT EXISTS (
       SELECT 1 FROM public.organization_members
       WHERE organization_id = OLD.organization_id
         AND role = 'ORG_OWNER'
     ) THEN
    RAISE EXCEPTION 'SEC-27: impossible de supprimer le dernier propriétaire (ORG_OWNER) de l''organisation'
      USING ERRCODE = 'HT002';
  END IF;
  RETURN OLD;
END;
$$;

-- 5. Création atomique : jamais d'organisation sans propriétaire (SEC-06).
CREATE OR REPLACE FUNCTION public.create_organization_with_owner(
  p_slug TEXT,
  p_name TEXT,
  p_language TEXT,
  p_logo_url TEXT,
  p_invite_url TEXT,
  p_owner_id TEXT
)
RETURNS public.organizations
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_org public.organizations;
BEGIN
  INSERT INTO public.organizations (slug, name, language, logo_url, icon_url, invite_url)
  VALUES (p_slug, p_name, COALESCE(p_language, 'fr'), p_logo_url, p_logo_url, p_invite_url)
  RETURNING * INTO v_org;

  INSERT INTO public.organization_members (organization_id, user_id, role)
  VALUES (v_org.id, p_owner_id, 'ORG_OWNER');

  RETURN v_org;
END;
$$;

-- 6. Transfert de propriété atomique : toujours au moins un ORG_OWNER natif (RFC Q2).
CREATE OR REPLACE FUNCTION public.transfer_organization_ownership(
  p_organization_id UUID,
  p_from_user_id TEXT,
  p_to_user_id TEXT,
  p_demote_self BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  UPDATE public.organization_members
  SET role = 'ORG_OWNER'
  WHERE organization_id = p_organization_id
    AND user_id = p_to_user_id
    AND role = 'ORG_ADMIN';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Le nouveau propriétaire doit être un ORG_ADMIN natif de l''organisation'
      USING ERRCODE = 'HT004';
  END IF;

  IF p_demote_self THEN
    UPDATE public.organization_members
    SET role = 'ORG_ADMIN'
    WHERE organization_id = p_organization_id
      AND user_id = p_from_user_id;
  END IF;
END;
$$;

-- 7. Invitations : organisation ou tournoi (RFC Q2.4), usage unique consommé atomiquement.
ALTER TABLE public.organization_invites
  ADD COLUMN IF NOT EXISTS tournament_id UUID REFERENCES public.tournaments(id) ON DELETE CASCADE;

ALTER TABLE public.organization_invites DROP CONSTRAINT IF EXISTS organization_invites_role_check;
ALTER TABLE public.organization_invites ADD CONSTRAINT organization_invites_role_check
  CHECK (
    (tournament_id IS NULL AND role IN ('ORG_ADMIN', 'ORG_TO', 'CASTER', 'STATISTICIAN', 'MEMBER'))
    OR (tournament_id IS NOT NULL AND role IN ('TOURNAMENT_TO', 'CASTER', 'STATISTICIAN'))
  );

CREATE OR REPLACE FUNCTION public.accept_organization_invite(p_token_hash TEXT, p_user_id TEXT)
RETURNS TABLE (organization_id UUID, slug TEXT, role TEXT, tournament_id UUID)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_invite public.organization_invites;
BEGIN
  UPDATE public.organization_invites AS i
  SET used_by = p_user_id, used_at = NOW()
  WHERE i.token_hash = p_token_hash
    AND i.used_at IS NULL
    AND i.expires_at > NOW()
    AND (
      i.tournament_id IS NULL
      OR EXISTS (SELECT 1 FROM public.tournaments t WHERE t.id = i.tournament_id AND t.status <> 'ARCHIVED')
    )
  RETURNING i.* INTO v_invite;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation invalide, expirée ou déjà utilisée' USING ERRCODE = 'HT003';
  END IF;

  IF v_invite.tournament_id IS NOT NULL THEN
    INSERT INTO public.tournament_staff AS s (tournament_id, user_id, role)
    VALUES (v_invite.tournament_id, p_user_id, v_invite.role)
    ON CONFLICT (tournament_id, user_id) DO UPDATE SET role = EXCLUDED.role;
  ELSE
    -- Un membre existant garde son rôle : une invitation n'est jamais une rétrogradation.
    INSERT INTO public.organization_members AS m (organization_id, user_id, role)
    VALUES (v_invite.organization_id, p_user_id, v_invite.role)
    ON CONFLICT ON CONSTRAINT organization_members_pkey DO NOTHING;
  END IF;

  RETURN QUERY
    SELECT o.id, o.slug::TEXT, v_invite.role, v_invite.tournament_id
    FROM public.organizations o
    WHERE o.id = v_invite.organization_id;
END;
$$;

-- 8. Lien de partage d'un tournoi privé : hash seul, dans une table fermée (RFC 5.2).
CREATE TABLE IF NOT EXISTS public.tournament_invite_tokens (
  tournament_id UUID PRIMARY KEY REFERENCES public.tournaments(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE public.tournament_invite_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tournament_invite_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.tournament_invite_tokens TO service_role;

REVOKE EXECUTE ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.transfer_organization_ownership(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.accept_organization_invite(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_organization_with_owner(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.transfer_organization_ownership(UUID, TEXT, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.accept_organization_invite(TEXT, TEXT) TO service_role;
