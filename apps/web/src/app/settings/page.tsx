import { permanentRedirect } from "next/navigation";

// Ancienne page mono-serveur : les paramètres se règlent depuis /admin/[orgSlug]/settings.
export default function LegacySettingsPage() {
  permanentRedirect("/organizations");
}
