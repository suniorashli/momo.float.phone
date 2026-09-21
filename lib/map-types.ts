// lib/map-types.ts
// RPG Map Mode — all type definitions

// ── Character Stats (CoC 6th Edition) ──
// 8 base attributes rolled 3D6 / 2D6+6 / 3D6+3, stored ×5 as percentages (15-105).
// san = SAN, starts at POW×5. lck = Luck, independent 3D6×5 roll (not derived from POW).
export type StatKey = "str" | "con" | "pow" | "dex" | "app" | "siz" | "int" | "edu" | "san" | "lck";
export type CharStats = Record<StatKey, number>;
export const STAT_LABELS: Record<StatKey, string> = {
  str: "力量", con: "体质", pow: "意志", dex: "敏捷", app: "外貌", siz: "体型", int: "智力", edu: "教育", san: "理智", lck: "幸运",
};
export const ALL_STATS: StatKey[] = ["str", "con", "pow", "dex", "app", "siz", "int", "edu", "san", "lck"];
/** Base attributes used for CoC6 character creation rolls (san/lck are handled separately). */
export const BASE_STATS: StatKey[] = ["str", "con", "pow", "dex", "app", "siz", "int", "edu"];
/** Skill → attribute approximation: CoC6 checks are mostly skill checks; the DM may name a
 *  skill in stat_check. We map common CoC6 skills onto the 10 attributes so rolls stay
 *  meaningful, falling back to INT-flavoured attributes when unknown. */
export const SKILL_STAT_HINT: Record<string, StatKey> = {
  侦查: "int", 聆听: "dex", 潜行: "dex", 攀爬: "dex", 游泳: "str", 跳跃: "dex",
  图书馆使用: "int", 历史: "edu", 医学: "edu", 法律: "edu", 考古学: "edu", 神秘学: "edu",
  人类学: "edu", 会计: "edu", 博物学: "edu", 精神分析: "pow", 话术: "app", 说服: "app",
  议价: "app", 信用评级: "app", 心理学: "pow", 急救: "int", 锁匠: "dex", 妙手: "dex",
  伪装: "app", 闪避: "dex", 投掷: "dex", 驾驶: "dex", 骑术: "dex", 射击: "dex",
  拳击: "str", 擒抱: "str", 追踪: "int", 导航: "int", 母语: "edu", 外语: "edu",
  电气维修: "edu", 机械维修: "edu", 摄影: "dex", 生存: "con", 艺术: "app", 手艺: "dex",
};
/** CoC6 damage bonus table: STR+SIZ sum → DB string. */
export function lookupDB(sum: number): string {
  if (sum <= 12) return "-1D6";
  if (sum <= 16) return "-1D4";
  if (sum <= 24) return "0";
  if (sum <= 32) return "+1D4";
  if (sum <= 40) return "+1D6";
  if (sum <= 48) return "+2D6";
  if (sum <= 56) return "+3D6";
  if (sum <= 64) return "+4D6";
  if (sum <= 72) return "+5D6";
  if (sum <= 80) return "+6D6";
  if (sum <= 88) return "+7D6";
  if (sum <= 96) return "+8D6";
  return "+9D6";
}
/** Derived combat values from CoC6 base attributes (percent scale). */
export type DerivedStats = {
  hp: number;      // ceil((CON + SIZ) / 2), from raw values
  mp: number;      // floor(POW / 5)
  mov: number;     // 8 (base)
  db: string;      // damage bonus by STR+SIZ
};

// ── Node Content (NPC + quest + encounter bound to specific node) ──
export type NodeContent = {
  name: string;
  npc?: { name: string; personality: string; role: string };
  quest?: { id: string; title: string; brief: string };
  encounter?: { id: string; brief: string; mood: string };
};

// ── World Generation Input (sent to map engine for rendering) ──
export type MapRegionInput = {
  id: string;
  l1_name_cn: string;
  l1_name_en: string;
  geography: "mountainous" | "plains" | "canyon";
  river_count: number;
  adjacent_to: string[];
  l2_nodes: string[];  // name-only for map engine
  l3_nodes: string[];  // name-only for map engine
};

export type WorldSkeletonInput = {
  map_settings: { header: string; title: string };
  regions: MapRegionInput[];
  seed?: number;
};

