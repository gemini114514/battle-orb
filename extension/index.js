const VERSION = '0.5.0';
globalThis.__battleOrbExpectedVersion = VERSION;
const bootTrace = (stage, detail = {}) => {
    const event = { time: new Date().toISOString(), stage, detail };
    if (!Array.isArray(globalThis.__battleOrbBootEvents)) globalThis.__battleOrbBootEvents = [];
    globalThis.__battleOrbBootEvents.push(event);
    globalThis.__battleOrbBootEvents = globalThis.__battleOrbBootEvents.slice(-100);
};
bootTrace('bootstrap-entered', { version: VERSION, readyState: document.readyState });
void import('./diagnose.js')
    .then(module => module.install({ version: VERSION }))
    .catch(error => console.warn('[Battle Orb] 诊断模块加载失败', error));

(async function battleOrbBootstrap() {
try {
    const [{ getContext }, { CombatEngine }, { BrowserCombatRepository }, { validateBattleDeclaration }, { buildBattleResultDsl }] = await Promise.all([
        import('../../../extensions.js'),
        import('./combat/engine.js'),
        import('./combat/browser-repository.js'),
        import('./combat/model.js'),
        import('./combat/narrative-dsl.js'),
    ]);
    bootTrace('dependencies-loaded');

const ROOT_ID = 'battle-orb-root';
const PANEL_ID = 'battle-orb-panel';
const FAB_ID = 'battle-orb-fab';
const MAX_FLOOR_CHARS = 9000;

let context = null;
let repository = null;
let engine = null;
let battle = null;
let declaration = null;
let model = null;
let tavernSnapshot = null;
let mapZoom = 1;
let mapPan = { x: 0, y: 0 };
let mapIntent = null;
let mapMenu = null;
let mapSuppressClickUntil = 0;
let mapPointer = null;
let selectedUnitId = null;
let inspectorUnitId = null;
let actionNotice = null;
let actionNoticeTimer = null;
const forcedUnitIds = new Set();
let attackEffects = [];
let combatEffectFrame = 0;
let mapState = null;
let busy = false;
let mounted = false;

const SETTINGS_KEY = 'battle-orb.settings';
let settings = { writeVerdictBasis: true };
let flowError = null;
try { settings = { writeVerdictBasis: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { /* keep defaults */ }
const saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {} };

const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[char]));
const clone = value => structuredClone(value);
const id = prefix => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;

function notify(message, type = 'info') {
    const fn = globalThis.toastr?.[type];
    if (typeof fn === 'function') fn(message, 'Battle Orb');
    setStatus(message, type);
}

function setStatus(message, kind = 'info') {
    const node = $('#battle-orb-status');
    if (node) { node.textContent = String(message || ''); node.dataset.kind = kind; }
}

function fabVisible() {
    try { return localStorage.getItem('battle-orb.fab-visible') !== '0'; } catch { return true; }
}

function applyFabVisibility() {
    const fab = document.getElementById(FAB_ID);
    if (fab) fab.style.display = fabVisible() ? '' : 'none';
}

function readFloatingPosition(key) {
    try {
        const value = JSON.parse(localStorage.getItem(`battle-orb.${key}-pos`) || 'null');
        return Number.isFinite(value?.x) && Number.isFinite(value?.y) ? value : null;
    } catch { return null; }
}

function writeFloatingPosition(key, position) {
    try { localStorage.setItem(`battle-orb.${key}-pos`, JSON.stringify(position)); } catch {}
}

function floatingViewportBounds(key) {
    const viewport = globalThis.visualViewport;
    const left = Number(viewport?.offsetLeft) || 0;
    const top = Number(viewport?.offsetTop) || 0;
    const width = Number(viewport?.width) || innerWidth || document.documentElement.clientWidth;
    const height = Number(viewport?.height) || innerHeight || document.documentElement.clientHeight;
    const compact = width <= 650 || navigator.maxTouchPoints > 0;
    const sideMargin = key === 'fab' ? (compact ? 12 : 8) : (compact ? 8 : 6);
    const topMargin = key === 'fab' ? (compact ? 12 : 8) : (compact ? 8 : 6);
    const bottomMargin = key === 'fab' ? (compact ? 36 : 8) : (compact ? 12 : 6);
    return { left: left + sideMargin, top: top + topMargin, right: left + width - sideMargin, bottom: top + height - bottomMargin, width, height };
}

function clampFloatingCoordinates(x, y, width, height, key) {
    const bounds = floatingViewportBounds(key);
    const safeWidth = Math.max(1, Math.min(Number(width) || (key === 'fab' ? 56 : 760), bounds.width));
    const safeHeight = Math.max(1, Math.min(Number(height) || (key === 'fab' ? 56 : 640), bounds.height));
    return {
        x: Math.max(bounds.left, Math.min(Math.max(bounds.left, bounds.right - safeWidth), Number(x) || bounds.left)),
        y: Math.max(bounds.top, Math.min(Math.max(bounds.top, bounds.bottom - safeHeight), Number(y) || bounds.top)),
    };
}

function makeDraggable(handle, target, key, clickGuard = false) {
    handle.addEventListener('pointerdown', event => {
        if (event.target.closest('button') && handle !== target) return;
        if (event.button !== undefined && event.button !== 0) return;
        event.preventDefault();
        target.dataset.boDragging = '1';
        const rect = target.getBoundingClientRect();
        const startX = event.clientX; const startY = event.clientY; let moved = false;
        const pointerId = event.pointerId;
        target.style.right = 'auto'; target.style.bottom = 'auto';
        const move = e => {
            if (e.pointerId !== pointerId) return;
            const dx = e.clientX - startX; const dy = e.clientY - startY;
            moved ||= Math.abs(dx) + Math.abs(dy) > 5;
            const next = clampFloatingCoordinates(rect.left + dx, rect.top + dy, rect.width, rect.height, key);
            target.style.left = `${next.x}px`; target.style.top = `${next.y}px`;
        };
        const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', finish); window.removeEventListener('blur', finish); };
        const finish = e => {
            if (e?.pointerId !== undefined && e.pointerId !== pointerId) return;
            cleanup(); delete target.dataset.boDragging;
            const now = target.getBoundingClientRect();
            const next = clampFloatingCoordinates(now.left, now.top, now.width, now.height, key);
            target.style.left = `${next.x}px`; target.style.top = `${next.y}px`;
            writeFloatingPosition(key, next);
            if (clickGuard && moved) { target.dataset.dragged = '1'; setTimeout(() => target.dataset.dragged = '0'); }
        };
        window.addEventListener('pointermove', move); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', finish); window.addEventListener('blur', finish);
    });
}

function restoreFloatingPosition(key, target) {
    if (!target || target.dataset.boDragging === '1') return;
    const rect = target.getBoundingClientRect();
    const pos = readFloatingPosition(key);
    const hasStored = Boolean(pos);
    const fromX = hasStored ? pos.x : rect.left;
    const fromY = hasStored ? pos.y : rect.top;
    const width = rect.width || target.offsetWidth || (key === 'fab' ? 56 : 760);
    const height = rect.height || target.offsetHeight || (key === 'fab' ? 56 : 640);
    const next = clampFloatingCoordinates(fromX, fromY, width, height, key);
    target.style.right = 'auto'; target.style.bottom = 'auto'; target.style.left = `${next.x}px`; target.style.top = `${next.y}px`;
    if (!hasStored || next.x !== pos.x || next.y !== pos.y) writeFloatingPosition(key, next);
}

function installFloatingClampListeners(entries) {
    let frame = 0;
    const clamp = () => { frame = 0; for (const [key, target] of entries) restoreFloatingPosition(key, target); };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(clamp); };
    addEventListener('resize', schedule, { passive: true });
    addEventListener('orientationchange', () => { schedule(); setTimeout(clamp, 350); }, { passive: true });
    globalThis.visualViewport?.addEventListener?.('resize', schedule, { passive: true });
    setTimeout(clamp, 250);
    setTimeout(clamp, 1000);
}

function openFloatingPanel(panel) {
    panel.classList.add('open');
    panel.style.right = 'auto'; panel.style.bottom = 'auto';
    const width = Math.max(1, Math.min(Number(panel.offsetWidth) || 760, innerWidth - 8));
    const height = Math.max(1, Math.min(Number(panel.offsetHeight) || 720, innerHeight - 8));
    const gap = 10;
    const fab = document.getElementById(FAB_ID);
    let anchorX = innerWidth / 2, anchorY = innerHeight / 2;
    if (fab) {
        const rect = fab.getBoundingClientRect();
        anchorX = rect.left + rect.width / 2;
        anchorY = rect.top + rect.height / 2;
    }
    const expandLeft = anchorX > innerWidth / 2;
    const expandUp = anchorY > innerHeight / 2;
    let x = expandLeft ? anchorX - gap - width : anchorX + (fab?.offsetWidth || 48) / 2 + gap;
    let y = expandUp ? anchorY - gap - height : anchorY + (fab?.offsetHeight || 48) / 2 + gap;
    x = Math.max(4, Math.min(innerWidth - width - 4, x));
    y = Math.max(4, Math.min(innerHeight - height - 4, y));
    panel.style.left = `${x}px`; panel.style.top = `${y}px`;
    writeFloatingPosition('panel', { x, y });
    requestAnimationFrame(() => restoreFloatingPosition('panel', panel));
}

function activeContext() {
    context ||= getContext();
    return context;
}

function pointerParts(pointer) {
    return String(pointer || '').split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function applyPatch(root, operation) {
    const path = pointerParts(operation?.path);
    if (!path.length) return operation?.op === 'remove' ? {} : clone(operation?.value ?? {});
    let parent = root;
    for (let index = 0; index < path.length - 1; index += 1) {
        const key = path[index];
        if (parent[key] === undefined || parent[key] === null || typeof parent[key] !== 'object') parent[key] = /^\d+$/.test(path[index + 1]) ? [] : {};
        parent = parent[key];
    }
    const key = path.at(-1);
    if (operation?.op === 'remove') {
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else delete parent[key];
    } else if (Array.isArray(parent) && key === '-') parent.push(clone(operation.value));
    else parent[key] = clone(operation?.value);
    return root;
}

function parsePatchBlocks(content) {
    const patches = [];
    const pattern = /<JSONPatch\b[^>]*>\s*([\s\S]*?)\s*<\/JSONPatch\s*>/gi;
    for (const match of String(content || '').matchAll(pattern)) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed)) patches.push(...parsed);
        } catch { /* preserve the floor even when a model emitted bad JSON */ }
    }
    return patches;
}

function isMvuStatData(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
}

function optionalGlobal(name) {
    const hosts = [globalThis];
    try { if (window && !hosts.includes(window)) hosts.push(window); } catch {}
    try { if (window?.parent && !hosts.includes(window.parent)) hosts.push(window.parent); } catch {}
    for (const host of hosts) {
        try { if (host?.[name]) return host[name]; } catch {}
    }
    return null;
}

function messageMvuStatData(ctx, floor) {
    const message = ctx.chat?.[floor];
    if (!message) return null;
    const variables = message.variables;
    const swipeId = Number.isInteger(Number(message.swipe_id)) ? Number(message.swipe_id) : 0;
    const selected = Array.isArray(variables) ? (variables[swipeId] ?? variables.at(-1)) : variables;
    return isMvuStatData(selected?.stat_data) ? clone(selected.stat_data) : null;
}

function replayMvu(messages) {
    const output = { stat_data: {} };
    let applied = 0;
    for (const message of messages || []) {
        for (const operation of parsePatchBlocks(message.content)) {
            if (!operation?.path) continue;
            applyPatch(output, operation);
            applied += 1;
        }
    }
    return { state: output, applied };
}

function syncAuthoritativeMvu(ctx) {
    const chatMeta = ctx.chatMetadata?.variables?.stat_data;
    if (isMvuStatData(chatMeta)) {
        try { return { state: typeof chatMeta === 'string' ? JSON.parse(chatMeta) : clone(chatMeta), source: 'chatMetadata.variables' }; }
        catch { /* treat as absent */ }
    }
    const all = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (let index = all.length - 1; index >= 0; index -= 1) {
        const statData = messageMvuStatData(ctx, index);
        if (statData) return { state: statData, source: `message.variables[${index}]` };
    }
    return null;
}

