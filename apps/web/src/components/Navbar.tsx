"use client";

import { useSession, signIn, signOut } from "next-auth/react";
import Link from "next/link";
import { LogOut, Menu, LogIn, WifiOff } from "lucide-react";
import { useState } from "react";
import { useOnlineStatus } from "@/hooks/useOnlineStatus";
import { useTranslation } from "@/i18n/LanguageContext";
import { LanguageSwitcher } from "./LanguageSwitcher";

export default function Navbar() {
  const { data: session } = useSession();
  const [isOpen, setIsOpen] = useState(false);
  const isOnline = useOnlineStatus();
  const { t } = useTranslation();

  return (
    <nav className="bg-[#0a0a0f] border-b border-slate-800/50 text-white shadow-md relative z-50">
      <div className="max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between h-16">
          <div className="flex items-center gap-3">
            <Link
              href="/"
              className="flex-shrink-0 flex items-center gap-2"
            >
              <span className="font-bold text-xl tracking-tight">
                {t("nav.brand")}
              </span>
            </Link>
            <ConnectionIndicator isOnline={isOnline} />
          </div>

          <div className="hidden md:flex items-center space-x-4">
            <Link
              href="/tournaments"
              className="text-slate-300 hover:text-white text-sm font-medium transition"
            >
              {t("nav.tournaments")}
            </Link>
            <LanguageSwitcher />
            {!session ? (
              <button
                onClick={() => signIn("discord", { callbackUrl: "/servers" })}
                className="bg-[#151722] hover:bg-[#1a1d2d] text-white px-4 py-2 rounded-md text-sm font-medium transition flex items-center gap-2 border border-slate-800/50"
              >
                <LogIn size={16} /> {t("nav.loginDiscord")}
              </button>
            ) : (
              <div className="flex items-center gap-4">
                <Link
                  href="/servers"
                  className="text-slate-300 hover:text-white text-sm font-medium transition"
                >
                  {t("nav.myServers")}
                </Link>
                <Link
                  href="/admin"
                  className="text-slate-300 hover:text-white text-sm font-medium transition"
                >
                  {t("nav.organizerPanel")}
                </Link>
                <div className="flex items-center gap-3">
                  <img
                    src={
                      session.user?.image ||
                      "https://cdn.discordapp.com/embed/avatars/0.png"
                    }
                    alt={t("nav.avatarAlt")}
                    className="w-8 h-8 rounded-full border-2 border-blue-500"
                  />
                  <span className="font-medium text-sm">
                    {session.user?.name}
                  </span>
                </div>
                <button
                  onClick={() => signOut({ callbackUrl: "/" })}
                  className="text-slate-400 hover:text-white transition"
                  title={t("nav.logout")}
                >
                  <LogOut size={20} />
                </button>
              </div>
            )}
          </div>

          <div className="md:hidden flex items-center gap-2">
            <LanguageSwitcher />
            <ConnectionIndicator isOnline={isOnline} />
            <button
              onClick={() => setIsOpen(!isOpen)}
              className="inline-flex items-center justify-center p-2 rounded-md text-slate-400 hover:text-white hover:bg-[#151722] focus:outline-none"
            >
              <Menu size={24} />
            </button>
          </div>
        </div>
      </div>

      {isOpen && (
        <div className="md:hidden bg-[#151722] border-t border-slate-800/50 pb-3 pt-2">
          <Link
            href="/tournaments"
            className="block mx-4 px-3 py-2 rounded-md text-base font-medium text-slate-300 hover:text-white hover:bg-[#0a0a0f]"
            onClick={() => setIsOpen(false)}
          >
            {t("nav.tournaments")}
          </Link>
          {!session ? (
            <div className="px-4 py-2">
              <button
                onClick={() => signIn("discord", { callbackUrl: "/servers" })}
                className="w-full bg-[#151722] hover:bg-[#0a0a0f] border border-slate-800/50 text-white px-4 py-2 rounded-md text-sm font-medium flex items-center justify-center gap-2"
              >
                <LogIn size={16} /> {t("nav.loginDiscord")}
              </button>
            </div>
          ) : (
            <div className="px-4">
              <div className="flex items-center gap-3 py-3 border-b border-slate-800/50 mb-2">
                <img
                  src={
                    session.user?.image ||
                    "https://cdn.discordapp.com/embed/avatars/0.png"
                  }
                  alt={t("nav.avatarAlt")}
                  className="w-10 h-10 rounded-full border-2 border-blue-500"
                />
                <span className="font-medium text-base text-white">
                  {session.user?.name}
                </span>
              </div>
              <Link
                href="/servers"
                className="block px-3 py-2 rounded-md text-base font-medium text-slate-300 hover:text-white hover:bg-[#151722]"
                onClick={() => setIsOpen(false)}
              >
                {t("nav.myServers")}
              </Link>
              <Link
                href="/admin"
                className="block px-3 py-2 rounded-md text-base font-medium text-slate-300 hover:text-white hover:bg-[#151722]"
                onClick={() => setIsOpen(false)}
              >
                {t("nav.organizerPanel")}
              </Link>
              <button
                onClick={() => signOut({ callbackUrl: "/" })}
                className="w-full text-left mt-2 px-3 py-2 rounded-md text-base font-medium text-slate-400 hover:text-white hover:bg-[#151722] flex items-center gap-2"
              >
                <LogOut size={18} /> {t("nav.logout")}
              </button>
            </div>
          )}
        </div>
      )}
    </nav>
  );
}

function ConnectionIndicator({ isOnline }: { isOnline: boolean }) {
  const { t } = useTranslation();
  if (isOnline) return null;

  return (
    <div
      className="flex items-center gap-1.5 text-xs text-red-400"
      title={t("common.connectionLost")}
    >
      <WifiOff size={14} />
      <span className="hidden sm:inline">{t("common.offline")}</span>
    </div>
  );
}

