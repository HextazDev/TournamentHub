# RFC 0001 — Le site comme produit principal et le système d'intégrations optionnelles (#57)

- **Statut** : Approuvé (Décisions propriétaire intégrées)
- **Issue parente** : `#57` — *refactor(architecture): RFC — Discord en intégration optionnelle (système de plugins)*
- **Issues liées** : `#15`, `#17`, `#21`, `#22`, `#23`, `#24`, `#37`, `#46`, `#47`, `#50`, `#58`, `#59` (ainsi que `#28`, `#39`, `#45` mentionnées par dépendance)
- **Date** : 4 novembre 2026

---

## 1. Résumé et recommandation finale

TournamentHub repose aujourd'hui sur un couplage fort avec Discord : le serveur Discord (`guild_id`) est l'unique clé de cloisonnement multi-tenant, le bot Discord est indispensable pour ouvrir les inscriptions, gérer le check-in ou lancer un tournoi, et les permissions reposent exclusivement sur les rôles et droits Discord. Ce RFC transforme **le site web en produit autonome** et repositionne **Discord comme la première intégration optionnelle** au sein d'un cadre de plugins unifié (aux côtés de Twitch et d'un fournisseur d'IA en mode *Bring Your Own Key*), tandis que l'API publique (`#59`) est exposée nativement et en permanence pour tous les tournois publics.

**Recommandation finale :**
1. **Tenant & Migration (`Q1` & `Q5`)** : Remplacer directement `server_settings` et `guild_id` par l'entité `organizations` (`id` UUID, `slug` unique) via une **bascule directe (*Option 5A — Clean Cutover*)**, le projet n'étant pas encore en production. Le rattachement d'un serveur Discord (`guild_id`) devient une propriété optionnelle portée par l'intégration Discord de l'organisation.
2. **Contrôle d'accès (`Q2`)** : Généraliser la décision pure en `canPerform(access, action, tournamentId)` dans `@hub/shared` en combinant des **rôles natifs du site** (`organization_members` / `tournament_staff`) et des **sources d'accès externes** (rôles Discord serveur et tournoi) évaluées tant que l'intégration est active, avec révocation immédiate à la désactivation sans jamais bloquer le propriétaire natif.
3. **Parcours métier (`Q3` & `Q4`)** : Porter l'inscription, le check-in et la déclaration de scores nativement sur le Web ; déléguer les effets externes (Discord, Twitch, IA) à un bus d'intégrations asynchrone tolérant aux pannes (*fail-safe*), piloté par les réglages de `#21` (`automation_settings`).

---

## 2. Contexte : dépendance actuelle envers Discord

L'inspection du dépôt montre que Discord est aujourd'hui cablé au cœur de chaque couche de l'architecture :

### 2.1 Schéma de données et RLS (`supabase/migrations/`)
- **Clé de tenant unique (`guild_id`)** :
  - `server_settings` (`supabase/migrations/20260101000000_initial_schema.sql`, `20261017000000_harden_access_and_guild_profile.sql`) utilise `guild_id VARCHAR(50) PRIMARY KEY` et stocke à la fois le profil de l'organisateur (`guild_name`, `guild_icon`, `language`, `invite_url`) et la configuration technique du bot (`bot_present`, `to_role_id`, `captain_role_id`, `checkin_channel_id`, `announcement_channel_id`, `registration_channel_id`).
  - `tournaments` exige `guild_id VARCHAR(50) NOT NULL` et embarque 7 colonnes propres à Discord (`checkin_message_id`, `discord_category_id`, `discord_announcement_channel_id`, `discord_registration_channel_id`, `discord_checkin_channel_id`, `discord_captain_role_id`, `discord_to_role_id`).
  - `phases` et `groups` portent `discord_channel_id VARCHAR(50)` ; `matches` porte `discord_channel_id VARCHAR(50)` ; `teams` identifie le capitaine par `captain_discord_id VARCHAR(50) NOT NULL`.
  - `guild_admins` a pour clé primaire `(guild_id, discord_id)` avec une contrainte `CHECK (reason IN ('ADMINISTRATOR', 'MANAGE_GUILD', 'TO_ROLE', 'SERVER_OWNER'))`.
- **Politiques RLS et exposition** :
  - Dans `20261017000000_harden_access_and_guild_profile.sql`, `server_settings` est lisible publiquement (`USING (true)`), les tournois et tables enfants sont filtrés par `is_public_tournament(tid)` (`SECURITY DEFINER SET search_path = public`), et toutes les écritures sont réservées au rôle `service_role` (`SEC-07`, vérifié par `supabase/tests/rls_access.sql`).

### 2.2 Cloisonnement et autorisations (`apps/bot`, `apps/web`, `packages/shared`)
- **Garde-fous d'isolation (`apps/bot/src/utils/tenant.ts`)** :
  - `getAuthenticatedGuildId(req)` lit `req.adminCheck?.guildId`.
  - `verifyTournamentGuild`, `verifyPhaseGuild`, `verifyTeamGuild` et `verifyMatchGuild` remontent systématiquement jusqu'à `tournaments.guild_id` (`SEC-01`).
- **Vérification des droits (`apps/bot/src/middleware/auth.ts`, `apps/bot/src/utils/adminAccess.ts`, `apps/web/src/lib/viewer.ts`)** :
  - `requireGuildAdmin` exige un `X-Discord-User-Id` et un `guildId`, interroge le cache Discord (`discordClient.guilds.fetch(guildId)` puis `guild.members.fetch(discordId)`), lit `server_settings.to_role_id` et applique `resolveAdminReason` (`SERVER_OWNER` > `ADMINISTRATOR` > `MANAGE_GUILD` > `TO_ROLE`), avec un cache mémoire `permCache` de 30 s (`SEC-04`, `SEC-05`).
  - Si le bot n'est pas sur le serveur Discord (`Guild not found`), `requireGuildAdmin` renvoie `404` et bloque toute mutation.
  - Côté web, `getViewer()` (`apps/web/src/lib/viewer.ts`) appelle `https://discord.com/api/users/@me/guilds` avec le token OAuth NextAuth (`apps/web/src/app/api/auth/[...nextauth]/route.ts`). `getGuildAdminAccess(guildId)` consulte `guild_admins` puis replie sur `GET /api/discord/permissions` côté bot (`SEC-11`).
  - *Note sur l'état du dépôt* : le modèle `GuildAccess` distinguant le niveau `SERVER` et le niveau `TOURNAMENT` (via `tournaments.discord_to_role_id` pour un tournoi non archivé), posé dans les décisions de cadrage comme socle à généraliser, n'est encore que partiellement matérialisé dans `packages/shared/src/index.ts` (qui expose `GuildAdminReasonSchema` au niveau serveur, tandis que `discord_to_role_id` sur `tournaments` ne sert aujourd'hui qu'aux permissions de salons dans `LifecycleService`). Le présent RFC intègre et généralise directement ce modèle à deux portées (`ORGANIZATION` / `TOURNAMENT`).

### 2.3 Routes Web et Proxy API (`apps/web`)
- **Routage par `guildId`** : toutes les pages publiques (`apps/web/src/app/[guildId]/...`) et d'administration (`apps/web/src/app/admin/[guildId]/...`) prennent l'identifiant Snowflake Discord dans l'URL. `canViewTournament` (`apps/web/src/lib/accessRules.ts`) vérifie `tournament.guild_id === routeGuildId` et l'appartenance au serveur Discord pour les tournois privés (`SEC-10`).
- **Parcours d'onboarding (`apps/web/src/lib/accessRules.ts`, `apps/web/src/lib/servers.ts`)** : `splitServers` et `serverSetupChecklist` imposent que le bot soit présent (`bot_present = true`) et que 5 champs Discord (`to_role_id`, `captain_role_id`, `registration_channel_id`, `announcement_channel_id`, `checkin_channel_id`) soient remplis avant que `tournamentNextStep` n'autorise la suite du parcours.
- **Proxy (`apps/web/src/app/api/bot/[...path]/route.ts`, `apps/web/src/lib/botProxyAllowlist.ts`)** : injecte `X-Discord-User-Id` et `X-Guild-Id` vers le bot (`SEC-06`, `SEC-13`).

### 2.4 Services métier couplés au cycle de vie Discord (`apps/bot/src/services/`)
- **Ouverture des inscriptions (`TournamentRouter.ts` + `RegistrationService.sendRegistrationEmbed`)** : `POST /api/tournaments/:id/registrations` échoue en `502` si l'embed Discord ne peut pas être envoyé dans `discord_registration_channel_id` (`REG-08`). L'inscription par les joueurs se fait uniquement via les boutons/modales Discord (`btn_register_*`, `modal_register_main_*`).
- **Check-in (`SchedulerService.ts`, `apps/bot/src/index.ts`)** : l'ouverture du check-in poste un bouton `btn_checkin` dans `discord_checkin_channel_id` et sauvegarde `checkin_message_id` (`CHK-01`).
- **Lancement et clôture (`LifecycleService.ts`, `ArchiveService.ts`)** : `launchTournament` échoue si le serveur Discord est introuvable, crée une catégorie `🏆 {name}`, un salon `#informations` et un salon par phase/groupe (`syncPhaseChannels`) **avant** de passer le tournoi à `ACTIVE` (`DISC-02`). `ArchiveService.backgroundDiscordCleanup` retire les rôles Discord Capitaine et verrouille le salon de check-in (`DISC-05`).
- **Rôles et pseudos (`PresenceRolesService.ts`, `WebhookRolesService.ts`)** : synchronisent le pseudo Discord et le rôle `discord_captain_role_id` lors du check-in (`OPS-05`).
- **Scores et progression (`ScoreService.ts`, `MatchRouter.ts`)** : la déclaration de score par les capitaines passe par le menu/modal/bouton Discord (`select_match_to_score`, `modal_score_*`, `btn_score_*`), et `progressTeams` attend un `TextChannel` Discord pour annoncer les rondes suisses, les égalités (`SCR-06`) ou les matchs prêts (`notifyMatchReady`).

