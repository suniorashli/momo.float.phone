// lib/coc-sheet.ts
// CoC 6th Edition character sheet: occupations, skills, weapons, point allocation,
// dice math and combat resolution helpers. (fork mod — kept standalone so merging
// upstream map-* files stays easy)

import type { CharStats, StatKey, RulesEdition } from "./map-types";
import { lookupDB, SKILL_STAT_HINT } from "./map-types";

export type { RulesEdition };

// ── Skill base values: CoC 6th ──
export const SKILL_BASE_6: Record<string, number> = {
  拳击: 50, 踢击: 25, 头槌: 10, 擒抱: 25, 小刀: 25, 棍棒: 25, 手枪: 20, 步枪: 25, 霰弹枪: 30, 冲锋枪: 15, 投掷: 25,
  侦查: 25, 聆听: 25, 潜行: 15, 藏匿: 15, 追踪: 10, 导航: 10,
  议价: 5, 话术: 5, 说服: 15, 心理学: 5, 信用评级: 0,
  会计: 10, 人类学: 1, 考古学: 1, 历史: 20, 法律: 5, 图书馆使用: 25, 医学: 5, 博物学: 10, 神秘学: 5, 精神分析: 1, 科学: 1, 克苏鲁神话: 0,
  "艺术/手艺": 5, "驾驶（汽车）": 20, 电气维修: 10, 机械维修: 20, 操作重型机械: 1, 计算机使用: 0, 电子学: 1, 摄影: 5, 锁匠: 1, 妙手: 10, 伪装: 1,
  外语: 1, 急救: 30, 游泳: 25, 攀爬: 40, 跳跃: 25, 骑术: 5, 生存: 10,
};

// Legacy alias kept for old imports (must come after SKILL_BASE_6 — no TDZ)
export const SKILL_BASE: Record<string, number> = SKILL_BASE_6;

// ── Skill base values: CoC 7th (per user's coc7th.json) ──
export const SKILL_BASE_7: Record<string, number> = {
  拳击: 25, 踢击: 25, 头槌: 25, 擒抱: 25, 小刀: 25, 棍棒: 25, 手枪: 20, 步枪: 25, 霰弹枪: 25, 冲锋枪: 15, 投掷: 20,
  侦查: 25, 聆听: 20, 潜行: 20, 藏匿: 20, 追踪: 10, 导航: 10,
  议价: 5, 话术: 5, 说服: 10, 心理学: 10, 信用评级: 0, 取悦: 15, 恐吓: 15, 估价: 5,
  会计: 5, 人类学: 1, 考古学: 1, 历史: 5, 法律: 5, 图书馆使用: 20, 医学: 1, 博物学: 10, 神秘学: 5, 精神分析: 1, 科学: 1, 克苏鲁神话: 0,
  "艺术/手艺": 5, "驾驶（汽车）": 20, 电气维修: 10, 机械维修: 10, 操作重型机械: 1, 计算机使用: 5, 电子学: 1, 摄影: 5, 锁匠: 1, 妙手: 10, 伪装: 5,
  外语: 1, 急救: 30, 游泳: 20, 攀爬: 20, 跳跃: 20, 骑术: 5, 生存: 10,
};

export function skillBaseTable(edition: RulesEdition): Record<string, number> {
  return edition === "coc7" ? SKILL_BASE_7 : SKILL_BASE_6;
}

/** Dodge value: 6th = DEX% × 0.4; 7th = DEX / 2 (percent). Both take percent DEX. */
export function dodgeValue(dex: number, edition: RulesEdition): number {
  return edition === "coc7" ? Math.floor(dex / 2) : Math.round(dex * 0.4);
}

/** Max HP: 7th = floor((CON+SIZ)/10) on percent values; 6th = ceil((CON+SIZ)/10). */
export function maxHpFor(edition: RulesEdition, con: number, siz: number): number {
  if (edition === "coc7") return Math.max(1, Math.floor((con + siz) / 10));
  return Math.max(1, Math.ceil((con + siz) / 10));
}

