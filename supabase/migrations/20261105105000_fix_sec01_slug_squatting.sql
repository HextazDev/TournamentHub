-- SEC-01: Renforcement de la contrainte CHECK sur le slug d'organisation
-- Interdit explicitement les slugs 100% numériques (snowflakes Discord 17-20 chiffres) et les formats UUID.

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_slug_check;

ALTER TABLE public.organizations ADD CONSTRAINT organizations_slug_check
  CHECK (
    slug ~ '^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$'
    AND slug !~ '^\d+$'
    AND slug !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  );
