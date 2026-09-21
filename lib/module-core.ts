// lib/module-core.ts
// Fork 九期: sectioned import — chunked extraction pipeline + code-only skeleton assembly.
// Solves: one-shot world-gen LLM pressure (retry costs everything) + large-module import limits.

import type { ApiConfig } from "./settings-types";
import { simpleLLMCall } from "./api-helpers";
import type { ModuleCore, ModuleAct, WorldSkeleton, RichRegion, WorldNPC, QuestLine, EncounterSeed, InvestigatorLine } from "./map-types";
import type { DMDossier } from "./map-types";

// ── Chunking ──

/** Split long text into ~size-char chunks at paragraph boundaries. */
export function chunkText(text: string, size = 8000): string[] {
  const clean = (text || "").replace(/\r/g, "").trim();
  if (!clean) return [];
  if (clean.length <= size) return [clean];
  const paras = clean.split(/\n{2,}/);
  const chunks: string[] = [];
  let buf = "";
  for (const p of paras) {
    if ((buf + "\n\n" + p).length > size && buf) { chunks.push(buf); buf = p; }
    else buf = buf ? `${buf}\n\n${p}` : p;
  }
  if (buf) chunks.push(buf);
  // Merge tiny trailing chunk
  if (chunks.length > 1 && chunks[chunks.length - 1].length < size * 0.2) {
    const last = chunks.pop()!;
    chunks[chunks.length - 1] += `\n\n${last}`;
  }
  return chunks;
}

// ── Tagged-block parsing (same style as worldGen) ──

function parseTagged(text: string): { sections: Record<string, string[]>; fields: Record<string, string> } {
  const src = text.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
  const fields: Record<string, string> = {};
  const sections: Record<string, string[]> = {};
  let curKey = "";
  let curSection = "";
  let buf: string[] = [];
  const flushField = () => { if (curKey) fields[curKey] = buf.join("\n").trim(); curKey = ""; buf = []; };
  const flushSection = () => { flushField(); if (curSection) sections[curSection] = sections[curSection] || []; };
  for (const raw of src.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const sec = line.match(/^#\s*(.+)$/);
    if (sec) { flushSection(); curSection = sec[1].trim(); continue; }
    const m = line.match(/^\[([^\]]+)\]\s*(.*)$/);
    if (m) { flushField(); curKey = m[1].trim(); buf = [m[2] ?? ""]; continue; }
    if (curKey) buf.push(line);
  }
  flushField();
  return { sections, fields };
}

// ── Extraction prompts (per section, tagged output) ──

const NPC_EXTRACT_PROMPT = `你是TRPG模组的资料整理员。从给定文本中提取所有NPC/人物/怪物信息。只输出标签块纯文本，不要JSON、不要多余解释。

格式（每个NPC一组，顺序编号）：
[NPC名]人名（没有名字的用身份称呼，如"胖店主"）
[NPC描写]2-4句：外貌、性格、说话方式、可疑之处（文本里有什么写什么，不要编造）
[NPC身份]info/quest/merchant/ambient/rival/creature 之一（creature=怪物/异象）
[NPC位置]TA出现或常驻的地点（文本提到才写，没有就留空）

要求：文本里的每个有名有姓的人物都要提取，包括看起来不重要的；同一个人只提取一次；纯背景提及的历史人物也提取（notes里注明"历史人物"）。文本若按"调查员车卡/主要NPC/次要NPC/怪物"等分区组织，主要NPC/次要NPC/怪物分区的所有人物都要逐一提取，一个都不能漏——宁可多提不可漏提。

【调查员除外·重要】玩家角色（HO/调查员/PC，文本常标注为"HO1车卡""调查员人物卡"等）不是NPC——他们是玩家扮演的角色，由系统另行导入。凡在车卡/调查员分区、或明显是玩家角色介绍（含属性表、技能表、背景故事）的人物一律不要提取。若拿不准某人是NPC还是调查员：有属性/技能数值表或标注HO/PC的就是调查员（跳过），其余照常提取。`;