// ── Rich Region Data (LLM output — nodes with content) ──
export type RichRegion = {
  id: string;
  l1_name_cn: string;
  l1_name_en: string;
  geography: "mountainous" | "plains" | "canyon";
  river_count: number;
  adjacent_to: string[];
  l1_npc?: { name: string; personality: string; role: string };
  l1_quest?: { id: string; title: string; brief: string };
  l2_nodes: NodeContent[];
  l3_nodes: NodeContent[];
};

// ── World Skeleton (LLM output) ──
export type QuestStage = {
  locationHint: string;       // specific node name
  brief: string;
  unlockHint?: string;
};

export type QuestLine = {
  id: string;
  title: string;
  type: "main" | "side";
  synopsis: string;
  triggerRegion: string;
  stages: QuestStage[];
};

// Legacy types kept for compatibility
export type WorldNPC = {
  id: string;
  name: string;
  personality: string;
  locationRegion: string;
  locationNode?: string;      // specific node name
  role: "quest" | "merchant" | "info" | "ambient" | "rival" | "creature";
  relatedQuestIds: string[];
};

export type EncounterSeed = {
  id: string;
  brief: string;
  mood: "tense" | "warm" | "mysterious" | "humorous" | "romantic" | "dread" | "eerie" | "uncanny";
  locationTypes: string[];
  locationNode?: string;      // specific node name
};

export type RulesEdition = "coc6" | "coc7";

// ── Personal secrets (secret-party mode, fork 八期A) ──
export type PersonalSecret = {
  content: string;      // 秘密内容（持有者视角，生成后分配给某位调查员）
  link: string;         // 与主线真相的咬合点
  informant?: string;   // 知情 NPC —— 持有者可私下问出更多
};

export type WorldSkeleton = {
  world: {
    name: string;
    lore: string;
    rulesEdition?: RulesEdition;   // fork: 6th/7th edition (default coc6 for old worlds)
  };
  mapInput: WorldSkeletonInput;
  richRegions: RichRegion[];     // full node content (NPC/quest/encounter per node)
  mainQuest: QuestLine;
  sideQuests: QuestLine[];
  npcs: WorldNPC[];
  encounterPool: EncounterSeed[];
  partyStats: Record<string, CharStats>;
  dmDossier?: DMDossier;
  personalSecrets?: PersonalSecret[];  // fork 八期A: per-investigator secrets (assigned at save creation)
  acts?: ModuleAct[];                  // fork 九期B: staged truth reveal (assembled from module acts)
};

export type ModuleAct = {
  index: number;
  title: string;
  summary: string;        // KP 视角的幕剧情（真相切片）
  nodes: string[];        // 涉及节点名
  secrets: string[];      // 本幕相关秘密/线索
  stageBrief: string;     // 主线阶段简介（映射到 mainQuest stage）
};

// ── Investigator private lines (fork: HO 导入剧情/个人线密档 — only the HO themself and the KP know) ──
export type InvestigatorLineEvent = { trigger: string; summary: string };   // trigger 如 "Day1夜晚"/"尤金死后"
export type InvestigatorLine = {
  ho: string;                                    // HO 代号或名字（HO1 等）
  introStory: string;                            // 导入剧情摘要（关键事实：认识谁、什么关系、约定）
  relations: { npc: string; relation: string }[]; // 与 NPC 的私人关系
  events: InvestigatorLineEvent[];               // 个人线事件（按天/条件触发，KP 演出）
  occupation?: string;                           // fork: 车卡要求的职业（秘密团固定职业，如"搞笑艺人"）——导入身份卡时必须采用
  boundCharacterId?: string;                     // 绑定角色卡 id；"__player__" = 玩家本人；空 = 未绑定
};

// ── Module core pack (fork 九期: sectioned import → review → share; 十二期: export/import) ──
export type ModuleCore = {
  npcs: { name: string; personality: string; role: string; location?: string }[];
  locations: { name: string; type?: string; regionHint?: string }[];
  truth: string;
  acts: ModuleAct[];
  rawImported?: { npcText: string; truthText: string; actText: string };  // 分栏原文（重提取用）
  stageAssets?: { kind: "portrait" | "cg" | "bgm"; name: string; boundTo?: string; fileName: string; note?: string; dataBase64: string; mime: string }[];  // fork: 演出资源随包分享（base64 内嵌，导入时写入 IndexedDB）
  investigatorLines?: InvestigatorLine[];   // fork: HO 导入剧情/个人线（密档，随包分享）
};

