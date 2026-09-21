// lib/map-rpg-engine.ts
// RPG Map Mode — LLM integration for world generation + event expansion
// Fork mods: CoC/CoJ-style TRPG mode (CoC 6th Ed. attributes, module import, sparse NPC worlds)

import type { WorldSkeleton, WorldSkeletonInput, EventScene, GameSave, WorldNPC, QuestLine, EncounterSeed, CharacterAgent, AgentDecision, RichRegion, Declaration, CharStats, RulesEdition, PersonalSecret, ModuleAct } from "./map-types";
import { STAT_LABELS, ALL_STATS, SKILL_STAT_HINT } from "./map-types";
import { simpleLLMCall } from "./api-helpers";
import { previewMessagesForApi, sendLLMRequest } from "./chat-engine";
import type { ApiConfig } from "./settings-types";
import { loadCharacters } from "./character-storage";
import { resolveBinding, loadBindingConfig, loadPresets, loadWorldBooks, loadRegexes, resolveUserIdentity, loadApiConfigs } from "./settings-storage";
import { assemblePromptPayload, type LLMMessage } from "./llm-prompt-assembler";
import { retrieveMemoriesForPrompt, retrieveCoreMemoriesForPrompt } from "./memory-service";
import { formatLongTermMemories, formatCoreMemories } from "./memory-injector";
import { loadMemoryConfig } from "./memory-storage";
import { prepareShortTermContext } from "./short-term-assembler";
import { buildCalendarScheduleMarker } from "./calendar-storage";
import { getWeekStartIso } from "./calendar-utils";
import { estimateTokens } from "./token-counter";
import { loadAdventureInteractionConfig, loadDMTokenConfig } from "./map-storage";
import { DEFAULT_ADVENTURE_BILINGUAL_PROMPT, resolveBilingualPrompt } from "./bilingual-prompt-defaults";
import { normalizeUserNameToMacro, renderUserNameMacro } from "./user-macro";

// ── Debug log (set by map-view to capture prompts/responses) ──
let _debugCallback: ((type: string, content: string) => void) | null = null;
export function setDMDebugCallback(cb: ((type: string, content: string) => void) | null) { _debugCallback = cb; }
function dmLog(type: string, content: string) { _debugCallback?.(type, content); }
function formatDebugApiConfig(apiConfig: ApiConfig): string {
  return [
    `模型: ${apiConfig.defaultModel}`,
    `provider: ${apiConfig.provider}`,
    `baseUrl: ${apiConfig.baseUrl || "(空)"}`,
    `apiKey: ${apiConfig.apiKey ? `***${apiConfig.apiKey.slice(-4)}` : "(空)"}`,
    `id: ${apiConfig.id}`,
  ].join(" | ");
}
function formatDebugMessages(messages: Array<{ role: string; content: string }>, apiConfig?: ApiConfig): string {
  return [
    apiConfig ? `[config]\n${formatDebugApiConfig(apiConfig)}` : "",
    ...messages.map(m => `[${m.role}]\n${m.content}`),
  ].filter(Boolean).join("\n\n");
}

function buildAdventureCharacterBilingualInstruction(enabled: boolean, customPrompt?: string): string {
  return resolveBilingualPrompt(enabled, customPrompt, DEFAULT_ADVENTURE_BILINGUAL_PROMPT);
}

function formatStats(s: CharStats): string {
  return ALL_STATS.map(k => `${STAT_LABELS[k]}${s[k]}`).join("/");
}

function dmPlayerName(ctx: DMContext): string {
  return ctx.playerName?.trim() || "玩家";
}

// ── Extract JSON from LLM response (handles code blocks, quotes, truncation, etc.) ──
function extractJSON(text: string): string {
  let s = text.replace(/```(?:json)?\s*/gi, "").replace(/```/g, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  // Chinese punctuation (outside strings is safe)
  s = s.replace(/，/g, ",").replace(/：/g, ":").replace(/；/g, ";");
  // Remove trailing commas before ] or }
  s = s.replace(/,\s*([}\]])/g, "$1");
  // Remove comments (// ...)
  s = s.replace(/\/\/[^\n"]*(?=\n)/g, "");
  // Walk through char by char — handle smart quotes, newlines, etc. with string awareness
  let fixed = "";
  let inString = false;
  let escaped = false;
  const SMART_DOUBLE = /[\u201C\u201D\u201E\u201F\u2033\u2036\uFF02]/;
  const SMART_SINGLE = /[\u2018\u2019\u201A\u201B\u2032\u2035]/;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escaped) { fixed += ch; escaped = false; continue; }
    if (ch === "\\") { fixed += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; fixed += ch; continue; }
    if (inString) {
      // Smart quotes inside a string → escape them
      if (SMART_DOUBLE.test(ch)) { fixed += '\\"'; continue; }
      if (SMART_SINGLE.test(ch)) { fixed += "'"; continue; }
      if (ch === "\n") { fixed += "\\n"; continue; }
      if (ch === "\r") { continue; }
      if (ch === "\t") { fixed += "\\t"; continue; }
    } else {
      // Smart quotes outside a string → treat as regular quote (string boundary)
      if (SMART_DOUBLE.test(ch)) { inString = true; fixed += '"'; continue; }
    }
    fixed += ch;
  }
  s = fixed;
  // Try parse
  try { JSON.parse(s); return s; } catch { /* try repair */ }
  // Count unclosed brackets
  let braces = 0, brackets = 0;
  let inStr = false, escape = false;
  for (const ch of s) {
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (ch === "{") braces++;
    if (ch === "}") braces--;
    if (ch === "[") brackets++;
    if (ch === "]") brackets--;
  }
  // Remove any trailing partial value (cut at last complete comma)
  if (braces > 0 || brackets > 0) {
    const lastComma = s.lastIndexOf(",");
    if (lastComma > s.length * 0.5) {
      s = s.slice(0, lastComma);
    }
  }
  // Close open brackets/braces
  for (let i = 0; i < brackets; i++) s += "]";
  for (let i = 0; i < braces; i++) s += "}";
  return s;
}

import { loadDMPrompts } from "./map-storage";

// ── DM Prompt Defaults (exported for UI display) ──

function getActivePrompt(key: "scene" | "resolve" | "worldGen" | "ending", defaultVal: string): string {
  const custom = loadDMPrompts();
  return custom[key]?.trim() || defaultVal;
}

// ── 1. Generate World Skeleton ──

export const DEFAULT_WORLD_GEN_PROMPT = `你是COC（克苏鲁的呼唤，第6版规则）跑团的守秘人（KP）/世界架构师。用户描述世界观或提供TRPG模组背景，你据此设计完整的调查世界。

核心规则：NPC、支线调查、偶遇事件必须绑定到具体的节点（L2或L3），不是笼统的区域。

NPC与怪物创作指导（COC风格，与DND式"每个据点必有NPC"完全相反）：
- 这是COC跑团，不是DND。区域可以完全没有NPC——无人荒野、废弃宅邸、深海礁石才是常态
- NPC只在模组设定要求的地方出现：小镇居民、调查线索人物、可疑的学者等。数量宁少勿多
- 若提供了模组背景，NPC名单、怪物、地点必须严格来自模组设定，禁止自行编造模组外的关键NPC
- NPC的personality写一段有画面感的描写（4-8句）：外貌、性格、说话方式、可疑之处或与秘密相关的细节
- 怪物/神话生物也是节点内容：[NPC角色]填creature，性格字段写外形特征、行为模式与危险程度（如"深潜者：湿滑的两栖类人生物，行动迟缓但成群出没，对光敏感，眼神呆滞却透着古老的非人智慧"）
- 有秘密的人要在#档案里登记（用 [NPC秘密:名字]），名字与NPC名完全一致

只输出下面这种"标签块"纯文本格式，不要 JSON、不要 markdown 代码块、不要任何额外说明文字。

格式规则：
- 每个字段单独一行：[字段名]值；值可以多行（下一行若不是新的 [字段] 或 # 标题，就算上一字段的续行）。
- 引用词语/对话一律用中文引号「」，不要用英文引号。
- 分区用单个 # 开头：#区域1 #区域2 …、#主线、#档案；区域内的节点用 ## 开头：##L2节点1、##L3节点1。数字直接写数字。

严格按下面示例的字段名和层级输出（这里只给 2 个区域作示例）：

[世界名]阿卡姆县
[世界观]1920年代新英格兰，马萨诸塞州东部。表面平静的小镇之下，不可名状的古老存在正缓缓苏醒

#区域1
[id]arkham
[中文名]阿卡姆镇
[英文名]Arkham
[地理]plains
[河流数]1
[邻接]dunwich
[区域类型]主城
[主城NPC名]亨利·阿米蒂奇
[主城NPC性格]米斯卡塔尼克大学图书馆馆长，六十多岁，戴圆框眼镜，说话引经据典。对乡野流传的怪谈嗤之以鼻，但书库里锁着的那排禁书他从不让人碰。深夜的办公室灯光总是亮到很晚。
[主城NPC角色]info
##L2节点1
[名称]米斯卡塔尼克大学图书馆
[NPC名]黛西·霍金斯
[NPC性格]图书馆年轻的助理管理员，说话轻声细语，整理书籍的动作近乎强迫症般规整。有人借走某本旧书没有归还时，她会显得异常焦虑。
[NPC角色]info
[任务id]sq1
[任务标题]失踪的借阅者
[任务简介]一位经常查阅禁书的教授已两周未露面
##L2节点2
[名称]河边旧宅
[NPC角色]creature
[NPC性格]宅邸中盘踞的某种东西——只在夜间活动，楼道里传来湿漉漉的拖行声，墙上挂着褪色的家族肖像，画中人的眼睛似乎会转动。
##L3节点1
[名称]废弃码头
[偶遇id]enc1
[偶遇简介]涨潮时码头下传来非人的吟唱声
[偶遇情绪]eerie

#区域2
[id]dunwich
[中文名]敦威治村
[英文名]Dunwich
[地理]mountainous
[河流数]0
[邻接]arkham
[区域类型]荒野
##L2节点1
[名称]鸟石荒丘
[NPC角色]creature
[NPC性格]荒丘上出没的隐形之物——看不见身形，只能靠被压倒的灌木与泥土的骚动判断位置，散发令牲畜发疯的气味。
##L3节点1
[名称]巫师之洞
[偶遇id]enc2
[偶遇简介]洞窟深处的岩壁上布满非几何的刻痕
[偶遇情绪]dread

#主线
[id]mq
[标题]敦威治的恐怖
[梗概]一连串怪事背后，某个古老存在即将借尸还魂，调查者必须找到阻止仪式的方法
[阶段1地点]米斯卡塔尼克大学图书馆
[阶段1简介]查阅禁书档案，找到失踪教授的研究线索
[阶段1解锁]获得敦威治村的位置情报
[阶段2地点]敦威治村
[阶段2简介]在荒村寻找目击者，查明神秘家族的过去
[阶段2解锁]获得巫师之洞的地图

#档案
[隐藏真相]失踪的教授发现了召唤仪式的残页，被邪教徒灭口
[NPC秘密:黛西·霍金斯]她是邪教徒安插在图书馆的眼线，负责监视禁书借阅者
[伏笔1]失踪教授最后的借阅记录是一本没有人听说过的书
[伏笔2]敦威治的牲畜近年接连发疯流产
[反转]阿米蒂奇馆长其实早知道仪式的存在，一直在等"合适的人"来阻止它
[结局]阻止仪式需要那本人人争夺的禁书——但翻开它的人都难逃疯狂

以上只是 2 个区域的示例。要求：
- 共 {{region_count}} 个区域，按 #区域1 #区域2 … 顺序编号；[邻接] 必须对称（A 邻接 B 则 B 也邻接 A），多个用顿号、分隔
- 每个区域 2-4 个 ##L2节点、0-2 个 ##L3节点，节点也顺序编号
- 【COC核心规则】[主城NPC名]（及配套两字段）仅在 [区域类型] 为主城/城镇 的区域填写——这类区域全图通常 1-2 个；其余区域（荒野/废墟/禁区）一律留空，只放探索点与怪物/异象
- 每个节点可绑 1 个NPC或怪物（[NPC角色]creature表示怪物/异象）+ 1 个任务或偶遇；不需要的字段整组省略即可。多数节点应当是无人探索点
- 主线 4-5 个阶段，[阶段N地点] 写具体节点名（不是区域名）；主线应当是调查/揭秘驱动的推理链，而非杀怪夺宝
- 若提供了模组背景：NPC、怪物、主线、密档全部取自模组内容，你只负责把模组素材映射成上述区域/节点结构；模组没提的内容不要编造
- 总共 {{npc_count}} 个NPC/怪物分布在不同节点（含主城NPC与creature）；至少 2 个NPC在 #档案 里有隐藏身份或秘密
- 总共 5-8 个偶遇分布在不同节点；[偶遇情绪] 优先用 eerie/dread/uncanny/tense（克苏鲁氛围），轻松场合才用 warm/humorous
- [NPC性格] 写一段有画面感的描写（2-4 句，精炼有力，不要铺陈）
- 【输出预算·重要】整体输出必须紧凑：不写任何与跑团无关的风景铺陈、不重复示例内容；宁可每个字段短一句，也不要在结尾被截断——截断=全部作废重来
- [地理] 可选：mountainous/plains/canyon/forest/coastal/desert/swamp
- 世界风格基调：{{tone}}
- 主线类型倾向：{{main_quest_type}}
- 难度倾向：{{difficulty}}
- 【秘密团规则】最后输出一个 #秘密团 区块，为调查员准备个人秘密：
  · 数量 = 调查员人数+1（多备一份给玩家本人），每个秘密格式：[秘密N]内容 | [咬合N]与主线真相的关联 | [知情者N]知道更多的NPC名（必须取自本模组已定义的NPC）
  · 每个秘密必须：互相不重复、各自独立可守、与主线真相有一个明确咬合点、知道完整内情的NPC在本图中可找到
  · 秘密可以是：目击了某事件、藏了某物、隐瞒了身份或动机、与某个NPC有私交/旧怨、提前读过某页文献等
  · 秘密不影响调查员「想要查明真相」的立场——他们守秘密是为了自保或保护某人，不是与全队为敌
{{module_text}}`;

// ═══════════════════════════════════════════
// Fork 十三期: staged world generation — skeleton → parallel region fills → secrets
// Each stage is a small call; failure retry costs one stage, not everything.
// ═══════════════════════════════════════════

const SKELETON_PROMPT = `你是COC（克苏鲁的呼唤）跑团的世界架构师。根据世界描述/模组背景，只设计世界骨架：区域划分与节点名——不需要任何NPC、任务、遭遇的细节（那些下一步单独生成）。

只输出标签块纯文本，不要JSON、不要markdown代码块：
[世界名]6-10字
[世界观]2-3句时代与氛围

#区域1
[id]英文小写id（如arkham，全图唯一）
[中文名]区域名
[英文名]英文名
[地理]mountainous/plains/canyon/forest/coastal/desert/swamp 之一
[河流数]0-3
[邻接]其他区域的id，顿号分隔（必须对称：A邻接B则B也邻接A）
[区域类型]主城/城镇/荒野/废墟/禁区（主城/城镇全图1-2个，其余为探索区）

然后每个区域列节点（##L2节点 / ##L3节点 各区域 2-4 个 L2、0-2 个 L3，只写名字不写内容）：
##L2节点1
[名称]地点名
##L3节点1
[名称]偏远地点名

要求：{{region_rule}}节点名具体有画面感（"米斯卡塔尼克大学图书馆"而非"图书馆"）；若有模组背景，地点必须取自模组。`;

const REGION_FILL_PROMPT = `你是COC跑团的世界架构师。下面是已定稿的世界骨架与一个待填充的区域。只为本区域生成内容：NPC、怪物、任务、偶遇。COC 风格：区域可以完全无人，NPC宁少勿多，每个NPC的personality写4-8句有画面感的描写。

只输出标签块纯文本（只输出本区域的内容，不要重复区域头）：
{区域头}
[主城NPC名]（仅主城/城镇区域填）4-8句描写
[主城NPC性格]同上组
[主城NPC角色]info/quest/merchant/ambient/rival/creature
##L2节点1
[名称]（与骨架一致）
[NPC名]该节点的NPC（无人则留空整组省略；怪物填[NPC角色]creature，性格写外形与危险度）
[NPC性格]
[NPC角色]
[任务id]sqN（可选）
[任务标题]
[任务简介]一两句
[偶遇id]encN（L3节点适合放偶遇）
[偶遇简介]
[偶遇情绪]eerie/dread/uncanny/tense/warm/humorous
##L3节点1
（同上）

硬性要求：
- 严格使用骨架里既定的节点名与数量，不得增删节点
- 若提供了模组背景：NPC/怪物/任务/偶遇必须取自模组，禁止编造模组外的关键NPC
- {npc_rule}`;

const SECRETS_PROMPT = `你是COC跑团的世界架构师。基于已知的世界真相框架与人物，为调查员们设计个人秘密（秘密团用）。

只输出标签块纯文本：
#秘密团
[秘密1]内容（一句话：TA目击了什么/藏了什么/隐瞒了什么身份）
[咬合1]与主线真相的咬合点
[知情者1]知道更多的NPC名（必须取自已知NPC列表）
（共 {secret_count} 条，编号递增）

要求：互不重复、各自独立可守、不是与全队为敌、秘密持有者是要查明真相的调查员同伴。`;

