import type { Metadata } from "next";
import LegalDocumentContent from "@/components/LegalDocumentContent";
import { t } from "@/i18n";
import { getServerLocale } from "@/i18n/server";
import { resolveLegalConfig } from "@/lib/legal";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const locale = await getServerLocale();
  return {
    title: t(locale, "legal.legal.metaTitle"),
    description: t(locale, "legal.legal.metaDescription"),
  };
}

export default function LegalNoticePage() {
  const config = resolveLegalConfig(process.env);
  return <LegalDocumentContent docType="legal" config={config} />;
}
