# 🐞 Problèmes Connus — TournamentHub

Bugs **constatés et non encore corrigés**, avec leur impact visible, un contournement éventuel et l'issue GitHub de suivi.

- **Ce document ≠ `docs/EDGE_CASES.md`** : le registre des cas limites décrit les invariants et leur couverture de tests (IDs `SWS-05`, `SCR-05`…). Ici, on consigne l'**impact pour l'organisateur / le joueur** et la marche à suivre en attendant le correctif.
- **Entrée** : tout bug découvert hors périmètre d'un ticket ➜ issue GitHub (`/create-issue`) + une ligne ici, dans le même diff.
- **Sortie** : quand l'issue est corrigée et mergée, retirer la ligne (l'historique Git fait foi) et promouvoir l'ID correspondant dans `docs/EDGE_CASES.md`.

---

## 📋 Registre

| ID | Domaine | Symptôme visible | Contournement | Edge cases | Suivi |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `KI-01` | Organisations | Le lien de contact d'une organisation refuse tout lien qui n'est pas une invitation Discord. | Utiliser une invitation Discord, ou laisser le champ vide. | — | #102 |
