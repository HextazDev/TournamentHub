"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { botApiFetch } from "@/utils/api";
import Link from "next/link";
import { CheckCircle2, ChevronLeft } from "lucide-react";
import { useToast } from "@/context/ToastContext";
import { useTranslation } from "@/i18n/LanguageContext";
import { getErrorMessage, readApiError } from "@/utils/errors";
import {
  GROUP_POINTS_DEFAULTS,
  GROUP_POINTS_KEYS,
  GROUP_POINTS_MAX,
  GROUP_POINTS_MIN,
  GroupPointValueSchema,
  GroupPointsSettingsSchema,
  resolveGroupPoints,
  type GroupPoints,
  type GroupPointsKey,
} from "@hub/shared";

/** `""` représente un champ numérique en cours d'édition (vidé par l'utilisateur). */
type PhaseSettingsForm = Partial<Record<GroupPointsKey, number | "">> & {
  bracket_reset?: boolean;
  third_place_match?: boolean;
  swiss_rounds_count?: number | "";
  [key: string]: unknown;
};

function isPlainSettings(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isGroupPointsKey(key: string): key is GroupPointsKey {
  return (GROUP_POINTS_KEYS as readonly string[]).includes(key);
}

export function PhaseConfigClient({ 
  phase, 
  tournamentId, 
  guildId, 
  totalTeams 
}: { 
  phase: any, 
  tournamentId: string, 
  guildId: string, 
  totalTeams: number 
}) {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();

  const [activeTab, setActiveTab] = useState<"general" | "advanced">("general");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isGroups = phase.format === "ROUND_ROBIN";
  const defaultSettings: PhaseSettingsForm = isGroups 
    ? { ...GROUP_POINTS_DEFAULTS }
    : (phase.format === "DOUBLE_ELIM" 
        ? { bracket_reset: true } 
        : (phase.format === "SWISS"
            ? { swiss_rounds_count: 3 }
            : { third_place_match: false }));
    
  const parsedSettings: unknown = phase.settings ?? {};
  // Les points invalides ou absents (settings `{}`, `""`, `NaN`…) retombent sur 3 / 1 / 0 / 0 ;
  // un barème personnalisé par l'organisateur est conservé tel quel.
  const resolvedPoints = resolveGroupPoints(parsedSettings);
  const initialSettings: PhaseSettingsForm = {
    ...defaultSettings,
    ...(isPlainSettings(parsedSettings) ? parsedSettings : {}),
    ...(isGroups ? resolvedPoints : {}),
  };
  // Dernière valeur valide de chaque champ de points, restaurée si le champ est quitté vide.
  const lastValidPoints = useRef<GroupPoints>(resolvedPoints);

  const [formData, setFormData] = useState({
    name: phase.name,
    phase_order: phase.phase_order,
    bracket_size: phase.bracket_size || 8,
    max_groups: phase.max_groups || 8,
    settings: initialSettings
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value, type } = e.target;
    // @ts-ignore
    const checked = type === "radio" || type === "checkbox" ? e.target.checked : undefined;
    
    if (name.startsWith("settings.")) {
      const settingName = name.split(".")[1];
      const nextValue = type === "number" ? (value === '' ? '' : Number(value)) : (type === "checkbox" ? checked : (value === 'true'));
      if (settingName && isGroupPointsKey(settingName)) {
        const parsedPoint = GroupPointValueSchema.safeParse(nextValue);
        if (parsedPoint.success) lastValidPoints.current = { ...lastValidPoints.current, [settingName]: parsedPoint.data };
      }
      setFormData(prev => ({
        ...prev,
        settings: {
          ...prev.settings,
          [settingName]: nextValue
        }
      }));
    } else {
      setFormData(prev => ({
        ...prev,
        [name]: (type === "number" || name === 'bracket_size' || name === 'max_groups') 
                 ? (value === '' ? '' : parseInt(value)) 
                 : value
      }));
    }
  };

  // Un champ de points ne reste jamais vide ni invalide : on restaure la dernière valeur valide.
  const handlePointsBlur = (key: GroupPointsKey) => {
    if (GroupPointValueSchema.safeParse(formData.settings[key]).success) return;
    setFormData(prev => ({
      ...prev,
      settings: { ...prev.settings, [key]: lastValidPoints.current[key] }
    }));
  };

  const handleRadioChange = (name: string, val: boolean) => {
    setFormData(prev => ({
      ...prev,
      settings: {
        ...prev.settings,
        [name]: val
      }
    }));
  };

  const onSubmit = async (shouldRedirect: boolean) => {
    if (isGroups && !GroupPointsSettingsSchema.safeParse(formData.settings).success) {
      toast.error(t("adminPhaseConfig.invalidPoints", { min: GROUP_POINTS_MIN, max: GROUP_POINTS_MAX }));
      return;
    }
    setIsSubmitting(true);
    try {
      const res = await botApiFetch(`/api/phases/${phase.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formData.name,
          phase_order: formData.phase_order,
          bracket_size: formData.bracket_size,
          max_groups: isGroups ? formData.max_groups : undefined,
          settings: formData.settings,
          guildId: guildId,
        }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }
      router.refresh();
      if (shouldRedirect) {
        toast.success(t("feedback.settingsSaved"));
        router.push(`/admin/${guildId}/tournaments/${tournamentId}/structure`);
      } else {
        toast.success(t("feedback.settingsUpdated"));
      }
    } catch (e: unknown) {
      console.error(e);
      const message = getErrorMessage(e);
      toast.error(message ? t("feedback.updateFailed", { message }) : t("feedback.updateFailedNoDetail"));
    } finally {
      setIsSubmitting(false);
    }
  };

  const activeTabClasses = "text-indigo-400 border-b-2 border-indigo-500 font-bold px-6 py-4 outline-none transition-all";
  const inactiveTabClasses = "text-slate-400 hover:text-slate-200 font-medium px-6 py-4 transition-colors outline-none hover:bg-slate-800/20";

  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 shadow-xl max-w-4xl mx-auto overflow-hidden">
      
      {/* Tabs */}
      <div className="flex border-b border-slate-800 bg-slate-900/50">
        <button 
          onClick={() => setActiveTab('general')}
          className={activeTab === 'general' ? activeTabClasses : inactiveTabClasses}
        >
          {t("adminPhaseConfig.generalTab")}
        </button>
        {isGroups && (
          <button 
            onClick={() => setActiveTab('advanced')}
            className={activeTab === 'advanced' ? activeTabClasses : inactiveTabClasses}
          >
            {t("adminPhaseConfig.advancedTab")}
          </button>
        )}
        <button className={inactiveTabClasses + " cursor-not-allowed opacity-40"}>{t("adminPhaseConfig.placementTab")}</button>
        <button className={inactiveTabClasses + " cursor-not-allowed opacity-40"}>{t("adminPhaseConfig.matchSettingsTab")}</button>
      </div>

      <div className="p-6 md:p-8 space-y-8 bg-slate-900/40 min-h-[400px] text-slate-200">
        {/* TAB: GENERAL */}
        {activeTab === 'general' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
            
            {/* Phase Order */}
            <div>
              <label className="block text-sm font-bold text-slate-300 mb-1.5 font-sans">{t("adminPhaseConfig.numberLabel")}</label>
              <input 
                type="number"
                name="phase_order"
                value={formData.phase_order}
                onChange={handleChange}
                className="w-full border border-slate-800 rounded-lg px-3 py-2.5 text-white bg-slate-950 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-medium"
              />
            </div>

            {/* Sizes */}
            <div>
              <label className="block text-sm font-bold text-slate-300 mb-1.5 font-sans">{t("adminPhaseConfig.sizeLabel")} <span className="text-slate-500 font-normal">{t("adminPhaseConfig.recommendedMax", { count: totalTeams })}</span></label>
              <input 
                type="number"
                name="bracket_size"
                value={formData.bracket_size}
                onChange={handleChange}
                min={2}
                className="w-full border border-slate-800 rounded-lg px-3 py-2.5 text-white bg-slate-950 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-medium"
              />
              <p className="text-xs text-slate-500 mt-1.5">
                {isGroups 
                  ? t("adminPhaseConfig.sizeHelpGroups") 
                  : phase.format === "SWISS" 
                    ? t("adminPhaseConfig.sizeHelpSwiss") 
                    : t("adminPhaseConfig.sizeHelpBracket")}
              </p>
            </div>

            {/* Name */}
            <div>
              <label className="block text-sm font-bold text-slate-300 mb-1.5 font-sans">{t("adminPhaseConfig.nameLabel")} <span className="text-slate-500 font-normal">{t("adminPhaseConfig.maxChar")}</span></label>
              <input 
                type="text"
                name="name"
                value={formData.name}
                onChange={handleChange}
                className="w-full border border-slate-800 rounded-lg px-3 py-2.5 text-white bg-slate-950 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-medium"
              />
            </div>

            {/* Number of Groups or 3rd place */}
            {isGroups ? (
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-1.5 font-sans">{t("adminPhaseConfig.groupsCount")}</label>
                <input 
                  type="number"
                  name="max_groups"
                  value={formData.max_groups}
                  onChange={handleChange}
                  className="w-full border border-slate-800 rounded-lg px-3 py-2.5 text-white bg-slate-950 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-medium"
                />
              </div>
            ) : phase.format === "DOUBLE_ELIM" ? (
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-1.5 font-sans">{t("adminPhaseConfig.bracketReset")} <span className="text-slate-500 font-normal">{t("adminPhaseConfig.bracketResetHelp")}</span></label>
                <div className="flex items-center gap-6 mt-3">
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300 font-medium hover:text-white transition-colors">
                    <input 
                      type="radio" 
                      name="settings.bracket_reset" 
                      checked={formData.settings.bracket_reset === true}
                      onChange={() => handleRadioChange('bracket_reset', true)}
                      className="accent-indigo-600 w-4 h-4 cursor-pointer"
                    />
                    {t("common.yes")}
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300 font-medium hover:text-white transition-colors">
                    <input 
                      type="radio" 
                      name="settings.bracket_reset" 
                      checked={formData.settings.bracket_reset === false}
                      onChange={() => handleRadioChange('bracket_reset', false)}
                      className="accent-indigo-600 w-4 h-4 cursor-pointer"
                    />
                    {t("common.no")}
                  </label>
                </div>
              </div>
            ) : phase.format === "SWISS" ? (
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-1.5 font-sans">{t("adminPhaseConfig.swissRounds")}</label>
                <input 
                  type="number"
                  name="settings.swiss_rounds_count"
                  value={formData.settings.swiss_rounds_count ?? 3}
                  onChange={handleChange}
                  min={1}
                  max={12}
                  className="w-full border border-slate-800 rounded-lg px-3 py-2.5 text-white bg-slate-950 focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 transition-all font-medium"
                />
              </div>
            ) : (
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-1.5 font-sans">{t("adminPhaseConfig.thirdPlaceMatch")}</label>
                <div className="flex items-center gap-6 mt-3">
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300 font-medium hover:text-white transition-colors">
                    <input 
                      type="radio" 
                      name="settings.third_place_match" 
                      checked={formData.settings.third_place_match === true}
                      onChange={() => handleRadioChange('third_place_match', true)}
                      className="accent-indigo-600 w-4 h-4 cursor-pointer"
                    />
                    {t("common.yes")}
                  </label>
                  <label className="flex items-center gap-2 cursor-pointer text-slate-300 font-medium hover:text-white transition-colors">
                    <input 
                      type="radio" 
                      name="settings.third_place_match" 
                      checked={formData.settings.third_place_match === false}
                      onChange={() => handleRadioChange('third_place_match', false)}
                      className="accent-indigo-600 w-4 h-4 cursor-pointer"
                    />
                    {t("common.no")}
                  </label>
                </div>
              </div>
            )}
          </div>
        )}

        {/* TAB: ADVANCED (Groups Only) */}
        {activeTab === 'advanced' && isGroups && (
          <div className="space-y-8 animate-in fade-in duration-300">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-6">
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-1.5 font-sans">{t("adminPhaseConfig.groupComposition")}</label>
                <select disabled className="w-full border border-slate-800 rounded-lg px-3 py-2.5 text-slate-500 bg-slate-900/50 cursor-not-allowed font-medium">
                  <option>{t("adminPhaseConfig.balancedEffort")}</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-bold text-slate-300 mb-1.5 font-sans">{t("adminPhaseConfig.pairingMethod")}</label>
                <select disabled className="w-full border border-slate-800 rounded-lg px-3 py-2.5 text-slate-500 bg-slate-900/50 cursor-not-allowed font-medium">
                  <option>Round-robin</option>
                </select>
              </div>
            </div>

            <div>
              <h4 className="text-sm font-bold text-slate-300 mb-3 flex items-center gap-1">{t("adminPhaseConfig.pointAttribution")}</h4>
              
              {/* Point Card */}
              <div className="border border-slate-800 rounded-lg p-5 mb-4 bg-slate-900">
                 <div className="flex items-start gap-3 mb-4">
                   <input type="checkbox" checked readOnly className="mt-1 accent-indigo-600 w-4 h-4 rounded bg-slate-950 border-slate-800" />
                   <div>
                     <span className="font-extrabold text-white text-sm block">{t("adminPhaseConfig.matchResult")}</span>
                     <p className="text-sm text-slate-400 mt-1 leading-relaxed">{t("adminPhaseConfig.matchResultDesc")}</p>
                   </div>
                 </div>
                 <div className="pl-7 grid grid-cols-3 gap-4 max-w-md">
                    <div>
                      <label className="block text-xs font-bold text-slate-400 mb-1">{t("adminPhaseConfig.win")}</label>
                      <input 
                        type="number" 
                        name="settings.points_win" 
                        value={formData.settings.points_win ?? GROUP_POINTS_DEFAULTS.points_win} 
                        onChange={handleChange}
                        onBlur={() => handlePointsBlur("points_win")}
                        className="w-full border border-slate-800 rounded-lg px-3 py-2 text-white bg-slate-950 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none font-medium" 
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-400 mb-1">{t("adminPhaseConfig.draw")}</label>
                      <input 
                        type="number" 
                        name="settings.points_draw" 
                        value={formData.settings.points_draw ?? GROUP_POINTS_DEFAULTS.points_draw} 
                        onChange={handleChange}
                        onBlur={() => handlePointsBlur("points_draw")}
                        className="w-full border border-slate-800 rounded-lg px-3 py-2 text-white bg-slate-950 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none font-medium" 
                      />
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-slate-400 mb-1">{t("adminPhaseConfig.loss")}</label>
                      <input 
                        type="number" 
                        name="settings.points_loss" 
                        value={formData.settings.points_loss ?? GROUP_POINTS_DEFAULTS.points_loss} 
                        onChange={handleChange}
                        onBlur={() => handlePointsBlur("points_loss")}
                        className="w-full border border-slate-800 rounded-lg px-3 py-2 text-white bg-slate-950 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none font-medium" 
                      />
                    </div>
                 </div>
              </div>

              {/* Forfeit Card */}
              <div className="border border-slate-800 rounded-lg p-5 bg-slate-900">
                 <div className="flex items-start gap-3 mb-4">
                   <input type="checkbox" checked readOnly className="mt-1 accent-indigo-600 w-4 h-4 rounded bg-slate-950 border-slate-800" />
                   <div>
                     <span className="font-extrabold text-white text-sm block">{t("adminPhaseConfig.forfeit")}</span>
                     <p className="text-sm text-slate-400 mt-1 leading-relaxed">{t("adminPhaseConfig.forfeitDesc")}</p>
                   </div>
                 </div>
                 <div className="pl-7 max-w-[120px]">
                    <input 
                      type="number" 
                      name="settings.points_forfeit" 
                      value={formData.settings.points_forfeit ?? GROUP_POINTS_DEFAULTS.points_forfeit} 
                      onChange={handleChange}
                      onBlur={() => handlePointsBlur("points_forfeit")}
                      className="w-full border border-slate-800 rounded-lg px-3 py-2 text-white bg-slate-950 focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 focus:outline-none font-medium" 
                    />
                 </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Footer Actions */}
      <div className="bg-slate-950/80 border-t border-slate-800 p-4 flex flex-col sm:flex-row justify-center md:justify-end gap-3">
        <Link 
          href={`/admin/${guildId}/tournaments/${tournamentId}/structure`}
          className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg font-bold text-slate-300 bg-slate-800 hover:bg-slate-700 transition-colors mr-auto w-full sm:w-auto border border-slate-700"
        >
          <ChevronLeft className="w-4 h-4" /> {t("common.back")}
        </Link>
        <button 
          onClick={() => onSubmit(true)}
          disabled={isSubmitting}
          className="flex flex-1 sm:flex-none justify-center items-center gap-2 px-6 py-2.5 rounded-lg font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 transition-all shadow-md disabled:opacity-50"
        >
          {t("adminPhaseConfig.updateAndReturn")}
        </button>
        <button 
          onClick={() => onSubmit(false)}
          disabled={isSubmitting}
          className="flex flex-1 sm:flex-none justify-center items-center gap-2 px-6 py-2.5 rounded-lg font-bold text-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 transition-all shadow-md disabled:opacity-50"
        >
          <CheckCircle2 className="w-4 h-4" /> {t("adminPhaseConfig.update")}
        </button>
      </div>

    </div>
  );
}
