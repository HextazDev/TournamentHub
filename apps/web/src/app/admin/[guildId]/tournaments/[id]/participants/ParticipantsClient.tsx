"use client";

import { useState, useEffect, useRef } from "react";
import { getBotApiUrl, botApiFetch } from '@/utils/api';

import { useRouter } from "next/navigation";
import { CheckCircle2, XCircle, UserPlus, Trash2, Search, Pencil, Sparkles } from "lucide-react";
import { useToast } from "@/context/ToastContext";
import { PromptModal } from "@/components/ui/PromptModal";
import { useTranslation } from "@/i18n/LanguageContext";
import { MAX_FAKE_TEAMS } from "@hub/shared";
import { getErrorMessage, readApiError } from "@/utils/errors";

export function ParticipantsClient({ tournamentId, guildId, initialTeams }: { tournamentId: string; guildId: string; initialTeams: any[] }) {
  const router = useRouter();
  const { toast } = useToast();
  const { t } = useTranslation();
  const [teams, setTeams] = useState(initialTeams);
  const [isAdding, setIsAdding] = useState(false);
  const [newTeamName, setNewTeamName] = useState("");
  const [showFakeModal, setShowFakeModal] = useState(false);
  const [isGeneratingFake, setIsGeneratingFake] = useState(false);

  // Custom Combobox State
  const [members, setMembers] = useState<any[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<any>(null);

  // Add State Variables
  const [editingTeam, setEditingTeam] = useState<any>(null);
  const [editTeamName, setEditTeamName] = useState("");

  const defaultMembers = [
    { ingame_name: "", friend_code: "", is_captain: true },
    { ingame_name: "", friend_code: "", is_captain: false },
    { ingame_name: "", friend_code: "", is_captain: false },
    { ingame_name: "", friend_code: "", is_captain: false },
    { ingame_name: "", friend_code: "", is_captain: false },
    { ingame_name: "", friend_code: "", is_captain: false },
  ];
  const [teamMembers, setTeamMembers] = useState(defaultMembers);

  const [teamToDelete, setTeamToDelete] = useState<any>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!guildId) return;
    if (isAdding && members.length === 0) {
      fetch(`${getBotApiUrl()}/api/discord/members?guildId=${guildId}`)
        .then((res) => res.json())
        .then((data) => {
          if(Array.isArray(data)) setMembers(data);
        })
        .catch((err) => console.error(err));
    }
  }, [isAdding]);

  // Click outside to close dropdown
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsDropdownOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const openAddModal = () => {
    setIsAdding(true);
    setNewTeamName("");
    setSelectedMember(null);
    setSearchTerm("");
    setTeamMembers(JSON.parse(JSON.stringify(defaultMembers)));
  };

  const handleAddTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTeamName.trim() || !selectedMember) return;

    try {
      const validMembers = teamMembers.filter(m => m.ingame_name.trim() || m.friend_code.trim() || m.is_captain);
      const membersPayload = validMembers.map(m => ({
        user_id: m.is_captain ? selectedMember.id : null,
        ingame_name: m.ingame_name.trim(),
        friend_code: m.friend_code.trim(),
        is_captain: m.is_captain
      }));

      const res = await botApiFetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tournament_id: tournamentId,
          guildId,
          name: newTeamName,
          captain_discord_id: selectedMember.id,
          members: membersPayload,
        }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }

      const data = await res.json();
      setTeams([...teams, data]);
      setNewTeamName("");
      setSearchTerm("");
      setSelectedMember(null);
      setIsAdding(false);
      toast.success(t("feedback.teamAdded"));
      if (data.presence_warning === true) toast.warning(t("feedback.teamAddedPresenceWarning"));
      router.refresh();
    } catch (err: unknown) {
      console.error(err);
      toast.error(t("feedback.addTeamFailed", { message: getErrorMessage(err) ?? t("common.unknown") }));
    }
  };

  const handleGenerateFakeTeamsSubmit = async (inputStr: string) => {
    const count = parseInt(inputStr, 10);
    if (isNaN(count) || count < 1 || count > MAX_FAKE_TEAMS) {
      toast.warning(t("feedback.fakeTeamsInvalidCount", { min: 1, max: MAX_FAKE_TEAMS }));
      return;
    }

    setIsGeneratingFake(true);
    try {
      const res = await botApiFetch('/api/teams/generate-fake', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tournament_id: tournamentId, guildId, count }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }

      const newTeams: unknown[] = await res.json();
      setTeams(prev => [...prev, ...newTeams]);
      setShowFakeModal(false);
      // Nombre réellement créé par le bot (qui plafonne à MAX_FAKE_TEAMS), pas le nombre demandé.
      toast.success(t("feedback.fakeTeamsAdded", { count: newTeams.length }));
      router.refresh();
    } catch (err: unknown) {
      console.error(err);
      toast.error(t("feedback.fakeTeamsFailed", { message: getErrorMessage(err) ?? t("common.unknown") }));
    } finally {
      setIsGeneratingFake(false);
    }
  };

  const handleForceCheckIn = async (teamId: string, currentStatus: boolean) => {
    try {
      const res = await botApiFetch(`/api/teams/${teamId}/checkin`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_checked_in: !currentStatus, guildId }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }

      setTeams(teams.map(t => t.id === teamId ? { ...t, is_checked_in: !currentStatus } : t));
      toast.success(!currentStatus ? t("feedback.teamCheckedIn") : t("feedback.teamCheckinCancelled"));
      router.refresh();
    } catch (err: unknown) {
      console.error(err);
      toast.error(t("feedback.updateFailed", { message: getErrorMessage(err) ?? t("common.unknown") }));
    }
  };

  const handleEditTeam = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTeamName.trim() || !selectedMember) return;

    try {
      const validMembers = teamMembers.filter(m => m.ingame_name.trim() || m.friend_code.trim() || m.is_captain);
      const membersPayload = validMembers.map(m => ({
        user_id: m.is_captain ? selectedMember.id : null,
        ingame_name: m.ingame_name.trim(),
        friend_code: m.friend_code.trim(),
        is_captain: m.is_captain
      }));

      const res = await botApiFetch(`/api/teams/${editingTeam.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editTeamName,
          captain_discord_id: selectedMember.id,
          guildId,
          members: membersPayload,
        }),
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }

      const data = await res.json();
      setTeams(teams.map(t => t.id === editingTeam.id ? { ...t, name: editTeamName, captain_discord_id: selectedMember.id, team_members: data.team_members || [] } : t));
      setEditingTeam(null);
      setEditTeamName("");
      setSelectedMember(null);
      setSearchTerm("");
      toast.success(t("feedback.teamUpdated"));
      router.refresh();
    } catch (err: unknown) {
      console.error(err);
      toast.error(t("feedback.editTeamFailed", { message: getErrorMessage(err) ?? t("common.unknown") }));
    }
  };

  const handleDeleteTeam = async () => {
    if (!teamToDelete) return;
    try {
      const res = await botApiFetch(`/api/teams/${teamToDelete.id}?guildId=${guildId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error((await readApiError(res)) ?? t("common.unknown"));
      }

      setTeams(teams.filter(t => t.id !== teamToDelete.id));
      setTeamToDelete(null);
      toast.success(t("feedback.teamDeleted"));
      router.refresh();
    } catch (err: unknown) {
      console.error(err);
      toast.error(t("feedback.deleteTeamFailed", { message: getErrorMessage(err) ?? t("common.unknown") }));
    }
  };

  const openEditModal = (team: any) => {
    setEditingTeam(team);
    setEditTeamName(team.name);
    // Dummy member fallback
    const member = members.find(m => m.id === team.captain_discord_id) || { id: team.captain_discord_id, displayName: "Chargement (ID: " + team.captain_discord_id + ")" };
    setSelectedMember(member);
    setSearchTerm(member.displayName);
    setIsDropdownOpen(false);

    const existingMembers = [...(team.team_members || [])].sort((a: any, b: any) =>
      (a.is_captain === b.is_captain) ? 0 : a.is_captain ? -1 : 1
    );

    const editMembers = JSON.parse(JSON.stringify(defaultMembers)).map((def: any, idx: number) => {
      if (existingMembers[idx]) {
        return {
          id: existingMembers[idx].id,
          user_id: existingMembers[idx].user_id,
          ingame_name: existingMembers[idx].ingame_name || "",
          friend_code: existingMembers[idx].friend_code || "",
          is_captain: existingMembers[idx].is_captain,
        };
      }
      return def;
    });
    // Force captain logic
    editMembers[0].is_captain = true;
    for(let i=1; i<6; i++) editMembers[i].is_captain = false;
    setTeamMembers(editMembers);

    if (!guildId) return;
    if (members.length === 0) {
      fetch(`${getBotApiUrl()}/api/discord/members?guildId=${guildId}`)
        .then((res) => res.json())
        .then((data) => {
          if(Array.isArray(data)) {
            setMembers(data);
            const found = data.find(m => m.id === team.captain_discord_id);
            if(found) {
              setSelectedMember(found);
              setSearchTerm(found.displayName);
            }
          }
        })
        .catch((err) => console.error(err));
    }
  };

  const filteredMembers = members.filter(m =>
    m.displayName?.toLowerCase().includes(searchTerm.toLowerCase()) ||
    m.username?.toLowerCase().includes(searchTerm.toLowerCase())
  ).slice(0, 50); // limit preview amount

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center bg-slate-800/50 p-4 rounded-xl border border-slate-700/50">
        <h2 className="text-xl font-bold text-white flex items-center gap-2">
          {t("adminParticipants.title")}
          <span className="text-sm font-normal px-2.5 py-0.5 rounded-full bg-slate-700 text-slate-300">
            {t("adminParticipants.registeredCount", { count: teams.length })}
          </span>
        </h2>
        <div className="flex gap-2">
          <button
            onClick={openAddModal}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg font-bold transition-colors shadow-lg shadow-blue-500/20"
          >
            <UserPlus className="w-4 h-4" />
            {t("adminParticipants.addManual")}
          </button>

          <button
            onClick={() => setShowFakeModal(true)}
            className="flex items-center gap-2 bg-yellow-600 hover:bg-yellow-700 text-white px-4 py-2 rounded-lg font-bold transition-colors shadow-lg shadow-yellow-500/20 cursor-pointer"
          >
            <Sparkles className="w-4 h-4" />
            {t("adminParticipants.generateFake")}
          </button>
        </div>
      </div>

      {isAdding && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto shadow-2xl border border-slate-700 custom-scrollbar">
            <div className="bg-slate-900 border-b border-slate-700 p-4">
              <h3 className="text-xl font-bold text-white">{t("adminParticipants.addTeamModal")}</h3>
            </div>

            <form onSubmit={handleAddTeam} className="p-6 space-y-6">
              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-semibold text-slate-400">{t("adminParticipants.teamName")}</label>
                  <input
                    type="text"
                    placeholder={t("adminParticipants.teamNamePlaceholder")}
                    className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                    value={newTeamName}
                    onChange={(e) => setNewTeamName(e.target.value)}
                    required
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-semibold text-slate-400">{t("adminParticipants.captainDiscord")}</label>
                  <div className="relative" ref={dropdownRef}>
                    <div className="relative">
                      <Search className="w-5 h-5 absolute left-3 top-3.5 text-slate-400" />
                      <input
                        type="text"
                        placeholder={t("adminParticipants.searchCaptainPlaceholder")}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-10 pr-4 py-3 text-white focus:outline-none focus:border-blue-500"
                        value={selectedMember ? selectedMember.displayName : searchTerm}
                        onChange={(e) => {
                          setSearchTerm(e.target.value);
                          setSelectedMember(null);
                          setIsDropdownOpen(true);
                        }}
                        onFocus={() => setIsDropdownOpen(true)}
                        required={!selectedMember}
                      />
                    </div>

                    {isDropdownOpen && !selectedMember && (
                      <div className="absolute top-14 left-0 w-full bg-slate-800 border border-slate-700 rounded-lg mt-1 max-h-60 overflow-y-auto z-50 shadow-xl overscroll-auto custom-scrollbar">
                        {members.length === 0 ? (
                          <div className="p-3 text-sm text-slate-400 text-center">{t("adminParticipants.loadingMembers")}</div>
                        ) : filteredMembers.length === 0 ? (
                          <div className="p-3 text-sm text-slate-400 text-center">{t("adminParticipants.noMembersFound")}</div>
                        ) : (
                          filteredMembers.map(member => (
                            <div
                              key={member.id}
                              className="px-4 py-3 hover:bg-slate-700 cursor-pointer flex flex-col transition-colors border-b border-slate-700/50 last:border-0"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSelectedMember(member);
                                setSearchTerm(member.displayName);
                                setIsDropdownOpen(false);
                              }}
                            >
                              <span className="text-white font-medium">{member.displayName}</span>
                              <span className="text-xs text-slate-400">@{member.username}</span>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="pt-4 space-y-4">
                  <h4 className="text-sm font-semibold text-slate-300 border-b border-slate-700 pb-2">{t("adminParticipants.teamMembers")}</h4>
                  {teamMembers.map((member, idx) => (
                    <div key={idx} className="flex flex-col sm:flex-row gap-3">
                      <div className="flex-1">
                        <input
                          type="text"
                          placeholder={`Pseudo In-game (Joueur ${idx + 1}${idx === 0 ? " - Cap" : idx >= 4 ? " - Optionnel" : ""})`}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                          value={member.ingame_name}
                          required={member.friend_code.trim().length > 0}
                          onChange={(e) => {
                            const newMembers = [...teamMembers];
                            newMembers[idx].ingame_name = e.target.value;
                            setTeamMembers(newMembers);
                          }}
                        />
                      </div>
                      <div className="flex-1">
                        <input
                          type="text"
                          placeholder={`Code Ami (ex: SW-...)${idx >= 4 ? " - Optionnel" : ""}`}
                          className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                          value={member.friend_code}
                          required={member.ingame_name.trim().length > 0}
                          onChange={(e) => {
                            const newMembers = [...teamMembers];
                            newMembers[idx].friend_code = e.target.value;
                            setTeamMembers(newMembers);
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 justify-end pt-4 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-5 py-2.5 rounded-lg font-bold text-slate-300 hover:bg-slate-700 transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!selectedMember || !newTeamName}
                  className="bg-green-600 hover:bg-green-700 text-white px-5 py-2.5 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t("common.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      <div className="bg-slate-800 rounded-xl border border-slate-700 overflow-hidden shadow-lg">
        <table className="w-full text-left">
          <thead className="bg-slate-900/80 text-slate-400 text-sm border-b border-slate-700">
            <tr>
              <th className="px-6 py-4 font-medium uppercase tracking-wider">{t("adminParticipants.teamName")}</th>
              <th className="px-6 py-4 font-medium uppercase tracking-wider">{t("adminParticipants.teamMembers")}</th>
              <th className="px-6 py-4 font-medium uppercase tracking-wider">{t("adminParticipants.checkinStatus")}</th>
              <th className="px-6 py-4 font-medium uppercase tracking-wider text-right">{t("adminParticipants.actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-700/50">
            {teams.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-6 py-12 text-center text-slate-500">
                  <div className="flex flex-col items-center gap-2">
                    <UserPlus className="w-8 h-8 opacity-50 mb-2" />
                    <span>{t("adminParticipants.noTeamsYet")}</span>
                  </div>
                </td>
              </tr>
            ) : (
              teams.map(team => (
                <tr key={team.id} className="hover:bg-slate-700/30 transition-colors group">
                  <td className="px-6 py-4 font-bold text-white flex flex-col gap-1">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-lg bg-slate-700 border border-slate-600 flex items-center justify-center text-xs text-slate-400">
                        {team.name.substring(0, 2).toUpperCase()}
                      </div>
                      {team.name}
                    </div>
                    <span className="text-xs text-slate-500 font-normal ml-11">Capt ID: {team.captain_discord_id}</span>
                  </td>
                  <td className="px-6 py-4 text-slate-300">
                    {team.team_members && team.team_members.length > 0 ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-sm border border-slate-600 bg-slate-800 px-2 py-1 rounded text-slate-300 w-max">{t("adminParticipants.playerCount", { count: team.team_members.length })}</span>
                        <div className="text-xs text-slate-400 max-w-[200px] truncate" title={team.team_members.map((m: any) => m.ingame_name || `(Joueur)`).join(', ')}>
                          {team.team_members.map((m: any) => m.ingame_name || `(Joueur)`).join(', ')}
                        </div>
                      </div>
                    ) : (
                      <span className="text-sm bg-purple-500/10 text-purple-400 px-2 py-1 rounded border border-purple-500/20">{t("adminParticipants.externalAdmin")}</span>
                    )}
                  </td>
                  <td className="px-6 py-4">
                    {team.is_checked_in ? (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-green-500/20 text-green-400 border border-green-500/20">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {t("adminParticipants.checkedIn")}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold bg-slate-700/50 text-slate-400 border border-slate-700">
                        <XCircle className="w-3.5 h-3.5" />
                        {t("adminParticipants.pending")}
                      </span>
                    )}
                  </td>
                  <td className="px-6 py-4 text-right">
                    <div className="flex items-center justify-end gap-3 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
                      <button
                        onClick={() => handleForceCheckIn(team.id, team.is_checked_in)}
                        className={`text-xs px-3 py-1.5 rounded-lg font-bold transition-all ${
                          team.is_checked_in
                            ? "bg-orange-500/10 hover:bg-orange-500/20 text-orange-400 border border-orange-500/20"
                            : "bg-blue-500/10 hover:bg-blue-500/20 text-blue-400 border border-blue-500/20"
                        }`}
                      >
                        {team.is_checked_in ? t("adminParticipants.cancelCheckin") : t("adminParticipants.forceCheckin")}
                      </button>
                      <div className="flex bg-slate-700/50 rounded-lg overflow-hidden border border-slate-600">
                        <button
                          onClick={() => openEditModal(team)}
                          className="p-2 hover:bg-blue-500/20 text-slate-300 hover:text-blue-400 transition-colors"
                          title={t("adminParticipants.editTeamTitle")}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                        <div className="w-px bg-slate-600"></div>
                        <button
                          onClick={() => setTeamToDelete(team)}
                          className="p-2 hover:bg-red-500/20 text-slate-300 hover:text-red-400 transition-colors"
                          title={t("adminParticipants.deleteTeamTitle")}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {editingTeam && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl border border-slate-700">
            <div className="bg-slate-900 border-b border-slate-700 p-4">
              <h3 className="text-xl font-bold text-white">{t("adminParticipants.editTeamModal")}</h3>
            </div>

            <form onSubmit={handleEditTeam} className="p-6 space-y-6">
              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-400">{t("adminParticipants.teamName")}</label>
                <input
                  type="text"
                  placeholder={t("adminParticipants.teamNamePlaceholder")}
                  className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white focus:outline-none focus:border-blue-500"
                  value={editTeamName}
                  onChange={(e) => setEditTeamName(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-2">
                <label className="text-sm font-semibold text-slate-400">{t("adminParticipants.captainDiscord")}</label>
                <div className="relative" ref={dropdownRef}>
                  <div className="relative">
                    <Search className="w-5 h-5 absolute left-3 top-3.5 text-slate-400" />
                    <input
                      type="text"
                      placeholder={t("adminParticipants.searchCaptainPlaceholder")}
                      className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-10 pr-4 py-3 text-white focus:outline-none focus:border-blue-500"
                      value={selectedMember ? selectedMember.displayName : searchTerm}
                      onChange={(e) => {
                        setSearchTerm(e.target.value);
                        setSelectedMember(null);
                        setIsDropdownOpen(true);
                      }}
                      onFocus={() => setIsDropdownOpen(true)}
                      required={!selectedMember}
                    />
                  </div>

                  {isDropdownOpen && !selectedMember && (
                    <div className="absolute top-14 left-0 w-full bg-slate-800 border border-slate-700 rounded-lg mt-1 max-h-60 overflow-y-auto z-50 shadow-xl overscroll-auto custom-scrollbar">
                      {members.length === 0 ? (
                        <div className="p-3 text-sm text-slate-400 text-center">{t("adminParticipants.loadingMembers")}</div>
                      ) : filteredMembers.length === 0 ? (
                        <div className="p-3 text-sm text-slate-400 text-center">{t("adminParticipants.noMembersFound")}</div>
                      ) : (
                        filteredMembers.map(member => (
                          <div
                            key={member.id}
                            className="px-4 py-3 hover:bg-slate-700 cursor-pointer flex flex-col transition-colors border-b border-slate-700/50 last:border-0"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedMember(member);
                              setSearchTerm(member.displayName);
                              setIsDropdownOpen(false);
                            }}
                          >
                            <span className="text-white font-medium">{member.displayName}</span>
                            <span className="text-xs text-slate-400">@{member.username}</span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              </div>

              <div className="pt-4 space-y-4">
                <h4 className="text-sm font-semibold text-slate-300 border-b border-slate-700 pb-2">{t("adminParticipants.teamMembers")}</h4>
                {teamMembers.map((member, idx) => (
                  <div key={idx} className="flex flex-col sm:flex-row gap-3">
                    <div className="flex-1">
                      <input
                        type="text"
                        placeholder={`Pseudo In-game (Joueur ${idx + 1}${idx === 0 ? " - Cap" : idx >= 4 ? " - Optionnel" : ""})`}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                        value={member.ingame_name}
                        required={member.friend_code.trim().length > 0}
                        onChange={(e) => {
                          const newMembers = [...teamMembers];
                          newMembers[idx].ingame_name = e.target.value;
                          setTeamMembers(newMembers);
                        }}
                      />
                    </div>
                    <div className="flex-1">
                      <input
                        type="text"
                        placeholder={`Code Ami (ex: SW-...)${idx >= 4 ? " - Optionnel" : ""}`}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-2 text-sm text-white focus:outline-none focus:border-blue-500"
                        value={member.friend_code}
                        required={member.ingame_name.trim().length > 0}
                        onChange={(e) => {
                          const newMembers = [...teamMembers];
                          newMembers[idx].friend_code = e.target.value;
                          setTeamMembers(newMembers);
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>

              <div className="flex gap-3 justify-end pt-4 border-t border-slate-700">
                <button
                  type="button"
                  onClick={() => {
                    setEditingTeam(null);
                    setSelectedMember(null);
                    setSearchTerm("");
                  }}
                  className="px-5 py-2.5 rounded-lg font-bold text-slate-300 hover:bg-slate-700 transition-colors"
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="submit"
                  disabled={!selectedMember || !editTeamName}
                  className="bg-blue-600 hover:bg-blue-700 text-white px-5 py-2.5 rounded-lg font-bold disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {t("common.save")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {teamToDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
          <div className="bg-slate-800 rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl border border-red-500/30">
            <div className="p-6 text-center space-y-4">
              <div className="w-16 h-16 bg-red-500/10 rounded-full flex items-center justify-center mx-auto mb-4 border border-red-500/20">
                <Trash2 className="w-8 h-8 text-red-500" />
              </div>
              <h3 className="text-xl font-bold text-white">{t("adminParticipants.deleteTeamModal")}</h3>
              <p className="text-sm text-slate-300">
                {t("adminParticipants.deleteConfirmText", { name: teamToDelete.name })}
                <br/>
                <span className="text-red-400 block mt-2 text-xs uppercase tracking-wider font-bold">{t("adminParticipants.irreversible")}</span>
              </p>
            </div>

            <div className="flex gap-2 p-4 bg-slate-900/50">
              <button
                onClick={() => setTeamToDelete(null)}
                className="flex-1 px-4 py-3 rounded-xl font-bold text-slate-300 hover:bg-slate-700 transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleDeleteTeam}
                className="flex-1 px-4 py-3 rounded-xl font-bold bg-red-600 hover:bg-red-700 text-white transition-colors flex items-center justify-center gap-2"
              >
                <Trash2 className="w-4 h-4" />
                {t("common.delete")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal Génération Fake Teams */}
      <PromptModal
        isOpen={showFakeModal}
        onClose={() => setShowFakeModal(false)}
        onSubmit={handleGenerateFakeTeamsSubmit}
        title={t("adminParticipants.fakeTeamsTitle")}
        description={t("feedback.fakeTeamsPrompt")}
        defaultValue="8"
        inputType="number"
        min={1}
        max={MAX_FAKE_TEAMS}
        placeholder={t("adminParticipants.fakeTeamsPlaceholder")}
        confirmText={t("adminParticipants.fakeTeamsConfirm")}
        isLoading={isGeneratingFake}
      />
    </div>
  );
}