/** Fumble threshold: 7th = 96-100 when value < 50, else only 100; 6th = 96-100 always. */
export function fumbleThreshold(edition: RulesEdition, value: number): number {
  if (edition === "coc7") return value < 50 ? 96 : 100;
  return 96;
}

/** 7th Edition bonus/penalty dice: two D100s, keep lower (bonus) or higher (penalty). */
export function rollD100WithDice(value: number, mode: "none" | "bonus" | "penalty", edition: RulesEdition): { roll: number; level: "crit" | "hard" | "success" | "fail" | "fumble"; detail: string } {
  const rand = () => Math.floor(Math.random() * 100) + 1;
  let roll = rand();
  let detail = "";
  if (edition === "coc7" && mode !== "none") {
    const second = rand();
    roll = mode === "bonus" ? Math.min(roll, second) : Math.max(roll, second);
    detail = mode === "bonus" ? `奖励骰（取低：${roll}）` : `惩罚骰（取高：${roll}）`;
  }
  if (roll <= Math.floor(value / 5)) return { roll, level: "crit", detail };
  if (roll <= Math.floor(value / 2)) return { roll, level: "hard", detail };
  if (roll <= value) return { roll, level: "success", detail };
  if (edition === "coc7" ? roll >= fumbleThreshold(edition, value) : roll > 95) return { roll, level: "fumble", detail };
  return { roll, level: "fail", detail };
}

/** 7th Edition DB by STR+SIZ (percent). 6th uses raw (÷5) table. */
export function dbForEdition(edition: RulesEdition, str: number, siz: number): string {
  if (edition === "coc6") return lookupDB(Math.round(str / 5) + Math.round(siz / 5));
  const sum = str + siz;
  if (sum <= 64) return "-2";
  if (sum <= 84) return "-1";
  if (sum <= 124) return "0";
  if (sum <= 164) return "+1D4";
  if (sum <= 204) return "+1D6";
  const extra = Math.ceil((sum - 204) / 80);
  return `+${1 + extra}D6`;
}

/** Luck spend (7th): burn luck to turn a near-miss into success. */
export function canSpendLuck(roll: number, value: number, luck: number): { ok: boolean; cost: number } {
  if (roll <= value) return { ok: false, cost: 0 };
  const diff = roll - value;
  return { ok: diff > 0 && diff <= luck, cost: diff };
}

export type WeaponSpec = {
  name: string;        // 显示名
  skill: string;       // 对应技能（拳击/小刀/手枪…）
  damage: string;      // 伤害表达式，支持 1D6+DB / 1D10+2 / 1D4
  range?: string;      // 射程描述
  shots?: number;      // 装弹量
  malf?: number;       // 故障值
};

// ── Weapon presets (quick-add in UI + occupation loadouts) ──
export const WEAPON_PRESETS: Record<string, WeaponSpec> = {
  "徒手": { name: "徒手", skill: "拳击", damage: "1D3+DB" },
  "小刀": { name: "小刀", skill: "小刀", damage: "1D4+DB" },
  "手斧": { name: "手斧", skill: "棍棒", damage: "1D6+DB" },
  "棍棒": { name: "棍棒", skill: "棍棒", damage: "1D6+DB" },
  "左轮手枪": { name: "左轮手枪", skill: "手枪", damage: "1D10", range: "15m", shots: 6, malf: 100 },
  "自动手枪": { name: "自动手枪", skill: "手枪", damage: "1D8", range: "12m", shots: 7, malf: 100 },
  "步枪": { name: "步枪", skill: "步枪", damage: "1D10+2", range: "100m", shots: 5, malf: 100 },
  "霰弹枪": { name: "霰弹枪", skill: "霰弹枪", damage: "2D6+2", range: "10m", shots: 2, malf: 100 },
  "冲锋枪": { name: "冲锋枪", skill: "冲锋枪", damage: "1D10", range: "25m", shots: 30, malf: 100 },
};

