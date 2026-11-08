# Commande `/create-issue` - Atelier Interactif de Cadrage & Création d'Issue

Lance l'atelier pour : `$ARGUMENTS` (idée brute, besoin ou description sommaire, facultatif).

## Instructions pour Claude :

1. **Charge la source unique** : lis `.agents/skills/issue-crafter/SKILL.md` et suis ses 5 phases :
   interview & challenge produit (doublons via `gh issue list --state all`) → grounding technique (migrations, `@hub/shared`, services bot, UI web) → rédaction « Agent-Ready » + triage proposé → **validation explicite du brouillon** → publication `gh issue create`.
2. **Point d'arrêt obligatoire** : ne JAMAIS exécuter `gh issue create` sans la validation explicite de l'utilisateur.
3. **Triage Project #2** : réservé à l'instance du mainteneur (`node scripts/triage-issue.js`). En cas d'accès refusé (fork, contributeur externe), sauter cette étape et ne retenir que le lien de l'issue créée.
4. **Restitution** : lien direct vers l'issue (`#<NUMERO>`), statut du triage si appliqué, et commande suggérée `/resolve-issue <NUMERO>`.