---

## 3. Objectifs et non-objectifs

### Objectifs
1. **Autonomie complète du Web** : permettre de créer une organisation (plafonnée à 5 par propriétaire), de configurer ses rôles d'équipe staff, et de gérer tout le cycle de vie d'un tournoi (création, inscriptions, check-in, arbre/poules/suisse, saisie et validation des scores, clôture, archivage) depuis le navigateur **sans installer le bot Discord**.
2. **Système d'intégrations modulaire par organisation** : permettre à chaque organisation d'activer, configurer et désactiver des intégrations tierces (Discord, Twitch `#58`/`#22`/`#17`/`#47`, IA en mode BYOK `#46`) de manière isolée.
3. **Modèle d'autorisation unifié (`canPerform`)** : partager entre `@hub/bot` et `@hub/web` une fonction pure `canPerform(access, action, tournamentId)` à deux portées (`ORGANIZATION` et `TOURNAMENT`), alimentée par les rôles natifs du site et, lorsque l'intégration Discord est active, par les rôles Discord configurés.
4. **Résilience et non-blocage (*Fail-Safe Integrations*, *Fail-Closed Security*)** : garantir qu'une panne ou désactivation d'intégration (Discord, Twitch, IA) ne bloque jamais l'avancement d'un tournoi, tout en maintenant une sécurité fermée par défaut sur chaque vérification d'accès.
5. **Bascule propre du schéma (Pré-production)** : refondre directement le schéma autour de `organizations` sans dette de colonnes ou d'alias hérités.

### Non-objectifs
1. **Remplacement de l'authentification Discord (NextAuth)** : la connexion au site reste assurée par le provider Discord (`SEC-09`) pour identifier l'utilisateur (`discordId`). Ajouter Google/Email/Twitch comme méthodes de connexion primaires est hors périmètre de ce RFC.
2. **Réécriture sur le web des fonctionnalités intrinsèquement propres à Discord** : le site ne recréera pas de salons vocaux ni de chat temps réel par match (voir `Q3`).
3. **Faire de l'API publique (`#59`) un plugin optionnel** : l'API publique REST en lecture seule n'est **pas** une intégration à activer ; elle est toujours disponible pour tous les tournois publics (`is_public = true`).

---

## 4. Questions d'architecture et décisions

### Q1. Modèle de tenant

#### Comparatif des options

