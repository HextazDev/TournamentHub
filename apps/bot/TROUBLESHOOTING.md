# Guide de Dépannage - Synchronisation des Rôles et Pseudos (`WebhookRolesService`)

## Fonctionnement : `WebhookRolesService`

Le bot synchronise le rôle de capitaine et le pseudonyme d'équipe sur Discord via un **Database Webhook Supabase** qui envoie une requête HTTP `POST /api/webhook/team-update` au bot lorsqu'une ligne de la table `teams` change.

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
