import ejs from 'ejs';
import lodashDefault, * as lodashModule from 'lodash-es';
import YAML from 'yaml';
import { z } from 'zod';
import { normalizeRelationships } from './store.js';

const clone = value => structuredClone(value ?? {});
const lodash = lodashDefault ?? lodashModule;
const EXTERNAL_PROMPT = Symbol('externalPrompt');

// V3.2.6's opening page writes both weapons and shields as type 0 (the shared
// hand-held slot).  Its calculator, however, used type 0 alone to decide what
// appears in 最终属性.武器.  Consequently a DEF-only shield inherited the
// unarmed ATK/MATK display and looked like an attack weapon.  Keep the card's
// numeric type and slot protocol intact, but make the calculator use the
// original item semantics (shield tags + defensive raw attributes) as well.
function patchShieldClassificationInCalculator(source) {
    const condition = 'if (safeNum(e.类型, 0) === 0) {';
    const recalc = 'function recalcCharacter(char, label, charBefore) {';
    if (!String(source).includes(condition) || !String(source).includes(recalc)) return { source, patched: false };
    const helper = `function isDefensiveHandheldEquipment(e) {
        if (!e || typeof e !== 'object' || safeNum(e.类型, 0) !== 0) return false;
        const tags = Array.isArray(e.标签) ? e.标签 : [];
        const raw = e.原始属性 && typeof e.原始属性 === 'object' ? e.原始属性 : {};
        const shieldTag = tags.some(tag => /盾|防暴/i.test(String(tag)));
        const defensiveOnly = (Object.prototype.hasOwnProperty.call(raw, 'DEF') || Object.prototype.hasOwnProperty.call(raw, 'MDEF'))
            && !Object.prototype.hasOwnProperty.call(raw, 'ATK')
            && !Object.prototype.hasOwnProperty.call(raw, 'MATK');
        return shieldTag || defensiveOnly;
    }

    ${recalc}`;
    return {
        source: String(source)
            .replace(recalc, helper)
            .replace(condition, 'if (safeNum(e.类型, 0) === 0 && !isDefensiveHandheldEquipment(e)) {'),
        patched: true,
    };
}

// This is the exact card-entry order used by the V3.2.6 forge_shop request
// captured from SillyTavern.  The entries are rendered in the browser so EJS
// sees the live MVU data rather than a stale server-side copy.
const TAVERN_SHOP_ENTRY_COMMENTS = [
    '⚙️品质效果数值规则',
    '⚙️实体生成规则',
    '⚙️状态协议',
    '⚙️行为判定[mvu_plot]',
];

const TAVERN_SHOP_HEADER = `你是「主神兑换终端」的商品生成子系统。玩家在主神空间开启商城, 需要你生成一批可购买商品。
世界观: 轮回战场, 玩家穿越各副本世界完成任务, 在主神空间用「空间币」兑换装备/技能/血统/道具/形态。
【系统设定】
属性系统 (底层定义):
  基础五维 (判定依据):
    力量: 近战/负重/破坏
    敏捷: 平衡/潜行/瞄准
    体质: 生命/耐性/恢复
    精神: 施法/察觉/意志
    魅力: 社交/欺骗/威吓
  衍生属性 (自动计算):
    HP: 生命值，归零进入濒死，【濒死状态再次受伤则死亡】
    HP_MAX: 生命值上限
    THP: 临时生命值/护盾，受到伤害时优先扣减，不叠加，脱战归零
    EP: 能量值，用于技能消耗
    EP_MAX: 能量值上限
    ATK: 物理攻击
    DEF: 物理防御
    MATK: 法术攻击
    MDEF: 法术防御
    AP: 法术强度乘区
    先攻DC: 行动顺序
    防御DC: 被命中难度`;

