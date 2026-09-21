"use client";
import React, { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { ArrowLeft, BookOpen, LogOut, Bug, Map as MapIcon, MessageCircle, Save, Send, Palette, MoreHorizontal, X } from "lucide-react";
import type { MapWorld, GameSave, NodeInteraction, EventScene, EventChoice, StreamMessage, Declaration } from "@/lib/map-types";
import {
  saveGame,
  loadWorldTheme,
  saveWorldTheme,
  type WorldTheme,
  loadAdventureInteractionConfig,
} from "@/lib/map-storage";
import { ADVENTURE_THEMES } from "./map-text-stream";
import { loadCharacters } from "@/lib/character-storage";
import { loadApiConfigs, loadBindingConfig, resolveBinding, resolveUserIdentity, resolveAuxiliaryApiConfig } from "@/lib/settings-storage";
import { expandEvent, companionDeclare, resolveRound, rollD100, resolveCheckStat, ROLL_LABELS, formatGameTime, advanceTime, pickEncounter, shouldTriggerEncounter, setDMDebugCallback, shouldAutoSummarize, generateAdventureSummary, generateEnding, generateAfterTalk, type EndingResult, DEFAULT_DM_ENDING_PROMPT } from "@/lib/map-rpg-engine";
import { skillCheckValue, resolveAttack, rollExpr, dbFromStats, findWeaponMention, LEVEL_LABEL, sanityLossVerdict, rollTemporaryMadness, buildInitiative, makeHostile, canSpendLuck, rollD100WithDice, SKILL_BASE_6, SKILL_BASE_7, type RollLevel, type HostileCombatant } from "@/lib/coc-sheet";
import { STAT_LABELS, ALL_STATS, type StageAsset } from "@/lib/map-types";
import { getAssetUrl, buildAssetManifest, registerAssetFiles, deleteAssetBlob } from "@/lib/stage-assets";
import { importInvestigator } from "@/lib/investigator-import";
import { saveMapWorld } from "@/lib/map-storage";
import MapRenderer from "./map-renderer";
import MapTextStream from "./map-text-stream";

type Props = {
  world: MapWorld;
  save: GameSave;
  onSaveUpdate: (save: GameSave) => void;
  onBack: () => void;
};

export default function MapView({ world, save, onSaveUpdate, onBack }: Props) {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [showJournal, setShowJournal] = useState(false);
  const [activeEvent, setActiveEvent] = useState<EventScene | null>(null);
  const [eventLoading, setEventLoading] = useState(false);
  const [activeEventMeta, setActiveEventMeta] = useState<{ type: string; questId?: string } | null>(save.pendingEvent?.eventMeta || null);
  const [eventContext, setEventContext] = useState(save.pendingEvent?.eventContext || "");
  const [eventContinueLoading, setEventContinueLoading] = useState(false);
  const [loadingPhase, setLoadingPhase_] = useState<"" | "companions" | "dm">("");
  const loadingPhaseRef = useRef(loadingPhase);
  const setLoadingPhase = useCallback((v: "" | "companions" | "dm") => { loadingPhaseRef.current = v; setLoadingPhase_(v); }, []);
  const [accumulatedEvent, setAccumulatedEvent] = useState<EventScene | null>(null);
  // showContacts removed — contacts now in tool panel
  const [showArchiveConfirm, setShowArchiveConfirm] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [debugLog, setDebugLog] = useState<{ time: string; type: string; content: string }[]>([]);
  const [debugFilter, setDebugFilter] = useState<"current" | "dm" | "char" | "all">("current");
  const [worldEvents, setWorldEvents] = useState<string[]>([]);
  const [showWorldEvents, setShowWorldEvents] = useState(false);
  const [showDeathDialog, setShowDeathDialog] = useState(false);
  const [endingData, setEndingData] = useState<EndingResult | null>(null);
  const [endingStep, setEndingStep] = useState(0);  // 0..paragraphs.length = paragraphs, +1 = closing, +2 = fireworks
  const [showFireworks, setShowFireworks] = useState(false);

  // New text-centric states
  const [streamMessages, setStreamMessages] = useState<StreamMessage[]>(save.streamLog || []);
  const [showToolPanel, setShowToolPanel] = useState(false);
  const [toolTab, setToolTab] = useState<"map" | "contacts" | "bag" | "clues">("map");
  const [inEvent, setInEvent] = useState(save.pendingEvent?.inEvent || false);
  const [currentChoices, setCurrentChoices] = useState<EventChoice[] | null>(save.pendingEvent?.choices || null);
  const [freeText, setFreeText] = useState("");
  const [freeAction, setFreeAction] = useState("");
  // Fork: player-chosen check skill for the current declaration
  const [checkSkill, setCheckSkill] = useState("");
  // Fork 八期B: private-talk toggle — when on, the declaration goes through the locked pipeline
  const [privateTalk, setPrivateTalk] = useState(false);
  const [privateTalkNpc, setPrivateTalkNpc] = useState("");
  // Fork: bottom-left ➕ menu (combat / skill check / private talk / dice mode)
  const [plusMenuOpen, setPlusMenuOpen] = useState(false);
  // Fork: skill-picker sheet (full skill list from the player's sheet — no more typos)
  const [skillPickerOpen, setSkillPickerOpen] = useState(false);
  // Fork: HO assignment modal — player picks own line first, KP assigns the rest by persona fit
  const [hoAssignOpen, setHoAssignOpen] = useState(false);
  const [hoAssignMap, setHoAssignMap] = useState<Record<string, string>>({});   // characterId|"__player__" → ho
  const [hoAssignLoading, setHoAssignLoading] = useState(false);
  // Fork: OOC (皮下吐槽) — story-neutral out-of-character chat (folded panel above the stream)
  const [oocMode, setOocMode] = useState(false);
  const [showOocPanel, setShowOocPanel] = useState(false);
  const [oocReplying, setOocReplying] = useState(false);
  // Fork: 后日谈 lines rendered inside the ending card
  const [afterTalk, setAfterTalk] = useState<{ speaker: string; text: string }[]>([]);
  const [afterTalkLoading, setAfterTalkLoading] = useState(false);
  const oocPanelRef = useRef<HTMLDivElement>(null);
  // Fork 十二期: player persona review modal (first world entry)
  const [personaReview, setPersonaReview] = useState<GameSave["myPersona"]>(save.myPersona && !save.myPersona.confirmed ? save.myPersona : null);
  // Fork 十期: stage cues — CG overlay + BGM player
  const [cgOverlay, setCgOverlay] = useState<{ name: string; url: string } | null>(null);
  const [currentBgm, setCurrentBgm] = useState<string>("");
  const bgmAudioRef = useRef<HTMLAudioElement | null>(null);
  const bgmNameRef = useRef("");
  const [showAssetPanel, setShowAssetPanel] = useState(false);
  const [currentHints, setCurrentHints] = useState<{ label: string; skillHint?: string }[] | null>(save.pendingEvent?.hints || null);
  // Fork: NPC talk topics from KP (tappable → fills speech input)
  const [currentTopics, setCurrentTopics] = useState<{ label: string; skillHint?: string }[] | null>(null);
  const [diceOverlay, setDiceOverlay] = useState<{ name: string; stat: string; statValue: number; context: string; label: string; isPlayer: boolean } | null>(null);
  const [diceRolling, setDiceRolling] = useState(false);
  const [diceNumber, setDiceNumber] = useState(0);
  const [diceWaitingClick, setDiceWaitingClick] = useState(false);
  const diceResolveRef = useRef<((r: { roll: number; level: string }) => void) | null>(null);
  const [pickerOverlay, setPickerOverlay] = useState<{ candidates: string[]; current: string; chosen: string; settled: boolean } | null>(null);
  const [lastFailedEvent, setLastFailedEvent] = useState<{ type: string; brief: string; meta?: { questId?: string; npcName?: string; npcPersonality?: string } } | null>(null);
  const [lastFailedAction, setLastFailedAction] = useState<string | null>(save.pendingEvent?.lastAction || null);
  const [completedCompanions, setCompletedCompanions] = useState<string[]>(save.pendingEvent?.completedCompanions || []);
  const completedCompanionsRef = useRef(completedCompanions);
  completedCompanionsRef.current = completedCompanions;
  const [freeMode, setFreeMode] = useState(false);
  // CoC6 combat round (fork)
  const [combatOpen, setCombatOpen] = useState(false);
  const [combatInput, setCombatInput] = useState<{ name: string; dex: string; hp: string }>({ name: "", dex: "", hp: "" });
  const [combatQueue, setCombatQueue] = useState<{ name: string; dex: number; hp: number; maxHp: number; notes?: string }[]>([]);
  const showCombat = !!save.combat && !save.combat.ended;
  const combatCurrentToken = save.combat && !save.combat.ended ? save.combat.initiative[save.combat.currentIndex] : null;
  const tokenLabel = (token: string): string => {
    if (token === "player") return userIdentity?.name || "你";
    if (token.startsWith("comp:")) {
      const ch = characters.find(c => c.id === token.slice(5));
      return ch?.name || token.slice(5);
    }
    return token.slice(9); // hostile:
  };
  const [showSaveConfirm, setShowSaveConfirm] = useState(false);
  const [freeModeReplying, setFreeModeReplying] = useState(false);
  const [worldTheme, setWorldTheme] = useState<WorldTheme>(() => loadWorldTheme(world.id));
  const [adventureConfig, setAdventureConfig] = useState(() => loadAdventureInteractionConfig());
  const [showThemePanel, setShowThemePanel] = useState(false);
  const [showTopActionMenu, setShowTopActionMenu] = useState(false);
  const [showEventActionDrawer, setShowEventActionDrawer] = useState(false);
  const [customFontFamily, setCustomFontFamily] = useState<string | undefined>(undefined);
  const inputRef = useRef<HTMLInputElement>(null);
  const endingScrollRef = useRef<HTMLDivElement>(null);

  // Auto-scroll ending overlay when step changes (or after-talk lines arrive)
  useEffect(() => {
    if (endingScrollRef.current) {
      endingScrollRef.current.scrollTop = endingScrollRef.current.scrollHeight;
    }
  }, [endingStep, afterTalkLoading, afterTalk]);

  // Fork: keep the OOC panel pinned to the newest line
  React.useEffect(() => {
    if (oocPanelRef.current && showOocPanel) {
      oocPanelRef.current.scrollTop = oocPanelRef.current.scrollHeight;
    }
  }, [streamMessages, showOocPanel]);

  // Stream message helpers
  const nextMsgId = useRef(0);
  const mkId = () => `sm_${Date.now()}_${nextMsgId.current++}`;
  const streamRef = useRef(streamMessages);
  streamRef.current = streamMessages;
  const pushMessages = useCallback((...msgs: StreamMessage[]) => {
    setStreamMessages(prev => [...prev, ...msgs]);
  }, []);

  // Refs for event state (used by persistSave to avoid stale closures)
  const inEventRef = useRef(inEvent);
  inEventRef.current = inEvent;
  const currentChoicesRef = useRef(currentChoices);
  currentChoicesRef.current = currentChoices;
  const eventContextRef = useRef(eventContext);
  eventContextRef.current = eventContext;
  const activeEventMetaRef = useRef(activeEventMeta);
  activeEventMetaRef.current = activeEventMeta;
  const lastFailedActionRef = useRef(lastFailedAction);
  lastFailedActionRef.current = lastFailedAction;
  const saveRef = useRef(save);
  React.useEffect(() => {
    saveRef.current = save;
  }, [save]);

  // Unified save: always injects streamLog + pendingEvent from refs
  const persistSave = useCallback((newSave: GameSave) => {
    const withExtra: GameSave = {
      ...newSave,
      lockedLog: lockedLogRef.current.length > 0 ? lockedLogRef.current : newSave.lockedLog,
      streamLog: streamRef.current.slice(-200),
      pendingEvent: inEventRef.current ? {
        inEvent: true,
        choices: currentChoicesRef.current || undefined,
        eventContext: eventContextRef.current || undefined,
        eventMeta: activeEventMetaRef.current || undefined,
        lastAction: lastFailedActionRef.current || undefined,
        interruptedPhase: loadingPhaseRef.current || undefined,
        completedCompanions: completedCompanionsRef.current.length > 0 ? completedCompanionsRef.current : undefined,
      } : undefined,
    };
    saveRef.current = withExtra;
    saveGame(withExtra);
    onSaveUpdate(withExtra);
  }, [onSaveUpdate]);

  // Inject custom font via FontFace API (avoids CSS string length / quoting issues with data URLs)
  React.useEffect(() => {
    if (!worldTheme.customFont) { setCustomFontFamily(undefined); return; }
    const fontName = `CustomAdv_${world.id.slice(0, 8)}`;
    let cancelled = false;
    const face = new FontFace(fontName, `url("${worldTheme.customFont}")`);
    face.load().then(loaded => {
      if (cancelled) return;
      document.fonts.add(loaded);
      setCustomFontFamily(`'${fontName}', 'PingFang SC', system-ui, sans-serif`);
    }).catch(err => {
      console.warn("Custom font load failed:", err);
      if (!cancelled) setCustomFontFamily(undefined);
    });
    return () => { cancelled = true; try { document.fonts.delete(face); } catch { } };
  }, [worldTheme.customFont, world.id]);

  // Persist immediately on every stream change
  React.useEffect(() => {
    if (streamMessages.length === 0) return;
    persistSave(saveRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [streamMessages]);

  // Connect debug callback
  React.useEffect(() => {
    setDMDebugCallback((type, content) => {
      const time = new Date().toLocaleTimeString();
      setDebugLog(prev => [...prev.slice(-50), { time, type, content }]);
    });
    return () => setDMDebugCallback(null);
  }, []);

  const { renderedMap, skeleton } = world;
  // Fork: rules edition — 7th edition worlds get difficulty tiers / bonus-penalty dice / luck spend (old worlds = 6th)
  const is7th = skeleton.world.rulesEdition === "coc7";
  const [diceMode, setDiceMode] = useState<"none" | "bonus" | "penalty">("none");
  const characters = useMemo(() => loadCharacters(), []);
  const userIdentity = useMemo(() => {
    if (save.agents.length === 1) {
      // Single agent: use that character's binding
      return resolveUserIdentity(save.agents[0].characterId, "adventure");
    }
    // Multiple agents or no agents: use global default
    return resolveUserIdentity(undefined, "adventure");
  }, [save.agents]);
  const charName = useCallback((id: string) => characters.find(c => c.id === id)?.name || id, [characters]);

  const avatarMap = useMemo(() => {
    const map: Record<string, string> = {};
    // Player avatar
    const playerName = userIdentity?.name || "你";
    if (userIdentity?.avatarUrl) map[playerName] = userIdentity.avatarUrl;
    // Companion avatars
    for (const a of save.agents) {
      const ch = characters.find(c => c.id === a.characterId);
      if (ch?.avatar) map[ch.name] = ch.avatar;
    }
    return map;
  }, [userIdentity, save.agents, characters]);

  // Fork 十期: stage assets — local mirror of world.assets (panel edits persist via saveMapWorld)
  const [assets, setAssets] = useState<StageAsset[]>(world.assets || []);
  const updateAssets = useCallback((next: StageAsset[]) => {
    setAssets(next);
    saveMapWorld({ ...world, assets: next });
  }, [world]);
  // NPC portraits — load object URLs once (cached in state)
  const [portraitMap, setPortraitMap] = useState<Record<string, string>>({});
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const portraits = assets.filter(a => a.kind === "portrait" && a.boundTo);
      for (const p of portraits) {
        const url = await getAssetUrl(p.id);
        if (cancelled) { if (url) URL.revokeObjectURL(url); return; }
        if (url) setPortraitMap(prev => ({ ...prev, [p.boundTo!]: url }));
      }
    })();
  }, [assets]);
  const fullAvatarMap = useMemo(() => ({ ...avatarMap, ...portraitMap }), [avatarMap, portraitMap]);
  // Fire CG/BGM cues from a DM result (KP reports names; blobs resolved locally)
  const fireStageCues = useCallback((sc: { cg?: string; bgm?: string }) => {
    if (sc.bgm && sc.bgm !== bgmNameRef.current) {
      const asset = assets.find(a => a.kind === "bgm" && (a.name === sc.bgm || a.fileName.includes(sc.bgm as string)));
      if (asset) {
        getAssetUrl(asset.id).then(url => {
          if (!url) return;
          bgmNameRef.current = sc.bgm as string;
          setCurrentBgm(sc.bgm as string);
          if (bgmAudioRef.current) {
            bgmAudioRef.current.src = url;
            bgmAudioRef.current.loop = true;
            bgmAudioRef.current.volume = 0.35;
            bgmAudioRef.current.play().catch(() => undefined);
          }
        });
      }
    }
    if (sc.cg) {
      const asset = assets.find(a => a.kind === "cg" && (a.name === sc.cg || a.fileName.includes(sc.cg as string)));
      if (asset) {
        getAssetUrl(asset.id).then(url => { if (url) setCgOverlay({ name: sc.cg as string, url }); });
      }
    }
  }, [assets]);
  const bilingualTranslationEnabled = adventureConfig.bilingualTranslationEnabled === true;
  const defaultTranslationExpanded = adventureConfig.collapseBilingualTranslation !== true;

  // Fork: lazy investigator import — runs on first world entry (was: blocking lobby creation).
  // One LLM call per person (player first, then companions, sequential); failures fall back silently
  // to the raw character card. Player persona opens the review modal when it arrives.
  // Phase 0: if HO lines exist but unassigned → assignment modal FIRST (player picks, KP assigns the rest).
  const personaImportedRef = useRef(false);
  React.useEffect(() => {
    if (personaImportedRef.current) return;
    if (!save.personaPending) return;
    if (save.investigatorLines?.length && !save.boundLineHo) {
      setHoAssignOpen(true);   // assignment modal opens; import starts after it confirms
      return;
    }
    personaImportedRef.current = true;
    let cancelled = false;
    (async () => {
      const apiConfigs = loadApiConfigs();
      const apiConfig = apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) return;
      const myName = userIdentity?.name || "调查员";
      const introSource = `${skeleton.world.name}：${skeleton.world.lore.slice(0, 260)}`;
      // Fork: table-feel — the KP opens the module and hands out identity cards one by one
      pushMessages({ id: mkId(), type: "narration", text: `🎲 KP 翻开《${skeleton.world.name}》的模组，把几张空白身份卡摆在桌上——"稍等，各位的调查员身份还在拟写。"` });
      // Fork: HO 密档改为分配面板——玩家先选，剩余由 KP 按人设贴合度分配（见 hoAssignOpen effect）
      // （旧的自动按序绑定已移除）
      // Player persona first → the review modal IS your card being handed over
      try {
        // Fork: HO occupation requirement — the player's assigned line dictates their job
        const myHoOcc = save.boundLineHo?.["__player__"]
          ? save.investigatorLines?.find(l => l.ho === save.boundLineHo["__player__"])?.occupation
          : undefined;
        const persona = await importInvestigator(myName, `（用户本人）${introSource}`, skeleton, save.mySecret, apiConfig, myHoOcc);
        if (!cancelled && persona) {
          persistSave({ ...saveRef.current, myPersona: { ...persona, confirmed: false } });
          pushMessages({ id: mkId(), type: "system", text: "📇 KP 将一张身份卡推到你面前——请过目（弹窗已打开，可修改后确认）" });
        } else if (!cancelled) {
          pushMessages({ id: mkId(), type: "system", text: "📇 你的身份卡没能拟好——你将以调查员本人的身份入团" });
        }
      } catch { /* fallback: no player persona */ }
      // Companions, one by one — each keeps its slot even on failure (raw card used)
      for (const a of saveRef.current.agents) {
        const ch = characters.find(c => c.id === a.characterId);
        const name = ch?.name || "同伴";
        try {
          // Fork: HO occupation requirement — each companion's assigned line dictates their job
          const compHoOcc = save.boundLineHo?.[a.characterId]
            ? save.investigatorLines?.find(l => l.ho === save.boundLineHo[a.characterId])?.occupation
            : undefined;
          const persona = await importInvestigator(name, ch?.personality || "", skeleton, save.agentSecrets?.[a.characterId], apiConfig, compHoOcc);
          if (!cancelled && persona) {
            persistSave({
              ...saveRef.current,
              agents: saveRef.current.agents.map(x => x.characterId === a.characterId ? { ...x, persona } : x),
            });
            pushMessages({ id: mkId(), type: "system", text: `📇 KP 把身份卡递给 ${name}——${persona.era} · ${persona.occupation}` });
            // Fork: the companion reacts in their own voice — "I'm going to play... a WHAT?!"
            pushMessages({
              id: mkId(),
              type: "character",
              speaker: persona.name || name,
              text: persona.cardReaction?.trim() || `（展开身份卡，眼睛慢慢睁大）……要我演这个时代的${persona.occupation}？行吧，我接了。`,
              emotion: "worried",
            });
          } else if (!cancelled) {
            pushMessages({ id: mkId(), type: "system", text: `📇 ${name} 的身份卡在途中遗失——TA将以原本的面目加入调查` });
          }
        } catch { /* fallback: raw card */ }
      }
      if (!cancelled) {
        const finalSave = { ...saveRef.current };
        delete finalSave.personaPending;
        persistSave(finalSave);
        pushMessages({ id: mkId(), type: "narration", text: "🎭 身份卡分发完毕。KP 清了清嗓子——\"诸位，故事开始了。\"" });
      }
    })();
    return () => { cancelled = true; };
    // Fork fix: boundLineHo must be a dep — after the assignment modal confirms,
    // personaPending is still true (unchanged) so the effect would never re-run
    // and the import pipeline stayed stuck at phase 0 forever
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.personaPending, save.boundLineHo]);
  // Player persona review modal opens when an unconfirmed persona arrives (state at L68 reads save.myPersona on mount)
  React.useEffect(() => {
    if (save.myPersona && !save.myPersona.confirmed) setPersonaReview(save.myPersona);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save.myPersona]);

  // Fork: HO assignment — player picks, then KP assigns remaining lines by character-card fit
  const hoPickPlayer = (ho: string) => {
    setHoAssignMap({ "__player__": ho });
  };
  const hoKpAssign = async () => {
    if (!save.investigatorLines?.length) return;
    setHoAssignLoading(true);
    try {
      const apiConfigs = loadApiConfigs();
      const apiConfig = apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("无API配置");
      const takenHo = Object.values(hoAssignMap)[0] || "";
      const freeLines = save.investigatorLines.filter(l => l.ho !== takenHo);
      const companions = save.agents.map(a => {
        const ch = characters.find(c => c.id === a.characterId);
        return { cid: a.characterId, name: ch?.name || a.characterId, personality: (ch?.personality || "").slice(0, 300) };
      });
      const next: Record<string, string> = { ...hoAssignMap };
      if (freeLines.length && companions.length) {
        const sys = `你是COC跑团的KP。若干条调查员密档线（HO）待分配给同伴角色——分配优先级：①HO车卡规定了职业的（标了"职业:"），优先分给角色卡性格/气质/性别与之相配的角色，且该角色的身份卡将直接采用此职业；②再按人设贴合度分配其余：角色卡性格与HO导入剧情的契合度优先（比如HO线是恋爱剧情而角色卡是恋爱脑，很贴；HO线是硬汉复仇而角色卡柔弱傲娇，不贴）。每条HO只给一个角色，一个角色至多一条；HO数量≥角色数量时，多余的HO留在池中无人扮演（写"无人"）。只输出：每行"角色名=HO代号"或"角色名=无人"。`;
        const user = `待分配HO线：\n${freeLines.map(l => `${l.ho}${l.occupation ? `（职业:${l.occupation}——此HO有固定职业要求，优先给适合的角色）` : ""}：${l.introStory.slice(0, 200)}${l.relations.length ? `（关系：${l.relations.map(r => `${r.npc}=${r.relation}`).join("；")}）` : ""}`).join("\n")}\n\n同伴角色：\n${companions.map(c => `${c.name}：${c.personality || "（无性格描述）"}`).join("\n")}\n\n玩家已选：${takenHo || "（未选）"}`;
        const result = await (await import("@/lib/api-helpers")).simpleLLMCall(apiConfig, [
          { role: "system", content: sys },
          { role: "user", content: user },
        ], { temperature: 0.3 });
        const txt = (result.content as string) || "";
        for (const c of companions) {
          const idx = txt.indexOf(c.name);
          const ho = idx >= 0 ? txt.slice(idx + c.name.length).replace(/^[\s]*[=＝][\s]*/, "").split(/[\s\n]+/)[0] || "" : "";
          if (ho && ho !== "无人" && freeLines.some(l => l.ho === ho) && !Object.values(next).includes(ho)) next[c.cid] = ho;
        }
      }
      setHoAssignMap(next);
    } catch { /* keep player's pick only */ }
    setHoAssignLoading(false);
  };
  const hoAssignConfirm = () => {
    // Fork fix: write the binding back into each line's boundCharacterId — the KP context
    // (investigatorLinesHint) reads THIS field, not the boundLineHo map; leaving it empty
    // made every line show as （未绑定）so the KP narrated whichever line it pleased (HO1)
    const boundLines = (save.investigatorLines || []).map(l => ({ ...l, boundCharacterId: undefined }));
    for (const [cid, ho] of Object.entries(hoAssignMap)) {
      const line = boundLines.find(l => l.ho === ho);
      if (line) line.boundCharacterId = cid;
    }
    persistSave({ ...save, boundLineHo: hoAssignMap, investigatorLines: boundLines });
    setHoAssignOpen(false);
    pushMessages({ id: mkId(), type: "system", text: "🎭 HO 密档线已分配——KP 开始分发身份卡" });
    // Player's own line → locked message right away (companions get theirs via lineHint during play)
    const myHo = hoAssignMap["__player__"];
    const myLine = save.investigatorLines?.find(l => l.ho === myHo);
    if (myLine) {
      pushMessages({
        id: mkId(), type: "narration", audience: ["locked"],
        text: `🔒〔你的私人密档 · ${myHo}〕${myLine.introStory ? `入团前：${myLine.introStory}` : ""}${myLine.relations.length ? `\n你的私人关系：${myLine.relations.map(r => `${r.npc}（${r.relation}）`).join("；")}` : ""}${myLine.events.length ? `\n你还有专属剧情线（${myLine.events.length} 段，触发时机由 KP 安排）——其他调查员对此一无所知。` : ""}`,
      });
    }
  };

  const agentsAtNode = useCallback((nodeId: string) =>
    save.agents.filter(a => a.characterId && a.currentNodeId === nodeId),
    [save.agents]);

  // Build a lookup of all nodes
  const allNodes = useMemo(() => {
    const nodes: { id: string; x: number; y: number; name: string; type: "l1" | "l2" | "l3"; regionIdx: number }[] = [];
    renderedMap.l1Nodes.forEach((n, i) => nodes.push({ id: n.id, x: n.x, y: n.y, name: n.nameCn, type: "l1", regionIdx: i }));
    renderedMap.l2Nodes.forEach((n, i) => nodes.push({ id: `l2_${i}`, x: n.x, y: n.y, name: n.name, type: "l2", regionIdx: n.regionIdx }));
    renderedMap.l3Nodes.forEach((n, i) => nodes.push({ id: `l3_${i}`, x: n.x, y: n.y, name: n.name, type: "l3", regionIdx: n.regionIdx }));
    return nodes;
  }, [renderedMap]);

  const nodeMap = useMemo(() => new Map(allNodes.map(n => [n.id, n])), [allNodes]);
  const currentNode = nodeMap.get(save.currentNodeId);

  // Fork 拆场: scene wall — a companion only witnesses stream messages from their own scene
  // (locked entries always hidden; scene:X tags only pass for members standing at X)
  const sceneWallFilter = useCallback((characterId: string) => {
    const agent = save.agents.find(a => a.characterId === characterId);
    const locName = nodeMap.get(agent?.currentNodeId || save.currentNodeId)?.name || "";
    return streamRef.current.filter(m => {
      if (!m.audience) return true;
      if (m.audience.includes("locked")) return false;
      const sc = m.audience.find(a => a.startsWith("scene:"));
      if (!sc) return true;
      return sc === `scene:${locName}`;
    });
  }, [save.agents, save.currentNodeId, nodeMap]);
  const selectedNode = selectedNodeId ? nodeMap.get(selectedNodeId) : null;

  const discoveredRegions = useMemo(() => {
    const regions = new Set<number>();
    for (const nodeId of save.discoveredNodes) {
      const node = allNodes.find(n => n.id === nodeId);
      if (node) regions.add(node.regionIdx);
    }
    return regions;
  }, [save.discoveredNodes, allNodes]);

  const isVisible = useCallback((nodeId: string) => {
    if (save.discoveredNodes.includes(nodeId)) return true;
    const node = allNodes.find(n => n.id === nodeId);
    return node ? discoveredRegions.has(node.regionIdx) : false;
  }, [save.discoveredNodes, allNodes, discoveredRegions]);

  const isVisited = useCallback((nodeId: string) => {
    return save.visitedNodes.includes(nodeId);
  }, [save.visitedNodes]);



  // Nearby nodes for exploration action bar
  const nearbyNodes = useMemo(() => {
    if (!currentNode) return [];
    // Use edge graph: find all nodes directly connected by routes
    const connectedIds = new Set<string>();
    for (const [a, b] of renderedMap.edges || []) {
      if (a === save.currentNodeId) connectedIds.add(b);
      if (b === save.currentNodeId) connectedIds.add(a);
    }
    return allNodes
      .filter(n => connectedIds.has(n.id) && isVisible(n.id))
      .slice(0, 10);
  }, [allNodes, save.currentNodeId, currentNode, isVisible, renderedMap.edges]);

  // Get interactions available at current node
  const getInteractions = useCallback((nodeId: string): NodeInteraction[] => {
    const node = nodeMap.get(nodeId);
    if (!node || nodeId !== save.currentNodeId) return [];

    const interactions: NodeInteraction[] = [];

    const nodeName = node.name;
    const regionId = skeleton.mapInput.regions[node.regionIdx]?.id;

    // Main quest: match by node name
    const stage = skeleton.mainQuest.stages[save.mainQuestStage];
    if (stage) {
      if (stage.locationHint === nodeName || stage.locationHint.includes(nodeName) || nodeName.includes(stage.locationHint)) {
        interactions.push({ type: "quest", label: `主线：${skeleton.mainQuest.title}`, questId: skeleton.mainQuest.id, available: true, icon: "📋" });
      }
    }

    // Side quests: match by region (trigger region) or active
    const allCompleted = save.agents.flatMap(a => a.completedSideQuests);
    const allActive = save.agents.flatMap(a => a.activeSideQuests);
    for (const sq of skeleton.sideQuests) {
      if (allCompleted.includes(sq.id)) continue;
      if (allActive.includes(sq.id) || regionId === sq.triggerRegion) {
        interactions.push({ type: "sidequest", label: `支线：${sq.title}`, questId: sq.id, available: true, icon: "📋" });
      }
    }

    // NPCs: match by specific node name, fallback to region L1 name for L1 NPCs
    const nodeNpcs = skeleton.npcs.filter(n => {
      if (n.locationNode === nodeName) return true;
      // L1 NPC: show at the L1 node of that region
      if (!n.locationNode && n.locationRegion === regionId && node.type === "l1") return true;
      return false;
    });
    for (const npc of nodeNpcs) {
      interactions.push({ type: "talk", label: `和${npc.name}交谈`, available: true, icon: "💬" });
    }

    const searchCount = save.searchedNodes[nodeId] || 0;
    if (searchCount < 3) {
      interactions.push({ type: "search", label: "搜索周围", available: true, icon: "🔍" });
    }

    if (node.type === "l1") {
      interactions.push({ type: "rest", label: "休息", available: true, icon: "🏕" });
    } else {
      interactions.push({ type: "rest", label: "扎营", available: true, icon: "⛺" });
    }

    return interactions;
  }, [save, skeleton, nodeMap]);

  // Push scene dialogues to stream (sceneTag: audience tag for split-scene rounds — only
  // companions at that node see the narration in their context)
  // Fork 交织: narration may embed 〔NPC名：台词〕 markers — split them into alternating
  // narration / npc bubbles so dialogue reads woven into the prose, not dumped after it.
  const pushSceneToStream = useCallback((scene: EventScene, sceneTag?: string) => {
    const audience = sceneTag ? { audience: [sceneTag] } : {};
    const normalize = (s: string) => s.replace(/[「」『』\s]/g, "");
    const msgs: StreamMessage[] = [];
    for (const d of scene.dialogues) {
      if (d.speaker !== "narrator") {
        // Standalone NPC line (no marker home) — check it wasn't already emitted by a marker split
        const dup = msgs.some(m => m.type === "npc" && m.speaker === d.speaker && normalize(m.text).includes(normalize(d.text)));
        if (!dup) msgs.push({ id: mkId(), type: "npc" as const, speaker: d.speaker, text: d.text, emotion: d.emotion, ...audience });
        continue;
      }
      // Narrator: split on 〔NPC：台词〕 markers
      const parts = d.text.split(/〔[^〕]*[：:][^〕]*〕/g);
      const marks = [...d.text.matchAll(/〔([^〔〕]*?)[：:]([^〔〕]*)〕/g)];
      if (marks.length === 0) {
        msgs.push({ id: mkId(), type: "narration" as const, text: d.text, emotion: d.emotion, ...audience });
        continue;
      }
      marks.forEach((m, i) => {
        const before = (parts[i] || "").trim();
        if (before) msgs.push({ id: mkId(), type: "narration" as const, text: before, ...audience });
        const spk = m[1].trim();
        const line = m[2].trim();
        if (spk && line) msgs.push({ id: mkId(), type: "npc" as const, speaker: spk, text: line, ...audience });
      });
      const after = (parts[parts.length - 1] || "").trim();
      if (after) msgs.push({ id: mkId(), type: "narration" as const, text: after, ...audience });
    }
    pushMessages(...msgs);
  }, [pushMessages]);

  // Initial location message
  const initialPushed = useRef(streamMessages.length > 0);
  React.useEffect(() => {
    if (currentNode && !initialPushed.current) {
      initialPushed.current = true;
      pushMessages({
        id: mkId(), type: "location",
        text: `你正在 ${currentNode.name}`,
      });
    }
  }, [currentNode, pushMessages]);

  // Handle move
  const handleMove = useCallback((targetNodeId: string) => {
    const target = nodeMap.get(targetNodeId);
    if (!target) return;

    const newDiscovered = [...save.discoveredNodes];
    for (const n of allNodes) {
      if (!newDiscovered.includes(n.id)) {
        if (n.regionIdx === target.regionIdx || n.type === "l1") {
          newDiscovered.push(n.id);
        }
      }
    }

    // Fork 拆场: only agents in the same scene follow the player — split members stay where they are
    const agentsHere = save.agents.filter(a => a.currentNodeId === save.currentNodeId);
    const movedAgents = save.agents.map(a => {
      if (!agentsHere.includes(a)) return a;
      return {
        ...a,
        currentNodeId: targetNodeId,
        currentNodeType: target.type,
        discoveredNodes: [...new Set([...a.discoveredNodes, targetNodeId])],
      };
    });

    const newSave: GameSave = {
      ...save,
      currentNodeId: targetNodeId,
      currentNodeType: target.type,
      agents: movedAgents,
      discoveredNodes: newDiscovered,
      visitedNodes: save.visitedNodes.includes(targetNodeId) ? save.visitedNodes : [...save.visitedNodes, targetNodeId],
      timestamp: new Date().toISOString(),
    };

    persistSave(newSave);
    setSelectedNodeId(null);

    // Push location message to stream
    pushMessages({
      id: mkId(), type: "location",
      text: `你来到了 ${target.name}`,
    });
  }, [save, nodeMap, allNodes, persistSave, pushMessages]);

  // Handle rest
  const handleRest = useCallback(() => {
    const isCity = save.currentNodeType === "l1";
    const recoveredHp = isCity ? save.maxHp : Math.min(save.maxHp, save.hp + 30);
    const restText = isCity ? "在城中休息了一晚，恢复了全部生命值。" : "在野外扎营过夜，恢复了少许生命值。";
    const newSave: GameSave = {
      ...save,
      hp: recoveredHp,
      gameTime: "morning",
      gameDay: save.gameDay + 1,
      journal: [...save.journal, {
        id: `j_${Date.now()}`,
        timestamp: formatGameTime(save.gameDay + 1, "morning"),
        realTime: new Date().toISOString(),
        locationName: currentNode?.name || "",
        text: restText,
        type: "discovery",
      }],
      timestamp: new Date().toISOString(),
    };
    persistSave(newSave);

    pushMessages({ id: mkId(), type: "system", text: restText });
  }, [save, currentNode, persistSave, pushMessages]);

  // ── Trigger an event (calls LLM → pushes to stream) ──
  const triggerEvent = useCallback(async (
    eventType: "main_quest" | "side_quest" | "encounter" | "search" | "talk",
    brief: string,
    meta?: { questId?: string; npcName?: string; npcPersonality?: string },
  ) => {
    if (inEvent || eventLoading) return;
    setEventLoading(true);
    setActiveEventMeta({ type: eventType, questId: meta?.questId });
    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      // DM API: multi-agent → global binding; single-agent → that agent's adventure binding
      const dmSlot = save.agents.length === 1
        ? resolveBinding(bindings, save.agents[0].characterId, "adventure")
        : resolveBinding(bindings, undefined, "adventure");
      const apiConfig = (dmSlot?.apiConfigId ? apiConfigs.find(c => c.id === dmSlot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("未找到有效的API配置，请先在设置中配置API");
      // CoC6 SAN backfill for pre-migration saves
      const playerSan = typeof save.san === "number" ? save.san : (save.playerStats?.san ?? 99);

      const companionIds = save.agents
        .filter(a => a.currentNodeId === save.currentNodeId)
        .map(a => a.characterId);
      const companionNames = companionIds.map(id => charName(id));

      const stagesWithResults = skeleton.mainQuest.stages.map((s, i) => ({
        brief: s.brief,
        result: save.director.mainArc.stageResults.find(r => r.stage === i)?.outcome,
      }));

      const npcSecret = meta?.npcName
        ? skeleton.dmDossier?.npcSecrets[skeleton.npcs.find(n => n.name === meta.npcName)?.id || ""] || undefined
        : undefined;

      const allCompleted = save.agents.flatMap(a => a.completedSideQuests);
      const sqStatus: Record<string, string> = {};
      for (const sq of skeleton.sideQuests) {
        sqStatus[sq.id] = allCompleted.includes(sq.id) ? "已完成" : "未触发";
      }
      const mqNodeMap: Record<number, string> = {};
      skeleton.mainQuest.stages.forEach((s, i) => { mqNodeMap[i] = s.locationHint; });

      const dmCtx = {
        worldLore: skeleton.world.lore,
        currentLocation: currentNode?.name || "",
        eventType,
        eventBrief: brief,
        npcName: meta?.npcName,
        npcPersonality: meta?.npcPersonality,
        npcSecret,
        companionNames,
        playerName: userIdentity?.name || "玩家",
        recentJournal: save.journal.map(j => j.text),
        keyChoices: save.keyChoices,
        gameTime: formatGameTime(save.gameDay, save.gameTime),
        dmDossier: skeleton.dmDossier,
        director: save.director,
        mainQuestSynopsis: skeleton.mainQuest.synopsis,
        mainQuestStages: stagesWithResults,
        richRegions: skeleton.richRegions,
        sideQuestStatus: sqStatus,
        mainQuestNodeMap: mqNodeMap,
        kpStyle: (skeleton.world.lore.match(/【KP风格指令】([\s\S]*)/)?.[1] || "").trim() || undefined,
        rulesEdition: skeleton.world.rulesEdition || "coc6",
        partySecrets: [
          ...(save.mySecret ? [{ who: userIdentity?.name || "你", secret: save.mySecret }] : []),
          ...Object.entries(save.agentSecrets || {}).map(([cid, s]) => ({ who: charName(cid), secret: s })),
        ],
        // Fork: HO 密档——导入剧情与个人线（KP 可见全部；含绑定角色名映射与事件触发表）
        ...(save.investigatorLines?.length ? {
          investigatorLinesHint: save.investigatorLines.map(l => {
            const holder = l.boundCharacterId === "__player__" ? (userIdentity?.name || "你") : charName(l.boundCharacterId || "");
            const bind = holder ? `（${holder}）` : "（未绑定）";
            // Fork fix: mark the player's own line — without this the KP narrated whichever
            // line it liked (usually the first, HO1) instead of the player's picked line
            const isPlayerLine = l.boundCharacterId === "__player__";
            return [
              `${l.ho}${bind}${isPlayerLine ? "【这是{{user}}本人的线——开场第一幕必须以这条线的导入剧情为起点】" : ""} 导入剧情：${l.introStory}`,
              ...(l.relations.length ? [`私人关系：${l.relations.map(r => `${r.npc}=${r.relation}`).join("；")}`] : []),
              ...(l.events.length ? [`个人线事件（按触发条件演出，只有${holder || l.ho}在场时才发生；触发时走私聊幕，不当众展开）：${l.events.map(e => `[${e.trigger}] ${e.summary}`).join(" ⟂ ")}`] : []),
            ].join("\n");
          }).join("\n\n"),
        } : {}),
        acts: skeleton.acts,
        currentAct: save.currentAct ?? 0,
        // Fork: 密档划账——已公开条目注入（KP 按标注守账）
        revealedDossier: save.revealedDossier || [],
        assetManifest: buildAssetManifest(assets),
        playerPersona: save.myPersona ? `${save.myPersona.occupation}——${save.myPersona.background}${save.myPersona.hooks ? `（私下在意：${save.myPersona.hooks}）` : ""}` : undefined,
        discoveredRegionIds: [...discoveredRegions].map(idx => skeleton.mapInput.regions[idx]?.id).filter(Boolean) as string[],
        partyStatus: {
          hp: save.hp,
          maxHp: save.maxHp,
          san: playerSan,
          items: [...(save.playerSheet?.equipment || []), ...save.director.keyItems],
          playerStats: save.playerStats,
          playerSheet: save.playerSheet,
          combat: save.combat && !save.combat.ended ? { round: save.combat.round, initiative: save.combat.initiative, currentIndex: save.combat.currentIndex, hostiles: save.combat.hostiles } : undefined,
          madness: save.madness,
          companions: save.agents
            .filter(a => a.currentNodeId === save.currentNodeId)
            .map(a => {
              const ch = characters.find(c => c.id === a.characterId);
              return { name: ch?.name || a.characterId, affinity: a.affinity, stats: a.stats, status: a.sheet ? a.sheet.occupation : "", sheet: a.sheet };
            }),
        },
        pacing: save.pacing,
      };

      const scene = await expandEvent(dmCtx, companionIds, apiConfig);
      failedSkillsRef.current.clear(); // new scene — reset the failed-check guard
      const dmScene = scene as EventScene & { dmSituation?: string; worldEvents?: string[]; revealed?: string[] };
      if (dmScene.worldEvents?.length) setWorldEvents(dmScene.worldEvents);
      // Fork: 密档划账——本轮公开的密档条目记入总账（去重）
      if (dmScene.revealed?.length) {
        const merged = [...new Set([...(save.revealedDossier || []), ...dmScene.revealed.map(r => r.trim())].filter(Boolean))];
        persistSave({ ...save, revealedDossier: merged });
      }

      const sceneJournal = scene.journalEntry?.trim();
      const sceneClues = (scene.clues || []).filter(Boolean);
      if (sceneJournal || sceneClues.length) {
        const locName = currentNode?.name || "未知地点";
        const dayLabel = formatGameTime(save.gameDay, save.gameTime);
        persistSave({
          ...save,
          journal: sceneJournal ? [...save.journal, {
            id: `j_${Date.now()}`,
            timestamp: formatGameTime(save.gameDay, save.gameTime),
            realTime: new Date().toISOString(),
            locationName: currentNode?.name || "",
            text: sceneJournal,
            type: eventType === "main_quest" ? "main" : "side",
          }] : save.journal,
          clues: [...(save.clues || []), ...sceneClues.map((c, i) => ({ id: `clue_${Date.now()}_${i}`, location: locName, text: c, day: dayLabel }))],
          timestamp: new Date().toISOString(),
        });
        if (sceneClues.length) pushMessages({ id: mkId(), type: "system", text: `🗂 线索归档：${sceneClues.join("；")}` });
      }
      if (scene.investigationDone) {
        pushMessages({ id: mkId(), type: "system", text: "🔎 本地点的调查已告一段落，继续停留难有新发现——考虑转移地点" });
      }

      // Fork 十期: stage cues — fire CG / BGM when KP reported them
      fireStageCues(scene as EventScene & { cg?: string; bgm?: string });

      // Push dialogues to text stream
      pushSceneToStream(scene);

      // Set event state for continuation
      setActiveEvent(scene);
      setAccumulatedEvent(scene);
      setEventContext(JSON.stringify(dmCtx));
      setInEvent(true);

      // Fork: investigation hints from KP (scene stays open for player declarations)
      const sceneHints = (scene as EventScene & { hints?: { label: string; skillHint?: string }[] }).hints;
      setCurrentHints(sceneHints && sceneHints.length > 0 ? sceneHints : null);
      const sceneTopics = (scene as EventScene & { topics?: { label: string; skillHint?: string }[] }).topics;
      setCurrentTopics(eventType === "talk" && sceneTopics && sceneTopics.length > 0 ? sceneTopics : null);

      // Set choices if available
      if (scene.choices && scene.choices.length > 0) {
        setCurrentChoices(scene.choices);
        setTimeout(() => inputRef.current?.focus(), 200);
      } else if (sceneHints && sceneHints.length > 0) {
        // No hard choices but hints exist — stay in event for player-driven investigation
        setCurrentChoices([]);
        setTimeout(() => inputRef.current?.focus(), 200);
      } else {
        // No choices — event done immediately
        setCurrentChoices(null); setCurrentTopics(null);
        setInEvent(false);
        setActiveEvent(null);
        setActiveEventMeta(null);
        pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
      }
      setLastFailedEvent(null); // success — clear any previous failure
    } catch (e) {
      console.warn("[MapView] Event trigger error:", e);
      pushMessages({ id: mkId(), type: "system", text: `事件触发失败：${e instanceof Error ? e.message : String(e)}` });
      setLastFailedEvent({ type: eventType, brief, meta });
      setActiveEvent(null);
      setActiveEventMeta(null);
      setInEvent(false);
    } finally {
      setEventLoading(false);
    }
  }, [save, skeleton, currentNode, characters, inEvent, eventLoading, pushSceneToStream, pushMessages]);

  // ── Handle player action — Collect-Resolve-Narrate loop ──
  const handlePlayerAction = useCallback(async (actionText: string, skipDisplay?: boolean) => {
    // ── Phase 2: Player declares ──
    const playerName = userIdentity?.name || "你";
    // Fork: round divider — every declaration round starts with a clear visual break
    pushMessages({ id: mkId(), type: "divider", text: `ROUND ${(save.keyChoices?.length || 0) + 1}` });
    if (!skipDisplay) {
      // Fork: player declaration → declCard (say / do / dice in one card)
      // Dice comes from the pre-rolled check in submitDeclarationWithCheck (pendingPlayerDiceRef)
      const sayMatch = actionText.match(/说：「(.+?)」/);
      const doMatch = actionText.match(/做：(.+)/);
      const say = sayMatch?.[1] || (!doMatch ? actionText : undefined);
      const doText = doMatch?.[1];
      const dice = pendingPlayerDiceRef.current;
      pendingPlayerDiceRef.current = undefined;
      const card: StreamMessage = {
        id: mkId(), type: "declCard", speaker: playerName, text: "",
        decl: { who: playerName, say, do: doText, dice },
      };
      pushMessages(card);
      streamRef.current = [...streamRef.current, card];
    }
    setCurrentChoices(null); setCurrentTopics(null);
    setEventContinueLoading(true);
    setLastFailedAction(actionText);  // save immediately so it persists if interrupted

    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      // DM API: multi-agent → global binding; single-agent → that agent's adventure binding
      const dmSlot = save.agents.length === 1
        ? resolveBinding(bindings, save.agents[0].characterId, "adventure")
        : resolveBinding(bindings, undefined, "adventure");
      const apiConfig = (dmSlot?.apiConfigId ? apiConfigs.find(c => c.id === dmSlot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("未找到有效的API配置");

      // ── Phase 3: Companions declare — detect already-replied from stream ──
      const companionIds = save.agents.map(a => a.characterId);

      // Include full stream log (narration + NPC + player + character + rolls) so DM sees free-chat context too
      const prevDialogue = streamRef.current
        .filter(m => m.type !== "system" && m.type !== "divider" && m.type !== "ooc")
        .map(m => m.type === "declCard" && m.decl
          ? `${m.decl.who}: ${[m.decl.say ? `说：「${m.decl.say}」` : "", m.decl.do ? `做：${m.decl.do}` : "", m.decl.dice ? `（宣言检定 ${m.decl.dice.skill}${m.decl.dice.value}：D100=${m.decl.dice.roll}，结果由你演出）` : ""].filter(Boolean).join(" ")}`
          : (m.speaker ? `${m.speaker}: ${m.text}` : m.text))
        .join("\n");


      const companionDecls: Declaration[] = [];
      if (companionIds.length > 0) {
        // Check which companions already completed (persisted in pendingEvent.completedCompanions)
        const alreadyDone = new Set(completedCompanionsRef.current);

        const pendingIds = companionIds.filter(cid => !alreadyDone.has(cid));

        if (pendingIds.length > 0) {
          setLoadingPhase("companions");
          for (const cid of pendingIds) {
            const declAgent = save.agents.find(a => a.characterId === cid);
            let declPendingDice: { skill: string; value: number; roll: number; level: string; detail?: string } | undefined;
            // Fork 十二期: companion remembers their OWN private talks (lockedLog filtered by who)
            const ownTalks = (save.lockedLog || []).filter(e => e.who === (characters.find(c => c.id === cid)?.name)).slice(-4);
            const memoryHint = ownTalks.length ? `【你的私下记忆】（别人不知道你知道这些）\n${ownTalks.map(e => `${e.day} 你与${e.npc || "某人"}私下谈过：${e.text}`).join("\n")}\n这些记忆影响你的言行（欲言又止/改变态度/私下行动），但不要主动透露内容。` : undefined;
            const personaHint = declAgent?.persona ? `【你的模组内人设】（以此身份行动，覆盖角色卡的现代设定）\n时代：${declAgent.persona.era}\n身份：${declAgent.persona.occupation}——${declAgent.persona.background}\n性格不变的部分：${declAgent.persona.keepTraits}\n${declAgent.persona.changes ? `时代调整：${declAgent.persona.changes}\n` : ""}你的言行、物品、习惯都必须属于这个时代，不要出现时代外元素。` : undefined;
            // Fork: 该同伴的 HO 密档线（只有TA和KP知道；入团前剧情+私人关系+事件预告）
            const myHoCode = save.boundLineHo?.[cid];
            const myLine = save.investigatorLines?.find(l => l.ho === myHoCode);
            const lineHint = myLine ? `【你的私人密档线】（只有你和KP知道，其他调查员一无所知——不要主动透露）\n入团前：${myLine.introStory || "（无）"}${myLine.relations.length ? `\n你的私人关系：${myLine.relations.map(r => `${r.npc}（${r.relation}）`).join("；")}` : ""}${myLine.events.length ? `\n你有专属剧情线，触发时机由KP安排（${myLine.events.map(e => e.trigger).join("、")}）——届时按你对该NPC的真实态度演出` : ""}` : undefined;
              // Fork 拆场: companion only sees messages from their own scene (locked always hidden, scene:X passes only for members at that node)
            const locName = nodeMap.get(declAgent?.currentNodeId || save.currentNodeId)?.name || "";
            const sceneFilteredLog = streamRef.current.filter(m => {
              if (!m.audience) return true;
              if (m.audience.includes("locked")) return false;
              const sc = m.audience.find(a => a.startsWith("scene:"));
              if (!sc) return true;
              return sc === `scene:${locName}`;
            });
            const decl = await companionDeclare(cid, apiConfig, sceneFilteredLog, save.agents.length > 1 ? userIdentity : undefined, declAgent?.affinity, {
              ...(save.agentSecrets?.[cid] ? { secretHint: `【你的秘密】${save.agentSecrets[cid].content}（与真相的咬合点：${save.agentSecrets[cid].link}${save.agentSecrets[cid].informant ? `；${save.agentSecrets[cid].informant}知道更多——你可以私下找TA求证）` : "）"}\n这是只有你知道的事。平时言行可以露出破绽（欲言又止、回避话题、偷偷做小动作），但不要直接说破；何时摊牌由你决定。不要在宣言里向队友透露秘密内容，除非你决定此刻公开它。` } : {}),
              ...((personaHint || lineHint) ? { personaHint: [personaHint, lineHint].filter(Boolean).join("\n\n") } : {}),
              ...(memoryHint ? { memoryHint } : {}),
            });

            if (decl.failed) {
              pushMessages({ id: mkId(), type: "system", text: `${decl.speaker} 回复失败` });
              throw new Error(`${decl.speaker}回复失败，请重试`);
            }

            // Mark as completed and persist immediately
            completedCompanionsRef.current = [...completedCompanionsRef.current, cid];
            setCompletedCompanions(completedCompanionsRef.current);

            companionDecls.push(decl);
            // Fork: companion-chosen skill check — roll it here, result enters the stream before DM resolve
            // (declAgent already resolved by characterId above — reuse it)
            if (decl.skillCheck && declAgent) {
              const edition2 = is7th ? "coc7" as const : "coc6" as const;
              const check = skillCheckValue(declAgent.sheet, decl.skillCheck, declAgent.stats, edition2);
              const rollR = rollD100(check.value, edition2);
              declPendingDice = { skill: check.source, value: check.value, roll: rollR.roll, level: rollR.level, detail: "" };
              usedSkillsRef.current.add(check.source.replace(/\(.*\)$/, ""));
            }
            if (declAgent?.sheet) {
              const weapon = findWeaponMention(`${decl.action} ${decl.speech}`, declAgent.sheet.weapons);
              if (weapon) {
                const skillVal = declAgent.sheet.skills[weapon.skill] ?? 25;
                const db = dbFromStats(declAgent.stats);
                const atk = resolveAttack(skillVal, weapon.name, weapon.damage, db, 30, "敌方");
                if (atk.attackLevel === "fail" || atk.attackLevel === "fumble") {
                  const missMsg: StreamMessage = { id: mkId(), type: "system", text: `⚔️ ${decl.speaker}以${weapon.name}攻击（${weapon.skill}${skillVal}%）：D100=${atk.attackRoll} → ${atk.attackLevel === "fumble" ? "大失败" : "失败"}` };
                  pushMessages(missMsg);
                  streamRef.current = [...streamRef.current, missMsg];
                } else if (atk.dodged) {
                  const missMsg: StreamMessage = { id: mkId(), type: "system", text: `⚔️ ${decl.speaker}以${weapon.name}攻击（${weapon.skill}${skillVal}%）→ 对方闪避成功，未造成伤害` };
                  pushMessages(missMsg);
                  streamRef.current = [...streamRef.current, missMsg];
                } else {
                  const dmgMsg: StreamMessage = { id: mkId(), type: "system", text: `⚔️ ${decl.speaker}以${weapon.name}命中（${atk.attackLevel === "crit" ? "大成功·贯穿" : LEVEL_LABEL[atk.attackLevel as RollLevel]}）：伤害 ${atk.damage}（${atk.damageDetail || "—"}）` };
                  pushMessages(dmgMsg);
                  streamRef.current = [...streamRef.current, dmgMsg];
                }
              }
            }
            // Fork: one declCard per companion — say / do / dice in a compact card
            {
              const card: StreamMessage = {
                id: mkId(),
                type: "declCard",
                speaker: decl.speaker,
                text: "",
                emotion: decl.emotion,
                decl: {
                  who: decl.speaker,
                  say: decl.speech && decl.speech !== "……" ? decl.speech : undefined,
                  do: decl.action && decl.action !== "跟随队伍" && decl.action !== "沉默不动" ? decl.action : undefined,
                  dice: declPendingDice,
                  emotion: decl.emotion,
                },
              };
              if (card.decl.say || card.decl.do || card.decl.dice) {
                pushMessages(card);
                streamRef.current = [...streamRef.current, card];
              }
            }
            // Fork 拆场: companion leaves the party — real position change + visible departure note
            if (decl.splitTo) {
              const destNode = allNodes.find(n => n.name === decl.splitTo) || allNodes.find(n => n.name.includes(decl.splitTo!) || decl.splitTo!.includes(n.name));
              if (destNode && destNode.id !== save.currentNodeId) {
                save = {
                  ...save,
                  agents: save.agents.map(x => x.characterId === cid
                    ? { ...x, currentNodeId: destNode.id, currentNodeType: destNode.type, discoveredNodes: [...new Set([...x.discoveredNodes, destNode.id])] }
                    : x),
                };
                pushMessages({ id: mkId(), type: "system", text: `🚶 ${decl.speaker} 宣言离队，独自前往「${destNode.name}」——那边发生的事只有TA自己知道` });
              }
            }
          }
        }
      }

      // ── Phase 3.5: Apply affinity changes from companion declarations ──
      for (const decl of companionDecls) {
        if (decl.affinityDelta && decl.affinityDelta !== 0) {
          const agentIdx = save.agents.findIndex(a => {
            const ch = characters.find(c => c.id === a.characterId);
            return ch?.name === decl.speaker;
          });
          if (agentIdx >= 0) {
            save = {
              ...save,
              agents: save.agents.map((a, i) =>
                i === agentIdx ? { ...a, affinity: Math.max(0, Math.min(100, a.affinity + decl.affinityDelta!)) } : a
              ),
            };
            persistSave(save);
          }
        }
      }

      // Fork 拆场: group members by current location (player + agents) for split narration
      const groupsByLoc = new Map<string, string[]>();
      groupsByLoc.set(save.currentNodeId, ["{{user}}"]);
      for (const a of save.agents) {
        const list = groupsByLoc.get(a.currentNodeId) || [];
        list.push(charName(a.characterId));
        groupsByLoc.set(a.currentNodeId, list);
      }
      const splitGroups = [...groupsByLoc.entries()].map(([nid, members]) => ({ where: nodeMap.get(nid)?.name || nid, members }));

      // ── Phase 4: DM resolves all declarations ──
      setLoadingPhase("dm");
      const allDeclarations: Declaration[] = [
        { speaker: playerName, speech: actionText, action: actionText },
        ...companionDecls,
      ];

      let dmCtx: import("@/lib/map-rpg-engine").DMContext;
      try { dmCtx = JSON.parse(eventContext); } catch { dmCtx = { worldLore: "", currentLocation: "", eventType: "", eventBrief: "", companionNames: [], recentJournal: [], keyChoices: [], gameTime: "" }; }
      dmCtx.previousDialogue = prevDialogue;
      dmCtx.director = save.director;
      dmCtx.recentJournal = saveRef.current.journal.map(j => j.text);
      dmCtx.revealedDossier = save.revealedDossier || [];   // fork: 密档划账随裁决上下文注入
      dmCtx.splitGroups = splitGroups.length > 1 ? splitGroups : undefined;   // fork 拆场: 分场状态（>1 场时注入）
      // Fork 拆场: remember where the player is this round — narration visibility splits along scene lines
      const myLocationName = nodeMap.get(save.currentNodeId)?.name || "";

      const continuation = await resolveRound(dmCtx, allDeclarations, apiConfig);

      // Update Director
      const ev = continuation as EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; moveTo?: string; worldEvents?: string[]; revealed?: string[] };
      if (ev.worldEvents?.length) setWorldEvents(ev.worldEvents);
      // Fork: 密档划账——本轮公开的密档条目记入总账（去重）
      if (ev.revealed?.length) {
        const revealedMerged = [...new Set([...(save.revealedDossier || []), ...ev.revealed.map(r => r.trim())].filter(Boolean))];
        save = { ...save, revealedDossier: revealedMerged };
        dmCtx.revealedDossier = revealedMerged;
      }
      const updatedDirector = { ...save.director };

      // Fork 九期B: act transition — when the act's final stage completes, load the next act
      let nextCurrentAct: number | undefined;
      if (skeleton.acts && skeleton.acts.length > 0 && continuation.advanceMainQuest) {
        const actIdx = Math.min(save.currentAct ?? 0, skeleton.acts.length - 1);
        const act = skeleton.acts[actIdx];
        const nextAct = skeleton.acts[actIdx + 1];
        // Simple mapping: main quest stage count within an act = total stages / acts
        const stagesPerAct = Math.max(1, Math.ceil(skeleton.mainQuest.stages.length / skeleton.acts.length));
        const inActStage = (save.mainQuestStage + 1) % stagesPerAct === 0;
        if (nextAct && inActStage) {
          pushMessages({ id: mkId(), type: "system", text: `🎭 第${actIdx + 1}幕「${act?.title || ""}」落幕——新的一幕开始了` });
          pushMessages({ id: mkId(), type: "narration", text: `【幕间】${nextAct.title ? `第${actIdx + 2}幕「${nextAct.title}」的帷幕拉开。` : ""}前事的余波尚未散尽，新的疑问已经浮现。调查仍在继续。` });
          nextCurrentAct = actIdx + 1;
        }
      }
      if (continuation.advanceMainQuest && activeEventMeta?.type === "main_quest") {
        updatedDirector.mainArc = {
          ...updatedDirector.mainArc,
          currentStage: updatedDirector.mainArc.currentStage + 1,
          stageResults: [...updatedDirector.mainArc.stageResults, {
            stage: updatedDirector.mainArc.currentStage,
            outcome: continuation.journalEntry || actionText,
            itemsGained: ev.gained || [],
            npcsInvolved: ev.npcsInvolved || [],
          }],
        };
      }

      // Process gained/lost — detect stat bonuses
      // Parse stat growth: "力量+5" or "小雪:感知+5" — supports all 7 stats
      // Parse gained (items only, no stat growth — growth is automatic)
      const newPlayerStats = { ...save.playerStats };
      let updatedAgents = [...save.agents];
      if (ev.gained?.length) updatedDirector.keyItems = [...new Set([...updatedDirector.keyItems, ...ev.gained])];

      // Parse lost — HP, stat decreases, and items
      const statNameMap: Record<string, string> = { 力量: "str", 体质: "con", 意志: "pow", 敏捷: "dex", 外貌: "app", 体型: "siz", 智力: "int", 教育: "edu", 理智: "san", 幸运: "lck", 感知: "int", 魅力: "app" };
      const lossPattern = /^(?:(.+?)[：:])?(.+?)(-\d+)$/;
      const lostItems: string[] = [];
      let hpChange = 0;
      let sanChange = 0;
      let newSan = typeof save.san === "number" ? save.san : (save.playerStats?.san ?? 99);
      for (const item of ev.lost || []) {
        // Fork 7th ed: two-tier SAN loss "SAN-1/1D6" (or "角色名:SAN-1/1D6") — roll a sanity check to pick the loss
        const san2 = item.match(/^(?:([^：:]+)[：:])?\s*SAN-(\d+)\/(\d*D\d+)$/i);
        if (san2) {
          const target2 = (san2[1] || "").trim();
          const succLoss = parseInt(san2[2], 10);
          const failExpr2 = san2[3];
          const sanCheckVal = Math.min(99, typeof save.san === "number" ? save.san : (save.playerStats?.san ?? 99));
          const chk = rollD100(sanCheckVal, is7th ? "coc7" : "coc6");
          const pass = chk.level !== "fail" && chk.level !== "fumble";
          const lost2 = pass ? succLoss : rollExpr(failExpr2, "0").total;
          pushMessages({ id: mkId(), type: "system", text: `🧠 理智检定 D100=${chk.roll}（SAN ${sanCheckVal}）→ ${pass ? "成功" : "失败"} → ${target2 ? `${target2}:` : ""}SAN-${lost2}` });
          if (!target2) {
            sanChange -= lost2;
          } else {
            updatedAgents = updatedAgents.map(a => {
              const ch = characters.find(c => c.id === a.characterId);
              if (ch?.name === target2) return { ...a, san: Math.max(0, (typeof a.san === "number" ? a.san : 99) - lost2) };
              return a;
            });
          }
          continue;
        }
        const m = item.match(lossPattern);
        if (m && (m[2] === "HP" || m[2] === "hp")) {
          // HP loss: "HP-15" or "小雪:HP-10"
          const target = m[1] || "";
          const delta = parseInt(m[3] || "0");
          if (!target) {
            hpChange += delta;
          } else {
            updatedAgents = updatedAgents.map(a => {
              const ch = characters.find(c => c.id === a.characterId);
              if (ch?.name === target) return { ...a, hp: Math.max(0, a.hp + delta) };
              return a;
            });
          }
        } else if (m && (m[2] === "SAN" || m[2] === "san")) {
          // SAN loss: "SAN-5" or "小雪:SAN-3" (CoC6 sanity)
          const target = m[1] || "";
          const delta = parseInt(m[3] || "0");
          if (!target) {
            sanChange += delta;
          } else {
            updatedAgents = updatedAgents.map(a => {
              const ch = characters.find(c => c.id === a.characterId);
              if (ch?.name === target) return { ...a, san: Math.max(0, (typeof a.san === "number" ? a.san : 99) + delta) };
              return a;
            });
          }
        } else if (m && statNameMap[m[2]]) {
          // Stat loss: "体质-5" or "小雪:力量-3"
          const target = m[1] || "";
          const stat = statNameMap[m[2]] as import("@/lib/map-types").StatKey;
          const delta = parseInt(m[3] || "0");
          if (!target) {
            (newPlayerStats as Record<string, number>)[stat] = Math.max(1, (newPlayerStats[stat] || 50) + delta);
            pushMessages({ id: mkId(), type: "system", text: `${STAT_LABELS[stat]} ${delta}` });
          } else {
            updatedAgents = updatedAgents.map(a => {
              const ch = characters.find(c => c.id === a.characterId);
              if (ch?.name === target) return { ...a, stats: { ...a.stats, [stat]: Math.max(1, (a.stats[stat] || 50) + delta) } };
              return a;
            });
          }
        } else {
          lostItems.push(item);
        }
      }
      // Apply HP change
      const newHp = hpChange ? Math.max(0, save.hp + hpChange) : save.hp;
      if (hpChange) pushMessages({ id: mkId(), type: "system", text: `HP ${hpChange}（${save.hp}→${newHp}）` });
      // Apply SAN change + CoC6 madness check
      if (sanChange) {
        const sanBefore = newSan;
        newSan = Math.max(0, newSan + sanChange);
        pushMessages({ id: mkId(), type: "system", text: `SAN ${sanChange}（理智降至 ${newSan}）` });
        const verdict = sanityLossVerdict(Math.abs(sanChange), sanBefore);
        const madness = newSaveMadness(sanBefore, verdict, newSan);
        if (madness.temporary) {
          pushMessages({ id: mkId(), type: "system", text: `🌀 SAN单场损失≥5 —— 临时疯狂发作：${madness.temporary.symptom}（持续 ${madness.temporary.rounds} 轮）` });
          save.madness = madness.raw;
        } else if (madness.permanent) {
          pushMessages({ id: mkId(), type: "system", text: `💀 SAN归零 —— 永久疯狂。${playerName}的心智永远地碎裂了。` });
          save.madness = madness.raw;
        }
      }
      if (lostItems.length) updatedDirector.keyItems = updatedDirector.keyItems.filter(i => !lostItems.includes(i));
      if (ev.npcsInvolved?.length) updatedDirector.keyNpcsMet = [...new Set([...updatedDirector.keyNpcsMet, ...ev.npcsInvolved])];

      // Gained/lost system messages
      if (ev.gained?.length) pushMessages({ id: mkId(), type: "system", text: `获得：${ev.gained.join("、")}` });
      if (lostItems.length) pushMessages({ id: mkId(), type: "system", text: `失去：${lostItems.join("、")}` });

      const newJournal = [...saveRef.current.journal];
      if (ev.journalEntry) {
        newJournal.push({
          id: `j_${Date.now()}`, timestamp: formatGameTime(save.gameDay, save.gameTime),
          realTime: new Date().toISOString(), locationName: currentNode?.name || "",
          text: ev.journalEntry, type: activeEventMeta?.type === "main_quest" ? "main" : "side",
        });
      }

      // Handle position change from DM
      let newNodeId = save.currentNodeId;
      let newNodeType = save.currentNodeType;
      let newDiscovered = [...new Set([...save.discoveredNodes, ...(ev.unlocks || [])])];

      // Unified move_to handling: string = everyone moves; object = per-person
      const fuzzyNode = (name: string) =>
        allNodes.find(n => n.name === name)
        || allNodes.find(n => n.name.includes(name))
        || allNodes.find(n => name.includes(n.name));

      const discoverNode = (nodeId: string) => {
        if (!newDiscovered.includes(nodeId)) newDiscovered.push(nodeId);
        for (const n of allNodes) {
          if (n.regionIdx === allNodes.find(x => x.id === nodeId)?.regionIdx && !newDiscovered.includes(n.id)) {
            newDiscovered.push(n.id);
          }
        }
      };

      const moveAgent = (charName: string, destName: string) => {
        const destNode = fuzzyNode(destName);
        if (!destNode) return;
        updatedAgents = updatedAgents.map(a => {
          const ch = characters.find(c => c.id === a.characterId);
          if (ch?.name === charName) {
            return { ...a, currentNodeId: destNode.id, currentNodeType: destNode.type, discoveredNodes: [...new Set([...a.discoveredNodes, destNode.id])] };
          }
          return a;
        });
        discoverNode(destNode.id);
      };

      const rawMoveTo = ev.moveTo;
      if (rawMoveTo && typeof rawMoveTo === "string") {
        // String: everyone moves to the same place
        const targetNode = fuzzyNode(rawMoveTo);
        if (targetNode) {
          newNodeId = targetNode.id;
          newNodeType = targetNode.type;
          discoverNode(targetNode.id);
          pushMessages({ id: mkId(), type: "location", text: `你来到了 ${targetNode.name}` });
          // All agents follow
          for (const a of updatedAgents) {
            const ch = characters.find(c => c.id === a.characterId);
            if (ch) moveAgent(ch.name, rawMoveTo);
          }
        }
      } else if (rawMoveTo && typeof rawMoveTo === "object") {
        // Object: per-person moves
        for (const [who, destName] of Object.entries(rawMoveTo as Record<string, string>)) {
          if (who === "你" || who === (userIdentity?.name || "玩家")) {
            // Player
            const targetNode = fuzzyNode(destName);
            if (targetNode) {
              newNodeId = targetNode.id;
              newNodeType = targetNode.type;
              discoverNode(targetNode.id);
              pushMessages({ id: mkId(), type: "location", text: `你来到了 ${targetNode.name}` });
            }
          } else {
            // Agent
            moveAgent(who, destName);
          }
        }
      }

      const newSave: GameSave = {
        ...save,
        ...(nextCurrentAct !== undefined ? { currentAct: nextCurrentAct } : {}),
        currentNodeId: newNodeId,
        currentNodeType: newNodeType,
        hp: newHp,
        san: newSan,
        madness: save.madness,
        playerStats: newPlayerStats,
        agents: updatedAgents,
        director: updatedDirector,
        journal: newJournal,
        keyChoices: actionText ? [...save.keyChoices, actionText] : save.keyChoices,
        mainQuestStage: ev.advanceMainQuest ? Math.min(save.mainQuestStage + 1, skeleton.mainQuest.stages.length) : save.mainQuestStage,
        discoveredNodes: newDiscovered,
        visitedNodes: newNodeId !== save.currentNodeId ? [...new Set([...save.visitedNodes, newNodeId])] : save.visitedNodes,
        timestamp: new Date().toISOString(),
      };
      persistSave(newSave);

      // ── Death check: HP=0 → show death dialog ──
      if (newHp <= 0) {
        pushMessages({ id: mkId(), type: "system", text: "你倒下了..." });
        setShowDeathDialog(true);
        setInEvent(false);
        setCurrentChoices(null); setCurrentTopics(null);
        setActiveEvent(null);
        setActiveEventMeta(null);
        setAccumulatedEvent(null);
        if (false) {
          // dead code to preserve original block structure
        }
        return;
      }

      // ── Ending check: DM decides ending ──
      if ((continuation as { ending?: boolean }).ending) {
        pushMessages({ id: mkId(), type: "system", text: "—— 主线完成 ——" });
        pushSceneToStream(continuation);
        persistSave({ ...newSave, completed: true });
        setInEvent(false);
        setCurrentChoices(null); setCurrentTopics(null);
        setActiveEvent(null);
        setActiveEventMeta(null);
        setAccumulatedEvent(null);
        // Generate ending (async)
        try {
          let dmCtxForEnding: import("@/lib/map-rpg-engine").DMContext;
          try { dmCtxForEnding = JSON.parse(eventContext); } catch { dmCtxForEnding = { worldLore: skeleton.world.lore, currentLocation: currentNode?.name || "", eventType: "", eventBrief: "", companionNames: [], recentJournal: save.journal.map(j => j.text), keyChoices: save.keyChoices, gameTime: formatGameTime(save.gameDay, save.gameTime) }; }
          dmCtxForEnding.director = newSave.director;
          dmCtxForEnding.recentJournal = newSave.journal.map(j => j.text);
          dmCtxForEnding.lockedLogSummary = lockedLogRef.current.map(e => `${e.day} · ${e.who} 与 ${e.npc || "某人"}私下交谈：${e.text}`);
          const ending = await generateEnding(dmCtxForEnding, apiConfig);
          setEndingData(ending);
          setEndingStep(0);
          // Fork: 后日谈——全员以本人身份闲聊吐槽这个模组（结局卡内展示，不进主消息流）
          setAfterTalkLoading(true);
          try {
            const dmCtxForAT: import("@/lib/map-rpg-engine").DMContext = { ...dmCtxForEnding, recentJournal: saveRef.current.journal.map(j => j.text) };
            const at = await generateAfterTalk(dmCtxForAT, apiConfig, saveRef.current.agents.map(a => charName(a.characterId)));
            setAfterTalk(at.lines);
            // Fork: 后日谈同步落进皮下吐槽面板（OOC 持久化，合上结局卡后仍可回看）
            if (at.lines.length) {
              pushMessages({ id: mkId(), type: "system", text: "🎬 后日谈已收录——见顶部「🎤 皮下吐槽」面板" });
              for (const l of at.lines) {
                const m: StreamMessage = { id: mkId(), type: "ooc", speaker: l.speaker, text: l.text };
                pushMessages(m);
                streamRef.current = [...streamRef.current, m];
              }
            }
          } catch { /* after-talk is best-effort */ }
          setAfterTalkLoading(false);
          // Final summary on game completion — use auxiliary API
          const endSummaryApi = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || apiConfig;
          generateAdventureSummary(newSave, skeleton.world.name, endSummaryApi).catch(() => undefined);
        } catch (e) {
          pushMessages({ id: mkId(), type: "system", text: `结局生成失败：${e instanceof Error ? e.message : String(e)}` });
        }
        return;
      }

      // Fork 八期B: KP-directed side scenes → locked log (reveal at ending)
      let sideSceneEntries: NonNullable<GameSave["lockedLog"]> = [];
      {
        const ss = ((continuation as EventScene & { sideScenes?: { who: string; npc: string; intent?: string; summary?: string }[] }).sideScenes || []);
        const sc = ss[0];
        if (sc) {
          const dayLabel = formatGameTime(newSave.gameDay, newSave.gameTime);
          const me = userIdentity?.name || "你";
          const entry = { id: `lock_${Date.now()}`, who: sc.who, npc: sc.npc, text: sc.summary || sc.intent || "（一场无人知晓的交谈）", day: dayLabel };
          // Push to user stream only if the user was part of it
          if (sc.who === me) {
            pushMessages({ id: mkId(), type: "narration", text: `🔒〔私聊·只有你和${sc.npc}在场〕${entry.text}`, audience: ["locked"] });
          }
          lockedLogRef.current = [...lockedLogRef.current, entry];
          sideSceneEntries = [...sideSceneEntries, entry];
        }
      }
      // Fork: 私聊幕若演的是 HO 个人线事件 → 事件摘要记入划账总账（KP 不重演）
      if (ev.revealed?.length) { /* already merged above */ }
      else {
        const hoOwner = save.investigatorLines?.length ? (Object.entries(save.boundLineHo || {}).find(([, ho]) => {
          const line = save.investigatorLines?.find(l => l.ho === ho);
          return line?.events.some(e => e.summary.slice(0, 15) === (sideSceneEntries[0]?.text || "").slice(0, 15));
        })?.[0]) : undefined;
        if (hoOwner && sideSceneEntries[0]) {
          const mergedHo = [...new Set([...(save.revealedDossier || []), sideSceneEntries[0].text])];
          save = { ...save, revealedDossier: mergedHo };
        }
      }
      // Fork: archive clues from this resolve round + investigation-done hint + time ticks
      {
        const resolveClues = ((continuation as EventScene & { clues?: string[] }).clues || []).filter(Boolean);
        if (resolveClues.length) {
          pushMessages({ id: mkId(), type: "system", text: `🗂 线索归档：${resolveClues.join("；")}` });
        }
        if ((continuation as EventScene & { investigationDone?: boolean }).investigationDone) {
          pushMessages({ id: mkId(), type: "system", text: "🔎 本地点的调查已告一段落——考虑转移地点" });
        }
        const ticks = (save.timeTicks || 0) + 1;
        let timedSave = newSave;
        if (sideSceneEntries.length) timedSave = { ...timedSave, lockedLog: [...(timedSave.lockedLog || []), ...sideSceneEntries] };
        if (ticks >= 4) {
          const adv = advanceTime(save.gameTime, 1);
          const timeLabel: Record<string, string> = { morning: "清晨", afternoon: "午后", evening: "黄昏", night: "夜晚" };
          pushMessages({ id: mkId(), type: "system", text: `🌗 ${adv.newDay ? "新的一天开始了。" : ""}时间流逝——现在已是${timeLabel[adv.time]}（第${adv.newDay ? newSave.gameDay + 1 : newSave.gameDay}天）` });
          timedSave = { ...timedSave, gameTime: adv.time, gameDay: adv.newDay ? newSave.gameDay + 1 : newSave.gameDay, timeTicks: 0 };
        } else {
          timedSave = { ...timedSave, timeTicks: ticks };
        }
        if (resolveClues.length) {
          const locName = currentNode?.name || "未知地点";
          const dayLabel = formatGameTime(newSave.gameDay, newSave.gameTime);
          timedSave = { ...timedSave, clues: [...(timedSave.clues || []), ...resolveClues.map((c, i) => ({ id: `clue_${Date.now()}_r${i}`, location: locName, text: c, day: dayLabel }))] };
        }
        persistSave(timedSave);
      }

      // Fork 拆场: split the narration by 【场：地点】sections — the player's scene goes to the
      // main stream (scene-tagged), off-screen scenes become 🔒 locked entries (each member gets
      // their own record → memoryHint next round; others stay blind until the ending reveal).
      // Runs BEFORE the persist block below so locked entries survive the save.
      if (splitGroups.length > 1 && continuation.dialogues[0]?.speaker === "narrator") {
        const rawNarration = continuation.dialogues[0].text;
        const segs = rawNarration.split(/(?=【场[：:])/g).map(s => s.trim()).filter(Boolean);
        if (segs.length > 1) {
          const mySegs: string[] = [];
          for (const seg of segs) {
            const m = seg.match(/^【场[：:](.+?)[】\]]/);
            const segLoc = m ? m[1] : "";
            const isMine = !segLoc || segLoc.includes(myLocationName) || myLocationName.includes(segLoc);
            if (isMine) { mySegs.push(seg); continue; }
            // off-screen scene → one locked entry per member (memoryHint matches by exact name)
            const grp = splitGroups.find(g => segLoc.includes(g.where) || g.where.includes(segLoc));
            const members = grp?.members.filter(x => x !== "{{user}}") || [];
            for (const mem of members.length ? members : ["离队者"]) {
              const entry = { id: `lock_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`, who: mem, npc: segLoc, text: seg, day: formatGameTime(save.gameDay, save.gameTime) };
              lockedLogRef.current = [...lockedLogRef.current, entry];
              sideSceneEntries.push(entry);
            }
            pushMessages({ id: mkId(), type: "narration", text: `🔒〔另一场 · ${segLoc}〕${members.join("、") || "有人"} 独自经历了什么——结局揭晓前无人知晓`, audience: ["locked"] });
          }
          continuation.dialogues[0] = { ...continuation.dialogues[0], text: mySegs.join("\n\n") || "（你所在之处暂时平静。）" };
        }
      }

      // Fork 十期: fire cues from the resolve round too
      fireStageCues(continuation as EventScene & { cg?: string; bgm?: string });

      // Push DM continuation to stream (player's scene carries an audience tag in split rounds —
      // companions elsewhere can't see it in their context)
      if (continuation.dialogues.length > 0) {
        pushSceneToStream(continuation, splitGroups.length > 1 ? `scene:${myLocationName}` : undefined);
        setActiveEvent(continuation);
        // Include companion declarations in accumulated dialogue for next round context
        const declDialogues = companionDecls.map(d => ({ speaker: d.speaker, text: `${d.speech}（${d.action}）`, emotion: d.emotion }));
        setAccumulatedEvent(prev => prev ? {
          ...prev,
          dialogues: [...prev.dialogues, { speaker: playerName, text: actionText, emotion: "neutral" }, ...declDialogues, ...continuation.dialogues],
          choices: continuation.choices,
        } : continuation);
        setEventContext(JSON.stringify(dmCtx));

        if (continuation.choices && continuation.choices.length > 0) {
          setCurrentChoices(continuation.choices);
          const contTopics = (continuation as EventScene & { topics?: { label: string; skillHint?: string }[] }).topics;
          setCurrentTopics(contTopics && contTopics.length > 0 ? contTopics : null);
          setLastFailedAction(null); setCompletedCompanions([]); // success — clear pending action
          setTimeout(() => inputRef.current?.focus(), 200);
        } else {
          // Event finished — run growth roll
          setLastFailedAction(null);          pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
          const grownSave = runGrowthRollRef.current(newSave, [...usedSkillsRef.current]);
          if (grownSave !== newSave) persistSave(grownSave);
          setCurrentChoices(null); setCurrentTopics(null);
          setInEvent(false);
          setActiveEvent(null);
          setActiveEventMeta(null);
          setAccumulatedEvent(null);
        }
      } else {
        // Event finished — run growth roll
        pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
        const grownSave = runGrowthRoll(newSave, [...usedSkillsRef.current]);
        if (grownSave !== newSave) persistSave(grownSave);
        setCurrentChoices(null); setCurrentTopics(null);
        setInEvent(false);
        setActiveEvent(null);
        setActiveEventMeta(null);
        setAccumulatedEvent(null);
      }
    } catch (e) {
      console.warn("[MapView] Event action error:", e);
      pushMessages({ id: mkId(), type: "system", text: `发生错误：${e instanceof Error ? e.message : String(e)}` });
      setLastFailedAction(actionText);
    } finally {
      setEventContinueLoading(false);
      setLoadingPhase("");
      // Auto-summary check (fire-and-forget)
      const latestSave = saveRef.current;
      if (shouldAutoSummarize(latestSave)) {
        const summaryApi = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || loadApiConfigs().find(c => c.apiKey);
        if (summaryApi?.apiKey) {
          generateAdventureSummary(latestSave, skeleton.world.name, summaryApi).catch(() => undefined);
        }
      }
    }
  }, [eventContext, accumulatedEvent, save, currentNode, activeEventMeta, persistSave, allNodes, characters, pushMessages, pushSceneToStream, userIdentity, skeleton, is7th]);

  // ── Growth roll ref (defined below, used by handlePlayerAction) ──
  const runGrowthRollRef = useRef<(s: GameSave, skills?: string[]) => GameSave>((s) => s);
  // Skills used during the current event (ref so growth roll after resolve can read them)
  const usedSkillsRef = useRef<Set<string>>(new Set());
  // Fork: dice pre-rolled in submitDeclarationWithCheck → rides on the player declCard
  const pendingPlayerDiceRef = useRef<{ skill: string; value: number; roll: number; level: string; detail?: string } | undefined>(undefined);
  // Fork: skills that already failed this scene (soft re-roll guard → pushed check / KP adjudication)
  const failedSkillsRef = useRef<Set<string>>(new Set());
  // Fork 八期B: locked private-talk log (in-memory mirror of save.lockedLog; reveal at ending)
  const lockedLogRef = useRef<{ id: string; who: string; npc?: string; text: string; day: string }[]>(save.lockedLog || []);

  // ── CoC6 madness builder (helper) ──
  const newSaveMadness = (sanBefore: number, verdict: { temporaryMadness: boolean; goneInsane: boolean }, sanAfter: number): { temporary?: { rounds: number; symptom: string }; permanent?: boolean; raw: GameSave["madness"] } => {
    const base = save.madness || { phobias: [], log: [] };
    if (verdict.goneInsane) {
      return { permanent: true, raw: { ...base, permanent: true, log: [...base.log, { day: formatGameTime(save.gameDay, save.gameTime), text: `SAN归零，永久疯狂` }] } };
    }
    if (verdict.temporaryMadness) {
      const rounds = Math.floor(Math.random() * 10) + 1;
      const symptom = rollTemporaryMadness();
      return {
        temporary: { rounds, symptom },
        raw: { ...base, temporary: { rounds, symptom }, log: [...base.log, { day: formatGameTime(save.gameDay, save.gameTime), text: `临时疯狂：${symptom}` }] },
      };
    }
    return { raw: base };
  };

  // ── Growth roll — CoC6 style: for each skill used this event, roll D100 > skill → +1D10 ──
  const runGrowthRoll = useCallback((currentSave: GameSave, skills?: string[]): GameSave => {
    const used = skills && skills.length > 0 ? skills : (currentSave.checkedSkills || []);
    if (used.length === 0) return currentSave;

    const newSheet = currentSave.playerSheet ? { ...currentSave.playerSheet, skills: { ...currentSave.playerSheet.skills } } : undefined;
    const growthMessages: string[] = [];
    const noGrowMessages: string[] = [];

    if (newSheet) {
      for (const skillName of used) {
        const current = newSheet.skills[skillName];
        if (typeof current !== "number") continue; // attribute fallback or base-only skill — no growth track
        const roll = Math.floor(Math.random() * 100) + 1;
        if (roll > current) {
          const gain = Math.floor(Math.random() * 10) + 1;
          const newVal = Math.min(99, current + gain);
          newSheet.skills[skillName] = newVal;
          growthMessages.push(`${skillName} ${current}→${newVal} (+${gain})`);
        } else {
          noGrowMessages.push(skillName);
        }
      }
    }

    if (growthMessages.length > 0) {
      pushMessages({
        id: mkId(), type: "system",
        text: `📈 技能成长：${growthMessages.join("、")}`,
      });
    }
    if (noGrowMessages.length > 0) {
      pushMessages({
        id: mkId(), type: "system",
        text: `技能成长 roll 未通过：${noGrowMessages.join("、")}`,
      });
    }

    return { ...currentSave, playerSheet: newSheet, checkedSkills: [] };
  }, [pushMessages]);
  runGrowthRollRef.current = runGrowthRoll;

  // ── CoC6 combat round actions ──
  const startCombat = useCallback((hostiles: { name: string; dex: number; hp: number; notes?: string }[]) => {
    if (hostiles.length === 0) return;
    const initiative = buildInitiative(
      save.playerStats.dex,
      save.agents.map(a => ({ characterId: a.characterId, dex: a.stats.dex })),
      hostiles.map(h => ({ name: h.name, dex: h.dex })),
    );
    const startIdx = initiative.findIndex(t => t === "player");
    const combat: GameSave["combat"] = {
      round: 1,
      initiative,
      currentIndex: 0,
      hostiles,
      hostileIndex: startIdx >= 0 ? startIdx : 0,
      playerDamageDealt: {},
    };
    persistSave({ ...save, combat });
    setCombatOpen(false);
    pushMessages({ id: mkId(), type: "system", text: `⚔️ 战斗开始！先攻顺序：${initiative.map(tokenLabel).join(" → ")}` });
  }, [save, persistSave, pushMessages, characters, userIdentity]);

  /** Apply damage to a hostile, advance turn after each action. */
  const dealDamageToHostile = useCallback((hostileName: string, dmg: number) => {
    if (!save.combat || save.combat.ended) return;
    const combat = { ...save.combat, hostiles: save.combat.hostiles.map(h => h.name === hostileName ? { ...h, hp: Math.max(0, h.hp - dmg) } : h) };
    const dead = combat.hostiles.find(h => h.name === hostileName && h.hp <= 0);
    if (dead) {
      pushMessages({ id: mkId(), type: "system", text: `☠️ ${hostileName} 倒下了` });
      combat.initiative = combat.initiative.filter(t => t !== `hostile:${hostileName}`);
      if (combat.currentIndex >= combat.initiative.length) combat.currentIndex = 0;
    }
    const anyAlive = combat.hostiles.some(h => h.hp > 0);
    if (!anyAlive) {
      combat.ended = true;
      pushMessages({ id: mkId(), type: "system", text: "⚔️ 战斗结束" });
      persistSave({ ...save, combat });
      return;
    }
    persistSave({ ...save, combat });
  }, [save, persistSave, pushMessages]);

  /** Advance to next actor; wrap → round+1. */
  const advanceCombatTurn = useCallback(() => {
    if (!save.combat || save.combat.ended) return;
    const combat = { ...save.combat };
    // Temporary madness counts down per round
    const madness = save.madness;
    let roundIncr = false;
    combat.currentIndex += 1;
    if (combat.currentIndex >= combat.initiative.length) {
      combat.currentIndex = 0;
      combat.round += 1;
      roundIncr = true;
    }
    if (roundIncr && madness?.temporary) {
      const roundsLeft = madness.temporary.rounds - 1;
      const updatedMadness = roundsLeft <= 0
        ? { ...madness, temporary: undefined }
        : { ...madness, temporary: { ...madness.temporary, rounds: roundsLeft } };
      persistSave({ ...save, combat, madness: updatedMadness });
      if (roundsLeft <= 0) pushMessages({ id: mkId(), type: "system", text: `🌀 临时疯狂症状缓解，${userIdentity?.name || "你"}恢复了自控` });
      return;
    }
    persistSave({ ...save, combat });
  }, [save, persistSave, pushMessages, userIdentity]);

  const endCombat = useCallback(() => {
    if (!save.combat) return;
    persistSave({ ...save, combat: { ...save.combat, ended: true } });
    pushMessages({ id: mkId(), type: "system", text: "⚔️ 战斗结束（手动）" });
  }, [save, persistSave, pushMessages]);

  // ── CoC6 support checks: first aid / sanity recovery / psychoanalysis ──
  const runSupportCheck = useCallback((skillName: "急救" | "意志" | "精神分析") => {
    const playerName2 = userIdentity?.name || "你";
    const candidates: { name: string; val: number; isPlayer: boolean }[] = [
      { name: playerName2, val: skillCheckValue(save.playerSheet, skillName, save.playerStats).value, isPlayer: true },
      ...save.agents.map(a => ({ name: charName(a.characterId), val: skillCheckValue(a.sheet, skillName, a.stats).value, isPlayer: false })),
    ];
    const best = [...candidates].sort((a, b) => b.val - a.val)[0];
    const r = rollD100(best.val, is7th ? "coc7" : "coc6");
    const levelLabel = r.level === "crit" ? "大成功" : r.level === "hard" ? "困难成功" : r.level === "success" ? "成功" : r.level === "fumble" ? "大失败" : "失败";
    const success = r.level !== "fail" && r.level !== "fumble";

    // Effects per CoC6
    let effectText = "";
    const newSave = { ...save };
    if (skillName === "急救") {
      if (success) {
        const heal = r.level === "crit" ? 3 : 1;
        newSave.hp = Math.min(newSave.maxHp, newSave.hp + heal);
        effectText = `HP +${heal}（${newSave.hp}/${newSave.maxHp}）`;
      } else effectText = "止血失败，伤势未好转";
    } else if (skillName === "意志") {
      // sanity recovery attempt (CoC6: success → SAN+1d6; simplified per check)
      if (success) {
        const gain = Math.floor(Math.random() * 6) + 1;
        const sanBefore = typeof newSave.san === "number" ? newSave.san : newSave.playerStats.san;
        newSave.san = Math.min(99, sanBefore + gain);
        effectText = `SAN +${gain}（理智回升至 ${newSave.san}）`;
      } else effectText = "未能平复心绪";
    } else if (skillName === "精神分析") {
      // psychoanalysis: success → SAN +1d3; can also calm temporary madness
      if (success) {
        const gain = Math.floor(Math.random() * 3) + 1;
        const sanBefore = typeof newSave.san === "number" ? newSave.san : newSave.playerStats.san;
        newSave.san = Math.min(99, sanBefore + gain);
        let extra = "";
        if (newSave.madness?.temporary) {
          newSave.madness = { ...newSave.madness, temporary: undefined };
          extra = "，临时疯狂被安抚";
        }
        effectText = `SAN +${gain}（理智回升至 ${newSave.san}）${extra}`;
      } else effectText = "对方仍困在自己的恐惧里";
    }
    persistSave(newSave);
    const msg: StreamMessage = { id: mkId(), type: "roll", speaker: `🤝 ${skillName} · ${best.name}（${skillName}${best.val}）`, text: `D100 = ${r.roll} → ${levelLabel} → ${effectText}`, emotion: success ? "success" : "fail" };
    pushMessages(msg);
    streamRef.current = [...streamRef.current, msg];
  }, [save, persistSave, pushMessages, userIdentity, characters, is7th]);

  // ── Handle event exit — send as player action so DM knows ──
  const handleEventExit = useCallback(async () => {
    const playerName = userIdentity?.name || "你";
    const exitMsg: StreamMessage = { id: mkId(), type: "narration", text: `${playerName}：决定离开，不再继续当前事件。` };
    pushMessages(exitMsg);
    streamRef.current = [...streamRef.current, exitMsg];
    setCurrentChoices(null); setCurrentTopics(null);

    // Let companions react to the exit decision
    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      const firstCharId = save.agents[0]?.characterId || characters[0]?.id || "";
      const slot = firstCharId ? resolveBinding(bindings, firstCharId, "adventure") : null;
      const apiConfig = (slot?.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];

      if (apiConfig?.apiKey) {
        const companionIds = save.agents.map(a => a.characterId);
        if (companionIds.length > 0) {
          setEventContinueLoading(true);
          setLoadingPhase("companions");
          const exitReactionInstruction = "{{user}}刚才决定离开当前事件，不再继续。请以你的身份回应{{user}}的离开：你会说什么、有什么反应、接下来是否跟随/挽留/沉默旁观。";
          const decls = await Promise.all(
            companionIds.map(cid => companionDeclare(
              cid,
              apiConfig,
              sceneWallFilter(cid),
              save.agents.length > 1 ? userIdentity : undefined,
              save.agents.find(a => a.characterId === cid)?.affinity,
              { instruction: exitReactionInstruction, secretHint: save.agentSecrets?.[cid] ? `【你的秘密】${save.agentSecrets[cid].content}——是否透露、何时摊牌由你决定。` : undefined, personaHint: save.agents.find(a => a.characterId === cid)?.persona ? `【你的模组内人设】${save.agents.find(a => a.characterId === cid)!.persona!.occupation}——${save.agents.find(a => a.characterId === cid)!.persona!.background}（言行物品须属该时代）` : undefined },
            ))
          );
          for (const decl of decls) {
            if (decl.speech && decl.speech !== "……") {
              pushMessages({ id: mkId(), type: "character", speaker: decl.speaker, text: decl.speech, emotion: decl.emotion });
            }
          }
          setEventContinueLoading(false);
          setLoadingPhase("");
        }
      }
    } catch { /* ignore errors on exit */ }

    // Exit event
    pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
    setInEvent(false);
    setActiveEvent(null);
    setActiveEventMeta(null);
    setAccumulatedEvent(null);
    setLastFailedAction(null);  }, [save, characters, userIdentity, pushMessages]);

  // ── Handle choice click — if statCheck, everyone rolls, then proceed ──
  const handleChoiceClick = useCallback(async (choice: EventChoice) => {
    if (!choice.statCheck) {
      handlePlayerAction(choice.label);
      return;
    }

    // CoC6: resolve check to trained skill value (preferred) or attribute fallback
    const checkName = choice.statCheck.stat;
    const playerCheck = skillCheckValue(save.playerSheet, checkName, save.playerStats);
    const label = playerCheck.source;
    const statKey = resolveCheckStat(checkName).key; // kept for animation/legacy display
    const usedSkills = new Set<string>(save.checkedSkills || []);
    const rollResults: string[] = [];

    // Helper: run dice overlay for one person
    const rollFor = async (name: string, statValue: number, isPlayer: boolean): Promise<{ roll: number; level: string; detail?: string }> => {
      setDiceOverlay({ name, stat: statKey, statValue, context: choice.label, label, isPlayer });
      setDiceNumber(0);
      setDiceRolling(false);

      if (isPlayer) {
        setDiceWaitingClick(true);
        await new Promise<void>(resolve => {
          diceResolveRef.current = (() => { setDiceWaitingClick(false); resolve(); }) as unknown as (r: { roll: number; level: string }) => void;
        });
      } else {
        await new Promise<void>(resolve => setTimeout(resolve, 800));
      }

      setDiceRolling(true);
      return new Promise<{ roll: number; level: string; detail?: string }>(resolve => {
        const interval = setInterval(() => setDiceNumber(Math.floor(Math.random() * 100) + 1), 80);
        setTimeout(() => {
          clearInterval(interval);
          const r = is7th && diceMode !== "none" ? rollD100WithDice(statValue, diceMode, "coc7") : rollD100(statValue, is7th ? "coc7" : "coc6");
          setDiceNumber(r.roll);
          setDiceRolling(false);
          setTimeout(() => { setDiceOverlay(null); setDiceNumber(0); resolve(r); }, 1200);
        }, 1000);
      });
    };

    // Determine who rolls — value comes from each person's own sheet (trained skill > base > attribute)
    const playerName = userIdentity?.name || "你";
    const candidates: { name: string; statValue: number; isPlayer: boolean }[] = [
      { name: playerName, statValue: playerCheck.value, isPlayer: true },
    ];
    for (const a of save.agents) {
      const ch = characters.find(c => c.id === a.characterId);
      if (ch) candidates.push({ name: ch.name, statValue: skillCheckValue(a.sheet, checkName, a.stats).value, isPlayer: false });
    }

    let chosen: typeof candidates[0];
    const specifiedWho = choice.statCheck!.who;

    if (specifiedWho === "best") {
      // Fork: support-check convention — the party member with the highest check value rolls
      chosen = [...candidates].sort((a, b) => b.statValue - a.statValue)[0];
      const pickerMsg: StreamMessage = { id: mkId(), type: "system", text: `🎲 ${checkName} 由队伍中数值最高者掷骰：${chosen.name}（${chosen.statValue}）` };
      pushMessages(pickerMsg);
      streamRef.current = [...streamRef.current, pickerMsg];
    } else if (specifiedWho) {
      // DM specified who rolls
      chosen = candidates.find(c =>
        specifiedWho === "你" ? c.isPlayer : c.name === specifiedWho
      ) || candidates[0];
      const pickerMsg: StreamMessage = { id: mkId(), type: "system", text: `🎲 ${chosen.name} 掷骰` };
      pushMessages(pickerMsg);
      streamRef.current = [...streamRef.current, pickerMsg];
    } else if (candidates.length === 1) {
      // Only one person, no need to pick
      chosen = candidates[0];
    } else {
      // Fork: CoC loop — the player's own check rolls themselves (who omitted = the player who declared).
      // Random pick animation removed: everyone declares & rolls their own checks now.
      chosen = candidates[0]; // player
      const rpMsg: StreamMessage = { id: mkId(), type: "system", text: `🎲 本次检定由 ${chosen.name} 掷骰（同伴的检定由他们自己宣言时掷）` };
      pushMessages(rpMsg);
      streamRef.current = [...streamRef.current, rpMsg];
    }

    // Record skill usage for growth roll (strip conversion suffix like 侦查(智力))
    if (playerCheck.source) {
      usedSkills.add(playerCheck.source.replace(/（异象）|\(基础\)/, "").replace(/\(.*\)$/, ""));
      usedSkillsRef.current.add(playerCheck.source.replace(/（异象）|\(基础\)/, "").replace(/\(.*\)$/, ""));
    }

    // Roll
    const result = await rollFor(chosen.name, chosen.statValue, chosen.isPlayer);
    const success = result.level !== "fail" && result.level !== "fumble";
    const levelLabel = result.level === "crit" ? "大成功！" : result.level === "hard" ? "困难成功" : result.level === "success" ? "成功" : result.level === "fumble" ? "大失败！" : "失败";
    const rollMsg: StreamMessage = { id: mkId(), type: "roll", speaker: `${chosen.name} · ${choice.label}（${label} ${chosen.statValue}）`, text: `D100 = ${result.roll}${result.detail ? ` ${result.detail}` : ""} → ${levelLabel}`, emotion: success ? "success" : "fail" };
    pushMessages(rollMsg);

    // CoC6 combat: weapon-skill checks auto-resolve damage (attack vs dodge, DB applied)
    const weapon = save.playerSheet?.weapons?.find(w => w.skill === checkName) || null;
    if (weapon && success && chosen.isPlayer) {
      const db = dbFromStats(save.playerStats);
      // Hostile dodge value unknown — let KP decide dodge via narration; use a modest 30 for auto-resolution
      const atk = resolveAttack(chosen.statValue, weapon.name, weapon.damage, db, 30, "敌方");
      if (atk.dodged) {
        const missMsg: StreamMessage = { id: mkId(), type: "system", text: `⚔️ ${chosen.name}以${weapon.name}攻击 → 对方闪避成功，未造成伤害` };
        pushMessages(missMsg);
        streamRef.current = [...streamRef.current, missMsg];
      } else {
        const dmgMsg: StreamMessage = { id: mkId(), type: "system", text: `⚔️ ${chosen.name}以${weapon.name}命中（${atk.attackLevel === "crit" ? "大成功·贯穿" : LEVEL_LABEL[atk.attackLevel as RollLevel]}）：伤害 ${atk.damage}（${atk.damageDetail || "—"}）` };
        pushMessages(dmgMsg);
        streamRef.current = [...streamRef.current, dmgMsg];
      }
    }
    // Manually sync ref so companionDeclare sees the roll result (pushMessages is async setState)
    streamRef.current = [...streamRef.current, rollMsg];
    rollResults.push(`${chosen.name}掷骰：D100=${result.roll}（${label}${chosen.statValue}）→${levelLabel}`);

    // Persist used skills for later growth roll
    persistSave({ ...save, checkedSkills: [...usedSkills] });

    // Proceed — skip display since roll messages already shown
    handlePlayerAction(choice.label, true);
  }, [handlePlayerAction, save, characters, userIdentity, pushMessages, persistSave, is7th, diceMode]);

  // Fork: OOC (皮下吐槽) — story-neutral chat; companions reply as themselves (no persona, no RP)
  // declared before handleFreeInput (deps order)
  const submitOoc = useCallback(async () => {
    const text = (freeText.trim() || freeAction.trim());
    if (!text || oocReplying) return;
    setFreeText("");
    setFreeAction("");
    const playerName = userIdentity?.name || "你";
    const userOocMsg: StreamMessage = { id: mkId(), type: "ooc", speaker: "__user__", text: `〔${playerName}〕${text}` };
    pushMessages(userOocMsg);
    streamRef.current = [...streamRef.current, userOocMsg];
    setShowOocPanel(true);
    setOocReplying(true);
    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      const slot = resolveBinding(bindings, undefined, "adventure");
      const apiConfig = (slot?.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("无API配置");
      // Fork: OOC history rides inside instruction (engine's filteredLog drops ooc-type messages,
      // so passing them via streamLog would leave companions blind)
      const oocHistory = streamRef.current.filter(m => m.type === "ooc").slice(-10)
        .map(m => m.speaker === "__user__" ? `〔OOC〕${m.text}` : `${m.speaker}：${m.text}`).join("\n");
      for (const a of save.agents.slice(0, 3)) {
        const ch = characters.find(c => c.id === a.characterId);
        if (!ch) continue;
        const decl = await companionDeclare(a.characterId, apiConfig, [], undefined, a.affinity, {
          instruction: `${oocHistory ? `以下是到目前为止的皮下吐槽记录（OOC）：\n${oocHistory}\n\n` : ""}现在是"皮下吐槽"时间（OOC）：你们暂时脱离角色，以你本人的身份和{{user}}闲聊——吐槽这个模组的剧情、刚才的剧情走向、KP的安排，或者随便聊。规则：
- 你就是你（${ch.name}），不是任何调查员；说话方式用你平时的（与角色卡一致）
- 谈到剧情时用"刚才那个剧情里/你那个角色"的说法
- 1-3句就好，像朋友插话吐槽；不行动、不宣言、不检定（action 留空、skill_check 留空）
- speech 就是你的吐槽内容`,
        });
        if (decl.speech && decl.speech !== "……") {
          const replyMsg: StreamMessage = { id: mkId(), type: "ooc", speaker: decl.speaker, text: decl.speech };
          pushMessages(replyMsg);
          streamRef.current = [...streamRef.current, replyMsg];
        }
      }
    } catch { /* silent */ }
    setOocReplying(false);
  }, [freeText, freeAction, oocReplying, save.agents, characters, userIdentity, pushMessages]);

  // Fork 八期B: player-initiated private talk — visible to the user only, archived to lockedLog
  // (declared BEFORE handleFreeInput — its deps array must not touch a TDZ binding)
  const submitPrivateTalk = useCallback(() => {
    const speech = freeText.trim();
    const action = freeAction.trim();
    if (!speech && !action) return;
    const playerName = userIdentity?.name || "你";
    const npcName = privateTalkNpc || "";
    const content = [speech, action].filter(Boolean).join(" / ");
    const dayLabel = formatGameTime(save.gameDay, save.gameTime);
    const entry = { id: `lock_${Date.now()}`, who: playerName, npc: npcName || undefined, text: content, day: dayLabel };
    lockedLogRef.current = [...lockedLogRef.current, entry];
    persistSave({ ...save, lockedLog: [...(save.lockedLog || []), entry] });
    pushMessages({ id: mkId(), type: "narration", text: `🔒〔你私下${npcName ? `对${npcName}` : ""}低语〕${content}`, audience: ["locked"] });
    setFreeText("");
    setFreeAction("");
    setPrivateTalk(false);
    setPrivateTalkNpc("");
  }, [freeText, freeAction, privateTalkNpc, save, userIdentity, persistSave, pushMessages]);

  // ── Handle free text input ──
  const handleFreeInput = useCallback(() => {
    if ((!freeText.trim() && !freeAction.trim()) || eventContinueLoading || eventLoading) return;
    if (oocMode) { submitOoc(); return; }
    if (privateTalk && inEvent) { submitPrivateTalk(); return; }
    const speech = freeText.trim();
    const action = freeAction.trim();
    setFreeText("");
    setFreeAction("");
    // Combine: "说：xxx｜做：xxx" or just one
    // Always use prefix format so handlePlayerAction can parse correctly
    const combined = speech && action
      ? `说：「${speech}」\n做：${action}`
      : speech
        ? `说：「${speech}」`
        : `做：${action}`;
    if (inEvent) {
      handlePlayerAction(combined);
    } else {
      triggerEvent("talk", combined);
    }
  }, [freeText, freeAction, eventContinueLoading, eventLoading, inEvent, handlePlayerAction, triggerEvent, privateTalk, submitPrivateTalk, oocMode, submitOoc]);

  const submitFreeInput = useCallback(() => {
    if (freeMode) {
      // Free mode: just push player message to stream, don't trigger DM
      const speech = freeText.trim();
      const action = freeAction.trim();
      if (!speech && !action) return;
      const playerName = userIdentity?.name || "你";
      if (speech) pushMessages({ id: mkId(), type: "player", speaker: playerName, text: speech });
      if (action) pushMessages({ id: mkId(), type: "narration", text: `${playerName}：${action}` });
      setFreeText("");
      setFreeAction("");
    } else {
      handleFreeInput();
    }
  }, [freeMode, freeText, freeAction, userIdentity, pushMessages, handleFreeInput]);

  // Fork: player declares with an explicitly chosen skill check (CoC loop)

  const submitDeclarationWithCheck = useCallback(() => {
    const skill = checkSkill.trim();
    const speech = freeText.trim();
    const action = freeAction.trim();
    if (!speech && !action && !skill) return;
    if (privateTalk) { submitPrivateTalk(); return; }
    // Build declaration text; skill check runs first (player rolls), then the action goes into the round
    const combined = [
      speech ? `说：「${speech}」` : "",
      action ? `做：${action}${skill ? `（检定：${skill}）` : ""}` : "",
    ].filter(Boolean).join("\n");
    setFreeText("");
    setFreeAction("");
    setCheckSkill("");
    setDiceMode("none");
    if (skill) {
      // Fork: same-scene failed check guard — warn on repeat (pushed-check rule: must justify a new approach)
      if (failedSkillsRef.current.has(skill)) {
        pushMessages({ id: mkId(), type: "system", text: `⚠ ${skill} 检定本场景已失败过——重复宣言请说明新的做法或理由，否则 KP 可裁定为重复无效` });
      }
      // Roll the player's chosen skill immediately, then continue as a declaration
      const edition = is7th ? "coc7" as const : "coc6" as const;
      const check = skillCheckValue(save.playerSheet, skill, save.playerStats, edition);
      const mode = edition === "coc7" ? diceMode : "none";
      const r = mode !== "none" ? rollD100WithDice(check.value, mode, edition) : { ...rollD100(check.value, edition), detail: "" };
      const rLabel = r.level === "crit" ? "大成功" : r.level === "hard" ? "困难成功" : r.level === "success" ? "成功" : r.level === "fumble" ? "大失败" : "失败";
      const success = r.level !== "fail" && r.level !== "fumble";
      if (!success) failedSkillsRef.current.add(skill);
      // Fork: dice result rides on the player declCard (no standalone roll message)
      pendingPlayerDiceRef.current = { skill: check.source, value: check.value, roll: r.roll, level: r.level, detail: mode !== "none" ? r.detail : "" };
      usedSkillsRef.current.add(check.source.replace(/\(.*\)$/, ""));
      persistSave({ ...save, checkedSkills: [...new Set([...(save.checkedSkills || []), check.source.replace(/\(.*\)$/, "")])] });
      // 7th luck spend on player-chosen checks
      if (is7th && !success && r.level === "fail") {
        const luck = save.playerStats.lck ?? 0;
        const luckInfo = canSpendLuck(r.roll, check.value, luck);
        if (luckInfo.ok && luckInfo.cost > 0 && window.confirm(`差一点！花费 ${luckInfo.cost} 点幸运（当前 ${luck}）补成成功？`)) {
          const newStats = { ...save.playerStats, lck: luck - luckInfo.cost };
          persistSave({ ...save, playerStats: newStats });
          const luckMsg: StreamMessage = { id: mkId(), type: "roll", speaker: `${userIdentity?.name || "你"} · 消耗幸运`, text: `花费幸运 ${luckInfo.cost} 点：D100 ${r.roll} → 补成成功（幸运剩余 ${newStats.lck}）`, emotion: "success" };
          pushMessages(luckMsg);
          streamRef.current = [...streamRef.current, luckMsg];
          handlePlayerAction(`【幸运补值成功】${combined}`, true);
          return;
        }
      }
    }
    handlePlayerAction(combined, !skill);
  }, [checkSkill, freeText, freeAction, save, is7th, diceMode, pushMessages, persistSave, handlePlayerAction, userIdentity, privateTalk, submitPrivateTalk]);

  const handleToggleFreeMode = useCallback(() => {
    if (freeMode) {
      setFreeMode(false);
      pushMessages({ id: mkId(), type: "system", text: "—— 自由交流结束 ——" });
    } else {
      setFreeMode(true);
      pushMessages({ id: mkId(), type: "system", text: "—— 自由交流模式 ——" });
    }
    setShowEventActionDrawer(false);
  }, [freeMode, pushMessages]);

  // ── Free mode: send message to a specific companion ──
  const handleFreeModeChat = useCallback(async (characterId: string) => {
    if (freeModeReplying) return;

    setFreeModeReplying(true);
    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      const slot = resolveBinding(bindings, characterId, "adventure");
      const apiConfig = (slot?.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("未找到API配置");

      const fmAgent = save.agents.find(a => a.characterId === characterId);
      const fmPersona = fmAgent?.persona ? `【你的模组内人设】${fmAgent.persona.occupation}——${fmAgent.persona.background}（时代：${fmAgent.persona.era}；言行物品须属这个时代）` : undefined;
      const decl = await companionDeclare(characterId, apiConfig, sceneWallFilter(characterId), save.agents.length > 1 ? userIdentity : undefined, fmAgent?.affinity, {
        ...(save.agentSecrets?.[characterId] ? { secretHint: `【你的秘密】${save.agentSecrets[characterId].content}——是否透露、何时摊牌由你决定。` } : {}),
        ...(fmPersona ? { personaHint: fmPersona } : {}),
      });

      if (decl.speech && decl.speech !== "……") {
        pushMessages({ id: mkId(), type: "character", speaker: decl.speaker, text: decl.speech, emotion: decl.emotion });
      }
      if (decl.action && decl.action !== "跟随队伍" && decl.action !== "沉默不动") {
        pushMessages({ id: mkId(), type: "narration", text: `${decl.speaker}：${decl.action}` });
      }
    } catch (e) {
      pushMessages({ id: mkId(), type: "system", text: `回复失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setFreeModeReplying(false);
    }
  }, [freeModeReplying, pushMessages]);

  // ── Direct DM resolve (skip companion LLM, use free-mode chat as declarations) ──
  const handleDirectResolve = useCallback(async () => {
    if (!inEvent || eventContinueLoading) return;
    setEventContinueLoading(true);
    setFreeMode(false);
    pushMessages({ id: mkId(), type: "system", text: "—— DM 裁决中 ——" });

    try {
      const apiConfigs = loadApiConfigs();
      const bindings = loadBindingConfig();
      const dmSlot = save.agents.length === 1
        ? resolveBinding(bindings, save.agents[0].characterId, "adventure")
        : resolveBinding(bindings, undefined, "adventure");
      const apiConfig = (dmSlot?.apiConfigId ? apiConfigs.find(c => c.id === dmSlot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
      if (!apiConfig?.apiKey) throw new Error("未找到有效的API配置");

      const playerName = userIdentity?.name || "你";

      // Build declarations from recent stream (free-mode chat)
      const recentStream = streamRef.current;
      const playerMsgs = recentStream.filter(m => m.type === "player");
      const lastPlayerMsg = playerMsgs[playerMsgs.length - 1];
      const playerDecl: Declaration = {
        speaker: playerName,
        speech: lastPlayerMsg?.text || "",
        action: lastPlayerMsg?.text || "（基于之前的讨论行动）",
      };

      const companionDecls: Declaration[] = [];
      for (const a of save.agents) {
        const ch = characters.find(c => c.id === a.characterId);
        if (!ch) continue;
        const charMsgs = recentStream.filter(m => m.type === "character" && m.speaker === ch.name);
        const lastMsg = charMsgs[charMsgs.length - 1];
        companionDecls.push({
          speaker: ch.name,
          speech: lastMsg?.text || "",
          action: lastMsg?.text || "跟随队伍",
        });
      }

      const allDeclarations: Declaration[] = [playerDecl, ...companionDecls];

      // Build DM context
      const prevDialogue = recentStream
        .filter(m => m.type !== "system" && m.type !== "divider" && m.type !== "ooc")
        .map(m => m.type === "declCard" && m.decl
          ? `${m.decl.who}: ${[m.decl.say ? `说：「${m.decl.say}」` : "", m.decl.do ? `做：${m.decl.do}` : "", m.decl.dice ? `（宣言检定 ${m.decl.dice.skill}${m.decl.dice.value}：D100=${m.decl.dice.roll}，结果由你演出）` : ""].filter(Boolean).join(" ")}`
          : (m.speaker ? `${m.speaker}: ${m.text}` : m.text))
        .join("\n");

      let dmCtx: import("@/lib/map-rpg-engine").DMContext;
      try { dmCtx = JSON.parse(eventContext); } catch { dmCtx = { worldLore: "", currentLocation: "", eventType: "", eventBrief: "", companionNames: [], recentJournal: [], keyChoices: [], gameTime: "" }; }
      dmCtx.previousDialogue = prevDialogue;
      dmCtx.director = save.director;
      dmCtx.recentJournal = save.journal.map(j => j.text);

      setLoadingPhase("dm");
      const continuation = await resolveRound(dmCtx, allDeclarations, apiConfig);

      // Reuse the same result processing as handlePlayerAction
      // (This duplicates some logic but keeps it self-contained)
      const ev = continuation as EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; moveTo?: string | Record<string, string>; worldEvents?: string[] };
      if (ev.worldEvents?.length) setWorldEvents(ev.worldEvents);

      if (continuation.dialogues.length > 0) {
        pushSceneToStream(continuation);
        setActiveEvent(continuation);
        setAccumulatedEvent(prev => prev ? {
          ...prev,
          dialogues: [...prev.dialogues, ...allDeclarations.map(d => ({ speaker: d.speaker, text: `${d.speech}（${d.action}）`, emotion: "neutral" })), ...continuation.dialogues],
          choices: continuation.choices,
        } : continuation);
        setEventContext(JSON.stringify(dmCtx));

        if (continuation.choices && continuation.choices.length > 0) {
          setCurrentChoices(continuation.choices);
          setLastFailedAction(null);          setTimeout(() => inputRef.current?.focus(), 200);
        } else {
          setLastFailedAction(null);          pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
          setCurrentChoices(null); setCurrentTopics(null);
          setInEvent(false);
          setActiveEvent(null);
          setActiveEventMeta(null);
          setAccumulatedEvent(null);
        }
      } else {
        pushMessages({ id: mkId(), type: "system", text: "—— 事件结束 ——" });
        setCurrentChoices(null); setCurrentTopics(null);
        setInEvent(false);
        setActiveEvent(null);
        setActiveEventMeta(null);
        setAccumulatedEvent(null);
      }

      // Save (simplified — skipping stat/item/position processing here, handled by handlePlayerAction for full events)
      persistSave({ ...save, timestamp: new Date().toISOString() });

    } catch (e) {
      pushMessages({ id: mkId(), type: "system", text: `裁决失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setEventContinueLoading(false);
      setLoadingPhase("");
    }
  }, [inEvent, eventContinueLoading, eventContext, save, characters, userIdentity, pushMessages, pushSceneToStream, persistSave]);

  // ── Handle interaction button click ──
  const handleInteraction = useCallback((ia: NodeInteraction) => {
    if (ia.type === "rest") {
      handleRest();
      return;
    }
    if (ia.type === "quest") {
      const stage = skeleton.mainQuest.stages[save.mainQuestStage];
      if (stage) triggerEvent("main_quest", `${skeleton.mainQuest.title}：${stage.brief}`);
      return;
    }
    if (ia.type === "sidequest") {
      const sq = skeleton.sideQuests.find(s => s.id === ia.questId);
      if (sq) triggerEvent("side_quest", `${sq.title}：${sq.synopsis}`, { questId: sq.id });
      return;
    }
    if (ia.type === "talk") {
      const npcName = ia.label.replace("和", "").replace("交谈", "");
      const npc = skeleton.npcs.find(n => ia.label.includes(n.name));
      triggerEvent("talk", `和${npc?.name || npcName}交谈`, { npcName: npc?.name, npcPersonality: npc?.personality });
      return;
    }
    if (ia.type === "search") {
      const newSearched = { ...save.searchedNodes, [save.currentNodeId]: (save.searchedNodes[save.currentNodeId] || 0) + 1 };
      const newSave = { ...save, searchedNodes: newSearched };
      persistSave(newSave);
      triggerEvent("search", `在${currentNode?.name}搜索周围`);
      return;
    }
  }, [save, skeleton, currentNode, handleRest, triggerEvent, persistSave]);

  // Handle save

  // ── Archive adventure ──
  const handleArchive = useCallback(() => {
    const summaryApi = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || loadApiConfigs().find(c => c.apiKey);
    if (summaryApi?.apiKey) {
      generateAdventureSummary(save, skeleton.world.name, summaryApi).catch(() => undefined);
    }
    persistSave({ ...save, timestamp: new Date().toISOString() });
    onBack();
  }, [save, skeleton, onBack]);

  // Fork 八期A: reveal overlay — full backstage view (all secrets + locked log), shown after ending
  const [showReveal, setShowReveal] = useState(false);
  const partySecretsView = [
    ...(save.mySecret ? [{ who: userIdentity?.name || "你", secret: save.mySecret }] : []),
    ...Object.entries(save.agentSecrets || {}).map(([cid, s]) => ({ who: charName(cid), secret: s })),
  ];

  // Trigger encounters after user moves
  const handleMoveWithAgents = useCallback((targetNodeId: string) => {
    if (inEvent || eventLoading) return;
    handleMove(targetNodeId);

    if (shouldTriggerEncounter(true)) {
      const node = nodeMap.get(targetNodeId);
      const regionIdx = node?.regionIdx ?? 0;
      const geography = skeleton.mapInput.regions[regionIdx]?.geography;
      const encounter = pickEncounter(skeleton.encounterPool, save.usedEncounterIds, geography);
      if (encounter) {
        const newSave = { ...save, usedEncounterIds: [...save.usedEncounterIds, encounter.id] };
        persistSave(newSave);
        setTimeout(() => triggerEvent("encounter", encounter.brief), 300);
      }
    }
  }, [handleMove, save, nodeMap, skeleton, triggerEvent, persistSave, inEvent, eventLoading]);

  // ── Current interactions ──
  const currentInteractions = useMemo(() => getInteractions(save.currentNodeId), [getInteractions, save.currentNodeId]);
  const canToggleFreeMode = !save.completed && save.agents.length > 0;
  const canExitCurrentEvent = !eventLoading && !eventContinueLoading && inEvent && !freeMode;
  const showEventActionHandle = canToggleFreeMode || canExitCurrentEvent;

  // ══════════════════════════════════════════════
  // ██ RENDER
  // ══════════════════════════════════════════════

  return (
    <div className="adventure-shell" data-adventure-theme={String(worldTheme.colorScheme || 0)} style={{
      position: "absolute", inset: 0,
      background: "var(--c-adv-bg)",
      display: "flex", flexDirection: "column",
      fontFamily: "'PingFang SC', system-ui, sans-serif",
      overflow: "hidden", color: "var(--c-adv-text)",
    }}>
      <div
        aria-hidden
        style={{
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          height: "var(--page-header-safe-top, 48px)",
          background: "var(--c-adv-bar-bg)",
          zIndex: 0,
          pointerEvents: "none",
        }}
      />
      {/* ═══ Top Bar ═══ */}
      <div style={{
        height: "var(--page-header-content-height, 42px)",
        marginTop: "var(--page-header-safe-top, 48px)",
        padding: "1px 20px",
        background: "var(--c-adv-bar-bg)",
        backdropFilter: "none",
        borderBottom: "1px solid var(--c-adv-bar-border)",
        position: "relative", zIndex: 1,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        flexShrink: 0,
      }}>
        <button onClick={() => setShowArchiveConfirm(true)} style={{ width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: "var(--c-adv-text-dim)", cursor: "pointer" }}>
          <ArrowLeft size={20} />
        </button>

        <div style={{ textAlign: "center", flex: 1 }}>
          <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.1em", color: "var(--c-adv-text)" }}>
            {skeleton.world.name}
          </div>
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 2 }}>
            {formatGameTime(save.gameDay, save.gameTime)} · HP {save.hp}/{save.maxHp} · SAN {typeof save.san === "number" ? save.san : (save.playerStats?.san ?? "?")} · {currentNode?.name}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center" }}>
          <button
            aria-label="更多冒险操作"
            aria-expanded={showTopActionMenu}
            onClick={() => {
              const next = !showTopActionMenu;
              setShowTopActionMenu(next);
              if (next) setShowThemePanel(false);
            }}
            style={{
              width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center",
              background: "none", border: "none",
              color: showTopActionMenu ? "var(--c-adv-icon-active)" : "var(--c-adv-icon)",
              cursor: "pointer",
            }}
          >
            <MoreHorizontal size={20} />
          </button>
        </div>
      </div>

      {showTopActionMenu && (
        <>
          <div
            onClick={() => setShowTopActionMenu(false)}
            style={{ position: "absolute", inset: 0, zIndex: 46 }}
          />
          <div style={{
            position: "absolute",
            top: 104,
            right: 12,
            zIndex: 47,
            width: 148,
            padding: 7,
            borderRadius: 15,
            background: "var(--c-adv-panel-bg)",
            border: "1px solid var(--c-adv-input-border)",
            boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
            backdropFilter: "blur(14px)",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            boxSizing: "border-box",
          }}>
            <button
              onClick={() => {
                setShowTopActionMenu(false);
                setShowThemePanel(true);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                width: "100%", minHeight: 44, padding: "0 10px", borderRadius: 10,
                border: "none",
                background: showThemePanel ? "var(--c-adv-choice-bg)" : "transparent",
                color: showThemePanel ? "var(--c-adv-accent)" : "var(--c-adv-text)",
                fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", cursor: "pointer", textAlign: "left",
                boxSizing: "border-box",
              }}
            >
              <Palette size={16} color="var(--c-adv-accent)" />
              <span>主题设置</span>
            </button>
            <button
              onClick={() => {
                setShowTopActionMenu(false);
                setShowSaveConfirm(true);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                width: "100%", minHeight: 44, padding: "0 10px", borderRadius: 10,
                border: "none", background: "transparent",
                color: "var(--c-adv-text)", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit",
                cursor: "pointer", textAlign: "left",
                boxSizing: "border-box",
              }}
            >
              <Save size={16} color="var(--c-adv-accent)" />
              <span>存档管理</span>
            </button>
            <button
              onClick={() => {
                setShowTopActionMenu(false);
                setShowJournal(!showJournal);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                width: "100%", minHeight: 44, padding: "0 10px", borderRadius: 10,
                border: "none",
                background: showJournal ? "var(--c-adv-choice-bg)" : "transparent",
                color: showJournal ? "var(--c-adv-accent)" : "var(--c-adv-text)",
                fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", cursor: "pointer", textAlign: "left",
                boxSizing: "border-box",
              }}
            >
              <BookOpen size={16} color="var(--c-adv-accent)" />
              <span>冒险日志</span>
            </button>
            <button
              onClick={() => {
                setShowTopActionMenu(false);
                setShowDebug(!showDebug);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                width: "100%", minHeight: 44, padding: "0 10px", borderRadius: 10,
                border: "none",
                background: showDebug ? "var(--c-adv-choice-bg)" : "transparent",
                color: showDebug ? "var(--c-adv-accent)" : "var(--c-adv-text)",
                fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", cursor: "pointer", textAlign: "left",
                boxSizing: "border-box",
              }}
            >
              <Bug size={16} color="var(--c-adv-accent)" />
              <span>调试记录</span>
            </button>
            <button
              onClick={() => {
                setShowTopActionMenu(false);
                setShowAssetPanel(true);
              }}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 9,
                width: "100%", minHeight: 44, padding: "0 10px", borderRadius: 10,
                border: "none", background: "transparent",
                color: "var(--c-adv-text)", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", cursor: "pointer", textAlign: "left",
                boxSizing: "border-box",
              }}
            >
              <Palette size={16} color="var(--c-adv-accent)" />
              <span>演出资源</span>
            </button>
          </div>
        </>
      )}

      {/* World events collapsible */}
      {worldEvents.length > 0 && (
        <div style={{
          padding: "0 12px", flexShrink: 0,
          borderBottom: showWorldEvents ? "1px solid var(--c-adv-input-bg)" : "none",
        }}>
          <button onClick={() => setShowWorldEvents(!showWorldEvents)} style={{
            width: "100%", padding: "5px 0",
            background: "none", border: "none",
            fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", cursor: "pointer",
            fontFamily: "monospace", letterSpacing: "0.1em",
            textAlign: "center",
          }}>
            🌍 世界动态 {showWorldEvents ? "▲" : "▼"}
          </button>
          {showWorldEvents && (
            <div style={{ padding: "0 4px 8px", maxHeight: 120, overflowY: "auto" }}>
              {worldEvents.map((evt, i) => (
                <div key={i} style={{
                  fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", lineHeight: 1.5,
                  padding: "3px 0",
                  borderBottom: i < worldEvents.length - 1 ? "1px solid var(--c-adv-input-bg)" : "none",
                }}>
                  {evt}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Fork: OOC (皮下) collapsible — story-neutral chatter stays out of the way */}
      {streamMessages.some(m => m.type === "ooc") && (
        <div style={{ padding: "0 12px", flexShrink: 0 }}>
          <button onClick={() => setShowOocPanel(!showOocPanel)} style={{
            width: "100%", padding: "7px 0", minHeight: 28,
            background: "none", border: "none",
            fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(140,200,255,0.55)", cursor: "pointer",
            fontFamily: "monospace", letterSpacing: "0.1em",
            textAlign: "center",
          }}>
            🎤 皮下吐槽 {showOocPanel ? "▲" : `▼（${streamMessages.filter(m => m.type === "ooc").length} 条）`}
          </button>
          {showOocPanel && (
            <div ref={oocPanelRef} style={{ maxHeight: 150, overflowY: "auto", paddingBottom: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              {streamMessages.filter(m => m.type === "ooc").map(m => {
                const isUser = m.speaker === "__user__";
                const avatar = !isUser ? fullAvatarMap[m.speaker || ""] : undefined;
                return (
                  <div key={m.id} style={{
                    display: "flex", gap: 6, alignItems: "flex-start",
                    flexDirection: isUser ? "row-reverse" : "row",
                  }}>
                    <div style={{
                      width: 20, height: 20, borderRadius: "50%", flexShrink: 0,
                      backgroundImage: avatar ? `url(${avatar})` : "none",
                      backgroundColor: avatar ? "transparent" : "rgba(140,200,255,0.12)",
                      backgroundSize: "cover", backgroundPosition: "center",
                      border: "1px solid rgba(140,200,255,0.3)",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      fontSize: 10, color: "rgba(170,215,255,0.8)",
                    }}>{!avatar && (isUser ? "你" : (m.speaker?.[0] || "?"))}</div>
                    <div style={{
                      maxWidth: "82%", padding: "5px 9px", borderRadius: 10,
                      background: isUser ? "rgba(140,200,255,0.14)" : "var(--c-adv-input-bg)",
                      border: `1px solid ${isUser ? "rgba(140,200,255,0.3)" : "var(--c-adv-input-border)"}`,
                    }}>
                      {!isUser && (
                        <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", fontWeight: 600, color: "rgba(170,215,255,0.9)", marginBottom: 1 }}>{m.speaker}</div>
                      )}
                      <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", lineHeight: 1.55, color: "var(--c-adv-text-dim)", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{m.text}</div>
                    </div>
                  </div>
                );
              })}
              {oocReplying && (
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(140,200,255,0.5)", textAlign: "center", fontFamily: "monospace", letterSpacing: "0.1em", padding: "2px 0" }}>
                  …皮下插话中
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══ Text Stream ═══ (minHeight floor: the bottom bar must never squeeze this to a slit) */}
      <div style={{ flex: 1, minHeight: 140, position: "relative", overflow: "hidden", background: "transparent", display: "flex", flexDirection: "column", zIndex: 1 }}>
        <MapTextStream
          messages={streamMessages.filter(m => m.type !== "ooc")}
          avatarMap={fullAvatarMap}
          fontFamily={customFontFamily}
          fontScale={worldTheme.fontScale}
          lineHeightScale={worldTheme.lineHeightScale}
          bilingualTranslationEnabled={bilingualTranslationEnabled}
          defaultTranslationExpanded={defaultTranslationExpanded}
          loading={eventLoading || eventContinueLoading}
          loadingText={eventLoading ? "DM 正在书写命运..." : loadingPhase === "companions" ? "同伴思考中..." : loadingPhase === "dm" ? "DM 裁决中..." : undefined}
        />
      </div>

      {/* ═══ Bottom Action Bar ═══ */}
      {save.completed ? (
        <div style={{
          padding: "14px 12px calc(env(safe-area-inset-bottom, 0px) + 14px)",
          background: "var(--c-adv-bar-bg)",
          backdropFilter: "none",
          borderTop: "1px solid var(--c-adv-accent-dim)",
          textAlign: "center",
          flexShrink: 0,
        }}>
          <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", letterSpacing: "0.15em", fontFamily: "monospace" }}>
            — 冒险已完结 —
          </div>
        </div>
      ) : (
        <div style={{
          padding: "8px 12px calc(env(safe-area-inset-bottom, 0px) + 8px)",
          background: "var(--c-adv-bar-bg)",
          backdropFilter: "none",
          borderTop: "1px solid var(--c-adv-bar-border)",
          flexShrink: 0,
          // Fork fix: the bar is an unbounded flexShrink:0 stack (choices + hints + topics +
          // checks + inputs) — during events it grew past the viewport, got clipped by the
          // root overflow:hidden and squeezed the stream/fold bar to a slit. Cap it and scroll inside.
          maxHeight: "48vh", overflowY: "auto", overscrollBehavior: "contain",
        }}>
          {/* Event choices (only during event with choices) */}
          <style>{`
          .map-choice-btn {
            transition: transform 0.15s ease, background 0.15s ease, border-color 0.15s ease;
          }
          .map-choice-btn:active:not(:disabled) {
            transform: scale(0.97);
            background: rgba(200,160,100,0.12) !important;
            border-color: rgba(200,160,100,0.3) !important;
          }
        `}</style>
          {/* Fork: combat entry moved into the ➕ menu — during combat a compact status chip stays visible */}

          {/* Retry button after API error (shows above choices) */}
          {inEvent && !freeMode && lastFailedAction && currentChoices && currentChoices.length > 0 && !eventContinueLoading && (
            <button onClick={() => {
              const action = lastFailedAction;
              setLastFailedAction(null);
              handlePlayerAction(action, true);
            }} style={{
              width: "100%", padding: "8px 0", borderRadius: 8, marginBottom: 5,
              border: "1px solid rgba(255,160,80,0.2)",
              background: "rgba(255,160,80,0.08)",
              color: "rgba(255,180,100,0.8)",
              fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
              <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>🔄</span> 重新生成（原操作）
            </button>
          )}
          {inEvent && !freeMode && currentChoices && currentChoices.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 5, maxHeight: "32vh", overflowY: "auto" }}>
              {currentChoices.map((choice, i) => {
                const missingItem = choice.requires && !save.director.keyItems.includes(choice.requires);
                return (
                  <button key={i}
                    className="map-choice-btn"
                    onClick={() => {
                      if (missingItem) {
                        pushMessages({ id: mkId(), type: "system", text: `缺少物品「${choice.requires}」，无法执行该行动` });
                        handlePlayerAction(`${choice.label}（缺少${choice.requires}，失败）`);
                        return;
                      }
                      handleChoiceClick(choice);
                    }}
                    disabled={eventContinueLoading}
                    style={{
                      width: "100%", padding: "9px 12px", borderRadius: 8,
                      border: `1px solid ${missingItem ? "rgba(255,80,60,0.15)" : "var(--c-adv-choice-border)"}`,
                      background: missingItem ? "rgba(255,80,60,0.04)" : "var(--c-adv-choice-bg)",
                      color: eventContinueLoading ? "var(--c-adv-text-muted)" : missingItem ? "var(--c-adv-icon)" : "var(--c-adv-body)",
                      fontSize: "calc(13px*var(--app-text-scale,1))", fontFamily: "inherit", cursor: "pointer",
                      lineHeight: 1.4, textAlign: "left",
                    }}>
                    {choice.statCheck && (
                      <span style={{
                        fontSize: "calc(9px*var(--app-text-scale,1))", padding: "1px 5px", borderRadius: 3, marginRight: 5,
                        background: "var(--c-adv-choice-bg)", color: "var(--c-adv-accent-dim)",
                      }}>
                        🎲 {STAT_LABELS[choice.statCheck.stat] || choice.statCheck.stat}{choice.statCheck.who ? ` · ${choice.statCheck.who}` : ""}
                      </span>
                    )}
                    {choice.requires && (
                      <span style={{
                        fontSize: "calc(9px*var(--app-text-scale,1))", padding: "1px 5px", borderRadius: 3, marginRight: 5,
                        background: missingItem ? "rgba(255,80,60,0.12)" : "rgba(100,200,100,0.12)",
                        color: missingItem ? "rgba(255,100,80,0.7)" : "rgba(100,200,100,0.7)",
                      }}>
                        {missingItem ? "🔒" : "✓"} {choice.requires}
                      </span>
                    )}
                    {choice.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Exploration buttons (only when NOT in event and NOT free mode) */}
          {!inEvent && !freeMode && (
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 5 }}>
              {currentInteractions.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {currentInteractions.map((ia, i) => (
                    <button key={i} disabled={!ia.available || eventLoading}
                      onClick={() => handleInteraction(ia)}
                      style={{
                        padding: "6px 11px", borderRadius: 7,
                        border: "1px solid var(--c-adv-choice-border)",
                        background: ia.available ? "var(--c-adv-input-bg)" : "transparent",
                        color: ia.available ? "var(--c-adv-text)" : "var(--c-adv-text-muted)",
                        fontSize: "calc(12px*var(--app-text-scale,1))", cursor: ia.available ? "pointer" : "default",
                        fontFamily: "inherit",
                        display: "flex", alignItems: "center", gap: 5,
                      }}>
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))" }}>{ia.icon}</span>
                      <span>{ia.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Retry button on failure */}
          {lastFailedEvent && !eventLoading && !inEvent && (
            <button onClick={() => {
              const { type, brief, meta } = lastFailedEvent;
              setLastFailedEvent(null);
              triggerEvent(type as "main_quest" | "side_quest" | "encounter" | "search" | "talk", brief, meta);
            }} style={{
              width: "100%", padding: "8px 0", borderRadius: 8, marginBottom: 5,
              border: "1px solid rgba(255,160,80,0.2)",
              background: "rgba(255,160,80,0.08)",
              color: "rgba(255,180,100,0.8)",
              fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            }}>
              <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>🔄</span> 重新生成
            </button>
          )}


          {/* Stuck state recovery: in event, not loading, no choices */}
          {inEvent && !eventLoading && !eventContinueLoading
            && (!currentChoices || currentChoices.length === 0) && (
              <div style={{
                display: "flex", gap: 6, marginBottom: 5,
              }}>
                {lastFailedAction && eventContext ? (
                  <button onClick={() => {
                    const action = lastFailedAction;
                    setLastFailedAction(null);
                    handlePlayerAction(action, true);
                  }} style={{
                    flex: 1, padding: "8px 0", borderRadius: 8,
                    border: "1px solid rgba(255,160,80,0.2)",
                    background: "rgba(255,160,80,0.08)",
                    color: "rgba(255,180,100,0.8)",
                    fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                  }}>
                    <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>🔄</span> 继续生成
                  </button>
                ) : (
                  <button onClick={() => {
                    pushMessages({ id: mkId(), type: "system", text: "—— 连接中断，已恢复探索 ——" });
                    setInEvent(false);
                    setCurrentChoices(null); setCurrentTopics(null);
                    setActiveEvent(null);
                    setActiveEventMeta(null);
                    setAccumulatedEvent(null);
                    setLastFailedAction(null);                  }} style={{
                    flex: 1, padding: "8px 0", borderRadius: 8,
                    border: "1px solid var(--c-adv-input-border)",
                    background: "var(--c-adv-input-bg)",
                    color: "var(--c-adv-text-dim)",
                    fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                    display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                  }}>
                    ⚠ 生成中断了，点击恢复探索
                  </button>
                )}
              </div>
            )}

          {/* ── Mode indicator ── */}
          {!eventLoading && !eventContinueLoading && (
            <div style={{
              fontSize: "calc(9px*var(--app-text-scale,1))", color: freeMode ? "rgba(100,180,255,0.5)" : "var(--c-adv-accent-dim)",
              fontFamily: "monospace", letterSpacing: "0.1em", marginBottom: 4,
              textAlign: "center",
            }}>
              {oocMode ? "🎤 皮下吐槽中 — 发送后同伴以本人身份插话（不影响剧情）" : freeMode ? "自由交流中 — 输入后点击角色头像发送" : inEvent ? "事件进行中" : ""}
            </div>
          )}

          {/* Fork: active-combat status chip (compact — the panel itself opens from the ➕ menu) */}
          {showCombat && !freeMode && !eventLoading && !eventContinueLoading && (
            <div style={{
              display: "flex", alignItems: "center", gap: 6, marginBottom: 5,
              padding: "5px 8px", borderRadius: 8,
              border: "1px solid rgba(200,80,80,0.3)", background: "rgba(200,80,80,0.08)",
              fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(230,130,120,0.9)",
            }}>
              <span style={{ fontFamily: "monospace", letterSpacing: "0.05em", flex: 1 }}>
                ⚔️ 第{save.combat!.round}轮 · {combatCurrentToken ? `${tokenLabel(combatCurrentToken)}行动` : "—"}
              </span>
              <button onClick={advanceCombatTurn} style={{
                padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(200,80,80,0.3)",
                background: "rgba(0,0,0,0.25)", color: "inherit",
                fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              }}>
                下一位 →
              </button>
              <button onClick={() => setCombatOpen(true)} style={{
                padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(200,80,80,0.25)",
                background: "rgba(0,0,0,0.25)", color: "inherit",
                fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              }}>
                面板
              </button>
              <button onClick={endCombat} style={{
                padding: "3px 8px", borderRadius: 5, border: "1px solid rgba(255,255,255,0.12)",
                background: "transparent", color: "rgba(255,255,255,0.45)",
                fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              }}>
                结束
              </button>
            </div>
          )}

          {/* ── Input area (hidden during loading) ── */}
          {!eventLoading && !eventContinueLoading && <div style={{ display: "grid", gridTemplateColumns: "36px 1fr 48px", gap: 6 }}>
            {/* Fork: ➕ menu — combat / skill check / private talk (folded away from daily investigation) */}
            <div style={{ position: "relative", display: "flex", alignItems: "stretch" }}>
              <button type="button" onClick={() => setPlusMenuOpen(!plusMenuOpen)} disabled={freeMode} style={{
                width: 36, borderRadius: 9, flexShrink: 0,
                border: plusMenuOpen ? "1px solid var(--c-adv-accent-dim)" : "1px solid var(--c-adv-input-border)",
                background: plusMenuOpen ? "var(--c-adv-choice-bg)" : "var(--c-adv-input-bg)",
                color: plusMenuOpen ? "var(--c-adv-accent)" : "var(--c-adv-text-dim)",
                fontSize: "calc(18px*var(--app-text-scale,1))", cursor: freeMode ? "default" : "pointer",
                fontFamily: "inherit", lineHeight: 1,
              }}>＋</button>
              {plusMenuOpen && (
                <>
                  <div onClick={() => setPlusMenuOpen(false)} style={{ position: "fixed", inset: 0, zIndex: 59 }} />
                  <div style={{
                    position: "absolute", left: 0, bottom: "calc(100% + 8px)", zIndex: 60,
                    minWidth: 190, padding: 6,
                    background: "var(--c-adv-panel-bg)", borderRadius: 12,
                    border: "1px solid var(--c-adv-input-border)",
                    boxShadow: "0 8px 28px rgba(0,0,0,0.35)",
                    display: "flex", flexDirection: "column", gap: 3,
                  }}>
                    <button type="button" onClick={() => { setPlusMenuOpen(false); setCombatOpen(true); }} style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderRadius: 8,
                      border: "none", background: "transparent", color: "var(--c-adv-text)",
                      fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                    }}>
                      <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>⚔️</span> {showCombat ? "战斗轮面板" : "开始战斗轮"}
                    </button>
                    <button type="button" onClick={() => { setPlusMenuOpen(false); setSkillPickerOpen(true); }} disabled={freeMode} style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderRadius: 8,
                      border: "none", background: "transparent", color: "var(--c-adv-text)",
                      fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                    }}>
                      <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>🎲</span> 技能检定{checkSkill.trim() ? `（已选 ${checkSkill.trim()}）` : ""}
                    </button>
                    <button type="button" onClick={() => { setPlusMenuOpen(false); setOocMode(prev => !prev); }} style={{
                      display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderRadius: 8,
                      border: "none", background: "transparent", color: oocMode ? "rgba(140,200,255,0.95)" : "var(--c-adv-text)",
                      fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                    }}>
                      <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>🎤</span> {oocMode ? "退出皮下吐槽" : "皮下吐槽（OOC）"}
                    </button>
                    {save.mySecret && inEvent && (
                      <button type="button" onClick={() => { setPlusMenuOpen(false); setPrivateTalk(prev => !prev); }} style={{
                        display: "flex", alignItems: "center", gap: 8, padding: "9px 10px", borderRadius: 8,
                        border: "none", background: "transparent", color: privateTalk ? "rgba(190,170,240,0.95)" : "var(--c-adv-text)",
                        fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                      }}>
                        <span style={{ fontSize: "calc(14px*var(--app-text-scale,1))" }}>🔒</span> {privateTalk ? "退出私下交谈" : "私下询问"}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, minWidth: 0 }}>
              {/* Fork: KP investigation hints (tappable → fills check skill) */}
              {inEvent && currentHints && currentHints.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "5px 0", maxHeight: 92, overflowY: "auto" }}>
                  <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", fontFamily: "monospace", letterSpacing: "0.1em", lineHeight: "24px" }}>💡</span>
                  {currentHints.map((h, i) => (
                    <button key={i} type="button"
                      onClick={() => {
                        setFreeAction(h.label);
                        if (h.skillHint) setCheckSkill(h.skillHint);
                      }}
                      style={{
                        padding: "3px 9px", borderRadius: 12,
                        border: "1px solid var(--c-adv-choice-border)", background: "var(--c-adv-choice-bg)",
                        color: "var(--c-adv-text-dim)", fontSize: "calc(10px*var(--app-text-scale,1))",
                        cursor: "pointer", fontFamily: "inherit",
                        display: "flex", alignItems: "center", gap: 4,
                      }}>
                      {h.label}
                      {h.skillHint && <span style={{ color: "var(--c-adv-accent-dim)", fontSize: "calc(9px*var(--app-text-scale,1))" }}>🎲{h.skillHint}</span>}
                    </button>
                  ))}
                </div>
              )}
              {/* Fork: NPC talk topics (tappable → fills speech input) */}
              {inEvent && currentTopics && currentTopics.length > 0 && (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 4, padding: "2px 0", maxHeight: 92, overflowY: "auto" }}>
                  <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", fontFamily: "monospace", letterSpacing: "0.1em", lineHeight: "24px" }}>❓</span>
                  {currentTopics.map((t, i) => (
                    <button key={i} type="button"
                      onClick={() => { setFreeText(t.label); if (t.skillHint) setCheckSkill(t.skillHint); }}
                      style={{
                        padding: "3px 9px", borderRadius: 12,
                        border: "1px solid var(--c-adv-choice-border)", background: "var(--c-adv-choice-bg)",
                        color: "var(--c-adv-text-dim)", fontSize: "calc(10px*var(--app-text-scale,1))",
                        cursor: "pointer", fontFamily: "inherit",
                        display: "flex", alignItems: "center", gap: 4,
                      }}>
                      {t.label}
                      {t.skillHint && <span style={{ color: "var(--c-adv-accent-dim)", fontSize: "calc(9px*var(--app-text-scale,1))" }}>🎲{t.skillHint}</span>}
                    </button>
                  ))}
                </div>
              )}
              {/* Fork: check-skill chip (tap → full skill list, no typos) */}
              {checkSkill.trim() && !freeMode && (
                <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", flexShrink: 0 }}>🎲</span>
                  <button type="button"
                    onClick={() => setSkillPickerOpen(true)}
                    style={{
                      padding: "5px 10px", borderRadius: 12,
                      border: "1px solid rgba(200,160,100,0.35)", background: "rgba(200,160,100,0.08)",
                      color: "var(--c-adv-accent)", fontSize: "calc(11px*var(--app-text-scale,1))",
                      cursor: "pointer", fontFamily: "inherit",
                      display: "flex", alignItems: "center", gap: 5,
                    }}>
                    {(() => { const p = skillCheckValue(save.playerSheet, checkSkill.trim(), save.playerStats, is7th ? "coc7" : "coc6"); return <>🎲 {checkSkill.trim()} {p.value}</>; })()}
                    <span onClick={e => { e.stopPropagation(); setCheckSkill(""); }} style={{ color: "var(--c-adv-text-muted)", padding: "0 2px", cursor: "pointer" }}>✕</span>
                  </button>
                  {is7th && diceMode !== "none" && (
                    <button type="button" onClick={() => setDiceMode("none")} style={{
                      padding: "5px 9px", borderRadius: 12, border: "1px solid var(--c-adv-input-border)",
                      background: "var(--c-adv-input-bg)", color: "var(--c-adv-text-dim)",
                      fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                    }}>
                      {diceMode === "bonus" ? "✦ 奖励骰 ✕" : "✖ 惩罚骰 ✕"}
                    </button>
                  )}
                </div>
              )}
              {/* Fork 八期B: private talk lives in the ➕ menu — NPC name input shows only when active */}
              {privateTalk && (
                <div style={{ display: "flex", gap: 5 }}>
                  <input
                    value={privateTalkNpc}
                    onChange={e => setPrivateTalkNpc(e.target.value)}
                    placeholder="对谁说（NPC名）"
                    style={{
                      flex: 1, minWidth: 0, padding: "5px 10px", borderRadius: 7,
                      border: "1px solid rgba(150,120,220,0.3)", background: "var(--c-adv-input-bg)",
                      color: "var(--c-adv-body)", fontSize: "calc(10px*var(--app-text-scale,1))", fontFamily: "inherit", outline: "none",
                    }}
                  />
                  <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(190,170,240,0.7)", alignSelf: "center" }}>🔒 发送后进入私聊记录</span>
                </div>
              )}
              {/* Fork: check-value preview (what will be rolled) */}
              {checkSkill.trim() && !freeMode && (() => {
                const preview = skillCheckValue(save.playerSheet, checkSkill.trim(), save.playerStats, is7th ? "coc7" : "coc6");
                return (
                  <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", padding: "0 2px", lineHeight: 1.6 }}>
                    将掷检定：<span style={{ color: "var(--c-adv-accent)" }}>{preview.source} {preview.value}</span>{is7th && diceMode !== "none" ? ` · ${diceMode === "bonus" ? "奖励骰" : "惩罚骰"}` : ""}
                  </div>
                );
              })()}
              {/* Fork: 7th-edition dice mode moved into the skill picker (per-roll) */}
              {/* Speech input */}
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", lineHeight: "32px", flexShrink: 0, width: 20, textAlign: "center" }}>💬</span>
                <input
                  ref={inputRef}
                  value={freeText}
                  onChange={e => setFreeText(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !freeMode) handleFreeInput();
                  }}
                  placeholder="说..."
                  disabled={eventContinueLoading || eventLoading || freeModeReplying}
                  style={{
                    flex: 1, minWidth: 0, padding: "7px 10px", borderRadius: 8,
                    border: `1px solid ${freeMode ? "rgba(100,180,255,0.12)" : "var(--c-adv-input-border)"}`,
                    background: "var(--c-adv-input-bg)",
                    color: "var(--c-adv-body)",
                    fontSize: "calc(13px*var(--app-text-scale,1))", fontFamily: "inherit", outline: "none",
                  }}
                />
              </div>

              {/* Action input */}
              <div style={{ display: "flex", gap: 6 }}>
                <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", lineHeight: "32px", flexShrink: 0, width: 20, textAlign: "center" }}>⚔</span>
                <input
                  value={freeAction}
                  onChange={e => setFreeAction(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter" && !freeMode) handleFreeInput();
                  }}
                  placeholder="做..."
                  disabled={eventContinueLoading || eventLoading || freeModeReplying}
                  style={{
                    flex: 1, minWidth: 0, padding: "7px 10px", borderRadius: 8,
                    border: `1px solid ${freeMode ? "rgba(100,180,255,0.12)" : "var(--c-adv-input-border)"}`,
                    background: "var(--c-adv-input-bg)",
                    color: "var(--c-adv-body)",
                    fontSize: "calc(13px*var(--app-text-scale,1))", fontFamily: "inherit", outline: "none",
                  }}
                />
              </div>
            </div>

            <button
              type="button"
              aria-label="发送行动"
              onClick={() => { if (!freeMode && checkSkill.trim()) submitDeclarationWithCheck(); else submitFreeInput(); }}
              disabled={(!freeText.trim() && !freeAction.trim() && !checkSkill.trim()) || eventContinueLoading || eventLoading || freeModeReplying}
              style={{
                width: 48,
                minHeight: 69,
                borderRadius: 9,
                border: "none",
                background: (freeText.trim() || freeAction.trim() || checkSkill.trim()) ? "var(--c-adv-accent-dim)" : "var(--c-adv-input-bg)",
                color: (freeText.trim() || freeAction.trim() || checkSkill.trim()) ? "var(--c-adv-accent)" : "var(--c-adv-text-muted)",
                cursor: (freeText.trim() || freeAction.trim() || checkSkill.trim()) && !freeModeReplying ? "pointer" : "default",
                flexShrink: 0,
                display: "grid",
                placeItems: "center",
              }}
            >
              <Send size={18} />
            </button>

            {/* Free mode: companion avatar row */}
            {freeMode && (
              <div style={{ display: "flex", flexDirection: "column", gap: 2, padding: "4px 0" }}>
                <div style={{ display: "flex", gap: 8, justifyContent: "center" }}>
                  {save.agents
                    .map(a => {
                      const ch = characters.find(c => c.id === a.characterId);
                      if (!ch) return null;
                      return (
                        <button key={a.characterId}
                          onClick={() => handleFreeModeChat(a.characterId)}
                          disabled={freeModeReplying}
                          style={{
                            display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
                            padding: "4px 6px", borderRadius: 8, border: "none", outline: "none",
                            background: "transparent", cursor: "pointer",
                            opacity: freeModeReplying ? 0.35 : 1,
                            WebkitTapHighlightColor: "transparent",
                          }}>
                          <div style={{
                            width: 32, height: 32, borderRadius: "50%",
                            backgroundImage: ch.avatar ? `url(${ch.avatar})` : "none",
                            backgroundColor: ch.avatar ? "transparent" : "var(--c-adv-choice-bg)",
                            backgroundSize: "cover", backgroundPosition: "center", backgroundRepeat: "no-repeat",
                            border: "1.5px solid var(--c-adv-accent-dim)",
                          }} />
                          <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-icon)" }}>{ch.name}</span>
                        </button>
                      );
                    })}
                </div>
                {freeModeReplying && (
                  <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(100,180,255,0.5)", textAlign: "center", fontFamily: "monospace" }}>
                    思考中...
                  </div>
                )}
              </div>
            )}
          </div>}
        </div>
      )}

      {/* ═══ Overlays ═══ */}

      {/* Fork: HO assignment modal — player picks first, KP assigns the rest */}
      {hoAssignOpen && save.investigatorLines && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 57,
          background: "rgba(5,5,10,0.75)", backdropFilter: "blur(6px)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        }}>
          <div style={{
            width: "min(420px, 100%)", maxHeight: "80vh", overflowY: "auto",
            background: "var(--c-adv-panel-bg)", borderRadius: 16,
            border: "1px solid rgba(190,170,240,0.3)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            padding: "18px 16px",
          }}>
            <div style={{ fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: 700, color: "var(--c-adv-accent)", marginBottom: 3 }}>🎭 选择你的密档线</div>
            <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
              本模组为每位调查员准备了私人剧情线——先选你要扮演哪条，剩下的由 KP 按各角色的人设贴合度分配给同伴。
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {save.investigatorLines.map(l => {
                const picked = hoAssignMap["__player__"] === l.ho;
                return (
                  <button key={l.ho} type="button" onClick={() => hoPickPlayer(l.ho)} style={{
                    padding: "9px 11px", borderRadius: 10, textAlign: "left", fontFamily: "inherit",
                    border: `1px solid ${picked ? "var(--c-adv-accent)" : "var(--c-adv-input-border)"}`,
                    background: picked ? "var(--c-adv-choice-bg)" : "var(--c-adv-input-bg)",
                    cursor: "pointer",
                  }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 3 }}>
                      <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 700, color: picked ? "var(--c-adv-accent)" : "var(--c-adv-text)" }}>{l.ho}</span>
                      {picked && <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", fontFamily: "monospace", letterSpacing: "0.15em" }}>✓ 你</span>}
                    </div>
                    <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                      {l.introStory || "（无导入剧情摘要）"}
                      {l.relations.length ? ` 〔${l.relations.map(r => r.npc).join("、")}〕` : ""}
                    </div>
                  </button>
                );
              })}
            </div>
            {Object.keys(hoAssignMap).length > 1 && (
              <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)" }}>
                <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4, letterSpacing: "0.1em" }}>KP 分配结果</div>
                {save.agents.map(a => {
                  const ch = characters.find(c => c.id === a.characterId);
                  const ho = hoAssignMap[a.characterId];
                  return (
                    <div key={a.characterId} style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", padding: "2px 0" }}>
                      <span>{ch?.name || a.characterId}</span>
                      <span style={{ color: ho ? "rgba(190,170,240,0.9)" : "var(--c-adv-text-muted)" }}>{ho || "—（未分）"}</span>
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <button type="button" onClick={hoKpAssign} disabled={!hoAssignMap["__player__"] || hoAssignLoading || save.agents.length === 0} style={{
                flex: 1, padding: "9px 0", borderRadius: 9,
                border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)",
                color: hoAssignLoading ? "var(--c-adv-text-muted)" : "var(--c-adv-text-dim)",
                fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              }}>
                {hoAssignLoading ? "⏳ KP 分配中..." : "🎲 KP 分配剩余"}
              </button>
              <button type="button" onClick={hoAssignConfirm} disabled={!hoAssignMap["__player__"]} style={{
                flex: 1, padding: "9px 0", borderRadius: 9,
                border: "none", background: "rgba(190,170,240,0.25)",
                color: "var(--c-adv-accent)", fontWeight: 600,
                fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              }}>
                确认并开始
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Fork: Skill Picker — full skill list from the sheet, tap to select (no typos) */}
      {skillPickerOpen && (() => {
        const allSkills = Object.keys(is7th ? SKILL_BASE_7 : SKILL_BASE_6);
        const sheetSkills = save.playerSheet?.skills || {};
        return (
          <div style={{
            position: "absolute", inset: 0, zIndex: 56,
            background: "rgba(5,5,10,0.7)", backdropFilter: "blur(6px)",
            display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
          }} onClick={() => setSkillPickerOpen(false)}>
            <div onClick={e => e.stopPropagation()} style={{
              width: "min(420px, 100%)", maxHeight: "78vh", overflowY: "auto",
              background: "var(--c-adv-panel-bg)", borderRadius: 16,
              border: "1px solid var(--c-adv-accent-dim)",
              boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
              padding: "16px 14px",
            }}>
              <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 700, color: "var(--c-adv-text)", marginBottom: 3 }}>🎲 选择检定技能</div>
              <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 12 }}>
                点选一项挂到本次宣言——数值取自你的角色卡（属性回退也标出）
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {allSkills.map(sk => {
                  const p = skillCheckValue(save.playerSheet, sk, save.playerStats, is7th ? "coc7" : "coc6");
                  const active = checkSkill.trim() === sk;
                  const trained = sheetSkills[sk] !== undefined;
                  return (
                    <button key={sk} type="button"
                      onClick={() => { setCheckSkill(active ? "" : sk); }}
                      style={{
                        padding: "6px 10px", borderRadius: 9,
                        border: `1px solid ${active ? "rgba(200,160,100,0.55)" : "var(--c-adv-input-border)"}`,
                        background: active ? "rgba(200,160,100,0.15)" : "var(--c-adv-input-bg)",
                        color: active ? "var(--c-adv-accent)" : trained ? "var(--c-adv-body)" : "var(--c-adv-text-muted)",
                        fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                        display: "flex", alignItems: "center", gap: 5,
                      }}>
                      {sk}
                      <span style={{ fontFamily: "monospace", fontSize: "calc(9px*var(--app-text-scale,1))", opacity: 0.75 }}>{p.value}</span>
                      {p.source.includes("(") && <span style={{ fontSize: "calc(8px*var(--app-text-scale,1))", opacity: 0.5 }}>属性</span>}
                    </button>
                  );
                })}
              </div>
              {is7th && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: "1px solid var(--c-adv-input-border)" }}>
                  <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 6 }}>骰型（7版）</div>
                  <div style={{ display: "flex", gap: 5 }}>
                    {([["none", "普通"], ["bonus", "奖励骰"], ["penalty", "惩罚骰"]] as const).map(([val, t]) => {
                      const active = diceMode === val;
                      return (
                        <button key={val} type="button"
                          onClick={() => setDiceMode(active ? "none" : val)}
                          style={{
                            flex: 1, padding: "6px 0", borderRadius: 7,
                            border: `1px solid ${active ? "var(--c-adv-accent-dim)" : "var(--c-adv-input-border)"}`,
                            background: active ? "var(--c-adv-choice-bg)" : "var(--c-adv-input-bg)",
                            color: active ? "var(--c-adv-accent)" : "var(--c-adv-text-muted)",
                            fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                          }}>
                          {val === "bonus" ? "✦ " : val === "penalty" ? "✖ " : ""}{t}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
                <button type="button" onClick={() => { setCheckSkill(""); setSkillPickerOpen(false); }} style={{
                  flex: 1, padding: "9px 0", borderRadius: 9,
                  border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)",
                  color: "var(--c-adv-text-dim)", fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>
                  {checkSkill.trim() ? "清除并关闭" : "关闭"}
                </button>
                <button type="button" onClick={() => setSkillPickerOpen(false)} style={{
                  flex: 1, padding: "9px 0", borderRadius: 9,
                  border: "none", background: "var(--c-adv-accent-dim)",
                  color: "var(--c-adv-accent)", fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                }}>
                  {checkSkill.trim() ? `确认 ${checkSkill.trim()}` : "不检定"}
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Picker Overlay — who rolls this round */}
      {pickerOverlay && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 55,
          background: "rgba(5,5,10,0.7)", backdropFilter: "blur(6px)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <div style={{
            width: 280, padding: "32px 20px",
            background: "var(--c-adv-panel-bg)",
            borderRadius: 24,
            border: "1px solid var(--c-adv-accent-dim)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 20,
          }}>
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", letterSpacing: "0.2em", fontFamily: "monospace" }}>
              谁来掷骰子？
            </div>
            <div style={{
              fontSize: "calc(28px*var(--app-text-scale,1))", fontWeight: 700, color: pickerOverlay.settled ? "var(--c-adv-accent)" : "var(--c-adv-text)",
              letterSpacing: "0.1em",
              transition: pickerOverlay.settled ? "color 0.3s, transform 0.3s" : "none",
              transform: pickerOverlay.settled ? "scale(1.2)" : "scale(1)",
            }}>
              {pickerOverlay.current}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {pickerOverlay.candidates.map(name => (
                <div key={name} style={{
                  width: 8, height: 8, borderRadius: "50%",
                  background: name === pickerOverlay.current
                    ? (pickerOverlay.settled ? "var(--c-adv-accent)" : "var(--c-adv-text-dim)")
                    : "var(--c-adv-text-muted)",
                  transition: "background 0.1s",
                }} />
              ))}
            </div>
            {pickerOverlay.settled && (
              <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", letterSpacing: "0.15em" }}>
                🎲 就是你了！
              </div>
            )}
          </div>
        </div>
      )}

      {/* Unified Dice Roll Overlay — 3D Cube (player manual / character auto) */}
      {diceOverlay && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 50,
          background: "rgba(5,5,10,0.7)", backdropFilter: "blur(6px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          animation: "overlay-fade-in 0.3s ease-out",
        }}>
          <div style={{
            width: 280, padding: "32px 20px",
            background: "var(--c-adv-panel-bg)",
            borderRadius: 24,
            border: "1px solid var(--c-adv-accent-dim)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            display: "flex", flexDirection: "column", alignItems: "center", gap: 16,
            animation: "popup-zoom-in 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards",
          }}>
            <style>{`
              @keyframes overlay-fade-in { from { opacity: 0; } to { opacity: 1; } }
              @keyframes popup-zoom-in { from { opacity: 0; transform: scale(0.9) translateY(20px); } to { opacity: 1; transform: scale(1) translateY(0); } }
              .dice-scene { perspective: 600px; width: 72px; height: 72px; }
              .dice-cube { width: 100%; height: 100%; position: relative; transform-style: preserve-3d; transform: rotateX(-20deg) rotateY(30deg); transition: transform 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275); }
              .dice-cube.rolling { animation: dice-toss 1.4s linear forwards; }
              .dice-cube.landed { animation: none; transform: rotateX(15deg) rotateY(15deg); }
              .dice-face { position: absolute; width: 72px; height: 72px; display: flex; align-items: center; justify-content: center; border-radius: 12px; background: var(--c-adv-panel-bg); border: 1px solid var(--c-adv-accent-dim); box-shadow: inset 0 0 16px rgba(0,0,0,0.5), 0 0 12px rgba(0,0,0,0.3); font-size: calc(24px*var(--app-text-scale,1)); font-weight: 800; font-family: 'Georgia', serif; color: var(--c-adv-accent); text-shadow: 0 2px 4px rgba(0,0,0,0.5); backface-visibility: hidden; }
              .dice-face::before { content: ''; position: absolute; inset: 2px; border-radius: 10px; border: 1px dashed var(--c-adv-text-muted); pointer-events: none; }
              .dice-face.front  { transform: translateZ(36px); }
              .dice-face.back   { transform: rotateY(180deg) translateZ(36px); }
              .dice-face.right  { transform: rotateY(90deg) translateZ(36px); }
              .dice-face.left   { transform: rotateY(-90deg) translateZ(36px); }
              .dice-face.top    { transform: rotateX(90deg) translateZ(36px); }
              .dice-face.bottom { transform: rotateX(-90deg) translateZ(36px); }
              @keyframes dice-toss {
                0%   { transform: translateY(0) scale(1) rotateX(0deg) rotateY(0deg); }
                35%  { transform: translateY(-130px) scale(1.15) rotateX(360deg) rotateY(120deg); }
                65%  { transform: translateY(10px) scale(0.9) rotateX(720deg) rotateY(240deg); }
                85%  { transform: translateY(-20px) scale(1.05) rotateX(940deg) rotateY(320deg); }
                100% { transform: translateY(0) scale(1) rotateX(1095deg) rotateY(375deg); }
              }
              @keyframes result-pop { 0% { transform: scale(0.8) translateY(15px); opacity: 0; } 50% { transform: scale(1.1) translateY(-5px); } 100% { transform: scale(1) translateY(0); opacity: 1; } }
              @keyframes text-glow { 0%, 100% { opacity: 0.85; } 50% { opacity: 1; } }
              .roll-btn { padding: 14px 40px; border-radius: 100px; background: var(--c-adv-accent-dim); border: 1px solid var(--c-adv-accent); color: var(--c-adv-accent); font-size: calc(16px*var(--app-text-scale,1)); font-weight: 700; letter-spacing: 0.25em; cursor: pointer; font-family: inherit; box-shadow: 0 8px 32px rgba(0,0,0,0.15); transition: all 0.2s; position: relative; overflow: hidden; width: 100%; box-sizing: border-box; }
              .roll-btn:hover { transform: translateY(-2px); opacity: 0.9; }
              .roll-btn:active { transform: translateY(1px); opacity: 0.8; }
            `}</style>

            {/* Who is rolling */}
            <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", letterSpacing: "0.15em" }}>
              {diceOverlay.name}
            </div>

            {/* Stat info */}
            <div style={{
              fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", letterSpacing: "0.15em",
              background: "var(--c-adv-input-bg)", padding: "6px 16px", borderRadius: 20,
              border: "1px solid var(--c-adv-input-border)",
            }}>
              <span style={{ color: "var(--c-adv-accent)" }}>{diceOverlay.label}</span> 判定 · 属性 <span style={{ color: "var(--c-adv-accent)" }}>{diceOverlay.statValue}</span>
            </div>

            {/* 3D Dice Cube */}
            {(diceRolling || diceNumber > 0) && (
              <div style={{ position: "relative", margin: "8px 0" }}>
                <div className="dice-scene">
                  <div className={`dice-cube ${diceRolling ? "rolling" : diceNumber ? "landed" : ""}`}>
                    {["front", "back", "right", "left", "top", "bottom"].map(face => (
                      <div key={face} className={`dice-face ${face}`}>
                        {diceNumber || "?"}
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Big result number after landing */}
            {!diceRolling && diceNumber > 0 ? (
              <div style={{
                fontSize: "calc(48px*var(--app-text-scale,1))", fontWeight: 900, fontFamily: "'Georgia', serif",
                color: "var(--c-adv-accent)", letterSpacing: "-1px",
                animation: "result-pop 0.6s cubic-bezier(0.175, 0.885, 0.32, 1.275) forwards, text-glow 2.5s ease-in-out infinite alternate",
              }}>
                {diceNumber}
              </div>
            ) : !diceRolling && diceNumber === 0 ? (
              <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", fontFamily: "monospace", letterSpacing: "0.25em" }}>
                D100 SYSTEM
              </div>
            ) : null}

            {/* Controls */}
            <div style={{ width: "100%", marginTop: 4 }}>
              {/* Player: manual roll button */}
              {diceOverlay.isPlayer && diceWaitingClick && (
                <button className="roll-btn" onClick={() => { if (diceResolveRef.current) diceResolveRef.current({ roll: 0, level: "" }); }}>
                  🎲 掷骰子
                </button>
              )}

              {/* Character: auto-roll indicator */}
              {!diceOverlay.isPlayer && !diceRolling && diceNumber === 0 && (
                <div style={{
                  fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", fontFamily: "monospace",
                  letterSpacing: "0.1em", textAlign: "center", padding: "10px 0",
                }}>
                  {diceOverlay.name} 投掷中...
                </div>
              )}

              {/* Rolling status */}
              {diceRolling && (
                <div style={{
                  fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", letterSpacing: "0.15em",
                  padding: "10px 0", textAlign: "center",
                  background: "var(--c-adv-input-bg)", borderRadius: 100,
                  border: "1px solid var(--c-adv-input-border)", width: "100%",
                }}>
                  命运判定中...
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ═══ CoC6 Combat Round Panel ═══ */}
      {combatOpen && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 58,
          background: "rgba(5,5,10,0.7)", backdropFilter: "blur(6px)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 20,
        }} onClick={() => setCombatOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "min(400px, 100%)", maxHeight: "80vh", overflowY: "auto",
            background: "var(--c-adv-panel-bg)", borderRadius: 16,
            border: "1px solid rgba(200,80,80,0.25)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            padding: "18px 16px",
          }}>
            <div style={{ fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: 700, color: "rgba(230,130,120,0.95)", marginBottom: 4, letterSpacing: "0.05em" }}>⚔️ 战斗轮</div>
            <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
              {showCombat ? "按先攻顺序行动。你的攻击检定照常掷骰，伤害骰由系统自动结算；结算出的伤害点面板上的 -5/-10/-20 记到目标身上。" : "按 KP 叙事填写敌方（名字、敏捷、HP），系统按敏捷排先攻开始战斗轮。"}
            </div>

            {/* Active combat state */}
            {showCombat && save.combat && (
              <>
                <div style={{ padding: "8px 10px", borderRadius: 8, background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)", marginBottom: 12 }}>
                  <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text)", marginBottom: 6 }}>
                    第 <span style={{ color: "var(--c-adv-accent)", fontFamily: "monospace" }}>{save.combat.round}</span> 轮 · 当前行动：
                    <span style={{ color: "rgba(230,130,120,0.95)", fontWeight: 600 }}>{combatCurrentToken ? tokenLabel(combatCurrentToken) : "—"}</span>
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {save.combat.initiative.map((t, i) => (
                      <span key={i} style={{
                        padding: "3px 8px", borderRadius: 10, fontSize: "calc(10px*var(--app-text-scale,1))",
                        background: i === save.combat!.currentIndex ? "rgba(200,80,80,0.25)" : "var(--c-adv-input-bg)",
                        border: `1px solid ${i === save.combat!.currentIndex ? "rgba(200,80,80,0.5)" : "var(--c-adv-input-border)"}`,
                        color: i === save.combat!.currentIndex ? "rgba(230,130,120,0.95)" : "var(--c-adv-text-muted)",
                      }}>
                        {tokenLabel(t)}
                      </span>
                    ))}
                  </div>
                </div>

                {/* Hostiles with damage ledger */}
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 6, fontFamily: "monospace", letterSpacing: "0.1em" }}>敌方状态</div>
                {save.combat.hostiles.filter(h => h.hp > 0).map(h => (
                  <div key={h.name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)", marginBottom: 5 }}>
                    <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-body)", flex: 1 }}>
                      {h.name}
                      {h.notes ? <span style={{ color: "var(--c-adv-text-muted)", fontSize: "calc(9px*var(--app-text-scale,1))", marginLeft: 4 }}>{h.notes}</span> : null}
                    </span>
                    <div style={{ width: 70, height: 5, borderRadius: 3, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                      <div style={{ width: `${(h.hp / h.maxHp) * 100}%`, height: "100%", background: "rgba(220,90,80,0.8)" }} />
                    </div>
                    <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(230,130,120,0.9)", fontFamily: "monospace", minWidth: 36, textAlign: "right" }}>{h.hp}/{h.maxHp}</span>
                    {[5, 10, 20].map(d => (
                      <button key={d} onClick={() => dealDamageToHostile(h.name, d)}
                        style={{
                          padding: "3px 6px", borderRadius: 5, border: "1px solid rgba(200,80,80,0.25)",
                          background: "rgba(200,80,80,0.08)", color: "rgba(230,130,120,0.9)",
                          fontSize: "calc(9px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                        }}>
                        -{d}
                      </button>
                    ))}
                  </div>
                ))}

                {/* Support checks: first aid / sanity recovery / psychoanalysis — best-valued member rolls */}
                <div style={{ marginTop: 10 }}>
                  <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 6, fontFamily: "monospace", letterSpacing: "0.1em" }}>辅助检定（队内最高值者掷骰）</div>
                  <div style={{ display: "flex", gap: 5 }}>
                    <button onClick={() => runSupportCheck("急救")}
                      style={{
                        flex: 1, padding: "8px 0", borderRadius: 8,
                        border: "1px solid rgba(120,200,140,0.3)", background: "rgba(120,200,140,0.08)",
                        color: "rgba(150,220,170,0.9)", fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                      }}>
                      💊 急救
                    </button>
                    <button onClick={() => runSupportCheck("意志")}
                      style={{
                        flex: 1, padding: "8px 0", borderRadius: 8,
                        border: "1px solid rgba(140,100,200,0.3)", background: "rgba(140,100,200,0.08)",
                        color: "rgba(180,150,230,0.9)", fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                      }}>
                      🧠 清醒检定
                    </button>
                    <button onClick={() => runSupportCheck("精神分析")}
                      style={{
                        flex: 1, padding: "8px 0", borderRadius: 8,
                        border: "1px solid rgba(120,180,220,0.3)", background: "rgba(120,180,220,0.08)",
                        color: "rgba(150,200,240,0.9)", fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                      }}>
                      🛋 精神分析
                    </button>
                  </div>
                </div>

                {/* Madness state */}
                {(save.madness?.temporary || save.madness?.permanent) && (
                  <div style={{ marginTop: 10, padding: "8px 10px", borderRadius: 8, background: "rgba(140,100,200,0.08)", border: "1px solid rgba(140,100,200,0.25)" }}>
                    <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(180,150,230,0.9)", marginBottom: 3, fontFamily: "monospace", letterSpacing: "0.1em" }}>疯狂状态</div>
                    <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-body)", lineHeight: 1.5 }}>
                      {save.madness.permanent ? "💀 永久疯狂 —— 心智已碎裂" : save.madness.temporary ? `🌀 临时疯狂（剩余 ${save.madness.temporary.rounds} 轮）：${save.madness.temporary.symptom}` : ""}
                    </div>
                  </div>
                )}

                <button onClick={() => { advanceCombatTurn(); }}
                  style={{
                    width: "100%", marginTop: 12, padding: "11px 0", borderRadius: 10,
                    border: "1px solid rgba(200,80,80,0.35)", background: "rgba(200,80,80,0.15)",
                    color: "rgba(230,130,120,0.95)", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 600,
                    cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.1em",
                  }}>
                  下一位行动 →
                </button>
                <button onClick={() => setCombatOpen(false)}
                  style={{
                    width: "100%", marginTop: 8, padding: "10px 0", borderRadius: 10,
                    border: "1px solid var(--c-adv-input-border)", background: "transparent",
                    color: "var(--c-adv-text-dim)", fontSize: "calc(12px*var(--app-text-scale,1))",
                    cursor: "pointer", fontFamily: "inherit",
                  }}>
                  收起面板
                </button>
              </>
            )}

            {/* Setup: no active combat */}
            {!showCombat && (
              <>
                {combatQueue.length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}>
                    {combatQueue.map((h, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", borderRadius: 8, background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)" }}>
                        <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-body)", flex: 1 }}>{h.name} · 敏捷{h.dex} · HP{h.hp}</span>
                        <button onClick={() => setCombatQueue(prev => prev.filter((_, j) => j !== i))}
                          style={{ background: "none", border: "none", color: "rgba(255,100,80,0.6)", cursor: "pointer", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit" }}>✕</button>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                  <input value={combatInput.name} onChange={e => setCombatInput(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="敌人名（如 深潜者A）"
                    style={{ flex: 2, minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)", color: "var(--c-adv-body)", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", outline: "none" }} />
                  <input value={combatInput.dex} onChange={e => setCombatInput(prev => ({ ...prev, dex: e.target.value }))} inputMode="numeric"
                    placeholder="敏捷"
                    style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)", color: "var(--c-adv-body)", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", outline: "none" }} />
                  <input value={combatInput.hp} onChange={e => setCombatInput(prev => ({ ...prev, hp: e.target.value }))} inputMode="numeric"
                    placeholder="HP"
                    style={{ flex: 1, minWidth: 0, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)", color: "var(--c-adv-body)", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", outline: "none" }} />
                </div>
                <button
                  onClick={() => {
                    const name = combatInput.name.trim();
                    const dex = parseInt(combatInput.dex, 10) || 50;
                    const hp = parseInt(combatInput.hp, 10) || 10;
                    if (!name) return;
                    setCombatQueue(prev => [...prev, makeHostile(name, dex, hp)]);
                    setCombatInput({ name: "", dex: "", hp: "" });
                  }}
                  style={{
                    width: "100%", padding: "10px 0", borderRadius: 10, marginBottom: 8,
                    border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)",
                    color: "var(--c-adv-text)", fontSize: "calc(12px*var(--app-text-scale,1))",
                    cursor: "pointer", fontFamily: "inherit",
                  }}>
                  + 添加敌人
                </button>
                <button onClick={() => { startCombat(combatQueue); setCombatQueue([]); }}
                  disabled={combatQueue.length === 0}
                  style={{
                    width: "100%", padding: "12px 0", borderRadius: 10,
                    border: "1px solid rgba(200,80,80,0.35)",
                    background: combatQueue.length === 0 ? "rgba(255,255,255,0.03)" : "rgba(200,80,80,0.2)",
                    color: combatQueue.length === 0 ? "rgba(255,255,255,0.25)" : "rgba(230,130,120,0.95)",
                    fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 600, letterSpacing: "0.1em",
                    cursor: combatQueue.length === 0 ? "default" : "pointer", fontFamily: "inherit",
                  }}>
                  ⚔️ 掷先攻，开始战斗
                </button>
                <button onClick={() => setCombatOpen(false)}
                  style={{
                    width: "100%", marginTop: 8, padding: "10px 0", borderRadius: 10,
                    border: "1px solid var(--c-adv-input-border)", background: "transparent",
                    color: "var(--c-adv-text-dim)", fontSize: "calc(12px*var(--app-text-scale,1))",
                    cursor: "pointer", fontFamily: "inherit",
                  }}>
                  取消
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ═══ Theme Panel ═══ */}
      {showThemePanel && (<>
        {/* Backdrop to close on outside click */}
        <div
          onClick={() => setShowThemePanel(false)}
          style={{ position: "absolute", inset: 0, zIndex: 44 }}
        />
        <div style={{
          position: "absolute", top: 90, right: 10, zIndex: 45,
          width: "min(280px, calc(100% - 20px))",
          background: "var(--c-adv-panel-bg)", borderRadius: 12,
          border: "1px solid var(--c-adv-input-border)",
          boxShadow: "0 2px 10px rgba(0,0,0,0.08)",
          padding: 14, maxHeight: "60vh", overflowY: "auto",
        }}>
          <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 10, letterSpacing: "0.1em" }}>主题设置</div>

          {/* Color scheme */}
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 6 }}>配色</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, marginBottom: 12 }}>
            {ADVENTURE_THEMES.map((s, i) => (
              <button key={i} onClick={() => { const t = { ...worldTheme, colorScheme: i }; setWorldTheme(t); saveWorldTheme(world.id, t); }}
                style={{
                  padding: "6px 0", borderRadius: 6, fontSize: "calc(10px*var(--app-text-scale,1))",
                  border: `1px solid ${(worldTheme.colorScheme ?? 0) === i ? "var(--c-adv-accent-dim)" : "var(--c-adv-input-border)"}`,
                  background: (worldTheme.colorScheme ?? 0) === i ? "var(--c-adv-choice-bg)" : "var(--c-adv-input-bg)",
                  color: s.preview, cursor: "pointer", fontFamily: "inherit",
                  display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: s.preview, flexShrink: 0 }} />
                {s.name}
              </button>
            ))}
          </div>

          {/* Custom font */}
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 6 }}>字体 {worldTheme.customFontName && <span style={{ color: "var(--c-adv-accent-dim)" }}>· {worldTheme.customFontName}</span>}</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            <label style={{
              flex: 1, padding: "6px 0", borderRadius: 6, textAlign: "center",
              border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)",
              color: "var(--c-adv-text-dim)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer",
            }}>
              上传字体
              <input type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={e => {
                const file = e.target.files?.[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = () => { const t = { ...worldTheme, customFont: reader.result as string, customFontName: file.name }; setWorldTheme(t); saveWorldTheme(world.id, t); };
                reader.readAsDataURL(file);
              }} />
            </label>
            {worldTheme.customFont && (
              <button onClick={() => { const t = { ...worldTheme, customFont: undefined, customFontName: undefined }; setWorldTheme(t); saveWorldTheme(world.id, t); }}
                style={{ padding: "6px 10px", borderRadius: 6, border: "1px solid rgba(255,100,80,0.2)", background: "transparent", color: "rgba(255,100,80,0.6)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer" }}>
                清除
              </button>
            )}
          </div>

          {/* Font scale */}
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4 }}>文字大小 <span style={{ color: "var(--c-adv-accent-dim)" }}>{Math.round((worldTheme.fontScale || 1) * 100)}%</span></div>
          <input type="range" className="adv-slider" min="0.7" max="1.5" step="any" value={worldTheme.fontScale || 1}
            onChange={e => { const t = { ...worldTheme, fontScale: parseFloat(e.target.value) }; setWorldTheme(t); saveWorldTheme(world.id, t); }} />

          {/* Line height scale */}
          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4 }}>行间距 <span style={{ color: "var(--c-adv-accent-dim)" }}>{Math.round((worldTheme.lineHeightScale || 1) * 100)}%</span></div>
          <input type="range" className="adv-slider" min="0.8" max="2.0" step="any" value={worldTheme.lineHeightScale || 1}
            onChange={e => { const t = { ...worldTheme, lineHeightScale: parseFloat(e.target.value) }; setWorldTheme(t); saveWorldTheme(world.id, t); }} />

        </div>
      </>)}

      {/* ═══ Floating Actions + Tool Drawer Handle ═══ */}
      {!showToolPanel && (<>
        {/* Direct resolve button (free mode + in event) */}
        {!save.completed && save.agents.length > 0 && freeMode && inEvent && (
          <button onClick={handleDirectResolve} style={{
            position: "absolute", right: 10, bottom: 282, zIndex: 40,
            width: 44, height: 44, borderRadius: "50%",
            background: "rgba(255,180,80,0.2)",
            border: "1px solid rgba(255,180,80,0.4)",
            backdropFilter: "blur(8px)",
            boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
            color: "var(--c-adv-accent)",
            fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit", fontWeight: 500,
            cursor: "pointer",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}>
            裁决
          </button>
        )}
        {/* Event action drawer handle */}
        {showEventActionHandle && (
          <button
            type="button"
            aria-label="打开事件操作"
            aria-expanded={showEventActionDrawer}
            onClick={() => setShowEventActionDrawer(prev => !prev)}
            style={{
              position: "absolute",
              right: 0,
              top: "calc(50% + 78px)",
              transform: "translateY(-50%)",
              zIndex: 40,
              width: 30,
              minHeight: 54,
              borderRadius: "14px 0 0 14px",
              background: "var(--c-adv-bar-bg)",
              border: "1px solid var(--c-adv-accent-dim)",
              borderRight: "none",
              backdropFilter: "blur(10px)",
              boxShadow: "-1px 0 5px rgba(0,0,0,0.08)",
              color: "var(--c-adv-accent-dim)",
              cursor: "pointer",
              display: "grid",
              placeItems: "center",
            }}
          >
            <MoreHorizontal size={15} />
          </button>
        )}
        {showEventActionDrawer && showEventActionHandle && (
          <>
            <div
              onClick={() => setShowEventActionDrawer(false)}
              style={{ position: "absolute", inset: 0, zIndex: 41 }}
            />
            <div
              role="dialog"
              aria-label="事件操作"
              style={{
                position: "absolute",
                right: 0,
                top: "calc(50% + 42px)",
                zIndex: 42,
                width: "min(256px, 78%)",
                maxHeight: "calc(100% - 210px)",
                overflowY: "auto",
                padding: 10,
                borderRadius: "16px 0 0 16px",
                border: "1px solid var(--c-adv-input-border)",
                borderRight: "none",
                background: "var(--c-adv-bar-bg)",
                backdropFilter: "blur(12px)",
                boxShadow: "-2px 0 10px rgba(0,0,0,0.08)",
                display: "flex",
                flexDirection: "column",
                gap: 8,
              }}
            >
              {canToggleFreeMode && (
                <button
                  type="button"
                  onClick={handleToggleFreeMode}
                  style={{
                    width: "100%",
                    padding: "10px 11px",
                    borderRadius: 12,
                    border: `1px solid ${freeMode ? "rgba(100,180,255,0.35)" : "var(--c-adv-input-border)"}`,
                    background: freeMode ? "rgba(100,180,255,0.12)" : "var(--c-adv-input-bg)",
                    color: "var(--c-adv-text)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <MessageCircle size={17} color={freeMode ? "rgba(100,180,255,0.9)" : "var(--c-adv-accent)"} style={{ marginTop: 1, flexShrink: 0 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 700, lineHeight: 1.25 }}>
                      {freeMode ? "结束自由交流" : "自由交流"}
                    </span>
                    <span style={{ display: "block", marginTop: 4, fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", lineHeight: 1.45 }}>
                      {freeMode ? "回到正常事件行动与 DM 裁决流程。" : "先和同伴对话，暂不推进 DM 裁决。"}
                    </span>
                  </span>
                </button>
              )}
              {canExitCurrentEvent && (
                <button
                  type="button"
                  onClick={() => {
                    setShowEventActionDrawer(false);
                    handleEventExit();
                  }}
                  style={{
                    width: "100%",
                    padding: "10px 11px",
                    borderRadius: 12,
                    border: "1px solid rgba(255,80,60,0.18)",
                    background: "rgba(255,80,60,0.06)",
                    color: "var(--c-adv-text)",
                    cursor: "pointer",
                    fontFamily: "inherit",
                    textAlign: "left",
                    display: "flex",
                    gap: 10,
                    alignItems: "flex-start",
                  }}
                >
                  <LogOut size={17} color="rgba(255,90,70,0.62)" style={{ marginTop: 1, flexShrink: 0 }} />
                  <span style={{ minWidth: 0 }}>
                    <span style={{ display: "block", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 700, lineHeight: 1.25 }}>退出事件</span>
                    <span style={{ display: "block", marginTop: 4, fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", lineHeight: 1.45 }}>
                      离开当前事件，回到探索状态。
                    </span>
                  </span>
                </button>
              )}
            </div>
          </>
        )}
        {/* Tool drawer handle */}
        <button
          type="button"
          aria-label="打开冒险工具栏"
          onClick={() => {
            setShowEventActionDrawer(false);
            setShowToolPanel(true);
          }}
          style={{
            position: "absolute",
            right: 0,
            top: "50%",
            transform: "translateY(-50%)",
            zIndex: 40,
            width: 30,
            minHeight: 76,
            borderRadius: "14px 0 0 14px",
            background: "var(--c-adv-bar-bg)",
            border: "1px solid var(--c-adv-accent-dim)",
            borderRight: "none",
            backdropFilter: "blur(10px)",
            boxShadow: "-1px 0 5px rgba(0,0,0,0.08)",
            color: "var(--c-adv-accent)",
            cursor: "pointer",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 0,
            fontFamily: "inherit",
          }}
        >
          <MapIcon size={15} />
        </button>
      </>)}

      {/* ═══ Tool Drawer (Map + Status + Companions) ═══ */}
      {showToolPanel && (
        <>
          {/* Backdrop */}
          <div style={{
            position: "absolute",
            inset: 0,
            zIndex: 39,
            background: "rgba(0,0,0,0.18)",
            backdropFilter: "blur(2px)",
          }} onClick={() => setShowToolPanel(false)} />

          {/* Drawer */}
          <div style={{
            position: "absolute",
            top: "calc(150px + env(safe-area-inset-top, 0px))",
            right: 0,
            bottom: freeMode ? 214 : inEvent ? 191 : 151,
            width: "min(360px, 82%)",
            zIndex: 40,
            background: "var(--c-adv-bar-bg)",
            border: "1px solid var(--c-adv-input-border)",
            borderRight: "none",
            borderRadius: "20px 0 0 20px",
            boxShadow: "-2px 0 10px rgba(0,0,0,0.08)",
            backdropFilter: "blur(12px)",
            display: "flex", flexDirection: "column",
            overflow: "hidden",
            animation: "tool-drawer-in 0.24s ease-out",
          }}>
            <style>{`
              @keyframes tool-drawer-in {
                from { opacity: 0.82; transform: translateX(24px); }
                to { opacity: 1; transform: translateX(0); }
              }
            `}</style>

            {/* Tab bar */}
            <div style={{
              display: "flex", borderBottom: "1px solid var(--c-adv-input-border)",
              flexShrink: 0,
            }}>
              {(["map", "bag", "clues", "contacts"] as const).map(tab => (
                <button key={tab} onClick={() => setToolTab(tab)}
                  style={{
                    flex: 1, padding: "10px 0",
                    background: "none", border: "none",
                    borderBottom: toolTab === tab ? "2px solid var(--c-adv-accent-dim)" : "2px solid transparent",
                    color: toolTab === tab ? "var(--c-adv-accent)" : "var(--c-adv-text-muted)",
                    fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                    letterSpacing: "0.05em",
                  }}>
                  {tab === "map" ? "🗺 地图" : tab === "bag" ? "📊 状态" : tab === "clues" ? "🗂 线索" : "💬 同伴"}
                </button>
              ))}
              <button onClick={() => setShowToolPanel(false)} style={{
                padding: "10px 14px", background: "none", border: "none",
                color: "var(--c-adv-text-muted)", fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer",
              }}>✕</button>
            </div>

            {/* Tab content */}
            {toolTab === "map" ? (
              <div style={{ flex: 1, position: "relative" }}>
                <MapRenderer
                  data={renderedMap}
                  currentNodeId={save.currentNodeId}
                  selectedNodeId={selectedNodeId}
                  discoveredNodes={save.discoveredNodes}
                  visitedNodes={save.visitedNodes}
                  agentPositions={save.agents.map(a => ({ nodeId: a.currentNodeId, name: charName(a.characterId), avatar: characters.find(c => c.id === a.characterId)?.avatar || undefined }))}
                  playerAvatar={userIdentity?.avatarUrl}
                  playerName={userIdentity?.name || "我"}
                  onNodeClick={(id) => {
                    if (!inEvent && !eventLoading) {
                      setSelectedNodeId(id === selectedNodeId ? null : id);
                    }
                  }}
                />
                {/* Selected node info at bottom of map */}
                {selectedNode && !inEvent && !eventLoading && (() => {
                  // Find node content from richRegions
                  const region = skeleton.richRegions[selectedNode.regionIdx];
                  let nodeContent: import("@/lib/map-types").NodeContent | undefined;
                  if (selectedNode.type === "l2") {
                    nodeContent = region?.l2_nodes.find(n => n.name === selectedNode.name);
                  } else if (selectedNode.type === "l3") {
                    nodeContent = region?.l3_nodes.find(n => n.name === selectedNode.name);
                  }
                  const l1Npc = selectedNode.type === "l1" ? region?.l1_npc : undefined;
                  const l1Quest = selectedNode.type === "l1" ? region?.l1_quest : undefined;
                  const npc = nodeContent?.npc || l1Npc;
                  const quest = nodeContent?.quest || l1Quest;
                  const encounter = nodeContent?.encounter;

                  return (
                    <div style={{
                      position: "absolute", bottom: 0, left: 0, right: 0, zIndex: 10,
                      padding: "10px 12px",
                      background: "linear-gradient(transparent, var(--c-adv-bar-bg) 30%)",
                    }}>
                      {/* Header */}
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
                          <span style={{ fontSize: "calc(8px*var(--app-text-scale,1))", padding: "1px 4px", borderRadius: 3, background: "var(--c-adv-input-border)", color: "var(--c-adv-text-muted)", fontFamily: "monospace", flexShrink: 0 }}>{selectedNode.type.toUpperCase()}</span>
                          <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 600, color: "var(--c-adv-accent)", whiteSpace: "nowrap" }}>{selectedNode.name}</span>
                          {selectedNode.id === save.currentNodeId && (
                            <span style={{ fontSize: "calc(8px*var(--app-text-scale,1))", padding: "1px 4px", borderRadius: 3, background: "var(--c-adv-accent-dim)", color: "var(--c-adv-accent-dim)", fontFamily: "monospace", flexShrink: 0 }}>HERE</span>
                          )}
                        </div>
                        <div style={{ display: "flex", alignItems: "center", gap: 5, flexShrink: 0 }}>
                          {selectedNode.id !== save.currentNodeId && isVisible(selectedNode.id) && nearbyNodes.some(n => n.id === selectedNode.id) && (
                            <button onClick={() => { handleMoveWithAgents(selectedNode.id); setShowToolPanel(false); }}
                              style={{
                                padding: "5px 10px", borderRadius: 6,
                                border: "1px solid var(--c-adv-accent-dim)",
                                background: "var(--c-adv-choice-bg)",
                                color: "var(--c-adv-accent)",
                                fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                              }}>
                              前往
                            </button>
                          )}
                          <button onClick={() => setSelectedNodeId(null)} style={{
                            background: "none", border: "none", color: "var(--c-adv-text-muted)",
                            fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer",
                          }}>✕</button>
                        </div>
                      </div>
                      {/* Details */}
                      <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                        {npc && (
                          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)", lineHeight: 1.4 }}>
                            <span style={{ color: "var(--c-adv-accent-dim)" }}>{npc.role === "creature" ? "👁 异象/怪物" : "💬"} {npc.role === "creature" && !npc.name.includes("（异象）") ? "" : npc.name}</span>
                            <span style={{ color: "var(--c-adv-text-muted)", marginLeft: 4 }}>{npc.personality.length > 40 ? npc.personality.slice(0, 40) + "..." : npc.personality}</span>
                          </div>
                        )}
                        {quest && (
                          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)" }}>
                            <span style={{ color: "rgba(140,200,140,0.6)" }}>📋 {quest.title}</span>
                            <span style={{ color: "var(--c-adv-text-muted)", marginLeft: 4 }}>{quest.brief}</span>
                          </div>
                        )}
                        {encounter && (
                          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)" }}>
                            <span style={{ color: "rgba(200,140,140,0.6)" }}>⚡ {encounter.mood}</span>
                            <span style={{ color: "var(--c-adv-text-muted)", marginLeft: 4 }}>{encounter.brief}</span>
                          </div>
                        )}
                        {!npc && !quest && !encounter && (
                          <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)" }}>暂无特殊内容</div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            ) : toolTab === "bag" ? (
              /* Bag tab — CoC6 character sheet */
              <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
                {/* Occupation header */}
                <div style={{ padding: "8px 10px", borderRadius: 8, background: "var(--c-adv-choice-bg)", border: "1px solid var(--c-adv-input-border)", marginBottom: 12, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 700, color: "var(--c-adv-accent)" }}>{save.playerSheet?.occupation || "调查员"}</div>
                    <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 2 }}>
                      信用评级 {save.playerSheet?.creditRating ?? "?"} · DB {dbFromStats(save.playerStats || { str: 50, con: 50, pow: 50, dex: 50, app: 50, siz: 50, int: 50, edu: 50, san: 50, lck: 50 })}
                    </div>
                  </div>
                  <div style={{ textAlign: "right", fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", lineHeight: 1.6 }}>
                    <div>HP {save.hp}/{save.maxHp}</div>
                    <div>MP {Math.floor((save.playerStats?.pow || 50) / 25)}</div>
                    <div>SAN {typeof save.san === "number" ? save.san : "?"}/99</div>
                  </div>
                </div>

                {/* Player stats */}
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>属性</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
                  {ALL_STATS.map(k => (
                    <div key={k} style={{
                      padding: "5px 8px", borderRadius: 6,
                      background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)",
                      fontSize: "calc(11px*var(--app-text-scale,1))", textAlign: "center", minWidth: 60,
                    }}>
                      <div style={{ color: "var(--c-adv-text-muted)", fontSize: "calc(9px*var(--app-text-scale,1))" }}>{STAT_LABELS[k]}</div>
                      <div style={{ color: "var(--c-adv-accent)", fontWeight: 600, marginTop: 2 }}>{save.playerStats?.[k] ?? "?"}</div>
                    </div>
                  ))}
                </div>

                {/* Trained skills */}
                {save.playerSheet && (
                  <>
                    <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>技能（本职+兴趣）</div>
                    <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 14 }}>
                      {Object.entries(save.playerSheet.skills)
                        .sort((a, b) => b[1] - a[1])
                        .map(([name, val]) => (
                          <div key={name} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 8px", borderRadius: 6, background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)" }}>
                            <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-body)", flex: 1 }}>{name}</span>
                            <div style={{ width: 90, height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
                              <div style={{ width: `${Math.min(100, val)}%`, height: "100%", background: "var(--c-adv-accent-dim)" }} />
                            </div>
                            <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-accent)", fontFamily: "monospace", minWidth: 26, textAlign: "right" }}>{val}</span>
                          </div>
                        ))}
                    </div>

                    {/* Weapons */}
                    {save.playerSheet.weapons.length > 0 && (
                      <>
                        <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>武器</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, marginBottom: 14 }}>
                          {save.playerSheet.weapons.map((w, i) => (
                            <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "5px 8px", borderRadius: 6, background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)" }}>
                              <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-body)" }}>{w.name} <span style={{ color: "var(--c-adv-text-muted)", fontSize: "calc(9px*var(--app-text-scale,1))" }}>{w.range ? `· ${w.range}` : ""}{w.shots ? `· ${w.shots}发` : ""}</span></span>
                              <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-accent)", fontFamily: "monospace" }}>
                                {save.playerSheet!.skills[w.skill] ?? 25}% · {w.damage}
                              </span>
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </>
                )}

                {/* Items */}
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>随身物品</div>
                {save.playerSheet?.equipment?.length ? (
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginBottom: 10 }}>
                    {save.playerSheet.equipment.map((item, i) => (
                      <span key={i} style={{ padding: "3px 8px", borderRadius: 12, background: "var(--c-adv-choice-bg)", border: "1px solid var(--c-adv-input-border)", fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-dim)" }}>{item}</span>
                    ))}
                  </div>
                ) : null}

                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", margin: "8px 0", fontFamily: "monospace", letterSpacing: "0.1em" }}>调查获得</div>
                {save.director.keyItems.length === 0 ? (
                  <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", textAlign: "center", padding: "20px 0" }}>
                    空空如也~
                  </div>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {save.director.keyItems.map((item, i) => (
                      <div key={i} style={{
                        padding: "7px 10px", borderRadius: 6,
                        background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)",
                        fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-body)",
                      }}>
                        {item}
                      </div>
                    ))}
                  </div>
                )}

                {/* Pacing control */}
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 14, marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>剧情节奏</div>
                <div style={{ display: "flex", gap: 4 }}>
                  {([["relaxed", "悠闲"], ["normal", "适中"], ["fast", "紧凑"]] as const).map(([val, label]) => (
                    <button key={val} onClick={() => persistSave({ ...save, pacing: val })}
                      style={{
                        flex: 1, padding: "6px 0", borderRadius: 6, fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit",
                        border: `1px solid ${(save.pacing || "normal") === val ? "var(--c-adv-accent-dim)" : "var(--c-adv-input-border)"}`,
                        background: (save.pacing || "normal") === val ? "var(--c-adv-choice-bg)" : "var(--c-adv-input-bg)",
                        color: (save.pacing || "normal") === val ? "var(--c-adv-accent)" : "var(--c-adv-text-muted)",
                        cursor: "pointer",
                      }}>
                      {label}
                    </button>
                  ))}
                </div>

                {/* Manual summary button (for this world) */}
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 14, marginBottom: 8, fontFamily: "monospace", letterSpacing: "0.1em" }}>冒险总结</div>
                <button onClick={async () => {
                  const apiConfig = resolveAuxiliaryApiConfig("memorySummaryApiConfigId") || loadApiConfigs().find(c => c.apiKey);
                  if (!apiConfig?.apiKey) return;
                  pushMessages({ id: mkId(), type: "system", text: "正在总结冒险经历..." });
                  try {
                    await generateAdventureSummary(save, skeleton.world.name, apiConfig);
                    pushMessages({ id: mkId(), type: "system", text: "冒险总结已更新" });
                  } catch (e) {
                    pushMessages({ id: mkId(), type: "system", text: `总结失败：${e instanceof Error ? e.message : String(e)}` });
                  }
                }} style={{
                  width: "100%", padding: "7px 0", borderRadius: 6, marginBottom: 8,
                  border: "1px solid var(--c-adv-accent-dim)", background: "var(--c-adv-choice-bg)",
                  color: "var(--c-adv-accent-dim)", fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>
                  立即总结本次冒险
                </button>

                {/* Game info */}
                <div style={{ marginTop: 14, fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", fontFamily: "monospace" }}>
                  <div>HP {save.hp}/{save.maxHp} · {formatGameTime(save.gameDay, save.gameTime)}</div>
                  <div style={{ marginTop: 2 }}>{currentNode?.name}</div>
                  <div style={{ marginTop: 2 }}>主线 第{Math.min(save.mainQuestStage + 1, skeleton.mainQuest.stages.length)}/{skeleton.mainQuest.stages.length}阶段</div>
                </div>

                {/* My persona card (fork 十二期 — module-era identity) */}
                {save.myPersona && (
                  <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "var(--c-adv-choice-bg)", border: "1px solid var(--c-adv-accent-dim)" }}>
                    <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", marginBottom: 4, fontFamily: "monospace", letterSpacing: "0.1em" }}>🎭 你的模组身份</div>
                    <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 600, color: "var(--c-adv-text)" }}>{save.myPersona.name} · {save.myPersona.occupation}</div>
                    {save.myPersona.background && <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 4, lineHeight: 1.6 }}>{save.myPersona.background}</div>}
                    {save.myPersona.hooks && <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 3, opacity: 0.75 }}>你私下在意：{save.myPersona.hooks}</div>}
                  </div>
                )}

                {/* My secret card (fork 八期A — visible to user only, reveal timing is theirs) */}
                {save.mySecret && (
                  <div style={{ marginTop: 14, padding: "10px 12px", borderRadius: 8, background: "rgba(150,120,220,0.08)", border: "1px solid rgba(150,120,220,0.25)" }}>
                    <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", marginBottom: 4, fontFamily: "monospace", letterSpacing: "0.1em" }}>🤫 你保守的秘密</div>
                    <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-body)", lineHeight: 1.6 }}>{save.mySecret.content}</div>
                    {save.mySecret.link && <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 4 }}>与真相的关联：{save.mySecret.link}</div>}
                    {save.mySecret.informant && <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)" }}>知道更多的人：{save.mySecret.informant}</div>}
                    <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 6, opacity: 0.7 }}>是否公开、何时摊牌，由你决定——KP 不会替你说破</div>
                  </div>
                )}
              </div>
            ) : toolTab === "clues" ? (
              /* Clue board — archived clues grouped by location (fork) */
              <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
                {(save.clues || []).length === 0 ? (
                  <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", textAlign: "center", padding: "40px 0" }}>
                    还没有归档的线索
                  </div>
                ) : (() => {
                  const byLoc = new Map<string, { text: string; day: string }[]>();
                  for (const c of save.clues!) {
                    if (!byLoc.has(c.location)) byLoc.set(c.location, []);
                    byLoc.get(c.location)!.push({ text: c.text, day: c.day });
                  }
                  return [...byLoc.entries()].map(([loc, list]) => (
                    <div key={loc} style={{ marginBottom: 12 }}>
                      <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", marginBottom: 5, letterSpacing: "0.08em" }}>📍 {loc}</div>
                      {list.map((c, i) => (
                        <div key={i} style={{ padding: "6px 10px", borderRadius: 6, background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)", marginBottom: 4, fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-body)", lineHeight: 1.5 }}>
                          {c.text}
                          <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 2 }}>{c.day}</div>
                        </div>
                      ))}
                    </div>
                  ));
                })()}
              </div>
            ) : (
              /* Contacts tab */
              <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
                {save.agents.length === 0 ? (
                  <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", textAlign: "center", padding: "40px 0" }}>
                    没有同伴
                  </div>
                ) : save.agents.map(a => {
                  const name = charName(a.characterId);
                  const nodeName = allNodes.find(n => n.id === a.currentNodeId)?.name || "未知";
                  return (
                    <div key={a.characterId} style={{
                      padding: "8px 10px", borderRadius: 8, marginBottom: 5,
                      border: "1px solid var(--c-adv-input-border)",
                      background: "var(--c-adv-input-bg)",
                    }}>
                      <div style={{ fontWeight: 500, fontSize: "calc(12px*var(--app-text-scale,1))", color: "var(--c-adv-text)" }}>
                        {name}
                        {a.sheet && <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", marginLeft: 6, fontWeight: 400 }}>{a.persona?.occupation || a.sheet.occupation} · 信用{a.sheet.creditRating}{a.sheet.weapons.length ? ` · ${a.sheet.weapons.map(w => w.name).join("、")}` : ""}</span>}
                      </div>
                      {a.persona?.background && (
                        <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 2, lineHeight: 1.5 }}>{a.persona.background}</div>
                      )}
                      <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 2 }}>
                        📍 {nodeName} · HP {a.hp}/{a.maxHp} · SAN {typeof a.san === "number" ? a.san : (a.stats?.san ?? "?")} · ❤️ {a.affinity}
                      </div>
                      {a.sheet && (
                        <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 3, lineHeight: 1.5 }}>
                          {Object.entries(a.sheet.skills).sort((x, y) => y[1] - x[1]).slice(0, 6).map(([sn, sv]) => `${sn}${sv}`).join(" ")}…
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Debug panel */}
      {showDebug && (() => {
        const isChar = (type: string) => type.includes("角色");
        const isRoundStart = (type: string) =>
          type === "发送·system" ||
          type === "DM裁决·system" ||
          type === "DM场景·发送" ||
          type === "DM裁决·发送" ||
          type === "DM结局·发送";

        // Find start of current round. Companion declarations happen before DM resolve,
        // so include the contiguous character calls immediately before the latest DM裁决.
        const roundStartIdx = (() => {
          let dmStartIdx = 0;
          for (let i = debugLog.length - 1; i >= 0; i--) {
            if (isRoundStart(debugLog[i].type)) {
              dmStartIdx = i;
              break;
            }
          }
          if (debugLog[dmStartIdx]?.type === "DM裁决·发送") {
            let start = dmStartIdx;
            while (start > 0 && isChar(debugLog[start - 1].type)) start--;
            return start;
          }
          return dmStartIdx;
        })();

        const filteredLog = (() => {
          if (debugFilter === "current") return debugLog.slice(roundStartIdx);
          if (debugFilter === "dm") return debugLog.filter(log => !isChar(log.type));
          if (debugFilter === "char") return debugLog.filter(log => isChar(log.type));
          return debugLog;
        })();

        const filterCounts: Record<"current" | "dm" | "char" | "all", number> = {
          current: debugLog.slice(roundStartIdx).length,
          dm: debugLog.filter(log => !isChar(log.type)).length,
          char: debugLog.filter(log => isChar(log.type)).length,
          all: debugLog.length,
        };

        const debugFilterTabs = [
          { label: "当前轮", val: "current" },
          { label: "DM", val: "dm" },
          { label: "角色", val: "char" },
          { label: "全部", val: "all" },
        ] as const;

        const tabBtn = (label: string, val: "current" | "dm" | "char" | "all") => {
          const active = debugFilter === val;
          return (
            <button
              key={val}
              type="button"
              onClick={() => setDebugFilter(val)}
              style={{
                minHeight: 44,
                padding: "8px 10px",
                borderRadius: 12,
                border: `1px solid ${active ? "var(--c-adv-accent)" : "var(--c-adv-input-border)"}`,
                background: active ? "var(--c-adv-choice-bg)" : "var(--c-adv-input-bg)",
                color: active ? "var(--c-adv-text)" : "var(--c-adv-text-muted)",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 2,
                cursor: "pointer",
                fontFamily: "inherit",
              }}
            >
              <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 700, lineHeight: 1.2 }}>{label}</span>
              <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: active ? "var(--c-adv-accent)" : "var(--c-adv-text-muted)", lineHeight: 1.2 }}>
                {filterCounts[val]} 条
              </span>
            </button>
          );
        };

        return (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="调试记录"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 55,
              background: "var(--c-adv-debug-overlay)",
              backdropFilter: "blur(8px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "max(16px, env(safe-area-inset-top, 0px)) 12px max(16px, env(safe-area-inset-bottom, 0px))",
            }}
          >
            <div
              style={{
                width: "min(680px, 100%)",
                height: "min(760px, 88dvh)",
                borderRadius: "var(--c-adv-debug-radius)",
                border: "1px solid var(--c-adv-input-border)",
                background: "var(--c-adv-debug-panel-bg)",
                boxShadow: "var(--c-adv-debug-shadow)",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
                fontFamily: "var(--adv-font), PingFang SC, system-ui, sans-serif",
              }}
            >
              <div style={{ padding: "16px 16px 12px", borderBottom: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-debug-header-bg)", flexShrink: 0 }}>
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "calc(18px*var(--app-text-scale,1))", fontWeight: 800, color: "var(--c-adv-text)", lineHeight: 1.2 }}>调试记录</div>
                    <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 5, lineHeight: 1.4 }}>
                      {debugLog.length > 0 ? `${debugLog.length} 条交互记录` : "触发事件后会显示 LLM 交互记录"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                    <button
                      type="button"
                      onClick={() => setDebugLog([])}
                      disabled={debugLog.length === 0}
                      style={{
                        minWidth: 56,
                        minHeight: 44,
                        padding: "0 14px",
                        borderRadius: 14,
                        border: "1px solid var(--c-adv-input-border)",
                        background: "var(--c-adv-input-bg)",
                        color: debugLog.length === 0 ? "var(--c-adv-text-muted)" : "var(--c-adv-text)",
                        fontSize: "calc(13px*var(--app-text-scale,1))",
                        fontWeight: 700,
                        cursor: debugLog.length === 0 ? "default" : "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      清空
                    </button>
                    <button
                      type="button"
                      aria-label="关闭调试记录"
                      onClick={() => setShowDebug(false)}
                      style={{
                        width: 44,
                        height: 44,
                        borderRadius: 14,
                        border: "1px solid var(--c-adv-input-border)",
                        background: "var(--c-adv-input-bg)",
                        color: "var(--c-adv-text)",
                        display: "grid",
                        placeItems: "center",
                        cursor: "pointer",
                      }}
                    >
                      <X size={19} />
                    </button>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8, marginTop: 14 }}>
                  {debugFilterTabs.map(tab => tabBtn(tab.label, tab.val))}
                </div>
              </div>

              <div style={{ flex: 1, overflow: "auto", padding: "14px 14px 18px" }}>
                {filteredLog.length === 0 ? (
                  <div style={{ color: "var(--c-adv-text-muted)", fontSize: "calc(13px*var(--app-text-scale,1))", textAlign: "center", padding: "64px 18px" }}>
                    {debugLog.length === 0 ? "当前页面暂无 LLM 交互记录；触发事件或继续行动后会显示。" : "此分类暂无记录"}
                  </div>
                ) : filteredLog.map((log, i) => {
                  const char = isChar(log.type);
                  const isRecv = log.type.includes("返回");
                  const isSystem = log.type.includes("system") || log.type === "配置";
                  const color = char
                    ? "var(--c-adv-debug-char)"
                    : isRecv
                      ? "var(--c-adv-debug-recv)"
                      : isSystem
                        ? "var(--c-adv-debug-system)"
                        : "var(--c-adv-debug-dm)";
                  const bg = char
                    ? "var(--c-adv-debug-char-bg)"
                    : isRecv
                      ? "var(--c-adv-debug-recv-bg)"
                      : isSystem
                        ? "var(--c-adv-debug-system-bg)"
                        : "var(--c-adv-debug-dm-bg)";

                  return (
                    <div
                      key={i}
                      style={{
                        marginBottom: 12,
                        borderRadius: 14,
                        overflow: "hidden",
                        border: "1px solid var(--c-adv-input-border)",
                        background: "var(--c-adv-debug-card-bg)",
                      }}
                    >
                      <div style={{ padding: "10px 12px", background: bg, display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, borderBottom: "1px solid var(--c-adv-input-border)" }}>
                        <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 800, color, lineHeight: 1.25, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {log.type}
                        </span>
                        <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", flexShrink: 0 }}>{log.time}</span>
                      </div>
                      <pre style={{
                        fontSize: "calc(12px*var(--app-text-scale,1))",
                        color: "var(--c-adv-text)",
                        margin: 0,
                        padding: "12px",
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        overflowWrap: "anywhere",
                        lineHeight: 1.65,
                        maxHeight: debugFilter === "current" ? undefined : 460,
                        overflow: debugFilter === "current" ? "visible" : "auto",
                        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                        background: "var(--c-adv-debug-pre-bg)",
                      }}>
                        {log.content}
                      </pre>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}

      {/* Backstage reveal entry (after ending fireworks, fork 八期) */}
      {save.completed && !showFireworks && (
        <button onClick={() => setShowReveal(true)} style={{
          position: "absolute", left: 10, bottom: 282, zIndex: 40,
          width: 44, height: 44, borderRadius: "50%",
          background: "rgba(150,120,220,0.2)", border: "1px solid rgba(150,120,220,0.4)",
          color: "rgba(200,180,250,0.95)", fontSize: "calc(16px*var(--app-text-scale,1))",
          cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center",
        }} title="幕后全貌（结局后解锁）">🎭</button>
      )}

      {/* ═══ Ending Overlay ═══ */}
      {endingData && (
        <div
          onClick={() => {
            if (showFireworks) return;
            const total = endingData.paragraphs.length;
            if (endingStep < total) {
              setEndingStep(endingStep + 1);
            } else if (endingStep === total) {
              // Show closing → fireworks
              setEndingStep(total + 1);
              setShowFireworks(true);
            }
          }}
          style={{
            position: "absolute", inset: 0, zIndex: 70,
            background: "rgba(5,5,10,0.7)", backdropFilter: "blur(4px)",
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: 20,
            cursor: showFireworks ? "default" : "pointer",
          }}
        >
          {/* Card popup */}
          <div ref={endingScrollRef} style={{
            maxWidth: 320, width: "100%", maxHeight: "75vh", overflowY: "auto",
            background: "radial-gradient(circle at top, rgba(30,25,20,0.97) 0%, rgba(12,10,15,0.98) 100%)",
            borderRadius: 20, border: "1px solid rgba(220,180,120,0.15)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)",
            padding: "28px 22px",
            display: "flex", flexDirection: "column", gap: 16,
            position: "relative", zIndex: 1,
          }}>
            {endingData.paragraphs.slice(0, endingStep + 1).map((p, i) => (
              <div key={i} style={{
                fontSize: "calc(14px*var(--app-text-scale,1))", lineHeight: 1.8, color: "rgba(255,255,255,0.75)",
                opacity: i === endingStep ? 1 : 0.4,
                transition: "opacity 0.5s",
                whiteSpace: "pre-wrap",
              }}>
                {p}
              </div>
            ))}

            {/* Closing */}
            {endingStep > endingData.paragraphs.length - 1 && (
              <div style={{
                fontSize: "calc(18px*var(--app-text-scale,1))", fontWeight: 600, color: "#f0c060",
                textAlign: "center", marginTop: 12,
                letterSpacing: "0.15em",
                textShadow: "0 0 20px rgba(240,192,96,0.3)",
              }}>
                {endingData.closing}
              </div>
            )}

            {/* Fork: 后日谈 — after the closing, the cast drops their masks (rendered in-card) */}
            {endingStep >= endingData.paragraphs.length && (afterTalkLoading || afterTalk.length > 0) && (
              <div style={{ marginTop: 4, paddingTop: 12, borderTop: "1px solid rgba(140,200,255,0.15)" }}>
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(140,200,255,0.65)", fontFamily: "monospace", letterSpacing: "0.2em", textAlign: "center", marginBottom: 8 }}>
                  🎬 后日谈 · 皮下复盘
                </div>
                {afterTalkLoading ? (
                  <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(140,200,255,0.4)", textAlign: "center", padding: "6px 0" }}>
                    大家正在卸下角色……
                  </div>
                ) : afterTalk.map((l, i) => (
                  <div key={i} style={{ marginBottom: 7 }}>
                    <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", fontWeight: 700, color: "rgba(170,215,255,0.9)", marginRight: 6 }}>{l.speaker}</span>
                    <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.65)", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>{l.text}</span>
                  </div>
                ))}
              </div>
            )}

            {/* Tap hint */}
            {!showFireworks && endingStep <= endingData.paragraphs.length && (
              <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.15)", marginTop: 12, letterSpacing: "0.2em", textAlign: "center" }}>
                点击继续
              </div>
            )}

            {/* Return buttons (after fireworks, inside card) — leave is always manual, never forced */}
            {!showFireworks && endingStep > endingData.paragraphs.length && (
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button onClick={(e) => {
                  e.stopPropagation();
                  setEndingData(null);   // just fold the card — stay in the world (reveal button / OOC panel still there)
                }} style={{
                  flex: 1, padding: "12px 0", borderRadius: 100,
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.18)",
                  color: "rgba(255,255,255,0.45)", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 600,
                  letterSpacing: "0.15em", cursor: "pointer", fontFamily: "inherit",
                }}>
                  留在此界
                </button>
                <button onClick={(e) => {
                  e.stopPropagation();
                  handleArchive();
                }} style={{
                  flex: 1.4, padding: "12px 0", borderRadius: 100,
                  background: "linear-gradient(135deg, rgba(220,180,120,0.25), rgba(180,130,70,0.15))",
                  border: "1px solid rgba(220,180,120,0.4)",
                  color: "#f4dca8", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 600,
                  letterSpacing: "0.15em", cursor: "pointer", fontFamily: "inherit",
                }}>
                  完结 · 归档离开
                </button>
              </div>
            )}
          </div>

          {/* Fireworks Canvas — full screen in front of card */}
          {showFireworks && (
            <canvas
              ref={(canvas) => {
                if (!canvas || canvas.dataset.initialized) return;
                canvas.dataset.initialized = "1";

                const dpr = window.devicePixelRatio || 2;
                const parent = canvas.parentElement!;
                const W = parent.clientWidth;
                const H = parent.clientHeight;
                canvas.width = W * dpr;
                canvas.height = H * dpr;
                canvas.style.width = W + "px";
                canvas.style.height = H + "px";
                const ctx = canvas.getContext("2d")!;
                ctx.scale(dpr, dpr);

                type Particle = {
                  x: number; y: number; vx: number; vy: number;
                  life: number; maxLife: number; color: string; size: number;
                  type: "trail" | "spark" | "glitter";
                  prevX: number; prevY: number;
                };
                const particles: Particle[] = [];
                // Each firework picks ONE main color — like real pyrotechnics
                const mainColors = ["#ff4040", "#e8a0ff", "#50ccff", "#50ee90", "#ff7eb3", "#a0b4ff", "#ff9055"];
                const pickMain = () => mainColors[Math.floor(Math.random() * mainColors.length)];

                const launch = () => {
                  const x = W * (0.15 + Math.random() * 0.7);
                  const targetY = H * (0.15 + Math.random() * 0.45);
                  const frames = 22 + Math.floor(Math.random() * 8);
                  const trailColor = "#ffd080";
                  // Launch trail
                  particles.push({
                    x, y: H + 10, vx: (Math.random() - 0.5) * 0.2, vy: -(H - targetY) / frames,
                    life: frames, maxLife: frames, color: trailColor, size: 1.5,
                    type: "trail", prevX: x, prevY: H + 10,
                  });
                  // Explosion
                  setTimeout(() => {
                    const color = pickMain();
                    const count = 70 + Math.floor(Math.random() * 40);
                    const shape = Math.random();
                    for (let i = 0; i < count; i++) {
                      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.15;
                      let speed: number;
                      if (shape < 0.4) speed = 3 + Math.random() * 3.5;          // peony (round)
                      else if (shape < 0.7) speed = 4.5 + Math.random() * 1.5;   // chrysanthemum (uniform)
                      else speed = 1.5 + Math.random() * 5;                       // willow (spread)
                      const life = shape < 0.7 ? 50 + Math.floor(Math.random() * 35) : 65 + Math.floor(Math.random() * 40);
                      // Mostly main color, ~15% white sparks
                      const c = Math.random() < 0.85 ? color : "#ffe8cc";
                      particles.push({
                        x, y: targetY,
                        vx: Math.cos(angle) * speed, vy: Math.sin(angle) * speed - 0.8,
                        life, maxLife: life,
                        color: c, size: 1.2 + Math.random() * 1.2,
                        type: "spark", prevX: x, prevY: targetY,
                      });
                    }
                    // Center flash
                    particles.push({
                      x, y: targetY, vx: 0, vy: 0,
                      life: 8, maxLife: 8, color: "#fff", size: 8,
                      type: "glitter", prevX: x, prevY: targetY,
                    });
                  }, frames * 16);
                };

                // Fewer launches, more spaced out
                let launchCount = 0;
                const intervals: ReturnType<typeof setInterval>[] = [];
                // Wave 1: opening (0-1.5s)
                intervals.push(setInterval(() => {
                  launch();
                  launchCount++;
                  if (launchCount > 3) clearInterval(intervals[0]);
                }, 500));
                // Wave 2: mid climax (1.5-4.5s) — more frequent
                setTimeout(() => {
                  intervals.push(setInterval(() => {
                    launch();
                    launch();
                    if (Math.random() > 0.5) launch();
                    launchCount++;
                    if (launchCount > 12) clearInterval(intervals[1]);
                  }, 600));
                }, 1500);
                // Wave 3: finale burst (4.5-6s)
                setTimeout(() => {
                  intervals.push(setInterval(() => {
                    launch(); launch();
                    launchCount++;
                    if (launchCount > 18) clearInterval(intervals[2]);
                  }, 350));
                }, 4500);

                let animId = 0;
                const animate = () => {
                  // Fade trail (creates afterglow)
                  ctx.globalCompositeOperation = "destination-out";
                  ctx.fillStyle = "rgba(0,0,0,0.08)";
                  ctx.fillRect(0, 0, W, H);
                  ctx.globalCompositeOperation = "lighter"; // additive blending for glow

                  for (let i = particles.length - 1; i >= 0; i--) {
                    const p = particles[i];
                    p.prevX = p.x; p.prevY = p.y;
                    p.x += p.vx;
                    p.y += p.vy;
                    if (p.type !== "trail") p.vy += 0.035;
                    if (p.type === "spark") { p.vx *= 0.985; p.vy *= 0.985; } // air resistance
                    p.life--;
                    // Secondary burst: ~10% of sparks explode again at 40% life remaining
                    if (p.type === "spark" && p.life === Math.floor(p.maxLife * 0.4) && Math.random() < 0.1) {
                      const remaining = p.life;
                      const subCount = 6 + Math.floor(Math.random() * 6);
                      for (let s = 0; s < subCount; s++) {
                        const a = Math.random() * Math.PI * 2;
                        const sp = 1 + Math.random() * 1.5;
                        const subLife = Math.floor(remaining * (0.5 + Math.random() * 0.4));
                        particles.push({
                          x: p.x, y: p.y,
                          vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                          life: subLife, maxLife: subLife,
                          color: p.color, size: 0.6 + Math.random() * 0.4,
                          type: "spark", prevX: p.x, prevY: p.y,
                        });
                      }
                    }
                    if (p.life <= 0) { particles.splice(i, 1); continue; }
                    const alpha = p.life / p.maxLife;

                    if (p.type === "trail") {
                      // Rising trail line
                      ctx.globalAlpha = alpha * 0.8;
                      ctx.strokeStyle = p.color;
                      ctx.lineWidth = p.size;
                      ctx.beginPath();
                      ctx.moveTo(p.prevX, p.prevY);
                      ctx.lineTo(p.x, p.y);
                      ctx.stroke();
                    } else if (p.type === "glitter") {
                      // Center flash — fast bright fade
                      ctx.globalAlpha = alpha;
                      ctx.fillStyle = p.color;
                      ctx.beginPath();
                      ctx.arc(p.x, p.y, p.size * alpha, 0, Math.PI * 2);
                      ctx.fill();
                    } else {
                      // Spark — draw as short line (motion trail) for realistic streaks
                      const trailLen = Math.sqrt(p.vx * p.vx + p.vy * p.vy) * 2;
                      ctx.globalAlpha = alpha * 0.85;
                      ctx.strokeStyle = p.color;
                      ctx.lineWidth = p.size * alpha;
                      ctx.lineCap = "round";
                      ctx.beginPath();
                      ctx.moveTo(p.x - p.vx * 1.5, p.y - p.vy * 1.5);
                      ctx.lineTo(p.x, p.y);
                      ctx.stroke();
                      // Soft glow at tip
                      ctx.globalAlpha = alpha * 0.12;
                      ctx.fillStyle = p.color;
                      ctx.beginPath();
                      ctx.arc(p.x, p.y, trailLen * 0.6, 0, Math.PI * 2);
                      ctx.fill();
                    }
                  }
                  ctx.globalAlpha = 1;
                  ctx.globalCompositeOperation = "source-over";
                  animId = requestAnimationFrame(animate);
                };
                animate();

                // Stop launching at 6s
                setTimeout(() => {
                  intervals.forEach(clearInterval);
                }, 6000);

                // Wait for particles to die out, then close
                setTimeout(() => {
                  const waitForEmpty = setInterval(() => {
                    if (particles.length === 0) {
                      clearInterval(waitForEmpty);
                      cancelAnimationFrame(animId);
                      setShowFireworks(false);
                    }
                  }, 200);
                  // Safety: force close after 4s
                  setTimeout(() => { cancelAnimationFrame(animId); setShowFireworks(false); }, 4000);
                }, 8000);
              }}
              style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}
            />
          )}

        </div>
      )}

      {/* ═══ Player persona review (fork 十二期 — first entry, edit then confirm) ═══ */}
      {personaReview && (
        <div style={{ position: "absolute", inset: 0, zIndex: 78, background: "rgba(0,0,0,0.75)", backdropFilter: "blur(6px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
          <div style={{
            width: "min(440px, 100%)", maxHeight: "84vh", overflowY: "auto",
            background: "var(--c-adv-panel-bg)", borderRadius: 16, border: "1px solid var(--c-adv-accent-dim)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.6)", padding: "20px 18px",
          }}>
            <div style={{ fontSize: "calc(16px*var(--app-text-scale,1))", fontWeight: 700, color: "var(--c-adv-accent)", marginBottom: 4, letterSpacing: "0.05em" }}>🎭 你的模组内身份</div>
            <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 14, lineHeight: 1.5 }}>
              角色卡已按模组时代适配。过目修改后确认——KP 将以此身份称呼与对待你
            </div>
            {([
              { key: "name", label: "名字" },
              { key: "occupation", label: "时代职业" },
            ] as const).map(f => (
              <div key={f.key} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4 }}>{f.label}</div>
                <input value={personaReview[f.key]} onChange={e => setPersonaReview({ ...personaReview, [f.key]: e.target.value })}
                  style={{ width: "100%", padding: "8px 10px", borderRadius: 8, border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)", color: "var(--c-adv-body)", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", outline: "none", boxSizing: "border-box" }} />
              </div>
            ))}
            {([
              { key: "background", label: "身份背景（这个时代的身份与来此缘由）" },
              { key: "keepTraits", label: "性格保持（不变的部分）" },
              { key: "changes", label: "时代调整说明" },
              { key: "hooks", label: "与本案的私人连接" },
            ] as const).map(f => (
              <div key={f.key} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4 }}>{f.label}</div>
                <textarea value={personaReview[f.key]} onChange={e => setPersonaReview({ ...personaReview, [f.key]: e.target.value })}
                  style={{ width: "100%", minHeight: 56, padding: "8px 10px", borderRadius: 8, border: "1px solid var(--c-adv-input-border)", background: "var(--c-adv-input-bg)", color: "var(--c-adv-body)", fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit", lineHeight: 1.6, resize: "vertical", outline: "none", boxSizing: "border-box" }} />
              </div>
            ))}
            <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
              <button type="button" onClick={() => { setPersonaReview(null); persistSave({ ...save, myPersona: undefined }); }}
                style={{ flex: 1, padding: "11px 0", borderRadius: 10, border: "1px solid var(--c-adv-input-border)", background: "transparent", color: "var(--c-adv-text-dim)", fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit" }}>
                不用模组身份
              </button>
              <button type="button" onClick={() => { persistSave({ ...save, myPersona: { ...personaReview, confirmed: true } }); setPersonaReview(null); pushMessages({ id: mkId(), type: "system", text: `🎭 你的身份已确认：${personaReview.occupation}` }); }}
                style={{ flex: 1.6, padding: "11px 0", borderRadius: 10, border: "1px solid var(--c-adv-accent-dim)", background: "var(--c-adv-accent-dim)", color: "var(--c-adv-accent)", fontSize: "calc(12px*var(--app-text-scale,1))", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
                确认身份，开始调查
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ Stage cue renderers (fork 十期) ═══ */}
      {/* BGM audio element (hidden; KP cue or manual control) */}
      <audio ref={bgmAudioRef} loop preload="none" />
      {/* BGM indicator + mute */}
      {currentBgm && (
        <button type="button" onClick={() => {
          const el = bgmAudioRef.current;
          if (!el) return;
          if (el.paused) el.play().catch(() => undefined); else el.pause();
        }} style={{
          position: "absolute", left: 10, top: "calc(var(--page-header-safe-top, 48px) + 46px)", zIndex: 30,
          padding: "3px 10px", borderRadius: 12,
          border: "1px solid rgba(150,200,170,0.3)", background: "rgba(10,14,12,0.7)",
          color: "rgba(180,230,200,0.85)", fontSize: "calc(9px*var(--app-text-scale,1))",
          cursor: "pointer", fontFamily: "monospace", letterSpacing: "0.05em",
          backdropFilter: "blur(6px)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }} title="点击暂停/播放 BGM">
          ♪ {currentBgm}
        </button>
      )}

      {/* CG fullscreen overlay (tap to dismiss) */}
      {cgOverlay && (
        <div onClick={() => setCgOverlay(null)} style={{
          position: "absolute", inset: 0, zIndex: 75,
          background: "rgba(0,0,0,0.92)",
          display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
          cursor: "pointer", animation: "cg-fade-in 0.5s ease-out",
        }}>
          <style>{`@keyframes cg-fade-in { from { opacity: 0; } to { opacity: 1; } }`}</style>
          <img src={cgOverlay.url} alt={cgOverlay.name} style={{ maxWidth: "100%", maxHeight: "86vh", objectFit: "contain", boxShadow: "0 24px 80px rgba(0,0,0,0.8)" }} />
          <div style={{ marginTop: 14, fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.35)", fontFamily: "monospace", letterSpacing: "0.2em" }}>
            🎞 {cgOverlay.name} · 点击任意处继续
          </div>
        </div>
      )}

      {/* ═══ Asset panel (fork 十期 — upload / bind / manual CG) ═══ */}
      {showAssetPanel && (
        <div style={{ position: "absolute", inset: 0, zIndex: 66, background: "rgba(0,0,0,0.6)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }} onClick={() => setShowAssetPanel(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "min(420px, 100%)", maxHeight: "80vh", overflowY: "auto",
            background: "var(--c-adv-panel-bg)", borderRadius: 14, border: "1px solid var(--c-adv-input-border)",
            padding: "16px 14px",
          }}>
            <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 700, color: "var(--c-adv-text)", marginBottom: 4 }}>🎞 演出资源</div>
            <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
              图片/音频存本地，AI 只看名字清单。命名建议：立绘=「NPC名.png」，CG 前缀「cg_」，BGM 前缀「bgm_」
            </div>
            {/* Upload */}
            <label style={{
              display: "block", padding: "10px 0", borderRadius: 8, textAlign: "center",
              border: "1px dashed rgba(200,160,100,0.3)", background: "transparent",
              color: "rgba(200,160,100,0.8)", fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              marginBottom: 12,
            }}>
              + 上传立绘 / CG / BGM（可多选）
              <input type="file" multiple accept="image/*,audio/*" hidden onChange={async e => {
                const files = Array.from(e.target.files || []);
                if (!files.length) return;
                const npcNames = [...skeleton.npcs.map(n => n.name), ...skeleton.richRegions.flatMap(r => r.l2_nodes.map(n => n.npc?.name).filter(Boolean) as string[])];
                try {
                  const { assets: next, skipped } = await registerAssetFiles(world.id, files, npcNames, assets);
                  updateAssets(next);
                  const added = next.length - assets.length;
                  if (skipped.length) pushMessages({ id: mkId(), type: "system", text: `⚠ 已登记 ${added} 个；跳过 ${skipped.length} 个（写入失败或格式不支持）：${skipped.join("、")}` });
                  else if (added === 0) pushMessages({ id: mkId(), type: "system", text: "没有新资源被登记（文件重复或格式不支持，仅支持图片/音频）" });
                  else pushMessages({ id: mkId(), type: "system", text: `🎞 已登记 ${added} 个演出资源——现共：立绘${next.filter(a => a.kind === "portrait").length} · CG${next.filter(a => a.kind === "cg").length} · BGM${next.filter(a => a.kind === "bgm").length}` });
                } catch (err) {
                  pushMessages({ id: mkId(), type: "system", text: `资源登记失败：${err instanceof Error ? err.message : String(err)}（常见原因：浏览器存储空间不足，请清理后重试）` });
                }
              }} />
            </label>
            {/* Asset list — grouped by kind (fork: portraits / CG / BGM sections with counts) */}
            {assets.length === 0 ? (
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", textAlign: "center", padding: "16px 0" }}>还没有演出资源</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {([
                  { kind: "portrait" as const, icon: "👤", title: "立绘", note: "按NPC名自动绑定；没绑上可点右侧输入框手填" },
                  { kind: "cg" as const, icon: "🖼", title: "CG", note: "名字带 cg_ 前缀自动归入；KP 在对应场景调用" },
                  { kind: "bgm" as const, icon: "🎵", title: "BGM", note: "音频自动归入；氛围切换时 KP 点播" },
                ]).map(({ kind, icon, title, note }) => {
                  const list = assets.filter(a => a.kind === kind);
                  return (
                    <div key={kind}>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                        <span style={{ fontSize: "calc(12px*var(--app-text-scale,1))" }}>{icon}</span>
                        <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-accent-dim)", fontFamily: "monospace", letterSpacing: "0.08em" }}>{title}</span>
                        <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: list.length ? "rgba(140,220,160,0.8)" : "var(--c-adv-text-muted)", fontFamily: "monospace" }}>{list.length ? `${list.length} 个` : "空"}</span>
                        {kind === "portrait" && <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", opacity: 0.7 }}>{note}</span>}
                      </div>
                      {list.length > 0 && (
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                          {list.map(a => (
                            <div key={a.id} style={{ display: "flex", gap: 8, alignItems: "center", padding: "6px 9px", borderRadius: 8, background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)" }}>
                              <input value={a.name} onChange={e => updateAssets(assets.map(x => x.id === a.id ? { ...x, name: e.target.value } : x))}
                                style={{ flex: 1, minWidth: 0, background: "transparent", border: "none", outline: "none", color: "var(--c-adv-text)", fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit" }} />
                              {kind === "portrait" ? (
                                <input value={a.boundTo || ""} placeholder={a.boundTo ? "" : "未绑定·点此填NPC名"} onChange={e => updateAssets(assets.map(x => x.id === a.id ? { ...x, boundTo: e.target.value } : x))}
                                  style={{ width: 110, background: "transparent", border: "none", borderBottom: `1px dashed ${a.boundTo ? "var(--c-adv-input-border)" : "rgba(255,150,120,0.5)"}`, outline: "none", color: a.boundTo ? "var(--c-adv-accent-dim)" : "rgba(255,150,120,0.75)", fontSize: "calc(10px*var(--app-text-scale,1))", fontFamily: "inherit", textAlign: "center" }} />
                              ) : (
                                <button type="button" onClick={() => fireStageCues({ cg: kind === "cg" ? a.name : undefined, bgm: kind === "bgm" ? a.name : undefined })}
                                  style={{ padding: "4px 8px", borderRadius: 6, border: "1px solid var(--c-adv-accent-dim)", background: "transparent", color: "var(--c-adv-accent)", fontSize: "calc(9px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" }}>
                                  试演
                                </button>
                              )}
                              <button type="button" onClick={() => { deleteAssetBlob(a.id); updateAssets(assets.filter(x => x.id !== a.id)); }}
                                style={{ background: "none", border: "none", color: "rgba(255,100,80,0.5)", cursor: "pointer", fontSize: "calc(13px*var(--app-text-scale,1))", fontFamily: "inherit", padding: 2 }}>✕</button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            <button onClick={() => setShowAssetPanel(false)} style={{
              width: "100%", marginTop: 12, padding: "10px 0", borderRadius: 9,
              border: "1px solid var(--c-adv-input-border)", background: "transparent",
              color: "var(--c-adv-text-dim)", fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
            }}>关闭</button>
          </div>
        </div>
      )}

      {/* ═══ Backstage Reveal (fork 八期A/B — after ending; all secrets + locked talks) ═══ */}
      {showReveal && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 72,
          background: "rgba(5,5,10,0.85)", backdropFilter: "blur(8px)",
          display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        }} onClick={() => setShowReveal(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            width: "min(420px, 100%)", maxHeight: "82vh", overflowY: "auto",
            background: "radial-gradient(circle at top, rgba(30,25,35,0.98) 0%, rgba(12,10,18,0.99) 100%)",
            borderRadius: 16, border: "1px solid rgba(190,170,240,0.25)",
            boxShadow: "0 24px 64px rgba(0,0,0,0.7)", padding: "20px 18px",
          }}>
            <div style={{ fontSize: "calc(16px*var(--app-text-scale,1))", fontWeight: 700, color: "rgba(210,190,250,0.95)", letterSpacing: "0.1em", marginBottom: 4 }}>🎭 幕后全貌</div>
            <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 14 }}>故事已落幕——现在你可以看看每个人守住（或没守住）什么</div>

            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(190,170,240,0.9)", marginBottom: 6, fontFamily: "monospace", letterSpacing: "0.1em" }}>调查员的秘密</div>
            {partySecretsView.length === 0 ? (
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 10 }}>（这个世界没有生成个人秘密）</div>
            ) : partySecretsView.map((s, i) => (
              <div key={i} style={{ padding: "8px 10px", borderRadius: 8, background: "rgba(150,120,220,0.08)", border: "1px solid rgba(150,120,220,0.18)", marginBottom: 5 }}>
                <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-body)", lineHeight: 1.6 }}><span style={{ color: "rgba(190,170,240,0.9)", fontWeight: 600 }}>{s.who}</span>：{s.secret.content}</div>
                {s.secret.link && <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginTop: 3 }}>咬合点：{s.secret.link}{s.secret.informant ? ` · 知情者：${s.secret.informant}` : ""}</div>}
              </div>
            ))}

            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(190,170,240,0.9)", margin: "14px 0 6px", fontFamily: "monospace", letterSpacing: "0.1em" }}>🔒 锁档私聊</div>
            {(save.lockedLog || []).length === 0 && (lockedLogRef.current.length === 0) ? (
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)" }}>（没有发生私下交谈）</div>
            ) : [...(save.lockedLog || []), ...lockedLogRef.current.filter(e => !(save.lockedLog || []).some(x => x.id === e.id))].map(e => (
              <div key={e.id} style={{ padding: "8px 10px", borderRadius: 8, background: "var(--c-adv-input-bg)", border: "1px solid var(--c-adv-input-border)", marginBottom: 5 }}>
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(190,170,240,0.8)", marginBottom: 3 }}>{e.day} · {e.who} ↔ {e.npc || "？"}</div>
                <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-body)", lineHeight: 1.6 }}>{e.text}</div>
              </div>
            ))}

            <button onClick={() => setShowReveal(false)}
              style={{
                width: "100%", marginTop: 14, padding: "11px 0", borderRadius: 10,
                border: "1px solid rgba(190,170,240,0.3)", background: "rgba(150,120,220,0.12)",
                color: "rgba(210,190,250,0.95)", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 600,
                cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.1em",
              }}>
              合上这本幕册
            </button>
          </div>
        </div>
      )}

      {/* Death dialog */}
      {showDeathDialog && (
        <div style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div style={{ background: "rgba(15,12,18,0.98)", borderRadius: 16, border: "1px solid rgba(200,60,60,0.2)", padding: 24, maxWidth: 280, width: "100%", textAlign: "center" }}>
            <div style={{ fontSize: "calc(32px*var(--app-text-scale,1))", marginBottom: 12 }}>💀</div>
            <div style={{ fontSize: "calc(16px*var(--app-text-scale,1))", fontWeight: 600, color: "#e0dcd5", marginBottom: 6 }}>你倒下了</div>
            <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.35)", marginBottom: 20, lineHeight: 1.5 }}>
              {save.checkpoint ? "黑暗笼罩了你的意识..." : "没有存档点，冒险到此为止了..."}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {save.checkpoint && (
                <button onClick={() => {
                  try {
                    const cp = JSON.parse(save.checkpoint!) as GameSave;
                    // Restore UI state from checkpoint
                    const restoredStream = [...(cp.streamLog || []), { id: mkId(), type: "system" as const, text: "—— 回到存档点 ——" }];
                    setStreamMessages(restoredStream);
                    setInEvent(cp.pendingEvent?.inEvent || false);
                    setCurrentChoices(cp.pendingEvent?.choices || null);
                    setEventContext(cp.pendingEvent?.eventContext || "");
                    setActiveEventMeta(cp.pendingEvent?.eventMeta || null);
                    setActiveEvent(null);
                    setAccumulatedEvent(null);
                    setLastFailedAction(cp.pendingEvent?.lastAction || null);
                    setCompletedCompanions(cp.pendingEvent?.completedCompanions || []);
                    // Clear transient UI state
                    setLoadingPhase("");
                    setFreeText("");
                    setFreeAction("");
                    setLastFailedEvent(null);
                    // Save directly (bypass persistSave which would inject current refs)
                    const restored: GameSave = { ...cp, streamLog: restoredStream.slice(-200), checkpoint: save.checkpoint };
                    saveGame(restored);
                    onSaveUpdate(restored);
                  } catch {
                    pushMessages({ id: mkId(), type: "system", text: "存档点损坏" });
                  }
                  setShowDeathDialog(false);
                }} style={{
                  padding: "10px 0", borderRadius: 8, border: "1px solid rgba(200,160,100,0.3)",
                  background: "rgba(200,160,100,0.15)", color: "#e8d0a0",
                  fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
                }}>
                  回到存档点
                </button>
              )}
              <button onClick={() => {
                setShowDeathDialog(false);
                onBack();
              }} style={{
                padding: "10px 0", borderRadius: 8, border: "1px solid rgba(255,255,255,0.08)",
                background: "rgba(255,255,255,0.03)", color: "rgba(255,255,255,0.4)",
                fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
              }}>
                放弃冒险
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Save checkpoint confirm */}
      {showSaveConfirm && (
        <div style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}
          onClick={() => setShowSaveConfirm(false)}>
          <div style={{ background: "var(--c-adv-panel-bg)", borderRadius: 12, border: `1px solid var(--c-adv-input-border)`, padding: 20, maxWidth: 280, width: "100%" }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 600, marginBottom: 6, textAlign: "center", color: "var(--c-adv-text)" }}>保存存档点</div>
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 4, textAlign: "center" }}>
              {currentNode?.name} · HP {save.hp}/{save.maxHp}
            </div>
            <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", marginBottom: 14, textAlign: "center" }}>
              {formatGameTime(save.gameDay, save.gameTime)} · {save.director.keyItems.length}件物品
            </div>
            {save.checkpoint && (
              <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,160,80,0.6)", marginBottom: 12, textAlign: "center", padding: "6px 0", borderRadius: 6, background: "rgba(255,160,80,0.06)" }}>
                已有存档点，保存将覆盖
              </div>
            )}
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setShowSaveConfirm(false)} style={{
                  flex: 1, padding: "10px 0", borderRadius: 8,
                  border: `1px solid var(--c-adv-input-border)`, background: "transparent",
                  color: "var(--c-adv-text-dim)", fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>
                  取消
                </button>
                <button onClick={() => {
                  // Inject current refs so checkpoint captures live state (save prop may be stale)
                  const { checkpoint: _, ...saveWithoutCheckpoint } = save;
                  const cpData = {
                    ...saveWithoutCheckpoint,
                    streamLog: streamRef.current.slice(-200),
                    pendingEvent: inEventRef.current ? {
                      inEvent: true,
                      choices: currentChoicesRef.current || undefined,
                      eventContext: eventContextRef.current || undefined,
                      eventMeta: activeEventMetaRef.current || undefined,
                      lastAction: lastFailedActionRef.current || undefined,
                      interruptedPhase: loadingPhaseRef.current || undefined,
                      completedCompanions: completedCompanionsRef.current.length > 0 ? completedCompanionsRef.current : undefined,
                    } : undefined,
                  };
                  const cp = JSON.stringify(cpData);
                  persistSave({ ...save, checkpoint: cp });
                  pushMessages({ id: mkId(), type: "system", text: "存档点已保存" });
                  setShowSaveConfirm(false);
                }} style={{
                  flex: 1, padding: "10px 0", borderRadius: 8,
                  border: "none", background: "var(--c-adv-accent-dim)",
                  color: "var(--c-adv-accent)", fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>
                  保存
                </button>
              </div>
              {save.checkpoint && (
                <button onClick={() => {
                  try {
                    const cp = JSON.parse(save.checkpoint!) as GameSave;
                    // Restore UI state from checkpoint
                    setStreamMessages(cp.streamLog || []);
                    setInEvent(cp.pendingEvent?.inEvent || false);
                    setCurrentChoices(cp.pendingEvent?.choices || null);
                    setEventContext(cp.pendingEvent?.eventContext || "");
                    setActiveEventMeta(cp.pendingEvent?.eventMeta || null);
                    setActiveEvent(null);
                    setAccumulatedEvent(null);
                    setLastFailedAction(cp.pendingEvent?.lastAction || null);
                    setCompletedCompanions(cp.pendingEvent?.completedCompanions || []);
                    // Clear transient UI state
                    setLoadingPhase("");
                    setFreeText("");
                    setFreeAction("");
                    setLastFailedEvent(null);
                    // Save directly (bypass persistSave which would inject current refs)
                    const restored: GameSave = { ...cp, checkpoint: save.checkpoint };
                    saveGame(restored);
                    onSaveUpdate(restored);
                  } catch {
                    pushMessages({ id: mkId(), type: "system", text: "存档点损坏" });
                  }
                  setShowSaveConfirm(false);
                }} style={{
                  width: "100%", padding: "10px 0", borderRadius: 8,
                  border: "1px solid rgba(255,160,80,0.2)", background: "rgba(255,160,80,0.06)",
                  color: "rgba(255,160,80,0.7)", fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>
                  回到存档点
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Archive confirm */}
      {showArchiveConfirm && (
        <div style={{ position: "absolute", inset: 0, zIndex: 60, background: "rgba(0,0,0,0.5)", backdropFilter: "blur(4px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}
          onClick={() => setShowArchiveConfirm(false)}>
          <div style={{
            background: "var(--c-adv-panel-bg)", borderRadius: 16,
            border: "1px solid var(--c-adv-accent-dim)",
            boxShadow: "0 16px 48px rgba(0,0,0,0.4)",
            padding: "24px 20px", maxWidth: 300, width: "100%",
          }} onClick={e => e.stopPropagation()}>
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: "calc(28px*var(--app-text-scale,1))", marginBottom: 8 }}>⚔️</div>
              <div style={{ fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: 600, color: "var(--c-adv-text)", marginBottom: 4 }}>
                暂离冒险
              </div>
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "var(--c-adv-text-muted)", lineHeight: 1.5 }}>
                {skeleton.world.name} · {formatGameTime(save.gameDay, save.gameTime)}
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <button onClick={() => { persistSave({ ...save, timestamp: new Date().toISOString() }); onBack(); }} style={{
                width: "100%", padding: "11px 0", borderRadius: 10,
                background: "var(--c-adv-accent-dim)", border: "none",
                color: "var(--c-adv-accent)", fontSize: "calc(13px*var(--app-text-scale,1))", fontWeight: 500,
                cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em",
              }}>
                保存并离开
              </button>
              <button onClick={() => setShowArchiveConfirm(false)} style={{
                width: "100%", padding: "11px 0", borderRadius: 10,
                background: "transparent", border: "1px solid var(--c-adv-input-border)",
                color: "var(--c-adv-text-dim)", fontSize: "calc(13px*var(--app-text-scale,1))",
                cursor: "pointer", fontFamily: "inherit",
              }}>
                继续冒险
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Journal overlay */}
      {showJournal && (
        <div style={{
          position: "absolute", inset: 0, zIndex: 30,
          background: "rgba(0,0,0,0.6)",
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 20,
        }} onClick={() => setShowJournal(false)}>
          <div style={{
            width: "100%", maxHeight: "70vh", overflow: "auto",
            background: "var(--c-adv-panel-bg)", borderRadius: 12,
            border: "1px solid var(--c-adv-input-border)", padding: 16,
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", letterSpacing: "0.15em", color: "var(--c-adv-text-muted)", marginBottom: 12, fontFamily: "monospace" }}>
              冒险日志
            </div>
            {save.journal.slice().reverse().map(j => (
              <div key={j.id} style={{
                padding: "8px 0",
                borderBottom: "1px solid var(--c-adv-input-bg)",
                fontSize: "calc(12px*var(--app-text-scale,1))",
              }}>
                <div style={{ color: "var(--c-adv-accent-dim)", fontSize: "calc(10px*var(--app-text-scale,1))", marginBottom: 2 }}>
                  {j.timestamp} · {j.locationName}
                </div>
                <div style={{ color: "var(--c-adv-body)", lineHeight: 1.5 }}>{j.text}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
