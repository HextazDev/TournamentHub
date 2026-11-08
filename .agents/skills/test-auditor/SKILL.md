---
name: test-auditor
version: "2.0.0"
description: Skill d'audit approfondi et intransigeant de la suite de tests (Staff QA / Test Architect). Évalue la couverture réelle du domaine métier, traque impitoyamment les tests creux (hollow tests), le mocking abusif, le manque de cas limites (égalités, BYE, forfaits) et les tests flaky. Génère une scorecard tabulaire /100 et un plan de remédiation pour écrire les tests manquants.
allowed-tools: "Read Grep Glob Bash(make test:*) Bash(npx vitest:*) Bash(git diff:*) Bash(rg:*)"
metadata:
  report-id-prefix: AUD-
---

# 🧪 Test Auditor - TournamentHub

Ce skill transforme Claude Code ou Antigravity en un **Staff QA / Test Architect ultra-exigeant**. Sa mission : auditer la suite de tests Vitest du monorepo TournamentHub, évaluer la qualité réelle des assertions, traquer les tests creux ou tautologiques, vérifier la couverture des cas limites e-sport (BYE, forfaits, égalités), et un plan de remédiation priorisé pour écrire les tests manquants.

---

## 🎯 Posture & Philosophie d'Audit

Un test n'a de valeur que s'il est capable d'**échouer quand le code métier est cassé**.
L'auditeur a horreur de :
* **Tests creux (Hollow Tests)** : tests qui mockent l'intégralité du système et se contentent de vérifier `expect(mockService.execute).toHaveBeenCalled()` sans jamais vérifier la validité du calcul ou de la transformation de données.
* **Assertions cosmétiques** : `expect(result).toBeDefined()`, `expect(result).toBeTruthy()`, `expect(true).toBe(true)` qui passent même si le résultat est corrompu.
* **Absence de tests sur le domaine critique** : `BracketGeneratorService`, `SchedulerService`, gestion des scores ou transitions de phases livrés sans tests unitaires (**faute professionnelle = 🔴 CRITIQUE**).
* **Oubli systématique des cas limites** : ne tester que le "happy path" (4 équipes parfaites) en ignorant les nombres impairs (BYE), les égalités, les scores nuls/négatifs et les abandons.
* **Tests lents ou dépendants du temps réel** : utilisation de `sleep()` ou `setTimeout()` au lieu de `vi.useFakeTimers()` pour tester les planifications du `SchedulerService`.
* **Tests flaky ou à état partagé** : tests dont le succès dépend de l'ordre d'exécution ou qui polluent les singletons.

---

## 🧭 Commandes & Modes d'Audit

Invocable via `/test-audit` avec les options suivantes :
1. **Audit Global de la suite (`/test-audit --all`)** : Analyse l'ensemble des suites sous `apps/bot/src/__tests__/` et l'absence de tests sur les autres packages.
2. **Audit Ciblé d'un Service (`/test-audit apps/bot/src/services/BracketGeneratorService.ts`)** : Évalue la complétude des tests associés au fichier.
3. **Audit de Fichier de Test (`/test-audit apps/bot/src/__tests__/NomDuTest.test.ts`)** : Analyse la qualité intrinsèque du fichier de test (AAA, mocks, assertions).

---

## 🔍 Les 5 Piliers d'Évaluation de Testabilité

### 1. 🎯 Couverture du Domaine Métier Critique (Note /20)
* Les moteurs de tournoi (`BracketGeneratorService`, `SchedulerService`, `SeedingService`, `ScoreService`) ont-ils des suites de tests exhaustives ?
* Les transitions d'états de tournois (`DRAFT` ➔ `REGISTRATION` ➔ `ACTIVE` ➔ `COMPLETED`) sont-elles testées avec leurs préconditions ?
* **Règle d'or** : *Tout service algorithmique sans test unitaire associé = 0/20 sur ce pilier et anomalie 🔴 CRITIQUE.*

### 2. 🕳️ Chasse aux Tests Creux & Mocking Abusif (Note /20)
* Les tests vérifient-ils le **comportement réel** ou seulement des mocks de mocks ?
* Le test échouerait-il si on modifiait la formule de calcul ou l'algorithme d'appariement ?
* Les assertions sont-elles strictes et précises (`expect(matches[0].team1_id).toBe('team-a')` plutôt que `expect(matches.length).toBeGreaterThan(0)`) ?

### 3. ⚠️ Couverture des Cas Limites e-Sport & Cas Dégradés (Note /20)
* **Arbres de tournois** :
  * Nombre impair d'équipes (gestion correcte des BYE au round 1).
  * Tournoi avec 1 seule équipe, 2 équipes, ou puissance de 2 non parfaite (ex: 7, 13, 31 équipes).
  * Double élimination : chute correcte du Winner Bracket vers le Loser Bracket.
  * Round-robin : pas de match retour non désiré, pas de double confrontation dans le même round.