async function globalAuthoritativeMvu(ctx) {
    const all = Array.isArray(ctx.chat) ? ctx.chat : [];
    const mvu = optionalGlobal('Mvu');
    if (mvu?.getMvuData) {
        try {
            const data = await Promise.resolve(mvu.getMvuData({ type: 'message', message_id: 'latest' }));
            if (isMvuStatData(data?.stat_data)) return { state: clone(data.stat_data), source: 'Mvu.getMvuData' };
        } catch (error) { console.warn('[Battle Orb] 通过 Mvu 读取 MVU 快照失败', error); }
    }
    const ejs = optionalGlobal('EjsTemplate');
    if (ejs?.prepareContext) {
        try {
            const env = await Promise.resolve(ejs.prepareContext({}, Math.max(0, all.length - 1)));
            if (isMvuStatData(env?.variables?.stat_data)) return { state: clone(env.variables.stat_data), source: 'EjsTemplate.prepareContext' };
        } catch (error) { console.warn('[Battle Orb] 通过 EJS 读取 MVU 上下文失败', error); }
    }
    return null;
}

function readTavern() {
    const ctx = activeContext();
    const all = Array.isArray(ctx.chat) ? ctx.chat : [];
    const messages = all.map((message, index) => ({
        id: message.id ?? index,
        role: message.is_user ? 'user' : message.is_system ? 'system' : 'assistant',
        content: String(message.mes || message.content || ''),
        hidden: Boolean(message.is_system && message.extra?.isSmallSys),
    })).filter(message => message.content.trim());
    const replayed = replayMvu(messages);
    const authoritative = syncAuthoritativeMvu(ctx);
    return {
        chatId: ctx.getCurrentChatId?.() || null,
        characterName: ctx.name2 || '',
        userName: ctx.name1 || '',
        messages,
        recent: messages.slice(-18).map(message => ({ role: message.role, content: message.content.slice(-MAX_FLOOR_CHARS) })),
        mvu: authoritative
            ? { state: authoritative.state, applied: replayed.applied, source: authoritative.source }
            : { state: replayed.state, applied: replayed.applied, source: 'JSONPatch 回放' },
    };
}

async function refreshTavernFromGlobals() {
    if (!tavernSnapshot) return;
    const snapshot = await globalAuthoritativeMvu(activeContext());
    if (!snapshot || !tavernSnapshot) return;
    const previousSource = String(tavernSnapshot.mvu?.source || '');
    if (previousSource.startsWith('chatMetadata') || previousSource.startsWith('message.variables')) return;
    tavernSnapshot.mvu = { ...tavernSnapshot.mvu, state: snapshot.state, source: snapshot.source };
    render();
}

function extractJsonObject(source) {
    const text = String(source || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(text); } catch { /* scan below */ }
    for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
        let depth = 0, quoted = false, escaped = false;
        for (let index = start; index < text.length; index += 1) {
            const char = text[index];
            if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; continue; }
            if (char === '"') quoted = true;
            else if (char === '{') depth += 1;
            else if (char === '}') { depth -= 1; if (!depth) { try { return JSON.parse(text.slice(start, index + 1)); } catch { break; } } }
        }
    }
    throw new Error('AI 没有返回合法 JSON');
}

function battleDeclarationFromFloor() {
    for (const message of [...(tavernSnapshot?.messages || [])].reverse()) {
        const match = message.content.match(/<BattleDeclaration\b[^>]*>([\s\S]*?)<\/BattleDeclaration\s*>/i);
        if (!match) continue;
        try { return JSON.parse(match[1].trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '')); }
        catch (error) { throw new Error(`BattleDeclaration JSON 无法解析：${error.message}`); }
    }
    return null;
}

function normalizeDeclaration(input) {
    const output = clone(input || {});
    output.schema ||= 'vibe-combat-declaration/v3';
    output.worldLifeLevel ||= String(tavernSnapshot?.mvu?.state?.stat_data?.主角?.层级 || 'Ⅰ');
    output.contactEstablished = output.contactEstablished !== false;
    output.participants = Array.isArray(output.participants) ? output.participants : [];
    const players = output.participants.filter(item => item?.side === 'player').map(item => item.id).filter(Boolean);
    const enemies = output.participants.filter(item => item?.side === 'enemy').map(item => item.id).filter(Boolean);
    output.contactPairs ||= players.flatMap(player => enemies.map(enemy => [player, enemy]));
    output.battlefield ||= { kind: '未知场景', shapeHint: 'unknown', description: '由本地二维战场承载' };
    output.battlefield.shapeHint = ['rectangle', 'circle', 'unknown'].includes(output.battlefield.shapeHint) ? output.battlefield.shapeHint : 'unknown';
    output.participants = output.participants.map((item, index) => ({
        id: String(item.id || `participant-${index + 1}`), name: String(item.name || `参战者 ${index + 1}`), count: Math.max(1, Number(item.count) || 1),
        side: item.side === 'player' ? 'player' : item.side === 'neutral' ? 'neutral' : 'enemy', source: item.source === 'existing' ? 'existing' : 'create',
        state: typeof item.state === 'string' ? item.state : '已进入交战状态', relativePosition: String(item.relativePosition || '战场中'), ...(item.reference ? { reference: String(item.reference).replace(/^\/+/, '').replace(/^关系列表[\\/]/, '') } : {}),
    }));
    return output;
}

const DECLARATION_SYSTEM = `你是 Battle Orb 的战场声明器。阅读酒馆最近剧情和当前 MVU，只输出一个 JSON 对象，不要 Markdown，不要解释，不要计算结果。对象必须包含 schema:"vibe-combat-declaration/v3"、worldLifeLevel、contactEstablished、contactPairs、reason、battlefield(kind/shapeHint/description)、participants。shapeHint 只能是 rectangle/circle/unknown；participants 至少一名 player 和一名 enemy，每个 participant 必须含 id/name/count/side/source/state/relativePosition；已有 MVU 实体 source=existing 并填写 reference，新敌人 source=create。禁止输出 HP、伤害、命中、死亡、坐标或 JSONPatch。`;
const MODEL_SYSTEM = `你是 Battle Orb 的战斗建模器。只输出一个完整 JSON CombatModel，不要 Markdown、解释或战报。必须包含 schema:"vibe-combat-model/v3"、title、location、battlefield、zones、combatants。battlefield 使用 rectangle(widthMeters/heightMeters/center) 或 circle(radiusMeters/center)；每个 combatant 必须有 id/declarationId/name/side/controller/hp/maxHp/ep/maxEp/attack/attackModifier/defenseDC/initiativeDC/armor/resistance/position/visionMeters/intelProfile/tacticalProfile/abilities。能力至少包含 basic-attack，禁止计算战斗结果；玩家方必须 controller=player，敌方 controller=ai。`;
const MODEL_SUPERVISOR_SYSTEM = `你是 Battle Orb 的战斗数据检查 AI（第二段对抗性审查）。检查给定的 CombatModel 是否自洽，并直接输出修正后的完整 JSON，不要 Markdown、解释或只输出差异。重点检查并修正：1) 武器/能力射程矛盾——例如配置了远程武器却只带近战能力、或近战武器却配置远程能力，能力射程必须与武器类型相符；2) 未实现的技能效果——引用了效果但未定义、或效果无数值的必须补齐或删除，能力必须至少包含 basic-attack；3) 与战场声明不符——participants 中声明存在的实体缺失、或出现声明外的实体；4) 玩家方必须 controller=player，敌方 controller=ai；5) 数值越界（HP/EP 为 0 或负、射程为负等）必须修正。可以连续多次修正，但最终只输出一个完整、可用的 CombatModel JSON。`;

async function generateRaw(messages, responseLength = 4000) {
    const ctx = activeContext();
    if (typeof ctx.generateRaw !== 'function') throw new Error('当前酒馆版本没有 generateRaw 扩展接口');
    return ctx.generateRaw({ prompt: messages, responseLength, trimNames: false });
}

function currentPlayerMvu() {
    return tavernSnapshot?.mvu?.state?.stat_data?.主角 || {};
}

