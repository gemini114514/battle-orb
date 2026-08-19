import { sha256, RULESET_VERSION } from './util.js';

const MAX_SOURCE = 64 * 1024;
const MAX_EFFECTS = 64;
// 单次脚本执行的挂钟上限。不能设太小：QuickJS 首跑需冷启动编译，且脚本输入会包含整场
// combatants（数百单位时序列化 + 解析可能超过 25ms），过紧会被误判为 interrupted 中止，
// 导致半自动/全自动“啥也没做就报错”。250ms 仍能挡住死循环，但不会误杀正常脚本。
const SCRIPT_EXECUTION_MS = 250;
let quickJsPromise;
let browserBundlePromise;

export function scriptHash(source) { return sha256(`${RULESET_VERSION}\n${String(source).trim().replace(/\r\n/g, '\n')}`); }

async function loadQuickJs() {
    // Node / vite harness: quickjs-emscripten is a normal dependency.
    try {
        const nodeModule = await import('quickjs-emscripten');
        if (nodeModule?.getQuickJS) return nodeModule.getQuickJS();
    } catch { /* fall through to the browser bundle */ }
    // Tavern extension: inject the self-contained vendored browser bundle once.
    if (!browserBundlePromise) {
        browserBundlePromise = new Promise((resolve, reject) => {
            const existing = globalThis.QJS || globalThis.QuickJS;
            if (existing) return resolve(existing);
            if (typeof document === 'undefined') return reject(new Error('QuickJS 不可用：Node 加载失败且非浏览器环境'));
            const src = new URL('./vendor/quickjs.global.js', import.meta.url).href;
            const script = document.createElement('script');
            script.src = src;
            script.async = true;
            script.onload = () => resolve(globalThis.QJS || globalThis.QuickJS);
            script.onerror = () => reject(new Error(`QuickJS 浏览器包加载失败：${src}`));
            document.head.appendChild(script);
        });
    }
    const namespace = await browserBundlePromise;
    if (namespace?.getQuickJS) return namespace.getQuickJS();
    if (namespace?.default?.getQuickJS) return namespace.default.getQuickJS();
    throw new Error('QuickJS 浏览器包未暴露 getQuickJS');
}

