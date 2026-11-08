# Commande `/security-audit` - Audit de Sécurité Multi-Tenant & AppSec

Déclenche l'audit sur : `$ARGUMENTS` (`--full`, ou un chemin vers des routes, des migrations ou des middlewares).

## Instructions pour Claude / Antigravity :

1. **Périmètre** :
   * Vide ou `--full` : monorepo complet (routes Express, migrations Supabase, middlewares Next.js, variables d'environnement).
   * `apps/bot/src/routes/` : cloisonnement multi-tenant et prévention IDOR (`verify*Guild`).
   * `supabase/migrations/` : politiques RLS et `SET search_path` des fonctions RPC `SECURITY DEFINER`.
2. **Charge la source unique** : lis `.agents/skills/security-auditor/SKILL.md` et évalue ses 5 piliers.
3. **Restitution** : format du SKILL.md — scorecard /100, vulnérabilités préfixées `AUD-`, plan de remédiation P0/P1 direct (pas de « prompts à copier »).
