import { DeterministicRng, deepClone, seed256 } from '../combat/util.js';

// This module is a server-safe port of the embedded V3.2.6 card rules.
// The card has nine life tiers (Roman Ⅰ–Ⅸ), not a 1–50 player-level scale.
// This conversion is scoped to the shop's vision gate only.  It must never be
// reused by the narrative/MVU layer as a general life-tier equivalence.
export const SHOP_RULESET_VERSION = 'v3.2.6-card-shop-vision';
export const QUALITY_ORDER = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
export const LIFE_LEVEL_ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ'];
// V3.2.6 forge_shop: Ⅰ=F, Ⅱ=E … for *商城视野* only.  The shop may show at
// most one further quality as temptation; it never changes the character's
// actual Ⅰ–Ⅸ life-tier data.
export const CARD_SHOP_DEFAULT_QUALITY_SEQUENCE = ['F'];
// These are copied from the card's embedded auxiliary calculator/worldbook,
// not from the legacy AIRPcard/数值.txt 1–50 forge helper.
export const CARD_LIFE_TIER_RANGES = {
    'Ⅰ': [1, 29], 'Ⅱ': [30, 99], 'Ⅲ': [100, 299], 'Ⅳ': [300, 999],
    'Ⅴ': [1000, 2999], 'Ⅵ': [3000, 9999], 'Ⅶ': [10000, 29999],
    'Ⅷ': [30000, 99999], 'Ⅸ': [100000, Infinity],
};
export const CARD_PRICE_RANGES = {
    F: [10, 99], E: [100, 999], D: [1000, 4999], C: [5000, 19999],
    B: [20000, 79999], A: [80000, 319999], S: [320000, 1270000],
    SS: [1280000, 5110000], SSS: [5120000, Infinity],
};
export const CARD_GROW_QUALITY_RANGES = {
    F: [1, 20], E: [5, 60], D: [12, 180], C: [36, 600], B: [120, 1800],
    A: [360, 6000], S: [1200, 18000], SS: [3600, 60000], SSS: [12000, 299999],
};
export const CARD_EQUIP_QUALITY_RANGES = {
    ATK: { F: [3, 15], E: [10, 40], D: [25, 100], C: [70, 250], B: [180, 600], A: [450, 1400], S: [1000, 3000], SS: [2200, 6500], SSS: [5000, 20000] },
    MATK: { F: [3, 15], E: [10, 40], D: [25, 100], C: [70, 250], B: [180, 600], A: [450, 1400], S: [1000, 3000], SS: [2200, 6500], SSS: [5000, 20000] },
    DEF: { F: [1, 9], E: [5, 25], D: [15, 55], C: [40, 130], B: [100, 300], A: [250, 700], S: [550, 1500], SS: [1200, 3300], SSS: [2600, 7000] },
    MDEF: { F: [1, 9], E: [5, 25], D: [15, 55], C: [40, 130], B: [100, 300], A: [250, 700], S: [550, 1500], SS: [1200, 3300], SSS: [2600, 7000] },
    AP: { F: [1, 15], E: [10, 30], D: [20, 45], C: [35, 65], B: [55, 90], A: [80, 120], S: [110, 150], SS: [140, 180], SSS: [170, 220] },
    五维: { F: [1, 9], E: [4, 18], D: [10, 45], C: [30, 110], B: [80, 260], A: [200, 600], S: [450, 1300], SS: [1000, 2800], SSS: [2200, 6000] },
};
export const CARD_SKILL_ITEM_RANGES = {
    F: { 技能伤害: [20, 50], 检定修正: [3, 7], 道具HP: [15, 80], 状态预算: 1 },
    E: { 技能伤害: [55, 120], 检定修正: [8, 12], 道具HP: [60, 250], 状态预算: 1 },
    D: { 技能伤害: [100, 250], 检定修正: [13, 18], 道具HP: [150, 600], 状态预算: 2 },
    C: { 技能伤害: [220, 550], 检定修正: [18, 24], 道具HP: [400, 1500], 状态预算: 2 },
    B: { 技能伤害: [500, 1300], 检定修正: [22, 30], 道具HP: [1000, 4000], 状态预算: 3 },
    A: { 技能伤害: [1100, 3000], 检定修正: [30, 40], 道具HP: [3000, 10000], 状态预算: 4 },
    S: { 技能伤害: [2500, 6500], 检定修正: [45, 55], 道具HP: [8000, 30000], 状态预算: '规则' },
    SS: { 技能伤害: [5500, 14000], 检定修正: [60, 80], 道具HP: [20000, 80000], 状态预算: '法则' },
    SSS: { 技能伤害: [12000, 32000], 检定修正: [100, Infinity], 道具HP: '满血', 状态预算: '概念' },
};
const RULES = {
    武器: { F: { 命中: [2, 2], 期望伤害: [4, 12] }, E: { 命中: [3, 4], 期望伤害: [10, 22] }, D: { 命中: [5, 7], 期望伤害: [18, 36] }, C: { 命中: [7, 9], 期望伤害: [30, 55] }, B: { 命中: [9, 11], 期望伤害: [48, 82] }, A: { 命中: [11, 13], 期望伤害: [72, 115] }, S: { 命中: [13, 15], 期望伤害: [105, 160] }, SS: { 命中: [15, 17], 期望伤害: [150, 225] }, SSS: { 命中: [17, 19], 期望伤害: [210, 320] } },
    身体防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 2], MDEF: [1, 2] }, D: { DEF: [2, 3], MDEF: [2, 3] }, C: { DEF: [3, 4], MDEF: [3, 4] }, B: { DEF: [4, 5], MDEF: [4, 5] }, A: { DEF: [5, 6], MDEF: [5, 6] }, S: { DEF: [6, 7], MDEF: [6, 7] }, SS: { DEF: [7, 8], MDEF: [7, 8] }, SSS: { DEF: [8, 9], MDEF: [8, 9] } },
    腿部防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 1], MDEF: [1, 1] }, D: { DEF: [1, 2], MDEF: [1, 2] }, C: { DEF: [2, 3], MDEF: [2, 3] }, B: { DEF: [3, 4], MDEF: [3, 4] }, A: { DEF: [4, 4], MDEF: [4, 4] }, S: { DEF: [4, 5], MDEF: [4, 5] }, SS: { DEF: [5, 6], MDEF: [5, 6] }, SSS: { DEF: [6, 7], MDEF: [6, 7] } },
    头部防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 1], MDEF: [1, 1] }, D: { DEF: [1, 2], MDEF: [1, 2] }, C: { DEF: [2, 2], MDEF: [2, 2] }, B: { DEF: [2, 3], MDEF: [2, 3] }, A: { DEF: [3, 3], MDEF: [3, 3] }, S: { DEF: [3, 4], MDEF: [3, 4] }, SS: { DEF: [4, 5], MDEF: [4, 5] }, SSS: { DEF: [4, 6], MDEF: [4, 6] } },
    盾牌防具: { F: { DEF: [1, 1], MDEF: [1, 1] }, E: { DEF: [1, 2], MDEF: [1, 2] }, D: { DEF: [2, 2], MDEF: [2, 2] }, C: { DEF: [2, 3], MDEF: [2, 3] }, B: { DEF: [3, 4], MDEF: [3, 4] }, A: { DEF: [4, 5], MDEF: [4, 5] }, S: { DEF: [5, 6], MDEF: [5, 6] }, SS: { DEF: [6, 7], MDEF: [6, 7] }, SSS: { DEF: [7, 8], MDEF: [7, 8] } },
    技能: { F: { 期望伤害: [7, 18], 消耗: [5, 10] }, E: { 期望伤害: [16, 34], 消耗: [10, 20] }, D: { 期望伤害: [28, 54], 消耗: [20, 40] }, C: { 期望伤害: [45, 80], 消耗: [40, 60] }, B: { 期望伤害: [70, 120], 消耗: [60, 90] }, A: { 期望伤害: [105, 165], 消耗: [90, 130] }, S: { 期望伤害: [145, 220], 消耗: [130, 200] }, SS: { 期望伤害: [205, 305], 消耗: [160, 250] }, SSS: { 期望伤害: [285, 420], 消耗: [200, 300] } },
    血统: { F: { 预算: [3, 5], 增益上限: 1, 附赠技能品质: null }, E: { 预算: [6, 10], 增益上限: 1, 附赠技能品质: null }, D: { 预算: [12, 20], 增益上限: 1, 附赠技能品质: null }, C: { 预算: [21, 35], 增益上限: 2, 附赠技能品质: 'F' }, B: { 预算: [33, 55], 增益上限: 2, 附赠技能品质: 'E' }, A: { 预算: [48, 80], 增益上限: 3, 附赠技能品质: 'D' }, S: { 预算: [66, 110], 增益上限: 3, 附赠技能品质: 'C' }, SS: { 预算: [90, 150], 增益上限: 4, 附赠技能品质: 'B' }, SSS: { 预算: [120, 200], 增益上限: 4, 附赠技能品质: 'A' } },
    // Embedded character-book entry 40: exact shop price bands.
    价格区间: CARD_PRICE_RANGES,
};
const SLOT_TABLE = [{ 子类型: '武器', 槽位: '武器' }, { 子类型: '防具', 槽位: '盾', 防具类型: '盾牌防具' }, { 子类型: '防具', 槽位: '铠甲', 防具类型: '身体防具' }, { 子类型: '防具', 槽位: '头盔', 防具类型: '头部防具' }, { 子类型: '防具', 槽位: '腿甲', 防具类型: '腿部防具' }, { 子类型: '饰品', 槽位: '腰带' }, { 子类型: '饰品', 槽位: '鞋子' }, { 子类型: '饰品', 槽位: '饰品' }];
const CATEGORY_KEYS = { bloodline: '血统列表', skill: '技能列表', equipment: '装备列表', item: '道具列表', upgrade: '升级列表' };
const CATEGORY_ALIASES = { 血统: 'bloodline', 血统列表: 'bloodline', 技能: 'skill', 技能列表: 'skill', 装备: 'equipment', 装备列表: 'equipment', 道具: 'item', 道具列表: 'item', 升级: 'upgrade', 升级列表: 'upgrade' };
const CATALOG_LIST_KEYS = [...Object.values(CATEGORY_KEYS), '形态列表'];
const VALID_SLOTS = ['武器', '法术武器', '铠甲', '头盔', '腿甲', '鞋子', '盾', '饰品', '腰带'];
const WEAPON_PROFILES = [{ min: 'F', type: '剑/刀/斧/锤/枪/拳套', mode: '近战' }, { min: 'F', type: '飞刀/飞镖/短弓/投石索', mode: '投掷' }, { min: 'F', type: '旧式手枪/袖珍枪/粗制火铳', mode: '低威力远程' }, { min: 'E', type: '长弓/手弩/火铳/左轮手枪', mode: '远程' }, { min: 'D', type: '强弩/步枪/霰弹枪/符枪/飞剑匣', mode: '远程' }, { min: 'C', type: '狙击枪/重弩/榴弹发射器', mode: '压制' }, { min: 'B', type: '电磁步枪/等离子枪/浮游刃群', mode: '科技武装' }, { min: 'A', type: '因果线枪/空间折叠炮/梦境武器', mode: '概念武装' }];
const ARTIFACT_PROFILES = [{ min: 'F', type: '符箓/铃/镜/珠', mode: '短法术' }, { min: 'E', type: '法杖/法书/阵盘', mode: '法术' }, { min: 'D', type: '剑匣/灵装/魔导器', mode: '术具' }, { min: 'C', type: '高阶阵盘/灵能炮杖', mode: '术式' }, { min: 'B', type: '星轨权杖/虚数终端', mode: '科技法术' }, { min: 'A', type: '因果书页/空间权杖', mode: '概念术具' }];

