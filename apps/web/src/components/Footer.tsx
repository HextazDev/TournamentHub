"use client";

import Link from "next/link";
import { useTranslation } from "@/i18n/LanguageContext";

export default function Footer() {
  const { t } = useTranslation();
  const currentYear = new Date().getFullYear();

  return (
    <footer className="bg-[#0a0a0f] border-t border-slate-800/60 text-slate-400">
      <div className="max-w-[1600px] w-full mx-auto px-4 sm:px-6 lg:px-8 py-6">
        <div className="flex flex-col sm:flex-row items-center justify-between gap-4 text-sm">
          <div className="flex flex-col sm:flex-row items-center gap-2 sm:gap-3 text-center sm:text-left">
            <span className="font-semibold text-slate-200">
              {t("footer.copyright", { year: currentYear })}
            </span>
            <span className="hidden sm:inline text-slate-700" aria-hidden="true">
              •
            </span>
            <span className="text-slate-400">{t("footer.brandTagline")}</span>
          </div>

          <nav
            aria-label={t("footer.legal")}
            className="flex flex-wrap items-center justify-center gap-x-6 gap-y-2"
          >
            <Link
              href="/terms"
              className="text-slate-400 hover:text-white transition-colors"
            >
              {t("footer.terms")}
            </Link>
            <Link
              href="/privacy"
              className="text-slate-400 hover:text-white transition-colors"
            >
              {t("footer.privacy")}
            </Link>
            <Link
              href="/legal"
              className="text-slate-400 hover:text-white transition-colors"
            >
              {t("footer.legal")}
            </Link>
          </nav>
        </div>
      </div>
    </footer>
  );
}