export function inspectScript(source, ability = {}) {
    const text = String(source || '');
    if (!text.trim()) throw new Error('脚本为空');
    const textSize = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
    if (textSize > MAX_SOURCE) throw new Error('脚本超过 64KB');
    const forbidden = /\b(?:fetch|XMLHttpRequest|WebSocket|require|process|Deno|Bun|importScripts|eval|Function|document|window|location)\b|\bimport\s*\(/;
    if (forbidden.test(text)) throw new Error('脚本请求了沙箱禁止能力');
    const apiNames = ['state', 'distance', 'unitsInArea', 'd100', 'd', 'attack', 'damage', 'heal', 'status', 'dispel', 'move', 'push', 'resource', 'modify', 'summon', 'check', 'lock', 'log', 'event'];
    const capabilities = [...new Set([...text.matchAll(/api\.([a-zA-Z]+)\s*\(/g)].map(match => match[1]).filter(name => apiNames.includes(name)))];
    return { hash: scriptHash(text), rulesetVersion: RULESET_VERSION, ability: { id: ability.id, name: ability.name }, source: text, size: textSize, capabilities, limits: { executionMs: SCRIPT_EXECUTION_MS, memoryMb: 16, maxEffects: MAX_EFFECTS, triggerDepth: 8 } };
}

function seededRandom(seedText) {
    // xmur3 -> mulberry32; deterministic across environments and replays.
    let h = 1779033703 ^ seedText.length;
    for (let i = 0; i < seedText.length; i += 1) { h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => {
        a += 0x6D2B79F5;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

export async function runScript(source, input) {
    const inspection = inspectScript(source, input.ability);
    const QuickJS = await loadQuickJs();
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const deadline = Date.now() + SCRIPT_EXECUTION_MS;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const vm = runtime.newContext();
    try {
        const safeInput = JSON.stringify(input).replace(/</g, '\\u003c');
        const wrapped = `"use strict";
            const input = Object.freeze(${safeInput});
            const effects = [];
            const emit = (type, payload) => { if (effects.length >= ${MAX_EFFECTS}) throw new Error("效果数量超过限制"); effects.push({ type, ...payload }); };
            const seededRandom = (seedText) => { let h = 1779033703 ^ seedText.length; for (let i = 0; i < seedText.length; i += 1) { h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); } let a = h >>> 0; return () => { a += 0x6D2B79F5; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
            const unitsById = new Map((input.units || []).map(u => [u.id, u]));
            const rand = seededRandom(String(input.rng && input.rng.seed) + ":" + Number(input.rng && input.rng.count || 0));
            const sideOf = u => u.side === "player" ? "player" : u.side === "neutral" ? "neutral" : "enemy";
            const actorSide = sideOf(input.actor || {});
            const api = Object.freeze({
              state: () => ({ round: input.round || 0, battlefield: input.battlefield || null, actor: input.actor || null, targets: input.targets || [], units: input.units || [], enemies: (input.units || []).filter(u => u.id !== (input.actor && input.actor.id) && sideOf(u) !== actorSide), allies: (input.units || []).filter(u => u.id !== (input.actor && input.actor.id) && sideOf(u) === actorSide) }),
              distance: (aId, bId) => { const a = unitsById.get(String(aId)), b = unitsById.get(String(bId)); if (!a || !b || !a.position || !b.position) return NaN; return Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y); },
              unitsInArea: (x, y, radius) => (input.units || []).filter(u => u.position && Math.hypot(u.position.x - Number(x), u.position.y - Number(y)) <= Number(radius)).map(u => ({ id: u.id, name: u.name, side: u.side, hp: u.hp, maxHp: u.maxHp, position: u.position, statuses: u.statuses })),
              d100: () => 1 + Math.floor(rand() * 100),
              d: n => 1 + Math.floor(rand() * Math.max(1, Number(n))),
              damage: (targetId, amount, damageType = "physical") => emit("damage", { targetId: String(targetId), amount: Number(amount), damageType: String(damageType) }),
              attack: (targetId, options = {}) => emit("attack", {
                  targetId: String(targetId),
                  power: options && options.power !== undefined ? Number(options.power) : Number(input.ability && input.ability.power || 0),
                  modifier: options && options.modifier !== undefined ? Number(options.modifier) : Number(input.ability && input.ability.modifier || 0),
                  damageType: options && options.damageType || String(input.ability && input.ability.type || 'physical'),
              }),
              heal: (targetId, amount) => emit("heal", { targetId: String(targetId), amount: Number(amount) }),
              status: (targetId, statusOrId, duration = 1) => {
                  const base = typeof statusOrId === 'object' && statusOrId !== null ? statusOrId : { id: String(statusOrId) };
                  emit("status", { targetId: String(targetId), status: { ...base, id: String(base.id), duration: base.duration !== undefined ? Number(base.duration) : Number(duration) } });
              },
              dispel: (targetId, status) => emit("dispel", { targetId: String(targetId), status: String(status) }),
              move: (targetId, x, y) => emit("move", { targetId: String(targetId), position: { x: Number(x), y: Number(y) } }),
              push: (targetId, dx, dy) => emit("push", { targetId: String(targetId), dx: Number(dx), dy: Number(dy) }),
              resource: (targetId, resource, delta) => emit("resource", { targetId: String(targetId), resource: String(resource), delta: Number(delta) }),
              modify: (targetId, field, delta, options = {}) => emit("modify", {
                  targetId: String(targetId),
                  field: String(field),
                  delta: Number(delta),
                  rounds: options && options.rounds !== undefined ? Math.max(0, Math.floor(Number(options.rounds))) : 0,
              }),
              summon: (templateId, zoneId, count = 1, x = null, y = null) => emit("summon", { templateId: String(templateId), zoneId: String(zoneId), count: Number(count), x: x === null ? null : Number(x), y: y === null ? null : Number(y) }),
              // 判定/检定：d100 + modifier vs dc，返回是否成功。决定性与战斗 RNG 同源
              // （沙箱内确定性随机），脚本据此分支（成功/失败的不同效果）。
              check: (options = {}) => {
                  const roll = 1 + Math.floor(rand() * 100);
                  const dc = Number(options && options.dc || 0);
                  const modifier = Number(options && options.modifier || 0);
                  const total = roll + modifier;
                  const label = String((options && options.label) || "检定");
                  emit("log", { message: label + "：" + roll + (modifier ? (modifier > 0 ? " + " + modifier : " - " + Math.abs(modifier)) : "") + " = " + total + " vs DC " + dc + " → " + (total >= dc ? "成功" : "失败") });
                  return total >= dc;
              },
              // 必中锁定：对目标附加"下一次受击必中"的锁定（带等级）。目标若拥有足够高
              // 的 lockImmunity 状态（免疫 D 级及以下等）则自动抵抗，不发锁定。
              lock: (targetId, options = {}) => emit("lock", {
                  targetId: String(targetId),
                  grade: String((options && options.grade) || "C"),
                  duration: options && options.duration !== undefined ? Math.max(1, Math.floor(Number(options.duration))) : 1,
                  name: String((options && options.name) || "必中锁定"),
              }),
              log: (message) => emit("log", { message: String(message) }),
              event: () => ({ type: input.event?.type || null, actor: input.actor || null, target: input.event?.target || null })
            });
            Math.random = undefined;
            (() => { ${source}\n })();
            JSON.stringify(effects);`;
        const result = vm.evalCode(wrapped, 'ability.js', { strict: true });
        if (result.error) {
            const detail = vm.dump(result.error); result.error.dispose();
            throw new Error(typeof detail === 'string' ? detail : detail?.message || '能力脚本执行失败');
        }
        const serialized = vm.dump(result.value); result.value.dispose();
        const effects = JSON.parse(serialized);
        return { inspection, effects };
    } finally { vm.dispose(); runtime.dispose(); }
}

export async function testScript(source, ability = {}) {
    const inspection = inspectScript(source, ability);
    const failures = [];
    for (let index = 0; index < 100; index += 1) {
        try {
            await runScript(source, { seedCase: index, ability, rng: { seed: `test-${index}`, count: 0 }, actor: { id: 'actor', side: 'player', hp: 100, ep: 100, position: { x: 0, y: 0 } }, targets: [{ id: 'target', side: 'enemy', hp: 100, position: { x: 5, y: 0 } }], units: [{ id: 'actor', side: 'player', hp: 100, position: { x: 0, y: 0 } }, { id: 'target', side: 'enemy', hp: 100, position: { x: 5, y: 0 } }], battlefield: { shape: 'rectangle', widthMeters: 60, heightMeters: 36 }, round: 1 });
        } catch (error) { failures.push({ seedCase: index, error: error.message }); if (failures.length >= 5) break; }
    }
    return { ...inspection, tests: 100, passed: failures.length === 0, failures };
}