const ASCII_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
const romanToLifeNumber = new Map([...LIFE_LEVEL_ROMAN.map((value, index) => [value, index + 1]), ...ASCII_ROMAN.map((value, index) => [value, index + 1])]);
export function normalizeLifeLevel(value, fallback = 1) {
    const safeFallback = Number.isInteger(Number(fallback)) && Number(fallback) >= 1 && Number(fallback) <= 9 ? Number(fallback) : 1;
    const text = String(value ?? '').trim().toUpperCase();
    if (romanToLifeNumber.has(text)) return romanToLifeNumber.get(text);
    const numeric = Number(text);
    // The card has exactly nine life levels. Do not silently turn legacy
    // 1–50 values (or 10+) into IX; invalid values use the card's I fallback.
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= 9 ? numeric : safeFallback;
}
export function lifeLevelRoman(value) { return LIFE_LEVEL_ROMAN[normalizeLifeLevel(value) - 1] || LIFE_LEVEL_ROMAN[0]; }
const num = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
const unique = value => [...new Set((Array.isArray(value) ? value : []).map(item => String(item || '').trim()).filter(Boolean))];
const windowRange = (range, ratio = .4) => { const [min, max] = range; const span = max - min; if (span <= 0) return [min, max]; const window = span < 2 ? span : Math.max(1, span * ratio); return [min, Math.min(max, Math.round(min + window))]; };
// Product balance is selected by its own F–SSS quality.  Life tier is never
// passed into this function, preventing accidental life→quality conversion.
const levelRule = (category, qualityValue) => {
    const quality = normalizeQualityLetter(qualityValue);
    const base = RULES[category]?.[quality];
    if (!base) return null;
    if (category === '武器') return { 命中: windowRange(base.命中, .7), 期望伤害: windowRange(base.期望伤害, .4) };
    if (category === '技能') return { 期望伤害: windowRange(CARD_SKILL_ITEM_RANGES[quality].技能伤害, .4), 消耗: windowRange(base.消耗, .5) };
    if (category === '血统') return { ...base, 预算: windowRange(base.预算, .45) };
    return { DEF: windowRange(base.DEF, 1), MDEF: windowRange(base.MDEF, 1) };
};
const priceRangeForQuality = quality => [...(CARD_PRICE_RANGES[normalizeQualityLetter(quality)] || CARD_PRICE_RANGES.F)];
const nextQuality = quality => QUALITY_ORDER[Math.min(QUALITY_ORDER.indexOf(normalizeQualityLetter(quality)) + 1, QUALITY_ORDER.length - 1)];
export const shopVisionQuality = lifeLevel => QUALITY_ORDER[Math.min(normalizeLifeLevel(lifeLevel) - 1, QUALITY_ORDER.length - 1)];
const qualityAtMost = (quality, maximum) => QUALITY_ORDER[Math.min(QUALITY_ORDER.indexOf(normalizeQualityLetter(quality)), QUALITY_ORDER.indexOf(normalizeQualityLetter(maximum)))];
const qualityForIndex = (index, preferences = []) => {
    const requested = preferences.length ? preferences : CARD_SHOP_DEFAULT_QUALITY_SEQUENCE;
    return normalizeQualityLetter(requested[index % requested.length]);
};
const randomInt = (rng, min, max) => rng.int(Math.ceil(min), Math.floor(max));
const getStatInRange = (rng, rank, total, min, max) => { const ratio = rank / Math.max(total - 1, 1); const subMin = min + Math.floor((max - min) * Math.max(0, ratio - .25)); const subMax = min + Math.ceil((max - min) * Math.min(1, ratio + .25)); return randomInt(rng, subMin, subMax); };
const tieredPrices = (rng, range, count) => {
    const [min, max] = range;
    // SSS is explicitly open-ended in the card. Local fallback uses its minimum;
    // a model may provide a higher price, and the prompt/response trace keeps
    // that output visible without a silent local correction.
    if (!Number.isFinite(max)) return Array.from({ length: count }, () => min);
    const step = (max - min) / (count + 1);
    return Array.from({ length: count }, (_, i) => {
        const base = min + step * (i + 1);
        return randomInt(rng, Math.max(min, Math.floor(base - step * .4)), Math.min(max, Math.ceil(base + step * .4)));
    });
};
const diceFromExpected = (target, min, max) => { const faces = [4, 6, 8, 10, 12, 14, 16, 18, 20]; const maxCount = Math.max(1, Math.ceil(target / 2.5) + 2); let best = { count: 1, face: 4, score: Infinity }; let inRange = null; let tolerance = null; for (let count = 1; count <= maxCount; count += 1) for (const face of faces) { const exp = count * (face + 1) / 2; const candidate = { count, face, score: Math.abs(exp - target) + count * .02 }; if (candidate.score < best.score) best = candidate; if (exp >= min && exp <= max && (!inRange || candidate.score < inRange.score)) inRange = candidate; if (exp >= min * .9 && exp <= max * 1.1 && (!tolerance || candidate.score < tolerance.score)) tolerance = candidate; } const result = inRange || tolerance || best; return `${result.count}d${result.face}`; };
const randomUnit = rng => rng.nextUint32() / 0x100000000;
const diceForRank = (rng, rank, total, min, max) => { const ratio = rank / Math.max(total - 1, 1); const base = min + (max - min) * ratio; const jitter = (max - min) * .15 * (randomUnit(rng) * 2 - 1); return diceFromExpected(Math.max(min, Math.min(max, base + jitter)), min, max); };
const profileText = (rng, text) => { const parts = String(text || '').split(/[\/／]/).map(v => v.trim()).filter(Boolean); return parts.length ? parts[randomInt(rng, 0, parts.length - 1)] : text; };
const normalizeTarget = (target = {}) => { const raw = Array.isArray(target.categories) && target.categories.length ? target.categories : target.category ? [target.category] : ['all']; const categories = raw.includes('all') ? Object.keys(CATEGORY_KEYS) : unique(raw).map(item => CATEGORY_ALIASES[item] || item).filter(item => CATEGORY_KEYS[item]); const slots = unique(target.slotPreferences || target.slots).filter(item => VALID_SLOTS.includes(item)); const requestedQualities = target.qualityPreferences ?? target.品质偏好 ?? target.qualities ?? target.品质; const qualityPreferences = unique(Array.isArray(requestedQualities) ? requestedQualities : requestedQualities ? [requestedQualities] : []).map(item => String(item).trim().toUpperCase()).filter(item => CARD_QUALITY_KEYS.has(item)); return { categories: categories.length ? categories : Object.keys(CATEGORY_KEYS), slots, qualityPreferences, count: Math.max(0, Math.min(50, Math.round(num(target.count, 0)))), query: String(target.query || '').slice(0, 500), autonomous: Boolean(target.autonomous) }; };
export { normalizeTarget };