| Critère | Option 1A : Table `organizations` dédiée (`id` UUID, `slug`) + rattachement Discord optionnel | Option 1B : Conserver `guild_id` partout avec pseudo-ID (`org_<uuid>`) pour les tenants sans Discord | Option 1C : Double clé permanente (`organization_id` nullable + `guild_id` nullable sur chaque table) |
| :--- | :--- | :--- | :--- |
| **Principe** | Nouvelle table `organizations` (`id UUID PK`, `slug TEXT UNIQUE`). `tournaments` référence `organization_id UUID NOT NULL`. Le `guild_id` Discord est porté par la configuration de l'intégration Discord (`UNIQUE` quand actif). | `server_settings.guild_id` accepte soit un Snowflake Discord (`^\d{17,20}$`), soit un identifiant synthétique `org_...`. Les tables et routes gardent le nom `guild_id`. | `tournaments` possède à la fois `organization_id` et `guild_id` avec un `CHECK (num_nonnulls(organization_id, guild_id) >= 1)`. |
| **Avantages** | Modèle du domaine propre et explicite ; permet de lier/délier ou changer de serveur Discord sans réécrire les clés étrangères des tournois ; URLs lisibles (`/[orgSlug]` et `/admin/[orgSlug]`). | Diff SQL minimal à court terme ; aucun renommage de colonne dans `tournaments`. | Pas de migration immédiate des colonnes existantes. |
| **Inconvénients** | Remplacement de `guild_id` par `organization_id` dans `tournaments`, `tenant.ts` et les routes Next.js. | Dette sémantique majeure (`guild_id` qui n'est plus une guilde) ; casse les validations regex Snowflake (`OptionalDiscordId` dans `packages/shared/src/index.ts`) ; impossible de rattacher un serveur Discord a posteriori sans migrer la PK en cascade. | Complexité permanente dans `verify*`, la RLS et le code métier (chaque requête doit tester deux colonnes) ; risque élevé d'oubli de filtre multi-tenant (`SEC-01`). |
| **Coût** | **M** | **S** à l'écriture, **L** en maintenance corrective. | **L** (double logique partout). |
| **Risques** | Faible (d'autant plus que la bascule se fait avec reset en pré-production, voir Q5). | Contournement des validations d'ID ou collision si un utilisateur rattache plus tard un vrai serveur Discord. | Fuite inter-tenant si une route vérifie `organization_id` alors que la ressource est rattachée par `guild_id`. |

#### Décision recommandée : **Option 1A — Table `organizations` dédiée (`id` UUID, `slug`) avec serveur Discord rattaché en option**

**Justification :**
- C'est la seule option qui permet nativement le parcours cible de `#57` : *« créer et gérer un tournoi depuis le site sans installer de bot Discord, puis activer les intégrations dont j'ai besoin »*. Si une organisation créée sur le web décide plus tard d'activer Discord, l'Option 1A se contente d'insérer/activer une ligne dans `organization_integrations` sans toucher à `tournaments.organization_id`.
- Un quota par défaut de **5 organisations possédées en tant que `ORG_OWNER` par utilisateur** est appliqué à la création pour prévenir le spam et le squatting de `slug`.

```sql
-- Extrait illustratif du modèle cible (Q1)
CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug VARCHAR(64) NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'),
  name VARCHAR(100) NOT NULL,
  icon_url TEXT,
  language VARCHAR(5) NOT NULL DEFAULT 'fr' CHECK (language IN ('fr', 'en')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

### Q2. Accès sans Discord et intégrations comme sources d'accès

#### 2.1 Rôles natifs du site et généralisation de `canPerform`
Le modèle d'accès devient `OrganizationAccess` dans `@hub/shared`, évalué par une fonction pure unique `canPerform(access, action, tournamentId)` partagée entre `apps/bot` et `apps/web` :

- **Portée `ORGANIZATION`** (`organization_members`) :
  - `ORG_OWNER` : Propriétaire de l'organisation (1 minimum par organisation, irrévocable par les intégrations, seul habilité à supprimer l'organisation, transférer la propriété ou gérer les propriétaires).
  - `ORG_ADMIN` : Organisateur / TO d'organisation (création de tournois, gestion des paramètres et des intégrations, administration de tous les tournois de l'organisation).
  - `CASTER` (`#23`) : Accès lecture aux données de production live (rosters, codes de salon, veto `#28`, génération/copie du lien d'overlay `#17`) sur tous les tournois de l'organisation.
  - `STATISTICIAN` (`#24`) : Accès écriture aux scores détaillés (`/stats`, `force-score`, MVP) sur tous les tournois de l'organisation, sans droit de modification de structure ni de suppression.
- **Portée `TOURNAMENT`** (`tournament_staff`, limité à un `tournament_id` non `ARCHIVED`) :
  - `TOURNAMENT_TO` : Gestion complète d'un tournoi spécifique (phases, équipes, lancement, scores), sans accès aux paramètres de l'organisation ni aux autres tournois.
  - `TOURNAMENT_CASTER` (`#23`) / `TOURNAMENT_STATISTICIAN` (`#24`) : Même périmètre que leurs homologues d'organisation, mais restreints à `tournamentId`.

```ts
// Extrait illustratif dans @hub/shared (Q2)
export type OrgRole = "ORG_OWNER" | "ORG_ADMIN" | "CASTER" | "STATISTICIAN";
export type TournamentRole = "TOURNAMENT_TO" | "TOURNAMENT_CASTER" | "TOURNAMENT_STATISTICIAN";
export type AccessSource = "NATIVE" | "DISCORD";

export interface EffectiveGrant {
  scope: "ORGANIZATION" | "TOURNAMENT";
  role: OrgRole | TournamentRole;
  tournamentId?: string; // requis si scope === "TOURNAMENT"
  source: AccessSource;
}

export interface OrganizationAccess {
  userId: string; // Discord User ID (identifiant d'authentification NextAuth)
  organizationId: string;
  grants: readonly EffectiveGrant[];
}

export type ProtectedAction =
  | "org:delete"
  | "org:transfer_ownership"
  | "org:manage_members"
  | "org:manage_integrations"
  | "org:update_settings"
  | "tournament:create"
  | "tournament:manage"
  | "tournament:delete"
  | "tournament:cast"
  | "tournament:report_stats";

export function canPerform(
  access: OrganizationAccess | null,
  action: ProtectedAction,
  tournamentId?: string,
): boolean;
```

#### 2.2 Comment l'intégration Discord devient une source d'accès : comparatif des options

| Critère | Option 2A : Interrogation Discord 100 % en direct à chaque requête | Option 2B : Copie permanente dans `organization_members` lors des événements Discord | Option 2C : Table native `organization_members` + grants d'intégration étiquetés (`source = 'DISCORD'`) synchronisés et vérifiés avec cache 30 s |
| :--- | :--- | :--- | :--- |
| **Principe** | `organization_members` ne contient que les membres natifs. Si Discord est actif, chaque contrôle interroge le bot en direct (cache 30 s). | Les événements Discord (`guildMemberUpdate`, `roleUpdate`) copient les utilisateurs dans `organization_members`. | Séparation stricte des sources : `organization_members` stocke les rôles `NATIVE` (persistants) ; `integration_access_grants` (qui remplace `guild_admins` en supportant les portées `ORGANIZATION` et `TOURNAMENT`) reflète les droits `DISCORD` avec repli live vers le bot (cache 30 s `SEC-05`). |
| **Avantages** | Révocation instantanée (hors TTL 30 s) à la désactivation de l'intégration ; aucune donnée Discord résiduelle en base. | Lecture SQL simple en une seule table ; le hub `/organizations` affiche tout le monde sans appeler le bot. | Combine l'annuaire rapide pour le hub, l'isolation stricte des sources (`NATIVE` vs `DISCORD`), la révocation atomique en 1 requête/filtre (`WHERE integration_enabled = true`) et le repli live du bot si un rôle vient d'être attribué. |
| **Inconvénients** | Si le bot redémarre, la page « Mes Organisations » ne peut pas lister les organisations où l'utilisateur est seulement TO Discord sans interroger toutes les guildes. | **Critique** : risque de confusion entre un rôle accordé manuellement sur le site et un rôle copié depuis Discord lors de la désactivation de l'intégration. | Deux sources à joindre dans le résolveur d'accès (encapsulé dans un seul service). |
| **Coût** | **S** | **M** | **M** |
| **Risques** | Latence sur le hub ou échec de découverte si le Gateway Discord est lent. | Maintien accidentel de droits après désactivation de Discord ou départ du serveur (`SEC-04`, `DISC-08`). | Désynchronisation temporaire (bornée à 30 s par `permCache` et purgée sur événement `DISC-08`). |

#### Décision recommandée : **Option 2C — Séparation stricte entre rôles `NATIVE` et grants `DISCORD` (filtrés par l'état actif de l'intégration + cache 30 s)**

**Justification et règles tranchées pour Q2 :**
1. **Règles de correspondance Discord ➔ Rôles effectifs (uniquement si l'intégration Discord de l'organisation est `ENABLED`)** :
   - Sur le serveur Discord rattaché : Propriétaire Discord (`guild.ownerId`), permission `Administrator`, permission `ManageGuild` ou possession du rôle `to_role_id` ➔ accorde `ORG_ADMIN` (`source: "DISCORD"`, portée `ORGANIZATION`).
   - Possession de `caster_role_id` (`#23`) / `statistician_role_id` (`#24`) au niveau serveur ➔ accorde `CASTER` / `STATISTICIAN` (`source: "DISCORD"`, portée `ORGANIZATION`).
   - Possession de `tournaments.discord_to_role_id` sur un tournoi dont `status != 'ARCHIVED'` ➔ accorde `TOURNAMENT_TO` (`source: "DISCORD"`, portée `TOURNAMENT`, borné à ce `tournament.id`). Dès que le tournoi passe à `ARCHIVED`, ce grant cesse d'être émis et d'être accepté.
2. **Priorité entre sources (Union additive des privilèges, suprématie du propriétaire natif)** :
   - Les droits sont **additifs** : `effectiveGrants = nativeGrants ∪ (isDiscordIntegrationEnabled ? discordGrants : ∅)`.
   - Un utilisateur qui est `CASTER` en `NATIVE` et `TOURNAMENT_TO` via `DISCORD` sur le tournoi X cumule les deux.
   - **Protection absolue de `ORG_OWNER`** : le rôle `ORG_OWNER` est exclusivement `NATIVE`. Une intégration ne peut ni créer, ni rétrograder, ni révoquer un `ORG_OWNER`.
3. **Désactivation de l'intégration Discord** :
   - Basculer l'intégration Discord à `DISABLED` (ou délier le serveur) invalide immédiatement les entrées `permCache` de l'organisation (`clearOrganizationPermissionCache(orgId)`) et purge/ignore tous les grants `source = 'DISCORD'`.
   - **Option de nettoyage Discord à la désactivation** : la modale de désactivation propose une case à cocher optionnelle *« Supprimer également la catégorie et les salons Discord du tournoi en cours »*. Si cochée, `LifecycleService` nettoie les salons créés avant de couper l'intégration ; sinon, les salons Discord sont conservés en l'état.
   - **Garde-fou anti-lockout** : toute organisation possède au moins un `ORG_OWNER` natif (contrainte vérifiée avant toute suppression de membre). La désactivation de Discord révoque instantanément les TO qui ne tenaient leur accès que d'un rôle Discord, sans jamais bloquer le `ORG_OWNER` ni les `ORG_ADMIN` natifs.
4. **Invitations et transfert de propriété (sans Discord)** :
   - **Invitations** : un `ORG_OWNER` ou `ORG_ADMIN` peut générer un lien d'invitation à usage unique / durée limitée (`organization_invites` : `token_hash`, `organization_id`, `role`, `tournament_id` optionnel, `expires_at`, `created_by`). L'invité clique sur le lien, s'identifie via NextAuth (Discord OAuth `identify`) et reçoit le rôle `NATIVE` correspondant, même s'il n'appartient à aucun serveur Discord commun.
   - **Transfert de propriété** : un `ORG_OWNER` peut promouvoir un `ORG_ADMIN` natif en `ORG_OWNER` (et optionnellement se rétrograder en `ORG_ADMIN`) via une transaction atomique garantissant qu'il reste toujours `>= 1` `ORG_OWNER` natif (et que le nouveau propriétaire ne dépasse pas le plafond de 5 organisations possédées).
5. **Compte qui perd son lien Discord / révocation OAuth** :
   - La connexion au site utilisant Discord OAuth (`identify`), un compte Discord supprimé ou banni par Discord ne peut plus ouvrir de session NextAuth (`SEC-06`).
   - Si l'utilisateur quitte le serveur Discord de l'organisation mais conserve son compte Discord : l'événement `guildMemberRemove` (`DISC-08`) purge ses grants `source = 'DISCORD'` et invalide `permCache` ; en revanche, ses éventuels rôles `source = 'NATIVE'` restent intacts (sauf révocation explicite par un `ORG_OWNER`/`ORG_ADMIN`).
6. **Cache et invalidation (`SEC-05`)** :
   - Le TTL maximal de `permCache` reste fixé à **30 secondes** (`PERM_CACHE_TTL_MS = 30_000`).
   - Une invalidation active immédiate (`permCache.delete`) est déclenchée sur : modification des membres natifs, modification de la configuration ou de l'état `enabled` de l'intégration Discord, changement de `to_role_id` / `discord_to_role_id`, passage d'un tournoi à `ARCHIVED`, et réception de `guildMemberRemove` / `guildMemberUpdate` / `roleUpdate`.

---

### Q3. Fonctionnalités propres à Discord : comportement sans Discord et équivalent Web

#### Comparatif des options d'architecture fonctionnelle

| Critère | Option 3A : Mode dégradé (désactiver inscriptions/check-in en libre-service quand Discord est coupé ; gestion 100 % TO) | Option 3B : Parité fonctionnelle Web native (formulaires Web pour inscriptions, check-in et scores + Realtime Supabase) | Option 3C : Remplacement complet incluant un chat Web temps réel par match |
| :--- | :--- | :--- | :--- |
| **Principe** | Sans Discord, seul le TO inscrit les équipes et saisit les scores depuis le back-office (`/admin/...`). | Le site devient le canal primaire pour s'inscrire, faire son check-in et déclarer/valider un score. Si Discord est actif, les deux canaux (Web et Discord) alimentent les mêmes services métier. | Option 3B + développement d'une messagerie instantanée Web par match et par groupe pour remplacer les salons Discord. |
| **Avantages** | Très peu de nouveau code front. | Répond pleinement à la vision « Le site comme produit principal » ; permet aux joueurs d'être autonomes sur mobile/PC sans bot ; s'aligne avec `#15`, `#21` et `#37`. | Aucune dépendance externe pour la communication entre joueurs. |
| **Inconvénients** | Ne permet pas d'organiser un tournoi communautaire autonome sans Discord (charge manuelle totale sur le TO). | Nécessite les vues publiques d'action joueur (inscription, check-in, déclaration de score) et les routes de mutation capitaine. | Hors cœur de métier : modération de contenu, stockage de messages, abus/spam, charge Realtime disproportionnée. |
| **Coût** | **S** | **M** | **XL** |
| **Risques** | Adoption nulle du mode sans Discord pour les tournois de plus de 8 équipes. | Conflit d'écriture si un capitaine clique simultanément sur Web et sur Discord (mitigé par les contraintes DB `REG-03` et l'idempotence `#45`). | Dérive fonctionnelle, risques juridiques/modération et saturation des connexions Realtime. |

#### Décision recommandée : **Option 3B — Parité fonctionnelle Web native pour tout le flux tournoi, sans chat Web**

#### Matrice détaillée par fonctionnalité actuelle

| Fonctionnalité actuelle (avec références code) | Comportement quand Discord est **désactivé** | Équivalent **Web natif** (toujours disponible) | Ce qui reste **exclusif à l'intégration Discord** |
| :--- | :--- | :--- | :--- |
| **Ouverture des inscriptions** (`TournamentRouter.ts` `POST /:id/registrations`, `RegistrationService.sendRegistrationEmbed`, `REG-08`) | Passe immédiatement `is_registration_open = true` en base sans exiger `discord_registration_channel_id` ni appeler Discord (`200 OK`). | Bouton « Ouvrir les inscriptions » dans le back-office ; active le formulaire d'inscription sur la page publique du tournoi. | Publication de l'embed d'inscription avec boutons `btn_register_*` et `btn_toggle_lang_*` dans `#inscriptions`. |
| **Inscription d'une équipe par un capitaine** (`RegistrationService.handleMainModalSubmit`, `finalizeRegistration`, `REG-01` à `REG-06`) | Aucune interaction Discord attendue. | Formulaire Web sur la page du tournoi (nom d'équipe, joueurs + codes ami validés par le même parseur dans `@hub/shared`, remplaçants) + ajout/import manuel par le TO (`#15`). | Saisie en 2 modales Discord (`modal_register_main_*`, `modal_register_subs_*`) et embed de confirmation dans le salon d'inscription. |
| **Check-in** (`SchedulerService.ts`, `CHK-01` à `CHK-04`, `#15`, `#21`) | `SchedulerService` ouvre et ferme la fenêtre temporelle en base (et purge les absents si `checkin_mode = REQUIRED_AUTO` `#21`), sans chercher de salon Discord ni bloquer sur `checkin_message_id`. | Bandeau et bouton « Valider mon check-in » sur la page du tournoi et dans la Navbar (`#37`) pour le capitaine connecté (`captain_discord_id === viewer.discordId`), ou check-in désactivé (`checkin_mode = DISABLED` `#15`). | Publication/édition de l'embed `btn_checkin` dans `#check-in` et rappels avec mentions `<@captain_id>` à J-30 et J-10 min. |
| **Lancement, salons de match et clôture** (`LifecycleService.launchTournament`, `syncPhaseChannels`, `closeTournament`, `DISC-02`, `DISC-03`) | `launchTournament` passe directement le tournoi à `status = 'ACTIVE'` en base sans créer de catégorie ni de salons. | Page Match / Phase sur le Web affichant l'adversaire, le statut, le code de salon in-game (`#23`) et les mises à jour en direct via Supabase Realtime. | Création automatique de la catégorie `🏆`, du salon `#informations`, des salons `#bracket-*` / `#swiss-*` / `#groupe-*` et gestion fine des `permissionOverwrites` (`DISC-04`). |
| **Rôles Capitaine / TO et renommage pseudo** (`PresenceRolesService`, `WebhookRolesService`, `ArchiveService`, `DISC-05`, `OPS-05`) | Aucun appel réseau vers Discord ; le statut de capitaine et de TO est purement géré en base (`teams.captain_discord_id`, `organization_members`, `tournament_staff`). | Badges « Capitaine » et « TO » dans l'interface Web ; contrôle d'accès via `canPerform`. | Attribution/retrait du rôle Discord `@Capitaine`, renommage du pseudo serveur du capitaine au nom de son équipe, passage du salon check-in en lecture seule à l'archivage. |
| **Déclaration et validation des scores** (`ScoreService.ts`, `MatchRouter.ts`, `SCR-01` à `SCR-08`, `#21`) | Calcul du classement (`LeaderboardService`) et progression d'arbre/ronde suisse (`progressTeams` découplé de `TextChannel`) s'exécutent à 100 % en base. | Interface Web sur la fiche du match permettant au capitaine de soumettre un score et au capitaine adverse de le valider/contester (selon `score_validation` `#21`), avec notification dans la Navbar (`#37`). | Menu déroulant `select_match_to_score`, modale `modal_score_*`, boutons `btn_score_val_*` / `btn_score_deny_*` et pings `<@captain>` / `<@&to_role>` en cas de match prêt ou d'égalité (`SCR-06`). |
| **Visibilité des tournois privés** (`canViewTournament` dans `apps/web/src/lib/accessRules.ts`, `SEC-10`) | Un tournoi privé (`is_public = false`) est accessible aux membres de l'organisation, aux joueurs inscrits au tournoi, ou via un lien de partage à jeton (`?invite=...`) généré par le TO. | Vérification en base (`organization_members`, `tournament_staff`, `teams.captain_discord_id`, `team_members.user_id`, ou jeton d'accès tournoi). | Lorsque Discord est actif, tout membre du serveur Discord rattaché (`memberGuildIds`) conserve en plus le droit de voir les tournois privés de l'organisation (`SEC-10`). |

