"use client";
import { useState, useMemo, useEffect } from "react";
import { ArrowLeft, ChevronDown, MoreHorizontal, Plus, Play, Trash2 } from "lucide-react";
import { loadCharacters } from "@/lib/character-storage";
import {
  loadMapWorlds,
  getLatestSave,
  deleteMapWorld,
  generateWorldId,
  saveMapWorld,
  createInitialSave,
  saveGame,
  addAgentToSave,
  loadDMPrompts,
  saveDMPrompts,
  loadDMTokenConfig,
  saveDMTokenConfig,
  type DMTokenConfig,
  loadAdventureSummaryConfig,
  saveAdventureSummaryConfig,
  type AdventureSummaryConfig,
  hydrateMapStorage,
  loadAdventureInteractionConfig,
  saveAdventureInteractionConfig,
  DEFAULT_ADVENTURE_INTERACTION_CONFIG,
  type AdventureInteractionConfig,
} from "@/lib/map-storage";
import { generateWorldSkeleton, DEFAULT_WORLD_GEN_PROMPT, DEFAULT_DM_SCENE_PROMPT, DEFAULT_DM_RESOLVE_PROMPT, DEFAULT_DM_ENDING_PROMPT, DEFAULT_ADVENTURE_SUMMARY_PROMPT } from "@/lib/map-rpg-engine";
import { extractNpcsFromText, extractTruthFromText, extractActsFromText, assembleSkeletonFromCore, extractInvestigatorLines } from "@/lib/module-core";
// (investigator import moved to map-view first-entry lazy import — lobby no longer blocks on it)
import { resolveUserIdentity } from "@/lib/settings-storage";
import type { ModuleCore, ModuleAct, InvestigatorLine } from "@/lib/map-types";
import { generateMap, type GeoJSONData } from "@/lib/map-engine";
import { registerAssetFiles, putAssetBlob, deleteAssetBlob } from "@/lib/stage-assets";
import type { StageAsset } from "@/lib/map-types";

// Fork: pack slimming helpers — image re-encode + gzip, all client-side, no deps
async function compressImageForPack(file: File, maxDim: number): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, maxDim / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bmp, 0, 0, w, h);
    const tryBlob = (type: string, q?: number) => new Promise<Blob | null>(res => canvas.toBlob(b => res(b), type, q));
    const webp = await tryBlob("image/webp", 0.85);
    if (webp && webp.type === "image/webp" && webp.size < file.size) return webp;
    // Safari lacks canvas WebP encoding — JPEG for CG (opaque art), resized PNG keeps portrait transparency
    if (/^cg[_\-/]/i.test(file.name) || file.type === "image/jpeg") {
      const jpg = await tryBlob("image/jpeg", 0.85);
      if (jpg && jpg.size < file.size) return jpg;
    }
    const png = await tryBlob("image/png");
    if (png && png.size < file.size) return png;
    return file;
  } catch { return file; }
}
async function gzipText(text: string): Promise<Uint8Array | null> {
  try {
    if (typeof CompressionStream === "undefined") return null;
    const cs = new CompressionStream("gzip");
    const writer = cs.writable.getWriter();
    writer.write(new TextEncoder().encode(text));
    writer.close();
    const buf = await new Response(cs.readable).arrayBuffer();
    return new Uint8Array(buf);
  } catch { return null; }
}
async function gunzipBytes(bytes: Uint8Array): Promise<string> {
  const ds = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  writer.write(bytes);
  writer.close();
  return await new Response(ds.readable).text();
}
import { loadApiConfigs, loadBindingConfig, resolveBinding } from "@/lib/settings-storage";
import type { MapWorld, GameSave } from "@/lib/map-types";
import { Toggle } from "@/components/ui/form";

type Props = {
  onClose: () => void;
  onStartGame: (world: MapWorld, save: GameSave) => void;
};

type Mode = "list" | "create" | "enter" | "prompts";
type DMPromptTab = "scene" | "resolve" | "worldGen" | "ending";
type PromptEditorKey = DMPromptTab | "summary" | "bilingual";

