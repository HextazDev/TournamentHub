import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { PublicTournamentNav } from "@/components/PublicTournamentNav";
import { OrganizerCard } from "@/components/OrganizerCard";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";
import { getReadableTournament, getServerProfile } from "@/lib/viewer";

export default async function PublicTournamentLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id } = await params;
  const locale = await getServerLocale();

  // SEC-10 : tournoi privé d'un serveur dont le visiteur n'est pas membre, ou URL incohérente ➜ 404.
  const tournament = await getReadableTournament(guildId, id);
  if (!tournament) notFound();
  const profile = await getServerProfile(guildId);

  return (
    <div className="min-h-screen bg-[#0f111a] text-slate-200 flex flex-col font-sans">
      {/* Top Banner (Header area) */}
      <div className="relative">
        {/* Placeholder banner (Splatoon style/Toornament placeholder) */}
        <div className="w-full h-48 sm:h-64 bg-slate-800 relative shadow-inner overflow-hidden">
          <div className="absolute inset-0 bg-gradient-to-t from-[#0f111a]/80 to-transparent"></div>
          {/* A potential CSS pattern or image here - empty for now */}
          <div className="absolute top-4 left-4 z-10">
            <Link 
              href={`/${guildId}`}
              className="p-2 flex items-center justify-center rounded-full bg-black/40 hover:bg-black/60 text-white backdrop-blur-md transition-colors"
              title={t(locale, "tournaments.backToServerTournaments")}
            >
              <ArrowLeft className="w-5 h-5" />
            </Link>
          </div>
        </div>
        
        {/* Profile Info Overlay */}
        <div className="max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8 relative z-10 -mt-16 sm:-mt-20">
          <div className="flex flex-col sm:flex-row items-center sm:items-end sm:space-x-6">
            <div className="relative">
              <div className="w-24 h-24 sm:w-32 sm:h-32 bg-slate-900 border-4 border-[#0f111a] overflow-hidden rounded-xl shadow-lg flex items-center justify-center shrink-0">
                 {/* Profile picture. Fallback to nice gradient/icon */}
                 <div className="w-full h-full bg-gradient-to-br from-purple-600 via-blue-600 to-cyan-500 flex items-center justify-center">
                    <span className="text-3xl sm:text-5xl font-extrabold text-white opacity-40">
                      {tournament.name?.[0]?.toUpperCase() || "T"}
                    </span>
                 </div>
              </div>
            </div>
            
            <div className="mt-4 sm:mt-0 pb-2 sm:pb-3 flex-grow text-center sm:text-left">
              <h1 className="text-3xl sm:text-4xl font-extrabold text-white tracking-tight">
                {tournament.name}
              </h1>
              <div className="mt-3 flex justify-center sm:justify-start">
                <OrganizerCard guildId={guildId} profile={profile} locale={locale} />
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 sm:mt-8">
        <PublicTournamentNav guildId={guildId} tournamentId={id} />
      </div>

      {/* Main Content Area */}
      <main className="flex-grow pt-8 pb-16">
        <div className="max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8">
          {children}
        </div>
      </main>
    </div>
  );
}


