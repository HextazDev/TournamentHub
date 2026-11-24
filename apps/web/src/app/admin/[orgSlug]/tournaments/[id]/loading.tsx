import LoadingSkeleton from "@/components/LoadingSkeleton";

export default function TournamentAdminLoading() {
  return (
    <div className="p-6 md:p-8 space-y-6 w-full">
      <div className="space-y-2 animate-pulse">
        <div className="h-8 w-64 bg-slate-800/70 rounded-lg" />
        <div className="h-4 w-96 max-w-full bg-slate-800/40 rounded" />
      </div>
      <LoadingSkeleton rows={3} variant="card" />
    </div>
  );
}