export type OccupationSpec = {
  name: string;
  skills: string[];          // 本职技能池（取前7-8个）
  credit: [number, number];  // 信用评级范围
  weapons: string[];         // 默认携带武器（WEAPON_PRESETS 键）
  equipment: string[];       // 默认随身物品
  keywords: string[];        // 人设关键词 → 职业推断
};

export const OCCUPATIONS: OccupationSpec[] = [
  { name: "侦探", skills: ["侦查", "心理学", "锁匠", "图书馆使用", "法律", "话术", "潜行"], credit: [9, 60], weapons: ["左轮手枪", "小刀"], equipment: ["手电筒", "放大镜", "笔记本", "怀表"], keywords: ["侦探", "私家", "调查员", "情报贩子"] },
  { name: "警察", skills: ["拳击", "手枪", "法律", "心理学", "侦查", "驾驶（汽车）", "急救"], credit: [20, 50], weapons: ["左轮手枪", "棍棒"], equipment: ["警笛", "手铐", "手电筒", "警官证"], keywords: ["警察", "警官", "刑警", "探长", " sheriff"] },
  { name: "医生", skills: ["医学", "急救", "心理学", "科学", "图书馆使用", "说服"], credit: [30, 80], weapons: ["小刀"], equipment: ["医疗包", "听诊器", "处方笺"], keywords: ["医生", "大夫", "外科", "医师", "法医"] },
  { name: "记者", skills: ["图书馆使用", "话术", "摄影", "心理学", "侦查", "历史", "说服"], credit: [9, 60], weapons: [], equipment: ["相机", "笔记本", "钢笔"], keywords: ["记者", "新闻", "撰稿"] },
  { name: "教授", skills: ["图书馆使用", "历史", "考古学", "科学", "神秘学", "说服", "心理学"], credit: [20, 70], weapons: [], equipment: ["书籍", "眼镜", "烟斗", "讲义"], keywords: ["教授", "学者", "老师", "博士", "研究员"] },
  { name: "作家", skills: ["图书馆使用", "神秘学", "历史", "心理学", "说服", "外语"], credit: [9, 60], weapons: [], equipment: ["手稿", "打字机", "墨水"], keywords: ["作家", "小说家", "诗人", "编剧"] },
  { name: "律师", skills: ["法律", "会计", "说服", "话术", "图书馆使用", "心理学"], credit: [30, 80], weapons: [], equipment: ["法律文书", "公文包", "怀表"], keywords: ["律师", "法律顾问", "检察官"] },
  { name: "神职人员", skills: ["心理学", "神秘学", "说服", "历史", "急救", "聆听"], credit: [9, 60], weapons: [], equipment: ["圣典", "十字架", "念珠"], keywords: ["神父", "牧师", "修女", "僧侣", "神职", "祭司"] },
  { name: "军人", skills: ["步枪", "拳击", "急救", "侦查", "潜行", "生存", "导航"], credit: [9, 30], weapons: ["步枪", "小刀"], equipment: ["军用水壶", "弹药带", "军牌"], keywords: ["军人", "士兵", "退伍", "老兵", "军官", "雇佣兵"] },
  { name: "盗贼", skills: ["妙手", "锁匠", "潜行", "侦查", "议价", "心理学", "藏匿"], credit: [5, 30], weapons: ["小刀"], equipment: ["撬锁工具", "绳索", "面罩"], keywords: ["小偷", "盗贼", "窃贼", "诈骗", "混混"] },
  { name: "艺术家", skills: ["艺术/手艺", "心理学", "历史", "神秘学", "侦查", "说服"], credit: [9, 50], weapons: ["小刀"], equipment: ["画具", "速写本"], keywords: ["画家", "音乐家", "艺术家", "雕塑", "钢琴"] },
  { name: "司机", skills: ["驾驶（汽车）", "机械维修", "侦查", "聆听", "心理学"], credit: [9, 30], weapons: ["棍棒"], equipment: ["工具箱", "地图", "驾照"], keywords: ["司机", "出租车", "车夫", "驾驶员"] },
  { name: "图书管理员", skills: ["图书馆使用", "历史", "考古学", "神秘学", "科学", "外语"], credit: [9, 35], weapons: [], equipment: ["借阅卡", "目录索引"], keywords: ["图书馆", "档案", "管理员"] },
  { name: "护士", skills: ["急救", "医学", "心理学", "说服", "侦查"], credit: [20, 50], weapons: ["小刀"], equipment: ["医疗包", "注射器"], keywords: ["护士", "护理"] },
  { name: "调查员", skills: ["侦查", "图书馆使用", "聆听", "话术", "急救", "历史", "攀爬"], credit: [20, 50], weapons: ["左轮手枪"], equipment: ["手电筒", "笔记本", "绳索"], keywords: [] },
];