export function emptyCatalog() { return { 血统列表: [], 形态列表: [], 技能列表: [], 装备列表: [], 道具列表: [], 升级列表: [], 成员商库: {} }; }
const normalizeItem = (item = {}, key, index) => ({ id: String(item.id || `${key}-${index + 1}`), ...deepClone(item) });
const classifyFlatShopItem = item => {
    if (!item || typeof item !== 'object') return null;
    if (item.升级自 || item.升级类型 || item.替换目标 || item.所属大类) return '升级列表';
    if (item.被动属性 || item.原始属性 && !item.数量 && !item.消耗 && item.类型 === undefined) return '血统列表';
    if (item.类型 === '主动' || item.类型 === '被动' || item.技能类型分类 || item.消耗 !== undefined && item.数量 === undefined && item.原始属性 === undefined) return '技能列表';
    if (VALID_SLOTS.includes(item.类型) || Number.isInteger(item.类型) && item.原始属性 || item.命中 !== undefined || item.DEF !== undefined || item.MDEF !== undefined) return '装备列表';
    if (item.数量 !== undefined || item.效果 !== undefined || item.道具类型 !== undefined) return '道具列表';
    return null;
};
export function normalizeCatalog(value) { const source = value?.商城 && typeof value.商城 === 'object' ? value.商城 : value || {}; const out = emptyCatalog(); for (const key of CATALOG_LIST_KEYS) if (Array.isArray(source[key])) out[key] = source[key].map((item, index) => normalizeItem(item, key, index)); const flat = Array.isArray(source.商品列表) ? source.商品列表 : Array.isArray(source.items) ? source.items : []; flat.forEach(item => { const key = classifyFlatShopItem(item); if (key) out[key].push(normalizeItem(item, key, out[key].length)); }); if (source.成员商库 && typeof source.成员商库 === 'object') out.成员商库 = deepClone(source.成员商库); return out; }
const nextId = (prefix, rng) => `${prefix}_${rng.nextUint32().toString(16)}`;
const bloodlineStats = (budget, rank) => { const ps = {}; let remaining = budget; const spend = cost => { remaining = Math.max(0, remaining - cost); }; const addFlat = (key, cost, maxCount = 999) => { const count = Math.min(maxCount, Math.floor(remaining / cost)); if (count > 0) { ps[key] = (ps[key] || 0) + count; spend(count * cost); } }; const addPool = (key) => { const unit = key === 'HP加成' ? 2 : 5; const value = Math.floor(remaining) * unit; if (value > 0) { ps[key] = (ps[key] || 0) + value; spend(value / unit); } }; if (rank % 4 === 0) { addFlat('DEF加成', 5, Math.max(1, Math.floor(budget / 18))); addPool('HP加成'); } else if (rank % 4 === 1) { addFlat('ATK加成', 5, Math.max(1, Math.floor(budget / 20))); addPool('HP加成'); } else if (rank % 4 === 2) { addFlat('法术ATK加成', 5, Math.max(1, Math.floor(budget / 20))); if (remaining >= 2) { const pct = Math.floor(remaining / 2) * 2; ps.法术强度加成 = (ps.法术强度加成 || 0) + pct; spend(pct / 2); } addPool('MP加成'); } else { addFlat('豁免加成', 3, Math.max(1, Math.floor(budget / 18))); addPool('MP加成'); } return ps; };
const entityLifeLevel = item => {
    if (!item || typeof item !== 'object') return 0;
    if (item.层级 !== undefined) return normalizeLifeLevel(item.层级);
    if (item.位阶 !== undefined) return normalizeLifeLevel(item.位阶);
    // Missing life-tier metadata is unknown, not a quality-derived tier.  Use
    // the lowest life tier as a conservative upgrade eligibility default.
    return item.等级 !== undefined && Number.isInteger(Number(item.等级))
        ? normalizeLifeLevel(item.等级)
        : 1;
};
const sourceEntries = source => Object.entries(source || {}).filter(([, item]) => item && typeof item === 'object' && item.状态 !== '被夺取' && entityLifeLevel(item) > 0);
const diceExpected = value => { const match = String(value || '').replace(/\s/g, '').match(/^(\d+)d(\d+)$/i); return match ? Number(match[1]) * (Number(match[2]) + 1) / 2 : null; };
const passiveUnits = { HP加成: { value: 2, cost: 1 }, MP加成: { value: 5, cost: 1 }, ATK加成: { value: 1, cost: 5 }, DEF加成: { value: 1, cost: 5 }, 法术ATK加成: { value: 1, cost: 5 }, MDEF加成: { value: 1, cost: 5 }, 豁免加成: { value: 1, cost: 3 }, 法术强度加成: { value: 2, cost: 1 } };
const passiveBudget = stats => { const s = stats || {}; return Math.abs(num(s.HP加成)) / 2 + Math.abs(num(s.MP加成)) / 5 + Math.abs(num(s.ATK加成)) * 5 + Math.abs(num(s.DEF加成)) * 5 + Math.abs(num(s.法术ATK加成)) * 5 + Math.abs(num(s.MDEF加成)) * 5 + Math.abs(num(s.豁免加成)) * 3 + Math.abs(num(s.法术强度加成)) / 2; };
const upgradePassive = (sourceStats, targetBudget, rank, rng) => { const ps = deepClone(sourceStats || {}); const oldBudget = passiveBudget(ps); if (oldBudget <= 0) return bloodlineStats(targetBudget, rank); const preferred = Object.keys(passiveUnits).filter(key => num(ps[key]) > 0); let index = 0; while (passiveBudget(ps) < targetBudget && index < 200) { let key = preferred.length ? preferred[index % preferred.length] : rank % 2 === 0 ? 'HP加成' : 'MP加成'; let unit = passiveUnits[key]; const remaining = targetBudget - passiveBudget(ps); if (unit.cost > remaining && remaining < 5) { key = 'HP加成'; unit = passiveUnits[key]; } ps[key] = num(ps[key]) + unit.value; index += 1; } return ps; };
// Card entity rule: 0 hand-held, 1 glove, 2 head, 3 chest, 4 leg,
// 5 shoes, 6 cape, 7 accessory, 8 world relic.  Type 8 is not a shield.
const EQUIPMENT_SLOT_BY_TYPE = ['武器', '手套', '头盔', '铠甲', '腿甲', '鞋子', '披风', '饰品', '世界遗物'];
const upgradeItems = (hero, level, rng, qualityPreferences = [], maximumQuality = 'SSS') => {
    const list = [];
    let upgradeIndex = 0;
    const add = (source, type) => {
        for (const [name, old] of sourceEntries(source)) {
            if (entityLifeLevel(old) >= level) continue;
            const requestedQuality = qualityPreferences.length ? qualityForIndex(upgradeIndex, qualityPreferences) : nextQuality(old.品质);
            const quality = qualityAtMost(requestedQuality, maximumQuality);
            const range = priceRangeForQuality(quality);
            const normal = tieredPrices(rng, range, 1)[0];
            upgradeIndex += 1;
            const item = {
                id: nextId('up', rng), 名称: name, 品质: quality,
                // The embedded card only defines the quality price bands. Upgrade
                // entries are shop entries too; do not apply the old, non-card
                // 30% discount here (it pushed SSS upgrades below 5,120,000).
                价格: normal,
                升级自: name, 升级类型: type, 描述: String(old.描述 || ''),
                _forgeType: type, 类型: type,
            };
            if (type === '技能') {
                item.技能类型分类 = Number(old.类型) === 1 || old.类型 === '被动' ? '被动' : Number(old.类型) === 2 ? '特殊' : '主动';
                item.消耗 = String(old.消耗 ?? '');
                item.效果 = old.效果 || {};
                item.标签 = unique(old.标签);
            } else if (type === '血统') {
                item.原始属性 = old.原始属性 || qualityAttributeRecord(quality);
                item.效果 = old.效果 || {};
                item.标签 = unique(old.标签);
            } else {
                const numericType = Number.isInteger(old.类型) ? Math.max(0, Math.min(8, old.类型)) : EQUIPMENT_TYPE_BY_SLOT[old.槽位 || old.部位 || '饰品'] ?? 7;
                item.类型 = '装备';
                item.槽位 = EQUIPMENT_SLOT_BY_TYPE[numericType] || '饰品';
                const oldSlot = old.槽位 || old.部位 || '';
                const armorType = [2, 3, 4, 5].includes(numericType) || ['盾', '盾牌'].includes(oldSlot);
                item.原始属性 = old.原始属性 || (armorType ? { DEF: quality, MDEF: quality } : numericType === 0 ? { ATK: quality } : {});
                item.效果 = old.效果 || old.特效 || {};
                item.标签 = unique(old.标签);
            }
            list.push(item);
        }
    };
    add(hero?.技能, '技能');
    add(hero?.血统, '血统');
    add(hero?.装备栏 || hero?.装备, '装备');
    return list;
};

