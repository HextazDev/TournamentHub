# TournamentHub - Directives pour Claude Code & Antigravity

## 📌 Vue d'ensemble du Projet

**TournamentHub** est une plateforme e-sport multi-jeux de gestion de tournois combinant un Bot Discord (Node.js/Express) et une Application Web (Next.js 16 Back-office & Portail public).

### Architecture du Monorepo
* **`apps/bot`** : Backend Node.js / Express 5 + Discord.js 14 + Supabase Client (`@hub/bot`).
  * Gère les commandes Discord, les interactions (boutons, modales, select menus), la synchronisation des salons/rôles et les planifications de tournois (`SchedulerService`).
  * Expose une API HTTP interne sur le port 8080 (avec route `/health` et routes sécurisées par `BOT_API_SECRET`).
* **`apps/web`** : Frontend Next.js 16 (React 19) App Router + Tailwind CSS v4 + NextAuth v4 (`@hub/web`).
  * Espace public spectateurs/joueurs (`/[guildId]`) et Back-office organisateurs (`/admin/[guildId]`).
* **`packages/shared`** : Types TypeScript de domaine, interfaces et schémas Zod partagés (`@hub/shared`).
* **`supabase`** : Configuration PostgreSQL locale, migrations SQL (`supabase/migrations/*.sql`), fonctions RPC et politiques RLS.
* **`docs/EDGE_CASES.md`** : Registre vivant des cas limites, invariants multi-tenant et règles de résilience (brackets, BYE, scores, check-in, Discord). Chaque entrée a un ID stable (`BRK-02`, `SEC-01`…) et un statut de couverture (✅ Testé / 🛡️ Garde-fou / ⚠️ Non couvert).

---

## 🌐 Configuration propre à chaque instance

Les consignes publiques décrivent l'architecture et les commandes du projet. Les adresses d'administration, inventaires de services, identifiants de projets cloud, chemins locaux et procédures d'exploitation propres au mainteneur restent dans une documentation privée, hors du suivi Git.

- Utiliser uniquement les environnements et services explicitement autorisés pour la tâche. Une URL citée dans une documentation ne donne pas l'autorisation de contacter le service.
- Fournir les paramètres et secrets par l'environnement de l'instance. Ne jamais placer de token dans une URL, un exemple versionné, un log ou un message GitHub.
- Analyser les diagnostics localement par défaut. Avant tout partage de logs, stack traces, dumps ou données de joueurs, retirer les secrets et données personnelles ; ne transmettre que le minimum nécessaire, vers la destination expressément autorisée par l'utilisateur.
- Ne pas déployer ni contacter la production pour une simple tâche de développement. Toute opération de production doit être demandée et vérifiée séparément.

---

## 🥋 Rituel Obligatoire pour Résoudre une Issue

> [!IMPORTANT]
> **Avant de toucher au code pour résoudre une issue, appliquer OBLIGATOIREMENT le Skill de rituel :**
> * **Skill complet** : `.agents/skills/issue-ritual/SKILL.md` (accessible aussi via `.claude/skills/issue-ritual`)
> * **Commande rapide Claude Code** : `/resolve-issue <NUMERO>`

### Le Cycle en 5 Phases Systématiques :
1. **Phase 1 : Cadrage & Contexte Git (`gh issue view <NUMERO>`)** :
   * Vérifier la branche active (`git branch --show-current`), les commits de la branche (`git log main..HEAD --oneline`) et les modifs locales en cours (`git status --short`). Alerter si sur `main`.
   * Lire le ticket complet, cartographier les fichiers cibles et inspecter le schéma DB réel (`supabase/migrations/`).
   * Consulter systématiquement **`docs/EDGE_CASES.md`** pour relever les cas limites et invariants existants du domaine touché (IDs concernés).
2. **Phase 2 : 🛑 RÉCAPITULATIF & PLAN D'IMPLÉMENTATION (Point d'arrêt obligatoire)** :
   * Présenter un récapitulatif clair : État Git, Objectif, Fichiers impactés, Migration DB éventuelle, Cas limites (IDs `docs/EDGE_CASES.md` impactés, nouveaux cas à consigner ou obsolètes à purger), **Impact Sécurité** (routes, RLS, secrets) et Stratégie de tests TDD.
   * **STOP** : Attendre la validation explicite de l'utilisateur avant d'écrire la moindre ligne de code.
