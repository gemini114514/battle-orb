const VERSION = '0.2.0';
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
const FAB_ID = 'battle-orb-fab';
const MAX_FLOOR_CHARS = 9000;

let context = null;
let repository = null;
let engine = null;
let battle = null;
let declaration = null;
let model = null;
let tavernSnapshot = null;
let actionMode = null;
let selectedTargetId = null;
let busy = false;
let mounted = false;

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
    const local = activeContext().chatMetadata?.variables?.stat_data;
    if (local && Object.keys(output.stat_data).length === 0) {
        try { output.stat_data = typeof local === 'string' ? JSON.parse(local) : clone(local); } catch { /* ignore */ }
    }
    return { state: output, applied };
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
    return {
        chatId: ctx.getCurrentChatId?.() || null,
        characterName: ctx.name2 || '',
        userName: ctx.name1 || '',
        messages,
        recent: messages.slice(-18).map(message => ({ role: message.role, content: message.content.slice(-MAX_FLOOR_CHARS) })),
        mvu: replayMvu(messages),
    };
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

function declarationValidation(value) {
    const report = validateBattleDeclaration(value, { strict: false });
    if (!report?.ok) throw new Error((report?.errors || []).slice(0, 5).map(error => `${error.path}：${error.message}`).join('\n') || '战场声明校验失败');
}

async function recognize() {
    if (busy) return;
    busy = true; setStatus('正在读取酒馆楼层与 MVU…', 'working');
    try {
        tavernSnapshot = readTavern();
        const tagged = battleDeclarationFromFloor();
        const content = tagged ? tagged : extractJsonObject(await generateRaw([
            { role: 'system', content: DECLARATION_SYSTEM },
            { role: 'user', content: JSON.stringify({ recentStory: tavernSnapshot.recent, mvu: tavernSnapshot.mvu.state }, null, 2) },
        ], 2600));
        declaration = normalizeDeclaration(content);
        declarationValidation(declaration);
        $('#battle-orb-declaration').value = JSON.stringify(declaration, null, 2);
        render();
        setStatus(tagged ? '已从当前楼层读取 BattleDeclaration' : '已由酒馆当前 AI 草拟战场声明', 'ok');
    } catch (error) { notify(`识别战场失败：${error.message}`, 'error'); }
    finally { busy = false; render(); }
}

async function createBattle() {
    if (busy) return;
    try {
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
        } catch (error) { setStatus(`CombatModel 生成失败，改用本地安全默认模型：${error.message}`, 'warn'); }
        model = mergeModel(candidate, declaration);
        repository = new BrowserCombatRepository();
        engine = new CombatEngine(repository);
        const created = engine.create({ seed: id('tavern'), mode: 'manual', storySessionId: tavernSnapshot.chatId, encounter: model, assetProfiles: model.assetProfiles || [], preparation: { declaration, source: 'tavern-injected' } });
        battle = repository.get(created.id);
        await engine.start(battle);
        repository.commit(battle);
        actionMode = null; selectedTargetId = null;
        setStatus('战场已创建；骰点、伤害、状态、位置和胜负由本地引擎裁定', 'ok');
        render();
    } catch (error) { notify(`创建战场失败：${error.message}`, 'error'); }
    finally { busy = false; render(); }
}

function publicBattle() { return battle && engine ? engine.publicState(battle) : null; }

async function execute(command) {
    if (!battle || busy || ['completed', 'abandoned'].includes(battle.status)) return;
    busy = true; setStatus('本地演算中…', 'working'); render();
    try { await engine.command(battle, command); repository.commit(battle); actionMode = null; selectedTargetId = null; }
    catch (error) { notify(`行动失败：${error.message}`, 'error'); }
    finally { busy = false; render(); }
}

async function reaction(choice) {
    if (!battle || busy) return;
    busy = true;
    try { await engine.reaction(battle, { choice }); repository.commit(battle); }
    catch (error) { notify(`反应处理失败：${error.message}`, 'error'); }
    finally { busy = false; render(); }
}

