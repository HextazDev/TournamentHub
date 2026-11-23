-- SEC-34 : defense-in-depth sur transfer_organization_ownership.
-- La démotion de p_from_user_id ne doit toucher que le ORG_OWNER effectif de l'organisation :
-- ne pas repose uniquement sur authorize(TRANSFER_OWNERSHIP) côté route.
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
      AND user_id = p_from_user_id
      AND role = 'ORG_OWNER';

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Seul le propriétaire effectif peut transférer la propriété'
        USING ERRCODE = 'HT004';
    END IF;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.transfer_organization_ownership(UUID, TEXT, TEXT, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.transfer_organization_ownership(UUID, TEXT, TEXT, BOOLEAN) TO service_role;