const compactPassiveStats = (stats = {}) => Object.fromEntries(Object.entries(stats).filter(([, value]) => Number(value) !== 0 && value !== undefined && value !== null));
const compactSpecialEffects = (value) => {
    if (!value || typeof value !== 'object') return null;
    const 增益 = Array.isArray(value.增益) ? value.增益.filter(Boolean) : [];
    const 副作用 = Array.isArray(value.副作用) ? value.副作用.filter(Boolean) : [];
    return 增益.length || 副作用.length ? { 增益, 副作用 } : null;
};
const appendUpgradeFields = (output, item) => {
    if (item.升级自 !== undefined && item.升级自 !== null && item.升级自 !== '') output.替换目标 = item.升级自;
    if (item.升级类型 !== undefined && item.升级类型 !== null && item.升级类型 !== '') output.所属大类 = item.升级类型;
    return output;
};
const EQUIPMENT_TYPE_BY_SLOT = { 武器: 0, 盾: 0, 盾牌: 0, 手套: 1, 拳套: 1, 头盔: 2, 铠甲: 3, 胸甲: 3, 腿甲: 4, 腿裤: 4, 鞋子: 5, 披风: 6, 斗篷: 6, 饰品: 7, 腰带: 7, 世界遗物: 8, 特殊: 8 };
const CARD_ATTRIBUTE_KEYS = ['力量', '敏捷', '体质', '精神', '魅力'];
const CARD_QUALITY_KEYS = new Set(QUALITY_ORDER);
const normalizeQualityLetter = (value, fallback = 'F') => {
    const text = String(value ?? '').trim().toUpperCase();
    if (CARD_QUALITY_KEYS.has(text)) return text;
    // Roman life-tier labels are not quality labels.  Never silently convert
    // Ⅰ–Ⅸ (or Arabic life-tier input) into F–SSS here.
    return fallback;
};
const qualityAttributeRecord = (quality, bias = 0) => {
    const normalized = normalizeQualityLetter(quality);
    const qualityIndex = QUALITY_ORDER.indexOf(normalized);
    // Entry 40's quality rule limits the main quality to at most half of the
    // five attributes while retaining at least two meaningful growth stats.
    // F has no lower tier, so it necessarily occupies all five attributes.
    const lower = QUALITY_ORDER[Math.max(0, qualityIndex - 1)];
    const mainCount = qualityIndex <= 0 ? CARD_ATTRIBUTE_KEYS.length : 2;
    const start = ((bias % CARD_ATTRIBUTE_KEYS.length) + CARD_ATTRIBUTE_KEYS.length) % CARD_ATTRIBUTE_KEYS.length;
    const mainIndexes = new Set(Array.from({ length: mainCount }, (_, offset) => (start + offset) % CARD_ATTRIBUTE_KEYS.length));
    return Object.fromEntries(CARD_ATTRIBUTE_KEYS.map((key, index) => [key, mainIndexes.has(index) ? normalized : lower]));
};
const effectValueToString = value => {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) return value.filter(item => item !== undefined && item !== null).map(effectValueToString).join('；');
    try { return JSON.stringify(value ?? ''); } catch (_error) { return String(value ?? ''); }
};
const itemEffectRecord = value => {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : (value ? { 描述: value } : {});
    return Object.fromEntries(Object.entries(source).map(([key, entry]) => [String(key), effectValueToString(entry)]));
};
const normalizeSparseAttributes = (value, fallbackQuality) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const allowed = new Set([...CARD_ATTRIBUTE_KEYS, 'ATK', 'DEF', 'MATK', 'MDEF', 'AP']);
    return Object.fromEntries(Object.entries(value).filter(([key]) => allowed.has(key)).map(([key, entry]) => [key, normalizeQualityLetter(entry, '')]).filter(([, entry]) => entry));
};
const bloodlineEffectRecord = (item, passive, special) => {
    const effect = itemEffectRecord(item.效果);
    if (special?.增益?.length) effect.增益 = effectValueToString(special.增益);
    if (special?.副作用?.length) effect.副作用 = effectValueToString(special.副作用);
    return effect;
};
const skillTypeNumber = item => item.技能类型分类 === '被动' || item.类型 === '被动' ? 1 : Number.isInteger(item.类型) ? Math.max(0, Math.min(2, item.类型)) : 0;
// Mirrors the card's convertToChinese() boundary: internal forge fields never
// leak into the saved catalogue, while the app id is retained for UI selection.
const convertShopItem = (item = {}) => {
    const id = item.id;
    if (item.类型 === '技能' || item._forgeType === '技能') {
        return appendUpgradeFields({ ...(id ? { id } : {}), 名称: String(item.名称 ?? ''), 品质: normalizeQualityLetter(item.品质), 类型: skillTypeNumber(item), 伤害: item.伤害, 伤害属性: item.伤害属性, 消耗: String(item.消耗 ?? 0), ...(item.标签?.length ? { 标签: unique(item.标签) } : {}), 效果: itemEffectRecord(item.效果 || (item.伤害 ? { 伤害: item.伤害, 伤害属性: item.伤害属性 || '' } : null)), 描述: String(item.描述 ?? ''), ...(item.价格 != null ? { 价格: item.价格 } : {}) }, item);
    }
    if (item.类型 === '血统' || item._forgeType === '血统') {
        const passive = compactPassiveStats(item.被动属性 || {});
        const special = compactSpecialEffects(item.特殊效果);
        const raw = normalizeSparseAttributes(item.原始属性, '');
        const fallbackAttributes = qualityAttributeRecord(item.品质, Number(item._attributeRank) || 0);
        const bloodAttributes = Object.fromEntries(CARD_ATTRIBUTE_KEYS.map(key => [key, raw[key] || fallbackAttributes[key]]));
        return appendUpgradeFields({ ...(id ? { id } : {}), 名称: item.名称, 品质: normalizeQualityLetter(item.品质), ...(item._forgeType === '血统' && item.升级自 ? { 类型: 8 } : {}), 原始属性: bloodAttributes, 效果: bloodlineEffectRecord(item, passive, special), 描述: String(item.描述 ?? ''), ...(item.标签?.length ? { 标签: unique(item.标签) } : {}), ...(item.价格 != null ? { 价格: item.价格 } : {}) }, item);
    }
    if (item.类型 === '装备' || item._forgeType === '装备') {
        const slot = item.槽位 || item.部位 || '饰品';
        const quality = normalizeQualityLetter(item.品质);
        const magic = Boolean(item._magic || item.标签?.includes?.('法术') || item.标签?.includes?.('魔法'));
        const raw = normalizeSparseAttributes(item.原始属性, '');
        const armor = item.子类型 === '防具' || ['盾', '盾牌', '铠甲', '头盔', '腿甲', '腿裤', '胸甲'].includes(slot);
        if (!Object.keys(raw).length) {
            if (slot === '武器') Object.assign(raw, { [magic ? 'MATK' : 'ATK']: quality });
            else if (armor) Object.assign(raw, { DEF: quality, MDEF: quality });
        }
        const tags = unique([...(item.标签 || []), slot]);
        return appendUpgradeFields({ ...(id ? { id } : {}), 名称: item.名称, 品质: quality, 类型: EQUIPMENT_TYPE_BY_SLOT[slot] ?? 7, 槽位: slot, 子类型: item.子类型, 原始属性: raw, 命中: item.命中, 伤害: item.伤害, DEF: item.DEF, MDEF: item.MDEF, 效果: itemEffectRecord(item.效果 || item.特效), 描述: String(item.描述 ?? ''), ...(tags.length ? { 标签: tags } : {}), ...(item.价格 != null ? { 价格: item.价格 } : {}) }, item);
    }
    if (item.类型 === '道具' || item._forgeType === '道具') {
        return appendUpgradeFields({ ...(id ? { id } : {}), 名称: item.名称, 品质: normalizeQualityLetter(item.品质), 类型: String(item.道具类型 || item.类型 || '消耗品'), 数量: item.数量 ?? 1, 效果: itemEffectRecord(item.效果), ...(item.标签?.length ? { 标签: unique(item.标签) } : {}), 描述: String(item.描述 ?? ''), ...(item.价格 != null ? { 价格: item.价格 } : {}) }, item);
    }
    return deepClone(item);
};

