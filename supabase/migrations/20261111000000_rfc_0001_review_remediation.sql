-- Remédiation de la revue de la PR #100 (RFC 0001 / #97).

-- 1. SEC-37 : l'invitation au staff d'un tournoi échouait toujours (42702). La colonne de sortie `tournament_id`
-- de RETURNS TABLE rendait ambiguë la cible de ON CONFLICT : la contrainte est désormais nommée.
-- Le rôle renvoyé est celui réellement détenu après acceptation, jamais celui d'une invitation sans effet.
CREATE OR REPLACE FUNCTION public.accept_organization_invite(p_token_hash TEXT, p_user_id TEXT)
RETURNS TABLE (organization_id UUID, slug TEXT, role TEXT, tournament_id UUID)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_invite public.organization_invites;
  v_role TEXT;
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
    ON CONFLICT ON CONSTRAINT tournament_staff_pkey DO UPDATE SET role = EXCLUDED.role;
    v_role := v_invite.role;
  ELSE
    -- Un membre existant garde son rôle : une invitation n'est jamais une rétrogradation.
    INSERT INTO public.organization_members AS m (organization_id, user_id, role)
    VALUES (v_invite.organization_id, p_user_id, v_invite.role)
    ON CONFLICT ON CONSTRAINT organization_members_pkey DO NOTHING;

    SELECT m.role INTO v_role
    FROM public.organization_members m
    WHERE m.organization_id = v_invite.organization_id AND m.user_id = p_user_id;
  END IF;

  RETURN QUERY
    SELECT o.id, o.slug::TEXT, v_role, v_invite.tournament_id
    FROM public.organizations o
    WHERE o.id = v_invite.organization_id;
END;
$$;

-- 2. SEC-36 : seul un ORG_OWNER effectif transfère la propriété, y compris sans rétrogradation.
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
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = p_organization_id
      AND user_id = p_from_user_id
      AND role = 'ORG_OWNER'
  ) THEN
    RAISE EXCEPTION 'Seul le propriétaire effectif peut transférer la propriété'
      USING ERRCODE = 'HT004';
  END IF;

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
      AND user_id = p_from_user_id
      AND role = 'ORG_OWNER';
  END IF;
END;
$$;

-- 3. SEC-38 : une intégration n'accorde jamais ORG_OWNER, rôle exclusivement natif (RFC Q2).
ALTER TABLE public.integration_access_grants DROP CONSTRAINT IF EXISTS integration_access_grants_role_check;
ALTER TABLE public.integration_access_grants ADD CONSTRAINT integration_access_grants_role_check
  CHECK (granted_role IN ('ORG_ADMIN', 'ORG_TO', 'TOURNAMENT_TO'));

-- 4. SEC-27 : le contrôle du dernier propriétaire est sérialisé par organisation. Sans verrou, deux propriétaires
-- qui se retiraient ou se rétrogradaient en même temps laissaient l'organisation sans ORG_OWNER.
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

CREATE OR REPLACE FUNCTION public.prevent_last_org_owner_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF OLD.role <> 'ORG_OWNER' THEN
    RETURN OLD;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('org_last_owner:' || OLD.organization_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.organizations WHERE id = OLD.organization_id)
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

REVOKE EXECUTE ON FUNCTION public.accept_organization_invite(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.transfer_organization_ownership(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.accept_organization_invite(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.transfer_organization_ownership(UUID, TEXT, TEXT, BOOLEAN) TO service_role;
