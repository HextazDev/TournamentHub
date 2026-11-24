# Commande `/code-review` - Revue de Code Intransigeante (Staff Engineer)

Déclenche l'audit sur : `$ARGUMENTS`.

## Instructions pour Claude :

1. **Périmètre** :
   * `--full` : audit architectural global du monorepo.
   * Un chemin de fichier (ex: `apps/bot/src/services/BracketGeneratorService.ts`) : ce fichier et ses dépendances directes.
   * Vide ou `--diff` : modifications courantes (diff de la branche vs `main`).
2. **Charge la source unique** : lis `.agents/skills/code-reviewer/SKILL.md`, exécute son diagnostic préalable (`make lint`, `make test`, scans `rg` des anti-patterns) et évalue les 6 piliers.
3. **Restitution** : suis exactement le format de rapport du SKILL.md — scorecard /100, anomalies préfixées `AUD-`, matrice effort/impact, plan de remédiation par scope (pas de « prompts à copier »).
