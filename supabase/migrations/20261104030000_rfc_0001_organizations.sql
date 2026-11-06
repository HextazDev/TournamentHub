-- RFC 0001 / Issue #97 (Option 5A — Clean Cutover) :
-- Le site comme produit principal (modèle Organizations) et intégrations optionnelles (Discord, Twitch, IA).
-- Cloisonnement multi-tenant sur `organizations.id` (UUID), accès natifs (`organization_members`, `tournament_staff`)
-- combinés aux accès d'intégration (`integration_access_grants`), secrets isolés (`organization_integration_secrets`).

-- 1. Table principale des tenants : `organizations`
CREATE TABLE IF NOT EXISTS public.organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(50) NOT NULL UNIQUE
    CONSTRAINT organizations_slug_check CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'),
  name VARCHAR(100) NOT NULL
    CONSTRAINT organizations_name_check CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  logo_url TEXT,
  icon_url TEXT,
  language VARCHAR(10) NOT NULL DEFAULT 'fr'
    CONSTRAINT organizations_language_check CHECK (language IN ('fr', 'en')),
  invite_url TEXT
    CONSTRAINT organizations_invite_url_check CHECK (
      invite_url IS NULL OR invite_url ~ '^https://(discord\.gg|discord\.com/invite)/[A-Za-z0-9-]+$'
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE OR REPLACE FUNCTION public.sync_organization_logo_icon()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.logo_url IS NOT NULL AND (NEW.icon_url IS NULL OR (TG_OP = 'UPDATE' AND NEW.logo_url IS DISTINCT FROM OLD.logo_url)) THEN
    NEW.icon_url := NEW.logo_url;
  ELSIF NEW.icon_url IS NOT NULL AND (NEW.logo_url IS NULL OR (TG_OP = 'UPDATE' AND NEW.icon_url IS DISTINCT FROM OLD.icon_url)) THEN
    NEW.logo_url := NEW.icon_url;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_organization_logo_icon() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_organization_logo_icon() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_organization_logo_icon ON public.organizations;
CREATE TRIGGER trg_sync_organization_logo_icon
  BEFORE INSERT OR UPDATE ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_organization_logo_icon();

-- 2. Membres natifs de l'organisation (`organization_members`)
CREATE TABLE IF NOT EXISTS public.organization_members (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL
    CONSTRAINT organization_members_role_check CHECK (
      role IN ('ORG_OWNER', 'ORG_ADMIN', 'ORG_TO', 'OWNER', 'ADMIN', 'ORGANIZER', 'MEMBER')
    ),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (organization_id, user_id)
);

-- SEC-27 : normalisation des rôles, quota de 5 organisations en tant que propriétaire (ORG_OWNER),
-- et interdiction de supprimer ou rétrograder le dernier propriétaire d'une organisation active.
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

  IF NEW.role = 'ORG_OWNER' THEN
    SELECT count(*) INTO v_owned_count
    FROM public.organization_members
    WHERE user_id = NEW.user_id
      AND role = 'ORG_OWNER'
      AND organization_id <> NEW.organization_id;

    IF v_owned_count >= 5 THEN
      RAISE EXCEPTION 'SEC-27: un utilisateur ne peut être propriétaire (ORG_OWNER) que de 5 organisations maximum'
        USING ERRCODE = 'P0001';
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
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.check_organization_member_invariants() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_organization_member_invariants() TO service_role;

DROP TRIGGER IF EXISTS trg_organization_member_invariants ON public.organization_members;
CREATE TRIGGER trg_organization_member_invariants
  BEFORE INSERT OR UPDATE ON public.organization_members
  FOR EACH ROW
  EXECUTE FUNCTION public.check_organization_member_invariants();

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
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.prevent_last_org_owner_deletion() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prevent_last_org_owner_deletion() TO service_role;

DROP TRIGGER IF EXISTS trg_prevent_last_org_owner_deletion ON public.organization_members;
CREATE TRIGGER trg_prevent_last_org_owner_deletion
  AFTER DELETE ON public.organization_members
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_last_org_owner_deletion();

-- 3. Staff natif par tournoi (`tournament_staff`)
CREATE TABLE IF NOT EXISTS public.tournament_staff (
  tournament_id UUID NOT NULL REFERENCES public.tournaments(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL
    CONSTRAINT tournament_staff_role_check CHECK (role IN ('TOURNAMENT_TO', 'CASTER', 'STATISTICIAN')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tournament_id, user_id)
);

-- 4. Invitations d'organisation (`organization_invites`)
CREATE TABLE IF NOT EXISTS public.organization_invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  role TEXT NOT NULL
    CONSTRAINT organization_invites_role_check CHECK (role IN ('ORG_ADMIN', 'ORG_TO', 'ADMIN', 'ORGANIZER', 'MEMBER')),
  created_by TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  used_by TEXT,
  used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 5. Intégrations par organisation (`organization_integrations`)
CREATE TABLE IF NOT EXISTS public.organization_integrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'DISCORD'
    CONSTRAINT organization_integrations_provider_check CHECK (provider IN ('DISCORD', 'TWITCH', 'AI')),
  type TEXT NOT NULL DEFAULT 'DISCORD'
    CONSTRAINT organization_integrations_type_check CHECK (type IN ('DISCORD', 'TWITCH', 'AI')),
  external_id TEXT,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  config JSONB NOT NULL DEFAULT '{}'::jsonb,
  status TEXT NOT NULL DEFAULT 'DISCONNECTED'
    CONSTRAINT organization_integrations_status_check CHECK (status IN ('CONNECTED', 'DEGRADED', 'REVOKED', 'DISCONNECTED')),
  last_error TEXT,
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_organization_integration_provider UNIQUE (organization_id, provider),
  -- SEC-29 : un identifiant externe (ex: guild_id Discord) ne peut être rattaché qu'à une seule organisation.
  CONSTRAINT uq_integration_provider_external_id UNIQUE (provider, external_id)
);

CREATE OR REPLACE FUNCTION public.sync_integration_provider_type()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.provider IS DISTINCT FROM 'DISCORD' THEN
      NEW.type := NEW.provider;
    ELSIF NEW.type IS DISTINCT FROM 'DISCORD' THEN
      NEW.provider := NEW.type;
    END IF;
  ELSE
    IF NEW.provider IS DISTINCT FROM OLD.provider THEN
      NEW.type := NEW.provider;
    ELSIF NEW.type IS DISTINCT FROM OLD.type THEN
      NEW.provider := NEW.type;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_integration_provider_type() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_integration_provider_type() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_integration_provider_type ON public.organization_integrations;
CREATE TRIGGER trg_sync_integration_provider_type
  BEFORE INSERT OR UPDATE ON public.organization_integrations
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_integration_provider_type();

-- 6. Secrets d'intégration chiffrés (`organization_integration_secrets` — SEC-28)
CREATE TABLE IF NOT EXISTS public.organization_integration_secrets (
  integration_id UUID PRIMARY KEY REFERENCES public.organization_integrations(id) ON DELETE CASCADE,
  encrypted_payload TEXT NOT NULL,
  key_version INT NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 7. Droits accordés par une intégration (`integration_access_grants` — remplace `guild_admins`)
CREATE TABLE IF NOT EXISTS public.integration_access_grants (
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'DISCORD'
    CONSTRAINT integration_access_grants_provider_check CHECK (provider IN ('DISCORD', 'TWITCH', 'AI')),
  user_id TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'ORGANIZATION'
    CONSTRAINT integration_access_grants_scope_check CHECK (scope_type IN ('ORGANIZATION', 'TOURNAMENT')),
  tournament_id UUID REFERENCES public.tournaments(id) ON DELETE CASCADE,
  granted_role TEXT NOT NULL DEFAULT 'ORG_TO'
    CONSTRAINT integration_access_grants_role_check CHECK (
      granted_role IN ('ORG_OWNER', 'ORG_ADMIN', 'ORG_TO', 'TOURNAMENT_TO')
    ),
  reason TEXT NOT NULL
    CONSTRAINT integration_access_grants_reason_check CHECK (
      reason IN ('SERVER_OWNER', 'ADMINISTRATOR', 'MANAGE_GUILD', 'TO_ROLE', 'TOURNAMENT_TO_ROLE')
    ),
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT integration_access_grants_scope_tournament_check CHECK (
    (scope_type = 'ORGANIZATION' AND tournament_id IS NULL)
    OR (scope_type = 'TOURNAMENT' AND tournament_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_integration_access_grants_entry
  ON public.integration_access_grants (
    organization_id,
    provider,
    user_id,
    scope_type,
    COALESCE(tournament_id, '00000000-0000-0000-0000-000000000000'::uuid)
  );

-- 8. Migration de `server_settings` et `tournaments` vers `organizations`
ALTER TABLE public.tournaments
  ADD COLUMN IF NOT EXISTS organization_id UUID REFERENCES public.organizations(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS discord_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.tournaments
  ALTER COLUMN guild_id DROP NOT NULL;

CREATE OR REPLACE FUNCTION public.slugify_identifier(p_raw TEXT, p_fallback TEXT)
RETURNS VARCHAR(50)
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE
  v_slug TEXT;
BEGIN
  v_slug := lower(regexp_replace(COALESCE(NULLIF(btrim(p_raw), ''), p_fallback), '[^a-z0-9]+', '-', 'g'));
  v_slug := regexp_replace(v_slug, '^-+|-+$', '', 'g');
  IF char_length(v_slug) < 3 THEN
    v_slug := 'org-' || regexp_replace(lower(p_fallback), '[^a-z0-9]+', '', 'g');
  END IF;
  IF char_length(v_slug) < 3 THEN
    v_slug := 'org-default';
  END IF;
  RETURN left(v_slug, 48);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.slugify_identifier(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.slugify_identifier(TEXT, TEXT) TO service_role;

-- Migration des lignes éventuelles de `server_settings` et `tournaments`
DO $$
DECLARE
  r RECORD;
  v_org_id UUID;
  v_slug VARCHAR(50);
BEGIN
  IF to_regclass('public.server_settings') IS NOT NULL THEN
    FOR r IN SELECT * FROM public.server_settings LOOP
      v_slug := public.slugify_identifier('discord-' || r.guild_id, r.guild_id);
      INSERT INTO public.organizations (slug, name, logo_url, icon_url, language, invite_url)
      VALUES (
        v_slug,
        COALESCE(NULLIF(btrim(r.guild_name), ''), 'Discord ' || r.guild_id),
        r.guild_icon,
        r.guild_icon,
        COALESCE(r.language, 'fr'),
        r.invite_url
      )
      ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
      RETURNING id INTO v_org_id;

      INSERT INTO public.organization_integrations (
        organization_id, provider, type, external_id, enabled, status, config
      ) VALUES (
        v_org_id,
        'DISCORD',
        'DISCORD',
        r.guild_id,
        TRUE,
        CASE WHEN r.bot_present THEN 'CONNECTED' ELSE 'DISCONNECTED' END,
        jsonb_build_object(
          'to_role_id', r.to_role_id,
          'captain_role_id', r.captain_role_id,
          'checkin_channel_id', r.checkin_channel_id,
          'announcement_channel_id', r.announcement_channel_id,
          'registration_channel_id', r.registration_channel_id,
          'bot_present', r.bot_present,
          'guild_name', r.guild_name,
          'guild_icon', r.guild_icon,
          'invite_url', r.invite_url
        )
      )
      ON CONFLICT (organization_id, provider) DO NOTHING;

      UPDATE public.tournaments
      SET organization_id = v_org_id
      WHERE guild_id = r.guild_id AND organization_id IS NULL;
    END LOOP;
  END IF;

  FOR r IN SELECT DISTINCT guild_id FROM public.tournaments WHERE organization_id IS NULL AND guild_id IS NOT NULL LOOP
    v_slug := public.slugify_identifier('discord-' || r.guild_id, r.guild_id);
    INSERT INTO public.organizations (slug, name)
    VALUES (v_slug, 'Discord ' || r.guild_id)
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id INTO v_org_id;

    INSERT INTO public.organization_integrations (
      organization_id, provider, type, external_id, enabled, status
    ) VALUES (
      v_org_id, 'DISCORD', 'DISCORD', r.guild_id, TRUE, 'CONNECTED'
    )
    ON CONFLICT (organization_id, provider) DO NOTHING;

    UPDATE public.tournaments
    SET organization_id = v_org_id
    WHERE guild_id = r.guild_id AND organization_id IS NULL;
  END LOOP;
END $$;

-- Trigger de cohérence `tournaments` : résout `organization_id` ou synchronise `guild_id` si Discord est lié.
CREATE OR REPLACE FUNCTION public.sync_tournament_organization()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_org_id UUID;
  v_guild_id TEXT;
  v_slug VARCHAR(50);
BEGIN
  IF NEW.organization_id IS NULL AND NEW.guild_id IS NOT NULL THEN
    SELECT organization_id INTO v_org_id
    FROM public.organization_integrations
    WHERE provider = 'DISCORD' AND external_id = NEW.guild_id
    LIMIT 1;

    IF v_org_id IS NULL THEN
      v_slug := public.slugify_identifier('discord-' || NEW.guild_id, NEW.guild_id);
      INSERT INTO public.organizations (slug, name)
      VALUES (v_slug, 'Organization ' || NEW.guild_id)
      ON CONFLICT (slug) DO UPDATE SET updated_at = NOW()
      RETURNING id INTO v_org_id;

      INSERT INTO public.organization_integrations (
        organization_id, provider, type, external_id, enabled, status
      ) VALUES (
        v_org_id, 'DISCORD', 'DISCORD', NEW.guild_id, TRUE, 'CONNECTED'
      )
      ON CONFLICT (organization_id, provider) DO NOTHING;
    END IF;

    NEW.organization_id := v_org_id;
  ELSIF NEW.organization_id IS NOT NULL AND NEW.guild_id IS NULL THEN
    SELECT external_id INTO v_guild_id
    FROM public.organization_integrations
    WHERE organization_id = NEW.organization_id
      AND provider = 'DISCORD'
      AND enabled = TRUE
    LIMIT 1;

    NEW.guild_id := v_guild_id;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.sync_tournament_organization() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sync_tournament_organization() TO service_role;

DROP TRIGGER IF EXISTS trg_sync_tournament_organization ON public.tournaments;
CREATE TRIGGER trg_sync_tournament_organization
  BEFORE INSERT OR UPDATE ON public.tournaments
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_tournament_organization();

ALTER TABLE public.tournaments
  ALTER COLUMN organization_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tournaments_organization_id ON public.tournaments(organization_id);
CREATE INDEX IF NOT EXISTS idx_organization_members_user_id ON public.organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_tournament_staff_user_id ON public.tournament_staff(user_id);
CREATE INDEX IF NOT EXISTS idx_organization_integrations_external ON public.organization_integrations(provider, external_id);

-- Suppression des tables historiques remplacées par le modèle Organizations (Option 5A)
DROP TABLE IF EXISTS public.guild_admins;
DROP TABLE IF EXISTS public.server_settings;

-- 9. RLS et privilèges fermés par défaut (SEC-07, SEC-10, SEC-12, SEC-28)
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tournament_staff ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_integration_secrets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.integration_access_grants ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public organizations are readable" ON public.organizations;
CREATE POLICY "Public organizations are readable" ON public.organizations
  FOR SELECT USING (true);

-- Aucune politique publique sur organization_members, tournament_staff, organization_invites,
-- organization_integrations, organization_integration_secrets, integration_access_grants.
REVOKE ALL ON TABLE
  public.organizations,
  public.organization_members,
  public.tournament_staff,
  public.organization_invites,
  public.organization_integrations,
  public.organization_integration_secrets,
  public.integration_access_grants
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.organizations TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO service_role;
