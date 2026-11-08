# Commande `/i18n-audit` - Audit de l'Internationalisation (FR / EN)

Déclenche l'audit sur : `$ARGUMENTS` (`--all`, `--diff`, ou un chemin vers un fichier / dossier).

## Instructions pour Claude / Antigravity :

1. **Preuve mécanique d'abord** :
   ```bash
   node .agents/skills/i18n-auditor/scripts/check-i18n.mjs
   ```
   Affiche le résumé (nombre de clés par locale, anomalies bloquantes, code de sortie).
2. **Charge la source unique** : lis `.agents/skills/i18n-auditor/SKILL.md`, restreins le périmètre :
   * vide ou `--all` : web (`apps/web/src`) + bot (`apps/bot/src`) + migrations touchant `language` ;
   * `--diff` : fichiers de `git diff --name-only main...HEAD` ;
   * chemin fourni : ce chemin (le script reste global pour la parité).
   Confirme ou écarte chaque 🟠/🟡 du script en lisant le code (faux positifs exclus du rapport).
3. **Restitution** : format du SKILL.md — scorecard /100, anomalies préfixées `AUD-`, plan de correction par scope (pas de « prompts à copier »).