export default function MapLobby({ onClose, onStartGame }: Props) {
  const [mode, setMode] = useState<Mode>("list");
  const [worlds, setWorlds] = useState<MapWorld[]>([]);

  // Ensure hydration completes before reading worlds
  useEffect(() => {
    hydrateMapStorage().then(() => setWorlds(loadMapWorlds()));
  }, []);

  // Refresh worlds list when switching back to list mode (picks up background generation results)
  useEffect(() => {
    if (mode !== "list") return;
    const interval = setInterval(() => {
      const current = loadMapWorlds();
      // Only update if any world's status changed
      if (current.some((w, i) => w.status !== worlds[i]?.status || w.updatedAt !== worlds[i]?.updatedAt)) {
        setWorlds(current);
      }
    }, 2000);
    return () => clearInterval(interval);
  }, [mode, worlds]);
  const [description, setDescription] = useState("");
  const [tone, setTone] = useState("");
  const [regionCount, setRegionCount] = useState(6);
  const [mainQuestType, setMainQuestType] = useState("");
  const [npcCount, setNpcCount] = useState(12);
  const [difficulty, setDifficulty] = useState("");
  // KP narration style (per world) — injected into scene/resolve prompts
  const [kpNarrStyle, setKpNarrStyle] = useState("");
  const [kpArtStyle, setKpArtStyle] = useState("");
  // Rules edition (per world) — CoC 6th/7th, chosen at creation; old worlds stay coc6 (fork)
  const [rulesEdition, setRulesEdition] = useState<"coc6" | "coc7">("coc6");
  // TRPG module background text (imported from txt) — injected into world-gen prompt
  const [moduleText, setModuleText] = useState("");
  const [moduleName, setModuleName] = useState("");
  const [moduleLoading, setModuleLoading] = useState(false);
  // Fork: advanced options collapsed by default — description/module is all most users need
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Fork 九期: sectioned import (NPC/truth/acts) + review + code-only assembly
  const [secNpcText, setSecNpcText] = useState("");
  const [secTruthText, setSecTruthText] = useState("");
  const [secActText, setSecActText] = useState("");
  // Fork: HO 导入剧情/个人线文本（第四栏 → 提取为 InvestigatorLine 密档）
  const [secHoText, setSecHoText] = useState("");
  const [hoLines, setHoLines] = useState<InvestigatorLine[] | null>(null);
  // Fork: 分栏锁定——锁住的栏目在重新提取时保留已提取结果（导入核心包后自动全锁，改哪栏解锁哪栏）
  const [secLocks, setSecLocks] = useState<{ npc: boolean; truth: boolean; act: boolean; ho: boolean }>({ npc: false, truth: false, act: false, ho: false });
  const [extracting, setExtracting] = useState(false);
  const [extractProgress, setExtractProgress] = useState("");
  const [moduleCore, setModuleCore] = useState<ModuleCore | null>(null);
  const [coreTab, setCoreTab] = useState<"npcs" | "truth" | "acts">("npcs");
  // Fork: stage assets staged for the core pack (uploaded here, blobs written to IDB on world create)
  const [coreAssets, setCoreAssets] = useState<{ asset: StageAsset; file: File }[]>([]);
  const handleCoreAssetFiles = async (files: FileList | null) => {
    if (!files?.length || !moduleCore) return;
    const npcNames = moduleCore.npcs.map(n => n.name);
    try {
      const { assets, skipped } = await registerAssetFiles("corepack", [...files], npcNames, coreAssets.map(x => x.asset));
      const next: { asset: StageAsset; file: File }[] = [...coreAssets];
      for (const a of assets.slice(coreAssets.length)) {
        const f = [...files].find(ff => ff.name.replace(/\.[^.]+$/, "") === a.name || ff.name === a.fileName);
        if (f) next.push({ asset: a, file: f });
      }
      setCoreAssets(next);
      // Fork fix: surface partial failures instead of failing silently
      const added = next.length - coreAssets.length;
      if (skipped.length) setError(`已添加 ${added} 个文件；跳过 ${skipped.length} 个不支持的文件：${skipped.join("、")}（仅支持图片/音频）`);
      else if (added === 0) setError("没有新文件被添加——文件名可能重复，或格式不受支持（仅图片/音频）");
    } catch (e) {
      setError(`资源添加失败：${e instanceof Error ? e.message : String(e)}（常见原因：浏览器存储空间不足，请清理后重试）`);
    }
  };
  const handleSectionFile = (file: File | null, setter: (t: string) => void) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => { const t = String(reader.result || ""); setter(t); };
    reader.readAsText(file, "utf-8");
  };
  /** Extract sections → review state. Fork: incremental — locked sections inherit the
   *  previously extracted results (from an imported core pack or a prior extraction);
   *  only unlocked sections with txt content get re-extracted. */
  const handleExtract = async () => {
    if (extracting) return;
    const prev = moduleCore;
    const hasAny = secNpcText.trim() || secTruthText.trim() || secActText.trim() || secHoText.trim() || prev;
    if (!hasAny) return;
    const apiConfigs = loadApiConfigs();
    const apiConfig = apiConfigs.find(c => c.apiKey) || apiConfigs[0];
    if (!apiConfig?.apiKey) { setError("未找到有效的API配置，请先在设置中配置API"); return; }
    setExtracting(true);
    setError(null);
    try {
      const core: ModuleCore = {
        npcs: [],
        locations: [],
        truth: "",
        acts: [],
        rawImported: { npcText: secNpcText, truthText: secTruthText, actText: secActText },
      };
      // NPC — locked: inherit; unlocked with txt: extract
      if (secLocks.npc && prev) {
        core.npcs = prev.npcs;
      } else if (secNpcText.trim()) {
        core.npcs = await extractNpcsFromText(secNpcText, apiConfig, [], p => setExtractProgress(p.step));
      }
      // Truth
      if (secLocks.truth && prev) {
        core.truth = prev.truth;
        if (prev.rawImported?.truthText) core.rawImported!.truthText = prev.rawImported.truthText;
      } else if (secTruthText.trim()) {
        const t = await extractTruthFromText(secTruthText, apiConfig, p => setExtractProgress(p.step));
        core.truth = t.truth;
        core.rawImported!.truthText = secTruthText;
      }
      // Acts
      if (secLocks.act && prev) {
        core.acts = prev.acts;
      } else if (secActText.trim()) {
        core.acts = await extractActsFromText(secActText, apiConfig, p => setExtractProgress(p.step));
      }
      // HO lines — locked: keep current hoLines; unlocked with txt: re-extract; no txt & no lock: keep too
      if (!secLocks.ho && secHoText.trim()) {
        setHoLines(await extractInvestigatorLines(secHoText, apiConfig, p => setExtractProgress(p.step)));
      }
      if (!core.npcs.length && !core.truth && !core.acts.length) throw new Error("三个栏目都提取失败，请检查 API 配置或重试");
      setModuleCore(core);
      setExtractProgress("");
    } catch (e) {
      setError(`提取失败：${e instanceof Error ? e.message : String(e)}——已提取的部分不会丢失，可直接重试`);
    } finally {
      setExtracting(false);
    }
  };
  const handleModuleFile = (file: File | null) => {
    if (!file) return;
    setModuleLoading(true);
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result || "");
      // Cap at ~12000 chars to keep the prompt within context limits
      setModuleText(text.length > 12000 ? text.slice(0, 12000) : text);
      setModuleName(file.name);
      setModuleLoading(false);
    };
    reader.onerror = () => setModuleLoading(false);
    reader.readAsText(file, "utf-8");
  };
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [genError, setGenError] = useState<{ reason: string; raw: string } | null>(null);
  // Fork: staged world-gen progress (shown on the generating world card)
  const [genProgress, setGenProgress] = useState<{ id: string; step: string } | null>(null);

  // DM prompt editor state
  const [dmPrompts, setDmPrompts] = useState(() => {
    const saved = loadDMPrompts();
    return {
      scene: saved.scene || DEFAULT_DM_SCENE_PROMPT,
      resolve: saved.resolve || DEFAULT_DM_RESOLVE_PROMPT,
      worldGen: saved.worldGen || DEFAULT_WORLD_GEN_PROMPT,
      ending: saved.ending || DEFAULT_DM_ENDING_PROMPT,
    };
  });
  const [editingPromptTab, setEditingPromptTab] = useState<PromptEditorKey>("scene");
  const [expandedPromptTab, setExpandedPromptTab] = useState<PromptEditorKey | null>(null);
  const [dmTokenConfig, setDmTokenConfig] = useState<DMTokenConfig>(() => loadDMTokenConfig());
  const [summaryConfig, setSummaryConfig] = useState<AdventureSummaryConfig>(() => loadAdventureSummaryConfig());
  const [adventureConfig, setAdventureConfig] = useState<AdventureInteractionConfig>(() => loadAdventureInteractionConfig());

  // Character selection (used during world creation)
  const [selectedCharIds, setSelectedCharIds] = useState<string[]>([]);

  const characters = useMemo(() => loadCharacters(), []);
  const promptSections: Array<{ key: PromptEditorKey; label: string; helper: string; placeholder: string; value: string; onChange: (value: string) => void; minHeight?: number }> = [
    {
      key: "scene",
      label: "场景生成",
      helper: "场景生成 System Prompt — DM 根据此指令生成场景、NPC 对话和选项。输出格式必须包含: narration, npc_lines, situation, choices, journal, gained, lost, advance, move_to, world_events",
      placeholder: DEFAULT_DM_SCENE_PROMPT,
      value: dmPrompts.scene,
      onChange: value => setDmPrompts(prev => ({ ...prev, scene: value })),
    },
    {
      key: "resolve",
      label: "裁决",
      helper: "裁决 System Prompt — 收到所有角色宣言后，DM 根据此指令统一裁决结果。输出格式同场景生成，本轮声明会自动注入 User Prompt。",
      placeholder: DEFAULT_DM_RESOLVE_PROMPT,
      value: dmPrompts.resolve,
      onChange: value => setDmPrompts(prev => ({ ...prev, resolve: value })),
    },
    {
      key: "worldGen",
      label: "世界生成",
      helper: "世界生成 System Prompt — 用户描述世界观后，AI 根据此指令生成完整世界骨架。输出为 world + regions + main_quest + dm_dossier 的 JSON。",
      placeholder: DEFAULT_WORLD_GEN_PROMPT,
      value: dmPrompts.worldGen,
      onChange: value => setDmPrompts(prev => ({ ...prev, worldGen: value })),
    },
    {
      key: "ending",
      label: "结局",
      helper: "结局 System Prompt — 主线通关后，DM 根据此指令生成结局。输出 JSON: {paragraphs:[\"段落1\",...], closing:\"收束语\"}",
      placeholder: DEFAULT_DM_ENDING_PROMPT,
      value: dmPrompts.ending,
      onChange: value => setDmPrompts(prev => ({ ...prev, ending: value })),
    },
    {
      key: "summary",
      label: "总结提示词",
      helper: "冒险自动总结 Prompt — 达到自动总结间隔后，DM 根据此指令压缩近期日志，生成可长期保留的冒险摘要。",
      placeholder: DEFAULT_ADVENTURE_SUMMARY_PROMPT,
      value: summaryConfig.prompt || DEFAULT_ADVENTURE_SUMMARY_PROMPT,
      onChange: value => setSummaryConfig(prev => ({ ...prev, prompt: value })),
      minHeight: 180,
    },
    {
      key: "bilingual",
      label: "双语提示词",
      helper: "角色双语翻译 Prompt — 角色发言需要翻译时使用，只作用于角色发言的中文译文。",
      placeholder: DEFAULT_ADVENTURE_INTERACTION_CONFIG.bilingualTranslationPrompt,
      value: adventureConfig.bilingualTranslationPrompt,
      onChange: value => setAdventureConfig(prev => ({ ...prev, bilingualTranslationPrompt: value })),
      minHeight: 180,
    },
  ];

  const resetCurrentPrompt = () => {
    if (editingPromptTab === "summary") {
      setSummaryConfig(prev => ({ ...prev, prompt: DEFAULT_ADVENTURE_SUMMARY_PROMPT }));
      return;
    }
    if (editingPromptTab === "bilingual") {
      setAdventureConfig(prev => ({
        ...prev,
        bilingualTranslationPrompt: DEFAULT_ADVENTURE_INTERACTION_CONFIG.bilingualTranslationPrompt,
      }));
      return;
    }
    const defaults: Record<DMPromptTab, string> = {
      scene: DEFAULT_DM_SCENE_PROMPT,
      resolve: DEFAULT_DM_RESOLVE_PROMPT,
      worldGen: DEFAULT_WORLD_GEN_PROMPT,
      ending: DEFAULT_DM_ENDING_PROMPT,
    };
    setDmPrompts(prev => ({ ...prev, [editingPromptTab]: defaults[editingPromptTab] }));
  };

  // ── Create World (background generation) ──
  const handleCreate = async () => {
    // Fork fix: whole-txt import alone is enough — module text becomes the description
    // Fork fix2: when a module txt IS imported, it takes priority as the primary material;
    // the description box degrades to a "supplementary requirements" note for the KP.
    // Fork fix3: a reviewed module core alone is ALSO enough — its world name comes from the
    // pack/module; an empty description box must not silently block creation (button-vs-guard mismatch)
    const effectiveDesc = moduleText.trim()
      ? `${moduleName || "导入模组"}：${moduleText.slice(0, 300)}`
      : moduleCore
        ? (description.trim() || `${moduleName || "核心包模组"}·核心包`)
        : description.trim();
    if (!effectiveDesc || isGenerating) return;
    setIsGenerating(true);
    setError(null);
    const userIdentity = resolveUserIdentity(undefined, "adventure");
    // KP narration style — computed once, used by both assembly & LLM paths (fork fix: was declared after first use)
    const kpStyleInstruction = [
      kpNarrStyle === "日式文风" ? "叙述文风：日式——克制的物哀感、留白与日常细节中的违和，人物称谓和句式贴近轻小说翻译腔" : "",
      kpNarrStyle === "美式文风" ? "叙述文风：美式——直白硬朗的黑色小说笔调，短句与俚语，动作场面干脆利落" : "",
      kpNarrStyle === "国风" ? "叙述文风：国风——白话中带古典意韵，环境描写重意境，克苏鲁元素用志怪笔法呈现" : "",
      kpNarrStyle === "西式古典" ? "叙述文风：西式古典——维多利亚哥特腔调，繁复庄重的长句，恰如洛夫克拉夫特本人的原文" : "",
      kpNarrStyle === "民国风" ? "叙述文风：民国风——上世纪二三十年代白话文的味道，新旧词汇交杂，时代感优先" : "",
      kpArtStyle === "电影风" ? "艺术风格：电影风——注重镜头感，叙述像运镜：远景/特写/切镜，用画面语言营造恐怖" : "",
      kpArtStyle === "文学风" ? "艺术风格：文学风——注重语言细腻的描述，修辞考究，感官细节层层铺陈" : "",
      kpArtStyle === "游戏风" ? "艺术风格：游戏风——注重趣味和反馈，叙述节奏轻快，及时回应玩家的行动并给足存在感" : "",
      kpArtStyle === "纪实风" ? "艺术风格：纪实风——注重发生在当下的感觉，像亲历者的第一手记录，冷静、具体、有时间感" : "",
    ].filter(Boolean).join("\n");

    const apiConfigs = loadApiConfigs();
    const bindings = loadBindingConfig();
    const firstChar = characters[0];
    const slot = firstChar ? resolveBinding(bindings, firstChar.id, "chat") : null;
    const apiConfig = (slot?.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) : null) || apiConfigs.find(c => c.apiKey) || apiConfigs[0];
    if (!apiConfig?.apiKey) { setError("未找到有效的API配置，请先在设置中配置API"); return; }

    // 1. Create placeholder world immediately
    const now = new Date().toISOString();
    const worldId = generateWorldId();
    const placeholder: MapWorld = {
      id: worldId,
      skeleton: { world: { name: effectiveDesc.slice(0, 20) + "...", lore: "" }, mapInput: { map_settings: { header: "", title: "" }, regions: [] }, richRegions: [], mainQuest: { id: "", title: "", type: "main", synopsis: "", triggerRegion: "", stages: [] }, sideQuests: [], npcs: [], encounterPool: [], partyStats: {} },
      renderedMap: { l1Nodes: [], l2Nodes: [], l3Nodes: [], rivers: [], regionBoundaries: [], mapSettings: { header: "", title: "" } } as unknown as import("@/lib/map-engine").MapGenerationOutput,
      createdAt: now,
      updatedAt: now,
      status: "generating",
    };
    saveMapWorld(placeholder);
    setWorlds(loadMapWorlds());
    setMode("list");
    setIsGenerating(false);

    // 2. Capture selected chars + rules edition for save creation later
    const charIdsSnapshot = [...selectedCharIds];
    const edition = rulesEdition;

    // 3. Generate in background
    try {
      // Fork 九期: reviewed module core → code-only assembly (no LLM world-gen call)
      if (moduleCore) {
        const skeleton = assembleSkeletonFromCore(moduleCore, effectiveDesc.slice(0, 20));
        const resp = await fetch("/countries.geo.json");
        const geoData: GeoJSONData = await resp.json();
        const renderedMap = generateMap(skeleton.mapInput, geoData);
        const world: MapWorld = {
          id: worldId,
          skeleton,
          renderedMap,
          createdAt: now,
          updatedAt: new Date().toISOString(),
        };
        // Persist rules edition + KP style (same as LLM path)
        world.skeleton = { ...world.skeleton, world: { ...world.skeleton.world, rulesEdition: edition, lore: kpStyleInstruction ? `${world.skeleton.world.lore}\n\n【KP风格指令】${kpStyleInstruction}` : world.skeleton.world.lore } };
        // Fork: install staged stage assets (from upload or imported pack) into this world
        if (coreAssets.length) {
          const installed: StageAsset[] = [];
          for (const { asset, file } of coreAssets) {
            const inst: StageAsset = { ...asset, id: `asset_${worldId}_${Date.now()}_${installed.length}` };
            try { await putAssetBlob(inst.id, file); installed.push(inst); } catch { /* skip broken file */ }
          }
          if (installed.length) world.assets = installed;
        }
        // Clean up the temporary staging blobs (registerAssetFiles wrote them under "corepack_" ids)
        for (const { asset } of coreAssets) { if (asset.id.startsWith("asset_corepack_")) deleteAssetBlob(asset.id).catch(() => undefined); }
        saveMapWorld(world);
        const startNode = renderedMap.l1Nodes[0]?.id || "l1_0";
        let save = createInitialSave(world.id, startNode, edition, skeleton.personalSecrets);
        // Fork: persona import deferred to first world entry (one LLM call per person, non-blocking here)
        save.personaPending = true;
        if (hoLines?.length) save.investigatorLines = hoLines;   // fork: HO 密档随存档进世界
        for (const cid of charIdsSnapshot) {
          const ch = characters.find(c => c.id === cid);
          save = addAgentToSave(save, cid, ch?.personality || "", edition, skeleton.personalSecrets, undefined);
        }
        const discovered: string[] = [startNode];
        renderedMap.l2Nodes.forEach((n, i) => { if (n.regionIdx === 0) discovered.push(`l2_${i}`); });
        renderedMap.l1Nodes.forEach(n => { if (!discovered.includes(n.id)) discovered.push(n.id); });
        save.discoveredNodes = discovered;
        save.journal[0].locationName = renderedMap.l1Nodes[0]?.nameCn || "起点";
        saveGame(save);
        setWorlds(loadMapWorlds());
        return;
      }
      const vars = {
        // world_desc carries user intent only — the module txt (if any) is the primary material via module_text
        world_desc: moduleText.trim()
          ? (description.trim() ? `${description.trim()}\n（注：已导入模组《${moduleName || "导入模组"}》为主素材，以上描述作为补充要求，与模组冲突时以模组为准）` : `${moduleName || "导入模组"}模组跑团`)
          : effectiveDesc,
        tone: tone || "自由发挥",
        region_count: String(regionCount),
        main_quest_type: mainQuestType || "自由发挥",
        npc_count: String(npcCount),
        difficulty: difficulty || "适中",
        ...(moduleText.trim() ? { module_text: `\n# 导入的模组背景（TRPG模组设定，世界必须严格按此素材构建）\n${moduleText.trim()}` } : {}),
      };
      // (kpStyleInstruction hoisted to the top of handleCreate — assembly path uses it too)
      // (module txt present → userDescription carries intent only; the module itself rides in vars.module_text)
      const skeleton = await generateWorldSkeleton(
        moduleText.trim() ? (description.trim() || "按导入的模组跑团") : effectiveDesc,
        [],
        apiConfig,
        vars,
        (step) => setGenProgress({ id: worldId, step }),
      );

      const resp = await fetch("/countries.geo.json");
      const geoData: GeoJSONData = await resp.json();
      const renderedMap = generateMap(skeleton.mapInput, geoData);

      // 4. Update world with real data (remove status = complete)
      const world: MapWorld = {
        id: worldId,
        skeleton,
        renderedMap,
        createdAt: now,
        updatedAt: new Date().toISOString(),
      };
      // Persist KP narration style + rules edition into the world skeleton (fork: per-world)
      world.skeleton = {
        ...world.skeleton,
        world: {
          ...world.skeleton.world,
          rulesEdition: edition,
          lore: kpStyleInstruction ? `${world.skeleton.world.lore}\n\n【KP风格指令】${kpStyleInstruction}` : world.skeleton.world.lore,
        },
      };
      saveMapWorld(world);

      // 5. Create initial save with selected characters
      const startNode = renderedMap.l1Nodes[0]?.id || "l1_0";
      let save = createInitialSave(world.id, startNode, edition, skeleton.personalSecrets);
      // Fork: persona import deferred to first world entry (one LLM call per person, non-blocking here)
      save.personaPending = true;
      if (hoLines?.length) save.investigatorLines = hoLines;   // fork: HO 密档随存档进世界
      for (const cid of charIdsSnapshot) {
        const ch = characters.find(c => c.id === cid);
        save = addAgentToSave(save, cid, ch?.personality || "", edition, skeleton.personalSecrets, undefined);
      }
      const startRegionIdx = 0;
      const discovered: string[] = [startNode];
      renderedMap.l2Nodes.forEach((n, i) => { if (n.regionIdx === startRegionIdx) discovered.push(`l2_${i}`); });
      renderedMap.l3Nodes.forEach((n, i) => { if (n.regionIdx === startRegionIdx) discovered.push(`l3_${i}`); });
      renderedMap.l1Nodes.forEach((n) => { if (!discovered.includes(n.id)) discovered.push(n.id); });
      save.discoveredNodes = discovered;
      save.journal[0].locationName = renderedMap.l1Nodes[0]?.nameCn || "起点";
      saveGame(save);

      setWorlds(loadMapWorlds());
      setGenProgress(null);
    } catch (e) {
      // Mark as failed + surface reason and raw LLM output in a dialog.
      const reason = e instanceof Error ? e.message : String(e);
      const raw = (e as { rawOutput?: string })?.rawOutput || "";
      const failed: MapWorld = { ...placeholder, status: "failed", statusMessage: reason, failureRaw: raw, updatedAt: new Date().toISOString() };
      saveMapWorld(failed);
      setWorlds(loadMapWorlds());
      setGenProgress(null);
      setGenError({ reason, raw });
    }
  };

  // ── Enter World (skip character selection, go straight in) ──
  const handleEnterWorld = (world: MapWorld) => {
    const save = getLatestSave(world.id) || createInitialSave(world.id, world.renderedMap.l1Nodes[0]?.id || "l1_0", world.skeleton.world.rulesEdition || "coc6", world.skeleton.personalSecrets);
    onStartGame(world, save);
  };

  const toggleChar = (id: string) => {
    setSelectedCharIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const handleDelete = (id: string) => {
    deleteMapWorld(id);
    setWorlds(loadMapWorlds());
    setDeleteConfirmId(null);
  };

  const S: Record<string, React.CSSProperties> = {
    root: { position: "absolute", inset: 0, background: "#0a0a0f", display: "flex", flexDirection: "column", fontFamily: "'PingFang SC', system-ui, sans-serif", color: "#e0dcd5", overflow: "hidden" },
    header: {
      height: "var(--page-header-content-height, 42px)",
      marginTop: "var(--page-header-safe-top, 48px)",
      padding: "1px 20px",
      display: "flex",
      justifyContent: "space-between",
      alignItems: "center",
      flexShrink: 0,
    },
    btn: { width: 36, height: 36, display: "flex", alignItems: "center", justifyContent: "center", background: "none", border: "none", color: "rgba(255,255,255,0.5)", cursor: "pointer" },
    body: { flex: 1, overflow: "auto", padding: "0 20px 20px" },
    card: { padding: "14px 16px", borderRadius: 10, background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", marginBottom: 10 },
    label: { fontSize: "calc(12px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)", marginBottom: 6 },
    input: { width: "100%", minHeight: 100, padding: 12, borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "rgba(255,255,255,0.04)", color: "#e0dcd5", fontSize: "calc(14px*var(--app-text-scale,1))", fontFamily: "inherit", lineHeight: 1.6, resize: "vertical" as const, outline: "none", boxSizing: "border-box" as const },
    primaryBtn: { width: "100%", padding: "14px 0", borderRadius: 10, border: "none", background: "rgba(200,160,100,0.2)", color: "#e8d0a0", fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: 500, letterSpacing: "0.1em", cursor: "pointer", fontFamily: "inherit" },
  };

  return (
    <div style={S.root}>
      <div style={S.header}>
        <button onClick={mode === "list" ? onClose : () => setMode("list")} style={S.btn}>
          <ArrowLeft size={20} />
        </button>
        <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", letterSpacing: "0.2em", color: "rgba(255,255,255,0.3)", fontFamily: "monospace" }}>
          {mode === "list" ? "MAP ADVENTURES" : mode === "create" ? "NEW WORLD" : "DM PROMPTS"}
        </span>
        {mode === "list" ? (
          <div style={{ display: "flex", gap: 2 }}>
            <button
              type="button"
              aria-label="冒险设置"
              onClick={() => { const s = loadDMPrompts(); setDmPrompts({ scene: s.scene || DEFAULT_DM_SCENE_PROMPT, resolve: s.resolve || DEFAULT_DM_RESOLVE_PROMPT, worldGen: s.worldGen || DEFAULT_WORLD_GEN_PROMPT, ending: s.ending || DEFAULT_DM_ENDING_PROMPT }); setMode("prompts"); }}
              style={S.btn}
            >
              <MoreHorizontal size={22} strokeWidth={1.7} />
            </button>
          </div>
        ) : <div style={{ width: 36 }} />}
      </div>

      <div style={mode === "list" ? { ...S.body, padding: "0 20px 96px" } : S.body}>
        {/* ── World List ── */}
        {mode === "list" && (
          worlds.length === 0 ? (
            <div style={{ textAlign: "center", padding: "80px 0", color: "rgba(255,255,255,0.2)" }}>
              <div style={{ fontSize: "calc(32px*var(--app-text-scale,1))", marginBottom: 12 }}>🗺</div>
              <div style={{ fontSize: "calc(13px*var(--app-text-scale,1))" }}>还没有冒险世界</div>
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", marginTop: 4 }}>点击右下角 + 创建一个</div>
            </div>
          ) : worlds.map(w => (
            <div key={w.id} style={{ ...S.card, opacity: w.status === "generating" ? 0.6 : 1 }}>
              <div style={{ fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: 600, marginBottom: 4 }}>
                {w.skeleton.world.name || "新世界"}
                {w.status === "generating" && <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,200,100,0.6)", marginLeft: 8, fontWeight: 400 }}>{genProgress && genProgress.id === w.id ? `生成中 · ${genProgress.step}` : "生成中..."}</span>}
                {w.status === "failed" && <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,100,80,0.7)", marginLeft: 8, fontWeight: 400 }}>生成失败</span>}
              </div>
              {w.status === "failed" && w.statusMessage && (
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,100,80,0.5)", marginBottom: 6, lineHeight: 1.4 }}>{w.statusMessage.slice(0, 100)}</div>
              )}
              {!w.status && <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.35)", marginBottom: 10 }}>{w.skeleton.world.lore.slice(0, 60)}...</div>}
              <div style={{ display: "flex", gap: 8 }}>
                {!w.status && (
                  <button onClick={() => handleEnterWorld(w)} style={{ flex: 1, padding: "8px 0", borderRadius: 6, border: "1px solid rgba(255,255,255,0.15)", background: "rgba(255,255,255,0.06)", color: "#e0dcd5", fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 4, fontFamily: "inherit" }}>
                    <Play size={12} /> 进入
                  </button>
                )}
                {w.status === "generating" && (
                  <div style={{ flex: 1, padding: "8px 0", textAlign: "center", fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,200,100,0.4)", fontFamily: "monospace", letterSpacing: "0.1em" }}>
                    世界正在生成中...
                  </div>
                )}
                {w.status === "failed" && (
                  <button onClick={() => setGenError({ reason: w.statusMessage || "生成失败", raw: w.failureRaw || "" })} style={{ flex: 1, padding: "8px 0", borderRadius: 6, border: "1px solid var(--c-adv-accent-dim)", background: "transparent", color: "var(--c-adv-accent)", fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit" }}>
                    查看失败详情
                  </button>
                )}
                <button onClick={() => setDeleteConfirmId(w.id)} style={{ padding: "8px 12px", borderRadius: 6, border: "1px solid rgba(255,100,80,0.2)", background: "transparent", color: "rgba(255,100,80,0.6)", fontSize: "calc(12px*var(--app-text-scale,1))", cursor: "pointer" }}>
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))
        )}

        {/* ── Create World ── */}
        {mode === "create" && (<>
          <style>{`
            @keyframes tome-glow { 0%,100%{box-shadow:0 0 15px rgba(200,160,100,0.06),inset 0 0 30px rgba(200,160,100,0.02)} 50%{box-shadow:0 0 25px rgba(200,160,100,0.12),inset 0 0 40px rgba(200,160,100,0.04)} }
            @keyframes seal-press { 0%{transform:scale(1)} 50%{transform:scale(0.92)} 100%{transform:scale(1)} }
            @keyframes ritual-pulse { 0%,100%{box-shadow:0 0 20px rgba(200,160,100,0.1),0 0 40px rgba(200,160,100,0.05)} 50%{box-shadow:0 0 30px rgba(200,160,100,0.25),0 0 60px rgba(200,160,100,0.1)} }
            .tome-seal:active { animation: seal-press 0.2s ease; }
            .tome-ritual:not(:disabled):hover { animation: ritual-pulse 1.5s ease infinite; }
            .tome-slider { -webkit-appearance:none; appearance:none; height:4px; border-radius:2px; background:linear-gradient(90deg,rgba(200,160,100,0.3),rgba(200,160,100,0.08)); outline:none; }
            .tome-slider::-webkit-slider-thumb { -webkit-appearance:none; width:18px; height:18px; border-radius:50%; background:radial-gradient(circle at 40% 35%,#d4b87a,#8a6d3b); border:2px solid rgba(200,160,100,0.5); box-shadow:0 2px 8px rgba(0,0,0,0.4),inset 0 1px 2px rgba(255,255,255,0.2); cursor:pointer; }
          `}</style>
          <div style={{
            display: "flex", flexDirection: "column", gap: 0,
            background: "linear-gradient(180deg, rgba(20,16,10,0.6), rgba(15,12,8,0.8))",
            border: "1px solid rgba(200,160,100,0.1)",
            borderRadius: 14,
            padding: "18px 16px",
            animation: "tome-glow 4s ease infinite",
          }}>
            {/* ── Tome header ornament ── */}
            <div style={{ textAlign: "center", marginBottom: 16 }}>
              <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", letterSpacing: "0.4em", color: "rgba(200,160,100,0.3)", fontFamily: "monospace" }}>
                ── 世界创造之书 ──
              </div>
            </div>

            {/* ── World description ── */}
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", marginBottom: 6, letterSpacing: "0.08em" }}>
                世界描述
              </div>
              <textarea value={description} onChange={e => setDescription(e.target.value)}
                placeholder="在此书写你所构想的世界...&#10;&#10;例如：吸血鬼的黑暗世界，人类在夹缝中求生，几大血族家族争夺王座..."
                style={{
                  width: "100%", minHeight: 90, padding: "12px 14px", borderRadius: 10,
                  border: "1px solid rgba(200,160,100,0.12)",
                  background: "rgba(0,0,0,0.3)",
                  color: "#d8cbb8", fontSize: "calc(13px*var(--app-text-scale,1))", fontFamily: "inherit", lineHeight: 1.7,
                  resize: "vertical", outline: "none", boxSizing: "border-box",
                }} />
              {moduleText.trim() && (
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,200,100,0.55)", marginTop: 6, lineHeight: 1.5 }}>
                  📄 已导入模组《{moduleName || "导入模组"}》——世界将严格按模组素材生成；此处描述仅作为补充要求（可留空）
                </div>
              )}
            </div>

            {/* ── Divider ── */}
            <div style={{ height: 1, background: "linear-gradient(90deg, transparent, rgba(200,160,100,0.15), transparent)", margin: "2px 0 14px" }} />

            {/* ── Advanced options (style & tone — collapsed by default; module import stays always-visible below) ── */}
            <button type="button" onClick={() => setShowAdvanced(!showAdvanced)} style={{
              width: "100%", padding: "9px 0", marginBottom: 14, borderRadius: 8,
              border: "1px dashed rgba(200,160,100,0.25)", background: "transparent",
              color: "rgba(200,160,100,0.55)", fontSize: "calc(11px*var(--app-text-scale,1))",
              cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.05em",
            }}>
              {showAdvanced ? "▲ 收起风格与难度" : "▼ 风格与难度（可选，不展开也能直接创建）"}
            </button>
            {showAdvanced && (<>
            {/* ── Tag sections ── */}
            {([
              { label: "风格基调", value: tone, setter: setTone, tags: ["轻松", "黑暗", "恐怖", "浪漫", "悬疑", "幽默", "治愈", "热血", "荒诞", "日常怪谈"] },
              { label: "主线类型", value: mainQuestType, setter: setMainQuestType, tags: ["解开谜团", "阴谋揭露", "失踪案", "禁忌知识", "邪教调查", "古宅探秘", "小镇怪事", "寻找宝藏", "生存逃脱", "恋爱喜剧"] },
              { label: "难度", value: difficulty, setter: setDifficulty, tags: ["轻松冒险", "适中", "硬核生存", "地狱难度"] },
            ] as const).map(section => (
              <div key={section.label} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", marginBottom: 7, letterSpacing: "0.08em" }}>
                  {section.label}
                </div>
                <div style={{
                  padding: "8px 10px", borderRadius: 7,
                  border: "1px solid rgba(200,160,100,0.08)",
                  background: "rgba(0,0,0,0.2)",
                }}>
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${section.tags.length <= 4 ? section.tags.length : section.tags.length <= 6 ? 3 : 4}, 1fr)`, gap: 5, marginBottom: 7 }}>
                    {section.tags.map(t => {
                      const active = section.value === t;
                      return (
                        <button key={t} className="tome-seal"
                          onClick={() => section.setter(active ? "" : t)}
                          style={{
                            padding: "6px 4px", borderRadius: 6,
                            border: `1px solid ${active ? "rgba(200,160,100,0.45)" : "rgba(200,160,100,0.1)"}`,
                            background: active
                              ? "linear-gradient(135deg, rgba(200,160,100,0.18), rgba(200,160,100,0.08))"
                              : "rgba(0,0,0,0.3)",
                            color: active ? "#e8d0a0" : "rgba(255,255,255,0.35)",
                            fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                            boxShadow: active ? "0 0 8px rgba(200,160,100,0.1), inset 0 1px 0 rgba(255,255,255,0.05)" : "none",
                            transition: "all 0.2s ease",
                            textAlign: "center",
                          }}>
                          {t}
                        </button>
                      );
                    })}
                  </div>
                  <input value={section.value} onChange={e => section.setter(e.target.value)}
                    placeholder="自定义..."
                    style={{
                      width: "100%", padding: "5px 0", borderRadius: 0,
                      border: "none", borderTop: "1px solid rgba(200,160,100,0.06)",
                      background: "transparent",
                      color: "#d8cbb8", fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit",
                      outline: "none", boxSizing: "border-box",
                    }} />
                </div>
              </div>
            ))}

            {/* ── Divider ── */}
            <div style={{ height: 1, background: "linear-gradient(90deg, transparent, rgba(200,160,100,0.15), transparent)", margin: "2px 0 14px" }} />

            {/* ── KP narration style ── */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", marginBottom: 7, letterSpacing: "0.08em" }}>
                KP 叙述风格
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                {(["日式文风", "美式文风", "国风", "西式古典", "民国风"] as const).map(t => {
                  const active = kpNarrStyle === t;
                  return (
                    <button key={t} className="tome-seal"
                      onClick={() => setKpNarrStyle(active ? "" : t)}
                      style={{
                        padding: "6px 12px", borderRadius: 6,
                        border: `1px solid ${active ? "rgba(200,160,100,0.45)" : "rgba(200,160,100,0.1)"}`,
                        background: active ? "linear-gradient(135deg, rgba(200,160,100,0.18), rgba(200,160,100,0.08))" : "rgba(0,0,0,0.3)",
                        color: active ? "#e8d0a0" : "rgba(255,255,255,0.35)",
                        fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                        transition: "all 0.2s ease",
                      }}>
                      {t}
                    </button>
                  );
                })}
              </div>
              <div style={{ marginTop: 7 }}>
                <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", marginBottom: 7, letterSpacing: "0.08em" }}>
                  艺术风格
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
                  {([
                    ["电影风", "注重镜头感"],
                    ["文学风", "注重语言细腻的描述"],
                    ["游戏风", "注重趣味和反馈"],
                    ["纪实风", "注重发生在当下的感觉"],
                  ] as const).map(([t, hint]) => {
                    const active = kpArtStyle === t;
                    return (
                      <button key={t} className="tome-seal"
                        onClick={() => setKpArtStyle(active ? "" : t)}
                        title={hint}
                        style={{
                          padding: "6px 12px", borderRadius: 6,
                          border: `1px solid ${active ? "rgba(200,160,100,0.45)" : "rgba(200,160,100,0.1)"}`,
                          background: active ? "linear-gradient(135deg, rgba(200,160,100,0.18), rgba(200,160,100,0.08))" : "rgba(0,0,0,0.3)",
                          color: active ? "#e8d0a0" : "rgba(255,255,255,0.35)",
                          fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                          transition: "all 0.2s ease",
                        }}>
                        {t}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
            </>)}
            {/* ── End advanced options (style & tone) ── */}

            {/* ── Divider ── */}
            <div style={{ height: 1, background: "linear-gradient(90deg, transparent, rgba(200,160,100,0.15), transparent)", margin: "2px 0 14px" }} />

            {/* ── TRPG module import (txt) ── */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", marginBottom: 6, letterSpacing: "0.08em" }}>
                导入模组背景（可选 · txt）
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <label style={{
                  flex: 1, padding: "8px 10px", borderRadius: 7, textAlign: "center",
                  border: `1px solid ${moduleText ? "rgba(200,160,100,0.4)" : "rgba(200,160,100,0.1)"}`,
                  background: moduleText ? "rgba(200,160,100,0.1)" : "rgba(0,0,0,0.2)",
                  color: moduleText ? "#e8d0a0" : "rgba(255,255,255,0.35)",
                  fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                }}>
                  {moduleLoading ? "读取中..." : moduleText ? `📄 ${moduleName}（已导入 ${moduleText.length} 字）` : "选择 .txt 模组文件（docx 请先另存为 txt）"}
                  <input type="file" accept=".txt,.md,text/plain" hidden onChange={e => handleModuleFile(e.target.files?.[0] ?? null)} />
                </label>
                {moduleText && (
                  <button type="button" onClick={() => { setModuleText(""); setModuleName(""); }}
                    style={{
                      padding: "8px 10px", borderRadius: 7,
                      border: "1px solid rgba(255,100,80,0.2)", background: "transparent",
                      color: "rgba(255,100,80,0.6)", fontSize: "calc(11px*var(--app-text-scale,1))",
                      cursor: "pointer", fontFamily: "inherit", flexShrink: 0,
                    }}>
                    移除
                  </button>
                )}
              </div>
              {moduleText && (
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.25)", marginTop: 5, lineHeight: 1.5 }}>
                  模组将作为世界生成的背景设定：NPC、怪物、地点、主线会优先取自模组内容（超长文件自动截取前 12000 字，建议大模组自行切割）
                </div>
              )}
            </div>

            {/* ── Sectioned import + extraction + review (fork 九期) ── */}
            <div style={{ marginBottom: 14, padding: "12px 12px", borderRadius: 10, border: "1px solid rgba(200,160,100,0.18)", background: "rgba(0,0,0,0.25)" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", letterSpacing: "0.08em" }}>分栏导入（大模组友好）</div>
                <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.25)" }}>提取→审校→组装，失败只重跑单栏</div>
              </div>
              {/* Four section upload slots with per-section locks (fork: 重新提取时锁住的栏目保留已提取结果) */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {([
                  { label: "NPC / 人物", text: secNpcText, setter: setSecNpcText, hint: "人物介绍、NPC列表", lock: "npc" as const, locked: secLocks.npc, count: moduleCore?.npcs.length },
                  { label: "真相 / 背景", text: secTruthText, setter: setSecTruthText, hint: "密档、背景设定、真相", lock: "truth" as const, locked: secLocks.truth, count: moduleCore?.truth ? undefined : undefined },
                  { label: "跑团流程", text: secActText, setter: setSecActText, hint: "分幕流程、剧情结构", lock: "act" as const, locked: secLocks.act, count: moduleCore?.acts.length },
                  { label: "HO 剧情", text: secHoText, setter: setSecHoText, hint: "各HO的导入剧情与个人线", lock: "ho" as const, locked: secLocks.ho, count: hoLines?.length },
                ] as const).map(sec => (
                  <div key={sec.label} style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)", width: 68, flexShrink: 0 }}>{sec.label}</span>
                    <label style={{
                      flex: 1, padding: "7px 10px", borderRadius: 7, textAlign: "center", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                      border: `1px solid ${sec.text ? "rgba(200,160,100,0.4)" : "rgba(200,160,100,0.1)"}`,
                      background: sec.text ? "rgba(200,160,100,0.1)" : "rgba(0,0,0,0.2)",
                      color: sec.text ? "#e8d0a0" : "rgba(255,255,255,0.35)",
                      fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                    }}>
                      {sec.text ? `📄 ${sec.text.length} 字` : `导入${sec.hint}（.txt）`}
                      <input type="file" accept=".txt,.md,text/plain" hidden onChange={e => { handleSectionFile(e.target.files?.[0] ?? null, sec.setter); setSecLocks(prev => ({ ...prev, [sec.lock]: false })); }} />
                    </label>
                    <button type="button" title={sec.locked ? "锁定中：重新提取时保留此栏已提取结果" : "未锁定：重新提取时会重提此栏"}
                      onClick={() => setSecLocks(prev => ({ ...prev, [sec.lock]: !prev[sec.lock] }))}
                      style={{ padding: "7px 9px", borderRadius: 7, border: `1px solid ${sec.locked ? "rgba(120,200,150,0.4)" : "rgba(255,255,255,0.12)"}`, background: sec.locked ? "rgba(120,200,150,0.12)" : "transparent", color: sec.locked ? "rgba(140,220,160,0.9)" : "rgba(255,255,255,0.3)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit", flexShrink: 0 }}>
                      {sec.locked ? "🔒" : "🔓"}
                    </button>
                    {sec.text && (
                      <button type="button" onClick={() => sec.setter("")} style={{ padding: "7px 8px", borderRadius: 7, border: "1px solid rgba(255,100,80,0.2)", background: "transparent", color: "rgba(255,100,80,0.6)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit" }}>✕</button>
                    )}
                  </div>
                ))}
              </div>
              {(secLocks.npc || secLocks.truth || secLocks.act || secLocks.ho) && (
                <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(140,220,160,0.55)", marginTop: 8, lineHeight: 1.5 }}>
                  🔒 {[
                    secLocks.npc && "NPC", secLocks.truth && "真相", secLocks.act && "流程", secLocks.ho && "HO",
                  ].filter(Boolean).join("、")} 栏已锁定——点「提取模组核心」只重提未锁定且已导入txt的栏目，锁定栏目保留现有结果
                </div>
              )}
              {/* Extract button + progress */}
              <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center" }}>
                <button type="button" className="tome-seal" onClick={handleExtract} disabled={extracting}
                  style={{
                    flex: 1, padding: "9px 0", borderRadius: 7,
                    border: `1px solid ${extracting ? "rgba(255,255,255,0.05)" : "rgba(200,160,100,0.3)"}`,
                    background: extracting ? "rgba(255,255,255,0.03)" : "rgba(200,160,100,0.15)",
                    color: extracting ? "rgba(255,255,255,0.25)" : "#e8d0a0",
                    fontSize: "calc(11px*var(--app-text-scale,1))", cursor: extracting ? "default" : "pointer", fontFamily: "inherit",
                  }}>
                  {extracting ? "⏳ 提取中..." : "🔍 提取模组核心"}
                </button>
                {moduleCore && !extracting && (
                  <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(140,220,160,0.8)", fontFamily: "monospace" }}>✓ 已提取</span>
                )}
              </div>
              {extractProgress && (
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(200,200,140,0.7)", marginTop: 6, fontFamily: "monospace" }}>{extractProgress}</div>
              )}
              {/* Fork: HO 密档审校（导入剧情/关系/事件，创建世界时随核心包进存档） */}
              {hoLines && hoLines.length > 0 && (
                <div style={{ marginTop: 10, borderTop: "1px solid rgba(200,160,100,0.12)", paddingTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", letterSpacing: "0.08em" }}>🎭 HO 密档（{hoLines.length} 位调查员的私人剧情）</span>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 180, overflowY: "auto" }}>
                    {hoLines.map((l, i) => (
                      <div key={l.ho + i} style={{ padding: "6px 8px", borderRadius: 7, background: "rgba(0,0,0,0.2)", border: "1px solid rgba(150,120,220,0.15)" }}>
                        <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 3 }}>
                          <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", fontWeight: 700, color: "rgba(190,170,240,0.95)" }}>{l.ho}</span>
                          <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)" }}>
                            {l.relations.length ? `关系：${l.relations.map(r => r.npc).join("、")}` : "无已提取关系"} · 事件 {l.events.length} 条
                          </span>
                          <button type="button" onClick={() => setHoLines(hoLines.filter((_, j) => j !== i))}
                            style={{ background: "none", border: "none", color: "rgba(255,100,80,0.5)", cursor: "pointer", fontSize: "calc(11px*var(--app-text-scale,1))", marginLeft: "auto", padding: 2 }}>✕</button>
                        </div>
                        {l.introStory && <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.45)", lineHeight: 1.5, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{l.introStory}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {/* Core pack export/import (fork 十二期 — reuse reviewed extraction) */}
              <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
                <button type="button" onClick={async () => {
                  if (!moduleCore) return;
                  // Fork slim: re-encode images (WebP/JPEG q0.85, portraits ≤1024px, CG ≤1600px) before embedding
                  const audioWarn = coreAssets.filter(x => x.asset.kind === "bgm" && x.file.size > 8 * 1024 * 1024);
                  if (audioWarn.length) {
                    const go = window.confirm(`有 ${audioWarn.length} 个音频超过 8MB（${audioWarn.map(x => x.asset.name).join("、")}）——包会很大。建议先用 128kbps MP3 压缩。仍要导出吗？`);
                    if (!go) return;
                  }
                  const stageAssets = await Promise.all(coreAssets.map(async ({ asset, file }) => {
                    let payload: Blob = file;
                    if (asset.kind === "portrait") payload = await compressImageForPack(file, 1024);
                    else if (asset.kind === "cg") payload = await compressImageForPack(file, 1600);
                    const buf = await payload.arrayBuffer();
                    const bytes = new Uint8Array(buf);
                    let bin = "";
                    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
                    return { kind: asset.kind, name: asset.name, boundTo: asset.boundTo, fileName: asset.fileName, note: asset.note, dataBase64: btoa(bin), mime: payload.type || file.type };
                  }));
                  // Fork slim: gzip the whole JSON (base64 inflates ~33%; gzip recovers it and more)
                  const json = JSON.stringify({ ...moduleCore, ...(stageAssets.length ? { stageAssets } : {}), ...(hoLines?.length ? { investigatorLines: hoLines } : {}) });
                  let blob: Blob;
                  let fname = `module-core-${Date.now()}.json`;
                  const gz = await gzipText(json);
                  if (gz && gz.byteLength < json.length) {
                    blob = new Blob([gz], { type: "application/gzip" });
                    fname = `module-core-${Date.now()}.json.gz`;
                  } else {
                    blob = new Blob([json], { type: "application/json" });
                  }
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement("a");
                  a.href = url; a.download = fname; a.click();
                  URL.revokeObjectURL(url);
                }} style={{
                  flex: 1, padding: "7px 0", borderRadius: 7, border: "1px solid var(--c-adv-input-border, rgba(200,160,100,0.15))", background: "transparent",
                  color: "rgba(200,160,100,0.75)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                }}>⬆ 导出核心包</button>
                <label style={{
                  flex: 1, padding: "7px 0", borderRadius: 7, border: "1px solid var(--c-adv-input-border, rgba(200,160,100,0.15))", background: "transparent",
                  color: "rgba(200,160,100,0.75)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit", textAlign: "center",
                }}>
                  ⬇ 导入核心包
                  <input type="file" accept=".json,.gz,application/json,application/gzip" hidden onChange={e => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    const reader = new FileReader();
                    reader.onload = async () => {
                      try {
                        // read as ArrayBuffer first — .gz packs are binary (readAsText would corrupt bytes)
                        const raw = reader.result as ArrayBuffer;
                        const head = new Uint8Array(raw.slice(0, 2));
                        let text: string;
                        if ((f.name.endsWith(".gz") || (head[0] === 0x1f && head[1] === 0x8b)) && typeof DecompressionStream !== "undefined") {
                          text = await gunzipBytes(new Uint8Array(raw));
                        } else {
                          text = new TextDecoder("utf-8").decode(raw);
                        }
                        const core = JSON.parse(text) as ModuleCore;
                        if (!Array.isArray(core.npcs) || !Array.isArray(core.acts)) throw new Error("格式不符");
                        setModuleCore(core);
                        setHoLines(Array.isArray(core.investigatorLines) && core.investigatorLines.length ? core.investigatorLines : null);
                        // Fork: imported pack = ready-made results → lock all sections so a
                        // later "提取" pass only re-runs what the user explicitly unlocks
                        setSecLocks({ npc: true, truth: true, act: true, ho: Array.isArray(core.investigatorLines) && core.investigatorLines.length > 0 });
                        // Fork: carried stage assets become staged Files (rewritten to IDB on world create)
                        if (Array.isArray(core.stageAssets) && core.stageAssets.length) {
                          const staged = await Promise.all(core.stageAssets.map(async sa => {
                            const bin = atob(sa.dataBase64);
                            const bytes = new Uint8Array(bin.length);
                            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                            const file = new File([bytes], sa.fileName || `${sa.name}.bin`, { type: sa.mime || "application/octet-stream" });
                            const asset: StageAsset = { id: `asset_corepack_${Date.now()}_${sa.name}`, kind: sa.kind, name: sa.name, boundTo: sa.boundTo, fileName: sa.fileName, note: sa.note };
                            return { asset, file };
                          }));
                          setCoreAssets(staged);
                          setError(`核心包已载入（含 ${staged.length} 个演出资源，创建世界时自动安装）`);
                        } else {
                          setCoreAssets([]);
                        }
                      } catch (err) {
                        setError(`核心包导入失败：${err instanceof Error ? err.message : String(err)}`);
                      }
                    };
                    reader.readAsArrayBuffer(f);
                  }} />
                </label>
              </div>
              {/* Fork: stage assets for the pack (portraits / CG / BGM — embedded on export) */}
              {moduleCore && (
                <div style={{ marginTop: 10, borderTop: "1px solid rgba(200,160,100,0.12)", paddingTop: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                    <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", letterSpacing: "0.08em" }}>🎭 演出资源（随核心包分享）</span>
                    {coreAssets.length > 0 && <span style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(140,220,160,0.8)", fontFamily: "monospace" }}>{coreAssets.length} 个</span>}
                  </div>
                  <label style={{
                    display: "block", padding: "7px 10px", borderRadius: 7, textAlign: "center",
                    border: "1px dashed rgba(200,160,100,0.25)", background: "rgba(0,0,0,0.15)",
                    color: "rgba(200,160,100,0.6)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                  }}>
                    ＋ 添加立绘 / CG / BGM 文件（多选）
                    <input type="file" multiple hidden accept="image/*,audio/*" onChange={e => { handleCoreAssetFiles(e.target.files); e.currentTarget.value = ""; }} />
                  </label>
                  {coreAssets.length > 0 && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, maxHeight: 200, overflowY: "auto" }}>
                      {([
                        { kind: "portrait" as const, icon: "🖼", title: "立绘" },
                        { kind: "cg" as const, icon: "🎬", title: "CG" },
                        { kind: "bgm" as const, icon: "🎵", title: "BGM" },
                      ]).map(({ kind, icon, title }) => {
                        const list = coreAssets.filter(({ asset }) => asset.kind === kind);
                        return (
                          <div key={kind}>
                            <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.55)", fontFamily: "monospace", letterSpacing: "0.08em", marginBottom: 3 }}>
                              {icon} {title} · {list.length ? `${list.length} 个` : "空"}
                            </div>
                            {list.length > 0 && (
                              <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                                {list.map(({ asset }) => (
                                  <div key={asset.id} style={{ display: "flex", alignItems: "center", gap: 6, padding: "4px 7px", borderRadius: 6, background: "rgba(0,0,0,0.2)", border: "1px solid rgba(200,160,100,0.08)" }}>
                                    <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))" }}>{icon}</span>
                                    <span style={{ flex: 1, minWidth: 0, fontSize: "calc(10px*var(--app-text-scale,1))", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                      {asset.name}{asset.boundTo
                                        ? <span style={{ color: "rgba(140,220,160,0.8)" }}> → {asset.boundTo}</span>
                                        : <span style={{ color: "rgba(255,150,120,0.7)" }}> · 未绑定</span>}
                                    </span>
                                    <button type="button" onClick={() => setCoreAssets(coreAssets.filter(({ asset: x }) => x.id !== asset.id))}
                                      style={{ background: "none", border: "none", color: "rgba(255,100,80,0.5)", cursor: "pointer", fontSize: "calc(11px*var(--app-text-scale,1))", padding: 2 }}>✕</button>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.25)", marginTop: 5, lineHeight: 1.5 }}>
                    命名规则：立绘=NPC名.png（自动绑定）· CG=cg_场景名.png · BGM=bgm_曲名.mp3；导出时打包进 JSON，对方导入即用
                  </div>
                </div>
              )}
              {/* Review editor */}
              {moduleCore && (
                <div style={{ marginTop: 10, borderTop: "1px solid rgba(200,160,100,0.12)", paddingTop: 10 }}>
                  <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", marginBottom: 6, letterSpacing: "0.08em" }}>审校提取结果（可增删改）</div>
                  <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
                    {(["npcs", "truth", "acts"] as const).map(t => (
                      <button key={t} type="button" onClick={() => setCoreTab(t)}
                        style={{
                          flex: 1, padding: "6px 0", borderRadius: 6,
                          border: `1px solid ${coreTab === t ? "rgba(200,160,100,0.4)" : "rgba(200,160,100,0.1)"}`,
                          background: coreTab === t ? "rgba(200,160,100,0.15)" : "rgba(0,0,0,0.2)",
                          color: coreTab === t ? "#e8d0a0" : "rgba(255,255,255,0.35)",
                          fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                        }}>
                        {t === "npcs" ? `NPC(${moduleCore.npcs.length})` : t === "truth" ? "真相" : `幕(${moduleCore.acts.length})`}
                      </button>
                    ))}
                  </div>
                  {coreTab === "npcs" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 220, overflowY: "auto" }}>
                      {moduleCore.npcs.map((n, i) => (
                        <div key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start", padding: "6px 8px", borderRadius: 7, background: "rgba(0,0,0,0.2)", border: "1px solid rgba(200,160,100,0.08)" }}>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <input value={n.name} onChange={e => setModuleCore({ ...moduleCore, npcs: moduleCore.npcs.map((x, j) => j === i ? { ...x, name: e.target.value } : x) })}
                              style={{ width: "100%", background: "transparent", border: "none", outline: "none", color: "#e8d0a0", fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit", marginBottom: 3 }} />
                            <textarea value={n.personality} onChange={e => setModuleCore({ ...moduleCore, npcs: moduleCore.npcs.map((x, j) => j === i ? { ...x, personality: e.target.value } : x) })}
                              style={{ width: "100%", minHeight: 44, background: "transparent", border: "none", outline: "none", color: "rgba(255,255,255,0.55)", fontSize: "calc(10px*var(--app-text-scale,1))", fontFamily: "inherit", lineHeight: 1.5, resize: "vertical" }} />
                            <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)" }}>{n.role}{n.location ? ` · ${n.location}` : ""}</div>
                          </div>
                          <button type="button" onClick={() => setModuleCore({ ...moduleCore, npcs: moduleCore.npcs.filter((_, j) => j !== i) })}
                            style={{ background: "none", border: "none", color: "rgba(255,100,80,0.5)", cursor: "pointer", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit", padding: 2 }}>✕</button>
                        </div>
                      ))}
                      <button type="button" onClick={() => setModuleCore({ ...moduleCore, npcs: [...moduleCore.npcs, { name: "新NPC", personality: "", role: "info" }] })}
                        style={{ padding: "7px 0", borderRadius: 7, border: "1px dashed rgba(200,160,100,0.25)", background: "transparent", color: "rgba(200,160,100,0.5)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit" }}>+ 添加NPC</button>
                    </div>
                  )}
                  {coreTab === "truth" && (
                    <textarea value={moduleCore.truth} onChange={e => setModuleCore({ ...moduleCore, truth: e.target.value })}
                      placeholder="真相与背景（可编辑）"
                      style={{ width: "100%", minHeight: 120, padding: "8px 10px", borderRadius: 7, border: "1px solid rgba(200,160,100,0.15)", background: "rgba(0,0,0,0.25)", color: "#d8cbb8", fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit", lineHeight: 1.6, resize: "vertical", outline: "none", boxSizing: "border-box" }} />
                  )}
                  {coreTab === "acts" && (
                    <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 220, overflowY: "auto" }}>
                      {moduleCore.acts.map((a, i) => (
                        <div key={i} style={{ padding: "7px 9px", borderRadius: 7, background: "rgba(0,0,0,0.2)", border: "1px solid rgba(200,160,100,0.08)" }}>
                          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 4 }}>
                            <input value={a.title} onChange={e => setModuleCore({ ...moduleCore, acts: moduleCore.acts.map((x, j) => j === i ? { ...x, title: e.target.value } : x) })}
                              style={{ flex: 1, background: "transparent", border: "none", outline: "none", color: "#e8d0a0", fontSize: "calc(11px*var(--app-text-scale,1))", fontFamily: "inherit" }} />
                            <button type="button" onClick={() => setModuleCore({ ...moduleCore, acts: moduleCore.acts.filter((_, j) => j !== i) })}
                              style={{ background: "none", border: "none", color: "rgba(255,100,80,0.5)", cursor: "pointer", fontSize: "calc(12px*var(--app-text-scale,1))", fontFamily: "inherit" }}>✕</button>
                          </div>
                          <textarea value={a.summary} onChange={e => setModuleCore({ ...moduleCore, acts: moduleCore.acts.map((x, j) => j === i ? { ...x, summary: e.target.value } : x) })}
                            style={{ width: "100%", minHeight: 56, background: "transparent", border: "none", outline: "none", color: "rgba(255,255,255,0.55)", fontSize: "calc(10px*var(--app-text-scale,1))", fontFamily: "inherit", lineHeight: 1.5, resize: "vertical" }} />
                          {a.nodes.length > 0 && <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)", marginTop: 3 }}>📍 {a.nodes.join("、")}</div>}
                        </div>
                      ))}
                      <button type="button" onClick={() => setModuleCore({ ...moduleCore, acts: [...moduleCore.acts, { index: moduleCore.acts.length, title: `第${moduleCore.acts.length + 1}幕`, summary: "", nodes: [], secrets: [], stageBrief: "" }] })}
                        style={{ padding: "7px 0", borderRadius: 7, border: "1px dashed rgba(200,160,100,0.25)", background: "transparent", color: "rgba(200,160,100,0.5)", fontSize: "calc(10px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit" }}>+ 添加一幕</button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* ── Rules edition (CoC 6th / 7th) ── */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", marginBottom: 7, letterSpacing: "0.08em" }}>
                规则版本
              </div>
              <div style={{ display: "flex", gap: 5 }}>
                {([["coc6", "COC 6版（经典）"], ["coc7", "COC 7版"]] as const).map(([val, t]) => {
                  const active = rulesEdition === val;
                  return (
                    <button key={val} className="tome-seal"
                      onClick={() => setRulesEdition(val)}
                      style={{
                        flex: 1, padding: "8px 4px", borderRadius: 6,
                        border: `1px solid ${active ? "rgba(200,160,100,0.45)" : "rgba(200,160,100,0.1)"}`,
                        background: active ? "linear-gradient(135deg, rgba(200,160,100,0.18), rgba(200,160,100,0.08))" : "rgba(0,0,0,0.3)",
                        color: active ? "#e8d0a0" : "rgba(255,255,255,0.35)",
                        fontSize: "calc(11px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit",
                        transition: "all 0.2s ease",
                      }}>
                      {t}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.25)", marginTop: 5, lineHeight: 1.5 }}>
                7版规则：技能基础值按7版、闪避=敏捷÷2、难度分级（困难÷2/极难÷5）、奖励骰/惩罚骰、幸运补值、EDU=2D6+6。仅对新世界生效，旧世界保持6版
              </div>
            </div>

            {/* ── Divider ── */}
            <div style={{ height: 1, background: "linear-gradient(90deg, transparent, rgba(200,160,100,0.15), transparent)", margin: "2px 0 14px" }} />

            {/* ── Sliders ── */}
            <div style={{ display: "flex", gap: 20, marginBottom: 18 }}>
              {([
                { label: "区域", value: regionCount, setter: setRegionCount, min: 3, max: 10 },
                { label: "NPC/怪物", value: npcCount, setter: setNpcCount, min: 0, max: 20 },
              ] as const).map(s => (
                <div key={s.label} style={{ flex: 1, opacity: moduleText.trim() ? 0.4 : 1 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
                    <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", letterSpacing: "0.08em" }}>{s.label}</span>
                    <span style={{ fontSize: "calc(13px*var(--app-text-scale,1))", color: "#e8d0a0", fontWeight: 600, fontFamily: "monospace" }}>{s.value}</span>
                  </div>
                  <input type="range" className="adv-slider"
                    min={s.min} max={s.max} value={s.value}
                    onChange={e => s.setter(Number(e.target.value))}
                    style={{ width: "100%" }} />
                </div>
              ))}
              {moduleText.trim() && (
                <div style={{ flexBasis: "100%", fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,200,100,0.55)", lineHeight: 1.5 }}>
                  📄 模组模式下由 AI 通读模组后自由决定区域与 NPC 数量（滑块仅供参考，不再强制）
                </div>
              )}
            </div>

            {/* ── Divider ── */}
            <div style={{ height: 1, background: "linear-gradient(90deg, transparent, rgba(200,160,100,0.15), transparent)", margin: "2px 0 14px" }} />

            {/* ── Character selection ── */}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(200,160,100,0.5)", marginBottom: 7, letterSpacing: "0.08em" }}>
                同行角色（可不选）
              </div>
              {characters.length === 0 ? (
                <div style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.15)", textAlign: "center", padding: "12px 0" }}>
                  还没有角色，可以先创建
                </div>
              ) : (
                <div style={{ display: "grid", gridTemplateColumns: "repeat(5, 1fr)", gap: 8 }}>
                  {characters.map(ch => {
                    const active = selectedCharIds.includes(ch.id);
                    return (
                      <button key={ch.id} className="tome-seal" onClick={() => toggleChar(ch.id)} style={{
                        padding: "8px 4px 6px", borderRadius: 8, fontFamily: "inherit",
                        border: `1px solid ${active ? "rgba(200,160,100,0.4)" : "rgba(200,160,100,0.08)"}`,
                        background: active ? "rgba(200,160,100,0.1)" : "rgba(0,0,0,0.2)",
                        cursor: "pointer", transition: "all 0.2s ease",
                        display: "flex", flexDirection: "column", alignItems: "center", gap: 5,
                      }}>
                        <div style={{ position: "relative" }}>
                          <div style={{
                            width: 36, height: 36, borderRadius: "50%",
                            background: ch.avatar ? `url(${ch.avatar}) center/cover` : "rgba(200,160,100,0.1)",
                            border: `2px solid ${active ? "rgba(200,160,100,0.5)" : "rgba(255,255,255,0.06)"}`,
                          }} />
                          {active && (
                            <div style={{
                              position: "absolute", bottom: -2, right: -2,
                              width: 14, height: 14, borderRadius: "50%",
                              background: "rgba(200,160,100,0.8)",
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: "calc(8px*var(--app-text-scale,1))", color: "#0a0a0f", fontWeight: 700,
                            }}>✓</div>
                          )}
                        </div>
                        <div style={{
                          fontSize: "calc(10px*var(--app-text-scale,1))", color: active ? "#e8d0a0" : "rgba(255,255,255,0.35)",
                          textAlign: "center", lineHeight: 1.2,
                          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                          width: "100%",
                        }}>
                          {ch.name}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* ── Error ── */}
            {error && (
              <div style={{
                fontSize: "calc(11px*var(--app-text-scale,1))", color: "rgba(255,100,80,0.8)", padding: "8px 12px",
                borderRadius: 8, background: "rgba(255,60,40,0.08)",
                border: "1px solid rgba(255,80,60,0.15)", marginBottom: 12,
              }}>
                {error}
              </div>
            )}

            {/* ── Create button (ritual activation) ── */}
            <button className="tome-ritual"
              onClick={handleCreate}
              disabled={(!description.trim() && !moduleText.trim() && !moduleCore) || isGenerating}
              style={{
                width: "100%", padding: "15px 0", borderRadius: 10,
                border: isGenerating ? "1px solid rgba(255,255,255,0.05)" : "1px solid rgba(200,160,100,0.3)",
                background: isGenerating
                  ? "rgba(255,255,255,0.03)"
                  : "linear-gradient(135deg, rgba(200,160,100,0.2), rgba(180,140,80,0.1))",
                color: isGenerating ? "rgba(255,255,255,0.25)" : "#e8d0a0",
                fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 600, letterSpacing: "0.2em",
                cursor: isGenerating ? "default" : "pointer",
                fontFamily: "inherit",
                transition: "all 0.3s ease",
              }}>
              {isGenerating ? "⏳ 世界生成中..." : selectedCharIds.length > 0 ? `✦ 携 ${selectedCharIds.length} 位同伴创造世界 ✦` : "✦ 独自创造世界 ✦"}
            </button>

            {/* ── Tome footer ornament ── */}
            <div style={{ textAlign: "center", marginTop: 12 }}>
              <div style={{ fontSize: "calc(8px*var(--app-text-scale,1))", letterSpacing: "0.5em", color: "rgba(200,160,100,0.15)", fontFamily: "monospace" }}>
                ─ ✧ ─
              </div>
            </div>
          </div>
        </>)}

        {/* ── DM Prompt Editor ── */}
        {mode === "prompts" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div style={{ ...S.card, marginBottom: 0 }}>
              <div style={{ ...S.label }}>运行参数</div>

              <div style={{ padding: "2px 0 12px", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)", marginBottom: 8, letterSpacing: "0.1em" }}>DM 上下文截断（Token）</div>
                <div style={{ display: "flex", gap: 16 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)" }}>日志</span>
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#e8d0a0", fontFamily: "monospace" }}>{dmTokenConfig.journalTokenBudget}</span>
                    </div>
                    <input type="range" className="adv-slider" min={1000} max={100000} step={500}
                      value={dmTokenConfig.journalTokenBudget}
                      onChange={e => setDmTokenConfig(prev => ({ ...prev, journalTokenBudget: Number(e.target.value) }))}
                      style={{ width: "100%" }} />
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
                      <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)" }}>对话</span>
                      <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#e8d0a0", fontFamily: "monospace" }}>{dmTokenConfig.dialogueTokenBudget}</span>
                    </div>
                    <input type="range" className="adv-slider" min={1000} max={100000} step={500}
                      value={dmTokenConfig.dialogueTokenBudget}
                      onChange={e => setDmTokenConfig(prev => ({ ...prev, dialogueTokenBudget: Number(e.target.value) }))}
                      style={{ width: "100%" }} />
                  </div>
                </div>
              </div>

              <div style={{ padding: "12px 0", borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                <div style={{ ...S.label }}>冒险自动总结</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 6 }}>
                  <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>自动总结并传入全局记忆间隔</span>
                  <span style={{ fontSize: "calc(11px*var(--app-text-scale,1))", color: "#e8d0a0", fontFamily: "monospace" }}>
                    {summaryConfig.interval === 0 ? "关闭" : `每 ${summaryConfig.interval} 条`}
                  </span>
                </div>
                <input
                  type="range"
                  className="adv-slider"
                  min={0}
                  max={100}
                  step={5}
                  value={summaryConfig.interval}
                  onChange={e => setSummaryConfig(prev => ({ ...prev, interval: Number(e.target.value) }))}
                  style={{ width: "100%" }}
                />
                <div style={{ display: "flex", justifyContent: "space-between", marginTop: 4 }}>
                  <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.25)" }}>关闭</span>
                  <span style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.25)" }}>100 条</span>
                </div>
              </div>

              <div style={{ paddingTop: 12 }}>
                <div style={{ ...S.label }}>双语翻译</div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: adventureConfig.bilingualTranslationEnabled ? 10 : 0 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>角色双语翻译</div>
                    <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)", marginTop: 3 }}>只作用于角色发言，不影响 DM / NPC / 选项 / 日志</div>
                  </div>
                  <Toggle
                    checked={adventureConfig.bilingualTranslationEnabled}
                    onChange={(checked) => setAdventureConfig(prev => ({ ...prev, bilingualTranslationEnabled: checked }))}
                  />
                </div>
                {adventureConfig.bilingualTranslationEnabled && (
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)", letterSpacing: "0.1em" }}>折叠中文译文</div>
                      <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.3)", marginTop: 3 }}>关闭后默认展开中文</div>
                    </div>
                    <Toggle
                      checked={adventureConfig.collapseBilingualTranslation === true}
                      onChange={(checked) => setAdventureConfig(prev => ({ ...prev, collapseBilingualTranslation: checked }))}
                    />
                  </div>
                )}
              </div>
            </div>

            <div style={{ ...S.label, marginBottom: -4 }}>提示词</div>

            {/* Collapsible prompt editors */}
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {promptSections.map(section => {
                const isOpen = expandedPromptTab === section.key;
                return (
                  <div
                    key={section.key}
                    style={{
                      borderRadius: 10,
                      border: `1px solid ${isOpen ? "rgba(200,160,100,0.22)" : "rgba(255,255,255,0.08)"}`,
                      background: isOpen ? "rgba(200,160,100,0.06)" : "rgba(255,255,255,0.02)",
                      overflow: "hidden",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        setEditingPromptTab(section.key);
                        setExpandedPromptTab(prev => prev === section.key ? null : section.key);
                      }}
                      aria-expanded={isOpen}
                      style={{
                        width: "100%",
                        minHeight: 44,
                        padding: "0 12px",
                        border: "none",
                        background: "transparent",
                        color: isOpen ? "#e8d0a0" : "rgba(255,255,255,0.72)",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        gap: 10,
                        cursor: "pointer",
                        fontFamily: "inherit",
                      }}
                    >
                      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: "calc(12px*var(--app-text-scale,1))" }}>
                        {section.label}
                      </span>
                      <ChevronDown
                        size={15}
                        strokeWidth={2}
                        style={{
                          flexShrink: 0,
                          color: isOpen ? "#e8d0a0" : "rgba(255,255,255,0.28)",
                          transform: isOpen ? "rotate(180deg)" : "rotate(0deg)",
                          transition: "transform 180ms ease, color 180ms ease",
                        }}
                      />
                    </button>
                    {isOpen && (
                      <div style={{ padding: "0 10px 10px" }}>
                        <div style={{ fontSize: "calc(10px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.26)", lineHeight: 1.6, padding: "8px 10px", borderRadius: 8, background: "rgba(255,255,255,0.025)", marginBottom: 8 }}>
                          {section.helper}
                        </div>
                        <textarea
                          value={section.value}
                          onChange={e => section.onChange(e.target.value)}
                          placeholder={section.placeholder}
                          style={{
                            ...S.input,
                            minHeight: section.minHeight ?? 220,
                            fontSize: "calc(12px*var(--app-text-scale,1))",
                            lineHeight: 1.5,
                            fontFamily: "monospace",
                          }}
                        />
                        <div style={{ fontSize: "calc(9px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.15)", textAlign: "center", marginTop: 6 }}>
                          当前显示的即为实际使用的提示词，可直接修改
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Save + Reset buttons */}
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => {
                saveDMPrompts(dmPrompts);
                saveDMTokenConfig(dmTokenConfig);
                saveAdventureSummaryConfig(summaryConfig);
                saveAdventureInteractionConfig(adventureConfig);
                setMode("list");
              }} style={{ ...S.primaryBtn, flex: 1 }}>
                保存
              </button>
              <button onClick={resetCurrentPrompt} style={{
                flexShrink: 0, padding: "14px 20px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.1)",
                background: "transparent", color: "rgba(255,255,255,0.4)", fontSize: "calc(12px*var(--app-text-scale,1))",
                cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
              }}>
                重置当前提示词
              </button>
            </div>
          </div>
        )}

      </div>

      {mode === "list" && (
        <button
          type="button"
          aria-label="创建冒险世界"
          onClick={() => setMode("create")}
          style={{
            position: "absolute",
            right: 22,
            bottom: "calc(28px + env(safe-area-inset-bottom, 0px))",
            zIndex: 30,
            width: 56,
            height: 56,
            borderRadius: "50%",
            border: "1px solid rgba(255,255,255,0.2)",
            background: "rgba(255,255,255,0.1)",
            color: "#fff",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 16px 38px rgba(0,0,0,0.45)",
            backdropFilter: "blur(12px)",
            cursor: "pointer",
          }}
        >
          <Plus size={24} strokeWidth={1.6} />
        </button>
      )}

      {/* Delete confirm dialog */}
      {deleteConfirmId && (
        <div onClick={() => setDeleteConfirmId(null)} style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "rgba(15,12,18,0.98)", borderRadius: 12, border: "1px solid rgba(255,100,80,0.15)", padding: 20, maxWidth: 280, width: "100%", textAlign: "center" }}>
            <div style={{ fontSize: "calc(14px*var(--app-text-scale,1))", fontWeight: 600, marginBottom: 8 }}>确认删除？</div>
            <div style={{ fontSize: "calc(12px*var(--app-text-scale,1))", color: "rgba(255,255,255,0.4)", marginBottom: 16 }}>这个世界的所有数据和存档将被永久删除</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setDeleteConfirmId(null)} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid rgba(255,255,255,0.1)", background: "transparent", color: "rgba(255,255,255,0.5)", fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit" }}>
                取消
              </button>
              <button onClick={() => handleDelete(deleteConfirmId)} style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "rgba(255,80,60,0.2)", color: "rgba(255,100,80,0.9)", fontSize: "calc(13px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit" }}>
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── World-gen failure dialog (reason + raw LLM output, adventure-styled) ── */}
      {genError && (
        <div className="modal-overlay" data-ui="modal" onClick={() => setGenError(null)}>
          <div
            onClick={e => e.stopPropagation()}
            style={{
              width: "100%", maxWidth: 440, maxHeight: "78%", display: "flex", flexDirection: "column",
              background: "var(--c-adv-panel-bg)", border: "1px solid var(--c-adv-accent-dim)",
              borderRadius: 14, boxShadow: "0 16px 48px rgba(0,0,0,0.55)", overflow: "hidden",
            }}
          >
            <div style={{ padding: "16px 18px 12px", borderBottom: "1px solid var(--c-adv-accent-dim)" }}>
              <div style={{ color: "var(--c-adv-accent)", fontSize: "calc(15px*var(--app-text-scale,1))", fontWeight: 600, letterSpacing: "0.04em" }}>⚠ 世界生成失败</div>
              <div style={{ color: "var(--c-adv-text-dim)", fontSize: "calc(12px*var(--app-text-scale,1))", marginTop: 6, lineHeight: 1.6 }}>{genError.reason}</div>
            </div>
            {genError.raw ? (
              <div style={{ padding: "12px 18px", overflowY: "auto", flex: 1, minHeight: 0 }}>
                <div style={{ color: "var(--c-adv-text-muted)", fontSize: "calc(10px*var(--app-text-scale,1))", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 6 }}>AI 原始输出</div>
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "var(--c-adv-text)", fontSize: "calc(11px*var(--app-text-scale,1))", lineHeight: 1.65, fontFamily: '"Courier New", monospace', background: "rgba(0,0,0,0.35)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8, padding: "10px 12px" }}>{genError.raw}</pre>
              </div>
            ) : (
              <div style={{ padding: "14px 18px", color: "var(--c-adv-text-muted)", fontSize: "calc(11px*var(--app-text-scale,1))", flex: 1 }}>（模型没有返回任何内容，可能是网络中断或请求超时）</div>
            )}
            <div style={{ display: "flex", gap: 10, padding: "12px 18px 16px", borderTop: "1px solid var(--c-adv-accent-dim)" }}>
              {genError.raw && (
                <button
                  type="button"
                  onClick={() => { navigator.clipboard?.writeText(genError.raw).catch(() => {}); }}
                  style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "1px solid var(--c-adv-accent-dim)", background: "transparent", color: "var(--c-adv-accent)", fontSize: "calc(12.5px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit" }}
                >
                  复制原始输出
                </button>
              )}
              <button
                type="button"
                onClick={() => setGenError(null)}
                style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: "none", background: "var(--c-adv-accent-dim)", color: "var(--c-adv-accent)", fontSize: "calc(12.5px*var(--app-text-scale,1))", cursor: "pointer", fontFamily: "inherit", fontWeight: 600 }}
              >
                知道了
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
