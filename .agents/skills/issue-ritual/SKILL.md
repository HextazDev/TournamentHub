---
name: issue-ritual
description: Rituel d'exécution obligatoire pour Claude Code et Antigravity lors de la résolution de toute issue sur TournamentHub. Comprend le cadrage Git initial, la présentation d'un plan d'implémentation à valider avant de coder, le TDD strict avec Verify RED, la couverture des cas limites via docs/EDGE_CASES.md, la checklist de sécurité multi-tenant, la loi d'airain anti-bandaids, les règles React 19, la vérification des traductions FR/EN (i18n-auditor), le protocole Evidence Before Claims du Makefile, et un bilan final sans commit automatique.
---

# 🥋 Rituel de Résolution d'Issue - TournamentHub

Ce rituel structure le travail de l'agent en **5 phases rigoureuses**. Il impose un **point d'arrêt obligatoire (Gate d'approbation)** après la récolte d'informations pour valider le plan avec l'utilisateur, applique une **discipline d'ingénierie d'élite (TDD, Anti-Band-Aids, Evidence Before Claims)**, et **interdit formellement tout commit automatique**.

---

## 🧭 Vue d'ensemble du Déroulement

```
┌─────────────────────────────────────────┐
│ PHASE 1 : Cadrage & Récolte d'Infos    │ ➜ Git context, gh issue view, DB inspection, shared types, EDGE_CASES
└────────────────────┬────────────────────┘
                     ▼
┌─────────────────────────────────────────┐
│ PHASE 2 : 🛑 RÉCAPITULATIF & PLAN       │ ➜ Présenter le plan et attendre le feu vert explicite !
└────────────────────┬────────────────────┘
                     ▼ (Validation utilisateur)
┌─────────────────────────────────────────┐
│ PHASE 3 : Implémentation & TDD Strict   │ ➜ TDD Verify RED ➜ Sécurité ➜ Anti-Band-Aids ➜ DB ➜ Shared ➜ Bot ➜ Web
└────────────────────┬────────────────────┘
                     ▼
┌─────────────────────────────────────────┐
│ PHASE 4 : 🧪 Porte de Vérification      │ ➜ make test/lint/build + preuve cas limites + auto-contrôle sécu + i18n
└────────────────────┬────────────────────┘
                     ▼
┌─────────────────────────────────────────┐
│ PHASE 5 : Bilan Final (Zéro Auto-Commit)│ ➜ Diff propre, mini-rapport 5 lignes, commande commit prête
└─────────────────────────────────────────┘
```

---

## 📍 PHASE 1 : Cadrage & Collecte d'Informations (Ne jamais coder à l'aveugle)

### 1.1 Contexte Git & État de la Branche (CRUCIAL)
Avant toute analyse, vérifier où l'on se trouve pour ne pas écraser de travail ou polluer l'historique :
```bash
# 1. Quelle est la branche active ?
git branch --show-current

# 2. Quels sont les commits déjà présents sur cette branche par rapport à main ?
git log main..HEAD --oneline

# 3. Y a-t-il des modifications en cours non commitées ?
git status --short
git diff
```
* **Vérifications clés** :
  * Si la branche est `main`, alerter l'utilisateur et recommander la création d'une branche dédiée : `git checkout -b feature/issue-<NUMERO>`.
  * Si des commits existent déjà sur la branche (`git log main..HEAD`), en prendre connaissance pour **ne pas réécrire ou réinventer ce qui a déjà été fait**.
  * Si des fichiers sont déjà modifiés/non commités (`git status`), les analyser pour distinguer ce qui relève du ticket en cours d'éventuels résidus d'une autre session.

### 1.2 Lire le ticket complet
```bash
gh issue view <NUMERO> --json number,title,body,labels
```
* Extraire les spécifications fonctionnelles, les fichiers cibles et les critères d'acceptation.
* Identifier la complexité et la priorité (P0, P1, P2).

### 1.3 Inspecter l'état réel du codebase
1. **Recherche de symboles existants** :
   ```bash
   rg "nomDuSymboleOuModele" packages/shared/ apps/bot/src/ apps/web/src/
   ```
2. **Vérité Base de Données** :
   * Inspecter `supabase/migrations/*.sql` pour connaître les colonnes et types réels.
   * ⚠️ **Piège classique** : `tournament_status` en DB vaut `'DRAFT'`, `'REGISTRATION'`, `'ACTIVE'`, `'COMPLETED'`, `'ARCHIVED'` (ne JAMAIS chercher `'in_progress'`).
3. **Vérité Types `@hub/shared`** :
   * Inspecter `packages/shared/src/index.ts` pour identifier les interfaces et schémas Zod à réutiliser ou étendre.
4. **Registre des Cas Limites (`docs/EDGE_CASES.md`)** :
   * Consulter systématiquement `docs/EDGE_CASES.md` et relever les IDs du domaine touché (`BRK-*`, `SWS-*`, `SCR-*`, `REG-*`, `SEC-*`, `DISC-*`…).
   * Repérer les lignes ⚠️ **Non couvert** du périmètre : le ticket ne doit jamais les aggraver, et peut être l'occasion de les corriger (à proposer en Phase 2).
5. **Surface de Sécurité** :
   * Le ticket touche-t-il une route Express, un middleware, une migration (RLS/RPC), l'auth NextAuth, le proxy `/api/bot/[...path]` ou une variable d'environnement ? Si oui, relire la checklist du skill `.agents/skills/security-auditor/SKILL.md` avant de planifier.
6. **Surface de Traduction (i18n)** :
   * Le ticket ajoute-t-il ou modifie-t-il du texte visible (JSX, toast, modale, embed/bouton/modal Discord, réponse éphémère) ? Si oui, repérer les namespaces existants dans `apps/web/src/i18n/locales/{fr,en}.ts` et `apps/bot/src/i18n/locales/{fr,en}.ts` à réutiliser ou étendre.

---

## 🛑 PHASE 2 : Récapitulatif & Validation du Plan (POINT D'ARRÊT OBLIGATOIRE)

> [!IMPORTANT]
> **Ne modifier AUCUN fichier de code avant d'avoir présenté ce récapitulatif et obtenu la confirmation explicite de l'utilisateur.**

L'agent doit produire un bilan clair structuré comme suit :
1. **🌿 Contexte Git** : Branche active, commits déjà existants pris en compte, statut des modifications locales en cours.
2. **🎯 Objectif & Périmètre** : Résumé en 2-3 phrases de ce que le ticket accomplit.
3. **📂 Fichiers impactés** : Liste ordonnée des fichiers à modifier ou créer.
4. **🗄️ Impact Base de Données** : Nouvelle migration SQL nécessaire (oui/non) avec schéma succinct.
5. **⚠️ Cas limites & Pièges identifiés** : IDs `docs/EDGE_CASES.md` impactés, nouveaux cas à consigner, cas obsolètes à purger. Penser systématiquement : valeurs nulles / `undefined`, BYE et nombres impairs, égalités, forfaits, double-clic / appels concurrents, redémarrage du bot en cours d'opération, ressource Discord supprimée.
6. **🌍 Impact Traductions** : Clés FR/EN à créer ou réutiliser (web/bot), ou *« Aucun texte visible »* explicitement.
7. **🔒 Impact Sécurité** : Routes ou tables touchées, contrôle `verify*Guild` prévu, politiques RLS, validation des entrées, secrets. Écrire *« Aucun impact sécurité »* explicitement si c'est le cas.
8. **🧪 Stratégie de tests & TDD** : Tests Vitest prévus (`apps/bot/src/__tests__/...`), **un test par cas limite annoncé** au point 5, et les tests de refus (`403` cross-guild, entrée invalide) pour le point 7.
9. **❓ Questions / Arbitrages éventuels** (si ambiguïté subsistante).
10. **Demande explicite** : *"Ce plan te convient-il ? Dois-je commencer l'implémentation ?"*

---

## 💻 PHASE 3 : Implémentation Rigoureuse & Discipline d'Ingénierie

Appliquer les modifications dans l'ordre strict des dépendances du monorepo :

```
1. supabase/migrations/     ➜ Nouveau fichier SQL si la DB évolue
2. packages/shared/src/     ➜ Types TypeScript & Schémas Zod
   └── ⚡ REBUILD OBLIGATOIRE : npm run build --workspace=@hub/shared
3. apps/bot/src/services/   ➜ Logique métier, générateurs de brackets/poules (TDD strict !)
4. apps/bot/src/routes/     ➜ Endpoints Express & Middlewares
5. apps/bot/src/commands/   ➜ Commandes Discord (si applicable)
6. apps/web/src/app/        ➜ Pages Next.js, Layouts, Composants
7. apps/bot/src/__tests__/  ➜ Tests unitaires Vitest
8. docs/EDGE_CASES.md        ➜ Synchronisation du registre des cas limites (ajout, promotion ✅, purge)
```

### 3.0 — Discipline d'Ingénierie & TDD Strict (Inspirée de Superpowers)

- **TDD strict pour la logique métier, les services et utilitaires** (`BracketGeneratorService`, `SchedulerService`, gestion des scores, seeding) :
  1. *RED* : Écrire le test Vitest minimal décrivant le comportement attendu avant le code métier.
  2. *VERIFY RED (Obligatoire)* : Exécuter `npx vitest run apps/bot/src/__tests__/NomDuTest.test.ts` et **constater l'échec pour la raison attendue**. Un test qui passe immédiatement est un test qui ne prouve rien.
  3. *GREEN* : Écrire le code minimal strict pour satisfaire le test.
  4. *VERIFY GREEN* : Ré-exécuter et vérifier que le test passe au vert.
  5. *REFACTOR* : Factoriser et nettoyer en restant vert.

- **Tests des cas limites, pas seulement du happy path** :
  - Chaque cas limite listé en Phase 2 devient un `it(...)` dédié, nommé d'après son ID (`it("BRK-02: 6 équipes ➜ 2 BYE propagés au R2", ...)`).
  - Les assertions portent sur le **comportement observable** (matchs insérés, statuts, équipes propagées, code HTTP), pas sur l'appel d'un mock.
  - Mocker Supabase et Discord à la frontière (`vi.mock("../lib/supabase")`) ; la logique pure (seeding, appariement, classement) doit être extraite et testée sans mock.
  - Pour tout contrôle d'accès ajouté : tester le chemin **refusé** (`403` cross-guild, capitaine non autorisé) autant que le chemin accepté.

- **Loi d'Airain Anti-Symptôme (Anti-Band-Aids & Anti-`any`)** :
  - **Aucune modification de code sans avoir formellement identifié et prouvé la cause racine.**
  - **Interdiction formelle de poser une rustine pour faire taire le compilateur ou masquer une erreur console** : pas de `?.` (optional chaining) sauvage, pas de `try/catch` vide qui étouffe les erreurs en silence, pas de fallback magique (`?? null`) pour masquer un état corrompu.
  - **Interdiction formelle d'utiliser `any`** ou des assertions abusives (`as any`, `as unknown as ...`). Les types doivent provenir de `@hub/shared` ou d'un narrowing Zod explicite.

### 3.1 — Règles de Code & Garde-Fous Techniques :

- **La Règle d'Or `@hub/shared`** : Dès que `packages/shared/src/index.ts` est modifié, lancer immédiatement `npm run build --workspace=@hub/shared`.
- **TypeScript strict (`apps/bot`)** :
  - `noUncheckedIndexedAccess: true` : Tout accès `arr[i]` est `T | undefined`. Toujours vérifier l'existence avec un guard (`if (!item) return;`) ou une valeur de repli `??`.
  - `exactOptionalPropertyTypes: true` : Ne jamais assigner `{ key: undefined }` sur une clé optionnelle.
- **Règles Non Négociables Front Next.js 16 / React 19 (`apps/web`)** :
  - **Gestion des 3 états obligatoires** : Tout écran ou bloc chargeant des données doit gérer :
    1. L'état de chargement (**Skeleton**, pas de spinner plein écran instable).
    2. L'état d'erreur (**Toast / Alerte** claire avec possibilité de réessayer).
    3. L'état vide (**Empty State** accueillant avec CTA d'action).
  - **Nettoyage strict des ressources (`useEffect`)** : Tout écouteur, timer ou souscription Supabase Realtime channel (`supabase.channel()`) DOIT impérativement être nettoyé dans la fonction de retour du `useEffect` (`supabase.removeChannel(channel)`).
  - **Paramètres asynchrones** : `params` et `searchParams` sont des Promises : `const { guildId } = await params;`.
  - **Composants Client** : Directive `"use client";` obligatoire dès qu'un hook (`useState`, `useEffect`, `useRouter`) est utilisé.
  - **Composant Link** : Utiliser impérativement `<Link href="...">` de `next/link`.
  - **Pas de `setState` synchrone** directement dans le corps d'un `useEffect`.
  - **Pas de `window.alert()` / `window.confirm()`** ➜ utiliser Toasts (`sonner`) et modales.