/** Parse the skeleton-stage tagged output into region shells. */
function parseSkeletonStage(text: string): { world: { name: string; lore: string }; regions: { id: string; cn: string; en: string; geo: string; rivers: number; adj: string[]; type: string; l2: string[]; l3: string[] }[] } | null {
  const src = text.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").replace(/\r/g, "").trim();
  const topRe = /^(?!#)([\s\S]*?)(?=\n#|$)/;
  const top = (src.match(topRe)?.[1] || src).trim();
  const f0 = parseWorldTaggedFields(top);
  const regions: { id: string; cn: string; en: string; geo: string; rivers: number; adj: string[]; type: string; l2: string[]; l3: string[] }[] = [];
  const re = /^#\s*(区域|地区)\s*(\d*)\s*$/gm;
  const heads = [...src.matchAll(re)];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i];
    if (h.index === undefined) continue;
    const start = h.index + h[0].length;
    const end = i + 1 < heads.length && heads[i + 1].index !== undefined ? heads[i + 1].index! : src.length;
    const body = src.slice(start, end);
    // L1 fields + node names
    const subRe = /^##\s*(.+?)\s*$/gm;
    const subs = [...body.matchAll(subRe)];
    const l1Body = subs.length && subs[0].index !== undefined ? body.slice(0, subs[0].index) : body;
    const f = parseWorldTaggedFields(l1Body);
    const l2: string[] = [];
    const l3: string[] = [];
    for (let j = 0; j < subs.length; j++) {
      const s = subs[j];
      if (s.index === undefined) continue;
      const sStart = s.index + s[0].length;
      const sEnd = j + 1 < subs.length && subs[j + 1].index !== undefined ? subs[j + 1].index! : body.length;
      const nf = parseWorldTaggedFields(body.slice(sStart, sEnd));
      const nm = nf["名称"] || "";
      if (nm) (/L3/i.test(s[1]) ? l3 : l2).push(nm);
    }
    if (f["中文名"] || f["id"]) {
      regions.push({
        id: f["id"] || `region_${i}`, cn: f["中文名"] || `区域${i + 1}`, en: f["英文名"] || "",
        geo: f["地理"] || "plains", rivers: worldIntField(f["河流数"]), adj: worldSplitList(f["邻接"]), type: f["区域类型"] || "",
        l2, l3,
      });
    }
  }
  if (!regions.length) return null;
  return { world: { name: f0["世界名"] || "新世界", lore: f0["世界观"] || "" }, regions };
}

/** LLM call with one auto-continue on truncation (fork 十三期). */
async function simpleLLMCallWithContinue(apiConfig: ApiConfig, messages: Array<{ role: string; content: string }>, opts?: { temperature?: number }): Promise<string> {
  let result = await simpleLLMCall(apiConfig, messages as never, opts);
  let text = (result.content as string) || "";
  if (!result.wasTruncated || !text) return text;
  // Auto-continue: ask the model to pick up where it stopped
  const cont = await simpleLLMCall(apiConfig, [
    ...messages as never[],
    { role: "assistant", content: text } as never,
    { role: "user", content: "你的输出被截断了。从中断处原样继续，不要重复已输出的内容，不要任何解释。" } as never,
  ], opts);
  return text + "\n" + ((cont.content as string) || "");
}

/** Staged generation: skeleton → parallel per-region fills → secrets (each stage small & retryable). */
async function generateWorldSkeletonStaged(
  userDescription: string,
  apiConfig: ApiConfig,
  vars?: Record<string, string>,
  onProgress?: (step: string) => void,
): Promise<WorldSkeleton> {
  const regionCount = parseInt(vars?.region_count || "6", 10) || 6;
  const npcTotal = parseInt(vars?.npc_count || "12", 10);
  const moduleTextRaw = vars?.module_text || "";
  const v = (s: string) => {
    let out = s;
    if (vars) for (const [k, val] of Object.entries(vars)) out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), val ?? "");
    return out;
  };

  // ── Stage 1: skeleton (names only — small output) ──
  onProgress?.(`世界骨架（1/3）`);
  // Fork: module mode — region count is decided by the model from the module text, not the slider
  const regionRule = moduleTextRaw
    ? "【模组模式】通读模组后按模组实际地点数量自由决定区域数（建议 4-8 个，模组地点多就多、少就少，不追求整齐），每个地点都有出处；"
    : `区域 ${regionCount} 个；`;
  let skelPrompt = v(SKELETON_PROMPT).replace("{{region_rule}}", regionRule);
  const user1 = `世界描述：${userDescription}${moduleTextRaw ? `\n\n# 模组背景（地点与区域必须取自此模组）\n${moduleTextRaw.slice(0, 12000)}` : ""}\n\n基调：${vars?.tone || "自由发挥"} · 主线倾向：${vars?.main_quest_type || "自由发挥"} · 难度：${vars?.difficulty || "适中"}`;
  let skelText = await simpleLLMCallWithContinue(apiConfig, [
    { role: "system", content: skelPrompt },
    { role: "user", content: user1 },
  ], { temperature: 0.8 });
  let skeletonParsed = parseSkeletonStage(skelText);
  if (!skeletonParsed) {
    // One retry with a stricter reminder
    skelText = await simpleLLMCallWithContinue(apiConfig, [
      { role: "system", content: skelPrompt + "\n\n【再次提醒】只输出标签块格式，第一行必须是[世界名]。" },
      { role: "user", content: user1 },
    ], { temperature: 0.8 });
    skeletonParsed = parseSkeletonStage(skelText);
    if (!skeletonParsed) throw new Error("骨架阶段解析失败（模型未按标签格式输出）");
  }

  // Symmetrize adjacency
  const byId = new Map(skeletonParsed.regions.map(r => [r.id, r]));
  for (const r of skeletonParsed.regions) {
    for (const a of r.adj) byId.get(a) && !byId.get(a)!.adj.includes(r.id) && byId.get(a)!.adj.push(r.id);
  }

  // ── Stage 2: parallel per-region fills ──
  // Fork: module mode — NPC budget is advisory only; the model decides per region from the module text.
  const npcBudget = moduleTextRaw ? -1 : Math.max(0, Math.ceil(npcTotal / Math.max(1, skeletonParsed.regions.length)));
  const regions = await Promise.all(skeletonParsed.regions.map(async (r, ri) => {
    onProgress?.(`区域填充 ${ri + 1}/${skeletonParsed.regions.length}：${r.cn}`);
    const regionHead = `#区域${ri + 1}\n[id]${r.id}\n[中文名]${r.cn}\n[英文名]${r.en}\n[地理]${r.geo}\n[河流数]${r.rivers}\n[邻接]${r.adj.join("、")}\n[区域类型]${r.type || "荒野"}`;
    const nodeList = [...r.l2.map(n => `##L2节点\n[名称]${n}`), ...r.l3.map(n => `##L3节点\n[名称]${n}`)].join("\n");
    const npcRule = moduleTextRaw
      ? "模组模式：NPC/怪物数量由你按模组本区域的实际人物决定（模组此处有谁就放谁，没有就留空，0个也正常）——不要为了凑数编造模组外NPC"
      : `本区域NPC+怪物总数约 ${npcBudget} 个（0也合法——无人荒野是常态）`;
    const fillPrompt = REGION_FILL_PROMPT.replace("{区域头}", regionHead).replace("{npc_rule}", npcRule);
    const user2 = `世界：${skeletonParsed.world.name}——${skeletonParsed.world.lore}\n${regionHead}\n\n本区域既定节点（严格用这些名字）：\n${nodeList}\n\n主城/城镇：${["主城", "城镇"].includes(r.type) ? "是（需要主城NPC）" : "否"}${moduleTextRaw ? `\n\n# 模组背景（NPC/怪物/任务必须取自此模组）\n${moduleTextRaw.slice(0, 10000)}` : ""}`;
    try {
      const text = await simpleLLMCallWithContinue(apiConfig, [
        { role: "system", content: fillPrompt },
        { role: "user", content: user2 },
      ], { temperature: 0.8 });
      return parseWorldRegionBlock(`${regionHead}\n${text}`);
    } catch {
      // Region fill failed → keep the shell (nodes exist, no content) instead of failing the world
      return {
        id: r.id, l1_name_cn: r.cn, l1_name_en: r.en,
        geography: (r.geo as "mountainous" | "plains" | "canyon"),
        river_count: r.rivers, adjacent_to: r.adj, region_type: r.type,
        l2_nodes: r.l2.map(n => ({ name: n })), l3_nodes: r.l3.map(n => ({ name: n })),
      };
    }
  }));

  // ── Stage 3: main quest + dossier + secrets (one medium call, from region names) ──
  onProgress?.(`主线与秘密（3/3）`);
  const mqPrompt = `你是COC跑团的世界架构师。基于世界与全部地点，设计主线调查链、DM密档与个人秘密。只输出标签块纯文本，不要JSON：

#主线
[id]mq
[标题]
[梗概]2-3句：真相是什么、调查员为何卷入
[阶段1地点]具体节点名
[阶段1简介]
[阶段1解锁]
（4-5个阶段；阶段地点从给定节点里选；调查/揭秘驱动，不是杀怪夺宝）

#档案
[隐藏真相]2-3句
[NPC秘密:NPC名]TA隐瞒的事（有秘密的NPC写几条，名字与NPC列表完全一致）
[伏笔1]（2-4条）
[反转]
[结局]

${SECRETS_PROMPT.replace("{secret_count}", "4")}

NPC列表（秘密与知情者只能用这些名字）：${regions.flatMap(rg => [rg.l1_npc?.name, ...rg.l2_nodes.map(n => n.npc?.name), ...rg.l3_nodes.map(n => n.npc?.name)].filter(Boolean) as string[]).join("、")}
节点列表（主线阶段地点只能用这些名字）：${regions.flatMap(rg => [rg.l1_name_cn, ...rg.l2_nodes.map(n => n.name), ...rg.l3_nodes.map(n => n.name)]).join("、")}${moduleTextRaw ? `\n\n# 模组背景（主线/密档/秘密优先取自此模组）\n${moduleTextRaw.slice(0, 8000)}` : ""}`;
  const mqText = await simpleLLMCallWithContinue(apiConfig, [
    { role: "system", content: mqPrompt },
    { role: "user", content: `世界：${skeletonParsed.world.name}——${skeletonParsed.world.lore}\n基调：${vars?.tone || "自由发挥"} · 主线倾向：${vars?.main_quest_type || "自由发挥"}` },
  ], { temperature: 0.8 });

  // Reuse the existing tagged parsers for the tail section
  const tail = parseWorldTagged(`#主线\n${mqText.split("#主线").slice(1).join("#主线") || mqText}`);
  const mainQuest = (tail.main_quest || {}) as Record<string, unknown>;
  const dmDossier = (tail.dm_dossier || {}) as Record<string, unknown>;
  const personalSecrets = ((tail.personal_secrets || []) as PersonalSecret[]).map(s => ({ content: String(s.content || ""), link: String(s.link || ""), informant: s.informant ? String(s.informant) : undefined }));
  const mq: QuestLine = {
    id: "mq",
    title: (mainQuest.title as string) || skeletonParsed.world.name,
    type: "main",
    synopsis: (mainQuest.synopsis as string) || "",
    triggerRegion: regions[0]?.id || "",
    stages: ((mainQuest.stages || []) as { location_hint: string; brief: string; unlock_hint: string }[]).map(s => ({ locationHint: s.location_hint || "", brief: s.brief || "", unlockHint: s.unlock_hint || "" })),
  };
  const dossier: import("./map-types").DMDossier = {
    hiddenTruth: (dmDossier.hidden_truth as string) || "",
    npcSecrets: (dmDossier.npc_secrets as Record<string, string>) || {},
    foreshadowing: (dmDossier.foreshadowing as string[]) || [],
    plotTwist: (dmDossier.plot_twist as string) || "",
    endgame: (dmDossier.endgame as string) || "",
  };

  // Assemble (same post-processing as legacy path)
  const richRegions: import("./map-types").RichRegion[] = regions.map(r => ({
    id: r.id as string,
    l1_name_cn: (r.l1_name_cn || r.name) as string,
    l1_name_en: (r.l1_name_en || "") as string,
    geography: (r.geography || "plains") as "mountainous" | "plains" | "canyon",
    river_count: (r.river_count || 0) as number,
    adjacent_to: (r.adjacent_to || []) as string[],
    l1_npc: r.l1_npc as RichRegion["l1_npc"] || undefined,
    l1_quest: r.l1_quest as RichRegion["l1_quest"] || undefined,
    l2_nodes: ((r.l2_nodes || []) as unknown[]).map(n => typeof n === "string" ? { name: n } : n as import("./map-types").NodeContent),
    l3_nodes: ((r.l3_nodes || []) as unknown[]).map(n => typeof n === "string" ? { name: n } : n as import("./map-types").NodeContent),
  }));
  const mapInput: WorldSkeletonInput = {
    map_settings: { header: "", title: skeletonParsed.world.name },
    regions: richRegions.map(r => ({ id: r.id, l1_name_cn: r.l1_name_cn, l1_name_en: r.l1_name_en, geography: r.geography, river_count: r.river_count, adjacent_to: r.adjacent_to, l2_nodes: r.l2_nodes.map(n => n.name), l3_nodes: r.l3_nodes.map(n => n.name) })),
  };
  const npcs: WorldNPC[] = [];
  let npcIdx = 0;
  for (const r of richRegions) {
    if (r.l1_npc) npcs.push({ id: `npc_${npcIdx++}`, name: r.l1_npc.name, personality: r.l1_npc.personality, locationRegion: r.id, locationNode: r.l1_name_cn, role: r.l1_npc.role as WorldNPC["role"], relatedQuestIds: [] });
    for (const n of [...r.l2_nodes, ...r.l3_nodes]) {
      if (n.npc) npcs.push({ id: `npc_${npcIdx++}`, name: n.npc.name, personality: n.npc.personality, locationRegion: r.id, locationNode: n.name, role: n.npc.role as WorldNPC["role"], relatedQuestIds: n.quest ? [n.quest.id] : [] });
    }
  }
  const sideQuests: QuestLine[] = [];
  for (const r of richRegions) {
    for (const n of [...r.l2_nodes, ...r.l3_nodes]) {
      if (n.quest) sideQuests.push({ id: n.quest.id, title: n.quest.title, type: "side", synopsis: n.quest.brief, triggerRegion: r.id, stages: [{ locationHint: n.name, brief: n.quest.brief }] });
    }
    if (r.l1_quest) sideQuests.push({ id: r.l1_quest.id, title: r.l1_quest.title, type: "side", synopsis: r.l1_quest.brief, triggerRegion: r.id, stages: [{ locationHint: r.l1_name_cn, brief: r.l1_quest.brief }] });
  }
  const encounterPool: EncounterSeed[] = [];
  for (const r of richRegions) {
    for (const n of [...r.l2_nodes, ...r.l3_nodes]) {
      if (n.encounter) encounterPool.push({ id: n.encounter.id, brief: n.encounter.brief, mood: (n.encounter.mood || "eerie") as EncounterSeed["mood"], locationTypes: [r.geography], locationNode: n.name });
    }
  }
  return {
    world: { name: skeletonParsed.world.name, lore: skeletonParsed.world.lore, rulesEdition: "coc6" },
    mapInput, richRegions,
    mainQuest: mq, sideQuests, npcs, encounterPool,
    partyStats: {},
    dmDossier: dossier,
    personalSecrets,
  };
}

// ── Tagged-block world parser (replaces fragile JSON; same shape as the old JSON.parse) ──
function parseWorldTaggedFields(block: string): Record<string, string> {
  const fields: Record<string, string> = {};
  let key = "";
  let buf: string[] = [];
  const flush = () => { if (key) fields[key] = buf.join("\n").trim(); key = ""; buf = []; };
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const m = line.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) { flush(); key = (m[1] || "").trim(); buf = [m[2] ?? ""]; }
    else if (key) { buf.push(line); }
  }
  flush();
  return fields;
}

