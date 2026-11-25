const MAX_ORG_SLUG_LENGTH = 48;

/**
 * Transforme un nom d'organisation en slug URL valide (aligné sur `OrganizationSlugSchema` : 3 à 48 caractères `[a-z0-9-]`).
 */
export function slugifyOrganizationName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_ORG_SLUG_LENGTH)
    .replace(/-+$/g, "");
}