export function generateShopDraft({ playerLevel = 1, slotPreferences = [], target = {}, seed, hero = {}, currentCatalog = {} } = {}) {
    const level = normalizeLifeLevel(playerLevel);
    const normalized = normalizeTarget({ ...target, slotPreferences });
    const resolvedSeed = seed || `${level}:${JSON.stringify(normalized)}`;
    const rng = new DeterministicRng(seed256(resolvedSeed));
    const generated = emptyCatalog();
    const skillIds = [];
    const has = category => normalized.categories.includes(category);
    const baseQuality = shopVisionQuality(level);
    const maximumQuality = nextQuality(baseQuality);
    const temptationBudget = rng.int(1, 2);
    let temptationCount = 0;
    let generatedProductCount = 0;
    const productQuality = index => {
        if (normalized.qualityPreferences.length) return qualityAtMost(qualityForIndex(index, normalized.qualityPreferences), maximumQuality);
        generatedProductCount += 1;
        if (generatedProductCount % 5 === 0 && temptationCount < temptationBudget) {
            temptationCount += 1;
            return maximumQuality;
        }
        return baseQuality;
    };
    const productPrice = quality => tieredPrices(rng, priceRangeForQuality(quality), 1)[0];

    if (has('upgrade')) generated.升级列表 = upgradeItems(hero, level, rng, normalized.qualityPreferences, maximumQuality);
    if (has('skill')) {
        const count = randomInt(rng, 2, 3);
        generated.技能列表 = Array.from({ length: count }, (_, rank) => {
            const quality = productQuality(rank);
            const rule = levelRule('技能', quality);
            const id = nextId('sk', rng);
            skillIds.push(id);
            return { id, 名称: '___FILL_INFO___', 品质: quality, 类型: '技能', 技能类型分类: '主动', 价格: productPrice(quality), 伤害: diceForRank(rng, rank, count, rule.期望伤害[0], rule.期望伤害[1]), 伤害属性: '___FILL_INFO___', 消耗: getStatInRange(rng, rank, count, rule.消耗[0], rule.消耗[1]), 标签: ['攻击', '伤害'], 效果: '___FILL_INFO___', 描述: '___FILL_INFO___' };
        });
    }
    if (has('bloodline')) {
        const count = randomInt(rng, 2, 3);
        generated.血统列表 = Array.from({ length: count }, (_, rank) => {
            const quality = productQuality(rank);
            const rule = levelRule('血统', quality);
            const item = { id: nextId('bl', rng), 名称: '___FILL_INFO___', 品质: quality, 类型: '血统', _attributeRank: rank, 价格: productPrice(quality), 被动属性: bloodlineStats(getStatInRange(rng, rank, count, rule.预算[0], rule.预算[1]), rank) };
            if (rule.附赠技能品质 !== null && skillIds.length) item.附带技能 = skillIds[rank % skillIds.length];
            return item;
        });
    }
    if (has('equipment')) for (const slot of SLOT_TABLE) {
        const preferred = normalized.slots.includes(slot.槽位) || (slot.槽位 === '武器' && normalized.slots.includes('法术武器'));
        const count = slot.槽位 === '武器' ? (preferred ? randomInt(rng, 3, 4) : randomInt(rng, 2, 3)) : slot.子类型 === '防具' ? (preferred ? randomInt(rng, 2, 3) : randomInt(rng, 1, 2)) : (normalized.slots.length ? randomInt(rng, 0, 1) : randomInt(rng, 0, 2));
        if (count <= 0) continue;
        for (let rank = 0; rank < count; rank += 1) {
            const quality = productQuality(rank);
            const rule = slot.子类型 === '武器' ? levelRule('武器', quality) : levelRule(slot.防具类型, quality);
            const item = { id: nextId('eq', rng), 名称: '___FILL_INFO___', 类型: '装备', 品质: quality, 价格: productPrice(quality), 子类型: slot.子类型, 槽位: slot.槽位, 描述: '___FILL_INFO___' };
            if (slot.子类型 === '武器') {
                const magic = normalized.slots.includes('法术武器') && !normalized.slots.includes('武器') ? true : normalized.slots.includes('法术武器') && normalized.slots.includes('武器') ? rank % 2 === 1 : randomUnit(rng) < .35;
                item._magic = magic;
                const profile = (magic ? ARTIFACT_PROFILES : WEAPON_PROFILES).filter(p => QUALITY_ORDER.indexOf(p.min) <= Math.min(QUALITY_ORDER.indexOf(quality) + (randomUnit(rng) < .18 ? 1 : 0), QUALITY_ORDER.indexOf('C')));
                item.命中 = getStatInRange(rng, rank, count, rule.命中[0], rule.命中[1]);
                item.伤害 = diceForRank(rng, rank, count, rule.期望伤害[0], rule.期望伤害[1]);
                const picked = profile[randomInt(rng, 0, Math.max(0, profile.length - 1))] || (magic ? ARTIFACT_PROFILES : WEAPON_PROFILES)[0];
                item.标签 = unique([profileText(rng, picked.type), profileText(rng, picked.mode), magic ? '法术' : '物理', '攻击', '武器']);
            } else if (slot.子类型 === '防具') {
                item.DEF = getStatInRange(rng, rank, count, rule.DEF[0], rule.DEF[1]);
                item.MDEF = getStatInRange(rng, rank, count, rule.MDEF[0], rule.MDEF[1]);
                item.标签 = ['轻便', '防具'];
                if (!['腿甲', '头盔'].includes(slot.槽位)) item.标签 = ['防具'];
            } else {
                item.特效 = '___FILL_INFO___';
                item.标签 = slot.槽位 === '鞋子' ? ['轻便', '脱身', '饰品'] : ['特殊', '饰品'];
            }
            generated.装备列表.push(item);
        }
    }
    if (has('item')) {
        const count = randomInt(rng, 2, 3);
        generated.道具列表 = Array.from({ length: count }, (_, rank) => {
            const quality = productQuality(rank);
            return { id: nextId('it', rng), 名称: '___FILL_INFO___', 类型: '道具', 品质: quality, 价格: productPrice(quality), 数量: 1, 道具类型: '___FILL_INFO___', 效果: '___FILL_INFO___', 标签: rank % 2 === 0 ? ['脱身'] : ['潜行'], 描述: '___FILL_INFO___' };
        });
    }
    const converted = emptyCatalog();
    for (const key of Object.values(CATEGORY_KEYS)) converted[key] = generated[key].map(convertShopItem);
    const catalog = normalizeCatalog(currentCatalog); for (const key of Object.values(CATEGORY_KEYS)) if (has(Object.keys(CATEGORY_KEYS).find(k => CATEGORY_KEYS[k] === key))) catalog[key] = converted[key];
    const qualitySet = [...new Set(Object.values(converted).flatMap(items => Array.isArray(items) ? items.map(item => normalizeQualityLetter(item.品质, '')) : []).filter(Boolean))];
    return { catalog, generated: converted, target: normalized, playerLevel: level, playerLifeLevel: lifeLevelRoman(level), qualitySet, qualityPolicy: 'tavern-shop-vision', baseQuality, priceRange: priceRangeForQuality(baseQuality), priceRanges: Object.fromEntries(qualitySet.map(quality => [quality, priceRangeForQuality(quality)])), seed: seed256(resolvedSeed), rulesetVersion: SHOP_RULESET_VERSION, rngIndex: rng.index };
}