3. **Phase 3 : Implémentation Rigoureuse & Discipline d'Ingénierie** :
   * Ordre : `1. SQL/Migrations` ➔ `2. @hub/shared` ➔ `3. Services Bot` ➔ `4. Routes API` ➔ `5. Web UI` ➔ `6. Tests`.
   * ⚡ **Après modification de `packages/shared`** : exécuter impérativement `npm run build --workspace=@hub/shared`.
   * 🔴 **TDD strict avec Verify RED** : pour tout service métier ou utilitaire (`BracketGeneratorService`, `SchedulerService`), écrire le test Vitest d'abord, **constater l'échec terminal pour la raison attendue**, puis implémenter le code minimal pour passer au vert.
   * 🛡️ **Loi d'airain Anti-Symptôme (Anti-Band-Aids)** : interdiction formelle de poser une rustine pour faire taire le compilateur ou masquer une erreur (`?.` sauvage, `as any`, `as unknown as`, `try/catch` vide qui étouffe l'erreur). Identifier et corriger la cause racine.
   * 🔒 **Sécurité par défaut** : toute route de mutation appelle `verify*Guild` (`apps/bot/src/utils/tenant.ts`) avant d'écrire ; toute nouvelle table active la RLS avec politiques d'écriture restreintes ; toute fonction `SECURITY DEFINER` fixe son `search_path` ; aucun secret en `NEXT_PUBLIC_*` ; toute entrée externe (body, customId, modal) est validée (Zod / guards) avant usage.
   * 📝 **Registre des Cas Limites (`docs/EDGE_CASES.md`)** :
     - **Ajouter** : tout cas limite introduit ou corrigé ➜ nouvelle ligne avec ID et test Vitest référencé.
     - **Promouvoir** : une ligne 🛡️/⚠️ couverte par un nouveau test passe en ✅.
     - **Purger** : toute règle supprimée ou refondue est retirée ou réécrite dans le même diff (zéro dette documentaire).
   * 🎨 **Règles Front React 19 / Next.js 16** :
     - 3 états obligatoires : Loading Skeleton, Error toast/alerte avec retry, Empty state accueillant.
     - Nettoyage strict des ressources dans `useEffect` (timers, event listeners, channels Supabase Realtime).
     - `await params`, `"use client";`, `<Link>`, pas de `setState` synchrone dans `useEffect`.
4. **Phase 4 : Porte de Vérification (« Evidence Before Claims »)** :
   * Interdiction d'affirmer qu'une tâche est résolue sans **preuve terminale fraîche** :
     - `make test` : tests unitaires Vitest (100% de succès).
     - `make lint` : 0 erreur de typage / linting sur l'ensemble du monorepo.
     - `make build` : compilation globale réussie.
   * 🧪 **Preuve des cas limites** : chaque cas limite annoncé en Phase 2 a un test Vitest qui passe (ou un garde-fou explicite justifié).
   * 🔒 **Auto-contrôle sécurité** : si le diff touche `routes/`, `middleware/`, `supabase/migrations/`, l'auth NextAuth ou des variables d'environnement, dérouler la checklist du skill `security-auditor` sur le diff (ou lancer `/security-audit <chemin>`).
   * 🌍 **Vérification des traductions** : si le diff ajoute/modifie du texte visible (web ou bot) ou touche `**/i18n/**`, `node .agents/skills/i18n-auditor/scripts/check-i18n.mjs` doit sortir en exit 0 et aucun texte en dur ne doit être introduit (ou `/i18n-audit --diff`).