export function detectOccupation(personality: string): OccupationSpec {
  const p = (personality || "").toLowerCase();
  for (const occ of OCCUPATIONS) {
    if (occ.keywords.some(k => p.includes(k))) return occ;
  }
  return OCCUPATIONS[OCCUPATIONS.length - 1]; // 调查员 fallback
}

// ── Damage bonus from percent-scale STR/SIZ ──
export function dbFromStats(stats: CharStats): string {
  return lookupDB(stats.str / 5 + stats.siz / 5);
}

export type CharSheet = {
  occupation: string;
  creditRating: number;
  skills: Record<string, number>;  // 已训练技能 → 当前值（含信用评级）
  weapons: WeaponSpec[];
  equipment: string[];
};

const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min;

/** Build a full CoC sheet (6th/7th): occupation (auto or forced), point allocation, default gear.
 *  stats are percent-scale attributes. */
export function buildCoCSheet(stats: CharStats, personality?: string, forcedOccupation?: string, edition: RulesEdition = "coc6"): CharSheet {
  const occ = forcedOccupation
    ? OCCUPATIONS.find(o => o.name === forcedOccupation) || detectOccupation(personality || "")
    : detectOccupation(personality || "");

  const BASE = skillBaseTable(edition);
  const skills: Record<string, number> = {};
  // 6th: occPoints = EDU(raw)×20 ≡ EDU%×4; 7th: EDU×4 — identical on percent scale.
  // Interest: 6th INT(raw)×10 ≡ INT%×2; 7th INT×2 — same.
  let occPoints = Math.round(stats.edu * 4);
  let intPoints = Math.round(stats.int * 2);

  // 本职技能加点：前3个技能是主修（拿60%点数），其余平分
  const occSkills = occ.skills.slice(0, 8);
  const major = occSkills.slice(0, 3);
  const minor = occSkills.slice(3);
  for (const s of major) {
    const base = BASE[s] ?? 0;
    const spend = Math.min(Math.max(0, 99 - base), Math.round(occPoints * 0.2 + rand(-5, 10)));
    skills[s] = base + spend;
    occPoints -= spend;
  }
  for (const s of minor) {
    if (occPoints <= 0) { if (!(s in skills)) skills[s] = BASE[s] ?? 0; continue; }
    const base = BASE[s] ?? 0;
    const spend = Math.min(Math.max(0, 99 - base), Math.max(5, Math.round(occPoints / Math.max(1, minor.length))));
    skills[s] = base + spend;
    occPoints -= spend;
  }

  // 兴趣点：从通用池挑3-4个非本职技能
  const interestPool = ["攀爬", "游泳", "急救", "跳跃", "说服", "聆听", "侦查", "图书馆使用", "医学", "心理学", "潜行", "驾驶（汽车）", "神秘学", "妙手"]
    .filter(s => !occSkills.includes(s));
  const picks = interestPool.sort(() => Math.random() - 0.5).slice(0, 4);
  for (const s of picks) {
    const base = BASE[s] ?? 0;
    const spend = Math.min(Math.max(0, 99 - base), Math.max(5, Math.round(intPoints / picks.length)));
    skills[s] = base + spend;
    intPoints -= spend;
  }

  // 信用评级：范围内随机（简化：不占职业点）
  const credit = rand(occ.credit[0], occ.credit[1]);
  skills["信用评级"] = credit;

  // 武器与物品
  const weapons: WeaponSpec[] = occ.weapons.map(w => ({ ...WEAPON_PRESETS[w] })).filter(Boolean);

  return { occupation: occ.name, creditRating: credit, skills, weapons, equipment: [...occ.equipment] };
}

