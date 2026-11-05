import type { Response } from "express";
import { INTERNAL_ERROR_CODE } from "@hub/shared";
import { logger } from "./logger";

/**
 * Refus métier explicite levé par un service (état incompatible, paramètre impossible) :
 * son message est rédigé pour le TO et peut lui être relayé tel quel, avec son statut 4xx.
 * Toute autre erreur (Supabase, Discord, exception inattendue) reste technique et masquée.
 */
export class DomainError extends Error {
  constructor(public readonly status: 400 | 404 | 409, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

/**
 * SEC-19 : réponse unique d'un échec dans une route.
 * - `DomainError` ➜ son statut et son message métier (`{ error }`), journalisé en `warn`.
 * - Toute autre erreur ➜ détail complet (objet d'erreur, stack) dans `logger.error` ; l'appelant ne reçoit
 *   qu'un message générique et un code stable, jamais `error.message` (noms de tables, contraintes…).
 */
export function sendServerError(res: Response, error: unknown, context: string, status = 500): void {
  if (error instanceof DomainError) {
    logger.warn(`[${context}]`, error);
    res.status(error.status).json({ error: error.message });
    return;
  }
  logger.error(`[${context}]`, error);
  res.status(status).json({ error: "Internal Server Error", code: INTERNAL_ERROR_CODE });
}
