import express from 'express';
import { CombatEngine, httpError } from './engine.js';
import { CombatRepository } from './repository.js';
import { inspectScript, testScript } from './sandbox.js';
import { compileStrategy } from './strategy.js';
import { deepClone, sha256 } from './util.js';
import { validateBattleDeclaration, validateCombatModel } from './model.js';
import { appendFlowTrace, flowTrace } from './flow-trace.js';
import { buildBattleResultDsl } from './narrative-dsl.js';

export function createCombatRouter(root) {
    const router = express.Router();
    const repository = new CombatRepository(root);
    const engine = new CombatEngine(repository);
    const locks = new Map();
    const nowMs = () => Number(process.hrtime.bigint()) / 1e6;

    const locked = (id, run) => {
        const previous = locks.get(id) || Promise.resolve();
        const current = previous.catch(() => {}).then(run);
        const tracked = current.catch(() => {}).finally(() => { if (locks.get(id) === tracked) locks.delete(id); });
        locks.set(id, tracked);
        return current;
    };

    const get = id => {
        const state = repository.get(id);
        if (!state) throw httpError(404, '战斗不存在');
        // Hydrate legacy V1 rows at the repository boundary, then persist the
        // compatibility projection immediately.  Otherwise a GET response
        // could look correct in memory while every later request reloaded the
        // same empty spatial state from SQLite.
        engine.hydrateLegacyState(state);
        state.pendingEvents = [];
        if (state.compatibilityDebug?.applied) repository.save(state);
        return state;
    };

    const commit = (state, command = {}, commandId = null) => {
        state.version += 1;
        const events = state.pendingEvents.splice(0);
        const benchmark = state.__combatBenchmark;
        const publicStateStartedAt = benchmark ? nowMs() : 0;
        const result = engine.publicState(state);
        if (benchmark) {
            const publicStateMs = nowMs() - publicStateStartedAt;
            benchmark.spans['response.public-state'] = { totalMs: publicStateMs, count: 1, maxMs: publicStateMs };
        }
        const persistStartedAt = benchmark ? nowMs() : 0;
        appendFlowTrace(state, command, events, benchmark);
        repository.commit(state, events, commandId, result, benchmark);
        if (benchmark) {
            const persistMs = nowMs() - persistStartedAt;
            benchmark.spans['response.persist'] = { totalMs: persistMs, count: 1, maxMs: persistMs };
        }
        return result;
    };

    const mutate = (handler, { allowCompleted = false } = {}) => async (req, res, next) => {
        const startedAt = nowMs();
        try {
            const result = await locked(req.params.id, async () => {
                const lockedAt = nowMs();
                const commandId = req.body.commandId || null;
                if (commandId) {
                    const cached = repository.command(req.params.id, commandId);
                    if (cached) return cached;
                }
                const state = get(req.params.id);
                Object.defineProperty(state, '__combatBenchmark', { value: { spans: Object.create(null) }, configurable: true });
                if (allowCompleted) {
                    if (req.body.expectedVersion !== undefined && Number(req.body.expectedVersion) !== state.version) throw httpError(409, `状态版本冲突：当前为 ${state.version}`);
                } else engine.assertWritable(state, req.body.expectedVersion);
                await handler(state, req.body, req);
                const committed = commit(state, req.body, commandId);
                committed.__benchmark = {
                    handlerMs: Math.round((nowMs() - lockedAt) * 10) / 10,
                    spans: state.__combatBenchmark.spans,
                };
                return committed;
            });
            const benchmark = result.__benchmark || {};
            delete result.__benchmark;
            const timing = Object.entries(benchmark.spans || {})
                .map(([name, value]) => `${name};dur=${Number(value.totalMs || 0).toFixed(1)};desc="count=${value.count || 0},max=${Number(value.maxMs || 0).toFixed(1)}ms"`)
                .join(', ');
            res.setHeader('Server-Timing', [`combat-action;dur=${(nowMs() - startedAt).toFixed(1)}`, `combat-handler;dur=${Number(benchmark.handlerMs || 0).toFixed(1)}`, timing].filter(Boolean).join(', '));
            res.json(result);
        } catch (error) { next(error); }
    };

    router.post('/sessions', (req, res, next) => {
        try { res.status(201).json(engine.create(req.body)); } catch (error) { next(error); }
    });
    router.post('/declaration/validate', (req, res, next) => {
        try { res.json(validateBattleDeclaration(req.body?.declaration, { strict: Boolean(req.body?.strict) })); } catch (error) { next(error); }
    });
    router.post('/model/validate', (req, res, next) => {
        try { res.json(validateCombatModel(req.body?.model, { declaration: req.body?.declaration, requiredAssets: req.body?.requiredAssets || [], strict: Boolean(req.body?.strict) })); } catch (error) { next(error); }
    });
    router.get('/assets/:assetId', (req, res, next) => {
        try { const profile = repository.assetProfile(req.params.assetId); if (!profile) throw httpError(404, '战斗资料不存在'); res.json(profile); } catch (error) { next(error); }
    });
    router.get('/:id/debug', (req, res, next) => {
        try {
            // Read a pristine copy first so this endpoint can distinguish the
            // persisted legacy shape from the hydrated projection returned to
            // the client. `get()` intentionally migrates and saves the row.
            const persisted = repository.get(req.params.id);
            if (!persisted) throw httpError(404, '战斗不存在');
            const summarize = state => ({
                id: state.id, status: state.status, version: state.version, rulesetVersion: state.rulesetVersion,
                hasBattlefield: Boolean(state.battlefield), battlefield: state.battlefield ? { shape: state.battlefield.shape, widthMeters: state.battlefield.widthMeters, heightMeters: state.battlefield.heightMeters, radiusMeters: state.battlefield.radiusMeters, center: state.battlefield.center } : null,
                zoneCount: Array.isArray(state.zones) ? state.zones.length : 0, combatantCount: Array.isArray(state.combatants) ? state.combatants.length : 0,
                protocol: { schema: state.schema || null, worldLifeLevel: state.worldLifeLevel || null, contactEstablished: state.contactEstablished === true, contactPairs: state.contactPairs || [] },
                authority: (state.combatants || []).map(unit => ({ id: unit.id, declarationId: unit.declarationId || null, side: unit.side, lifeLevel: unit.lifeLevel || null, attributeQualities: unit.attributeQualities || null, assetBindings: unit.assetBindings || [], provenance: unit.combatProvenance || null })),
                missingPositions: (state.combatants || []).filter(unit => !Number.isFinite(Number(unit.position?.x)) || !Number.isFinite(Number(unit.position?.y))).length,
            });
            const raw = summarize(persisted);
            const state = get(req.params.id);
            const projected = engine.publicState(state);
            const primaryPlayer = projected.combatants?.find(unit => unit.side === 'player');
            const enemyAwareness = (projected.combatants || []).filter(unit => unit.side === 'enemy').map(unit => ({ id: unit.id, awareness: projected.intel?.knowledge?.[unit.id]?.[primaryPlayer?.id]?.awareness || 'unaware', source: projected.intel?.knowledge?.[unit.id]?.[primaryPlayer?.id]?.source || null })).reduce((out, item) => ({ ...out, [item.awareness]: (out[item.awareness] || 0) + 1 }), {});
            res.json({ format: 'combat-load-debug', raw, projected: { hasBattlefield: Boolean(projected.battlefield), battlefield: projected.battlefield, zoneCount: projected.zones?.length || 0, combatantCount: projected.combatants?.length || 0, missingPositions: projected.combatants?.filter(unit => !Number.isFinite(Number(unit.position?.x)) || !Number.isFinite(Number(unit.position?.y))).length || 0, activation: projected.intel?.activation || {}, enemyAwareness, playerProvenance: primaryPlayer?.combatProvenance || null, playerCombatPanel: primaryPlayer ? { hp: primaryPlayer.hp, maxHp: primaryPlayer.maxHp, ep: primaryPlayer.ep, maxEp: primaryPlayer.maxEp, attack: primaryPlayer.attack, magicAttack: primaryPlayer.magicAttack, armor: primaryPlayer.armor, resistance: primaryPlayer.resistance, attributes: primaryPlayer.attributes } : null }, hydration: projected.compatibilityDebug || null, persistedAfter: summarize(repository.get(req.params.id)) });
        } catch (error) { next(error); }
    });
    router.get('/:id', (req, res, next) => {
        const startedAt = nowMs();
        try {
            const state = get(req.params.id);
            const publicState = engine.publicState(state);
            const stateMs = nowMs() - startedAt;
            res.setHeader('Server-Timing', `combat-state;dur=${stateMs.toFixed(1)}`);
            res.json(publicState);
        } catch (error) { next(error); }
    });
    router.get('/:id/events', (req, res, next) => {
        const startedAt = nowMs();
        try {
            get(req.params.id);
            const limit = Math.max(0, Math.min(1000, Number(req.query.limit) || 0));
            const events = repository.events(req.params.id, req.query.after, { limit, tail: req.query.tail === '1' });
            res.setHeader('Server-Timing', `combat-events;dur=${(nowMs() - startedAt).toFixed(1)}`);
            res.json({ events });
        } catch (error) { next(error); }
    });
    router.get('/:id/replay', (req, res, next) => {
        try {
            const state = get(req.params.id); const events = repository.events(state.id);
            res.json({ format: 'vibe-combat-replay', version: 1, battleId: state.id, rulesetVersion: state.rulesetVersion, seed: state.seed, initialSnapshot: state.initialSnapshot, initialHash: state.initialHash, events, finalResult: state.finalResult, replayHash: sha256({ initial: state.initialHash, events: events.map(event => event.hash), final: state.finalResult }) });
        } catch (error) { next(error); }
    });
    router.get('/:id/flow-trace', (req, res, next) => {
        try { res.json(flowTrace(get(req.params.id))); } catch (error) { next(error); }
    });
    router.post('/:id/strategy/compile', mutate((state, body) => {
        state.strategy = compileStrategy(body.text, body);
        if (body.assignments && typeof body.assignments === 'object' && !Array.isArray(body.assignments)) {
            state.strategy.assignments = Object.fromEntries(Object.entries(body.assignments).map(([unitId, assignment]) => {
                const value = assignment && typeof assignment === 'object' ? assignment : { text: assignment };
                return [String(unitId), { ...compileStrategy(value.text || '', { ...body, confirmed: true }), presetId: value.presetId || null }];
            }));
        }
        if (body.mode) engine.setMode(state, body.mode);
        engine.event(state, 'strategy_compiled', { strategy: state.strategy });
    }));
    router.post('/:id/scripts/inspect', async (req, res, next) => { try { get(req.params.id); res.json(await testScript(req.body.source, req.body.ability)); } catch (error) { next(error); } });
    router.post('/:id/scripts/:hash/approve', mutate((state, body, req) => {
        const inspection = inspectScript(body.source, body.ability);
        if (inspection.hash !== req.params.hash) throw httpError(400, '脚本哈希与源码不一致');
        repository.approveScript(inspection.hash, state.rulesetVersion, { inspection, source: body.source });
        if (!state.approvedScripts.includes(inspection.hash)) state.approvedScripts.push(inspection.hash);
        state.status = 'ready'; state.pauseReason = null; engine.event(state, 'script_approved', { hash: inspection.hash, ability: body.ability });
    }));
    router.post('/:id/start', mutate(async (state, body) => { if (body.mode) engine.setMode(state, body.mode); await engine.start(state); }));
    router.post('/:id/redo', mutate(async (state, body) => {
        const history = Array.isArray(state.commandHistory) ? state.commandHistory : [];
        const last = history.at(-1);
        if (!last) throw httpError(409, '没有可重做的玩家行动');
        const command = { ...deepClone(last), expectedVersion: state.version, commandId: body.commandId, redo: true };
        await engine.command(state, command);
        engine.event(state, 'command_redone', { actorId: command.actorId, type: command.type, abilityId: command.abilityId || null, targetIds: command.targetIds || [], recordedRound: last.recordedAtRound ?? null });
    }));
    router.post('/:id/commands', mutate(async (state, body) => body.type === 'script' ? engine.scriptCommand(state, body) : engine.command(state, body)));
    router.post('/:id/reactions', mutate(async (state, body) => engine.reaction(state, body)));
    router.post('/:id/advance', mutate(async (state, body) => {
        if (body.mode) engine.setMode(state, body.mode);
        if (state.status === 'paused') { state.status = 'running'; state.pauseReason = null; }
        await engine.advanceUntilPause(state, Math.min(10000, Math.max(1, Number(body.maxActions) || 1000)));
    }));
    router.post('/:id/control', mutate((state, body) => { if (body.mode) engine.setMode(state, body.mode); if (body.unitId) engine.setControl(state, body); }));
router.post('/:id/participants', mutate((state, body) => engine.setParticipate(state, body)));
    router.post('/:id/pause', mutate((state, body) => engine.pause(state, { type: 'user', note: body.note || '' })));
    router.post('/:id/resume', mutate(async state => engine.resume(state)));
    router.post('/:id/finalize', mutate(state => {
        if (state.status !== 'completed') throw httpError(409, '只有已完成战斗可以结算');
        if (!state.finalizedAt) {
            state.finalizedAt = new Date().toISOString();
            engine.event(state, 'combat_finalized', { resultHash: sha256(state.finalResult) });
            // Finalization itself is part of the append-only ledger. Keep the
            // result pointer aligned with that terminal event so replay/debug
            // consumers do not report a false hash mismatch after closing a
            // completed battle.
            state.finalResult.eventHash = state.lastEventHash;
        }
    }, { allowCompleted: true }));
    router.post('/:id/abandon', mutate((state, body) => { state.status = 'abandoned'; state.pauseReason = { type: 'abandoned', note: body.note || '' }; engine.event(state, 'combat_abandoned', state.pauseReason); }));
    router.get('/:id/narrative-bundle', (req, res, next) => {
        try {
            const state = get(req.params.id);
            if (!state.finalResult && state.status !== 'paused') throw httpError(409, '尚无正式暂停点或最终战果');
            const events = repository.events(state.id);
            const final = state.finalResult || { winner: null, rounds: state.round, mvuPatch: [], checkResults: [], casualties: [], finalState: { combatants: deepClone(state.combatants), battlefield: deepClone(state.battlefield) } };
            const units = final.finalState?.combatants || state.combatants;
            const anchors = engine.buildNarrativeAnchors(events);
            const battleDsl = buildBattleResultDsl({ state, events, final });
            const bundle = {
                schema: 'vibe-combat-result-outline/v3', battleId: state.id, title: state.title, paused: !state.finalResult,
                pauseReason: state.finalResult ? null : state.pauseReason, winner: final.winner, rounds: final.rounds ?? state.round,
                battlefield: final.finalState?.battlefield || state.battlefield,
                participants: units.map(unit => ({ id: unit.id, name: unit.name, side: unit.side, status: unit.status, hp: unit.hp, maxHp: unit.maxHp, ep: unit.ep, maxEp: unit.maxEp, position: unit.position })),
                casualties: final.casualties || [], checks: final.checkResults || [], keyEvents: anchors.slice(-18), battleDsl,
                mvuPatch: final.mvuPatch || [], seed: state.seed, eventHash: events.at(-1)?.hash
            };
            res.json({ bundle, systemPrompt: '你是《轮回战场》的战斗叙事融合器。只能依据 BattleResultOutline 与 battleDsl 写连贯、清晰的中文战斗剧情。battleDsl 是逐事件的本地裁定记录，必须保留交战顺序、攻击双方、命中/未命中、伤害、状态变化、击倒与击杀因果，不得把一次攻击写成多次，也不得遗漏关键击杀。不得修改其中的命中、伤害、死亡、资源、位置或胜负；只补足感官、动作与因果连接。不要输出 UpdateVariable。', userPrompt: `请将以下本地权威战斗剧情大纲融合为完整剧情。优先逐行阅读 battleDsl，再用其他字段补充战场和最终状态：\n${JSON.stringify(bundle)}` });
        } catch (error) { next(error); }
    });

    router.use((error, req, res, _next) => {
        const debug = { requestId: `combat-error-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, at: new Date().toISOString(), method: req.method, path: req.originalUrl, status: error.status || 500, error: { name: error.name || 'Error', message: error.message, stack: error.stack || null, details: error.details || null } };
        console.error(`[combat][request-error] ${JSON.stringify(debug)}`);
        res.status(error.status || 500).json({ error: error.message, debug });
    });
    return { router, repository, engine };
}