function fallbackModel(input) {
    const playerMvu = currentPlayerMvu();
    const shape = input.battlefield.shapeHint === 'circle' ? 'circle' : 'rectangle';
    const battlefield = shape === 'circle'
        ? { shape, name: input.battlefield.kind || '交战区域', radiusMeters: 24, center: { x: 0, y: 0 } }
        : { shape, name: input.battlefield.kind || '交战区域', widthMeters: 60, heightMeters: 36, center: { x: 0, y: 0 } };
    const participants = input.participants || [];
    const playerHp = Math.max(1, Number(playerMvu.HP || 100));
    const playerMaxHp = Math.max(playerHp, Number(playerMvu.HP_MAX || playerHp));
    const playerEp = Math.max(0, Number(playerMvu.EP || 0));
    const playerMaxEp = Math.max(playerEp, Number(playerMvu.EP_MAX || playerEp));
    return {
        schema: 'vibe-combat-model/v3', worldLifeLevel: input.worldLifeLevel, contactEstablished: true, contactPairs: input.contactPairs || [],
        title: input.reason || '未命名遭遇', location: input.battlefield.kind || '未知战场', battlefield,
        zones: [{ id: 'field', name: input.battlefield.description || '主战区', adjacent: [], capacity: 999 }], assetProfiles: [],
        combatants: participants.map((item, index) => {
            const player = item.side === 'player'; const hp = player ? playerHp : Math.max(20, 55 - index * 3); const maxHp = player ? playerMaxHp : hp;
            return {
                id: item.id, declarationId: item.id, name: item.name, side: item.side, controller: player ? 'player' : 'ai', hp, maxHp,
                ep: player ? playerEp : 0, maxEp: player ? playerMaxEp : 0, attack: player ? 20 : 8, magicAttack: 0, attackModifier: player ? 2 : -1,
                defenseDC: player ? 50 : 45, initiativeDC: player ? 55 : 45, armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4,
                position: { x: player ? -12 : 12, y: player ? (index % 3) * 2 : (index % 3) * 2 }, facingDegrees: player ? 0 : 180, fovDegrees: 120, visionMeters: 30,
                intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 15, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 },
                tacticalProfile: { archetype: 'scattered', groupId: player ? 'heroes' : 'enemies', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 12 },
                abilities: [{ id: 'basic-attack', name: '基础攻击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.8, cooldownRounds: 0, targetCount: 1, aoe: false }],
            };
        }),
    };
}

function mergeModel(candidate, input) {
    const fallback = fallbackModel(input);
    if (!candidate || typeof candidate !== 'object') return fallback;
    const output = { ...fallback, ...candidate, battlefield: { ...fallback.battlefield, ...(candidate.battlefield || {}) }, zones: Array.isArray(candidate.zones) && candidate.zones.length ? candidate.zones : fallback.zones };
    const candidateByDeclaration = new Map((candidate.combatants || []).map(item => [String(item.declarationId || item.id), item]));
    output.combatants = fallback.combatants.map(base => {
        const item = candidateByDeclaration.get(String(base.declarationId)) || candidateByDeclaration.get(String(base.id)) || {};
        const abilities = Array.isArray(item.abilities) && item.abilities.length ? item.abilities : base.abilities;
        return { ...base, ...item, id: base.id, declarationId: base.declarationId, side: base.side, controller: base.controller, position: { ...base.position, ...(item.position || {}) }, abilities: abilities.map(ability => { const { script, scriptHash, ...safeAbility } = ability || {}; return { ...base.abilities[0], ...safeAbility }; }) };
    });
    return output;
}

async function superviseCombatModel(candidate, declaration, snapshot, maxRounds = 3) {
    if (!candidate || typeof candidate !== 'object') return candidate;
    let current = mergeModel(candidate, declaration);
    for (let round = 0; round < maxRounds; round += 1) {
        let revised = null;
        try {
            revised = extractJsonObject(await generateRaw([
                { role: 'system', content: MODEL_SUPERVISOR_SYSTEM },
                { role: 'user', content: JSON.stringify({ declaration, mvu: snapshot?.mvu?.state, combatModel: current }, null, 2) },
            ], 7000));
        } catch (error) { setStatus(`战斗数据检查 AI 第 ${round + 1} 轮修正失败：${error.message}`, 'warn'); break; }
        if (!revised || typeof revised !== 'object') break;
        const normalized = mergeModel(revised, declaration);
        if (JSON.stringify(normalized) === JSON.stringify(current)) return current;
        current = normalized;
    }
    return current;
}

function declarationValidation(value) {
    const report = validateBattleDeclaration(value, { strict: false });
    if (!report?.ok) throw new Error((report?.errors || []).slice(0, 5).map(error => `${error.path}：${error.message}`).join('\n') || '战场声明校验失败');
}

async function recognize() {
    if (busy) return;
    flowError = null;
    busy = true; setStatus('正在读取酒馆楼层与 MVU…', 'working');
    try {
        tavernSnapshot = readTavern();
        const tagged = battleDeclarationFromFloor();
        const content = tagged ? tagged : extractJsonObject(await generateRaw([
            { role: 'system', content: DECLARATION_SYSTEM },
            { role: 'user', content: JSON.stringify({ recentStory: tavernSnapshot.recent, mvu: tavernSnapshot.mvu.state, ...(String(settings.recognizeHint || '').trim() ? { playerHint: String(settings.recognizeHint).trim() } : {}) }, null, 2) },
        ], 2600));
        declaration = normalizeDeclaration(content);
        declarationValidation(declaration);
        $('#battle-orb-declaration').value = JSON.stringify(declaration, null, 2);
        render();
        setStatus(tagged ? '已从当前楼层读取 BattleDeclaration' : '已由酒馆当前 AI 草拟战场声明', 'ok');
    } catch (error) { flowError = { step: 'recognize', message: error.message || '识别失败' }; notify(`识别战场失败：${error.message}`, 'error'); }
    finally { busy = false; render(); }
}

async function createBattle() {
    if (busy) return;
    try {
        flowError = null;
        if (!declaration) await recognize();
        if (!declaration) return;
        declaration = normalizeDeclaration(extractJsonObject($('#battle-orb-declaration').value));
        declarationValidation(declaration);
        busy = true; setStatus('正在用酒馆当前 AI 建立 CombatModel…', 'working'); render();
        tavernSnapshot ||= readTavern();
        let candidate = null;
        try {
            candidate = extractJsonObject(await generateRaw([
                { role: 'system', content: MODEL_SYSTEM },
                { role: 'user', content: JSON.stringify({ declaration, mvu: tavernSnapshot.mvu.state }, null, 2) },
            ], 7000));
            setStatus('CombatModel 已生成，正在由战斗数据检查 AI 审查修正…', 'working'); render();
        } catch (error) { setStatus(`CombatModel 生成失败，改用本地安全默认模型：${error.message}`, 'warn'); }
        candidate = await superviseCombatModel(candidate, declaration, tavernSnapshot);
        model = mergeModel(candidate, declaration);
        repository = new BrowserCombatRepository();
        engine = new CombatEngine(repository);
        const created = engine.create({ seed: id('tavern'), mode: 'manual', storySessionId: tavernSnapshot.chatId, encounter: model, assetProfiles: model.assetProfiles || [], preparation: { declaration, source: 'tavern-injected' } });
        battle = repository.get(created.id);
        await engine.start(battle);
        repository.commit(battle);
        mapIntent = null; mapMenu = null; selectedUnitId = null; inspectorUnitId = null; mapZoom = 1; mapPan = { x: 0, y: 0 };
        setStatus('战场已创建；骰点、伤害、状态、位置和胜负由本地引擎裁定', 'ok');
        render();
    } catch (error) { flowError = { step: 'create', message: error.message || '创建失败' }; notify(`创建战场失败：${error.message}`, 'error'); }
    finally { busy = false; render(); }
}

function publicBattle() { return battle && engine ? engine.publicState(battle) : null; }

async function execute(command) {
    if (!battle || busy || ['completed', 'abandoned'].includes(battle.status)) return false;
    busy = true; setStatus('本地演算中…', 'working'); render();
    try {
        await engine.command(battle, command);
        repository.commit(battle);
        mapIntent = null; mapMenu = null;
        const recentEvents = repository.events(battle.id).slice(-24);
        spawnAttackEffects(publicBattle(), recentEvents);
        const notice = actionNoticeFromEvents(recentEvents, publicBattle(), command.actorId, command.type);
        showActionNotice(notice);
        if (notice) setStatus(notice.text, notice.kind);
        return true;
    }
    catch (error) { notify(`行动失败：${error.message}`, 'error'); return false; }
    finally { busy = false; render(); }
}

async function reaction(choice) {
    if (!battle || busy) return;
    busy = true;
    try { await engine.reaction(battle, { choice }); repository.commit(battle); }
    catch (error) { notify(`反应处理失败：${error.message}`, 'error'); }
    finally { busy = false; render(); }
}

function battlefieldTransform(canvas, battlefield) {
    const rect = canvas.getBoundingClientRect();
    const pad = 22;
    const width = battlefield.shape === 'circle' ? battlefield.radiusMeters * 2 : battlefield.widthMeters;
    const height = battlefield.shape === 'circle' ? battlefield.radiusMeters * 2 : battlefield.heightMeters;
    const baseScale = Math.max(.1, Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height));
    const scale = baseScale * Math.min(3, Math.max(.5, Number(mapZoom) || 1));
    const originX = rect.width / 2 - battlefield.center.x * scale + Number(mapPan.x || 0);
    const originY = rect.height / 2 + battlefield.center.y * scale + Number(mapPan.y || 0);
    return { rect, pad, scale, zoom: mapZoom, baseScale, originX, originY, toCanvas: position => ({ x: originX + position.x * scale, y: originY - position.y * scale }), toWorld: ({ x, y }) => ({ x: (x - originX) / scale, y: (originY - y) / scale }) };
}

function visibleIds(state) {
    const ids = new Set((state?.intel?.visibleToPlayer || []).map(String));
    for (const unit of state?.combatants || []) if (unit.side !== 'enemy') ids.add(unit.id);
    // A completed battle is a forensic/replay view: defeated enemies remain
    // on the final 2D board and must stay inspectable. The live fog-of-war
    // projection may omit dead IDs during cleanup, which previously made a
    // completed board appear frozen because clicks could not hit any token.
    if (['completed', 'abandoned'].includes(state?.status)) for (const unit of state?.combatants || []) ids.add(unit.id);
    // Legacy snapshots predating the intelligence state retain their former
    // fully-visible behavior rather than rendering an empty battlefield.
    if (!state?.intel?.knowledge) for (const unit of state?.combatants || []) ids.add(unit.id);
    for (const id of state?.movementBlockers?.unitIds || []) ids.add(String(id));
    return ids;
}

function intelSummary(state) {
    const visible = visibleIds(state);
    const playerIds = new Set((state?.combatants || []).filter(unit => unit.side === 'player').map(unit => unit.id));
    const known = Object.entries(state?.intel?.knowledge || {}).filter(([observerId]) => playerIds.has(observerId)).flatMap(([, entries]) => Object.values(entries || {})).filter(entry => entry?.canTarget);
    const sources = { visual: 0, auditory: 0, intel: 0, melee_contact: 0, shared: 0 };
    for (const entry of known) if (Object.hasOwn(sources, entry.source)) sources[entry.source] += 1;
    const labels = [['visual', '视觉'], ['auditory', '听觉'], ['intel', '情报'], ['melee_contact', '近战'], ['shared', '共享']].filter(([key]) => sources[key]).map(([key, label]) => `${label} ${sources[key]}`);
    const visibleEnemies = (state?.combatants || []).filter(unit => unit.side === 'enemy' && visible.has(unit.id)).length;
    const hiddenEnemies = (state?.combatants || []).filter(unit => unit.side === 'enemy' && !visible.has(unit.id)).length;
    return { visibleEnemies, hiddenEnemies, text: labels.length ? labels.join(' · ') : '尚未确认敌方信息' };
}

function selectedUnit(state) {
    if (!state?.combatants?.length) return null;
    const preferred = state.combatants.find(unit => unit.id === selectedUnitId);
    if (preferred) return preferred;
    const active = state.combatants.find(unit => unit.id === state.activeUnitId);
    selectedUnitId = active?.id || state.combatants[0].id;
    return active || state.combatants[0];
}

function assetProfilesForUnit(unit, state) {
    const profiles = new Map((state?.assetProfiles || []).map(profile => [String(profile.assetId), profile]));
    const ids = [
        ...(Array.isArray(unit?.assetBindings) ? unit.assetBindings : []),
        ...(Array.isArray(unit?.equipment) ? unit.equipment.map(item => typeof item === 'string' ? item : item?.assetId || item?.id) : []),
        ...(Array.isArray(unit?.equipments) ? unit.equipments.map(item => typeof item === 'string' ? item : item?.assetId || item?.id) : []),
    ].filter(Boolean).map(String);
    return ids.map(id => profiles.get(id) || { assetId: id, name: id }).filter((profile, index, list) => list.findIndex(item => item.assetId === profile.assetId) === index);
}

function objectRows(value, labels = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    return Object.entries(value).map(([key, val]) => `<div class="combat-detail-row"><span>${escapeHtml(labels[key] || key)}</span><b>${escapeHtml(typeof val === 'object' ? JSON.stringify(val) : String(val ?? '—'))}</b></div>`).join('');
}