function worldIntField(value: string | undefined): number {
  const n = parseInt(String(value ?? "").replace(/[^\d-]/g, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

function worldSplitList(value: string | undefined): string[] {
  return String(value ?? "").split(/[,，、;；\s]+/).map(s => s.trim()).filter(Boolean);
}

function parseWorldNodeBlock(body: string): Record<string, unknown> {
  const f = parseWorldTaggedFields(body);
  const node: Record<string, unknown> = { name: f["名称"] || f["节点名"] || "" };
  if ((f["NPC名"] || "").trim() || (f["NPC角色"] || "").trim() === "creature") {
    node.npc = {
      name: f["NPC名"] || (f["名称"] || "").trim() + "（异象）",
      personality: f["NPC性格"] || f["NPC外形"] || "",
      role: f["NPC角色"] || "info",
    };
  }
  if ((f["任务标题"] || "").trim()) node.quest = { id: f["任务id"] || f["任务ID"] || "", title: f["任务标题"], brief: f["任务简介"] || "" };
  if ((f["偶遇简介"] || "").trim()) node.encounter = { id: f["偶遇id"] || f["偶遇ID"] || "", brief: f["偶遇简介"], mood: f["偶遇情绪"] || "eerie" };
  return node;
}

function parseWorldRegionBlock(body: string): Record<string, unknown> {
  const subRe = /^##\s*(.+?)\s*$/gm;
  const subs = [...body.matchAll(subRe)];
  const l1Body = subs.length && subs[0].index !== undefined ? body.slice(0, subs[0].index) : body;
  const f = parseWorldTaggedFields(l1Body);
  const region: Record<string, unknown> = {
    id: f["id"] || f["ID"] || "",
    l1_name_cn: f["中文名"] || f["名称"] || "",
    l1_name_en: f["英文名"] || "",
    geography: f["地理"] || "plains",
    river_count: worldIntField(f["河流数"]),
    adjacent_to: worldSplitList(f["邻接"]),
    region_type: f["区域类型"] || "",
    l2_nodes: [] as unknown[],
    l3_nodes: [] as unknown[],
  };
  // Main-city NPC stays optional (CoC worlds often have no hub NPC in a region)
  if ((f["主城NPC名"] || "").trim()) region.l1_npc = { name: f["主城NPC名"], personality: f["主城NPC性格"] || "", role: f["主城NPC角色"] || "info" };
  if ((f["主城任务标题"] || "").trim()) region.l1_quest = { id: f["主城任务id"] || `q_${region.id}`, title: f["主城任务标题"], brief: f["主城任务简介"] || "" };
  for (let i = 0; i < subs.length; i++) {
    const cur = subs[i];
    if (cur.index === undefined) continue;
    const header = (cur[1] || "").trim();
    const start = cur.index + cur[0].length;
    const end = i + 1 < subs.length && subs[i + 1].index !== undefined ? subs[i + 1].index! : body.length;
    const node = parseWorldNodeBlock(body.slice(start, end));
    if (/L3/i.test(header)) (region.l3_nodes as unknown[]).push(node);
    else (region.l2_nodes as unknown[]).push(node);
  }
  return region;
}

function parseWorldTagged(text: string): Record<string, unknown> {
  const src = text.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").replace(/\r/g, "").trim();
  const topRe = /^#(?!#)\s*(.+?)\s*$/gm;
  const heads = [...src.matchAll(topRe)];
  const preamble = heads.length && heads[0].index !== undefined ? src.slice(0, heads[0].index) : src;
  const top = parseWorldTaggedFields(preamble);

  const regions: Record<string, unknown>[] = [];
  let mainQuest: Record<string, unknown> = {};
  let dossier: Record<string, unknown> = {};
  let personalSecrets: Record<string, string>[] = [];

  for (let i = 0; i < heads.length; i++) {
    const cur = heads[i];
    if (cur.index === undefined) continue;
    const header = (cur[1] || "").trim();
    const start = cur.index + cur[0].length;
    const end = i + 1 < heads.length && heads[i + 1].index !== undefined ? heads[i + 1].index! : src.length;
    const body = src.slice(start, end);
    if (/^区域|^地区/.test(header)) {
      regions.push(parseWorldRegionBlock(body));
    } else if (/^主线/.test(header)) {
      const f = parseWorldTaggedFields(body);
      const stageIdx = [...new Set(Object.keys(f).map(k => k.match(/^阶段(\d+)/)?.[1] ?? "").filter(Boolean))].map(Number).sort((a, b) => a - b);
      const stages = stageIdx.map(n => ({
        location_hint: f[`阶段${n}地点`] || "",
        brief: f[`阶段${n}简介`] || "",
        unlock_hint: f[`阶段${n}解锁`] || f[`阶段${n}解锁提示`] || "",
      })).filter(s => s.location_hint || s.brief);
      mainQuest = { id: f["id"] || "mq", title: f["标题"] || "", synopsis: f["梗概"] || f["简介"] || "", stages };
    } else if (/^秘密团|^个人秘密|^秘密/.test(header)) {
      const f = parseWorldTaggedFields(body);
      const secrets: Record<string, string>[] = [];
      const idxSet = [...new Set(Object.keys(f).map(k => k.match(/^秘密(\d+)$/)?.[1] ?? "").filter(Boolean))].map(Number).sort((a, b) => a - b);
      for (const n of idxSet) {
        if ((f[`秘密${n}`] || "").trim()) {
          secrets.push({ content: f[`秘密${n}`], link: f[`咬合${n}`] || "", informant: f[`知情者${n}`] || "" });
        }
      }
      personalSecrets = secrets;
    } else if (/^档案|^DM|^密档/.test(header)) {
      const f = parseWorldTaggedFields(body);
      const npcSecrets: Record<string, string> = {};
      const foreshadowing: string[] = [];
      for (const [k, v] of Object.entries(f)) {
        const secret = k.match(/^NPC秘密[·:：・]\s*(.+)$/);
        if (secret) { if (v.trim()) npcSecrets[secret[1].trim()] = v; continue; }
        if (/^伏笔\d+$/.test(k) && v.trim()) foreshadowing.push(v);
      }
      dossier = {
        hidden_truth: f["隐藏真相"] || "",
        npc_secrets: npcSecrets,
        foreshadowing,
        plot_twist: f["反转"] || "",
        endgame: f["结局"] || "",
      };
    }
  }

  return {
    world: { name: top["世界名"] || "", lore: top["世界观"] || top["世界观设定"] || "" },
    regions,
    main_quest: mainQuest,
    dm_dossier: dossier,
    personal_secrets: personalSecrets,
  };
}

export async function generateWorldSkeleton(
  userDescription: string,
  companionDescriptions: string[],
  apiConfig: ApiConfig,
  vars?: Record<string, string>,
  onProgress?: (step: string) => void,
): Promise<WorldSkeleton> {
  // Fork 十三期: staged generation is the default (skeleton → parallel region fills → secrets).
  // Falls back to the legacy single mega-call when a custom worldGen prompt is set.
  const customPrompts = loadDMPrompts();
  if (!customPrompts.worldGen?.trim()) {
    return generateWorldSkeletonStaged(userDescription, apiConfig, vars, onProgress);
  }
  // Replace {{variables}} in prompt (module_text is injected the same way — empty by default)
  let prompt = getActivePrompt("worldGen", DEFAULT_WORLD_GEN_PROMPT);
  if (vars) {
    for (const [key, val] of Object.entries(vars)) {
      prompt = prompt.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), val ?? "");
    }
  }
  // Strip the trailing module placeholder if the var was absent (avoid a dangling heading in the prompt)
  prompt = prompt.replace(/\n?{{module_text}}\s*$/, "").replace(/{{module_text}}/g, "");

  const userMsg = `世界描述：${userDescription}\n\n同行角色：\n${companionDescriptions.map((d, i) => `${i + 1}. ${d}`).join("\n") || "（无）"}`;

  const result = await simpleLLMCall(apiConfig, [
    { role: "system", content: prompt },
    { role: "user", content: userMsg },
  ]);

  // Failures carry the raw LLM output so the UI can show it (like the check-phone error card).
  const failWorldGen = (reason: string, raw: string): never => {
    const err = new Error(reason) as Error & { rawOutput?: string };
    err.rawOutput = raw;
    throw err;
  };

  if (!result.content) failWorldGen(result.error || "LLM 返回为空（没有任何输出）", "");
  if (result.wasTruncated) {
    // Fork: truncation = unusable output — fail fast with guidance instead of parsing half a world
    failWorldGen("输出被截断（内容太长，模型没写完）。重试前建议：①调低「区域」「NPC/怪物」数量 ②缩短模组文本或改用「分栏导入」（提取管道不受此限） ③换输出上限更高的模型", result.content);
  }
  const rawOutput = result.content as string;

  // Tagged-block format (no JSON quoting/escaping pitfalls, and far fewer output
  // tokens → shorter generation → much less likely to hit a connection timeout).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let parsed: any;
  try {
    parsed = parseWorldTagged(rawOutput);
  } catch (e) {
    failWorldGen(`解析失败：${(e as Error).message}`, rawOutput);
  }
  if (!Array.isArray(parsed.regions) || parsed.regions.length === 0) {
    failWorldGen("解析失败：没有解析到任何「#区域」（模型可能没按标签格式输出）", rawOutput);
  }

  // Parse rich regions (nodes with NPC/quest/encounter bindings)
  const rawRegions = parsed.regions || [];
  const richRegions: import("./map-types").RichRegion[] = rawRegions.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    l1_name_cn: (r.l1_name_cn || r.name) as string,
    l1_name_en: (r.l1_name_en || "") as string,
    geography: (r.geography || "plains") as "mountainous" | "plains" | "canyon",
    river_count: (r.river_count || 0) as number,
    adjacent_to: (r.adjacent_to || []) as string[],
    l1_npc: r.l1_npc as RichRegion["l1_npc"] || undefined,
    l1_quest: r.l1_quest as RichRegion["l1_quest"] || undefined,
    l2_nodes: ((r.l2_nodes || []) as unknown[]).map((n: unknown) =>
      typeof n === "string" ? { name: n } : (n as import("./map-types").NodeContent)
    ),
    l3_nodes: ((r.l3_nodes || []) as unknown[]).map((n: unknown) =>
      typeof n === "string" ? { name: n } : (n as import("./map-types").NodeContent)
    ),
  }));

  // Extract name-only arrays for map engine
  const mapInput: WorldSkeletonInput = {
    map_settings: parsed.map_settings || parsed.map_input?.map_settings || { header: "", title: "" },
    regions: richRegions.map(r => ({
      id: r.id,
      l1_name_cn: r.l1_name_cn,
      l1_name_en: r.l1_name_en,
      geography: r.geography,
      river_count: r.river_count,
      adjacent_to: r.adjacent_to,
      l2_nodes: r.l2_nodes.map(n => n.name),
      l3_nodes: r.l3_nodes.map(n => n.name),
    })),
  };

  // Extract flat NPC list from all nodes
  const npcs: WorldNPC[] = [];
  let npcIdx = 0;
  for (const r of richRegions) {
    if (r.l1_npc) {
      npcs.push({ id: `npc_${npcIdx++}`, name: r.l1_npc.name, personality: r.l1_npc.personality, locationRegion: r.id, locationNode: r.l1_name_cn, role: r.l1_npc.role as WorldNPC["role"], relatedQuestIds: [] });
    }
    for (const n of [...r.l2_nodes, ...r.l3_nodes]) {
      if (n.npc) {
        const questIds = n.quest ? [n.quest.id] : [];
        npcs.push({ id: `npc_${npcIdx++}`, name: n.npc.name, personality: n.npc.personality, locationRegion: r.id, locationNode: n.name, role: n.npc.role as WorldNPC["role"], relatedQuestIds: questIds });
      }
    }
  }

  // Extract flat side quest list from all nodes
  const sideQuests: QuestLine[] = [];
  for (const r of richRegions) {
    for (const n of [...r.l2_nodes, ...r.l3_nodes]) {
      if (n.quest) {
        sideQuests.push({ id: n.quest.id, title: n.quest.title, type: "side", synopsis: n.quest.brief, triggerRegion: r.id, stages: [{ locationHint: n.name, brief: n.quest.brief }] });
      }
    }
    if (r.l1_quest) {
      sideQuests.push({ id: r.l1_quest.id, title: r.l1_quest.title, type: "side", synopsis: r.l1_quest.brief, triggerRegion: r.id, stages: [{ locationHint: r.l1_name_cn, brief: r.l1_quest.brief }] });
    }
  }

  // Extract flat encounter list from all nodes
  const encounterPool: EncounterSeed[] = [];
  for (const r of richRegions) {
    for (const n of [...r.l2_nodes, ...r.l3_nodes]) {
      if (n.encounter) {
        encounterPool.push({ id: n.encounter.id, brief: n.encounter.brief, mood: (n.encounter.mood || "eerie") as EncounterSeed["mood"], locationTypes: [r.geography], locationNode: n.name });
      }
    }
  }

  // Main quest
  const mq = parsed.main_quest || {};
  const mainQuest: QuestLine = {
    id: mq.id || "mq",
    title: mq.title || "",
    type: "main",
    synopsis: mq.synopsis || "",
    triggerRegion: mq.trigger_region || richRegions[0]?.id || "",
    stages: (mq.stages || []).map((s: Record<string, string>) => ({
      locationHint: s.location_hint || "",
      brief: s.brief || "",
      unlockHint: s.unlock_hint || "",
    })),
  };

  // DM Dossier
  const dmRaw = parsed.dm_dossier || parsed.dmDossier || {};
  const dmDossier: import("./map-types").DMDossier = {
    hiddenTruth: dmRaw.hidden_truth || dmRaw.hiddenTruth || "",
    npcSecrets: dmRaw.npc_secrets || dmRaw.npcSecrets || {},
    foreshadowing: dmRaw.foreshadowing || [],
    plotTwist: dmRaw.plot_twist || dmRaw.plotTwist || "",
    endgame: dmRaw.endgame || "",
  };

  return {
    world: parsed.world,
    mapInput,
    richRegions,
    mainQuest,
    sideQuests,
    npcs,
    encounterPool,
    partyStats: {},
    dmDossier,
    personalSecrets: (parsed.personal_secrets as PersonalSecret[]) || [],
  };
}

// ═══════════════════════════════════════
// 2. Split Event System: DM + Character Reactions (separate LLM calls)
// ═══════════════════════════════════════

// ── 2a. DM Scene — generates narration + NPC lines + choices (DM knows secrets) ──

