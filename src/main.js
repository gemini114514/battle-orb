import './style.css';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import jquery from 'jquery';
import * as Vue from 'vue';
import * as Zod from 'zod';
import { GameStore, getAffection } from './store.js';
import { CardRuntime } from './runtime.js';
import { library, normalizePreset, normalizeScript, normalizeRegexPreset, normalizeUserProfile, normalizeWorldbookEntry } from './library.js';
import { GameplayBlackBox } from './blackbox.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const LIFE_LEVEL_ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ'];
const ASCII_LIFE_LEVEL_ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX'];
const TAVERN_QUALITY_ORDER = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];
// This range and its nine equal display bands are copied from the V3.2.6
// floating status ball. They are display-only: the final attributes remain
// read-only MVU output and no values are recalculated here.
const TAVERN_LIFE_ATTRIBUTE_RANGES = {
    'Ⅰ': [1, 29], 'Ⅱ': [30, 99], 'Ⅲ': [100, 299], 'Ⅳ': [300, 999], 'Ⅴ': [1000, 2999],
    'Ⅵ': [3000, 9999], 'Ⅶ': [10000, 29999], 'Ⅷ': [30000, 99999], 'Ⅸ': [100000, Infinity],
};
function normalizeLifeLevel(value) {
    const text = String(value ?? '').trim().toUpperCase();
    const romanIndex = LIFE_LEVEL_ROMAN.indexOf(text);
    if (romanIndex >= 0) return romanIndex + 1;
    const asciiIndex = ASCII_LIFE_LEVEL_ROMAN.indexOf(text);
    if (asciiIndex >= 0) return asciiIndex + 1;
    const numeric = Number(text);
    // The card has exactly nine life levels; legacy 1–50 values are invalid.
    return Number.isInteger(numeric) && numeric >= 1 && numeric <= 9 ? numeric : 1;
}
function lifeLevelRoman(value) { return LIFE_LEVEL_ROMAN[normalizeLifeLevel(value) - 1] || LIFE_LEVEL_ROMAN[0]; }
function heroLifeLevel(hero = {}) { return normalizeLifeLevel(hero.层级 ?? hero.位阶 ?? hero.等级 ?? 1); }

function uiQuality(value, fallback = 'E') {
    const quality = String(value ?? '').trim().toUpperCase();
    return TAVERN_QUALITY_ORDER.includes(quality) ? quality : fallback;
}

function displayedLifeTier(hero = {}) {
    const ownTier = lifeLevelRoman(hero.层级 ?? hero.位阶 ?? hero.等级 ?? 'Ⅰ');
    const form = hero.当前形态;
    if (!form || form.激活 !== true || !String(form.名称 || '').trim()) return ownTier;
    const formEntry = hero.形态库?.[form.名称];
    const formTier = lifeLevelRoman(formEntry?.层级 ?? formEntry?.位阶 ?? formEntry?.等级 ?? ownTier);
    return normalizeLifeLevel(formTier) > normalizeLifeLevel(ownTier) ? formTier : ownTier;
}

function finalAttributeNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : 0;
}

function finalAttributeText(value, suffix = '') {
    const numeric = finalAttributeNumber(value);
    return `${Number.isInteger(numeric) ? numeric : numeric.toFixed(2).replace(/\.00$/, '')}${suffix}`;
}

function finalAttributeQuality(value, lifeTier) {
    const [minimum, maximum] = TAVERN_LIFE_ATTRIBUTE_RANGES[lifeTier] || TAVERN_LIFE_ATTRIBUTE_RANGES['Ⅰ'];
    const numeric = finalAttributeNumber(value);
    if (numeric < minimum) return 'F';
    const effectiveMaximum = Number.isFinite(maximum) ? maximum : minimum * 10;
    if (numeric >= effectiveMaximum) return 'SSS';
    const bandWidth = Math.max(1, Math.floor((effectiveMaximum - minimum) / 9));
    return TAVERN_QUALITY_ORDER[Math.min(8, Math.floor((numeric - minimum) / bandWidth))];
}

function finalAttributePanel(attributes = {}, player = {}) {
    const lifeTier = displayedLifeTier(player);
    const used = new Set(['力量', '敏捷', '体质', '精神', '魅力', '力量修正', '敏捷修正', '体质修正', '精神修正', '魅力修正', 'DEF', 'MDEF', 'AP', '物理减伤率', '魔法减伤率', '先攻DC', '防御DC', '武器', 'ATK', 'MATK']);
    const rows = (items, { quality = false } = {}) => items.map(([key, label, suffix = '']) => {
        const value = finalAttributeText(attributes[key], suffix);
        const badge = quality ? `<span class="final-attribute-grade q-${finalAttributeQuality(attributes[key], lifeTier)}" title="当前生命层级下的属性段位">${finalAttributeQuality(attributes[key], lifeTier)}</span>` : '';
        return `<div class="final-attribute-row"><span class="k">${escapeHtml(label)}</span><span class="v">${escapeHtml(value)}${badge}</span></div>`;
    }).join('');
    const section = (title, icon, content, extraClass = '') => `<section class="final-attribute-section ${extraClass}"><h3>${icon} ${title}</h3><div class="final-attribute-grid">${content}</div></section>`;
    const basic = section('基础属性', '💪', rows([['力量', '力量'], ['敏捷', '敏捷'], ['体质', '体质'], ['精神', '精神'], ['魅力', '魅力']], { quality: true }), 'basic');
    const modifiers = section('修正值', '✨', rows([['力量修正', '力量修正'], ['敏捷修正', '敏捷修正'], ['体质修正', '体质修正'], ['精神修正', '精神修正'], ['魅力修正', '魅力修正']]));
    const derivedRows = rows([['DEF', 'DEF（物防）'], ['MDEF', 'MDEF（术防）'], ['物理减伤率', '物理减伤率', '%'], ['魔法减伤率', '魔法减伤率', '%'], ['AP', 'AP（法术增幅）', '%'], ['先攻DC', '先攻DC'], ['防御DC', '防御DC']]);
    const weapons = attributes.武器 && typeof attributes.武器 === 'object' && !Array.isArray(attributes.武器) ? attributes.武器 : {};
    const unarmed = weapons.无武装 && typeof weapons.无武装 === 'object' ? weapons.无武装 : { ATK: attributes.ATK, MATK: attributes.MATK };
    const weaponCard = (name, weapon, base = false) => `<div class="final-weapon ${base ? 'base' : ''}"><b>${base ? '无武装' : `⚔ ${escapeHtml(name)}`}</b><span class="atk">ATK（物攻）<strong>${escapeHtml(finalAttributeText(weapon?.ATK))}</strong></span><span class="matk">MATK（术攻）<strong>${escapeHtml(finalAttributeText(weapon?.MATK))}</strong></span></div>`;
    const weaponCards = [weaponCard('无武装', unarmed, true), ...Object.entries(weapons).filter(([name]) => name !== '无武装').map(([name, weapon]) => weaponCard(name, weapon))].join('');
    const extras = Object.entries(attributes).filter(([key]) => !used.has(key)).map(([key, value]) => `<div class="final-attribute-row"><span class="k">${escapeHtml(key)}</span><span class="v">${escapeHtml(inventoryDetailValue(value))}</span></div>`).join('');
    const derived = `<section class="final-attribute-section derived"><h3>⚡ 衍生属性</h3><div class="final-attribute-grid">${derivedRows}</div><div class="final-weapon-divider">⚔ 武器攻击</div><div class="final-weapon-list">${weaponCards}</div>${extras ? `<div class="final-attribute-extra"><h4>其他结算项</h4><div class="final-attribute-grid">${extras}</div></div>` : ''}</section>`;
    return `<div class="final-attribute-panel" data-life-tier="${lifeTier}"><header><small>READ ONLY · MVU CALCULATED</small><span>当前显示层级 ${lifeTier}</span></header>${basic}${modifiers}${derived}</div>`;
}
const store = new GameStore();
const blackbox = new GameplayBlackBox();
let runtime;
let generating = false;
let generationController = null;
let generationClock = null;
let generationAiProcessId = null;
const activeAiProcesses = new Map();
let aiProcessClock = null;
let activeMessageId = null;
let presets = [];
let scripts = [];
let profiles = [];
let userProfiles = [];
let regexPresets = [];
let openingData = null;
let selectedStarterIds = new Set();
let selectedStackCounts = {}; // id -> qty for stackable 道具 purchases
let customStarterItems = [];
let selectedPlotId = null;
let selectedPresetId = null;
let selectedScriptId = null;
let selectedRegexPresetId = 'card';
let selectedPromptEntryId = null;
let selectedRegexEntryId = null;
let selectedUserProfileId = null;
let worldbookEntries = [];
let selectedWorldbookId = null;
const scriptFrames = new Map();
let connectionModelCandidates = [];
let textEditorOriginal = '';
let textEditorSave = null;
let textEditorSearchAt = 0;
let textEditorMode = 'json';
let textEditorReadonly = false;
let setupShopCategory = 'all';
let setupShopRarity = 'all';
let personalShopCategory = 'all';
let personalShopRarity = 'all';
let personalShopSearch = '';
let personalShopExtraRequirement = '';
let personalShopRefreshBusy = false;
let personalShopRefreshAbort = null;
let personalShopRefreshStartedAt = 0;
let personalShopRefreshStatus = '';
let personalShopRefreshTimer = null;
let inventoryTab = 'tactical';
const storyFloorBySession = new Map();
let pendingFloorRegeneration = null;
let pendingFloorRegenerationTimer = null;
let combatState = null;
let combatEvents = [];
let combatShowCohorts = false;
let combatBusy = false;
let combatNarrationBusy = false;
let combatNarrationState = { battleId: null, phase: 'idle', detail: '' };
let combatRecognitionBusy = false;
let combatRecognitionState = { phase: 'idle', detail: '', elapsedMs: 0 };
let combatRecognitionStartedAt = 0;
let combatRecognitionClock = null;
let pendingCombatScriptReview = null;
let pendingBattleDeclaration = null;
let pendingCombatModel = null;
let combatModelingState = { phase: 'idle', detail: '' };
let combatMapIntent = null;
let combatMapZoom = 1;
// The map is a viewport, not a fixed-focus illustration.  Keep the pan in
// CSS-pixel space so it remains stable while the user zooms and drags on
// touch or desktop pointer devices.
let combatMapPan = { x: 0, y: 0 };
let combatMapSuppressClickUntil = 0;
let combatMapPointer = null;
let combatSelectedUnitId = null;
let combatForcedUnitIds = new Set();
let combatEntityInspectorUnitId = null;
let combatMapMenu = null;
let combatActionNotice = null;
let combatActionNoticeTimer = null;
let combatSimulatorPickerOpen = false;
let combatFlowPhase = null;
// Per model call: how many consecutive upstream timeouts / service errors to
// absorb with a backoff before the pipeline gives up (without consuming one
// of the five validation-repair slots).
const COMBAT_MODEL_SERVICE_RETRIES = 4;
const APP_REPO = 'gemini114514/battle-orb';
let appInfo = { version: '0.1.0', latest: null, checkedAt: null, checking: false, available: false, dismissed: false };
function compareVersions(a, b) {
    const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
        const x = pa[i] || 0, y = pb[i] || 0;
        if (x > y) return 1;
        if (x < y) return -1;
    }
    return 0;
}
async function checkForUpdate() {
    if (appInfo.checking) return appInfo;
    appInfo.checking = true;
    renderUpdateBanner();
    try {
        const [localRes, latestRes] = await Promise.all([
            fetch('/api/version').then(r => r.ok ? r.json() : null),
            fetch(`https://api.github.com/repos/${APP_REPO}/releases/latest`).then(r => r.ok ? r.json() : null),
        ]);
        const local = String(localRes?.version || appInfo.version);
        appInfo.version = local;
        const latestTag = String(latestRes?.tag_name || '').trim();
        const latestVersion = latestTag.replace(/^v/i, '');
        appInfo.latest = { tag: latestTag, version: latestVersion, name: latestRes?.name || '', body: latestRes?.body || '', url: latestRes?.html_url || '', publishedAt: latestRes?.published_at || '' };
        appInfo.available = Boolean(latestVersion && compareVersions(latestVersion, local) > 0);
        appInfo.checkedAt = Date.now();
    } catch { /* offline / unreachable: keep defaults */ }
    appInfo.checking = false;
    renderVersionBadge();
    renderUpdateBanner();
    return appInfo;
}
function renderVersionBadge() {
    const badge = $('#versionBadge');
    if (!badge) return;
    badge.textContent = `v${appInfo.version}`;
    badge.title = appInfo.available ? `发现新版本 ${appInfo.latest?.tag || ''} · 点击查看` : `当前版本 v${appInfo.version} · 点击检查更新`;
}
function renderUpdateBanner() {
    const banner = $('#updateBanner');
    if (!banner) return;
    const visible = Boolean(appInfo.available && !appInfo.dismissed);
    banner.classList.toggle('hidden', !visible);
    if (!visible) return;
    const latest = appInfo.latest || {};
    const body = String(latest.body || '').split('\n').map(line => escapeHtml(line)).join('<br>');
    banner.innerHTML = `<div class="update-banner-inner"><b>发现新版本 ${escapeHtml(latest.tag || latest.version || '')}</b><span>${body || escapeHtml(latest.name || '')}</span><div class="update-banner-actions"><button data-action="apply-update">立即更新</button><button data-action="dismiss-update">稍后提醒</button></div></div>`;
}
let combatUnitStrategySelections = {};
let combatDebugBattleId = null;
let combatDebugTrace = [];
let combatPromptTraceCache = null;
let selectedPromptLabMode = 'story';
let promptLabRendering = false;
const COMBAT_DEBUG_TRACE_LIMIT = 300;
const COMBAT_DEBUG_VALUE_LIMIT = 120000;
const COMBAT_DEBUG_EXPORT_VALUE_LIMIT = 5 * 1024 * 1024;
const COMBAT_BENCHMARK_ENABLED = new URLSearchParams(location.search).get('combatBenchmark') === '1';

const COMBAT_STRATEGY_PRESETS = Object.freeze({
    standard: { label: '标准推进', description: '优先最近目标，保持资源，必要时保护队友。', text: '标准推进：优先攻击最近的合法目标；队友濒危时协助保护；保留约20% EP，不主动友伤。' },
    focus: { label: '集中火力', description: '优先集火 Boss 或当前标记目标。', text: '集中火力：优先集火 Boss 或标记目标，其次攻击最脆弱目标；队友无需分散追击。' },
    guerrilla: { label: '游击分割', description: '潜行、诱导、拉扯，避免一次接触整群敌人。', text: '游击分割：先潜行或诱导分割敌群，逐个击破；每次攻击后尽量拉开距离，避免同时接触大量敌人。' },
    guard: { label: '护卫防守', description: '围绕主角或指定队友，优先阻断近身威胁。', text: '护卫防守：优先保护主角和濒危队友，攻击进入近战范围的敌人；不要为了追击远处目标离开护卫位置。' },
});

window.addEventListener('error', event => blackbox.record('error', 'window_error', { message: event.message, source: event.filename, line: event.lineno, column: event.colno, error: event.error }));
window.addEventListener('unhandledrejection', event => blackbox.record('error', 'unhandled_rejection', { reason: event.reason }));

marked.setOptions({ breaks: true, gfm: true });

function toast(message, type = 'info') {
    const item = document.createElement('div');
    item.className = `toast ${type}`;
    item.textContent = message;
    $('#toasts').append(item);
    setTimeout(() => item.remove(), 4200);
}

function formatTime(value) {
    return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function escapeHtml(value) {
    const node = document.createElement('div');
    node.textContent = String(value ?? '');
    return node.innerHTML;
}

function elapsedClock(milliseconds = 0) {
    const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderAiProcessBar() {
    const root = $('#aiProcessBar');
    if (!root) return;
    const entries = [...activeAiProcesses.values()];
    root.classList.toggle('hidden', entries.length === 0);
    root.setAttribute('aria-hidden', String(entries.length === 0));
    if (!entries.length) { root.innerHTML = ''; return; }
    root.innerHTML = `<span class="ai-process-bar-label">大模型进程</span><div class="ai-process-items">${entries.map(item => `<span class="ai-process-item">${item.onAbort ? `<button type="button" class="ai-process-cancel" data-ai-cancel="${escapeHtml(item.id)}" title="取消此任务" aria-label="取消此任务">✕</button>` : ''}<b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.detail || '等待响应')} · ${elapsedClock(performance.now() - item.startedAt)}</small></span>`).join('')}</div>`;
}

function beginAiProcess(label, detail = '等待响应', onAbort = null) {
    const id = crypto.randomUUID();
    activeAiProcesses.set(id, { id, label, detail, startedAt: performance.now(), onAbort: typeof onAbort === 'function' ? onAbort : null });
    if (!aiProcessClock) aiProcessClock = setInterval(renderAiProcessBar, 250);
    renderAiProcessBar();
    return id;
}

function isAbortError(error) {
    return Boolean(error && (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.signal?.aborted));
}

function cancelAiProcess(id) {
    if (!id) return false;
    const item = activeAiProcesses.get(id);
    if (!item) return false;
    try { if (typeof item.onAbort === 'function') item.onAbort(); } catch { /* ignore */ }
    endAiProcess(id);
    return true;
}

function updateAiProcess(id, detail) {
    const item = activeAiProcesses.get(id);
    if (!item) return;
    item.detail = detail;
    renderAiProcessBar();
}

function endAiProcess(id) {
    if (!id) return;
    activeAiProcesses.delete(id);
    if (!activeAiProcesses.size && aiProcessClock) {
        clearInterval(aiProcessClock);
        aiProcessClock = null;
    }
    renderAiProcessBar();
}

const PROMPT_LAB_MODES = {
    story: { label: '正文剧情生成', description: '当前楼层实际发送给剧情 AI 的完整 messages；动态内容来自当前预设、世界书、历史和 MVU。' },
    'combat-recognition': { label: '战斗 AI · 遭遇识别', description: '人工点击“AI 识别当前遭遇”时发送的 BattleDeclaration 草拟请求。' },
    'combat-model': { label: '战斗 AI · 数字化建模', description: '战斗 AI 将 BattleDeclaration 转为 CombatModel 时发送的请求骨架。' },
    'combat-strategy': { label: '战斗 AI · 策略编译', description: '半自动策略转换为本地确定性策略时发送的请求。' },
    'combat-narration': { label: '正文 AI · 战斗融合', description: '本地结果写回剧情前发送给正文 AI 的 BattleResultOutline。' },
    shop: { label: '商店 AI · forge_shop', description: '个人商店刷新使用的原卡 system/user prompt 预览，不触发模型请求。' },
    'assistant-script': { label: '助手脚本 AI', description: '酒馆助手通过 TavernHelper.generate 调用时使用的 system 覆盖。' },
    'connection-test': { label: '连接测试', description: 'API 连接测试发送的最小请求。' },
};

const PROMPT_MODULE_DEFINITIONS = {
    preset: { label: '预设模块', description: 'AIRP / OAI 预设条目，保留角色、顺序和示例消息语义。' },
    rules: { label: '规则模块', description: '角色卡、World Info、玩家设定与共享协议规则。' },
    work: { label: '工作提示词', description: '当前模式本次任务的具体工作说明与输出约束。' },
    dynamic: { label: '动态上下文', description: '当前楼层、MVU、战场状态和用户输入等运行时内容。' },
};

function promptModuleStates(mode) {
    const all = store.data.settings.promptModules;
    if (!all || typeof all !== 'object') store.data.settings.promptModules = {};
    const raw = store.data.settings.promptModules?.[mode] || {};
    const states = {};
    for (const id of Object.keys(PROMPT_MODULE_DEFINITIONS)) {
        const value = raw[id] && typeof raw[id] === 'object' ? raw[id] : {};
        states[id] = {
            enabled: value.enabled !== false,
            text: String(value.text || ''),
            role: ['system', 'user', 'assistant'].includes(value.role) ? value.role : id === 'dynamic' ? 'user' : 'system',
        };
    }
    return states;
}

function promptModuleText(mode, id, fallback = '') {
    const state = promptModuleStates(mode)[id];
    if (!state?.enabled) return '';
    return state.text.trim() || String(fallback || '');
}

function promptModuleEnabled(mode, id) {
    return promptModuleStates(mode)[id]?.enabled !== false;
}

function promptModuleOverrideApplied(mode) {
    return Object.values(promptModuleStates(mode)).some(state => state.enabled === false || Boolean(String(state.text || '').trim()));
}

function savePromptModuleStates(mode, states) {
    const all = store.data.settings.promptModules && typeof store.data.settings.promptModules === 'object'
        ? store.data.settings.promptModules
        : {};
    all[mode] = Object.fromEntries(Object.entries(PROMPT_MODULE_DEFINITIONS).map(([id, definition]) => {
        const value = states?.[id] || {};
        return [id, {
            enabled: value.enabled !== false,
            text: String(value.text || ''),
            role: ['system', 'user', 'assistant'].includes(value.role) ? value.role : id === 'dynamic' ? 'user' : 'system',
            label: definition.label,
        }];
    }));
    store.updateSettings({ promptModules: all });
}

function applyPromptModuleMessages(modules, mode) {
    const states = promptModuleStates(mode);
    const output = [];
    for (const module of modules || []) {
        const state = states[module.id] || { enabled: true, text: '' };
        if (state.enabled === false) continue;
        const fallback = Array.isArray(module.messages) ? module.messages : [];
        if (state.text.trim()) {
            output.push({ role: state.role || fallback[0]?.role || 'system', content: state.text.trim() });
        } else {
            output.push(...fallback.map(item => ({ role: item.role || 'system', content: String(item.content || '') })).filter(item => item.content.trim()));
        }
    }
    return applyPromptOverride(output, mode);
}

function promptModuleSnapshot(modules, mode) {
    const states = promptModuleStates(mode);
    return (modules || []).map(module => {
        const state = states[module.id] || { enabled: true, text: '' };
        const entries = (module.entries || module.messages || []).map((item, index) => ({
            id: item.id || `${module.id}-${index + 1}`,
            name: item.name || `${module.label || module.id} ${index + 1}`,
            role: item.role || 'system',
            content: String(item.content || ''),
            source: item.source || module.id,
        }));
        return {
            id: module.id,
            label: module.label || PROMPT_MODULE_DEFINITIONS[module.id]?.label || module.id,
            description: module.description || PROMPT_MODULE_DEFINITIONS[module.id]?.description || '',
            enabled: state.enabled !== false,
            override: state.text,
            role: state.role,
            entries,
        };
    });
}

function promptOverrides() {
    const settings = store.data.settings;
    settings.promptOverrides = settings.promptOverrides && typeof settings.promptOverrides === 'object' ? settings.promptOverrides : {};
    return settings.promptOverrides;
}

function promptOverride(mode) {
    const entry = promptOverrides()[mode];
    if (!entry) return { enabled: false, text: '' };
    if (typeof entry === 'string') return { enabled: Boolean(entry.trim()), text: entry };
    return { enabled: entry.enabled !== false && Boolean(String(entry.text || '').trim()), text: String(entry.text || '') };
}

function applyPromptOverride(messages, mode) {
    const override = promptOverride(mode);
    const output = structuredClone(messages || []);
    if (!override.enabled || !override.text.trim()) return output;
    const index = output.findIndex(item => item?.role === 'system');
    if (index >= 0) output[index] = { ...output[index], content: override.text };
    else output.unshift({ role: 'system', content: override.text });
    return output;
}

function promptModeForCombatPurpose(purpose = '') {
    if (purpose === 'battle_declaration_draft') return 'combat-recognition';
    if (purpose === 'strategy_compile') return 'combat-strategy';
    if (String(purpose).startsWith('battle_model')) return 'combat-model';
    return 'combat-model';
}

// V3.2.6 contains display-only regex replacements whose replacement strings
// are complete HTML documents wrapped in a Markdown code fence. SillyTavern
// executes those documents inside its message renderer; rendering the same
// replacement through marked would expose the literal `<!DOCTYPE html>`.
// Preserve the source semantic blocks until the native renderer below can
// turn them into safe, collapsible components. Other regex scripts continue
// to run in their original order.
function protectNativeDisplayBlocks(source) {
    const blocks = [];
    const token = index => `\uE000REINCARNATION_DISPLAY_${index}\uE001`;
    const protectedSource = String(source ?? '').replace(/<(UpdateVariable|CheckResult|options|mission)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, block => {
        const index = blocks.push(block) - 1;
        return token(index);
    });
    return {
        source: protectedSource,
        restore(value) {
            return String(value ?? '').replace(/\uE000REINCARNATION_DISPLAY_(\d+)\uE001/g, (_all, index) => blocks[Number(index)] ?? '');
        },
    };
}

function stripReasoningBlocksForDisplay(source) {
    let output = String(source ?? '');
    // Providers and Tavern presets use several equivalent private channels.
    // They are response metadata, never story prose. Remove complete blocks
    // (including multiline/nested markup) before Markdown turns their contents
    // into visible chat text. An unterminated opening tag is treated as a
    // streaming tail and removed through the end of the current message.
    for (const tag of ['dm_think', 'think', 'thinking', 'analysis', 'reasoning', 'cot', 'chain_of_thought', 'konatan_planning~']) {
        const escaped = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const block = new RegExp(`<${escaped}(?:\\s[^>]*)?>[\\s\\S]*?(?:<\\/${escaped}\\s*>|$)`, 'gi');
        output = output.replace(block, '');
    }
    // Some providers use a bare metacognition header rather than XML tags.
    output = output.replace(/(?:^|\n)\s*\[metacognition\][\s\S]*?(?=\n\s*(?:```|<content\b|$))/gi, '\n');
    return output;
}

function renderRich(container, source, messageId, role = 'assistant') {
    container.replaceChildren();
    if (source.trim() === '【封面】') {
        container.innerHTML = `<div class="native-cover"><span class="cover-tag">REINCARNATION PROTOCOL · 3.2.6</span><h2>轮回战场</h2><p>一套以 D100 判定、数值化战斗和动态因果为核心的无限世界生存协议。</p><div class="cover-features"><div><b>D100 物理演算</b><small>属性、装甲与血量双轨裁定</small></div><div><b>因果演进</b><small>你的选择持续改变世界稳定度</small></div><div><b>升维与降解</b><small>跨世界战利品与生命层级体系</small></div><div><b>动态生态</b><small>NPC 拥有立场、记忆与利益诉求</small></div></div><label><input type="checkbox" data-cover-agree> 我已了解规则，准备建立轮回者档案</label><button disabled data-action="enter-game">接入主神终端</button></div>`;
        return;
    }
    if (source.trim() === '【开局】') {
        container.innerHTML = `<div class="setup-launcher"><div class="setup-icon">+</div><div><h3>建立轮回者档案</h3><p>录入身份、血统潜质、背景和初始投放方式，然后开始第一场轮回。</p></div><button data-action="open-setup">开始建档</button></div>`;
        return;
    }
    // Run the card/preset display regexes against the original response. The
    // replacement strings in Tavern are often complete HTML documents (with
    // their own CSS and inline scripts), so protecting semantic tags here
    // would bypass the card and leave raw XML visible.
    let content = runtime?.applyDisplayRegex(String(source), role) ?? String(source);
    // The card hides <dm_think>; compatible providers sometimes use the same
    // explicit channel under another name. This is display-only and never
    // changes the saved response or the next-turn prompt.
    content = content.replace(/<BattleDeclaration\b[^>]*>[\s\S]*?<\/BattleDeclaration\s*>/gi, '');
    content = stripReasoningBlocksForDisplay(content);
    appendRenderedContent(container, content);
}

function htmlDocumentPattern() {
    return /```\s*(?:text|html|xml)?\s*(<!doctype\s+html[\s\S]*?<\/html\s*>)\s*```/gi;
}

function appendHtmlFrame(container, html, { fragment = false } = {}) {
    const frame = document.createElement('iframe');
    frame.className = 'tavern-html-frame';
    frame.title = '酒馆卡片 HTML 内容';
    frame.setAttribute('aria-label', '酒馆卡片 HTML 内容');
    frame.setAttribute('allowtransparency', 'true');
    frame.loading = 'eager';
    frame.referrerPolicy = 'no-referrer';
    // Chromium paints an iframe viewport white even when its document canvas
    // is transparent. Use the app's dark canvas as the actual viewport color
    // so cards never punch a white rectangle through the story floor.
    frame.style.backgroundColor = '#11150f';
    const bridge = `<script>
      (() => {
        const parentWindow = window.parent;
        window.getChatMessages = (...args) => parentWindow.getChatMessages?.(...args) || [];
        window.getCurrentMessageId = () => parentWindow.SillyTavern?.getCurrentMessageId?.() ?? '';
        window.triggerSlash = command => parentWindow.triggerSlash?.(command);
        window.TavernHelper = parentWindow.TavernHelper;
        window.Mvu = parentWindow.Mvu;
        window._ = parentWindow._;
        window.toastr = parentWindow.toastr;
      })();
    </script>`;
    // The card owns its markup and visual language, but its document must live
    // on the host page's scroll surface.  This style is appended after the
    // card styles so a white iframe canvas or a fixed inner overflow region
    // cannot create a second scrollbar or a bright rectangle in dark mode.
    const hostStyle = `<style data-reincarnation-host>
      :root, html, body { min-height: 0 !important; height: auto !important; overflow: visible !important; background: #11150f !important; background-color: #11150f !important; }
      body { color: var(--text-color, var(--theme-text, #e6ecf3)) !important; }
      /* Tavern world-selection cards intentionally cap this list at 65/70vh.
         That is correct as a standalone page but creates a second scrollbar
         when embedded in a story floor. Let the outer story view own scrolling. */
      .options-container, .world-options, .world-list, .world-grid, .wizard-layout, .terminal-container {
        max-height: none !important;
        height: auto !important;
        overflow: visible !important;
      }
    </style>`;
    let source = fragment
        ? `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent;color:inherit;overflow:visible}body{font-family:inherit}</style>${bridge}${hostStyle}</head><body>${html}</body></html>`
        : html;
    // Keep Tavern card resources, but defer remote stylesheets. A blocked
    // font/CDN must not hold the iframe parser before the card's inline
    // scripts run. `media=print` makes the request non-blocking and the
    // onload callback switches it back to the intended media when available.
    const deferredImports = [];
    source = source.replace(/@import\s+(?:url\(\s*(["']?)([^)'"\s]+)\1\s*\)|(["'])([^"']+)\3)[^;]*;?/gi, (_all, _quoteA, urlA, _quoteB, urlB) => {
        const url = String(urlA || urlB || '').trim();
        if (url) deferredImports.push(url);
        return '';
    });
    source = source.replace(/<link\b[^>]*\brel\s*=\s*(["'])stylesheet\1[^>]*>/gi, tag => {
        const withoutMedia = tag.replace(/\smedia\s*=\s*(["'])[^"']*\1/gi, '');
        return withoutMedia.replace(/>\s*$/, ' media="print" data-tavern-deferred-style onload="this.media=\'all\'">');
    });
    if (deferredImports.length) {
        const links = deferredImports.map(url => {
            const href = url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
            return `<link rel="stylesheet" href="${href}" media="print" data-tavern-deferred-style onload="this.media='all'">`;
        }).join('');
        source = /<head\b[^>]*>/i.test(source)
            ? source.replace(/<head\b[^>]*>/i, match => `${match}${links}`)
            : `${links}${source}`;
    }
    // Inject TavernHelper-compatible globals before card scripts execute.
    if (!fragment) {
        source = /<head\b[^>]*>/i.test(source)
            ? source.replace(/<\/head\s*>/i, `${hostStyle}</head>`).replace(/<head\b[^>]*>/i, match => `${match}${bridge}`)
            : `${bridge}${hostStyle}${source}`;
    }
    let resizeTimer = 0;
    let observedDocument = null;
    const resize = () => {
        resizeTimer = 0;
        try {
            const doc = frame.contentDocument;
            if (!doc) return;
            // A blocked remote stylesheet can keep srcdoc in `loading`; the
            // parsed DOM is still usable, so fire the lifecycle hook cards
            // normally rely on before measuring it.
            if (doc.readyState === 'loading') doc.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
            const root = doc.documentElement;
            const body = doc.body;
            // Inline important styles win even if a card injects a late body
            // stylesheet after the initial srcdoc parse.
            root?.style?.setProperty('background', '#11150f', 'important');
            root?.style?.setProperty('background-color', '#11150f', 'important');
            root?.style?.setProperty('overflow', 'visible', 'important');
            body?.style?.setProperty('background', '#11150f', 'important');
            body?.style?.setProperty('background-color', '#11150f', 'important');
            body?.style?.setProperty('overflow', 'visible', 'important');
            const bodyRect = body?.getBoundingClientRect?.();
            // Do not use documentElement.scrollHeight as the primary source:
            // Chromium reports the iframe's current viewport height there,
            // which makes a frame that was expanded once impossible to shrink.
            // Body content height remains independent of the old iframe size.
            const bodyChildrenBottom = body
                ? [...body.children].reduce((max, node) => Math.max(max, node.getBoundingClientRect().bottom - (bodyRect?.top || 0)), 0)
                : 0;
            const height = Math.max(
                36,
                Math.ceil(Math.max(
                    body?.scrollHeight || 0,
                    bodyRect?.height || 0,
                    bodyChildrenBottom,
                    root?.scrollHeight && !body ? root.scrollHeight : 0,
                )),
            );
            frame.style.height = `${height}px`;
        } catch { frame.style.height = '240px'; }
    };
    const queueResize = () => {
        if (!resizeTimer) resizeTimer = window.setTimeout(resize, 0);
    };
    const observeDocument = () => {
        try {
            const doc = frame.contentDocument;
            if (!doc || observedDocument === doc || !doc.body) return;
            observedDocument = doc;
            const ViewportResizeObserver = frame.contentWindow?.ResizeObserver || window.ResizeObserver;
            if (ViewportResizeObserver) {
                const observer = new ViewportResizeObserver(queueResize);
                if (doc.documentElement) observer.observe(doc.documentElement);
                observer.observe(doc.body);
                frame.__reincarnationResizeObserver = observer;
            }
            const MutationObserverImpl = frame.contentWindow?.MutationObserver || window.MutationObserver;
            if (MutationObserverImpl) {
                const observer = new MutationObserverImpl(queueResize);
                observer.observe(doc.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'open', 'hidden'] });
                frame.__reincarnationMutationObserver = observer;
            }
            // `toggle` is not a bubbling event, so capture it on the document;
            // click is a fallback for custom cards that implement collapse by
            // changing classes/styles instead of using <details>.
            const settleResize = () => {
                queueResize();
                [60, 180, 400, 800].forEach(delay => setTimeout(resize, delay));
            };
            doc.addEventListener('toggle', settleResize, true);
            doc.addEventListener('click', settleResize, true);
            queueResize();
        } catch { /* iframe may not have a document yet */ }
    };
    frame.addEventListener('load', () => {
        observeDocument();
        resize();
        [60, 180, 500, 1200].forEach(delay => setTimeout(() => { observeDocument(); resize(); }, delay));
    });
    container.append(frame);
    frame.srcdoc = source;
    // `load` is not guaranteed for srcdoc documents with blocked remote
    // assets; keep probing briefly, then let ResizeObserver/MutationObserver
    // handle all later expand/collapse and script-driven content changes.
    const pollResize = () => {
        try {
            const doc = frame.contentDocument;
            if (doc?.readyState === 'loading') doc.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true }));
            observeDocument();
            resize();
        } catch { /* iframe may not have a document yet */ }
    };
    [40, 120, 300, 700, 1400, 2400].forEach(delay => setTimeout(pollResize, delay));
}

function appendRenderedContent(container, source) {
    let cursor = 0;
    let match;
    const documents = htmlDocumentPattern();
    while ((match = documents.exec(String(source))) !== null) {
        appendMarkdownOrHtmlFragment(container, String(source).slice(cursor, match.index));
        appendHtmlFrame(container, match[1]);
        cursor = match.index + match[0].length;
    }
    appendMarkdownOrHtmlFragment(container, String(source).slice(cursor));
}

function appendMarkdownOrHtmlFragment(container, source) {
    const value = String(source ?? '');
    if (!value.trim()) return;
    // Izumi and other Tavern presets also use standalone snippets containing
    // <style>/<script>. Mount those in the same document-backed frame so CSS
    // and event handlers work instead of being stripped by Markdown sanitize.
    if (/<(?:style|script)\b/i.test(value) && /<[^>]+>/i.test(value)) {
        appendHtmlFrame(container, value, { fragment: true });
        return;
    }
    appendMarkdown(container, value);
}

function parseWorldCandidates(source) {
    const blocks = String(source).split(/(?=\d*[.、]?\s*【[^】]+】)/).map(item => item.trim()).filter(Boolean);
    return blocks.map((block, index) => {
        const title = block.match(/【([^】]+)】/)?.[1] ?? `候选世界 ${index + 1}`;
        return { title, description: block.replace(/^\d*[.、]?\s*【[^】]+】/, '').trim().slice(0, 500) };
    });
}

function appendMarkdown(container, source) {
    if (!source.trim()) return;
    const part = document.createElement('div');
    part.innerHTML = DOMPurify.sanitize(marked.parse(source), { ADD_TAGS: ['details', 'summary'], ADD_ATTR: ['open'] });
    while (part.firstChild) container.append(part.firstChild);
}

function collectStoryFloors(messages) {
    const floors = [];
    let actions = [];
    for (const message of messages.filter(item => !item.isHidden)) {
        if (message.role === 'user') { actions.push(message); continue; }
        floors.push({ id: message.id, narrative: message, actions });
        actions = [];
    }
    if (actions.length) floors.push({ id: actions.at(-1).id, narrative: null, actions });
    return floors;
}

function currentStoryFloor() {
    const session = store.activeSession;
    if (!session) return null;
    const floors = collectStoryFloors(session.messages);
    const index = Math.max(0, Math.min(floors.length - 1, storyFloorBySession.get(session.id) ?? floors.length - 1));
    return floors[index] || null;
}

// The read-only Prompt views need the actual prompt that was sent.  A floor
// without its own narrative (a trailing user action) or with a non-generated
// narrative (combat narration, imported/migrated messages) has no stored trace,
// so fall back to the most recent floor that carries one instead of leaving the
// buttons permanently disabled.
function currentFloorPromptTrace() {
    const session = store.activeSession;
    if (!session) return null;
    const floors = collectStoryFloors(session.messages);
    const index = Math.max(0, Math.min(floors.length - 1, storyFloorBySession.get(session.id) ?? floors.length - 1));
    for (let i = index; i >= 0; i -= 1) {
        const trace = floors[i]?.narrative?.promptTrace;
        if (trace) return trace;
    }
    return null;
}

function renderMessages({ followLatest = false } = {}) {
    const list = $('#messages');
    list.replaceChildren();
    const session = store.activeSession;
    if (!session) return;
    const floors = collectStoryFloors(session.messages);
    const previous = storyFloorBySession.get(session.id);
    let floorIndex = followLatest || previous === undefined ? floors.length - 1 : previous;
    floorIndex = Math.max(0, Math.min(floors.length - 1, floorIndex));
    storyFloorBySession.set(session.id, floorIndex);
    const floor = floors[floorIndex];
    if (floor) {
        const message = floor.narrative || floor.actions.at(-1);
        const node = document.createElement('article');
        node.className = `story-floor-card message ${message.role}`;
        node.dataset.id = message.id;
        const actionText = floor.actions.map(item => item.content).join('\n\n');
        // Story floors are zero-based: the initial “建档” opening is floor 0,
        // and the first generated continuation is floor 1. Keep the total
        // count as a count (not a max index) so the existing “n / total” HUD
        // remains easy to read.
        node.innerHTML = `<header class="story-floor-heading"><div><small>STORY FLOOR</small><b>第 ${floorIndex} 楼</b></div><span>${formatTime(message.createdAt)}</span></header>${actionText ? `<section class="floor-action"><small>${escapeHtml(store.data.settings.userName || '轮回者')}的行动</small><p>${escapeHtml(actionText)}</p></section>` : ''}<div class="message-body story-narrative"></div>`;
        list.append(node);
        renderRich($('.message-body', node), message.content, message.id, message.role);
        activeMessageId = message.id;
    } else list.innerHTML = '<div class="empty-state">尚无剧情楼层</div>';
    const previousButton = $('[data-action="floor-prev"]');
    const nextButton = $('[data-action="floor-next"]');
    previousButton.disabled = floorIndex <= 0;
    nextButton.disabled = floorIndex >= floors.length - 1;
    const usage = floor?.narrative?.tokenUsage;
    $('#floorTokenUsage').textContent = usage?.exact ? `Token ${Number(usage.totalTokens || 0).toLocaleString()}` : usage ? 'Token API 未返回' : 'Token —';
    $('#floorTokenUsage').disabled = !usage;
    $('#floorPromptButton').disabled = !currentFloorPromptTrace();
    $('#floorFullPromptButton').disabled = !currentFloorPromptTrace();
    $('[data-action="edit-floor"]').disabled = !floor;
    const regenButton = $('[data-action="regen-floor"]');
    regenButton.disabled = !floor?.narrative;
    const regenArmed = Boolean(floor?.narrative && pendingFloorRegeneration && pendingFloorRegeneration.messageId === floor.narrative.id && pendingFloorRegeneration.expiresAt > Date.now());
    regenButton.textContent = regenArmed ? '再次点击确认' : '重新演算';
    regenButton.title = regenArmed ? '再次点击将建立同层并行分支并发送一次新请求' : '需在首次点击后的 3 秒内再次点击确认；原楼层会保留为分支';
    const branchButton = $('#floorBranchButton');
    const branches = storyBranchesForFloor(floor?.narrative);
    const activeBranchId = store.activeStoryBranch()?.id;
    const branchIndex = Math.max(0, branches.findIndex(branch => branch.id === activeBranchId));
    branchButton.textContent = `分支 ${branches.length ? branchIndex + 1 : 1}/${Math.max(1, branches.length)}`;
    branchButton.disabled = branches.length < 2;
    const branchPrevButton = $('[data-action="floor-branch-prev"]');
    const branchNextButton = $('[data-action="floor-branch-next"]');
    if (branchPrevButton) branchPrevButton.disabled = branches.length < 2;
    if (branchNextButton) branchNextButton.disabled = branches.length < 2;
    $('[data-action="delete-floor"]').disabled = !floor;
    $('#tokenBadge').textContent = floors.length ? `${floorIndex} / ${floors.length} 楼` : '0 楼';
    $('#sessionTitle').textContent = session.title;
    list.scrollTop = 0;
}

function renderQuickActions() {
    const root = $('#quickActions');
    if (!root) return;
    const stat = runtime?.variables?.stat_data ?? {};
    const world = stat['世界'] ?? {};
    const system = stat['系统状态'] ?? {};
    const settings = stat['设置'] ?? {};
    const tasks = Object.entries(stat['任务']?.['列表'] ?? {});
    const settlementTasks = tasks.filter(([, task]) => /^(可结算|失败)$/.test(String(task?.['状态'] ?? '')));
    const isSingleWorld = settings['单一世界'] === true;
    const inGodSpace = system['是否在主神空间'] === true;
    const trialReady = system['是否可试炼'] === true || system['可试炼'] === true;
    const trialDone = system['试炼已完成'] === true;
    const visibleTaskNames = settlementTasks.slice(0, 2).map(([name]) => name).join('、');
    const cards = [
        {
            icon: '◉', label: '选择世界', prompt: '【选择世界】',
            state: isSingleWorld ? 'locked' : inGodSpace ? 'ready' : 'risk',
            hint: isSingleWorld ? '单一世界模式；仍可自由尝试' : inGodSpace ? '主神空间／休整期，候选世界协议可用' : `当前位于${world['名称'] || '任务世界'}；协议会按原卡前置条件裁定`,
            tag: isSingleWorld ? '世界锁定' : inGodSpace ? '可选世界' : '世界中',
        },
        {
            icon: '◆', label: '结算任务', prompt: '【结算任务】',
            state: settlementTasks.length ? 'ready' : 'neutral',
            hint: settlementTasks.length ? `可清算：${visibleTaskNames}` : tasks.length ? `当前 ${tasks.length} 项任务，尚无“可结算／失败”状态` : '暂无主神任务；仍可提交指令让原卡规则裁定',
            tag: settlementTasks.length ? `${settlementTasks.length} 项待结算` : '等待条件',
        },
        {
            icon: '↑', label: '申请晋升', prompt: '【申请晋升】',
            state: trialDone ? 'locked' : trialReady ? 'ready' : 'neutral',
            hint: trialDone ? '本阶段试炼已完成；仍可自由提交申请' : trialReady ? 'MVU 标记为可试炼' : '可随时提交；是否开启由原卡试炼协议裁定',
            tag: trialDone ? '已完成' : trialReady ? '可试炼' : '待判定',
        },
        {
            icon: '◎', label: '检视状态', prompt: '我检查当前状态、装备、任务和可用资源。',
            state: 'neutral', hint: '普通叙事指令；不会替代 MVU 或任务结算。', tag: '自由输入',
        },
        {
            icon: '⌕', label: '观察环境', prompt: '我谨慎地观察周围环境、人物动向与可交互线索。',
            state: 'neutral', hint: '普通叙事指令；结果仍由世界状态与判定决定。', tag: '自由输入',
        },
        {
            icon: '⚔', label: 'AI识别当前遭遇', action: 'combat-draft-ai',
            state: combatRecognitionBusy ? 'locked' : 'neutral',
            hint: combatRecognitionBusy ? '战斗 AI 正在读取当前剧情与 MVU；请等待本次识别完成。' : '直接调用战斗 AI 草拟 BattleDeclaration，并进入本地校验流程。',
            tag: combatRecognitionBusy ? `识别中 ${combatElapsedClock(performance.now() - combatRecognitionStartedAt)}` : '战斗终端',
        },
    ];
    const taskState = settlementTasks.length ? `待结算 ${settlementTasks.length}` : tasks.length ? `进行中 ${tasks.length}` : '暂无任务';
    root.innerHTML = `<header class="quick-action-header"><div><small>ORIGINAL CARD PROTOCOLS</small><b>${escapeHtml(world['名称'] || (inGodSpace ? '主神空间' : '未锚定世界'))}</b></div><span>MVU 实时读取 · 指令填入输入框或直接调用战斗终端</span></header><div class="quick-action-status"><span class="${inGodSpace ? 'space' : 'world'}">${inGodSpace ? '主神空间／休整期' : '任务世界中'}</span><span class="${settlementTasks.length ? 'ready' : ''}">任务：${escapeHtml(taskState)}</span><span>${trialReady ? '试炼：可申请' : trialDone ? '试炼：已完成' : '试炼：待判定'}</span></div><div class="quick-action-grid">${cards.map(card => `<button type="button" class="quick-action-card ${card.state}" ${card.action ? `data-action="${escapeHtml(card.action)}"` : `data-prompt="${escapeHtml(card.prompt)}"`} ${card.state === 'locked' ? 'disabled' : ''} title="${escapeHtml(card.hint)}"><i>${card.icon}</i><span><b>${escapeHtml(card.label)}</b><small>${escapeHtml(card.hint)}</small></span><em>${escapeHtml(card.tag)}</em></button>`).join('')}</div>`;
}

function storyBranchesForFloor(message) {
    const key = message?.branchKey;
    if (!key) return [];
    return store.storyBranches().filter(branch => branch.messages.some(item => item.branchKey === key));
}

function refreshRegexDisplay(reason = 'manual') {
    // Messages retain their raw model output.  This is a display-only rerender,
    // so importing/editing a Tavern regex can be safely applied to every
    // existing floor without destructively rewriting the save.
    runtime?.setRegexPresets(regexPresets);
    renderMessages();
    void blackbox.record('editor', 'regex_display_refreshed', { reason, presets: regexPresets.length, floor: storyFloorBySession.get(store.activeSession?.id) ?? null });
}

async function requestFloorRegeneration(message) {
    if (!message || generating) return;
    const storyConnection = aiConnection('story');
    if (!storyConnection.baseUrl || !storyConnection.model) {
        showPanel('settings');
        toast('请先在“模型配置”中设置可用的剧情 AI 连接。', 'error');
        return;
    }
    const now = Date.now();
    if (pendingFloorRegeneration?.messageId !== message.id || pendingFloorRegeneration.expiresAt <= now) {
        pendingFloorRegeneration = { messageId: message.id, expiresAt: now + 3000 };
        clearTimeout(pendingFloorRegenerationTimer);
        pendingFloorRegenerationTimer = setTimeout(() => {
            pendingFloorRegeneration = null;
            renderMessages();
        }, 3050);
        renderMessages();
        toast('再次点击“重新演算”确认。原楼层将保留为可切换分支。', 'info');
        return;
    }
    clearTimeout(pendingFloorRegenerationTimer);
    pendingFloorRegeneration = null;
    let branch;
    try { branch = store.forkStoryBranch(message.id); }
    catch (error) {
        await blackbox.record('story', 'branch_creation_failed', { messageId: message.id, error, storageCompacted: store.storageCompacted, storageAvailable: store.storageAvailable }, { sessionId: store.activeSession?.id });
        renderAll();
        toast(`无法建立重演分支：${error.message || error}`, 'error');
        return;
    }
    if (!branch) return toast('无法建立剧情分支', 'error');
    storyFloorBySession.delete(store.activeSession.id);
    await blackbox.record('story', 'branch_created_for_regeneration', { branchId: branch.id, parentBranchId: branch.parentBranchId, forkKey: branch.forkKey, forkMessageId: message.id, storageCompacted: store.storageCompacted }, { sessionId: store.activeSession.id });
    renderAll();
    try { await generate({ addUser: false, branchKey: branch.forkKey }); }
    catch (error) {
        await blackbox.record('story', 'branch_regeneration_failed', { branchId: branch.id, forkKey: branch.forkKey, error }, { sessionId: store.activeSession?.id });
        toast(`重新演算失败：${error.message || error}`, 'error');
    }
}

async function switchFloorBranch(direction = 1) {
    const floor = currentStoryFloor();
    const branches = storyBranchesForFloor(floor?.narrative);
    if (branches.length < 2) return;
    const activeId = store.activeStoryBranch()?.id;
    const index = Math.max(0, branches.findIndex(branch => branch.id === activeId));
    const offset = direction < 0 ? -1 : 1;
    const next = branches[(index + offset + branches.length) % branches.length];
    if (!store.selectStoryBranch(next.id)) return toast('切换剧情分支失败', 'error');
    storyFloorBySession.set(store.activeSession.id, Math.max(0, storyFloorBySession.get(store.activeSession.id) ?? 0));
    renderAll();
    await blackbox.record('story', 'branch_switched', { branchId: next.id, forkKey: next.forkKey, branchCount: branches.length }, { sessionId: store.activeSession.id });
    toast(`已切换至 ${next.label}`, 'success');
}

function readSseText(buffer, onChunk, onEvent = () => {}) {
    const events = buffer.split('\n\n');
    const rest = events.pop() ?? '';
    for (const event of events) {
        for (const line of event.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const data = line.slice(5).trim();
            if (!data || data === '[DONE]') continue;
            try {
                const json = JSON.parse(data);
                if (json.error) {
                    onEvent(json);
                    throw new Error(json.error.message || json.error.type || '上游返回错误');
                }
                const delta = json.choices?.[0]?.delta?.content ?? json.choices?.[0]?.text ?? '';
                if (delta) onChunk(delta);
                onEvent(json);
            } catch (error) {
                // JSON parsing errors can be caused by a partial SSE frame;
                // provider error objects are deliberately re-thrown so the
                // caller can show the real upstream reason instead of an empty
                // assistant message.
                if (error?.message && !/Unexpected token|JSON parse|JSON parsing/i.test(error.message)) throw error;
            }
        }
    }
    return rest;
}

function normalizeTokenUsage(usage, promptMessages, output) {
    const raw = usage?.usageMetadata ?? usage ?? null;
    const input = Number(raw?.prompt_tokens ?? raw?.input_tokens ?? raw?.promptTokenCount ?? raw?.inputTokens);
    const completion = Number(raw?.completion_tokens ?? raw?.output_tokens ?? raw?.candidatesTokenCount ?? raw?.outputTokens);
    const total = Number(raw?.total_tokens ?? raw?.totalTokenCount ?? raw?.totalTokens);
    const hasInput = Number.isFinite(input), hasOutput = Number.isFinite(completion), hasTotal = Number.isFinite(total);
    // Match Tavern's accounting boundary: provider usage is authoritative.
    // When an endpoint omits usage we expose that fact instead of presenting a
    // character-count approximation as a token total.
    return {
        inputTokens: hasInput ? input : null,
        outputTokens: hasOutput ? completion : null,
        totalTokens: hasTotal ? total : (hasInput || hasOutput ? (hasInput ? input : 0) + (hasOutput ? completion : 0) : null),
        exact: hasInput || hasOutput || hasTotal,
        source: hasInput || hasOutput || hasTotal ? 'provider_usage' : 'provider_usage_unavailable',
        requestMessages: Array.isArray(promptMessages) ? promptMessages.length : 0,
        outputCharacters: String(output ?? '').length,
        raw,
    };
}

async function generate({ addUser = true, text = '', branchKey = null } = {}) {
    if (generating) return;
    const settings = aiConnection('story');
    if (!settings.baseUrl || !settings.model) {
        showPanel('settings');
        toast('请先填写 API 地址和模型名称', 'error');
        return;
    }
    if (addUser) {
        const value = text.trim();
        if (!value) return;
        store.addMessage('user', value);
    }
    const session = store.activeSession;
    const promptModules = promptModuleStates('story');
    const prompt = runtime.buildPrompt(session.messages, { promptModules });
    // Keep the battle declaration instruction in the existing system anchor.
    // Appending a fresh system message after the current user turn produces a
    // trailing system/model turn that Gemini rejects (and differs from
    // Tavern's role ordering).  Inserting it into the anchor preserves the
    // instruction without changing the chat-turn boundary.
    const battleInstruction = promptModuleText('story', 'work', `${battleDeclarationInstruction()}\n\n${localCombatAuthorityInstruction()}`);
    const systemAnchor = prompt.messages.find(message => message.role === 'system');
    if (promptModuleEnabled('story', 'work') && battleInstruction) {
        if (systemAnchor) systemAnchor.content = `${systemAnchor.content}\n\n${battleInstruction}`;
        else prompt.messages.unshift({ role: 'system', content: battleInstruction });
    }
    // World Info and AIRP presets can leave a variable-only context block as
    // the final user turn.  That block is intentionally allowed to request a
    // bare <UpdateVariable>, but it must not replace the player's current
    // action as the provider's conversational boundary.  Keep the submitted
    // user action last whenever this is a normal generation turn.  This is
    // also what lets the opening scene receive prose instead of only MVU.
    const submittedUserText = addUser ? String(text || '').trim() : '';
    const currentUser = [...session.messages].reverse().find(message => message.role === 'user')?.content?.trim() || '';
    const hasVariableOnlyFormat = prompt.messages.some(message => /<Format>[\s\S]*(?:ONLY permitted to output|只能输出|仅允许输出)[\s\S]*<UpdateVariable>/i.test(String(message.content || '')));
    const narrativeBoundary = hasVariableOnlyFormat
        ? '\n\n[剧情输出边界]\n输出顺序固定且两部分都不可省略：先写与本轮行动对应的完整、连贯、沉浸式正文；正文之后必须追加一个合法 <UpdateVariable><JSONPatch>...</JSONPatch></UpdateVariable> 块，没有变量变化时也输出空数组 []。绝不能只返回变量块。'
        : '';
    if (submittedUserText) {
        const finalPromptMessage = prompt.messages.at(-1);
        const finalPromptText = String(finalPromptMessage?.content || '').trim();
        const finalUserTurn = `${submittedUserText}${narrativeBoundary}`;
        if (finalPromptMessage?.role !== 'user' || finalPromptText !== finalUserTurn) prompt.messages.push({ role: 'user', content: finalUserTurn });
    }
    const lastNonSystem = [...prompt.messages].reverse().find(message => message.role !== 'system');
    // A reroll is an explicit continuation even when the fork happens to end
    // on the preceding user action.  Tavern still appends its continuation
    // nudge in that case; otherwise the request ends at a stale user turn and
    // some providers answer with only the mandatory MVU patch.
    const explicitContinuation = Boolean(branchKey);
    if (explicitContinuation || !lastNonSystem || lastNonSystem.role === 'assistant') {
        const continuePrompt = runtime.activePreset?.raw?.continue_nudge_prompt
            ? runtime.macros(runtime.activePreset.raw.continue_nudge_prompt)
            : '[Continue the story]';
        // `addUser:false` is also used by a few legacy callers while opening
        // a fresh session.  A fresh opening is not a continuation request:
        // only an explicit branch regeneration may use continue_nudge_prompt.
        // On branch regeneration the current user action already exists in
        // the branch history, but presets which inline {{lastUserMessage}}
        // remove it from the visible chat boundary.  The old implementation
        // then appended only the continuation nudge, leaving a variable-only
        // <Format> as the effective instruction and producing MVU with no
        // narrative.  Preserve the real action and its prose/MVU boundary in
        // the same final user turn as the nudge.
        const fallbackUser = addUser && currentUser
            ? `${currentUser}${narrativeBoundary}`
            : explicitContinuation && currentUser
                ? `${currentUser}${narrativeBoundary}\n\n${continuePrompt}`
                : explicitContinuation
                    ? continuePrompt
                    : '[Start a new chat]';
        // If a preset inlines {{lastUserMessage}}, the user turn is removed
        // from visible history.  Re-add a compact user boundary so OpenAI /
        // Gemini-compatible endpoints never receive a model turn as the final
        // content item.  New input is retained; regeneration gets Tavern's
        // continue-nudge wording.
        prompt.messages.push({ role: 'user', content: fallbackUser });
    }
    prompt.messages = applyPromptOverride(prompt.messages, 'story');
    const assistant = store.addMessage('assistant', '');
    if (branchKey) assistant.branchKey = branchKey;
    for (const message of session.messages) if (message !== assistant) delete message.promptTrace;
    assistant.promptTrace = {
        sentAt: new Date().toISOString(), model: settings.model, protocol: settings.protocol || 'openai-chat',
        preset: runtime.activePreset ? { id: runtime.activePreset.id, name: runtime.activePreset.name } : null,
        activeWorldbookEntries: prompt.activeEntries.map(item => item.comment || item.name || item.uid),
        messages: structuredClone(prompt.messages),
    };
    assistant.tokenUsage = normalizeTokenUsage(null, prompt.messages, '');
    store.save();
    const turnId = crypto.randomUUID();
    const startedAt = performance.now();
    const variablesBefore = structuredClone(runtime.variables);
    await blackbox.record('turn', 'generation_started', {
        addUser, userText: text, messageCount: session.messages.length, prompt,
        preset: runtime.activePreset ? { id: runtime.activePreset.id, name: runtime.activePreset.name, prompts: runtime.activePreset.prompts?.length } : null,
        connection: settings, variablesBefore,
    }, { sessionId: session.id, turnId });
    generating = true;
    generationController = new AbortController();
    let timeoutId;
    const armGenerationTimeout = phase => {
        clearTimeout(timeoutId);
        timeoutId = setTimeout(() => generationController?.abort(new DOMException(`${phase}连续 300 秒无响应`, 'TimeoutError')), 300000);
    };
    armGenerationTimeout('等待上游');
    generationAiProcessId = beginAiProcess('正文 AI', '准备发送提示词', () => generationController?.abort(new DOMException('用户已中止生成', 'AbortError')));
    generationClock = setInterval(() => {
        const seconds = Math.floor((performance.now() - startedAt) / 1000);
        if ($('#generationElapsed')) $('#generationElapsed').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }, 1000);
    $('#generationElapsed').textContent = '0:00'; $('#generationChars').textContent = '等待首包';
    $('#sendButton').disabled = true;
    $('#typing').classList.remove('hidden');
    renderMessages({ followLatest: true });
    try {
        const sampling = runtime.activePreset?.sampling ?? {};
        // Tavern's OpenAI request does not inherit `reasoning_effort` from an
        // imported preset.  Treat that field as an explicit connection option
        // only; otherwise Izumi 0503 silently becomes Gemini thinking HIGH.
        const { reasoningEffort: _presetReasoningEffort, ...presetSampling } = sampling;
        const explicitReasoning = settings.reasoningEffort && settings.reasoningEffort !== 'auto'
            ? { reasoningEffort: settings.reasoningEffort }
            : {};
        const requestPayload = { ...settings, ...presetSampling, ...explicitReasoning, maxTokens: Math.max(30000, Number(sampling.maxTokens || settings.maxTokens) || 32768), assistantPrefill: runtime.activePreset?.assistantPrefill || '', messages: prompt.messages };
        updateAiProcess(generationAiProcessId, '等待模型首包');
        await blackbox.record('api', 'request_dispatched', { url: '/api/chat', payload: requestPayload }, { sessionId: session.id, turnId });
        const response = await fetch('/api/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestPayload),
            signal: generationController.signal,
        });
        armGenerationTimeout('接收响应');
        updateAiProcess(generationAiProcessId, '接收模型响应');
        await blackbox.record('api', 'response_headers', { status: response.status, ok: response.ok, contentType: response.headers.get('content-type'), elapsedMs: Math.round(performance.now() - startedAt) }, { sessionId: session.id, turnId });
        if (!response.ok) {
            const error = await response.text();
            throw new Error(error || `HTTP ${response.status}`);
        }
        const type = response.headers.get('content-type') || '';
        if (type.includes('application/json')) {
            const body = await response.json();
            assistant.content = body.choices?.[0]?.message?.content ?? '';
            assistant.tokenUsage = normalizeTokenUsage(body.usage, prompt.messages, assistant.content);
            store.updateMessage(assistant.id, assistant.content);
        } else {
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';
            let content = '';
            let streamUsage = null;
            let firstChunkRecorded = false;
            let lastPaint = 0;
            while (true) {
                const { value, done } = await reader.read();
                armGenerationTimeout('流式传输');
                buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
                buffer = readSseText(buffer, chunk => { content += chunk; }, event => { if (event.usage) streamUsage = event.usage; });
                if (content && !firstChunkRecorded) { firstChunkRecorded = true; blackbox.record('api', 'response_first_chunk', { elapsedMs: Math.round(performance.now() - startedAt) }, { sessionId: session.id, turnId }); }
                $('#generationChars').textContent = `${content.length.toLocaleString()} 字`;
                const now = performance.now();
                if (now - lastPaint > 90 || done) {
                    assistant.content = content;
                    const body = $(`.message[data-id="${assistant.id}"] .message-body`);
                    if (body) renderRich(body, content, assistant.id);
                    $('#messages').scrollTop = $('#messages').scrollHeight;
                    lastPaint = now;
                }
                if (done) break;
            }
            assistant.tokenUsage = normalizeTokenUsage(streamUsage, prompt.messages, content);
            store.updateMessage(assistant.id, content);
        }
        // Combat handoff is an explicit prompt protocol.  Do not inspect prose,
        // Step.4, CheckResult, HP arrows, or entity counts to infer a battle
        // phase and do not ask another model to repair a non-conforming reply.
        // Only a declared LOCAL_COMBAT_REQUIRED handshake holds combat patches;
        // otherwise this response is passed through unchanged for traceability.
        const declarationHint = battleDeclarationFromMessage(assistant.content);
        const handoff = battleHandoffFromMessage(assistant.content);
        const localHandoff = handoff?.status === 'LOCAL_COMBAT_REQUIRED';
        const heldPatch = localHandoff ? deferLocalCombatPatch(assistant.content) : null;
        if (heldPatch?.deferredOperations?.length) {
            await blackbox.record('combat-model', 'combat_protocol_patch_held', {
                messageId: assistant.id,
                operationCount: heldPatch.deferredOperations.length,
                paths: heldPatch.deferredOperations.map(operation => operation.path || operation.from || operation.to || '/'),
                reason: 'explicit LOCAL_COMBAT_REQUIRED handshake; local engine owns the next combat result',
            }, { sessionId: session.id, turnId });
        }
        const updated = await runtime.parseVariableUpdate(heldPatch?.sanitizedContent || assistant.content, runtime.variables);
        const variablesChanged = JSON.stringify(updated) !== JSON.stringify(runtime.variables);
        if (variablesChanged) await runtime.replaceVariables(updated);
        if (!/<UpdateVariable>/i.test(assistant.content)) await blackbox.record('runtime', 'variable_update_absent', { variablesChanged, responseLength: assistant.content.length }, { sessionId: session.id, turnId });
        try { await processBattleDeclaration(assistant, { protocolHandoff: handoff }); }
        catch (declarationError) {
            combatModelingState = { phase: 'failed', detail: `战场声明处理失败：${declarationError.message}` };
            renderCombatModelStatus();
            await blackbox.record('combat-model', 'declaration_processing_failed', { messageId: assistant.id, error: declarationError.message }, { sessionId: session.id, turnId });
            toast(`战场声明处理失败：${declarationError.message}`, 'error');
        }
        await runtime.emit('message_received', session.messages.length - 1);
        await runtime.emit('character_message_rendered', session.messages.length - 1);
        await blackbox.record('turn', 'generation_completed', { elapsedMs: Math.round(performance.now() - startedAt), response: assistant.content, variablesBefore, variablesAfter: runtime.variables }, { sessionId: session.id, turnId });
    } catch (error) {
        const aborted = generationController?.signal.aborted;
        const detail = aborted ? (generationController.signal.reason?.message || '用户已中止') : error.message;
        assistant.tokenUsage = normalizeTokenUsage(null, prompt.messages, assistant.content);
        store.updateMessage(assistant.id, `> 连接中断\n\n${detail}`);
        if (aborted) toast(detail === '用户已中止' ? '已中止生成。' : `${detail}。`, 'info');
        else toast(`生成失败：${detail}`, 'error');
        await blackbox.record('turn', 'generation_failed', { elapsedMs: Math.round(performance.now() - startedAt), error, partialResponse: assistant.content }, { sessionId: session.id, turnId });
    } finally {
        clearTimeout(timeoutId); clearInterval(generationClock); generationClock = null; generationController = null;
        endAiProcess(generationAiProcessId); generationAiProcessId = null;
        generating = false;
        $('#sendButton').disabled = false;
        $('#typing').classList.add('hidden');
        renderAll();
        renderBlackBox();
    }
}

function triggerSlash(command) {
    const input = $('#messageInput');
    const send = String(command).match(/^\/send\s+([\s\S]*?)(?:\|\/trigger)?$/i);
    if (send) {
        const text = send[1].replace(/\\\|/g, '|').trim();
        input.value = text;
        input.dispatchEvent(new Event('input'));
        generate({ text });
        return true;
    }
    const setInput = String(command).match(/^\/(?:setinput|input)\s+([\s\S]*)$/i);
    if (setInput) {
        input.value = setInput[1];
        input.dispatchEvent(new Event('input'));
        input.focus();
        return true;
    }
    if (/^\/trigger/i.test(command)) return true;
    return false;
}

// Battle Orb can run as a standalone tactical terminal or inside the
// SillyTavern third-party extension.  Keep the bridge deliberately small: the
// terminal owns combat facts, while the Tavern owns the final chat record.
function postBattleOrbMessage(type, payload = {}) {
    const message = { type, source: 'battle-orb', version: 1, ...payload };
    const targets = [];
    if (window.parent && window.parent !== window) targets.push(window.parent);
    if (window.opener && window.opener !== window && !window.opener.closed) targets.push(window.opener);
    const uniqueTargets = [...new Set(targets)];
    for (const target of uniqueTargets) {
        try { target.postMessage(message, '*'); } catch (error) { console.warn('[battle-orb] bridge post failed', error); }
    }
    return uniqueTargets.length;
}

function importBattleOrbTavernContext(payload = {}) {
    const sourceMessages = Array.isArray(payload.messages) ? payload.messages : [];
    if (!sourceMessages.length || !store.activeSession) return { ok: false, count: 0, reason: 'empty_context' };
    const now = new Date().toISOString();
    const messages = sourceMessages.slice(-80).map((item, index) => {
        const role = item.role === 'user' ? 'user' : item.role === 'system' ? 'system' : 'assistant';
        const content = String(item.content ?? item.message ?? '').trim();
        return { id: crypto.randomUUID(), role, content, createdAt: now, swipes: [content], swipeIndex: 0, tavernMessageId: item.id ?? item.message_id ?? index };
    }).filter(item => item.content);
    if (!messages.length) return { ok: false, count: 0, reason: 'empty_content' };
    const session = store.activeSession;
    session.messages = messages;
    session.title = String(payload.title || payload.characterName || '酒馆战斗分支').replace(/\s+/g, ' ').slice(0, 40) || '酒馆战斗分支';
    session.battleOrbTavernContext = {
        chatId: payload.chatId || null,
        characterName: payload.characterName || null,
        userName: payload.userName || null,
        importedAt: now,
        messageCount: messages.length,
    };
    store.save();
    renderAll();
    renderMessages({ followLatest: true });
    toast(`已同步酒馆当前剧情（${messages.length} 条）`, 'success');
    return { ok: true, count: messages.length };
}

function publishBattleOrbHandoff(payload = {}) {
    return postBattleOrbMessage('battle-orb:handoff', {
        battleId: payload.battleId || null,
        messageId: payload.messageId || null,
        content: String(payload.content || ''),
        battle: payload.battle || null,
        replayHash: payload.replayHash || null,
        simulation: Boolean(payload.simulation),
        createdAt: new Date().toISOString(),
    });
}

function installBridge() {
    const messages = () => store.activeSession?.messages ?? [];
    const legacyInput = $('#send_textarea');
    const composerInput = $('#messageInput');
    legacyInput?.addEventListener('input', () => {
        if (!composerInput || composerInput.value === legacyInput.value) return;
        composerInput.value = legacyInput.value;
        composerInput.dispatchEvent(new Event('input', { bubbles: true }));
    });
    composerInput?.addEventListener('input', () => {
        if (legacyInput && legacyInput.value !== composerInput.value) legacyInput.value = composerInput.value;
    });
    window.getChatMessages = (range, options = {}) => {
        let selected = messages();
        if (range !== undefined && range !== null && range !== '') {
            const id = String(range);
            selected = selected.filter((item, index) => item.id === id || String(index) === id);
        }
        return selected.map((item, index) => ({
            message_id: item.id,
            message: item.content,
            role: item.role,
            is_user: item.role === 'user',
            swipes: options.include_swipe ? item.swipes : undefined,
            swipe_id: item.swipeIndex,
            is_hidden: Boolean(item.isHidden),
            index,
        }));
    };
    window.setChatMessage = async (content, messageId, options = {}) => {
        const all = messages();
        const message = all.find((item, index) => item.id === String(messageId) || String(index) === String(messageId));
        if (!message) throw new Error('未找到消息');
        if (typeof options.is_hidden === 'boolean') message.isHidden = options.is_hidden;
        if (Number.isInteger(options.swipe_id) && message.swipes?.[options.swipe_id] !== undefined) {
            message.swipeIndex = options.swipe_id;
            message.content = message.swipes[options.swipe_id];
        } else if (content !== undefined && content !== null) {
            message.content = String(content);
        }
        store.save();
        renderMessages();
        return true;
    };
    window.setChatMessages = async updates => {
        for (const update of Array.isArray(updates) ? updates : [updates]) {
            const id = update.message_id ?? update.id ?? update.index;
            await window.setChatMessage(update.message ?? update.content, id, update);
        }
        return true;
    };
    window.injectPrompts = prompts => runtime.injectPrompts(prompts);
    window.triggerSlash = triggerSlash;
    window.__reincarnationBridge = {
        getChatMessages: window.getChatMessages,
        setChatMessage: window.setChatMessage,
        setChatMessages: window.setChatMessages,
        injectPrompts: window.injectPrompts,
        triggerSlash,
        getMessageVar: (...args) => window.getMessageVar(...args),
        setMessageVar: (...args) => window.setMessageVar(...args),
    };
    window.__battleOrbBridge = window.__reincarnationBridge;
    window.addEventListener('message', event => {
        if (event.data?.type === 'world_selection' && event.data.content) generate({ text: event.data.content });
        if (event.data?.type === 'battle-orb:context' && (event.source === window.parent || event.source === window.opener)) {
            importBattleOrbTavernContext(event.data);
        }
    });
    setTimeout(() => postBattleOrbMessage('battle-orb:hello', { page: 'combat-terminal' }), 250);
}

function renderStatus() {
    const stat = runtime.variables.stat_data ?? {};
    const player = stat['主角'] ?? {};
    const system = stat['系统状态'] ?? {};
    const world = stat['世界'] ?? {};
    const cards = [
        ['生命层级', player['层级'] ?? 'Ⅰ'],
        ['HP', `${player.HP ?? 20} / ${player.HP_MAX ?? 20}`, Number(player.HP || 0) / Math.max(1, Number(player.HP_MAX || 20))],
        ['EP', `${player.EP ?? 0} / ${player.EP_MAX ?? 0}`, Number(player.EP || 0) / Math.max(1, Number(player.EP_MAX || 1))],
        ['空间币', player['空间币'] ?? 0],
        ['当前位置', world['地点'] || world['名称'] || '主神空间'],
        ['世界稳定', `${world['稳定'] ?? 100}%`, Number(world['稳定'] ?? 100) / 100],
        ['战斗状态', system['是否战斗中'] ? `第 ${system['当前轮次'] ?? 1} 回合` : '非战斗'],
        ['当前形态', player['当前形态']?.['名称'] || '基础形态'],
    ];
    const node = $('#statusContent');
    node.innerHTML = cards.map(([name, value, progress]) => `<article class="stat-card"><small>${escapeHtml(name)}</small><strong>${escapeHtml(value)}</strong>${progress !== undefined ? `<div class="bar"><i style="width:${Math.max(0, Math.min(100, progress * 100))}%"></i></div>` : ''}</article>`).join('');
    const attributes = player['最终属性'] ?? {};
    const equipment = player['装备'] ?? {};
    node.insertAdjacentHTML('beforeend', `<article class="stat-card full final-attributes-card"><small>最终属性</small>${finalAttributePanel(attributes, player)}</article><article class="stat-card wide"><small>装备</small>${dataTable(equipment)}</article><article class="stat-card wide"><small>状态效果</small>${dataTable(player['状态'] ?? {})}</article>`);
}

function plainValue(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (Array.isArray(value)) return value.join('、') || '—';
    if (typeof value === 'object') return value['描述'] || value['名称'] || JSON.stringify(value);
    return String(value);
}

function entityCards(collection, type) {
    const entries = Array.isArray(collection) ? collection.map((value, index) => [value?.['名称'] || `${type} ${index + 1}`, value]) : Object.entries(collection || {});
    if (!entries.length) return `<div class="empty-state">暂无${escapeHtml(type)}记录</div>`;
    return entries.map(([name, data]) => {
        const obj = typeof data === 'object' && data ? data : { '描述': data };
        const tier = obj['品质'] || obj['层级'] || obj['等级'] || obj['位格'] || '—';
        const description = obj['描述'] || obj['效果'] || obj['背景'] || obj['状态'] || plainValue(data);
        const tags = obj['标签'] || obj['类型'] || obj['身份'] || [];
        const tagList = Array.isArray(tags) ? tags : [tags];
        return `<article class="entity-card" data-entity-type="${escapeHtml(type)}"><header><h3>${escapeHtml(name)}</h3><span class="tier">${escapeHtml(tier)}</span></header><p>${escapeHtml(plainValue(description))}</p><footer>${tagList.filter(Boolean).slice(0, 6).map(tag => `<span>${escapeHtml(tag)}</span>`).join('')}</footer></article>`;
    }).join('');
}

// These are the equipment slots, operation states, and capacities used by the
// V3.2.6 floating status ball.  Keep the numeric protocol intact: 0 is the
// backpack, 1 is currently worn / in the tactical bar, and 2 is storage.
const TAVERN_EQUIPMENT_SLOTS = [
    { label: '武器', type: 0, cap: 2 }, { label: '手套', type: 1, cap: 1 },
    { label: '头部', type: 2, cap: 1 }, { label: '胸部', type: 3, cap: 1 },
    { label: '腿部', type: 4, cap: 1 }, { label: '鞋子', type: 5, cap: 1 },
    { label: '披风', type: 6, cap: 1 }, { label: '饰品', type: 7, cap: 2 },
    { label: '世界遗物', type: 8, cap: 0 },
];
const TAVERN_ITEM_SLOT_CAP = 5;

function inventoryEntries(collection) {
    return Array.isArray(collection)
        ? collection.map((value, index) => [value?.['名称'] || `未命名物品 ${index + 1}`, value || {}])
        : Object.entries(collection || {});
}

function inventoryStatus(entry) {
    const status = Number(entry?.['状态']);
    return [0, 1, 2].includes(status) ? status : 0;
}

function inventoryQuality(entry) {
    return uiQuality(entry?.['品质'], 'E');
}

// The V3.2.6 opening page encodes shields as type 0 together with swords and
// other hand-held equipment.  A shield still consumes one of the two hand-held
// slots, but should never be labelled or rendered as an attack weapon.
function isDefensiveHandheldEquipment(entry) {
    if (Number(entry?.['类型']) !== 0) return false;
    const tags = Array.isArray(entry?.['标签']) ? entry['标签'] : [];
    const raw = entry?.['原始属性'] && typeof entry['原始属性'] === 'object' ? entry['原始属性'] : {};
    const shieldTag = tags.some(tag => /盾|防暴/i.test(String(tag)));
    const defensiveOnly = ('DEF' in raw || 'MDEF' in raw) && !('ATK' in raw) && !('MATK' in raw);
    return shieldTag || defensiveOnly;
}

function equipmentSlotFor(entry) {
    const type = Number(entry?.['类型']);
    const slot = TAVERN_EQUIPMENT_SLOTS.find(item => item.type === type) || { label: '未分类装备', type, cap: 0 };
    return isDefensiveHandheldEquipment(entry)
        ? { ...slot, label: '盾牌', occupancyLabel: '武器手持位' }
        : slot;
}

function inventoryDetailValue(value) {
    if (value === null || value === undefined || value === '') return '';
    if (typeof value !== 'object') return String(value);
    return Object.entries(value).map(([key, item]) => `${key}: ${plainValue(item)}`).join(' · ');
}

function inventoryCard(kind, name, rawEntry) {
    const entry = typeof rawEntry === 'object' && rawEntry ? rawEntry : { '描述': rawEntry };
    const status = inventoryStatus(entry);
    const quality = inventoryQuality(entry);
    const slot = kind === 'equipment' ? equipmentSlotFor(entry) : null;
    const typeLabel = slot?.label || entry['类型'] || entry['道具类型'] || '道具';
    const description = entry['描述'] || entry['效果说明'] || entry['效果'] || entry['背景'] || '暂无描述';
    const rows = [];
    if (entry['消耗'] !== undefined) rows.push(['消耗', entry['消耗']]);
    if (entry['数量'] !== undefined) rows.push(['数量', entry['数量']]);
    if (entry['原始属性'] !== undefined) rows.push(['属性', entry['原始属性']]);
    else if (entry['属性'] !== undefined) rows.push(['属性', entry['属性']]);
    if (entry['效果'] !== undefined && entry['效果'] !== description) rows.push(['效果', entry['效果']]);
    const actionButton = (action, label) => `<button type="button" class="arsenal-action" data-inventory-action="${action}" data-inventory-kind="${kind}" data-inventory-name="${escapeHtml(name)}">${label}</button>`;
    let actions = '';
    // The original floating ball deliberately leaves world relics outside the
    // normal equipment flow; they are neither worn nor moved through slots.
    if (slot?.type === 8) actions = '<span class="arsenal-relic-lock" title="世界遗物不进入常规装备栏体系">世界遗物 · 特殊持有</span>';
    else if (status === 0) actions = `${actionButton('wear', '穿戴')}${actionButton('store', '存放')}`;
    else if (status === 1) actions = `${actionButton('remove', '脱下')}${actionButton('store', '存放')}`;
    else actions = `${actionButton('wear', '穿戴')}${actionButton('takeback', '取回')}`;
    return `<article class="arsenal-card q-${quality}" data-inventory-kind="${kind}" data-inventory-status="${status}">
        <header><div><h3>${escapeHtml(name)}</h3><small>${escapeHtml(typeLabel)}</small></div><span class="arsenal-quality q-${quality}">${quality}</span></header>
        <p class="arsenal-description">${escapeHtml(inventoryDetailValue(description))}</p>
        ${rows.length ? `<dl class="arsenal-details">${rows.map(([label, value]) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(inventoryDetailValue(value))}</dd></div>`).join('')}</dl>` : ''}
        <footer><span class="arsenal-state">${status === 1 ? '战术栏' : status === 2 ? '仓库' : kind === 'equipment' ? '装备背包' : '道具背包'}</span><div class="arsenal-actions">${actions}</div></footer>
    </article>`;
}

function inventorySlotStrip(player) {
    const equipped = inventoryEntries(player['装备']).filter(([, entry]) => inventoryStatus(entry) === 1);
    const slots = TAVERN_EQUIPMENT_SLOTS.map(slot => {
        const current = equipped.filter(([, entry]) => Number(entry?.['类型']) === slot.type).length;
        const state = slot.cap && current > slot.cap ? 'is-over' : slot.cap && current === slot.cap ? 'is-full' : '';
        const count = slot.cap ? `${current} / ${slot.cap}` : `${current} / X`;
        return `<div class="arsenal-slot ${state}" title="${escapeHtml(slot.label)}：${slot.cap ? `最多 ${slot.cap} 件` : '不受常规槽位限制'}"><small>${slot.label}</small><b>${count}</b></div>`;
    });
    const itemCount = inventoryEntries(player['道具']).filter(([, entry]) => inventoryStatus(entry) === 1).length;
    const itemState = itemCount > TAVERN_ITEM_SLOT_CAP ? 'is-over' : itemCount === TAVERN_ITEM_SLOT_CAP ? 'is-full' : '';
    slots.push(`<div class="arsenal-slot arsenal-item-slot ${itemState}" title="战术道具：最多 ${TAVERN_ITEM_SLOT_CAP} 个"><small>道具</small><b>${itemCount} / ${TAVERN_ITEM_SLOT_CAP}</b></div>`);
    return slots.join('');
}

function inventoryTabEntries(player) {
    const equipment = inventoryEntries(player['装备']);
    const items = inventoryEntries(player['道具']);
    if (inventoryTab === 'tactical') return [...equipment.filter(([, entry]) => inventoryStatus(entry) === 1).map(([name, entry]) => ['equipment', name, entry]), ...items.filter(([, entry]) => inventoryStatus(entry) === 1).map(([name, entry]) => ['item', name, entry])];
    if (inventoryTab === 'equipment') return equipment.filter(([, entry]) => inventoryStatus(entry) === 0).map(([name, entry]) => ['equipment', name, entry]);
    if (inventoryTab === 'item') return items.filter(([, entry]) => inventoryStatus(entry) === 0).map(([name, entry]) => ['item', name, entry]);
    return [...equipment.filter(([, entry]) => inventoryStatus(entry) === 2).map(([name, entry]) => ['equipment', name, entry]), ...items.filter(([, entry]) => inventoryStatus(entry) === 2).map(([name, entry]) => ['item', name, entry])];
}

function renderInventory() {
    const stat = runtime.variables.stat_data ?? {};
    const player = stat['主角'] ?? {};
    const tabs = [
        ['tactical', '战术栏'], ['equipment', '装备背包'], ['item', '道具背包'], ['storage', '仓库'],
    ];
    const entries = inventoryTabEntries(player);
    const tabTitle = tabs.find(([key]) => key === inventoryTab)?.[1] || '战术栏';
    const emptyHint = inventoryTab === 'storage' ? '仓库为空；仓库物品不会进入 AI 可见的战术栏。' : inventoryTab === 'tactical' ? '战术栏为空；只有这里的装备与道具会在战斗状态中生效。' : '背包为空；这里的物品在战斗时不会进入 AI 可见的战术栏。';
    $('#inventoryContent').innerHTML = `<section class="arsenal-terminal">
        <header class="arsenal-terminal-header"><div><small>FLOATING STATUS PROTOCOL · V3.2.6</small><h2>携行与装备终端</h2></div><p>状态 0：背包 · 1：战术栏 · 2：仓库</p></header>
        <div class="arsenal-slot-strip">${inventorySlotStrip(player)}</div>
        <nav class="arsenal-tabs" aria-label="物品状态筛选">${tabs.map(([key, label]) => `<button type="button" class="${inventoryTab === key ? 'active' : ''}" data-inventory-tab="${key}">${label}</button>`).join('')}</nav>
        <div class="arsenal-tab-heading"><div><small>${inventoryTab === 'tactical' ? 'AI VISIBLE' : inventoryTab === 'storage' ? 'AI HIDDEN · STORAGE' : 'AI HIDDEN · BACKPACK'}</small><h3>${tabTitle}</h3></div><span>${entries.length} 件</span></div>
        <div class="arsenal-grid">${entries.map(([kind, name, entry]) => inventoryCard(kind, name, entry)).join('') || `<div class="empty-state">${emptyHint}</div>`}</div>
        ${Object.keys(stat['资产'] || {}).length ? `<section class="arsenal-assets"><small>空间资产 · 只读</small>${entityCards(stat['资产'], '资产')}</section>` : ''}
    </section>`;
}

async function changeInventoryStatus({ action, kind, name }) {
    const variables = structuredClone(runtime.variables);
    const player = variables.stat_data?.['主角'];
    const collectionKey = kind === 'equipment' ? '装备' : '道具';
    const collection = player?.[collectionKey];
    const entry = Array.isArray(collection) ? collection.find(item => item?.['名称'] === name) : collection?.[name];
    if (!entry || typeof entry !== 'object') return toast('未找到该物品；可能已被当前楼层的状态更新替换。', 'error');
    const previousStatus = inventoryStatus(entry);
    const details = { action, kind, name, previousStatus, automaticRemoved: [] };
    if (kind === 'equipment' && equipmentSlotFor(entry).type === 8) return toast('世界遗物不进入常规装备栏，无法执行穿戴或仓库操作。', 'error');
    if (action === 'wear') {
        if (kind === 'equipment') {
            const slot = equipmentSlotFor(entry);
            const worn = inventoryEntries(player['装备']).filter(([otherName, other]) => otherName !== name && inventoryStatus(other) === 1 && Number(other?.['类型']) === slot.type);
            if (slot.cap >= 2 && worn.length >= slot.cap) {
                const occupancyLabel = slot.occupancyLabel || slot.label;
                return toast(`身上${occupancyLabel}已满(${slot.cap}件)，先脱下现有${occupancyLabel}后再尝试。`, 'error');
            }
            if (slot.cap === 1 && worn.length) {
                worn.forEach(([otherName, other]) => { other['状态'] = 0; details.automaticRemoved.push(otherName); });
            }
        } else {
            const wornItems = inventoryEntries(player['道具']).filter(([otherName, other]) => otherName !== name && inventoryStatus(other) === 1);
            if (wornItems.length >= TAVERN_ITEM_SLOT_CAP) return toast(`身上负重已满(${TAVERN_ITEM_SLOT_CAP}个道具)，先卸载现有道具后再尝试。`, 'error');
        }
        entry['状态'] = 1;
    } else if (action === 'remove' || action === 'takeback') {
        entry['状态'] = 0;
    } else if (action === 'store') {
        entry['状态'] = 2;
    } else return;
    const saved = await runtime.replaceVariables(variables);
    await blackbox.record('inventory', 'item_status_changed', { ...details, nextStatus: inventoryStatus(entry), variablesVersion: saved?.version ?? null }, { sessionId: store.activeSession?.id });
    renderAll();
    const result = action === 'wear' ? `已穿戴：${name}${details.automaticRemoved.length ? `；已自动脱下：${details.automaticRemoved.join('、')}` : ''}` : action === 'store' ? `已存放至仓库：${name}` : action === 'takeback' ? `已取回至背包：${name}` : `已脱下：${name}`;
    toast(result, 'success');
}

function renderAbilities() {
    const player = runtime.variables.stat_data?.['主角'] ?? {};
    const sections = [['职业', player['职业']], ['血统', player['血统']], ['技能', player['技能']], ['形态库', player['形态库']]];
    $('#abilityContent').innerHTML = sections.map(([title, data]) => `<section class="entity-section"><h2>${title}</h2><div class="entity-grid">${entityCards(data, title)}</div></section>`).join('');
}

function dataTable(value) {
    const entries = Object.entries(value || {});
    if (!entries.length) return '<p style="color:#5e6979;font-size:12px">暂无数据</p>';
    return `<table class="data-table">${entries.slice(0, 30).map(([key, item]) => `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(typeof item === 'object' ? JSON.stringify(item) : item)}</td></tr>`).join('')}</table>`;
}

function renderMissions() {
    const stat = runtime.variables.stat_data ?? {};
    const missions = stat['任务']?.['列表'] ?? {};
    const world = stat['世界'] ?? {};
    const items = Object.entries(missions);
    $('#missionCount').textContent = items.length;
    $('#missionContent').innerHTML = items.map(([name, data]) => { const obj = typeof data === 'object' ? data : { '描述': data }; const progress = Number(obj['进度'] || 0); return `<article class="mission-card"><h3>${escapeHtml(name)}</h3><p>${escapeHtml(plainValue(obj['描述'] || obj['目标'] || data))}</p><p>状态：${escapeHtml(obj['状态'] || '进行中')} · 奖励：${escapeHtml(plainValue(obj['奖励']))}</p>${progress ? `<progress max="100" value="${Math.min(100, progress)}"></progress>` : ''}</article>`; }).join('') || '<div class="empty-state">尚未接受任务。前往冒险记录或请求新的世界候选。</div>';
}

function renderWorld() {
    const world = runtime.variables.stat_data?.['世界'] ?? {};
    const tags = value => `<div class="tag-cloud">${(Array.isArray(value) ? value : Object.keys(value || {})).map(item => `<span>${escapeHtml(item)}</span>`).join('') || '<span>暂无记录</span>'}</div>`;
    $('#worldContent').innerHTML = `<article class="world-panel"><h3>${escapeHtml(world['名称'] || '主神空间')}</h3>${dataTable({ '当前位置': world['地点'], '世界位格': world['位格'], '任务难度': world['难度'], '稳定度': `${world['稳定'] ?? 100}%`, '世界时间': world['时间'] })}</article><article class="world-panel"><h3>世界法则</h3>${tags(world['法则'])}</article><article class="world-panel full"><h3>势力</h3>${dataTable(world['势力'] || {})}</article><article class="world-panel"><h3>探索记录</h3>${dataTable(world['探索'] || {})}</article><article class="world-panel"><h3>因果轨道</h3>${dataTable(world['因果轨道'] || {})}</article>`;
}

function renderRelations() {
    const stat = runtime.variables.stat_data ?? {};
    const relations = stat['关系列表'] ?? {};
    const names = ['主角', ...Object.keys(relations)];
    const displayName = name => name === '主角' ? (stat['主角']?.['姓名'] || store.data.settings.userName || '主角') : name;
    const tone = score => score > 0 ? 'positive' : score < 0 ? 'negative' : 'neutral';
    const matrix = names.length > 1 ? `<section class="relation-matrix-panel"><header><div><small>DIRECTED AFFECTION</small><h2>互相好感度</h2></div><p>纵轴对横轴的好感；未记录统一按 0 处理。</p></header><div class="relation-matrix-scroll"><table class="relation-matrix"><thead><tr><th>由 \ 对</th>${names.map(name => `<th>${escapeHtml(displayName(name))}</th>`).join('')}</tr></thead><tbody>${names.map(source => `<tr><th>${escapeHtml(displayName(source))}</th>${names.map(target => source === target ? '<td class="self">—</td>' : `<td class="${tone(getAffection(stat, source, target))}" title="${escapeHtml(displayName(source))} → ${escapeHtml(displayName(target))}">${getAffection(stat, source, target)}</td>`).join('')}</tr>`).join('')}</tbody></table></div></section>` : '';
    const collectionDetails = (label, collection, empty = '无记录') => {
        const entries = inventoryEntries(collection);
        return `<details class="relation-detail" open><summary>${escapeHtml(label)} <span>${entries.length}</span></summary>${entries.length ? `<div class="relation-detail-list">${entries.map(([key, value]) => `<div><b>${escapeHtml(key)}</b><span>${escapeHtml(inventoryDetailValue(value) || plainValue(value))}</span></div>`).join('')}</div>` : `<p class="relation-empty-detail">${escapeHtml(empty)}</p>`}</details>`;
    };
    const entityVitals = (entity = {}) => `<div class="relation-vitals"><span><small>HP</small><b>${escapeHtml(`${entity.HP ?? '—'} / ${entity.HP_MAX ?? '—'}`)}</b></span><span><small>EP</small><b>${escapeHtml(`${entity.EP ?? '—'} / ${entity.EP_MAX ?? '—'}`)}</b></span><span><small>状态</small><b>${escapeHtml(entity['在场'] === false ? '不在场' : plainValue(entity['当前形态']?.['名称'] || entity['状态'] || '正常'))}</b></span></div>`;
    const cards = Object.entries(relations).map(([name, npc]) => {
        const relationEntries = Object.entries(npc?.['好感度关系'] || {}).filter(([target]) => target !== name);
        const relationList = relationEntries.length ? relationEntries.map(([target, score]) => `<li><span>→ ${escapeHtml(displayName(target))}</span><b class="${tone(Number(score) || 0)}">${Number(score) || 0}</b></li>`).join('') : '<li class="empty-relation">未记录关系，默认均为 0</li>';
        const final = npc?.['最终属性'] && typeof npc['最终属性'] === 'object' ? npc['最终属性'] : {};
        const equipment = npc?.['装备'] || {};
        const skills = npc?.['技能'] || {};
        const items = npc?.['道具'] || {};
        const relationSummary = npc?.['背景故事'] || npc?.['外貌'] || npc?.['身份'] || '暂无人物摘要';
        const local = localEntityCombatSnapshot(npc || {});
        const combatRows = [['来源', local.source], ['攻击 / 术攻', `${local.attack ?? '—'} / ${local.magicAttack ?? '—'}`], ['攻击修正', local.attackModifier ?? '—'], ['防御 DC', local.defenseDC ?? '—'], ['物理 / 魔法减伤', `${local.armor ?? '—'}% / ${local.resistance ?? '—'}%`], ['战斗资产', local.assetBindings?.length ? local.assetBindings.join('、') : '无']];
        return `<article class="relation-entity-card"><header><div><small>${npc?.['是否队友'] ? 'PARTY ENTITY' : 'WORLD ENTITY'}</small><h3>${escapeHtml(name)}</h3><p class="relation-entity-subtitle">${escapeHtml(plainValue(npc?.['身份'] || npc?.['种族'] || '未声明身份'))}</p></div><span>${escapeHtml(npc?.['层级'] || npc?.['位阶'] || '—')}</span></header>${entityVitals(npc)}<p class="relation-entity-summary">${escapeHtml(plainValue(relationSummary))}</p><div class="relation-entity-facts"><span>种族 <b>${escapeHtml(plainValue(npc?.['种族'] || '—'))}</b></span><span>职业 <b>${escapeHtml(plainValue(npc?.['职业'] || '—'))}</b></span><span>在场 <b>${npc?.['在场'] === false ? '否' : '是'}</b></span></div><details class="relation-detail relation-attributes" open><summary>五维与最终属性 <span>${Object.keys(final).length}</span></summary>${Object.keys(final).length ? finalAttributePanel(final, npc) : '<p class="relation-empty-detail">暂无最终属性记录</p>'}</details><details class="relation-detail" open><summary>本地战斗资料 <span>${local.assetBindings?.length || 0}</span></summary><div class="relation-detail-list">${combatRows.map(([label, value]) => `<div><b>${escapeHtml(label)}</b><span>${escapeHtml(String(value ?? '—'))}</span></div>`).join('')}</div></details>${collectionDetails('装备', equipment)}${collectionDetails('技能', skills)}${collectionDetails('血统', npc?.['血统'] || {})}${collectionDetails('形态库', npc?.['形态库'] || {})}${collectionDetails('道具', items)}<details class="relation-detail" open><summary>有向好感度 <span>${relationEntries.length}</span></summary><ul class="relation-affection-list">${relationList}</ul></details>${npc?.['状态'] ? collectionDetails('状态与效果', npc['状态']) : ''}<details class="relation-detail"><summary>背景与心理记录 <span>只读</span></summary><div class="relation-long-text"><p><b>外貌</b>${escapeHtml(plainValue(npc?.['外貌'] || '—'))}</p><p><b>着装</b>${escapeHtml(plainValue(npc?.['着装'] || '—'))}</p><p><b>背景故事</b>${escapeHtml(plainValue(npc?.['背景故事'] || '—'))}</p><p><b>心里话</b>${escapeHtml(plainValue(npc?.['心里话'] || '—'))}</p></div></details></article>`;
    }).join('');
    $('#relationContent').innerHTML = `${matrix}<section class="relation-entity-grid">${cards || '<div class="empty-state">暂无 NPC；空关系列表中的任意好感度均按 0 读取。</div>'}</section>`;
}

function renderIntel() {
    const intel = runtime.variables.stat_data?.['传闻'] ?? {};
    const groups = [['街头巷议', intel['街头巷议']], ['情报交易', intel['情报交易']], ['布告与檄文', intel['布告与檄文']]];
    $('#intelContent').innerHTML = groups.map(([title, data]) => `<section class="intel-column"><h3>${title}</h3>${Object.entries(data || {}).map(([name, value]) => `<div class="intel-item"><b>${escapeHtml(name)}</b><p>${escapeHtml(plainValue(value))}</p></div>`).join('') || '<div class="empty-state">暂无情报</div>'}</section>`).join('');
}

function renderHudAndHub() {
    const stat = runtime.variables.stat_data ?? {};
    const player = stat['主角'] ?? {};
    const world = stat['世界'] ?? {};
    const missions = Object.entries(stat['任务']?.['列表'] ?? {});
    const hp = Number(player.HP ?? 20), hpMax = Number(player.HP_MAX ?? 20), ep = Number(player.EP ?? 0), epMax = Number(player.EP_MAX ?? 0);
    $('#hudHp').textContent = `${hp}/${hpMax}`; $('#hudHpBar').style.width = `${Math.min(100, hp / Math.max(1, hpMax) * 100)}%`;
    $('#hudEp').textContent = `${ep}/${epMax}`; $('#hudEpBar').style.width = `${Math.min(100, ep / Math.max(1, epMax) * 100)}%`;
    $('#hudCoin').textContent = player['空间币'] ?? 0; $('#hudStability').textContent = `${world['稳定'] ?? 100}%`;
    $('#hubGreeting').textContent = `欢迎回来，${player['姓名'] || store.data.settings.userName || '轮回者'}`;
    $('#hubWorld').textContent = world['名称'] || '主神空间'; $('#hubLocation').textContent = world['地点'] || '等待投放';
    $('#adventureLocation').textContent = world['地点'] || world['名称'] || '主神空间';
    $('#hubSummary').textContent = stat['系统状态']?.['是否战斗中'] ? `战斗进行中 · 第 ${stat['系统状态']['当前轮次'] || 1} 回合` : `${world['名称'] || '主神空间'}运行稳定，等待你的下一项行动。`;
    $('#hubMission').innerHTML = missions.length ? `<h3>${escapeHtml(missions[0][0])}</h3><p>${escapeHtml(plainValue(missions[0][1]?.['描述'] || missions[0][1]))}</p>` : '<div class="objective-empty">当前没有进行中的任务</div>';
    $('#hubCharacter').innerHTML = [['生命层级', player['层级'] || 'Ⅰ'], ['身份', plainValue(player['身份'])], ['当前形态', player['当前形态']?.['名称'] || '基础形态'], ['空间币', player['空间币'] || 0]].map(([k,v]) => `<div class="glance-row"><span>${k}</span><b>${escapeHtml(v)}</b></div>`).join('');
    $('#hubRecent').innerHTML = (store.activeSession?.messages ?? []).slice(-4).reverse().map(item => `<div class="recent-entry"><b>${item.role === 'user' ? store.data.settings.userName : '世界'}：</b>${escapeHtml(item.content.replace(/<[^>]+>/g, '').slice(0, 80))}</div>`).join('') || '<div class="objective-empty">暂无行动记录</div>';
}

function renderArchive() {
    $('#archiveContent').innerHTML = store.data.sessions.map(session => {
        const branches = Array.isArray(session.storyBranches) ? session.storyBranches.length : 1;
        return `<article class="archive-card ${session.id === store.data.activeSessionId ? 'active' : ''}" data-session="${session.id}"><h3>${escapeHtml(session.title)}</h3><p>${escapeHtml(session.messages.at(-1)?.content.replace(/<[^>]+>/g, '').slice(0, 100) || '尚未建立链接')}</p><footer><span>${session.messages.length} 条记录 · ${branches} 条分支</span><span>${new Date(session.updatedAt).toLocaleString('zh-CN')}</span></footer></article>`;
    }).join('') || '<div class="empty-state">暂无轮回档案</div>';
}

function activeBattleId() { return store.activeSession?.activeBattleId || null; }

function combatDebugStorageKey(battleId) { return `reincarnation-combat-debug:${battleId}`; }

function combatDebugEnsure(battleId) {
    const id = String(battleId || '').trim();
    if (!id || id === combatDebugBattleId) return;
    combatDebugBattleId = id;
    try {
        const saved = JSON.parse(sessionStorage.getItem(combatDebugStorageKey(id)) || '[]');
        combatDebugTrace = Array.isArray(saved) ? saved.slice(-COMBAT_DEBUG_TRACE_LIMIT) : [];
    } catch { combatDebugTrace = []; }
}

function combatDebugJson(value, limit = COMBAT_DEBUG_VALUE_LIMIT) {
    if (value === undefined) return undefined;
    try {
        const json = JSON.stringify(value);
        if (json.length <= limit) return JSON.parse(json);
        return { truncated: true, bytes: json.length, preview: json.slice(0, limit) };
    } catch (error) { return { unserializable: true, error: error.message, value: String(value) }; }
}

function combatDebugError(error) {
    return { name: error?.name || 'Error', message: error?.message || String(error), stack: error?.stack || null, serverDebug: error?.debug || null };
}

function combatDebugResponseSummary(body) {
    if (!body || typeof body !== 'object') return body;
    if (Array.isArray(body.events)) return { format: body.format || null, eventCount: body.events.length, lastEvent: body.events.at(-1) ? { sequence: body.events.at(-1).sequence, round: body.events.at(-1).round, type: body.events.at(-1).type } : null };
    if (body.bundle) return { format: body.bundle.schema || body.format || null, battleId: body.bundle.battleId || null, winner: body.bundle.winner || null, rounds: body.bundle.rounds ?? null };
    if (body.id && body.status) return { id: body.id, status: body.status, version: body.version, round: body.round, activeUnitId: body.activeUnitId, pauseReason: body.pauseReason ? combatDebugJson(body.pauseReason, 20000) : null, eventHash: body.eventHash || null, combatantCount: Array.isArray(body.combatants) ? body.combatants.length : null, battlefield: body.battlefield ? { shape: body.battlefield.shape, widthMeters: body.battlefield.widthMeters, heightMeters: body.battlefield.heightMeters, radiusMeters: body.battlefield.radiusMeters } : null };
    if (body.error) return { error: body.error };
    return combatDebugJson(body, 30000);
}

function recordCombatDebug(kind, data = {}, battleId = combatDebugBattleId || combatState?.id || activeBattleId()) {
    const id = String(battleId || '').trim();
    if (id) combatDebugEnsure(id);
    const entry = { at: new Date().toISOString(), kind, ...combatDebugJson(data, COMBAT_DEBUG_VALUE_LIMIT) };
    combatDebugTrace = [...combatDebugTrace, entry].slice(-COMBAT_DEBUG_TRACE_LIMIT);
    if (id) {
        try { sessionStorage.setItem(combatDebugStorageKey(id), JSON.stringify(combatDebugTrace)); } catch { /* temporary trace must never break gameplay */ }
    }
    return entry;
}

async function combatRequest(path = '', options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const requestBody = typeof options.body === 'string' ? (() => { try { return JSON.parse(options.body); } catch { return options.body; } })() : options.body;
    const pathBattleId = /^\/(battle-[^/]+)(?:\/|$)/.exec(path)?.[1] || null;
    const requestBattleId = pathBattleId || combatState?.id || activeBattleId() || combatDebugBattleId;
    if (requestBattleId) combatDebugEnsure(requestBattleId);
    const startedAt = performance.now();
    let response;
    let recorded = false;
    try {
        response = await fetch(`/api/combat${path}`, { headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }, ...options });
        const headersAt = performance.now();
        const text = await response.text();
        const textAt = performance.now();
        let body;
        let parseError = null;
        try { body = text ? JSON.parse(text) : {}; } catch (error) { parseError = error; body = { error: text.slice(0, 20000) }; }
        const parsedAt = performance.now();
        const durationMs = Math.round((performance.now() - startedAt) * 10) / 10;
        const benchmark = {
            totalMs: durationMs,
            headersMs: Math.round((headersAt - startedAt) * 10) / 10,
            bodyReadMs: Math.round((textAt - headersAt) * 10) / 10,
            jsonParseMs: Math.round((parsedAt - textAt) * 10) / 10,
            responseChars: text.length,
            serverTiming: response.headers.get('server-timing') || null,
        };
        if (!response.ok || parseError) {
            const error = new Error(body.error || `战斗接口返回非 JSON（HTTP ${response.status}）` || `HTTP ${response.status}`);
            if (body.debug) error.debug = body.debug;
            recordCombatDebug('api_error', { method, path, durationMs, benchmark, status: response.status, request: combatDebugJson(requestBody), response: combatDebugJson(body), error: combatDebugError(error), responseParseError: Boolean(parseError) }, requestBattleId);
            recorded = true;
            throw error;
        }
        if (body?.id) {
            combatDebugEnsure(body.id);
            if (Array.isArray(body.movementBlockers?.unitIds)) {
                combatForcedUnitIds = new Set(body.movementBlockers.unitIds.map(String));
                const blockerId = body.movementBlockers.unitIds[0];
                if (blockerId) {
                    combatSelectedUnitId = String(blockerId);
                    combatEntityInspectorUnitId = String(blockerId);
                } else if (body.movementBlockers.actorId) {
                    combatSelectedUnitId = String(body.movementBlockers.actorId);
                    combatEntityInspectorUnitId = null;
                }
            }
        }
        recordCombatDebug('api_response', { method, path, durationMs, benchmark, status: response.status, request: combatDebugJson(requestBody), response: combatDebugResponseSummary(body) }, body?.id || requestBattleId);
        return body;
    } catch (error) {
        if (!recorded) recordCombatDebug('api_error', { method, path, durationMs: Math.round((performance.now() - startedAt) * 10) / 10, status: response?.status || 0, request: combatDebugJson(requestBody), error: combatDebugError(error) }, requestBattleId);
        throw error;
    }
}

async function exportCombatDebug() {
    if (!combatState?.id) return toast('暂无可导出的战术演算', 'error');
    const battleId = combatState.id;
    combatDebugEnsure(battleId);
    const backend = {};
    const fetchBackend = async (key, path) => {
        try { backend[key] = await combatRequest(`/${battleId}${path}`); }
        catch (error) { backend[key] = { error: combatDebugError(error) }; }
    };
    await fetchBackend('flowTrace', '/flow-trace');
    const clientTrace = combatDebugTrace.slice(-64).map(entry => ({
        at: entry.at, kind: entry.kind, method: entry.method || null, path: entry.path || null,
        status: entry.status || null, durationMs: entry.durationMs || null, benchmark: entry.benchmark || null,
        request: entry.request && typeof entry.request === 'object' ? { type: entry.request.type || null, actorId: entry.request.actorId || null, targetCount: Array.isArray(entry.request.targetIds) ? entry.request.targetIds.length : null } : null,
        response: entry.response || null, error: entry.error ? { name: entry.error.name, message: entry.error.message } : null,
    }));
    const payload = {
        format: 'reincarnation-vibe-combat-debug', version: 2, exportedAt: new Date().toISOString(),
        battleId, page: { href: location.href, userAgent: navigator.userAgent, viewport: { width: innerWidth, height: innerHeight, devicePixelRatio: devicePixelRatio } },
        client: { activeSessionId: store.activeSession?.id || null, activeBattleId: activeBattleId(), status: combatState?.status || null, version: combatState?.version || null, round: combatState?.round || null, eventHash: combatState?.eventHash || null, visibleEventCount: combatEvents.length },
        clientTrace, backend,
    };
    const file = `轮回战场-战术演算DEBUG-${battleId}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
    const link = document.createElement('a'); link.href = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })); link.download = file; link.click(); URL.revokeObjectURL(link.href);
    await blackbox.record('combat', 'combat_debug_exported', { battleId, file, traceCount: combatDebugTrace.length, backend: Object.fromEntries(Object.entries(backend).map(([key, value]) => [key, value?.error ? { error: value.error.message } : { ok: true }])) }, { sessionId: store.activeSession?.id });
    toast(`战术 DEBUG 已导出：${combatDebugTrace.length} 条记录`, 'success');
}

function combatPromptTraceEvents(events, sessionId) {
    const battleId = combatState?.id || null;
    return (events || []).filter(event => {
        if (sessionId && event.sessionId && event.sessionId !== sessionId) return false;
        if (battleId && event.payload?.battleId && event.payload.battleId !== battleId) return false;
        return ['api', 'turn', 'combat-ai', 'combat-model', 'combat'].includes(event.category)
            && (event.turnId || event.category === 'combat-model' || event.category === 'combat');
    });
}

function pairTraceEvents(events, startCategory, startSuffix, doneCategory, doneSuffix) {
    const starts = events.filter(event => event.category === startCategory && String(event.type).endsWith(startSuffix));
    return starts.map(requestEvent => {
        const responseEvent = events.find(event => event.category === doneCategory && String(event.type).endsWith(doneSuffix) && event.turnId === requestEvent.turnId);
        return { turnId: requestEvent.turnId || null, requestAt: requestEvent.timestamp, responseAt: responseEvent?.timestamp || null, request: requestEvent.payload || {}, response: responseEvent?.payload || null };
    });
}

function buildCombatPromptTrace(events, sessionId) {
    const scoped = combatPromptTraceEvents(events, sessionId);
    const storyPairs = pairTraceEvents(scoped, 'api', 'request_dispatched', 'turn', 'generation_completed');
    const combatPairs = pairTraceEvents(scoped, 'combat-ai', '_started', 'combat-ai', '_completed');
    const protocol = scoped.filter(event => event.category === 'combat-model').map(event => ({ timestamp: event.timestamp, type: event.type, turnId: event.turnId || null, payload: event.payload || {} }));
    const creations = scoped.filter(event => event.category === 'combat' && event.type === 'combat_created').map(event => ({ timestamp: event.timestamp, payload: event.payload || {} }));
    return {
        format: 'reincarnation-combat-prompt-trace', version: 1, readOnly: true, exportedAt: new Date().toISOString(), sessionId: sessionId || null, battleId: combatState?.id || null,
        summary: { storyPairs: storyPairs.length, combatAiPairs: combatPairs.length, protocolEvents: protocol.length, localCreations: creations.length },
        storyAi: storyPairs,
        combatAi: combatPairs,
        protocol,
        localCreations: creations,
        timeline: scoped.map(event => ({ id: event.id || null, timestamp: event.timestamp, category: event.category, type: event.type, turnId: event.turnId || null, payload: event.payload || {} })),
    };
}

async function openCombatPromptTrace() {
    const events = await blackbox.events();
    const trace = buildCombatPromptTrace(events, store.activeSession?.id || null);
    combatPromptTraceCache = trace;
    renderCombatPromptTraceSummary();
    openTextEditor({ title: `只读 Prompt 追踪 · ${trace.battleId || '当前剧情'}`, value: JSON.stringify(trace, null, 2), mode: 'json', readonly: true });
    await blackbox.record('combat', 'prompt_trace_opened', { battleId: combatState?.id || null, summary: trace.summary }, { sessionId: store.activeSession?.id });
}

function renderCombatPromptTraceSummary() {
    const root = $('#combatPromptTraceSummary');
    if (!root) return;
    const summary = combatPromptTraceCache?.summary;
    root.innerHTML = summary
        ? `<b>已整理本场成对记录</b><br>剧情 AI ${summary.storyPairs} 对请求/回复 · 战斗 AI ${summary.combatAiPairs} 对请求/回复 · 协议事件 ${summary.protocolEvents} 条 · 本地创建 ${summary.localCreations} 次<br><code>请求与回复均按 turnId 保持原始顺序；内容仅供只读查看，不会写回。</code>`
        : '点击“用内建编辑器查看”后读取当前会话黑盒，并按 turnId 配对剧情 AI 与战斗 AI 的完整请求/回复。';
}

function defaultEncounter() {
    const stat = runtime.variables.stat_data || {};
    const player = stat['主角'] || {};
    const world = stat['世界'] || {};
    const attrs = player['最终属性'] || {};
    const value = (key, fallback) => Number(attrs[key] ?? player[key]) || fallback;
    // The card's auxiliary MVU script writes the authoritative combat panels
    // under 最终属性.武器.  Never fall back to the raw player.ATK/MATK when an
    // equipped panel exists: raw inventory grades (for example "D"/"E") are
    // not combat numbers and would silently discard the card calculation.
    const weaponPanels = attrs['武器'] && typeof attrs['武器'] === 'object' ? attrs['武器'] : {};
    const equippedNames = inventoryEntries(player['装备'])
        .filter(([, entry]) => inventoryStatus(entry) === 1)
        .map(([name]) => String(name));
    const selectedWeaponName = equippedNames.find(name => weaponPanels[name] && typeof weaponPanels[name] === 'object')
        || (weaponPanels['无武装'] ? '无武装' : Object.keys(weaponPanels).find(name => weaponPanels[name] && typeof weaponPanels[name] === 'object'));
    const selectedWeapon = selectedWeaponName ? weaponPanels[selectedWeaponName] : null;
    const selectedEquipment = selectedWeaponName ? player['装备']?.[selectedWeaponName] : null;
    const weaponIsHybrid = Array.isArray(selectedEquipment?.标签) && selectedEquipment.标签.includes('能量');
    const combatPanelValue = (key, fallback) => {
        const numeric = Number(selectedWeapon?.[key]);
        return Number.isFinite(numeric) ? numeric : value(key, fallback);
    };
    return {
        storySessionId: store.activeSession?.id, mode: $('#combatMode')?.value || 'manual',
        encounter: {
            title: `${world['地点'] || world['名称'] || '未知区域'}遭遇战`, location: world['地点'] || world['名称'] || '当前区域',
            description: '由正文剧情触发的待确认遭遇。可直接编辑敌人、区域与能力。',
            zones: [{ id: 'front', name: '交战前沿', adjacent: ['rear'], capacity: 6 }, { id: 'rear', name: '后方区域', adjacent: ['front'], capacity: 12, cover: 15 }],
            combatants: [
                // The server resolves this snapshot through combat/adapter.js.
                // Do not derive five dimensions locally from ATK or initiative:
                // those are independent MVU results in the card.
                { id: 'protagonist', name: player['姓名'] || store.data.settings.userName || '主角', side: 'player', isPlayer: true, controller: 'player', zoneId: 'front', weaponName: selectedWeaponName || null, mvu: { player: structuredClone(player), selectedWeaponName: selectedWeaponName || null }, baseSpeedMeters: 6, visionMeters: 30, facingDegrees: 0, fovDegrees: 120, abilities: [{ id: 'basic-attack', name: selectedWeaponName ? `${selectedWeaponName}·攻击` : '基础攻击', type: weaponIsHybrid ? 'hybrid' : 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }] },
                { id: 'enemy', name: '敌对实体', side: 'enemy', controller: 'ai', count: 1, hp: 20, maxHp: 20, attack: 8, attackModifier: 3, defenseDC: 10, initiativeDC: 0, armor: 0, radiusMeters: .5, sizeClass: 'medium', zoneId: 'front' },
            ],
        },
    };
}

function isCombatSimulation(state = combatState) {
    return Boolean(state?.transient && state?.simulation?.source === 'combat-simulator');
}

function combatNarrationAlreadyWritten(battleId) {
    const id = String(battleId || '').trim();
    return Boolean(id && store.activeSession?.messages?.some(message => message?.combat?.battleId === id));
}

function updateCombatNarrationControl(state = combatState, simulation = isCombatSimulation(state)) {
    const button = $('#combatNarrateButton');
    const statusNode = $('#combatNarrateStatus');
    if (!button) return;
    const battleId = state?.id || null;
    if (battleId && combatNarrationState.battleId !== battleId) {
        const written = combatNarrationAlreadyWritten(battleId);
        combatNarrationState = { battleId, phase: written ? 'success' : 'idle', detail: written ? '本场结果已写入当前分支' : '' };
    }
    const phase = combatNarrationBusy ? 'running' : combatNarrationState.phase;
    const eligible = Boolean(state && ['paused', 'completed'].includes(state.status));
    const baseText = simulation ? '将模拟测试写回正文 AI' : '生成并写入剧情';
    const labels = {
        running: simulation ? '正在生成模拟剧情…' : '正在生成并写入…',
        success: '已写入当前剧情',
        error: '写入失败，点击重试',
        idle: baseText,
    };
    button.textContent = labels[phase] || baseText;
    button.disabled = combatNarrationBusy || phase === 'success' || !eligible;
    button.dataset.narrationState = phase;
    button.setAttribute('aria-busy', String(combatNarrationBusy));
    button.title = combatNarrationBusy
        ? '正在等待正文 AI，重复点击已锁定。'
        : phase === 'success'
            ? '本场战斗结果已经写入当前剧情分支。'
            : phase === 'error'
                ? `上次写入未完成${combatNarrationState.detail ? `：${combatNarrationState.detail}` : ''}，可点击重试。`
                : simulation
                    ? '显式确认后，才会将这场临时模拟写成战术终端的测试剧情，并写入当前分支。'
                    : '正式暂停点或完成战斗后生成一次剧情融合。';
    if (statusNode) {
        statusNode.className = `combat-narrate-status ${phase}`;
        statusNode.textContent = combatNarrationBusy ? '请求进行中 · 已锁定重复提交' : (combatNarrationState.detail || ({ success: '写入完成', error: '可重试', idle: eligible ? '等待生成' : '暂无可写入结果' }[phase] || ''));
    }
}

function setCombatNarrationState(phase, detail = '') {
    combatNarrationState = { battleId: combatState?.id || combatNarrationState.battleId, phase, detail };
    updateCombatNarrationControl(combatState, isCombatSimulation());
}

/**
 * Release the interactive terminal after a local result has been written to
 * the story.  The append-only combat row and its event ledger remain intact
 * for replay/debug; only the transient UI projection is discarded.  A paused
 * formal battle keeps its active id so the player can resume it later, while a
 * completed battle is detached from the session because it is already closed.
 */
async function cleanCombatTerminalAfterNarration({ battleId, status, messageId, simulation = false } = {}) {
    const session = store.activeSession;
    const completed = status === 'completed';
    const activeBattleCleared = Boolean(!simulation && completed && session?.activeBattleId === battleId);
    try {
        if (activeBattleCleared) {
            session.activeBattleId = null;
            store.save();
        }
        combatState = null;
        combatEvents = [];
        combatMapMenu = null;
        combatMapIntent = null;
        combatMapZoom = 1; combatMapPan = { x: 0, y: 0 };
        combatUnitStrategySelections = {};
        combatSelectedUnitId = null;
        combatEntityInspectorUnitId = null;
        combatPromptTraceCache = null;
        snapCombatFlowPhase();
        pendingCombatScriptReview = null;
        pendingBattleDeclaration = null;
        pendingCombatModel = null;
        combatModelingState = { phase: 'idle', detail: '本场结果已写入剧情；战术终端已清理，可从存档重放。' };
        await blackbox.record('combat', 'combat_clean_completed', {
            battleId: battleId || null,
            status: status || null,
            messageId: messageId || null,
            simulation,
            activeBattleCleared,
            retainedInHistory: Boolean(session?.combatIds?.includes(battleId)),
            reason: 'local_result_written_to_story',
        }, { sessionId: session?.id });
    } catch (error) {
        // Cleaning is deliberately best-effort. The story write and its MVU
        // update are already durable; a diagnostic failure must not turn a
        // successful narration into a duplicate/retry prompt.
        await blackbox.record('combat', 'combat_clean_failed', {
            battleId: battleId || null,
            status: status || null,
            messageId: messageId || null,
            simulation,
            error,
        }, { sessionId: session?.id });
    }
}

function combatNumber(value, fallback, minimum = 0) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? Math.max(minimum, numeric) : fallback;
}

function simulatorHero() {
    const hero = structuredClone(defaultEncounter().encounter.combatants[0]);
    const mvuPlayer = hero.mvu?.player || {};
    const final = mvuPlayer['最终属性'] || {};
    const selectedWeapon = final['武器']?.[hero.mvu?.selectedWeaponName] || final['武器']?.['无武装'] || {};
    const panel = (key, fallback = 0) => {
        const numeric = Number(final[key] ?? mvuPlayer[key]);
        return Number.isFinite(numeric) ? numeric : fallback;
    };
    hero.id = 'simulator-protagonist';
    hero.templateId = 'simulator-protagonist';
    hero.controller = 'player';
    hero.hp = combatNumber(mvuPlayer.HP, 20, 1);
    hero.maxHp = Math.max(hero.hp, combatNumber(mvuPlayer.HP_MAX, hero.hp, 1));
    hero.ep = combatNumber(mvuPlayer.EP, 0, 0);
    hero.maxEp = Math.max(hero.ep, combatNumber(mvuPlayer.EP_MAX, hero.ep, 0));
    hero.attack = combatNumber(selectedWeapon.ATK ?? final.ATK, 10, 1);
    hero.magicAttack = combatNumber(selectedWeapon.MATK ?? final.MATK, 10, 1);
    hero.attackModifier = combatNumber(final['攻击修正'] ?? panel('力量修正'), 0);
    hero.defenseDC = combatNumber(panel('防御DC'), 0, 0);
    hero.initiativeDC = combatNumber(panel('先攻DC'), 0);
    hero.armor = combatNumber(panel('物理减伤率'), 0, 0);
    hero.resistance = combatNumber(panel('魔法减伤率'), 0, 0);
    hero.radiusMeters = .5;
    hero.baseSpeedMeters = 6;
    hero.speedMeters = 6;
    // Keep the character's own sensory baseline when it is present in the
    // loaded card/session.  The fallback is deliberately generous enough for
    // the simulator to be an encounter test rather than a silent stalemate.
    hero.visionMeters = combatNumber(hero.visionMeters, 30, 1);
    hero.facingDegrees = 0;
    hero.fovDegrees = 120;
    hero.position = { x: -20, y: 0 };
    hero.attributes = {
        strengthModifier: combatNumber(panel('力量修正'), 0), dexterityModifier: combatNumber(panel('敏捷修正'), 0),
        constitutionModifier: combatNumber(panel('体质修正'), 0), spiritModifier: combatNumber(panel('精神修正'), 0), charismaModifier: combatNumber(panel('魅力修正'), 0),
    };
    hero.intelProfile = { presence: 'cautious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 28, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 7, attackNoiseMeters: 32 };
    hero.tacticalProfile = { archetype: 'squad', groupId: 'simulator-player', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 18 };
    return hero;
}

function simulationEnemyFromHero(hero, id, name, levelOffset = 0, extra = {}) {
    // The card does not define a universal life-level-to-stat conversion.
    // These are clearly labelled pressure samples for engine verification only;
    // they never feed a numeric conversion back into stat_data. Their exact
    // inputs only reach the story model after an explicit test-story writeback.
    const factor = levelOffset <= 0 ? 1 : 1 + levelOffset * 0.7;
    const hpFactor = levelOffset <= 0 ? 1 : 1 + levelOffset * 2.5;
    // Same-tier simulator hostiles use the formal V3.2.6 baseline used by the
    // saved-client regression (zombie ATK 9 / MATK 2 / attack modifier 5).
    // They must not inherit the player's weapon ATK; doing so made a level-I
    // zombie deal the protagonist's 37+ damage in the simulator.
    const baseline = { attack: 9, magicAttack: 2, attackModifier: 5, defenseDC: 10, initiativeDC: 9, armor: 0, resistance: 0 };
    return {
        id, templateId: id, name, side: 'enemy', controller: 'ai', count: 1,
        hp: Math.max(1, Math.round(hero.maxHp * hpFactor)), maxHp: Math.max(1, Math.round(hero.maxHp * hpFactor)),
        ep: Math.max(0, Math.round(hero.maxEp * factor)), maxEp: Math.max(0, Math.round(hero.maxEp * factor)),
        attack: Math.max(1, Math.round(baseline.attack * factor)), magicAttack: Math.max(1, Math.round(baseline.magicAttack * factor)),
        attackModifier: Math.round(baseline.attackModifier + levelOffset * 9), defenseDC: Math.round(baseline.defenseDC + levelOffset * 16),
        initiativeDC: Math.round(baseline.initiativeDC + levelOffset * 7), armor: Math.min(90, Math.round(baseline.armor + levelOffset * 10)),
        resistance: Math.min(90, Math.round(baseline.resistance + levelOffset * 10)), zoneId: 'field',
        radiusMeters: .5, speedMeters: 6, visionMeters: 50, facingDegrees: 180, fovDegrees: 120, position: { x: 14, y: 0 },
        attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 },
        intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 25, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 },
        tacticalProfile: { archetype: 'scattered', groupId: id, objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 },
        ...extra,
    };
}

function buildCombatSimulatorScenario(scenarioId) {
    const hero = simulatorHero();
    const stat = runtime.variables.stat_data || {};
    const player = stat['主角'] || {};
    const currentTier = heroLifeLevel(player);
    const bossTier = Math.min(9, currentTier + 2);
    const base = {
        transient: true,
        storySessionId: null,
        mode: store.data.settings.combatModePreference || $('#combatMode')?.value || 'manual',
        seed: `combat-simulator:${scenarioId}:v2`,
        simulation: { source: 'combat-simulator', scenarioId, currentLifeLevel: lifeLevelRoman(currentTier), targetLifeLevel: lifeLevelRoman(bossTier), ruleset: 'local-authority-v2-2d' },
    };
    const battlefield = { shape: 'rectangle', name: '标准二维测试场', widthMeters: 70, heightMeters: 50, center: { x: 0, y: 0 } };
    if (scenarioId === 'same-tier-horde') {
        const zombieAnchorX = hero.position.x + Math.max(8, Math.min(18, Number(hero.visionMeters || 30) * .55));
        return {
        ...base,
        simulation: { ...base.simulation, label: '本能丧尸群 · 1 对 100' },
        encounter: { title: '模拟器 · 本能丧尸群 1 对 100', location: '压力测试场 · 开阔地', description: '同级基准来自当前主角战斗面板。一百个独立丧尸只凭自身视觉、听觉搜寻；每个单位每回合最多面对八个近战攻击者，不修改任何 MVU 数值。它们以散落无规章的螺旋散布，而不是队列或军团方阵。', battlefield, combatants: [hero, simulationEnemyFromHero(hero, 'sim-same-tier-hostile', '本能丧尸', 0, { count: 100, position: { x: zombieAnchorX, y: hero.position.y }, distribution: { style: 'scattered', radiusMeters: 16, spacingMeters: 1.25, jitterMeters: 1.2 }, tacticalProfile: { archetype: 'scattered', groupId: 'sim-zombies', objective: 'search', focusRule: 'nearest', coordinationRadiusMeters: 0 } })] },
        };
    }
    if (scenarioId === 'two-tier-boss') return {
        ...base,
        simulation: { ...base.simulation, label: `高二生命层级 BOSS · ${lifeLevelRoman(currentTier)} → ${lifeLevelRoman(bossTier)}` },
        encounter: { title: `模拟器 · 高二生命层级 BOSS（${lifeLevelRoman(bossTier)}）`, location: '压力测试场 · 首领区', description: '这是以当前主角为参照的两层生命层级压力样本；层级标签用于场景说明，不会回写属性或模型提示词。', battlefield, combatants: [hero, simulationEnemyFromHero(hero, 'sim-two-tier-boss', `生命层级 ${lifeLevelRoman(bossTier)} BOSS`, 2, { boss: true, phases: [70, 40, 15], position: { x: 14, y: 0 } })] },
    };
    if (scenarioId === 'boss-with-minions') return {
        ...base,
        simulation: { ...base.simulation, label: `高二生命层级 BOSS ＋ 同级随从 · ${lifeLevelRoman(currentTier)} → ${lifeLevelRoman(bossTier)}` },
        encounter: { title: `模拟器 · ${lifeLevelRoman(bossTier)} BOSS ＋ 同级随从`, location: '压力测试场 · 复合战区', description: '首领与同级随从的混合战样本，用于检验集火、阶段事件和群组账本。该结果仅在明确导入剧情后才影响主线。', battlefield, combatants: [hero, simulationEnemyFromHero(hero, 'sim-command-boss', `生命层级 ${lifeLevelRoman(bossTier)} BOSS`, 2, { boss: true, phases: [70, 40, 15], position: { x: 15, y: 7 } }), simulationEnemyFromHero(hero, 'sim-same-tier-minion', '同级随从', 0, { count: 12, position: { x: 13, y: -9 } })] },
    };
    if (scenarioId === 'goblin-squad') return {
        ...base,
        simulation: { ...base.simulation, label: '哥布林小队 · 共享视野与协同集火' },
        encounter: { title: '模拟器 · 哥布林小队', location: '压力测试场 · 楔形小队', description: '十二名哥布林以有限协同半径共享目击情报，按楔形小队推进，并偏好攻击最虚弱的已发现目标。', battlefield, combatants: [hero, simulationEnemyFromHero(hero, 'sim-goblin-squad', '战术哥布林', 0, { count: 12, position: { x: 14, y: 0 }, distribution: { style: 'wedge', spacingMeters: 1.5, jitterMeters: .25 }, intelProfile: { presence: 'cautious', stealthBonus: 2, perceptionBonus: 3, commandBonus: 3, hearingMeters: 26, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 7, attackNoiseMeters: 28 }, tacticalProfile: { archetype: 'squad', groupId: 'sim-goblins', objective: 'engage', focusRule: 'weakest', coordinationRadiusMeters: 18 } })] },
    };
    if (scenarioId === 'hive-machines') return {
        ...base,
        simulation: { ...base.simulation, label: '格式塔机械体 · 全群情报同步' },
        encounter: { title: '模拟器 · 格式塔机械体巡逻群', location: '压力测试场 · 网格扫描区', description: '任一机械体确认目标，格式塔即向所有节点同步；其节点以环形巡逻间距展开，远距情报能力只提供发现，不直接造成伤害。', battlefield, combatants: [hero, simulationEnemyFromHero(hero, 'sim-hive-machines', '格式塔机械体', 0, { count: 12, position: { x: 14, y: 0 }, distribution: { style: 'ring', radiusMeters: 8, spacingMeters: 2 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 7, commandBonus: 0, hearingMeters: 30, intelligenceRangeMeters: 45, intelligenceBonus: 12, movementNoiseMeters: 9, attackNoiseMeters: 24 }, tacticalProfile: { archetype: 'hive', groupId: 'sim-machine-hive', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 1000 } })] },
    };
    throw new Error('未知模拟器场景');
}

async function createCombatSimulatorScenario(scenarioId) {
    if (combatBusy) return;
    // Capture the selector before rendering the previous (possibly completed)
    // simulation.  renderCombat synchronizes controls from that old state;
    // reading after it would silently turn a newly selected manual run back
    // into the previous auto mode.
    const selectedMode = $('#combatMode')?.value || store.data.settings.combatModePreference || 'manual';
    const payload = buildCombatSimulatorScenario(scenarioId);
    payload.mode = ['manual', 'semi', 'auto'].includes(selectedMode) ? selectedMode : 'manual';
    combatBusy = true; renderCombat();
    try {
        combatSimulatorPickerOpen = false;
        combatState = await combatRequest('/sessions', { method: 'POST', body: JSON.stringify(payload) });
        combatEvents = (await combatRequest(`/${combatState.id}/events`)).events || [];
        pendingCombatScriptReview = null;
        // Loading a sample must be enough to enter a usable battlefield.  In
        // manual/semi it pauses on the first controllable turn; in auto it
        // runs straight to a reproducible result.
        combatBusy = false;
        await mutateCombat('start', { mode: payload.mode });
        requestAnimationFrame(() => requestAnimationFrame(() => $('#combatZones')?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
        toast(payload.mode === 'auto' ? '模拟器已启动并完成本地自动演算。' : '模拟器已启动，已定位到二维战场；请在地图上继续操作。', 'success');
    } finally { combatBusy = false; renderCombat(); }
}

function combatConnection() {
    const id = aiConnectionId('combat') || store.data.settings.activeCombatConnectionId || store.data.settings.activeConnectionId;
    return store.data.connections.find(item => item.id === id) || null;
}

function combatPreset() {
    const id = store.data.settings.activeCombatPresetId || store.data.settings.activePresetId;
    return presets.find(item => item.id === id) || null;
}

function extractJsonObject(text) {
    const source = String(text || '').replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    try { return JSON.parse(source); } catch {}
    // Models occasionally prepend a short sentence or append a second
    // fenced block.  Using first-{ / last-} used to combine unrelated JSON
    // and turn an otherwise recoverable response into a parse failure.  Scan
    // balanced objects instead, respecting quoted braces and escapes, and
    // try each complete candidate from left to right.
    for (let start = source.indexOf('{'); start >= 0; start = source.indexOf('{', start + 1)) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let index = start; index < source.length; index += 1) {
            const char = source[index];
            if (inString) {
                if (escaped) escaped = false;
                else if (char === '\\') escaped = true;
                else if (char === '"') inString = false;
                continue;
            }
            if (char === '"') { inString = true; continue; }
            if (char === '{') depth += 1;
            else if (char === '}') {
                depth -= 1;
                if (depth === 0) {
                    try {
                        const parsed = JSON.parse(source.slice(start, index + 1));
                        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
                    } catch {}
                    break;
                }
            }
        }
    }
    throw new Error('战斗 AI 未返回合法 JSON 对象');
}

// Recognition responses are commonly wrapped by an AIRP/OAI preset (for
// example {"BattleDeclaration": {...}}, {"declaration": {...}}, or a
// provider envelope containing `data`).  The local validator must receive the
// declaration object itself, but it must never invent missing fields.  Keep
// this unwrapping deliberately narrow and bounded so an unrelated story JSON
// object still fails with the real validation report.
function unwrapBattleDeclarationObject(value, path = '$', depth = 0) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || depth > 3) return { value, path };
    const declarationKeys = ['BattleDeclaration', 'battleDeclaration', 'battle_declaration', 'declaration'];
    const preferred = declarationKeys.find(key => value[key] && typeof value[key] === 'object' && !Array.isArray(value[key]));
    if (preferred) return unwrapBattleDeclarationObject(value[preferred], `${path}.${preferred}`, depth + 1);
    // Some OpenAI-compatible gateways return { data: { result: {...} } }.
    for (const key of ['result', 'output', 'data', 'response', 'content']) {
        const nested = value[key];
        if (!nested || typeof nested !== 'object' || Array.isArray(nested)) continue;
        const candidate = unwrapBattleDeclarationObject(nested, `${path}.${key}`, depth + 1);
        if (candidate.value && typeof candidate.value === 'object' && (candidate.value.reason || candidate.value.battlefield || candidate.value.participants)) return candidate;
    }
    return { value, path };
}

function parseBattleDeclarationResponse(content) {
    const raw = String(content || '').trim();
    const tagged = battleDeclarationFromMessage(raw);
    if (tagged?.error) throw new Error(tagged.error);
    if (tagged?.declaration) return { declaration: tagged.declaration, source: 'BattleDeclaration-tag', path: '$.BattleDeclaration', raw };
    const parsed = extractJsonObject(raw);
    const unwrapped = unwrapBattleDeclarationObject(parsed);
    return { declaration: unwrapped.value, source: unwrapped.path === '$' ? 'json' : 'json-envelope', path: unwrapped.path, raw };
}

function combatRecognitionPrompt() {
    return '你是人工触发的战场声明草拟器。根据给出的真实剧情与 MVU，只输出一个完整的 BattleDeclaration JSON 对象本身，不要输出 Markdown、解释、剧情正文、XML 标签或外层包装（不得写成 {"BattleDeclaration": {...}}）。对象必须包含 schema:"vibe-combat-declaration/v3"、worldLifeLevel（从 MVU 主角层级读罗马数字 Ⅰ–Ⅸ）、contactEstablished（战斗已开始则 true）、contactPairs（已接触的实体 ID 二元数组）、reason、battlefield(kind/shapeHint/description)、participants；participants 至少包含一名 side=player 和一名 side=enemy。【硬性必填】每个 participant 都必须有 id/name/count/side/source/state/relativePosition，其中 state 是单个普通字符串，描述该实体的大致状态、装备或威胁印象，绝不可省略、禁止写成对象或填 HP/EP 数值；source=existing 的 participant 必须填写 reference（引用 MVU 已有实体的准确名称，如“主角”或关系列表成员，不要带 / 路径前缀）。【枚举硬规则】shapeHint 只能填英文 rectangle/circle/unknown；source 只能填英文 existing/create（禁止 new、已有、player、enemy 等）。【玩家额外需求】若输入包含 playerRequirements 字段，把它视为玩家对本场遭遇的硬性偏好（例如更大的战场规模、夜战或雨天、狭窄地形、需要强调的战场设定或敌人特征），必须体现在 battlefield 尺寸与描述、participants 状态描述中；与剧情事实冲突而确实无法满足时保持声明合法，不要编造。【禁止】不得计算或恢复任何战斗结果，不得输出 Step.4、CheckResult、命中、伤害、死亡、残余数量、HP/EP、坐标或 JSONPatch。';
}

function battleDeclarationFromMessage(content) {
    const match = String(content || '').match(/<BattleDeclaration\b[^>]*>([\s\S]*?)<\/BattleDeclaration\s*>/i);
    if (!match) return null;
    const raw = match[1].trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    try { return { declaration: JSON.parse(raw), raw }; }
    catch (error) { return { error: `BattleDeclaration 不是合法 JSON：${error.message}`, raw }; }
}

function battleHandoffFromMessage(content) {
    const match = String(content || '').match(/<BattleHandoff\b([^>]*)>([\s\S]*?)<\/BattleHandoff\s*>/i);
    if (!match) return null;
    const attributes = Object.fromEntries([...match[1].matchAll(/([\w:-]+)\s*=\s*["']([^"']*)["']/g)].map(item => [item[1], item[2]]));
    return { status: String(match[2] || '').trim().toUpperCase(), ...attributes };
}

function deferLocalCombatPatch(content) {
    const source = String(content || '');
    const match = source.match(/<JSONPatch>\s*([\s\S]*?)\s*<\/JSONPatch>/i);
    if (!match) return null;
    let operations;
    try { operations = JSON.parse(match[1]); }
    catch { return null; }
    if (!Array.isArray(operations)) return null;
    const pathOf = operation => [operation?.path, operation?.from, operation?.to].filter(Boolean).map(String).join(' ');
    const isCombatStatePath = operation => /(?:^|\/)(?:主角|关系列表|系统状态|任务)(?:\/|$)/.test(pathOf(operation));
    const deferredOperations = operations.filter(isCombatStatePath);
    if (!deferredOperations.length) return { sanitizedContent: source, operations, deferredOperations: [] };
    const allowedOperations = operations.filter(operation => !isCombatStatePath(operation));
    const sanitizedContent = source.slice(0, match.index) + `<JSONPatch>\n${JSON.stringify(allowedOperations)}\n</JSONPatch>` + source.slice(match.index + match[0].length);
    return { sanitizedContent, operations, deferredOperations };
}

function normalizeBattleDeclarationCompatibility(declaration) {
    const normalized = structuredClone(declaration || {});
    const player = runtime.variables?.stat_data?.['主角'] || {};
    const playerName = String(player['姓名'] || store.data.settings.userName || '主角').trim() || '主角';
    const relationNames = new Set(Object.keys(runtime.variables?.stat_data?.['关系列表'] || {}).map(String));
    const repairs = [];
    // The strict model hand-off requires the declaration to carry the protocol
    // contract (schema/worldLifeLevel/contactEstablished/contactPairs) so the
    // modeler can copy it verbatim.  Manual recognition drafts routinely omit
    // them; seed the missing fields from the authoritative MVU instead of
    // letting the modeler guess values that would fail strict preservation.
    if (normalized.schema === undefined) { normalized.schema = 'vibe-combat-declaration/v3'; repairs.push({ repair: 'declaration_schema_seeded', to: normalized.schema }); }
    if (normalized.worldLifeLevel === undefined) {
        const lifeLevel = String(player['层级'] || 'Ⅰ').trim() || 'Ⅰ';
        normalized.worldLifeLevel = lifeLevel;
        repairs.push({ repair: 'world_life_level_seeded', to: lifeLevel });
    }
    if (normalized.contactEstablished === undefined) { normalized.contactEstablished = true; repairs.push({ repair: 'contact_established_seeded', to: true }); }
    if (!Array.isArray(normalized.contactPairs)) {
        const playerIds = (normalized.participants || []).filter(item => item?.side === 'player').map(item => item?.id).filter(Boolean);
        const enemyIds = (normalized.participants || []).filter(item => item?.side === 'enemy').map(item => item?.id).filter(Boolean);
        const pairs = [];
        for (const a of playerIds) for (const b of enemyIds) pairs.push([a, b]);
        normalized.contactPairs = pairs;
        repairs.push({ repair: 'contact_pairs_seeded', pairs });
    }
    if (normalized.battlefield && typeof normalized.battlefield === 'object') {
        const legacyShape = String(normalized.battlefield.shapeHint || '').toLowerCase();
        if (['line', 'square', 'free', 'open'].includes(legacyShape)) {
            normalized.battlefield.shapeHint = legacyShape === 'open' ? 'circle' : 'rectangle';
            repairs.push({ repair: 'legacy_shape_to_supported_v3', from: legacyShape, to: normalized.battlefield.shapeHint });
        } else if (normalized.battlefield.shapeHint && !['rectangle', 'circle', 'unknown'].includes(normalized.battlefield.shapeHint)) {
            // The story model writes shapeHint as a Chinese description sentence
            // instead of the closed enum.  shapeHint is a constrained hint (the
            // modeler decides exact geometry), so coerce it to a valid enum.
            const rawHint = String(normalized.battlefield.shapeHint).trim();
            const hintMap = {
                rectangle: 'rectangle', rect: 'rectangle', 矩形: 'rectangle', 长方形: 'rectangle', 方形: 'rectangle', 正方: 'rectangle', 走廊: 'rectangle', 巷道: 'rectangle', 街道: 'rectangle', 建筑: 'rectangle', 室内: 'rectangle', 隧道: 'rectangle', 房间: 'rectangle', 通道: 'rectangle',
                circle: 'circle', circular: 'circle', 圆形: 'circle', 环形: 'circle', 圆: 'circle', 空地: 'circle', 空旷: 'circle', 广场: 'circle', 露天: 'circle', 台地: 'circle', 草地: 'circle', 洞穴: 'circle', 大厅: 'circle',
                unknown: 'unknown', 未知: 'unknown', 不确定: 'unknown',
            };
            let mapped = hintMap[rawHint.toLowerCase()] || null;
            if (!mapped) {
                if (/圆|环形|空地|广场|开阔|露天|台地|草地|洞|岩石|废墟/.test(rawHint)) mapped = 'circle';
                else if (/方|矩形|走廊|巷道|建筑|室内|隧道|房间|通道|街道|狭/.test(rawHint)) mapped = 'rectangle';
                else mapped = 'unknown';
            }
            repairs.push({ repair: 'shape_hint_coerced_to_enum', from: normalized.battlefield.shapeHint, to: mapped });
            normalized.battlefield.shapeHint = mapped;
        }
        if (!normalized.battlefield.kind && typeof normalized.battlefield.kind !== 'string') {
            const desc = String(normalized.battlefield.description || normalized.battlefield.name || normalized.battlefield.environment || '');
            let kind = '未知地形';
            if (/建筑|室内|走廊|房间|隧道|大厅|地下|遗迹内|酒馆|屋|房|库/.test(desc)) kind = '建筑内部';
            else if (/街|巷|道路|广场|集市/.test(desc)) kind = '街道';
            else if (/森林|林|树|灌木/.test(desc)) kind = '森林';
            else if (/空|开阔|草地|平原|台地|荒野|洞|岩石|废墟|遗迹外|山|坡/.test(desc)) kind = '空旷地';
            normalized.battlefield.kind = kind;
            repairs.push({ repair: 'battlefield_kind_derived', from: null, to: kind });
        }
    }
    if (Array.isArray(normalized.participants)) {
        for (const participant of normalized.participants) {
            // Strip path prefixes from references (/主角, /关系列表/xxx) before
            // any relation matching so the MVU name lookup succeeds.
            if (participant?.reference && typeof participant.reference === 'string') {
                const cleaned = String(participant.reference).trim().replace(/^\/+/, '').replace(/^关系列表[\/]/, '').trim();
                if (cleaned !== participant.reference) {
                    repairs.push({ participantId: participant.id || null, repair: 'reference_path_prefix_stripped', from: participant.reference, to: cleaned });
                    participant.reference = cleaned;
                }
            }
            // The story model writes state as an object ({"HP":..,"buffs":[]}
            // or {"reference":"/主角"}).  state must be a plain string and the
            // reference must sit on participant.reference.
            if (participant?.state && typeof participant.state === 'object' && !Array.isArray(participant.state)) {
                const hiddenReference = participant.state.reference;
                if (typeof hiddenReference === 'string' && hiddenReference.trim() && !participant.reference) {
                    participant.reference = String(hiddenReference).trim().replace(/^\/+/, '').replace(/^关系列表[\/]/, '').trim();
                    repairs.push({ participantId: participant.id || null, repair: 'reference_extracted_from_state', reference: participant.reference });
                }
                const base = participant.name || participant.role || participant.intent || '未知实体';
                participant.state = `${base}：交战状态（具体以本地演算为准）`;
                repairs.push({ participantId: participant.id || null, repair: 'state_object_coerced_to_text' });
            }
            // source is a closed enum; coerce new/中文/player/enemy aliases.
            const rawSource = String(participant?.source ?? '').trim().toLowerCase();
            if (rawSource && !['existing', 'create'].includes(rawSource)) {
                const sourceMap = {
                    existing: 'existing', 已有: 'existing', 现有: 'existing', 原有: 'existing', 原有实体: 'existing', 原: 'existing', 原有人物: 'existing', 已有实体: 'existing', player: 'existing', 玩家: 'existing', 主角: 'existing', 己方: 'existing',
                    create: 'create', new: 'create', 新建: 'create', 新建实体: 'create', 新: 'create', 新造: 'create', 生成: 'create', 召唤: 'create', enemy: 'create', 敌人: 'create', 敌方: 'create',
                };
                let mapped = sourceMap[rawSource];
                if (!mapped && participant?.side === 'player') mapped = 'existing';
                if (!mapped && participant?.side === 'enemy') mapped = 'create';
                if (mapped) {
                    repairs.push({ participantId: participant.id || null, repair: 'source_coerced_to_enum', from: participant.source, to: mapped });
                    participant.source = mapped;
                }
            }
            // The story model occasionally labels the already-existing
            // protagonist as source=create (the live floor-4 replay did this
            // with "Alice").  Do not let that cosmetic identity error block
            // the entire combat pipeline: the local MVU snapshot is the
            // authority for the player entity, not the model's label.
            if (participant?.side === 'player' && participant.source === 'create') {
                participant.source = 'existing';
                participant.reference = participant.reference || playerName || '主角';
                participant.name = participant.name || playerName;
                repairs.push({ participantId: participant.id || null, repair: 'player_create_to_existing', reference: participant.reference });
            }
            if (participant?.side !== 'player' && participant?.source === 'existing') {
                const reference = String(participant.reference || '').replace(/^关系列表[\\/]/, '').trim();
                if (!reference || !relationNames.has(reference)) {
                    participant.source = 'create';
                    delete participant.reference;
                    repairs.push({ participantId: participant.id || null, repair: 'missing_relation_existing_to_create', reference: reference || null });
                }
            }
        }
    }
    return { declaration: normalized, repairs };
}

function assetFingerprint(kind, name, entry) {
    const clone = structuredClone(entry || {});
    delete clone['战斗资产ID'];
    delete clone['战斗资产指纹'];
    return `${kind}:${name}:${JSON.stringify(clone)}`;
}

// Explicit phase protocol: the model must hand off before any combat roll.
function battleDeclarationInstruction() {
    return `【战斗握手协议 v3】本轮剧情需要数值回合制战斗，你必须：1) 先写一小段正文；2) 随后只输出一个 <BattleDeclaration> JSON 机器块；3) 再输出 <BattleHandoff>LOCAL_COMBAT_REQUIRED</BattleHandoff> 并立即停止，不得续写战斗正文或结算。

【participants 硬性必填——缺一项即整体校验失败】
- 必须输出 <BattleDeclaration> 与 </BattleDeclaration> 标签包裹 JSON 机器块，标签缺失、JSON 未闭合或不是合法 JSON 都会导致整场校验失败；
- 每个 participant 都必须填写 state（战斗开始前的大致状态：姿态、装备、威胁印象），即使没把握也要写一句简短印象，禁止省略；
- source 为 "existing" 的 participant 必须填写 reference（引用 MVU 中已有实体的准确名称：主角或关系列表里的名字）；
- 每个 participant 都必须填写 id/name/count/side/source/state/relativePosition 与 lifeLevel；
- participants 至少包含一名 side=player 和一名 side=enemy；
- 非敌方（side=player 或 neutral）且 source=create 的 participant 必须额外写明 intent 或 role（行为意图或角色）。

【字段类型与取值硬规则——写错一项即整体校验失败】
- shapeHint 是枚举字段，只能填英文 rectangle、circle、unknown 三个值之一（分别对应长方形/矩形、圆形、未知）。禁止写中文，禁止写描述性句子；空间描述一律写进 battlefield.description。
- source 是枚举字段，只能填英文 existing 或 create 两个值之一：existing=引用 MVU 已有实体（必须写 reference）；create=本场新建实体。禁止写 new、已有、新建、player、enemy、npc 等其他值；英文 new 一律改成 create。
- state 必须是单个普通字符串（如 "手持长枪戒备"）。禁止把 state 写成 JSON 对象，禁止在 state 里填 HP、EP、buffs 等数值字段（数值由本地引擎裁定）；reference 不得放在 state 里，必须直接写在 participant.reference。
- reference 直接写实体名称本身（"主角"、"阿尔托莉雅·潘德拉贡(Lancer)"），不要带任何路径前缀（禁止 "/主角"、"/关系列表/xxx"）。
- battlefield 必须填写 kind（笼统场景类型，如 建筑内部/空旷地/街道/森林/洞穴），shapeHint 另填枚举值，两者是不同字段。

【最小合法示例——请严格照此形态输出，不得省略 state / reference】
{"schema":"vibe-combat-declaration/v3","worldLifeLevel":"Ⅰ","contactEstablished":true,"contactPairs":[["alice","goblin_1"]],"reason":"哥布林伏击","battlefield":{"kind":"森林空地","shapeHint":"circle","description":"被树根环绕的开阔地"},"participants":[
  {"id":"alice","name":"主角","count":1,"side":"player","source":"existing","reference":"主角","state":"手持长枪戒备，盾牌前举","lifeLevel":"Ⅰ","attributeQualities":{"strengthModifier":"C","dexterityModifier":"B","constitutionModifier":"C","spiritModifier":"B","charismaModifier":"C"},"relativePosition":"中心","distribution":{"style":"scattered","radiusMeters":0,"spacingMeters":0,"jitterMeters":0,"orientationDegrees":0}},
  {"id":"goblin_1","name":"哥布林斥候","count":3,"side":"enemy","source":"create","state":"弯着腰从树后逼近，举着短刀","lifeLevel":"Ⅰ","attributeQualities":{"strengthModifier":"E","dexterityModifier":"D","constitutionModifier":"E","spiritModifier":"E","charismaModifier":"E"},"relativePosition":"北侧二十米树丛","distribution":{"style":"scattered","radiusMeters":3,"spacingMeters":1.5,"jitterMeters":0.5,"orientationDegrees":0}}
]}

【完整字段参考】
{"schema":"vibe-combat-declaration/v3","worldLifeLevel":"Ⅰ","contactEstablished":true,"contactPairs":[["player-id","enemy-id"]],"reason":"冲突/任务","battlefield":{"kind":"建筑内部/空旷地等笼统场景","shapeHint":"rectangle|circle|unknown","description":"简短空间印象"},"participants":[{"id":"稳定英文或拼音ID","name":"名称","count":1,"side":"player|enemy|neutral","source":"existing|create","reference":"existing 必须引用 MVU 名称，create 省略","state":"必须填写：战斗开始前的大致状态、装备或威胁印象","lifeLevel":"Ⅰ","attributeQualities":{"strengthModifier":"F","dexterityModifier":"F","constitutionModifier":"F","spiritModifier":"F","charismaModifier":"F"},"relativePosition":"相对主控角色的方位、模糊距离或敌群分布","distribution":{"style":"scattered|squad|legion|line|ring|wedge|grid","radiusMeters":12,"spacingMeters":1.2,"jitterMeters":0.5,"orientationDegrees":0}}]}

【校验规则】
- worldLifeLevel 与每个 lifeLevel 必须填写一个明确的罗马数字 Ⅰ、Ⅱ、Ⅲ、Ⅳ、Ⅴ、Ⅵ、Ⅶ、Ⅷ 或 Ⅸ，不要输出范围；attributeQualities 五维分别填写 F/E/D/C/B/A/S/SS/SSS 的品质字母，不要把两套概念机械等号。
- contactEstablished 是已经点亮的关键旗标：本轮剧情中直接对话、互相看见或明确交战的敌我实体必须为 true，并用 contactPairs 精确列出已接触的 ID；未知/潜伏才为 false。它会被本地引擎种入双方情报账本，不能让已经对话的单位在切换终端时突然互相找不到。
- distribution 的 rows/columns 只有 grid 阵型需要填写；scattered 表示丧尸等无规章散落，squad/wedge 表示哥布林小队，legion/grid 才能使用整齐军团。
- create 实体只描述身份、数量、生命层级、五维品质、装备/威胁印象和行为意图，不得填写坐标、HP、EP、攻击、防御、技能数值、命中、伤害、死亡或胜负；create 且非敌方（side=player 或 neutral）的实体必须填写 intent 或 role。
- worldLifeLevel 与每个参战者的 lifeLevel/五维品质是叙事事实，不是数值战斗结果，必须从世界生命等级和原卡流程认真声明。

【禁止】在 <BattleDeclaration> 块之外输出 dm_think、Step.4/Step.5、D100、先攻、CheckResult、攻击、命中、伤害、死亡、残余数量、HP/EP 变化、战斗轮次、战斗 JSONPatch 或战斗正文；尤其不要在隐藏思考中先算战斗数值。若全局格式强制要求 UpdateVariable，只能输出空 JSONPatch []。本地战斗完成后系统会把不可变 <BattleResultOutline> 放入下一轮上下文，只有收到该大纲后才允许续写正文，不得重新计算或否定大纲。`;
}
function localCombatAuthorityInstruction() { return `【VIBE COMBAT 权威顺序】原卡 DND/正文检定算法继续用于未进入本地战斗的普通剧情。进入本地战斗后分三个阶段：正文 AI 只声明参战者和空间意图；本地 Vibe Combat 独占数字化建模、先攻、发现、移动、命中、伤害、资源、死亡和胜负；正文 AI 只读取 BattleResultOutline 并转写剧情。两种算法可以共存，但不得在同一阶段重复计算。正文 AI 在 BattleDeclaration 或 BattleResultOutline 之前没有权限生成战斗结果，也没有权限用 JSONPatch 写入本地战斗事实。`; }

async function ensureCombatAssetContext() {
    const variables = structuredClone(runtime.variables);
    const player = variables.stat_data?.['主角'] || {};
    const assets = [];
    let changed = false;
    const collect = (collection, kind, tacticalOnly = false) => {
        for (const [name, entry] of inventoryEntries(collection)) {
            if (!entry || typeof entry !== 'object') continue;
            if (tacticalOnly && inventoryStatus(entry) !== 1) continue;
            if (!entry['战斗资产ID']) { entry['战斗资产ID'] = `asset-${crypto.randomUUID()}`; changed = true; }
            const fingerprint = assetFingerprint(kind, name, entry);
            if (entry['战斗资产指纹'] !== fingerprint) { entry['战斗资产指纹'] = fingerprint; changed = true; }
            assets.push({ assetId: entry['战斗资产ID'], fingerprint, kind, name, description: String(entry['描述'] || entry['效果说明'] || ''), attributes: entry['原始属性'] || entry['属性'] || {}, finalAttributes: entry['真属性'] || entry['最终属性'] || {}, effects: entry['效果'] || {}, consume: entry['消耗'] || '', tags: entry['标签'] || [] });
        }
    };
    collect(player['装备'], 'equipment', true);
    collect(player['道具'], 'item', true);
    collect(player['技能'], 'skill', false);
    // Existing NPC/ally entities can carry their own combat assets.  They
    // must enter the same immutable requiredAssets list as the protagonist;
    // otherwise reusing an NPC's local asset ID would be rejected later as an
    // unknown binding and the model would silently fall back to AI numbers.
    for (const entity of Object.values(variables.stat_data?.['关系列表'] || {})) {
        if (!entity || entity['在场'] === false) continue;
        collect(entity['装备'], 'equipment', true);
        collect(entity['道具'], 'item', true);
        collect(entity['技能'], 'skill', false);
    }
    const uniqueAssets = new Map();
    for (const asset of assets) uniqueAssets.set(String(asset.assetId), asset);
    assets.length = 0; assets.push(...uniqueAssets.values());
    if (changed) await runtime.replaceVariables(variables);
    return assets;
}

function combatSnapshotNumber(value, fallback = undefined) {
    if (Number.isFinite(Number(value))) return Number(value);
    const text = String(value ?? '').trim();
    const percent = text.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*%$/);
    return percent ? Number(percent[1]) : fallback;
}

function localEntityCombatSnapshot(entity = {}) {
    const final = entity['最终属性'] && typeof entity['最终属性'] === 'object' ? entity['最终属性'] : {};
    const explicit = entity['战斗档案'] || entity['战斗属性'] || entity['战斗数据'] || entity.combatProfile || entity.combat || {};
    const equipped = entity['装备'] && typeof entity['装备'] === 'object' ? entity['装备'] : {};
    const weapons = final['武器'] && typeof final['武器'] === 'object' ? final['武器'] : {};
    const equippedNames = Object.entries(equipped)
        .filter(([, item]) => Number(item?.['状态'] ?? item?.status ?? item?.equipped ?? 0) === 1)
        .flatMap(([slot, item]) => [item?.['名称'], item?.name, slot].filter(Boolean).map(String));
    const selectedWeapon = equippedNames.find(name => weapons[name] && typeof weapons[name] === 'object') || Object.keys(weapons).find(name => name !== '无武装' && weapons[name] && typeof weapons[name] === 'object') || (weapons['无武装'] ? '无武装' : null);
    const weapon = selectedWeapon ? weapons[selectedWeapon] || {} : {};
    const pick = (keys, fallback = undefined) => {
        for (const key of keys) {
            const value = key.includes('.') ? key.split('.').reduce((out, part) => out?.[part], explicit) : explicit[key] ?? final[key] ?? entity[key];
            const parsed = combatSnapshotNumber(value, undefined);
            if (parsed !== undefined) return parsed;
        }
        return fallback;
    };
    const modifier = (label, english) => pick([english, `${label}修正`, label], undefined);
    const snapshot = {
        hp: pick(['hp', 'HP'], combatSnapshotNumber(entity.HP, undefined)), maxHp: pick(['maxHp', 'HP_MAX'], combatSnapshotNumber(entity.HP_MAX, undefined)),
        ep: pick(['ep', 'EP'], combatSnapshotNumber(entity.EP, undefined)), maxEp: pick(['maxEp', 'EP_MAX'], combatSnapshotNumber(entity.EP_MAX, undefined)),
        attack: pick(['attack', 'ATK'], combatSnapshotNumber(weapon.ATK ?? final.ATK, undefined)),
        magicAttack: pick(['magicAttack', 'MATK'], combatSnapshotNumber(weapon.MATK ?? final.MATK, undefined)),
        attackModifier: pick(['attackModifier', '攻击修正'], modifier('力量', 'strengthModifier')),
        defenseDC: pick(['defenseDC', '防御DC'], combatSnapshotNumber(final['防御DC'], undefined)),
        initiativeDC: pick(['initiativeDC', '先攻DC'], combatSnapshotNumber(final['先攻DC'], undefined)),
        armor: pick(['armor', 'physicalReduction', '物理减伤率'], combatSnapshotNumber(final['物理减伤率'], undefined)),
        resistance: pick(['resistance', 'magicalReduction', '魔法减伤率'], combatSnapshotNumber(final['魔法减伤率'], undefined)),
        attributes: {
            strengthModifier: modifier('力量', 'strengthModifier'), dexterityModifier: modifier('敏捷', 'dexterityModifier'), constitutionModifier: modifier('体质', 'constitutionModifier'), spiritModifier: modifier('精神', 'spiritModifier'), charismaModifier: modifier('魅力', 'charismaModifier'),
        },
        abilities: Array.isArray(explicit.abilities) ? structuredClone(explicit.abilities) : Array.isArray(explicit['技能']) ? structuredClone(explicit['技能']) : [],
        assetBindings: [...new Set(Object.values(equipped).flatMap(item => [item?.['战斗资产ID'], item?.battleAssetId].filter(Boolean).map(String)))],
        selectedWeapon,
        source: Object.keys(explicit).length ? 'mvu-existing-entity-combat-profile' : 'mvu-existing-entity',
    };
    return snapshot;
}

function battleKnownEntities() {
    const stat = runtime.variables.stat_data || {};
    const player = stat['主角'] || {};
    const compact = (name, entity, source) => {
        const localCombat = localEntityCombatSnapshot(entity || {});
        return {
            reference: name, source, name, lifeLevel: entity['层级'] || entity['位阶'] || 'Ⅰ',
            hp: entity.HP, maxHp: entity.HP_MAX, ep: entity.EP, maxEp: entity.EP_MAX,
            attributes: entity['最终属性'] || {}, state: entity['状态'] || {}, tactical: source === 'player' ? 'player' : entity['是否队友'] ? 'ally' : 'npc',
            localCombat,
            equipment: entity['装备'] || {}, items: entity['道具'] || {}, skills: entity['技能'] || {},
            identity: entity['身份'] || '', appearance: entity['外貌'] || '', status: entity['在场'] !== false ? 'present' : 'absent',
        };
    };
    return [compact('主角', player, 'player'), ...Object.entries(stat['关系列表'] || {}).filter(([, entity]) => entity?.['在场'] !== false).map(([name, entity]) => compact(name, entity || {}, 'relation'))];
}

function combatElapsedClock(milliseconds = 0) {
    const seconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderCombatRecognitionControl() {
    const button = $('#combatDraftAiButton') || $('[data-action="combat-draft-ai"]');
    const status = $('#combatDraftAiStatus');
    if (!button) return;
    const phase = combatRecognitionBusy ? 'running' : (combatRecognitionState.phase || 'idle');
    const elapsed = combatRecognitionBusy
        ? Math.max(0, performance.now() - combatRecognitionStartedAt)
        : Number(combatRecognitionState.elapsedMs || 0);
    const labels = {
        idle: 'AI 识别当前遭遇',
        running: `识别当前遭遇 · ${combatElapsedClock(elapsed)}`,
        success: `已识别遭遇 · ${combatElapsedClock(elapsed)}`,
        error: '识别失败 · 点击重试',
    };
    button.textContent = labels[phase] || labels.idle;
    button.dataset.recognitionState = phase;
    button.setAttribute('aria-busy', String(phase === 'running'));
    button.disabled = combatRecognitionBusy || (combatBusy && !combatRecognitionBusy);
    button.title = phase === 'running'
        ? '战斗 AI 正在读取当前剧情与 MVU；重复点击已锁定。'
        : phase === 'success'
            ? `本次遭遇识别已完成，用时 ${combatElapsedClock(elapsed)}；可再次点击重新识别。`
            : phase === 'error'
                ? `上次识别失败${combatRecognitionState.detail ? `：${combatRecognitionState.detail}` : ''}；点击重试。`
                : '读取当前剧情与 MVU，交给战斗 AI 草拟 BattleDeclaration，再进入本地校验。';
    if (status) {
        status.className = `combat-ai-recognition-status ${phase}`;
        status.textContent = phase === 'running'
            ? `战斗 AI 识别中 · ${combatRecognitionState.detail || '等待首包'} · ${combatElapsedClock(elapsed)}`
            : combatRecognitionState.detail || ({ idle: '读取当前剧情与 MVU', success: `识别完成 · ${combatElapsedClock(elapsed)}`, error: '可重试' }[phase] || '');
    }
}

function startCombatRecognitionClock() {
    clearInterval(combatRecognitionClock);
    combatRecognitionClock = setInterval(() => {
        if (!combatRecognitionBusy) return;
        combatRecognitionState.elapsedMs = performance.now() - combatRecognitionStartedAt;
        renderCombatRecognitionControl();
    }, 1000);
}

function stopCombatRecognitionClock() {
    clearInterval(combatRecognitionClock);
    combatRecognitionClock = null;
}

function resetCombatRecognitionState() {
    combatRecognitionBusy = false;
    combatRecognitionState = { phase: 'idle', detail: '', elapsedMs: 0 };
    combatRecognitionStartedAt = 0;
    stopCombatRecognitionClock();
}

function renderCombatModelStatus() {
    const root = $('#combatModelStatus');
    if (!root) return;
    const state = combatModelingState;
    const labels = { idle: '等待剧情 AI 的战场声明', declaration: '正文声明已接收', modeling: '战斗 AI 正在建模', repair: '战斗 AI 正在修复模型', ready: '建模通过 · 即将进入编制', failed: '建模失败，等待人工介入' };
    const actions = state.phase === 'failed'
        ? `${pendingCombatModel?.declaration ? '<button data-action="combat-retry-modeling">继续重试</button>' : ''}${pendingBattleDeclaration?.declaration ? '<button data-action="combat-edit-declaration">编辑战场声明</button>' : ''}<button data-action="combat-open-model-diagnostics">查看诊断 / 人工修正</button>`
        : state.phase === 'ready' ? '<button data-action="combat-open-prepared-model">查看最终模型</button>' : '';
    root.className = `combat-model-status ${state.phase}`;
    root.innerHTML = `<div><small>COMBAT PIPELINE</small><b>${escapeHtml(labels[state.phase] || state.phase)}</b><span>${escapeHtml(state.detail || '正文声明 → 战斗 AI 建模 → 本地校验 → 固定种子回合制')}</span></div>${actions}`;
}

async function openBattleDeclarationPreview(declaration, sourceMessageId = null, metadata = {}) {
    pendingBattleDeclaration = { declaration, sourceMessageId, receivedAt: new Date().toISOString(), ...metadata };
    combatModelingState = { phase: 'declaration', detail: `${declaration.participants?.length || 0} 个参战实体；确认后才会调用战斗 AI 建模。` };
    snapCombatFlowPhase();
    renderCombatModelStatus();
    openTextEditor({ title: '正文 AI 战场声明 · 确认后交由战斗 AI 数字化', value: JSON.stringify(declaration, null, 2), mode: 'json', onSave: async value => {
        const edited = JSON.parse(value);
        const check = await combatRequest('/declaration/validate', { method: 'POST', body: JSON.stringify({ declaration: edited }) });
        if (!check.ok) throw new Error(check.errors.map(item => `${item.path}：${item.message}`).join('\n'));
        $('#textEditorDialog').close();
        await modelBattleFromDeclaration(edited, sourceMessageId);
    } });
}

async function processBattleDeclaration(message, { automatic = true, protocolHandoff = null } = {}) {
    const extracted = battleDeclarationFromMessage(message?.content);
    if (!extracted) {
        // Keep an explicit black-box breadcrumb for story floors that contain
        // battle prose but no machine-readable declaration.  Without this,
        // the floor simply looked as if the combat pipeline had been skipped.
        await blackbox.record('combat-model', 'declaration_absent', {
            messageId: message?.id || null,
            responseLength: String(message?.content || '').length,
            responsePreview: String(message?.content || '').slice(0, 1200),
            reason: 'no BattleDeclaration tag',
        }, { sessionId: store.activeSession?.id });
        if (protocolHandoff) await blackbox.record('combat-model', 'combat_protocol_violation', { messageId: message?.id || null, reason: 'BattleHandoff was present but BattleDeclaration was absent', handoff: protocolHandoff }, { sessionId: store.activeSession?.id });
        return false;
    }
    if (extracted.error) {
        combatModelingState = { phase: 'failed', detail: extracted.error };
        pendingBattleDeclaration = { raw: extracted.raw, sourceMessageId: message.id, protocolHandoff, validation: { errors: [{ path: '/', message: extracted.error }] } };
        await blackbox.record('combat-model', 'declaration_parse_failed', { messageId: message.id, raw: extracted.raw, error: extracted.error }, { sessionId: store.activeSession?.id });
        renderCombatModelStatus(); toast('正文 AI 的战场声明无法解析；已保留诊断供人工修正。', 'error');
        return true;
    }
    const compatibility = normalizeBattleDeclarationCompatibility(extracted.declaration);
    const declaration = compatibility.declaration;
    // A BattleDeclaration is a hard handoff out of the story view. Switch to
    // the local tactical terminal before any validation/model call so a slow
    // combat-AI request cannot leave the player staring at the previous
    // narrative floor with no indication that the combat pipeline is active.
    showPanel('combat');
    combatModelingState = { phase: 'declaration', detail: `${declaration.participants?.length || 0} 个参战实体；正在切换到本地战斗终端。` };
    renderAll();
    const validation = await combatRequest('/declaration/validate', { method: 'POST', body: JSON.stringify({ declaration, strict: automatic }) });
    await blackbox.record('combat-model', validation.ok ? 'declaration_validated' : 'declaration_invalid', { messageId: message.id, declaration, originalDeclaration: extracted.declaration, compatibilityRepairs: compatibility.repairs, protocolHandoff, validation }, { sessionId: store.activeSession?.id });
    if (!validation.ok) {
        pendingBattleDeclaration = { declaration, originalDeclaration: extracted.declaration, compatibilityRepairs: compatibility.repairs, sourceMessageId: message.id, protocolHandoff, validation };
        combatModelingState = { phase: 'failed', detail: `正文声明缺少 ${validation.errors.length} 项必填信息。` };
        renderCombatModelStatus(); toast('战场声明不完整，已保留人工修正入口。', 'error');
        return true;
    }
    if (automatic) {
        if (protocolHandoff?.status !== 'LOCAL_COMBAT_REQUIRED') {
            await blackbox.record('combat-model', 'combat_protocol_violation', {
                messageId: message.id,
                reason: 'BattleDeclaration was emitted without the required LOCAL_COMBAT_REQUIRED handoff',
                handoff: protocolHandoff,
            }, { sessionId: store.activeSession?.id });
            pendingBattleDeclaration = { declaration, originalDeclaration: extracted.declaration, compatibilityRepairs: compatibility.repairs, sourceMessageId: message.id, protocolHandoff, validation };
            combatModelingState = { phase: 'failed', detail: '正文已声明战斗，但没有输出 LOCAL_COMBAT_REQUIRED 握手；未自动创建本地战斗。' };
            renderCombatModelStatus();
            toast('战斗声明缺少本地握手标记，已停止自动建模。', 'error');
            return true;
        }
        await blackbox.record('combat-model', 'declaration_handoff_accepted', {
            messageId: message.id,
            participantCount: declaration.participants?.length || 0,
            compatibilityRepairs: compatibility.repairs,
            nextStep: 'automatic combat-AI modeling and local creation',
        }, { sessionId: store.activeSession?.id });
        pendingBattleDeclaration = { declaration, originalDeclaration: extracted.declaration, compatibilityRepairs: compatibility.repairs, sourceMessageId: message.id, protocolHandoff, validation };
        await modelBattleFromDeclaration(declaration, message.id, null, { autoCreate: true, protocolHandoff });
    } else {
        // Manually drafted declarations retain the editor checkpoint, but the
        // user is still placed in the tactical terminal rather than the story
        // view while deciding whether to submit them for modeling.
        await openBattleDeclarationPreview(declaration, message.id, { protocolHandoff, compatibilityRepairs: compatibility.repairs });
    }
    return true;
}

function combatModelPrompt() {
    return `你是 Vibe Combat v3 的战场建模 AI。只输出一个可被 JSON.parse 解析的 JSON CombatModel；禁止解释、Markdown、代码围栏、剧情、CheckResult、UpdateVariable 或第二个 JSON。你不是战斗裁判：只负责把 BattleDeclaration 建模成可校验的二维回合制初始状态；伤害、先攻、发现、死亡和胜负全部交给本地服务器。

【修复重试协议】当输入 JSON 的 repairs 非空时，说明上一轮模型已经被本地校验拒绝。必须阅读 repairs 中的逐条 path/message 和 previousModel，保留所有未报错字段，只修正明确报错的字段，然后重新输出完整 CombatModel；绝对不能只输出补丁、错误说明或省略字段。若 previousModel 与本轮声明冲突，以 BattleDeclaration、knownEntities、requiredAssets 为准；不要为了“看起来合理”自行改写生命层级、品质、装备、数值或参战数量。

【硬约束优先级】
1. 输入 BattleDeclaration、knownEntities、requiredAssets 是唯一事实来源；不能凭空添加参战者。
2. 顶层 schema、worldLifeLevel、contactEstablished、contactPairs 必须逐字复制输入，禁止改写。
3. combatants 必须与 BattleDeclaration.participants 一一对应：每个 declarationId 恰好一个条目，严格复制 participant.count（缺省为 1）；不要把群体展开成 -001/-002 成员，展开由本地服务器完成。不得漏实体、合并不同 declarationId、改变 side 或数量。每个条目还必须复制 participant.distribution 的 style/radiusMeters/spacingMeters/jitterMeters/orientationDegrees；没有 distribution 时才使用 scattered 默认值。
4. participant 的 lifeLevel 和 attributeQualities 五维品质必须逐字复制。source=existing 的实体必须优先照抄 knownEntities 中同 reference 的 localCombat 快照；不能用模型临时猜测覆盖已有 HP/EP、ATK/MATK、攻击修正、DEF、减伤、装备或技能。每个条目附 combatProvenance:{source:"combat-ai-derived",worldLifeLevel,lifeLevel,attributeQualities,formulaVersion:"v3.2.6",entityReference:"已有实体名"}；主角条目的数值不是模型裁定权威：knownEntities 中 reference=主角 的 localCombat 存在时可以照抄最终属性，但不要求模型自行推导或校验 HP/EP、ATK/MATK、减伤、DC 等公式，只要输出有限数字占位即可；客户端随后会用 MVU 最终属性覆盖这些字段。禁止用模型臆造玩家装备事实、品质或公式结论。
5. requiredAssets 必须原样镜像到 assetProfiles；assetId、fingerprint、kind、name、finalAttributes 一个字符都不能改，combat 只补充射程/冷却/攻击方式。不得创造价格、品质或替代属性。

【唯一允许的输出骨架】
{"schema":"vibe-combat-model/v3","title":"…","location":"…","worldLifeLevel":"Ⅰ","contactEstablished":true,"contactPairs":[["id-a","id-b"]],"battlefield":{"shape":"rectangle","name":"…","widthMeters":20,"heightMeters":20,"center":{"x":0,"y":0}},"combatants":[{"id":"participant-id","name":"…","declarationId":"participant-id","count":1,"side":"player","controller":"player","lifeLevel":"Ⅰ","attributeQualities":{"strengthModifier":"F","dexterityModifier":"F","constitutionModifier":"F","spiritModifier":"F","charismaModifier":"F"},"combatProvenance":{"source":"combat-ai-derived","worldLifeLevel":"Ⅰ","lifeLevel":"Ⅰ","attributeQualities":{"strengthModifier":"F","dexterityModifier":"F","constitutionModifier":"F","spiritModifier":"F","charismaModifier":"F"},"formulaVersion":"v3.2.6"},"hp":20,"maxHp":20,"ep":0,"maxEp":0,"attack":10,"magicAttack":0,"attackModifier":0,"defenseDC":10,"initiativeDC":0,"armor":0,"resistance":0,"radiusMeters":0.5,"sizeClass":"medium","speedMeters":6,"position":{"x":0,"y":0},"facingDegrees":0,"fovDegrees":120,"visionMeters":15,"distribution":{"style":"scattered","radiusMeters":3,"spacingMeters":1.5,"jitterMeters":0.2,"orientationDegrees":0},"attributes":{"strengthModifier":0,"dexterityModifier":0,"constitutionModifier":0,"spiritModifier":0,"charismaModifier":0},"intelProfile":{"presence":"obvious","stealthBonus":0,"perceptionBonus":0,"commandBonus":0,"hearingMeters":8,"intelligenceRangeMeters":0,"intelligenceBonus":0,"movementNoiseMeters":8,"attackNoiseMeters":12},"tacticalProfile":{"archetype":"scattered","groupId":"group-id","objective":"engage","focusRule":"nearest","coordinationRadiusMeters":0},"assetBindings":[],"abilities":[{"id":"basic-attack","name":"基础攻击","type":"physical","actionType":"main","power":0,"modifier":0,"epCost":0,"minRangeMeters":0,"maxRangeMeters":1.5,"cooldownRounds":0,"targetCount":1,"aoe":false}] }],"assetProfiles":[]}

【建模规则】
- battlefield 只能使用 rectangle 或 circle；矩形填写 widthMeters/heightMeters/center，圆形填写 radiusMeters/center。战场边界必须容纳所有群体展开后的 footprint：每个群体锚点到边界至少留出 distribution.radiusMeters + radiusMeters，宽高不能小于展开直径；不同阵营的锚点必须保持不重叠的安全距离。对于两个模板 A/B，锚点距离必须至少为 A 的展开半径 + B 的展开半径 + A.radiusMeters + B.radiusMeters + 0.5 米；count=1 的个体展开半径按 0 计算，不要把单个玩家的 distribution.radiusMeters 当成实际占地。示例：单个玩家在 (0,-1)、半径 0.5，半径 3 的三只丧尸群不得把锚点放在 (0,1)，应放到相距至少 4 米的位置（例如 (0,5)）。首版不建模掩体、遮挡、地形、路径或区域效果。
- 每个 combatant 都必须包含骨架中的全部字段。数值字段只需存在且为有限数字；具体 HP/EP、攻击、防御、DC、减伤、移速、射程、冷却与五维数值由本地权威数据和战斗引擎处理，不要在回复中解释数值公式，也不要因为不确定而省略字段。defenseDC 只表示本单位的防御目标值，不要与情报/豁免 DC 混用；模型声明的有限数值会被本地原样保留，不套用隐藏的生命层级换算。radiusMeters 是单个实体身体碰撞半径，不是群体散布半径；模型可以自由声明任意有限半径，普通人类约 0.5 米只是常见示例而非限制。合法枚举如下：side=player|enemy|neutral；controller=player|ai；lifeLevel=Ⅰ|Ⅱ|Ⅲ|Ⅳ|Ⅴ|Ⅵ|Ⅶ|Ⅷ|Ⅸ；品质=F|E|D|C|B|A|S|SS|SSS。
- 合法战场与分布枚举必须只从这些值中选择：battlefield.shape=rectangle|circle；distribution.style=scattered|squad|legion|line|ring|wedge|grid；presence=obvious|cautious|concealed；tacticalProfile.archetype=scattered|squad|hive；objective=search|engage|hold；focusRule=nearest|weakest|marked。
- 只为每个 participant 输出一个“群体模板”条目并保留 count。根据该 participant.distribution 放置锚点和队形提示：scattered=松散非规则散布，squad/wedge=小队/楔形，legion/grid=方阵，ring=环形，line=横列；没有 legion/grid 声明的丧尸不得排成方阵。position 是群体锚点，不是成员坐标；必须让锚点与其他群体保持足够距离，使本地展开后任意成员都不重叠。群体内 count>1 时，本地会按 distribution.radiusMeters/spacingMeters 展开成员，不能把多个模板锚点放在同一点，也不能假定“同一阵营”可以重叠；先按两组 footprint 半径之和预留距离。若群体 footprint 放不进当前场地，应扩大 battlefield，而不是把成员挤到同一点或缩成方阵。
- attributes 必须完整包含五维修正；力量用于近战压制，敏捷用于机动/潜行，体质用于体力，精神用于发现/追踪，魅力用于诱导/协同。不要把五维品质字母直接当作数值，也不要把生命层级和品质机械等号。
- intelProfile 三个来源独立：visual（前方扇形+2m近距全向）、auditory（只能形成模糊怀疑）、intel（情报能力）。presence 由声明决定：潜行/未发现/隐蔽必须是 concealed；直接对话、互相看见或明确交战的接触对必须保持可追踪。近战攻击无论命中与否都会让受击者立即发现攻击者。
- tacticalProfile 只能用 archetype=scattered|squad|hive、objective=search|engage|hold、focusRule=nearest|weakest|marked。scattered 不共享情报，squad 仅在 coordinationRadiusMeters 内共享，hive 才能全群同步。
- 每个单位至少一个 basic-attack。basic-attack 的 power=0、modifier=0：单位 attack/magicAttack 与 attackModifier 已是最终面板值，绝不能把同一个 ATK 再复制进能力造成双算；只有明确命名的额外技能才填写有限 power/modifier。能力必须有 id/name/type/actionType/power/modifier/epCost/minRangeMeters/maxRangeMeters/cooldownRounds/targetCount/aoe；type 只能是 physical|magical|hybrid|true，actionType 只能逐字填写 "main" 或 "minor"，绝对不能填写 reaction、passive、bonus、action 或其他值。防御、格挡、自动反击属于本地被动/反应规则，不要伪造为 ability。非 basic-attack 必须有有限 power 或受审查脚本。maxRangeMeters≤1.5 的能力属于近战，单个目标每回合最多 8 个近战接触位。脚本只能调用 api.damage/heal/status/move/resource/dispel/log，移动只能 api.move(targetId,x,y)。
- assetProfiles.combat.attackStyle 只能从 melee|ranged|magical|hybrid|utility 中选择；assetProfiles 的 kind、assetId、fingerprint、finalAttributes 必须复制 requiredAssets，不得猜测。
- assetBindings 必须存在且为 assetProfiles 中的 ID；无装备必须为 []。assetProfiles 必须覆盖所有 requiredAssets，保留 finalAttributes，不要改写玩家装备事实。

【输出前逐项自检，失败就修正后再输出】
每个 participant 是否恰好一个 combatant、count 是否相同、declarationId 是否存在；顶层四个协议字段是否原样；五维品质与 lifeLevel 是否原样；requiredAssets 是否逐字镜像；所有必填键是否存在；所有坐标是否在边界内；是否只有一个 JSON 且没有 markdown。通过后立即输出 JSON。`;
}

function authoritativeQualityProfile(player, final, unit) {
    const source = final['五维品质'] || final['属性品质'] || player['五维品质'] || player['属性品质'] || player['血统']?.['原始属性'] || {};
    const pick = (key, aliases = []) => {
        for (const candidate of [key, ...aliases]) {
            if (source && typeof source === 'object' && source[candidate] !== undefined) return String(source[candidate]).toUpperCase();
        }
        return String(unit?.attributeQualities?.[key] || unit?.qualityProfile?.[key] || 'F').toUpperCase();
    };
    return {
        strengthModifier: pick('strengthModifier', ['力量']), dexterityModifier: pick('dexterityModifier', ['敏捷']),
        constitutionModifier: pick('constitutionModifier', ['体质']), spiritModifier: pick('spiritModifier', ['精神']), charismaModifier: pick('charismaModifier', ['魅力']),
    };
}

function equippedCombatAssetBindings(player = {}, combatAssets = []) {
    const byName = new Map();
    for (const asset of Array.isArray(combatAssets) ? combatAssets : []) {
        if (!asset?.assetId || !asset?.name) continue;
        byName.set(String(asset.name).trim(), String(asset.assetId));
    }
    const equipped = player?.['装备'] && typeof player['装备'] === 'object' ? player['装备'] : {};
    const bindings = [];
    for (const [slot, item] of Object.entries(equipped)) {
        if (!item || Number(item?.状态 ?? item?.status ?? item?.equipped ?? 0) !== 1) continue;
        const direct = item?.['战斗资产ID'];
        if (direct) { bindings.push(String(direct)); continue; }
        const candidates = [item?.名称, item?.name, slot].filter(Boolean).map(value => String(value).trim());
        const matched = candidates.map(name => byName.get(name)).find(Boolean);
        if (matched) bindings.push(matched);
    }
    return [...new Set(bindings)];
}

// The declaration is the authority for the hand-off protocol facts
// (worldLifeLevel/contactEstablished/contactPairs).  The modeler is instructed
// to copy them verbatim, but when it drifts we overwrite its copy so strict
// validation can never be blocked by a protocol mismatch.  Note: the model's
// schema is vibe-combat-model/v3 and must NOT be copied from the declaration
// (which carries vibe-combat-declaration/v3).
function attachAuthoritativeDeclarationProtocol(model, declaration) {
    const copy = structuredClone(model || {});
    if (!declaration || typeof declaration !== 'object') return copy;
    if (declaration.worldLifeLevel !== undefined) {
        copy.worldLifeLevel = declaration.worldLifeLevel;
        if (Array.isArray(copy.combatants)) {
            for (const unit of copy.combatants) {
                if (unit?.combatProvenance) unit.combatProvenance.worldLifeLevel = declaration.worldLifeLevel;
            }
        }
    }
    if (declaration.contactEstablished !== undefined) copy.contactEstablished = declaration.contactEstablished;
    if (Array.isArray(declaration.contactPairs)) copy.contactPairs = structuredClone(declaration.contactPairs);
    return copy;
}

function attachAuthoritativePlayerMvu(model, combatAssets = []) {
    const copy = structuredClone(model || {});
    const player = runtime.variables?.stat_data?.['主角'];
    const unit = copy.combatants?.find(item => item?.side === 'player');
    // The browser starts with an empty stat_data object before character
    // creation. Treat that as "no authoritative snapshot"; touching the
    // model in that state would manufacture missing-path errors and force the
    // repair loop even though no player MVU exists yet.
    const finalSnapshot = player?.['最终属性'];
    if (!player || !unit || (player.HP === undefined && player.HP_MAX === undefined && !finalSnapshot) || !finalSnapshot || typeof finalSnapshot !== 'object' || Object.keys(finalSnapshot).length === 0) return copy;
    const final = player['最终属性'] || {};
    const weapons = final['武器'] && typeof final['武器'] === 'object' ? final['武器'] : {};
    const equipped = player['装备'] && typeof player['装备'] === 'object' ? player['装备'] : {};
    const equippedWeaponCandidates = Object.entries(equipped)
        .filter(([, item]) => Number(item?.状态 ?? item?.status ?? item?.equipped ?? 0) === 1)
        .flatMap(([slot, item]) => [item?.名称, item?.name, slot].filter(Boolean).map(String));
    const selectedWeaponName = equippedWeaponCandidates.find(name => weapons[name] && typeof weapons[name] === 'object')
        || (weapons['无武装'] ? '无武装' : Object.keys(weapons).find(name => weapons[name] && typeof weapons[name] === 'object'))
        || null;
    const weapon = selectedWeaponName ? weapons[selectedWeaponName] || {} : {};
    const number = (value, fallback) => {
        if (Number.isFinite(Number(value))) return Number(value);
        const text = String(value ?? '').trim();
        const percent = text.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*%$/);
        return percent ? Number(percent[1]) : fallback;
    };
    const missingAuthoritativePaths = [];
    const authoritativeNumber = (value, fallback, path) => {
        const parsed = number(value, NaN);
        if (Number.isFinite(parsed)) return parsed;
        missingAuthoritativePaths.push(path);
        return fallback;
    };
    const modifier = key => number(final[`${key}修正`], number(final[key], 0));
    const attributeQualities = authoritativeQualityProfile(player, final, unit);
    const worldLifeLevel = copy.worldLifeLevel || 'Ⅰ';
    // ensureCombatAssetContext works on a cloned MVU snapshot and persists it
    // asynchronously.  Do not rely on that write having reached
    // runtime.variables before this same turn builds the CombatModel.  Match
    // equipped entries against the returned authoritative asset list as a
    // fallback, while still accepting an already materialized asset ID.
    const equippedAssetBindings = equippedCombatAssetBindings(player, combatAssets);
    unit.mvu = { player: structuredClone(player), selectedWeaponName };
    unit.combatProvenance = {
        source: 'mvu-final-attributes',
        formulaVersion: 'v3.2.6',
        worldLifeLevel,
        lifeLevel: String(player['层级'] || unit.lifeLevel || 'Ⅰ'),
        attributeQualities,
        missingPaths: missingAuthoritativePaths,
        selectedWeapon: selectedWeaponName,
        paths: {
            hp: '主角.HP', maxHp: '主角.HP_MAX', ep: '主角.EP', maxEp: '主角.EP_MAX',
            attack: selectedWeaponName ? `主角.最终属性.武器.${selectedWeaponName}.ATK` : '主角.最终属性.ATK',
            magicAttack: selectedWeaponName ? `主角.最终属性.武器.${selectedWeaponName}.MATK` : '主角.最终属性.MATK',
            armor: '主角.最终属性.物理减伤率', resistance: '主角.最终属性.魔法减伤率',
        },
    };
    // Keep the model AI responsible for spatial/tactical fields, but never
    // allow it to replace card-calculated player combat values. In particular,
    // DEF is not a damage-reduction percentage; the authoritative percentage
    // is the MVU final attribute named 物理减伤率.
    unit.hp = number(player.HP, unit.hp); unit.maxHp = Math.max(1, number(player.HP_MAX, unit.maxHp));
    unit.ep = number(player.EP, unit.ep); unit.maxEp = Math.max(unit.ep, number(player.EP_MAX, unit.maxEp));
    unit.attack = authoritativeNumber(weapon.ATK ?? final.ATK, 0, selectedWeaponName ? `主角.最终属性.武器.${selectedWeaponName}.ATK` : '主角.最终属性.ATK');
    unit.magicAttack = authoritativeNumber(weapon.MATK ?? final.MATK, 0, selectedWeaponName ? `主角.最终属性.武器.${selectedWeaponName}.MATK` : '主角.最终属性.MATK');
    unit.attackModifier = number(final['攻击修正'], modifier('力量'));
    unit.defenseDC = authoritativeNumber(final['防御DC'], 0, '主角.最终属性.防御DC');
    unit.initiativeDC = authoritativeNumber(final['先攻DC'], 0, '主角.最终属性.先攻DC');
    unit.armor = Math.max(0, Math.min(95, authoritativeNumber(final['物理减伤率'], 0, '主角.最终属性.物理减伤率')));
    unit.resistance = Math.max(0, Math.min(95, authoritativeNumber(final['魔法减伤率'], 0, '主角.最终属性.魔法减伤率')));
    unit.combatProvenance.missingPaths = missingAuthoritativePaths;
    unit.attributes = {
        strengthModifier: modifier('力量'), dexterityModifier: modifier('敏捷'), constitutionModifier: modifier('体质'),
        spiritModifier: modifier('精神'), charismaModifier: modifier('魅力'),
    };
    unit.lifeLevel = String(player['层级'] || unit.lifeLevel || 'Ⅰ');
    unit.attributeQualities = attributeQualities;
    unit.assetBindings = equippedAssetBindings;
    return copy;
}

function attachAuthoritativeExistingEntities(model, declaration) {
    const copy = structuredClone(model || {});
    const stat = runtime.variables?.stat_data || {};
    const relationMap = stat['关系列表'] || {};
    const declarationById = new Map((Array.isArray(declaration?.participants) ? declaration.participants : []).map(item => [String(item?.id || ''), item]));
    for (const unit of copy.combatants || []) {
        const participant = declarationById.get(String(unit?.declarationId || ''));
        if (!participant || participant.source !== 'existing' || participant.side === 'player') continue;
        const reference = String(participant.reference || '').replace(/^关系列表[\\/]/, '').trim();
        const entity = relationMap[reference];
        if (!entity || typeof entity !== 'object') continue;
        const local = localEntityCombatSnapshot(entity);
        const authoritative = ['hp', 'maxHp', 'ep', 'maxEp', 'attack', 'magicAttack', 'attackModifier', 'defenseDC', 'initiativeDC', 'armor', 'resistance'];
        for (const key of authoritative) if (local[key] !== undefined) unit[key] = local[key];
        if (Object.values(local.attributes || {}).some(value => value !== undefined)) {
            unit.attributes = { ...unit.attributes, ...Object.fromEntries(Object.entries(local.attributes).filter(([, value]) => value !== undefined)) };
        }
        if (local.abilities?.length) unit.abilities = local.abilities;
        if (local.assetBindings?.length) unit.assetBindings = local.assetBindings;
        unit.mvu = { entity: structuredClone(entity), reference };
        unit.combatProvenance = {
            ...(unit.combatProvenance || {}), source: local.source, entityReference: reference,
            formulaVersion: 'v3.2.6', localSnapshotApplied: true,
            paths: { hp: `关系列表.${reference}.HP`, maxHp: `关系列表.${reference}.HP_MAX`, ep: `关系列表.${reference}.EP`, maxEp: `关系列表.${reference}.EP_MAX`, finalAttributes: `关系列表.${reference}.最终属性`, equipment: `关系列表.${reference}.装备` },
        };
    }
    return copy;
}

function sanitizeBasicAttackAbilities(model) {
    const copy = structuredClone(model || {});
    for (const unit of copy.combatants || []) {
        for (const ability of unit.abilities || []) {
            if (ability?.id === 'basic-attack') {
                ability.power = 0;
                ability.modifier = 0;
            }
        }
    }
    return copy;
}

async function modelBattleFromDeclaration(declaration, sourceMessageId = null, seedModel = null, { autoCreate = false, protocolHandoff = null, resume = null } = {}) {
    if (combatBusy) return;
    const connection = combatConnection();
    if (!connection?.baseUrl || !connection?.model) { showPanel('settings'); throw new Error('请先配置战斗 AI 线路，再确认战场声明'); }
    combatBusy = true;
    snapCombatFlowPhase();
    try {
        const assets = resume?.requiredAssets || await ensureCombatAssetContext();
        const baseContext = { declaration, knownEntities: battleKnownEntities(), requiredAssets: assets, rules: { version: 'vibe-combat-v2-turn-field', spatial: 'only boundary, circles, distance, movement; no cover/terrain/pathfinding' } };
        let candidate = seedModel;
        let previousModel = resume?.previousModel || null;
        const repairs = [...(resume?.repairs || [])];
        let serviceExhausted = false;
        let lastServiceError = null;
        for (let round = 1; round <= 5; round += 1) {
            const firstCall = repairs.length === 0 && round === 1;
            combatModelingState = { phase: firstCall ? 'modeling' : 'repair', detail: `第 ${repairs.length + 1} 次${firstCall ? '数字化建模' : `修复校验错误${resume ? '（继续重试）' : ''}`}…` };
            renderCombatModelStatus(); renderCombat();
            if (!candidate) {
                const repairInput = { ...baseContext, repairs };
                if (previousModel) repairInput.previousModel = previousModel;
                let response = null;
                for (let serviceAttempt = 1; serviceAttempt <= COMBAT_MODEL_SERVICE_RETRIES; serviceAttempt += 1) {
                    try {
                        response = await callCombatAi(combatModelPrompt(), JSON.stringify(repairInput, null, 2), firstCall ? 'battle_model_started' : 'battle_model_repair');
                        break;
                    } catch (error) {
                        if (isAbortError(error)) throw error;
                        lastServiceError = error;
                        await blackbox.record('combat-model', 'model_service_error', { attempt: repairs.length + 1, serviceAttempt, error: error?.message || String(error) }, { sessionId: store.activeSession?.id });
                        if (serviceAttempt >= COMBAT_MODEL_SERVICE_RETRIES) break;
                        // An upstream timeout or busy service must neither
                        // consume one of the five repair slots nor abort the
                        // whole modeling protocol: back off briefly, then
                        // repeat the exact same model call.
                        combatModelingState = { phase: 'repair', detail: `战斗 AI 服务超时或出错（自动重试 ${serviceAttempt} / ${COMBAT_MODEL_SERVICE_RETRIES - 1}）：${error?.message || error}` };
                        renderCombatModelStatus();
                        await new Promise(resolve => setTimeout(resolve, 1500 * serviceAttempt));
                    }
                }
                if (!response) { serviceExhausted = true; break; }
                try {
                    candidate = extractJsonObject(response.content);
                } catch (error) {
                    // A malformed model response must consume one repair slot,
                    // not abort the whole five-attempt protocol.  Keep the
                    // exact parser error in the blackbox so it is diagnosable.
                    const report = { valid: false, errors: [{ code: 'parse.error', path: '$', message: error.message }] };
                    repairs.push({ attempt: repairs.length + 1, report });
                    await blackbox.record('combat-model', 'model_rejected', { attempt: repairs.length, error: error.message, validation: report, responseParse: 'failed' }, { sessionId: store.activeSession?.id });
                    candidate = null;
                    continue;
                }
            }
            candidate = sanitizeBasicAttackAbilities(attachAuthoritativeDeclarationProtocol(attachAuthoritativeExistingEntities(attachAuthoritativePlayerMvu(candidate, assets), declaration), declaration));
            const validation = await combatRequest('/model/validate', { method: 'POST', body: JSON.stringify({ declaration, model: candidate, requiredAssets: assets, strict: true }) });
            await blackbox.record('combat-model', validation.ok ? 'model_validated' : 'model_rejected', { attempt: repairs.length + 1, declaration, model: candidate, validation }, { sessionId: store.activeSession?.id });
            if (validation.ok) {
                pendingCombatModel = { declaration, model: candidate, requiredAssets: assets, validation, attempts: repairs.length + 1, sourceMessageId, repairs };
                combatModelingState = { phase: 'ready', detail: `第 ${repairs.length + 1} 次校验通过；已自动进入第 3 步编制部署，请选择策略与操控方式。` };
                renderCombatModelStatus();
                // A validated model never waits on a second human checkpoint:
                // create it immediately, then stop at step 3 so the player can
                // choose per-unit tactics and manual/automatic control before
                // the local engine rolls initiative.
                await blackbox.record('combat-model', 'model_auto_create', { sourceMessageId, attempt: repairs.length + 1, protocolHandoff, battleAuthority: 'local', nextStep: 'deploy' }, { sessionId: store.activeSession?.id });
                await createCombatFromPreparedModel(pendingCombatModel, { autoStart: false, autoDeploy: true });
                return;
            }
            repairs.push({ attempt: repairs.length + 1, report: validation.report });
            previousModel = candidate;
            candidate = null;
        }
        pendingCombatModel = { declaration, model: null, requiredAssets: assets, attempts: repairs.length, sourceMessageId, protocolHandoff, repairs, validation: repairs.at(-1)?.report || null, previousModel, resumeRounds: (resume?.resumeRounds || 0) + 1 };
        combatModelingState = { phase: 'failed', detail: serviceExhausted
            ? `战斗 AI 服务连续 ${COMBAT_MODEL_SERVICE_RETRIES} 次超时或出错${lastServiceError ? `：${lastServiceError.message || lastServiceError}` : ''}；可点击“继续重试”，或选择人工修正。`
            : '战斗 AI 已连续五次未能构造可计算战场；可点击“继续重试”再试五次，或选择人工修正。' };
        renderCombatModelStatus();
        snapCombatFlowPhase();
        renderCombat();
    } catch (error) {
        if (isAbortError(error)) { combatModelingState = { phase: 'idle', detail: '已取消建模' }; renderCombatModelStatus(); }
        throw error;
    } finally { combatBusy = false; renderCombat(); }
}

function openPreparedCombatModel() {
    if (!pendingCombatModel?.model) return;
    openTextEditor({ title: `最终 CombatModel · 已通过本地校验（${pendingCombatModel.attempts} 次）`, value: JSON.stringify(pendingCombatModel.model, null, 2), mode: 'json', onSave: async value => {
        const model = sanitizeBasicAttackAbilities(attachAuthoritativeDeclarationProtocol(attachAuthoritativeExistingEntities(attachAuthoritativePlayerMvu(JSON.parse(value), pendingCombatModel.requiredAssets), pendingCombatModel.declaration), pendingCombatModel.declaration));
        const validation = await combatRequest('/model/validate', { method: 'POST', body: JSON.stringify({ declaration: pendingCombatModel.declaration, model, requiredAssets: pendingCombatModel.requiredAssets, strict: pendingCombatModel.declaration?.schema === 'vibe-combat-declaration/v3' }) });
        if (!validation.ok) throw new Error(validation.errors.map(item => `${item.path}：${item.message}`).join('\n'));
        $('#textEditorDialog').close();
        pendingCombatModel.model = model; pendingCombatModel.validation = validation;
        await createCombatFromPreparedModel(pendingCombatModel);
    } });
}

function openCombatModelDiagnostics() {
    const payload = pendingCombatModel || pendingBattleDeclaration || { error: '没有可用建模诊断' };
    openTextEditor({ title: '战场建模诊断 · 可手工填入完整 CombatModel 后重新校验', value: JSON.stringify(payload, null, 2), mode: 'json', onSave: async value => {
        const edited = JSON.parse(value);
        const declaration = edited.declaration || pendingBattleDeclaration?.declaration;
        const model = edited.model || edited;
        const assets = edited.requiredAssets || pendingCombatModel?.requiredAssets || await ensureCombatAssetContext();
        const validation = await combatRequest('/model/validate', { method: 'POST', body: JSON.stringify({ declaration, model, requiredAssets: assets, strict: declaration?.schema === 'vibe-combat-declaration/v3' }) });
        if (!validation.ok) throw new Error(validation.errors.map(item => `${item.path}：${item.message}`).join('\n'));
        $('#textEditorDialog').close();
        pendingCombatModel = { declaration, model, requiredAssets: assets, validation, attempts: 'manual', repairs: pendingCombatModel?.repairs || [] };
        combatModelingState = { phase: 'ready', detail: '人工修正的模型已通过本地校验；确认后创建战斗。' };
        snapCombatFlowPhase();
        renderCombatModelStatus(); openPreparedCombatModel();
    } });
}

async function createCombatFromPreparedModel(prepared, { autoStart = false, autoDeploy = false } = {}) {
    const model = sanitizeBasicAttackAbilities(attachAuthoritativeDeclarationProtocol(attachAuthoritativeExistingEntities(attachAuthoritativePlayerMvu(prepared.model, prepared.requiredAssets), prepared.declaration), prepared.declaration));
    const payload = { storySessionId: store.activeSession?.id, mode: $('#combatMode')?.value || 'manual', encounter: model, assetProfiles: model.assetProfiles || [], preparation: { declaration: prepared.declaration, attempts: prepared.attempts, repairReports: prepared.repairs, sourceMessageId: prepared.sourceMessageId || null } };
    await createCombatPayload(payload);
    if (autoStart && combatState?.status === 'draft') {
        // The automatic story handoff has already passed declaration and
        // model validation.  Starting the local engine here prevents a
        // successful BattleDeclaration from leaving a newly-created battle in
        // an unexplained draft with no initiative events.  Manual/editor
        // encounters intentionally retain the explicit Start button.
        const createdVersion = combatState.version;
        combatState = await combatRequest(`/${combatState.id}/start`, { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID(), expectedVersion: createdVersion, mode: payload.mode }) });
        combatEvents = (await combatRequest(`/${combatState.id}/events`)).events || [];
        snapCombatFlowPhase();
        await blackbox.record('combat', 'combat_auto_started', { battleId: combatState.id, expectedVersion: createdVersion, state: combatState, reason: 'automatic BattleDeclaration handoff' }, { sessionId: store.activeSession?.id });
        renderCombat();
    }
    if (autoDeploy && !autoStart) {
        combatFlowPhase = 'deploy';
        renderCombat();
        toast('战斗 AI 建模成功，已进入第 3 步编制部署；请选择各单位策略与手操 / 自动方式。', 'success');
    }
    pendingBattleDeclaration = null; pendingCombatModel = null;
    combatModelingState = { phase: 'idle', detail: autoDeploy && !autoStart ? '本地权威战斗已创建；等待第 3 步编制部署。' : '本地权威战斗已创建；固定坐标和资产资料已锁定在本场快照。' };
    renderCombatModelStatus();
}

async function callCombatAi(systemPrompt, userPrompt, purpose) {
    const connection = combatConnection();
    if (!connection) throw new Error('请先在战术终端选择独立战斗模型线路');
    const preset = combatPreset();
    const presetMessages = (preset?.prompts || []).filter(item => item.enabled !== false && !item.marker && item.content).map(item => ({ role: ['system', 'assistant', 'user'].includes(item.role) ? item.role : 'system', content: item.content }));
    const messages = buildCombatAiMessages(systemPrompt, userPrompt, purpose, presetMessages);
    const turnId = crypto.randomUUID();
    const combatController = new AbortController();
    const processId = beginAiProcess('战斗 AI', `${PROMPT_LAB_MODES[promptModeForCombatPurpose(purpose)]?.label || purpose} · 等待首包`, () => combatController.abort(new DOMException('用户已取消战斗 AI 请求', 'AbortError')));
    try {
        await blackbox.record('combat-ai', `${purpose}_started`, { connection: { id: connection.id, name: connection.name, model: connection.model, protocol: connection.protocol }, preset: preset ? { id: preset.id, name: preset.name } : null, messages }, { sessionId: store.activeSession?.id, turnId });
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...connection, stream: false, maxTokens: Math.max(30000, Number(connection.maxTokens) || 0), messages }), signal: combatController.signal });
        updateAiProcess(processId, '接收模型响应');
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message || body.error || `HTTP ${response.status}`);
        const content = body.choices?.[0]?.message?.content || '';
        await blackbox.record('combat-ai', `${purpose}_completed`, { content, usage: body.usage }, { sessionId: store.activeSession?.id, turnId });
        return { content, usage: body.usage };
    } finally {
        endAiProcess(processId);
    }
}

function buildCombatAiPromptPackage(systemPrompt, userPrompt, purpose = '', presetMessages = null) {
    const mode = promptModeForCombatPurpose(purpose);
    const states = promptModuleStates(mode);
    const preset = presetMessages || ((combatPreset()?.prompts || []).filter(item => item.enabled !== false && !item.marker && item.content).map(item => ({ role: ['system', 'assistant', 'user'].includes(item.role) ? item.role : 'system', content: item.content })));
    const modules = [
        { id: 'preset', label: 'AIRP / OAI 预设', description: PROMPT_MODULE_DEFINITIONS.preset.description, messages: preset },
        { id: 'rules', label: '战斗规则 / 协议', description: PROMPT_MODULE_DEFINITIONS.rules.description, messages: [{ role: 'system', content: systemPrompt }] },
        { id: 'work', label: '战斗工作提示词', description: PROMPT_MODULE_DEFINITIONS.work.description, messages: [{ role: 'user', content: userPrompt }] },
    ];
    const messages = applyPromptModuleMessages(modules, mode);
    return { mode, purpose, messages, modules, states };
}

function buildCombatAiMessages(systemPrompt, userPrompt, purpose = '', presetMessages = null) {
    return buildCombatAiPromptPackage(systemPrompt, userPrompt, purpose, presetMessages).messages;
}

async function draftCombatWithAi(sourceMessageId = null) {
    if (combatRecognitionBusy) return;
    if (combatBusy) { toast('战斗终端当前正在处理另一项请求，请稍候。', 'info'); return; }
    const startedAt = performance.now();
    showPanel('combat');
    combatRecognitionBusy = true;
    combatRecognitionStartedAt = startedAt;
    combatRecognitionState = { phase: 'running', detail: '读取当前剧情与 MVU', elapsedMs: 0 };
    startCombatRecognitionClock();
    combatBusy = true; renderCombat();
    try {
        const session = store.activeSession;
        const currentFloorMessage = currentStoryFloor()?.narrative || session?.messages?.at(-1) || null;
        const context = {
            sourceMessageId: sourceMessageId || currentFloorMessage?.id || null,
            recentStory: session?.messages?.filter(item => !item.isHidden).slice(-8).map(item => ({ role: item.role, content: item.content })),
            stat_data: runtime.variables.stat_data,
        };
        // Free-form extra requirements (更大的战场规模 / 夜战 / 强调设定...)
        // typed next to the recognition button ride along as player
        // preferences for the drafting model.
        const recognitionNotes = String($('#combatRecognitionNotes')?.value || '').trim();
        if (recognitionNotes) context.playerRequirements = recognitionNotes;
        combatRecognitionState.detail = '战斗 AI 正在分析遭遇';
        renderCombatRecognitionControl();
        const prompt = await callCombatAi(combatRecognitionPrompt(), `当前剧情与 MVU：\n${JSON.stringify(context)}`, 'battle_declaration_draft');
        let parsedResponse;
        try {
            parsedResponse = parseBattleDeclarationResponse(prompt.content);
        } catch (error) {
            await blackbox.record('combat-model', 'declaration_drafted_parse_failed', {
                sourceMessageId: context.sourceMessageId,
                error,
                rawChars: String(prompt.content || '').length,
                rawPreview: String(prompt.content || '').slice(0, 1600),
            }, { sessionId: store.activeSession?.id });
            throw error;
        }
        const drafted = parsedResponse.declaration;
        const compatibility = normalizeBattleDeclarationCompatibility(drafted);
        const declaration = compatibility.declaration;
        const validation = await combatRequest('/declaration/validate', { method: 'POST', body: JSON.stringify({ declaration }) });
        await blackbox.record('combat-model', validation.ok ? 'declaration_drafted_validated' : 'declaration_drafted_invalid', {
            sourceMessageId: context.sourceMessageId,
            declaration,
            responseParse: { source: parsedResponse.source, path: parsedResponse.path, rawChars: parsedResponse.raw.length, rawPreview: parsedResponse.raw.slice(0, 1200) },
            compatibilityRepairs: compatibility.repairs,
            validation,
        }, { sessionId: store.activeSession?.id });
        if (!validation.ok) throw new Error(validation.errors.map(item => `${item.path}：${item.message}`).join('\n'));
        await openBattleDeclarationPreview(declaration, context.sourceMessageId, { manuallyDrafted: true });
        combatRecognitionState = { phase: 'success', detail: `识别完成 · 已通过声明校验 · ${combatElapsedClock(performance.now() - startedAt)}`, elapsedMs: performance.now() - startedAt };
    } catch (error) {
        if (isAbortError(error)) combatRecognitionState = { phase: 'idle', detail: '已取消', elapsedMs: performance.now() - startedAt };
        else combatRecognitionState = { phase: 'error', detail: error?.message || String(error), elapsedMs: performance.now() - startedAt };
        throw error;
    } finally {
        combatRecognitionBusy = false;
        combatBusy = false;
        stopCombatRecognitionClock();
        renderCombat();
    }
}

function collectCombatUnitStrategies() {
    const assignments = {};
    $$('[data-combat-unit-strategy]').forEach(select => {
        const unitId = select.dataset.combatUnitStrategy;
        const presetId = combatUnitStrategySelections[unitId] || select.value;
        if (!presetId || presetId === 'inherit') return;
        const preset = COMBAT_STRATEGY_PRESETS[presetId];
        if (preset) assignments[unitId] = { presetId, text: preset.text };
    });
    return assignments;
}

async function compileCombatStrategy(confirmed) {
    let compiled;
    if (!confirmed && combatConnection()) {
        const response = await callCombatAi('你是战斗策略编译器。只把玩家策略转换为 JSON，不计算战果。允许字段：priorities(nearest/weakest/boss 的排列)、preserveEpPercent、allowItems、allowFriendlyFire、retreat、reactionPolicy(auto/conserve)、takeoverTriggers([{field,operator,value}])。field 仅限 playerHpPercent/playerEpPercent/enemyDefeatedPercent/allyDying/bossPhaseChanged/round/noLegalAction。只输出 JSON。', `战场摘要：${JSON.stringify({ round: combatState.round, zones: combatState.zones, cohorts: combatState.cohorts })}\n玩家策略：${$('#combatStrategy').value}`, 'strategy_compile');
        compiled = extractJsonObject(response.content);
    }
    await mutateCombat('strategy/compile', { text: $('#combatStrategy').value, mode: $('#combatMode').value, confirmed, compiled, assignments: collectCombatUnitStrategies() });
}

function combatLoadSummary(state) {
    const units = Array.isArray(state?.combatants) ? state.combatants : [];
    return {
        id: state?.id || null, status: state?.status || null, version: state?.version ?? null,
        hasBattlefield: Boolean(state?.battlefield), battlefieldShape: state?.battlefield?.shape || null,
        battlefield: state?.battlefield ? { widthMeters: state.battlefield.widthMeters, heightMeters: state.battlefield.heightMeters, radiusMeters: state.battlefield.radiusMeters, center: state.battlefield.center } : null,
        zoneCount: Array.isArray(state?.zones) ? state.zones.length : 0, combatantCount: units.length,
        missingPositions: units.filter(unit => !Number.isFinite(Number(unit.position?.x)) || !Number.isFinite(Number(unit.position?.y))).length,
        activeUnitId: state?.activeUnitId || null, compatibilityDebug: state?.compatibilityDebug || null,
    };
}

async function loadCombat({ quiet = false } = {}) {
    if (isCombatSimulation()) {
        try {
            const [state, ledger] = await Promise.all([combatRequest(`/${combatState.id}`), combatRequest(`/${combatState.id}/events?limit=250&tail=1`)]);
            combatState = state; combatUnitStrategySelections = {}; combatEvents = ledger.events || []; combatMapMenu = null; combatMapIntent = null; combatMapZoom = 1; combatMapPan = { x: 0, y: 0 }; combatSelectedUnitId = state?.activeUnitId || null; combatEntityInspectorUnitId = null; combatPromptTraceCache = null; snapCombatFlowPhase();
            await blackbox.record('combat', 'combat_load_diagnostics', { source: 'simulation', summary: combatLoadSummary(state), eventCount: combatEvents.length }, { sessionId: store.activeSession?.id });
            renderCombat();
        } catch (error) { await blackbox.record('combat', 'combat_load_failed', { source: 'simulation', battleId: combatState?.id || null, error }, { sessionId: store.activeSession?.id }); if (!quiet) toast(`读取模拟战斗失败：${error.message}`, 'error'); }
        return;
    }
    const id = activeBattleId();
    if (!id) { combatState = null; combatUnitStrategySelections = {}; combatEvents = []; combatMapMenu = null; combatMapIntent = null; combatMapZoom = 1; combatMapPan = { x: 0, y: 0 }; combatSelectedUnitId = null; combatEntityInspectorUnitId = null; combatPromptTraceCache = null; snapCombatFlowPhase(); combatNarrationBusy = false; combatNarrationState = { battleId: null, phase: 'idle', detail: '' }; renderCombat(); return; }
    try {
        const [state, ledger] = await Promise.all([combatRequest(`/${id}`), combatRequest(`/${id}/events?limit=250&tail=1`)]);
        combatState = state; combatUnitStrategySelections = {}; combatEvents = ledger.events || []; combatMapMenu = null; combatMapIntent = null; combatMapZoom = 1; combatMapPan = { x: 0, y: 0 }; combatSelectedUnitId = state?.activeUnitId || null; combatEntityInspectorUnitId = null; combatPromptTraceCache = null; snapCombatFlowPhase();
        const summary = combatLoadSummary(state);
        await blackbox.record('combat', 'combat_load_diagnostics', { source: 'archive', summary, eventCount: combatEvents.length, renderable: Boolean(state?.battlefield && state?.combatants?.length) }, { sessionId: store.activeSession?.id });
        if (!summary.hasBattlefield) await blackbox.record('combat', 'combat_load_spatial_missing', { battleId: id, summary, hint: '请求 /api/combat/:id/debug 获取后端原始/投影对照' }, { sessionId: store.activeSession?.id });
        renderCombat();
    } catch (error) { await blackbox.record('combat', 'combat_load_failed', { source: 'archive', battleId: id, error }, { sessionId: store.activeSession?.id }); if (!quiet) toast(`读取战斗失败：${error.message}`, 'error'); }
}

async function mutateCombat(route, payload = {}) {
    if (!combatState || combatBusy) return;
    combatBusy = true; renderCombat();
    // The ledger is append-only. Fetch only the events produced by this
    // command; refetching a 20k+ event battle made every later turn slower.
    const eventSequenceBefore = combatEvents.at(-1)?.sequence || 0;
    try {
        combatState = await combatRequest(`/${combatState.id}/${route}`, { method: 'POST', body: JSON.stringify({ commandId: crypto.randomUUID(), expectedVersion: combatState.version, ...payload }) });
        const newEvents = (await combatRequest(`/${combatState.id}/events?after=${eventSequenceBefore}`)).events || [];
        combatEvents = [...combatEvents, ...newEvents];
        snapCombatFlowPhase();
        showCombatActionNotice(combatActionNoticeFromEvents(newEvents, combatState, payload.actorId, payload.type));
        if (!isCombatSimulation()) {
            const system = runtime.variables.stat_data['系统状态'] ||= {};
            system['是否战斗中'] = !['completed', 'abandoned'].includes(combatState.status);
            system['当前轮次'] = combatState.round;
            await runtime.replaceVariables(runtime.variables);
            await blackbox.record('combat', `combat_${route.replace(/\W+/g, '_')}`, { battleId: combatState.id, state: combatState, latestEvents: combatEvents.slice(-20) }, { sessionId: store.activeSession?.id });
            renderHudAndHub();
        }
        renderCombat();
    } catch (error) {
        const blockingUnitIds = error?.debug?.error?.details?.blockingUnitIds;
        if (Array.isArray(blockingUnitIds) && blockingUnitIds.length) {
            combatForcedUnitIds = new Set(blockingUnitIds.map(String));
            combatSelectedUnitId = String(blockingUnitIds[0]);
            combatEntityInspectorUnitId = String(blockingUnitIds[0]);
            combatMapIntent = null;
            combatMapMenu = null;
        }
        showCombatActionNotice({ kind: 'error', text: error.message || '战斗操作失败' });
        throw error;
    } finally { combatBusy = false; renderCombat(); }
}

function battlefieldTransform(canvas, battlefield) {
    const rect = canvas.getBoundingClientRect();
    const pad = 22;
    const width = battlefield.shape === 'circle' ? battlefield.radiusMeters * 2 : battlefield.widthMeters;
    const height = battlefield.shape === 'circle' ? battlefield.radiusMeters * 2 : battlefield.heightMeters;
    const baseScale = Math.max(.1, Math.min((rect.width - pad * 2) / width, (rect.height - pad * 2) / height));
    const scale = baseScale * Math.min(3, Math.max(.5, Number(combatMapZoom) || 1));
    const originX = rect.width / 2 - battlefield.center.x * scale + Number(combatMapPan.x || 0);
    const originY = rect.height / 2 + battlefield.center.y * scale + Number(combatMapPan.y || 0);
    return { rect, pad, scale, zoom: combatMapZoom, baseScale, originX, originY, toCanvas: position => ({ x: originX + position.x * scale, y: originY - position.y * scale }), toWorld: ({ x, y }) => ({ x: (x - originX) / scale, y: (originY - y) / scale }) };
}

function combatVisibleIds(state) {
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

function combatIntelSummary(state) {
    const visibleIds = combatVisibleIds(state);
    const playerIds = new Set((state?.combatants || []).filter(unit => unit.side === 'player').map(unit => unit.id));
    const known = Object.entries(state?.intel?.knowledge || {}).filter(([observerId]) => playerIds.has(observerId)).flatMap(([, entries]) => Object.values(entries || [])).filter(entry => entry?.canTarget);
    const sources = { visual: 0, auditory: 0, intel: 0, melee_contact: 0, shared: 0 };
    for (const entry of known) if (Object.hasOwn(sources, entry.source)) sources[entry.source] += 1;
    const labels = [['visual', '视觉'], ['auditory', '听觉'], ['intel', '情报'], ['melee_contact', '近战'], ['shared', '共享']].filter(([key]) => sources[key]).map(([key, label]) => `${label} ${sources[key]}`);
    const visibleEnemies = (state?.combatants || []).filter(unit => unit.side === 'enemy' && visibleIds.has(unit.id)).length;
    const hiddenEnemies = (state?.combatants || []).filter(unit => unit.side === 'enemy' && !visibleIds.has(unit.id)).length;
    return { visibleEnemies, hiddenEnemies, text: labels.length ? labels.join(' · ') : '尚未确认敌方信息' };
}

function combatSelectedUnit(state) {
    if (!state?.combatants?.length) return null;
    const preferred = state.combatants.find(unit => unit.id === combatSelectedUnitId);
    if (preferred) return preferred;
    const active = state.combatants.find(unit => unit.id === state.activeUnitId);
    combatSelectedUnitId = active?.id || state.combatants[0].id;
    return active || state.combatants[0];
}

function combatAssetProfilesForUnit(unit, state) {
    const profiles = new Map((state?.assetProfiles || []).map(profile => [String(profile.assetId), profile]));
    const ids = [
        ...(Array.isArray(unit?.assetBindings) ? unit.assetBindings : []),
        ...(Array.isArray(unit?.equipment) ? unit.equipment.map(item => typeof item === 'string' ? item : item?.assetId || item?.id) : []),
        ...(Array.isArray(unit?.equipments) ? unit.equipments.map(item => typeof item === 'string' ? item : item?.assetId || item?.id) : []),
    ].filter(Boolean).map(String);
    return ids.map(id => profiles.get(id) || { assetId: id, name: id }).filter((profile, index, list) => list.findIndex(item => item.assetId === profile.assetId) === index);
}

function combatStrategyPresetOptions(unit, state) {
    const selected = combatUnitStrategySelections[unit.id] || state?.strategy?.assignments?.[unit.id]?.presetId || 'inherit';
    const options = [`<option value="inherit" ${selected === 'inherit' ? 'selected' : ''}>跟随上方策略</option>`];
    for (const [id, preset] of Object.entries(COMBAT_STRATEGY_PRESETS)) options.push(`<option value="${id}" ${selected === id ? 'selected' : ''}>${escapeHtml(preset.label)}</option>`);
    return options.join('');
}

function combatUnitModeOptions(unit) {
    const selected = unit.controlMode || 'follow';
    return `<option value="follow" ${selected === 'follow' ? 'selected' : ''}>跟随全局</option><option value="manual" ${selected === 'manual' ? 'selected' : ''}>本单位手操</option><option value="auto" ${selected === 'auto' ? 'selected' : ''}>本单位自动</option>`;
}

function combatObjectRows(value, labels = {}) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
    return Object.entries(value).map(([key, val]) => `<div class="combat-detail-row"><span>${escapeHtml(labels[key] || key)}</span><b>${escapeHtml(typeof val === 'object' ? JSON.stringify(val) : String(val ?? '—'))}</b></div>`).join('');
}

function combatEntityInspectorMarkup(unit, state) {
    if (!unit) return '';
    const equipment = combatAssetProfilesForUnit(unit, state);
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
        <section class="combat-detail-section"><h4>战场定位</h4><div class="combat-detail-grid">${combatObjectRows({ '坐标': `(${Number(pos.x || 0).toFixed(2)}, ${Number(pos.y || 0).toFixed(2)})`, 朝向: `${Number(unit.facingDegrees || 0).toFixed(0)}°`, 半径: `${unit.radiusMeters ?? '—'}m`, 基础移速: `${unit.baseSpeedMeters ?? unit.speedMeters ?? '—'}m`, 有效移速: `${Number(unit.baseSpeedMeters ?? unit.speedMeters ?? 0) + Math.floor(Math.max(0, Number(attrs.dexterityModifier || 0)) / 2)}m/回合`, 视觉: `${unit.visionMeters ?? '—'}m · ${unit.fovDegrees ?? 120}°`, 区域: unit.zoneId || '—', 阵营: unit.side || '—', 控制: unit.controller || '—' })}</div></section>
        <section class="combat-detail-section"><h4>核心战斗数值</h4><div class="combat-detail-grid">${combatObjectRows({ 攻击: unit.attack, 魔攻: unit.magicAttack, 攻击修正: unit.attackModifier, 防御DC: unit.defenseDC, 先攻DC: unit.initiativeDC, 护甲: unit.armor, 抗性: unit.resistance, 临时HP: unit.thp ?? 0, 五维: Object.entries(attrs).map(([key, val]) => `${key}:${val}`).join(' · ') || '—' })}</div></section>
        <section class="combat-detail-section"><h4>状态与冷却</h4><div class="combat-detail-chips">${statusMarkup}</div><div class="combat-detail-chips">${cooldownMarkup}</div></section>
        <section class="combat-detail-section"><h4>装备 / 本地战斗资料</h4><div class="combat-detail-cards">${equipmentMarkup}</div></section>
        <section class="combat-detail-section"><h4>技能清单</h4><div class="combat-detail-cards">${abilityMarkup}</div></section>
        <section class="combat-detail-section"><h4>常驻被动</h4><div class="combat-detail-cards">${passiveMarkup}</div></section>
        <section class="combat-detail-section"><h4>侦察与战术</h4><div class="combat-detail-grid">${combatObjectRows(unit.intelProfile, { presence: '显眼程度', stealthBonus: '潜行修正', perceptionBonus: '感知修正', commandBonus: '指挥修正', hearingMeters: '听觉范围', intelligenceRangeMeters: '情报范围', intelligenceBonus: '情报修正' })}${combatObjectRows(unit.tacticalProfile, { archetype: '组织类型', groupId: '群组', objective: '目标', focusRule: '集火规则', coordinationRadiusMeters: '协同范围' })}</div></section>
    </aside>`;
}

function combatMapMenuMarkup(state, actor) {
    if (!combatMapMenu || !actor) return '';
    const manual = state?.pauseReason?.type === 'manual_turn' && state?.activeUnitId === actor.id;
    const legal = (state?.pauseReason?.legalActions || []).filter(ability => ability.actionAvailable);
    const abilities = legal.filter(ability => ability.type !== 'maneuver');
    const maneuvers = legal.filter(ability => ability.type === 'maneuver');
    const abilityButtons = abilities.map(ability => `<button data-action="combat-map-menu-ability" data-combat-ability-id="${escapeHtml(ability.id)}" data-combat-script="${ability.scriptHash ? 'true' : 'false'}"><b>${escapeHtml(ability.name)}</b><small>射程 ${escapeHtml(ability.minRangeMeters ?? 0)}–${escapeHtml(ability.maxRangeMeters ?? 0)}m · EP ${escapeHtml(ability.epCost ?? 0)}</small></button>`).join('');
    const maneuverButtons = maneuvers.map(maneuver => `<button data-action="combat-map-menu-maneuver" data-combat-maneuver="${escapeHtml(maneuver.id)}" ${manual ? '' : 'disabled'}><b>${escapeHtml(maneuver.name)}</b><small>${escapeHtml(maneuver.detail || '本地机动规则')}</small></button>`).join('');
    const remaining = Number(state.turnBudget?.[actor.id]?.movementMeters ?? actor.speedMeters ?? 0);
    const basic = legal.find(ability => ability.id === 'basic-attack');
    const moveAttackButton = basic && manual && remaining > 0 ? `<button data-action="combat-map-menu-move-attack"><b>移动攻击</b><small>自动移动到最短基础攻击距离后攻击</small></button>` : '';
    return `<div class="combat-map-menu" role="menu"><header><b>${escapeHtml(actor.name || actor.id)}</b><small>${manual ? `移动 ${remaining.toFixed(1)}m · 体力 ${actor.exertion ?? 0}/${actor.maxExertion ?? 0}` : '当前不可手操'}</small></header><button data-action="combat-map-menu-move" ${manual && remaining > 0 ? '' : 'disabled'}><b>移动到这里</b><small>剩余 ${remaining.toFixed(1)}m 落点</small></button>${moveAttackButton}${maneuverButtons}${abilityButtons || '<small class="combat-menu-empty">暂无可用技能</small>'}<button data-action="combat-map-menu-wait" ${manual ? '' : 'disabled'}><b>结束行动</b><small>恢复体力并交给本地演算继续</small></button></div>`;
}

function showCombatActionNotice(notice) {
    combatActionNotice = notice ? { text: String(notice.text || notice), kind: notice.kind || 'info' } : null;
    if (combatActionNoticeTimer) clearTimeout(combatActionNoticeTimer);
    if (combatActionNotice) combatActionNoticeTimer = setTimeout(() => { combatActionNotice = null; combatActionNoticeTimer = null; renderCombat(); }, 3000);
}

function combatActionNoticeFromEvents(events, state, actorId = null, actionType = null) {
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

function selectedCombatRanges(unit, state) {
    if (!unit) return { movement: 0, attacks: [] };
    const budget = state?.turnBudget?.[unit.id];
    const movement = Math.max(0, Number(budget?.movementMeters ?? unit.speedMeters ?? unit.baseSpeedMeters ?? 0));
    const attacks = (Array.isArray(unit.abilities) ? unit.abilities : []).map(ability => ({
        id: String(ability.id || ability.name || 'attack'), name: String(ability.name || ability.id || '攻击'), min: Math.max(0, Number(ability.minRangeMeters || 0)), max: Math.max(0, Number(ability.maxRangeMeters ?? (ability.range === 'far' ? 1000 : ability.range === 'contact' ? 1.5 : 8))),
    })).filter(ability => ability.max > 0 && Number.isFinite(ability.max)).sort((a, b) => a.max - b.max);
    return { movement, attacks };
}

function combatRangeLegendMarkup(unit, state) {
    if (!unit) return '';
    const ranges = selectedCombatRanges(unit, state);
    const attackText = [...new Map(ranges.attacks.map(item => [item.max, item])).values()].slice(0, 4).map(item => `${escapeHtml(item.name)} ${item.min > 0 ? `${item.min}–` : '≤'}${item.max}m`).join(' · ');
    return `<div class="combat-range-legend"><b>已选：${escapeHtml(unit.name || unit.id)}</b><span class="movement-range-key">移动 ${ranges.movement.toFixed(1)}m</span>${attackText ? `<span class="attack-range-key">攻击：${attackText}</span>` : '<span class="attack-range-key">无可用攻击射程</span>'}</div>`;
}

function drawCombatMap() {
    const canvas = $('#combatMap'); const state = combatState;
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
    if (actor && combatMapIntent?.type === 'ability') {
        const ability = actor.abilities.find(item => item.id === combatMapIntent.abilityId);
        if (ability) { const center = transform.toCanvas(actor.position); context.beginPath(); context.arc(center.x, center.y, Number(ability.maxRangeMeters || 0) * transform.scale, 0, Math.PI * 2); context.strokeStyle = '#e0b96588'; context.setLineDash([5, 5]); context.stroke(); context.setLineDash([]); }
    }
    const selectedForFov = state.combatants.find(unit => unit.id === combatSelectedUnitId) || actor;
    if (selectedForFov) {
        const center = transform.toCanvas(selectedForFov.position); const radians = Number(selectedForFov.facingDegrees || 0) * Math.PI / 180;
        const half = Number(selectedForFov.fovDegrees || 120) * Math.PI / 360;
        context.beginPath(); context.moveTo(center.x, center.y); context.arc(center.x, center.y, Number(selectedForFov.visionMeters || 0) * transform.scale, -radians - half, -radians + half); context.closePath(); context.fillStyle = selectedForFov.side === 'player' ? '#89d77212' : '#d36b5b12'; context.fill(); context.strokeStyle = selectedForFov.side === 'player' ? '#9dda7355' : '#d36b5b55'; context.lineWidth = 1; context.stroke();
        const ranges = selectedCombatRanges(selectedForFov, state);
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
    if (actor && combatMapIntent?.type === 'move') { const center = transform.toCanvas(actor.position); const meters = Number(state.turnBudget?.[actor.id]?.movementMeters ?? actor.speedMeters ?? 0); context.beginPath(); context.arc(center.x, center.y, meters * transform.scale, 0, Math.PI * 2); context.strokeStyle = '#9dda73aa'; context.setLineDash([4, 4]); context.stroke(); context.setLineDash([]); }
    if (actor && combatMapIntent?.type === 'withdraw') { const center = transform.toCanvas(actor.position); context.beginPath(); context.arc(center.x, center.y, (2 + Math.floor(Math.max(0, Number(actor.attributes?.dexterityModifier || 0)) / 2)) * transform.scale, 0, Math.PI * 2); context.strokeStyle = '#e0b965aa'; context.setLineDash([3, 3]); context.stroke(); context.setLineDash([]); }
    if (actor && combatMapIntent?.type === 'lure') { const center = transform.toCanvas(actor.position); context.beginPath(); context.arc(center.x, center.y, (6 + Math.max(0, Number(actor.attributes?.charismaModifier || 0)) * 2) * transform.scale, 0, Math.PI * 2); context.strokeStyle = '#b787f5aa'; context.setLineDash([3, 3]); context.stroke(); context.setLineDash([]); }
    const unitById = new Map(state.combatants.map(unit => [unit.id, unit]));
    const playerObserver = state.combatants.find(item => item.side === 'player');
    const visibleIds = combatVisibleIds(state);
    const visibleUnits = state.combatants.filter(unit => visibleIds.has(unit.id));
    const cohorts = new Map();
    for (const unit of visibleUnits) {
        const key = `${unit.side}:${unit.templateId || unit.name}:${unit.boss ? unit.id : ''}`;
        const list = cohorts.get(key) || []; list.push(unit); cohorts.set(key, list);
    }
    const lastKnown = Object.entries(state.intel?.lastKnownPositions || {}).map(([id, position]) => ({ id, position, unit: unitById.get(id) })).filter(entry => entry.unit?.side === 'enemy' && !visibleIds.has(entry.id));
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
        const selected = unit.id === combatSelectedUnitId;
        const forced = combatForcedUnitIds.has(unit.id) || state.movementBlockers?.unitIds?.includes(unit.id);
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
    context.restore();
}

function renderBattlefieldMap(state) {
    const root = $('#combatZones');
    if (!state?.battlefield) { root.innerHTML = '<div class="empty-state">创建遭遇后显示二维战场</div>'; return; }
    const actor = state.combatants.find(unit => unit.id === state.activeUnitId);
    combatSelectedUnit(state);
    const intent = combatMapIntent?.type === 'move' ? '已选择移动：点选可达落点' : combatMapIntent?.type === 'withdraw' ? '已选择战术脱离：点选4米内的方向' : combatMapIntent?.type === 'lure' ? '已选择诱导：点选声源位置' : combatMapIntent?.type === 'ability' ? `已选择技能：点选目标 · ${combatMapIntent.abilityName}` : '点击实体查看详情 · 点击空白处打开行动菜单';
    const field = state.battlefield;
    const intel = combatIntelSummary(state);
    const notice = combatActionNotice ? `<div class="combat-action-notice ${escapeHtml(combatActionNotice.kind)}" role="status">${escapeHtml(combatActionNotice.text)}</div>` : '';
    const inspectorUnit = combatEntityInspectorUnitId ? state.combatants.find(unit => unit.id === combatEntityInspectorUnitId) : null;
    const selectedUnit = state.combatants.find(unit => unit.id === combatSelectedUnitId) || actor;
    root.innerHTML = `<div class="combat-map-wrap">${notice}<div class="combat-map-zoom" role="toolbar" aria-label="战场缩放"><button data-action="combat-map-zoom-out" title="缩小">−</button><button data-action="combat-map-zoom-reset" title="恢复 100%">${Math.round(combatMapZoom * 100)}%</button><button data-action="combat-map-zoom-in" title="放大">＋</button><button data-action="combat-map-zoom-200" title="快速放大到 200%">200%</button></div><canvas id="combatMap" aria-label="二维战场"></canvas>${combatRangeLegendMarkup(selectedUnit, state)}${combatMapMenuMarkup(state, actor)}${combatEntityInspectorMarkup(inspectorUnit, state)}<div class="combat-map-caption"><span>${escapeHtml(field.shape === 'circle' ? `圆形 · 半径 ${field.radiusMeters}m` : `矩形 · ${field.widthMeters}m × ${field.heightMeters}m`)}</span><b>${escapeHtml(intent)}</b><span title="${escapeHtml(intel.text)}">情报：已见敌 ${intel.visibleEnemies}${intel.hiddenEnemies ? ` · 未确认 ${intel.hiddenEnemies}` : ''}</span></div></div>`;
    requestAnimationFrame(() => {
        drawCombatMap();
        if (combatMapIntent) {
            const cancel = document.createElement('button');
            cancel.type = 'button';
            cancel.className = 'combat-intent-cancel';
            cancel.dataset.action = 'combat-map-cancel';
            cancel.textContent = '取消当前操作';
            cancel.title = '退出当前攻击、移动或机动目标选择';
            $('#combatZones .combat-map-wrap')?.append(cancel);
        }
        if (combatMapMenu) {
            const cancelMenu = document.createElement('button');
            cancelMenu.type = 'button';
            cancelMenu.className = 'combat-menu-cancel';
            cancelMenu.dataset.action = 'combat-map-menu-cancel';
            cancelMenu.textContent = '关闭行动菜单';
            $('#combatZones .combat-map-menu')?.append(cancelMenu);
        }
        const menu = $('#combatZones .combat-map-menu');
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
            const secondaryButtons = [...menu.querySelectorAll('[data-action="combat-map-menu-maneuver"]')];
            if (secondaryButtons.length) {
                const secondary = document.createElement('details');
                secondary.className = 'combat-secondary-actions';
                const summary = document.createElement('summary');
                summary.textContent = '其他行动';
                const body = document.createElement('div');
                secondary.append(summary, body);
                secondaryButtons.forEach(button => body.append(button));
                const cancel = menu.querySelector('.combat-menu-cancel');
                (cancel ? menu.insertBefore(secondary, cancel) : menu.append(secondary));
            }
        }
        const canvas = $('#combatMap');
        canvas?.addEventListener('wheel', event => {
            event.preventDefault();
            const next = Number(combatMapZoom) + (event.deltaY < 0 ? .1 : -.1);
            combatMapZoom = Math.min(3, Math.max(.5, Math.round(next * 10) / 10));
            drawCombatMap();
            const button = document.querySelector('.combat-map-zoom [data-action="combat-map-zoom-reset"]');
            if (button) button.textContent = `${Math.round(combatMapZoom * 100)}%`;
        }, { passive: false });
        // Zooming is useful only when the enlarged field can also be moved.
        // Pointer events keep this identical on mouse, pen and touch; a short
        // tap still falls through to the existing entity/action-menu click.
        canvas?.addEventListener('pointerdown', event => {
            if (event.button !== undefined && event.button !== 0) return;
            combatMapPointer = { id: event.pointerId, x: event.clientX, y: event.clientY, moved: false, pan: { ...combatMapPan } };
            canvas.setPointerCapture?.(event.pointerId);
            canvas.style.cursor = 'grabbing';
        });
        canvas?.addEventListener('pointermove', event => {
            const pointer = combatMapPointer;
            if (!pointer || pointer.id !== event.pointerId) return;
            const dx = event.clientX - pointer.x; const dy = event.clientY - pointer.y;
            if (!pointer.moved && Math.hypot(dx, dy) < 3) return;
            pointer.moved = true;
            combatMapPan = { x: pointer.pan.x + dx, y: pointer.pan.y + dy };
            drawCombatMap();
        });
        const finishMapPointer = event => {
            const pointer = combatMapPointer;
            if (!pointer || pointer.id !== event.pointerId) return;
            if (pointer.moved) combatMapSuppressClickUntil = Date.now() + 120;
            combatMapPointer = null;
            canvas.style.cursor = 'grab';
            canvas.releasePointerCapture?.(event.pointerId);
        };
        canvas?.addEventListener('pointerup', finishMapPointer);
        canvas?.addEventListener('pointercancel', finishMapPointer);
        canvas?.addEventListener('pointerleave', event => {
            // Keep a captured drag alive when the pointer leaves the canvas;
            // only pointerup/pointercancel terminates it.
            if (combatMapPointer?.id === event.pointerId) return;
            canvas.style.cursor = 'grab';
        });
    });
}

async function handleCombatMapClick(event) {
    const canvas = event.target.closest('#combatMap');
    if (!canvas || !combatState?.battlefield) return false;
    if (Date.now() < combatMapSuppressClickUntil) return true;
    const transform = canvas._battlefieldTransform || battlefieldTransform(canvas, combatState.battlefield);
    const bounds = canvas.getBoundingClientRect(); const world = transform.toWorld({ x: event.clientX - bounds.left, y: event.clientY - bounds.top });
    const visibleIds = combatVisibleIds(combatState);
    const hit = combatState.combatants.filter(unit => visibleIds.has(unit.id)).sort((a, b) => Math.hypot(a.position.x - world.x, a.position.y - world.y) - Math.hypot(b.position.x - world.x, b.position.y - world.y)).find(unit => Math.hypot(unit.position.x - world.x, unit.position.y - world.y) <= Math.max(unit.radiusMeters, .7, 10 / Math.max(.1, transform.scale)));
    const actor = combatState.combatants.find(unit => unit.id === combatState.activeUnitId);
    // A completed battle has no activeUnitId, but the 2D field must remain
    // inspectable. The old early return swallowed every canvas click and made
    // the terminal look frozen immediately after the last action. Without an
    // active actor we only allow inspection; action menus stay disabled.
    if (!actor) {
        combatMapIntent = null;
        combatMapMenu = null;
        if (hit) {
            combatSelectedUnitId = hit.id;
            combatEntityInspectorUnitId = hit.id;
            recordCombatDebug('map_entity_selected_inactive_battle', { unitId: hit.id, side: hit.side, state: combatState.status, world });
        } else {
            combatEntityInspectorUnitId = null;
            recordCombatDebug('map_click_inactive_battle', { state: combatState.status, world });
        }
        renderCombat();
        return true;
    }
    if (!combatMapIntent) {
        if (hit) {
            combatSelectedUnitId = hit.id; combatEntityInspectorUnitId = hit.id; combatMapMenu = null;
            recordCombatDebug('map_entity_selected', { unitId: hit.id, side: hit.side, world });
        } else {
            combatSelectedUnitId = actor.id; combatEntityInspectorUnitId = null;
            const localX = event.clientX - bounds.left; const localY = event.clientY - bounds.top;
            combatMapMenu = { world };
            recordCombatDebug('map_action_menu_opened', { actorId: actor.id, world, x: localX, y: localY });
        }
        renderCombat();
        return true;
    }
    if (combatMapIntent.type === 'move' || combatMapIntent.type === 'withdraw' || combatMapIntent.type === 'lure') {
        const type = combatMapIntent.type;
        combatMapIntent = null;
        combatMapMenu = null;
        try { await mutateCombat('commands', { type, actorId: actor.id, x: Math.round(world.x * 100) / 100, y: Math.round(world.y * 100) / 100 }); }
        catch (error) { combatMapIntent = { type }; toast(`${type === 'lure' ? '诱导' : type === 'withdraw' ? '脱离' : '移动'}无效：${error.message}`, 'error'); renderCombat(); }
        return true;
    }
    const abilityHit = hit?.id === actor.id ? null : hit;
    if (!abilityHit) {
        const cancelled = { ...combatMapIntent };
        combatMapIntent = null;
        combatMapMenu = null;
        recordCombatDebug('map_target_miss_cancelled', { actorId: actor.id, world, intent: cancelled });
        toast('未选中合法目标，已退出当前攻击模式。', 'info');
        renderCombat();
        return true;
    }
    if (combatMapIntent.type === 'move_attack') {
        const intent = combatMapIntent; combatMapIntent = null; combatMapMenu = null;
        try { await mutateCombat('commands', { type: 'move_attack', actorId: actor.id, targetId: abilityHit.id }); }
        catch (error) { combatMapIntent = intent; toast(`移动攻击无效：${error.message}`, 'error'); renderCombat(); }
        return true;
    }
    const intent = combatMapIntent; combatMapIntent = null;
    combatMapMenu = null;
    recordCombatDebug('map_target_selected', { actorId: actor.id, targetId: abilityHit.id, abilityId: intent.abilityId, abilityName: intent.abilityName, world, distance: Math.hypot(actor.position.x - abilityHit.position.x, actor.position.y - abilityHit.position.y), edgeDistance: Math.max(0, Math.hypot(actor.position.x - abilityHit.position.x, actor.position.y - abilityHit.position.y) - Number(actor.radiusMeters || .5) - Number(abilityHit.radiusMeters || .5)), meleeSlot: combatState.meleeSlots?.targets?.[abilityHit.id] || null });
    try { await mutateCombat('commands', { type: intent.script ? 'script' : 'attack', actorId: actor.id, abilityId: intent.abilityId, targetIds: [abilityHit.id] }); }
    catch (error) { combatMapIntent = intent; toast(`目标无效：${error.message}`, 'error'); renderCombat(); }
    return true;
}

const COMBAT_LEDGER_CATEGORIES = Object.freeze([
    { key: 'initiative', label: '先攻与行动顺序', icon: '⚑', types: new Set(['initiative_roll', 'initiative_order_locked', 'round_started']) },
    { key: 'attack', label: '攻击与伤害', icon: '⚔', types: new Set(['attack_check', 'action_resolved', 'evasion_consumed']) },
    { key: 'skill', label: '技能与脚本', icon: '✦', types: new Set(['script_action_resolved', 'script_approval_required', 'script_approved']) },
    { key: 'movement', label: '移动与机动', icon: '↗', types: new Set(['unit_moved', 'unit_waited', 'maneuver_resolved', 'strategy_retreat', 'turn_skipped']) },
    { key: 'intel', label: '侦察与潜行', icon: '◉', types: new Set(['intel_check', 'intel_detected', 'intel_shared', 'awareness_changed', 'noise_emitted', 'stealth_entered', 'stealth_broken', 'hide_resolved', 'tracking_lost', 'guerrilla_posture_changed', 'guerrilla_escape_assessed', 'lure_created']) },
    { key: 'state', label: '状态与系统', icon: '◆', types: new Set() },
]);

function combatLedgerCategory(event) {
    return COMBAT_LEDGER_CATEGORIES.find(category => category.types.has(event?.type)) || COMBAT_LEDGER_CATEGORIES.at(-1);
}

function combatUnitName(state, id) {
    return state?.combatants?.find(unit => unit.id === id)?.name || id || '未知单位';
}

function combatOutcomeLabel(outcome) {
    return ({ hit: '命中', miss: '未命中', disaster: '灾难', miracle: '奇迹', success: '成功', failure: '失败' }[outcome] || outcome || '已结算');
}

function combatLedgerSummary(event, state) {
    const payload = event?.payload || {};
    const actor = combatUnitName(state, payload.actorId || payload.unitId || payload.observerId);
    if (event.type === 'attack_check') {
        const target = combatUnitName(state, payload.targetId);
        const roll = payload.selected === undefined ? '' : `D100 ${payload.selected} + ${payload.modifier ?? 0} = ${payload.total ?? '—'} / DC ${payload.defenseDC ?? '—'}`;
        const damage = payload.damage?.final !== undefined ? ` · 伤害 ${payload.damage.final}` : ' · 未造成伤害';
        const hp = payload.applied?.after?.hp !== undefined ? ` · 目标 HP ${payload.applied.after.hp}` : '';
        return `${actor} ${payload.counterattack ? '被动反击' : '攻击'} ${target} · ${combatOutcomeLabel(payload.outcome)}${payload.ambush ? ' · 伏击' : ''} · ${roll}${damage}${hp}`;
    }
    if (event.type === 'action_resolved' || event.type === 'script_action_resolved') {
        const results = Array.isArray(payload.results) ? payload.results : [];
        const resultText = results.map(result => `${combatUnitName(state, result.targetId)} ${combatOutcomeLabel(result.outcome)}${result.damage?.final !== undefined ? ` ${result.damage.final}伤害` : ''}${result.applied?.after?.hp !== undefined ? `（HP ${result.applied.after.hp}）` : ''}`).join('；');
        return `${actor} ${event.type === 'script_action_resolved' ? '脚本/技能结算' : '攻击结算'}${resultText ? ` · ${resultText}` : ''}${payload.epCost ? ` · EP -${payload.epCost}` : ''}`;
    }
    if (event.type === 'initiative_roll') return `${actor} 先攻检定 · D100 ${payload.selected ?? '—'} + ${payload.initiativeDC ?? 0} = ${payload.total ?? '—'}`;
    if (event.type === 'initiative_order_locked') {
        const order = Array.isArray(payload.order) ? payload.order.map(item => `${item.rank ?? '—'}.${combatUnitName(state, item.unitId)}`).join(' → ') : '—';
        return `先攻全部完成${payload.allUnitsRolled === false ? '（不完整）' : ''} · 行动顺序：${order}`;
    }
    if (event.type === 'evasion_consumed') return `${combatUnitName(state, payload.targetId)} 消耗闪避次数 · 剩余 ${payload.remainingAttacks ?? 0}`;
    if (event.type === 'unit_moved') return `${actor} 移动 ${Number(payload.distanceMeters || 0).toFixed(1)}m · (${Number(payload.to?.x || 0).toFixed(1)}, ${Number(payload.to?.y || 0).toFixed(1)})`;
    if (event.type === 'unit_waited') return `${actor} 结束行动${payload.reason ? ` · ${payload.reason}` : ''}`;
    if (event.type === 'maneuver_resolved') return `${actor} 机动：${payload.maneuver || '已完成'}${payload.distanceMeters ? ` · ${Number(payload.distanceMeters).toFixed(1)}m` : ''}`;
    if (event.type === 'strategy_retreat') return `${actor} 按策略撤离${payload.targetId ? ` · 远离 ${combatUnitName(state, payload.targetId)}` : ''}`;
    if (event.type === 'turn_skipped') return `${actor} 回合被跳过${payload.reason ? ` · ${payload.reason}` : ''}`;
    if (event.type === 'intel_check') return `${actor} 对 ${combatUnitName(state, payload.targetId)} 进行${payload.source || '情报'}发现检定 · ${payload.selected ?? '—'} + ${payload.modifier ?? 0} = ${payload.total ?? '—'} / DC ${payload.dc ?? '—'} · ${payload.success ? '发现' : '未发现'}`;
    if (event.type === 'intel_detected') return `${actor} 通过${payload.source || '情报'}发现 ${combatUnitName(state, payload.targetId)} · ${payload.awareness || '已确认'}`;
    if (event.type === 'awareness_changed') return `${combatUnitName(state, payload.observerId || payload.unitId)} 对 ${combatUnitName(state, payload.targetId)} 情报状态变为 ${payload.awareness || payload.to || '已更新'}`;
    if (event.type === 'noise_emitted') return `${actor} 产生${payload.reason || '声音'} · 半径 ${Number(payload.radiusMeters || 0).toFixed(1)}m`;
    if (event.type === 'stealth_entered') return `${actor} 进入潜行`;
    if (event.type === 'stealth_broken') return `${actor} 解除潜行 · ${payload.reason || '状态变化'}`;
    if (event.type === 'hide_resolved') return `${actor} 隐蔽检定完成 · 切断 ${payload.reduced ?? 0}/${payload.observers ?? 0} 条追踪`;
    if (event.type === 'tracking_lost') return `${combatUnitName(state, payload.observerId)} 失去对 ${combatUnitName(state, payload.targetId)} 的追踪`;
    if (event.type === 'lure_created') return `${actor} 制造诱导声源 · 影响 ${payload.affectedIds?.length || 0} 个实体`;
    if (event.type === 'unit_state_changed') return `${combatUnitName(state, payload.unitId)} 状态：${payload.from || '—'} → ${payload.to || '—'}`;
    if (event.type === 'command_redone') return `${actor} 重做上一次行动 · ${payload.type || '行动'}`;
    if (event.type === 'combat_created') return `战斗创建 · ${payload.title || state?.title || '未命名遭遇'}`;
    if (event.type === 'turn_started') return `回合 ${event.round || 0} 开始 · 当前行动 ${actor}`;
    if (event.type === 'combat_completed') return `战斗完成 · ${payload.winner === 'player' ? '玩家方胜利' : payload.winner === 'enemy' ? '敌方胜利' : '已结算'}`;
    return `${event.type || '未知事件'}${payload.reason ? ` · ${payload.reason}` : ''}`;
}

function combatSimpleAttackLabel(event) {
    const payload = event?.payload || {};
    if (payload.outcome === 'hit') return '命中';
    if (payload.outcome === 'miss') return '未命中';
    if (payload.outcome === 'disaster') return '灾难';
    if (payload.outcome === 'miracle') return '奇迹';
    return combatOutcomeLabel(payload.outcome);
}

function combatSimpleAttackRowLegacy(event, state) {
    const payload = event?.payload || {};
    const actor = combatUnitName(state, payload.actorId);
    const target = combatUnitName(state, payload.targetId);
    const hit = payload.outcome === 'hit' || payload.outcome === 'miracle';
    const damage = payload.damage?.final;
    const beforeHp = payload.applied?.before?.hp;
    const afterHp = payload.applied?.after?.hp;
    const hpText = afterHp === undefined ? '' : ` · HP ${beforeHp ?? '—'}→${afterHp}`;
    const damageText = hit && damage !== undefined ? ` · 伤害 ${damage}` : '';
    const detail = `D100 ${payload.selected ?? '—'} + ${payload.modifier ?? 0} = ${payload.total ?? '—'} / DC ${payload.defenseDC ?? '—'}${payload.ambush ? ' · 伏击' : ''}`;
    const outcome = `${payload.counterattack ? '反击·' : ''}${combatSimpleAttackLabel(event)}`;
    return `<article class="combat-attack-row ${hit ? 'hit' : 'miss'}" title="${escapeHtml(detail)}"><span class="combat-attack-seq">#${event.sequence ?? '—'}</span><b class="combat-attack-actor">${escapeHtml(actor)}</b><i>→</i><b class="combat-attack-target">${escapeHtml(target)}</b><span class="combat-attack-result">${escapeHtml(outcome)}${escapeHtml(damageText)}${escapeHtml(hpText)}</span></article>`;
}

function combatBattleReportMarkupLegacy(events, state) {
    const attacks = (events || []).filter(event => event?.type === 'attack_check');
    if (!attacks.length) return '<div class="combat-battle-report empty-state">尚无攻击结算；移动、侦察和状态变化已收进下方完整账本。</div>';
    const grouped = new Map();
    for (const event of attacks.slice(-160)) {
        const round = Number.isFinite(Number(event.round)) ? Number(event.round) : 0;
        const list = grouped.get(round) || [];
        list.push(event);
        grouped.set(round, list);
    }
    const rounds = [...grouped.entries()].sort((a, b) => b[0] - a[0]);
    const latestRound = rounds[0]?.[0];
    const rows = rounds.map(([round, items]) => `<details class="combat-battle-round" ${round === latestRound ? 'open' : ''}><summary><span>第 ${round} 回合</span><b>${items.length} 次攻击</b></summary><div class="combat-battle-round-rows">${items.slice().reverse().map(event => combatSimpleAttackRow(event, state)).join('')}</div></details>`).join('');
    return `<section class="combat-battle-report"><header><div><small>QUICK BATTLE REPORT</small><b>攻击记录</b></div><span>只显示“谁攻击了谁”与结果</span></header><div class="combat-battle-rounds">${rows}</div></section>`;
}

function combatAttackProcedureMarkup(event, state) {
    const payload = event?.payload || {};
    const actorUnit = state?.combatants?.find(unit => unit.id === payload.actorId);
    const targetUnit = state?.combatants?.find(unit => unit.id === payload.targetId);
    const basis = payload.attackBasis || {};
    const actorBasis = basis.actor || actorUnit || {};
    const targetBasis = basis.target || targetUnit || {};
    const ability = basis.ability || actorUnit?.abilities?.find(item => item.id === payload.abilityId) || {};
    const show = value => escapeHtml(value === undefined || value === null || value === '' ? '—' : String(value));
    const rolls = Array.isArray(payload.rawRolls) && payload.rawRolls.length ? payload.rawRolls.join(' / ') : show(payload.selected);
    const edgeDistance = basis.edgeDistanceMeters === undefined && actorUnit && targetUnit
        ? Math.max(0, Math.hypot(Number(actorUnit.position?.x || 0) - Number(targetUnit.position?.x || 0), Number(actorUnit.position?.y || 0) - Number(targetUnit.position?.y || 0)) - Number(actorUnit.radiusMeters || 0) - Number(targetUnit.radiusMeters || 0))
        : basis.edgeDistanceMeters;
    const reduction = payload.damage?.reduction && typeof payload.damage.reduction === 'object'
        ? Object.entries(payload.damage.reduction).map(([key, value]) => key + ' ' + value + '%').join(' / ')
        : payload.damage?.reduction;
    let damageText = '未命中，不进行伤害结算。';
    if (payload.damage) {
        if (payload.damage.channels) {
            damageText = '原始 ' + show(payload.damage.raw) + '；物理 ' + show(payload.damage.channels.physical) + ' + 魔法 ' + show(payload.damage.channels.magical) + '；最终 ' + show(payload.damage.final);
        } else {
            damageText = '原始 ' + show(payload.damage.raw) + ' − 减伤 ' + show(reduction) + '% = 最终 ' + show(payload.damage.final);
        }
        if (payload.applied) {
            damageText += '；HP ' + show(payload.applied.before?.hp) + ' → ' + show(payload.applied.after?.hp) + '（实际 HP 伤害 ' + show(payload.applied.hpDamage) + '，护盾吸收 ' + show(payload.applied.absorbed) + '）';
        }
    }
    const modifierFormula = show(actorBasis.attackModifier) + ' + 位阶 ' + show(actorBasis.tierCorrection ?? 0) + ' + 能力 ' + show(ability.modifier ?? 0);
    const rollMode = payload.ambush ? '优势（伏击）' : Array.isArray(payload.rawRolls) && payload.rawRolls.length > 1 ? '双骰' : '普通';
    return '<details class=\"combat-attack-procedure\"><summary>查看完整判定流程</summary><dl>' +
        '<dt>行动</dt><dd>第 ' + show(event.round) + ' 回合 · #' + show(event.sequence) + ' · ' + (payload.counterattack ? '近战自动反击 · ' : '') + show(ability.name || payload.abilityId) + '</dd>' +
        '<dt>攻击方依据</dt><dd>' + show(actorUnit?.name || payload.actorId) + ' · ATK ' + show(actorBasis.attack) + ' / MATK ' + show(actorBasis.magicAttack) + ' · 修正 ' + modifierFormula + '</dd>' +
        '<dt>目标依据</dt><dd>' + show(targetUnit?.name || payload.targetId) + ' · 防御 DC ' + show(targetBasis.defenseDC ?? payload.defenseDC) + ' · 物理减伤 ' + show(targetBasis.armor ?? 0) + '% · 魔法减伤 ' + show(targetBasis.resistance ?? 0) + '%</dd>' +
        '<dt>距离与合法性</dt><dd>边缘距离 ' + show(edgeDistance) + 'm · 射程 ' + show(ability.minRangeMeters ?? 0) + '–' + show(ability.maxRangeMeters) + 'm · ' + (basis.legalRange === false ? '非法（仅记录旧事件）' : '合法') + (basis.contactSlot ? ' · 近战接触位 ' + show(basis.contactSlot) : '') + '</dd>' +
        '<dt>命中检定</dt><dd>' + rollMode + ' · D100 ' + rolls + '；' + modifierFormula + ' = ' + show(payload.total) + '，对 DC ' + show(payload.defenseDC) + ' · ' + show(combatSimpleAttackLabel(event)) + '</dd>' +
        '<dt>伤害与结算</dt><dd>' + damageText + '</dd>' +
        '</dl></details>';
}

function combatSimpleAttackRow(event, state) {
    const payload = event?.payload || {};
    const actor = combatUnitName(state, payload.actorId);
    const target = combatUnitName(state, payload.targetId);
    const hit = payload.outcome === 'hit' || payload.outcome === 'miracle';
    const damage = payload.damage?.final;
    const beforeHp = payload.applied?.before?.hp;
    const afterHp = payload.applied?.after?.hp;
    const hpText = afterHp === undefined ? '' : ' · HP ' + (beforeHp ?? '—') + '→' + afterHp;
    const damageText = hit && damage !== undefined ? ' · 伤害 ' + damage : '';
    const detail = 'D100 ' + (payload.selected ?? '—') + ' + ' + (payload.modifier ?? 0) + ' = ' + (payload.total ?? '—') + ' / DC ' + (payload.defenseDC ?? '—') + (payload.ambush ? ' · 伏击' : '');
    const outcome = `${payload.counterattack ? '反击·' : ''}${combatSimpleAttackLabel(event)}`;
    return '<article class=\"combat-attack-row ' + (hit ? 'hit' : 'miss') + '\" title=\"' + escapeHtml(detail) + '\"><span class=\"combat-attack-seq\">#' + (event.sequence ?? '—') + '</span><b class=\"combat-attack-actor\">' + escapeHtml(actor) + '</b><i>→</i><b class=\"combat-attack-target\">' + escapeHtml(target) + '</b><span class=\"combat-attack-result\">' + escapeHtml(outcome + damageText + hpText) + '</span>' + combatAttackProcedureMarkup(event, state) + '</article>';
}

function combatInitiativeMarkup(roundEvents, state) {
    const rolls = roundEvents.filter(event => event?.type === 'initiative_roll');
    if (!rolls.length) return '<div class=\"combat-round-missing\">该旧存档未记录本回合先攻明细；原始事件仍保存在完整账本。</div>';
    const locked = roundEvents.find(event => event?.type === 'initiative_order_locked');
    const started = roundEvents.find(event => event?.type === 'round_started');
    const order = locked?.payload?.order?.map(item => item.unitId) || started?.payload?.order?.map(item => item.unitId) || [];
    const ordered = rolls.slice().sort((a, b) => {
        const ai = order.indexOf(a.payload?.unitId); const bi = order.indexOf(b.payload?.unitId);
        return (ai < 0 ? 9999 : ai) - (bi < 0 ? 9999 : bi);
    });
    const lockState = locked?.payload?.allUnitsRolled === false ? ' · 检定未完成' : ' · 全部完成后锁定';
    return '<details class=\"combat-round-initiative\" open><summary>先攻与行动顺序 · ' + rolls.length + ' 个单位' + lockState + '</summary><div>' +
        ordered.map((event, index) => '<div class=\"combat-initiative-row\"><span>' + (index + 1) + '</span><b>' + escapeHtml(combatUnitName(state, event.payload?.unitId)) + '</b><small>D100 ' + escapeHtml(String(event.payload?.selected ?? '—')) + ' + 先攻 ' + escapeHtml(String(event.payload?.initiativeDC ?? 0)) + ' = ' + escapeHtml(String(event.payload?.total ?? '—')) + '</small></div>').join('') +
        '</div></details>';
}

function combatBattleReportMarkup(events, state) {
    const source = (events || []).slice(-250);
    const attacks = source.filter(event => event?.type === 'attack_check');
    const initiativeEvents = source.filter(event => event?.type === 'initiative_roll' || event?.type === 'initiative_order_locked' || event?.type === 'round_started');
    if (!attacks.length && !initiativeEvents.length) return '<div class=\"combat-battle-report empty-state\">尚无攻击结算；移动、侦察和状态变化已收进下方完整账本。</div>';
    const grouped = new Map();
    for (const event of attacks.slice(-160)) {
        const round = Number.isFinite(Number(event.round)) ? Number(event.round) : 0;
        const list = grouped.get(round) || [];
        list.push(event);
        grouped.set(round, list);
    }
    // A manual battle may pause immediately after initialization. Keep that
    // stage visible even before the first attack so the all-units gate is
    // auditable instead of looking like the engine skipped initiative.
    for (const event of initiativeEvents) {
        const round = Number.isFinite(Number(event.round)) ? Number(event.round) : Number(event.payload?.round || 0);
        if (!grouped.has(round)) grouped.set(round, []);
    }
    const rounds = [...grouped.entries()].sort((a, b) => b[0] - a[0]);
    const latestRound = rounds[0]?.[0];
    const rows = rounds.map(([round, items]) => {
        const roundEvents = source.filter(event => Number(event.round) === Number(round));
        return '<details class=\"combat-battle-round\" ' + (round === latestRound ? 'open' : '') + '><summary><span>第 ' + round + ' 回合</span><b>' + items.length + ' 次攻击</b></summary><div class=\"combat-battle-round-rows\">' + combatInitiativeMarkup(roundEvents, state) + (items.length ? items.slice().reverse().map(event => combatSimpleAttackRow(event, state)).join('') : '<div class=\"combat-round-missing\">本回合尚未发生攻击；行动将在先攻顺序锁定后开始。</div>') + '</div></details>';
    }).join('');
    return '<section class=\"combat-battle-report\"><header><div><small>QUICK BATTLE REPORT</small><b>攻击记录 · 完整判定</b></div><span>先攻与每次攻击的依据、检定、伤害和结算均可展开</span></header><div class=\"combat-battle-rounds\">' + rows + '</div></section>';
}

function combatAuditLedgerMarkup(events, state) {
    const source = (events || []).slice(-250);
    if (!source.length) return '<div class="empty-state">尚无事件</div>';
    const grouped = new Map();
    const counts = new Map(COMBAT_LEDGER_CATEGORIES.map(category => [category.key, 0]));
    for (const event of source) {
        const round = Number.isFinite(Number(event.round)) ? Number(event.round) : 0;
        const category = combatLedgerCategory(event);
        counts.set(category.key, (counts.get(category.key) || 0) + 1);
        const roundGroup = grouped.get(round) || new Map();
        const list = roundGroup.get(category.key) || [];
        list.push({ event, category }); roundGroup.set(category.key, list); grouped.set(round, roundGroup);
    }
    const latestRound = Math.max(...grouped.keys());
    const chips = COMBAT_LEDGER_CATEGORIES.filter(category => counts.get(category.key)).map(category => `<span class="combat-ledger-chip ${category.key}">${category.icon} ${category.label} ${counts.get(category.key)}</span>`).join('');
    const rounds = [...grouped.entries()].sort((a, b) => b[0] - a[0]).map(([round, categories]) => {
        const categoryMarkup = COMBAT_LEDGER_CATEGORIES.filter(category => categories.has(category.key)).map(category => {
            const items = categories.get(category.key) || [];
            const rows = items.slice().reverse().map(({ event }) => `<article class="combat-ledger-event ${category.key}"><time>#${event.sequence ?? '—'}</time><b>${escapeHtml(combatLedgerSummary(event, state))}</b><code>${escapeHtml(String(event.hash || '').slice(0, 12))}</code><details><summary>原始明细</summary><pre>${escapeHtml(JSON.stringify(event.payload || {}, null, 2))}</pre></details></article>`).join('');
            return `<details class="combat-ledger-category ${category.key}" ${round === latestRound || category.key === 'attack' ? 'open' : ''}><summary><span>${category.icon} ${category.label}</span><b>${items.length}</b></summary><div>${rows}</div></details>`;
        }).join('');
        return `<details class="combat-ledger-round" ${round === latestRound ? 'open' : ''}><summary><span>第 ${round} 回合</span><b>${[...categories.values()].reduce((sum, list) => sum + list.length, 0)} 条事件</b></summary><div>${categoryMarkup}</div></details>`;
    }).join('');
    return `<div class="combat-ledger-summary"><span>显示最近 ${source.length} 条</span>${chips}</div><div class="combat-ledger-rounds">${rounds}</div>`;
}

function combatLedgerMarkup(events, state) {
    const source = events || [];
    const audit = combatAuditLedgerMarkup(source, state);
    return `${combatBattleReportMarkup(source, state)}<details class="combat-ledger-audit"><summary><span>完整裁定账本</span><b>${source.length} 条事件 · 点击展开</b></summary><div class="combat-ledger-audit-body">${audit}</div></details>`;
}

const COMBAT_FLOW_ORDER = ['initiate', 'model', 'deploy', 'battle', 'result'];

function combatAutoPhase(state) {
    if (!state) return combatModelingState.phase !== 'idle' ? 'model' : 'initiate';
    switch (state.status) {
        case 'draft':
        case 'ready':
            return 'deploy';
        case 'running':
        case 'paused':
        case 'awaiting_script_approval':
            return 'battle';
        case 'completed':
        case 'abandoned':
            return 'result';
        default:
            return 'deploy';
    }
}

function snapCombatFlowPhase() {
    combatFlowPhase = combatAutoPhase(combatState);
}

function renderCombat() {
    const renderStartedAt = performance.now();
    const state = combatState;
    // The terminal is a single guided battle flow: 遭遇发起 → 建模确认 →
    // 编制部署 → 战场演算 → 结果结算.  The stepper stays reachable so the
    // player can review an earlier step; lifecycle events snap the phase
    // forward through snapCombatFlowPhase().
    if (!combatFlowPhase) combatFlowPhase = combatAutoPhase(state);
    $$('[data-combat-phase]').forEach(panel => {
        panel.classList.toggle('is-active', panel.dataset.combatPhase === combatFlowPhase);
    });
    const autoIdx = COMBAT_FLOW_ORDER.indexOf(combatAutoPhase(state));
    const currentIdx = COMBAT_FLOW_ORDER.indexOf(combatFlowPhase);
    $$('[data-combat-flow-step]').forEach(step => {
        const phase = step.dataset.combatFlowStep;
        const idx = COMBAT_FLOW_ORDER.indexOf(phase);
        step.classList.toggle('active', phase === combatFlowPhase);
        step.classList.toggle('done', idx < currentIdx);
        step.classList.toggle('pending', idx > autoIdx);
        step.setAttribute('aria-current', phase === combatFlowPhase ? 'step' : 'false');
    });
    renderCombatPromptTraceSummary();
    const simulatorFold = $('#combatSimulatorFold');
    const simulatorFoldState = $('#combatSimulatorFoldState');
    if (simulatorFoldState) simulatorFoldState.textContent = simulatorFold?.open ? '点击折叠' : '点击展开';
    renderCombatModelStatus();
    const debugExportButton = $('[data-action="combat-debug-export"]');
    if (debugExportButton) debugExportButton.textContent = `导出 DEBUG${combatDebugTrace.length ? ` · ${combatDebugTrace.length}` : ''}`;
    const simulation = isCombatSimulation(state);
    $('#combatNavState').textContent = state ? state.status === 'completed' ? '✓' : state.round || '•' : '—';
    $('#combatStatus').textContent = state ? `${simulation ? '模拟 · ' : ''}${({ draft: '待开始', ready: '已就绪', running: '演算中', paused: '已暂停', completed: '已完成', awaiting_script_approval: '等待脚本审批', abandoned: '已放弃', error: '错误' }[state.status] || state.status)}` : '未建立';
    $('#combatRound').textContent = state ? `${state.round} / v${state.version}` : '—';
    $('#combatSeed').textContent = state?.seed?.slice(0, 16) || '—';
    $('#combatSeed').title = state?.seed || '';
    $('#combatHash').textContent = state?.eventHash?.slice(0, 16) || '—';
    $('#combatHash').title = state?.eventHash || '';
    $('#combatSimulatorState').textContent = simulation ? `运行中 · ${state.simulation?.label || '临时场景'}` : '未启用';
    $('#combatSimulatorState').title = simulation ? '本场战斗只保留在服务器内存中；仅通过“导入剧情”才会影响当前分支。' : '';
    const simulator = $('#combatSimulator');
    simulator?.classList.toggle('simulation-active', simulation);
    simulator?.classList.toggle('scenario-picker-open', simulation && combatSimulatorPickerOpen);
    $('#combatSimulatorState').closest('.combat-simulator-state')?.classList.toggle('active', simulation);
    $('#combatSimulatorState').parentElement.querySelector('[data-action="combat-exit-simulator"]').disabled = !simulation;
    const simulatorPicker = $('[data-action="combat-toggle-simulator-picker"]');
    if (simulatorPicker) { simulatorPicker.hidden = !simulation; simulatorPicker.textContent = combatSimulatorPickerOpen ? '收起样本' : '更换样本'; }
    $('#combatResultTitle').textContent = simulation ? '模拟结果导入' : '剧情融合';
    renderCombatRecognitionControl();
    updateCombatNarrationControl(state, simulation);
    if (state) {
        const modePreference = isCombatSimulation(state) && ['completed', 'abandoned'].includes(state.status) ? store.data.settings.combatModePreference : null;
        $('#combatMode').value = modePreference || state.mode;
    }
    const connectionId = aiConnectionId('combat') || store.data.settings.activeCombatConnectionId || store.data.settings.activeConnectionId || '';
    $('#combatConnection').innerHTML = `<option value="">跟随当前 API 主线路</option>${store.data.connections.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === connectionId ? 'selected' : ''}>战斗 · ${escapeHtml(item.name || item.model)}</option>`).join('')}`;
    const presetId = store.data.settings.activeCombatPresetId || store.data.settings.activePresetId || '';
    $('#combatPreset').innerHTML = `<option value="">无额外预设</option>${presets.map(item => `<option value="${escapeHtml(item.id)}" ${item.id === presetId ? 'selected' : ''}>战斗 · ${escapeHtml(item.name)}</option>`).join('')}`;
    if (state?.strategy?.source && document.activeElement !== $('#combatStrategy')) $('#combatStrategy').value = state.strategy.source;
    const mapStartedAt = performance.now();
    renderBattlefieldMap(state);
    const mapMarkupMs = performance.now() - mapStartedAt;
    const actor = state?.combatants?.find(unit => unit.id === state.activeUnitId);
    $('#combatActiveUnit').textContent = actor?.name || '—';
    const legal = state?.pauseReason?.legalActions || [];
    const movementPoints = Number(state?.turnBudget?.[actor?.id]?.movementMeters ?? actor?.speedMeters ?? 0);
    const moveControls = state?.pauseReason?.type === 'manual_turn' && movementPoints > 1e-6 ? `<div class="combat-movement"><small>移动点数 · 剩余 ${movementPoints.toFixed(1)}m</small><span>可在攻击前后重复移动，直到点数耗尽</span></div>` : '';
    const scriptApproval = state?.pauseReason?.type === 'script_approval' ? `<div class="script-approval-card"><b>${escapeHtml(state.pauseReason.inspection?.ability?.name || state.pauseReason.abilityId)}</b><p>哈希 ${escapeHtml(state.pauseReason.inspection?.hash || '')}</p><span>权限：${escapeHtml((state.pauseReason.inspection?.capabilities || []).join('、') || '无声明式效果')}</span><div><button data-action="combat-inspect-script">运行 100 组固定种子审查</button><button data-action="combat-approve-script" ${pendingCombatScriptReview?.passed ? '' : 'disabled'}>批准此版本</button></div></div>` : '';
    const reactionControls = state?.pauseReason?.type === 'reaction_window' ? `<div class="reaction-window"><b>关键反应窗口</b><p>${escapeHtml(state.pauseReason.type)} · ${escapeHtml(state.pauseReason.unitId || '')} · 阶段 ${escapeHtml(state.pauseReason.threshold || '')}</p><div>${(state.pauseReason.options || ['policy']).map(option => `<button data-combat-reaction="${escapeHtml(option)}">${escapeHtml(option)}</button>`).join('')}</div></div>` : '';
    $('#combatTurn').innerHTML = scriptApproval || reactionControls || (actor ? `<div class="active-unit-card"><b>${escapeHtml(actor.name)}</b><span>HP ${actor.hp}/${actor.maxHp} · EP ${actor.ep}/${actor.maxEp} · 坐标 (${Number(actor.position?.x || 0).toFixed(1)}, ${Number(actor.position?.y || 0).toFixed(1)})</span><small>${escapeHtml(state.pauseReason?.type || '等待本地演算')}</small></div>${moveControls}${state.pauseReason?.type === 'manual_turn' ? `<div class="combat-action-hint">攻击、技能、移动、结束行动：请点击二维战场空白处，从行动菜单选择。点击任意实体圆球可查看完整战斗档案。</div>${legal.map(ability => `<div class="combat-ability"><header><b>${escapeHtml(ability.name)}</b><span>${Number(ability.minRangeMeters || 0)}–${Number(ability.maxRangeMeters || 0)}m · EP ${ability.epCost}${ability.cooldownRemaining ? ` · CD ${ability.cooldownRemaining}` : ''}</span></header><div><small>${ability.actionAvailable ? `可用 · 当前合法目标 ${ability.legalTargetIds?.length || 0} 个` : '对应行动不可用或冷却中'}</small></div></div>`).join('')}` : `<p>${escapeHtml(JSON.stringify(state.pauseReason || {}))}</p>`}` : '<div class="empty-state">等待行动时机</div>');
    const visibleIds = combatVisibleIds(state);
    const visibleUnits = (state?.combatants || []).filter(unit => visibleIds.has(unit.id));
    const unitById = new Map((state?.combatants || []).map(unit => [unit.id, unit]));
    const roster = combatShowCohorts
        ? (state?.cohorts || []).map(group => {
            const units = (group.ids || []).map(id => unitById.get(id)).filter(unit => unit && visibleIds.has(unit.id));
            if (!units.length) return null;
            return { ...group, count: units.length, totalHp: units.reduce((sum, unit) => sum + unit.hp + unit.thp, 0), totalMaxHp: units.reduce((sum, unit) => sum + unit.maxHp, 0) };
        }).filter(Boolean)
        : visibleUnits;
    const intel = combatIntelSummary(state);
    $('#combatRoster').innerHTML = `${roster.map(unit => combatShowCohorts ? `<article><div><b>${escapeHtml(unit.name)}</b><small>${escapeHtml(unit.zoneId)} · ${escapeHtml(unit.state)}</small></div><span>×${unit.count} · HP ${unit.totalHp}/${unit.totalMaxHp}</span></article>` : `<article><div><b>${escapeHtml(unit.name)}</b><small>(${Number(unit.position?.x || 0).toFixed(1)}, ${Number(unit.position?.y || 0).toFixed(1)}) · ${escapeHtml(unit.state)}${unit.boss ? ' · BOSS' : ''}</small></div><span>HP ${unit.hp}+${unit.thp}/${unit.maxHp} · EP ${unit.ep}/${unit.maxEp}</span>${unit.side === 'player' ? `<div class="combat-unit-controls"><label title="该单位由玩家手操还是交给本地 AI"><span>控制</span><select data-combat-control="${escapeHtml(unit.id)}"><option value="player" ${unit.controller === 'player' ? 'selected' : ''}>手操</option><option value="ai" ${unit.controller !== 'player' ? 'selected' : ''}>自动</option></select></label><label title="该单位是否覆盖全局手操 / 自动模式"><span>行动</span><select data-combat-unit-mode="${escapeHtml(unit.id)}">${combatUnitModeOptions(unit)}</select></label><label title="该单位使用的本地确定性策略"><span>策略</span><select data-combat-unit-strategy="${escapeHtml(unit.id)}">${combatStrategyPresetOptions(unit, state)}</select></label></div>` : ''}</article>`).join('') || '<div class="empty-state">暂无已确认参战实体</div>'}${intel.hiddenEnemies ? `<div class="combat-intel-fog">迷雾情报：仍有 ${intel.hiddenEnemies} 个敌对单位未确认位置 · ${escapeHtml(intel.text)}</div>` : ''}`;
    const ledgerStartedAt = performance.now();
    $('#combatEvents').innerHTML = combatLedgerMarkup(combatEvents, state);
    const ledgerMarkupMs = performance.now() - ledgerStartedAt;
    const strategy = state?.strategy;
    $('#combatStrategyPreview').className = `strategy-preview${strategy ? '' : ' empty-state'}`;
    $('#combatStrategyPreview').innerHTML = strategy ? `<dl><dt>编译器</dt><dd>${escapeHtml(strategy.compiler || 'local-parser')}</dd><dt>优先级</dt><dd>${strategy.priorities.join(' → ')}</dd><dt>EP 保留</dt><dd>${strategy.preserveEpPercent}%</dd><dt>反应</dt><dd>${strategy.reactionPolicy}</dd></dl><h4>任一条件触发接管</h4>${strategy.takeoverTriggers.map(trigger => `<code>${trigger.field} ${trigger.operator} ${trigger.value}</code>`).join(' ')}${strategy.confirmed ? '<b class="strategy-confirmed">已确认</b>' : '<button data-action="combat-confirm-strategy">确认并启用</button>'}` : '策略会先编译为确定性规则，确认后才执行。';
    $('#combatResult').innerHTML = state?.finalResult ? `<div class="combat-result-summary ${simulation ? 'simulation-result' : ''}"><b>${state.finalResult.winner === 'player' ? '玩家方胜利' : '敌方胜利'}</b><span>${state.finalResult.rounds} 回合 · ${state.finalResult.casualties.length} 个失能实体</span><code>${escapeHtml(state.finalResult.eventHash?.slice(0, 24) || '')}</code>${simulation ? '<p>这是临时模拟结果；点击上方按钮才会把它写成战术终端测试剧情，交给正文 AI。</p>' : ''}</div>` : state?.status === 'paused' ? `<p>${simulation ? '模拟器暂停：可继续演算，或把这个可复现暂停点作为测试剧情交给正文 AI。' : '正式暂停：'}${escapeHtml(state.pauseReason?.type || 'unknown')}</p>` : `<div class="empty-state">${simulation ? '载入模拟后，开始或推进演算即可得到可选的模拟测试剧情输入。' : '正式暂停或战斗结束后可生成融合剧情。'}</div>`;
    if (COMBAT_BENCHMARK_ENABLED && state?.id) recordCombatDebug('render_benchmark', { totalMs: Math.round((performance.now() - renderStartedAt) * 10) / 10, mapMarkupMs: Math.round(mapMarkupMs * 10) / 10, ledgerMarkupMs: Math.round(ledgerMarkupMs * 10) / 10, combatantCount: state.combatants?.length || 0, loadedEventCount: combatEvents.length }, state.id);
}

async function createCombatFromEditor(text) {
    const payload = JSON.parse(text);
    await createCombatPayload(payload);
}

async function createCombatPayload(payload) {
    combatPromptTraceCache = null;
    combatState = await combatRequest('/sessions', { method: 'POST', body: JSON.stringify(payload) });
    snapCombatFlowPhase();
    combatNarrationBusy = false;
    combatNarrationState = { battleId: combatState.id, phase: 'idle', detail: '' };
    combatEvents = (await combatRequest(`/${combatState.id}/events`)).events || [];
    if (isCombatSimulation()) {
        renderCombat(); toast('临时模拟遭遇已建立；不会写入正式战斗存档。', 'success');
        return;
    }
    const session = store.activeSession; session.activeBattleId = combatState.id; session.combatIds = [...new Set([...(session.combatIds || []), combatState.id])]; store.save();
    await blackbox.record('combat', 'combat_created', { payload, state: combatState }, { sessionId: session.id });
    renderCombat(); toast('本地权威战斗已建立；确认编制后即可开始。', 'success');
}

async function narrateCombat() {
    const battleId = combatState?.id || null;
    if (combatNarrationBusy) {
        await blackbox.record('combat', 'narration_click_ignored', { battleId, reason: 'request_in_flight' }, { sessionId: store.activeSession?.id });
        toast('剧情写入请求正在进行中，已阻止重复提交。', 'info');
        return null;
    }
    if (!combatState || !['paused', 'completed'].includes(combatState.status)) return toast('只有正式暂停点或已完成战斗可生成剧情', 'error');
    if (combatNarrationState.battleId === battleId && combatNarrationState.phase === 'success') {
        await blackbox.record('combat', 'narration_click_ignored', { battleId, reason: 'already_written' }, { sessionId: store.activeSession?.id });
        toast('本场战斗结果已经写入当前剧情，无需重复生成。', 'info');
        return null;
    }
    const settings = aiConnection('story');
    if (!settings.baseUrl || !settings.model) return toast('请先配置正文模型连接', 'error');
    const simulation = isCombatSimulation();
    const turnId = crypto.randomUUID();
    let writtenMessage = null;
    let terminalCleaned = false;
    let narrationAiProcessId = null;
    const narrationController = new AbortController();
    combatNarrationBusy = true;
    combatNarrationState = { battleId, phase: 'running', detail: simulation ? '正在请求正文 AI 生成模拟测试剧情' : '正在生成战斗融合剧情' };
    updateCombatNarrationControl(combatState, simulation);
    narrationAiProcessId = beginAiProcess('正文 AI', simulation ? '战斗模拟剧情 · 等待首包' : '战斗融合剧情 · 等待首包', () => narrationController.abort(new DOMException('用户已取消战斗融合', 'AbortError')));
    try {
        const narrative = await combatRequest(`/${combatState.id}/narrative-bundle`);
        // Post-battle disposition instructions (搜刮战利品 / 什么都不要 /
        // 安葬死者 ...) reuse the extra-requirements box pattern: they are
        // appended to the fusion prompt so the story AI writes the aftermath
        // without touching the locally adjudicated outcome.
        const dispositionNotes = String($('#combatDispositionNotes')?.value || '').trim();
        const dispositionPrompt = dispositionNotes ? `\n\n玩家战后处置要求（只描写处置过程与合理结果，不得改写已裁定的命中、伤害、死亡、资源或胜负）：${dispositionNotes}` : '';
        const narrativeUserPrompt = simulation
            ? `${narrative.userPrompt}${dispositionPrompt}\n\n这是玩家已明确确认要写入当前剧情分支的“模拟测试记录”。保留全部本地裁定事实，将它写成主神终端/战术演算终端内进行的虚拟测试剧情（可用于商店升级、配装或战术验证之后的剧情片段），不得把它擅自叙述为任务世界中已经真实发生的战斗，也不得凭空改写现实 MVU。`
            : `${narrative.userPrompt}${dispositionPrompt}`;
        await blackbox.record('combat', 'narration_started', { battleId: combatState.id, bundle: narrative.bundle, dispositionNotes }, { sessionId: store.activeSession?.id, turnId });
        let body = {}, prose = '', fallbackError = null;
        try {
            const narrativeModules = [
                { id: 'preset', label: PROMPT_MODULE_DEFINITIONS.preset.label, messages: [] },
                { id: 'rules', label: '战斗叙事规则', messages: [{ role: 'system', content: narrative.systemPrompt }] },
                { id: 'work', label: PROMPT_MODULE_DEFINITIONS.work.label, messages: [{ role: 'user', content: narrativeUserPrompt }] },
            ];
            const messages = applyPromptModuleMessages(narrativeModules, 'combat-narration');
            const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, stream: false, maxTokens: Math.max(30000, Number(settings.maxTokens) || 0), messages }), signal: narrationController.signal });
            updateAiProcess(narrationAiProcessId, '接收模型响应');
            body = await response.json(); if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
            prose = String(body.choices?.[0]?.message?.content || '').replace(/<UpdateVariable>[\s\S]*?<\/UpdateVariable>/gi, '').replace(/<JSONPatch>[\s\S]*?<\/JSONPatch>/gi, '').trim();
            if (!prose) throw new Error('正文模型返回空战报');
        } catch (error) {
            if (error?.name === 'AbortError') throw error;
            fallbackError = error;
            const casualties = (narrative.bundle.casualties || []).map(item => `${item.name}（${item.state}）`).join('、') || '无';
            prose = `本地战斗演算在第 ${narrative.bundle.rounds || combatState.round} 回合抵达正式结算点。${narrative.bundle.winner ? `胜者为${narrative.bundle.winner === 'player' ? '玩家方' : '敌方'}。` : `演算因“${narrative.bundle.pauseReason?.type || '安全暂停'}”暂停。`}失能与伤亡记录：${casualties}。\n\n> 正文模型暂不可用，本楼使用本地权威战报模板；稍后可依据同一重放重新生成叙事，不会重掷。`;
            await blackbox.record('combat', 'narration_fallback_used', { battleId: combatState.id, error }, { sessionId: store.activeSession?.id, turnId });
        }
        const checks = (narrative.bundle.checks || narrative.bundle.checkResults || []).slice(-20).map(check => `- ${check.actorId || ''} → ${check.targetId}：D100 ${check.selected} + ${check.modifier} = ${check.total} / DC ${check.defenseDC}，${check.outcome}`).join('\n');
        const patch = simulation ? [] : narrative.bundle.mvuPatch || [];
        const content = `${prose}\n\n${checks ? `<CheckResult>\n${checks}\n</CheckResult>\n\n` : ''}<UpdateVariable><JSONPatch>\n${JSON.stringify(patch, null, 2)}\n</JSONPatch></UpdateVariable>`;
        writtenMessage = store.addMessage('assistant', content);
        if (!writtenMessage) throw new Error('当前剧情分支不存在，无法写入战斗结果');
        writtenMessage.combat = { battleId: combatState.id, replayHash: combatState.eventHash, result: narrative.bundle, importedFromSimulation: simulation };
        writtenMessage.tokenUsage = normalizeTokenUsage(body.usage, narrativeUserPrompt, prose);
        store.save();
        const updated = await runtime.parseVariableUpdate(content, runtime.variables); await runtime.replaceVariables(updated);
        if (combatState.status === 'completed') await mutateCombat('finalize');
        const bridgeRecipients = publishBattleOrbHandoff({ battleId: combatState.id, messageId: writtenMessage.id, content, battle: narrative.bundle, replayHash: combatState.eventHash, simulation });
        const narratedStatus = combatState.status;
        await blackbox.record('combat', 'narration_completed', { battleId: combatState.id, messageId: writtenMessage.id, tokenUsage: writtenMessage.tokenUsage, prose, fallback: Boolean(fallbackError), importedFromSimulation: simulation, bridgeRecipients }, { sessionId: store.activeSession?.id, turnId });
        combatNarrationState = { battleId, phase: 'success', detail: simulation ? '模拟测试已写入当前分支' : '战斗融合剧情已写入当前分支' };
        // The disposition box is a one-shot aftermath instruction; clear it so
        // the next battle cannot silently inherit stale loot/search orders.
        const dispositionInput = $('#combatDispositionNotes');
        if (dispositionInput) dispositionInput.value = '';
        await cleanCombatTerminalAfterNarration({ battleId, status: narratedStatus, messageId: writtenMessage.id, simulation });
        terminalCleaned = true;
        // renderAll() intentionally preserves the currently viewed floor.  A
        // newly written combat result must instead become visible immediately;
        // otherwise the request succeeds in the blackbox while the user stays
        // on the previous declaration floor and sees “nothing happened”.
        showPanel('chat'); renderAll(); renderMessages({ followLatest: true });
        toast(simulation ? '模拟测试剧情已交给正文 AI 并写入当前分支。' : '权威战报已融合为剧情楼层，MVU 已按本地结果更新。', 'success');
        return writtenMessage;
    } catch (error) {
        if (error?.name === 'AbortError') {
            combatNarrationState = { battleId, phase: 'idle', detail: '已取消；未写入剧情' };
            toast('已取消战斗融合，未写入剧情。', 'info');
            return null;
        }
        if (writtenMessage) {
            combatNarrationState = { battleId, phase: 'success', detail: '剧情已写入；诊断记录未完成' };
            if (!terminalCleaned) await cleanCombatTerminalAfterNarration({ battleId, status: combatState?.status, messageId: writtenMessage.id, simulation });
            showPanel('chat'); renderAll(); renderMessages({ followLatest: true });
            toast('剧情已写入当前分支，但部分诊断记录失败。', 'info');
            return writtenMessage;
        }
        combatNarrationState = { battleId, phase: 'error', detail: error?.message || String(error) };
        throw error;
    } finally {
        endAiProcess(narrationAiProcessId);
        combatNarrationBusy = false;
        updateCombatNarrationControl(combatState, isCombatSimulation());
    }
}

function protocolLabel(value) {
    return { 'openai-chat': 'OpenAI Chat', 'openai-responses': 'OpenAI Responses', anthropic: 'Anthropic', gemini: 'Gemini' }[value] || value || 'OpenAI Chat';
}

function protocolDefaults(protocol) {
    return {
        'openai-chat': { baseUrl: 'https://api.openai.com', path: '/v1/chat/completions', modelsPath: '/v1/models' },
        'openai-responses': { baseUrl: 'https://api.openai.com', path: '/v1/responses', modelsPath: '/v1/models' },
        anthropic: { baseUrl: 'https://api.anthropic.com', path: '/v1/messages', modelsPath: '/v1/models' },
        gemini: { baseUrl: 'https://generativelanguage.googleapis.com', path: '/v1beta/models/{model}:generateContent', modelsPath: '/v1beta/models' },
    }[protocol] || { baseUrl: '', path: '/v1/chat/completions', modelsPath: '/v1/models' };
}

function renderConnectionModelOptions(filter = '') {
    const root = $('#connectionModelOptions');
    const query = String(filter).trim().toLowerCase();
    const models = connectionModelCandidates.filter(item => !query || item.toLowerCase().includes(query));
    root.innerHTML = models.slice(0, 300).map(item => `<button type="button" data-model-option="${escapeHtml(item)}">${escapeHtml(item)}</button>`).join('');
    root.classList.toggle('open', models.length > 0);
}

function renderConnectionManager() {
    const active = store.data.settings.activeConnectionId;
    $('#connectionList').innerHTML = store.data.connections.map(item => `<div class="manager-item ${item.id === active ? 'active' : ''}" data-connection-id="${item.id}"><b>${item.id === active ? '<i class="active-dot"></i>' : ''}${escapeHtml(item.name || '未命名连接')}</b><small>${protocolLabel(item.protocol)} · ${escapeHtml(item.model || '未设置模型')}</small></div>`).join('') || '<div class="empty-state">暂无连接配置</div>';
    const current = store.data.connections.find(item => item.id === active);
    $('#activeCallSummary').innerHTML = current ? [['当前配置', current.name], ['协议', protocolLabel(current.protocol)], ['模型', current.model], ['地址', current.baseUrl]].map(([key, value]) => `<div class="active-call-row"><span>${key}</span><b>${escapeHtml(value)}</b></div>`).join('') : '<div class="empty-state">尚未选择模型连接</div>';
}

const AI_ASSIGNMENT_FIELDS = {
    story: 'storyConnectionId',
    combat: 'combatConnectionId',
    shop: 'shopConnectionId',
};

function aiConnectionId(purpose) {
    const field = AI_ASSIGNMENT_FIELDS[purpose];
    return field ? store.data.settings.aiAssignments?.[field] || null : null;
}

function aiConnection(purpose) {
    const assigned = store.data.connections.find(item => item.id === aiConnectionId(purpose));
    if (assigned) return assigned;
    const active = store.data.connections.find(item => item.id === store.data.settings.activeConnectionId);
    return active || store.data.settings;
}

function renderModelRoutingManager() {
    const form = $('#modelRoutingForm');
    if (!form) return;
    const assignments = store.data.settings.aiAssignments || {};
    const options = `<option value="">跟随当前 API 主线路</option>${store.data.connections.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name || item.model || '未命名连接')} · ${escapeHtml(item.model || '未设置模型')}</option>`).join('')}`;
    for (const [purpose, field] of Object.entries(AI_ASSIGNMENT_FIELDS)) {
        const select = form.elements[field];
        if (!select) continue;
        select.innerHTML = options;
        select.value = assignments[field] || '';
    }
    const summary = $('#modelRoutingSummary');
    if (summary) {
        const labels = { story: '剧情 AI', combat: '战斗 AI', shop: '商店 AI' };
        summary.innerHTML = Object.entries(AI_ASSIGNMENT_FIELDS).map(([purpose, field]) => {
            const connection = store.data.connections.find(item => item.id === assignments[field]);
            return `<div class="active-call-row"><span>${labels[purpose]}</span><b>${escapeHtml(connection?.name || '跟随当前 API 主线路')}</b></div>`;
        }).join('');
    }
}

function saveModelRouting() {
    const form = $('#modelRoutingForm');
    if (!form) return;
    const aiAssignments = Object.fromEntries(Object.values(AI_ASSIGNMENT_FIELDS).map(field => [field, form.elements[field].value || null]));
    store.updateSettings({ aiAssignments });
    renderModelRoutingManager();
    renderCombat();
    renderPersonalShop();
    toast('大模型用途配置已保存', 'success');
}

function buildStoryPromptPackage() {
    const session = store.activeSession;
    if (!session || !runtime) return { messages: [{ role: 'system', content: '尚未建立当前剧情会话。' }], activeWorldbookEntries: [], modules: [] };
    const states = promptModuleStates('story');
    const prompt = runtime.buildPrompt(session.messages, { promptModules: states });
    const battleInstruction = promptModuleText('story', 'work', `${battleDeclarationInstruction()}\n\n${localCombatAuthorityInstruction()}`);
    const workMessages = promptModuleEnabled('story', 'work') && battleInstruction ? [{ role: 'system', content: battleInstruction }] : [];
    const systemAnchor = prompt.messages.find(message => message.role === 'system');
    if (workMessages.length) {
        if (systemAnchor) systemAnchor.content = `${systemAnchor.content}\n\n${workMessages[0].content}`;
        else prompt.messages.unshift({ role: 'system', content: workMessages[0].content });
    }
    const modules = [
        { id: 'preset', label: PROMPT_MODULE_DEFINITIONS.preset.label, description: PROMPT_MODULE_DEFINITIONS.preset.description, entries: prompt.modules?.preset?.entries || [], messages: prompt.modules?.preset?.entries || [] },
        { id: 'rules', label: PROMPT_MODULE_DEFINITIONS.rules.label, description: PROMPT_MODULE_DEFINITIONS.rules.description, entries: prompt.modules?.rules?.entries || [], messages: prompt.modules?.rules?.entries || [] },
        { id: 'work', label: PROMPT_MODULE_DEFINITIONS.work.label, description: PROMPT_MODULE_DEFINITIONS.work.description, entries: [...(prompt.modules?.work?.entries || []), ...workMessages.map((item, index) => ({ id: `story-work-${index + 1}`, name: '战斗握手与本地权威协议', ...item, source: 'work' }))], messages: [...(prompt.modules?.work?.entries || []), ...workMessages] },
        { id: 'dynamic', label: PROMPT_MODULE_DEFINITIONS.dynamic.label, description: PROMPT_MODULE_DEFINITIONS.dynamic.description, entries: prompt.modules?.dynamic?.entries || [], messages: prompt.modules?.dynamic?.entries || [] },
    ];
    return { ...prompt, messages: applyPromptOverride(prompt.messages, 'story'), modules, moduleStates: states, activeWorldbookEntries: prompt.activeEntries?.map(item => item.comment || item.name || item.uid) || [], preset: runtime.activePreset ? { id: runtime.activePreset.id, name: runtime.activePreset.name } : null };
}

function promptLabStoryMessages() {
    return buildStoryPromptPackage();
}

function promptLabCombatMessages(mode) {
    const qualities = { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' };
    const context = { sourceMessageId: currentStoryFloor()?.narrative?.id || null, recentStory: store.activeSession?.messages?.filter(item => !item.isHidden).slice(-8).map(item => ({ role: item.role, content: item.content })) || [], stat_data: runtime?.variables?.stat_data || {} };
    if (mode === 'combat-recognition') {
        const recognitionNotes = String($('#combatRecognitionNotes')?.value || '').trim();
        if (recognitionNotes) context.playerRequirements = recognitionNotes;
        return buildCombatAiPromptPackage(combatRecognitionPrompt(), `当前剧情与 MVU：\n${JSON.stringify(context)}`, 'battle_declaration_draft');
    }
    if (mode === 'combat-strategy') return buildCombatAiPromptPackage('你是战斗策略编译器。只把玩家策略转换为 JSON，不计算战果。允许字段：priorities(nearest/weakest/boss 的排列)、preserveEpPercent、allowItems、allowFriendlyFire、retreat、reactionPolicy(auto/conserve)、takeoverTriggers([{field,operator,value}])。field 仅限 playerHpPercent/playerEpPercent/enemyDefeatedPercent/allyDying/bossPhaseChanged/round/noLegalAction。只输出 JSON。', `战场摘要：${JSON.stringify({ round: combatState?.round || 0, zones: combatState?.zones || [], cohorts: combatState?.cohorts || [] })}\n玩家策略：${$('#combatStrategy')?.value || '优先保护主角并攻击最近敌人。'}`, 'strategy_compile');
    const declaration = pendingBattleDeclaration?.declaration || { schema: 'vibe-combat-declaration/v3', worldLifeLevel: 'Ⅰ', contactEstablished: true, contactPairs: [['hero', 'enemy']], battlefield: { kind: '当前场景', shapeHint: 'unknown', description: '等待正文战场声明' }, participants: [{ id: 'hero', name: '主角', side: 'player', source: 'existing', reference: '主角', state: '当前 MVU 状态', lifeLevel: 'Ⅰ', attributeQualities: qualities, relativePosition: '中心' }, { id: 'enemy', name: '待声明敌对实体', side: 'enemy', source: 'create', state: '待正文补充', lifeLevel: 'Ⅰ', attributeQualities: qualities, relativePosition: '未知' }] };
    const modelContext = { declaration, knownEntities: battleKnownEntities(), requiredAssets: [], rules: { version: 'vibe-combat-v2-turn-field', spatial: 'only boundary, circles, distance, movement; no cover/terrain/pathfinding' } };
    return buildCombatAiPromptPackage(combatModelPrompt(), JSON.stringify({ ...modelContext, repairs: [] }, null, 2), 'battle_model_started');
}

async function buildPromptLabPayload(mode = selectedPromptLabMode) {
    if (mode === 'story') { const connection = aiConnection('story'); const story = promptLabStoryMessages(); return { mode, ...story, modules: promptModuleSnapshot(story.modules, mode), connection: { id: connection.id, name: connection.name, model: connection.model, protocol: connection.protocol }, sampling: runtime?.activePreset?.sampling || {}, overrideApplied: promptOverride(mode).enabled, moduleOverrideApplied: promptModuleOverrideApplied(mode) }; }
    if (['combat-recognition', 'combat-model', 'combat-strategy'].includes(mode)) { const packageData = promptLabCombatMessages(mode); return { mode, messages: packageData.messages, modules: promptModuleSnapshot(packageData.modules, mode), overrideApplied: promptOverride(mode).enabled, moduleOverrideApplied: promptModuleOverrideApplied(mode) }; }
    if (mode === 'combat-narration') {
        if (!combatState?.id) {
            const modules = [{ id: 'preset', label: PROMPT_MODULE_DEFINITIONS.preset.label, messages: [] }, { id: 'rules', label: '战斗叙事规则', messages: [{ role: 'system', content: '你是《轮回战场》的战斗叙事融合器。只能依据 BattleResultOutline 写紧凑、连贯的中文战斗剧情。' }] }, { id: 'work', label: PROMPT_MODULE_DEFINITIONS.work.label, messages: [{ role: 'user', content: '当前没有暂停或完成的本地战斗；请先建立战斗后刷新预览。' }] }];
            return { mode, messages: applyPromptModuleMessages(modules, mode), modules: promptModuleSnapshot(modules, mode), overrideApplied: promptOverride(mode).enabled, moduleOverrideApplied: promptModuleOverrideApplied(mode) };
        }
        const narrative = await combatRequest(`/${combatState.id}/narrative-bundle`);
        const dispositionNotes = String($('#combatDispositionNotes')?.value || '').trim();
        const narrativeWorkPrompt = dispositionNotes ? `${narrative.userPrompt}\n\n玩家战后处置要求（只描写处置过程与合理结果，不得改写已裁定的命中、伤害、死亡、资源或胜负）：${dispositionNotes}` : narrative.userPrompt;
        const modules = [{ id: 'preset', label: PROMPT_MODULE_DEFINITIONS.preset.label, messages: [] }, { id: 'rules', label: '战斗叙事规则', messages: [{ role: 'system', content: narrative.systemPrompt }] }, { id: 'work', label: PROMPT_MODULE_DEFINITIONS.work.label, messages: [{ role: 'user', content: narrativeWorkPrompt }] }];
        return { mode, battleId: combatState.id, messages: applyPromptModuleMessages(modules, mode), modules: promptModuleSnapshot(modules, mode), bundle: narrative.bundle, overrideApplied: promptOverride(mode).enabled, moduleOverrideApplied: promptModuleOverrideApplied(mode) };
    }
    if (mode === 'shop') {
        const hero = runtime?.variables?.stat_data?.主角 || {};
        const session = store.activeSession;
        const level = heroLifeLevel(hero);
        const connection = aiConnection('shop');
        const payload = { characterName: hero.姓名 || store.data.settings.userName || '轮回者', playerLevel: level, playerLifeLevel: lifeLevelRoman(level), target: { autonomous: true, categories: ['all'], query: personalShopExtraRequirement || '' }, seed: 'prompt-preview', hero, currentCatalog: session?.personalShop?.catalog || {}, connection, tavernShopSystem: runtime?.buildTavernShopSystem?.(), promptModules: {}, promptOverride: '' };
        const response = await fetch('/api/shop/prompt-preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || `商店提示词预览失败（${response.status}）`);
        const modules = [{ id: 'preset', label: '商店专用预设', description: 'V3.2.6 商店调用不继承剧情 AIRP 预设；可在此显式提供一份商店专用前置模块。', messages: [] }, { id: 'rules', label: '原卡商城规则', description: '来自角色卡 World Info / forge_shop 规则条目。', messages: [data.messages?.[0]].filter(Boolean) }, { id: 'work', label: 'forge_shop 工作提示词', description: '由玩家生命层级、目标、库存和当前状态动态生成。', messages: [data.messages?.[1]].filter(Boolean) }];
        return { ...data, mode, messages: applyPromptModuleMessages(modules, mode), modules: promptModuleSnapshot(modules, mode), moduleOverrideApplied: promptModuleOverrideApplied(mode), connection: { id: connection.id, name: connection.name, model: connection.model } };
    }
    const connection = aiConnection('story');
    const modules = [{ id: 'preset', label: PROMPT_MODULE_DEFINITIONS.preset.label, messages: [] }, { id: 'rules', label: '连接测试规则', messages: [] }, { id: 'work', label: '连接测试工作提示词', messages: [{ role: 'user', content: connection.testPrompt || '只回复 OK' }] }];
    return { mode, messages: applyPromptModuleMessages(modules, mode), modules: promptModuleSnapshot(modules, mode), moduleOverrideApplied: promptModuleOverrideApplied(mode), connection: { id: connection.id, name: connection.name, model: connection.model } };
}

function renderPromptModuleCards(modules = []) {
    if (!modules.length) return '<div class="prompt-lab-error"><b>当前模式没有可拆分模块</b><p>请先建立会话或加载对应的战斗/商城上下文。</p></div>';
    return `<div class="prompt-module-order"><span>实际合成顺序</span>${modules.map(module => `<b>${escapeHtml(module.label)}</b>`).join('<i>→</i>')}</div><div class="prompt-module-grid">${modules.map(module => {
        const id = escapeHtml(module.id);
        const entries = module.entries || [];
        const override = String(module.override || '');
        const role = module.role || (module.id === 'work' || module.id === 'dynamic' ? 'user' : 'system');
        return `<details class="prompt-module-card ${module.enabled ? 'is-enabled' : 'is-disabled'}" data-prompt-module-card="${id}" open><summary><span class="prompt-module-toggle"><input type="checkbox" data-prompt-module-enabled="${id}" ${module.enabled ? 'checked' : ''} title="启用或停用此模块"><b>${escapeHtml(module.label)}</b></span><small>${entries.length} 个组成条目</small></summary><p class="prompt-module-description">${escapeHtml(module.description || PROMPT_MODULE_DEFINITIONS[module.id]?.description || '')}</p><div class="prompt-module-entries">${entries.map((entry, index) => `<article><header><b>${escapeHtml(entry.name || `${module.label} ${index + 1}`)}</b><span>${escapeHtml(entry.role || 'system')} · ${escapeHtml(entry.source || module.id)}</span></header><pre>${escapeHtml(String(entry.content || ''))}</pre></article>`).join('') || '<div class="empty-state">此模块当前没有默认条目；可在下面填入模块覆盖。</div>'}</div><label class="prompt-module-editor"><span>模块覆盖（留空＝使用上方真实构造）</span><textarea data-prompt-module-text="${id}" rows="8" spellcheck="false" placeholder="编辑后保存将替换整个模块；不会修改原始角色卡 / AIRP 预设。">${escapeHtml(override)}</textarea></label><label class="prompt-module-role"><span>覆盖角色</span><select data-prompt-module-role="${id}"><option value="system" ${role === 'system' ? 'selected' : ''}>system</option><option value="user" ${role === 'user' ? 'selected' : ''}>user</option><option value="assistant" ${role === 'assistant' ? 'selected' : ''}>assistant</option></select></label></details>`;
    }).join('')}</div>`;
}

async function renderPromptLab() {
    const root = $('#promptLabContent');
    if (!root || promptLabRendering) return;
    promptLabRendering = true;
    const mode = PROMPT_LAB_MODES[selectedPromptLabMode] ? selectedPromptLabMode : 'story';
    const override = promptOverride(mode);
    root.innerHTML = `<div class="prompt-lab-loading">正在构造 ${escapeHtml(PROMPT_LAB_MODES[mode].label)} 的真实发送结构…</div>`;
    try {
        const payload = await buildPromptLabPayload(mode);
        const preview = JSON.stringify(payload, null, 2);
        root.innerHTML = `<header class="prompt-lab-header"><div><small>PROMPT CONSTRUCTION LAB · MODULAR PIPELINE</small><h3>模块化提示词构造与预览</h3><p>${escapeHtml(PROMPT_LAB_MODES[mode].description)} 当前顺序按“预设 → 规则 → 工作提示词 → 动态上下文”拆分；每个模块可以独立停用或用本地编辑内容替换，原始卡片与 AIRP 文件不会被改写。</p></div><button type="button" data-action="prompt-lab-refresh">重新构造</button></header><div class="prompt-lab-controls"><label><span>调用模式</span><select id="promptLabMode">${Object.entries(PROMPT_LAB_MODES).map(([key, item]) => `<option value="${key}" ${key === mode ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('')}</select></label><button type="button" data-action="prompt-lab-save-modules" class="accent-button">保存模块编排</button><button type="button" data-action="prompt-lab-clear-modules">清除模块覆盖</button></div>${renderPromptModuleCards(payload.modules || [])}<details class="prompt-lab-legacy-fold"><summary>兼容旧版：单一 system 覆盖（建议迁移到上方规则 / 工作模块）</summary><div class="prompt-lab-legacy-body"><label class="prompt-lab-enabled"><input id="promptLabEnabled" type="checkbox" ${override.enabled ? 'checked' : ''}><span>启用旧版 system 覆盖</span></label><textarea id="promptLabOverride" rows="6" spellcheck="false" placeholder="留空则完全使用模块化提示词">${escapeHtml(override.text)}</textarea><div><button type="button" data-action="prompt-lab-save">保存旧版覆盖</button><button type="button" data-action="prompt-lab-clear">清除旧版覆盖</button></div></div></details><details class="prompt-lab-preview-fold" open><summary>本次实际构造预览 · ${escapeHtml(mode)} <b>${escapeHtml(payload.overrideApplied ? '含旧版覆盖' : payload.moduleOverrideApplied ? '已应用模块覆盖' : '模块化构造')}</b></summary><textarea id="promptLabPreview" class="prompt-lab-preview" readonly spellcheck="false">${escapeHtml(preview)}</textarea></details>`;
    } catch (error) {
        root.innerHTML = `<div class="prompt-lab-error"><b>提示词构造失败</b><p>${escapeHtml(error.message || error)}</p><button data-action="prompt-lab-refresh">重试</button></div>`;
    } finally {
        promptLabRendering = false;
    }
}

function editUserProfile(profile = null) {
    const form = $('#userProfileForm');
    if (!form) return;
    const value = profile || { id: '', name: '', displayName: store.data.settings.userName || '', persona: store.data.settings.persona || '', description: '', tags: [] };
    form.reset();
    for (const [key, item] of Object.entries(value)) if (form.elements[key]) form.elements[key].value = Array.isArray(item) ? item.join(', ') : item ?? '';
    $('#userProfileEditorTitle').textContent = profile ? profile.name : '新建用户设定';
    const active = profile?.id === store.data.settings.activeUserProfileId;
    $('#userProfileEditorState').textContent = active ? '当前生效' : '未启用';
    $('#userProfileEditorState').classList.toggle('active', active);
    $('#userProfileUpdatedAt').textContent = profile?.updatedAt ? `更新于 ${new Date(profile.updatedAt).toLocaleString()}` : '尚未保存';
    $('#userProfileActivate').disabled = !profile || profile.id === store.data.settings.activeUserProfileId;
    $('#userProfileDelete').disabled = !profile;
}

function renderUserProfileManager() {
    const list = $('#userProfileList');
    if (!list) return;
    const activeId = store.data.settings.activeUserProfileId;
    const sorted = [...userProfiles].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    list.innerHTML = sorted.map(profile => `<div class="manager-item ${profile.id === selectedUserProfileId ? 'active' : ''}" data-user-profile-id="${escapeHtml(profile.id)}"><b>${profile.id === activeId ? '<i class="active-dot"></i>' : ''}${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.displayName || '未设置显示名称')} · ${escapeHtml(profile.persona || '空白设定').slice(0, 48)}</small></div>`).join('') || '<div class="empty-state">还没有用户设定，点击“新建”创建 A / B / C / D 档案。</div>';
    const selected = userProfiles.find(item => item.id === selectedUserProfileId) || null;
    editUserProfile(selected);
}

async function saveUserProfile() {
    const form = $('#userProfileForm');
    if (!form?.reportValidity()) return;
    const values = Object.fromEntries(new FormData(form));
    const existing = userProfiles.find(item => item.id === values.id);
    const profile = normalizeUserProfile({
        ...values,
        id: values.id || undefined,
        tags: String(values.tags || '').split(/[,，]/).map(item => item.trim()).filter(Boolean),
        createdAt: existing?.createdAt,
    }, '用户设定');
    await library.put('userProfiles', profile);
    userProfiles = userProfiles.filter(item => item.id !== profile.id).concat(profile);
    selectedUserProfileId = profile.id;
    if (profile.id === store.data.settings.activeUserProfileId) {
        store.updateSettings({ userName: profile.displayName || profile.name || '轮回者', persona: profile.persona || '' });
        renderAll();
    }
    renderUserProfileManager();
    toast(`用户设定“${profile.name}”已保存`, 'success');
}

async function activateUserProfile(profile = userProfiles.find(item => item.id === selectedUserProfileId)) {
    if (!profile) return toast('请先选择一个用户设定', 'error');
    store.updateSettings({ activeUserProfileId: profile.id, userName: profile.displayName || profile.name || '轮回者', persona: profile.persona || '' });
    selectedUserProfileId = profile.id;
    renderUserProfileManager();
    renderAll();
    await blackbox.record('user_profile', 'user_profile_activated', { profileId: profile.id, name: profile.name }, { sessionId: store.activeSession?.id });
    toast(`已启用用户设定：${profile.name}`, 'success');
}

function exportUserProfile(profile = userProfiles.find(item => item.id === selectedUserProfileId)) {
    if (!profile) return toast('请先选择一个用户设定', 'error');
    const blob = new Blob([JSON.stringify({ format: 'reincarnation-user-profile', version: 1, exportedAt: new Date().toISOString(), profile }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = `${profile.name || '用户设定'}.json`; link.click(); URL.revokeObjectURL(url);
}

function exportUserProfiles() {
    if (!userProfiles.length) return toast('暂无可导出的用户设定', 'error');
    const blob = new Blob([JSON.stringify({ format: 'reincarnation-user-profiles', version: 1, exportedAt: new Date().toISOString(), activeId: store.data.settings.activeUserProfileId, profiles: userProfiles }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = '轮回战场-用户设定档案.json'; link.click(); URL.revokeObjectURL(url);
}

async function importUserProfiles(file) {
    const raw = JSON.parse(await file.text());
    const source = Array.isArray(raw) ? raw : Array.isArray(raw.profiles) ? raw.profiles : raw.profile ? [raw.profile] : [raw];
    const imported = source.filter(item => item && typeof item === 'object').map((item, index) => normalizeUserProfile({ ...item, id: undefined, name: item.name || `用户设定 ${index + 1}` }, `用户设定 ${index + 1}`));
    if (!imported.length) throw new Error('文件中没有可识别的用户设定');
    for (const profile of imported) {
        const existing = userProfiles.find(item => item.name === profile.name);
        if (existing) { profile.id = existing.id; profile.createdAt = existing.createdAt; }
        await library.put('userProfiles', profile);
    }
    userProfiles = userProfiles.filter(item => !imported.some(profile => profile.id === item.id)).concat(imported);
    selectedUserProfileId = imported[0].id;
    renderUserProfileManager();
    toast(`已导入 ${imported.length} 个用户设定`, 'success');
}

function editConnection(connection = null) {
    const form = $('#connectionForm');
    form.reset();
    const value = connection || { id: '', name: '', protocol: 'openai-chat', ...protocolDefaults('openai-chat'), apiKey: '', model: '', apiVersion: '', extraHeaders: '{}', extraBody: '{}', testPrompt: '只回复 OK', temperature: .9, maxTokens: 32768 };
    for (const [key, item] of Object.entries(value)) if (form.elements[key]) form.elements[key].value = item ?? '';
    $('#connectionEditorTitle').textContent = connection ? connection.name : '新建连接';
    $('#temperatureValue').textContent = value.temperature ?? .9;
    connectionModelCandidates = [];
    $('#connectionModelOptions').classList.remove('open');
}

function createConnectionDraft() {
    const protocol = 'openai-chat';
    const saved = store.saveConnection({
        id: crypto.randomUUID(),
        name: '新建连接',
        protocol,
        ...protocolDefaults(protocol),
        apiKey: '',
        model: '',
        apiVersion: '',
        extraHeaders: '{}',
        extraBody: '{}',
        testPrompt: '只回复 OK',
        temperature: .9,
        maxTokens: 32768,
    });
    editConnection(saved);
    renderConnectionManager();
    renderModelRoutingManager();
    $('#connectionForm').elements.name.focus();
    toast('已创建并保存临时连接配置，请继续填写后再次保存', 'info');
}

function renderPresetManager() {
    $('#presetList').innerHTML = presets.map(item => `<div class="manager-item ${item.id === selectedPresetId ? 'active' : ''}" data-preset-id="${item.id}"><b>${item.id === store.data.settings.activePresetId ? '<i class="active-dot"></i>' : ''}${escapeHtml(item.name)}</b><small>${item.prompts.length} 条提示词 · ${item.prompts.filter(prompt => prompt.enabled).length} 启用</small></div>`).join('') || '<div class="empty-state">尚未导入 AIRP 预设</div>';
    const preset = presets.find(item => item.id === selectedPresetId);
    if (!preset) {
        $('#presetTitle').textContent = '未选择预设';
        $('#presetSummary').innerHTML = '导入 SillyTavern OAI JSON 预设后，可在这里查看、启停和排序提示词条目。';
        $('#promptEntries').replaceChildren();
        $('#promptEntryEditor').innerHTML = '<div class="empty-state">在左侧选择一个提示词条目</div>';
        return;
    }
    if (!preset.prompts.some(item => item.identifier === selectedPromptEntryId)) selectedPromptEntryId = preset.prompts[0]?.identifier || null;
    $('#presetTitle').textContent = preset.name;
    $('#presetSummary').innerHTML = `<div class="preset-stats"><div><small>提示词条目</small><b>${preset.prompts.length}</b></div><div><small>已启用</small><b>${preset.prompts.filter(item => item.enabled).length}</b></div><div><small>温度</small><b>${preset.sampling.temperature ?? '—'}</b></div><div><small>最大输出</small><b>${preset.sampling.maxTokens ?? '—'}</b></div></div>`;
    $('#promptEntries').innerHTML = preset.prompts.map((item, index) => `<div class="prompt-entry ${item.identifier === selectedPromptEntryId ? 'selected' : ''}" data-prompt-id="${escapeHtml(item.identifier)}"><span class="drag-handle">${index + 1}</span><div><b>${escapeHtml(item.name)}</b><small>${item.marker ? '结构标记' : `${item.role} · ${item.content.length.toLocaleString()} 字符`}</small></div><label class="icon-checkbox" title="${item.enabled ? '此条目已启用' : '此条目已停用'}"><input type="checkbox" data-prompt-toggle ${item.enabled ? 'checked' : ''}></label></div>`).join('');
    renderPromptEntryEditor(preset, preset.prompts.find(item => item.identifier === selectedPromptEntryId));
}

function renderPromptEntryEditor(preset, prompt) {
    const root = $('#promptEntryEditor');
    if (!prompt) { root.innerHTML = '<div class="empty-state">在左侧选择一个提示词条目</div>'; return; }
    root.innerHTML = `<input type="hidden" name="identifier" value="${escapeHtml(prompt.identifier)}"><header><div><small>PROMPT ENTRY</small><h3>${escapeHtml(prompt.name)}</h3></div><div><button type="button" data-action="move-prompt-up" title="上移条目">↑</button><button type="button" data-action="move-prompt-down" title="下移条目">↓</button><button type="button" data-action="delete-prompt-entry" class="danger" title="删除条目">×</button><label class="icon-checkbox" title="启用或停用此提示词"><input name="enabled" type="checkbox" ${prompt.enabled ? 'checked' : ''}></label></div></header><div class="form-grid"><label class="wide"><span>名称</span><input name="name" value="${escapeHtml(prompt.name)}"></label><label><span>角色</span><select name="role"><option value="system" ${prompt.role === 'system' ? 'selected' : ''}>system</option><option value="user" ${prompt.role === 'user' ? 'selected' : ''}>user</option><option value="assistant" ${prompt.role === 'assistant' ? 'selected' : ''}>assistant</option></select></label><label><span>注入位置</span><select name="injectionPosition"><option value="0" ${Number(prompt.injectionPosition) === 0 ? 'selected' : ''}>相对位置</option><option value="1" ${Number(prompt.injectionPosition) === 1 ? 'selected' : ''}>聊天深度</option></select></label><label><span>注入深度</span><input name="injectionDepth" type="number" min="0" value="${Number(prompt.injectionDepth ?? 4)}"></label><label class="checkbox-field" title="结构标记条目不直接发送内容"><span>Marker</span><input name="marker" type="checkbox" ${prompt.marker ? 'checked' : ''}></label><label class="wide"><span>提示词内容</span><textarea name="content" rows="18" spellcheck="false">${escapeHtml(prompt.content)}</textarea></label></div><footer><span>${prompt.content.length.toLocaleString()} 字符</span><button type="submit" class="accent-button">保存当前条目</button></footer>`;
}

function updateTextEditorStatus(message = '') {
    const input = $('#textEditorValue');
    const before = input.value.slice(0, input.selectionStart);
    const line = before.split('\n').length;
    const column = before.length - before.lastIndexOf('\n');
    const count = input.value.split('\n').length;
    $('#textEditorLines').textContent = Array.from({ length: count }, (_item, index) => index + 1).join('\n');
    $('#textEditorLines').scrollTop = input.scrollTop;
    $('#textEditorStatus').textContent = message || `${textEditorReadonly ? '只读 · ' : ''}${textEditorMode === 'json' ? 'JSON' : '文本'} · ${input.value.length.toLocaleString()} 字符 · 第 ${line} 行，第 ${column} 列`;
}

function openTextEditor({ title, value, onSave, mode = 'json', readonly = false }) {
    textEditorOriginal = value;
    textEditorSave = onSave;
    textEditorMode = mode;
    textEditorReadonly = readonly;
    textEditorSearchAt = 0;
    $('#textEditorTitle').textContent = title;
    $('#textEditorValue').value = value;
    $('#textEditorFind').value = '';
    $('#textEditorReplace').value = '';
    $('#textEditorValue').readOnly = readonly;
    $$('[data-editor-write]').forEach(item => { item.hidden = readonly; });
    $$('[data-editor-json]').forEach(item => { item.hidden = mode !== 'json'; });
    updateTextEditorStatus();
    $('#textEditorDialog').showModal();
    requestAnimationFrame(() => $('#textEditorValue').focus());
}

function findInEditor() {
    const input = $('#textEditorValue');
    const query = $('#textEditorFind').value;
    if (!query) return updateTextEditorStatus('请输入查找内容');
    let index = input.value.indexOf(query, textEditorSearchAt);
    if (index < 0) index = input.value.indexOf(query);
    if (index < 0) return updateTextEditorStatus('未找到匹配内容');
    input.focus(); input.setSelectionRange(index, index + query.length);
    textEditorSearchAt = index + query.length;
    updateTextEditorStatus();
}

async function saveTextEditor() {
    try {
        if (textEditorReadonly) { $('#textEditorDialog').close(); return; }
        const value = $('#textEditorValue').value;
        if (textEditorMode === 'json') JSON.parse(value);
        await textEditorSave?.(value);
        textEditorOriginal = value;
        $('#textEditorDialog').close();
        toast(textEditorMode === 'json' ? 'JSON 已验证并保存' : '文本已保存', 'success');
    } catch (error) {
        const position = Number(error.message.match(/position\s+(\d+)/i)?.[1]);
        if (Number.isFinite(position)) { $('#textEditorValue').focus(); $('#textEditorValue').setSelectionRange(position, position); }
        updateTextEditorStatus(`无法保存：${error.message}`);
        blackbox.record('editor', 'text_save_failed', { error, mode: textEditorMode });
    }
}

async function renderBlackBox() {
    const events = await blackbox.events();
    $('#blackboxRunId').textContent = blackbox.runId;
    $('#blackboxEventCount').textContent = events.length.toLocaleString();
    $('#blackboxSessionId').textContent = store.activeSession?.id || '—';
    $('#blackboxLastEvent').textContent = events.at(-1)?.type || '—';
    $('#blackboxState').textContent = '本机记录中';
    $('#blackboxTimeline').innerHTML = events.slice(-100).reverse().map(item => `<div class="blackbox-event"><time>${escapeHtml(new Date(item.timestamp).toLocaleTimeString())}</time><span>${escapeHtml(item.category)}</span><b>${escapeHtml(item.type)}</b></div>`).join('') || '<div class="empty-state">尚无事件</div>';
}

function scriptCapabilities(script) {
    const names = ['getChatMessages', 'setChatMessage', 'getVariables', 'updateVariablesWith', 'getWorldbook', 'generateRaw', 'eventOn'];
    return names.filter(name => script.content.includes(name));
}

function renderScriptManager() {
    $('#scriptList').innerHTML = scripts.map(item => `<div class="manager-item ${item.id === selectedScriptId ? 'active' : ''}" data-script-id="${item.id}"><b>${item.enabled ? '<i class="active-dot"></i>' : ''}${escapeHtml(item.name)}</b><small>${(item.content.length / 1024 / 1024).toFixed(1)} MB · ${item.enabled ? '已启用' : '已停用'}</small></div>`).join('') || '<div class="empty-state">尚未导入助手脚本</div>';
    const script = scripts.find(item => item.id === selectedScriptId);
    if (!script) return;
    $('#scriptTitle').textContent = script.name;
    $('#scriptSummary').innerHTML = `<div class="script-meta"><div><small>脚本体积</small><b>${(script.content.length / 1024 / 1024).toFixed(2)} MB</b></div><div><small>运行状态</small><b>${script.enabled ? '已启用' : '已停用'}</b></div></div><div class="capability-list">${scriptCapabilities(script).map(name => `<span>${name}</span>`).join('')}</div>${script.enabled ? '<button class="script-console-button" data-action="open-script-ui">打开脚本控制台</button>' : ''}`;
}

function renderRegexManager() {
    const cardScripts = runtime?.card.extensions?.regex_scripts || [];
    $('#regexPresetList').innerHTML = `<div class="manager-item ${selectedRegexPresetId === 'card' ? 'active' : ''}" data-regex-preset-id="card"><b><i class="active-dot"></i>角色卡内置正则</b><small>${cardScripts.length} 条 · 随角色卡加载</small></div>` + regexPresets.map(item => `<div class="manager-item ${item.id === selectedRegexPresetId ? 'active' : ''}" data-regex-preset-id="${item.id}"><b>${item.enabled ? '<i class="active-dot"></i>' : ''}${escapeHtml(item.name)}</b><small>${item.scripts.length} 条 · ${item.enabled ? '已启用' : '已停用'}</small></div>`).join('');
    const preset = selectedRegexPresetId === 'card' ? { name: '角色卡内置正则', enabled: true, scripts: cardScripts } : regexPresets.find(item => item.id === selectedRegexPresetId);
    if (!preset) { selectedRegexPresetId = 'card'; return renderRegexManager(); }
    $('#regexPresetTitle').textContent = preset.name;
    $('#regexPresetEnabled').checked = preset.enabled !== false;
    $('#regexPresetEnabled').disabled = selectedRegexPresetId === 'card';
    $('#regexPresetEnabled').title = selectedRegexPresetId === 'card' ? '角色卡内置正则始终启用；编辑时会自动创建副本' : (preset.enabled ? '正则预设已启用' : '正则预设已停用');
    if (!preset.scripts.some(item => item.id === selectedRegexEntryId)) selectedRegexEntryId = preset.scripts[0]?.id || null;
    $('#regexPresetSummary').innerHTML = `<div class="preset-stats"><div><small>规则数</small><b>${preset.scripts.length}</b></div><div><small>发送前</small><b>${preset.scripts.filter(item => item.promptOnly || !item.markdownOnly).length}</b></div><div><small>显示时</small><b>${preset.scripts.filter(item => !item.promptOnly).length}</b></div><div><small>状态</small><b>${preset.enabled ? '启用' : '停用'}</b></div></div>`;
    $('#regexEntries').innerHTML = preset.scripts.map((item, index) => `<div class="prompt-entry ${item.id === selectedRegexEntryId ? 'selected' : ''}" data-regex-entry-id="${escapeHtml(item.id)}"><span class="drag-handle">${index + 1}</span><div><b>${escapeHtml(item.scriptName || `正则 ${index + 1}`)}</b><small>${item.promptOnly ? 'Prompt Only' : item.markdownOnly ? 'Markdown Only' : '双管线'} · placement ${(item.placement || []).join('/')} · depth ${item.minDepth ?? '—'}~${item.maxDepth ?? '—'}</small></div><label class="icon-checkbox" title="${item.disabled ? '此正则已停用' : '此正则已启用'}"><input type="checkbox" data-regex-toggle ${item.disabled ? '' : 'checked'}></label></div>`).join('');
    renderRegexEntryEditor(preset, preset.scripts.find(item => item.id === selectedRegexEntryId));
}

function renderRegexEntryEditor(preset, rule) {
    const root = $('#regexEntryEditor');
    if (!rule) { root.innerHTML = '<div class="empty-state">在左侧选择一条正则规则</div>'; return; }
    const placement = rule.placement || [];
    root.innerHTML = `<input type="hidden" name="id" value="${escapeHtml(rule.id)}"><header><div><small>REGEX SCRIPT</small><h3>${escapeHtml(rule.scriptName)}</h3></div><div><button type="button" data-action="move-regex-up" title="上移规则">↑</button><button type="button" data-action="move-regex-down" title="下移规则">↓</button><button type="button" data-action="delete-regex-entry" class="danger" title="删除规则">×</button><label class="icon-checkbox" title="启用或停用此正则"><input name="enabled" type="checkbox" ${rule.disabled ? '' : 'checked'}></label></div></header>${selectedRegexPresetId === 'card' ? '<div class="editor-notice">编辑卡内规则时会创建一份可编辑副本，原角色卡数据保持不变。</div>' : ''}<div class="form-grid"><label class="wide"><span>脚本名称</span><input name="scriptName" value="${escapeHtml(rule.scriptName)}"></label><label class="wide"><span>查找正则</span><textarea name="findRegex" rows="5" spellcheck="false">${escapeHtml(rule.findRegex || '')}</textarea></label><label class="wide"><span>替换内容</span><textarea name="replaceString" rows="10" spellcheck="false">${escapeHtml(rule.replaceString || '')}</textarea></label><div class="checkbox-strip wide"><label title="作用于用户消息（placement 1）"><input name="placement1" type="checkbox" ${placement.includes(1) ? 'checked' : ''}></label><label title="作用于角色消息（placement 2）"><input name="placement2" type="checkbox" ${placement.includes(2) ? 'checked' : ''}></label><label title="仅用于发送模型前的 Prompt 管线"><input name="promptOnly" type="checkbox" ${rule.promptOnly ? 'checked' : ''}></label><label title="仅用于 Markdown/消息显示管线"><input name="markdownOnly" type="checkbox" ${rule.markdownOnly ? 'checked' : ''}></label><label title="编辑已有消息时重新运行"><input name="runOnEdit" type="checkbox" ${rule.runOnEdit ? 'checked' : ''}></label><label title="在查找正则中执行宏替换"><input name="substituteRegex" type="checkbox" ${Number(rule.substituteRegex) > 0 ? 'checked' : ''}></label></div><label><span>最小深度</span><input name="minDepth" type="number" min="0" value="${rule.minDepth ?? ''}"></label><label><span>最大深度</span><input name="maxDepth" type="number" min="0" value="${rule.maxDepth ?? ''}"></label><label class="wide"><span>预先移除字符串（每行一项）</span><textarea name="trimStrings" rows="3">${escapeHtml((rule.trimStrings || []).join('\n'))}</textarea></label></div><footer><span>${escapeHtml(preset.name)}</span><button type="submit" class="accent-button">保存当前规则</button></footer>`;
}

async function editableRegexPreset() {
    if (selectedRegexPresetId !== 'card') return regexPresets.find(item => item.id === selectedRegexPresetId);
    const previouslySelected = selectedRegexEntryId;
    const preset = normalizeRegexPreset({ name: '角色卡内置正则副本', enabled: true, scripts: runtime.card.extensions.regex_scripts }, '角色卡内置正则副本.json');
    await library.put('regexPresets', preset); regexPresets.push(preset); selectedRegexPresetId = preset.id;
    selectedRegexEntryId = preset.scripts.some(item => item.id === previouslySelected) ? previouslySelected : preset.scripts[0]?.id || null;
    runtime.setRegexPresets(regexPresets);
    return preset;
}

function presetByName(name) {
    if (name === 'in_use') return presets.find(item => item.id === store.data.settings.activePresetId) || null;
    return presets.find(item => item.name === name) || null;
}

function presetBridgeValue(preset) {
    if (!preset) throw new Error('预设不存在');
    const raw = preset.raw || {};
    return structuredClone({
        ...raw,
        prompts: preset.prompts,
        extensions: { ...(raw.extensions || {}), ...(preset.extensions || {}) },
        settings: {
            temperature: preset.sampling?.temperature ?? raw.temperature ?? 1,
            top_p: preset.sampling?.topP ?? raw.top_p ?? 1,
            top_k: preset.sampling?.topK ?? raw.top_k ?? 0,
            min_p: raw.min_p ?? 0,
            frequency_penalty: preset.sampling?.frequencyPenalty ?? raw.frequency_penalty ?? 0,
            presence_penalty: preset.sampling?.presencePenalty ?? raw.presence_penalty ?? 0,
            max_context: preset.sampling?.contextSize ?? raw.openai_max_context ?? 128000,
            max_completion_tokens: preset.sampling?.maxTokens ?? raw.openai_max_tokens ?? 8192,
            should_stream: raw.stream_openai !== false,
            reasoning_effort: preset.sampling?.reasoningEffort ?? raw.reasoning_effort ?? 'auto',
        },
    });
}

function rawFromPresetBridge(value) {
    const prompts = (value.prompts || []).map((prompt, index) => ({
        ...prompt,
        identifier: prompt.identifier || prompt.id || crypto.randomUUID(),
        name: prompt.name || `条目 ${index + 1}`,
        injection_position: prompt.injection_position ?? prompt.injectionPosition ?? 0,
        injection_depth: prompt.injection_depth ?? prompt.injectionDepth ?? 4,
    }));
    const settings = value.settings || {};
    const { settings: _bridgeSettings, ...source } = value;
    return {
        ...source,
        prompts,
        prompt_order: [{ character_id: 100001, order: prompts.map(prompt => ({ identifier: prompt.identifier, enabled: prompt.enabled !== false })) }],
        temperature: settings.temperature ?? value.temperature,
        top_p: settings.top_p ?? value.top_p,
        top_k: settings.top_k ?? value.top_k,
        min_p: settings.min_p ?? value.min_p,
        frequency_penalty: settings.frequency_penalty ?? value.frequency_penalty,
        presence_penalty: settings.presence_penalty ?? value.presence_penalty,
        openai_max_context: settings.max_context ?? value.openai_max_context,
        openai_max_tokens: settings.max_completion_tokens ?? value.openai_max_tokens,
        stream_openai: settings.should_stream ?? value.stream_openai,
        reasoning_effort: settings.reasoning_effort ?? value.reasoning_effort,
        extensions: value.extensions || {},
    };
}

async function saveBridgePreset(name, value, existing = presetByName(name)) {
    const normalized = normalizePreset(rawFromPresetBridge(value), `${name}.json`);
    if (existing) normalized.id = existing.id;
    normalized.name = name;
    await library.put('presets', normalized);
    presets = presets.filter(item => item.id !== normalized.id && item.name !== name).concat(normalized);
    if (existing?.id === store.data.settings.activePresetId || name === 'in_use') {
        store.updateSettings({ activePresetId: normalized.id }); runtime.setPreset(normalized);
    }
    selectedPresetId = normalized.id; renderPresetManager();
    return normalized;
}

function installPresetBridge() {
    const api = {
        getPresetNames: () => presets.map(item => item.name),
        getLoadedPresetName: () => presetByName('in_use')?.name || '',
        getPreset: name => presetBridgeValue(presetByName(name)),
        isPresetNormalPrompt: prompt => !prompt?.marker,
        isPresetSystemPrompt: prompt => Boolean(prompt?.marker || prompt?.role === 'system'),
        importRawPreset: async (name, content) => {
            try {
                const raw = typeof content === 'string' ? JSON.parse(content) : content;
                await saveBridgePreset(String(name).replace(/\.json$/i, ''), raw);
                return true;
            } catch (error) { console.error('[preset bridge] importRawPreset', error); return false; }
        },
        loadPreset: name => {
            const preset = presetByName(name); if (!preset) return false;
            store.updateSettings({ activePresetId: preset.id }); runtime.setPreset(preset); selectedPresetId = preset.id; renderPresetManager(); return true;
        },
        replacePreset: async (name, value) => { await saveBridgePreset(name === 'in_use' ? presetByName('in_use')?.name : name, value, presetByName(name)); return true; },
        updatePresetWith: async (name, callback) => {
            const preset = presetByName(name); if (!preset) return false;
            const value = presetBridgeValue(preset); const result = await callback(value);
            await saveBridgePreset(preset.name, result ?? value, preset); return true;
        },
        createPreset: async (name, value = { prompts: [], extensions: {} }) => { await saveBridgePreset(name, value); return true; },
        deletePreset: async name => {
            const preset = presetByName(name); if (!preset) return false;
            await library.delete('presets', preset.id); presets = presets.filter(item => item.id !== preset.id);
            if (store.data.settings.activePresetId === preset.id) { store.updateSettings({ activePresetId: null }); runtime.setPreset(null); }
            selectedPresetId = presets[0]?.id || null; renderPresetManager(); return true;
        },
        renamePreset: async (oldName, newName) => {
            const preset = presetByName(oldName); if (!preset || !newName) return false;
            preset.name = newName; await library.put('presets', preset); renderPresetManager(); return true;
        },
        exportPreset: name => {
            const preset = presetByName(name); if (!preset) return false;
            const blob = new Blob([JSON.stringify(rawFromPresetBridge(presetBridgeValue(preset)), null, 2)], { type: 'application/json' });
            const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `${preset.name}.json`; link.click(); URL.revokeObjectURL(link.href); return true;
        },
        forgeShop: forgePersonalShop,
        forge_shop: forgePersonalShop,
    };
    Object.assign(window, api);
    Object.assign(window.TavernHelper, api);
}

// Preset entries the reincarnation flow needs on top of the card's built-in
// worldbook: the local-authority combat handoff and the post-battle
// disposition rules.  Seeded once into the user-managed store; fully editable
// afterwards and never force-restored over user edits.
const WORLDBOOK_SEEDS = [
    {
        comment: '【战术演算】本地权威战斗交接', keys: ['战斗', '交战', '开战', '遭遇战', '战术演算', '袭击'], constant: false,
        insertion_order: 900, position: 'before_char',
        content: '当剧情走向战斗时，正文 AI 不得自行裁定命中、伤害、死亡或胜负；应输出 BattleDeclaration 战场声明并交给本地战术演算终端以固定种子结算。战斗期间保持战场态势描述克制，等待本地裁定结果。战后以本地 CheckResult 与战报大纲为唯一事实来源融合剧情，不得改写骰点、伤害、死亡与胜负。',
    },
    {
        comment: '【战后处置】搜刮与战利品规则', keys: ['搜刮', '战利品', '打扫战场', '战后处置', '缴获', '尸体'], constant: false,
        insertion_order: 901, position: 'before_char',
        content: '战斗结束后，若玩家提出战后处置要求（如搜刮战利品、安葬死者、破坏尸体、审问俘虏、快速撤离），正文 AI 应围绕本地战报已裁定的伤亡、位置与状态描写处置过程与合理结果。物品与资源发放需与战场事实、参与者状态和世界物价一致；不得凭空捏造未在裁定或处置逻辑中出现的高价值战利品，也不得复写已经结束的战斗经过。',
    },
];

function worldbookDepthOption(entry) {
    const depth = entry?.extensions?.depth;
    return depth !== null && depth !== undefined && Number.isFinite(Number(depth)) ? String(Number(depth)) : '';
}

function renderWorldbookManager() {
    const listRoot = $('#worldbookList');
    if (!listRoot) return;
    listRoot.innerHTML = worldbookEntries.map(entry => `<div class="manager-item ${entry.id === selectedWorldbookId ? 'active' : ''}" data-worldbook-id="${entry.id}"><b>${entry.enabled !== false ? '<i class="active-dot"></i>' : ''}${escapeHtml(entry.comment || `条目 ${entry.id}`)}</b><small>${entry.constant ? '常驻' : (entry.keys.length ? entry.keys.join('、') : '未设关键词')} · 顺序 ${entry.insertion_order}${worldbookDepthOption(entry) ? ` · 深度 ${worldbookDepthOption(entry)}` : ''}</small></div>`).join('') || '<div class="empty-state">还没有自定义世界书条目；点击“＋ 新建”或导入 JSON。</div>';
    const form = $('#worldbookForm');
    const entry = worldbookEntries.find(item => item.id === selectedWorldbookId);
    if (!entry) {
        $('#worldbookTitle').textContent = '未选择条目';
        $('#worldbookMeta').textContent = '新条目保存后立即与角色卡内置世界书并行生效。';
        form?.reset();
        if (form?.elements?.insertionOrder) form.elements.insertionOrder.value = '100';
        return;
    }
    $('#worldbookTitle').textContent = entry.comment || `条目 ${entry.id}`;
    $('#worldbookMeta').textContent = `${entry.origin === 'seed' ? '流程预置条目' : '自建条目'} · 更新于 ${entry.updatedAt || '-'} · ${entry.content.length.toLocaleString()} 字符`;
    form.elements.id.value = String(entry.id);
    form.elements.comment.value = entry.comment;
    form.elements.keys.value = entry.keys.join(', ');
    form.elements.secondaryKeys.value = entry.secondary_keys.join(', ');
    form.elements.insertionOrder.value = String(entry.insertion_order);
    form.elements.position.value = entry.position;
    form.elements.depth.value = worldbookDepthOption(entry);
    form.elements.role.value = String(entry.extensions?.role || 0);
    form.elements.enabled.checked = entry.enabled !== false;
    form.elements.constant.checked = Boolean(entry.constant);
    form.elements.useRegex.checked = entry.use_regex !== false;
    form.elements.content.value = entry.content;
}

function applyWorldbookEntriesToRuntime() {
    runtime?.setCustomWorldbook?.(worldbookEntries);
}

async function saveWorldbookForm(event) {
    event.preventDefault();
    const form = $('#worldbookForm');
    const existing = worldbookEntries.find(item => String(item.id) === form.elements.id.value);
    const depth = form.elements.depth.value;
    const raw = {
        ...(existing || {}),
        id: existing?.id,
        keys: form.elements.keys.value,
        secondary_keys: form.elements.secondaryKeys.value,
        comment: form.elements.comment.value.trim() || '未命名条目',
        content: form.elements.content.value,
        constant: form.elements.constant.checked,
        insertion_order: Number(form.elements.insertionOrder.value) || 0,
        enabled: form.elements.enabled.checked,
        position: form.elements.position.value,
        use_regex: form.elements.useRegex.checked,
        extensions: { ...(existing?.extensions || {}), role: Number(form.elements.role.value) || 0, ...(depth === '' ? {} : { depth: Number(depth) }) },
    };
    if (raw.extensions && depth === '') delete raw.extensions.depth;
    const entry = normalizeWorldbookEntry(raw);
    await library.put('worldbooks', entry);
    worldbookEntries = worldbookEntries.filter(item => item.id !== entry.id).concat(entry);
    selectedWorldbookId = entry.id;
    applyWorldbookEntriesToRuntime();
    renderWorldbookManager();
    toast(`世界书条目“${entry.comment}”已保存并生效`, 'success');
}

async function createWorldbookEntry() {
    const entry = normalizeWorldbookEntry({ comment: '新条目', insertion_order: 100 });
    await library.put('worldbooks', entry);
    worldbookEntries = worldbookEntries.concat(entry);
    selectedWorldbookId = entry.id;
    applyWorldbookEntriesToRuntime();
    renderWorldbookManager();
    $('#worldbookForm')?.elements?.comment?.focus();
}

async function deleteWorldbookEntry() {
    const entry = worldbookEntries.find(item => item.id === selectedWorldbookId);
    if (!entry) return toast('请先在左侧选择要删除的条目', 'error');
    await library.delete('worldbooks', entry.id);
    worldbookEntries = worldbookEntries.filter(item => item.id !== entry.id);
    selectedWorldbookId = worldbookEntries[0]?.id ?? null;
    applyWorldbookEntriesToRuntime();
    renderWorldbookManager();
    toast(`已删除世界书条目“${entry.comment}”`, 'info');
}

async function importWorldbookFile(file) {
    const parsed = JSON.parse(await file.text());
    const rawEntries = Array.isArray(parsed) ? parsed : parsed?.entries || parsed?.character_book?.entries;
    if (!Array.isArray(rawEntries) || !rawEntries.length) throw new Error('不是可识别的世界书 JSON：缺少条目数组');
    const imported = rawEntries.map(item => normalizeWorldbookEntry({ ...item, origin: 'user' }));
    for (const entry of imported) await library.put('worldbooks', entry);
    const importedIds = new Set(imported.map(item => item.id));
    worldbookEntries = worldbookEntries.filter(item => !importedIds.has(item.id)).concat(imported);
    selectedWorldbookId = imported[0]?.id ?? selectedWorldbookId;
    applyWorldbookEntriesToRuntime();
    renderWorldbookManager();
    toast(`已导入 ${imported.length} 条世界书条目`, 'success');
}

function exportWorldbookEntries() {
    if (!worldbookEntries.length) return toast('还没有可导出的世界书条目', 'error');
    const payload = { name: '轮回战场·自定义世界书', entries: worldbookEntries };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `reincarnation-worldbook-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
}

async function restoreWorldbookSeeds() {
    let restored = 0;
    for (const seed of WORLDBOOK_SEEDS) {
        if (worldbookEntries.some(item => item.comment === seed.comment)) continue;
        const entry = normalizeWorldbookEntry({ ...seed, origin: 'seed' });
        await library.put('worldbooks', entry);
        worldbookEntries = worldbookEntries.concat(entry);
        restored += 1;
    }
    applyWorldbookEntriesToRuntime();
    renderWorldbookManager();
    toast(restored ? `已恢复 ${restored} 条流程预置条目` : '流程预置条目均已存在', restored ? 'success' : 'info');
}

async function loadLibraries() {
    [presets, scripts, profiles, userProfiles, regexPresets] = await Promise.all([library.list('presets'), library.list('scripts'), library.list('profiles'), library.list('userProfiles'), library.list('regexPresets')]);
    // One-time migration for presets imported before prompt-order alignment
    // was implemented.  Preserve locally edited prompt text/order, but apply
    // Tavern's active order as the enable allow-list so stale entries from an
    // older stored normalized object do not leak into the next request.
    for (const preset of presets) {
        if (preset.promptOrderAligned || !preset.raw?.prompts || !Array.isArray(preset.prompts)) continue;
        const selectedOrder = preset.raw.prompt_order?.find(item => String(item.character_id) === '100001')
            || preset.raw.prompt_order?.at(-1);
        const order = Array.isArray(selectedOrder?.order) ? selectedOrder.order : [];
        if (Array.isArray(selectedOrder?.order)) {
            const enabledMap = new Map(order.map(item => [item.identifier, item.enabled !== false]));
            preset.prompts = preset.prompts.map(prompt => ({ ...prompt, enabled: Boolean(enabledMap.get(prompt.identifier)) }));
        }
        preset.promptOrderAligned = true;
        await library.put('presets', preset);
    }
    if (!userProfiles.length) {
        const legacy = normalizeUserProfile({ name: '默认用户', displayName: store.data.settings.userName || '轮回者', persona: store.data.settings.persona || '', description: '由旧版常规设置迁移而来' }, '默认用户');
        await library.put('userProfiles', legacy);
        userProfiles = [legacy];
    }
    let activeUserProfile = userProfiles.find(item => item.id === store.data.settings.activeUserProfileId);
    if (!activeUserProfile) {
        activeUserProfile = userProfiles[0];
        store.updateSettings({ activeUserProfileId: activeUserProfile.id, userName: activeUserProfile.displayName || activeUserProfile.name || '轮回者', persona: activeUserProfile.persona || '' });
    } else {
        // The active profile is the source of truth for the prompt persona.
        store.updateSettings({ userName: activeUserProfile.displayName || activeUserProfile.name || '轮回者', persona: activeUserProfile.persona || '' });
    }
    selectedUserProfileId = activeUserProfile.id;
    worldbookEntries = (await library.list('worldbooks')).map(item => normalizeWorldbookEntry(item));
    if (!worldbookEntries.length) {
        for (const seed of WORLDBOOK_SEEDS) worldbookEntries.push(normalizeWorldbookEntry({ ...seed, origin: 'seed' }));
        await Promise.all(worldbookEntries.map(entry => library.put('worldbooks', entry)));
    }
    selectedWorldbookId = worldbookEntries[0]?.id ?? null;
    runtime.setCustomWorldbook(worldbookEntries);
    selectedPresetId = store.data.settings.activePresetId || presets[0]?.id || null;
    selectedScriptId = scripts[0]?.id || null;
    const active = presets.find(item => item.id === store.data.settings.activePresetId) || null;
    runtime.setPreset(active);
    runtime.setRegexPresets(regexPresets);
    installPresetBridge();
    renderPresetManager(); renderScriptManager(); renderRegexManager(); renderConnectionManager(); renderUserProfileManager(); renderWorldbookManager();
    for (const script of scripts.filter(item => item.enabled)) executeAssistantScript(script).catch(error => toast(`${script.name} 启动失败：${error.message}`, 'error'));
}

async function importPresetFile(file) {
    const preset = normalizePreset(JSON.parse(await file.text()), file.name);
    await library.put('presets', preset);
    presets = presets.filter(item => item.id !== preset.id).concat(preset); selectedPresetId = preset.id;
    renderPresetManager(); toast(`已导入 AIRP 预设：${preset.name}`, 'success');
}

async function importScriptFile(file) {
    const text = await file.text();
    let raw;
    try { raw = JSON.parse(text); }
    catch (error) {
        if (!/\.m?js$/i.test(file.name)) throw new Error(`JSON 解析失败：${error.message}`);
        raw = { type: 'script', name: file.name.replace(/\.m?js$/i, ''), content: text, enabled: true };
    }
    const script = normalizeScript(raw, file.name);
    await library.put('scripts', script);
    scripts = scripts.filter(item => item.id !== script.id).concat(script); selectedScriptId = script.id;
    renderScriptManager();
    if (script.enabled) executeAssistantScript(script).catch(error => toast(`${script.name} 启动失败：${error.message}`, 'error'));
    toast(`已导入助手脚本：${script.name}`, 'success');
}

async function importScriptUrl(sourceUrl) {
    let remote;
    const response = await fetch('/api/import-script-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: sourceUrl }) });
    const responseText = await response.text();
    try { remote = JSON.parse(responseText); }
    catch {
        if (/^\s*<!doctype|^\s*<html/i.test(responseText)) {
            try {
                const direct = await fetch(sourceUrl);
                if (!direct.ok) throw new Error(`${direct.status} ${direct.statusText}`);
                const url = new URL(sourceUrl);
                const parts = url.pathname.split('/').filter(Boolean).map(item => decodeURIComponent(item));
                const leaf = parts.at(-1) || '远程助手脚本.js';
                const filename = /^index\.(?:m?js|json)$/i.test(leaf) && parts.length > 1 ? `${parts.at(-2)}${leaf.slice(5)}` : leaf;
                remote = { url: direct.url || sourceUrl, filename, contentType: direct.headers.get('content-type') || '', content: await direct.text() };
            } catch (error) {
                throw new Error(`本机仍在运行旧版服务，且 CDN 直连失败（${error.message}）。请关闭旧窗口并重新启动网页版。`);
            }
        } else throw new Error(`本机导入接口返回了无法识别的内容（HTTP ${response.status}）`);
    }
    if (!response.ok && !remote?.content) throw new Error(remote?.error || response.statusText);
    let raw;
    try { raw = JSON.parse(remote.content); }
    catch (error) {
        if (!/\.(?:m?js)(?:$|\?)/i.test(remote.filename) && !/javascript|ecmascript/i.test(remote.contentType)) throw new Error(`远程 JSON 解析失败：${error.message}`);
        raw = { type: 'script', name: remote.filename.replace(/\.m?js$/i, ''), content: remote.content, enabled: true };
    }
    const script = { ...normalizeScript(raw, remote.filename), sourceUrl: remote.url };
    await library.put('scripts', script);
    scripts = scripts.filter(item => item.id !== script.id).concat(script); selectedScriptId = script.id;
    renderScriptManager();
    if (script.enabled) executeAssistantScript(script).catch(error => toast(`${script.name} 启动失败：${error.message}`, 'error'));
    toast(`已从 URL 导入：${script.name}`, 'success');
}

async function callExtraModel(messages, options = {}) {
    const settings = { ...store.data.settings, ...options };
    const rawMessages = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
    const outgoingMessages = applyPromptModuleMessages([
        { id: 'preset', label: PROMPT_MODULE_DEFINITIONS.preset.label, messages: [] },
        { id: 'rules', label: PROMPT_MODULE_DEFINITIONS.rules.label, messages: rawMessages.filter(item => item?.role === 'system') },
        { id: 'work', label: PROMPT_MODULE_DEFINITIONS.work.label, messages: rawMessages.filter(item => item?.role !== 'system') },
    ], 'assistant-script');
    const scriptController = new AbortController();
    const processId = beginAiProcess('助手脚本 AI', '等待模型响应', () => scriptController.abort(new DOMException('用户已取消助手脚本请求', 'AbortError')));
    try {
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...settings, messages: outgoingMessages }), signal: scriptController.signal });
        updateAiProcess(processId, '接收模型响应');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || JSON.stringify(data));
        return data.choices?.[0]?.message?.content || '';
    } finally {
        endAiProcess(processId);
    }
}

async function executeAssistantScript(script) {
    if (scriptFrames.has(script.id) || !script.enabled) return;
    await blackbox.record('script', 'script_starting', { id: script.id, name: script.name, sourceUrl: script.sourceUrl, size: script.content.length }, { sessionId: store.activeSession?.id });
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.dataset.assistantScript = script.id;
    document.body.append(frame);
    const win = frame.contentWindow;
    frame.contentDocument.addEventListener('focusin', event => {
        if (!frame.hidden) return;
        event.target?.blur?.();
        window.focus();
    }, true);
    win.$ = win.jQuery = jquery;
    const saveData = async data => { script.data = data; await library.put('scripts', script); };
    Object.assign(win, {
        $: jquery, jQuery: jquery, _: window._, z: Zod, Vue, toastr: window.toastr, TavernHelper: window.TavernHelper,
        SillyTavern: { ...window.SillyTavern, getCurrentChatId: () => store.activeSession?.id || '', getCurrentMessageId: () => activeMessageId },
        tavern_events: window.tavern_events, chat_metadata: window.chat_metadata, chat: store.activeSession?.messages || [],
        getChatMessages: window.getChatMessages, setChatMessage: window.setChatMessage, setChatMessages: window.setChatMessages,
        getCurrentChatId: () => store.activeSession?.id || '', getCurrentMessageId: () => activeMessageId,
        getScriptId: () => script.id, getScriptName: () => script.name,
        getVariables: options => options?.type === 'script' ? structuredClone(script.data || {}) : window.getVariables(options),
        replaceVariables: async (data, options) => options?.type === 'script' ? saveData(structuredClone(data)) : runtime.replaceVariables(data),
        updateVariablesWith: async (callback, options) => { if (options?.type === 'script') { const data = structuredClone(script.data || {}); await saveData(await callback(data) ?? data); } else return window.updateVariablesWith(callback); },
        getWorldbookNames: () => [runtime.card.extensions?.world || runtime.card.name],
        getCharWorldbookNames: () => [runtime.card.extensions?.world || runtime.card.name],
        getChatWorldbookName: () => runtime.card.extensions?.world || runtime.card.name,
        getGlobalWorldbookNames: () => [],
        getWorldbook: () => structuredClone(runtime.card.character_book?.entries || []),
        injectPrompts: window.injectPrompts,
        getPresetNames: window.getPresetNames, getLoadedPresetName: window.getLoadedPresetName, getPreset: window.getPreset,
        isPresetNormalPrompt: window.isPresetNormalPrompt, isPresetSystemPrompt: window.isPresetSystemPrompt,
        importRawPreset: window.importRawPreset, loadPreset: window.loadPreset, replacePreset: window.replacePreset,
        updatePresetWith: window.updatePresetWith, createPreset: window.createPreset, deletePreset: window.deletePreset,
        renamePreset: window.renamePreset, exportPreset: window.exportPreset,
        generate: options => callExtraModel(options?.prompt || options?.messages || options, options || {}),
        generateRaw: options => callExtraModel(options?.prompt || options?.messages || options, options || {}),
        forgeShop: forgePersonalShop,
        forge_shop: forgePersonalShop,
        eventOn: window.eventOn, eventEmit: window.eventEmit, waitGlobalInitialized: window.waitGlobalInitialized,
        getUserName: () => store.data.settings.userName, getCharName: () => runtime.card.name,
    });
    const blob = new Blob([script.content], { type: 'text/javascript' });
    const url = URL.createObjectURL(blob);
    const tag = frame.contentDocument.createElement('script');
    tag.type = 'module'; tag.src = url;
    const loaded = new Promise((resolve, reject) => { tag.onload = resolve; tag.onerror = () => reject(new Error('模块加载失败')); });
    frame.contentDocument.head.append(tag);
    scriptFrames.set(script.id, { frame, url });
    try { await loaded; await blackbox.record('script', 'script_started', { id: script.id, name: script.name }, { sessionId: store.activeSession?.id }); }
    catch (error) { await blackbox.record('script', 'script_failed', { id: script.id, name: script.name, error }, { sessionId: store.activeSession?.id }); throw error; }
}

function openAssistantScriptUi(id) {
    const running = scriptFrames.get(id);
    if (!running) return toast('脚本仍在启动或启动失败', 'error');
    const selector = '.zhino-fab,.chaoxi-fab,[class*="floating"] button,[class*="fab"]';
    const scriptRoots = [...document.querySelectorAll(`[script_id="${CSS.escape(id)}"]`)];
    const trigger = scriptRoots.map(root => root.matches(selector) ? root : root.querySelector(selector)).find(Boolean);
    if (trigger) {
        const rect = trigger.getBoundingClientRect();
        const init = { bubbles: true, button: 0, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, screenX: rect.left + rect.width / 2, screenY: rect.top + rect.height / 2 };
        trigger.dispatchEvent(new PointerEvent('pointerdown', init));
        window.dispatchEvent(new PointerEvent('pointerup', init));
        trigger.click();
    } else toast('脚本已在宿主页面运行；请使用它自己的悬浮球打开界面', 'info');
}

function stopAssistantScript(id) {
    const running = scriptFrames.get(id);
    if (!running) return;
    document.querySelectorAll(`[script_id="${CSS.escape(id)}"]`).forEach(node => node.remove());
    running.frame.remove(); URL.revokeObjectURL(running.url); scriptFrames.delete(id);
}

function renderIntegrity(result) {
    const data = runtime.card;
    const rows = [
        ['角色卡协议', `${runtime.envelope.spec} ${runtime.envelope.spec_version}`, true],
        ['世界书', `${data.character_book?.entries?.length ?? 0} / 41`, data.character_book?.entries?.length === 41],
        ['正则脚本', `${data.extensions?.regex_scripts?.length ?? 0} / 12`, data.extensions?.regex_scripts?.length === 12],
        ['玩法脚本', `${result.loaded.length + result.failed.length} / 4`, result.loaded.length + result.failed.length === 4],
        ...result.loaded.map(item => [item.name, item.mode, true]),
        ...result.failed.map(item => [item.name, `远程模块暂不可用：${item.error}`, false]),
    ];
    $('#integrityDetails').innerHTML = rows.map(([name, value, ok]) => `<div class="integrity-row"><span>${escapeHtml(name)}</span><b class="${ok ? 'ok' : ''}">${escapeHtml(value)}</b></div>`).join('');
}

function fillSettings() {
    const form = $('#settingsForm');
    for (const [key, value] of Object.entries(store.data.settings)) if (form.elements[key]) form.elements[key].value = value;
    const active = store.data.connections.find(item => item.id === store.data.settings.activeConnectionId) || null;
    editConnection(active);
    renderConnectionManager();
    renderModelRoutingManager();
    applyUiScale();
}

function applyUiScale() {
    const scale = Math.min(1.5, Math.max(.85, Number(store.data.settings.uiScale) || 1));
    const root = document.documentElement;
    // CSS zoom scales the rendered box as well as its content. Keep both
    // dimensions inversely sized on every viewport (including phones), so the
    // maximum 150% accessibility scale never makes the app itself taller than
    // the physical viewport and clips profile/settings actions at the bottom.
    root.style.setProperty('--ui-scale', String(scale));
    root.dataset.uiScale = String(scale);
    root.style.setProperty('--app-viewport-width', `${window.innerWidth / scale}px`);
    root.style.setProperty('--app-viewport-height', `${window.innerHeight / scale}px`);
}

window.addEventListener('resize', applyUiScale);

function renderAll() {
    renderMessages();
    renderQuickActions();
    renderStatus();
    renderMissions();
    renderInventory();
    renderAbilities();
    renderWorld();
    renderRelations();
    renderPersonalShop();
    renderIntel();
    renderHudAndHub();
    renderArchive();
    renderConnectionManager();
    renderCombat();
}

function showPanel(panel) {
    $$('.view').forEach(item => item.classList.toggle('active', item.id === `view-${panel}`));
    $$('.nav-item[data-panel], .mobile-bottom-nav [data-panel]').forEach(item => item.classList.toggle('active', item.dataset.panel === panel));
    document.documentElement.dataset.activePanel = panel;
    const labels = { hub: '世界总览', chat: '剧情楼层', combat: '战术演算', status: '主角档案', shop: '个人商店终端', inventory: '装备与道具', abilities: '技能与血统', missions: '任务', world: '世界档案', worldbook: '世界书管理', relations: '实体关系', intel: '情报与传闻', archive: '存档管理', 'user-settings': '用户设定', settings: '系统设置' };
    $('#routeLabel').textContent = labels[panel] ?? panel;
    $('#rail').classList.remove('open');
    if (panel !== 'chat') {
        const toolbar = $('#view-chat .adventure-toolbar');
        toolbar?.classList.remove('tools-open');
        toolbar?.querySelector('[data-action="toggle-story-tools"]')?.setAttribute('aria-expanded', 'false');
    }
    if (panel === 'combat') loadCombat({ quiet: true });
}

async function newSession() {
    const variables = runtime.createInitialVariables();
    const session = store.createSession({ firstMessage: runtime.card.first_mes || '【封面】', variables });
    const first = session.messages[0];
    if (first) first.swipes = [runtime.card.first_mes, ...(runtime.card.alternate_greetings ?? [])];
    store.save();
    loadPersonalShopState();
    combatState = null; combatUnitStrategySelections = {}; combatEvents = []; combatMapMenu = null; combatMapIntent = null; combatMapZoom = 1; combatMapPan = { x: 0, y: 0 }; combatSelectedUnitId = null; combatEntityInspectorUnitId = null; combatPromptTraceCache = null; snapCombatFlowPhase(); pendingCombatScriptReview = null; resetCombatRecognitionState();
    await runtime.emit(window.Mvu.events.VARIABLE_INITIALIZED, runtime.variables, 0);
    await blackbox.record('session', 'session_created', { title: session.title, firstMessage: session.messages[0]?.content, variables: session.variables }, { sessionId: session.id });
    showPanel('hub');
    renderAll();
}

const attributeKeys = ['力量', '敏捷', '体质', '精神', '魅力'];
let setupStep = 0;
let attributePoints = Object.fromEntries(attributeKeys.map(key => [key, 0]));
const qualityLevels = ['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS'];

function renderAttributeBuilder() {
    $('#attributeBuilder').innerHTML = attributeKeys.map(key => `<div class="attribute-item"><span>${key}</span><b>${qualityLevels[attributePoints[key]]}</b><div><button type="button" data-attribute="${key}" data-delta="-1">−</button><button type="button" data-attribute="${key}" data-delta="1">＋</button></div></div>`).join('');
    $('#pointsLeft').textContent = 8 - Object.values(attributePoints).reduce((sum, value) => sum + value, 0);
}

function starterItems() {
    if (!openingData) return [];
    return [
        ...(openingData.equipments || []).map(item => ({ ...item, _cat: 'equipment' })),
        ...(openingData.items || []).map(item => ({ ...item, _cat: 'item' })),
        ...(openingData.skills || []).map(item => ({ ...item, _cat: 'skill' })),
        ...customStarterItems,
    ];
}

function personalCatalogItems() {
    const catalog = store.activeSession?.personalShop?.catalog;
    if (!catalog) return [];
    const mapping = [['血统列表', 'bloodline'], ['形态列表', 'form'], ['技能列表', 'skill'], ['装备列表', 'equipment'], ['道具列表', 'item'], ['升级列表', 'upgrade']];
    return mapping.flatMap(([key, category]) => (Array.isArray(catalog[key]) ? catalog[key] : []).map((entry, index) => ({
        ...entry,
        id: `shop:${category}:${entry.id || index + 1}`,
        name: entry.名称 || entry.name || '未命名商品',
        tier: entry.品质 || entry.tier || 'F',
        cost: Number(entry.价格 ?? entry.cost ?? 0),
        desc: entry.描述 || entry.desc || '',
        tags: entry.标签 || entry.tags || [],
        attrs: entry.原始属性 || entry.被动属性 || entry.attrs || Object.fromEntries(['命中', '伤害', 'DEF', 'MDEF'].filter(key => entry[key] !== undefined).map(key => [key, entry[key]])),
        effects: entry.效果 || entry.特效 || entry.特殊效果 || entry.effects || {},
        consume: entry.消耗 || entry.consume || '',
        _cat: category,
        _shopGenerated: true,
        _catalogEntry: entry,
    })));
}

function personalShopItems() {
    const generated = personalCatalogItems();
    if (!generated.length) return starterItems();
    // 首次刷新后以个人目录为准；此前已选的开局兑换仍保留在购物车，避免刷新造成购买状态丢失。
    return [...generated, ...starterItems().filter(item => shopItemSelected(item))];
}

function loadPersonalShopState() {
    const state = store.activeSession?.personalShop || { selectedIds: [], customItems: [], catalog: null, history: [], lastRefresh: null };
    const rawIds = state.selectedIds || [];
    // Stackable 道具 quantities live in stackCounts; legacy saves may still hold
    // them in selectedIds (qty 1) — migrate them into stackCounts on load.
    selectedStackCounts = {};
    for (const id of rawIds) {
        const item = starterItems().find(entry => entry.id === id);
        if (item && isStackableShopItem(item)) selectedStackCounts[id] = Math.max(1, Number(state.stackCounts?.[id]) || 1);
    }
    Object.entries(state.stackCounts || {}).forEach(([id, qty]) => {
        const item = starterItems().find(entry => entry.id === id);
        if (item && isStackableShopItem(item) && Number(qty) > 0) selectedStackCounts[id] = Math.max(1, Math.floor(Number(qty)));
    });
    selectedStarterIds = new Set(rawIds.filter(id => {
        const item = starterItems().find(entry => entry.id === id);
        return !item || !isStackableShopItem(item);
    }));
    customStarterItems = structuredClone(state.customItems || []);
    personalShopExtraRequirement = String(state.extraRequirement || '');
}

function persistPersonalShopState() {
    const session = store.activeSession; if (!session) return;
    const state = session.personalShop || {};
    session.personalShop = { ...state, selectedIds: [...selectedStarterIds], stackCounts: structuredClone(selectedStackCounts), customItems: structuredClone(customStarterItems), history: structuredClone(state.history || []), updatedAt: new Date().toISOString() };
    store.save();
}

function partnerCost() {
    const form = $('#setupForm');
    return form.elements.partnerEnabled.checked ? ({ Ⅰ: 70, Ⅱ: 350, Ⅲ: 1000 }[form.elements.partnerTier.value] || 0) : 0;
}

function setupBalance() {
    return shopBalance() - partnerCost();
}

const STACKABLE_SHOP_CATEGORIES = new Set(['item']);
function isStackableShopItem(item) { return Boolean(item && STACKABLE_SHOP_CATEGORIES.has(item._cat)); }
function selectedStackQty(id) { return Math.max(0, Number(selectedStackCounts?.[id]) || 0); }
function shopItemSelected(item) { return isStackableShopItem(item) ? selectedStackQty(item.id) > 0 : selectedStarterIds.has(item.id); }
function shopItemCost(item) {
    if (!item) return 0;
    if (isStackableShopItem(item)) return Number(item.cost || 0) * selectedStackQty(item.id);
    return selectedStarterIds.has(item.id) ? Number(item.cost || 0) : 0;
}
function shopBalance() {
    const selectedCost = starterItems().reduce((sum, item) => sum + shopItemCost(item), 0);
    return Number(openingData?.initSpaceCoins || 1000) - selectedCost;
}

function personalShopBalance() {
    const selectedCost = personalShopItems().reduce((sum, item) => sum + shopItemCost(item), 0);
    return Number(openingData?.initSpaceCoins || 1000) - selectedCost;
}

function shopItemCard(item, { personal = false } = {}) {
    const selected = shopItemSelected(item);
    const balance = personal ? personalShopBalance() : shopBalance();
    const quality = uiQuality(item.tier, 'F');
    const properties = [item.consume && ['消耗', item.consume], item.attrs && Object.keys(item.attrs).length && ['属性', Object.entries(item.attrs).map(([key, value]) => `${key}+${value}`).join(' · ')], item.effects && Object.keys(item.effects).length && ['效果', Object.entries(item.effects).map(([key, value]) => `${key}:${plainValue(value)}`).join(' · ')]].filter(Boolean);
    const categoryLabel = { equipment: '装备', item: '道具', skill: '技能', bloodline: '血统', form: '形态', upgrade: '升级' }[item._cat] || item._cat || '兑换';
    if (isStackableShopItem(item)) {
        const cost = Number(item.cost || 0);
        const qty = selectedStackQty(item.id);
        const maxQty = cost > 0 ? Math.min(999, qty + Math.floor(balance / cost)) : 999;
        const disabledStart = !selected && cost > balance;
        const stepper = `<div class="shop-qty-stepper"><button type="button" data-shop-qty-dec data-starter-id="${escapeHtml(item.id)}" aria-label="减少数量" ${qty === 0 ? 'disabled' : ''}>−</button><input type="number" data-shop-qty-input data-starter-id="${escapeHtml(item.id)}" min="0" max="${maxQty}" value="${qty}" inputmode="numeric" aria-label="购买数量"><button type="button" data-shop-qty-inc data-starter-id="${escapeHtml(item.id)}" aria-label="增加数量" ${disabledStart ? 'disabled' : ''}>＋</button></div>`;
        return `<div class="setup-shop-item item-card q-${quality} ${selected ? 'selected is-selected' : ''} ${disabledStart ? 'is-disabled' : ''}" data-starter-id="${escapeHtml(item.id)}"><span class="selected-corner">已选择 ×${qty}</span><header class="card-header"><h4 class="item-name">${escapeHtml(item.name)}</h4><span class="item-rarity q-${quality}">${escapeHtml(quality)}</span></header><div class="card-body"><p>${escapeHtml(item.desc || '暂无描述')}</p>${properties.map(([label, value]) => `<div class="item-info"><b>${label}</b><span>${escapeHtml(value)}</span></div>`).join('')}<div class="tag-list">${(item.tags || []).slice(0, 6).map(tag => `<i>${escapeHtml(tag)}</i>`).join('')}</div></div><footer><span>${categoryLabel}</span>${stepper}<b>¤ ${(cost * qty).toLocaleString()}</b></footer></div>`;
    }
    const disabled = !selected && Number(item.cost || 0) > balance;
    return `<button type="button" class="setup-shop-item item-card q-${quality} ${selected ? 'selected is-selected' : ''} ${disabled ? 'is-disabled' : ''}" data-starter-id="${escapeHtml(item.id)}" ${disabled ? 'disabled' : ''}><span class="selected-corner">已选择</span><header class="card-header"><h4 class="item-name">${escapeHtml(item.name)}</h4><span class="item-rarity q-${quality}">${escapeHtml(quality)}</span></header><div class="card-body"><p>${escapeHtml(item.desc || '暂无描述')}</p>${properties.map(([label, value]) => `<div class="item-info"><b>${label}</b><span>${escapeHtml(value)}</span></div>`).join('')}<div class="tag-list">${(item.tags || []).slice(0, 6).map(tag => `<i>${escapeHtml(tag)}</i>`).join('')}</div></div><footer><span>${categoryLabel}</span><b>¤ ${Number(item.cost).toLocaleString()}</b></footer></button>`;
}

function renderSetupShop() {
    if (!openingData) { $('#setupShopItems').innerHTML = '<div class="empty-state">开局数据库加载中…</div>'; return; }
    const query = $('#setupShopSearch').value.trim().toLowerCase();
    const category = setupShopCategory;
    const rarity = setupShopRarity;
    const items = starterItems().filter(item => (category === 'all' || item._cat === category) && (rarity === 'all' || item.tier === rarity) && (!query || [item.name, item.desc, ...(item.tags || [])].join(' ').toLowerCase().includes(query)));
    $('#setupShopItems').innerHTML = items.map(item => shopItemCard(item)).join('') || '<div class="empty-state">没有匹配的兑换项</div>';
    const chosen = starterItems().filter(item => shopItemSelected(item));
    $('#setupCoins').textContent = setupBalance().toLocaleString();
    $('#setupCoins').classList.toggle('negative', setupBalance() < 0);
    const chipLabel = item => isStackableShopItem(item) && selectedStackQty(item.id) > 1 ? `${item.name} ×${selectedStackQty(item.id)}` : item.name;
    $('#setupCart').innerHTML = `<div><b>已选兑换 <i>${chosen.length}</i></b><small>总计消耗 ${(Number(openingData?.initSpaceCoins || 1000) - shopBalance()).toLocaleString()} 空间币</small></div><div class="setup-cart-chips">${chosen.map(item => `<button type="button" data-starter-id="${escapeHtml(item.id)}">${escapeHtml(chipLabel(item))} <b>×</b></button>`).join('') || '<span>尚未选择兑换项</span>'}</div>`;
    renderPartnerState();
}

function renderPersonalShop() {
    const root = $('#personalShopContent'); if (!root) return;
    if (!openingData) { root.innerHTML = '<div class="empty-state">个人商城数据库加载中…</div>'; return; }
    const items = personalShopItems().filter(item => (personalShopCategory === 'all' || item._cat === personalShopCategory) && (personalShopRarity === 'all' || item.tier === personalShopRarity) && (!personalShopSearch || [item.name, item.desc, ...(item.tags || [])].join(' ').toLowerCase().includes(personalShopSearch)));
    const chosen = personalShopItems().filter(item => shopItemSelected(item));
    const state = store.activeSession?.personalShop || {};
    const last = state.lastRefresh;
    const hero = runtime.variables.stat_data?.主角 || {};
    const stat = runtime.variables.stat_data ?? {};
    const inGodSpace = stat['系统状态']?.['是否在主神空间'] === true;
    const shopContext = inGodSpace ? {
        tone: 'state-space', label: '主神空间终端', description: '主神空间／休整期：可按个人存档与商城规则刷新。', action: '让大模型生成个人商城', note: '模型将结合生命层级、库存和额外要求自主选择目标',
    } : {
        tone: 'state-world', label: '任务世界中', description: '当前不在主神空间：仍允许自由刷新，结果与叙事后果将由当前世界和原卡规则裁定。', action: '仍要在任务世界刷新商城', note: '不会阻止点击；模型与正文会依据当前 MVU 世界状态处理这次请求',
    };
    const level = heroLifeLevel(hero);
    const activeConnection = aiConnection('shop');
    const elapsed = personalShopRefreshBusy ? `${Math.max(0, (Date.now() - personalShopRefreshStartedAt) / 1000).toFixed(1)} 秒` : '';
    const status = personalShopRefreshBusy ? `${personalShopRefreshStatus || '正在等待模型响应'} · 已用时 ${elapsed} · 再点一次取消` : (last ? `上次完成：${escapeHtml(last.source || 'local')} · ${escapeHtml(formatTime(last.generatedAt || last.at || Date.now()))} · 用时 ${last.elapsedMs ? `${(last.elapsedMs / 1000).toFixed(1)} 秒` : '—'} · seed ${escapeHtml(last.seed || '—')}` : '尚未刷新；目标、槽位和数量由当前大模型自行决定');
    root.innerHTML = `<section class="personal-shop-wallet"><div><small>PERSONAL WALLET</small><b>¤ ${personalShopBalance().toLocaleString()}</b></div><span>${escapeHtml(hero.姓名 || store.data.settings.userName || '当前人物')} · 独立终端</span></section><section class="personal-shop-refresh"><header><div><small>AI SHOP TERMINAL · forge_shop</small><b>大模型自主决定本次商品目标</b></div><span>${escapeHtml(activeConnection?.model || '未选择 API')}</span></header><div class="shop-context ${shopContext.tone}"><b>${escapeHtml(shopContext.label)}</b><span>${escapeHtml(shopContext.description)}</span><em>MVU 实时状态 · 不限制玩家点击</em></div><div class="shop-refresh-grid shop-refresh-readonly"><div><small>生命层级 · MVU</small><b>${escapeHtml(`生命层级 · ${lifeLevelRoman(level)}`)}</b><em>读取 stat_data.主角.层级</em></div><label class="wide">额外要求（可选）<input id="personalShopQuery" value="${escapeHtml(personalShopExtraRequirement)}" placeholder="例如：偏向火焰、适合近战、避免重复商品"></label></div><button type="button" class="ai-refresh-button ${shopContext.tone} ${personalShopRefreshBusy ? 'is-busy' : ''}" data-action="refresh-personal-shop" title="${escapeHtml(shopContext.description)}"><span class="ai-refresh-icon">✦</span><span><b>${personalShopRefreshBusy ? '取消本次商城刷新' : shopContext.action}</b><small>${personalShopRefreshBusy ? '再次点击立即取消 · 不写入半成品' : shopContext.note}</small></span><i>${personalShopRefreshBusy ? 'CANCEL' : inGodSpace ? 'GENERATE' : 'OVERRIDE'}</i></button><small class="shop-refresh-status ${personalShopRefreshBusy ? 'is-running' : ''}">${status}</small></section><section class="personal-shop-layout"><aside><input data-personal-shop-search value="${escapeHtml(personalShopSearch)}" placeholder="搜索兑换项"><div>${[['all','全部分类'],['equipment','装备'],['item','道具'],['skill','技能'],['bloodline','血统'],['form','形态'],['upgrade','升级']].map(([key,label]) => `<button data-personal-shop-category="${key}" class="${personalShopCategory === key ? 'active' : ''}">${label}</button>`).join('')}</div></aside><main><div class="personal-rarity-filter">${['all','F','E','D','C','B','A','S','SS','SSS'].map(key => `<button data-personal-shop-rarity="${key}" class="${personalShopRarity === key ? 'active' : ''}">${key === 'all' ? '全部品质' : key}</button>`).join('')}</div><div class="setup-shop-grid">${items.map(item => shopItemCard(item, { personal: true })).join('') || '<div class="empty-state">没有匹配的兑换项</div>'}</div></main></section><section class="selected-panel personal-shop-cart"><header><div><b>当前人物购物车</b><small>选择状态随人物存档持久化</small></div><span>${chosen.length}</span></header><div>${chosen.map(item => `<button data-starter-id="${escapeHtml(item.id)}">${escapeHtml(isStackableShopItem(item) && selectedStackQty(item.id) > 1 ? `${item.name} ×${selectedStackQty(item.id)}` : item.name)} · ¤${(isStackableShopItem(item) ? Number(item.cost) * selectedStackQty(item.id) : Number(item.cost)).toLocaleString()} ×</button>`).join('') || '<p>尚未选择兑换项</p>'}</div></section>`;
}

async function refreshPersonalShop() {
    const session = store.activeSession;
    if (!session) return;
    if (personalShopRefreshBusy) {
        personalShopRefreshAbort?.abort(new DOMException('用户取消商城刷新', 'AbortError'));
        personalShopRefreshStatus = '正在取消请求';
        renderPersonalShop();
        return;
    }
    const query = String($('#personalShopQuery')?.value || personalShopExtraRequirement || '').trim().slice(0, 500);
    personalShopExtraRequirement = query;
    personalShopRefreshBusy = true;
    personalShopRefreshStartedAt = Date.now();
    personalShopRefreshStatus = '正在请求大模型决定刷新目标';
    personalShopRefreshAbort = new AbortController();
    clearInterval(personalShopRefreshTimer);
    personalShopRefreshTimer = setInterval(() => { if (personalShopRefreshBusy) renderPersonalShop(); }, 500);
    renderPersonalShop();
    const hero = runtime.variables.stat_data?.主角 || {};
    const playerLevel = heroLifeLevel(hero);
    const connection = aiConnection('shop');
    const payload = { characterName: hero.姓名 || store.data.settings.userName || '轮回者', playerLevel, playerLifeLevel: lifeLevelRoman(playerLevel), target: { autonomous: true, categories: ['all'], query }, seed: crypto.randomUUID(), hero, currentCatalog: session.personalShop?.catalog || {}, connection, tavernShopSystem: runtime.buildTavernShopSystem(), promptModules: promptModuleStates('shop') };
    const connectionMeta = { id: connection.id, name: connection.name, model: connection.model, protocol: connection.protocol };
    const shopAiProcessId = beginAiProcess('商店 AI', 'forge_shop · 等待首包', () => personalShopRefreshAbort?.abort(new DOMException('用户已取消商城刷新', 'AbortError')));
    await blackbox.record('shop', 'shop_refresh_started', { target: 'model-decided', extraRequirement: query, playerLevel, connection: connectionMeta }, { sessionId: session.id });
    try {
        const response = await fetch('/api/shop/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, promptOverride: promptOverride('shop').enabled ? promptOverride('shop').text : '' }), signal: personalShopRefreshAbort.signal });
        updateAiProcess(shopAiProcessId, '接收模型响应');
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error || `刷新失败（${response.status}）`);
        personalShopRefreshStatus = '已收到模型结果，正在写入独立终端';
        const elapsedMs = Date.now() - personalShopRefreshStartedAt;
        session.personalShop = { ...(session.personalShop || {}), extraRequirement: query, catalog: body.catalog, lastRefresh: { refreshId: body.refreshId, source: body.source, seed: body.seed, generatedAt: body.generatedAt, target: body.target, playerLevel: body.playerLevel, elapsedMs }, history: [...(session.personalShop?.history || []), { refreshId: body.refreshId, source: body.source, seed: body.seed, generatedAt: body.generatedAt, target: body.target, playerLevel: body.playerLevel, elapsedMs }].slice(-30) };
        store.save();
        await blackbox.record('shop', 'shop_refresh_completed', { refreshId: body.refreshId, source: body.source, warnings: body.warnings, apiTrace: body.apiTrace, catalogCounts: Object.fromEntries(Object.entries(body.catalog || {}).filter(([key]) => key.endsWith('列表')).map(([key, list]) => [key, list.length])) }, { sessionId: session.id });
        toast(body.source === 'api' ? '大模型已完成个人商城刷新' : '已使用本地规则完成商城兜底刷新', body.source === 'api' ? 'success' : 'info');
        if (body.warnings?.length) toast(body.warnings[0], 'info');
    } catch (error) {
        if (error.name === 'AbortError') {
            await blackbox.record('shop', 'shop_refresh_cancelled', { target: 'model-decided', elapsedMs: Date.now() - personalShopRefreshStartedAt }, { sessionId: session.id });
            toast('已取消商城刷新，未写入半成品', 'info');
        } else {
            await blackbox.record('shop', 'shop_refresh_failed', { error: error.message, target: payload.target, connection: connectionMeta }, { sessionId: session.id });
            toast(`商城刷新失败：${error.message}`, 'error');
        }
    } finally {
        endAiProcess(shopAiProcessId);
        personalShopRefreshBusy = false;
        personalShopRefreshAbort = null;
        clearInterval(personalShopRefreshTimer);
        personalShopRefreshTimer = null;
        personalShopRefreshStatus = '';
        renderPersonalShop();
    }
}

// 酒馆助手/卡内脚本可直接调用的 forge_shop 兼容入口。它不依赖页面焦点，结果仍只写入当前人物的独立商店存档。
async function forgePersonalShop(args = {}) {
    const session = store.activeSession;
    if (!session) throw new Error('当前没有活动存档');
    const hero = runtime.variables.stat_data?.主角 || {};
    const connection = aiConnection('shop');
    const playerLevel = heroLifeLevel(hero);
    const payload = {
        characterName: hero.姓名 || store.data.settings.userName || '轮回者', playerLevel, playerLifeLevel: lifeLevelRoman(playerLevel),
        target: { autonomous: true, categories: ['all'], query: String(args.要求 ?? args.query ?? '').slice(0, 500) },
        seed: args.seed || crypto.randomUUID(), hero, currentCatalog: session.personalShop?.catalog || {}, connection,
        tavernShopSystem: runtime.buildTavernShopSystem(), promptModules: promptModuleStates('shop'),
    };
    const forgeController = new AbortController();
    const processId = beginAiProcess('商店 AI', 'forge_shop · 等待首包', () => forgeController.abort(new DOMException('用户已取消 forge_shop', 'AbortError')));
    try {
        const response = await fetch('/api/shop/forge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...payload, promptOverride: promptOverride('shop').enabled ? promptOverride('shop').text : '' }), signal: forgeController.signal });
        updateAiProcess(processId, '接收模型响应');
        const body = await response.json();
        if (!response.ok || !body.ok) throw new Error(body.error || `forge_shop 失败（${response.status}）`);
        session.personalShop = { ...(session.personalShop || {}), catalog: body.catalog, lastRefresh: { refreshId: body.refreshId, source: body.source, seed: body.seed, generatedAt: body.generatedAt, target: body.target, playerLevel: body.playerLevel }, history: [...(session.personalShop?.history || []), { refreshId: body.refreshId, source: body.source, seed: body.seed, generatedAt: body.generatedAt, target: body.target, playerLevel: body.playerLevel }].slice(-30) };
        store.save();
        renderPersonalShop();
        await blackbox.record('shop', 'shop_forge_called', { refreshId: body.refreshId, source: body.source, target: body.target, playerLevel: body.playerLevel, apiTrace: body.apiTrace }, { sessionId: session.id });
        return body;
    } finally {
        endAiProcess(processId);
    }
}

function renderSetupPlots() {
    if (!openingData) return;
    $('#setupPlots').innerHTML = (openingData.plots || []).map(plot => `<button type="button" class="setup-plot ${selectedPlotId === plot.id ? 'selected' : ''}" data-plot-id="${escapeHtml(plot.id)}"><b>${escapeHtml(plot.name)}</b><span>位格 ${escapeHtml(plot.rank || 'Ⅰ')} · 难度 ${escapeHtml(plot.tier || 'F~E')}</span><small>${escapeHtml(plot.time || '')}</small></button>`).join('');
}

function renderPartnerState() {
    const form = $('#setupForm'); if (!form) return;
    const enabled = form.elements.partnerEnabled.checked;
    const cost = partnerCost(); const balance = setupBalance();
    $('#partnerCostState').textContent = enabled ? `消耗 ${cost} · 余额 ${balance}` : '未创建';
    $$('[name^="partner"]', form).filter(input => input.name !== 'partnerEnabled').forEach(input => { input.disabled = !enabled; });
}

function collectProfileState() {
    const form = $('#setupForm'); const values = Object.fromEntries(new FormData(form));
    return { version: 1, values, attributes: structuredClone(attributePoints), starterIds: [...selectedStarterIds], stackCounts: structuredClone(selectedStackCounts), customStarterItems: structuredClone(customStarterItems), selectedPlotId, savedAt: new Date().toISOString() };
}

function applyProfileState(state) {
    const form = $('#setupForm');
    for (const [key, value] of Object.entries(state.values || {})) {
        const field = form.elements[key]; if (!field) continue;
        if (field instanceof RadioNodeList) { const target = [...field].find(item => item.value === value); if (target) target.checked = true; }
        else if (field.type === 'checkbox') field.checked = value === 'on' || value === true;
        else field.value = value ?? '';
    }
    attributePoints = Object.fromEntries(attributeKeys.map(key => [key, Number(state.attributes?.[key] || 0)]));
    customStarterItems = structuredClone(state.customStarterItems || []);
    selectedStackCounts = {};
    for (const id of state.starterIds || []) {
        const item = starterItems().find(entry => entry.id === id);
        if (item && isStackableShopItem(item)) selectedStackCounts[id] = Math.max(1, Number(state.stackCounts?.[id]) || 1);
    }
    Object.entries(state.stackCounts || {}).forEach(([id, qty]) => {
        const item = starterItems().find(entry => entry.id === id);
        if (item && isStackableShopItem(item) && Number(qty) > 0) selectedStackCounts[id] = Math.max(1, Math.floor(Number(qty)));
    });
    selectedStarterIds = new Set((state.starterIds || []).filter(id => {
        const item = starterItems().find(entry => entry.id === id);
        return !item || !isStackableShopItem(item);
    }));
    selectedPlotId = state.selectedPlotId || null;
    persistPersonalShopState();
    renderAttributeBuilder(); renderSetupShop(); renderSetupPlots(); renderPartnerState(); renderSetupSummary();
}

function renderProfiles() {
    $('#profileList').innerHTML = profiles.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).map(profile => `<div class="profile-card"><div><b>${escapeHtml(profile.name)}</b><small>${escapeHtml(profile.state?.values?.name || '未命名')} · ${escapeHtml(profile.state?.values?.faction || '')} · ${new Date(profile.updatedAt).toLocaleString()}</small></div><div><button type="button" data-profile-action="load" data-profile-id="${profile.id}">加载</button><button type="button" data-profile-action="export" data-profile-id="${profile.id}">导出</button><button type="button" class="danger" data-profile-action="delete" data-profile-id="${profile.id}">删除</button></div></div>`).join('') || '<div class="empty-state">还没有保存的人物档案</div>';
}

function renderSetupSummary() {
    const values = Object.fromEntries(new FormData($('#setupForm')));
    const chosen = starterItems().filter(item => shopItemSelected(item));
    const plot = openingData?.plots?.find(item => item.id === selectedPlotId);
    const chosenLabel = chosen.map(item => isStackableShopItem(item) && selectedStackQty(item.id) > 1 ? `${item.name} ×${selectedStackQty(item.id)}` : item.name).join('、') || '无';
    $('#setupSummary').innerHTML = `<div><small>轮回者</small><b>${escapeHtml(values.name || '未命名')} · ${escapeHtml(values.race || '人类')} · ${escapeHtml(values.faction || '')}</b></div><div><small>五维潜质</small><b>${attributeKeys.map(key => `${key}${qualityLevels[attributePoints[key]]}`).join(' · ')}</b></div><div><small>初始兑换</small><b>${escapeHtml(chosenLabel)}（余额 ${setupBalance()}）</b></div><div><small>降临</small><b>${escapeHtml(values.mode === '候选世界' ? plot?.name || '未选择' : values.mode === '单一世界' ? values.targetWorld || '未填写' : '主神空间')}</b></div><div><small>队友</small><b>${values.partnerEnabled === 'on' ? `${escapeHtml(values.partnerName || '未命名')} · ${escapeHtml(values.partnerTier)}级` : '无'}</b></div>`;
    renderProfiles();
}

function showSetupStep(next) {
    setupStep = Math.max(0, Math.min(4, next));
    $$('.setup-step').forEach((node, index) => node.classList.toggle('active', index === setupStep));
    $$('.setup-progress i').forEach((node, index) => node.classList.toggle('active', index <= setupStep));
    $('#setupStepLabel').textContent = `${setupStep + 1} / 5 · ${['信息 / 属性', '初始折扣兑换', '世界 / 降临', '队友创建', '档案确认'][setupStep]}`;
    $('#setupPrev').disabled = setupStep === 0;
    $('#setupNext').classList.toggle('hidden', setupStep === 4);
    $('#setupSubmit').classList.toggle('hidden', setupStep !== 4);
    if (setupStep === 4) renderSetupSummary();
}

async function openSetup() {
    const player = runtime.variables.stat_data?.['主角'] ?? {};
    const form = $('#setupForm');
    form.elements.name.value = store.data.settings.userName || '';
    form.elements.race.value = player['种族'] || '人类';
    setupStep = 0;
    const initialBloodline = Object.values(player['血统'] || {}).find(item => item?.标签?.includes('初始血统'));
    attributePoints = Object.fromEntries(attributeKeys.map(key => [key, Math.max(0, qualityLevels.indexOf(initialBloodline?.原始属性?.[key] || 'F'))]));
    loadPersonalShopState(); selectedPlotId = null;
    renderAttributeBuilder(); renderSetupShop(); renderSetupPlots(); renderPartnerState(); showSetupStep(0); $('#setupDialog').showModal();
}

async function submitSetup(event) {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    const variables = structuredClone(runtime.variables);
    const stat = variables.stat_data;
    stat['主角']['种族'] = values.race;
    stat['主角']['身份'] = [values.faction, `${values.age}岁`, values.gender];
    const bloodlineName = `${values.race || '人类'}血统`;
    stat['主角']['血统'] = { [bloodlineName]: { 品质: 'F', 标签: ['初始血统', values.race || '人类'], 原始属性: Object.fromEntries(attributeKeys.map(key => [key, qualityLevels[attributePoints[key]]])), 效果: {}, 描述: '最初的基础，却有无限可能' } };
    const chosen = starterItems().filter(item => shopItemSelected(item));
    stat['主角']['装备'] = {}; stat['主角']['道具'] = {}; stat['主角']['技能'] = {};
    for (const item of chosen) {
        if (item._cat === 'equipment') {
            const exportType = item.type <= 9 ? 0 : item.type - 9;
            stat['主角']['装备'][item.name] = { 品质: item.tier, 类型: exportType, 标签: [...(item.tags || []), ...(item.source ? [item.source] : [])], 原始属性: item.attrs || {}, 效果: item.effects || {}, 描述: item.desc || '', 消耗: item.consume || '', 状态: 0 };
        } else if (item._cat === 'item') stat['主角']['道具'][item.name] = { 品质: item.tier, 类型: item.type, 数量: Math.max(1, selectedStackQty(item.id)), 标签: [...(item.tags || []), ...(item.source ? [item.source] : [])], 效果: item.effects || {}, 描述: item.desc || '' };
        else stat['主角']['技能'][item.name] = { 品质: item.tier, 类型: item.type, 标签: [...(item.tags || []), ...(item.source ? [item.source] : [])], 效果: item.effects || {}, 描述: item.desc || '', 消耗: item.consume || '' };
    }
    stat['主角']['空间币'] = setupBalance();
    stat['设置']['单一世界'] = values.mode === '单一世界';
    stat['设置']['世界超稳'] = values.worldLock === 'on';
    const plot = openingData?.plots?.find(item => item.id === selectedPlotId);
    if (values.mode === '候选世界' && plot) {
        stat['世界']['名称'] = plot.name.match(/【(.*?)】/)?.[1] || plot.name; stat['世界']['时间'] = plot.time || ''; stat['世界']['位格'] = plot.rank || 'Ⅰ'; stat['世界']['难度'] = String(plot.tier || 'F~E').replace(/[-–—]/g, '~');
        stat['世界']['异端雷达'] = { 当前模式: plot.ecology || plot.eco || '', 异端上限: Number(plot.aliens || 0), 活跃余量: Number(plot.aliens || 0) }; stat['系统状态']['是否在主神空间'] = false;
    } else if (values.mode === '单一世界' && values.targetWorld) {
        stat['世界']['名称'] = values.targetWorld;
        stat['世界']['时间'] = values.worldTime || ''; stat['世界']['因果轨道'] = { 当前阶段: values.worldState || '未设定', 故事线: '', 下一节点: '', 偏移记录: {} };
        stat['系统状态']['是否在主神空间'] = false;
    } else stat['系统状态']['是否在主神空间'] = true;
    stat['关系列表'] = stat['关系列表'] || {};
    if (values.partnerEnabled === 'on') {
        if (!values.partnerName?.trim()) return toast('启用队友后必须填写队友姓名', 'error');
        stat['关系列表'][values.partnerName.trim()] = { 在场: true, 种族: values.partnerRace || '人类', 身份: [values.faction, values.partnerGender], 职业: {}, 层级: values.partnerTier, HP: 20, HP_MAX: 20, THP: 0, EP: 0, EP_MAX: 0, 状态: {}, 最终属性: {}, 血统: {}, 装备: {}, 技能: {}, 道具: {}, 形态库: {}, 当前形态: { 激活: false, 名称: '' }, 性格: '', 喜爱: values.partnerLikes || '', 外貌: values.partnerAppearance || '', 着装: '', 是否队友: true, 好感度: 0, 好感度关系: {}, 心里话: '', 背景故事: values.partnerBackground || '' };
    }
    await runtime.replaceVariables(variables);
    const committed = runtime.variables.stat_data;
    if (!committed?.主角?.血统?.[bloodlineName] || committed.主角.空间币 !== setupBalance()) throw new Error('MVU 建档提交校验失败，变量未正确落盘');
    $('#setupDialog').close();
    const worldText = values.mode === '候选世界' && plot ? `【${plot.name}】\n[时间锚点]：${plot.time}\n[主线状态]：${plot.deviation}\n[切入身份]：${plot.identity}\n[主神任务]：${plot.identityMissions?.[values.faction] || ''}` : values.mode === '单一世界' ? `【${values.targetWorld}】\n[时间锚点]：${values.worldTime}\n[主线状态]：${values.worldState}\n[切入身份]：${values.worldIdentity}\n[主神任务]：${values.worldGoal}` : '当前处于主神空间待机状态，未锚定具体世界。';
    const partnerText = values.partnerEnabled === 'on' ? `专属伙伴：${values.partnerName}，${values.partnerRace}，${values.partnerTier}级。请按 NPC 生成规则补全其血统、技能和 1~2 件初始装备，但不得替换已写入的基础档案。` : '无协同实体。';
    const prompt = `【轮回者建档完成】\n系统已将初始装备、道具、技能、血统、空间币和伙伴精准写入 stat_data，禁止替换或重复发放。\n\n【角色信息】\n姓名：${values.name}\n性别：${values.gender}\n年龄：${values.age}岁\n种族：${values.race}\n身份：${values.faction}\n初始血统：${bloodlineName}（F级；${attributeKeys.map(key => `${key}${qualityLevels[attributePoints[key]]}`).join('、')}）\n\n【初始兑换】\n${chosen.map(item => `${item.name}(${item.tier})`).join('、') || '无'}\n剩余空间币：${setupBalance()}\n\n【协同实体】\n${partnerText}\n\n【世界与降临信息】\n${worldText}\n\n进行开局初始化并展开沉浸式场景。根据种族为初始血统设计 1~2 个符合 F 级限制的效果；已写入字段只可补全，不可清空。必须在末尾输出合法 <UpdateVariable><JSONPatch>，Patch 路径相对于 stat_data。`;
    showPanel('chat');
    $('#messageInput').value = prompt;
    $('#messageInput').dispatchEvent(new Event('input'));
    renderAll();
    await blackbox.record('setup', 'character_profile_committed', { profile: collectProfileState(), statData: committed }, { sessionId: store.activeSession?.id });
    toast('完整人物档案已写入 MVU，确认后即可执行开局。', 'success');
}

function bindEvents() {
    document.addEventListener('change', event => {
        const input = event.target.closest('[data-shop-qty-input]');
        if (!input) return;
        const personal = Boolean(input.closest('#view-shop'));
        const id = input.dataset.starterId;
        const item = (personal ? personalShopItems() : starterItems()).find(entry => entry.id === id);
        if (!item || !isStackableShopItem(item)) return;
        const cost = Number(item.cost || 0);
        const current = selectedStackQty(id);
        const balance = personal ? personalShopBalance() : shopBalance();
        const raw = Number(input.value);
        const next = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
        if (cost * (next - current) > balance + 1e-9) {
            toast('数量超出空间币预算', 'error');
            input.value = current;
            return;
        }
        if (next === 0) delete selectedStackCounts[id]; else selectedStackCounts[id] = next;
        persistPersonalShopState(); renderSetupShop(); renderPersonalShop();
    });
    $('#composer').addEventListener('submit', event => {
        event.preventDefault();
        const input = $('#messageInput');
        const text = input.value;
        input.value = '';
        input.style.height = '';
        generate({ text });
    });
    $('#messageInput').addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            $('#composer').requestSubmit();
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape' || (!combatMapIntent && !combatMapMenu)) return;
        const cancelled = combatMapIntent ? { ...combatMapIntent } : { type: 'menu' };
        combatMapIntent = null;
        combatMapMenu = null;
        recordCombatDebug('map_action_cancelled_escape', { actorId: combatState?.activeUnitId || null, intent: cancelled });
        renderCombat();
    });
    document.addEventListener('toggle', event => {
        if (event.target?.id === 'combatSimulatorFold') {
            const label = $('#combatSimulatorFoldState');
            if (label) label.textContent = event.target.open ? '点击折叠' : '点击展开';
        }
    }, true);
    $('#messageInput').addEventListener('input', event => {
        event.target.style.height = 'auto';
        event.target.style.height = `${Math.min(160, event.target.scrollHeight)}px`;
    });
    document.addEventListener('click', async event => {
        const inventoryTabButton = event.target.closest('[data-inventory-tab]');
        if (inventoryTabButton) {
            inventoryTab = inventoryTabButton.dataset.inventoryTab;
            renderInventory();
            await blackbox.record('inventory', 'tab_opened', { tab: inventoryTab }, { sessionId: store.activeSession?.id });
            return;
        }
        const inventoryAction = event.target.closest('[data-inventory-action]');
        if (inventoryAction) {
            try {
                await changeInventoryStatus({
                    action: inventoryAction.dataset.inventoryAction,
                    kind: inventoryAction.dataset.inventoryKind,
                    name: inventoryAction.dataset.inventoryName,
                });
            } catch (error) {
                await blackbox.record('inventory', 'item_status_change_failed', { action: inventoryAction.dataset.inventoryAction, kind: inventoryAction.dataset.inventoryKind, name: inventoryAction.dataset.inventoryName, error }, { sessionId: store.activeSession?.id });
                toast(`物品操作失败：${error.message}`, 'error');
            }
            return;
        }
        const settingsTab = event.target.closest('[data-settings-tab]')?.dataset.settingsTab;
        if (settingsTab) {
            $$('.settings-tabs [data-settings-tab]').forEach(button => button.classList.toggle('active', button.dataset.settingsTab === settingsTab));
            $$('[data-settings-panel]').forEach(panel => panel.classList.toggle('active', panel.dataset.settingsPanel === settingsTab));
            blackbox.record('ui', 'settings_tab_opened', { tab: settingsTab }, { sessionId: store.activeSession?.id });
            if (settingsTab === 'blackbox') renderBlackBox();
            if (settingsTab === 'model-routing') renderModelRoutingManager();
            if (settingsTab === 'prompt-lab') await renderPromptLab();
            return;
        }
        const connectionItem = event.target.closest('[data-connection-id]');
        if (connectionItem) {
            store.selectConnection(connectionItem.dataset.connectionId);
            editConnection(store.data.connections.find(item => item.id === connectionItem.dataset.connectionId));
            renderConnectionManager();
            renderModelRoutingManager();
            return;
        }
        const userProfileItem = event.target.closest('[data-user-profile-id]');
        if (userProfileItem) {
            selectedUserProfileId = userProfileItem.dataset.userProfileId;
            renderUserProfileManager();
            return;
        }
        const presetItem = event.target.closest('[data-preset-id]');
        if (presetItem) { selectedPresetId = presetItem.dataset.presetId; selectedPromptEntryId = null; renderPresetManager(); return; }
        const promptEntry = event.target.closest('[data-prompt-id]');
        if (promptEntry && !event.target.matches('[data-prompt-toggle]')) { selectedPromptEntryId = promptEntry.dataset.promptId; renderPresetManager(); return; }
        const scriptItem = event.target.closest('[data-script-id]');
        if (scriptItem) { selectedScriptId = scriptItem.dataset.scriptId; renderScriptManager(); return; }
        const worldbookItem = event.target.closest('[data-worldbook-id]');
        if (worldbookItem) { selectedWorldbookId = Number(worldbookItem.dataset.worldbookId); renderWorldbookManager(); return; }
        const regexItem = event.target.closest('[data-regex-preset-id]');
        if (regexItem) { selectedRegexPresetId = regexItem.dataset.regexPresetId; selectedRegexEntryId = null; renderRegexManager(); return; }
        const regexEntry = event.target.closest('[data-regex-entry-id]');
        if (regexEntry && !event.target.matches('[data-regex-toggle]')) { selectedRegexEntryId = regexEntry.dataset.regexEntryId; renderRegexManager(); return; }
        const modelOption = event.target.closest('[data-model-option]');
        if (modelOption) {
            $('#connectionForm').elements.model.value = modelOption.dataset.modelOption;
            $('#connectionModelOptions').classList.remove('open');
            return;
        }
        const qtyControl = event.target.closest('[data-shop-qty-dec],[data-shop-qty-inc]');
        if (qtyControl) {
            const personal = Boolean(event.target.closest('#view-shop'));
            const id = qtyControl.dataset.starterId;
            const item = (personal ? personalShopItems() : starterItems()).find(entry => entry.id === id);
            if (item && isStackableShopItem(item)) {
                const cost = Number(item.cost || 0);
                const current = selectedStackQty(id);
                const balance = personal ? personalShopBalance() : shopBalance();
                if (qtyControl.matches('[data-shop-qty-dec]')) {
                    const next = Math.max(0, current - 1);
                    if (next === 0) delete selectedStackCounts[id]; else selectedStackCounts[id] = next;
                } else {
                    if (cost > balance) return toast('剩余空间币不足', 'error');
                    selectedStackCounts[id] = current + 1;
                }
                persistPersonalShopState(); renderSetupShop(); renderPersonalShop(); return;
            }
        }
        const starter = event.target.closest('[data-starter-id]');
        if (starter && !event.target.closest('[data-shop-qty-input]')) {
            const personal = Boolean(starter.closest('#view-shop'));
            const id = starter.dataset.starterId; const item = (personal ? personalShopItems() : starterItems()).find(entry => entry.id === id);
            if (isStackableShopItem(item)) {
                if (selectedStackQty(id) > 0) { delete selectedStackCounts[id]; }
                else if (Number(item.cost || 0) <= (personal ? personalShopBalance() : shopBalance())) selectedStackCounts[id] = 1;
                else return toast('剩余空间币不足', 'error');
            } else if (selectedStarterIds.has(id)) selectedStarterIds.delete(id);
            else if (item && (personal ? personalShopBalance() : setupBalance()) >= Number(item.cost || 0)) selectedStarterIds.add(id);
            else return toast('剩余空间币不足', 'error');
            persistPersonalShopState(); renderSetupShop(); renderPersonalShop(); return;
        }
        const setupCategory = event.target.closest('[data-setup-shop-category]');
        if (setupCategory) { setupShopCategory = setupCategory.dataset.setupShopCategory; $$('[data-setup-shop-category]').forEach(button => button.classList.toggle('active', button === setupCategory)); renderSetupShop(); return; }
        const setupRarity = event.target.closest('[data-setup-shop-rarity]');
        if (setupRarity) { setupShopRarity = setupRarity.dataset.setupShopRarity; $$('[data-setup-shop-rarity]').forEach(button => button.classList.toggle('active', button === setupRarity)); renderSetupShop(); return; }
        const personalCategory = event.target.closest('[data-personal-shop-category]');
        if (personalCategory) { personalShopCategory = personalCategory.dataset.personalShopCategory; renderPersonalShop(); return; }
        const personalRarity = event.target.closest('[data-personal-shop-rarity]');
        if (personalRarity) { personalShopRarity = personalRarity.dataset.personalShopRarity; renderPersonalShop(); return; }
        const plotButton = event.target.closest('[data-plot-id]');
        if (plotButton) { selectedPlotId = plotButton.dataset.plotId; $('#setupForm').elements.mode.value = '候选世界'; renderSetupPlots(); return; }
        const profileAction = event.target.closest('[data-profile-action]');
        if (profileAction) {
            const profile = profiles.find(item => item.id === profileAction.dataset.profileId); if (!profile) return;
            if (profileAction.dataset.profileAction === 'load') { applyProfileState(profile.state); $('#profileName').value = profile.name; toast(`已加载档案：${profile.name}`, 'success'); }
            if (profileAction.dataset.profileAction === 'delete' && confirm(`删除人物档案“${profile.name}”？`)) { await library.delete('profiles', profile.id); profiles = profiles.filter(item => item.id !== profile.id); renderProfiles(); }
            if (profileAction.dataset.profileAction === 'export') { const url = URL.createObjectURL(new Blob([JSON.stringify({ format: 'reincarnation-character-profile', version: 1, profile }, null, 2)], { type: 'application/json' })); const link = document.createElement('a'); link.href = url; link.download = `${profile.name}.json`; link.click(); URL.revokeObjectURL(url); }
            return;
        }
        const panel = event.target.closest('[data-panel]')?.dataset.panel;
        if (panel) return showPanel(panel);
        const prompt = event.target.closest('[data-prompt]')?.dataset.prompt;
        if (prompt) {
            showPanel('chat');
            $('#messageInput').value = prompt;
            $('#messageInput').dispatchEvent(new Event('input'));
            $('#messageInput').focus();
            return;
        }
        const nativePrompt = event.target.closest('[data-native-prompt]')?.dataset.nativePrompt;
        if (nativePrompt) {
            showPanel('chat');
            $('#messageInput').value = nativePrompt;
            $('#messageInput').dispatchEvent(new Event('input'));
            $('#messageInput').focus();
            return;
        }
        const strategyPreset = event.target.closest('[data-combat-strategy-preset]');
        if (strategyPreset) {
            const preset = COMBAT_STRATEGY_PRESETS[strategyPreset.dataset.combatStrategyPreset];
            if (!preset) return;
            const textarea = $('#combatStrategy');
            if (textarea) {
                textarea.value = preset.text;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
            $$('.combat-strategy-preset-list button').forEach(button => button.classList.toggle('active', button === strategyPreset));
            return;
        }
        const action = event.target.closest('[data-action]')?.dataset.action;
        if (action === 'combat-flow-phase') {
            const phase = event.target.closest('[data-combat-flow-step]')?.dataset.combatFlowStep;
            if (!phase || !COMBAT_FLOW_ORDER.includes(phase)) return;
            combatFlowPhase = phase;
            renderCombat();
            document.querySelector('.combat-flow-stepper')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            return;
        }
        if (action === 'combat-view-prompt-trace') {
            try { await openCombatPromptTrace(); }
            catch (error) { toast(`读取 Prompt 追踪失败：${error.message || error}`, 'error'); }
            return;
        }
        if (event.target.closest('#combatMap')) { if (await handleCombatMapClick(event)) return; }
        if (action === 'combat-map-zoom-out' || action === 'combat-map-zoom-in' || action === 'combat-map-zoom-reset' || action === 'combat-map-zoom-200') {
            combatMapSuppressClickUntil = 0;
            if (action === 'combat-map-zoom-out') combatMapZoom = Math.max(.5, Math.round((combatMapZoom - .25) * 100) / 100);
            if (action === 'combat-map-zoom-in') combatMapZoom = Math.min(3, Math.round((combatMapZoom + .25) * 100) / 100);
            if (action === 'combat-map-zoom-reset') { combatMapZoom = 1; combatMapPan = { x: 0, y: 0 }; }
            if (action === 'combat-map-zoom-200') combatMapZoom = 2;
            drawCombatMap();
            const zoomLabel = document.querySelector('.combat-map-zoom [data-action="combat-map-zoom-reset"]');
            if (zoomLabel) zoomLabel.textContent = `${Math.round(combatMapZoom * 100)}%`;
            return;
        }
        if (action === 'combat-close-entity-inspector') { combatMapMenu = null; combatEntityInspectorUnitId = null; combatSelectedUnitId = combatState?.activeUnitId || null; renderCombat(); return; }
        if (action === 'combat-map-cancel' || action === 'combat-map-menu-cancel') {
            const cancelled = combatMapIntent ? { ...combatMapIntent } : { type: 'menu' };
            combatMapIntent = null;
            combatMapMenu = null;
            recordCombatDebug('map_action_cancelled', { actorId: combatState?.activeUnitId || null, intent: cancelled });
            renderCombat();
            return;
        }
        if (action === 'combat-map-menu-move') {
            if (!combatMapMenu || !combatState?.activeUnitId) return toast('没有可用的移动落点', 'error');
            const destination = combatMapMenu.world; const actorId = combatState.activeUnitId; combatMapMenu = null;
            try { await mutateCombat('commands', { type: 'move', actorId, x: Math.round(destination.x * 100) / 100, y: Math.round(destination.y * 100) / 100 }); }
            catch (error) { toast(`移动无效：${error.message}`, 'error'); renderCombat(); }
            return;
        }
        if (action === 'combat-map-menu-stealth') {
            const actorId = combatState?.activeUnitId;
            if (!actorId) return toast('当前没有可操作单位', 'error');
            const stealthing = combatState?.combatants?.find(unit => unit.id === actorId)?.statuses?.some(status => status?.id === 'stealth');
            combatMapMenu = null;
            try { await mutateCombat('commands', { type: stealthing ? 'unsneak' : 'sneak', actorId }); }
            catch (error) { toast(`潜行操作失败：${error.message}`, 'error'); renderCombat(); }
            return;
        }
        if (action === 'combat-map-menu-maneuver') {
            const maneuver = event.target.closest('[data-combat-maneuver]')?.dataset.combatManeuver;
            const actorId = combatState?.activeUnitId;
            if (!maneuver || !actorId) return toast('当前没有可用机动动作', 'error');
            combatMapMenu = null;
            if (maneuver === 'withdraw' || maneuver === 'lure') { combatMapIntent = { type: maneuver }; renderCombat(); return; }
            try { await mutateCombat('commands', { type: maneuver, actorId }); }
            catch (error) { toast(`机动失败：${error.message}`, 'error'); renderCombat(); }
            return;
        }
        if (action === 'combat-map-menu-ability') {
            const actor = combatState?.combatants?.find(unit => unit.id === combatState.activeUnitId);
            const ability = actor?.abilities?.find(item => item.id === event.target.closest('[data-combat-ability-id]')?.dataset.combatAbilityId);
            if (!ability) return toast('当前能力不可用', 'error');
            if (Array.isArray(ability.legalTargetIds) && !ability.legalTargetIds.length) return toast('当前攻击范围内没有合法目标，请先移动或取消攻击模式。', 'info');
            combatMapIntent = { type: 'ability', abilityId: ability.id, abilityName: ability.name, script: event.target.closest('[data-combat-script]')?.dataset.combatScript === 'true' }; combatMapMenu = null; renderCombat(); return;
        }
        if (action === 'combat-map-menu-move-attack') {
            if (!combatState?.activeUnitId) return toast('当前没有可操作单位', 'error');
            combatMapIntent = { type: 'move_attack', abilityId: 'basic-attack', abilityName: '移动攻击' };
            combatMapMenu = null; renderCombat(); return;
        }
        if (action === 'combat-map-menu-wait') { combatMapMenu = null; try { await mutateCombat('commands', { type: 'wait', actorId: combatState.activeUnitId }); } catch (error) { toast(`行动失败：${error.message}`, 'error'); } return; }
        const combatMove = event.target.closest('[data-combat-move]');
        if (combatMove) { try { await mutateCombat('commands', { type: 'move', actorId: combatState.activeUnitId, zoneId: combatMove.dataset.combatMove }); } catch (error) { toast(`移动失败：${error.message}`, 'error'); } return; }
        const combatReaction = event.target.closest('[data-combat-reaction]');
        if (combatReaction) { try { await mutateCombat('reactions', { choice: combatReaction.dataset.combatReaction }); } catch (error) { toast(`反应提交失败：${error.message}`, 'error'); } return; }
        const combatAbility = event.target.closest('[data-combat-ability]');
        if (combatAbility) {
            try { await mutateCombat('commands', { type: combatAbility.dataset.combatScript === 'true' ? 'script' : 'attack', actorId: combatState.activeUnitId, abilityId: combatAbility.dataset.combatAbility, targetIds: [combatAbility.dataset.combatTarget] }); }
            catch (error) { toast(`行动失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-simulator-scenario') {
            try { await createCombatSimulatorScenario(event.target.closest('[data-simulator-scenario]')?.dataset.simulatorScenario); }
            catch (error) { toast(`模拟器载入失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-exit-simulator') {
            if (!isCombatSimulation()) return;
            combatState = null; combatEvents = []; combatMapMenu = null; combatMapIntent = null; combatMapZoom = 1; combatMapPan = { x: 0, y: 0 }; combatSelectedUnitId = null; combatEntityInspectorUnitId = null; combatPromptTraceCache = null; snapCombatFlowPhase(); pendingCombatScriptReview = null; combatSimulatorPickerOpen = false; combatNarrationBusy = false; combatNarrationState = { battleId: null, phase: 'idle', detail: '' }; resetCombatRecognitionState();
            await loadCombat({ quiet: true });
            toast('已退出模拟器；主线与正式战斗记录未受到影响。', 'info');
            return;
        }
        if (action === 'combat-toggle-simulator-picker') {
            if (!isCombatSimulation()) return;
            combatSimulatorPickerOpen = !combatSimulatorPickerOpen; renderCombat();
            if (combatSimulatorPickerOpen) $('#combatSimulator')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            return;
        }
        if (action === 'combat-map-move') {
            if (!combatState?.activeUnitId) return toast('当前没有可移动的行动单位', 'error');
            combatMapIntent = { type: 'move' }; renderCombat(); return;
        }
        if (action === 'combat-map-ability') {
            const actor = combatState?.combatants?.find(unit => unit.id === combatState.activeUnitId);
            const ability = actor?.abilities?.find(item => item.id === event.target.closest('[data-combat-ability-id]')?.dataset.combatAbilityId);
            if (!ability) return toast('当前能力不可用', 'error');
            combatMapIntent = { type: 'ability', abilityId: ability.id, abilityName: ability.name, script: event.target.closest('[data-combat-script]')?.dataset.combatScript === 'true' };
            renderCombat(); return;
        }
        if (action === 'combat-open-prepared-model') { openPreparedCombatModel(); return; }
        if (action === 'combat-retry-modeling') {
            if (!pendingCombatModel?.declaration) return toast('没有可继续重试的战场声明', 'error');
            try {
                // Continue the five-attempt protocol from the accumulated
                // repair history so the model sees every previous rejection
                // instead of restarting from a blank slate.
                await modelBattleFromDeclaration(pendingCombatModel.declaration, pendingCombatModel.sourceMessageId, null, { protocolHandoff: pendingCombatModel.protocolHandoff, resume: pendingCombatModel });
            } catch (error) { if (isAbortError(error)) toast('已取消建模重试。', 'info'); else toast(`建模重试失败：${error.message || error}`, 'error'); }
            return;
        }
        if (action === 'combat-edit-declaration') { if (pendingBattleDeclaration?.declaration) await openBattleDeclarationPreview(pendingBattleDeclaration.declaration, pendingBattleDeclaration.sourceMessageId); return; }
        if (action === 'combat-open-model-diagnostics') { openCombatModelDiagnostics(); return; }
        if (action === 'combat-new') {
            openTextEditor({ title: '新建本地权威遭遇 · EncounterDraft', value: JSON.stringify(defaultEncounter(), null, 2), mode: 'json', onSave: async text => { try { await createCombatFromEditor(text); $('#textEditorDialog').close(); } catch (error) { toast(`遭遇创建失败：${error.message}`, 'error'); throw error; } } });
            return;
        }
        if (action === 'combat-draft-ai') { try { await draftCombatWithAi(); } catch (error) { if (isAbortError(error)) toast('已取消遭遇识别。', 'info'); else toast(`遭遇识别失败：${error.message}`, 'error'); } return; }
        if (action === 'combat-start') {
            try {
                // Step 3 is the last preparation checkpoint.  Applying the
                // local strategy here makes the transition explicit while
                // avoiding a second confirmation dialog after model success.
                if (combatState?.status === 'draft' || combatState?.status === 'ready') await compileCombatStrategy(true);
                await mutateCombat('start', { mode: $('#combatMode').value });
            } catch (error) { toast(`无法开始：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-advance') { try { await mutateCombat('advance', { mode: $('#combatMode').value, maxActions: 10000 }); } catch (error) { toast(`推进失败：${error.message}`, 'error'); } return; }
        if (action === 'combat-wait') { try { await mutateCombat('commands', { type: 'wait', actorId: combatState.activeUnitId }); } catch (error) { toast(`行动失败：${error.message}`, 'error'); } return; }
        if (action === 'combat-refresh') { await loadCombat(); return; }
        if (action === 'combat-toggle-cohorts') { combatShowCohorts = !combatShowCohorts; renderCombat(); return; }
        if (action === 'combat-compile-strategy' || action === 'combat-confirm-strategy') {
            if (!combatState) return toast('请先建立遭遇', 'error');
            try { await compileCombatStrategy(action === 'combat-confirm-strategy'); }
            catch (error) { if (isAbortError(error)) toast('已取消策略编译。', 'info'); else toast(`策略编译失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-inspect-script') {
            const review = combatState?.pauseReason?.inspection;
            if (!review) return;
            try {
                pendingCombatScriptReview = await combatRequest(`/${combatState.id}/scripts/inspect`, { method: 'POST', body: JSON.stringify({ source: review.source, ability: review.ability }) });
                openTextEditor({ title: `只读能力脚本审查 · ${review.ability?.name || review.hash}`, value: `${review.source}\n\n/*\n固定种子测试：${pendingCombatScriptReview.passed ? '100 / 100 通过' : '失败'}\n权限：${pendingCombatScriptReview.capabilities.join(', ') || '无'}\n限制：${JSON.stringify(pendingCombatScriptReview.limits)}\n失败：${JSON.stringify(pendingCombatScriptReview.failures, null, 2)}\n*/`, mode: 'text', readonly: true });
                renderCombat();
            } catch (error) { toast(`脚本审查失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-approve-script') {
            const review = combatState?.pauseReason?.inspection;
            if (!review || !pendingCombatScriptReview?.passed || pendingCombatScriptReview.hash !== review.hash) return toast('必须先通过固定种子审查', 'error');
            try { await mutateCombat(`scripts/${review.hash}/approve`, { source: review.source, ability: review.ability }); pendingCombatScriptReview = null; toast('脚本版本已批准并缓存；规则或源码改变后会重新审批。', 'success'); }
            catch (error) { toast(`脚本审批失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-replay') {
            if (!combatState) return toast('暂无战斗重放', 'error');
            try { const replay = await combatRequest(`/${combatState.id}/replay`); openTextEditor({ title: `只读战斗重放 · ${combatState.id}`, value: JSON.stringify(replay, null, 2), mode: 'json', readonly: true }); }
            catch (error) { toast(`重放读取失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-redo') {
            if (!combatState) return toast('暂无可重做的战斗', 'error');
            try { await mutateCombat('redo'); toast('已重做上一次玩家行动。', 'success'); }
            catch (error) { toast(`重做失败：${error.message}`, 'error'); }
            return;
        }
        if (action === 'combat-debug-export') { try { await exportCombatDebug(); } catch (error) { recordCombatDebug('debug_export_error', { error: combatDebugError(error) }); toast(`DEBUG 导出失败：${error.message}`, 'error'); } return; }
        if (action === 'combat-narrate') { try { await narrateCombat(); } catch (error) { if (isAbortError(error)) toast('已取消战斗融合。', 'info'); else { toast(`战报融合失败：${error.message}`, 'error'); await blackbox.record('combat', 'narration_failed', { battleId: combatState?.id, error }, { sessionId: store.activeSession?.id }); } } return; }
        if (action) blackbox.record('ui', 'action_clicked', { action }, { sessionId: store.activeSession?.id });
        if (action === 'refresh-personal-shop') { await refreshPersonalShop(); return; }
        if (action === 'check-update') {
            const info = await checkForUpdate();
            if (info.available) toast(`发现新版本 ${info.latest?.tag || ''}，可点击更新横幅或手动运行 update.bat。`, 'info');
            else if (info.latest?.tag) toast(`已是最新版本 v${info.version}。`, 'success');
            else toast('未能检查更新（可能离线或无新版本）。', 'info');
            return;
        }
        if (action === 'dismiss-update') { appInfo.dismissed = true; renderUpdateBanner(); return; }
        if (action === 'apply-update') {
            if (appInfo.updating) return;
            appInfo.updating = true;
            try {
                const response = await fetch('/api/update', { method: 'POST' });
                const body = await response.json().catch(() => ({}));
                if (!response.ok) throw new Error(body.error || '更新接口异常');
                toast(body.message || '更新已开始，服务器将自动重启；稍后请刷新页面。', 'info');
                appInfo.dismissed = true; renderUpdateBanner();
            } catch (error) { toast(`启动更新失败：${error.message}`, 'error'); }
            appInfo.updating = false;
            return;
        }
        if (action === 'toggle-rail') $('#rail').classList.toggle('open');
        if (action === 'toggle-story-tools') {
            const toolbar = $('#view-chat .adventure-toolbar');
            const opened = toolbar?.classList.toggle('tools-open') ?? false;
            event.target.closest('[data-action="toggle-story-tools"]')?.setAttribute('aria-expanded', String(opened));
        }
        if (action === 'toggle-nav-category') {
            const category = event.target.closest('.nav-category');
            const collapsed = category.classList.toggle('collapsed');
            event.target.closest('.nav-category-toggle').setAttribute('aria-expanded', String(!collapsed));
        }
        if (action === 'floor-prev' || action === 'floor-next') {
            const session = store.activeSession;
            if (session) {
                const current = storyFloorBySession.get(session.id) ?? collectStoryFloors(session.messages).length - 1;
                storyFloorBySession.set(session.id, current + (action === 'floor-prev' ? -1 : 1));
                renderMessages();
                await blackbox.record('ui', 'story_floor_changed', { floor: storyFloorBySession.get(session.id) }, { sessionId: session.id });
            }
        }
        if (action === 'view-floor-prompt') {
            const trace = currentFloorPromptTrace();
            if (trace) openTextEditor({ title: '本楼实际发送 Prompt · 只读', value: JSON.stringify(trace, null, 2), mode: 'json', readonly: true });
        }
        if (action === 'view-floor-full-prompt') {
            const trace = currentFloorPromptTrace();
            if (!trace) return;
            const header = [
                `本楼实际发送给大模型的完整 Prompt（只读）`,
                `模型：${trace.model || ''} · ${trace.protocol || 'openai-chat'}`,
                trace.sentAt ? `发送时间：${trace.sentAt}` : '',
                trace.preset ? `AIRP 预设：${trace.preset.name || ''}` : '',
                trace.activeWorldbookEntries?.length ? `World Info 命中：${trace.activeWorldbookEntries.join('、')}` : '',
            ].filter(Boolean);
            const body = [];
            (Array.isArray(trace.messages) ? trace.messages : []).forEach((message, index) => {
                body.push(`========== [${index + 1}] ${String(message.role || '?').toUpperCase()} ==========`);
                body.push(String(message.content ?? ''));
                body.push('');
            });
            openTextEditor({ title: `本楼完整 Prompt · ${trace.model || ''} · 只读`, value: `${header.join('\n')}\n\n${body.join('\n')}`, mode: 'text', readonly: true });
        }
        if (action === 'view-floor-tokens') {
            const usage = currentStoryFloor()?.narrative?.tokenUsage;
            if (usage) openTextEditor({ title: `本楼 Token 明细 · ${usage.exact ? 'API 实际值' : '上游未提供统计'}`, value: JSON.stringify(usage, null, 2), mode: 'json', readonly: true });
        }
        if (action === 'edit-floor') {
            const floor = currentStoryFloor(); const message = floor?.narrative || floor?.actions.at(-1);
            if (message) openTextEditor({ title: `编辑第 ${storyFloorBySession.get(store.activeSession.id) ?? 0} 楼`, value: message.content, mode: 'text', onSave: async value => { store.updateMessage(message.id, value); renderAll(); await blackbox.record('editor', 'story_floor_saved', { messageId: message.id, length: value.length }, { sessionId: store.activeSession?.id }); } });
        }
        if (action === 'regen-floor') {
            const message = currentStoryFloor()?.narrative;
            if (message) await requestFloorRegeneration(message);
        }
        if (action === 'switch-floor-branch') {
            await switchFloorBranch();
        }
        if (action === 'floor-branch-prev') {
            await switchFloorBranch(-1);
            return;
        }
        if (action === 'floor-branch-next') {
            await switchFloorBranch(1);
            return;
        }
        if (action === 'delete-floor') {
            const floor = currentStoryFloor(); const message = floor?.actions[0] || floor?.narrative;
            if (message && confirm('从当前剧情楼层开始删除后续记录？')) { store.removeFrom(message.id); storyFloorBySession.set(store.activeSession.id, collectStoryFloors(store.activeSession.messages).length - 1); renderAll(); }
        }
        if (action === 'open-setup-shop') { await openSetup(); showSetupStep(1); }
        if (action === 'home') showPanel('hub');
        if (action === 'toggle-actions') {
            const actions = $('#quickActions');
            const expanded = !actions.classList.toggle('hidden');
            event.target.closest('[data-action="toggle-actions"]')?.setAttribute('aria-expanded', String(expanded));
        }
        const aiCancel = event.target.closest('[data-ai-cancel]');
        if (aiCancel) { cancelAiProcess(aiCancel.dataset.aiCancel); return; }
        if (action === 'cancel-generation' && generationController) {
            await blackbox.record('turn', 'generation_cancel_requested', {}, { sessionId: store.activeSession?.id });
            generationController.abort(new DOMException('用户已中止生成', 'AbortError'));
        }
        if (action === 'roll') {
            const roll = 1 + Math.floor(Math.random() * 100);
            const input = $('#messageInput');
            input.value += `${input.value ? '\n' : ''}【D100：${roll}】`;
            input.dispatchEvent(new Event('input'));
        }
        if (action === 'new-chat') await newSession();
        if (action === 'enter-game') {
            const first = store.activeSession?.messages[0];
            if (first) {
                first.swipeIndex = 1;
                first.content = runtime.card.alternate_greetings?.[0] || '【开局】';
                store.save();
                renderAll();
            }
        }
        if (action === 'open-setup') openSetup();
        if (action === 'close-setup') $('#setupDialog').close();
        if (action === 'setup-prev') showSetupStep(setupStep - 1);
        if (action === 'open-profiles') { showSetupStep(4); renderSetupSummary(); }
        if (action === 'setup-next') {
            if (setupStep === 0 && !$('#setupForm').reportValidity()) return;
            if (setupStep === 1 && setupBalance() < 0) return toast('初始兑换已超出空间币预算', 'error');
            if (setupStep === 2 && $('#setupForm').elements.mode.value === '候选世界' && !selectedPlotId) return toast('请选择一个候选世界', 'error');
            if (setupStep === 3 && $('#setupForm').elements.partnerEnabled.checked && !$('#setupForm').elements.partnerName.value.trim()) return toast('请填写队友姓名', 'error');
            if (setupBalance() < 0) return toast('空间币不足以支付队友建档费用', 'error');
            showSetupStep(setupStep + 1);
        }
        if (action === 'save-profile') {
            const name = $('#profileName').value.trim(); if (!name) return toast('请输入档案名称', 'error');
            const existing = profiles.find(item => item.name === name);
            const profile = { id: existing?.id || crypto.randomUUID(), name, state: collectProfileState(), createdAt: existing?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
            await library.put('profiles', profile); profiles = profiles.filter(item => item.id !== profile.id).concat(profile); renderProfiles(); toast(`人物档案“${name}”已保存`, 'success');
        }
        if (action === 'import-profile') $('#profileFile').click();
        if (action === 'add-custom-starter') {
            try {
                const name = $('#customStarterName').value.trim(); if (!name) throw new Error('请填写名称');
                const effects = JSON.parse($('#customStarterEffects').value || '{}');
                const category = $('#customStarterCategory').value;
                const item = { id: `custom-${crypto.randomUUID()}`, name, tier: $('#customStarterTier').value, cost: Number($('#customStarterCost').value || 0), type: category === 'equipment' ? 9 : category === 'skill' ? 2 : '特殊', source: '自定义', tags: $('#customStarterTags').value.split(/[,，]/).map(item => item.trim()).filter(Boolean), attrs: {}, effects, desc: $('#customStarterDescription').value.trim(), consume: '', _cat: category, custom: true };
                if (item.cost < 0) throw new Error('空间币消耗不能为负数');
                customStarterItems.push(item); selectedStarterIds.add(item.id); persistPersonalShopState(); $('#customStarterName').value = ''; renderSetupShop(); renderPersonalShop(); toast(`已创建并选择：${name}`, 'success');
            } catch (error) { toast(`自定义兑换项创建失败：${error.message}`, 'error'); }
        }
        if (action === 'save-settings') {
            const values = Object.fromEntries(new FormData($('#settingsForm')));
            store.updateSettings(values);
            applyUiScale();
            toast('常规设置已保存', 'success');
        }
        if (action === 'prompt-lab-refresh') { await renderPromptLab(); return; }
        if (action === 'prompt-lab-save-modules') {
            const mode = $('#promptLabMode')?.value || selectedPromptLabMode;
            const states = promptModuleStates(mode);
            for (const id of Object.keys(PROMPT_MODULE_DEFINITIONS)) {
                const enabled = $(`[data-prompt-module-enabled="${id}"]`);
                const text = $(`[data-prompt-module-text="${id}"]`);
                const role = $(`[data-prompt-module-role="${id}"]`);
                states[id] = { enabled: enabled ? enabled.checked : states[id].enabled, text: text ? text.value : states[id].text, role: role?.value || states[id].role };
            }
            selectedPromptLabMode = mode;
            savePromptModuleStates(mode, states);
            toast(`已保存模块编排：${PROMPT_LAB_MODES[mode]?.label || mode}`, 'success');
            await renderPromptLab();
            return;
        }
        if (action === 'prompt-lab-clear-modules') {
            const mode = $('#promptLabMode')?.value || selectedPromptLabMode;
            const all = store.data.settings.promptModules && typeof store.data.settings.promptModules === 'object' ? store.data.settings.promptModules : {};
            delete all[mode];
            store.updateSettings({ promptModules: all });
            toast(`已清除模块覆盖：${PROMPT_LAB_MODES[mode]?.label || mode}`, 'success');
            await renderPromptLab();
            return;
        }
        if (action === 'prompt-lab-save') {
            const mode = $('#promptLabMode')?.value || selectedPromptLabMode;
            const text = String($('#promptLabOverride')?.value || '');
            const enabled = Boolean($('#promptLabEnabled')?.checked && text.trim());
            selectedPromptLabMode = mode;
            const overrides = promptOverrides();
            overrides[mode] = { enabled, text };
            store.updateSettings({ promptOverrides: overrides });
            toast(enabled ? `已保存并启用：${PROMPT_LAB_MODES[mode]?.label || mode}` : `已保存：${PROMPT_LAB_MODES[mode]?.label || mode}（未启用覆盖）`, 'success');
            await renderPromptLab();
            return;
        }
        if (action === 'prompt-lab-clear') {
            const mode = $('#promptLabMode')?.value || selectedPromptLabMode;
            const overrides = promptOverrides();
            delete overrides[mode];
            store.updateSettings({ promptOverrides: overrides });
            toast(`已清除：${PROMPT_LAB_MODES[mode]?.label || mode}`, 'success');
            await renderPromptLab();
            return;
        }
        if (action === 'save-model-routing') saveModelRouting();
        if (action === 'new-user-profile') {
            selectedUserProfileId = null;
            renderUserProfileManager();
            $('#userProfileForm')?.elements.name?.focus();
        }
        if (action === 'activate-user-profile') await activateUserProfile();
        if (action === 'save-user-profile') await saveUserProfile();
        if (action === 'delete-user-profile') {
            const profile = userProfiles.find(item => item.id === selectedUserProfileId);
            if (profile && confirm(`删除用户设定“${profile.name}”？`)) {
                await library.delete('userProfiles', profile.id);
                userProfiles = userProfiles.filter(item => item.id !== profile.id);
                if (store.data.settings.activeUserProfileId === profile.id) {
                    const fallback = userProfiles[0] || null;
                    if (fallback) await activateUserProfile(fallback);
                    else store.updateSettings({ activeUserProfileId: null, userName: '轮回者', persona: '' });
                }
                selectedUserProfileId = userProfiles[0]?.id || null;
                renderUserProfileManager();
                toast(`用户设定“${profile.name}”已删除`, 'success');
            }
        }
        if (action === 'import-user-profile') $('#userProfileFile').click();
        if (action === 'export-user-profile') exportUserProfile();
        if (action === 'export-user-profiles') exportUserProfiles();
        if (action === 'worldbook-new') await createWorldbookEntry();
        if (action === 'delete-worldbook') {
            const entry = worldbookEntries.find(item => item.id === selectedWorldbookId);
            if (entry && confirm(`删除世界书条目“${entry.comment}”？`)) await deleteWorldbookEntry();
        }
        if (action === 'import-worldbook') $('#worldbookFile').click();
        if (action === 'export-worldbook') exportWorldbookEntries();
        if (action === 'restore-worldbook-seeds') await restoreWorldbookSeeds();
        if (action === 'new-connection') createConnectionDraft();
        if (action === 'delete-connection') {
            const id = $('#connectionForm').elements.id.value;
            if (id && confirm('删除这条 API 连接配置？')) {
                store.deleteConnection(id);
                editConnection(store.data.connections.find(item => item.id === store.data.settings.activeConnectionId) || null);
                renderConnectionManager(); renderModelRoutingManager();
            }
        }
        if (action === 'fetch-models') await fetchModels();
        if (action === 'test-connection') await testConnection();
        if (action === 'import-connections') $('#connectionFile').click();
        if (action === 'export-connections') exportConnections();
        if (action === 'import-preset') $('#presetFile').click();
        if (action === 'add-prompt-entry') {
            const preset = presets.find(item => item.id === selectedPresetId); if (!preset) return toast('请先选择预设', 'error');
            const prompt = { identifier: crypto.randomUUID(), name: '新提示词', role: 'system', content: '', marker: false, enabled: true, order: preset.prompts.length, injectionPosition: 0, injectionDepth: 4 };
            preset.prompts.push(prompt); selectedPromptEntryId = prompt.identifier; await library.put('presets', preset); if (preset.id === store.data.settings.activePresetId) runtime.setPreset(preset); renderPresetManager();
        }
        if (['move-prompt-up', 'move-prompt-down'].includes(action)) {
            const preset = presets.find(item => item.id === selectedPresetId); const index = preset?.prompts.findIndex(item => item.identifier === selectedPromptEntryId) ?? -1; const target = action.endsWith('up') ? index - 1 : index + 1;
            if (preset && index >= 0 && target >= 0 && target < preset.prompts.length) { [preset.prompts[index], preset.prompts[target]] = [preset.prompts[target], preset.prompts[index]]; preset.prompts.forEach((item, order) => { item.order = order; }); await library.put('presets', preset); renderPresetManager(); }
        }
        if (action === 'delete-prompt-entry') {
            const preset = presets.find(item => item.id === selectedPresetId); const index = preset?.prompts.findIndex(item => item.identifier === selectedPromptEntryId) ?? -1;
            if (preset && index >= 0 && confirm(`删除提示词“${preset.prompts[index].name}”？`)) { preset.prompts.splice(index, 1); selectedPromptEntryId = preset.prompts[Math.min(index, preset.prompts.length - 1)]?.identifier || null; await library.put('presets', preset); if (preset.id === store.data.settings.activePresetId) runtime.setPreset(preset); renderPresetManager(); }
        }
        if (action === 'edit-preset-source') {
            const preset = presets.find(item => item.id === selectedPresetId);
            if (!preset) return toast('请先选择一个预设', 'error');
            const source = JSON.stringify(rawFromPresetBridge(presetBridgeValue(preset)), null, 2);
            openTextEditor({ title: `编辑预设 · ${preset.name}`, value: source, onSave: async text => {
                const value = JSON.parse(text);
                await saveBridgePreset(preset.name, value, preset);
                await blackbox.record('editor', 'preset_saved', { presetId: preset.id, name: preset.name, beforeLength: source.length, afterLength: text.length });
            } });
        }
        if (action === 'activate-preset') {
            const preset = presets.find(item => item.id === selectedPresetId);
            if (preset) {
                store.updateSettings({ activePresetId: preset.id });
                runtime.setPreset(preset);
                renderPresetManager();
                toast(`已启用 AIRP 预设：${preset.name}`, 'success');
            }
        }
        if (action === 'delete-preset') {
            const preset = presets.find(item => item.id === selectedPresetId);
            if (preset && confirm(`删除预设“${preset.name}”？`)) {
                await library.delete('presets', preset.id);
                presets = presets.filter(item => item.id !== preset.id);
                if (store.data.settings.activePresetId === preset.id) { store.updateSettings({ activePresetId: null }); runtime.setPreset(null); }
                selectedPresetId = presets[0]?.id || null; renderPresetManager();
            }
        }
        if (action === 'import-script') $('#scriptFile').click();
        if (action === 'import-regex-preset') $('#regexPresetFile').click();
        if (action === 'refresh-regex-display') {
            refreshRegexDisplay('manual');
            toast('已按当前正则重新渲染所有剧情楼层', 'success');
        }
        if (action === 'add-regex-entry') {
            const preset = await editableRegexPreset(); const rule = { id: crypto.randomUUID(), scriptName: '新正则', disabled: false, runOnEdit: false, findRegex: '', replaceString: '', trimStrings: [], placement: [1, 2], substituteRegex: 0, minDepth: null, maxDepth: null, markdownOnly: false, promptOnly: false };
            preset.scripts.push(rule); selectedRegexEntryId = rule.id; await library.put('regexPresets', preset); runtime.setRegexPresets(regexPresets); renderRegexManager();
        }
        if (['move-regex-up', 'move-regex-down'].includes(action)) {
            const preset = await editableRegexPreset(); const index = preset.scripts.findIndex(item => item.id === selectedRegexEntryId); const target = action.endsWith('up') ? index - 1 : index + 1;
            if (index >= 0 && target >= 0 && target < preset.scripts.length) { [preset.scripts[index], preset.scripts[target]] = [preset.scripts[target], preset.scripts[index]]; await library.put('regexPresets', preset); renderRegexManager(); refreshRegexDisplay('rule_reordered'); }
        }
        if (action === 'delete-regex-entry') {
            const preset = await editableRegexPreset(); const index = preset.scripts.findIndex(item => item.id === selectedRegexEntryId);
            if (index >= 0 && confirm(`删除正则“${preset.scripts[index].scriptName}”？`)) { preset.scripts.splice(index, 1); selectedRegexEntryId = preset.scripts[Math.min(index, preset.scripts.length - 1)]?.id || null; await library.put('regexPresets', preset); renderRegexManager(); refreshRegexDisplay('rule_deleted'); }
        }
        if (action === 'toggle-regex-preset') {
            const preset = regexPresets.find(item => item.id === selectedRegexPresetId); if (!preset) return toast('角色卡内置正则不能整体停用', 'error');
            preset.enabled = !preset.enabled; await library.put('regexPresets', preset); renderRegexManager(); refreshRegexDisplay('preset_toggled');
        }
        if (action === 'delete-regex-preset') {
            const preset = regexPresets.find(item => item.id === selectedRegexPresetId); if (!preset) return toast('角色卡内置正则不能删除', 'error');
            if (confirm(`删除正则预设“${preset.name}”？`)) { await library.delete('regexPresets', preset.id); regexPresets = regexPresets.filter(item => item.id !== preset.id); selectedRegexPresetId = 'card'; renderRegexManager(); refreshRegexDisplay('preset_deleted'); }
        }
        if (action === 'edit-regex-preset') {
            const preset = selectedRegexPresetId === 'card' ? { name: '角色卡内置正则（只读副本）', scripts: runtime.card.extensions.regex_scripts } : regexPresets.find(item => item.id === selectedRegexPresetId);
            if (!preset) return;
            const source = JSON.stringify({ name: preset.name, enabled: preset.enabled !== false, scripts: preset.scripts }, null, 2);
            openTextEditor({ title: `编辑正则预设 · ${preset.name}`, value: source, onSave: selectedRegexPresetId === 'card' ? async text => {
                const imported = normalizeRegexPreset(JSON.parse(text), '卡内正则副本.json'); imported.name = '卡内正则副本'; await library.put('regexPresets', imported); regexPresets.push(imported); selectedRegexPresetId = imported.id; renderRegexManager(); refreshRegexDisplay('card_copy_edited');
            } : async text => {
                const imported = normalizeRegexPreset(JSON.parse(text), `${preset.name}.json`); imported.id = preset.id; imported.name = preset.name; await library.put('regexPresets', imported); regexPresets = regexPresets.filter(item => item.id !== preset.id).concat(imported); renderRegexManager(); refreshRegexDisplay('preset_source_edited');
            } });
        }
        if (action === 'import-script-url') {
            const input = $('#scriptUrl'); const url = input.value.trim();
            if (!url) return toast('请先填写助手脚本 URL', 'error');
            const button = event.target.closest('[data-action="import-script-url"]'); button.disabled = true; button.textContent = '导入中…';
            try { await importScriptUrl(url); input.value = ''; }
            catch (error) { toast(`URL 导入失败：${error.message}`, 'error'); }
            finally { button.disabled = false; button.textContent = 'URL 导入'; }
        }
        if (action === 'toggle-script') {
            const script = scripts.find(item => item.id === selectedScriptId);
            if (script) {
                script.enabled = !script.enabled; await library.put('scripts', script);
                if (script.enabled) executeAssistantScript(script).catch(error => toast(`${script.name} 启动失败：${error.message}`, 'error'));
                else stopAssistantScript(script.id);
                renderScriptManager();
            }
        }
        if (action === 'open-script-ui') openAssistantScriptUi(selectedScriptId);
        if (action === 'delete-script') {
            const script = scripts.find(item => item.id === selectedScriptId);
            if (script && confirm(`删除脚本“${script.name}”？`)) {
                stopAssistantScript(script.id); await library.delete('scripts', script.id);
                scripts = scripts.filter(item => item.id !== script.id); selectedScriptId = scripts[0]?.id || null; renderScriptManager();
            }
        }
        if (action === 'export-save') exportSave();
        if (action === 'export-blackbox') {
            let combatReplay = null;
            try { if (activeBattleId()) combatReplay = await combatRequest(`/${activeBattleId()}/replay`); } catch (error) { combatReplay = { error: error.message, battleId: activeBattleId() }; }
            await blackbox.exportCurrent({
                store: store.data,
                activePreset: runtime.activePreset ? { id: runtime.activePreset.id, name: runtime.activePreset.name } : null,
                card: { name: runtime.card.name, worldbookEntries: runtime.card.character_book?.entries?.length, regexScripts: runtime.card.extensions?.regex_scripts?.length },
                scripts: scripts.map(item => ({ id: item.id, name: item.name, enabled: item.enabled, sourceUrl: item.sourceUrl })),
                combatReplay,
            });
        }
        if (action === 'clear-blackbox' && confirm('清空所有本机黑盒历史并开始一段新的记录？')) { await blackbox.clear(); await renderBlackBox(); }
        const messageAction = event.target.closest('[data-message-action]');
        if (messageAction) await handleMessageAction(messageAction.closest('.message').dataset.id, messageAction.dataset.messageAction);
        const archive = event.target.closest('[data-session]');
        if (archive) { store.selectSession(archive.dataset.session); loadPersonalShopState(); combatState = null; combatUnitStrategySelections = {}; combatEvents = []; combatMapZoom = 1; combatMapPan = { x: 0, y: 0 }; combatPromptTraceCache = null; snapCombatFlowPhase(); pendingCombatScriptReview = null; resetCombatRecognitionState(); loadCombat({ quiet: true }); showPanel('hub'); renderAll(); }
        const attribute = event.target.closest('[data-attribute]');
        if (attribute) {
            const key = attribute.dataset.attribute;
            const delta = Number(attribute.dataset.delta);
            const used = Object.values(attributePoints).reduce((sum, value) => sum + value, 0);
            if (delta > 0 && used >= 8) return toast('血统潜质点已全部分配', 'error');
            attributePoints[key] = Math.max(0, Math.min(8, attributePoints[key] + delta));
            renderAttributeBuilder();
        }
        const filter = event.target.closest('[data-filter]');
        if (filter) {
            $$('.filter-tabs button').forEach(button => button.classList.toggle('active', button === filter));
            $$('#inventoryContent .entity-card').forEach(card => card.hidden = filter.dataset.filter !== 'all' && card.dataset.entityType !== filter.dataset.filter);
        }
    });
    document.addEventListener('change', async event => {
        if (event.target.matches('#promptLabMode')) {
            selectedPromptLabMode = event.target.value;
            await renderPromptLab();
            return;
        }
        if (event.target.matches('[data-prompt-module-enabled]')) {
            const card = event.target.closest('[data-prompt-module-card]');
            card?.classList.toggle('is-enabled', event.target.checked);
            card?.classList.toggle('is-disabled', !event.target.checked);
            return;
        }
        if (event.target.matches('[data-combat-control]')) {
            try { await mutateCombat('control', { unitId: event.target.dataset.combatControl, controller: event.target.value === 'ai' ? 'ai' : 'player' }); }
            catch (error) { toast(`控制权切换失败：${error.message}`, 'error'); }
            return;
        }
        if (event.target.matches('[data-combat-unit-mode]')) {
            try { await mutateCombat('control', { unitId: event.target.dataset.combatUnitMode, modeOverride: event.target.value }); }
            catch (error) { toast(`单位模式切换失败：${error.message}`, 'error'); }
            return;
        }
        if (event.target.matches('[data-combat-unit-strategy]')) {
            const unitId = event.target.dataset.combatUnitStrategy;
            if (event.target.value === 'inherit') delete combatUnitStrategySelections[unitId];
            else combatUnitStrategySelections[unitId] = event.target.value;
            return;
        }
        if (event.target.matches('#combatMode')) {
            const selectedMode = event.target.value;
            // Keep the choice even while a terminal is being replaced.  This
            // is also the source of truth for the next transient simulator.
            store.updateSettings({ combatModePreference: selectedMode });
            // A completed simulator cannot be mutated, but its mode selector
            // is still the control used by the next sample.  Persist that
            // preference instead of letting renderCombat snap it back to the
            // old terminal state.
            if (!combatState || ['completed', 'abandoned'].includes(combatState.status)) {
                renderCombat();
                return;
            }
            try { await mutateCombat('control', { mode: selectedMode }); } catch (error) { toast(`模式切换失败：${error.message}`, 'error'); }
            return;
        }
        if (event.target.matches('#combatConnection')) {
            const aiAssignments = { ...(store.data.settings.aiAssignments || {}), combatConnectionId: event.target.value || null };
            store.updateSettings({ activeCombatConnectionId: event.target.value || null, aiAssignments });
            renderModelRoutingManager(); renderCombat(); return;
        }
        if (event.target.matches('#combatPreset')) { store.updateSettings({ activeCombatPresetId: event.target.value || null }); renderCombat(); return; }
        if (event.target.matches('[data-cover-agree]')) {
            event.target.closest('.native-cover').querySelector('[data-action="enter-game"]').disabled = !event.target.checked;
        }
        if (event.target.matches('[data-prompt-toggle]')) {
            const preset = presets.find(item => item.id === selectedPresetId);
            const prompt = preset?.prompts.find(item => item.identifier === event.target.closest('[data-prompt-id]')?.dataset.promptId);
            if (prompt) {
                prompt.enabled = event.target.checked;
                library.put('presets', preset);
                if (preset.id === store.data.settings.activePresetId) runtime.setPreset(preset);
                renderPresetManager();
            }
        }
        if (event.target.matches('[data-regex-toggle]')) {
            const entryId = event.target.closest('[data-regex-entry-id]')?.dataset.regexEntryId;
            selectedRegexEntryId = entryId || selectedRegexEntryId;
            const preset = await editableRegexPreset();
            const rule = preset?.scripts.find(item => item.id === selectedRegexEntryId);
            if (rule) {
                rule.disabled = !event.target.checked;
                await library.put('regexPresets', preset);
                await blackbox.record('editor', 'regex_entry_toggled', { presetId: preset.id, ruleId: rule.id, enabled: !rule.disabled });
                renderRegexManager(); refreshRegexDisplay('rule_toggled');
            }
        }
        if (event.target.matches('#regexPresetEnabled')) {
            const preset = regexPresets.find(item => item.id === selectedRegexPresetId);
            if (!preset) return;
            preset.enabled = event.target.checked;
            await library.put('regexPresets', preset);
            await blackbox.record('editor', 'regex_preset_toggled', { presetId: preset.id, enabled: preset.enabled });
            renderRegexManager(); refreshRegexDisplay('preset_enabled_changed');
        }
    });
    $('#presetFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = '';
        if (!file) return;
        try { await importPresetFile(file); } catch (error) { toast(`预设导入失败：${error.message}`, 'error'); }
    });
    $('#scriptFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = '';
        if (!file) return;
        try { await importScriptFile(file); } catch (error) { toast(`脚本导入失败：${error.message}`, 'error'); }
    });
    $('#regexPresetFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = ''; if (!file) return;
        try { const preset = normalizeRegexPreset(JSON.parse(await file.text()), file.name); await library.put('regexPresets', preset); regexPresets.push(preset); selectedRegexPresetId = preset.id; renderRegexManager(); refreshRegexDisplay('preset_imported'); toast(`已导入正则预设：${preset.name}，已重渲染剧情`, 'success'); }
        catch (error) { toast(`正则预设导入失败：${error.message}`, 'error'); }
    });
    $('#worldbookFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = '';
        if (!file) return;
        try { await importWorldbookFile(file); }
        catch (error) { toast(`世界书导入失败：${error.message}`, 'error'); }
    });
    $('#scriptUrl').addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); $('[data-action="import-script-url"]').click(); }
    });
    $('#connectionFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = '';
        if (!file) return;
        try { await importConnections(file); } catch (error) { toast(`API 实例导入失败：${error.message}`, 'error'); }
    });
    $('#connectionForm').addEventListener('submit', event => {
        event.preventDefault();
        const values = Object.fromEntries(new FormData(event.currentTarget));
        values.temperature = Number(values.temperature); values.maxTokens = Number(values.maxTokens);
        const saved = store.saveConnection(values); editConnection(saved); renderConnectionManager(); renderModelRoutingManager();
        toast(`连接配置“${saved.name}”已保存并启用`, 'success');
    });
    $('#promptEntryEditor').addEventListener('submit', async event => {
        event.preventDefault();
        const preset = presets.find(item => item.id === selectedPresetId);
        const prompt = preset?.prompts.find(item => item.identifier === selectedPromptEntryId);
        if (!preset || !prompt) return;
        const form = event.currentTarget;
        const before = { name: prompt.name, role: prompt.role, enabled: prompt.enabled, contentLength: prompt.content.length };
        prompt.name = form.elements.name.value.trim() || '未命名提示词';
        prompt.role = form.elements.role.value;
        prompt.content = form.elements.content.value;
        prompt.marker = form.elements.marker.checked;
        prompt.enabled = form.elements.enabled.checked;
        prompt.injectionPosition = Number(form.elements.injectionPosition.value || 0);
        prompt.injectionDepth = Math.max(0, Number(form.elements.injectionDepth.value || 0));
        await library.put('presets', preset);
        if (preset.id === store.data.settings.activePresetId) runtime.setPreset(preset);
        await blackbox.record('editor', 'preset_entry_saved', { presetId: preset.id, promptId: prompt.identifier, before, after: { name: prompt.name, role: prompt.role, enabled: prompt.enabled, contentLength: prompt.content.length } });
        renderPresetManager();
        toast(`提示词“${prompt.name}”已保存`, 'success');
    });
    $('#regexEntryEditor').addEventListener('submit', async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const preset = await editableRegexPreset();
        const rule = preset?.scripts.find(item => item.id === selectedRegexEntryId);
        if (!preset || !rule) return;
        const nullableNumber = name => form.elements[name].value === '' ? null : Math.max(0, Number(form.elements[name].value));
        const before = { scriptName: rule.scriptName, disabled: rule.disabled, findLength: rule.findRegex.length, replaceLength: rule.replaceString.length };
        rule.scriptName = form.elements.scriptName.value.trim() || '未命名正则';
        rule.findRegex = form.elements.findRegex.value;
        rule.replaceString = form.elements.replaceString.value;
        rule.placement = [form.elements.placement1.checked && 1, form.elements.placement2.checked && 2].filter(Boolean);
        rule.promptOnly = form.elements.promptOnly.checked;
        rule.markdownOnly = form.elements.markdownOnly.checked;
        rule.runOnEdit = form.elements.runOnEdit.checked;
        rule.substituteRegex = form.elements.substituteRegex.checked ? 1 : 0;
        rule.minDepth = nullableNumber('minDepth');
        rule.maxDepth = nullableNumber('maxDepth');
        rule.trimStrings = form.elements.trimStrings.value.split(/\r?\n/).filter(item => item.length);
        rule.disabled = !form.elements.enabled.checked;
        await library.put('regexPresets', preset);
        await blackbox.record('editor', 'regex_entry_saved', { presetId: preset.id, ruleId: rule.id, before, after: { scriptName: rule.scriptName, disabled: rule.disabled, findLength: rule.findRegex.length, replaceLength: rule.replaceString.length } });
        renderRegexManager(); refreshRegexDisplay('rule_saved');
        toast(`正则“${rule.scriptName}”已保存`, 'success');
    });
    $('#textEditorValue').addEventListener('input', () => updateTextEditorStatus());
    $('#textEditorValue').addEventListener('scroll', event => { $('#textEditorLines').scrollTop = event.target.scrollTop; });
    $('#textEditorValue').addEventListener('click', () => updateTextEditorStatus());
    $('#textEditorValue').addEventListener('keyup', () => updateTextEditorStatus());
    $('#textEditorValue').addEventListener('keydown', event => {
        if (event.key === 'Tab') {
            event.preventDefault(); const input = event.currentTarget; const start = input.selectionStart;
            input.setRangeText('  ', start, input.selectionEnd, 'end'); updateTextEditorStatus();
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') { event.preventDefault(); saveTextEditor(); }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f') { event.preventDefault(); $('#textEditorFind').focus(); }
    });
    $('#textEditorDialog').addEventListener('click', async event => {
        const action = event.target.closest('[data-editor-action]')?.dataset.editorAction;
        if (!action) return;
        if (action === 'close') $('#textEditorDialog').close();
        if (action === 'find-next') findInEditor();
        if (action === 'revert') { $('#textEditorValue').value = textEditorOriginal; updateTextEditorStatus('已恢复打开时内容'); }
        if (action === 'format') { try { $('#textEditorValue').value = JSON.stringify(JSON.parse($('#textEditorValue').value), null, 2); updateTextEditorStatus('JSON 格式化完成'); } catch (error) { updateTextEditorStatus(`JSON 无效：${error.message}`); } }
        if (action === 'replace') { const input = $('#textEditorValue'); const selected = input.value.slice(input.selectionStart, input.selectionEnd); if (selected === $('#textEditorFind').value) input.setRangeText($('#textEditorReplace').value, input.selectionStart, input.selectionEnd, 'end'); findInEditor(); }
        if (action === 'replace-all') { const find = $('#textEditorFind').value; if (find) { const input = $('#textEditorValue'); const count = input.value.split(find).length - 1; input.value = input.value.split(find).join($('#textEditorReplace').value); updateTextEditorStatus(`已替换 ${count} 处`); } }
        if (action === 'save') await saveTextEditor();
    });
    $('#setupForm').addEventListener('submit', submitSetup);
    $('#modelRoutingForm').addEventListener('submit', event => { event.preventDefault(); saveModelRouting(); });
    $('#userProfileForm').addEventListener('submit', event => { event.preventDefault(); saveUserProfile(); });
    $('#worldbookForm').addEventListener('submit', saveWorldbookForm);
    $('#setupShopSearch').addEventListener('input', renderSetupShop);
    $('#personalShopContent').addEventListener('input', event => { if (event.target.matches('[data-personal-shop-search]')) { personalShopSearch = event.target.value.trim().toLowerCase(); renderPersonalShop(); requestAnimationFrame(() => { const input = $('[data-personal-shop-search]'); input?.focus(); input?.setSelectionRange(input.value.length, input.value.length); }); } });
    $('#setupForm').elements.partnerEnabled.addEventListener('change', () => { renderPartnerState(); renderSetupShop(); });
    $('#setupForm').elements.partnerTier.addEventListener('change', () => { renderPartnerState(); renderSetupShop(); });
    $('#setupForm').elements.mode.forEach(input => input.addEventListener('change', renderSetupPlots));
    $('#profileFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = ''; if (!file) return;
        try {
            const raw = JSON.parse(await file.text()); const source = raw.profile || raw;
            if (!source?.state) throw new Error('缺少人物档案 state');
            const profile = { ...source, id: crypto.randomUUID(), name: source.name || file.name.replace(/\.json$/i, ''), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
            await library.put('profiles', profile); profiles.push(profile); renderProfiles(); toast(`已导入人物档案：${profile.name}`, 'success');
        } catch (error) { toast(`人物档案导入失败：${error.message}`, 'error'); }
    });
    $('#userProfileFile').addEventListener('change', async event => {
        const file = event.target.files[0]; event.target.value = ''; if (!file) return;
        try { await importUserProfiles(file); }
        catch (error) { toast(`用户设定导入失败：${error.message}`, 'error'); }
    });
    $('#connectionForm').elements.temperature.addEventListener('input', event => { $('#temperatureValue').textContent = event.target.value; });
    $('#connectionForm').elements.model.addEventListener('input', event => renderConnectionModelOptions(event.target.value));
    $('#connectionForm').elements.model.addEventListener('focus', event => { if (connectionModelCandidates.length) renderConnectionModelOptions(event.target.value); });
    $('#connectionForm').elements.model.addEventListener('keydown', event => {
        if (event.key === 'ArrowDown' && connectionModelCandidates.length) { event.preventDefault(); renderConnectionModelOptions(event.target.value); $('#connectionModelOptions button')?.focus(); }
        if (event.key === 'Escape') $('#connectionModelOptions').classList.remove('open');
    });
    $('#connectionForm').elements.protocol.addEventListener('change', event => {
        const form = event.currentTarget.form; const defaults = protocolDefaults(event.target.value);
        form.elements.baseUrl.value = defaults.baseUrl; form.elements.path.value = defaults.path; form.elements.modelsPath.value = defaults.modelsPath;
        connectionModelCandidates = []; $('#connectionModelOptions').classList.remove('open');
    });
    document.addEventListener('pointerdown', event => { if (!event.target.closest('.model-combo')) $('#connectionModelOptions').classList.remove('open'); });
    runtime.addEventListener('notify', event => toast(event.detail.message, event.detail.type));
    runtime.addEventListener('variables', renderAll);
}

async function handleMessageAction(id, action) {
    const session = store.activeSession;
    const message = session.messages.find(item => item.id === id);
    if (!message) return;
    if (action === 'edit') {
        openTextEditor({ title: '编辑剧情楼层', value: message.content, mode: 'text', onSave: async value => { store.updateMessage(id, value); renderAll(); } });
    } else if (action === 'delete') {
        if (confirm('从这条消息开始删除后续记录？')) { store.removeFrom(id); renderAll(); }
    } else if (action === 'regen') {
        await requestFloorRegeneration(message);
    }
}

async function fetchModels() {
    const form = $('#connectionForm');
    const values = Object.fromEntries(new FormData(form));
    const modelsController = new AbortController();
    const processId = beginAiProcess('API 模型列表', '等待接口响应', () => modelsController.abort(new DOMException('用户已取消获取模型', 'AbortError')));
    try {
        const response = await fetch('/api/models', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(values), signal: modelsController.signal });
        updateAiProcess(processId, '解析模型列表');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        const ids = (data.data ?? []).map(item => typeof item === 'string' ? item : item.id || item.name).filter(Boolean).sort((a, b) => a.localeCompare(b));
        if (!ids.length) throw new Error('接口未返回模型列表');
        connectionModelCandidates = ids;
        renderConnectionModelOptions(form.elements.model.value);
        $('#connectionTestResult').textContent = `已获取 ${ids.length} 个模型；输入关键词过滤或直接选择`;
    } catch (error) { if (isAbortError(error)) toast('已取消获取模型。', 'info'); else toast(`获取模型失败：${error.message}`, 'error'); }
    finally { endAiProcess(processId); }
}

function validateConnectionForTest(values) {
    const missing = [];
    if (!String(values.baseUrl || '').trim()) missing.push('API 基础地址');
    if (!String(values.model || '').trim()) missing.push('模型名称');
    for (const [key, label] of [['extraHeaders', '额外请求头 JSON'], ['extraBody', '额外请求体 JSON']]) {
        if (!String(values[key] || '').trim()) continue;
        try { JSON.parse(values[key]); } catch (error) { return `测试前请修正${label}：${error.message}`; }
    }
    return missing.length ? `测试前请填写：${missing.join('、')}` : '';
}

async function testConnection() {
    const form = $('#connectionForm');
    const values = Object.fromEntries(new FormData(form));
    const result = $('#connectionTestResult');
    const validationError = validateConnectionForTest(values);
    if (validationError) {
        result.textContent = validationError;
        result.className = 'error';
        return;
    }
    result.textContent = '正在连接…';
    const testController = new AbortController();
    const processId = beginAiProcess('API 连接测试', '等待接口响应', () => testController.abort(new DOMException('用户已取消连接测试', 'AbortError')));
    try {
        const connectionTestModules = [{ id: 'preset', label: PROMPT_MODULE_DEFINITIONS.preset.label, messages: [] }, { id: 'rules', label: PROMPT_MODULE_DEFINITIONS.rules.label, messages: [] }, { id: 'work', label: PROMPT_MODULE_DEFINITIONS.work.label, messages: [{ role: 'user', content: values.testPrompt || '只回复 OK' }] }];
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...values, stream: false, temperature: Number(values.temperature), maxTokens: Math.min(64, Number(values.maxTokens) || 64), messages: applyPromptModuleMessages(connectionTestModules, 'connection-test') }), signal: testController.signal });
        updateAiProcess(processId, '接收测试响应');
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || response.statusText);
        result.textContent = `连接正常 · ${String(data.choices?.[0]?.message?.content || '上游已响应').slice(0, 80)}`;
        result.className = 'ok';
    } catch (error) {
        if (isAbortError(error)) { result.textContent = '已取消连接测试'; result.className = 'info'; }
        else { result.textContent = `连接失败 · ${error.message}`; result.className = 'error'; }
    } finally { endAiProcess(processId); }
}

async function importConnections(file) {
    const raw = JSON.parse(await file.text());
    const source = Array.isArray(raw) ? raw : Array.isArray(raw.profiles) ? raw.profiles : raw.connections;
    if (!Array.isArray(source) || !source.length) throw new Error('文件中没有 profiles 或 connections 实例数组');
    const items = source.map((item, index) => {
        const config = item?.config || item || {};
        const signature = `${config.baseUrl || ''} ${config.path || ''}`;
        const inferredProtocol = /generateContent|generativelanguage/i.test(signature) ? 'gemini' : /anthropic|\/messages/i.test(signature) ? 'anthropic' : /\/responses/i.test(signature) ? 'openai-responses' : 'openai-chat';
        return {
            ...config,
            id: crypto.randomUUID(),
            name: String(item?.name || `API ${index + 1}`),
            protocol: config.protocol || inferredProtocol,
            maxTokens: config.maxTokens ?? config.maxOutputTokens ?? 8192,
        };
    });
    if (!confirm(`导入会覆盖当前 ${store.data.connections.length} 个 API 实例，确定继续？`)) return;
    store.data.connections = [];
    store.data.settings.activeConnectionId = null;
    store.data.settings.aiAssignments = { storyConnectionId: null, combatConnectionId: null, shopConnectionId: null };
    let last;
    for (const item of items) {
        if (!item?.name || !item?.baseUrl) continue;
        const defaults = protocolDefaults(item.protocol || 'openai-chat');
        last = store.saveConnection({ ...defaults, extraHeaders: '{}', extraBody: '{}', testPrompt: '只回复 OK', ...item, id: item.id || crypto.randomUUID() });
    }
    if (!last) throw new Error('没有可导入的有效实例');
    editConnection(last); renderConnectionManager(); renderModelRoutingManager(); toast(`已导入 ${items.length} 条 API 实例`, 'success');
}

function exportConnections() {
    if (!confirm('导出的实例集包含 API Key，请只保存在可信位置。确定导出？')) return;
    const profiles = store.data.connections.map(({ id, name, createdAt, updatedAt, ...config }) => ({ id, name, config }));
    const payload = { format: 'comic-orb-api-profiles', version: 1, kind: 'chat', exportedAt: new Date().toISOString(), activeId: store.data.settings.activeConnectionId, profiles };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = `comic-orb-chat-apis-${new Date().toISOString().slice(0, 10)}.json`; link.click(); URL.revokeObjectURL(link.href);
}

function exportSave() {
    const blob = new Blob([store.export()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `轮回战场-${store.activeSession?.title || '存档'}.json`;
    link.click();
    URL.revokeObjectURL(link.href);
}

async function loadOpeningData() {
    const response = await fetch('/api/opening-data');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || response.statusText);
    openingData = data;
    renderSetupShop(); renderPersonalShop(); renderSetupPlots();
}

async function boot() {
    await blackbox.record('lifecycle', 'boot_started', { savedSessions: store.data.sessions.length, savedConnections: store.data.connections.length });
    try {
        const response = await fetch('/api/card');
        if (!response.ok) throw new Error(await response.text());
        runtime = new CardRuntime(await response.json(), store);
        window.__reincarnationRuntime = runtime;
        window.__battleOrbRuntime = runtime;
        if (!store.data.connections.length) {
            store.saveConnection({
                name: '默认 OpenAI 兼容连接', protocol: 'openai-chat', ...protocolDefaults('openai-chat'),
                baseUrl: store.data.settings.baseUrl || 'https://api.openai.com/v1', apiKey: store.data.settings.apiKey || '',
                model: store.data.settings.model || '', temperature: store.data.settings.temperature ?? .9,
                maxTokens: store.data.settings.maxTokens ?? 8192, apiVersion: '', extraHeaders: '{}', extraBody: '{}', testPrompt: '只回复 OK',
            });
        }
        if (!store.activeSession) {
            const session = store.createSession({ firstMessage: runtime.card.first_mes || '【封面】', variables: runtime.createInitialVariables() });
            session.messages[0].swipes = [runtime.card.first_mes, ...(runtime.card.alternate_greetings ?? [])];
            store.save();
        }
        loadPersonalShopState();
        installBridge();
        bindEvents();
        fillSettings();
        renderAll();
        await Promise.all([loadLibraries(), loadOpeningData().catch(error => { toast(error.message, 'error'); blackbox.record('setup', 'opening_data_failed', { error }); })]);
        renderVersionBadge();
        checkForUpdate();
        const result = await runtime.initializeScripts();
        await blackbox.record('runtime', 'card_runtime_initialized', { card: runtime.card.name, worldbookEntries: runtime.card.character_book?.entries?.length, regexScripts: runtime.card.extensions?.regex_scripts?.length, loaded: result.loaded, failed: result.failed }, { sessionId: store.activeSession?.id });
        renderIntegrity(result);
        const total = result.loaded.length + result.failed.length;
        $('#runtimeBadge').classList.toggle('ready', result.failed.length === 0);
        $('#runtimeBadge').innerHTML = `<i></i> ${result.failed.length ? `${total - result.failed.length}/${total} 脚本就绪` : '玩法运行时就绪'}`;
        if (result.failed.length) toast('部分远程卡片模块未加载，请检查网络；核心内置兼容层仍可运行。', 'error');
        const battleOrbApp = { store, runtime, blackbox, generate, newSession, refreshPersonalShop, forgeShop: forgePersonalShop, forge_shop: forgePersonalShop, presets: () => presets, scripts: () => scripts, userProfiles: () => userProfiles, activateUserProfile, renderAll, renderRelations, renderPersonalShop, renderBlackBox, processBattleDeclaration, parseBattleDeclarationResponse, combatModelPrompt, ensureCombatAssetContext, battleKnownEntities, localEntityCombatSnapshot, attachAuthoritativeExistingEntities, exportCombatDebug, openCombatPromptTrace, getCombatPromptTrace: () => structuredClone(combatPromptTraceCache), getCombatDebugTrace: () => structuredClone(combatDebugTrace), getCombatState: () => structuredClone(combatState), getAffection: (source, target) => getAffection(runtime.variables.stat_data, source, target), importTavernContext: importBattleOrbTavernContext, publishHandoff: publishBattleOrbHandoff };
        window.__battleOrbApp = battleOrbApp;
        // Keep the old diagnostic global as a compatibility alias for copied
        // UI tests and existing local bookmarks.
        window.__reincarnationApp = battleOrbApp;
        await blackbox.record('lifecycle', 'boot_completed', { activeSessionId: store.activeSession?.id, activePresetId: store.data.settings.activePresetId, activeConnectionId: store.data.settings.activeConnectionId }, { sessionId: store.activeSession?.id });
        await renderBlackBox();
    } catch (error) {
        console.error(error);
        await blackbox.record('lifecycle', 'boot_failed', { error });
        toast(`启动失败：${error.message}`, 'error');
        $('#runtimeBadge').innerHTML = '<i></i> 启动失败';
    }
}

boot();
