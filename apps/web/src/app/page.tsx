"use client";

import { useSession, signIn } from "next-auth/react";
import Link from "next/link";
import { LogIn, ArrowRight, Trophy } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";

export default function Home() {
  const { data: session } = useSession();
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center min-h-[80vh] w-full px-6 py-12 bg-[#0a0a0f] text-slate-200">
      <div className="max-w-3xl text-center space-y-8">
        <h1 className="text-5xl md:text-6xl font-extrabold text-white tracking-tight">
          {t("home.heroTitle")}{" "}
          <span className="text-blue-500">{t("home.heroTitleHighlight")}</span>
        </h1>
        <p className="text-xl text-slate-400 max-w-2xl mx-auto leading-relaxed">
          {t("home.heroSubtitle")}
        </p>

        <div className="pt-8 flex flex-col sm:flex-row items-center justify-center gap-4">
          <Link
            href="/tournaments"
            className="w-full sm:w-auto flex items-center justify-center gap-3 bg-[#151722] hover:bg-[#1a1d2d] border border-slate-700 text-white font-semibold py-4 px-8 rounded-xl transition-transform hover:scale-105"
          >
            <Trophy size={24} />
            {t("home.browseTournaments")}
          </Link>
          {!session ? (
            <button
              onClick={() => signIn("discord", { callbackUrl: "/servers" })}
              className="w-full sm:w-auto flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-500 text-white font-semibold py-4 px-8 rounded-xl shadow-lg transition-transform hover:scale-105"
            >
              <LogIn size={24} />
              {t("home.connectDiscord")}
            </button>
          ) : (
            <Link
              href="/servers"
              className="w-full sm:w-auto flex items-center justify-center gap-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold py-4 px-8 rounded-xl shadow-lg transition-transform hover:scale-105"
            >
              {t("home.accessServers")}
              <ArrowRight size={24} />
            </Link>
          )}
        </div>
      </div>

      <div className="mt-24 grid grid-cols-1 md:grid-cols-3 gap-8 max-w-5xl">
        <div className="bg-[#151722] hover:bg-[#1a1d2d] p-6 rounded-2xl shadow-sm border border-slate-800/50">
          <div className="bg-blue-500/10 border border-blue-500/20 w-12 h-12 rounded-lg flex items-center justify-center mb-4">
            <span className="text-2xl">🏆</span>
          </div>
          <h3 className="text-lg font-bold text-slate-200 mb-2">
            {t("home.feature1Title")}
          </h3>
          <p className="text-slate-400">
            {t("home.feature1Desc")}
          </p>
        </div>
        <div className="bg-[#151722] hover:bg-[#1a1d2d] p-6 rounded-2xl shadow-sm border border-slate-800/50">
          <div className="bg-blue-500/10 border border-blue-500/20 w-12 h-12 rounded-lg flex items-center justify-center mb-4">
            <span className="text-2xl">🤖</span>
          </div>
          <h3 className="text-lg font-bold text-slate-200 mb-2">
            {t("home.feature2Title")}
          </h3>
          <p className="text-slate-400">
            {t("home.feature2Desc")}
          </p>
        </div>
        <div className="bg-[#151722] hover:bg-[#1a1d2d] p-6 rounded-2xl shadow-sm border border-slate-800/50">
          <div className="bg-blue-500/10 border border-blue-500/20 w-12 h-12 rounded-lg flex items-center justify-center mb-4">
            <span className="text-2xl">📱</span>
          </div>
          <h3 className="text-lg font-bold text-slate-200 mb-2">
            {t("home.feature3Title")}
          </h3>
          <p className="text-slate-400">
            {t("home.feature3Desc")}
          </p>
        </div>
      </div>
    </div>
  );
}