function entityInspectorMarkup(unit, state) {
    if (!unit) return '';
    const equipment = assetProfilesForUnit(unit, state);
    const statuses = Array.isArray(unit.statuses) ? unit.statuses : [];
    const cooldowns = Object.entries(unit.cooldowns || {}).filter(([, value]) => Number(value) > 0);
    const abilities = Array.isArray(unit.abilities) ? unit.abilities : [];
    const passives = Array.isArray(unit.passives) ? unit.passives : [];
    const pos = unit.position || {};
    const attrs = unit.attributes || {};
    const statusMarkup = statuses.length ? statuses.map(status => `<span class="combat-detail-chip">${escapeHtml(status.name || status.id || '状态')}${status.duration !== undefined ? ` · ${escapeHtml(status.duration)}回合` : ''}</span>`).join('') : '<small class="combat-detail-muted">无持续状态</small>';
    const equipmentMarkup = equipment.length ? equipment.map(profile => {
        const combat = profile.combat || {};
        return `<article class="combat-detail-card"><b>${escapeHtml(profile.name || profile.assetId)}</b><small>${escapeHtml(profile.kind || '装备')} · ID ${escapeHtml(profile.assetId || '—')}</small><span>战斗距离 ${escapeHtml(combat.minRangeMeters ?? '—')}–${escapeHtml(combat.maxRangeMeters ?? '—')}m · 冷却 ${escapeHtml(combat.cooldownRounds ?? 0)}回合</span><span>${escapeHtml(combat.attackStyle || profile.description || '已绑定本地战斗资料')}</span></article>`;
    }).join('') : '<small class="combat-detail-muted">未绑定装备或装备资料未随本场载入</small>';
    const abilityMarkup = abilities.length ? abilities.map(ability => `<article class="combat-detail-card"><b>${escapeHtml(ability.name || ability.id)}</b><small>${escapeHtml(ability.type || 'ability')} · ${escapeHtml(ability.actionType || 'main')} · ${ability.script ? '脚本能力' : '本地计算'}</small><span>威力 ${escapeHtml(ability.power ?? 0)} · 修正 ${escapeHtml(ability.modifier ?? 0)} · EP ${escapeHtml(ability.epCost ?? 0)}</span><span>射程 ${escapeHtml(ability.minRangeMeters ?? 0)}–${escapeHtml(ability.maxRangeMeters ?? 0)}m · 目标 ${escapeHtml(ability.targetCount ?? 1)}${ability.aoe ? ' · AOE' : ''} · 冷却 ${escapeHtml(ability.cooldownRounds ?? 0)}回合</span></article>`).join('') : '<small class="combat-detail-muted">无已声明技能</small>';
    const passiveMarkup = passives.length ? passives.map(passive => `<article class="combat-detail-card combat-passive-card"><b>${escapeHtml(passive.name || passive.id)}</b><small>常驻被动 · ${passive.enabled === false ? '已停用' : '已启用'}</small><span>${passive.id === 'melee-counterattack' ? '被近战攻击后仍存活：立即使用近战基础攻击反击一次；反击不消耗主动行动且不会递归触发。' : escapeHtml(passive.trigger || '本地战斗规则')}</span></article>`).join('') : '<small class="combat-detail-muted">无常驻被动</small>';
    const cooldownMarkup = cooldowns.length ? cooldowns.map(([id, rounds]) => `<span class="combat-detail-chip">${escapeHtml(id)} · ${escapeHtml(rounds)}回合</span>`).join('') : '<small class="combat-detail-muted">无冷却</small>';
    return `<aside class="combat-entity-inspector" role="dialog" aria-label="实体战斗信息">
        <header><div><small>ENTITY INTEL · LOCAL STATE</small><h3>${escapeHtml(unit.name || unit.id)}</h3><span>${escapeHtml(unit.side || 'unknown')} · ${escapeHtml(unit.controller || 'ai')} · ${escapeHtml(unit.state || 'active')}${unit.boss ? ' · BOSS' : ''}${unit.elite ? ' · ELITE' : ''}</span></div><button data-action="combat-close-entity-inspector" aria-label="关闭实体信息">×</button></header>
        <section class="combat-detail-section combat-detail-vitals"><div class="combat-vital hp"><span>HP</span><b>${escapeHtml(unit.hp ?? 0)}/${escapeHtml(unit.maxHp ?? 0)}</b><i style="width:${Math.max(0, Math.min(100, Number(unit.maxHp) ? Number(unit.hp || 0) / Number(unit.maxHp) * 100 : 0))}%"></i></div><div class="combat-vital ep"><span>EP</span><b>${escapeHtml(unit.ep ?? 0)}/${escapeHtml(unit.maxEp ?? 0)}</b><i style="width:${Math.max(0, Math.min(100, Number(unit.maxEp) ? Number(unit.ep || 0) / Number(unit.maxEp) * 100 : 0))}%"></i></div><div class="combat-vital exertion"><span>体力</span><b>${escapeHtml(unit.exertion ?? 0)}/${escapeHtml(unit.maxExertion ?? 0)}</b><i style="width:${Math.max(0, Math.min(100, Number(unit.maxExertion) ? Number(unit.exertion || 0) / Number(unit.maxExertion) * 100 : 0))}%"></i></div></section>
        <section class="combat-detail-section"><h4>战场定位</h4><div class="combat-detail-grid">${objectRows({ '坐标': `(${Number(pos.x || 0).toFixed(2)}, ${Number(pos.y || 0).toFixed(2)})`, 朝向: `${Number(unit.facingDegrees || 0).toFixed(0)}°`, 半径: `${unit.radiusMeters ?? '—'}m`, 基础移速: `${unit.baseSpeedMeters ?? unit.speedMeters ?? '—'}m`, 有效移速: `${Number(unit.baseSpeedMeters ?? unit.speedMeters ?? 0) + Math.floor(Math.max(0, Number(attrs.dexterityModifier || 0)) / 2)}m/回合`, 视觉: `${unit.visionMeters ?? '—'}m · ${unit.fovDegrees ?? 120}°`, 区域: unit.zoneId || '—', 阵营: unit.side || '—', 控制: unit.controller || '—' })}</div></section>
        <section class="combat-detail-section"><h4>核心战斗数值</h4><div class="combat-detail-grid">${objectRows({ 攻击: unit.attack, 魔攻: unit.magicAttack, 攻击修正: unit.attackModifier, 防御DC: unit.defenseDC, 先攻DC: unit.initiativeDC, 护甲: unit.armor, 抗性: unit.resistance, 临时HP: unit.thp ?? 0, 五维: Object.entries(attrs).map(([key, val]) => `${key}:${val}`).join(' · ') || '—' })}</div></section>
        <section class="combat-detail-section"><h4>状态与冷却</h4><div class="combat-detail-chips">${statusMarkup}</div><div class="combat-detail-chips">${cooldownMarkup}</div></section>
        <section class="combat-detail-section"><h4>装备 / 本地战斗资料</h4><div class="combat-detail-cards">${equipmentMarkup}</div></section>
        <section class="combat-detail-section"><h4>技能清单</h4><div class="combat-detail-cards">${abilityMarkup}</div></section>
        <section class="combat-detail-section"><h4>常驻被动</h4><div class="combat-detail-cards">${passiveMarkup}</div></section>
        <section class="combat-detail-section"><h4>侦察与战术</h4><div class="combat-detail-grid">${objectRows(unit.intelProfile, { presence: '显眼程度', stealthBonus: '潜行修正', perceptionBonus: '感知修正', commandBonus: '指挥修正', hearingMeters: '听觉范围', intelligenceRangeMeters: '情报范围', intelligenceBonus: '情报修正' })}${objectRows(unit.tacticalProfile, { archetype: '组织类型', groupId: '群组', objective: '目标', focusRule: '集火规则', coordinationRadiusMeters: '协同范围' })}</div></section>
    </aside>`;
}

function mapMenuMarkup(state, actor) {
    if (!mapMenu || !actor) return '';
    const manual = state?.pauseReason?.type === 'manual_turn' && state?.activeUnitId === actor.id;
    const legal = (state?.pauseReason?.legalActions || []).filter(ability => ability.actionAvailable);
    const abilities = legal.filter(ability => ability.type !== 'maneuver');
    const maneuvers = legal.filter(ability => ability.type === 'maneuver');
    const abilityButtons = abilities.map(ability => `<button data-action="combat-map-menu-ability" data-combat-ability-id="${escapeHtml(ability.id)}" data-combat-script="${ability.scriptHash ? 'true' : 'false'}"><b>${escapeHtml(ability.name)}</b><small>射程 ${escapeHtml(ability.minRangeMeters ?? 0)}–${escapeHtml(ability.maxRangeMeters ?? 0)}m · EP ${escapeHtml(ability.epCost ?? 0)}</small></button>`).join('');
    const maneuverButtons = maneuvers.map(maneuver => `<button data-action="combat-map-menu-maneuver" data-combat-maneuver="${escapeHtml(maneuver.id)}" ${manual ? '' : 'disabled'}><b>${escapeHtml(maneuver.name)}</b><small>${escapeHtml(maneuver.detail || '本地机动规则')}</small></button>`).join('');
    const remaining = Number(state.turnBudget?.[actor.id]?.movementMeters ?? actor.speedMeters ?? 0);
    const basic = legal.find(ability => ability.id === 'basic-attack');
    const moveAttackButton = basic && manual && remaining > 0 ? `<button data-action="combat-map-menu-move-attack"><b>移动攻击</b><small>自动移动到最短基础攻击距离后攻击</small></button>` : '';
    return `<div class="combat-map-menu" role="menu"><header><b>${escapeHtml(actor.name || actor.id)}</b><small>${manual ? `移动 ${remaining.toFixed(1)}m · 体力 ${actor.exertion ?? 0}/${actor.maxExertion ?? 0}` : '当前不可手操'}</small></header><button data-action="combat-map-menu-wait" class="combat-menu-end" ${manual ? '' : 'disabled'}><b>结束行动</b><small>恢复体力并交给本地演算继续</small></button><button data-action="combat-map-menu-move" ${manual && remaining > 0 ? '' : 'disabled'}><b>移动到这里</b><small>剩余 ${remaining.toFixed(1)}m 落点</small></button>${moveAttackButton}${maneuverButtons}${abilityButtons || '<small class="combat-menu-empty">暂无可用技能</small>'}</div>`;
}

function showActionNotice(notice) {
    actionNotice = notice ? { text: String(notice.text || notice), kind: notice.kind || 'info' } : null;
    if (actionNoticeTimer) clearTimeout(actionNoticeTimer);
    if (actionNotice) actionNoticeTimer = setTimeout(() => { actionNotice = null; actionNoticeTimer = null; render(); }, 3000);
}

function actionNoticeFromEvents(events, state, actorId = null, actionType = null) {
    const candidates = [...(events || [])].filter(item => !actorId || item.payload?.actorId === actorId);
    const preferredTypes = actionType === 'move' ? ['unit_moved'] : actionType === 'wait' ? ['unit_waited'] : actionType === 'sneak' || actionType === 'hide' ? ['hide_resolved', 'stealth_entered'] : actionType === 'unsneak' ? ['stealth_broken'] : actionType === 'attack' || actionType === 'script' ? ['action_resolved', 'script_action_resolved'] : ['maneuver_resolved', 'withdrawal_resolved', 'lure_created', 'action_resolved', 'script_action_resolved', 'unit_moved', 'unit_waited', 'stealth_entered', 'stealth_broken', 'turn_skipped'];
    const event = [...candidates].reverse().find(item => preferredTypes.includes(item.type)) || [...(events || [])].reverse().find(item => ['action_resolved', 'script_action_resolved', 'unit_moved', 'unit_waited', 'turn_skipped'].includes(item.type));
    if (!event) return null;
    const actor = state?.combatants?.find(unit => unit.id === event.payload?.actorId);
    if (event.type === 'action_resolved') {
        const results = event.payload?.results || [];
        const parts = results.map(result => {
            const target = state?.combatants?.find(unit => unit.id === result.targetId);
            const totalDamage = Number(result.damage?.final ?? 0);
            const hpDamage = Number(result.applied?.hpDamage ?? 0);
            const absorbed = Number(result.applied?.absorbed ?? 0);
            const hp = target ? ` · HP ${target.hp}/${target.maxHp}` : '';
            const damageText = totalDamage > 0 ? `-${totalDamage} 伤害${absorbed > 0 ? `（护盾吸收 ${absorbed}）` : ''}${hpDamage !== totalDamage ? `，HP -${hpDamage}` : ''}` : '未造成伤害';
            return `${target?.name || result.targetId} ${result.outcome === 'hit' || result.outcome === 'miracle' ? `命中 ${damageText}` : result.outcome === 'miss' ? '未命中' : result.outcome}${hp}`;
        });
        return { kind: 'action', text: `${actor?.name || event.payload?.actorId || '单位'} · ${parts.join('；') || '行动已结算'}${event.payload?.epCost ? ` · EP -${event.payload.epCost}` : ''}` };
    }
    if (event.type === 'script_action_resolved') return { kind: 'action', text: `${actor?.name || event.payload?.actorId || '单位'} · 脚本技能已结算 · ${Array.isArray(event.payload?.effects) ? `${event.payload.effects.length} 个效果` : '效果已应用'}` };
    if (event.type === 'stealth_entered') return { kind: 'intel', text: `${actor?.name || event.payload?.actorId || '单位'} 进入潜行 · 视觉改为发现检定 · 移动声源上限 3m` };
    if (event.type === 'stealth_broken') return { kind: 'intel', text: `${actor?.name || event.payload?.actorId || '单位'} 结束潜行 · ${event.payload?.reason || '状态解除'}` };
    if (event.type === 'maneuver_resolved') return { kind: 'move', text: `${actor?.name || event.payload?.actorId || '单位'} · ${event.payload?.maneuver === 'sprint' ? `疾走，额外 ${event.payload.addedMeters}m` : event.payload?.maneuver === 'withdraw' ? `战术脱离 ${Number(event.payload.distanceMeters || 0).toFixed(1)}m` : event.payload?.maneuver === 'evasive' ? `闪避步法，${event.payload.remainingAttacks}次攻击劣势` : event.payload?.maneuver || '机动已结算'}` };
    if (event.type === 'lure_created') return { kind: 'intel', text: `${actor?.name || event.payload?.actorId || '单位'} 制造诱导声源 · 干扰 ${event.payload?.affectedIds?.length || 0} 个实体` };
    if (event.type === 'hide_resolved') return { kind: 'intel', text: `${actor?.name || event.payload?.actorId || '单位'} 隐蔽完成 · 切断 ${event.payload?.reduced || 0}/${event.payload?.observers || 0} 条追踪` };
    if (event.type === 'unit_moved') return { kind: 'move', text: `${actor?.name || event.payload?.actorId || '单位'} 移动 ${Number(event.payload?.distanceMeters || 0).toFixed(1)}m · 位置 (${Number(event.payload?.to?.x || 0).toFixed(1)}, ${Number(event.payload?.to?.y || 0).toFixed(1)})` };
    if (event.type === 'unit_waited') return { kind: 'wait', text: `${actor?.name || event.payload?.actorId || '单位'} 结束行动` };
    return { kind: 'info', text: `${actor?.name || event.payload?.actorId || '单位'} 行动被跳过` };
}

