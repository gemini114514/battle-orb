import { sha256, RULESET_VERSION } from './util.js';

const MAX_SOURCE = 64 * 1024;
const MAX_EFFECTS = 64;
let quickJsPromise;

export function scriptHash(source) { return sha256(`${RULESET_VERSION}\n${String(source).trim().replace(/\r\n/g, '\n')}`); }

export function inspectScript(source, ability = {}) {
    const text = String(source || '');
    if (!text.trim()) throw new Error('脚本为空');
    const textSize = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
    if (textSize > MAX_SOURCE) throw new Error('脚本超过 64KB');
    const forbidden = /\b(?:fetch|XMLHttpRequest|WebSocket|require|process|Deno|Bun|importScripts|eval|Function)\b|\bimport\s*\(/;
    if (forbidden.test(text)) throw new Error('脚本请求了沙箱禁止能力');
    const capabilities = [...new Set([...text.matchAll(/api\.(damage|heal|status|move|resource|summon|dispel|log)\s*\(/g)].map(match => match[1]))];
    return { hash: scriptHash(text), rulesetVersion: RULESET_VERSION, ability: { id: ability.id, name: ability.name }, source: text, size: textSize, capabilities, limits: { executionMs: 25, memoryMb: 16, maxEffects: MAX_EFFECTS, triggerDepth: 8 } };
}

export async function runScript(source, input) {
    const inspection = inspectScript(source, input.ability);
    // The same engine module is shared with the Tavern browser extension. Do
    // not put quickjs-emscripten in the static import graph: Tavern loads
    // extension files directly and has no npm dependency directory there.
    // Browser-injected abilities are deliberately rejected; the Node harness
    // loads QuickJS lazily only when a scripted ability is actually tested.
    if (typeof window !== 'undefined' || typeof document !== 'undefined') {
        throw new Error('酒馆注入模式不执行脚本能力；请把该能力改写为本地规则能力后再开战');
    }
    quickJsPromise ||= import('quickjs-emscripten').then(module => module.getQuickJS());
    const QuickJS = await quickJsPromise;
    const runtime = QuickJS.newRuntime();
    runtime.setMemoryLimit(16 * 1024 * 1024);
    runtime.setMaxStackSize(512 * 1024);
    const deadline = Date.now() + 25;
    runtime.setInterruptHandler(() => Date.now() > deadline);
    const vm = runtime.newContext();
    try {
        const safeInput = JSON.stringify(input).replace(/</g, '\\u003c');
        const wrapped = `"use strict";
            const input = Object.freeze(${safeInput});
            const effects = [];
            const emit = (type, payload) => { if (effects.length >= ${MAX_EFFECTS}) throw new Error("效果数量超过限制"); effects.push({ type, ...payload }); };
            const api = Object.freeze({
              damage:(targetId,amount,damageType="physical")=>emit("damage",{targetId:String(targetId),amount:Number(amount),damageType:String(damageType)}),
              heal:(targetId,amount)=>emit("heal",{targetId:String(targetId),amount:Number(amount)}),
              status:(targetId,status,duration=1)=>emit("status",{targetId:String(targetId),status:String(status),duration:Number(duration)}),
              move:(targetId,x,y)=>emit("move",{targetId:String(targetId),position:{x:Number(x),y:Number(y)}}),
              resource:(targetId,resource,delta)=>emit("resource",{targetId:String(targetId),resource:String(resource),delta:Number(delta)}),
              summon:(templateId,zoneId,count=1)=>emit("summon",{templateId:String(templateId),zoneId:String(zoneId),count:Number(count)}),
              dispel:(targetId,status)=>emit("dispel",{targetId:String(targetId),status:String(status)}),
              log:(message)=>emit("log",{message:String(message)})
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
            await runScript(source, { seedCase: index, ability, actor: { id: 'actor', hp: 100, ep: 100 }, targets: [{ id: 'target', hp: 100 }], roll: (index * 37) % 100 + 1 });
        } catch (error) { failures.push({ seedCase: index, error: error.message }); if (failures.length >= 5) break; }
    }
    return { ...inspection, tests: 100, passed: failures.length === 0, failures };
}
