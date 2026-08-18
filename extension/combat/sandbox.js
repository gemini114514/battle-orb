import { sha256, RULESET_VERSION } from './util.js';

const MAX_SOURCE = 64 * 1024;

// Script abilities remain visible in the model and are rejected explicitly in
// the browser extension.  The authoritative engine still supports the full
// QuickJS sandbox in the standalone regression harness; Tavern itself should
// never execute arbitrary card code just because a floor supplied it.
export function scriptHash(source) {
    return sha256(`${RULESET_VERSION}\n${String(source).trim().replace(/\r\n/g, '\n')}`);
}

export function inspectScript(source, ability = {}) {
    const text = String(source || '');
    const size = typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(text).length : text.length;
    if (!text.trim()) throw new Error('脚本为空');
    if (size > MAX_SOURCE) throw new Error('脚本超过 64KB');
    return { hash: scriptHash(text), rulesetVersion: RULESET_VERSION, ability: { id: ability.id, name: ability.name }, source: text, size, capabilities: [], limits: { executionMs: 0, memoryMb: 0, maxEffects: 0, triggerDepth: 0 } };
}

export async function runScript(source, input) {
    inspectScript(source, input?.ability);
    throw new Error('酒馆注入模式不执行脚本能力；请把该能力改写为本地规则能力后再开战');
}