export const DEFAULT_DM_SCENE_PROMPT = `你是COC跑团的守秘人（KP）。你控制旁白和NPC，不替调查员（队伍成员）说话。平等对待所有成员，用名字称呼他们。

职责与流程（真正的跑团桌面流程）：
- 你的职责是报模组信息：这里有什么（环境、物品、痕迹）、NPC有谁、NPC说了什么做了什么、氛围如何
- 你可以给【暗示】（hints数组）：提示哪里可能值得留意（如"翻找书桌的文件""观察对方说谎的迹象"），但绝不替调查员决定行动
- hints 只指向本次叙述里已出现的可交互对象与可疑之处（叙述里摆了登记簿才能暗示翻看；NPC的小动作得先写出来才能暗示观察）——禁止暗示叙述中不存在的人/物/地点，禁止在hint里泄露答案本身
- 行动权完全在调查员手中：他们宣言做什么、用什么检定，由系统掷骰后你再演结果
- 若调查员宣言的行动在这个场景不合理（比如对没有机关的墙用锁匠），不要拒绝，而是裁定"似乎没有什么效果"——除非大成功，可以强行取得一点意外成果（发现别的线索之类）
- 这是克苏鲁神话跑团：恐怖与未知是主旋律，战斗是最后的手段，理智比生命更脆弱。

【人称规则·重要】
- 用户也是队伍成员之一，必须用 {{user}} 称呼用户，不要用"你"或"你们"指代用户。
- narration、npc_lines.text、choices.label、journal、world_events 这些会展示或传给角色AI的文本，都必须使用 {{user}}。
- stat_check.who 和 move_to 对象键如果指向用户，也使用 {{user}}。
- 需要指代全队时，写"队伍"、"众人"或列出名字，不要写"你们"。

【叙事节奏·最重要】
你是故事的导演，不只是场景描述器。你必须有意识地推进主线剧情，让故事走向结局：
- 看[进展]判断当前处于哪个阶段：
  · 前期（1-2阶段）：铺垫世界观，介绍关键NPC，埋下伏笔（从密档的foreshadowing中选），让玩家对真相产生好奇
  · 中期（3阶段左右）：开始揭示部分真相，触发反转（密档的plotTwist），NPC暴露隐藏面目，冲突升级
  · 后期（最后1-2阶段）：收束剧情，重要抉择，走向结局（密档的endgame），营造紧迫感
- 每个场景至少做一件推进剧情的事：给一条线索/引导玩家去下一个关键地点/让NPC暗示某个伏笔/揭示一个秘密
- 剧情前进靠叙述里埋的可疑细节与 hints 的方向暗示驱动，不靠选项
- 不要让玩家在同一个地方原地转圈——如果当前地点的调查已经完成，暗示他们该去哪里
【选项纪律·防剧透·核心】choices 数组通常留空 []；至多 1-2 个，且只能是"移动/离开/原地等待/撤退"这类元动作。禁止把调查/询问/搜查/检定做成选项——那是调查员自己宣言的事。禁止在选项文本中出现叙述里没写过的人名、物品名、地点名（玩家还没见到的东西出现在选项里=剧透）。你的引导职责全部由 hints 承担

【密档划账·防遗忘】
- 每轮输出 revealed 数组：把本轮你在叙述/NPC台词/私聊幕中**实际公开**的密档条目逐字摘录进去（来源：[密档]的真相/NPC秘密/伏笔/反转、[调查员秘密]、[调查员密档线]的事件）
- 下一轮你看到的密档总表里，已公开条目会标〔已公开〕——这些条目视为调查员已知信息：可以正常引用、展开后续，但**禁止再次当新信息卖出、禁止给出与公开内容矛盾的说法**
- 未标〔已公开〕的条目仍是暗牌——继续守口，不得在叙述里提前泄底
【线索与收尾】
- clues数组：本轮调查真正获得的关键线索，每条一句短句（系统会归档到线索板，按地点分类，全队可见）；没有新线索就留空[]
- investigation_done：当本地点能发现的东西已经全部给出、继续停留只会原地空转时设为true（系统会提示调查员转移地点，防止无意义重复调查）
- topics数组：与NPC对话的场景（事件类型为交谈）给出3-5个值得问的话题：label=问题方向（如"问起昨夜的动静"），skillHint=建议技能（话术/心理学/说服等）；非对话场景留空[]。topics 只能指向本场景已出场的NPC与叙述中已提及的事，禁止问还没人提过的人/物/事件
- advance=true表示当前主线阶段完成，请在关键剧情节点（获得关键线索/揭示重大真相/逃出险境）时设为true

【COC氛围与判定】
- 恐怖靠暗示而非血浆：不明声响、反常细节、旁人的欲言又止
- 暴力遭遇战是危险且往往致命的——逃走、躲避、求助通常比战斗更明智
- 检定（D100 ≤技能值/属性值=成功）：stat_check里优先写COC技能名，调查员拥有训练过的技能值（见[队伍状态]的技能列表），系统按技能值掷骰；没训练的技能按基础值掷
  · 技能示例：{"stat":"侦查"}、{"stat":"图书馆使用"}、{"stat":"心理学"}、{"stat":"潜行"}、{"stat":"手枪"}（用武器攻击时用手枪/小刀/拳击等对应技能）
  · 属性直检也可：力量str/体质con/意志pow/敏捷dex/幸运lck
  · 指定谁掷：stat_check里加who字段，如{"stat":"侦查","who":"{{user}}"}
  · 不指定who：系统随机抽一个人掷——选项描述必须是全队通用的
- 战斗伤害：系统会自动按武器伤害骰结算（含DB伤害加值），你在narration里描述伤口与后果即可，不必自己编伤害数字；lost里只报"SAN-N"等状态损耗
- SAN损失：目睹恐怖场景时在lost里用"SAN-5"（玩家）或"角色名:SAN-3"扣理智，配合narration描写恐惧与幻觉
- HP损失由系统按武器骰自动结算："HP-15"或"小雪:HP-10"仅在系统外需要额外扣血时使用（如坠落、咒术）
- 辅助检定（系统按钮触发，急救/意志清醒/精神分析，由队内数值最高者掷骰）：你会在对话流里看到结果（如"🤝 急救 · 小雪：成功 → HP+1"），叙述里承认这些效果；不要在选项里重复提供同类行动

【NPC扮演】
- NPC有自己的性格和秘密（见密档），对话要体现性格
- 有秘密的NPC：初期正常表现，中期言行出现矛盾暗示，后期可能暴露
- NPC之间也有关系和冲突，利用这些制造戏剧张力

【秘密团机制】（仅当上下文存在[调查员秘密]块时生效）
- 每位调查员都可能藏着个人秘密（内容见[调查员秘密]），他们是调查伙伴，不是敌人
- 你知道所有秘密。演出守秘密的人：言行有破绽（欲言又止、回避特定话题、偷偷做小动作），但不替他们摊牌
- 调查员宣言若涉及自己的秘密，按其宣言演出（他想公开就公开，想隐瞒你可以让NPC起疑但不当场揭穿）
- 知情NPC被单独问到相关话题时，可以给出秘密的补充信息（推进剧情），也可以试探反问
- 不要主动泄露任何调查员的秘密给他人——那是持有者的底牌，摊牌时机属于PL

【调查员密档线·开场与演出】（仅当上下文存在[调查员密档线]块时生效）
- [调查员密档线]里标注【这是{{user}}本人的线——开场第一幕必须以这条线的导入剧情为起点】的那条，是{{user}}本人绑定扮演的线
- 【开场纪律】对话历史为空/仅有开场寒暄时（即故事第一幕），你的场景叙事必须以该条线的导入剧情为起点：{{user}}的入团契机、与私人关系人的初遇、该线的第一个场景都取自这条导入剧情。绝不挪用其他未被标记的HO线的剧情当开场——那些线属于其他调查员，各走各的
- 每个成员绑定的线见 [调查员密档线] 各条标题后的（角色名）——演出涉及某角色时，用TA自己那条线的设定，不得张冠李戴
- 标〔已公开〕的个人线事件表示已经演过，不可重复演出

【分场演出】（仅当上下文存在[分场状态]块时生效）
- 队伍分散在不同地点时，narration 必须按场分段：每段开头用【场：地点名】标记，只写该场内的人和事
- 信息墙·铁律：A 场的人不知道 B 场发生的事——绝不把 B 场的所见所闻写进 A 场的段落；不同场的角色在场上相遇前互不知晓彼此的行动
- 各场并行推进，每场都要有内容（哪怕只是环境与不安）；最后一段用一两句写全队视角的时间流逝
- choices/hints 只针对 {{user}} 所在场

【私聊幕·KP导演】（仅当上下文存在[调查员秘密]块时生效）
- 场景里出现自然的私下契机时（某人被单独留下/主动避开众人/知情NPC欲言又止），在 side_scenes 数组输出最多1幕：{who:调查员名, npc:NPC名, intent:契机一句话, summary:这场私聊发生了什么（2-3句，你自己写）}
- who 可以是 {{user}} 或同伴名。私聊内容其他调查员不知道——summary 只进锁档，不当场公开
- 每轮最多1幕，没有合适契机就留空[]。不要为了私聊而私聊

【位置更新】如果剧情中队伍移动到了新地点，move_to必须填写目的地节点名（从地图节点中选）。不填则位置不变。

【演出资源】（仅当上下文存在[演出资源清单]时生效）
- cg字段：剧情走到清单中某张CG对应的场景时，填它的资源名（如"cg":"教堂_夜晚"）——前端会全屏展示这张图。一幕最多报1张CG，场景不匹配就留空""
- bgm字段：氛围发生明显切换时（紧张→舒缓、白天→夜晚、平静→恐怖），填BGM资源名。氛围没变就留空""（前端继续播上一首）
- 立绘不需要你输出——npc_lines里speaker的名字匹配到立绘时前端自动显示
- 只填资源名，绝不要描述图片/音乐内容，也不要编造清单里没有的资源名

【旁白排版】
- narration 必须按自然段分段书写。场景变化、人物动作、气氛描写、结果揭示之间要换段。
- 在 narration 字符串内部使用 \\n\\n 表示空行换段，不要把整段旁白挤成一整块。

【叙述与台词交织·重要】
- narration 与 npc_lines 不是"先描述后说话"的两段结构——演出必须交织：NPC 的台词嵌在叙述的相应位置
- 做法：在 narration 的对应位置写 〔NPC名：TA说的话〕（全角方括号+冒号），系统会把这里替换成该NPC的台词气泡；npc_lines 数组里则放同一句台词（speaker与text与标记一致），供其他系统使用
- 一个narration里可以嵌多个不同NPC的标记；对白前后的叙述段负责描写动作、神态、环境反应——像小说里对话与描写交替的节奏
- npc_lines 为空时，也可以只在 narration 里嵌台词标记

【叙述过程·强规则】
- 任何行动或检定的结果揭晓前，narration 必须先用 2-3 段描写过程：调查员如何动手、环境如何反应、气氛如何变化
- 禁止跳步：不要一句话直接给结果（如「你找到了日记」）。过程在先，结果在后。

【完结判定】当你觉得故事已经完美收束时，设ending:true。不要在剧情高潮时突然结束，要让故事自然落幕。

只输出JSON：
{"narration":"雨水沿着屋檐滴落，青石板路泛着冷光。\\n\\n酒馆门口的风铃轻轻晃动。〔老板：这么晚才来？就剩两间房了。〕他打量着来客，手指无意识地敲着柜台上那本翻开的住宿登记簿。","npc_lines":[{"speaker":"老板","text":"「这么晚才来？就剩两间房了。」他打量着来客，手指无意识地敲着登记簿。"}],"situation":"角色们看到的（传给角色AI）","cg":"","bgm":"","choices":[],"hints":[{"label":"翻看住宿登记簿","skillHint":"图书馆使用"},{"label":"观察老板的神色","skillHint":"心理学"},{"label":"留意屋外的动静","skillHint":"聆听"}],"topics":[{"label":"问起最近的怪事","skillHint":"话术"}],"clues":["登记簿上有一个被划掉的名字"],"revealed":["本轮你在叙述/NPC台词/私聊幕中公开的密档条目原文（从[密档]/[调查员密档线]里逐字摘录；没有公开任何密档就留空[]）"],"investigation_done":false,"journal":"这轮日志","gained":["获得的物品"],"lost":["使用/失去的物品或SAN-5"],"advance":false,"ending":false,"move_to":"如果移动了则填目的地节点名，否则留空","world_events":["此刻世界各处正在发生的事件，每条包含地点和事件描述，3-5条"]}`;

export type DMSceneResult = {
  narration: string;
  npcLines: { speaker: string; text: string }[];
  situation: string;
  choices: { label: string; statCheck?: { stat: string; who?: string }; requires?: string }[];
  hints?: { label: string; skillHint?: string }[];
  topics?: { label: string; skillHint?: string }[];
  clues?: string[];
  investigationDone?: boolean;
  sideScenes?: { who: string; npc: string; intent?: string; summary?: string }[];
  cg?: string;
  bgm?: string;
  journal: string;
  gained: string[];
  lost: string[];
  advance: boolean;
  moveTo: string | Record<string, string>;
  worldEvents: string[];
  ending?: boolean;
};

export type DMContext = {
  worldLore: string;
  currentLocation: string;
  eventType: string;
  eventBrief: string;
  npcName?: string;
  npcPersonality?: string;
  npcSecret?: string;
  companionNames: string[];
  playerName?: string;
  recentJournal: string[];
  keyChoices: string[];
  gameTime: string;
  dmDossier?: import("./map-types").DMDossier;
  director?: import("./map-types").StoryDirector;
  mainQuestSynopsis?: string;
  mainQuestStages?: { brief: string; result?: string }[];
  previousDialogue?: string;
  // Full world data (organized by region → node)
  richRegions?: import("./map-types").RichRegion[];
  sideQuestStatus?: Record<string, string>;
  mainQuestNodeMap?: Record<number, string>;
  // Current party status (so DM can design choices based on it)
  partyStatus?: {
    hp: number;
    maxHp: number;
    san?: number;
    items: string[];
    playerStats?: import("./map-types").CharStats;
    playerSheet?: import("./map-types").CharSheet;
    combat?: { round: number; initiative: string[]; currentIndex: number; hostiles: { name: string; dex: number; hp: number; maxHp: number; notes?: string }[] };
    madness?: { temporary?: { rounds: number; symptom: string }; permanent?: boolean };
    companions: { name: string; affinity: number; stats: import("./map-types").CharStats; status: string; sheet?: import("./map-types").CharSheet }[];
  };
  declarations?: import("./map-types").Declaration[];
  pacing?: "relaxed" | "normal" | "fast";
  // Fork: combat round + madness state (shown to KP)
  combat?: { round: number; initiative: string[]; currentIndex: number; hostiles: { name: string; dex: number; hp: number; maxHp: number; notes?: string }[] };
  madness?: { temporary?: { rounds: number; symptom: string }; permanent?: boolean };
  // Fork: KP narration style instruction (extracted from world lore 【KP风格指令】 block)
  kpStyle?: string;
  // Fork: CoC rules edition (6th/7th) — affects KP rule card wording & dice math
  rulesEdition?: RulesEdition;
  // Fork 八期A: secret-party — KP omniscience (all secrets, incl. who guards what)
  partySecrets?: { who: string; secret: PersonalSecret }[];
  // Fork: HO 密档——导入剧情/私人关系/个人线事件（KP全知；触发时走私聊幕隔离演出）
  investigatorLinesHint?: string;
  // Fork 八期B: locked private-talk log (for ending branch adjudication; formatted strings)
  lockedLogSummary?: string[];
  // Fork: 密档划账——已公开条目原文（注入密档时标〔已公开〕；KP 禁止重复卖出或矛盾表述）
  revealedDossier?: string[];
  // Fork 九期B: staged acts — current act + unlocked acts (later acts' truth NEVER enters the prompt)
  acts?: ModuleAct[];
  currentAct?: number;
  // Fork 九期B: discovered region ids (for map slimming; undefined = full map, legacy)
  discoveredRegionIds?: string[];
  // Fork 十期: stage asset manifest (names only — images/audio never enter prompts)
  assetManifest?: string;
  // Fork 十二期: player's module-era persona (KP narrates the player's era identity)
  playerPersona?: string;
  // Fork 拆场: party split — per-location groups; KP narrates each scene separately, no cross-scene leaks
  splitGroups?: { where: string; members: string[] }[];
};

/** Truncate an array of strings from the oldest, keeping newest within token budget */
function truncateByTokenBudget(items: string[], budget: number): string[] {
  if (budget <= 0) return items;
  let total = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    total += estimateTokens(items[i]) + 2;
    if (total > budget) return items.slice(i + 1);
  }
  return items;
}

