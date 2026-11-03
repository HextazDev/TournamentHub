# 🐞 Problèmes Connus — TournamentHub

Bugs **constatés et non encore corrigés**, avec leur impact visible, un contournement éventuel et l'issue GitHub de suivi.

- **Ce document ≠ `docs/EDGE_CASES.md`** : le registre des cas limites décrit les invariants et leur couverture de tests (IDs `SWS-05`, `SCR-05`…). Ici, on consigne l'**impact pour l'organisateur / le joueur** et la marche à suivre en attendant le correctif.
- **Entrée** : tout bug découvert hors périmètre d'un ticket ➜ issue GitHub (`/create-issue`) + une ligne ici, dans le même diff.
- **Sortie** : quand l'issue est corrigée et mergée, retirer la ligne (l'historique Git fait foi) et promouvoir l'ID correspondant dans `docs/EDGE_CASES.md`.

---

## 📋 Registre

| ID | Domaine | Symptôme visible | Contournement | Edge cases | Suivi |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **KI-04** | Scores (back-office) | La case **Forfait** de la modale « Modifier le score » est sans effet : `PUT /api/matches/:id/force-score` enregistre toujours le match en `COMPLETED`, jamais en `FF`. Le perdant prend donc une défaite (`points_loss`), pas un forfait (`points_forfeit`). | Aucun pour appliquer `points_forfeit` ; saisir le score du forfait (ex. `3-0`) pour attribuer la victoire. | `LB-05` | [#77](https://github.com/HextazDev/TournamentHub/issues/77) |
