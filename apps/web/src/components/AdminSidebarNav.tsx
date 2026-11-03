"use client";

import Link from "next/link";
import { LayoutDashboard, Settings, Trophy, ArrowLeft, Menu, X } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";

export function AdminSidebarNav({ guildId }: { guildId: string }) {
  const { t } = useTranslation();

  return (
    <>
      {/* Mobile Header */}
      <div className="lg:hidden p-4 bg-slate-800 border-b border-slate-700 flex justify-between items-center sticky top-0 z-30">
        <h2 className="text-lg font-bold flex items-center gap-2">
          <Settings className="w-5 h-5 text-blue-400" /> {t("adminSidebar.toPanel")}
        </h2>
        <label
          htmlFor="server-sidebar"
          className="p-2 cursor-pointer bg-slate-700 rounded-md hover:bg-slate-600 transition-colors"
        >
          <Menu className="w-5 h-5 text-white" />
        </label>
      </div>

      {/* Hidden Checkbox for Mobile Toggle */}
      <input type="checkbox" id="server-sidebar" className="peer hidden" />

      {/* Overlay */}
      <label
        htmlFor="server-sidebar"
        className="fixed inset-0 bg-black/60 z-40 hidden peer-checked:block lg:hidden"
      />

      {/* Sidebar */}
      <aside className="fixed lg:sticky top-0 lg:top-[0rem] left-0 h-[100dvh] lg:h-[calc(100vh-4rem)] w-64 bg-slate-800 border-r border-slate-700 flex flex-col shrink-0 z-50 transform -translate-x-full peer-checked:translate-x-0 lg:translate-x-0 transition-transform duration-300">
        <div className="lg:hidden absolute top-4 right-4">
          <label
            htmlFor="server-sidebar"
            className="p-2 cursor-pointer bg-slate-700 rounded-md hover:bg-slate-600 transition-colors flex"
          >
            <X className="w-5 h-5 text-white" />
          </label>
        </div>
        <div className="p-6 border-b border-slate-700">
          <Link href="/admin" className="text-xl font-bold flex items-center gap-2 hover:text-blue-300 transition-colors">
            <Settings className="w-6 h-6 text-blue-400" />
            {t("adminSidebar.toPanel")}
          </Link>
          <p className="text-sm text-slate-400 mt-1">
            {t("adminSidebar.serverAdmin")}
          </p>
        </div>

        <nav className="flex-1 p-4 space-y-2">
          <Link
            href={`/admin/${guildId}`}
            className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
          >
            <LayoutDashboard className="w-5 h-5" />
            {t("adminSidebar.dashboard")}
          </Link>
          <Link
            href={`/admin/${guildId}/settings`}
            className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
          >
            <Settings className="w-5 h-5" />
            {t("adminSidebar.serverSettings")}
          </Link>
          <Link
            href={`/admin/${guildId}/tournaments`}
            className="flex items-center gap-3 px-4 py-3 rounded-lg text-slate-300 hover:text-white hover:bg-slate-700 transition-colors"
          >
            <Trophy className="w-5 h-5" />
            {t("adminSidebar.manageTournaments")}
          </Link>
        </nav>

        <div className="p-4 border-t border-slate-700">
          <Link
            href={`/${guildId}`}
            className="flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors p-2"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("adminSidebar.backToPublic")}
          </Link>
        </div>
      </aside>
    </>
  );
}
