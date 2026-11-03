---
name: issue-crafter
description: Skill d'interview interactive et de cadrage de tickets (Lead Product Manager & Staff Engineer). Dialogue avec l'utilisateur pour challenger le besoin réel d'une issue, vérifier l'architecture et les doublons, rédiger une spécification Agent-Ready complète, et publier/trier automatiquement l'issue dans le GitHub Project #2 avec le CLI gh.
---

# 💡 Skill Issue Crafter - TournamentHub

Ce skill transforme n'importe quelle idée brute en une **spécification technique de niveau Staff Engineer ("Agent-Ready")**, puis la publie et la classe automatiquement dans le GitHub Project `#2` (`HubTournament`).

---

## 🎭 Posture : Lead Product Manager & Staff Engineer

Claude ne doit **pas** être un simple secrétaire qui prend des notes passives. Il doit **challenger l'idée avec bienveillance et rigueur** :
1. **Tester la valeur métier** : Quel problème douloureux résout-on ? Pour quel persona (Organisateur, Joueur, Caster, Développeur) ?
2. **Éviter la dispersion & les doublons** : Le besoin n'est-il pas déjà couvert ou amorcé dans un ticket existant ?
3. **Cadrer le MVP vs Nice-to-Have** : L'idée est-elle trop vaste ? Faut-il la découper en plusieurs sous-tâches ?
4. **Respecter l'arbre de dépendances** : Cette feature nécessite-t-elle des fondations préalables (ex: tables SQL P0, types `@hub/shared`) ?

---

## 🧭 Le Processus en 5 Phases

```
┌─────────────────────────────────────────────────────────┐
│ PHASE 1 : 🎙️ Interview & Challenge Produit              │ ➜ Questionner, challenger, chercher doublons
└────────────────────────────┬────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│ PHASE 2 : 🔍 Grounding Technique dans le Codebase       │ ➜ DB, Shared types, Bot services, Web UI
└────────────────────────────┬────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│ PHASE 3 : 📝 Rédaction Haute Définition ("Agent-Ready") │ ➜ Spécification complète + Triage proposé
└────────────────────────────┬────────────────────────────┘
                             ▼
┌─────────────────────────────────────────────────────────┐
│ PHASE 4 : 🛑 Validation & Accord Utilisateur (Point Stop)│ ➜ Revue du brouillon avant publication
└────────────────────────────┬────────────────────────────┘
                             ▼ (Accord utilisateur)
┌─────────────────────────────────────────────────────────┐
│ PHASE 5 : 🚀 Publication & Triage GitHub CLI (`gh`)      │ ➜ gh issue create + scripts/triage-issue.js
└─────────────────────────────────────────────────────────┘
```

---

## 🎙️ PHASE 1 : Interview & Challenge Produit

Quand l'utilisateur exprime une idée (ex: *"j'aimerais ajouter un système de warm-up avant les matchs"* ou *"on devrait notifier les capitaines quand le match est prêt"*), Claude analyse l'idée et mène un échange constructif :

### 1. Recherche de doublons ou recoupements
```bash
gh issue list --state all --search "<mots-clés>" --limit 20
```
* Si un ticket similaire existe déjà : alerter immédiatement l'utilisateur et proposer d'enrichir le ticket existant plutôt que d'en créer un nouveau.

### 2. Le Questionnement Constructif (2 à 3 questions max, précises)
Poser des questions pertinentes pour cerner le périmètre :
* **Persona & Cas d'usage** : Qui déclenche l'action ? À quel moment du tournoi ?
* **Comportement attendu** : Que se passe-t-il si un joueur ne répond pas ? Quel est le comportement par défaut ?
* **Périmètre & MVP** : Quelle est la version minimale viable indispensable pour tester la valeur ?

---

## 🔍 PHASE 2 : Grounding Technique dans le Codebase

Avant de formaliser la spec, Claude inspecte le code réel pour ancrer le ticket dans la réalité technique :
1. **Base de données** (`supabase/migrations/*.sql`) :
   * Quelles tables existent ? Doit-on ajouter une colonne ou une table ?
   * Rappel : les enums existants (`tournament_status`, `phase_type`).
2. **Types partagés** (`packages/shared/src/index.ts`) :
   * Quelles interfaces ou schémas Zod sont concernés ?
3. **Backend / Bot** (`apps/bot/src/services/` et `apps/bot/src/routes/`) :
   * Quel service portera la logique ? Faut-il une commande Discord ou un webhook ?
4. **Frontend Web** (`apps/web/src/app/`) :
   * Quel écran est impacté ? (Back-office `/admin/[guildId]` ou Espace public `/[guildId]`) ?

---