function canvasTransform(state, canvas) {
    const field = state.battlefield || {};
    const width = field.shape === 'circle' ? Number(field.radiusMeters || 20) * 2 : Number(field.widthMeters || 60);
    const height = field.shape === 'circle' ? width : Number(field.heightMeters || 36);
    const scale = Math.min((canvas.clientWidth - 44) / width, (canvas.clientHeight - 44) / height);
    return { width, height, scale, toCanvas: point => ({ x: canvas.clientWidth / 2 + Number(point.x || 0) * scale, y: canvas.clientHeight / 2 - Number(point.y || 0) * scale }), toWorld: point => ({ x: (point.x - canvas.clientWidth / 2) / scale, y: -(point.y - canvas.clientHeight / 2) / scale }) };
}

function drawMap(state) {
    const canvas = $('#battle-orb-map');
    if (!canvas || !state?.battlefield) return;
    const rect = canvas.getBoundingClientRect(); const ratio = globalThis.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.floor(rect.width * ratio)); canvas.height = Math.max(1, Math.floor(rect.height * ratio));
    const graphics = canvas.getContext('2d'); graphics.setTransform(ratio, 0, 0, ratio, 0, 0);
    graphics.clearRect(0, 0, rect.width, rect.height); graphics.fillStyle = '#0b110d'; graphics.fillRect(0, 0, rect.width, rect.height);
    const transform = canvasTransform(state, canvas); const center = transform.toCanvas({ x: 0, y: 0 });
    graphics.strokeStyle = '#263a2b'; graphics.lineWidth = 1;
    for (let x = -transform.width / 2; x <= transform.width / 2; x += 5) { const p = transform.toCanvas({ x, y: 0 }); graphics.beginPath(); graphics.moveTo(p.x, 20); graphics.lineTo(p.x, rect.height - 20); graphics.stroke(); }
    for (let y = -transform.height / 2; y <= transform.height / 2; y += 5) { const p = transform.toCanvas({ x: 0, y }); graphics.beginPath(); graphics.moveTo(20, p.y); graphics.lineTo(rect.width - 20, p.y); graphics.stroke(); }
    graphics.strokeStyle = '#9acd54'; graphics.lineWidth = 2; graphics.fillStyle = '#121e14'; graphics.beginPath();
    if (state.battlefield.shape === 'circle') graphics.arc(center.x, center.y, Number(state.battlefield.radiusMeters || 20) * transform.scale, 0, Math.PI * 2);
    else graphics.rect(center.x - transform.width * transform.scale / 2, center.y - transform.height * transform.scale / 2, transform.width * transform.scale, transform.height * transform.scale);
    graphics.fill(); graphics.stroke();
    for (const unit of state.combatants || []) {
        const point = transform.toCanvas(unit.position || {}); const radius = Math.max(7, Number(unit.radiusMeters || .5) * transform.scale);
        graphics.beginPath(); graphics.fillStyle = unit.side === 'player' ? '#79d6e8' : unit.side === 'enemy' ? '#ef8177' : '#d3c16f'; graphics.globalAlpha = unit.state === 'active' ? 1 : .42; graphics.arc(point.x, point.y, Math.min(18, radius), 0, Math.PI * 2); graphics.fill(); graphics.globalAlpha = 1;
        if (unit.id === state.activeUnitId) { graphics.strokeStyle = '#eaff90'; graphics.lineWidth = 3; graphics.stroke(); }
        graphics.fillStyle = '#e8f4e4'; graphics.font = '11px system-ui'; graphics.textAlign = 'center'; graphics.fillText(`${unit.name} · ${Math.max(0, Math.round(unit.hp))}/${Math.max(1, Math.round(unit.maxHp))}`, point.x, point.y - Math.min(20, radius) - 5);
    }
}