export function mergeApiCatalog(draftCatalog, responseCatalog, target) {
    const result = normalizeCatalog(draftCatalog);
    const incoming = normalizeCatalog(responseCatalog);
    // No balance correction is performed here. The prompt is the contract;
    // if an upstream model returns a wrong price or number, keep it visible so
    // the prompt/API trace can be audited instead of masking the defect.
    const modelFields = ['名称', '描述', '道具类型', '伤害属性', '标签', '效果', '特效', '特殊效果', '价格', '品质', '原始属性', '消耗', '伤害', '命中', 'DEF', 'MDEF', '类型', '数量', '附带技能', '槽位', '子类型'];
    for (const category of target.categories) {
        const key = CATEGORY_KEYS[category];
        const items = incoming[key]?.length ? incoming[key] : (draftCatalog[key] || []);
        result[key] = items.slice(0, draftCatalog[key]?.length || items.length || 50).map((item, index) => {
            const base = draftCatalog[key]?.[index] || {};
            const safe = {};
            for (const field of modelFields) if (item[field] !== undefined) safe[field] = field === '效果' || field === '特效' || field === '特殊效果' ? itemEffectRecord(item[field]) : field === '标签' ? unique(item[field]) : deepClone(item[field]);
            if (item.特殊效果 !== undefined && category === 'bloodline') safe.效果 = { ...(safe.效果 || {}), ...itemEffectRecord(item.特殊效果) };
            return { ...deepClone(base), ...safe, id: base.id || item.id };
        });
    }
    return result;
}