// This suffix is retained verbatim from the supplied SillyTavern request.
// It intentionally includes the card's original shop-visibility wording;
// see the alignment notes for its conflict with the newer independent
// life-tier/quality interpretation.
const TAVERN_SHOP_TRAILING_SPACE = ' ';
const TAVERN_SHOP_SUFFIX = `【生成约束】
1. 贴合度: 根据玩家当前的构筑（偏向物理/近战/生存）、职业和购买力生成。
2. 品质与视野权限控制 (商城解锁铁律):
   - 【前置扫描】: 生成商品前，必须严格检索【当前玩家数据】中的道具/状态，确认玩家当前层级以及是否持有【高阶权限凭证】。
   - 【基础视野】: 若无特殊凭证，商城视野 =【玩家当前层级+1阶】（Ⅰ=F，Ⅱ=E…）；允许生成1~2件【商城视野+1阶】商品作为诱惑（此为平民极限）。
   - 【凭证覆盖】: 若玩家持有高于【玩家当前层级+1阶】的【X级权限凭证】（例:D级凭证），则本条直接覆盖【基础视野】，商城视野固定为【X级】。
   - 【绝对红线】: 商品最高品质 =【商城视野+1阶】。商城视野只能来源于【基础视野】或【权限凭证】其中之一，禁止叠加计算。阶位序列:F→E→D→C→B→A→S→SS→SSS。权限凭证绝不出售或展示！
   - 【纯净展示】: 权限凭证仅用于决定商城视野。商品一旦生成即可直接购买，禁止在商品描述或购买条件中再次要求权限凭证。
   - 避免与玩家已有物品功能完全重复。
3. 升级重铸机制:${TAVERN_SHOP_TRAILING_SPACE}
   - 仔细检阅【当前玩家数据】，挑选玩家现有的低阶血统、技能、装备或形态，生成高阶强化版本放入「升级列表」。必须直接生成升级后的完整成品面板，绝对禁止采用词条增量打补丁！必须提供精准的 \`替换目标\`，以便系统进行回收替换。同一目标可提供多个选项。
   - 【阶位限制规则】: 升级与重铸的阶位上限，严格与上述第2条的【品质与视野权限控制】同步。绝不能生成超出玩家视野上限的升级方案。
   - 【形态升级特例】: 形态的【层级】(如Ⅰ、Ⅱ)提升极其困难！禁止跨层级直接升级。只有当目标形态的五维综合品质极高（例如全属性达到S，或至少包含2~3个SSS加若干B，总体量相当于24点资质）时，才允许提供跃迁至下一层级的升级服务。若未达标，只能提供【同层级内】的强化服务（即保持层级不变，仅提升部分属性评级、强化效果或追加技能）。
   - 【升级继承规则】:
      * 升级商品必须完整继承替换目标的已有有效词条。
      * 禁止使用“融合了原能力”“保留部分能力”等模糊描述替代实际词条记录。
      * 原装备/技能/血统的已有效果必须逐条迁移到新面板【效果】字段中。
      * 若旧词条被改造、合并或替换，必须明确记录原词条 → 新词条的对应关系。
4. 核心聚焦: 玩家提出了明确的【核心需求】。商品生成必须以此为绝对中心。允许某些分类为空（不生成）。若生成其他类型的商品，必须与核心需求构成【流派联动】（例如需求是"狙击枪"，则配套生成"隐身技能"、"穿甲弹药道具"等）。总数控制在 16~24 个。
5. 商品职责隔离:
   - 【血统与形态严格隔离】: 两者必须彻底解耦，绝对禁止生成“附带变身形态的血统”。血统是底层生命本质的被动改造；形态是可激活的独立战斗变身面板或外置武装系统。
   - 【形态列表】: 禁止Ⅶ级以上形态商品出售。
   - 【血统列表】: 仅生成玩家未拥有的独立血统体系。若属于玩家已有血统的同源强化、进化、觉醒版本，必须进入升级列表。禁止S级以上血统商品出售。
   - 【升级列表】:${TAVERN_SHOP_TRAILING_SPACE}
      * 仅处理玩家当前已有血统、技能、装备、形态的强化、升阶、重铸或觉醒。必须填写准确替换目标。
   - 【世界遗物规则】:
      * 世界遗物禁止作为商城普通商品生成。
      * 世界遗物只能通过任务世界探索、特殊事件、剧情奖励或世界结算获得。
      * 主神空间仅提供世界遗物的解析、修复、强化、融合等服务，不直接出售新的世界遗物。
      * 世界遗物不可进入普通装备栏体系，不作为常规装备替代品处理。
   - 同一目标禁止同时作为普通商品与升级商品出现。
   - 禁止提供金融类服务，如贷款，彩票等一切让玩家额外获得空间币的商品或能力。
6. 修炼类道具规则:
   - 【道具列表】允许生成秘籍、功法、心法、修炼资料等成长型道具。
   - 修炼类道具属于学习媒介，不直接生成技能或被动效果；购买后需通过修炼过程生成对应成长型状态。
   - 若商品描述为功法、修真秘籍、内功心法、魔法研究资料、身体强化方案等，应优先作为【道具】生成，而非【技能】。
   - 技能列表仅用于角色已经掌握、可直接使用的能力，不用于记录学习材料或成长路径。
   - 技能列表禁止生成需要长期学习、修炼积累或改变生命结构才能获得的体系能力。
   - 品质参考:
      * 普通武学、基础训练类秘籍: F-E级
      * 高深武学、内功心法、特殊技艺传承: D-C级
      * 修炼体系、生命进化、长期身体改造类秘籍: 通常不低于D级，依据实际成长潜力评估
   - 禁止将长期修炼体系压缩为单个技能出售，例如禁止把“修真功法”“血脉觉醒法”“内功心法”直接生成技能。
【严格输出格式】
仅输出 YAML 文本, 不要解释、不要 markdown 代码围栏。顶层为六个列表键: 血统列表 / 形态列表 / 技能列表 / 装备列表 / 道具列表 / 升级列表, 每项以 "  - " 开头。
字段类型必须严格遵守:
  - 层级: 字符串, 仅可选 Ⅰ / Ⅱ / Ⅲ / Ⅳ / Ⅴ / Ⅵ / Ⅶ / Ⅷ / Ⅸ
  - 品质: 字符串, 仅可选 F / E / D / C / B / A / S / SS / SSS
  - 标签: 行内数组 ['标签1', '标签2'...]
  - 原始属性: 行内对象。血统必须完整包含五维（力量、敏捷、体质、精神、魅力）；【形态】必须完整包含五维，且强制附加相关的【衍生属性】；每项最低品质为F；装备仅写非0项。
  - 效果: 行内对象 {效果名: '描述'}, 键为字符串, 值为字符串描述
  - 价格: 数字(空间币)
  - 描述/消耗: 字符串
  - 类型:
      技能列表.类型 = 数字 0(主动) / 1(被动) / 2(特殊)
      装备列表.类型 = 数字 0(武器) / 1(手套) / 2(头部) / 3(胸部) / 4(腿部) / 5(鞋子) / 6(披风) / 7(饰品)
      道具列表.类型 = 字符串(消耗品/材料/特殊等, 同类型需复用且不得细分)
  - 替换目标: 字符串 (仅【升级列表】内商品必填，必须与玩家当前拥有的原物品名称一字不差！)
  - 所属大类: 字符串 (仅【升级列表】内商品必填，仅限填写: 血统 / 形态 / 技能 / 装备)
  - 道具列表.数量 = 数字(该商品可购入的库存份数, ≥1)
对象键禁止使用英文句点，口径类X.Ymm统一写作X·Y（例：5.56mm弹药→5·56弹药）;`;

function parseRegex(source) {
    if (!source) return null;
    if (source.startsWith('/')) {
        const end = source.lastIndexOf('/');
        if (end > 0) {
            try { return new RegExp(source.slice(1, end), source.slice(end + 1)); } catch { return null; }
        }
    }
    try { return new RegExp(source, 'g'); } catch { return null; }
}

