import LoadingSkeleton from "@/components/LoadingSkeleton";

export default function PublicTournamentLoading() {
  return (
    <div className="space-y-6 w-full">
      <LoadingSkeleton rows={3} variant="card" />
    </div>
  );
}