export function shopModelPrompt({ draft, target, playerLevel, characterName, query }) {
    const roman = lifeLevelRoman(playerLevel);
    const baseQuality = shopVisionQuality(playerLevel);
    const maximumQuality = nextQuality(baseQuality);
    const skillRanges = QUALITY_ORDER.map(quality => `${quality}[技能${CARD_SKILL_ITEM_RANGES[quality].技能伤害[0]}-${CARD_SKILL_ITEM_RANGES[quality].技能伤害[1]}|检定+${CARD_SKILL_ITEM_RANGES[quality].检定修正[0]}-${Number.isFinite(CARD_SKILL_ITEM_RANGES[quality].检定修正[1]) ? CARD_SKILL_ITEM_RANGES[quality].检定修正[1] : '100以上'}|道具HP ${typeof CARD_SKILL_ITEM_RANGES[quality].道具HP === 'string' ? CARD_SKILL_ITEM_RANGES[quality].道具HP : `${CARD_SKILL_ITEM_RANGES[quality].道具HP[0]}-${CARD_SKILL_ITEM_RANGES[quality].道具HP[1]}`}|状态预算${CARD_SKILL_ITEM_RANGES[quality].状态预算}]`).join('、');
    return `你是《轮回战场》V3.2.6 卡片的 forge_shop 文案填充器。你的任务是给服务器草案补全文案，不是重新设计数值。

【商城视野】当前玩家层级为${roman}。仅在本次商城生成中，严格遵循原卡视野表（Ⅰ=F，Ⅱ=E……）：本次基础视野为${baseQuality}，最高可展示${maximumQuality}；${maximumQuality}级仅可作为少量诱惑商品。此规则只用于商城，禁止写入角色正文、角色档案或 MVU 的生命层级字段。

【草案数据契约】草案中的每个商品已经由服务器按卡片规则生成并锁定。你必须按原索引/原 id 原样保留：品质、价格、消耗、原始属性、附带技能引用，以及伤害、命中、DEF、MDEF 等数值字段。不得重算、四舍五入、折扣、升级或引用旧记录。你可以只返回需要补全的文案字段；服务器会把文案合并回对应草案，任何未返回字段都以草案为准。

【价格硬规则】价格必须服从商品自身品质：F[10,99]、E[100,999]、D[1000,4999]、C[5000,19999]、B[20000,79999]、A[80000,319999]、S[320000,1270000]、SS[1280000,5110000]、SSS[5120000,+∞]。F 级价格只能是 10–99，100 或更高均为错误。

【技能/道具/状态锚点】${skillRanges}。技能伤害写入草案的伤害字段或效果字符串时，必须复制草案值；不要自行生成 2d6、2d10 等不在对应品质区间的旧式数值。效果必须是扁平的“键:字符串”记录，不得嵌套对象或数组。

${target?.autonomous ? '【自主刷新目标】先输出“刷新目标”，其中 categories、slotPreferences、qualityPreferences 只能使用协议允许的值；只返回你决定刷新的类别，其余类别列表置空。qualityPreferences 只允许 F/E/D/C/B/A/S/SS/SSS。' : ''}
【输出协议】只返回一个 JSON 对象，必须包含：刷新目标、血统列表、技能列表、装备列表、道具列表、升级列表；也兼容直接返回商品列表。每个列表条目优先只返回名称、标签、描述、效果、特效、伤害属性、道具类型等文案字段，不得输出与草案不同的品质、价格或数值。

当前目标：${JSON.stringify(target)}
人物：${characterName || '轮回者'}
额外要求：${query || '无'}

【草案快照】
${JSON.stringify(draft)}`;
}

