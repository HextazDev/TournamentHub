# Commande `/test-audit` - Audit Approfondi des Tests & Fiabilité

Déclenche l'audit sur : `$ARGUMENTS` (`--all`, un service, ou un fichier de test).

## Instructions pour Claude / Antigravity :

1. **Périmètre** :
   * Vide ou `--all` : toute la suite sous `apps/bot/src/__tests__/`.
   * Un service (ex: `apps/bot/src/services/BracketGeneratorService.ts`) : complétude des tests associés.
   * Un fichier de test : qualité des assertions et des mocks (AAA, tests creux, fake timers).
2. **Charge la source unique** : lis `.agents/skills/test-auditor/SKILL.md` et évalue ses 5 piliers.
3. **Restitution** : format du SKILL.md — scorecard /100, anomalies préfixées `AUD-`, plan de création des tests manquants direct (pas de « prompts à copier »).
