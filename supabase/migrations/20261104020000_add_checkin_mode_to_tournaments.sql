-- Migration : Check-in optionnel (#15)
-- Permet de désactiver le check-in d'un tournoi (checkin_mode = 'DISABLED').
-- Par défaut, le check-in est actif ('ENABLED').

ALTER TABLE tournaments
ADD COLUMN IF NOT EXISTS checkin_mode TEXT NOT NULL DEFAULT 'ENABLED'
CHECK (checkin_mode IN ('ENABLED', 'DISABLED'));
