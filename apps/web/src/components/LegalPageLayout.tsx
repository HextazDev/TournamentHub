"use client";

import Link from "next/link";
import { ArrowLeft, FileText, Shield, Scale } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";
import { LEGAL_LAST_UPDATED_ISO } from "@/lib/legal";

export type LegalDocumentType = "terms" | "privacy" | "legal";

interface LegalPageLayoutProps {
  active: LegalDocumentType;
  title: string;
  subtitle: string;
  children: React.ReactNode;
}

export default function LegalPageLayout({
  active,
  title,
  subtitle,
  children,
}: LegalPageLayoutProps) {
  const { locale, t } = useTranslation();

  const formattedDate = new Intl.DateTimeFormat(locale, {
    dateStyle: "long",
    timeZone: "UTC",
  }).format(new Date(`${LEGAL_LAST_UPDATED_ISO}T00:00:00Z`));

  const navItems: Array<{
    key: LegalDocumentType;
    href: string;
    label: string;
    icon: React.ReactNode;
  }> = [
    {
      key: "terms",
      href: "/terms",
      label: t("legal.nav.terms"),
      icon: <FileText size={16} />,
    },
    {
      key: "privacy",
      href: "/privacy",
      label: t("legal.nav.privacy"),
      icon: <Shield size={16} />,
    },
    {
      key: "legal",
      href: "/legal",
      label: t("legal.nav.legal"),
      icon: <Scale size={16} />,
    },
  ];

  return (
    <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-10 sm:py-14 text-slate-200">
      <div className="mb-6">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-slate-400 hover:text-white transition-colors"
        >
          <ArrowLeft size={16} />
          <span>{t("legal.backHome")}</span>
        </Link>
      </div>

      <nav
        aria-label={t("legal.nav.legal")}
        className="flex flex-wrap gap-2 mb-8"
      >
        {navItems.map((item) => {
          const isActive = item.key === active;
          return (
            <Link
              key={item.key}
              href={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${
                isActive
                  ? "bg-blue-600/20 border-blue-500/50 text-blue-300"
                  : "bg-[#151722] border-slate-800/70 text-slate-300 hover:text-white hover:border-slate-700"
              }`}
            >
              {item.icon}
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      <article className="bg-[#151722] border border-slate-800/70 rounded-2xl p-6 sm:p-10 shadow-sm">
        <header className="border-b border-slate-800/70 pb-6 mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white tracking-tight">
            {title}
          </h1>
          <p className="mt-3 text-slate-400 text-base leading-relaxed">
            {subtitle}
          </p>
          <p className="mt-4 text-xs text-slate-500">
            {t("legal.lastUpdatedLabel")}: {formattedDate}
          </p>
        </header>

        <div className="space-y-8 text-slate-300 leading-relaxed">
          {children}
        </div>
      </article>
    </div>
  );
}