const TRUTH_EXTRACT_PROMPT = `你是TRPG模组的资料整理员。从给定文本中提取故事的核心真相与背景设定。只输出标签块纯文本，不要JSON。

格式：
[隐藏真相]这个故事的底牌是什么（2-4句）
[背景设定]时代、地点、世界观的必要背景（2-4句）
[NPC秘密1]某NPC名：TA隐瞒的事（有几条写几条，编号递增）
[伏笔1]早期应当埋下的线索（有几条写几条，编号递增）
[反转]故事中段的关键转折（文本有才写）
[结局]故事可能如何收束（文本有才写）

要求：忠实于文本，文本没写的不要编造；秘密/伏笔保留具体细节（数字、日期、物品名）。`;

const ACT_EXTRACT_PROMPT = `你是TRPG模组的资料整理员。从给定文本中提取跑团流程/剧情结构，分割为几幕。只输出标签块纯文本，不要JSON。

格式（每幕一组，从1编号）：
[幕N标题]这一幕的名字（2-6字）
[幕N剧情]这一幕发生什么、调查员要做什么、真相推进到哪一步（3-5句，KP视角）
[幕N地点]涉及的地点，顿号分隔（只写文本明确提到的）
[幕N线索]这一幕应揭示的关键信息/线索（有几条写几条，编号递增）

要求：如果文本已经明确分章/分幕/分阶段，严格按它的结构；如果没有，按剧情推进逻辑分成3-5幕；每幕的剧情必须与前后幕衔接（后幕依赖前幕的发现）。`;

// ── Investigator private lines (fork: HO导入剧情/个人线 → 密档) ──

const HO_LINE_EXTRACT_PROMPT = `你是TRPG模组的资料整理员。文本里包含若干调查员（HO）各自的导入剧情与个人线事件——这些是每个HO的私人密档，其他调查员不知道。请按HO分组提取。

只输出标签块纯文本，不要JSON：
[HO]HO代号（如HO1、HO2；用文本里的代号；若文本用真名称呼调查员，写"代号（真名）"）
[职业]车卡给这个HO规定的职业（如搞笑艺人、记者、医生；秘密团常要求固定职业，务必照抄原文；文本没写职业才留空）
[导入剧情]TA入团前的故事摘要（3-6句：TA与哪些NPC是什么关系、发生了什么关键事件、有什么约定或承诺——这些是TA的既定背景。车卡里的人物设定/性格/背景故事也并入这里概述）
[关系1]NPC名：关系描述（每个相关NPC一组，编号递增；只写该HO的私人关系）
[事件1]触发条件|事件摘要（格式：Day1夜晚/见到尤金之后/XX死后 等触发时机 | 3-8句事件内容——TA会经历什么、NPC会对TA说什么/做什么、可能的选项与分支）
（事件有几条写几条，编号递增）

要求：
- 忠实于文本，禁止编造；文本没有的HO不要列
- 每个HO单独一组、完整输出（[HO]→[导入剧情]→[关系]→[事件]），不要把多个HO的内容写进同一组；文本里有几个HO就输出几组
- 文本里的调查员车卡（属性/技能/背景故事/人物设定）就属于HO材料——车卡内容并入该HO的[导入剧情]，不要丢弃
- 事件摘要要保留原文的关键台词感（如NPC的语气、态度转变点）
- 区分"导入剧情"（入团前）与"个人线事件"（入团后按条件触发）`;

export type ExtractProgress = { step: string; done: number; total: number };

/** Flatten numbered tagged fields back to a name→value map (NPC名3 → key "NPC名3"). */
function taggedToFieldMap(text: string): Record<string, string> {
  const { fields } = parseTagged(text);
  return fields;
}

/** Fork fix: split tagged output into blocks at every occurrence of a repeating key
 *  (each [NPC名] / [HO] line starts a new block). When the LLM ignores numbering and
 *  reuses the same label, the flat field map overwrites earlier entries — keeping only
 *  ONE npc/HO. Block-splitting recovers every occurrence. Returns one field-map per block. */