* **Scores & Forfaits** :
  * Égalités de scores et règles de départage (tie-break).
  * Scores négatifs ou impossibles rejetés.
  * Forfait d'une équipe en plein tournoi (qualification automatique de l'adversaire).
* **Concurrence & Check-in** : Inscription simultanée au-delà du `max_teams`.
* **Alignement avec le Registre Vivant (`docs/EDGE_CASES.md`)** :
  * Chaque ligne marquée ✅ **Testé** doit pointer vers un test existant, qui échoue réellement si l'invariant est cassé. Un pointeur mort ou un test creux = 🔴.
  * Lister les lignes 🛡️ **Garde-fou** et ⚠️ **Non couvert** du périmètre audité comme **déficit de couverture**, classées par criticité (priorité : `BRK`, `SWS`, `SCR`, `SEC`).
  * Signaler tout cas limite testé mais absent du registre (à consigner) et toute entrée obsolète (à purger).

### 4. ⏱️ Déterminisme, Isolation & Gestion du Temps (Note /20)
* **Arrange-Act-Assert (AAA)** : Séparation claire de la mise en place, de l'exécution et des assertions.
* **Zéro fuite d'état** : Nettoyage systématique via `beforeEach(() => { vi.clearAllMocks(); })`.
* **Fake Timers** : Utilisation impérative de `vi.useFakeTimers()` et `vi.advanceTimersByTime()` pour tester les crons et délais de check-in, sans jamais bloquer le thread de test.
* **Déterminisme** : Aucun test ne doit dépendre du fuseau horaire, de la vitesse de la machine ou de l'ordre alphabétique des fichiers de test.

### 5. 📖 Lisibilité, Expressivité & Maintenance (Note /20)
* Les `describe` et `it` décrivent-ils clairement l'intention métier en anglais technique :
  `it('should advance winning team to next round and drop losing team to lower bracket round 1')` ?
* Pas de duplication massive de setup (usage judicieux de factories d'objets `createMockTournament()`).
* Pas de logique conditionnelle (`if / else`, boucles complexes) dans le test lui-même.

---

## 📊 Format de Restitution Obligatoire du Rapport

```markdown
# 🧪 Rapport d'Audit de Test & Fiabilité

**Date de l'audit** : YYYY-MM-DD  
**Périmètre audité** : [Suite complète / Service ciblé]  
**Verdict Global** : 🔴 REJETÉ (Tests creux ou domaine non couvert) | 🟠 APPROUVÉ SOUS RÉSERVE | 🟢 EXCELLENT

---

## 1. 📈 Scorecard d'Excellence des Tests

| Pilier d'Évaluation | Note /20 | Statut | Synthèse de l'Évaluateur |
|---|:---:|:---:|---|
| 🎯 Couverture Métier Critique | XX/20 | 🟢 / 🟠 / 🔴 | ... |
| 🕳️ Chasse aux Tests Creux | XX/20 | 🟢 / 🟠 / 🔴 | ... |
| ⚠️ Cas Limites & Erreurs e-Sport | XX/20 | 🟢 / 🟠 / 🔴 | ... |
| ⏱️ Déterminisme & Isolation | XX/20 | 🟢 / 🟠 / 🔴 | ... |
| 📖 Lisibilité & Pattern AAA | XX/20 | 🟢 / 🟠 / 🔴 | ... |
| **NOTE GLOBALE** | **XX/100** | — | **[Mention globale]** |

---

## 2. 📋 Répertoire des Anomalies de Test

| ID | Sévérité | Fichier & Lignes | Problème Détecté | Risque en Production |
|:---:|:---:|:---:|---|---|
| `AUD-TST-01` | 🔴 CRITIQUE | `BracketGeneratorService.ts` | Aucune suite de test pour la double élimination | Régressions silencieuses dans l'arbre des perdants |
| `AUD-TST-02` | 🟠 IMPORTANT | `BracketGeneratorService.test.ts:42` | Test creux : vérifie seulement que la fonction retourne un tableau sans vérifier les appariements | Faux sentiment de sécurité |
| `AUD-TST-03` | 🟡 MOYEN | `SchedulerService.test.ts:18` | Utilisation de setTimeout réel (1000ms) au lieu de vi.useFakeTimers | Tests lents et risque d'instabilité en CI |

---

## 3. 🎯 Matrice d'Effort vs Impact

* **Quick Wins** : Remplacer les assertions vagues par des égalités strictes, ajouter `vi.useFakeTimers()`.
* **Chantiers Prioritaires** : Écrire les suites manquantes pour les cas limites e-sport (BYE, forfaits, Swiss rounds).

---

## 4. 📋 Plan de Création des Tests Manquants

*(Lister directement les suites à écrire — cible, cas limites, commandes de validation. Pas de blocs « prompts à copier ».)*

- `BracketGeneratorService` : créer `apps/bot/src/__tests__/BracketGeneratorService.edge-cases.test.ts` couvrant BYE (7 équipes), forfait (FF) et égalité parfaite — pattern AAA, assertions strictes, validation via `make test`.
```