/** Resolve a check target to a concrete value: trained skill → base skill → attribute mapping.
 *  edition affects dodge & native-language bases. */
export function skillCheckValue(sheet: CharSheet | undefined, name: string, stats: CharStats, edition: RulesEdition = "coc6"): { value: number; source: string } {
  const n = (name || "").trim();
  const BASE = skillBaseTable(edition);
  if (n === "闪避") return { value: dodgeValue(stats.dex, edition), source: "闪避" };
  if (n === "母语") return { value: edition === "coc7" ? stats.edu : Math.round(stats.edu * 5), source: "母语" };
  if (sheet?.skills && typeof sheet.skills[n] === "number") return { value: sheet.skills[n], source: n };
  if (typeof BASE[n] === "number") return { value: BASE[n], source: `${n}(基础)` };
  // attribute keys / legacy
  const attr: Record<string, StatKey> = { str: "str", con: "con", pow: "pow", dex: "dex", app: "app", siz: "siz", int: "int", edu: "edu", san: "san", lck: "lck", per: "int", cha: "app", 力量: "str", 体质: "con", 意志: "pow", 敏捷: "dex", 外貌: "app", 体型: "siz", 智力: "int", 教育: "edu", 理智: "san", 幸运: "lck", 感知: "int", 魅力: "app" };
  const lower = n.toLowerCase();
  if (attr[lower]) return { value: stats[attr[lower]], source: attr[lower] };
  if (attr[n]) return { value: stats[attr[n]], source: attr[n] };
  if (SKILL_STAT_HINT[n]) return { value: stats[SKILL_STAT_HINT[n]], source: `${n}(${SKILL_STAT_HINT[n]})` };
  return { value: stats.int, source: `${n}(智力)` };
}

// ── Dice math ──
export function rollDice(count: number, sides: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) total += rand(1, sides);
  return total;
}

/** Roll a damage/roll expression: "1D6+DB", "2D6+2", "1D4", supports -DB. Returns {total, detail}. */
export function rollExpr(expr: string, db: string): { total: number; detail: string } {
  let total = 0;
  const parts: string[] = [];
  const dbVal = db === "0" ? 0 : (() => {
    const m = /([+-])(\d*)D(\d+)/i.exec(db || "0");
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    const n = m[2] ? parseInt(m[2], 10) : 1;
    const s = parseInt(m[3], 10);
    return sign * rollDice(n, s);
  })();
  const tokens = (expr || "0").replace(/\s+/g, "").match(/[+-]?[^+-]+/g) || [];
  for (const t of tokens) {
    const dm = /^[+-]?(\d*)[dD](\d+)$/.exec(t);
    if (dm) {
      const sign = t.startsWith("-") ? -1 : 1;
      const n = dm[1] ? parseInt(dm[1], 10) : 1;
      const s = parseInt(dm[2], 10);
      const r = rollDice(n, s);
      total += sign * r;
      parts.push(`${sign < 0 ? "-" : ""}${n}D${s}=${r}`);
      continue;
    }
    if (/^[+-]?DB$/i.test(t)) { total += dbVal; parts.push(`DB=${dbVal >= 0 ? "+" : ""}${dbVal}`); continue; }
    const nm = /^[+-]?\d+$/.exec(t);
    if (nm) { const v = parseInt(t, 10); total += v; parts.push(`${v >= 0 ? "+" : ""}${v}`); }
  }
  return { total: Math.max(0, total), detail: parts.join(" ") || "0" };
}

