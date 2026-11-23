-- #102 / SEC-08 (KI-01) : autoriser tout lien de contact public https:// sur une organisation
-- (avec ou sans intégration Discord), tout en bloquant http://, javascript:, data:, espaces et credentials.

ALTER TABLE public.organizations
  DROP CONSTRAINT IF EXISTS organizations_invite_url_check;

ALTER TABLE public.organizations
  ADD CONSTRAINT organizations_invite_url_check CHECK (
    invite_url IS NULL
    OR (
      char_length(invite_url) <= 512
      AND invite_url ~ '^https://[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,63}(:[0-9]{1,5})?([/?#][^[:space:]]*)?$'
    )
  );