---

### Q4. Cadre d'intégration commun (système de plugins)

> [!NOTE]
> **Distinction Capacité Native vs Intégration (Plugin)** : L'API publique en lecture seule (`#59`) et les overlays OBS (`#17`) ne sont **pas** des intégrations tierces à activer : ce sont des **fonctionnalités natives de la plateforme** toujours disponibles (l'API publique pour tout tournoi `is_public = true`, et l'overlay OBS via son URL à token pour tout tournoi). Le cadre de plugins ci-dessous gouverne les **connecteurs vers des services externes** activables par organisation : `DISCORD`, `TWITCH` (`#58`/`#22`/`#47`) et `AI` (`#46`).

#### 4.1 Contrat d'une intégration
Chaque intégration implémente un contrat unique côté serveur (`apps/bot/src/integrations/`) et déclare ses capacités (`capabilities`), son schéma de configuration publique (`configSchema` Zod dans `@hub/shared`) et son schéma de secrets (`secretsSchema`, chiffré et jamais exposé au client) :

```ts
// Extrait illustratif du contrat d'intégration (Q4)
export type IntegrationProvider = "DISCORD" | "TWITCH" | "AI";

export type IntegrationCapability =
  | "NOTIFICATIONS"    // Annonces cycle de vie, matchs prêts, résultats (Discord, Twitch chat)
  | "ACCESS_SOURCE"    // Fournit des EffectiveGrant (Discord roles)
  | "SCORE_INPUT"      // Permet de proposer ou valider un score (Discord modals, IA OCR #46)
  | "LIVE_STATUS"      // Détecte les streams en direct et clips (Twitch #22, #47)
  | "AI_ASSIST";       // Brouillons de récaps, assistant règlement, prédictions (#46)

export interface DomainEventMap {
  "tournament.registration_opened": { organizationId: string; tournamentId: string };
  "team.registered":                { organizationId: string; tournamentId: string; teamId: string };
  "tournament.checkin_opened":      { organizationId: string; tournamentId: string; closesAt: string };
  "tournament.checkin_reminder":    { organizationId: string; tournamentId: string; minutesLeft: number };
  "team.checkin_updated":           { organizationId: string; tournamentId: string; teamId: string; isCheckedIn: boolean };
  "tournament.checkin_closed":      { organizationId: string; tournamentId: string };
  "tournament.launched":            { organizationId: string; tournamentId: string };
  "phase.seeded":                   { organizationId: string; tournamentId: string; phaseId: string };
  "match.ready":                    { organizationId: string; tournamentId: string; matchId: string; team1Id: string; team2Id: string };
  "match.score_reported":           { organizationId: string; tournamentId: string; matchId: string; reportedByTeamId: string };
  "match.score_contested":          { organizationId: string; tournamentId: string; matchId: string };
  "match.completed":                { organizationId: string; tournamentId: string; matchId: string; winnerId: string | null };
  "phase.round_generated":          { organizationId: string; tournamentId: string; phaseId: string; roundNumber: number };
  "tournament.closed":              { organizationId: string; tournamentId: string };
  "tournament.archived":            { organizationId: string; tournamentId: string };
}

export interface IntegrationPlugin<TConfig = unknown> {
  readonly provider: IntegrationProvider;
  readonly capabilities: readonly IntegrationCapability[];
  validateConfig(input: unknown): TConfig;
  onDisable?(organizationId: string, config: TConfig, options?: { cleanupExternalResources?: boolean }): Promise<void>;
  onEvent?<K extends keyof DomainEventMap>(
    event: K,
    payload: DomainEventMap[K],
    ctx: { config: TConfig; decryptSecrets(): Promise<Record<string, string>> }
  ): Promise<void>;
  resolveAccessGrants?(userId: string, organizationId: string, tournamentId?: string): Promise<EffectiveGrant[]>;
  healthCheck?(organizationId: string): Promise<{ healthy: boolean; reason?: string }>;
}
```

