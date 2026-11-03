.PHONY: install dev dev-bot dev-bot-start bot-start dev-bot-stop bot-stop dev-web dev-web-start web-start dev-web-stop web-stop dev-stop dev-build dev-logs supabase-start supabase-stop db-init db-test-rls db-push env-init init lint build help

help:
	@echo "Commandes disponibles :"
	@echo "  make init           - Initialise l'environnement complet (install + start + config env + db)"
	@echo "  make install        - Installe les dépendances locales (nécessaire pour l'autocomplétion / IDE)"
	@echo "  make supabase-start - Démarre la stack Supabase locale (Docker)"
	@echo "  make supabase-stop  - Éteint la stack Supabase locale (Docker)"
	@echo "  make env-init       - Récupère les clés locales Supabase et met à jour les fichiers .env"
	@echo "  make db-init        - Applique les migrations supabase/migrations sur la base locale"
	@echo "  make db-test-rls    - Rejoue les migrations sur une base jetable et vérifie la RLS"
	@echo "  make db-push        - Applique les migrations en attente sur le projet Supabase lié (PRODUCTION)"
	@echo "  make dev            - Lance le Bot et Next.js en arrière-plan (Docker Compose -d)"
	@echo "  make dev-logs       - Affiche les logs en temps réel des conteneurs de dev"
	@echo "  make dev-bot        - Lance uniquement le bot Discord de Dev (alias: bot-start)"
	@echo "  make dev-bot-stop   - Arrête uniquement le bot Discord de Dev (alias: bot-stop)"
	@echo "  make dev-web        - Lance uniquement le site Next.js dans Docker Compose (alias: web-start)"
	@echo "  make dev-web-stop   - Arrête uniquement le site Next.js (alias: web-stop)"
	@echo "  make dev-build      - Reconstruit les images de développement (après ajout de paquets npm)"
	@echo "  make dev-stop       - Arrête l'ensemble des conteneurs (Bot et Next.js)"
	@echo "  make lint           - Valide les types du bot et lint le code du web"
	@echo "  make build          - Compile le bot et le projet web"

init: install supabase-start env-init db-init
	@echo "🎉 Environnement de développement initialisé avec succès !"
	@echo "👉 Utilisez 'make dev' pour lancer l'application et le bot."

install:
	@echo "📦 Installation de l'ensemble des dépendances du monorepo..."
	npm install

supabase-start:
	@echo "⚡ Démarrage de Supabase en local..."
	npx supabase start

supabase-stop:
	@echo "🛑 Arrêt de Supabase en local..."
	npx supabase stop

env-init:
	@echo "🔑 Configuration des clés d'environnement locales..."
	node scripts/setup-dev-env.js

# Conteneur Postgres de la stack Supabase locale (son suffixe dépend du project_id au démarrage).
DB_CONTAINER ?= $(shell docker ps --format '{{.Names}}' | grep '^supabase_db_' | head -1)

db-init:
	@echo "🗄️ Application des migrations SQL locales..."
	@test -n "$(DB_CONTAINER)" || (echo "❌ Stack Supabase locale introuvable : lancez 'make supabase-start'." && exit 1)
	@for f in $$(ls supabase/migrations/*.sql | sort); do \
		echo "-> Exécution de $$f..."; \
		docker exec -i $(DB_CONTAINER) psql -U postgres -d postgres -v ON_ERROR_STOP=1 --single-transaction < $$f || exit 1; \
	done

db-test-rls:
	@echo "🔒 Vérification de la RLS sur une base jetable..."
	@test -n "$(DB_CONTAINER)" || (echo "❌ Stack Supabase locale introuvable : lancez 'make supabase-start'." && exit 1)
	@docker exec $(DB_CONTAINER) psql -U postgres -q -c "DROP DATABASE IF EXISTS rls_check" -c "CREATE DATABASE rls_check"
	@for f in $$(ls supabase/migrations/*.sql | sort); do \
		docker exec -i $(DB_CONTAINER) psql -U postgres -d rls_check -q -v ON_ERROR_STOP=1 --single-transaction < $$f > /dev/null || exit 1; \
	done
	@docker exec -i $(DB_CONTAINER) psql -U postgres -d rls_check -q -v ON_ERROR_STOP=1 < supabase/tests/rls_access.sql
	@docker exec $(DB_CONTAINER) psql -U postgres -q -c "DROP DATABASE rls_check"

# Production : nécessite 'npx supabase login' puis 'npx supabase link --project-ref <ref>'. Jamais depuis l'éditeur SQL.
db-push:
	npx supabase db push --linked

dev:
	@echo "🚀 Démarrage du Bot et de Next.js en arrière-plan..."
	docker compose up -d
	@echo "👉 Les conteneurs tournent en arrière-plan. Utilisez 'make dev-logs' pour voir les logs."

dev-logs:
	docker compose logs -f

dev-bot:
	@echo "🤖 Démarrage du bot Discord local dans Docker en arrière-plan..."
	docker compose up -d bot-dev
	@echo "👉 Le bot tourne en arrière-plan. Utilisez 'make dev-logs' pour voir les logs."

dev-bot-start: dev-bot
bot-start: dev-bot

dev-bot-stop:
	@echo "🛑 Arrêt du bot Discord local..."
	docker compose stop bot-dev

bot-stop: dev-bot-stop

dev-web:
	@echo "🖥️ Démarrage de Next.js local dans Docker en arrière-plan..."
	docker compose up -d web-dev
	@echo "👉 Next.js tourne en arrière-plan. Utilisez 'make dev-logs' pour voir les logs."

dev-web-start: dev-web
web-start: dev-web

dev-web-stop:
	@echo "🛑 Arrêt de Next.js local..."
	docker compose stop web-dev

web-stop: dev-web-stop

dev-stop:
	@echo "🛑 Arrêt des conteneurs de développement..."
	docker compose down

dev-build:
	@echo "🛠️ Reconstruction des images de développement..."
	docker compose build

lint:
	@echo "🔍 Vérification du typage dans packages/shared..."
	cd packages/shared && npx tsc --noEmit
	@echo "🔍 Vérification du typage dans apps/bot..."
	cd apps/bot && npx tsc --noEmit
	@echo "🔍 Linting dans apps/web..."
	cd apps/web && npm run lint

test:
	@echo "🧪 Exécution des tests unitaires..."
	npm run test

build:
	@echo "🛠️ Compilation du package partagé @hub/shared..."
	cd packages/shared && npm run build
	@echo "🛠️ Compilation de apps/bot..."
	cd apps/bot && npm run build
	@echo "🛠️ Compilation de apps/web..."
	cd apps/web && npm run build