function selectedRanges(unit, state) {
    if (!unit) return { movement: 0, attacks: [] };
    const budget = state?.turnBudget?.[unit.id];
    const movement = Math.max(0, Number(budget?.movementMeters ?? unit.speedMeters ?? unit.baseSpeedMeters ?? 0));
    const attacks = (Array.isArray(unit.abilities) ? unit.abilities : []).map(ability => ({
        id: String(ability.id || ability.name || 'attack'), name: String(ability.name || ability.id || '攻击'), min: Math.max(0, Number(ability.minRangeMeters || 0)), max: Math.max(0, Number(ability.maxRangeMeters ?? (ability.range === 'far' ? 1000 : ability.range === 'contact' ? 1.5 : 8))),
    })).filter(ability => ability.max > 0 && Number.isFinite(ability.max)).sort((a, b) => a.max - b.max);
    return { movement, attacks };
}

function rangeLegendMarkup(unit, state) {
    if (!unit) return '';
    const ranges = selectedRanges(unit, state);
    const attackText = [...new Map(ranges.attacks.map(item => [item.max, item])).values()].slice(0, 4).map(item => `${escapeHtml(item.name)} ${item.min > 0 ? `${item.min}–` : '≤'}${item.max}m`).join(' · ');
    return `<div class="combat-range-legend"><b>已选：${escapeHtml(unit.name || unit.id)}</b><span class="movement-range-key">移动 ${ranges.movement.toFixed(1)}m</span>${attackText ? `<span class="attack-range-key">攻击：${attackText}</span>` : '<span class="attack-range-key">无可用攻击射程</span>'}</div>`;
}

function drawMap() {
    const canvas = $('#battle-orb-map'); const state = mapState;
    if (!canvas || !state?.battlefield) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return;
    canvas.width = Math.round(rect.width * ratio); canvas.height = Math.round(rect.height * ratio);
    const context = canvas.getContext('2d'); context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const { battlefield } = state; const transform = battlefieldTransform(canvas, battlefield); canvas._battlefieldTransform = transform;
    context.clearRect(0, 0, rect.width, rect.height);
    context.fillStyle = '#0b100d'; context.fillRect(0, 0, rect.width, rect.height);
    context.save();
    context.strokeStyle = '#52614d'; context.fillStyle = '#111811'; context.lineWidth = 1.5;
    if (battlefield.shape === 'circle') { const center = transform.toCanvas(battlefield.center); context.beginPath(); context.arc(center.x, center.y, battlefield.radiusMeters * transform.scale, 0, Math.PI * 2); context.fill(); context.stroke(); }
    else { const width = battlefield.widthMeters * transform.scale, height = battlefield.heightMeters * transform.scale; const center = transform.toCanvas(battlefield.center); context.fillRect(center.x - width / 2, center.y - height / 2, width, height); context.strokeRect(center.x - width / 2, center.y - height / 2, width, height); }
    const actor = state.combatants.find(unit => unit.id === state.activeUnitId);
    if (actor && mapIntent?.type === 'ability') {
        const ability = actor.abilities.find(item => item.id === mapIntent.abilityId);
        if (ability) { const center = transform.toCanvas(actor.position); context.beginPath(); context.arc(center.x, center.y, Number(ability.maxRangeMeters || 0) * transform.scale, 0, Math.PI * 2); context.strokeStyle = '#e0b96588'; context.setLineDash([5, 5]); context.stroke(); context.setLineDash([]); }
    }
    const selectedForFov = state.combatants.find(unit => unit.id === selectedUnitId) || actor;
    if (selectedForFov) {
        const center = transform.toCanvas(selectedForFov.position); const radians = Number(selectedForFov.facingDegrees || 0) * Math.PI / 180;
        const half = Number(selectedForFov.fovDegrees || 120) * Math.PI / 360;
        context.beginPath(); context.moveTo(center.x, center.y); context.arc(center.x, center.y, Number(selectedForFov.visionMeters || 0) * transform.scale, -radians - half, -radians + half); context.closePath(); context.fillStyle = selectedForFov.side === 'player' ? '#89d77212' : '#d36b5b12'; context.fill(); context.strokeStyle = selectedForFov.side === 'player' ? '#9dda7355' : '#d36b5b55'; context.lineWidth = 1; context.stroke();
        const ranges = selectedRanges(selectedForFov, state);
        const movementCenter = center;
        if (ranges.movement > 0) {
            context.beginPath(); context.arc(movementCenter.x, movementCenter.y, ranges.movement * transform.scale, 0, Math.PI * 2);
            context.strokeStyle = '#9dda73d9'; context.lineWidth = 2; context.setLineDash([7, 4]); context.stroke(); context.setLineDash([]);
            context.fillStyle = '#bde88b'; context.font = '600 10px sans-serif'; context.textAlign = 'left'; context.fillText(`移动 ${ranges.movement.toFixed(1)}m`, movementCenter.x + 7, movementCenter.y + ranges.movement * transform.scale - 7);
        }
        const rangeGroups = new Map();
        for (const ability of ranges.attacks) {
            const group = rangeGroups.get(ability.max) || { max: ability.max, min: ability.min, names: [] };
            group.min = Math.min(group.min, ability.min); group.names.push(ability.name); rangeGroups.set(ability.max, group);
        }
        [...rangeGroups.values()].slice(0, 4).forEach((range, rangeIndex) => {
            context.beginPath(); context.arc(center.x, center.y, range.max * transform.scale, 0, Math.PI * 2);
            context.strokeStyle = rangeIndex === 0 ? '#e0b965d0' : '#b787f5b8'; context.lineWidth = rangeIndex === 0 ? 2 : 1.5; context.setLineDash([4, 5]); context.stroke(); context.setLineDash([]);
            if (range.min > 0) { context.beginPath(); context.arc(center.x, center.y, range.min * transform.scale, 0, Math.PI * 2); context.strokeStyle = '#e0b96577'; context.lineWidth = 1; context.setLineDash([2, 5]); context.stroke(); context.setLineDash([]); }
            context.fillStyle = rangeIndex === 0 ? '#f2d48c' : '#d2b4f5'; context.font = '600 9px sans-serif'; context.textAlign = 'right'; context.fillText(`${range.names.slice(0, 2).join('、')} ≤${range.max}m`, center.x + range.max * transform.scale - 5, center.y - 5 - rangeIndex * 12);
        });
        canvas._rangeRenderState = { selectedUnitId: selectedForFov.id, movementMeters: ranges.movement, attackRanges: [...rangeGroups.values()].map(range => ({ min: range.min, max: range.max, names: range.names })) };
    }
    if (actor && mapIntent?.type === 'move') { const center = transform.toCanvas(actor.position); const meters = Number(state.turnBudget?.[actor.id]?.movementMeters ?? actor.speedMeters ?? 0); context.beginPath(); context.arc(center.x, center.y, meters * transform.scale, 0, Math.PI * 2); context.strokeStyle = '#9dda73aa'; context.setLineDash([4, 4]); context.stroke(); context.setLineDash([]); }
    if (actor && mapIntent?.type === 'withdraw') { const center = transform.toCanvas(actor.position); context.beginPath(); context.arc(center.x, center.y, (2 + Math.floor(Math.max(0, Number(actor.attributes?.dexterityModifier || 0)) / 2)) * transform.scale, 0, Math.PI * 2); context.strokeStyle = '#e0b965aa'; context.setLineDash([3, 3]); context.stroke(); context.setLineDash([]); }
    if (actor && mapIntent?.type === 'lure') { const center = transform.toCanvas(actor.position); context.beginPath(); context.arc(center.x, center.y, (6 + Math.max(0, Number(actor.attributes?.charismaModifier || 0)) * 2) * transform.scale, 0, Math.PI * 2); context.strokeStyle = '#b787f5aa'; context.setLineDash([3, 3]); context.stroke(); context.setLineDash([]); }
    const unitById = new Map(state.combatants.map(unit => [unit.id, unit]));
    const playerObserver = state.combatants.find(item => item.side === 'player');
    const visible = visibleIds(state);
    const visibleUnits = state.combatants.filter(unit => visible.has(unit.id));
    const cohorts = new Map();
    for (const unit of visibleUnits) {
        const key = `${unit.side}:${unit.templateId || unit.name}:${unit.boss ? unit.id : ''}`;
        const list = cohorts.get(key) || []; list.push(unit); cohorts.set(key, list);
    }
    const lastKnown = Object.entries(state.intel?.lastKnownPositions || {}).map(([id, position]) => ({ id, position, unit: unitById.get(id) })).filter(entry => entry.unit?.side === 'enemy' && !visible.has(entry.id));
    for (const contact of lastKnown) {
        const center = transform.toCanvas(contact.position);
        context.save(); context.strokeStyle = '#d8af58aa'; context.fillStyle = '#d8af5822'; context.setLineDash([4, 3]); context.lineWidth = 1.5;
        context.beginPath(); context.arc(center.x, center.y, Math.max(6, contact.unit.radiusMeters * transform.scale + 3), 0, Math.PI * 2); context.fill(); context.stroke(); context.setLineDash([]);
        context.fillStyle = '#e5c77e'; context.font = '9px sans-serif'; context.textAlign = 'center'; context.fillText('最后信号', center.x, center.y - 10); context.restore();
    }
    const suppressedLabels = new Set([...cohorts.values()].filter(list => list.length >= 8 && !list.some(unit => unit.boss || unit.id === state.activeUnitId)).flatMap(list => list.map(unit => unit.id)));
    for (const unit of visibleUnits) {
        const center = transform.toCanvas(unit.position); const radius = Math.max(5, unit.radiusMeters * transform.scale);
        const active = unit.id === state.activeUnitId;
        const selected = unit.id === selectedUnitId;
        const forced = forcedUnitIds.has(unit.id) || state.movementBlockers?.unitIds?.includes(unit.id);
        context.beginPath(); context.arc(center.x, center.y, radius, 0, Math.PI * 2);
        context.fillStyle = unit.state !== 'active' ? '#4d514c' : unit.side === 'player' ? '#75bb86' : unit.side === 'enemy' ? '#cd6558' : '#8893a5'; context.fill();
        context.lineWidth = selected ? 4 : forced ? 3.5 : active ? 3 : unit.boss ? 2.5 : 1; context.strokeStyle = selected ? '#f2ff85' : forced ? '#ff786b' : active ? '#d9ff66' : unit.boss ? '#f2c66f' : '#142016'; context.stroke();
        const awareness = unit.side === 'enemy' && playerObserver ? state.intel?.knowledge?.[playerObserver.id]?.[unit.id]?.awareness : null;
        if (awareness) { context.beginPath(); context.arc(center.x, center.y, radius + 3, 0, Math.PI * 2); context.lineWidth = 1.5; context.strokeStyle = awareness === 'engaged' ? '#ff6b64' : awareness === 'tracking' ? '#89d772' : '#e0b965'; context.stroke(); }
        if (selected) { context.beginPath(); context.arc(center.x, center.y, radius + 5, 0, Math.PI * 2); context.strokeStyle = '#b7e85d99'; context.lineWidth = 1.5; context.setLineDash([3, 3]); context.stroke(); context.setLineDash([]); }
        const facing = Number(unit.facingDegrees || 0) * Math.PI / 180; context.beginPath(); context.moveTo(center.x, center.y); context.lineTo(center.x + Math.cos(facing) * radius, center.y - Math.sin(facing) * radius); context.strokeStyle = '#10140f'; context.lineWidth = 1.5; context.stroke();
        if (!suppressedLabels.has(unit.id)) {
            context.fillStyle = '#edf2e9'; context.font = '600 10px sans-serif'; context.textAlign = 'center'; context.fillText(unit.name.length > 8 ? `${unit.name.slice(0, 7)}…` : unit.name, center.x, center.y - radius - 7); context.fillStyle = '#bac7b7'; context.font = '9px sans-serif'; context.fillText(`${unit.hp}/${unit.maxHp}`, center.x, center.y + radius + 11);
        }
    }
    // Dense formations remain individual, collidable bodies.  Their labels are
    // aggregated so a 1v100 map stays legible instead of becoming a text wall.
    for (const list of cohorts.values()) {
        if (list.length < 8 || list.some(unit => unit.boss || unit.id === state.activeUnitId)) continue;
        const centers = list.map(unit => transform.toCanvas(unit.position));
        const x = centers.reduce((sum, center) => sum + center.x, 0) / centers.length;
        const top = Math.min(...centers.map(center => center.y)) - 13;
        const hp = list.reduce((sum, unit) => sum + unit.hp + unit.thp, 0), maxHp = list.reduce((sum, unit) => sum + unit.maxHp, 0);
        context.textAlign = 'center'; context.fillStyle = '#f0c2b8'; context.font = '600 10px sans-serif'; context.fillText(`${list[0].name} ×${list.length}`, x, top); context.fillStyle = '#a9b7aa'; context.font = '9px sans-serif'; context.fillText(`总 HP ${hp}/${maxHp}`, x, top + 11);
    }
    renderAttackEffects(context, transform, state);
    context.restore();
}