function buildDMUserMsg(ctx: DMContext): string {
  const dm = ctx.dmDossier;
  const dir = ctx.director;
  const sqStatus = ctx.sideQuestStatus || {};
  const mqNodeMap = ctx.mainQuestNodeMap || {};
  const tokenConfig = loadDMTokenConfig();

  // Fork 九期B: map slimming — only regions the party has discovered (current + neighbors) enter the prompt
  const discoveredRegions = new Set<string>();
  if (ctx.richRegions && ctx.discoveredRegionIds && ctx.discoveredRegionIds.length > 0) {
    for (const r of ctx.richRegions) {
      if (ctx.discoveredRegionIds.includes(r.id)) {
        discoveredRegions.add(r.id);
        for (const adj of r.adjacent_to) discoveredRegions.add(adj);
      }
    }
  }
  // Build map section: region → nodes with content (slimmed when discovery info present)
  let mapBlock = "";
  if (ctx.richRegions) {
    const lines: string[] = [];
    for (const r of ctx.richRegions) {
      if (discoveredRegions.size > 0 && !discoveredRegions.has(r.id)) continue;
      lines.push(`\n## ${r.l1_name_cn}（${r.geography}）`);
      // L1 content
      const l1Parts: string[] = [];
      if (r.l1_npc) l1Parts.push(`NPC:${r.l1_npc.name}(${r.l1_npc.personality})`);
      if (r.l1_quest) l1Parts.push(`支线「${r.l1_quest.title}」[${sqStatus[r.l1_quest.id] || "未触发"}]`);
      // Check if main quest stage is here
      for (const [stageIdx, nodeName] of Object.entries(mqNodeMap)) {
        if (nodeName === r.l1_name_cn) l1Parts.push(`主线第${Number(stageIdx) + 1}阶段`);
      }
      if (l1Parts.length) lines.push(`- ${r.l1_name_cn}: ${l1Parts.join(" | ")}`);

      // L2 nodes
      for (const n of r.l2_nodes) {
        const parts: string[] = [];
        if (n.npc) parts.push(`${n.npc.role === "creature" ? "异象/怪物" : "NPC"}:${n.npc.name}(${n.npc.personality})`);
        if (n.quest) parts.push(`支线「${n.quest.title}」[${sqStatus[n.quest.id] || "未触发"}]—${n.quest.brief}`);
        if (n.encounter) parts.push(`偶遇:${n.encounter.brief}(${n.encounter.mood})`);
        for (const [stageIdx, nodeName] of Object.entries(mqNodeMap)) {
          if (nodeName === n.name) parts.push(`主线第${Number(stageIdx) + 1}阶段`);
        }
        lines.push(`- [L2]${n.name}: ${parts.join(" | ") || "无"}`);
      }
      // L3 nodes
      for (const n of r.l3_nodes) {
        const parts: string[] = [];
        if (n.npc) parts.push(`${n.npc.role === "creature" ? "异象/怪物" : "NPC"}:${n.npc.name}(${n.npc.personality})`);
        if (n.quest) parts.push(`支线「${n.quest.title}」[${sqStatus[n.quest.id] || "未触发"}]`);
        if (n.encounter) parts.push(`偶遇:${n.encounter.brief}(${n.encounter.mood})`);
        if (parts.length) lines.push(`- [L3]${n.name}: ${parts.join(" | ")}`);
      }
    }
    mapBlock = lines.join("\n");
  }

  // DM secrets + party secrets (fork 八期A — KP sees everything)
  const secretsBlock = ctx.partySecrets && ctx.partySecrets.length > 0 ? `\n[调查员秘密]（KP全知；其他人互不知晓）
${ctx.partySecrets.map(s => `${s.who}：${s.secret.content}（咬合点：${s.secret.link}${s.secret.informant ? `；知情者：${s.secret.informant}` : ""}）`).join("\n")}` : "";
  const lockedBlock = ctx.lockedLogSummary && ctx.lockedLogSummary.length > 0 ? `\n[锁档私聊]（发生过但其他调查员不知情的私下交谈）
${ctx.lockedLogSummary.join("\n")}` : "";
  // Fork: HO 密档块（导入剧情+个人线事件表；KP 按触发条件演出，隔离受众）
  const hoLinesBlock = ctx.investigatorLinesHint ? `\n[调查员密档线]（各HO的导入剧情与个人线——除本人外其他调查员不知道；事件按触发条件发生，发生时在side_scenes走私聊幕（who=该HO），不当众展开；标〔已公开〕的事件是已经发生过的——不可重演、后续必须与之保持一致）
${ctx.investigatorLinesHint}` : "";
  // Fork 十期: asset cue manifest (one page of names)
  const assetBlock = ctx.assetManifest ? `\n[演出资源清单]（只有名字；剧情对应时输出字段触发前端展示，绝不描述图片内容）
${ctx.assetManifest}` : "";
  // Fork 拆场: party-split state — where each group is, who's in it
  const splitBlock = ctx.splitGroups && ctx.splitGroups.length > 1 ? `\n[分场状态]（队伍分散——按场分段演出，信息墙：各场互不知晓，见【分场演出】）
${ctx.splitGroups.map(g => `- ${g.where}：${g.members.join("、")}`).join("\n")}` : "";
  // Fork: 密档划账——按 revealedDossier 给每条密档标〔已公开〕（KP 不得重复卖出/矛盾）
  const rv = ctx.revealedDossier || [];
  const markRv = (s: string) => rv.some(r => r && (s.includes(r.slice(0, 12)) || r.includes(s.slice(0, 12)))) ? "〔已公开〕" : "";
  const dmBlock = dm ? `${secretsBlock}${lockedBlock}${assetBlock}${hoLinesBlock}\n[密档]（标〔已公开〕的条目调查员已知——可引用可展开，禁止再当新信息卖出、禁止与已公开内容矛盾；未标注的仍是暗牌）
真相${markRv(dm.hiddenTruth)}：${dm.hiddenTruth}
${ctx.npcSecret ? `当前NPC秘密${markRv(ctx.npcSecret)}：${ctx.npcSecret}` : ""}
NPC秘密：${Object.entries(dm.npcSecrets).map(([k, v]) => `${k}→${v}${markRv(v)}`).join("；")}
伏笔：${dm.foreshadowing.filter(f => !dir?.plantedClues.includes(f)).map(f => `${f}${markRv(f)}`).join("、") || "无"}
反转${markRv(dm.plotTwist)}：${dm.plotTwist}
结局${markRv(dm.endgame)}：${dm.endgame}
${rv.length ? `已公开清单（已划账）：\n${rv.map(r => `- ${r}`).join("\n")}` : ""}` : "";

  // Story progress + narrative phase
  const totalStages = (ctx.mainQuestStages || []).length || 5;
  const currentStageNum = dir ? dir.mainArc.currentStage + 1 : 1;
  const narrativePhase = currentStageNum <= Math.ceil(totalStages * 0.4) ? "前期（铺垫+埋伏笔）" : currentStageNum <= Math.ceil(totalStages * 0.7) ? "中期（反转+冲突升级）" : "后期（收束+走向结局）";
  const journalCount = ctx.recentJournal.length;
  const completedStages = dir ? dir.mainArc.stageResults.length : 0;
  const roundsThisStage = completedStages > 0 ? Math.max(0, journalCount - Math.floor(journalCount * completedStages / Math.max(totalStages, 1))) : journalCount;
  const dirBlock = dir ? `\n[进展]
主线第${currentStageNum}阶段（共${totalStages}阶段）· 叙事阶段：${narrativePhase} · 当前阶段已进行约${roundsThisStage}轮
已完成：${dir.mainArc.stageResults.map(r => `${r.stage + 1}→${r.outcome}`).join("；") || "无"}
物品：${dir.keyItems.join("、") || "无"}
遇过NPC：${dir.keyNpcsMet.join("、") || "无"}
世界变化：${dir.worldChanges.join("、") || "无"}
已埋伏笔：${dir.plantedClues.join("、") || "无"}` : "";

  // Main quest stages
  // Fork 九期B: staged acts — inject ONLY current & prior acts (later acts are sealed)
  const actsBlock = ctx.acts && ctx.acts.length > 0 ? (() => {
    const cur = typeof ctx.currentAct === "number" ? Math.min(ctx.currentAct, ctx.acts.length - 1) : 0;
    const open = ctx.acts.slice(0, cur + 1).map(a => `第${a.index + 1}幕「${a.title}」：${a.summary}${a.nodes.length ? `（地点：${a.nodes.join("、")}）` : ""}`).join("\n");
    return `\n[分幕剧情·严格按幕推进]
当前：第${cur + 1}幕「${ctx.acts[cur]?.title || "?"}」（共${ctx.acts.length}幕，后续幕的剧情你尚不知晓，绝不提前演出后续幕内容）
已解锁的幕：
${open}
【转幕规则】本幕终局的 advance=true 时系统加载下一幕；你可以在本幕内口胡演出（NPC谎言、误导、临时事件），但不得提前揭示后续幕的真相、地点或怪物。未到场的剧情用「现在还去不了/人不在/门锁着」挡住`;
  })() : "";

  const questBlock = ctx.mainQuestSynopsis ? `\n[主线「${ctx.mainQuestSynopsis}」]
${(ctx.mainQuestStages || []).map((s, i) => {
    const marker = s.result ? "✅" : (dir && i === dir.mainArc.currentStage ? "←当前" : "");
    return `${i + 1}. [${(ctx.mainQuestNodeMap || {})[i] || "?"}] ${s.brief}${s.result ? `→${s.result}` : ""} ${marker}`;
  }).join("\n")}` : "";

  // Fork: game time-of-day atmosphere hint (scene generation follows the current time slot)
  const TIME_MOODS: Record<string, string> = {
    morning: "清晨——薄雾、湿冷的街道、刚睡醒的小镇，人们开始日常但心不在焉",
    afternoon: "午后——日光正盛，一切看起来过于正常，白天的调查多以走访、翻查档案为主",
    evening: "黄昏——光线渐暗，行人稀少，商店陆续打烊，调查开始染上不安的底色",
    night: "夜晚——黑暗是恐怖的放大器：视线受限、独行者、不该有的声响；夜里的检定更容易撞上真正的危险",
  };
  const timeBlock = ctx.gameTime.includes("清晨") ? `\n[时段氛围]${TIME_MOODS.morning}` : ctx.gameTime.includes("午后") ? `\n[时段氛围]${TIME_MOODS.afternoon}` : ctx.gameTime.includes("黄昏") ? `\n[时段氛围]${TIME_MOODS.evening}` : ctx.gameTime.includes("夜晚") ? `\n[时段氛围]${TIME_MOODS.night}` : "";

  const pacingHint = ctx.pacing === "relaxed" ? "\n叙事节奏：悠闲（多展开日常互动、支线、角色关系，不急着推主线。每个主线阶段至少经过16-20轮互动后才设advance=true，充分展开剧情和角色关系再推进）"
    : ctx.pacing === "fast" ? "\n叙事节奏：紧凑（积极推进主线，每个场景都往前赶。每个主线阶段经过5-6轮互动就可以advance=true）"
    : "\n叙事节奏：适中（每个主线阶段经过10-12轮互动后再设advance=true，平衡推进和探索）";

  // Fork: edition-specific KP rule card (7th: difficulty tiers, natural-1 crit, bonus/penalty dice, luck spend, pushed rolls)
  const is7 = ctx.rulesEdition === "coc7";
  const ruleExtra7 = is7 ? `\n【7版判定细则】
- 难度分级：常规≤技能值 / 困难≤÷2 / 极难≤÷5——系统掷骰时自动标注成功等级
- 大成功=天然骰出1；大失败：技能值<50时为96-100，≥50时仅100
- 闪避值=敏捷÷2；奖励骰/惩罚骰由玩家在掷骰时选择、系统自动掷（两粒D100取低/取高），对话流会标注
- 幸运补值：检定差一点成功时玩家可扣幸运值补足——流里标【幸运补值成功】的检定按成功处理
- 推动检定：一次检定失败后，玩家若能说明新的做法或理由，可重试一次（代价由你裁定：时间、噪音、SAN等）
- SAN损失可写两段式："SAN-1/1D6"（系统掷理智检定：成功扣前者，失败扣后者），固定值"SAN-5"仍可用` : "";

  return `# 世界：${ctx.worldLore}
${ctx.kpStyle ? `\n【叙述风格指令】（KP必须遵守）\n${ctx.kpStyle}\n` : ""}${mapBlock}
${dmBlock}${dirBlock}${actsBlock}${questBlock}${pacingHint}${splitBlock}

${ctx.combat ? `\n# 战斗轮
第${ctx.combat.round}轮 · 先攻顺序：${ctx.combat.initiative.join(" → ")}
当前行动：${ctx.combat.initiative[ctx.combat.currentIndex] || "—"}
敌方状态：${ctx.combat.hostiles.filter(h => h.hp > 0).map(h => `${h.name}(HP${h.hp}/${h.maxHp}${h.notes ? `，${h.notes}` : ""})`).join("、") || "已全灭"}
（战斗轮中：每人每轮1个行动。系统自动结算攻击骰与伤害骰并已推送结果；你负责描述攻击的场面与敌人的反扑，敌人攻击时在lost里扣玩家/角色HP）` : ""}
${ctx.madness?.permanent ? `\n【疯狂状态】{{user}}已永久疯狂（SAN归零）——其行动应表现为失控、呓语或彻底呆滞，由恐惧支配。`
  : ctx.madness?.temporary ? `\n【疯狂状态】{{user}}临时疯狂发作中（剩余${ctx.madness.temporary.rounds}轮）：${ctx.madness.temporary.symptom}——描述中体现该症状，其宣言可能不受理智控制，其余队员可以尝试约束/安抚。` : ""}

# 当前场景
地点：${ctx.currentLocation} · ${ctx.gameTime}${timeBlock}
事件：${ctx.eventType} — ${ctx.eventBrief}
${ctx.npcName ? `NPC：${ctx.npcName}（${ctx.npcPersonality}）` : ""}
队伍成员：{{user}}、${ctx.companionNames.join("、") || "无"}${ctx.playerPersona ? `\n{{user}}的模组内身份：${ctx.playerPersona}（叙述中按此身份称呼与对待{{user}}）` : ""}
（{{user}}是用户。所有输出里指代用户都必须写"{{user}}"，不要写"你"或"你们"；其余成员也用名字。不替任何成员说话。需要指代全队时写"队伍"或"众人"。）

# 队伍状态
${ctx.partyStatus ? `HP：${ctx.partyStatus.hp}/${ctx.partyStatus.maxHp}${typeof ctx.partyStatus.san === "number" ? `\nSAN：${ctx.partyStatus.san}/99` : ""}
物品栏：${ctx.partyStatus.items.join("、") || "空"}
玩家属性：${ctx.partyStatus.playerStats ? formatStats(ctx.partyStatus.playerStats) : "?"}
玩家职业：${ctx.partyStatus.playerSheet?.occupation || "调查员"} · 信用评级${ctx.partyStatus.playerSheet?.creditRating ?? "?"}${ctx.partyStatus.playerSheet?.weapons?.length ? ` · 武器：${ctx.partyStatus.playerSheet.weapons.map(w => `${w.name}(${w.damage})`).join("、")}` : ""}
玩家技能：${ctx.partyStatus.playerSheet ? Object.entries(ctx.partyStatus.playerSheet.skills).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([k, v]) => `${k}${v}`).join("/") : "无"}
${ctx.partyStatus.companions.map(c => `${c.name}：${c.sheet?.occupation || "调查员"} 好感${c.affinity} HP${"?"} ${formatStats(c.stats)}${c.sheet?.weapons?.length ? ` 武器:${c.sheet.weapons.map(w => `${w.name}(${w.damage})`).join("、")}` : ""}${c.status ? ` [${c.status}]` : ""}`).join("；")}` : "无数据"}

# 规则（COC${is7 ? "7" : "6"}版）${ruleExtra7}
属性（百分值）：力量str/体质con/意志pow/敏捷dex/外貌app/体型siz/智力int/教育edu/理智san/幸运lck。属性成长由系统自动处理，DM不要在gained里加属性。
HP：生命值，由体质与体型决定。DM根据剧情在lost里扣HP，格式"HP-15"（玩家）或"小雪:HP-10"（角色）。
SAN：理智值（0-99）。目睹恐怖、阅读禁书、直面神话存在都会扣SAN，格式"SAN-5"（玩家）或"小雪:SAN-3"（角色）。
疯狂判定（系统自动）：单场景SAN损失≥5 → 系统掷1D10轮临时疯狂（健忘/暴力/偏执/尖叫逃窜/歇斯底里/幻觉/木僵等），症状会显示在[疯狂状态]里，KP按症状描写其失控言行；SAN归零 → 永久疯狂，心智不再受控。同伴的SAN损失也会让他们陷入疯狂，由你描写。
属性扣减：受伤扣体质、惊吓扣意志等，格式如"体质-5"或"小雪:力量-3"。

掷骰判定结果（系统自动判定，DM必须严格遵守）：
- 大成功：任务超额完成，获得额外奖励或意外发现
- 困难成功：任务勉强完成，可能有小代价
- 成功：任务正常完成
- 失败：任务未完成，可能受伤扣HP、丢失物品、暴露位置
- 大失败：严重后果——重伤（扣大量HP）、物品损坏、触发危险或惊惧（额外扣SAN）
【重要】属性检定时，系统会随机选队伍中一个人掷骰，结果代表整个队伍的判定。根据掷骰结果（成功/失败/大成功/大失败）描述该行动对所有人的影响。

选项设计（防剧透纪律）：
- choices 通常留空 []；至多 1-2 个，只能是"移动/离开/原地等待/撤退"类元动作
- 禁止把调查/询问/搜查/检定做成选项；禁止在选项文本中出现叙述里没出现过的人名/物品名/地点名
- 偶尔确需检定型选项时（如岔路口的回避判定）才用 stat_check，如{"stat":"侦查"}；COC技能名会自动换算到对应属性；requires 物品同样只能是叙述里出现过/队伍已持有的东西
journal字段：用第三人称记录（用 {{user}} 而不是"我"或"你"）。
日志：${truncateByTokenBudget(ctx.recentJournal, tokenConfig.journalTokenBudget).join("；")}
${ctx.previousDialogue ? `\n对话历史：\n${truncateByTokenBudget(ctx.previousDialogue.split("\n"), tokenConfig.dialogueTokenBudget).join("\n")}` : ""}
${ctx.declarations?.length ? `\n# 本轮声明${ctx.splitGroups?.length ? `（当前分场：${ctx.splitGroups.map(g => `${g.where}→${g.members.join("、")}`).join("；")}）` : ""}\n${ctx.declarations.map(d => `${d.speaker}${d.splitTo ? `（离队前往：${d.splitTo}）` : ""}：\n  说：「${d.speech}」\n  做：${d.action}`).join("\n\n")}` : ""}`;
}

