import LoadingSkeleton from "@/components/LoadingSkeleton";

export default function TournamentsLoading() {
  return (
    <div className="max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-6">
      <div className="h-9 w-64 bg-slate-800/70 rounded-lg animate-pulse" />
      <LoadingSkeleton rows={4} variant="card" />
    </div>
  );
}
