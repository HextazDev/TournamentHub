import dotenv from "dotenv";
import { readBotEnvironment } from "./environment";

dotenv.config({ quiet: true });
// Evaluated before creating network clients, even when imported from a command.
export const botEnvironment = readBotEnvironment(process.env);