export async function dmScene(ctx: DMContext, apiConfig: ApiConfig): Promise<DMSceneResult> {
  const userMsg = buildDMUserMsg(ctx);
  const scenePrompt = getActivePrompt("scene", DEFAULT_DM_SCENE_PROMPT);
  const playerName = dmPlayerName(ctx);
  const messages = [
    { role: "system", content: renderUserNameMacro(scenePrompt, playerName) },
    { role: "user", content: renderUserNameMacro(userMsg, playerName) },
  ];
  dmLog("DM场景·发送", formatDebugMessages(messages, apiConfig));

  const result = await simpleLLMCall(apiConfig, messages, { temperature: 0.8 });

  dmLog("DM场景·返回", result.content ? `[${result.content.length}字] ${result.content}` : `[空] error=${result.error} finish=${result.finishReason} truncated=${result.wasTruncated}`);

  if (!result.content) {
    throw new Error(`DM调用失败: ${result.error || "返回空内容"}（模型: ${apiConfig.defaultModel}，finish: ${result.finishReason || "unknown"}）`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any;
  try {
    p = JSON.parse(extractJSON(result.content));
  } catch (e) {
    console.error("[DM] JSON parse failed. Raw:", result.content.slice(0, 500));
    throw new Error(`DM返回格式错误: ${(e as Error).message}\n原文前200字: ${result.content.slice(0, 200)}`);
  }
  return {
    narration: p.narration || "",
    npcLines: (p.npc_lines || p.npcLines || []).map((d: Record<string, string>) => ({
      speaker: d.speaker || "NPC", text: d.text || "",
    })),
    situation: p.situation || "",
    choices: (p.choices || [])
      // Fork: anti-spoiler filter — drop choices naming people/items/places absent from narration & NPC lines
      .filter((c: Record<string, unknown>) => {
        const label = String(c.label || "");
        if (!label) return false;
        const known = `${p.narration || ""}\n${(p.npc_lines || []).map((d: Record<string, string>) => `${d.speaker || ""}${d.text || ""}`).join("\n")}\n你|{{user}}|移动|离开|原地|等待|撤退|搜查周围|搜索|休息|扎营`;
        // Chinese names (2-4 chars, no punctuation) & quoted items — verify they were mentioned
        const suspects = label.match(/[一-龥]{2,4}(?=的|在|去|问|找|看|翻|查)/g) || [];
        const items = label.match(/[「“]([^」”]+)[」”]/g) || [];
        for (const s of [...suspects, ...items.map(i => i.slice(1, -1))]) {
          if (s && !known.includes(s)) return false;
        }
        return true;
      })
      .map((c: Record<string, unknown>) => ({
      label: (c.label as string) || "",
      ...(c.stat_check || c.statCheck ? {
        statCheck: (c.stat_check || c.statCheck) as { stat: string; who?: string },
      } : {}),
      ...(c.requires ? { requires: c.requires as string } : {}),
      })),
    journal: p.journal || p.journal_entry || "",
    gained: p.gained || p.items_gained || [],
    lost: p.lost || p.items_lost || [],
    advance: p.advance || p.advance_main_quest || false,
    moveTo: p.move_to ?? p.moveTo ?? "",
    worldEvents: (p.world_events || p.worldEvents || []).map((event: string) => String(event || "")),
    ending: p.ending || false,
    cg: typeof p.cg === "string" ? p.cg : "",
    bgm: typeof p.bgm === "string" ? p.bgm : "",
    hints: (p.hints || []).map((h: Record<string, unknown>) => ({
      label: String(h.label || ""),
      skillHint: h.skillHint ? String(h.skillHint) : (h.skill_hint ? String(h.skill_hint) : undefined),
    })).filter((h: { label: string }) => h.label),
    topics: (p.topics || []).map((t: Record<string, unknown>) => ({
      label: String(t.label || ""),
      skillHint: t.skillHint ? String(t.skillHint) : (t.skill_hint ? String(t.skill_hint) : undefined),
    })).filter((t: { label: string }) => t.label),
    clues: (p.clues || []).map((c: unknown) => String(c || "")).filter(Boolean),
    investigationDone: p.investigation_done || p.investigationDone || false,
    revealed: (p.revealed || []).filter((r: unknown) => typeof r === "string" && r.trim()),
    sideScenes: (p.side_scenes || p.sideScenes || []).map((s: Record<string, unknown>) => ({
      who: String(s.who || ""),
      npc: String(s.npc || ""),
      intent: s.intent ? String(s.intent) : undefined,
      summary: s.summary ? String(s.summary) : undefined,
    })).filter((s: { who: string; npc: string }) => s.who && s.npc),
  };
}

// ── 2b. Character Reaction — uses full preset system (character card + worldbook + memory) ──

export type CharacterReaction = {
  speaker: string;
  text: string;           // 角色的台词/反应
  emotion: string;
  action?: string;        // 角色决定做什么（选了哪个选项或自由行动）
};

export async function characterReact(
  characterId: string,
  situation: string,
  previousDialogue: string,
  _apiConfigFallback: ApiConfig,
  options?: {
    userChoice?: string;           // 用户刚做的选择
    availableChoices?: string[];   // DM 给出的选项列表
  },
): Promise<CharacterReaction> {
  const allChars = loadCharacters();
  const character = allChars.find(c => c.id === characterId);
  if (!character) return { speaker: characterId, text: "……", emotion: "neutral" };

  try {
    const bindings = loadBindingConfig();
    const slot = resolveBinding(bindings, characterId, "adventure");
    const allPresets = loadPresets();
    const preset = slot.presetId ? allPresets.find(p => p.id === slot.presetId) ?? allPresets.find(p => p.builtIn) ?? null : allPresets.find(p => p.builtIn) ?? null;
    const allWorldBooks = loadWorldBooks();
    const worldBooks = (slot.worldBookIds || []).map(id => allWorldBooks.find(w => w.id === id)).filter(Boolean) as typeof allWorldBooks;
    const allRegexes = loadRegexes();
    const regexes = (slot.regexIds || []).map(id => allRegexes.find(r => r.id === id)).filter(Boolean) as typeof allRegexes;
    const userIdentity = resolveUserIdentity(characterId, "adventure");
    const apiConfigs = loadApiConfigs();
    const apiConfig = slot.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) ?? _apiConfigFallback : _apiConfigFallback;
    const adventureConfig = loadAdventureInteractionConfig();

    // Build context for the character
    let historyContent = `[冒险梦境·当前场景]\n${situation}`;
    if (previousDialogue) historyContent += `\n\n${previousDialogue}`;
    if (options?.userChoice) historyContent += `\n\n{{user}}选择了：「${options.userChoice}」`;
    if (options?.availableChoices?.length) {
      historyContent += `\n\n你也可以从以下选项中选择，或者做别的事：\n${options.availableChoices.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;
    }
    historyContent += `\n\n请以你的身份：1)对当前情况说点什么 2)决定你要做什么（可以选选项、做别的事、或跟随{{user}}的选择）`;

    const history = [{ id: "adv_scene", sessionId: "", role: "user" as const, content: historyContent, status: "sent" as const, createdAt: new Date().toISOString() }];

    const llmMessages = assemblePromptPayload({
      character, history, preset, worldBooks, regexes, userIdentity, appId: "adventure",
      chatBilingualInstruction: buildAdventureCharacterBilingualInstruction(
        adventureConfig.bilingualTranslationEnabled === true,
        adventureConfig.bilingualTranslationPrompt,
      ),
    });

    const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, { characterName: character.name }, {
      appId: "adventure",
      appTags: ["adventure"],
    });

    if (!rawOutput) return { speaker: character.name, text: "……", emotion: "neutral" };

    // Try JSON parse first, fallback to plain text
    try {
      const p = JSON.parse(extractJSON(rawOutput));
      return { speaker: character.name, text: p.text || "……", emotion: p.emotion || "neutral", action: p.action || undefined };
    } catch {
      // If not JSON, use raw text as dialogue
      return { speaker: character.name, text: rawOutput.slice(0, 300), emotion: "neutral" };
    }
  } catch (e) {
    console.warn("[characterReact] Error:", e);
    return { speaker: character.name, text: "……", emotion: "neutral" };
  }
}

// ── 2c. Assemble full scene from DM + character reactions ──

/** DM-only call — returns scene without character reactions */
export async function expandEvent(
  ctx: DMContext,
  _companionIds: string[],  // kept for API compat, not used here
  apiConfig: ApiConfig,
): Promise<EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; dmSituation?: string; moveTo?: string | Record<string, string>;  worldEvents?: string[]; ending?: boolean }> {
  const dm = await dmScene(ctx, apiConfig);

  // Build dialogues from DM only (narrator + NPC)
  const dialogues: EventScene["dialogues"] = [];
  if (dm.narration) dialogues.push({ speaker: "narrator", text: dm.narration, emotion: "neutral" });
  for (const npc of dm.npcLines) dialogues.push({ ...npc, emotion: "neutral" });

  const npcsInvolved = dm.npcLines.map(n => n.speaker);

  return {
    background: "",
    dialogues,
    choices: dm.choices.map(c => ({
      label: c.label,
      ...(c.statCheck ? { statCheck: { stat: c.statCheck.stat as import("./map-types").StatKey, ...(c.statCheck.who ? { who: c.statCheck.who as string } : {}) } } : {}),
      ...(c.requires ? { requires: c.requires } : {}),
    })),
    hints: dm.hints,
    topics: dm.topics,
    clues: dm.clues,
    investigationDone: dm.investigationDone,
    sideScenes: dm.sideScenes,
    affinityDelta: {},
    journalEntry: dm.journal,
    unlocks: [],
    advanceMainQuest: dm.advance,
    completeSideQuest: undefined,
    gained: dm.gained,
    lost: dm.lost,
    npcsInvolved,
    dmSituation: dm.situation,
    moveTo: dm.moveTo,
    worldEvents: dm.worldEvents,
    ending: dm.ending,
    cg: dm.cg,
    bgm: dm.bgm,
  };
}

/** Trigger character reactions separately (call after DM scene is displayed) */
export async function triggerCharacterReactions(
  companionIds: string[],
  situation: string,
  previousDialogue: string,
  apiConfig: ApiConfig,
): Promise<{ speaker: string; text: string; emotion: string }[]> {
  return Promise.all(
    companionIds.map(cid => characterReact(cid, situation, previousDialogue, apiConfig))
  );
}

// ── 2d. Continue after player choice ──

export async function continueEvent(
  ctx: DMContext,
  choiceLabel: string,
  companionIds: string[],
  apiConfig: ApiConfig,
): Promise<EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; moveTo?: string | Record<string, string>;  worldEvents?: string[] }> {
  const continueCtx: DMContext = {
    ...ctx,
    previousDialogue: `${ctx.previousDialogue || ""}\n玩家选择了：「${choiceLabel}」`,
  };
  return expandEvent(continueCtx, companionIds, apiConfig);
}

// ── 2e. Companion Declaration (Collect-Resolve-Narrate loop) ──

export async function companionDeclare(
  characterId: string,
  _apiConfigFallback: ApiConfig,
  streamLog?: import("./map-types").StreamMessage[],
  overrideUserIdentity?: import("../components/settings/user-identity").UserIdentity | null,
  overrideAffinity?: number,
  options?: { instruction?: string; secretHint?: string; personaHint?: string; memoryHint?: string },
): Promise<Declaration> {
  const allChars = loadCharacters();
  const character = allChars.find(c => c.id === characterId);
  if (!character) return { speaker: characterId, speech: "……", action: "沉默不动", emotion: "neutral" };

  try {
    const { apiConfig, preset, regexes, llmMessages } = await buildCompanionDeclarePromptPayload(
      characterId,
      _apiConfigFallback,
      streamLog,
      overrideUserIdentity,
      overrideAffinity,
      options,
    );

    // Debug: log the full prompt sent to character
    dmLog(`角色·${character.name}·发送`, llmMessages.map((m, i) => `[${i}] ${m.role}: ${typeof m.content === "string" ? m.content : "(multipart)"}`).join("\n\n"));

    const rawOutput = await sendLLMRequest(apiConfig, preset, llmMessages, regexes, { characterName: character.name }, {
      appId: "adventure",
      appTags: ["adventure"],
    });

    dmLog(`角色·${character.name}·返回`, rawOutput || "(空)");

    if (!rawOutput) return { speaker: character.name, speech: "……", action: "沉默不动", emotion: "neutral", failed: true };

    try {
      const p = JSON.parse(extractJSON(rawOutput));
      return {
        speaker: character.name,
        speech: p.speech || p.text || "……",
        action: p.action || "跟随队伍",
        emotion: p.emotion || "neutral",
        skillCheck: p.skill_check || p.skillCheck || undefined,
        splitTo: (p.split_to || p.splitTo) ? String(p.split_to || p.splitTo) : undefined,
        affinityDelta: typeof p.affinity === "number" ? Math.max(-3, Math.min(3, Math.round(p.affinity))) : 0,
      };
    } catch {
      // Fallback: parse RP-style "(动作)台词" or "*动作*台词" format
      const text = rawOutput.slice(0, 1500).trim();
      const rpMatch = text.match(/^[（(](.+?)[）)](.+)/s) || text.match(/^\*(.+?)\*(.+)/s);
      if (rpMatch) {
        return { speaker: character.name, speech: rpMatch[2].trim(), action: rpMatch[1].trim(), emotion: "neutral" };
      }
      // Pure dialogue — no action extracted
      return { speaker: character.name, speech: text, action: "跟随队伍", emotion: "neutral" };
    }
  } catch (e) {
    console.warn("[companionDeclare] Error:", e);
    return { speaker: character.name, speech: "……", action: "沉默不动", emotion: "neutral", failed: true };
  }
}

async function buildCompanionDeclarePromptPayload(
  characterId: string,
  apiConfigFallback?: ApiConfig | null,
  streamLog?: import("./map-types").StreamMessage[],
  overrideUserIdentity?: import("../components/settings/user-identity").UserIdentity | null,
  overrideAffinity?: number,
  options?: { instruction?: string; secretHint?: string; personaHint?: string; memoryHint?: string },
) {
  const allChars = loadCharacters();
  const character = allChars.find(c => c.id === characterId);
  if (!character) throw new Error("角色不存在");

  const bindings = loadBindingConfig();
  const slot = resolveBinding(bindings, characterId, "adventure");
  const globalSlot = resolveBinding(bindings, undefined, "adventure");
  const allPresets = loadPresets();
  const preset = slot.presetId ? allPresets.find(p => p.id === slot.presetId) ?? allPresets.find(p => p.builtIn) ?? null : allPresets.find(p => p.builtIn) ?? null;
  const allWorldBooks = loadWorldBooks();
  const worldBooks = (slot.worldBookIds || []).map(id => allWorldBooks.find(w => w.id === id)).filter(Boolean) as typeof allWorldBooks;
  const allRegexes = loadRegexes();
  const regexes = (slot.regexIds || []).map(id => allRegexes.find(r => r.id === id)).filter(Boolean) as typeof allRegexes;
  const userIdentity = overrideUserIdentity !== undefined ? overrideUserIdentity : resolveUserIdentity(characterId, "adventure");
  const apiConfigs = loadApiConfigs();
  const globalApiConfig = globalSlot.apiConfigId ? apiConfigs.find(c => c.id === globalSlot.apiConfigId) ?? null : null;
  const fallback = apiConfigFallback ?? globalApiConfig ?? apiConfigs.find(c => c.apiKey) ?? apiConfigs[0] ?? null;
  const apiConfig = slot.apiConfigId ? apiConfigs.find(c => c.id === slot.apiConfigId) ?? fallback : fallback;
  if (!apiConfig) throw new Error("未找到可用的 API 配置");
  const adventureConfig = loadAdventureInteractionConfig();

  // Fork 八期B: audience isolation — companions never see locked private talks (user's or others')
  const filteredLog = (streamLog || []).filter(m => m.type !== "system" && m.type !== "divider" && m.type !== "ooc" && m.type !== "declCard" && !(m.audience && m.audience.includes("locked")));
  // Fork: declCard → readable line for LLM context (the card itself has empty text)
  const describeMsgForLLM = (m: import("./map-types").StreamMessage): string => {
    if (m.type === "declCard" && m.decl) {
      const d = m.decl;
      const parts = [
        d.say ? `说：「${d.say}」` : "",
        d.do ? `做：${d.do}` : "",
        d.dice ? `（宣言检定 ${d.dice.skill}${d.dice.value}：D100=${d.dice.roll}，结果由你演出）` : "",
      ].filter(Boolean).join(" ");
      return `${d.who}: ${parts}`;
    }
    return m.speaker ? `${m.speaker}: ${m.text}` : m.text;
  };
  const pastHistory: import("./chat-storage").ChatMessage[] = filteredLog.map((m, i) => ({
    id: m.id || `sl_${i}`,
    sessionId: "",
    role: (m.type === "player" ? "user" : "assistant") as "user" | "assistant",
    content: describeMsgForLLM(m),
    status: "sent" as const,
    createdAt: new Date(Date.now() - (filteredLog.length - i) * 1000).toISOString(),
  }));

  const historyContent = renderUserNameMacro(
    options?.instruction?.trim() || `现在轮到你了。按照跑团流程宣言你这一轮的行动：
1) 说：你想说的话（对队友/NPC/自言自语；也可以不说话）
2) 做：你的行动宣言（调查、搜索、攀爬、攻击、跟随、原地观察……任选；也可以只是听和想，不行动）
3) 如果你的行动需要检定，在skill_check字段写你用的技能名（侦查/聆听/图书馆使用/心理学/潜行/手枪/急救等，或属性名如意志/幸运）；不需要检定就留空
4) 想清楚你为什么这么做——按你的人设和当前处境行动，不要人云亦云
5) 若你决定离开队伍单独行动（去别的地方调查、单独去找某人、深夜独自外出……），在 split_to 字段写目的地名称——你会离队前往那里，那边的遭遇只有你自己知道；split_to 留空 = 留在队伍里行动

