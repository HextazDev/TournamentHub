# 🐞 Problèmes Connus — TournamentHub

Bugs **constatés et non encore corrigés**, avec leur impact visible, un contournement éventuel et l'issue GitHub de suivi.

- **Ce document ≠ `docs/EDGE_CASES.md`** : le registre des cas limites décrit les invariants et leur couverture de tests (IDs `SWS-05`, `SCR-05`…). Ici, on consigne l'**impact pour l'organisateur / le joueur** et la marche à suivre en attendant le correctif.
- **Entrée** : tout bug découvert hors périmètre d'un ticket ➜ issue GitHub (`/create-issue`) + une ligne ici, dans le même diff.
- **Sortie** : quand l'issue est corrigée et mergée, retirer la ligne (l'historique Git fait foi) et promouvoir l'ID correspondant dans `docs/EDGE_CASES.md`.

---

## 📋 Registre

| ID | Domaine | Symptôme visible | Contournement | Edge cases | Suivi |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **KI-01** | Classement | Le classement **web** (back-office et portail public) et le classement **persisté** (`phase_teams`, calculé par le bot) peuvent différer : un match `FF` en poules donne au perdant `points_loss + points_forfeit` côté web, mais est ignoré côté bot ; un match au statut `BYE` est compté côté bot, ignoré côté web. | Saisir un score réel (ex. `1-0`) plutôt que le statut `FF` pour un forfait en poules. | `LB-05`, `LB-06` | [#51](https://github.com/HextazDev/TournamentHub/issues/51) |
| **KI-02** | Classement Suisse | Le barème de points configuré n'est pas appliqué en Suisse : victoire / BYE = 3 pts, nul = 1 pt, toujours. | Aucun (barème 3/1/0 imposé). | `SWS-05` | [#51](https://github.com/HextazDev/TournamentHub/issues/51) |