// ── Investigator import (fork 十一期: persona adapted to the module era/setting) ──
export type InvestigatorPersona = {
  name: string;           // 名字（保留原名或时代化别名）
  era: string;            // 时代（如「1920年代新英格兰」）
  occupation: string;     // 时代化职业显示名（捕快/私家侦探/神学生）
  refOccupation?: string; // 技能模板参考职业（映射 OCCUPATIONS 表，用于掷骰技能组）
  background: string;     // 身份背景（这个时代的身份、来此缘由，2-4句）
  keepTraits: string;     // 性格保持（角色卡核心性格不变的部分）
  changes: string;        // 时代适配调整（警察→捕快之类的说明）
  hooks: string;          // 与模组/秘密的连接点
  cardReaction?: string;  // fork: 拿到身份卡那一刻的第一人称反应（KP发卡演出的台词）
  confirmed?: boolean;    // fork 十二期: 玩家人设已审校确认（首次进入世界时过目）
};

// ── Stage assets (fork 十期: portraits / CG / BGM — images never enter prompts, KP only "calls the cue") ──
export type StageAsset = {
  id: string;
  kind: "portrait" | "cg" | "bgm";
  name: string;            // 资源名（KP 清单里的名字，语义化命名很重要）
  boundTo?: string;        // portrait: 绑定的 NPC 名；cg/bgm 可空
  fileName: string;
  note?: string;           // 什么时候用（给 KP 的提示，可选）
};

// ── DM (Dungeon Master) System ──

/** DM's secret knowledge — the full truth behind the world */
export type DMDossier = {
  hiddenTruth: string;           // the big secret/twist of the main quest
  npcSecrets: Record<string, string>;  // npcId → their hidden agenda/secret
  foreshadowing: string[];       // clues to plant early
  plotTwist: string;             // what happens at the midpoint
  endgame: string;               // how the story can end
};

/** The living state of the story — grows as events happen */
export type StoryDirector = {
  // Main quest progress
  mainArc: {
    currentStage: number;
    stageResults: { stage: number; outcome: string; itemsGained: string[]; npcsInvolved: string[] }[];
  };
  // Side quest progress
  sideArcResults: Record<string, { status: "active" | "completed" | "failed"; outcome: string }>;
  // Accumulated state
  keyItems: string[];            // items/info the player has collected
  keyNpcsMet: string[];          // important NPCs the player has interacted with
  worldChanges: string[];        // things the player's actions have changed in the world
  // Narrative memory
  plantedClues: string[];        // foreshadowing clues that have been delivered
  unrevealedSecrets: string[];   // secrets not yet discovered
};

// ── Rendered Map Data (from map-engine.ts) ──
// Re-export from map-engine
export type { MapGenerationOutput } from "./map-engine";

// ── Game State ──
export type NodeInteraction = {
  type: "quest" | "sidequest" | "encounter" | "search" | "rest" | "shop" | "talk";
  label: string;
  questId?: string;
  available: boolean;
  icon: string;
};

export type JournalEntry = {
  id: string;
  timestamp: string;     // game time
  realTime: string;      // real timestamp
  locationName: string;
  text: string;
  type: "main" | "side" | "encounter" | "discovery" | "choice";
};

