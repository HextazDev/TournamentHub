import { InviteClient } from "./InviteClient";

/** Invitation à une organisation : le jeton reste dans le fragment d'URL, jamais envoyé au serveur ni journalisé. */
export default function InvitePage() {
  return <InviteClient />;
}
