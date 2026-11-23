import { Trophy } from "lucide-react";
import type { ServerSettings, Tournament } from "@hub/shared";
import { supabaseAdmin } from "@/lib/supabase-admin";
import { getViewer, memberGuildIds } from "@/lib/viewer";
import { TournamentCard } from "@/components/TournamentCard";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";
import type { Locale } from "@/i18n/types";

async function loadTournaments(discordId: string | null, guildIds: string[]) {
  const visible = supabaseAdmin
    .from("tournaments")
    .select("*")
    .neq("status", "ARCHIVED")
    .order("created_at", { ascending: false })
    .limit(60);

  const [publicRes, discordIntsRes, membersRes, staffRes] = await Promise.all([
    visible.eq("is_public", true),
    guildIds.length > 0
      ? supabaseAdmin
          .from("organization_integrations")
          .select("organization_id")
          .eq("provider", "DISCORD")
          .eq("enabled", true)
          .in("external_id", guildIds)
      : Promise.resolve({ data: [], error: null }),
    discordId
      ? supabaseAdmin.from("organization_members").select("organization_id").eq("user_id", discordId)
      : Promise.resolve({ data: [], error: null }),
    discordId
      ? supabaseAdmin
          .from("tournament_staff")
          .select("tournaments!inner(organization_id)")
          .eq("user_id", discordId)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (publicRes.error) throw new Error(`public tournaments read failed: ${publicRes.error.message}`);
  if (discordIntsRes.error) throw new Error(`discord integrations read failed: ${discordIntsRes.error.message}`);
  if (membersRes.error) throw new Error(`organization_members read failed: ${membersRes.error.message}`);
  if (staffRes.error) throw new Error(`tournament_staff read failed: ${staffRes.error.message}`);

  const accessibleOrgIds = new Set<string>();
  for (const row of (discordIntsRes.data ?? []) as { organization_id?: string }[]) {
    if (row.organization_id) accessibleOrgIds.add(row.organization_id);
  }
  for (const row of (membersRes.data ?? []) as { organization_id?: string }[]) {
    if (row.organization_id) accessibleOrgIds.add(row.organization_id);
  }
  for (const row of (staffRes.data ?? []) as { tournaments?: { organization_id?: string } | { organization_id?: string }[] }[]) {
    const t = Array.isArray(row.tournaments) ? row.tournaments[0] : row.tournaments;
    if (t?.organization_id) accessibleOrgIds.add(t.organization_id);
  }

  const privateRes =
    accessibleOrgIds.size > 0
      ? await supabaseAdmin
          .from("tournaments")
          .select("*")
          .in("organization_id", [...accessibleOrgIds])
          .eq("is_public", false)
          .neq("status", "ARCHIVED")
          .order("created_at", { ascending: false })
      : { data: [], error: null };
  if (privateRes.error) throw new Error(`private tournaments read failed: ${privateRes.error.message}`);

  return { publicList: (publicRes.data ?? []) as Tournament[], privateList: (privateRes.data ?? []) as Tournament[] };
}

async function loadProfiles(tournaments: Tournament[]): Promise<Map<string, ServerSettings>> {
  const orgIds = [...new Set(tournaments.map((t) => t.organization_id).filter((id): id is string => Boolean(id)))];
  const map = new Map<string, ServerSettings>();

  if (orgIds.length === 0) return map;

  const [orgsRes, allOrgIntegrationsRes] = await Promise.all([
    supabaseAdmin.from("organizations").select("*").in("id", orgIds),
    supabaseAdmin.from("organization_integrations").select("*").eq("provider", "DISCORD").in("organization_id", orgIds),
  ]);
  if (orgsRes.error) throw new Error(`organizations read failed: ${orgsRes.error.message}`);
  if (allOrgIntegrationsRes.error) throw new Error(`organization_integrations read failed: ${allOrgIntegrationsRes.error.message}`);

  const discordByOrgId = new Map<string, Record<string, unknown>>();
  for (const intRow of (allOrgIntegrationsRes.data ?? []) as Record<string, unknown>[]) {
    if (typeof intRow.organization_id === "string") {
      discordByOrgId.set(intRow.organization_id, intRow);
    }
  }

  for (const orgRow of (orgsRes.data ?? []) as Record<string, unknown>[]) {
    if (typeof orgRow.id !== "string" || typeof orgRow.slug !== "string") continue;
    const discordInt = discordByOrgId.get(orgRow.id);
    const cfg = (discordInt?.config ?? {}) as Record<string, unknown>;
    const discordEnabled = Boolean(discordInt?.enabled);
    const externalGuildId = typeof discordInt?.external_id === "string" ? discordInt.external_id : orgRow.slug;

    const profile: ServerSettings = {
      organization_id: orgRow.id,
      slug: orgRow.slug,
      guild_id: externalGuildId,
      guild_name: typeof orgRow.name === "string" ? orgRow.name : orgRow.slug,
      guild_icon: typeof orgRow.icon_url === "string" ? orgRow.icon_url : null,
      bot_present: discordEnabled && Boolean(cfg.bot_present ?? true),
      to_role_id: typeof cfg.to_role_id === "string" ? cfg.to_role_id : null,
      captain_role_id: typeof cfg.captain_role_id === "string" ? cfg.captain_role_id : null,
      registration_channel_id: typeof cfg.registration_channel_id === "string" ? cfg.registration_channel_id : null,
      announcement_channel_id: typeof cfg.announcement_channel_id === "string" ? cfg.announcement_channel_id : null,
      checkin_channel_id: typeof cfg.checkin_channel_id === "string" ? cfg.checkin_channel_id : null,
      language: orgRow.language === "en" ? "en" : "fr",
      invite_url:
        typeof orgRow.invite_url === "string"
          ? orgRow.invite_url
          : typeof orgRow.public_contact_url === "string"
            ? orgRow.public_contact_url
            : null,
      updated_at: typeof orgRow.updated_at === "string" ? orgRow.updated_at : new Date().toISOString(),
    };

    map.set(orgRow.id, profile);
    map.set(orgRow.slug, profile);
  }

  return map;
}

function Grid({ list, profiles, locale }: { list: Tournament[]; profiles: Map<string, ServerSettings>; locale: Locale }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
      {list.map((tourn) => {
        const profile = profiles.get(tourn.organization_id) ?? null;
        return <TournamentCard key={tourn.id} tournament={tourn} profile={profile} locale={locale} showOrganizer />;
      })}
    </div>
  );
}

export default async function DiscoverTournamentsPage() {
  const locale = await getServerLocale();
  const viewer = await getViewer();
  const { publicList, privateList } = await loadTournaments(viewer.discordId, [...memberGuildIds(viewer)]);
  const profiles = await loadProfiles([...publicList, ...privateList]);

  return (
    <div className="min-h-[calc(100vh-4rem)] bg-[#0f111a] text-slate-200 p-4 sm:p-8">
      <div className="max-w-[1600px] w-full mx-auto space-y-10">
        <header>
          <h1 className="text-4xl font-extrabold text-white tracking-tight">{t(locale, "discover.title")}</h1>
          <p className="text-slate-400 mt-3 text-lg max-w-2xl">{t(locale, "discover.subtitle")}</p>
          {!viewer.discordId && <p className="text-slate-500 mt-2 text-sm">{t(locale, "discover.loginHint")}</p>}
          {viewer.guildsError && (
            <p className="mt-4 rounded-lg border border-amber-700/50 bg-amber-900/20 px-4 py-3 text-sm text-amber-400">
              {t(locale, "discover.guildsUnavailable")}
            </p>
          )}
        </header>

        {viewer.discordId && privateList.length > 0 && (
          <section className="space-y-4">
            <h2 className="text-xl font-bold text-white">{t(locale, "discover.privateSection")}</h2>
            <Grid list={privateList} profiles={profiles} locale={locale} />
          </section>
        )}

        <section className="space-y-4">
          <h2 className="text-xl font-bold text-white">{t(locale, "discover.publicSection")}</h2>
          {publicList.length === 0 ? (
            <div className="bg-[#151722] p-12 text-center rounded-2xl border border-slate-800/50 max-w-xl mx-auto">
              <Trophy className="w-12 h-12 text-slate-600 mx-auto mb-4" />
              <p className="text-slate-200 font-semibold">{t(locale, "discover.empty")}</p>
              <p className="text-slate-500 mt-2 text-sm">{t(locale, "discover.emptyDesc")}</p>
            </div>
          ) : (
            <Grid list={publicList} profiles={profiles} locale={locale} />
          )}
        </section>
      </div>
    </div>
  );
}