export type GameSave = {
  id: string;
  worldId: string;
  timestamp: string;

  // User (player) state
  currentNodeId: string;
  currentNodeType: "l1" | "l2" | "l3";
  discoveredNodes: string[];
  visitedNodes: string[];
  hp: number;
  maxHp: number;
  san?: number;                  // CoC6 SAN (optional — old saves may lack it)
  playerStats: CharStats;
  playerSheet?: CharSheet;       // CoC6 sheet: occupation/skills/weapons/equipment
  checkedSkills?: string[];      // skills used this event (for CoC skill growth rolls)

  // Companion agents — each moves independently
  agents: CharacterAgent[];

  // World-level progress
  mainQuestStage: number;
  usedEncounterIds: string[];
  // DM story director — the living narrative state
  director: StoryDirector;
  gameDay: number;
  gameTime: "morning" | "afternoon" | "evening" | "night";

  // Shared history
  journal: JournalEntry[];       // combined log (user + all agents)
  keyChoices: string[];
  searchedNodes: Record<string, number>;
  checkedStats?: StatKey[];      // stats successfully used this event (for growth roll)
  streamLog?: StreamMessage[];   // text stream history (last 200)
  pendingEvent?: {               // restore event state on re-entry
    inEvent: boolean;
    choices?: EventChoice[];
    eventContext?: string;
    eventMeta?: { type: string; questId?: string };
    lastAction?: string;         // last player action (for retry on reload)
    interruptedPhase?: "companions" | "dm";
    completedCompanions?: string[];  // character IDs that already replied this round
  };
  checkpoint?: string;           // JSON snapshot of GameSave at save point (for death rollback)
  pacing?: "relaxed" | "normal" | "fast";  // narrative pacing preference
  completed?: boolean;           // main quest finished
  // ── CoC6 combat round (fork) ──
  combat?: {
    round: number;                                  // 当前轮次
    initiative: string[];                           // 先攻序列 tokens: player / comp:<id> / hostile:<name>
    currentIndex: number;                           // 当前行动者索引
    hostiles: { name: string; dex: number; hp: number; maxHp: number; notes?: string }[];
    hostileIndex: number;                           // 战斗开始时 hostiles 在先攻中的起始位（仅记录）
    playerDamageDealt: Record<string, number>;      // hostileName → 已造成伤害
    ended?: boolean;
  };
  madness?: {
    temporary?: { rounds: number; symptom: string; until?: string };  // 临时疯狂（剩余轮数）
    permanent?: boolean;              // 永久疯狂（SAN=0）
    phobias: string[];                // 恐惧症/狂躁症积累
    log: { day: string; text: string }[];
  };
  // ── fork: clue board + time passage ──
  clues?: { id: string; location: string; text: string; day: string }[];  // 线索板（按地点归档）
  timeTicks?: number;                // 距上次时段推进的轮数计数
  // ── fork: secret party (八期A) ──
  mySecret?: PersonalSecret;                     // 用户的秘密（工具栏可见，摊牌时机由用户决定）
  myPersona?: InvestigatorPersona;               // fork 十二期: 玩家的模组内人设（首次进入时审校确认）
  personaPending?: boolean;                      // fork: 调查员导入延迟到首次进入世界时执行（每人一次LLM，创建世界不再阻塞等待）
  agentSecrets?: Record<string, PersonalSecret>; // characterId → 同伴的秘密（KP 可见；用户结局前不可见，幕后页揭晓）
  investigatorLines?: InvestigatorLine[];        // fork: HO 导入剧情/个人线密档（随核心包/世界导入；KP 与本人可见）
  boundLineHo?: Record<string, string>;          // fork: characterId → HO 代号（"__player__"=玩家本人）；绑定后个人线才注入
  revealedDossier?: string[];                    // fork: 密档划账——已公开条目原文（NPC秘密/伏笔/HO事件/真相切片）；注入时标注状态防止KP遗忘或前后矛盾
  lockedLog?: { id: string; who: string; npc?: string; text: string; day: string }[]; // 锁档私聊流（结局揭晓；八期B 填充）
  // ── fork 九期B: staged acts ──
  currentAct?: number;             // 当前幕索引（skeleton.acts[currentAct]）
  // ── fork 十期: stage cues fired by KP (rendered client-side; assets stay local) ──
  pendingCg?: string;              // 待展示的 CG 资源名
  pendingBgm?: string;             // 待切换的 BGM 资源名
};

// ── MapWorld (stored in IndexedDB) — world is independent of characters ──
export type MapWorld = {
  id: string;
  skeleton: WorldSkeleton;
  assets?: StageAsset[];      // fork 十期: stage asset manifest (image/audio blobs live in IDB, not here)
  renderedMap: import("./map-engine").MapGenerationOutput;
  createdAt: string;
  updatedAt: string;
  status?: "generating" | "failed";
  statusMessage?: string;  // failure reason
  failureRaw?: string;     // raw LLM output on failure, for the failure dialog
};

