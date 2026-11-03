# 🐞 Problèmes Connus — TournamentHub

Bugs **constatés et non encore corrigés**, avec leur impact visible, un contournement éventuel et l'issue GitHub de suivi.

- **Ce document ≠ `docs/EDGE_CASES.md`** : le registre des cas limites décrit les invariants et leur couverture de tests (IDs `SWS-05`, `SCR-05`…). Ici, on consigne l'**impact pour l'organisateur / le joueur** et la marche à suivre en attendant le correctif.
- **Entrée** : tout bug découvert hors périmètre d'un ticket ➜ issue GitHub (`/create-issue`) + une ligne ici, dans le même diff.
- **Sortie** : quand l'issue est corrigée et mergée, retirer la ligne (l'historique Git fait foi) et promouvoir l'ID correspondant dans `docs/EDGE_CASES.md`.

---

## 📋 Registre

| ID | Domaine | Symptôme visible | Contournement | Edge cases | Suivi |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **KI-05** | Placement des phases (back-office) | Un double forfait `FF` saisi à `0-0` n'est pas considéré comme un match joué : le placement (seeding) de la phase reste modifiable, et le re-seed **efface** les matchs et le classement de la phase. Même effet pour un `0-0` en attente de validation ou contesté. | Ne pas modifier le placement d'une phase dont un match a été joué, déclaré ou contesté. | `SCR-09` | [#82](https://github.com/HextazDev/TournamentHub/issues/82) |