5. **Phase 5 : Clôture & Mini-Rapport (PAS D'AUTO-COMMIT)** :
   * `git diff` audité sans console.log ou fichiers parasites. Zéro `any`. **`docs/EDGE_CASES.md` synchronisé**.
   * Interdiction formelle d'exécuter `git commit` automatiquement.
   * Mini-rapport en 5 lignes max (fichiers modifiés, preuves terminales, cas limites testés, instructions de test local `make dev`, commande de commit suggérée).
   * Rappel : une fusion sur `main` peut déclencher un déploiement configuré par l'exploitant. Ouvrir une PR ; ne pas pousser directement sur `main` ni déclencher un déploiement sans demande explicite.

---

## 🧐 Code Reviewer Intransigeant (Skill d'Audit Staff Engineer)

Le monorepo intègre un skill d'audit complet pour évaluer le code avec un niveau d'exigence maximal (Architecture, Sécurité, Perf, Clean Code, Typage, Tests) :
* **Skill complet** : `.agents/skills/code-reviewer/SKILL.md` (accessible aussi via `.claude/skills/code-reviewer`)
* **Commandes rapides** :
  * `/code-review` : Audite le diff de la branche courante.
  * `/code-review --full` : Audite l'architecture globale du monorepo.
  * `/code-review <chemin/vers/fichier>` : Audite un fichier spécifique.

---

## 🧪 Test Auditor (Audit Approfondi de Testabilité & Fiabilité)

Skill d'audit dédié à l'évaluation impitoyable de la suite de tests Vitest (Staff QA / Test Architect) :
* **Skill complet** : `.agents/skills/test-auditor/SKILL.md`
* **Commande rapide** : `/test-audit [--all | <service> | <fichier_test>]`

---

## 🔒 Security Auditor (Audit de Sécurité Multi-Tenant & AppSec)

Skill d'audit dédié à la sécurité applicative, au cloisonnement strict et à la protection des endpoints :
* **Skill complet** : `.agents/skills/security-auditor/SKILL.md`
* **Commande rapide** : `/security-audit [--full | <routes> | <migrations>]`

---

## 🌍 i18n Auditor (Audit des Traductions FR / EN)

Skill d'audit de l'internationalisation web & bot (parité des dictionnaires, clés fantômes, textes en dur, formatage des dates, résolution de la langue) :
* **Skill complet** : `.agents/skills/i18n-auditor/SKILL.md`
* **Script mécanique** : `node .agents/skills/i18n-auditor/scripts/check-i18n.mjs` (exit 1 si anomalie bloquante)
* **Commande rapide** : `/i18n-audit [--all | --diff | <chemin>]`

---

## 💡 Issue Crafter (Atelier d'Idéation, Qualification & Triage)

Permet de transformer une idée brute en spécification "Agent-Ready" après un échange critique, et de la publier/trier sur GitHub Project #2 :
* **Skill complet** : `.agents/skills/issue-crafter/SKILL.md`
* **Commande rapide** : `/create-issue [description ou idée]`

---

## 🛠️ Commandes Makefile & Scripts Essentiels (Sans Watch)

Le projet utilise un `Makefile` pour orchestrer les tâches monorepo. **Toujours exécuter les commandes sans mode interactif/watch.**

### 1. Tests Unitaires
```bash
# Via Makefile (exécute Vitest en mode 'run' sur tout le monorepo)
make test

# Ou via npm
npm run test

# Exécuter un fichier de test spécifique
npx vitest run apps/bot/src/__tests__/BracketGeneratorService.test.ts

# Filtrer les tests par nom de suite
npx vitest run apps/bot -t "BracketGenerator"
```

### 2. Linting & Validation de Types
```bash
# Via Makefile (valide le typage bot avec tsc --noEmit + eslint sur web)
make lint

# Typecheck granulaire par package
npx tsc --noEmit --project packages/shared/tsconfig.json
npx tsc --noEmit --project apps/bot/tsconfig.json
npx tsc --noEmit --project apps/web/tsconfig.json
```

### 3. Compilation & Build
```bash
# Compiler le monorepo complet dans l'ordre de dépendance (Shared -> Bot -> Web)
make build

# Important : Si vous modifiez uniquement packages/shared, recompilez-le avec :
npm run build --workspace=@hub/shared
```

### 4. Environnement Local & Docker
```bash
make supabase-start   # Démarre la stack Supabase locale (Docker)
make supabase-stop    # Arrête la stack Supabase locale
make db-init          # Applique les migrations SQL sur la base locale
make dev              # Démarre Next.js et le Bot Discord en arrière-plan
make dev-logs         # Affiche les logs en direct des conteneurs
make dev-stop         # Arrête les conteneurs de dev
```

---

## 📐 Conventions TypeScript & Monorepo

### 1. Gestion des Types Partagés (`packages/shared`)
* Toute structure de données partagée (`Tournament`, `Phase`, `Match`, `Team`, `User`) et tout schéma Zod commun doit résider dans `packages/shared/src/index.ts`.
* **Règle absolue** : Après chaque modification dans `packages/shared`, lancer `npm run build --workspace=@hub/shared` pour régénérer les fichiers `dist/index.d.ts` et `dist/index.js`.
* Importer dans `apps/bot` et `apps/web` exclusivement via `@hub/shared`.

### 2. Typage Strict (`apps/bot`)
Le `tsconfig.json` du bot applique un typage strict renforcé :
* `noUncheckedIndexedAccess: true` : L'accès aux tableaux ou clés d'objets (`arr[i]`, `dict[key]`) renvoie `T | undefined`. Toujours vérifier l'existence avec des guards (`if (!item) return;`) ou l'opérateur de coalescence nulle `??`.
* `exactOptionalPropertyTypes: true` : Ne jamais assigner la valeur `undefined` à une clé optionnelle (`foo?: string`), sauf si son type autorise explicitement `string | undefined`.

### 3. Spécificités Next.js 16 & React 19 (`apps/web`)
* **Paramètres asynchrones** : Dans Next.js App Router, `params` et `searchParams` sont des Promises (`const { guildId } = await params;`).
* **Composants Client** : Placer obligatoirement `"use client";` au tout début des fichiers utilisant l'interactivité ou des hooks React.
* **Composant Link** : Utiliser impérativement `<Link href="...">` de `next/link` pour la navigation interne.
* **Effets React** : Ne pas appeler de `setState` synchrone directement dans le corps d'un `useEffect`.

### 4. Base de Données & Supabase
* **Enums PostgreSQL** :
  * `tournament_status` : `'DRAFT'`, `'REGISTRATION'`, `'ACTIVE'`, `'COMPLETED'`, `'ARCHIVED'`.
  * `phase_type` : `'ROUND_ROBIN'`, `'SINGLE_ELIM'`, `'SWISS'`, `'DOUBLE_ELIM'`.
* **Cloisonnement Multi-Tenant** :
  * Toute requête SQL ou mutation API doit être vérifiée et restreinte par `guild_id` ou via `verifyTournamentGuild` / `verifyPhaseGuild` (`apps/bot/src/utils/tenant.ts`).
* **Migrations** : Tout changement de schéma SQL doit être formalisé dans un nouveau fichier timestampé sous `supabase/migrations/`.

### 5. Registre Vivant des Cas Limites (`docs/EDGE_CASES.md`)
* Toute modification de code impactant la génération de brackets/poules/rondes suisses, la gestion des BYE et forfaits, la validation des scores, les fenêtres d'inscription/check-in, le cloisonnement multi-tenant ou la résilience Discord DOIT maintenir [`docs/EDGE_CASES.md`](docs/EDGE_CASES.md) rigoureusement synchronisé.
* Un cas limite n'est maîtrisé que s'il est prouvé par un test (`make test`) ou un garde-fou explicite. Les lignes ⚠️ sont des bugs latents connus : ne jamais les aggraver, et les traiter via une issue dédiée.

### 6. Journalisation Structurée & Observabilité
* **Logger Winston (`apps/bot/src/utils/logger.ts`)** :
  * Utiliser systématiquement `logger.info()`, `logger.warn()` et `logger.error()` à la place de `console.log()` anarchiques.
  * Formats adaptés : mode développement lisible avec couleurs et timestamps, mode production structuré.
* **Horodatage Standardisé PM2 (`--time`)** :
  * PM2 préfixe automatiquement les flux avec `YYYY-MM-DD HH:mm:ss: `.
  * Interdiction d'ajouter des dates ISO brutes manuelles dans les messages textuels.
* **Ségrégation Stderr vs Stdout** :
  * `stdout` : Démarrage du bot, réceptions d'événements, synchronisations d'équipes et de brackets.
  * `stderr` : Erreurs API Discord, rejets de requêtes Supabase, exceptions inattendues.
  * Consulter les flux dans l'environnement autorisé ; conserver les adresses d'administration et moyens d'authentification hors des consignes publiques.
* **Capture des Crashs & Stack Traces (Bus PM2)** :
  * Toujours transmettre l'objet `Error` complet : `logger.error('Échec génération bracket:', error)`.
  * Si l'exploitant utilise le bus PM2 (`pm2.launchBus`), les alertes doivent rester sur une destination autorisée et exclure secrets et données personnelles.
* **Diagnostics volumineux** :
  * Ne jamais dumper de brackets JSON volumineux dans la console.
  * Conserver les dumps localement par défaut. Tout transfert externe nécessite une destination autorisée et une suppression préalable des secrets et données de joueurs.

---

## 🐙 Conventions de Commits & PR

* Appliquer rigoureusement la convention **Conventional Commits** :
  * `feat(scope): description` (Nouvelle fonctionnalité)
  * `fix(scope): description` (Correction de bug)
  * `ux(scope): description` (Amélioration UI / Toast / Dialogue)
  * `refactor(scope): description` (Refactoring interne)
  * `test(scope): description` (Tests unitaires)
* Toujours mentionner le numéro de ticket GitHub associé (ex: `#20`).