function taggedBlocksBy(text: string, blockKey: string): Record<string, string>[] {
  const src = text.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").trim();
  const marker = new RegExp("^\\[" + blockKey + "\\d*\\]\\s*(.*)$");
  const lines = src.split("\n");
  const starts: number[] = [];
  lines.forEach((raw, i) => {
    if (raw.replace(/\s+$/, "").match(marker)) starts.push(i);
  });
  if (starts.length <= 1) return [taggedToFieldMap(src)];
  const blocks: string[][] = [];
  for (let b = 0; b < starts.length; b++) {
    blocks.push(lines.slice(starts[b], b + 1 < starts.length ? starts[b + 1] : lines.length));
  }
  return blocks.map(bl => taggedToFieldMap(bl.join("\n")));
}

export async function extractNpcsFromText(
  text: string,
  apiConfig: ApiConfig,
  existingNames: string[],
  onProgress?: (p: ExtractProgress) => void,
): Promise<ModuleCore["npcs"]> {
  const chunks = chunkText(text);
  const all: ModuleCore["npcs"] = [];
  const seen = new Set(existingNames);
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ step: `NPC提取 ${i + 1}/${chunks.length}`, done: i, total: chunks.length });
    const prevNote = all.length ? `（已有NPC：${[...seen].slice(0, 30).join("、")}——重复的不要再提取）` : "";
    const result = await simpleLLMCall(apiConfig, [
      { role: "system", content: NPC_EXTRACT_PROMPT + prevNote },
      { role: "user", content: `模组文本（第${i + 1}/${chunks.length}部分）：\n${chunks[i]}` },
    ]);
    if (!result.content) continue;
    // Fork fix: block-split by [NPC名] — recovers every NPC even when the LLM reuses the
    // same label without numbering (flat map would keep only the last one)
    const blocks = taggedBlocksBy(result.content, "NPC名");
    for (const f of blocks) {
      const names = Object.keys(f).filter(k => /^NPC名\d*$/.test(k));
      for (const nk of names) {
        const n = nk.replace(/^NPC名/, "");
        const name = f[nk]; const desc = f[`NPC描写${n}`] || ""; const role = f[`NPC身份${n}`] || "info"; const loc = f[`NPC位置${n}`] || "";
        if (!name || seen.has(name)) continue;
        seen.add(name);
        all.push({
          name,
          personality: desc || "（描写缺失）",
          role: (["info", "quest", "merchant", "ambient", "rival", "creature"].includes(role) ? role : "info") as ModuleCore["npcs"][number]["role"],
          location: loc || undefined,
        });
      }
    }
  }
  return all;
}

export async function extractTruthFromText(
  text: string,
  apiConfig: ApiConfig,
  onProgress?: (p: ExtractProgress) => void,
): Promise<{ truth: string; dossier: Partial<DMDossier> }> {
  const chunks = chunkText(text);
  const parts: string[] = [];
  const npcSecrets: Record<string, string> = {};
  const foreshadowing: string[] = [];
  let hidden = ""; let bg = ""; let twist = ""; let endgame = "";
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ step: `真相提取 ${i + 1}/${chunks.length}`, done: i, total: chunks.length });
    const result = await simpleLLMCall(apiConfig, [
      { role: "system", content: TRUTH_EXTRACT_PROMPT },
      { role: "user", content: `模组文本（第${i + 1}/${chunks.length}部分）：\n${chunks[i]}` },
    ]);
    if (!result.content) continue;
    const f = taggedToFieldMap(result.content);
    if (f["隐藏真相"] && !hidden) hidden = f["隐藏真相"];
    if (f["背景设定"]) parts.push(f["背景设定"]);
    if (f["反转"] && !twist) twist = f["反转"];
    if (f["结局"] && !endgame) endgame = f["结局"];
    for (const [k, v] of Object.entries(f)) {
      const sm = k.match(/^NPC秘密\d*$/);
      if (sm && v) {
        const [nm, ...rest] = v.split(/[：:]/);
        if (nm?.trim() && rest.length) npcSecrets[nm.trim()] = rest.join("：").trim();
      }
      if (/^伏笔\d*$/.test(k) && v) foreshadowing.push(v);
    }
  }
  return {
    truth: [hidden, ...parts].filter(Boolean).join("\n\n"),
    dossier: { hiddenTruth: hidden || "（未提取到明确真相）", npcSecrets, foreshadowing, plotTwist: twist, endgame },
  };
}