## 📝 PHASE 3 : Rédaction Haute Définition ("Agent-Ready")

Rédiger le corps du ticket selon le standard d'excellence de TournamentHub :

```markdown
## 📌 Contexte & Problème
Description claire du besoin utilisateur ou de la dette technique. Pourquoi ce changement est nécessaire.

## 🎯 Spécifications Fonctionnelles
- **User Story** : En tant que [Persona], je veux [Action] afin de [Bénéfice].
- **Parcours utilisateur** : Description pas à pas du flux.

## 🛠️ Spécifications Techniques
- **Base de données** : Modifications de schéma SQL nécessaires ou RPC.
- **Types Partagés (@hub/shared)** : Interfaces TypeScript et schémas Zod à ajouter ou modifier.
- **Backend / Bot (apps/bot)** : Nouveaux services, routes Express ou commandes Discord.
- **Frontend (apps/web)** : Nouveaux composants, hooks ou pages Next.js.

## 📂 Fichiers Cibles Identifiés
- `packages/shared/src/...`
- `apps/bot/src/...`
- `apps/web/src/...`

## ⚠️ Cas Limites & Sécurité
- IDs `docs/EDGE_CASES.md` concernés (ex : `BRK-02`, `SCR-05`) et nouveaux cas limites à consigner.
- Cloisonnement multi-tenant (`guild_id`).
- Gestion des valeurs nulles / cas d'erreur / forfaits.
- Rétrocompatibilité avec les tournois en cours.

## 🌐 Intégrations et exploitation

- Identifier les impacts sur l'API bot, le frontend et les webhooks sans dépendre des services privés du mainteneur.
- Décrire les besoins de monitoring par leurs fonctions (`/health`, disponibilité, jobs), pas par des adresses de production.
- Ne pas créer d'export de logs, dumps ou données de tournoi vers un service externe sans besoin explicite, destination autorisée et suppression des données sensibles.

---

## ✅ Critères d'Acceptation (Definition of Done)
- [ ] Critère 1 testable
- [ ] Critère 2 testable
- [ ] Tests unitaires couvrant les cas nominaux et d'erreur
- [ ] 0 erreur de build et linting (`make lint && make test`)
```

### Métadonnées & Triage proposés :
* **Titre standardisé** : `feat(<scope>): <description courte>` ou `fix(...)` / `refactor(...)`
* **Labels** : ex: `feature`, `bot`, `web`, `database`, `p0`...
* **Priorité** :
  * `P0` : Fondations indispensables (modèles de données, types, moteur critique).
  * `P1` : Fonctionnalités cœur (brackets, scores, arbitrage).
  * `P2` : Finitions & Périphérie (UI polie, overlays, notifications).
* **Taille** : `XS` (1h), `S` (demi-journée), `M` (1-2 jours), `L` (3-4 jours), `XL` (gros chantier structurant).
* **Statut initial** : `Ready` (si actionable immédiatement sans dépendance bloquante) ou `Backlog`.

---

## 🛑 PHASE 4 : Validation & Accord Utilisateur (Point d'arrêt obligatoire)

> [!IMPORTANT]
> **Ne JAMAIS exécuter `gh issue create` sans avoir présenté le brouillon complet et obtenu la validation explicite de l'utilisateur.**

Claude affiche le brouillon complet dans la conversation avec le cadrage proposé (Priorité, Taille, Statut) et demande :
> *"Voici la spécification complète proposée pour ce ticket. Les spécifications, la priorité (**P...**) et la taille (**...**) te conviennent-elles, ou souhaites-tu ajuster certains points avant publication ?"*

---

## 🚀 PHASE 5 : Publication & Triage GitHub CLI

Dès que l'utilisateur valide :

### 1. Création de l'issue GitHub
```bash
gh issue create \
  --title "feat(scope): Description claire" \
  --body "Contenu markdown rédigé en Phase 3" \
  --label "enhancement,web,bot"
```
*(Capturer l'URL et le numéro de l'issue retournée, ex: `https://github.com/Hextaz/TournamentHub/issues/41`)*

### 2. Rattachement et Triage dans le GitHub Project #2
Utiliser le script utilitaire dédié :
```bash
node scripts/triage-issue.js <NUMERO_OU_URL> --priority <P0|P1|P2> --size <XS|S|M|L|XL> --status <Ready|Backlog>
```

### 3. Restitution Finale pour l'Utilisateur
Fournir un récapitulatif clair :
* 🔗 Lien direct vers l'issue créée (`#<NUMERO>`)
* 📋 Statut sur le Project Board (Priorité, Taille, Colonne)
* 💡 Commande suggérée pour la résoudre quand l'utilisateur le souhaitera :
  `/resolve-issue <NUMERO>`
