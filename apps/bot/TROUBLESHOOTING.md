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

## Webhook Supabase (optionnel)

Le webhook ne sert plus qu'à resynchroniser les changements faits hors du bot. S'il est configuré, chaque appel journalise `[WebhookRoles] <INSERT|UPDATE|DELETE> received`. Un payload invalide est rejeté (`[WebhookRoles] Invalid team webhook payload`) sans toucher à Discord. Le contrat (en-têtes requis) est décrit dans `docs/SELF_HOSTING.md`.