const ATTACK_EFFECT_OUTCOMES = { hit: { label: '命中', color: '#ffd27a' }, miss: { label: '未命中', color: '#9aa5a0' }, critical: { label: '暴击', color: '#ff6b6b' }, miracle: { label: '大成功', color: '#ffd700' }, blocked: { label: '格挡', color: '#7aa2ff' }, resisted: { label: '抵抗', color: '#b787f5' }, absorbed: { label: '吸收', color: '#69d8b8' }, evaded: { label: '闪避', color: '#8bd7f2' } };
const attackEffectStyle = outcome => ATTACK_EFFECT_OUTCOMES[String(outcome || '').toLowerCase()] || { label: '结算', color: '#d0e6a5' };

function spawnAttackEffects(state, events) {
    const now = Date.now();
    const knownIds = new Set((state?.combatants || []).map(unit => unit.id));
    for (const event of events || []) {
        if (event?.type !== 'action_resolved' && event?.type !== 'script_action_resolved') continue;
        const attackerId = event.payload?.actorId;
        if (!knownIds.has(attackerId)) continue;
        for (const result of Array.isArray(event.payload?.results) ? event.payload.results : []) {
            const targetId = result?.targetId;
            if (!targetId || !knownIds.has(targetId)) continue;
            const outcome = String(result?.outcome || result?.kind || 'hit').toLowerCase();
            const style = attackEffectStyle(outcome);
            attackEffects = attackEffects.filter(effect => !(effect.attackerId === attackerId && effect.targetId === targetId));
            attackEffects.push({ attackerId, targetId, outcome, color: style.color, label: style.label, startedAt: now, duration: 2600 });
        }
    }
    if (attackEffects.length) animateCombatEffects();
}

function animateCombatEffects() {
    if (combatEffectFrame) cancelAnimationFrame(combatEffectFrame);
    const step = () => {
        const now = Date.now();
        attackEffects = attackEffects.filter(effect => now - effect.startedAt < effect.duration);
        if (!attackEffects.length) { combatEffectFrame = 0; return; }
        drawMap();
        combatEffectFrame = requestAnimationFrame(step);
    };
    combatEffectFrame = requestAnimationFrame(step);
}

function bezierPoint(a, mid, b, t) {
    const u = 1 - t;
    return { x: u * u * a.x + 2 * u * t * mid.x + t * t * b.x, y: u * u * a.y + 2 * u * t * mid.y + t * t * b.y };
}

function renderAttackEffects(context, transform, state) {
    const now = Date.now();
    for (const effect of attackEffects) {
        const from = state.combatants.find(unit => unit.id === effect.attackerId);
        const to = state.combatants.find(unit => unit.id === effect.targetId);
        if (!from || !to) continue;
        const progress = Math.min(1, (now - effect.startedAt) / effect.duration);
        const a = transform.toCanvas(from.position);
        const b = transform.toCanvas(to.position);
        const arcHeight = Math.min(46, Math.max(10, Math.hypot(b.x - a.x, b.y - a.y) * 0.18));
        const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - arcHeight };
        const travel = Math.min(1, progress / 0.55);
        const p = bezierPoint(a, mid, b, travel);
        context.save();
        context.globalAlpha = progress > 0.75 ? (1 - progress) / 0.25 : 1;
        context.lineCap = 'round';
        context.strokeStyle = effect.color;
        context.lineWidth = 2.5;
        context.beginPath(); context.moveTo(a.x, a.y); context.lineTo(p.x, p.y); context.stroke();
        context.globalAlpha *= .35;
        context.lineWidth = 6;
        context.stroke();
        context.globalAlpha = progress > 0.75 ? (1 - progress) / 0.25 : 1;
        context.fillStyle = '#fff';
        context.beginPath(); context.arc(p.x, p.y, 3.4, 0, Math.PI * 2); context.fill();
        context.fillStyle = effect.color;
        context.beginPath(); context.arc(p.x, p.y, 2, 0, Math.PI * 2); context.fill();
        const flash = (progress - 0.55) / 0.45;
        if (flash > 0) {
            const radius = Math.max(4, 8 + flash * 16);
            context.globalAlpha = (progress > 0.75 ? (1 - progress) / 0.25 : 1) * Math.max(0, 1 - flash);
            context.strokeStyle = effect.color;
            context.lineWidth = 2;
            context.beginPath(); context.arc(b.x, b.y, radius, 0, Math.PI * 2); context.stroke();
            context.globalAlpha = (progress > 0.75 ? (1 - progress) / 0.25 : 1) * Math.max(0, .55 - flash * .5);
            context.fillStyle = effect.color;
            context.beginPath(); context.arc(b.x, b.y, Math.max(3, 7 + flash * 8), 0, Math.PI * 2); context.fill();
        }
        context.globalAlpha = 1;
        context.fillStyle = effect.color;
        context.font = '700 11px sans-serif';
        context.textAlign = 'center';
        context.fillText(effect.label, b.x, b.y - 16);
        context.restore();
    }
}

function renderBattlefield(state) {
    const root = $('#battle-orb-map-wrap');
    if (!root) return;
    if (!state?.battlefield) { root.innerHTML = '<div class="empty-state">创建遭遇后显示二维战场</div>'; return; }
    const actor = state.combatants.find(unit => unit.id === state.activeUnitId);
    selectedUnit(state);
    const intent = mapIntent?.type === 'move' ? '已选择移动：点选可达落点' : mapIntent?.type === 'withdraw' ? '已选择战术脱离：点选4米内的方向' : mapIntent?.type === 'lure' ? '已选择诱导：点选声源位置' : mapIntent?.type === 'ability' ? `已选择技能：点选目标 · ${mapIntent.abilityName}` : '点击实体查看详情 · 点击空白处打开行动菜单';
    const field = state.battlefield;
    const intel = intelSummary(state);
    const notice = actionNotice ? `<div class="combat-action-notice ${escapeHtml(actionNotice.kind)}" role="status">${escapeHtml(actionNotice.text)}</div>` : '';
    const inspectorUnit = inspectorUnitId ? state.combatants.find(unit => unit.id === inspectorUnitId) : null;
    const selectedUnitBox = state.combatants.find(unit => unit.id === selectedUnitId) || actor;
    root.innerHTML = `<div class="combat-map-wrap">${notice}<div class="combat-map-zoom" role="toolbar" aria-label="战场缩放"><button data-action="combat-map-zoom-out" title="缩小">−</button><button data-action="combat-map-zoom-reset" title="恢复 100%">${Math.round(mapZoom * 100)}%</button><button data-action="combat-map-zoom-in" title="放大">＋</button><button data-action="combat-map-zoom-200" title="快速放大到 200%">200%</button></div><canvas id="battle-orb-map" aria-label="二维战场"></canvas>${rangeLegendMarkup(selectedUnitBox, state)}${mapMenuMarkup(state, actor)}${entityInspectorMarkup(inspectorUnit, state)}<div class="combat-map-caption"><span>${escapeHtml(field.shape === 'circle' ? `圆形 · 半径 ${field.radiusMeters}m` : `矩形 · ${field.widthMeters}m × ${field.heightMeters}m`)}</span><b>${escapeHtml(intent)}</b><span title="${escapeHtml(intel.text)}">情报：已见敌 ${intel.visibleEnemies}${intel.hiddenEnemies ? ` · 未确认 ${intel.hiddenEnemies}` : ''}</span></div></div>`;
    requestAnimationFrame(() => {
        drawMap();
        if (mapIntent) {
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'combat-intent-cancel';
            cancel.dataset.action = 'combat-map-cancel';
            cancel.textContent = '取消当前操作';
            cancel.title = '退出当前攻击、移动或机动目标选择';
            $('#battle-orb-map-wrap .combat-map-wrap')?.append(cancel);
        }
        if (mapMenu) {
            const cancelMenu = document.createElement('button');
            cancelMenu.type = 'button';
            cancelMenu.className = 'combat-menu-cancel';
            cancelMenu.dataset.action = 'combat-map-menu-cancel';
            cancelMenu.textContent = '关闭行动菜单';
            $('#battle-orb-map-wrap .combat-map-menu')?.append(cancelMenu);
        }
        const menu = $('#battle-orb-map-wrap .combat-map-menu');
        if (menu) {
            const legalActions = state?.pauseReason?.legalActions || [];
            menu.querySelectorAll('[data-combat-ability-id]').forEach(button => {
                const ability = legalActions.find(item => item.id === button.dataset.combatAbilityId);
                if (Array.isArray(ability?.legalTargetIds) && ability.legalTargetIds.length === 0) {
                    button.disabled = true;
                    const hint = button.querySelector('small');
                    if (hint) hint.textContent = '攻击范围内无合法目标';
                    button.title = '范围内无目标；请先移动、等待或取消';
                }
            });
            const moveButton = menu.querySelector('[data-action="combat-map-menu-move"]');
            const menuActor = state?.combatants?.find(unit => unit.id === state.activeUnitId);
            const remaining = Number(state?.turnBudget?.[menuActor?.id]?.movementMeters ?? menuActor?.speedMeters ?? 0);
            if (moveButton && (state?.pauseReason?.type !== 'manual_turn' || remaining <= 0)) moveButton.remove();
        }
        const canvas = $('#battle-orb-map');
        canvas?.addEventListener('wheel', event => {
            event.preventDefault();
            const next = Number(mapZoom) + (event.deltaY < 0 ? .1 : -.1);
            mapZoom = Math.min(3, Math.max(.5, Math.round(next * 10) / 10));
            drawMap();
            const button = document.querySelector('.combat-map-zoom [data-action="combat-map-zoom-reset"]');
            if (button) button.textContent = `${Math.round(mapZoom * 100)}%`;
        }, { passive: false });
        // Zooming is useful only when the enlarged field can also be moved.
        // Pointer events keep this identical on mouse, pen and touch; a short
        // tap still falls through to the existing entity/action-menu click.
        canvas?.addEventListener('pointerdown', event => {
            if (event.button !== undefined && event.button !== 0) return;
            mapPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, pan: { ...mapPan } };
            canvas.setPointerCapture?.(event.pointerId);
            canvas.style.cursor = 'grabbing';
        });
        canvas?.addEventListener('pointermove', event => {
            const pointer = mapPointer;
            if (!pointer || pointer.id !== event.pointerId) return;
            const dx = event.clientX - pointer.x; const dy = event.clientY - pointer.y;
            if (!pointer.moved && Math.hypot(dx, dy) < 3) return;
            pointer.moved = true;
            mapPan = { x: pointer.pan.x + dx, y: pointer.pan.y + dy };
            drawMap();
        });
        const finishMapPointer = event => {
            const pointer = mapPointer;
            if (!pointer || pointer.id !== event.pointerId) return;
            if (pointer.moved) mapSuppressClickUntil = Date.now() + 120;
            mapPointer = null;
            canvas.style.cursor = 'grab';
            canvas.releasePointerCapture?.(event.pointerId);
        };
        canvas?.addEventListener('pointerup', finishMapPointer);
        canvas?.addEventListener('pointercancel', finishMapPointer);
        canvas?.addEventListener('pointerleave', event => {
            // Keep a captured drag alive when the pointer leaves the canvas;
            // only pointerup/pointercancel terminates it.
            if (mapPointer?.id === event.pointerId) return;
            canvas.style.cursor = 'grab';
        });
    });
}