export async function extractActsFromText(
  text: string,
  apiConfig: ApiConfig,
  onProgress?: (p: ExtractProgress) => void,
): Promise<ModuleAct[]> {
  const result = await simpleLLMCall(apiConfig, [
    { role: "system", content: ACT_EXTRACT_PROMPT },
    { role: "user", content: `模组文本：\n${text}` },
  ]);
  onProgress?.({ step: "流程提取", done: 1, total: 1 });
  if (!result.content) return [];
  const f = taggedToFieldMap(result.content);
  const nums = [...new Set(Object.keys(f).map(k => k.match(/^幕(\d+)标题$/)?.[1]).filter(Boolean) as string[])].sort((a, b) => Number(a) - Number(b));
  const acts: ModuleAct[] = nums.map((n, i) => ({
    index: i,
    title: f[`幕${n}标题`] || `第${i + 1}幕`,
    summary: f[`幕${n}剧情`] || "",
    nodes: (f[`幕${n}地点`] || "").split(/[,，、;；\s]+/).map(s => s.trim()).filter(Boolean),
    secrets: (f[`幕${n}线索`] || "").split(/\n|；(?![^（]*）)/).map(s => s.trim()).filter(Boolean),
    stageBrief: f[`幕${n}剧情`]?.slice(0, 60) || "",
  })).filter(a => a.summary || a.nodes.length);
  return acts;
}

// ── Investigator private lines: extraction (fork) ──

export async function extractInvestigatorLines(
  text: string,
  apiConfig: ApiConfig,
  onProgress?: (p: ExtractProgress) => void,
): Promise<InvestigatorLine[]> {
  const chunks = chunkText(text, 8000);
  const all: InvestigatorLine[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.({ step: `HO剧情提取 ${i + 1}/${chunks.length}`, done: i, total: chunks.length });
    const prevNote = all.length ? `（已提取的HO：${all.map(l => l.ho).join("、")}——已列过的HO若在新文本有补充事件可合并，不要重复其导入剧情）` : "";
    const result = await simpleLLMCall(apiConfig, [
      { role: "system", content: HO_LINE_EXTRACT_PROMPT + prevNote },
      { role: "user", content: `模组文本（第${i + 1}/${chunks.length}部分）：\n${chunks[i]}` },
    ]);
    if (!result.content) continue;
    // Fork fix: block-split by [HO] — each HO's group stays together even when the LLM
    // reuses the plain [HO] label without numbering (flat map kept only the last HO)
    const blocks = taggedBlocksBy(result.content, "HO");
    for (const f of blocks) {
      const hoKeys = Object.keys(f).filter(k => /^HO\d*$/.test(k));
      for (const hk of hoKeys) {
        const ho = (f[hk] || "").trim();
        if (!ho) continue;
        const intro = f["导入剧情"] || "";
        const occupation = (f["职业"] || "").trim() || undefined;
        const relations = Object.keys(f)
          .filter(k => /^关系\d*$/.test(k))
          .map(k => f[k] || "")
          .filter(Boolean)
          .map(r => {
            const m = r.match(/^(.+?)[:：]\s*(.+)$/);
            return m ? { npc: m[1].trim(), relation: m[2].trim() } : { npc: r.slice(0, 20), relation: r };
          });
        const events = Object.keys(f)
          .filter(k => /^事件\d*$/.test(k))
          .map(k => f[k] || "")
          .filter(Boolean)
          .map(e => {
            const idx = e.indexOf("|");
            return idx > 0 ? { trigger: e.slice(0, idx).trim(), summary: e.slice(idx + 1).trim() } : { trigger: "", summary: e };
          });
        const existing = all.find(l => l.ho === ho);
        if (existing) {
          if (!existing.introStory && intro) existing.introStory = intro;
          if (!existing.occupation && occupation) existing.occupation = occupation;
          existing.relations.push(...relations.filter(r => !existing.relations.some(x => x.npc === r.npc)));
          existing.events.push(...events);
        } else if (intro || relations.length || events.length) {
          all.push({ ho, introStory: intro, relations, events, ...(occupation ? { occupation } : {}) });
        }
      }
    }
  }
  return all;
}