/** Max damage of an expression (crit/贯穿用：骰子取满)。 */
export function maxExpr(expr: string, db: string): number {
  let total = 0;
  const dbMax = (() => {
    const m = /([+-])(\d*)D(\d+)/i.exec(db || "0");
    if (!m) return 0;
    const sign = m[1] === "-" ? -1 : 1;
    const n = m[2] ? parseInt(m[2], 10) : 1;
    const s = parseInt(m[3], 10);
    return sign * n * s;
  })();
  const tokens = (expr || "0").replace(/\s+/g, "").match(/[+-]?[^+-]+/g) || [];
  for (const t of tokens) {
    const dm = /^[+-]?(\d*)[dD](\d+)$/.exec(t);
    if (dm) {
      const sign = t.startsWith("-") ? -1 : 1;
      const n = dm[1] ? parseInt(dm[1], 10) : 1;
      total += sign * n * parseInt(dm[2], 10);
      continue;
    }
    if (/^[+-]?DB$/i.test(t)) { total += dbMax; continue; }
    const nm = /^[+-]?\d+$/.exec(t);
    if (nm) total += parseInt(t, 10);
  }
  return Math.max(0, total);
}

// ── Combat resolution ──
export type RollLevel = "crit" | "hard" | "success" | "fail" | "fumble";
const LEVEL_RANK: Record<RollLevel, number> = { fumble: 0, fail: 1, success: 2, hard: 3, crit: 4 };

export function d100Level(value: number): { roll: number; level: RollLevel } {
  const roll = rand(1, 100);
  if (roll <= Math.floor(value / 5)) return { roll, level: "crit" };
  if (roll <= Math.floor(value / 2)) return { roll, level: "hard" };
  if (roll <= value) return { roll, level: "success" };
  if (roll > 95) return { roll, level: "fumble" };
  return { roll, level: "fail" };
}

export const LEVEL_LABEL: Record<RollLevel, string> = { crit: "大成功", hard: "困难成功", success: "成功", fail: "失败", fumble: "大失败" };

/** Attack vs dodge (CoC6 simplified): attack must succeed first; dodge of equal-or-higher
 *  level negates (crit attack only negated by crit dodge). Returns full result for display. */
export function resolveAttack(atkSkillVal: number, atkLabel: string, dmgExpr: string, db: string, defenderDodgeVal: number | null, defenderLabel: string): {
  attackRoll: number; attackLevel: RollLevel; dodged: boolean; dodgeRoll?: number; dodgeLevel?: RollLevel; damage: number; damageDetail: string;
} {
  const atk = d100Level(atkSkillVal);
  if (atk.level === "fail" || atk.level === "fumble") {
    return { attackRoll: atk.roll, attackLevel: atk.level, dodged: false, damage: 0, damageDetail: "" };
  }
  let dodged = false;
  let dodgeRoll: number | undefined;
  let dodgeLevel: RollLevel | undefined;
  if (defenderDodgeVal !== null && defenderDodgeVal > 0) {
    const dod = d100Level(defenderDodgeVal);
    dodgeRoll = dod.roll; dodgeLevel = dod.level;
    if (dod.level !== "fail" && dod.level !== "fumble") {
      dodged = !(atk.level === "crit" && dod.level !== "crit") && LEVEL_RANK[dod.level] >= LEVEL_RANK[atk.level];
    }
  }
  if (dodged) {
    return { attackRoll: atk.roll, attackLevel: atk.level, dodged, dodgeRoll, dodgeLevel, damage: 0, damageDetail: "" };
  }
  // Damage: crit → max dice (贯穿); else roll
  const dmg = atk.level === "crit" ? { total: maxExpr(dmgExpr, db), detail: "贯穿(骰面取满)" } : rollExpr(dmgExpr, db);
  return { attackRoll: atk.roll, attackLevel: atk.level, dodged: false, dodgeRoll, dodgeLevel, damage: dmg.total, damageDetail: dmg.detail };
}