function renderTurn(state) {
    const root = $('#battle-orb-turn'); if (!root) return;
    const actor = state?.combatants?.find(unit => unit.id === state.activeUnitId);
    if (!state) { root.innerHTML = '<div class="bo-empty">创建战场后显示当前行动。</div>'; return; }
    const targets = state.combatants.filter(unit => unit.side === 'enemy' && unit.state === 'active');
    const actionButtons = actor?.controller === 'player' && state.status === 'paused' ? (actor.abilities || []).flatMap(ability => targets.map(target => `<button class="bo-action" data-bo-action="attack" data-ability="${escapeHtml(ability.id)}" data-target="${escapeHtml(target.id)}">${escapeHtml(ability.name || ability.id)} → ${escapeHtml(target.name)}</button>`)).join('') : '';
    const reactionButtons = state.pauseReason?.type === 'reaction_window' || state.pauseReason?.type === 'boss_phase' ? ['interrupt', 'defend', 'policy'].map(choice => `<button class="bo-action" data-bo-reaction="${choice}">${choice === 'interrupt' ? '尝试打断' : choice === 'defend' ? '防御' : '按策略处理'}</button>`).join('') : '';
    root.innerHTML = `<div class="bo-turn-head"><b>${escapeHtml(actor?.name || '等待演算')}</b><span>${escapeHtml(state.status)} · 第 ${state.round || 0} 回合</span></div><p>${escapeHtml(state.pauseReason ? JSON.stringify(state.pauseReason) : '本地引擎正在推进')}</p><div class="bo-action-grid">${actionButtons || '<span class="bo-muted">当前没有可选攻击目标</span>'}</div><div class="bo-action-grid"><button class="bo-action" data-bo-action="move">点地图移动</button><button class="bo-action" data-bo-action="wait">等待</button><button class="bo-action" data-bo-action="hide">潜行</button><button class="bo-action" data-bo-action="resume">继续推进</button></div><div class="bo-action-grid">${reactionButtons}</div>${actionMode === 'move' ? '<small class="bo-hint">请点击二维战场上的目标位置。</small>' : ''}`;
}

function renderLedger(state) {
    const node = $('#battle-orb-ledger'); if (!node || !state || !repository) return;
    const events = repository.events(state.id).slice(-18);
    node.innerHTML = events.length ? events.map(event => `<div><span>#${event.sequence}</span> ${escapeHtml(event.type)} <small>${escapeHtml(JSON.stringify(event.payload || {}).slice(0, 180))}</small></div>`).join('') : '<div class="bo-muted">暂无裁定事件</div>';
}

function render() {
    const floor = $('#battle-orb-floor');
    if (floor) floor.textContent = tavernSnapshot ? `已读取 ${tavernSnapshot.messages.length} 楼 · MVU Patch ${tavernSnapshot.mvu.applied} 条` : '尚未读取当前酒馆聊天';
    const mvu = $('#battle-orb-mvu');
    if (mvu) mvu.textContent = tavernSnapshot ? JSON.stringify(tavernSnapshot.mvu.state, null, 2) : '同步后显示';
    const declarationBox = $('#battle-orb-declaration');
    if (declarationBox && declaration && declarationBox !== document.activeElement) declarationBox.value = JSON.stringify(declaration, null, 2);
    const state = publicBattle();
    const field = $('#battle-orb-field'); if (field) field.hidden = !state;
    const create = $('#battle-orb-create'); if (create) create.disabled = busy || !declaration;
    const narrateButton = $('#battle-orb-narrate'); if (narrateButton) narrateButton.disabled = busy || !state || state.status !== 'completed';
    const meta = $('#battle-orb-battle-meta');
    if (meta && state) meta.textContent = `${state.title || '遭遇'} · ${state.status} · seed ${String(state.seed || '').slice(0, 12)}`;
    renderTurn(state); renderLedger(state); if (state) drawMap(state);
}

