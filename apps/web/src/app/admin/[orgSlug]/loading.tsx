import LoadingSkeleton from "@/components/LoadingSkeleton";

export default function OrgAdminLoading() {
  return (
    <div className="p-6 md:p-8 space-y-6 w-full">
      <div className="space-y-2 animate-pulse">
        <div className="h-8 w-56 bg-slate-800/70 rounded-lg" />
        <div className="h-4 w-80 bg-slate-800/40 rounded" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 animate-pulse">
        <div className="h-28 bg-slate-800/50 rounded-xl border border-slate-800" />
        <div className="h-28 bg-slate-800/50 rounded-xl border border-slate-800" />
        <div className="h-28 bg-slate-800/50 rounded-xl border border-slate-800" />
      </div>
      <LoadingSkeleton rows={3} variant="card" />
    </div>
  );
}
