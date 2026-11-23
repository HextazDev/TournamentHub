"use client";

import { useTranslation } from "@/i18n/LanguageContext";
import type { LegalConfig } from "@/lib/legal";
import LegalPageLayout, { type LegalDocumentType } from "./LegalPageLayout";

interface LegalDocumentContentProps {
  docType: LegalDocumentType;
  config: LegalConfig;
}

function ContactValue({
  email,
  fallback,
}: {
  email: string | null;
  fallback: string;
}) {
  if (!email) {
    return <span className="text-slate-400 italic">{fallback}</span>;
  }

  return (
    <a
      href={`mailto:${email}`}
      className="text-blue-400 hover:text-blue-300 underline underline-offset-4 transition-colors"
    >
      {email}
    </a>
  );
}

export default function LegalDocumentContent({
  docType,
  config,
}: LegalDocumentContentProps) {
  const { t } = useTranslation();
  const notConfigured = t("legal.notConfigured");

  if (docType === "terms") {
    const sections = [
      {
        title: t("legal.terms.sections.scopeTitle"),
        body: t("legal.terms.sections.scopeBody"),
      },
      {
        title: t("legal.terms.sections.accessTitle"),
        body: t("legal.terms.sections.accessBody"),
      },
      {
        title: t("legal.terms.sections.conductTitle"),
        body: t("legal.terms.sections.conductBody"),
      },
      {
        title: t("legal.terms.sections.organizersTitle"),
        body: t("legal.terms.sections.organizersBody"),
      },
      {
        title: t("legal.terms.sections.availabilityTitle"),
        body: t("legal.terms.sections.availabilityBody"),
      },
      {
        title: t("legal.terms.sections.suspensionTitle"),
        body: t("legal.terms.sections.suspensionBody"),
      },
      {
        title: t("legal.terms.sections.changesTitle"),
        body: t("legal.terms.sections.changesBody"),
      },
    ];

    return (
      <LegalPageLayout
        active="terms"
        title={t("legal.terms.title")}
        subtitle={t("legal.terms.subtitle")}
      >
        {sections.map((section) => (
          <section key={section.title} className="space-y-2">
            <h2 className="text-xl font-semibold text-white">
              {section.title}
            </h2>
            <p className="text-slate-300">{section.body}</p>
          </section>
        ))}
      </LegalPageLayout>
    );
  }

  if (docType === "privacy") {
    return (
      <LegalPageLayout
        active="privacy"
        title={t("legal.privacy.title")}
        subtitle={t("legal.privacy.subtitle")}
      >
        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-white">
            {t("legal.privacy.sections.controllerTitle")}
          </h2>
          <p>{t("legal.privacy.sections.controllerBody")}</p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-white">
            {t("legal.privacy.sections.dataCollectedTitle")}
          </h2>
          <p>{t("legal.privacy.sections.dataCollectedIntro")}</p>
          <ul className="list-disc pl-6 space-y-2 text-slate-300">
            <li>{t("legal.privacy.sections.dataCollectedItem1")}</li>
            <li>{t("legal.privacy.sections.dataCollectedItem2")}</li>
            <li>{t("legal.privacy.sections.dataCollectedItem3")}</li>
          </ul>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-white">
            {t("legal.privacy.sections.purposeTitle")}
          </h2>
          <p>{t("legal.privacy.sections.purposeBody")}</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-white">
            {t("legal.privacy.sections.cookiesTitle")}
          </h2>
          <p>{t("legal.privacy.sections.cookiesBody")}</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-white">
            {t("legal.privacy.sections.subprocessorsTitle")}
          </h2>
          <p>{t("legal.privacy.sections.subprocessorsBody")}</p>
        </section>

        <section className="space-y-2">
          <h2 className="text-xl font-semibold text-white">
            {t("legal.privacy.sections.retentionTitle")}
          </h2>
          <p>{t("legal.privacy.sections.retentionBody")}</p>
        </section>

        <section className="space-y-3">
          <h2 className="text-xl font-semibold text-white">
            {t("legal.privacy.sections.rightsTitle")}
          </h2>
          <p>{t("legal.privacy.sections.rightsBody")}</p>
          <div className="bg-[#0a0a0f] border border-slate-800/70 rounded-xl px-4 py-3 text-sm flex flex-wrap items-center gap-2">
            <span className="font-medium text-slate-200">
              {t("legal.privacy.sections.contactLabel")}:
            </span>
            <ContactValue
              email={config.contactEmail}
              fallback={notConfigured}
            />
          </div>
        </section>
      </LegalPageLayout>
    );
  }

  return (
    <LegalPageLayout
      active="legal"
      title={t("legal.legal.title")}
      subtitle={t("legal.legal.subtitle")}
    >
      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-white">
          {t("legal.legal.sections.publisherTitle")}
        </h2>
        <dl className="bg-[#0a0a0f] border border-slate-800/70 rounded-xl p-4 space-y-3 text-sm">
          <div className="flex flex-col sm:flex-row sm:gap-4">
            <dt className="sm:w-48 font-medium text-slate-400">
              {t("legal.legal.sections.publisherNameLabel")}
            </dt>
            <dd className="text-slate-200">
              {config.publisherName ?? (
                <span className="text-slate-400 italic">{notConfigured}</span>
              )}
            </dd>
          </div>
          <div className="flex flex-col sm:flex-row sm:gap-4">
            <dt className="sm:w-48 font-medium text-slate-400">
              {t("legal.legal.sections.contactEmailLabel")}
            </dt>
            <dd>
              <ContactValue
                email={config.contactEmail}
                fallback={notConfigured}
              />
            </dd>
          </div>
          {config.siteUrl ? (
            <div className="flex flex-col sm:flex-row sm:gap-4">
              <dt className="sm:w-48 font-medium text-slate-400">
                {t("legal.legal.sections.siteUrlLabel")}
              </dt>
              <dd className="text-slate-200 break-all">{config.siteUrl}</dd>
            </div>
          ) : null}
        </dl>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-semibold text-white">
          {t("legal.legal.sections.hostTitle")}
        </h2>
        <dl className="bg-[#0a0a0f] border border-slate-800/70 rounded-xl p-4 space-y-3 text-sm">
          <div className="flex flex-col sm:flex-row sm:gap-4">
            <dt className="sm:w-48 font-medium text-slate-400">
              {t("legal.legal.sections.hostNameLabel")}
            </dt>
            <dd className="text-slate-200">
              {config.hostName ?? (
                <span className="text-slate-400 italic">{notConfigured}</span>
              )}
            </dd>
          </div>
          <div className="flex flex-col sm:flex-row sm:gap-4">
            <dt className="sm:w-48 font-medium text-slate-400">
              {t("legal.legal.sections.hostAddressLabel")}
            </dt>
            <dd className="text-slate-200">
              {config.hostAddress ?? (
                <span className="text-slate-400 italic">{notConfigured}</span>
              )}
            </dd>
          </div>
        </dl>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold text-white">
          {t("legal.legal.sections.ipTitle")}
        </h2>
        <p>{t("legal.legal.sections.ipBody")}</p>
      </section>

      <section className="space-y-2">
        <h2 className="text-xl font-semibold text-white">
          {t("legal.legal.sections.liabilityTitle")}
        </h2>
        <p>{t("legal.legal.sections.liabilityBody")}</p>
      </section>
    </LegalPageLayout>
  );
}