async function narrate() {
    const state = publicBattle();
    if (!state || state.status !== 'completed' || busy) return;
    const ctx = activeContext(); const battleId = state.id;
    if (ctx.chat?.some(message => message.extra?.battleOrb?.battleId === battleId)) return notify('这场战斗已经回写过当前聊天', 'info');
    busy = true; setStatus('正在让酒馆当前 AI 融合本地战报…', 'working'); render();
    try {
        const events = repository.events(battleId);
        const final = state.finalResult;
        const dsl = buildBattleResultDsl({ state, events, final });
        const recent = (tavernSnapshot || readTavern()).recent;
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
        const checks = (final.checkResults || []).slice(-20).map(check => `- ${check.actorId || ''} → ${check.targetId || ''}：D100 ${check.selected} + ${check.modifier} = ${check.total} / DC ${check.defenseDC}，${check.outcome || 'resolved'}`).join('\n');
        const patch = Array.isArray(final.mvuPatch) ? final.mvuPatch : [];
        const content = `${prose || '本地战斗已完成。'}\n\n${checks ? `<CheckResult>\n${checks}\n</CheckResult>\n\n` : ''}<UpdateVariable><JSONPatch>\n${JSON.stringify(patch, null, 2)}\n</JSONPatch></UpdateVariable>`;
        const message = { name: ctx.name2 || 'assistant', is_user: false, is_system: false, send_date: Math.floor(Date.now() / 1000), mes: content, extra: { battleOrb: { battleId, replayHash: final.eventHash || null, result: final, importedAt: new Date().toISOString() } } };
        ctx.chat.push(message); ctx.chatMetadata.tainted = true; const messageId = ctx.chat.length - 1;
        ctx.addOneMessage(message, { scroll: true });
        await ctx.eventSource.emit(ctx.eventTypes.MESSAGE_RECEIVED, messageId, 'battle-orb');
        await ctx.eventSource.emit(ctx.eventTypes.CHARACTER_MESSAGE_RENDERED, messageId, 'battle-orb');
        await ctx.saveChat();
        setStatus('战报已写回当前主 AI 聊天，并保留 MVU JSONPatch', 'ok');
        notify('Battle Orb 战报已回写当前酒馆聊天', 'success');
    } catch (error) { notify(`战后回写失败：${error.message}`, 'error'); }
    finally { busy = false; render(); }
}

function handleCanvasClick(event) {
    const state = publicBattle(); const canvas = $('#battle-orb-map');
    if (!state || !canvas) return;
    const rect = canvas.getBoundingClientRect(); const point = { x: event.clientX - rect.left, y: event.clientY - rect.top }; const transform = canvasTransform(state, canvas); const world = transform.toWorld(point);
    const hit = state.combatants.find(unit => Math.hypot(Number(unit.position?.x || 0) - world.x, Number(unit.position?.y || 0) - world.y) <= Math.max(.8, Number(unit.radiusMeters || .5) + 1));
    if (hit) { selectedTargetId = hit.id; render(); return; }
    if (actionMode === 'move' && state.activeUnitId) void execute({ type: 'move', actorId: state.activeUnitId, x: Math.round(world.x * 100) / 100, y: Math.round(world.y * 100) / 100 });
}