function renderTurn(state) {
    const root = $('#battle-orb-turn'); if (!root) return;
    const actor = state?.combatants?.find(unit => unit.id === state.activeUnitId);
    if (!state) { root.innerHTML = '<div class="bo-empty">创建战场后显示当前行动。</div>'; return; }
    const targets = state.combatants.filter(unit => unit.side === 'enemy' && unit.state === 'active');
    const actionButtons = actor?.controller === 'player' && state.status === 'paused' ? (actor.abilities || []).flatMap(ability => targets.map(target => `<button class="bo-action" data-bo-action="attack" data-ability="${escapeHtml(ability.id)}" data-target="${escapeHtml(target.id)}">${escapeHtml(ability.name || ability.id)} → ${escapeHtml(target.name)}</button>`)).join('') : '';
    const reactionButtons = state.pauseReason?.type === 'reaction_window' || state.pauseReason?.type === 'boss_phase' ? ['interrupt', 'defend', 'policy'].map(choice => `<button class="bo-action" data-bo-reaction="${choice}">${choice === 'interrupt' ? '尝试打断' : choice === 'defend' ? '防御' : '按策略处理'}</button>`).join('') : '';
    root.innerHTML = `<div class="bo-turn-head"><b>${escapeHtml(actor?.name || '等待演算')}</b><span>${escapeHtml(state.status)} · 第 ${state.round || 0} 回合</span></div><p>${escapeHtml(state.pauseReason ? JSON.stringify(state.pauseReason) : '本地引擎正在推进')}</p><div class="bo-action-grid">${actionButtons || '<span class="bo-muted">当前没有可选攻击目标</span>'}</div><div class="bo-action-grid"><button class="bo-action" data-bo-action="move">点地图移动</button><button class="bo-action" data-bo-action="wait">等待</button><button class="bo-action" data-bo-action="hide">潜行</button><button class="bo-action" data-bo-action="resume">继续推进</button></div><div class="bo-action-grid">${reactionButtons}</div>${mapIntent?.type === 'move' ? '<small class="bo-hint">请点击二维战场上的目标位置。</small>' : ''}`;
}

function renderLedger(state) {
    const node = $('#battle-orb-ledger'); if (!node || !state || !repository) return;
    const events = repository.events(state.id).slice(-18);
    node.innerHTML = events.length ? events.map(event => `<div><span>#${event.sequence}</span> ${escapeHtml(event.type)} <small>${escapeHtml(JSON.stringify(event.payload || {}).slice(0, 180))}</small></div>`).join('') : '<div class="bo-muted">暂无裁定事件</div>';
}

function renderSteps() {
    const steps = [
        ['read', 'battle-orb-sync', '①', '读取', '楼层 + MVU', Boolean(tavernSnapshot)],
        ['recognize', 'battle-orb-recognize', '②', '识别', '战场声明', Boolean(declaration)],
        ['create', 'battle-orb-create', '③', '创建战场', 'CombatModel', Boolean(publicBattle())],
    ];
    for (const [key, id, badge, label, hint, done] of steps) {
        const button = $(`#${id}`);
        if (!button) continue;
        const failed = flowError?.step === key;
        button.classList.toggle('done', done);
        button.classList.toggle('failed', failed);
        button.classList.toggle('active', !done && !failed && !busy && (key === 'read' || (key === 'recognize' && Boolean(tavernSnapshot)) || (key === 'create' && Boolean(declaration))));
        button.disabled = busy || (key === 'create' && !declaration);
        button.innerHTML = `<i>${failed ? '↻' : badge}</i><b>${failed ? '重试' : label}</b><small>${failed ? (flowError?.message || '') : hint}</small>`;
    }
}

function render() {
    const floor = $('#battle-orb-floor');
    if (floor) floor.textContent = tavernSnapshot ? `已读取 ${tavernSnapshot.messages.length} 楼 · MVU ${tavernSnapshot.mvu.applied} 条 Patch · ${tavernSnapshot.mvu.source}` : '尚未读取当前酒馆聊天';
    const mvu = $('#battle-orb-mvu');
    if (mvu) mvu.textContent = tavernSnapshot ? JSON.stringify(tavernSnapshot.mvu.state, null, 2) : '同步后显示';
    const declarationBox = $('#battle-orb-declaration');
    if (declarationBox && declaration && declarationBox !== document.activeElement) declarationBox.value = JSON.stringify(declaration, null, 2);
    const state = publicBattle();
    mapState = state;
    const field = $('#battle-orb-field'); if (field) field.hidden = !state;
    const narrateButton = $('#battle-orb-narrate'); if (narrateButton) narrateButton.disabled = busy || !state || state.status !== 'completed';
    const meta = $('#battle-orb-battle-meta');
    if (meta && state) meta.textContent = `${state.title || '遭遇'} · ${state.status} · seed ${String(state.seed || '').slice(0, 12)}`;
    renderTurn(state); renderLedger(state); renderBattlefield(state);
    renderSteps();
}

function assistantName() {
    const ctx = activeContext();
    const name = String(ctx.name2 || '').trim();
    if (name && name !== 'SillyTavern System') return name;
    const all = Array.isArray(ctx.chat) ? ctx.chat : [];
    for (let index = all.length - 1; index >= 0; index -= 1) {
        const message = all[index];
        if (message && !message.is_user && !message.is_system) {
            const candidate = String(message.name || '').trim();
            if (candidate && candidate !== 'SillyTavern System') return candidate;
        }
    }
    return name || 'assistant';
}

function insertFloor(ctx, content, extra = {}) {
    const mes = String(content || '');
    const message = {
        name: assistantName(),
        is_user: false,
        is_system: false,
        send_date: new Date().toISOString(),
        mes,
        swipe_id: 0,
        swipes: [mes],
        extra,
    };
    ctx.chat.push(message);
    ctx.chatMetadata.tainted = true;
    const messageId = ctx.chat.length - 1;
    ctx.addOneMessage(message, { scroll: true });
    void ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, messageId, 'battle-orb');
    void ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId, 'battle-orb');
    return messageId;
}

async function narrate() {
    const state = publicBattle();
    if (!state || state.status !== 'completed' || busy) return;
    const ctx = activeContext(); const battleId = state.id;
    if (ctx.chat?.some(message => message.extra?.battleOrb?.battleId === battleId)) return notify('这场战斗已经回写过当前聊天', 'info');
    busy = true; setStatus('正在回写战报…', 'working'); render();
    try {
        const events = repository.events(battleId);
        const final = state.finalResult;
        const dsl = buildBattleResultDsl({ state, events, final });
        const recent = (tavernSnapshot || readTavern()).recent;
        const checks = (final.checkResults || []).slice(-20).map(check => `- ${check.actorId || ''} → ${check.targetId || ''}：D100 ${check.selected} + ${check.modifier} = ${check.total} / DC ${check.defenseDC}，${check.outcome || 'resolved'}`).join('\n');
        const patch = Array.isArray(final.mvuPatch) ? final.mvuPatch : [];
        const recordExtra = { battleOrb: { battleId, replayHash: final.eventHash || null, result: final, importedAt: new Date().toISOString() } };
        const checksBlock = checks ? `<CheckResult>\n${checks}\n</CheckResult>\n\n` : '';
        const patchBlock = `<UpdateVariable><JSONPatch>\n${JSON.stringify(patch, null, 2)}\n</JSONPatch></UpdateVariable>`;

        const recordContent = `${dsl}\n\n${checksBlock}${patchBlock}`;

        if (settings.writeVerdictBasis) {
            insertFloor(ctx, `【Battle Orb 战斗记录】\n${recordContent}`, recordExtra);
            setStatus('判断依据已正式插入楼层，正在创作剧情…', 'working'); render();
        }

        let prose = '';
        try {
            prose = String(await generateRaw([
                { role: 'system', content: '你是酒馆主 AI 的战后叙事融合器。只能依据本地 BATTLE_RESULT_DSL 写中文剧情，不能改写命中、伤害、位置、伤亡、胜负或 MVU Patch；只输出正文，不要 JSON、不要分析。' },
                { role: 'user', content: `战前最近剧情：\n${JSON.stringify(recent)}\n\n本地权威战报：\n${dsl}` },
            ], 6000)).replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '').trim();
        } catch (error) {
            prose = `本地战斗在第 ${final.rounds || state.round || 0} 回合完成。胜者：${final.winner === 'player' ? '玩家方' : final.winner === 'enemy' ? '敌方' : '未决'}。正文 AI 暂不可用，本楼保留本地权威战报与 MVU 更新。`;
            setStatus(`正文 AI 暂不可用，使用本地战报模板回写：${error.message}`, 'warn');
        }

        if (settings.writeVerdictBasis) {
            insertFloor(ctx, prose || '本地战斗已完成。', {});
        } else {
            insertFloor(ctx, `${prose || '本地战斗已完成。'}\n\n${checksBlock}${patchBlock}`, recordExtra);
        }
        await ctx.saveChat();
        setStatus(settings.writeVerdictBasis ? '战斗记录与剧情已写回当前酒馆楼层' : '剧情已写回当前酒馆楼层（仅剧情）', 'ok');
        notify('Battle Orb 战报已回写当前酒馆聊天', 'success');
    } catch (error) { notify(`战后回写失败：${error.message}`, 'error'); }
    finally { busy = false; render(); }
}

async function handleMapClick(event) {
    const canvas = event.target.closest('#battle-orb-map');
    if (!canvas || !mapState?.battlefield) return false;
    if (Date.now() < mapSuppressClickUntil) return true;
    const transform = canvas._battlefieldTransform || battlefieldTransform(canvas, mapState.battlefield);
    const bounds = canvas.getBoundingClientRect(); const world = transform.toWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    const visible = visibleIds(mapState);
    const hit = mapState.combatants.filter(unit => visible.has(unit.id)).sort((a, b) => Math.hypot(a.position.x - world.x, a.position.y - world.y) - Math.hypot(b.position.x - world.x, b.position.y - world.y)).find(unit => Math.hypot(unit.position.x - world.x, unit.position.y - world.y) <= Math.max(unit.radiusMeters, .7, 10 / Math.max(.1, transform.scale)));
    const actor = mapState.combatants.find(unit => unit.id === mapState.activeUnitId);
    // A completed battle has no activeUnitId, but the 2D field must remain
    // inspectable. Without an active actor we only allow inspection; action
    // menus stay disabled so the terminal never looks frozen after the last
    // action.
    if (!actor) {
        mapIntent = null;
        mapMenu = null;
        if (hit) {
            selectedUnitId = hit.id;
            inspectorUnitId = hit.id;
        } else {
            inspectorUnitId = null;
        }
        render();
        return true;
    }
    if (!mapIntent) {
        if (hit) {
            selectedUnitId = hit.id; inspectorUnitId = hit.id; mapMenu = null;
        } else {
            selectedUnitId = actor.id; inspectorUnitId = null;
            mapMenu = { world };
        }
        render();
        return true;
    }
    if (mapIntent.type === 'move' || mapIntent.type === 'withdraw' || mapIntent.type === 'lure') {
        const type = mapIntent.type;
        mapIntent = null;
        mapMenu = null;
        const ok = await execute({ type, actorId: actor.id, x: Math.round(world.x * 100) / 100, y: Math.round(world.y * 100) / 100 });
        if (!ok) { mapIntent = { type }; render(); }
        return true;
    }
    const abilityHit = hit?.id === actor.id ? null : hit;
    if (!abilityHit) {
        mapIntent = null;
        mapMenu = null;
        notify('未选中合法目标，已退出当前攻击模式。', 'info');
        render();
        return true;
    }
    if (mapIntent.type === 'move_attack') {
        const intent = mapIntent; mapIntent = null; mapMenu = null;
        const ok = await execute({ type: 'move_attack', actorId: actor.id, targetId: abilityHit.id });
        if (!ok) { mapIntent = intent; render(); }
        return true;
    }
    const intent = mapIntent; mapIntent = null;
    mapMenu = null;
    const ok = await execute({ type: intent.script ? 'script' : 'attack', actorId: actor.id, abilityId: intent.abilityId, targetIds: [abilityHit.id] });
    if (!ok) { mapIntent = intent; render(); }
    return true;
}