- **Traductions FR/EN (web & bot)** :
  - **Zéro texte visible en dur** : web ➜ `t("namespace.key")` (client, `useTranslation`) ou `t(locale, "namespace.key")` (server component) ; bot ➜ `tBot(lang, "namespace.key")` avec `lang` issu de `getGuildLanguage(guildId, tournamentId)`.
  - **Toute clé ajoutée l'est dans les deux locales** (`fr.ts` **et** `en.ts`), avec les mêmes placeholders `{param}`.
  - **Pas de concaténation de phrases** : `t("k", { name })` plutôt que `t("a") + name + t("b")`.
  - **Dates & nombres** formatés depuis la locale active (`Intl.*`, `dayjs.locale(locale)`), jamais `"fr-FR"` en dur.
- **Checklist Sécurité (non négociable)** :
  - **Multi-tenant (IDOR)** : toute route de mutation résout le guild authentifié (`getAuthenticatedGuildId`) puis appelle le `verify{Tournament,Phase,Team,Match}Guild` correspondant **avant** toute écriture. Ne jamais faire confiance à un `guild_id` ou un UUID venant du body sans ce contrôle.
  - **Autorisation Discord** : les interactions (boutons, modals, select menus) vérifient que `interaction.user.id` est bien l'acteur autorisé (capitaine concerné, TO). Un `customId` est une entrée utilisateur : re-valider l'état en DB (statut du match, fenêtre d'inscription) au moment du clic.
  - **Idempotence** : toute action déclenchable deux fois (double-clic, retry réseau, redémarrage PM2) vérifie l'état courant avant de muter (cf. `SCR-05`).
  - **Supabase** : nouvelle table ➜ `ENABLE ROW LEVEL SECURITY` + politiques d'écriture restreintes ; fonction `SECURITY DEFINER` ➜ `SET search_path = public` ; opérations multi-lignes ➜ RPC transactionnelle.
  - **Secrets** : aucun secret dans une variable `NEXT_PUBLIC_*`, aucun token dans les logs, `BOT_API_SECRET` uniquement côté serveur.
  - **Validation d'entrée** : body Express validé par Zod (`middleware/validate.ts`) ; scores bornés, IDs au format UUID.

---

## 🧪 PHASE 4 : Porte de Vérification (« Evidence Before Claims »)

> [!CAUTION]
> **Interdiction formelle d'affirmer qu'une tâche est terminée, qu'un bug est résolu ou que le code compile sans en apporter la preuve terminale fraîche.**

Exécuter et afficher les résultats des 3 commandes sans watch :

```bash
# 1. Tests unitaires Vitest (0 échec, code de sortie 0)
make test

# 2. Validation TypeScript et ESLint (0 erreur tolérée sur tout le monorepo)
make lint

# 3. Compilation complète de production (Shared ➜ Bot ➜ Web)
make build
```

Si l'une des commandes échoue, corriger immédiatement à la racine avant de continuer.

**4. Preuve des cas limites** : pour chaque cas limite annoncé en Phase 2, citer le test qui le couvre et vérifier qu'il figure dans la sortie de `make test`. Un cas limite sans test doit être justifié par un garde-fou explicite et marqué 🛡️ dans `docs/EDGE_CASES.md`.

**5. Auto-contrôle sécurité** : si le diff touche `apps/bot/src/routes/`, `apps/bot/src/middleware/`, `supabase/migrations/`, `apps/web/src/app/api/` ou des variables d'environnement, relire le diff avec la checklist du skill `security-auditor` (ou lancer `/security-audit <chemin>`) et reporter le résultat dans le bilan. Toute faille 🔴 bloque la clôture.

**6. Vérification des traductions** : si le diff ajoute ou modifie du texte visible (web ou bot) ou touche `**/i18n/**`, exécuter :

```bash
node .agents/skills/i18n-auditor/scripts/check-i18n.mjs
```

Le script doit sortir en **exit 0** (parité FR/EN, aucune clé utilisée mais non définie, placeholders identiques), et **aucun fichier du diff** ne doit figurer dans la section « Textes en dur suspects » pour une chaîne introduite par le ticket (faux positifs justifiés dans le bilan). Pour un audit approfondi : `/i18n-audit --diff`.

---

## 📦 PHASE 5 : Bilan Final & Clôture (PAS D'AUTO-COMMIT)

> [!CAUTION]
> **Interdiction formelle d'exécuter `git commit` automatiquement.**
> Le commit appartient à l'utilisateur. L'agent prépare le terrain, audite la propreté du diff, et fournit la commande de commit prête à copier.

### 5.1 Audit de propreté du Diff
```bash
git status
git diff
```
* **Nettoyage strict** : Aucun `console.log("DEBUG", ...)` résiduel, aucun fichier temporaire, aucun code mort, aucun `any` introduit, et **`docs/EDGE_CASES.md` synchronisé** (nouveaux cas consignés, lignes promues en ✅, cas obsolètes purgés).

### 5.2 Mini-Rapport de Clôture (5 lignes max)
Terminer systématiquement par un rapport dense et percutant :
1. **Fichiers modifiés** : Liste synthétique des fichiers code, schémas et documentation touchés (`docs/EDGE_CASES.md`).
2. **Preuves terminales validées** : `make test` (X/X passés), `make lint` (0 erreur), `make build` (Succès).
3. **Cas limites, sécurité & i18n** : IDs `docs/EDGE_CASES.md` couverts (ex : `BRK-02 ✅`, `SCR-05 ✅`), résultat de l'auto-contrôle sécurité et de `check-i18n.mjs` (ou « aucun impact »).
4. **Test local** : Commande pour tester (`make dev`) et URL locale (`http://localhost:3000`).
5. **Commande de commit & Déploiement Homelab** :
   ```bash
   git add <fichiers concernés>
   git commit -m "<type>(<scope>): <description claire> (#<NUMERO>)"
   # Pousser la branche de travail, puis ouvrir une PR. Aucun déploiement implicite.
   git push origin HEAD
   ```
   * **Suivi de mise en production** : uniquement si un déploiement a été demandé, vérifier le monitoring et les logs dans l'environnement autorisé. Conserver les coordonnées d'exploitation hors des consignes publiques.