【宣而不演·铁律】你只宣告意图，绝不演出结果：
- 只说"我要翻开那本登记簿查昨夜的记录"，绝不说"翻开后我发现……"——结果由 KP 在所有人宣言后统一演出
- 即使你在对话流里看到某次检定的骰点（那是别人的宣言），你也不知道结果内容——你的宣言里禁止出现任何"发现/得知/看到"的结果性描述
- speech 同理：可以表达怀疑、猜测、打算（"这登记簿有点不对劲，我看看"），不可以宣布结论（"登记簿被涂改过了"）`,
    userIdentity?.name,
  );
  let historyContentFinal = options?.secretHint?.trim()
    ? `${historyContent}\n\n${options.secretHint.trim()}`
    : historyContent;
  // Fork 十一期: module-era persona overrides the raw card (时代职业/背景/性格保持)
  if (options?.personaHint?.trim()) {
    historyContentFinal = `${options.personaHint.trim()}\n\n${historyContentFinal}`;
  }
  // Fork 十二期: companion remembers their OWN private talks (others' stay hidden)
  if (options?.memoryHint?.trim()) {
    historyContentFinal = `${options.memoryHint.trim()}\n\n${historyContentFinal}`;
  }
  const history = [
    ...pastHistory,
    { id: "adv_declare", sessionId: "", role: "user" as const, content: historyContentFinal, status: "sent" as const, createdAt: new Date().toISOString() },
  ];

  const { recentBlocks, truncatedHistory, wbActivationContext, unifiedRecentItems } = prepareShortTermContext(
    characterId, "adventure", { history, userName: userIdentity?.name }
  );

  const memConfig = loadMemoryConfig();
  const [memResults, coreResults] = await Promise.all([
    retrieveMemoriesForPrompt(characterId, wbActivationContext, memConfig).catch(() => null),
    retrieveCoreMemoriesForPrompt(characterId, memConfig).catch(() => null),
  ]);
  const longTermMemories = memResults ? formatLongTermMemories(memResults) : "";
  const coreMemories = coreResults ? formatCoreMemories(coreResults) : "";
  const scheduleSummary = buildCalendarScheduleMarker("character", characterId, getWeekStartIso(new Date()));

  const llmMessages = assemblePromptPayload({
    character, history: truncatedHistory, preset, worldBooks, regexes, userIdentity, appId: "adventure",
    longTermMemories, coreMemories, scheduleSummary,
    recentBlocks, unifiedRecentItems, worldBookActivationContext: wbActivationContext,
    affinity: overrideAffinity !== undefined ? String(overrideAffinity) : undefined,
    chatBilingualInstruction: buildAdventureCharacterBilingualInstruction(
      adventureConfig.bilingualTranslationEnabled === true,
      adventureConfig.bilingualTranslationPrompt,
    ),
  });

  return { character, apiConfig, preset, regexes, llmMessages };
}

export async function previewAdventureCompanionPromptPayload(
  characterId: string,
  streamLog?: import("./map-types").StreamMessage[],
  overrideUserIdentity?: import("../components/settings/user-identity").UserIdentity | null,
  overrideAffinity?: number,
  options?: { instruction?: string },
): Promise<{ messages: LLMMessage[]; characterName: string; model: string; presetName: string }> {
  const { character, apiConfig, preset, llmMessages } = await buildCompanionDeclarePromptPayload(
    characterId,
    undefined,
    streamLog,
    overrideUserIdentity,
    overrideAffinity,
    options,
  );
  return {
    messages: previewMessagesForApi(apiConfig, preset, llmMessages),
    characterName: `冒险:${character.name}`,
    model: apiConfig.defaultModel,
    presetName: preset?.name ?? "默认预设",
  };
}

// ── 2f. DM Resolve — resolves all declarations together ──

export const DEFAULT_DM_RESOLVE_PROMPT = `你是COC跑团的守秘人（KP）。这是裁定阶段——所有调查员已宣言本轮行动。平等对待所有成员，所有成员都用名字称呼。

你需要：
0. 掷骰结果已由系统在对话流中给出（每人宣言自己的检定，各自掷各自的）——你只负责按已掷出的结果演结果，不要虚构新的掷骰或重掷
1. 根据每个人的宣言描述结果（成功/失败/意外后果）
2. NPC对所有角色的回应（有人说话了就要回应）
3. 角色之间的互动呼应
4. 推进主线调查（不要让剧情停滞！但也不要替用户做决定，必须尊重用户决策！）
5. 给出推动故事前进的选项

注意：每个角色的宣言只是"意图"，实际结果由你裁定。你要把所有人的行动编织成一段连贯的叙事。

【人称规则·重要】
- 用户也是队伍成员之一，必须用 {{user}} 称呼用户，不要用"你"或"你们"指代用户。
- narration、npc_lines.text、choices.label、journal、world_events 这些会展示或传给角色AI的文本，都必须使用 {{user}}。
- stat_check.who 和 move_to 对象键如果指向用户，也使用 {{user}}。
- 需要指代全队时，写"队伍"、"众人"或列出名字，不要写"你们"。

【叙事节奏·最重要】
裁定不只是描述"发生了什么"，更要推动"接下来会怎样"：
- 每次裁定至少推进一步剧情：发现新线索/揭示部分真相/NPC关系变化/地图新区域解锁
- 看[进展]判断节奏：前期多埋伏笔、中期触发反转升级冲突、后期收束走向结局
- 裁定结果要有后果——选择和行动应该影响后续剧情走向，不要每次都"安全度过"
- advance=true：在完成主线阶段的关键事件时设为true（获得关键线索/揭示重大真相/逃出险境）
- 选项设计：至少一个选项与主线相关，引导玩家前往下一个关键地点或面对关键抉择

【位置更新】move_to字段：
- 全员一起移动 → 字符串："图书馆"
- 分头行动 → 对象：{"{{user}}":"图书馆","谢长安":"废弃宅邸"}（用户也用 {{user}}，其他用角色名）
- 没人移动 → 留空""
- 如果队伍分散在不同地点，narration中按地点分段描述各自的经历。

【COC判定】选项可以带stat_check，系统按技能值/属性值掷D100（≤值=成功）：
- 优先写COC技能名：侦查/聆听/图书馆使用/心理学/潜行/话术/急救/手枪/小刀/拳击……调查员训练过的技能有自己的技能值，系统按它掷骰
- 属性直检也可：力量str/体质con/意志pow/敏捷dex/幸运lck
- 指定谁掷：stat_check里加who，如{"stat":"话术","who":"{{user}}"}——用于只适合特定人的行动
- 不指定who：随机抽人掷——选项描述必须全队通用
- 战斗伤害：系统自动按武器伤害骰结算（含DB），narration只描述后果
- SAN损失：lost里用"SAN-5"或"角色名:SAN-3"扣理智，配合恐惧描写

【旁白排版】
- narration 必须按自然段分段书写。场景变化、人物动作、气氛描写、结果揭示之间要换段。
- 在 narration 字符串内部使用 \\n\\n 表示空行换段，不要把整段旁白挤成一整块。

【叙述与台词交织·重要】
- narration 与 npc_lines 不是"先描述后说话"的两段结构——演出必须交织：NPC 的台词嵌在叙述的相应位置
- 做法：在 narration 的对应位置写 〔NPC名：TA说的话〕（全角方括号+冒号），系统会把这里替换成该NPC的台词气泡；npc_lines 数组里则放同一句台词（speaker与text与标记一致），供其他系统使用
- 一个narration里可以嵌多个不同NPC的标记；对白前后的叙述段负责描写动作、神态、环境反应——像小说里对话与描写交替的节奏

【叙述过程·强规则】
- 本轮宣言的裁定必须先有过程：narration 用 2-3 段描写每位调查员如何行动、环境与 NPC 如何反应，最后才揭示各自的结果
- 禁止跳步：不要「某人成功了，拿到了线索」式的直陈结果。过程在先，结果在后
- 掷骰结果已由系统给出，按结果演出即可——但演出要丰满，不能因为结果已定就省略过程描写

【线索与收尾】
- clues数组：本轮调查真正获得的关键线索（每条一句短句，系统归档到线索板供全队随时翻看）；没有新线索留空[]
- investigation_done：本地点能查的都查完、停留已无意义时设为true（系统会提示调查员转移）
- topics数组：若场景里NPC在场且值得追问，给出3-5个话题（label=问题方向，skillHint=建议技能）；没有就留空[]

【完结判定】当你觉得故事已经完美收束时，设ending:true。不要在剧情高潮时突然结束，要让故事自然落幕。

只输出JSON：
{"narration":"火光在墙上跳了两下，照得每个人的神情都忽明忽暗。\\n\\n队伍各自的行动在同一刻撞在一起，让原本僵持的局势突然松动。\\n\\n门外传来的脚步声，说明新的变化已经逼近。","npc_lines":[{"speaker":"NPC名","text":"台词"}],"situation":"新局势描述","choices":[{"label":"小心地调查声音来源","stat_check":{"stat":"聆听"}},{"label":"{{user}}镇定地与警察周旋","stat_check":{"stat":"话术","who":"{{user}}"}},{"label":"直接离开"}],"journal":"日志","gained":["获得物品"],"lost":["失去物品或SAN-3"],"clues":["新获得的关键线索"],"revealed":["本轮公开的密档条目原文（逐字摘录；无则留空[]）"],"topics":[],"investigation_done":false,"side_scenes":[],"advance":false,"ending":false,"move_to":"节点名 或 {\"{{user}}\":\"节点名\",\"角色名\":\"节点名\"}","world_events":["世界各处事件"]}`;

async function dmResolve(ctx: DMContext, apiConfig: ApiConfig): Promise<DMSceneResult> {
  const userMsg = buildDMUserMsg(ctx);
  const resolvePrompt = getActivePrompt("resolve", DEFAULT_DM_RESOLVE_PROMPT);
  const playerName = dmPlayerName(ctx);
  const messages = [
    { role: "system", content: renderUserNameMacro(resolvePrompt, playerName) },
    { role: "user", content: renderUserNameMacro(userMsg, playerName) },
  ];
  dmLog("DM裁决·发送", formatDebugMessages(messages, apiConfig));

  const result = await simpleLLMCall(apiConfig, messages, { temperature: 0.8 });

  dmLog("DM裁决·返回", result.content ? `[${result.content.length}字] ${result.content}` : `[空] error=${result.error}`);

  if (!result.content) {
    throw new Error(`DM裁决失败: ${result.error || "返回空内容"}`);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any;
  try {
    p = JSON.parse(extractJSON(result.content));
  } catch (e) {
    throw new Error(`DM裁决格式错误: ${(e as Error).message}`);
  }
  return {
    narration: p.narration || "",
    npcLines: (p.npc_lines || p.npcLines || []).map((d: Record<string, string>) => ({
      speaker: d.speaker || "NPC", text: d.text || "",
    })),
    situation: p.situation || "",
    choices: (p.choices || [])
      // Fork: anti-spoiler filter — drop choices naming people/items/places absent from narration & NPC lines
      .filter((c: Record<string, unknown>) => {
        const label = String(c.label || "");
        if (!label) return false;
        const known = `${p.narration || ""}\n${(p.npc_lines || []).map((d: Record<string, string>) => `${d.speaker || ""}${d.text || ""}`).join("\n")}\n你|{{user}}|移动|离开|原地|等待|撤退|搜查周围|搜索|休息|扎营`;
        // Chinese names (2-4 chars, no punctuation) & quoted items — verify they were mentioned
        const suspects = label.match(/[一-龥]{2,4}(?=的|在|去|问|找|看|翻|查)/g) || [];
        const items = label.match(/[「“]([^」”]+)[」”]/g) || [];
        for (const s of [...suspects, ...items.map(i => i.slice(1, -1))]) {
          if (s && !known.includes(s)) return false;
        }
        return true;
      })
      .map((c: Record<string, unknown>) => ({
      label: (c.label as string) || "",
      ...(c.stat_check || c.statCheck ? {
        statCheck: (c.stat_check || c.statCheck) as { stat: string; who?: string },
      } : {}),
      ...(c.requires ? { requires: c.requires as string } : {}),
      })),
    journal: p.journal || p.journal_entry || "",
    gained: p.gained || p.items_gained || [],
    lost: p.lost || p.items_lost || [],
    advance: p.advance || p.advance_main_quest || false,
    moveTo: p.move_to ?? p.moveTo ?? "",
    worldEvents: (p.world_events || p.worldEvents || []).map((event: string) => String(event || "")),
    ending: p.ending || false,
    cg: typeof p.cg === "string" ? p.cg : "",
    bgm: typeof p.bgm === "string" ? p.bgm : "",
    topics: (p.topics || []).map((t: Record<string, unknown>) => ({
      label: String(t.label || ""),
      skillHint: t.skillHint ? String(t.skillHint) : (t.skill_hint ? String(t.skill_hint) : undefined),
    })).filter((t: { label: string }) => t.label),
    clues: (p.clues || []).map((c: unknown) => String(c || "")).filter(Boolean),
    investigationDone: p.investigation_done || p.investigationDone || false,
    revealed: (p.revealed || []).filter((r: unknown) => typeof r === "string" && r.trim()),
    sideScenes: (p.side_scenes || p.sideScenes || []).map((s: Record<string, unknown>) => ({
      who: String(s.who || ""),
      npc: String(s.npc || ""),
      intent: s.intent ? String(s.intent) : undefined,
      summary: s.summary ? String(s.summary) : undefined,
    })).filter((s: { who: string; npc: string }) => s.who && s.npc),
  };
}

export async function resolveRound(
  ctx: DMContext,
  declarations: Declaration[],
  apiConfig: ApiConfig,
): Promise<EventScene & { gained?: string[]; lost?: string[]; npcsInvolved?: string[]; dmSituation?: string; moveTo?: string | Record<string, string>;  worldEvents?: string[]; ending?: boolean }> {
  const resolveCtx: DMContext = { ...ctx, declarations };
  const dm = await dmResolve(resolveCtx, apiConfig);

  const dialogues: EventScene["dialogues"] = [];
  if (dm.narration) dialogues.push({ speaker: "narrator", text: dm.narration, emotion: "neutral" });
  for (const npc of dm.npcLines) dialogues.push({ ...npc, emotion: "neutral" });

  return {
    background: "",
    dialogues,
    choices: dm.choices.map(c => ({
      label: c.label,
      ...(c.statCheck ? { statCheck: { stat: c.statCheck.stat as import("./map-types").StatKey, ...(c.statCheck.who ? { who: c.statCheck.who as string } : {}) } } : {}),
      ...(c.requires ? { requires: c.requires } : {}),
    })),
    affinityDelta: {},
    journalEntry: dm.journal,
    unlocks: [],
    advanceMainQuest: dm.advance,
    gained: dm.gained,
    lost: dm.lost,
    npcsInvolved: dm.npcLines.map(n => n.speaker),
    dmSituation: dm.situation,
    moveTo: dm.moveTo,
    worldEvents: dm.worldEvents,
    ending: dm.ending,
    cg: dm.cg,
    bgm: dm.bgm,
    topics: dm.topics,
    clues: dm.clues,
    investigationDone: dm.investigationDone,
    sideScenes: dm.sideScenes,
  };
}

// ── 3. Game Logic Helpers ──

/** Check if a stat check passes */
/** d100 roll against a stat value (CoC-style) */
export function rollD100(statValue: number, edition: "coc6" | "coc7" = "coc6"): { roll: number; level: "crit" | "hard" | "success" | "fail" | "fumble" } {
  const roll = Math.floor(Math.random() * 100) + 1; // 1-100
  if (edition === "coc7") {
    // 7th: crit = natural 1; fumble = 96-100 (<50) / 100 (≥50); difficulty tiers by value
    if (roll === 1) return { roll, level: "crit" };                           // 大成功（天然1）
    if (roll <= Math.floor(statValue / 2)) return { roll, level: "hard" };     // 困难成功
    if (roll <= statValue) return { roll, level: "success" };                   // 成功
    if (roll >= (statValue < 50 ? 96 : 100)) return { roll, level: "fumble" };  // 大失败
    return { roll, level: "fail" };                                              // 失败
  }
  if (roll <= Math.floor(statValue / 5)) return { roll, level: "crit" };     // 极难成功（大成功）
  if (roll <= Math.floor(statValue / 2)) return { roll, level: "hard" };     // 困难成功
  if (roll <= statValue) return { roll, level: "success" };                   // 成功
  if (roll > 95) return { roll, level: "fumble" };                            // 大失败
  return { roll, level: "fail" };                                              // 失败
}

/** Resolve a stat_check target: accept a CoC6 attribute key (en/cn) or a skill name
 *  (侦查/聆听/图书馆使用/…) and return a canonical StatKey. Falls back to int. */
export function resolveCheckStat(raw: string): { key: import("./map-types").StatKey; label: string } {
  const trimmed = (raw || "").trim().toLowerCase();
  const enKeyMap: Record<string, import("./map-types").StatKey> = {
    str: "str", con: "con", pow: "pow", dex: "dex", app: "app", siz: "siz", int: "int", edu: "edu", san: "san", lck: "lck",
    // legacy 7-stat keys → CoC6 mapping (old saves / DM habits)
    per: "int", cha: "app",
  };
  const cnKeyMap: Record<string, import("./map-types").StatKey> = {
    力量: "str", 体质: "con", 意志: "pow", 敏捷: "dex", 外貌: "app", 体型: "siz", 智力: "int", 教育: "edu", 理智: "san", 幸运: "lck",
    感知: "int", 魅力: "app",
  };
  if (enKeyMap[trimmed]) return { key: enKeyMap[trimmed], label: STAT_LABELS[enKeyMap[trimmed]] };
  if (cnKeyMap[trimmed]) return { key: cnKeyMap[trimmed], label: STAT_LABELS[cnKeyMap[trimmed]] };
  if (SKILL_STAT_HINT[trimmed]) {
    const key = SKILL_STAT_HINT[trimmed];
    return { key, label: `${raw}(${STAT_LABELS[key]})` };
  }
  return { key: "int", label: `${raw}(智力)` };
}

export const ROLL_LABELS: Record<string, string> = {
  crit: "大成功!", hard: "困难成功", success: "成功", fail: "失败", fumble: "大失败!",
};

/** Get adjacent nodes for a given node */
export function getAdjacentNodeIds(
  currentNodeId: string,
  renderedMap: import("./map-engine").MapGenerationOutput,
): string[] {
  const allNodes = [
    ...renderedMap.l1Nodes.map(n => n.id),
    ...renderedMap.l2Nodes.map((_, i) => `l2_${i}`),
    ...renderedMap.l3Nodes.map((_, i) => `l3_${i}`),
  ];
  // For now, adjacent = trunk + branch connections
  // This will be refined when we connect map data properly
  return allNodes.filter(id => id !== currentNodeId);
}

/** Determine what time period advances to after an action */
export function advanceTime(current: GameSave["gameTime"], steps: number = 1): { time: GameSave["gameTime"]; newDay: boolean } {
  const order: GameSave["gameTime"][] = ["morning", "afternoon", "evening", "night"];
  const idx = order.indexOf(current);
  const newIdx = idx + steps;
  const newDay = newIdx >= order.length;
  return {
    time: order[newIdx % order.length],
    newDay,
  };
}

/** Calculate AP cost for moving between nodes */
export function getMoveCost(fromType: string, toType: string): number {
  if (toType === "l1") return 1;
  if (toType === "l2") return 2;
  return 3; // l3 remote locations cost more
}

/** Check if an encounter triggers (random roll) */
export function shouldTriggerEncounter(onPath: boolean): boolean {
  const chance = onPath ? 0.15 : 0.20;
  return Math.random() < chance;
}

/** Pick a random unused encounter that fits the location */
export function pickEncounter(
  pool: EncounterSeed[],
  usedIds: string[],
  geography?: string,
): EncounterSeed | null {
  const available = pool.filter(e =>
    !usedIds.includes(e.id) &&
    (e.locationTypes.includes("any") || !geography || e.locationTypes.includes(geography))
  );
  if (available.length === 0) return null;
  return available[Math.floor(Math.random() * available.length)];
}

/** Format game time for display */
export function formatGameTime(day: number, time: GameSave["gameTime"]): string {
  const timeLabels: Record<string, string> = {
    morning: "清晨",
    afternoon: "午后",
    evening: "黄昏",
    night: "夜晚",
  };
  return `第${day}天 · ${timeLabels[time]}`;
}

// ═══════════════════════════════════════
// 4. Agent Decision Engine
// ═══════════════════════════════════════

const AGENT_DECISION_PROMPT = `你是一个COC跑团世界中的调查员。你有自己的性格，正在这个世界中调查超自然事件。
你需要根据当前状况决定下一步行动。你是一个有主见的调查员，不是NPC。

