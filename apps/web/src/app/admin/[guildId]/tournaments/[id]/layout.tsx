import { TournamentAdminSidebarNav } from "@/components/TournamentAdminSidebarNav";
import { getManagedTournament } from "@/lib/viewer";
import { notFound } from "next/navigation";

export default async function TournamentAdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ guildId: string; id: string }>;
}) {
  const { guildId, id: tournamentId } = await params;
  const tournament = await getManagedTournament(guildId, tournamentId);
  if (!tournament) notFound();


  return (
    <div className="flex flex-col lg:flex-row min-h-[calc(100vh-4rem)] bg-slate-900 text-white w-full relative">
      <TournamentAdminSidebarNav
        guildId={guildId}
        tournamentId={tournamentId}
        tournamentName={tournament.name}
      />

      {/* Main Tournament Content */}
      <main className="flex-1 p-6 md:p-8 overflow-y-auto flex flex-col">{children}</main>
    </div>
  );
}