// ── Character Agent State (per character in a world) ──
export type CharacterAgent = {
  characterId: string;
  currentNodeId: string;
  currentNodeType: "l1" | "l2" | "l3";
  discoveredNodes: string[];
  visitedNodes: string[];
  activeSideQuests: string[];
  completedSideQuests: string[];
  hp: number;
  maxHp: number;
  san?: number;
  journal: JournalEntry[];
  affinity: number;            // towards user, 0-100
  stats: CharStats;
  persona?: InvestigatorPersona;  // fork 十一期: module-adapted persona (overrides raw character card in-game)
  sheet?: CharSheet;           // CoC6 sheet for this companion
  madness?: { temporary?: { rounds: number; symptom: string }; permanent?: boolean };
};

// ── CoC character sheet (fork: occupation/skills/weapons) ──
export type CharSheet = {
  occupation: string;             // 职业（调查员为默认）
  creditRating: number;           // 信用评级
  skills: Record<string, number>; // 已训练技能 → 当前值（含信用评级）
  weapons: { name: string; skill: string; damage: string; range?: string; shots?: number; malf?: number }[];
  equipment: string[];            // 随身物品
};

// ── Agent Skill System (like 小卷's skills) ──
export type AgentAction =
  | { type: "move"; targetNodeId: string }
  | { type: "search" }
  | { type: "rest" }
  | { type: "accept_quest"; questId: string }
  | { type: "talk_npc"; npcId: string }
  | { type: "contact_user"; message: string }
  | { type: "contact_agent"; targetCharacterId: string; message: string }
  | { type: "wait" }
  | { type: "join_user" }
  | { type: "leave_user" };

export type AgentDecision = {
  action: AgentAction;
  reasoning: string;           // why the agent chose this (for journal)
};

// ── Event Scene (LLM-expanded dialogue) ──
export type EventChoice = {
  label: string;
  statCheck?: { stat: StatKey; who?: string };  // who: "你"/角色名/best = 指定掷骰人; 省略 = 玩家自己掷
  requires?: string;           // item name required (e.g. "古老钥匙")
  consequence?: string;        // brief hint for journal
};

export type EventDialogue = {
  speaker: string;             // character name, NPC name, or "narrator"
  text: string;
  emotion?: string;            // for sprite selection
};

export type EventScene = {
  background?: string;         // scene description (for atmosphere)
  cg?: string;                 // fork 十期: CG 资源名（KP 报幕，前端取图全屏展示）
  bgm?: string;                // fork 十期: BGM 资源名（前端循环播放，直到下一首）
  dialogues: EventDialogue[];
  choices?: EventChoice[];
  hints?: { label: string; skillHint?: string }[];  // fork: investigation prompts (CoC loop — player decides actions)
  topics?: { label: string; skillHint?: string }[]; // fork: NPC talk topics (tappable → fills speech input)
  clues?: string[];                 // fork: key clues gained this round → archived to the clue board
  investigationDone?: boolean;      // fork: KP signals this location's investigation is complete (anti-idling)
  sideScenes?: { who: string; npc: string; intent?: string; summary?: string }[];  // fork 八期B: KP-directed private scenes (locked)
  affinityDelta?: Record<string, number>;  // character affinity changes
  journalEntry?: string;       // auto-added to journal
  unlocks?: string[];          // node IDs to unlock/discover
  apCost?: number;
  advanceMainQuest?: boolean;
  completeSideQuest?: string;
};

export type StreamMessage = {
  id: string;
  type: "narration" | "npc" | "player" | "character" | "system" | "location" | "roll" | "divider" | "declCard" | "ooc";
  speaker?: string;
  text: string;
  emotion?: string;
  audience?: string[];  // fork 八期A 骨架（B期启用）：可见名单；undefined = 全员可见，["locked"] = 锁档
  // fork: declCard — one compact card per declaration (say / do / dice)
  decl?: {
    who: string;
    say?: string;
    do?: string;
    dice?: { skill: string; value: number; roll: number; level: string; detail?: string };
    emotion?: string;
  };
};

// Collect-Resolve-Narrate: a player or companion's declared action+speech per round
export type Declaration = {
  speaker: string;    // display name
  speech: string;     // what they say (to player/NPC/companion)
  action: string;     // what they do (physical action description)
  skillCheck?: string;  // fork: companion-chosen skill for this action (rolled by system)
  splitTo?: string;    // fork 拆场: 目的地名称——该成员离队单独行动，队伍不知道那边发生什么
  emotion?: string;   // for display
  affinityDelta?: number;  // -3 to +3, how the character's affinity toward user changed
  failed?: boolean;        // true if LLM call failed (not a deliberate silence)
};
