import { guildIconUrl } from "@/components/OrganizerCard";

export function GuildAvatar({ id, name, icon }: { id: string; name: string; icon: string | null }) {
  const url = guildIconUrl(id, icon);
  return url ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt="" className="w-14 h-14 rounded-xl bg-slate-800 shrink-0" />
  ) : (
    <div className="w-14 h-14 rounded-xl bg-[#1a1d2d] flex items-center justify-center shrink-0">
      <span className="text-lg font-bold text-slate-300">{name.substring(0, 2).toUpperCase()}</span>
    </div>
  );
}
