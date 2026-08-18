import { sha256 } from './util.js';

const MAX_ENTRIES = 256;
const MAX_BYTES = 128 * 1024;
const IMPORTANT_EVENTS = new Set(['combat_completed', 'combat_paused', 'combat_finalized', 'combat_abandoned', 'boss_phase_changed', 'unit_state_changed']);

function round(value) { return Math.round(Number(value || 0) * 10) / 10; }

export function appendFlowTrace(state, command = {}, events = [], benchmark = null) {
    const counts = Object.create(null);
    const important = [];
    for (const event of events) {
        counts[event.type] = (counts[event.type] || 0) + 1;
        if (IMPORTANT_EVENTS.has(event.type) && important.length < 12) important.push({ sequence: event.sequence, round: event.round, type: event.type, actorId: event.payload?.actorId || null, unitId: event.payload?.unitId || null });
    }
    const entry = {
        sequence: state.sequence, version: state.version, round: state.round,
        command: { type: command.type || null, actorId: command.actorId || null, targetCount: Array.isArray(command.targetIds) ? command.targetIds.length : 0, expectedVersion: command.expectedVersion ?? null },
        eventCount: events.length, eventTypes: counts, important,
        timing: benchmark ? Object.fromEntries(Object.entries(benchmark.spans || {}).map(([name, value]) => [name, { ms: round(value.totalMs), count: value.count || 0, maxMs: round(value.maxMs) }])) : {},
        status: state.status, pauseReason: state.pauseReason?.type || null, eventHash: state.lastEventHash || null,
    };
    const trace = Array.isArray(state.flowTrace) ? state.flowTrace : [];
    trace.push(entry);
    while (trace.length > MAX_ENTRIES || JSON.stringify(trace).length > MAX_BYTES) trace.shift();
    state.flowTrace = trace;
}

export function flowTrace(state) {
    const entries = Array.isArray(state?.flowTrace) ? state.flowTrace : [];
    return {
        format: 'reincarnation-combat-flow-trace', version: 1, battleId: state?.id || null,
        rulesetVersion: state?.rulesetVersion || null, seed: state?.seed || null,
        start: { initialHash: state?.initialHash || null, combatantCount: state?.combatants?.length || 0, initialCounts: state?.initialCounts || null },
        entries, final: { sequence: state?.sequence ?? null, version: state?.version ?? null, round: state?.round ?? null, status: state?.status || null, eventHash: state?.lastEventHash || null, stateHash: sha256({ version: state?.version, sequence: state?.sequence, round: state?.round, status: state?.status, eventHash: state?.lastEventHash }) },
    };
}