function pointerParts(pointer) {
    return String(pointer || '').split('/').slice(1).map(item => item.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function getParent(root, pointer) {
    const parts = pointerParts(pointer);
    const key = parts.pop();
    let parent = root;
    for (const part of parts) {
        if (parent?.[part] === undefined) parent[part] = {};
        parent = parent[part];
    }
    return { parent, key };
}

// Card Zod schemas and legacy helper scripts are allowed to normalize item
// objects, but the standalone combat terminal needs these opaque bookkeeping
// keys to survive that round trip unchanged.
function preserveCombatAssetMetadata(targetEntity, sourceEntity) {
    if (!targetEntity || !sourceEntity || typeof targetEntity !== 'object' || typeof sourceEntity !== 'object') return;
    // Combat terminal metadata belongs to the entity itself, not to the
    // Tavern card's narrative schema.  Zod strips unknown root keys from an
    // NPC on every MVU write; preserving these keys is what lets an existing
    // dog/NPC carry its audited local combat profile into a later battle
    // instead of being silently replaced by a fresh AI guess.
    const combatProfileKeys = ['战斗档案', '战斗属性', '战斗数据', 'combatProfile', 'combat'];
    const hasCombatProfile = combatProfileKeys.some(key => sourceEntity[key] !== undefined && sourceEntity[key] !== null);
    for (const key of combatProfileKeys) if (sourceEntity[key] !== undefined) targetEntity[key] = clone(sourceEntity[key]);
    // A Tavern card schema may legally coerce an NPC's generic fields to its
    // starter defaults (for example HP=1) when it does not know about the
    // standalone terminal's combat dossier.  Once an entity has an explicit
    // local dossier, those card-side defaults must not overwrite the
    // authoritative combat snapshot.  Keep the narrative schema behavior for
    // ordinary entities that have no dossier at all.
    if (hasCombatProfile) {
        for (const key of ['层级', 'HP', 'HP_MAX', 'THP', 'EP', 'EP_MAX', '最终属性', '装备', '技能', '道具']) {
            if (sourceEntity[key] !== undefined) targetEntity[key] = clone(sourceEntity[key]);
        }
    }
    for (const collectionKey of ['装备', '道具', '技能']) {
        const targetCollection = targetEntity[collectionKey], sourceCollection = sourceEntity[collectionKey];
        if (!targetCollection || !sourceCollection || typeof targetCollection !== 'object' || typeof sourceCollection !== 'object') continue;
        const sourceEntries = Array.isArray(sourceCollection) ? sourceCollection.map((item, index) => [String(index), item]) : Object.entries(sourceCollection);
        for (const [key, sourceItem] of sourceEntries) {
            const targetItem = Array.isArray(targetCollection) ? targetCollection[Number(key)] : targetCollection[key];
            if (!targetItem || !sourceItem || typeof targetItem !== 'object' || typeof sourceItem !== 'object') continue;
            for (const metadataKey of ['战斗资产ID', '战斗资产指纹']) if (sourceItem[metadataKey] !== undefined) targetItem[metadataKey] = clone(sourceItem[metadataKey]);
        }
    }
}

export class CardRuntime extends EventTarget {
    constructor(cardEnvelope, store) {
        super();
        this.envelope = cardEnvelope;
        this.card = cardEnvelope.data ?? cardEnvelope;
        this.store = store;
        this.schema = null;
        this.loadedScripts = [];
        this.failedScripts = [];
        this.activePreset = null;
        this.externalRegexPresets = [];
        this.promptVariables = {};
        this.promptContext = { lastUserMessage: '', lastMessage: '' };
        this.externalPrompts = new Map();
        this.events = new Map();
        this.customWorldbook = [];
        this.installGlobals();
    }

    setPreset(preset) {
        this.activePreset = preset || null;
    }

    setRegexPresets(presets = []) {
        this.externalRegexPresets = presets.filter(item => item?.enabled !== false);
    }

    // User-managed worldbook entries (世界书管理 view) ride along with the
    // card's own character_book through the exact same activation, EJS
    // rendering and depth-injection pipeline.
    setCustomWorldbook(entries = []) {
        this.customWorldbook = (Array.isArray(entries) ? entries : []).filter(item => item && item.enabled !== false);
    }

    injectPrompts(prompts = []) {
        const list = Array.isArray(prompts) ? prompts : [prompts];
        const ids = [];
        for (const prompt of list) {
            if (!prompt) continue;
            const id = String(prompt.id || prompt.identifier || crypto.randomUUID());
            ids.push(id);
            if (prompt.content === null || prompt.content === undefined || prompt.content === '') this.externalPrompts.delete(id);
            else this.externalPrompts.set(id, { id, role: 'system', position: 'in_chat', depth: 0, ...prompt });
        }
        return { uninject: () => ids.forEach(id => this.externalPrompts.delete(id)) };
    }

    get variables() {
        return this.store.activeSession?.variables ?? {};
    }

    createInitialVariables() {
        const entry = this.card.character_book?.entries?.find(item => /\[InitVar\]/i.test(item.comment || ''));
        try { return { stat_data: YAML.parse(entry?.content || '{}') ?? {} }; } catch { return { stat_data: {} }; }
    }

    on(name, callback) {
        if (!this.events.has(name)) this.events.set(name, new Set());
        this.events.get(name).add(callback);
        return () => this.events.get(name)?.delete(callback);
    }

    async emit(name, ...args) {
        for (const callback of this.events.get(name) ?? []) {
            try { await callback(...args); } catch (error) { console.error(`[runtime:${name}]`, error); }
        }
    }

    installGlobals() {
        const runtime = this;
        window._ = lodash;
        window.z = z;
        window.GS_PARENT = window;
        window.$ = callback => {
            if (typeof callback !== 'function') {
                const nodes = callback instanceof Node || callback === window
                    ? [callback]
                    : [...document.querySelectorAll(String(callback))];
                return {
                    nodes,
                    length: nodes.length,
                    remove() { nodes.forEach(node => node.remove()); return this; },
                    append(content) { nodes.forEach(node => node.insertAdjacentHTML('beforeend', String(content))); return this; },
                    on(name, listener) { nodes.forEach(node => node.addEventListener(name, listener)); return this; },
                    off(name, listener) { nodes.forEach(node => node.removeEventListener(name, listener)); return this; },
                    addClass(name) { nodes.forEach(node => node.classList.add(name)); return this; },
                    removeClass(name) { nodes.forEach(node => node.classList.remove(name)); return this; },
                    first() { return window.$(nodes[0]); },
                    get(index) { return nodes[index]; },
                };
            }
            if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', callback, { once: true });
            else queueMicrotask(callback);
        };
        window.getMessageVar = function (path, options = {}) {
            const value = lodash.get(runtime.variables, path);
            return value === undefined ? clone(options.defaults) : value;
        };
        window.setMessageVar = async function (path, value) {
            const variables = clone(runtime.variables);
            lodash.set(variables, path, value);
            await runtime.replaceVariables(variables);
        };
        window.getVariables = () => clone(runtime.variables);
        window.updateVariablesWith = async callback => {
            const variables = clone(runtime.variables);
            const result = await callback(variables);
            await runtime.replaceVariables(result ?? variables);
        };
        window.eventOn = (name, callback) => runtime.on(name, callback);
        window.eventEmit = (name, ...args) => runtime.emit(name, ...args);
        window.waitGlobalInitialized = async name => window[name];
        window.initializeGlobal = (name, value) => { window[name] = value; };
        window.toastr = {
            success: message => runtime.notify(message, 'success'),
            error: message => runtime.notify(message, 'error'),
            warning: message => runtime.notify(message, 'warning'),
            info: message => runtime.notify(message, 'info'),
        };
        window.registerMvuSchema = schema => { runtime.schema = schema; };
        window.Mvu = {
            events: {
                VARIABLE_INITIALIZED: 'mag_variable_initiailized',
                VARIABLE_UPDATE_STARTED: 'mag_variable_update_started',
                COMMAND_PARSED: 'mag_command_parsed',
                VARIABLE_UPDATE_ENDED: 'mag_variable_update_ended',
                BEFORE_MESSAGE_UPDATE: 'mag_before_message_update',
            },
            getMvuData: () => clone(runtime.variables),
            replaceMvuData: async value => runtime.replaceVariables(value),
            parseMessage: async (message, oldData) => runtime.parseVariableUpdate(message, oldData),
        };
        window.TavernHelper = {
            getChatMessages: (...args) => window.getChatMessages(...args),
            triggerSlash: command => window.triggerSlash(command),
            getVariables: window.getVariables,
            updateVariablesWith: window.updateVariablesWith,
            Mvu: window.Mvu,
        };
        const eventTypes = {
            CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
            MESSAGE_RECEIVED: 'message_received',
            MESSAGE_SENT: 'message_sent',
            CHAT_CHANGED: 'chat_changed',
        };
        window.tavern_events = { ...eventTypes, CHAT_LOADED: 'chatLoaded', APP_READY: 'app_ready' };
        window.chat_metadata = { integrity: true, variables: runtime.variables };
        window.chat = runtime.store.activeSession?.messages ?? [];
        window.SillyTavern = {
            chat: window.chat,
            getCurrentChatId: () => runtime.store.activeSession?.id || '',
            getCurrentMessageId: () => Math.max(0, (runtime.store.activeSession?.messages.length ?? 1) - 1),
            getContext: () => ({
                eventTypes,
                eventSource: {
                    on: (name, callback) => runtime.on(name, callback),
                    once: (name, callback) => {
                        const off = runtime.on(name, (...args) => { off(); callback(...args); });
                    },
                    emit: (name, ...args) => runtime.emit(name, ...args),
                },
                chat: runtime.store.activeSession?.messages ?? [],
                characterId: 0,
                name1: runtime.store.data.settings.userName,
                name2: runtime.card.name,
            }),
        };
    }

    notify(message, type = 'info') {
        this.dispatchEvent(new CustomEvent('notify', { detail: { message: String(message), type } }));
    }

    async initializeScripts() {
        const scripts = this.card.extensions?.tavern_helper?.scripts ?? [];
        for (const script of scripts) {
            if (script.enabled === false) continue;
            try {
                if (script.name === 'MVU脚本') {
                    this.loadedScripts.push({ name: script.name, mode: '内置兼容引擎' });
                    continue;
                }
                let content = script.content;
                let shieldClassificationPatched = false;
                if (script.name === '辅助计算脚本') {
                    const patched = patchShieldClassificationInCalculator(content);
                    content = patched.source;
                    shieldClassificationPatched = patched.patched;
                }
                content = content.replace(
                    /import\s*\{\s*registerMvuSchema\s*\}\s*from\s*['"][^'"]+['"];?/,
                    'const registerMvuSchema = window.registerMvuSchema;',
                );
                const importOnly = content.match(/^\s*import\s*['"]([^'"]+)['"];?\s*$/);
                if (importOnly) {
                    if (script.name === '悬浮球状态栏') {
                        this.loadedScripts.push({ name: script.name, mode: '已映射为原生状态与 HUD 页面' });
                        continue;
                    }
                    try {
                        await import(/* @vite-ignore */ importOnly[1]);
                        this.loadedScripts.push({ name: script.name, mode: '原始远程模块' });
                    } catch (error) {
                        if (script.name === '悬浮球状态栏') {
                            this.loadedScripts.push({ name: script.name, mode: '内置状态面板兼容（CDN 离线）' });
                            console.warn('悬浮球远程模块不可用，已启用内置状态面板', error);
                        } else {
                            this.failedScripts.push({ name: script.name, error: error.message });
                        }
                    }
                    continue;
                }
                const blob = new Blob([content], { type: 'text/javascript' });
                const url = URL.createObjectURL(blob);
                await import(/* @vite-ignore */ url);
                URL.revokeObjectURL(url);
                this.loadedScripts.push({
                    name: script.name,
                    mode: shieldClassificationPatched ? '卡内原始脚本 · DEF 盾牌分类修复' : '卡内原始脚本',
                });
            } catch (error) {
                this.failedScripts.push({ name: script.name, error: error.message });
                console.error(`脚本 ${script.name} 加载失败`, error);
            }
        }
        await this.emit(window.Mvu.events.VARIABLE_INITIALIZED, clone(this.variables), 0);
        return { loaded: this.loadedScripts, failed: this.failedScripts };
    }

    async validateVariables(variables) {
        if (!this.schema) { normalizeRelationships(variables.stat_data); return variables; }
        try {
            const schema = typeof this.schema === 'function' ? this.schema() : this.schema;
            // Some card schemas normalize objects in place while parsing.
            // Keep an untouched source snapshot so terminal-only metadata can
            // be restored after that normalization rather than reading an
            // already-stripped object.
            const source = clone(variables.stat_data ?? {});
            const statData = await schema.parseAsync(clone(source));
            const merged = { ...(variables.stat_data ?? {}), ...statData };
            preserveCombatAssetMetadata(merged['主角'], source['主角']);
            merged['主角'] = { ...(merged['主角'] || {}), '好感度关系': clone(source['主角']?.['好感度关系'] || {}) };
            merged['关系列表'] = merged['关系列表'] || {};
            for (const [name, npc] of Object.entries(source['关系列表'] || {})) {
                if (!merged['关系列表'][name]) continue;
                preserveCombatAssetMetadata(merged['关系列表'][name], npc);
                merged['关系列表'][name]['好感度关系'] = clone(npc?.['好感度关系'] || {});
            }
            normalizeRelationships(merged);
            return { ...variables, stat_data: merged };
        } catch (error) {
            console.warn('ZOD 校验保留原值：', error);
            normalizeRelationships(variables.stat_data);
            return variables;
        }
    }

    async replaceVariables(next) {
        const before = clone(this.variables);
        const assetSource = clone(next?.stat_data ?? {});
        let variables = await this.validateVariables(clone(next));
        await this.emit(window.Mvu.events.VARIABLE_UPDATE_STARTED, variables);
        await this.emit(window.Mvu.events.VARIABLE_UPDATE_ENDED, variables, before);
        // Helper scripts may rebuild equipment objects during the update
        // event. Re-apply the opaque IDs after those hooks, immediately before
        // persistence, so they cannot be lost between turns.
        preserveCombatAssetMetadata(variables.stat_data?.['主角'], assetSource['主角']);
        for (const [name, npc] of Object.entries(assetSource['关系列表'] || {})) preserveCombatAssetMetadata(variables.stat_data?.['关系列表']?.[name], npc);
        variables = clone(variables);
        const messageIndex = Math.max(0, (this.store.activeSession?.messages.length ?? 1) - 1);
        this.store.saveVariables(variables, messageIndex);
        this.dispatchEvent(new CustomEvent('variables', { detail: variables }));
        return variables;
    }

    async parseVariableUpdate(content, oldData = this.variables) {
        const match = String(content).match(/<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/i);
        if (!match) return clone(oldData);
        let operations;
        try { operations = JSON.parse(match[1]); } catch (error) {
            this.notify(`变量 JSON Patch 解析失败：${error.message}`, 'error');
            return clone(oldData);
        }
        const result = clone(oldData);
        if (!result.stat_data || typeof result.stat_data !== 'object') result.stat_data = {};
        const patchRoot = result.stat_data;
        for (const operation of operations) {
            try {
                const normalizedPath = String(operation.path || '').replace(/^\/stat_data(?=\/|$)/, '') || '/';
                const { parent, key } = getParent(patchRoot, normalizedPath);
                if (operation.op === 'replace') parent[key] = clone(operation.value);
                else if (operation.op === 'delta') parent[key] = Number(parent[key] || 0) + Number(operation.value || 0);
                else if (operation.op === 'insert') {
                    if (Array.isArray(parent) && key === '-') parent.push(clone(operation.value));
                    else parent[key] = clone(operation.value);
                } else if (operation.op === 'remove') {
                    if (Array.isArray(parent)) parent.splice(Number(key), 1);
                    else delete parent[key];
                } else if (operation.op === 'move') {
                    const normalizedFrom = String(operation.from || '').replace(/^\/stat_data(?=\/|$)/, '') || '/';
                    const source = getParent(patchRoot, normalizedFrom);
                    const value = clone(source.parent[source.key]);
                    if (Array.isArray(source.parent)) source.parent.splice(Number(source.key), 1);
                    else delete source.parent[source.key];
                    const normalizedTo = String(operation.to || normalizedPath).replace(/^\/stat_data(?=\/|$)/, '') || '/';
                    const target = getParent(patchRoot, normalizedTo);
                    target.parent[target.key] = value;
                }
            } catch (error) { console.warn('忽略无效变量操作', operation, error); }
        }
        await this.emit(window.Mvu.events.COMMAND_PARSED, result, operations, content);
        return result;
    }

    beginPromptRender(messages = []) {
        const visible = messages.filter(item => !item.isHidden);
        const lastUser = [...visible].reverse().find(item => item.role === 'user');
        const last = visible.at(-1);
        this.promptVariables = {};
        this.promptContext = {
            lastUserMessage: String(lastUser?.content ?? ''),
            lastMessage: String(last?.content ?? ''),
        };
    }

    macros(text) {
        const settings = this.store.data.settings;
        const userName = settings.userName || '轮回者';
        const addVariable = (_all, key, value) => {
            const name = String(key || '').trim();
            const incoming = String(value ?? '');
            const current = this.promptVariables[name];
            const isNumeric = entry => /^[-+]?\d+(?:\.\d+)?$/.test(String(entry ?? '').trim());
            this.promptVariables[name] = isNumeric(current) && isNumeric(incoming)
                ? String(Number(current) + Number(incoming))
                : `${current ?? ''}${incoming}`;
            return '';
        };
        return String(text ?? '')
            // Tavern's trim macro is a formatting instruction, not prompt
            // text.  Removing its adjacent newline gives the same no-leading-
            // whitespace behaviour seen in the captured request.
            .replace(/[ \t]*{{trim}}[ \t]*(?:\r?\n)?/gi, '')
            .replace(/{{\/\/[\s\S]*?}}/g, '')
            .replace(/{{addvar::([^:}]+)::([\s\S]*?)}}/gi, addVariable)
            .replace(/{{setvar::([^:}]+)::([^}]*)}}/gi, (_all, key, value) => { this.promptVariables[key.trim()] = value; return ''; })
            .replace(/{{getvar::([^}]+)}}/gi, (_all, key) => String(this.promptVariables[key.trim()] ?? ''))
            .replace(/{{lastUserMessage}}/gi, this.promptContext.lastUserMessage)
            .replace(/{{lastMessage}}/gi, this.promptContext.lastMessage)
            // SillyTavern's continuation preset uses the legacy
            // {{lastChatMessage}} spelling.  Keep it distinct from
            // {{lastUserMessage}}: it refers to the immediately preceding
            // visible turn, regardless of role.
            .replace(/{{lastChatMessage}}/gi, this.promptContext.lastMessage)
            .replace(/{{user}}/gi, userName)
            .replace(/{{char}}/gi, this.card.name)
            .replace(/{{charIfNotGroup}}/gi, this.card.name)
            // The Maya prompt family used by the baseline writes these legacy
            // angle-bracket aliases instead of Tavern's {{user}} macro.
            .replace(/<user>/gi, userName)
            .replace(/<char>/gi, this.card.name)
            .replace(/{{get_message_variable::([^}]+)}}/gi, (_all, path) => {
                const value = lodash.get(this.variables, path.trim());
                return typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
            })
            .replace(/{{random::([^}]+)}}/gi, (_all, choices) => {
                const values = choices.split('::');
                return values[Math.floor(Math.random() * values.length)] ?? '';
            })
            .replace(/{{roll\s+(\d+)d(\d+)}}/gi, (_all, count, sides) => Array.from({ length: Number(count) }, () => 1 + Math.floor(Math.random() * Number(sides))).reduce((sum, value) => sum + value, 0).toString())
            .replace(/{{roll::(\d+)}}/gi, (_all, sides) => String(1 + Math.floor(Math.random() * Number(sides))))
            .replace(/{{roll}}/gi, () => String(1 + Math.floor(Math.random() * 100)))
            .trim();
    }

    renderTemplate(text) {
        try {
            const output = ejs.render(String(text ?? ''), {
                _: lodash,
                YAML,
                getMessageVar: window.getMessageVar,
                getVariables: window.getVariables,
                user: this.store.data.settings.userName,
                char: this.card.name,
            }, { async: false });
            // EJS's `<%=` escapes XML characters. Tavern injects these card
            // blocks as plain prompt text, so undo only the standard entity
            // escaping before macro expansion (otherwise JSON/YAML state is
            // sent as `&#34;` and loses its structure).
            const unescaped = output
                .replace(/&#34;/g, '"')
                .replace(/&#39;/g, "'")
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>');
            return this.macros(unescaped);
        } catch (error) {
            console.warn('世界书 EJS 条目执行失败，保留静态部分', error);
            return this.macros(String(text ?? '').replace(/<%[\s\S]*?%>/g, ''));
        }
    }

    activeWorldbook(messages) {
        const entries = [...(this.card.character_book?.entries ?? []), ...this.customWorldbook];
        const scanText = messages.slice(-12).map(item => item.content).join('\n').toLowerCase();
        return entries.filter(entry => {
            if (entry.enabled === false) return false;
            if (entry.constant) return true;
            const keys = entry.keys ?? [];
            if (!keys.length) return false;
            return keys.some(key => {
                try { return entry.use_regex ? new RegExp(key, 'i').test(scanText) : scanText.includes(String(key).toLowerCase()); }
                catch { return scanText.includes(String(key).toLowerCase()); }
            });
        }).sort((a, b) => (a.insertion_order ?? 0) - (b.insertion_order ?? 0));
    }

    injectCardContextIntoPreset(content, { before = '', after = '', persona = '' } = {}) {
        let output = String(content ?? '');
        let beforePlaced = !before;
        let afterPlaced = !after;
        let personaPlaced = !persona;
        const insertAfterOpeningTag = (tag, value) => {
            if (!value) return false;
            const expression = new RegExp(`(<${tag}(?:\\s[^>]*)?>)(\\r?\\n)?`, 'i');
            if (!expression.test(output)) return false;
            output = output.replace(expression, (_all, opening) => `${opening}\n\n${value}\n\n`);
            return true;
        };
        // Tavern's World Info builder puts the two character-book positions
        // inside these pre-existing slots. Appending them after the prompt
        // changes both their scope and their position relative to chat history.
        beforePlaced = insertAfterOpeningTag('world_info', before) || beforePlaced;
        afterPlaced = insertAfterOpeningTag('additional_info', after) || afterPlaced;
        // AIRP profiles commonly reserve <角色> for the user persona.  Fill it
        // only when the preset exposes the slot; generic presets retain the
        // existing fallback block below.
        personaPlaced = insertAfterOpeningTag('角色', persona) || personaPlaced;
        return { content: output, beforePlaced, afterPlaced, personaPlaced };
    }

    /**
     * Reproduce SillyTavern's `squash_system_messages` boundary.  AIRP/OAI
     * presets often contain a very large sequence of system-labelled context
     * blocks.  Tavern keeps the first system instruction as the system anchor,
     * then presents the remaining preset context as user turns separated by
     * assistant examples.  Sending every block as an independent system turn
     * changes both the provider's role handling and the final Gemini contents
     * sequence, so the conversion is done after all card/script injections.
     */
    squashPresetMessages(prefixMessages, newChatPrompt = '') {
        const source = Array.isArray(prefixMessages) ? prefixMessages : [];
        const output = [];
        const pendingUser = [];
        let anchorSeen = false;
        let userSeen = false;
        let firstAssistantSeen = false;
        const appendPending = content => {
            const text = String(content ?? '').trim();
            if (text) pendingUser.push(text);
        };
        const flushPending = () => {
            if (!pendingUser.length) return;
            output.push({ role: 'user', content: pendingUser.join('\n\n') });
            pendingUser.length = 0;
            userSeen = true;
        };
        for (const original of source) {
            if (!original || !String(original.content ?? '').trim()) continue;
            const message = { role: original.role || 'system', content: String(original.content) };
            if (message.role === 'system' && !anchorSeen && original[EXTERNAL_PROMPT] !== true) {
                output.push(message);
                anchorSeen = true;
                continue;
            }
            if (message.role === 'assistant') {
                // Tavern's new-chat marker is inserted immediately before the
                // first assistant example when no user turn has appeared yet.
                if (!firstAssistantSeen && !userSeen && String(newChatPrompt || '').trim()) {
                    output.push({ role: 'user', content: String(newChatPrompt).trim() });
                    userSeen = true;
                }
                flushPending();
                output.push(message);
                firstAssistantSeen = true;
                continue;
            }
            // Explicit user entries and all subsequent system entries are
            // context in the same user-side block until an assistant example
            // creates the next role boundary.
            appendPending(message.content);
        }
        flushPending();
        return output;
    }

    buildPrompt(messages, { promptModules = {} } = {}) {
        this.beginPromptRender(messages);
        const presetModule = promptModules?.preset || {};
        const rulesModule = promptModules?.rules || {};
        const workModule = promptModules?.work || {};
        const dynamicModule = promptModules?.dynamic || {};
        const presetEnabled = presetModule.enabled !== false;
        const rulesEnabled = rulesModule.enabled !== false;
        const workEnabled = workModule.enabled !== false;
        const workOverride = String(workModule.text || '').trim();
        const dynamicEnabled = dynamicModule.enabled !== false;
        const rulesOverride = String(rulesModule.text || '').trim();
        const presetOverride = String(presetModule.text || '').trim();
        const active = this.activeWorldbook(messages);
        const before = rulesEnabled && !rulesOverride
            ? active.filter(item => item.position === 'before_char').map(item => this.renderTemplate(item.content)).filter(Boolean)
            : [];
        const afterEntries = active.filter(item => item.position !== 'before_char');
        const inChatEntries = afterEntries.filter(item => Number.isFinite(Number(item.extensions?.depth)) || Number(item.extensions?.position) === 4);
        const staticAfterEntries = afterEntries.filter(item => !inChatEntries.includes(item));
        const after = rulesEnabled && !rulesOverride ? staticAfterEntries.map(item => this.renderTemplate(item.content)).filter(Boolean) : [];
        const persona = this.store.data.settings.persona?.trim();
        const beforeContext = before.join('\n\n');
        const afterContext = after.join('\n\n');
        const cardContext = rulesEnabled
            ? (rulesOverride || [
                this.card.description,
                this.card.personality,
                this.card.scenario,
                beforeContext,
                afterContext,
                persona ? `<玩家设定>\n${persona}\n</玩家设定>` : '',
                this.card.system_prompt,
                this.card.post_history_instructions,
            ].filter(Boolean).join('\n\n'))
            : '';
        const presetPrompts = presetEnabled
            ? (presetOverride
                ? [{ identifier: 'preset-module-override', name: '实验室预设模块覆盖', role: presetModule.role || 'system', content: presetOverride, enabled: true, marker: false }]
                : (this.activePreset?.prompts ?? []).filter(item => item.enabled && !item.marker && item.content?.trim()))
            : [];
        const depthPrompts = [];
        for (const entry of (rulesEnabled ? inChatEntries : [])) {
            const content = this.renderTemplate(entry.content);
            if (!content) continue;
            const depth = Number.isFinite(Number(entry.extensions?.depth)) ? Number(entry.extensions.depth) : 0;
            const roleCode = Number(entry.extensions?.role ?? 0);
            const role = roleCode === 2 ? 'assistant' : roleCode === 1 ? 'user' : 'system';
            depthPrompts.push({ role, content, depth, worldbook: entry.comment || entry.uid || '' });
        }
        const presetBefore = [];
        let inlinesLastUser = false;
        for (const prompt of presetPrompts) {
            const value = { role: prompt.role || 'system', content: this.macros(prompt.content) };
            if (/{{lastUserMessage}}/i.test(prompt.content)) inlinesLastUser = true;
            if (prompt.injectionPosition === 1 && prompt.injectionDepth > 0) depthPrompts.push({ ...value, depth: prompt.injectionDepth });
            else presetBefore.push(value);
        }
        const prefixMessages = [];
        let cardContextPlaced = false;
        for (const item of presetBefore) {
            const injected = this.injectCardContextIntoPreset(item.content, { before: beforeContext, after: afterContext, persona });
            const prepared = { ...item, content: injected.content };
            const residualCardContext = rulesEnabled && !rulesOverride ? [
                !injected.beforePlaced ? beforeContext : '',
                !injected.afterPlaced ? afterContext : '',
                !injected.personaPlaced && persona ? `<玩家设定>\n${persona}\n</玩家设定>` : '',
                this.card.description,
                this.card.personality,
                this.card.scenario,
                this.card.system_prompt,
                this.card.post_history_instructions,
            ].filter(Boolean).join('\n\n') : '';
            // The baseline's Maya preset starts with a compact reset system
            // message and sends the remaining <word_count> block as a user
            // context message. The former implementation flattened both into
            // one system message, which materially changes Gemini behaviour.
            const boundary = prepared.role === 'system' ? prepared.content.indexOf('<word_count>') : -1;
            const mayBeMayaLayout = boundary > 0 && /RESET ALL OF THE ABOVE TO NULL/i.test(prepared.content.slice(0, boundary));
            if (mayBeMayaLayout) {
                const prelude = prepared.content.slice(0, boundary).trim();
                const body = prepared.content.slice(boundary).trim();
                if (prelude) prefixMessages.push({ role: 'system', content: prelude });
                prefixMessages.push({ role: 'user', content: [body, residualCardContext].filter(Boolean).join('\n\n') });
                cardContextPlaced = !residualCardContext;
            } else if (prepared.content) {
                // In the captured OAI request the large creative/context block
                // is a user turn even when an imported older preset labels it
                // as system. Detect only that recognizable Maya layout; other
                // system prompts keep their declared role.
                const isMayaContextTurn = prepared.role === 'system'
                    && /^\s*<word_count>/i.test(prepared.content)
                    && /<interactive_input>|<world_info>/i.test(prepared.content);
                prefixMessages.push({ ...prepared, role: isMayaContextTurn ? 'user' : prepared.role });
                cardContextPlaced = cardContextPlaced || !residualCardContext;
            }
        }
        if (cardContext && !cardContextPlaced) prefixMessages.push({ role: 'system', content: cardContext });
        for (const prompt of (workEnabled && !workOverride ? this.externalPrompts.values() : [])) {
            const value = { role: prompt.role || 'system', content: this.macros(prompt.content) };
            const taggedValue = { ...value, [EXTERNAL_PROMPT]: true };
            const depth = Number(prompt.depth ?? prompt.injectionDepth ?? 0);
            if (depth > 0 || prompt.position === 'in_chat') depthPrompts.push({ ...value, depth });
            else if (value.role === 'system') prefixMessages.unshift(taggedValue);
            else prefixMessages.push(taggedValue);
        }
        const visibleHistory = dynamicEnabled ? messages.filter(item => !item.isHidden) : [];
        const lastVisibleUserIndex = inlinesLastUser ? visibleHistory.map(item => item.role).lastIndexOf('user') : -1;
        const history = visibleHistory.filter((_item, index) => index !== lastVisibleUserIndex).map((item, index, list) => ({
            role: item.role === 'assistant' ? 'assistant' : 'user',
            content: this.applyPromptRegex(this.macros(item.content), item.role, list.length - 1 - index),
        }));
        let outputHistory = [...history];
        for (const prompt of depthPrompts.sort((a, b) => b.depth - a.depth)) {
            // Tavern's depth=1 entry is placed after the latest visible chat
            // turn; depth=3 is three turns back, etc.  The +1 is important for
            // the card's `⚙️额外思考` entry, which must follow the opening
            // assistant turn instead of preceding it.
            const index = Math.max(0, outputHistory.length - prompt.depth + 1);
            outputHistory.splice(index, 0, { role: prompt.role, content: prompt.content });
        }
        let finalPrefix = prefixMessages;
        if (this.activePreset?.squashSystemMessages) {
            // Empty preset values still produce Tavern's standard marker in a
            // fresh chat (the UI supplies this default at send time).
            const newChatPrompt = this.activePreset.raw?.new_chat_prompt || '[Start a new chat]';
            finalPrefix = this.squashPresetMessages(prefixMessages, newChatPrompt);
            // Depth injections are part of the prompt context too.  There is
            // no reason to re-introduce a trailing system turn after squash;
            // convert them to the same user-side context role Tavern uses.
            outputHistory = outputHistory.map(item => item.role === 'system'
                ? { role: 'user', content: item.content }
                : { role: item.role, content: item.content });
        }
        const assembledMessages = [...finalPrefix, ...outputHistory];
        // SillyTavern's prompt builder coalesces adjacent user-side context
        // created by depth injections.  Keeping every World Info entry as a
        // separate user turn changes the provider's conversational boundary
        // (and makes the last message look like a fresh user request). Merge
        // only adjacent user blocks; assistant examples and real chat turns
        // remain hard boundaries.
        const coalesced = [];
        for (const message of assembledMessages) {
            const previous = coalesced.at(-1);
            if (previous?.role === 'user' && message.role === 'user') {
                previous.content = `${previous.content}\n\n${message.content}`;
            } else {
                coalesced.push({ ...message });
            }
        }
        const ruleEntries = rulesOverride
            ? [{ id: 'rules-override', name: '实验室规则覆盖', role: 'system', content: rulesOverride, source: 'rules' }]
            : [
                { id: 'card-description', name: '角色卡 · Description', role: 'system', content: this.card.description, source: 'card' },
                { id: 'card-personality', name: '角色卡 · Personality', role: 'system', content: this.card.personality, source: 'card' },
                { id: 'card-scenario', name: '角色卡 · Scenario', role: 'system', content: this.card.scenario, source: 'card' },
                { id: 'worldbook-before', name: 'World Info · before_char', role: 'system', content: beforeContext, source: 'worldbook' },
                { id: 'worldbook-after', name: 'World Info · after_char', role: 'system', content: afterContext, source: 'worldbook' },
                { id: 'user-persona', name: '玩家设定', role: 'system', content: persona ? `<玩家设定>\n${persona}\n</玩家设定>` : '', source: 'persona' },
                { id: 'card-system', name: '角色卡 · system_prompt', role: 'system', content: this.card.system_prompt, source: 'card' },
                { id: 'card-post-history', name: '角色卡 · post_history_instructions', role: 'system', content: this.card.post_history_instructions, source: 'card' },
            ].filter(item => String(item.content || '').trim());
        return {
            messages: coalesced,
            activeEntries: active,
            preset: this.activePreset,
            // Keep the logical construction visible to the prompt laboratory
            // without putting private metadata into the provider request.
            // These modules mirror Tavern's prompt-order mental model:
            // preset entries, card/worldbook rules, and the dynamic chat turn.
            modules: {
                preset: {
                    id: 'preset', label: 'AIRP / OAI 预设', enabled: presetEnabled,
                    entries: presetPrompts.map(item => ({ id: item.identifier, name: item.name, role: item.role || 'system', content: this.macros(item.content), source: 'preset' })),
                },
                rules: {
                    id: 'rules', label: '角色卡 / World Info 规则', enabled: rulesEnabled,
                    entries: ruleEntries,
                },
                dynamic: {
                    id: 'dynamic', label: '动态历史 / 用户输入', enabled: dynamicEnabled,
                    entries: history.map((item, index) => ({ id: `history-${index}`, name: `历史 ${index + 1}`, role: item.role, content: item.content, source: 'dynamic' })),
                },
                work: {
                    id: 'work', label: '外部注入 / 工作提示词', enabled: workEnabled,
                    entries: [...this.externalPrompts.values()].map((item, index) => ({ id: `external-${index}`, name: item.name || `外部提示 ${index + 1}`, role: item.role || 'system', content: this.macros(item.content), source: 'work' })),
                },
            },
        };
    }

    buildTavernShopSystem() {
        const variables = clone(this.promptVariables);
        const context = clone(this.promptContext);
        this.beginPromptRender([]);
        try {
            const entries = this.card.character_book?.entries ?? [];
            const rules = TAVERN_SHOP_ENTRY_COMMENTS.map(comment => entries.find(entry => entry.comment === comment))
                .filter(Boolean)
                .map(entry => this.renderTemplate(entry.content))
                .filter(Boolean);
            const [qualityRules = '', entityRules = '', statusRules = '', checkRules = ''] = rules;
            // renderTemplate() trims an entry's trailing whitespace; restore
            // the exact inter-entry separators observed in Tavern's export.
            return `${TAVERN_SHOP_HEADER}\n${qualityRules}\n\n${entityRules}\n${statusRules}\n${checkRules}\n\n${TAVERN_SHOP_SUFFIX}`;
        } finally {
            this.promptVariables = variables;
            this.promptContext = context;
        }
    }

    applyPromptRegex(content, role, depth = 0) {
        return this.applyRegex(content, role, 'prompt', depth);
    }

    applyDisplayRegex(content, role, depth = 0) {
        return this.applyRegex(content, role, 'display', depth);
    }

    applyExternalDisplayRegex(content, role, depth = 0) {
        return this.applyRegex(content, role, 'display', depth, this.externalRegexPresets.flatMap(preset => preset.scripts || []));
    }

    regexScripts() {
        const presetScripts = Array.isArray(this.activePreset?.regexScripts)
            ? this.activePreset.regexScripts
            : Array.isArray(this.activePreset?.extensions?.regex_scripts)
                ? this.activePreset.extensions.regex_scripts
                : Array.isArray(this.activePreset?.extensions?.SPreset?.RegexBinding?.regexes)
                    ? this.activePreset.extensions.SPreset.RegexBinding.regexes
                    : [];
        return [
            ...(this.card.extensions?.regex_scripts ?? []),
            ...presetScripts,
            ...this.externalRegexPresets.flatMap(preset => preset.scripts || []),
        ];
    }

    applyRegex(content, role, mode, depth = 0, scripts = this.regexScripts()) {
        const placement = role === 'user' ? 1 : 2;
        let output = String(content ?? '');
        for (const script of scripts) {
            if (script.disabled || !(script.placement ?? []).includes(placement)) continue;
            if (script.minDepth != null && depth < Number(script.minDepth)) continue;
            if (script.maxDepth != null && depth > Number(script.maxDepth)) continue;
            if (mode === 'prompt' && script.markdownOnly) continue;
            if (mode === 'display' && script.promptOnly) continue;
            for (const trim of script.trimStrings || []) output = output.split(this.macros(trim)).join('');
            const findSource = Number(script.substituteRegex || 0) > 0 ? this.macros(script.findRegex) : script.findRegex;
            const regex = parseRegex(findSource);
            if (!regex) continue;
            try { output = output.replace(regex, this.macros(script.replaceString ?? '')); }
            catch (error) { console.warn(`正则 ${script.scriptName} 执行失败`, error); }
        }
        return output;
    }
}
