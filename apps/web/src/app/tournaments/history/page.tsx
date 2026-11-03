import { permanentRedirect } from "next/navigation";

// Ancienne page mono-serveur : l'historique se consulte désormais depuis le panel de chaque serveur.
export default function LegacyTournamentsHistoryPage() {
  permanentRedirect("/servers");
}