/** Find a weapon mention in free text (companion declarations etc.). */
export function findWeaponMention(text: string, weapons: WeaponSpec[]): WeaponSpec | null {
  const t = text || "";
  for (const w of weapons) {
    if (t.includes(w.name)) return w;
  }
  for (const w of Object.values(WEAPON_PRESETS)) {
    if (t.includes(w.name)) return w;
  }
  // combat skill words without explicit weapon → 徒手
  if (/(射击|开枪|开火|枪击)/.test(t)) return WEAPON_PRESETS["左轮手枪"];
  if (/(挥拳|重拳|拳击|打斗|斗殴|一拳)/.test(t)) return WEAPON_PRESETS["徒手"];
  return null;
}

/** Initiative order tokens sorted by DEX desc. Token: "player" | "comp:<charId>" | "hostile:<name>". */
export function buildInitiative(
  playerDex: number,
  companions: { characterId: string; dex: number }[],
  hostiles: { name: string; dex: number }[],
): string[] {
  const entries: { token: string; dex: number; jitter: number }[] = [
    { token: "player", dex: playerDex, jitter: Math.random() },
    ...companions.map(c => ({ token: `comp:${c.characterId}`, dex: c.dex, jitter: Math.random() })),
    ...hostiles.map(h => ({ token: `hostile:${h.name}`, dex: h.dex, jitter: Math.random() })),
  ];
  return entries.sort((a, b) => b.dex - a.dex || b.jitter - a.jitter).map(e => e.token);
}

// ═══════════════════════════════════════════
// Madness system (CoC6)
// ═══════════════════════════════════════════

/** CoC6 sanity loss thresholds.
 *  totalLoss ≥ 5 in one scene → 临时疯狂（不定性疯狂，1d10 rounds of temporary insanity）;
 *  san hitting 0 → 永久疯狂（indefinite insanity）. */
export function sanityLossVerdict(totalLoss: number, sanBefore: number): { temporaryMadness: boolean; goneInsane: boolean } {
  return {
    temporaryMadness: totalLoss >= 5,
    goneInsane: sanBefore - totalLoss <= 0,
  };
}

export const MADNESS_TABLE: string[] = [
  "健忘症（忘记刚才发生的一切）",
  "躯体化症状（昏厥、抽搐、失语）",
  "暴力倾向（攻击视野中的一切，包括队友）",
  "类偏执（坚信有人在追杀自己）",
  "尖叫逃窜（向远离恐怖源的方向狂奔）",
  "歇斯底里（大笑、痛哭、无法自控）",
  "恐惧症发作（针对当下的刺激源）",
  "狂躁症（不停做事、说话，无法安静）",
  "幻觉（看见不存在的东西并信以为真）",
  "木僵（呆立原地，对一切无反应）",
];

/** Roll temporary (indefinite-lite) madness symptom: d10 → symptom text. */
export function rollTemporaryMadness(): string {
  return MADNESS_TABLE[rand(0, MADNESS_TABLE.length - 1)];
}

/** Battle-round hostiles: KP declares names + DEX (approx from narration); we track hp via a simple ledger. */
export type HostileCombatant = {
  id: string;           // = name
  name: string;
  dex: number;
  hp: number;
  maxHp: number;
  notes?: string;       // KP-provided description (e.g. 深潜者×3)
};

export function makeHostile(name: string, dex: number, hp: number, notes?: string): HostileCombatant {
  return { id: name, name, dex, hp, maxHp: Math.max(1, hp), notes };
}
