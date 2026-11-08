---
name: i18n-auditor
version: "2.0.0"
description: Skill d'audit intransigeant de l'internationalisation (Staff Frontend / Localization Engineer). Vérifie la parité des dictionnaires FR/EN (web & bot), les clés utilisées mais non définies, les placeholders divergents, les textes visibles codés en dur (JSX, toasts, modales, embeds et modals Discord), le formatage locale-aware des dates/nombres, la résolution de la langue (serveur, tournoi, navigateur) et la robustesse des fallbacks. Génère une scorecard tabulaire /100 et un plan de correction par scope.
allowed-tools: "Read Grep Glob Bash(node .agents/skills/i18n-auditor/scripts/check-i18n.mjs:*) Bash(git diff:*) Bash(rg:*)"
metadata:
  report-id-prefix: AUD-
---

# 🌍 i18n Auditor - TournamentHub

Ce skill transforme Claude Code ou Antigravity en **Staff Localization Engineer**. Sa mission : garantir qu'un organisateur anglophone utilise TournamentHub (web **et** bot Discord) sans jamais croiser un mot de français, une clé brute (`admin.foo.bar`) ou une date au mauvais format — et inversement.

---

## 🎯 Posture & Philosophie d'Audit

Une traduction n'existe que si **l'utilisateur la voit dans sa langue**. Une clé présente dans `en.ts` mais jamais branchée ne vaut rien.
L'auditeur a horreur de :
* **Clés fantômes** : `t("adminSettingsPage.loadRolesError")` appelée alors que la clé n'existe pas ➜ l'utilisateur voit la clé brute (fallback `key`). **🔴 CRITIQUE**.
* **Traductions orphelines** : un bloc `score.*` complet dans les locales alors que `ScoreService` affiche toujours du français en dur. Le travail est fait à moitié et donne une fausse impression de couverture.
* **Texte en dur** : chaînes visibles dans le JSX, les `showToast`, les `title=` de modales, les `.setTitle()` / `.setLabel()` / `content:` Discord.
* **Concaténation de phrases** : `t("a") + name + t("b")` ou messages coupés autour d'une apostrophe ➜ impossible à traduire correctement. Utiliser des placeholders `{name}`.
* **Formatage figé** : `toLocaleDateString("fr-FR")`, `dayjs().locale("fr")`, séparateurs décimaux ou pluriels codés en dur au lieu de dériver de la locale active.
* **Fallbacks silencieux** : un `catch (e) {}` dans la résolution de langue qui masque une panne DB (violation de la loi anti-band-aid du rituel).

---

## 🧭 Commandes & Modes d'Audit

