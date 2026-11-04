# Guide de Dépannage - Rôle Capitaine et pseudo d'équipe

## Fonctionnement

Au check-in, le capitaine reçoit le rôle Capitaine du tournoi (`tournaments.discord_captain_role_id`) et son pseudo devient le nom de son équipe (32 caractères max). Au check-out, le pseudo d'équipe et le rôle sont retirés.

Tout passe par `CaptainPresenceService` (`apps/bot/src/services/CaptainPresenceService.ts`), appelé :

| Déclencheur | Où | Webhook requis ? |
| :--- | :--- | :--- |
| Bouton « Confirmer ma présence » (Discord) | `btn_checkin` dans `src/index.ts` | Non |
| Bascule du check-in dans le back-office | `PATCH /api/teams/:id/checkin` | Non |
| Modification de `teams` faite hors du bot (édition directe en base) | `POST /api/webhook/team-update` | Oui, optionnel (voir `docs/SELF_HOSTING.md`) |

Le pseudo et le rôle sont traités **indépendamment** : un capitaine impossible à renommer reçoit quand même le rôle. Un refus Discord n'annule jamais le check-in.

## Lire les logs

Chaque application se termine par une ligne de synthèse :

```
[CaptainPresence] applyPresence done { guildId, teamId, nickname: "applied", role: "applied" }
```

Chaque échec produit un `warn` structuré avec un champ `reason` (et `code` Discord quand il existe) :

| `reason` | Cause | Correctif |
| :--- | :--- | :--- |
| `member_not_manageable` | Propriétaire du serveur, ou membre dont le rôle le plus haut est au-dessus de celui du bot. Discord interdit de le renommer. | Aucun pour le propriétaire. Sinon, monter le rôle du bot au-dessus de celui du membre. Le rôle Capitaine est quand même ajouté. |
| `nickname_failed` | Discord a refusé le renommage (ex. `50013 Missing Permissions` : permission « Gérer les pseudos » absente). | Donner « Gérer les pseudos » au bot. |
| `role_not_found` | Le rôle configuré n'existe plus sur le serveur (cache, puis Discord). | Reconfigurer le rôle Capitaine du tournoi. |
| `role_above_bot` | Le rôle Capitaine est au-dessus du rôle le plus haut du bot. | Placer le rôle du bot au-dessus du rôle Capitaine (Paramètres du serveur → Rôles). |
| `role_add_failed` / `role_remove_failed` | Discord a refusé la modification du rôle (ex. `50013` : permission « Gérer les rôles » absente). | Donner « Gérer les rôles » au bot. |
| `member_unavailable` | Le capitaine n'est plus membre du serveur (`10007`). | Aucun. |
| `guild_unavailable` | Le bot n'est plus sur le serveur du tournoi. | Réinviter le bot. |

Quand le check-in est fait par le bouton Discord et qu'un de ces échecs survient, le capitaine reçoit en plus un message éphémère lui demandant de prévenir un TO.

## Webhook Supabase optionnel (`WebhookRolesService` - OPS-05)

Le webhook ne sert plus qu'à resynchroniser les changements faits hors du bot (édition directe en base). S'il est configuré, chaque appel journalise `[WebhookRoles] <INSERT|UPDATE|DELETE> received`. Un payload invalide est rejeté (`[WebhookRoles] Invalid team webhook payload`) sans toucher à Discord.

### Contrat d'authentification obligatoire (`OPS-05`)

La route `/api/webhook/team-update` est protégée par deux contrôles en temps constant (`timingSafeEqual`) :
1. **`Authorization: Bearer <BOT_API_SECRET>`** (middleware global `/api`)
2. **`x-webhook-secret: <WEBHOOK_SECRET ou BOT_API_SECRET>`** (handler du webhook)

> [!IMPORTANT]
> Ne passez jamais le secret dans l'URL (`?secret=...`) : la query string est ignorée et refusée (`401`) afin d'éviter toute fuite de secret dans les journaux HTTP ou reverse proxies.

### Configuration du Database Webhook dans Supabase

1. Ouvrez votre projet Supabase → **Database → Webhooks**
2. Créez un webhook avec les paramètres suivants :
   - **Name** : `team-update-webhook`
   - **Table** : `public.teams`
   - **Events** : `INSERT`, `UPDATE`, `DELETE`
   - **Method** : `POST`
   - **URL** : `https://api.votre-domaine.example/api/webhook/team-update`
   - **HTTP Headers** :
     - `Content-Type`: `application/json`
     - `Authorization`: `Bearer <VOTRE_BOT_API_SECRET>`
     - `x-webhook-secret`: `<VOTRE_WEBHOOK_SECRET_OU_BOT_API_SECRET>`

### Tester le Webhook manuellement

Remplacez l'URL et les secrets par ceux de votre environnement de test :

```bash
# 1. Vérifier qu'un appel non authentifié est refusé (doit renvoyer HTTP 401)
curl -i -X POST https://api.votre-domaine.example/api/webhook/team-update \
  -H "Content-Type: application/json" \
  -d '{"type":"UPDATE","table":"teams","record":{}}'

# 2. Simuler un événement authentifié depuis Supabase
curl -i -X POST https://api.votre-domaine.example/api/webhook/team-update \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOT_API_SECRET" \
  -H "x-webhook-secret: ${WEBHOOK_SECRET:-$BOT_API_SECRET}" \
  -d '{
    "type": "UPDATE",
    "table": "teams",
    "record": {
      "id": "00000000-0000-0000-0000-000000000000",
      "name": "Test Team",
      "is_checked_in": true,
      "captain_discord_id": "123456789012345678",
      "tournament_id": "00000000-0000-0000-0000-000000000001"
    }
  }'
```

* **Succès (`200 OK`)** : `{"received":true}` lorsque le membre et le rôle Discord ont bien été mis à jour.
* **Échec Discord/DB (`500 Internal Server Error`)** : `{"received":false,"error":"Discord role synchronization failed"}` si le serveur, le membre ou le rôle configuré est introuvable, ou si la hiérarchie des rôles Discord empêche le bot de modifier le membre (`member.manageable === false`).

### Causes fréquentes d'échec sur Discord

1. **Hiérarchie des rôles** : Le rôle du bot doit être placé **au-dessus** du rôle Capitaine et du rôle le plus élevé des joueurs concernés (note : le propriétaire d'un serveur Discord ne peut pas voir son pseudo modifié par un bot).
2. **Permissions manquantes** : Le bot doit disposer des permissions `Manage Roles` et `Manage Nicknames`, ainsi que de l'intent privilégié **Server Members Intent** (`GuildMembers`).
3. **Temps réel côté navigateur (Realtime)** : Pour que l'interface web reflète immédiatement les changements d'équipes et de matchs, vérifiez que `teams` et `matches` figurent bien dans la publication `supabase_realtime` (configurée dans les migrations `supabase/migrations/`).