// ── Code-only assembly (no LLM) ──

const REGION_TYPES = ["主城", "城镇", "荒野", "废墟", "禁区"];

/** Fork fix: normalize a location name — strip trailing numbering and parenthetical
 *  suffixes so "旅馆2/旅馆（二层）/旅馆 3" all merge into "旅馆". Modules revisit the
 *  same places; each mention must NOT become a separate map node. */
function normalizeLocName(raw: string): string {
  let s = (raw || "").trim();
  s = s.replace(/[（(][^）)]*[）)]+$/g, "");          // trailing (…) / （…）
  s = s.replace(/[\s\-—_·]*(?:\d+|[一二三四五六七八九十]+)[\s]*$/g, "");  // trailing 2 / 二
  return s.trim();
}

/** Assemble a full WorldSkeleton from a reviewed ModuleCore. Pure code — deterministic, free, instant. */
export function assembleSkeletonFromCore(core: ModuleCore, worldName: string): WorldSkeleton {
  // 1. Group locations into regions (~4 nodes per region), tagging L1 by first-of-region or explicit hint
  // Fork fix: merge same-place variants first (旅馆/旅馆2/旅馆（二层） → 旅馆)
  const mergeVariants = (list: ModuleCore["locations"]) => {
    const byKey = new Map<string, ModuleCore["locations"][number]>();
    for (const l of list) {
      const key = normalizeLocName(l.name);
      if (!key) continue;
      const existing = byKey.get(key);
      if (!existing) byKey.set(key, { ...l, name: key });
      else {
        if (existing.type !== "l1" && l.type === "l1") existing.type = "l1";
        if (l.regionHint && !existing.regionHint) existing.regionHint = l.regionHint;
      }
    }
    return [...byKey.values()];
  };
  const locs = core.locations.length ? mergeVariants(core.locations) : mergeVariants(deriveLocationsFromNpcs(core));
  // Fork fix: acts' node names must follow the same merge (main-quest stage hints point at nodes by name)
  const actsNorm = core.acts.map(a => ({ ...a, nodes: a.nodes.map(nd => normalizeLocName(nd)).filter(Boolean) }));
  const npcNorm = core.npcs.map(n => n.location ? { ...n, location: normalizeLocName(n.location) } : n);
  core = { ...core, acts: actsNorm, npcs: npcNorm };
  const regions: RichRegion[] = [];
  const GEO = ["plains", "mountainous", "canyon"] as const;
  const perRegion = 4;
  for (let i = 0; i < Math.max(1, Math.ceil(locs.length / perRegion)); i++) {
    const slice = locs.slice(i * perRegion, (i + 1) * perRegion);
    const regionName = slice.find(l => l.type === "l1")?.regionHint || slice[0]?.regionHint || `区域${i + 1}`;
    const l1 = slice.find(l => l.type === "l1") || slice[0];
    regions.push({
      id: `region_${i}`,
      l1_name_cn: l1?.name || `区域${i + 1}`,
      l1_name_en: "",
      geography: GEO[i % GEO.length] as RichRegion["geography"],
      river_count: 0,
      adjacent_to: i > 0 ? [`region_${i - 1}`] : [],
      l2_nodes: slice.filter(l => l.type !== "l1").map(l => ({ name: l.name, npc: findNpcAt(core, l)?.name ? { name: findNpcAt(core, l)!.name, personality: findNpcAt(core, l)!.personality, role: findNpcAt(core, l)!.role as "info" } : undefined })),
      l3_nodes: [],
    });
    void regionName;
  }
  // Ensure adjacency symmetric
  for (let i = 1; i < regions.length; i++) regions[i - 1].adjacent_to = [...new Set([...(regions[i - 1].adjacent_to || []), regions[i].id])];

  // 2. NPCs
  const npcs: WorldNPC[] = core.npcs.map((n, i) => ({
    id: `npc_${i}`,
    name: n.name,
    personality: n.personality,
    locationRegion: regions.find(r => r.l2_nodes.some(nd => nd.npc?.name === n.name) || r.l1_name_cn === n.location)?.id || regions[0]?.id || "region_0",
    locationNode: n.location || undefined,
    role: (n.role || "info") as WorldNPC["role"],
    relatedQuestIds: [],
  }));

  // 3. Main quest from acts (or single-stage fallback)
  const acts: ModuleAct[] = core.acts.length ? core.acts : [{
    index: 0, title: "调查", summary: core.truth.slice(0, 200), nodes: locs.slice(0, 1).map(l => l.name), secrets: [], stageBrief: "查明真相",
  }];
  const mainQuest: QuestLine = {
    id: "mq",
    title: acts[0].title || worldName,
    type: "main",
    synopsis: acts.map(a => a.summary.slice(0, 40)).join(" → ") || core.truth.slice(0, 80),
    triggerRegion: regions[0]?.id || "region_0",
    stages: acts.map((a, i) => ({
      locationHint: a.nodes[0] || regions[Math.min(i, regions.length - 1)]?.l1_name_cn || "",
      brief: a.stageBrief || a.summary.slice(0, 60),
      unlockHint: acts[i + 1] ? `进入「${acts[i + 1].title}」` : undefined,
    })),
  };

  // 4. Dossier from truth
  const dossier: DMDossier = {
    hiddenTruth: core.truth.slice(0, 600) || "（无）",
    npcSecrets: {},
    foreshadowing: acts.flatMap(a => a.secrets).slice(0, 6),
    plotTwist: "",
    endgame: "",
  };

  return {
    world: { name: worldName, lore: (core.rawImported?.truthText || "").slice(0, 300) || dossier.hiddenTruth, rulesEdition: "coc6" },
    mapInput: {
      map_settings: { header: "", title: worldName },
      regions: regions.map(r => ({
        id: r.id, l1_name_cn: r.l1_name_cn, l1_name_en: r.l1_name_en || "",
        geography: r.geography, river_count: r.river_count, adjacent_to: r.adjacent_to,
        l2_nodes: r.l2_nodes.map(n => n.name), l3_nodes: [],
      })),
    },
    richRegions: regions,
    mainQuest,
    sideQuests: [],
    npcs,
    encounterPool: [] as EncounterSeed[],
    partyStats: {},
    dmDossier: dossier,
    acts,
  };
}

function findNpcAt(core: ModuleCore, loc: ModuleCore["locations"][number]) {
  return core.npcs.find(n => n.location && (n.location === loc.name || n.location.includes(loc.name) || loc.name.includes(n.location)));
}

function deriveLocationsFromNpcs(core: ModuleCore): ModuleCore["locations"][number][] {
  const set = new Map<string, ModuleCore["locations"][number]>();
  for (const n of core.npcs) {
    if (n.location && !set.has(n.location)) set.set(n.location, { name: n.location, type: set.size === 0 ? "l1" : "l2" });
  }
  // NPC-less locations from acts
  for (const a of core.acts) for (const nd of a.nodes) {
    if (!set.has(nd)) set.set(nd, { name: nd, type: "l2" });
  }
  return [...set.values()];
}