#### 4.2 Modèle d'exécution et résilience : comparatif des options

| Critère | Option 4A : Appels synchrones bloquants dans la requête HTTP | Option 4B : `Promise.allSettled` asynchrone en mémoire (*fire-and-forget*) | Option 4C : Exécution asynchrone isolée avec état de santé par intégration et rejeu idempotent |
| :--- | :--- | :--- | :--- |
| **Principe** | La route HTTP attend que Discord, Twitch et l'IA aient terminé avant de commiter le statut en base (comportement actuel de `DISC-02` et `REG-08`). | L'état métier est écrit en base en premier. Le bus appelle les intégrations actives en arrière-plan avec `Promise.allSettled` et logge les erreurs via `logger.error`. | L'état métier est commité en base d'abord. Le dispatcher exécute chaque intégration active avec un timeout strict et enregistre le dernier statut (`last_status`, `last_error_code`, `updated_at`) sur `organization_integrations` pour afficher une alerte + bouton « Réessayer / Resynchroniser » au TO. |
| **Avantages** | Le TO sait immédiatement si un salon Discord n'a pas pu être créé. | Latence HTTP minimale ; une panne externe ne bloque jamais la requête. | Respecte l'exigence *« une intégration indisponible ne bloque jamais le tournoi »* tout en donnant une visibilité claire au TO (alerte « Salon Discord non synchronisé — Réessayer » ou « Token Twitch expiré » `#58`) et en évitant les doublons (`#45`, `#47`). |
| **Inconvénients** | **Viole l'exigence du RFC** : si Discord ou Twitch tombe en panne, impossible de lancer le tournoi ou de valider un score. | Échec silencieux pour le TO dans l'UI web ; perte en cas de redémarrage PM2. | Requiert 3 colonnes d'état de santé sur `organization_integrations` et un endpoint de rejeu (`sync`). |
| **Coût** | **S** | **S** | **M** |
| **Risques** | Blocage complet d'un tournoi en direct sur rate-limit Discord (429) ou panne API Twitch/IA. | Salons ou annonces manquants sans que le TO n'en soit informé dans le back-office. | Rejeu non idempotent si un handler ne vérifie pas si la ressource externe existe déjà (mitigé par les clés d'idempotence comme `checkin_message_id` `CHK-01` ou `discord_channel_id`). |

#### Décision recommandée : **Option 4C — Commit métier d'abord + dispatcher asynchrone isolé avec état de santé et rejeu idempotent**

**Justification et lien avec l'automatisation configurable (`#21`) :**
- **Inversion de priorité (DB-first, Fail-safe)** : contrairement à l'actuel `DISC-02` (où `LifecycleService.launchTournament` refusait de passer le tournoi à `ACTIVE` si la création de catégorie Discord échouait) et `REG-08` (où l'ouverture des inscriptions échouait en `502` sans salon Discord), **la transition en base de données est désormais l'autorité primaire**. Si l'intégration Discord est active mais que l'API Discord renvoie une erreur `50013` (Missing Permissions) ou est injoignable, le tournoi passe quand même en `REGISTRATION` ou `ACTIVE` ; la réponse API renvoie `{ status: "ACTIVE", integrationWarnings: [{ provider: "DISCORD", code: "CHANNEL_SYNC_FAILED" }] }` et l'UI affiche un toast d'avertissement avec un bouton « Resynchroniser Discord » (`POST /api/phases/:id/sync`).
- **Articulation avec `#21` (`automation_settings`)** :
  - Le moteur d'automatisation (`#21`) pilote **le cœur métier** (`SchedulerService`, `ScoreService`, `LifecycleService`), tandis que les intégrations (`Q4`) **observent** les événements qui en découlent :
    - Si `checkin_mode = DISABLED` (`#15`, `#21`), `SchedulerService` n'émet jamais `tournament.checkin_opened`, donc ni le Web ni l'intégration Discord ne publient de check-in.
    - Si `score_validation = TO_APPROVAL_ONLY` (`#21`), une proposition de score (qu'elle vienne du Web, d'une modale Discord ou d'une extraction IA `#46`) place le match en `WAITING_VALIDATION` et émet `match.score_reported` ; `match.completed` (qui déclenche l'annonce du vainqueur sur Discord, la mise à jour de l'overlay `#17` et la résolution d'une prédiction ou d'un clip Twitch `#46`/`#47`) n'est émis qu'après validation effective.
    - Si `bracket_progression = MANUAL` (`#21`), `match.completed` ne déclenche pas `assign_team_to_match` ni `match.ready` tant que le TO n'a pas validé l'avancement.

---

### Q5. Migration du schéma et des environnements existants

#### Comparatif des options de migration

| Critère | Option 5A : Bascule directe (« Clean Cutover » avec reset de la base de pré-production) | Option 5B : Migration *Expand-and-Contract* en 4 phases avec triggers de double écriture | Option 5C : Coexistence permanente de deux tables (`server_settings` + `organizations`) |
| :--- | :--- | :--- | :--- |
| **Principe** | Le projet n'étant pas encore en production, une migration directe remplace `server_settings` et `guild_admins` par `organizations`, `organization_members`, `tournament_staff`, `organization_integrations` et remplace `tournaments.guild_id` par `tournaments.organization_id NOT NULL`. Au redémarrage du bot, `ClientReady` (`GuildRegistryService`) crée ou synchronise automatiquement une organisation avec l'intégration Discord activée pour chaque serveur où le bot est présent. | Ajout de `organizations` en parallèle de `server_settings`, triggers SQL de synchronisation bidirectionnelle, alias d'URL `/[guildId]`, puis suppression en 4 PRs successives. | Les anciens serveurs restent dans `server_settings` et les nouveaux vont dans `organizations`. |
| **Avantages** | **Zéro dette technique transitoire** ; aucun trigger temporaire ni double colonne à maintenir ; routes Web d'emblée propres (`/[orgSlug]` et `/admin/[orgSlug]`) ; réduction drastique du temps d'implémentation. | Utile uniquement si des tournois réels en production devaient tourner pendant le déploiement. | Aucun impact sur les anciens serveurs à court terme. |
| **Inconvénients** | Réinitialise les données de test existantes (`make db-init` / migration de remplacement) et modifie directement les URLs de `/[guildId]` vers `/[orgSlug]`. | Surcoût important et inutile avant la mise en production. | Duplication totale du code de sécurité et des routes. |
| **Coût** | **S/M** | **L** | **L** |
| **Risques** | Aucun risque sur des données de production (inexistantes) ; le rattrapage automatique `ClientReady` du bot recrée immédiatement les organisations des serveurs Discord où le bot de dev/staging est installé. | Complexité des triggers transitoires. | Bugs d'isolation entre les deux modèles. |

#### Décision recommandée : **Option 5A — Bascule directe (« Clean Cutover »)**

**Justification et déroulement :**
- Le projet n'étant pas encore en production, maintenir une compatibilité descendante sur les URLs `/[guildId]` ou des triggers de double écriture `server_settings <-> organizations` introduirait une complexité inutile.
- **Déroulement de la bascule** :
  1. **Schéma SQL** : suppression de `server_settings`, `guild_admins` et `tournaments.guild_id` au profit de `organizations`, `organization_members`, `tournament_staff`, `organization_integrations`, `organization_integration_secrets`, `integration_access_grants`, `organization_invites` et `tournaments.organization_id UUID NOT NULL`.
  2. **Auto-onboarding des serveurs où le bot est déjà présent** : au démarrage du bot (`Events.ClientReady` dans `apps/bot/src/index.ts`) ou sur `guildCreate`, `GuildRegistryService` vérifie si une `organization_integrations` (`provider = 'DISCORD'`, `external_id = guild.id`) existe. Sinon, il crée automatiquement l'organisation correspondante, inscrit `guild.ownerId` comme `ORG_OWNER` natif dans `organization_members`, active l'intégration Discord et synchronise les grants `DISCORD` (`integration_access_grants`). Ainsi, après un reset de la base, tous les serveurs Discord où le bot est installé réapparaissent immédiatement en tant qu'organisations avec l'intégration Discord activée, sans aucune perte d'accès pour les TO.
  3. **Retour arrière (Rollback)** : simple `git revert` de la PR suivi d'un `make db-init` sur l'environnement de développement/staging.

---

## 5. Impact sécurité

> [!IMPORTANT]
> **Invariant de migration** : toute nouvelle table active la RLS dès sa création (`ALTER TABLE ... ENABLE ROW LEVEL SECURITY`) et aucun droit d'écriture n'est accordé à `anon` ou `authenticated` (`SEC-07`). La migration SQL inclut dans la même transaction la création des tables, leurs contraintes, l'activation de la RLS, les `REVOKE`/`GRANT` et la mise à jour de `supabase/tests/rls_access.sql`.

### 5.1 Cloisonnement multi-tenant : RLS, `SECURITY DEFINER` et gardes applicatifs

1. **Politiques RLS et privilèges PostgreSQL (`SEC-07`, `SEC-10`)** :
   - **Nouvelles tables sensibles (`organization_members`, `tournament_staff`, `integration_access_grants`, `organization_invites`, `organization_integration_secrets`)** :
     - `ENABLE ROW LEVEL SECURITY` dès le `CREATE TABLE`.
     - **Aucune politique `FOR SELECT` publique** et `REVOKE ALL ON TABLE ... FROM PUBLIC, anon, authenticated;` (même modèle que `team_members` dans `20261017000000_harden_access_and_guild_profile.sql`). Seul `service_role` y accède.
   - **Table `organizations` et visibilité publique** :
     - Lecture publique (`anon`, `authenticated`) sur `organizations` (`id`, `slug`, `name`, `icon_url`, `language`). Les configurations d'intégration (`organization_integrations.config` : IDs de rôles, IDs de salons) et les jetons d'invitation (`tournaments.invite_token_hash`) ne sont jamais exposés à `anon` / `authenticated`.
   - **Table `tournaments` et ressources enfants (`phases`, `teams`, `matches`, `groups`, `phase_teams`)** :
     - La fonction `is_public_tournament(tid UUID)` (`SECURITY DEFINER SET search_path = public`) reste inchangée et continue de filtrer toutes les lectures directes `anon` / `authenticated` ainsi que les flux Supabase Realtime (`teams`, `matches`).
     - La lecture des tournois privés (`is_public = false`) passe par le serveur Next.js (`getReadableTournament` dans `apps/web/src/lib/viewer.ts`) qui vérifie que le visiteur est soit membre de l'organisation (`organization_members` / `tournament_staff` / `integration_access_grants`), soit joueur inscrit (`teams.captain_discord_id` / `team_members.user_id`), soit porteur d'un jeton d'invitation valide (`?invite=...`), soit membre du serveur Discord rattaché si l'intégration Discord est active (`SEC-10`).
   - **Fonctions `SECURITY DEFINER`** :
     - Toute nouvelle fonction ou RPC PostgreSQL utilisant `SECURITY DEFINER` DOIT fixer explicitement `SET search_path = public`, révoquer `EXECUTE FROM PUBLIC, anon, authenticated` et n'accorder `EXECUTE` qu'à `service_role`.

2. **Gardes de routes et prévention IDOR (`SEC-01`, `SEC-06`, `SEC-11`, `SEC-12`, `SEC-13`)** :
   - Remplacement de `requireGuildAdmin` par `requireOrganizationAccess(action)` dans `apps/bot/src/middleware/auth.ts`.
   - Toute route de mutation vérifie :
     1. L'authentification service-à-service par `BOT_API_SECRET` en temps constant (`timingSafeEqual`, `SEC-02`, `SEC-03`).
     2. L'identité `X-Discord-User-Id` injectée exclusivement par le proxy serveur Next.js `/api/bot/[...path]` à partir de la session NextAuth (`SEC-06`).
     3. L'appartenance de la ressource ciblée (`tournamentId`, `phaseId`, `teamId`, `matchId`) à l'`organizationId` authentifié via `verify{Tournament,Phase,Team,Match}Organization` **avant** toute écriture ou appel d'intégration (`SEC-01`, `SEC-14`).
     4. L'autorisation fine via `canPerform(access, action, tournamentId)` : par exemple, un `STATISTICIAN` (`#24`) passe sur `PUT /api/matches/:id/force-score` (`tournament:report_stats`) mais reçoit `403` sur `DELETE /api/phases/:id` (`tournament:manage`).
   - **Fail-closed strict (`SEC-04`)** : si la lecture de `organization_members` ou `organization_integrations` dans Supabase échoue, le middleware renvoie `503 Service Unavailable` **sans mettre le résultat en cache** et refuse l'accès.

### 5.2 Stockage sécurisé des jetons et secrets d'intégration (`#58`, `#46`, `#17`)

- **Séparation `config` vs `secrets`** :
  - `organization_integrations.config` (JSONB) ne contient que des paramètres non secrets (ex : `guild_id`, `to_role_id`, `twitch_channel_login`, modèle IA choisi).
  - Les secrets par organisation (tokens OAuth Twitch `access_token` / `refresh_token` `#58`, clé API IA fournie par l'organisation en mode **BYOK** `#46`) sont stockés dans une table isolée `organization_integration_secrets` (`organization_id`, `provider`, `encrypted_payload BYTEA`, `key_version INT`, `updated_at`).
- **Chiffrement au repos (AES-256-GCM)** :
  - Avant insertion en base, les secrets sont chiffrés côté serveur (`apps/bot`) avec **AES-256-GCM** (IV aléatoire de 96 bits unique par écriture + tag d'authentification de 128 bits) à l'aide d'une clé maîtresse serveur `INTEGRATION_ENCRYPTION_KEY` (32 octets en base64/hex dans l'environnement du bot, vérifiée au démarrage selon `OPS-01`).
  - `key_version` permet la rotation de clé sans coupure.
  - Les secrets déchiffrés ne résident qu'en mémoire le temps de l'appel sortant (ex. appel Twitch Helix ou appel au fournisseur IA avec la clé BYOK de l'organisation), ne sont **jamais** journalisés dans Winston (`logger.ts`), **jamais** retournés dans une réponse HTTP au navigateur, et **jamais** placés dans une variable `NEXT_PUBLIC_*`.
- **Jetons d'overlay OBS (`#17`) et d'invitation tournoi privé** :
  - Les tokens d'URL (`/overlay/[orgSlug]/...?token=...` et `?[invite]=...`) sont générés avec 256 bits d'entropie (`crypto.randomBytes(32).toString('base64url')`) ; seul leur **hash SHA-256** (`overlay_token_hash`, `invite_token_hash`) est stocké en base, avec possibilité de régénération/révocation en un clic.

### 5.3 Cas limites de `docs/EDGE_CASES.md` impactés et nouveaux invariants

#### Cas limites existants impactés
| ID | Impact du RFC #57 et évolution de l'invariant |
| :--- | :--- |
| **`SEC-01`** | `verify{Tournament,Phase,Team,Match}Guild` devient `verify{Tournament,Phase,Team,Match}Organization`. Tout accès croisé entre l'organisation A et l'organisation B (avec ou sans Discord) renvoie `403`. |
| **`SEC-04`** | `requireOrganizationAccess` vérifie d'abord les rôles `NATIVE` en base, puis (si l'intégration Discord est `ENABLED`) les grants `DISCORD`. Une panne Supabase renvoie `503` sans mise en cache ; une panne de l'API Discord n'empêche **jamais** un `ORG_OWNER` ou `ORG_ADMIN` natif d'agir, mais refuse (fail-closed) un accès qui dépendrait uniquement d'une vérification live Discord impossible. |
| **`SEC-05`** | Le TTL de `permCache` reste plafonné à 30 s et est purgé immédiatement lors de la désactivation d'une intégration ou du retrait d'un membre. |
| **`SEC-06` / `SEC-13`** | Le proxy `/api/bot/[...path]` transmet `X-Organization-Id` et étend la liste blanche (`botProxyAllowlist.ts`) aux seules routes de gestion d'organisation et d'intégrations. |
| **`SEC-07` / `SEC-10` / `SEC-12`** | La RLS bloque toute lecture anonyme des nouvelles tables d'accès et de secrets ; `getReadableTournament` et `getManagedTournament` (`apps/web/src/lib/viewer.ts`) vérifient `tournament.organization_id === org.id` et les 4 conditions d'accès aux tournois privés (membre org, participant inscrit, lien `?invite=` valide, ou membre du serveur Discord actif). |
| **`SEC-08`** | `ServerSettingsRouter` est remplacé par `OrganizationRouter` + `IntegrationRouter` : validation stricte du schéma Zod par provider et refus `403` si `organization_id` diffère du tenant authentifié. |
| **`SEC-11`** | La règle unique d'accès devient `canPerform(access, action, tournamentId)` dans `@hub/shared`, partagée entre le middleware du bot, le layout admin web et l'affichage des boutons d'action. |
| **`DISC-02`** | **Réécrit** : au lancement d'un tournoi (`launchTournament`), le passage à `ACTIVE` en base ne dépend plus du succès de la création des salons Discord. Si Discord est désactivé, aucun salon n'est créé ; si Discord est activé et échoue, le tournoi passe à `ACTIVE` et l'état de synchronisation Discord est marqué en erreur réessayable. |
| **`DISC-07` / `DISC-08`** | `GuildRegistryService` synchronise le profil et les grants `source = 'DISCORD'` (`integration_access_grants`) sur l'organisation rattachée au `guild.id`. |
| **`REG-08`** | **Réécrit** : l'ouverture des inscriptions (`POST /api/tournaments/:id/registrations`) active toujours les inscriptions Web (`is_registration_open = true`) ; si l'intégration Discord est activée et qu'un salon est configuré, l'embed est envoyé (avec avertissement réessayable en cas d'erreur Discord au lieu d'un blocage dur). |
| **`CHK-01`** | `SchedulerService` exécute l'ouverture/fermeture du check-in en base pour tous les tournois (avec ou sans Discord), et n'exécute le rattrapage de message Discord (`botAlreadySentCheckinMessage`) que si l'intégration Discord est active. |

#### Nouveaux cas limites à ajouter dans `docs/EDGE_CASES.md`
| Nouvel ID | Scénario | Comportement Attendu (Invariant à tester sous Vitest) |
| :--- | :--- | :--- |
| **`SEC-15`** | Désactivation de l'intégration Discord d'une organisation alors qu'un utilisateur doté uniquement du rôle Discord TO (`source = 'DISCORD'`) a une session active (et une entrée dans `permCache`). | Invalidation immédiate de `permCache` et refus `403` sur toute mutation dès la milliseconde suivant la désactivation ; le `ORG_OWNER` natif conserve 100 % de ses accès. |
| **`SEC-16`** | Tentative de suppression ou de rétrogradation du dernier `ORG_OWNER` natif d'une organisation, ou tentative de posséder plus de 5 organisations (`ORG_OWNER`). | Rejet `400` côté service **et** contrainte/trigger SQL empêchant une organisation de se retrouver avec `0` `ORG_OWNER` natif ou un utilisateur de dépasser 5 organisations possédées. |
| **`SEC-17`** | Un `TOURNAMENT_TO` (natif ou via `discord_to_role_id`) tente de modifier un autre tournoi de la même organisation, de modifier les intégrations de l'organisation, ou d'agir après que son tournoi est passé à `ARCHIVED`. | Rejet `403` par `canPerform(access, action, tournamentId)`. |
| **`SEC-18`** | Un serveur Discord `G` déjà rattaché à l'organisation `A` tente d'être rattaché à l'organisation `B` par un utilisateur non autorisé ou en doublon. | Rejet `409 Conflict` (contrainte `UNIQUE (provider, external_id)` sur les intégrations) et vérification que l'utilisateur qui lie le serveur `G` dispose bien des droits `ManageGuild` / `Administrator` / `Owner` sur `G`. |
| **`SEC-19`** | Lecture de `organization_integrations` via l'API ou le SSR web. | Les secrets (tokens OAuth Twitch, clés API IA BYOK) ne sont jamais sérialisés : seul un booléen `hasConfiguredSecret: true` et les métadonnées publiques (ex. nom de chaîne Twitch, masque `sk-...xxxx`) sont renvoyés. |
| **`INT-01`** | Une intégration active (Discord, Twitch Helix, fournisseur IA) lève une exception, dépasse son timeout (ex. 5 s) ou renvoie `429` / `503` lors de `onTournamentLaunch` ou `onMatchResult`. | La mutation métier (lancement du tournoi, validation du score, progression du bracket) réussit (`200`), l'erreur est isolée, journalisée avec `logger.error`, et l'état de santé de l'intégration enregistre l'échec sans impacter les autres intégrations. |
| **`INT-02`** | Token OAuth Twitch (`#58`) ou clé API IA BYOK (`#46`) expiré(e) ou révoqué(e). | Pour Twitch : tentative unique de `refresh_token` ; en cas d'échec (`400`/`401`) ou de clé IA invalide, l'intégration passe en statut `NEEDS_REAUTH` (`enabled = false`), les secrets invalides sont purgés et une bannière d'alerte s'affiche dans le back-office de l'organisation. |

---

## 6. Intégrations et issues liées

> [!NOTE]
> Les issues `#28` (veto des maps), `#39` (profil joueur et historique) et `#45` (idempotence des effets de score / correction de `SCR-05`) ne figurent pas en tant que fiches complètes dans l'export joint, mais sont citées comme dépendances dans `#17`, `#22`, `#23`, `#37`, `#46` et `#47`. Ce qui les concerne ci-dessous est déduit uniquement de ces mentions et de `docs/EDGE_CASES.md`.

### 6.1 Vue d'ensemble des intégrations (`Q4`) et des fonctionnalités touchées par le tenant

| Domaine / Composant | Issues | Nature dans l'architecture | Ce que le RFC #57 débloque | Ce que le RFC #57 contraint | Dépendances |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Discord** (bot actuel) | `#57` | **Intégration (`DISCORD`)** : `NOTIFICATIONS`, `ACCESS_SOURCE`, `SCORE_INPUT` | Permet d'utiliser TournamentHub sans installer le bot, ou de désactiver Discord (avec option de nettoyage des salons du tournoi en cours). | Le bot ne doit plus être présumé présent (`bot_present` / `guild`) dans `LifecycleService`, `RegistrationService`, `SchedulerService` et `ScoreService`. | Lots 1 à 4 de `#57` |
| **Twitch — Compte OAuth par organisateur** | `#58` | **Intégration (`TWITCH`)** : socle d'auth pour `NOTIFICATIONS`, `LIVE_STATUS` | Fournit la table `organization_integrations` + `organization_integration_secrets` (AES-256-GCM) et la page « Intégrations » de l'organisation. **Entérine l'Option B de `#58`** (OAuth par organisation). | Les tokens OAuth Twitch sont strictement cloisonnés par `organization_id` (`SEC-19`, `INT-02`) ; chaque instance self-hosted configure ses propres `TWITCH_CLIENT_ID` / `TWITCH_CLIENT_SECRET`. | Lot 2 (Cadre d'intégrations & coffre de secrets) |
| **Twitch — Statut live & badges** | `#22` | **Intégration (`TWITCH`)** : `LIVE_STATUS` | Permet d'afficher les badges `🔴 LIVE` sur n'importe quel tournoi (avec ou sans Discord) dès que `twitch_channel` est renseigné sur l'équipe ou le tournoi. | Les appels Helix doivent être mis en cache (`>= 60 s`) côté serveur et s'intègrent au connecteur Twitch de l'organisation (ou token applicatif de l'instance en lecture seule). | Lot 1 (`organizations`) ; `#58` et `#39` (profil joueur) |
| **Twitch — Production live & highlights** | `#47` | **Intégration (`TWITCH` + `AI`)** : `LIVE_STATUS`, `NOTIFICATIONS` | Unifie le déclenchement des clips et de l'état post-match sur l'événement `match.completed` du bus `Q4`. | Exige que `#45` (`SCR-05`, déduplication des effets de score) soit résolu avant tout déclenchement automatique de clip ou publication, et impose le consentement explicite pour les interviews. Réutilise la connexion OAuth de `#58`. | `#45` (bloquant), `#58`, `#22`, `#17`, `#23`, `#28`, `#46`, `#24` |
| **IA — Scores, récaps, règlement, prédictions** | `#46` | **Intégration (`AI` en mode BYOK)** : `SCORE_INPUT`, `AI_ASSIST`, `NOTIFICATIONS` | Fournit le contrat `IntegrationPlugin` (`provider = 'AI'`), le stockage chiffré de la clé API de l'organisation (*Bring Your Own Key*) dans `organization_integration_secrets`, et le rattachement au flux de score unifié. | Toute sortie IA est validée par Zod dans `@hub/shared` avant usage ; l'extraction de score propose des valeurs mais ne contourne **jamais** la validation capitaine/TO (`ScoreService` + `#21`). Pour le sous-lot « Prédictions Twitch », dépend de `#58` et `#45`. | Lot 2 (Cadre d'intégrations & secrets BYOK), `#45`, `#58` |
| **Overlays OBS (ToornamentTV)** | `#17` | **Capacité native Web** (Temps réel Supabase) | Les routes d'overlay (`/overlay/[orgSlug]/...`) fonctionnent pour toute organisation sans dépendre d'un `guildId`, d'un bot Discord ni d'un compte Twitch (`#58`). | L'URL est protégée par un token d'overlay haché en base (`SEC-19`), générable uniquement par un membre autorisé via `canPerform(access, 'tournament:cast', id)` (`ORG_ADMIN` ou `CASTER` `#23`). | Lot 1 (`organizations` + `canPerform`), `#23`, `#28` (si affichage du veto) |
| **API Publique en lecture seule** | `#59` | **Capacité native Plateforme** (toujours active pour `is_public = true`) | **N'est pas un plugin** : expose nativement et en permanence les tournois publics sous le nouveau modèle de tenant : `GET /v1/organizations/:orgSlug/tournaments`, `GET /v1/tournaments/:id`, `GET /v1/tournaments/:id/matches`, `GET /v1/phases/:id/standings`. | Filtrage strict `is_public = true` (`SEC-10`), exclusion totale des champs privés (`captain_discord_id`, `friend_code`, `discord_*_channel_id`, `invite_token_hash`), rate-limiting par IP. | Lot 1 (`organizations` et projections publiques dans `@hub/shared`) |
| **Automatisation configurable** | `#21` | **Moteur métier interne** (émetteur des événements `Q4`) | Découple les règles d'avancement du tournoi (`registration_mode`, `checkin_mode`, `score_validation`, `bracket_progression`) de l'exécution Discord : le moteur `#21` orchestre la base de données et émet les événements vers les intégrations actives. | `SchedulerService` et `ScoreService` doivent consulter `automation_settings` avant d'émettre un événement ou de faire progresser une équipe. | Lot 2 (Extraction du cœur métier hors du code Discord) |
| **Rôles Casteur & Statisticien** | `#23`, `#24` | **Rôles `canPerform`** (natifs + source Discord) | Grâce à `Q2`, un Casteur (`#23`) ou un Statisticien (`#24`) peut être nommé **directement sur le site** (au niveau de l'organisation ou d'un seul tournoi via `tournament_staff`) sans Discord, **ou** hériter automatiquement de ce rôle via `caster_role_id` / `statistician_role_id` si Discord est activé. | Les routes `/caster` et `/stats` ainsi que `PUT /api/matches/:id/force-score` et `/stats` doivent utiliser `canPerform(access, 'tournament:cast' | 'tournament:report_stats', tournamentId)`. | Lot 1 (`canPerform`, `organization_members`, `tournament_staff`) |
| **Découplage des étapes (check-in facultatif, inscriptions manuelles)** | `#15` | **Flux métier Web natif** (`Q3`) | S'aligne directement avec `Q3` : un tournoi sans Discord (ou fermé sur invitation) peut désactiver le check-in (`checkin_mode = DISABLED`) et inscrire les équipes depuis le Web sans salon Discord (`REG-08` assoupli). | La correction de score a posteriori doit recalculer `LeaderboardService` de manière idempotente sans ré-émettre de fausses notifications de nouveau match si le tour suivant est déjà entamé. | Lot 2 & `#21` |
| **Découverte des tournois publics & accueil** | `#50` | **Portail public multi-organisations** | Sur `/`, le catalogue des tournois publics affiche tous les tournois `is_public = true` rattachés à leur **organisation** (`/[orgSlug]/tournaments/[id]`), qu'elle utilise Discord ou non. Le parcours organisateur propose « Créer une organisation » (immédiat, sans bot) puis, en option, « Connecter un serveur Discord ». | La vérification de visibilité (`SEC-10`) doit être respectée en base (RLS) et côté serveur Next.js. | Lot 1 (`organizations`) |
| **Navigation enrichie (Navbar)** | `#37` | **Portail Web & notifications in-app** (`Q3`) | « Mes Serveurs » devient « Mes Organisations » (`/organizations`). L'indicateur d'action requise (Notification Dot : check-in ouvert, match prêt, score à valider) devient le canal de notification Web principal pour les joueurs des tournois sans Discord. | Doit interroger les tournois de l'utilisateur via `teams.captain_discord_id` / `team_members.user_id` sans polling excessif. | Lot 1 & Lot 4 (Parcours Web joueur) |

---

## 7. Découpage en issues ordonnées

Avec le choix de l'**Option 5A (Bascule directe)**, le découpage est épuré de toute couche de transition héritée, tout en garantissant dès le Lot 1 que les serveurs Discord existants sont automatiquement ré-enregistrés comme organisations au démarrage du bot.

| Ordre | Titre de l'issue suggérée | Objectif & Périmètre technique | Dépendances | Taille | Impact utilisateurs / dev |
| :---: | :--- | :--- | :---: | :---: | :--- |
| **1** | `refactor(core): basculer le tenant sur organizations et généraliser canPerform (#57)` | Remplacer `server_settings` et `guild_admins` par `organizations`, `organization_members`, `tournament_staff`, `organization_integrations` et `integration_access_grants` (Option 5A). Implémenter `canPerform(access, action, tournamentId)` dans `@hub/shared` (portées `ORGANIZATION`/`TOURNAMENT`, sources `NATIVE`/`DISCORD`, plafond de 5 orgs par `ORG_OWNER`). Mettre à jour `tenant.ts` (`verify*Organization`), `auth.ts`, `GuildRegistryService` (auto-création d'organisation au `ClientReady`), `viewer.ts`, les routes `/[orgSlug]` et `supabase/tests/rls_access.sql`. Couvrir `SEC-15` à `SEC-18`. | Aucune | **L** | Bascule propre du schéma ; les serveurs où le bot est présent deviennent automatiquement des organisations avec Discord actif. |
| **2** | `refactor(bot): extraire le bus d'intégrations (IntegrationPlugin), le coffre de secrets et encapsuler Discord (#57)` | Définir l'interface `IntegrationPlugin` (`DISCORD`, `TWITCH`, `AI`) et la table `organization_integration_secrets` (chiffrement AES-256-GCM, `SEC-19`). Découpler `LifecycleService`, `RegistrationService`, `SchedulerService` et `ScoreService` de Discord : le cœur métier commite en base d'abord (`DISC-02` et `REG-08` réécrits) puis notifie le plugin Discord de façon isolée (`INT-01`). Gérer l'option `cleanupExternalResources` à la désactivation. | **Lot 1** (et recommandé avec `#45`) | **L** | En cas de panne ou désactivation de Discord, les tournois fonctionnent sans blocage. |
| **3** | `feat(web): création d'organisation sans Discord, gestion des membres, invitations et page Intégrations (#57)` | Permettre de créer une organisation sur le Web sans bot Discord (max 5 par `ORG_OWNER`), de gérer les membres natifs (`ORG_OWNER`, `ORG_ADMIN`), les invitations par lien (`organization_invites`), le transfert de propriété, les liens de partage de tournois privés (`?invite=`), et d'activer/configurer/désactiver l'intégration Discord (avec case à cocher de suppression des salons en cours) dans `/admin/[orgSlug]/settings/integrations`. | **Lot 1**, **Lot 2** | **M** | Débloque la création et l'administration d'organisations 100 % Web. |
| **4** | `feat(web): parcours joueur 100 % Web (inscriptions, check-in et saisie de scores sans Discord) (#57)` | Créer sur `/[orgSlug]/tournaments/[id]` le formulaire Web d'inscription d'équipe, le bouton de check-in capitaine et l'interface de déclaration/validation/contestation de score par les capitaines, connectés aux mêmes règles métier que le bot. | **Lot 2**, **Lot 3** (coordonné avec `#15` et `#21`) | **L** | Débloque le déroulement complet d'un tournoi de A à Z pour les joueurs sans Discord. |
| **5** | `feat(roles): intégrer les rôles Casteur (#23) et Statisticien (#24) au modèle canPerform` | Activer les rôles `CASTER` et `STATISTICIAN` dans `canPerform` (attribuables nativement sur le site par organisation/tournoi **et** via `caster_role_id` / `statistician_role_id` dans l'intégration Discord) et livrer les vues `/caster` (`#23`) et `/stats` (`#24`). | **Lot 1**, **Lot 3** | **M** | Ajoute les espaces dédiés staff avec ou sans Discord. |
| **6** | `feat(stream): intégration OAuth Twitch par organisation (#58), badges live (#22) et overlays OBS (#17)` | Implémenter le plugin `TWITCH` (`#58`) en utilisant `organization_integration_secrets`, la détection live (`#22`) et les overlays natifs `/overlay/[orgSlug]/...` protégés par `overlay_token_hash` (`#17`). | **Lot 2**, **Lot 5** | **L** | Débloque l'écosystème streaming par organisation. |
| **7** | `feat(api): API publique v1 en lecture seule centrée sur les organisations (#59)` | Exposer nativement `/v1/organizations/:orgSlug/tournaments`, `/v1/tournaments/:id`, `/v1/tournaments/:id/matches`, `/v1/phases/:id/standings` et la documentation OpenAPI `/developers`, toujours actifs pour les tournois `is_public = true`. | **Lot 1** | **M** | Ouvre l'API publique en lecture seule sur tous les tournois publics. |
| **8** | `feat(ai): adaptateur d'intégration IA en mode BYOK (#46) sur le bus de plugins` | Brancher le plugin `AI` (`#46`) sur le contrat `IntegrationPlugin` avec clé API fournie par l'organisation (chiffrée dans `organization_integration_secrets`) pour le MVP retenu. | **Lot 2**, **Lot 4** | **M** | Ajoute l'assistance IA optionnelle par organisation sans coût d'instance. |

---

## 8. Décisions actées par le propriétaire (clôture des questions ouvertes)

1. **Quotas de création d'organisations sans Discord** : **Oui** — Plafond fixé à **5 organisations possédées en tant que `ORG_OWNER` par compte utilisateur** (`SEC-16`) pour prévenir le spam et le squatting de slugs.
2. **Politique de conservation des salons Discord à la désactivation de l'intégration** : **Option (b)** — Lors de la désactivation de l'intégration Discord, proposer une **case à cocher optionnelle « Supprimer également la catégorie et les salons Discord du tournoi en cours »** (par défaut les salons sont conservés ; si cochée, `onDisable` nettoie la catégorie et les salons Discord du tournoi actif).
3. **Visibilité des tournois privés (`is_public = false`) sans Discord** : **Oui** — Lecture ouverte aux membres enregistrés de l'organisation (`organization_members` / `tournament_staff`), aux joueurs inscrits au tournoi (`teams` / `team_members`), à tout visiteur disposant d'un lien de partage à jeton (`?invite=...`) généré par le TO, ainsi qu'aux membres du serveur Discord rattaché lorsque l'intégration Discord est active (`SEC-10`).
4. **Clé API du fournisseur d'IA (`#46`)** : **Option (b) — BYOK (*Bring Your Own Key*) uniquement** — Chaque organisation qui active l'intégration IA renseigne sa propre clé API, stockée chiffrée (AES-256-GCM) dans `organization_integration_secrets` (`SEC-19`). Aucune clé mutualisée au niveau de l'instance.
