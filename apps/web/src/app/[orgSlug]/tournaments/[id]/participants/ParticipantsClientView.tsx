"use client";

import { useState } from "react";
import { Users, User, X } from "lucide-react";
import { useTranslation } from "@/i18n/LanguageContext";

type Team = any;

export function ParticipantsClientView({ teams }: { teams: Team[] }) {
  const { t } = useTranslation();
  const [selectedTeam, setSelectedTeam] = useState<Team | null>(null);

  const handleClose = () => setSelectedTeam(null);

  return (
    <div className="space-y-6">
      <div className="text-slate-300 font-bold mb-4 border-b border-slate-800 pb-2">
        {t("participants.sizeTeams", { count: teams.length })}
      </div>

      {teams.length === 0 ? (
        <div className="py-12 bg-[#151722] rounded-xl border border-slate-800/50 flex flex-col items-center justify-center text-slate-500">
          <p>{t("participants.noValidated")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {teams.map((team) => (
            <div 
              key={team.id} 
              onClick={() => setSelectedTeam(team)}
              className="bg-[#151722] p-4 rounded border border-slate-800 hover:border-slate-600 transition-colors flex items-center gap-4 cursor-pointer group shadow-sm"
            >
              <div className="w-12 h-12 bg-slate-800 rounded flex items-center justify-center shrink-0 group-hover:bg-slate-700 transition-colors">
                 <Users className="w-6 h-6 text-slate-500" />
              </div>
              <div className="overflow-hidden">
                <h3 className="font-bold text-slate-200 truncate pr-2 group-hover:text-blue-400 transition-colors">{team.name}</h3>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal / Dialog for Team Detail */}
      {selectedTeam && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6 animate-in fade-in" style={{ backgroundColor: 'rgba(0,0,0,0.7)' }}>
          <div className="bg-[#0f111a] border border-slate-800 w-full max-w-2xl rounded-xl shadow-2xl flex flex-col overflow-hidden relative animate-in zoom-in-95 duration-200">
            {/* Modal Header inside the banner */}
            <div className="h-32 bg-slate-800 relative flex justify-end p-4">
               <button 
                 onClick={handleClose}
                 className="absolute top-4 right-4 p-2 bg-black/40 hover:bg-black/60 rounded-full text-white transition-colors"
               >
                 <X className="w-5 h-5" />
               </button>
            </div>
            
            {/* Profile Info Overlay */}
            <div className="px-6 relative -mt-10">
              <div className="flex flex-col sm:flex-row items-center sm:items-end sm:space-x-6">
                <div className="w-20 h-20 bg-slate-900 border-4 border-[#0f111a] rounded flex items-center justify-center shrink-0">
                   <Users className="w-10 h-10 text-slate-500" />
                </div>
                <div className="mt-3 sm:mt-0 pb-1 flex-grow text-center sm:text-left">
                  <p className="text-xs text-slate-400 font-bold uppercase tracking-wider">{t("participants.team")}</p>
                  <h2 className="text-3xl font-extrabold text-white">{selectedTeam.name}</h2>
                </div>
              </div>
            </div>

            {/* Modal Tabs */}
            <div className="px-6 mt-6 border-b border-slate-800 flex gap-4">
               <button className="pb-3 text-sm font-semibold border-b-2 border-blue-500 text-blue-400">
                 {t("participants.about")}
               </button>
               {/* Disabled Activity tab for aesthetic purposes until match linking */}
               <button className="pb-3 text-sm font-semibold border-b-2 border-transparent text-slate-500 cursor-not-allowed">
                 {t("participants.activity")}
               </button>
            </div>

            {/* Modal Content */}
            <div className="p-6 bg-[#151722] min-h-[250px] overflow-y-auto">
               <h3 className="text-lg font-bold text-slate-300 mb-4">{t("participants.lineup")}</h3>
               
               <div className="space-y-2">
                 {selectedTeam.members && Array.isArray(selectedTeam.members) && selectedTeam.members.length > 0 ? (
                   selectedTeam.members.map((member: any, index: number) => (
                     <div key={index} className="bg-slate-900 border border-slate-800 p-4 rounded flex items-center gap-3">
                       <User className="w-5 h-5 text-slate-500" />
                       <span className="text-slate-300 font-medium">
                         {typeof member === 'string' ? member : (member.name || member.id || t("participants.playerNumber", { number: index + 1 }))}
                       </span>
                     </div>
                   ))
                 ) : (
                   <div className="bg-slate-900 border border-slate-800 p-4 rounded text-center text-slate-500">
                     <p>{t("participants.noMembers")}</p>
                   </div>
                 )}
               </div>
            </div>
          </div>
          
          {/* Backdrop click closer */}
          <div className="fixed inset-0 z-[-1]" onClick={handleClose}></div>
        </div>
      )}
    </div>
  );
}