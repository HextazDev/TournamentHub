-- #85 (SEC-20) : Garantir en base qu'une phase ne contient que des équipes de son tournoi.
-- 1. Requête de contrôle des incohérences préexistantes (à exécuter avant migration si besoin) :
--    SELECT pt.phase_id, pt.team_id, p.tournament_id AS phase_tournament, t.tournament_id AS team_tournament
--    FROM phase_teams pt
--    JOIN phases p ON p.id = pt.phase_id
--    JOIN teams t ON t.id = pt.team_id
--    WHERE p.tournament_id IS DISTINCT FROM t.tournament_id;

-- 2. Trigger de cohérence BEFORE INSERT OR UPDATE sur phase_teams :
CREATE OR REPLACE FUNCTION check_phase_team_tournament_integrity()
RETURNS TRIGGER AS $$
DECLARE
  v_phase_tournament_id UUID;
  v_team_tournament_id UUID;
BEGIN
  SELECT tournament_id INTO v_phase_tournament_id FROM phases WHERE id = NEW.phase_id;
  IF v_phase_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Phase % introuvable', NEW.phase_id USING ERRCODE = 'P0002';
  END IF;

  SELECT tournament_id INTO v_team_tournament_id FROM teams WHERE id = NEW.team_id;
  IF v_team_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Équipe % introuvable', NEW.team_id USING ERRCODE = 'P0002';
  END IF;

  IF v_phase_tournament_id IS DISTINCT FROM v_team_tournament_id THEN
    RAISE EXCEPTION 'L''équipe % n''appartient pas au tournoi de la phase %', NEW.team_id, NEW.phase_id
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION check_phase_team_tournament_integrity() SET search_path = public;
REVOKE EXECUTE ON FUNCTION check_phase_team_tournament_integrity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION check_phase_team_tournament_integrity() TO service_role;

DROP TRIGGER IF EXISTS trg_phase_teams_tournament_integrity ON phase_teams;
CREATE TRIGGER trg_phase_teams_tournament_integrity
  BEFORE INSERT OR UPDATE ON phase_teams
  FOR EACH ROW
  EXECUTE FUNCTION check_phase_team_tournament_integrity();

-- 3. Mise à jour de regenerate_phase_seeding pour vérifier l'appartenance de chaque team_id
--    au tournoi de la phase AVANT toute suppression (DELETE matches / phase_teams) :
CREATE OR REPLACE FUNCTION regenerate_phase_seeding(
  p_phase_id UUID,
  p_participants JSONB
)
RETURNS VOID AS $$
DECLARE
  v_tournament_id UUID;
  v_foreign_count INT;
BEGIN
  -- Récupérer le tournoi de la phase
  SELECT tournament_id INTO v_tournament_id
  FROM phases
  WHERE id = p_phase_id;

  IF v_tournament_id IS NULL THEN
    RAISE EXCEPTION 'Phase introuvable' USING ERRCODE = 'P0002';
  END IF;

  -- SEC-20 : vérifier l'appartenance de toutes les équipes au tournoi avant toute suppression
  IF p_participants IS NOT NULL AND jsonb_typeof(p_participants) = 'array' AND jsonb_array_length(p_participants) > 0 THEN
    SELECT count(*) INTO v_foreign_count
    FROM jsonb_array_elements(p_participants) AS elem
    WHERE NOT EXISTS (
      SELECT 1
      FROM teams t
      WHERE t.id = (elem->>'team_id')::UUID
        AND t.tournament_id = v_tournament_id
    );

    IF v_foreign_count > 0 THEN
      RAISE EXCEPTION 'Une ou plusieurs équipes n''appartiennent pas au tournoi de la phase'
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Réinitialiser les matchs et les équipes de la phase
  DELETE FROM matches WHERE phase_id = p_phase_id;
  DELETE FROM phase_teams WHERE phase_id = p_phase_id;

  -- Insérer le nouveau placement
  INSERT INTO phase_teams (phase_id, team_id, seed)
  SELECT p_phase_id, (elem->>'team_id')::UUID, (elem->>'seed')::INT
  FROM jsonb_array_elements(p_participants) AS elem;
END;
$$ LANGUAGE plpgsql;

ALTER FUNCTION regenerate_phase_seeding(UUID, JSONB) SET search_path = public;
REVOKE EXECUTE ON FUNCTION regenerate_phase_seeding(UUID, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION regenerate_phase_seeding(UUID, JSONB) TO service_role;