const yamlInline = value => {
    if (value === undefined || value === null || value === '') return '{}';
    try { return JSON.stringify(value); } catch (_error) { return '{}'; }
};

const ownedSummary = (label, entries = {}) => {
    const source = entries && typeof entries === 'object' ? Object.entries(entries) : [];
    if (!source.length) return `${label}: 无`;
    return `${label}:\n${source.map(([name, item]) => {
        const value = item && typeof item === 'object' ? item : {};
        const quality = String(value.品质 ?? value.quality ?? '未定');
        const level = value.层级 ?? value.位阶;
        const attributes = value.原始属性 ?? value.被动属性 ?? {};
        const effects = value.效果 ?? value.特效 ?? {};
        return `  - ${name} [${level ? `层级:${level} | ` : ''}${quality}级 | 属性:${yamlInline(attributes)} | 效果:${yamlInline(effects)} | 描述:${String(value.描述 ?? '').replace(/\s+/g, ' ').slice(0, 300) || '无'}]`;
    }).join('\n')}`;
};

const ownedSummaryIfPresent = (label, entries = {}) => {
    const source = entries && typeof entries === 'object' ? Object.entries(entries) : [];
    return source.length ? ownedSummary(label, entries) : '';
};

// Mirrors the user message captured from the original V3.2.6 forge_shop
// invocation.  Numerical balance belongs to the card rule entries in the
// system message; this message supplies only the live MVU subject and the
// player's optional core demand.
export function tavernShopUserPrompt({ playerLevel, characterName, hero = {}, query }) {
    const roman = lifeLevelRoman(playerLevel);
    const identity = Array.isArray(hero.身份) ? hero.身份.filter(Boolean).join('/') : String(hero.身份 ?? hero.阵营 ?? '未定');
    const race = String(hero.种族 ?? '未定');
    const currency = hero.空间币 ?? '未定';
    const demand = String(query || '').trim() || '请基于当前构筑、购买力与权限自主决定本次核心商品需求。';
    const owned = [
        ownedSummaryIfPresent('已有血统', hero.血统),
        ownedSummaryIfPresent('已有技能', hero.技能),
        ownedSummaryIfPresent('已有装备', hero.装备栏 || hero.装备),
        ownedSummaryIfPresent('已有道具', hero.道具),
        ownedSummaryIfPresent('已有形态', hero.形态库),
    ].filter(Boolean).join('\n');
    // This template intentionally retains the original examples (including
    // their uneven example quality/price combinations).  They are model
    // anchors in the captured Tavern request, not local balancing rules.
    return `
【当前购买对象数据】
本次购买目标: 主角(玩家本人)
种族: ${race}
身份: ${identity}
层级: ${roman}
空间币: ${currency}${owned ? `\n${owned}` : ''}

【输出结构】
血统列表:
  - 名称: 血统名
    品质: E
    标签: ["主神空间", "强化"]
    原始属性: {"力量": "E", "敏捷": "C", "体质": "D", "精神": "D", "魅力": "E"}
    效果: {体能充沛: 基础生命恢复速度小幅提升}
    描述: 简短描述
    价格: 450
技能列表:
  - 名称: 技能名
    品质: F
    类型: 0
    标签: ["主神空间", "被动"]
    效果: {射击校准: 射击检定+5}
    描述: 简短描述
    消耗: 无
    价格: 80
装备列表:
  - 名称: 装备名
    品质: F
    类型: 0
    标签: ["主神空间", "科技"]
    原始属性: {"DEF": "C"}
    效果: {防弹: 对实弹伤害额外减免2点}
    描述: 简短描述
    消耗: 无
    价格: 50
道具列表:
  - 名称: 道具名
    品质: F
    类型: 消耗品
    数量: 3
    标签: ["主神空间", "辅助"]
    效果: {急救: 恢复10HP}
    描述: 简短描述
    价格: 50
形态列表:
  - 名称: 形态名称
    层级: {按形态自身战斗位格生成，Ⅰ－Ⅸ}
    消耗: HP/EP/特殊资源
    状态: 完好
    标签: ["主神空间", 依赖的道具/血统/来源等]
    原始属性: {基础属性/衍生属性: 品质}
    效果: { [词条]: 描述 }
    技能: {
     - 名称: 技能名
       品质: F
       类型: 0
       标签: ["主神空间", "被动"]
       效果: {射击校准: 射击检定+5}
       描述: 简短描述
       消耗: 无}
    描述: 简短描述
    价格: 300
升级列表:
  - 名称: 进阶装备/技能/血统/形态名称 (例: M16A2突击步枪·改)
    替换目标: 原有物品确切名称 (例: M16A2突击步枪)
    所属大类: 装备 (必填: 血统/技能/装备/形态)
    层级: ${roman}
    品质: E
    类型: 0
    标签: ["主神空间", "科技", "升级"]
    原始属性: {"DEF": "C"}
    效果: {防弹: 强化减伤效果至4点}
    描述: 回收旧型号进行重铸升阶后的成品
    消耗: 无
    价格: 300

【本次核心商品需求】
  ${demand}

现在请基于上述核心需求进行精准检索与配套生成（允许部分列表为空），仅输出 YAML:
`;
}