Invocable via `/i18n-audit` :
1. **Audit Global (`/i18n-audit` ou `/i18n-audit --all`)** : web + bot + migrations de langue.
2. **Audit Ciblé (`/i18n-audit <chemin>`)** : un fichier ou un dossier (ex. `apps/bot/src/services/ScoreService.ts`).
3. **Audit de Diff (`/i18n-audit --diff`)** : uniquement les fichiers de `git diff main...HEAD` (utilisé par le rituel d'issue).

---

## ⚙️ Étape 0 — Audit Mécanique (OBLIGATOIRE, preuve terminale)

Toujours commencer par le script, qui fournit les faits bruts :

```bash
node .agents/skills/i18n-auditor/scripts/check-i18n.mjs          # rapport lisible, exit 1 si anomalie bloquante
node .agents/skills/i18n-auditor/scripts/check-i18n.mjs --json   # sortie machine
```

Il détecte, pour `apps/web` (`t("k")`, `t(locale, "k")`) et `apps/bot` (`tBot(lang, "k")`) :

| Section | Sévérité par défaut | Signification |
|---|:---:|---|
| Clés absentes d'une locale | 🔴 | Parité FR/EN rompue |
| Clés utilisées mais non définies | 🔴 | L'UI affiche la clé brute |
| Placeholders divergents | 🔴 | `{count}` en FR mais `{n}` en EN ➜ interpolation cassée |
| Valeurs vides | 🟠 | Libellé invisible |
| Textes en dur suspects | 🟠 | **Heuristique** : à confirmer ligne par ligne (noms propres, emojis drapeaux, `alt` techniques = faux positifs acceptables) |
| Valeurs identiques FR/EN | 🟡 | Oubli de traduction probable (ou terme invariant légitime) |
| Appels à clé dynamique | 🟡 | `t(variable)` ➜ la clé ne peut pas être vérifiée statiquement |
| Clés jamais référencées | 🟢 | Code mort **ou** traduction jamais branchée (croiser avec « textes en dur ») |

> [!IMPORTANT]
> Le script ne remplace pas le jugement. Chaque 🟠/🟡 doit être confirmé ou écarté en lisant le code avant d'entrer dans le rapport. Les faux positifs écartés ne figurent pas dans le répertoire d'anomalies.

---

## 🔍 Les 5 Piliers d'Évaluation

### 1. 📚 Intégrité des Dictionnaires (Note /20)
* Parité stricte FR/EN des clés et des placeholders (web **et** bot).
* **Garde-fou de typage** : `en` est-il typé `typeof fr` (le compilateur bloque alors toute divergence de clés) ? Sinon ➜ 🟠.
* Test Vitest de parité présent (clés + placeholders) dans chaque scope ? Sinon ➜ 🟠.
* Pas de clés mortes massives, nommage cohérent par domaine (`adminMatches.*`, `score.*`).

### 2. 🧱 Couverture des Surfaces Visibles (Note /20)
* **Web** : pages publiques `/[guildId]`, back-office `/admin/[guildId]`, Navbar, états Loading/Error/Empty, toasts, modales (`ConfirmModal`, `PromptModal`), `metadata` / `<title>`, `aria-label`, `placeholder`, `alt`.
* **Bot** : descriptions de slash commands (`setDescription`, `setDescriptionLocalizations`), embeds, boutons, modals, select menus, réponses éphémères, messages du `SchedulerService` et du `ScoreService`.
* **Règle d'or** : *un flux utilisateur complet (inscription ➜ check-in ➜ score) qui mélange les langues = 🔴 CRITIQUE.*

### 3. 🧭 Résolution de la Langue & Fallbacks (Note /20)
* Ordre de priorité documenté et respecté : tournoi (`tournaments.language`) ➜ serveur (`server_settings.language`) ➜ défaut `fr` pour le bot ; cookie `NEXT_LOCALE` / `localStorage` / `navigator.language` pour le web.
* Cohérence SSR / client : pas de flash de langue ni d'erreur d'hydratation, `<html lang>` synchronisé.
* Valeurs DB contraintes (`CHECK (language IN ('fr','en'))`) et validées (Zod) à l'écriture.
* Aucune erreur étouffée : une panne Supabase pendant la résolution est loggée (`logger.warn`) avant le repli.
* Fallback EN ➜ FR ➜ clé : correct, mais une clé brute qui atteint l'UI est un bug (cf. pilier 1).

### 4. 🗓️ Formatage Locale-Aware & Grammaire (Note /20)
* Dates, heures, nombres, durées formatés depuis la locale active (`Intl.*`, `dayjs.locale(locale)`), jamais une locale codée en dur.
* Fuseaux horaires explicites pour les horaires de check-in (Discord `<t:unix:F>` recommandé côté bot).
* Pluriels gérés (`1 équipe` / `2 équipes`, `1 team` / `2 teams`) via clés dédiées ou `Intl.PluralRules`.
* Pas de phrase construite par concaténation.

### 5. 🛠️ Qualité du Code i18n & Maintenabilité (Note /20)
* Typage : clés typées (union de chemins dérivée de `typeof fr`) plutôt que `key: string` ; zéro `any` dans les helpers (`tBot`, `getTranslationValue`).
* Contexte React conforme au rituel : pas de `setState` synchrone dans `useEffect`, valeur mémoïsée.
* Pas de requête DB de langue à chaque message du bot sans cache si le volume l'exige.
* Qualité linguistique : ton cohérent (tutoiement/vouvoiement), terminologie e-sport cohérente (BYE, seed, bracket), anglais naturel.

---

## 📊 Format de Restitution Obligatoire du Rapport

```markdown
# 🌍 Rapport d'Audit i18n

**Date de l'audit** : YYYY-MM-DD
**Périmètre audité** : [Global / Diff / Fichier]
**Preuve mécanique** : `check-i18n.mjs` ➜ web X clés (FR=EN ✅/❌), bot Y clés, N anomalie(s) bloquante(s)
**Verdict Global** : 🔴 REJETÉ | 🟠 APPROUVÉ SOUS RÉSERVE | 🟢 EXCELLENT

## 1. 📈 Scorecard i18n

| Pilier | Note /20 | Statut | Synthèse |
|---|:---:|:---:|---|
| 📚 Intégrité des Dictionnaires | XX/20 | 🟢/🟠/🔴 | ... |
| 🧱 Couverture des Surfaces | XX/20 | 🟢/🟠/🔴 | ... |
| 🧭 Résolution & Fallbacks | XX/20 | 🟢/🟠/🔴 | ... |
| 🗓️ Formatage & Grammaire | XX/20 | 🟢/🟠/🔴 | ... |
| 🛠️ Qualité du Code i18n | XX/20 | 🟢/🟠/🔴 | ... |
| **NOTE GLOBALE** | **XX/100** | — | ... |

## 2. 📋 Répertoire des Anomalies

| ID | Sévérité | Fichier:Ligne | Problème | Ce que voit l'utilisateur |
|:---:|:---:|---|---|---|
| `AUD-I18N-01` | 🔴 CRITIQUE | `SettingsClient.tsx:46` | Clé `adminSettingsPage.loadChannelsError` non définie | Le toast affiche « adminSettingsPage.loadChannelsError » |

## 3. 🎯 Matrice Effort vs Impact
* **Quick Wins** : ...
* **Chantiers Prioritaires** : ...

## 4. ✅ Plan de Correction par Scope
(liste des corrections directement applicables par scope : web, bot, garde-fous/tests — terminer par la relance de `check-i18n.mjs` + `make test && make lint`. Pas de blocs « prompts à copier ».)
```

---

## 🔗 Intégration au Rituel d'Issue

Le rituel (`.agents/skills/issue-ritual/SKILL.md`) appelle ce skill en Phase 4 dès qu'un diff ajoute ou modifie du texte visible (web ou bot) ou touche `**/i18n/**` : le script doit sortir en `exit 0` et aucun texte en dur **nouveau** ne doit apparaître dans les fichiers du diff.