function bindPanel() {
    $('#battle-orb-sync')?.addEventListener('click', () => { tavernSnapshot = readTavern(); const found = battleDeclarationFromFloor(); if (found) declaration = normalizeDeclaration(found); render(); setStatus(`已读取 ${tavernSnapshot.messages.length} 楼与 ${tavernSnapshot.mvu.applied} 条 MVU Patch`, 'ok'); });
    $('#battle-orb-recognize')?.addEventListener('click', () => void recognize());
    $('#battle-orb-create')?.addEventListener('click', () => void createBattle());
    $('#battle-orb-narrate')?.addEventListener('click', () => void narrate());
    $('#battle-orb-declaration')?.addEventListener('input', event => { try { declaration = normalizeDeclaration(JSON.parse(event.target.value)); } catch { declaration = null; } render(); });
    $('#battle-orb-map')?.addEventListener('click', handleCanvasClick);
    document.addEventListener('click', event => {
        const action = event.target.closest('[data-bo-action]'); if (!action) return;
        const state = publicBattle(); const actorId = state?.activeUnitId;
        if (action.dataset.boAction === 'move') { actionMode = 'move'; render(); return; }
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
    const root = document.createElement('section'); root.id = ROOT_ID; root.innerHTML = `
      <header class="bo-header"><div><small>BATTLE ORB · TAVERN NATIVE</small><h2>战斗球</h2><p>直接读取当前酒馆楼层与 MVU；本地裁定战斗；战报回写主 AI。</p></div><button id="battle-orb-close" class="bo-close">×</button></header>
      <div id="battle-orb-status" class="bo-status">准备就绪：点击“读取酒馆”</div>
      <div class="bo-toolbar"><button id="battle-orb-sync">读取酒馆楼层 / MVU</button><button id="battle-orb-recognize">识别 / 生成战场声明</button><button id="battle-orb-create" disabled>创建二维战场</button></div>
      <div id="battle-orb-floor" class="bo-floor">尚未读取当前酒馆聊天</div>
      <details class="bo-fold"><summary>当前 MVU 快照</summary><pre id="battle-orb-mvu">同步后显示</pre></details>
      <section class="bo-declaration"><header><b>BattleDeclaration</b><small>可人工修正后创建</small></header><textarea id="battle-orb-declaration" spellcheck="false" placeholder="从当前楼层读取，或点击识别让主 AI 草拟"></textarea></section>
      <section id="battle-orb-field" class="bo-field" hidden><header><div><b>二维战场</b><small id="battle-orb-battle-meta">本地权威演算</small></div><button id="battle-orb-narrate" disabled>战斗完成后回写主 AI</button></header><div class="bo-map-wrap"><canvas id="battle-orb-map"></canvas></div><div id="battle-orb-turn" class="bo-turn"></div><details class="bo-fold"><summary>本地裁定账本</summary><div id="battle-orb-ledger" class="bo-ledger"></div></details></section>`;
    document.body.append(root);
    const fab = document.createElement('button'); fab.id = FAB_ID; fab.type = 'button'; fab.textContent = '⚔'; fab.title = `Battle Orb ${VERSION}`; document.body.append(fab);
    applyFabVisibility();
    const toggle = () => root.classList.toggle('open'); fab.addEventListener('click', toggle); $('#battle-orb-close').addEventListener('click', () => root.classList.remove('open'));
    bindPanel();
    tavernSnapshot = readTavern();
    const found = battleDeclarationFromFloor(); if (found) declaration = normalizeDeclaration(found);
    render();
    try {
        const ctx = activeContext();
        ctx.eventSource?.on?.(ctx.eventTypes?.MESSAGE_RECEIVED, messageId => {
            tavernSnapshot = readTavern();
            const foundDeclaration = battleDeclarationFromFloor();
            if (foundDeclaration) { declaration = normalizeDeclaration(foundDeclaration); root.classList.add('open'); setStatus('检测到正文 AI 的 BattleDeclaration，可开始本地战斗', 'ok'); render(); }
        });
        ctx.eventSource?.on?.(ctx.eventTypes?.CHAT_CHANGED, () => { tavernSnapshot = readTavern(); const foundDeclaration = battleDeclarationFromFloor(); if (foundDeclaration) declaration = normalizeDeclaration(foundDeclaration); render(); });
    } catch (error) { console.warn('[Battle Orb] 酒馆事件监听安装失败', error); }
    console.info(`[Battle Orb] 已注入酒馆工作流 v${VERSION}，无独立端口`);
}

addEventListener('battle-orb:open-panel', () => {
    if (!document.getElementById(ROOT_ID) && !mounted) mount();
    document.getElementById(ROOT_ID)?.classList.add('open');
});
addEventListener('battle-orb:remount', () => {
    if (!document.getElementById(ROOT_ID)) { mounted = false; mount(); }
    document.getElementById(ROOT_ID)?.classList.add('open');
});
addEventListener('battle-orb:set-fab-visible', event => {
    const fab = document.getElementById(FAB_ID);
    if (fab) fab.style.display = event.detail?.visible === false ? 'none' : '';
});

mount();
bootTrace('bootstrap-complete', { rootConnected: Boolean(document.getElementById(ROOT_ID)), fabExists: Boolean(document.getElementById(FAB_ID)) });
} catch (error) {
    bootTrace('bootstrap-fatal', { message: error?.message || String(error), stack: error?.stack || '' });
    console.error('[Battle Orb] 启动失败；请在扩展菜单运行诊断', error);
}
})();