function bindPanel() {
    $('#battle-orb-sync')?.addEventListener('click', async () => {
        flowError = null;
        try {
            tavernSnapshot = readTavern();
            await refreshTavernFromGlobals();
            const found = battleDeclarationFromFloor();
            if (found) declaration = normalizeDeclaration(found);
            render();
            setStatus(`已读取 ${tavernSnapshot.messages.length} 楼与 ${tavernSnapshot.mvu.applied} 条 MVU Patch（${tavernSnapshot.mvu.source}）`, 'ok');
        } catch (error) { flowError = { step: 'read', message: error.message || '读取失败' }; notify(`读取失败：${error.message}`, 'error'); render(); }
    });
    $('#battle-orb-recognize')?.addEventListener('click', () => void recognize());
    $('#battle-orb-create')?.addEventListener('click', () => void createBattle());
    $('#battle-orb-narrate')?.addEventListener('click', () => void narrate());
    $('#battle-orb-write-verdict')?.addEventListener('change', event => { settings.writeVerdictBasis = Boolean(event.target.checked); saveSettings(); setStatus(settings.writeVerdictBasis ? '判断依据回写正文：战斗记录正式插入楼层后再创作剧情' : '只写回剧情：仅把剧情写回楼层', 'ok'); });
    $('#battle-orb-recognize-hint')?.addEventListener('input', event => { settings.recognizeHint = String(event.target.value || '').trim(); saveSettings(); });
    $('#battle-orb-declaration')?.addEventListener('input', event => { try { declaration = normalizeDeclaration(JSON.parse(event.target.value)); } catch { declaration = null; } render(); });
    document.addEventListener('click', async event => {
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (event.target.closest('#battle-orb-map')) { if (await handleMapClick(event)) return; }
        if (action === 'combat-map-zoom-out' || action === 'combat-map-zoom-in' || action === 'combat-map-zoom-reset' || action === 'combat-map-zoom-200') {
            mapSuppressClickUntil = 0;
            if (action === 'combat-map-zoom-out') mapZoom = Math.max(.5, Math.round((mapZoom - .25) * 100) / 100);
            if (action === 'combat-map-zoom-in') mapZoom = Math.min(3, Math.round((mapZoom + .25) * 100) / 100);
            if (action === 'combat-map-zoom-reset') { mapZoom = 1; mapPan = { x: 0, y: 0 }; }
            if (action === 'combat-map-zoom-200') mapZoom = 2;
            drawMap();
            const zoomLabel = document.querySelector('.combat-map-zoom [data-action="combat-map-zoom-reset"]');
            if (zoomLabel) zoomLabel.textContent = `${Math.round(mapZoom * 100)}%`;
            return;
        }
        if (action === 'combat-close-entity-inspector') { mapMenu = null; inspectorUnitId = null; selectedUnitId = mapState?.activeUnitId || null; render(); return; }
        if (action === 'combat-map-cancel' || action === 'combat-map-menu-cancel') {
            mapIntent = null;
            mapMenu = null;
            render();
            return;
        }
        if (action === 'combat-map-menu-move') {
            if (!mapMenu || !mapState?.activeUnitId) { notify('没有可用的移动落点', 'error'); return; }
            const destination = mapMenu.world; const actorId = mapState.activeUnitId; mapMenu = null;
            const ok = await execute({ type: 'move', actorId, x: Math.round(destination.x * 100) / 100, y: Math.round(destination.y * 100) / 100 });
            if (!ok) render();
            return;
        }
        if (action === 'combat-map-menu-maneuver') {
            const maneuver = event.target.closest('[data-combat-maneuver]')?.dataset.combatManeuver;
            const actorId = mapState?.activeUnitId;
            if (!maneuver || !actorId) { notify('当前没有可用机动动作', 'error'); return; }
            mapMenu = null;
            if (maneuver === 'withdraw' || maneuver === 'lure') { mapIntent = { type: maneuver }; render(); return; }
            void execute({ type: maneuver, actorId });
            return;
        }
        if (action === 'combat-map-menu-ability') {
            const actor = mapState?.combatants?.find(unit => unit.id === mapState?.activeUnitId);
            const ability = actor?.abilities?.find(item => item.id === event.target.closest('[data-combat-ability-id]')?.dataset.combatAbilityId);
            if (!ability) { notify('当前能力不可用', 'error'); return; }
            if (Array.isArray(ability.legalTargetIds) && !ability.legalTargetIds.length) { notify('当前攻击范围内没有合法目标，请先移动或取消攻击模式。', 'info'); return; }
            mapIntent = { type: 'ability', abilityId: ability.id, abilityName: ability.name, script: event.target.closest('[data-combat-script]')?.dataset.combatScript === 'true' }; mapMenu = null; render(); return;
        }
        if (action === 'combat-map-menu-move-attack') {
            if (!mapState?.activeUnitId) { notify('当前没有可操作单位', 'error'); return; }
            mapIntent = { type: 'move_attack', abilityId: 'basic-attack', abilityName: '移动攻击' };
            mapMenu = null; render(); return;
        }
        if (action === 'combat-map-menu-wait') { mapMenu = null; void execute({ type: 'wait', actorId: mapState?.activeUnitId }); return; }
    });
    document.addEventListener('click', event => {
        const action = event.target.closest('[data-bo-action]'); if (!action) return;
        const state = publicBattle(); const actorId = state?.activeUnitId;
        if (action.dataset.boAction === 'move') { mapIntent = { type: 'move' }; render(); return; }
        if (action.dataset.boAction === 'resume') { if (!battle || busy) return; busy = true; void engine.resume(battle).then(() => repository.commit(battle)).catch(error => notify(`推进失败：${error.message}`, 'error')).finally(() => { busy = false; render(); }); return; }
        if (!actorId) return;
        if (action.dataset.boAction === 'attack') void execute({ type: 'attack', actorId, abilityId: action.dataset.ability, targetIds: [action.dataset.target] });
        else void execute({ type: action.dataset.boAction, actorId });
    });
    document.addEventListener('click', event => { const reactionButton = event.target.closest('[data-bo-reaction]'); if (reactionButton) void reaction(reactionButton.dataset.boReaction); });
}

function mount() {
    if (mounted || document.getElementById(ROOT_ID)) return;
    mounted = true;
    const root = document.createElement('div'); root.id = ROOT_ID; root.innerHTML = `
      <button id="${FAB_ID}" type="button" title="Battle Orb ${VERSION}">⚔</button>
      <section id="${PANEL_ID}">
        <header id="battle-orb-head" class="bo-header"><div><small>BATTLE ORB · TAVERN NATIVE</small><h2>战斗球</h2><p>直接读取当前酒馆楼层与 MVU；本地裁定战斗；战报回写主 AI。</p></div><button id="battle-orb-close" class="bo-close">×</button></header>
        <div id="battle-orb-body" class="bo-body">
          <div class="bo-steps">
            <button id="battle-orb-sync" class="bo-step" type="button"><i>①</i><b>读取</b><small>楼层 + MVU</small></button>
            <button id="battle-orb-recognize" class="bo-step" type="button"><i>②</i><b>识别</b><small>战场声明</small></button>
            <button id="battle-orb-create" class="bo-step" type="button"><i>③</i><b>创建战场</b><small>CombatModel</small></button>
          </div>
          <label class="bo-setting"><input id="battle-orb-write-verdict" type="checkbox" ${settings.writeVerdictBasis ? 'checked' : ''}><span>判断依据回写正文</span><small>战斗记录正式插入楼层后再剧情创作；关闭则只写回剧情</small></label>
          <label class="bo-hint-field"><span>识别提示（可选）</span><input id="battle-orb-recognize-hint" type="text" value="${escapeHtml(settings.recognizeHint || '')}" placeholder="敌人数量范围 / 规模 / 战术等额外提醒"></label>
          <div id="battle-orb-status" class="bo-status">准备就绪：点击“读取”</div>
          <div id="battle-orb-floor" class="bo-floor">尚未读取当前酒馆聊天</div>
          <details class="bo-fold"><summary>当前 MVU 快照</summary><pre id="battle-orb-mvu">同步后显示</pre></details>
          <section class="bo-declaration"><header><b>BattleDeclaration</b><small>可人工修正后创建</small></header><textarea id="battle-orb-declaration" spellcheck="false" placeholder="从当前楼层读取，或点击识别让主 AI 草拟"></textarea></section>
          <section id="battle-orb-field" class="bo-field" hidden><header><div><b>二维战场</b><small id="battle-orb-battle-meta">本地权威演算</small></div><button id="battle-orb-narrate" disabled>战斗完成后回写主 AI</button></header><div id="battle-orb-map-wrap" class="bo-map-wrap"></div><div id="battle-orb-turn" class="bo-turn"></div><details class="bo-fold"><summary>本地裁定账本</summary><div id="battle-orb-ledger" class="bo-ledger"></div></details></section>
        </div>
      </section>`;
    document.body.append(root);
    const panel = $(`#${PANEL_ID}`);
    const fab = $(`#${FAB_ID}`);
    applyFabVisibility();
    const toggle = () => { if (panel.classList.contains('open')) panel.classList.remove('open'); else openFloatingPanel(panel); };
    fab.addEventListener('click', event => { if (fab.dataset.dragged === '1') return; event.preventDefault(); toggle(); });
    $('#battle-orb-close').addEventListener('click', () => panel.classList.remove('open'));
    makeDraggable(fab, fab, 'fab', true);
    makeDraggable($('#battle-orb-head'), panel, 'panel');
    restoreFloatingPosition('fab', fab);
    restoreFloatingPosition('panel', panel);
    installFloatingClampListeners([['fab', fab], ['panel', panel]]);
    bindPanel();
    tavernSnapshot = readTavern();
    void refreshTavernFromGlobals();
    const found = battleDeclarationFromFloor(); if (found) declaration = normalizeDeclaration(found);
    render();
    try {
        const ctx = activeContext();
        ctx.eventSource?.on?.(ctx.eventTypes?.MESSAGE_RECEIVED, messageId => {
            tavernSnapshot = readTavern();
            void refreshTavernFromGlobals();
            const foundDeclaration = battleDeclarationFromFloor();
            if (foundDeclaration) { declaration = normalizeDeclaration(foundDeclaration); openFloatingPanel(panel); setStatus('检测到正文 AI 的 BattleDeclaration，可开始本地战斗', 'ok'); render(); }
        });
        ctx.eventSource?.on?.(ctx.eventTypes?.CHAT_CHANGED, () => { tavernSnapshot = readTavern(); void refreshTavernFromGlobals(); const foundDeclaration = battleDeclarationFromFloor(); if (foundDeclaration) declaration = normalizeDeclaration(foundDeclaration); render(); });
    } catch (error) { console.warn('[Battle Orb] 酒馆事件监听安装失败', error); }
    console.info(`[Battle Orb] 已注入酒馆工作流 v${VERSION}，无独立端口`);
}

addEventListener('battle-orb:open-panel', () => {
    if (!document.getElementById(ROOT_ID) && !mounted) mount();
    const panel = document.getElementById(PANEL_ID);
    if (panel) openFloatingPanel(panel);
});
addEventListener('battle-orb:remount', () => {
    if (!document.getElementById(ROOT_ID)) { mounted = false; mount(); }
    const panel = document.getElementById(PANEL_ID);
    if (panel) openFloatingPanel(panel);
});
addEventListener('battle-orb:set-fab-visible', event => {
    const fab = document.getElementById(FAB_ID);
    if (fab) fab.style.display = event.detail?.visible === false ? 'none' : '';
});

mount();
bootTrace('bootstrap-complete', { rootConnected: Boolean(document.getElementById(ROOT_ID)), fabExists: Boolean(document.getElementById(FAB_ID)) });
globalThis.__battleOrbDebug = {
    attackEffects: () => attackEffects.map(effect => ({ ...effect })),
    settings: () => ({ ...settings }),
    flowError: () => flowError ? { ...flowError } : null,
};
} catch (error) {
    bootTrace('bootstrap-fatal', { message: error?.message || String(error), stack: error?.stack || '' });
    console.error('[Battle Orb] 启动失败；请在扩展菜单运行诊断', error);
}
})();
