"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Loader2 } from "lucide-react";
import { botApiFetch } from "@/utils/api";
import { useTranslation } from "@/i18n/LanguageContext";
import { useToast } from "@/context/ToastContext";
import { getErrorMessage, readApiError } from "@/utils/errors";

export function CreateOrganizationModal() {
  const { t, locale } = useTranslation();
  const { toast } = useToast();
  const router = useRouter();

  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleNameChange = (value: string) => {
    setName(value);
    if (!slug) {
      setSlug(
        value
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 60),
      );
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !slug.trim()) return;
    setIsSubmitting(true);
    try {
      const res = await botApiFetch("/api/organizations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          slug: slug.trim().toLowerCase(),
          language: locale,
        }),
      });
      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }
      const created = (await res.json()) as { slug?: string };
      toast.success(t("organizations.createdSuccess"));
      setIsOpen(false);
      router.push(`/admin/${created.slug ?? slug.trim().toLowerCase()}`);
      router.refresh();
    } catch (err: unknown) {
      toast.error(t("feedback.genericError", { message: getErrorMessage(err) ?? t("common.unknown") }));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white px-4 py-2.5 text-sm font-semibold transition-colors shadow-lg"
      >
        <Plus className="w-4 h-4" />
        {t("organizations.createButton")}
      </button>

      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl bg-[#151722] border border-slate-800 p-6 shadow-2xl space-y-5">
            <div>
              <h2 className="text-xl font-bold text-white">{t("organizations.createTitle")}</h2>
              <p className="text-sm text-slate-400 mt-1">{t("organizations.createSubtitle")}</p>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-300">{t("organizations.nameLabel")}</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={100}
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder={t("organizations.namePlaceholder")}
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2.5 text-white focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-sm font-medium text-slate-300">{t("organizations.slugLabel")}</label>
                <input
                  type="text"
                  required
                  minLength={2}
                  maxLength={60}
                  pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
                  value={slug}
                  onChange={(e) => setSlug(e.target.value.toLowerCase())}
                  placeholder={t("organizations.slugPlaceholder")}
                  className="w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2.5 text-white font-mono text-sm focus:border-blue-500 focus:outline-none"
                />
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="rounded-lg bg-slate-800 hover:bg-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 transition-colors"
                >
                  {t("organizations.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 hover:bg-blue-500 px-4 py-2 text-sm font-semibold text-white transition-colors disabled:opacity-50"
                >
                  {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
                  {isSubmitting ? t("organizations.creating") : t("organizations.createSubmit")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