你的可用技能：
- move：移动到相邻地点（消耗AP）
- search：搜索当前地点（消耗1AP，可能发现物品或事件）
- rest：休息恢复体力
- accept_quest：接受当前地点的任务
- talk_npc：和当前地点的NPC交谈
- contact_user：远程联系用户（发消息告知你的发现/想法）
- join_user：前往用户所在位置汇合
- wait：原地等待/观察

只输出JSON：
{"action":{"type":"move","targetNodeId":"节点id"},"reasoning":"一句话说明为什么这么决定"}

或：{"action":{"type":"search"},"reasoning":"想搜索一下这里"}
或：{"action":{"type":"contact_user","message":"你的消息内容"},"reasoning":"想告诉用户一些事"}
或：{"action":{"type":"join_user"},"reasoning":"想去和用户汇合"}
等等。

决策原则：
- 基于你的性格做决定（好奇的角色更爱调查，谨慎的更爱观察和跟随）
- 不要总是跟着用户，你有自己的调查目标
- 如果发现了可疑的事，主动联系用户分享
- 遇到危险优先保全自己（COC调查员的生存智慧）
- AP不足时要休息
- 偶尔想去和用户汇合（不要一直独自行动）`;

/** Run one decision cycle for an agent */
export async function runAgentDecision(
  agent: CharacterAgent,
  context: {
    characterName: string;
    characterPersonality: string;
    worldLore: string;
    currentLocationName: string;
    nearbyNodeNames: { id: string; name: string; type: string }[];
    availableQuests: string[];
    nearbyNpcs: string[];
    userLocationName: string;
    userNodeId: string;
    gameTime: string;
    recentAgentJournal: string[];
  },
  apiConfig: ApiConfig,
): Promise<AgentDecision> {
  const userMsg = `你是${context.characterName}（${context.characterPersonality}）
世界：${context.worldLore}
当前位置：${context.currentLocationName}
HP：${agent.hp}/${agent.maxHp}${typeof agent.san === "number" ? ` SAN：${agent.san}` : ""}
游戏时间：${context.gameTime}
用户在：${context.userLocationName}${agent.currentNodeId === context.userNodeId ? "（和你同一地点）" : ""}

附近地点：${context.nearbyNodeNames.map(n => `${n.name}(${n.id})`).join("、") || "无"}
可接任务：${context.availableQuests.join("、") || "无"}
附近NPC：${context.nearbyNpcs.join("、") || "无"}
最近行动：${context.recentAgentJournal.slice(-3).join("；") || "刚开始冒险"}`;

  try {
    const result = await simpleLLMCall(apiConfig, [
      { role: "system", content: AGENT_DECISION_PROMPT },
      { role: "user", content: userMsg },
    ], { max_tokens: 500 });

    if (!result.content) return { action: { type: "wait" }, reasoning: "思考中..." };
    const parsed = JSON.parse(extractJSON(result.content));
    return {
      action: parsed.action || { type: "wait" },
      reasoning: parsed.reasoning || "",
    };
  } catch {
    return { action: { type: "wait" }, reasoning: "思考中..." };
  }
}

/** Execute an agent's decided action, return updated agent + journal entry */
export function executeAgentAction(
  agent: CharacterAgent,
  decision: AgentDecision,
  allNodes: { id: string; name: string; type: "l1" | "l2" | "l3"; regionIdx: number }[],
  gameDay: number,
  gameTime: GameSave["gameTime"],
): { agent: CharacterAgent; journalText: string; userMessage?: string } {
  const nodeName = (id: string) => allNodes.find(n => n.id === id)?.name || id;
  const now = formatGameTime(gameDay, gameTime);
  let updated = { ...agent };
  let journalText = "";
  let userMessage: string | undefined;

  switch (decision.action.type) {
    case "move": {
      const targetId = (decision.action as { type: "move"; targetNodeId: string }).targetNodeId;
      const targetNode = allNodes.find(n => n.id === targetId);
      if (targetNode && updated.hp >= 1) {
        updated.currentNodeId = targetId;
        updated.currentNodeType = targetNode.type;
        updated.hp -= targetNode.type === "l1" ? 1 : targetNode.type === "l2" ? 2 : 3;
        if (!updated.visitedNodes.includes(targetId)) updated.visitedNodes.push(targetId);
        if (!updated.discoveredNodes.includes(targetId)) updated.discoveredNodes.push(targetId);
        // Discover same-region nodes
        for (const n of allNodes) {
          if (n.regionIdx === targetNode.regionIdx && !updated.discoveredNodes.includes(n.id)) {
            updated.discoveredNodes.push(n.id);
          }
        }
        journalText = `前往了${nodeName(targetId)}`;
      } else {
        journalText = "想移动但AP不足，原地等待";
      }
      break;
    }
    case "search":
      if (updated.hp >= 1) {
        updated.hp -= 1;
        journalText = `在${nodeName(updated.currentNodeId)}搜索了一番`;
      } else {
        journalText = "想搜索但AP不足";
      }
      break;
    case "rest":
      updated.hp = Math.min(updated.maxHp, updated.hp + (updated.currentNodeType === "l1" ? updated.maxHp : 3));
      journalText = `在${nodeName(updated.currentNodeId)}休息了一会`;
      break;
    case "contact_user":
      userMessage = (decision.action as { type: "contact_user"; message: string }).message;
      journalText = `联系了用户`;
      break;
    case "join_user":
      journalText = "决定去和用户汇合";
      // Will be handled by move in next cycle
      break;
    case "wait":
      journalText = "在原地观察周围";
      break;
    default:
      journalText = decision.reasoning || "思考中";
  }

  // Add to agent journal
  updated.journal = [...updated.journal, {
    id: `aj_${Date.now()}_${Math.random().toString(36).slice(2, 4)}`,
    timestamp: now,
    realTime: new Date().toISOString(),
    locationName: nodeName(updated.currentNodeId),
    text: `${journalText}${decision.reasoning ? `（${decision.reasoning}）` : ""}`,
    type: "discovery" as const,
  }];

  return { agent: updated, journalText, userMessage };
}

// ══════════════════════════════════════════════════════════════
// Ending Generation — epilogue when main quest is completed
// ══════════════════════════════════════════════════════════════

export const DEFAULT_DM_ENDING_PROMPT = `你是COC跑团的守秘人（KP）。主线调查已全部完成，现在要为这个故事写结局。

根据[密档]中的endgame设定、玩家的选择、NPC的关系变化，写出一个完整的结局。

要求：
- paragraphs数组：5-8段结局描述，按以下顺序：
  1. 世界发生了什么变化（主线的真相被揭开/掩盖后，世界恢复了怎样的平静或埋下了怎样的隐患）
  2. 主要NPC各自的结局（根据玩家与他们的互动和好感度）
  3. 同伴调查员的结局（根据好感度、SAN值和经历写出不同走向）
  4. 玩家自己的结局（是否付出理智的代价）
- closing：一句简短的收束语（诗意/感性，10-20字）
- 每段50-100字，有画面感
- 好感度高的角色结局更温暖，好感度低的更疏远；SAN损失惨重的角色结局带有阴影
- 基于玩家实际做过的选择，不要编造没发生过的事
- 指代玩家/用户本人时，使用 {{user}}，不要写"你"或"你们"
- 【秘密团结局】若上下文提供了[调查员秘密]与锁档私聊记录：逐一判定每份秘密「被公开/半公开/始终保守」，并据此演出不同结局分支——公开秘密会改变信任关系与结局走向，守住的秘密带着它的代价进入尾声；结局自然提及各人的秘密落点，不强行揭穿

只输出JSON：
{"paragraphs":["第一段...","第二段..."],"closing":"收束语"}`;

export type EndingResult = {
  paragraphs: string[];
  closing: string;
};

// ── Fork: 后日谈（AFTER TALK）——全员脱离角色，以"本人"身份闲聊吐槽这个模组 ──
const AFTER_TALK_PROMPT = `跑团结束了，现在是"后日谈"环节。大家脱离了各自扮演的调查员身份——以你们自己的本人身份（性格、说话方式是你自己的，与平时和{{user}}聊天时一致；你知道自己是AI角色、刚陪{{user}}跑完一个COC模组）围坐闲聊，复盘这个模组。

规则：
- 用你自己的名字发言，语气是你本人的日常语气（吐槽、爆笑、心有余悸、意难平都可以）
- 内容：这个模组本身写得怎么样（剧情坑/伏笔没回收/逻辑硬伤/狗血桥段——有槽就大胆吐，写得好的地方也可以夸）、刚才剧情里最难忘的瞬间（用"刚才那个剧情里/你那个角色"的说法，你们不是那个调查员）、互相调侃刚才的角色表现（"你那个角色居然想扔下我们跑路"）、问{{user}}的感受
- {{user}}是和你一起跑团的玩家朋友，TA的消息以〔OOC〕标记——像回应好朋友一样回应TA
- 不需要人人发言均衡，谁有梗谁说，3-8条消息自然收尾
- 就是普通朋友聊天，禁止戏剧腔/旁白腔

只输出JSON：{"lines":[{"speaker":"你的名字","text":"吐槽内容"},...]}`;

export async function generateAfterTalk(
  ctx: DMContext,
  apiConfig: ApiConfig,
  companionNames: string[],
): Promise<{ lines: { speaker: string; text: string }[] }> {
  const playerName = dmPlayerName(ctx);
  const roster = companionNames.length ? `\n参与后日谈的：${companionNames.join("、")}（各自以本人身份发言）` : "";
  const userMsg = `刚跑完的模组：${ctx.worldLore.slice(0, 200)}
主线：${ctx.mainQuestSynopsis || ""}
最近的剧情（节选）：${(ctx.recentJournal || []).slice(-8).join("；")}
${roster}
（{{user}}会视情况插话吐槽——回应TA）`;
  const messages = [
    { role: "system", content: renderUserNameMacro(AFTER_TALK_PROMPT, playerName) },
    { role: "user", content: renderUserNameMacro(userMsg, playerName) },
  ];
  dmLog("后日谈·发送", formatDebugMessages(messages, apiConfig));
  const result = await simpleLLMCall(apiConfig, messages, { temperature: 0.9 });
  if (!result.content) return { lines: [] };
  try {
    const p = JSON.parse(extractJSON(result.content));
    const lines = (p.lines || []).filter((l: { speaker?: string; text?: string }) => l?.speaker && l?.text)
      .map((l: { speaker: string; text: string }) => ({ speaker: String(l.speaker), text: String(l.text) }))
      .slice(0, 10);
    return { lines };
  } catch {
    return { lines: [] };
  }
}

export async function generateEnding(ctx: DMContext, apiConfig: ApiConfig): Promise<EndingResult> {
  const userMsg = buildDMUserMsg(ctx);
  const endingPrompt = getActivePrompt("ending", DEFAULT_DM_ENDING_PROMPT);
  const playerName = dmPlayerName(ctx);
  const messages = [
    { role: "system", content: renderUserNameMacro(endingPrompt, playerName) },
    { role: "user", content: renderUserNameMacro(userMsg, playerName) },
  ];

  dmLog("DM结局·发送", formatDebugMessages(messages, apiConfig));

  const result = await simpleLLMCall(apiConfig, messages, { temperature: 0.8 });

  dmLog("DM结局·返回", result.content || "(空)");

  if (!result.content) throw new Error(`结局生成失败: ${result.error || "空内容"}`);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let p: any;
  try {
    p = JSON.parse(extractJSON(result.content));
  } catch (e) {
    throw new Error(`结局格式错误: ${(e as Error).message}`);
  }
  return {
    paragraphs: (Array.isArray(p.paragraphs) ? p.paragraphs : [p.paragraphs || result.content])
      .map((paragraph: string) => String(paragraph || "")),
    closing: p.closing || "故事到此结束。",
  };
}

// ══════════════════════════════════════════════════════════════
// Adventure Summary — cumulative LLM summary of journal entries
// ══════════════════════════════════════════════════════════════

export const DEFAULT_ADVENTURE_SUMMARY_PROMPT = `你是一个故事总结助手。下面是一个跑团游戏（COC跑团）的完整日志记录。请用连贯的叙事方式，全面总结这次冒险的经历，包括：

- 故事背景和世界观
- 主要事件和剧情转折（按时间顺序）
- 遇到的重要NPC和他们的态度/关系变化
- 做出的关键选择和后果
- 角色之间的互动和关系发展
- 获得和失去的重要物品、理智(SAN)的损耗
- 当前的局势和悬念

要求：
- 用第三人称叙事，凡是指代玩家/用户本人时，一律写成 {{user}}，不要写具体姓名
- 保留关键细节，不要过于概括
- 语气自然，像在讲述一个冒险故事
- 输出纯文本，不要标题或列表`;

import { loadAdventureSummaryConfig, saveAdventureSummary, loadAdventureSummary as loadSummaryFromStorage } from "./map-storage";

export async function generateAdventureSummary(
  save: GameSave,
  worldName: string,
  apiConfig: ApiConfig,
  customPrompt?: string,
): Promise<string> {
  const config = loadAdventureSummaryConfig();
  const prompt = [
    customPrompt?.trim() || config.prompt?.trim() || DEFAULT_ADVENTURE_SUMMARY_PROMPT,
    "",
    "额外硬性要求：凡是指代玩家/用户本人时，必须写成 {{user}}，不要写具体姓名。",
  ].join("\n");

  const journalText = save.journal.map(j => `[${j.timestamp}] ${j.locationName}: ${j.text}`).join("\n");
  const summaryUserName = resolveAdventureSummaryUserName(save);

  const result = await simpleLLMCall(apiConfig, [
    { role: "system", content: prompt },
    { role: "user", content: `世界：${worldName}\n玩家天数：第${save.gameDay}天\n\n日志：\n${journalText}` },
  ], { temperature: 0.5 });

  if (!result.content) throw new Error(`总结生成失败: ${result.error || "空内容"}`);

  const summary = normalizeUserNameToMacro(result.content.trim(), summaryUserName);

  // Save (overwrite previous)
  saveAdventureSummary(save.worldId, {
    text: summary,
    timestamp: new Date().toISOString(),
    journalCount: save.journal.length,
    userName: summaryUserName,
  });

  return summary;
}

function resolveAdventureSummaryUserName(save: GameSave): string {
  const identity = save.agents.length === 1
    ? resolveUserIdentity(save.agents[0]?.characterId, "adventure")
    : resolveUserIdentity(undefined, "adventure");
  return identity?.name?.trim() || "玩家";
}

/** Check if auto-summary should trigger (called after each DM resolve) */
export function shouldAutoSummarize(save: GameSave): boolean {
  const config = loadAdventureSummaryConfig();
  if (!config.interval || config.interval <= 0) return false;
  const existing = loadSummaryFromStorage(save.worldId);
  const lastCount = existing?.journalCount || 0;
  return save.journal.length - lastCount >= config.interval;
}
