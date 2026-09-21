// lib/investigator-import.ts
// Fork 十一期: investigator import — adapt a character card to the module's era/setting before play.
// One LLM call per companion at world entry; output is a structured persona that overrides the raw card in-game.

import type { ApiConfig } from "./settings-types";
import { simpleLLMCall } from "./api-helpers";
import type { InvestigatorPersona, PersonalSecret, WorldSkeleton } from "./map-types";
import { OCCUPATIONS } from "./coc-sheet";

const IMPORT_PROMPT = `你是COC跑团的主持人助手。一位玩家带着自己的角色卡加入模组，但角色卡的设定与模组时代/世界观可能不匹配（比如角色卡是现代人，模组是1920年代或古代）。你需要为TA生成"模组内人设"：贴合时代、贴合模组、但保留角色卡的核心性格。

只输出标签块纯文本，不要JSON：
[名字]保留原名或转成时代化变体（中文名优先保留，设定卡是外文名可音译）
[时代职业]这个时代里TA是什么职业（必须是该时代真实存在的职业；角色卡职业若时代不符，转成最接近的时代等价物：现代警察→1920年代治安官/民国巡捕/古代捕快；网络主播→报社记者/说书人；程序员→电报员/账房先生。参考候选：{occ_pool}）
[技能模板]上面候选职业之一（系统按它分配技能组；写与TA最贴的那个职业名，必须严格等于候选之一）
[身份背景]TA在这个时代的身份与来此缘由（2-4句：做什么的、为什么卷入这次调查、与队伍如何相识）
[性格保持]角色卡里不变的部分（2-3句：核心性格、说话方式、口头禅、与{{user}}的关系基调）
[时代调整]原设定到模组设定的对应关系（1-2句，如"原设定的手机改为随身怀表与笔记本"）
[背景钩子]TA与本次调查的私人连接（1-2句：TA为什么在意这个案子——原因必须能自然解释TA加入调查，且可与其性格呼应）
[拿卡反应]TA拿到身份卡那一刻的第一人称感叹（1-2句，体现"我接下来要扮演的人居然是……"的错愕或兴奋：TA读出卡上的职业并用自己的口吻反应。用TA的性格和说话方式——傲娇会别扭、老成会感慨、元气会兴奋。不要旁白腔）

要求：
- 性格、说话方式、与{{user}}的关系必须忠于角色卡，禁止重写人格
- 时代职业、生活方式、物品全部时代化，禁止出现不属于该时代的元素
- 背景钩子要具体（与模组开头的地点/事件/失踪者有关联更好），不要"命运指引"这类空话
- [拿卡反应]必须是第一人称台词（可带语气词），像玩家看到卡的那一瞬脱口而出`;

const PROMPT_SECRET_BLOCK = `

补充：这是一个秘密团，每位调查员会拿到一个个人秘密。TA的秘密是：「{secret}」（与真相的咬合：{link}）。
[背景钩子]必须与这个秘密自然衔接——TA在意这个案子的私人原因应与其秘密相关或相邻，但不要在背景里写破秘密内容。`;

const PROMPT_HO_BLOCK = `

补充：这是一个固定车卡的秘密团——TA被分配到一条指定调查员线（HO），车卡规定了TA的职业。
TA的HO职业要求：「{ho_occupation}」。
【职业铁律】[时代职业]必须就是「{ho_occupation}」（可按时代微调措辞，如"搞笑艺人"在不同时代可为"宫廷俳优/杂耍艺人/喜剧演员"，但职业内核不得更换）。角色卡原职业作废，[身份背景]要能解释TA为何从事这个职业并与HO导入剧情衔接。[技能模板]从候选中选与该职业最接近的。`;

/** Adapt one companion's persona to the module. Returns null on failure (caller falls back to raw card). */
export async function importInvestigator(
  characterName: string,
  characterPersonality: string,
  skeleton: WorldSkeleton,
  secret?: PersonalSecret,
  apiConfig: ApiConfig,
  hoOccupation?: string,
): Promise<InvestigatorPersona | null> {
  const eraGuess = skeleton.world.lore.slice(0, 120) || skeleton.world.name;
  const occPool = OCCUPATIONS.map(o => o.name).join("/");
  let prompt = IMPORT_PROMPT.replace("{occ_pool}", occPool);
  if (hoOccupation?.trim()) {
    prompt += PROMPT_HO_BLOCK.split("{ho_occupation}").join(hoOccupation.trim());
  }
  if (secret) {
    prompt += PROMPT_SECRET_BLOCK.replace("{secret}", secret.content).replace("{link}", secret.link || "未注明");
  }
  const userMsg = `模组：${skeleton.world.name}（${eraGuess}）
主线：${skeleton.mainQuest.title} — ${skeleton.mainQuest.synopsis}
开场地点：${skeleton.mainQuest.stages[0]?.locationHint || skeleton.richRegions[0]?.l1_name_cn || "未知"}
角色卡：${characterName}
性格设定：${characterPersonality}`;

  const result = await simpleLLMCall(apiConfig, [
    { role: "system", content: prompt },
    { role: "user", content: userMsg },
  ], { temperature: 0.7 });
  if (!result.content) return null;

  // Parse tagged blocks
  const fields: Record<string, string> = {};
  let key = "";
  let buf: string[] = [];
  for (const raw of result.content.replace(/```[a-zA-Z]*\s*/g, "").replace(/```/g, "").split("\n")) {
    const m = raw.match(/^\s*\[([^\]]+)\]\s*(.*)$/);
    if (m) { if (key) fields[key] = buf.join("\n").trim(); key = m[1].trim(); buf = [m[2] ?? ""]; }
    else if (key) buf.push(raw);
  }
  if (key) fields[key] = buf.join("\n").trim();

  if (!fields["技能模板"] || !OCCUPATIONS.some(o => o.name === fields["技能模板"])) {
    // Skill template must be a real occupation; drop to first mention or detective
    fields["技能模板"] = OCCUPATIONS.find(o => (fields["时代职业"] || "").includes(o.name))?.name || "调查员";
  }
  return {
    name: fields["名字"] || characterName,
    era: eraGuess,
    occupation: fields["时代职业"] || fields["技能模板"] || "调查员",
    refOccupation: fields["技能模板"],
    background: fields["身份背景"] || "",
    keepTraits: fields["性格保持"] || characterPersonality.slice(0, 200),
    changes: fields["时代调整"] || "",
    hooks: fields["背景钩子"] || "",
    cardReaction: fields["拿卡反应"] || "",
  };
}
