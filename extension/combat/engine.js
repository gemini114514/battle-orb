import { aggregateCohorts, alliesOf, applyDamage, centerDistance, damageValue, edgeDistance, effectiveSpeed, enemiesOf, entityRadiusMeters, evasionAttacks, exertionMaximum, isMeleeAbility, living, normalizeAttributes, normalizeEncounter, normalizeIntelProfile, normalizePassives, normalizeTacticalProfile, positionInsideBattlefield, rangeLegal, sprintMeters, tacticalGroupKey, targetCostMultiplier, validateSpatialEncounter, withdrawMeters } from './rules.js';
import { evaluateTriggers } from './strategy.js';
import { inspectScript, runScript, scriptHash } from './sandbox.js';
import { canonical, deepClone, DeterministicRng, makeId, RULESET_VERSION, seed256, sha256 } from './util.js';

const MODES = new Set(['manual', 'semi', 'auto']);
const sideIndexCache = new WeakMap();
const AWARENESS_RANK = Object.freeze({ unaware: 0, suspicious: 1, tracking: 2, engaged: 3 });
const clockMs = () => globalThis.process?.hrtime?.bigint ? Number(globalThis.process.hrtime.bigint()) / 1e6 : globalThis.performance?.now?.() || Date.now();

export class CombatEngine {
    constructor(repository) { this.repository = repository; }

    benchmarkStart(state) {
        const benchmark = state?.__combatBenchmark;
        return benchmark ? clockMs() : 0;
    }

    benchmarkEnd(state, name, startedAt) {
        const benchmark = state?.__combatBenchmark;
        if (!benchmark || !startedAt) return;
        const duration = clockMs() - startedAt;
        const item = benchmark.spans[name] ||= { totalMs: 0, count: 0, maxMs: 0 };
        item.totalMs += duration;
        item.count += 1;
        item.maxMs = Math.max(item.maxMs, duration);
    }

    benchmarkMeasure(state, name, work) {
        const startedAt = this.benchmarkStart(state);
        try { return work(); }
        finally { this.benchmarkEnd(state, name, startedAt); }
    }

    async benchmarkMeasureAsync(state, name, work) {
        const startedAt = this.benchmarkStart(state);
        try { return await work(); }
        finally { this.benchmarkEnd(state, name, startedAt); }
    }

    create(input = {}) {
        const encounterInput = input.encounter || input;
        const encounter = normalizeEncounter(encounterInput);
        validateSpatialEncounter(encounter);
        const seed = seed256(input.seed);
        const state = {
            id: makeId('battle-'), storySessionId: input.storySessionId || null, rulesetVersion: RULESET_VERSION,
            transient: Boolean(input.transient), simulation: input.simulation ? deepClone(input.simulation) : null,
            status: 'draft', version: 1, sequence: 0, seed, rng: new DeterministicRng(seed).snapshot(), mode: MODES.has(input.mode) ? input.mode : 'manual',
            lastEventHash: null,
            playerId: input.playerId || 'local-player', seatId: input.seatId || 'seat-1', title: encounter.title, location: encounter.location, description: encounter.description,
            zones: encounter.zones, battlefield: encounter.battlefield, combatants: encounter.combatants, assetProfiles: Array.isArray(input.assetProfiles) ? deepClone(input.assetProfiles) : Array.isArray(encounterInput.assetProfiles) ? deepClone(encounterInput.assetProfiles) : [], preparation: input.preparation ? deepClone(input.preparation) : null, initialSnapshot: null, initialHash: null,
            initialCounts: { player: encounter.combatants.filter(unit => unit.side === 'player').length, enemy: encounter.combatants.filter(unit => unit.side === 'enemy').length },
            round: 0, initiative: [], cursor: 0, activeUnitId: null, strategy: null, pendingReaction: null, pauseReason: null,
            intel: { knowledge: {}, noise: [], decoys: [], visibleToPlayer: [], lastKnownPositions: {}, activation: { unaware: 0, suspicious: 0, tracking: 0, engaged: 0 } },
            contactEstablished: encounter.contactEstablished === true,
            contactPairs: deepClone(encounter.contactPairs || []),
            worldLifeLevel: encounter.worldLifeLevel || null,
            schema: encounter.schema || null,
            meleeSlots: { round: 0, targets: {} },
            flags: {}, noChangeRounds: 0, lastProgressHash: null, approvedScripts: [], commandHistory: [], finalResult: null, pendingEvents: [], createdAt: new Date().toISOString(),
        };
        this.ensureTacticalState(state);
        state.initialSnapshot = deepClone({ battlefield: state.battlefield, zones: state.zones, combatants: state.combatants, assetProfiles: state.assetProfiles, intel: state.intel, contactEstablished: state.contactEstablished, contactPairs: state.contactPairs, worldLifeLevel: state.worldLifeLevel, schema: state.schema, meleeSlots: state.meleeSlots });
        for (const profile of state.assetProfiles) this.repository.saveAssetProfile?.(profile);
        state.initialHash = sha256(state.initialSnapshot);
        this.event(state, 'combat_created', {
            title: state.title,
            mode: state.mode,
            seed: state.seed,
            initialHash: state.initialHash,
            protocol: { schema: state.schema, worldLifeLevel: state.worldLifeLevel, contactEstablished: state.contactEstablished, contactPairs: state.contactPairs },
            combatantAuthority: state.combatants.map(unit => ({ unitId: unit.id, declarationId: unit.declarationId || null, side: unit.side, lifeLevel: unit.lifeLevel || null, attributeQualities: unit.attributeQualities || null, assetBindings: unit.assetBindings || [], provenance: unit.combatProvenance || null })),
            authoritativePlayers: state.combatants.filter(unit => unit.side === 'player').map(unit => ({
                unitId: unit.id,
                attack: unit.attack,
                magicAttack: unit.magicAttack,
                armor: unit.armor,
                resistance: unit.resistance,
                provenance: unit.combatProvenance || null,
            })),
        });
        const pending = state.pendingEvents.splice(0);
        this.repository.create(state);
        for (const event of pending) this.repository.appendEvent(state.id, event);
        return this.publicState(state);
    }

    publicState(state) {
        this.hydrateLegacyState(state);
        const value = deepClone(state);
        delete value.pendingEvents;
        delete value.flowTrace;
        const blockersByActor = Object.fromEntries((state.combatants || []).filter(living).map(unit => [unit.id, this.adjacentOpponents(state, unit).map(other => other.id)]).filter(([, ids]) => ids.length));
        const active = state.combatants?.find(unit => unit.id === state.activeUnitId);
        const activeBlockers = active ? (blockersByActor[active.id] || []) : [];
        value.movementBlockers = {
            actorId: active?.id || null, unitIds: activeBlockers, byActor: blockersByActor,
            diagnostics: active ? activeBlockers.map(id => {
                const blocker = state.combatants.find(unit => unit.id === id);
                return { blockerId: id, blockerToActor: this.meleeBlockProfile(blocker, active), actorToBlocker: this.meleeBlockProfile(active, blocker) };
            }) : [],
        };
        // `pauseReason` is persisted with the state, but its legal target IDs
        // are spatial and can become stale after loading an older battle or
        // after a state migration. Re-project manual actions from the current
        // positions so the client can attack a blocker that is actually in
        // contact instead of hiding it behind an old empty target list.
        if (value.pauseReason?.type === 'manual_turn' && active?.id === value.pauseReason.unitId) {
            value.pauseReason.legalActions = this.legalActions(state, active);
        }
        value.cohorts = aggregateCohorts(value.combatants);
        value.eventHash = state.lastEventHash || null;
        return value;
    }

    hydrateLegacyState(state) {
        if (!state || !Array.isArray(state.combatants)) return state;
        const initialSnapshotNeedsSpatial = Boolean(state.initialSnapshot && Array.isArray(state.initialSnapshot.combatants) && (!state.initialSnapshot.battlefield || state.initialSnapshot.combatants.some(unit => !Number.isFinite(Number(unit.position?.x)) || !Number.isFinite(Number(unit.position?.y)))));
        if (state.compatibilityDebug?.kind === 'combat_state_hydration' && state.compatibilityDebug.after?.combatantCount === state.combatants.length && !initialSnapshotNeedsSpatial) return state;
        const before = {
            hasBattlefield: Boolean(state.battlefield),
            battlefieldShape: state.battlefield?.shape || null,
            hasZones: Array.isArray(state.zones) && state.zones.length > 0,
            combatantCount: state.combatants.length,
            missingPositions: state.combatants.filter(unit => !Number.isFinite(Number(unit.position?.x)) || !Number.isFinite(Number(unit.position?.y))).length,
            missingAbilities: state.combatants.filter(unit => !Array.isArray(unit.abilities) || !unit.abilities.length).length,
        };
        let changed = false;
        // V1 sessions persisted zones and unit records but had no continuous
        // battlefield.  Keep those records playable by projecting them onto a
        // deterministic rectangle; this is a compatibility projection, not a
        // new combat result or a silent balance change.
        if (!state.battlefield || !['rectangle', 'circle'].includes(state.battlefield.shape)) {
            state.battlefield = { shape: 'rectangle', name: state.location || '兼容二维战场', widthMeters: 160, heightMeters: 80, center: { x: 0, y: 0 } };
            changed = true;
        }
        if (state.battlefield.shape === 'rectangle') {
            if (!Number.isFinite(Number(state.battlefield.widthMeters))) { state.battlefield.widthMeters = 160; changed = true; }
            if (!Number.isFinite(Number(state.battlefield.heightMeters))) { state.battlefield.heightMeters = 80; changed = true; }
            state.battlefield.center = { x: Number(state.battlefield.center?.x) || 0, y: Number(state.battlefield.center?.y) || 0 };
        } else {
            if (!Number.isFinite(Number(state.battlefield.radiusMeters))) { state.battlefield.radiusMeters = 40; changed = true; }
            state.battlefield.center = { x: Number(state.battlefield.center?.x) || 0, y: Number(state.battlefield.center?.y) || 0 };
        }
        if (!Array.isArray(state.zones) || !state.zones.length) { state.zones = [{ id: 'field', name: state.battlefield.name || '战场', adjacent: [], capacity: 1000, narrow: false, cover: 0, blocked: false, hazard: null }]; changed = true; }
        const occupied = [];
        const validPoint = position => Number.isFinite(Number(position?.x)) && Number.isFinite(Number(position?.y));
        const place = (unit, index) => {
            if (validPoint(unit.position)) return { x: Number(unit.position.x), y: Number(unit.position.y) };
            const enemy = unit.side === 'enemy';
            const row = Math.floor(index / 8), column = index % 8;
            return { x: enemy ? 22 + column * 2.2 : -22 - column * 2.2, y: (row - 1.5) * 2.2 };
        };
        state.combatants.forEach((unit, index) => {
            const position = place(unit, index);
            if (unit.position?.x !== position.x || unit.position?.y !== position.y) changed = true;
            unit.position = position;
            const defaults = { radiusMeters: .5, speedMeters: 6, baseSpeedMeters: Number(unit.speedMeters) || 6, visionMeters: 30, fovDegrees: 120, facingDegrees: unit.side === 'enemy' ? 180 : 0, thp: 0, maxEp: Number(unit.ep) || 0 };
            for (const [key, fallback] of Object.entries(defaults)) if (!Number.isFinite(Number(unit[key]))) { unit[key] = fallback; changed = true; }
            // Never rewrite an explicit combat value during hydration. This
            // path only repairs missing spatial fields for legacy saves.
            const normalizedRadius = entityRadiusMeters(unit);
            if (unit.radiusMeters !== normalizedRadius) { unit.radiusMeters = normalizedRadius; changed = true; }
            if (!Number.isFinite(Number(unit.maxHp))) { unit.maxHp = Math.max(1, Number(unit.hp) || 20); changed = true; }
            if (!Number.isFinite(Number(unit.hp))) { unit.hp = unit.maxHp; changed = true; } else unit.hp = Math.max(0, Math.min(unit.maxHp, Number(unit.hp)));
            if (!Number.isFinite(Number(unit.ep))) { unit.ep = unit.maxEp; changed = true; } else unit.ep = Math.max(0, Math.min(unit.maxEp, Number(unit.ep)));
            if (!Array.isArray(unit.statuses)) { unit.statuses = []; changed = true; }
            if (!unit.cooldowns || typeof unit.cooldowns !== 'object') { unit.cooldowns = {}; changed = true; }
            if (!Array.isArray(unit.abilities) || !unit.abilities.length) { unit.abilities = [{ id: 'basic-attack', name: '基础攻击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false, script: null }]; changed = true; }
            const normalizedPassives = normalizePassives(unit.passives, unit.abilities);
            if (JSON.stringify(normalizedPassives) !== JSON.stringify(unit.passives || [])) { unit.passives = normalizedPassives; changed = true; }
            if (!unit.state) { unit.state = Number(unit.hp) <= 0 ? 'dying' : 'active'; changed = true; }
            occupied.push(unit.position);
        });
        // Legacy saves created before V2 carried an initialSnapshot whose
        // combatants had no spatial fields.  Keep the replay/settlement
        // baseline usable by projecting that snapshot with the same stable
        // placement rule, without replacing the current (possibly moved)
        // combatants with their initial positions.
        if (state.initialSnapshot && Array.isArray(state.initialSnapshot.combatants)) {
            const snapshotNeedsSpatial = !state.initialSnapshot.battlefield || state.initialSnapshot.combatants.some(unit => !validPoint(unit.position));
            if (snapshotNeedsSpatial) {
                state.initialSnapshot.battlefield = deepClone(state.battlefield);
                state.initialSnapshot.zones = deepClone(state.zones);
                state.initialSnapshot.combatants = state.initialSnapshot.combatants.map((unit, index) => {
                    const copy = deepClone(unit);
                    if (!validPoint(copy.position)) copy.position = place(copy, index);
                    if (!Number.isFinite(Number(copy.radiusMeters))) copy.radiusMeters = .5;
                    if (!Number.isFinite(Number(copy.maxHp))) copy.maxHp = Math.max(1, Number(copy.hp) || 20);
                    if (!Number.isFinite(Number(copy.hp))) copy.hp = copy.maxHp;
                    copy.hp = Math.max(0, Math.min(copy.maxHp, Number(copy.hp)));
                    copy.state ||= copy.hp <= 0 ? 'dying' : 'active';
                    return copy;
                });
                state.initialSnapshot.assetProfiles ||= deepClone(state.assetProfiles || []);
                state.initialSnapshot.intel ||= { knowledge: {}, noise: [], visibleToPlayer: [], lastKnownPositions: {} };
                state.initialSnapshot.meleeSlots ||= { round: state.round || 0, targets: {} };
                state.initialHash = sha256(state.initialSnapshot);
                changed = true;
            }
        }
        const after = {
            hasBattlefield: Boolean(state.battlefield),
            battlefieldShape: state.battlefield?.shape || null,
            field: state.battlefield?.shape === 'circle' ? { radiusMeters: state.battlefield.radiusMeters, center: state.battlefield.center } : { widthMeters: state.battlefield?.widthMeters, heightMeters: state.battlefield?.heightMeters, center: state.battlefield?.center },
            hasZones: Array.isArray(state.zones) && state.zones.length > 0,
            combatantCount: state.combatants.length,
            missingPositions: state.combatants.filter(unit => !Number.isFinite(Number(unit.position?.x)) || !Number.isFinite(Number(unit.position?.y))).length,
        };
        state.compatibilityDebug = { kind: 'combat_state_hydration', battleId: state.id || null, applied: changed, reason: changed ? 'legacy_or_incomplete_spatial_state' : 'v2_spatial_state_present', before, after, at: new Date().toISOString() };
        if (changed) console.warn('[combat][legacy-hydrate]', JSON.stringify(state.compatibilityDebug));
        return state;
    }

    event(state, type, payload = {}) {
        const previousHash = state.lastEventHash || 'GENESIS';
        const body = { battleId: state.id, sequence: ++state.sequence, timestamp: new Date().toISOString(), round: state.round, type, payload };
        const deterministicBody = { sequence: body.sequence, round: body.round, type, payload };
        const event = { ...body, previousHash, hash: sha256(`${previousHash}\n${canonical(deterministicBody)}`) };
        state.lastEventHash = event.hash;
        state.pendingEvents.push(event);
        return event;
    }

    ensureTacticalState(state) {
        this.hydrateLegacyState(state);
        state.intel ||= { knowledge: {}, noise: [], decoys: [], visibleToPlayer: [], lastKnownPositions: {}, activation: {} };
        state.intel.knowledge ||= {}; state.intel.noise ||= []; state.intel.decoys ||= []; state.intel.visibleToPlayer ||= []; state.intel.lastKnownPositions ||= {}; state.intel.activation ||= {};
        state.meleeSlots ||= { round: state.round || 0, targets: {} }; state.meleeSlots.targets ||= {};
        state.commandHistory ||= [];
        state.flowTrace ||= [];
        for (const unit of state.combatants) {
            unit.attributes ||= normalizeAttributes(unit);
            unit.intelProfile ||= normalizeIntelProfile(unit);
            unit.tacticalProfile ||= normalizeTacticalProfile(unit);
            unit.baseSpeedMeters = Number.isFinite(Number(unit.baseSpeedMeters)) ? Number(unit.baseSpeedMeters) : Number(unit.speedMeters || 6);
            unit.speedMeters = unit.baseSpeedMeters;
            unit.fovDegrees = Number.isFinite(Number(unit.fovDegrees)) ? Number(unit.fovDegrees) : 120;
            unit.maxExertion = Number.isFinite(Number(unit.maxExertion)) ? Number(unit.maxExertion) : exertionMaximum(unit);
            unit.exertion = Math.max(0, Math.min(unit.maxExertion, Number.isFinite(Number(unit.exertion)) ? Number(unit.exertion) : unit.maxExertion));
            unit.homePosition ||= { ...unit.position };
            unit.passives = normalizePassives(unit.passives, unit.abilities);
            state.intel.knowledge[unit.id] ||= {};
        }
        const sideIndexKey = state.combatants.map(unit => `${unit.id}:${unit.side}`).join('|');
        const cached = sideIndexCache.get(state);
        if (!cached || cached.key !== sideIndexKey) {
            const index = { player: [], enemy: [], neutral: [] };
            for (const unit of state.combatants) (index[unit.side] ||= []).push(unit);
            sideIndexCache.set(state, { key: sideIndexKey, index });
        }
    }

    isOpposed(observer, target) { return observer?.side !== target?.side && observer?.side !== 'neutral' && target?.side !== 'neutral'; }

    knowledge(state, observerId, targetId) {
        this.ensureTacticalState(state);
        return state.intel.knowledge[observerId]?.[targetId] || null;
    }

    awareness(entry) { return entry?.awareness || (entry?.canTarget ? 'tracking' : entry ? 'suspicious' : 'unaware'); }
    awarenessRank(entry) { return AWARENESS_RANK[this.awareness(entry)] ?? 0; }
    isTracking(entry) { return this.awarenessRank(entry) >= AWARENESS_RANK.tracking; }
    isEngaged(entry) { return this.awareness(entry) === 'engaged'; }

    facingDelta(observer, target) {
        const angle = Math.atan2(Number(target.position?.y || 0) - Number(observer.position?.y || 0), Number(target.position?.x || 0) - Number(observer.position?.x || 0)) * 180 / Math.PI;
        const raw = ((angle - Number(observer.facingDegrees || 0) + 540) % 360) - 180;
        return Math.abs(raw);
    }

    inVisualField(observer, target) {
        const distance = centerDistance(observer, target);
        if (distance <= 2 + 1e-6) return true;
        if (distance > Number(observer.visionMeters || 0) + 1e-6) return false;
        return this.facingDelta(observer, target) <= Number(observer.fovDegrees || 120) / 2 + 1e-6;
    }

    movementRemaining(state, actor) {
        const budget = state.turnBudget?.[actor.id] || {};
        return Math.max(0, Number(budget.movementMeters ?? (budget.movement ? effectiveSpeed(actor) : 0)) || 0);
    }

    consumeMovement(state, actor, meters) {
        const budget = state.turnBudget[actor.id] ||= { movement: 1, movementMeters: effectiveSpeed(actor), main: 1, minor: 1, movedMeters: 0, spentExertion: false };
        budget.movementMeters = Math.max(0, Number(budget.movementMeters ?? effectiveSpeed(actor)) - Math.max(0, Number(meters) || 0));
        budget.movedMeters = Number(budget.movedMeters || 0) + Math.max(0, Number(meters) || 0);
        budget.movement = budget.movementMeters > 1e-6 ? 1 : 0;
        return budget.movementMeters;
    }

    changeExertion(state, actor, delta, reason) {
        const before = Number(actor.exertion || 0);
        actor.exertion = Math.max(0, Math.min(Number(actor.maxExertion || exertionMaximum(actor)), before + Number(delta || 0)));
        if (actor.exertion !== before) this.event(state, 'exertion_changed', { actorId: actor.id, before, after: actor.exertion, delta: actor.exertion - before, reason });
        return actor.exertion;
    }

    canTarget(state, observer, target) {
        if (!this.isOpposed(observer, target)) return true;
        // Physical melee contact is also discovery. A unit cannot block a
        // player's movement through a mutual melee relationship and still be
        // treated as an unknown target when the attack command is resolved.
        if (this.meleeBlockRange(observer, target) && this.meleeBlockRange(target, observer)) return living(target);
        const entry = this.knowledge(state, observer.id, target.id);
        return Boolean(this.isTracking(entry) && living(target));
    }

    isStealthed(unit) {
        return Boolean(unit?.statuses?.some(status => status?.id === 'stealth'));
    }

    enterStealth(state, actor, { source = 'player' } = {}) {
        if (!actor || !living(actor)) throw httpError(400, '当前单位无法进入潜行');
        if (this.isStealthed(actor)) return false;
        actor.statuses ||= [];
        actor.statuses.push({ id: 'stealth', name: '潜行', tags: ['stealth'] });
        this.event(state, 'stealth_entered', { actorId: actor.id, source, movementNoiseMeters: Math.min(3, Number(actor.intelProfile?.movementNoiseMeters ?? 3)) });
        // Re-run only the affected directed pairs.  A concealed actor may
        // still be detected by a valid visual/auditory/intelligence check;
        // entering stealth is not an unconditional invisibility flag.
        this.refreshIntelligence(state, { reason: 'stealth_entered', affectedIds: [actor.id] });
        return true;
    }

    breakStealth(state, actor, { reason = 'revealed', source = 'system' } = {}) {
        if (!actor?.statuses?.some(status => status?.id === 'stealth')) return false;
        actor.statuses = actor.statuses.filter(status => status?.id !== 'stealth');
        this.event(state, 'stealth_broken', { actorId: actor.id, reason, source });
        if (source === 'player_command') this.refreshIntelligence(state, { reason: 'stealth_broken', affectedIds: [actor.id] });
        return true;
    }

    knownTargets(state, observer) { return enemiesOf(state, observer).filter(target => this.canTarget(state, observer, target)); }

    strategyFor(state, actor) {
        const global = state?.strategy || {};
        const local = actor?.id && global.assignments?.[actor.id];
        // Unit assignments intentionally override only policy fields.  The
        // shared runtime/trigger ledger remains on state.strategy so replays
        // and takeover conditions stay deterministic.
        return local ? { ...global, ...local, assignments: global.assignments, runtime: global.runtime } : global;
    }

    guerrillaMemory(state, actor) {
        // This is deliberately stored in the confirmed local strategy, rather
        // than inferred from prose on every turn.  It makes an automatic
        // battle replayable and exposes every posture transition as an event.
        state.strategy ||= {};
        state.strategy.runtime ||= {};
        return state.strategy.runtime[actor.id] ||= { posture: 'approach', escapeRounds: 0, lastAttackRound: null };
    }

    knownThreats(state, actor) {
        // A policy may only plan around entities already exposed to this
        // combatant (or its own last confirmed signal).  It must not inspect
        // hidden enemy locations as an AI cheat.
        const targets = this.knownTargets(state, actor);
        const lastKnown = Object.entries(state.intel.lastKnownPositions || {})
            .map(([id, position]) => ({ unit: state.combatants.find(item => item.id === id), position }))
            .filter(item => item.unit && this.isOpposed(actor, item.unit) && living(item.unit) && !targets.some(target => target.id === item.unit.id));
        return [
            ...targets.map(unit => ({ unit, position: { ...unit.position }, certainty: 'tracking' })),
            ...lastKnown.map(item => ({ unit: item.unit, position: { ...item.position }, certainty: 'last_known' })),
        ];
    }

    enemyPressure(state, actor) {
        const threats = this.knownThreats(state, actor);
        const immediate = threats.filter(({ unit, position }) => {
            const reach = effectiveSpeed(unit) + Math.max(...unit.abilities.map(item => Number(item.maxRangeMeters || 0)), 1.5);
            const projected = Math.max(0, Math.hypot(position.x - actor.position.x, position.y - actor.position.y) - Number(unit.radiusMeters || .5) - Number(actor.radiusMeters || .5));
            return projected <= reach + 1e-6;
        });
        return { threats, immediate, adjacent: this.adjacentOpponents(state, actor) };
    }

    setGuerrillaPosture(state, actor, memory, posture, reason, extra = {}) {
        if (memory.posture === posture) return;
        const before = memory.posture;
        memory.posture = posture;
        if (posture !== 'escape') memory.escapeRounds = 0;
        this.event(state, 'guerrilla_posture_changed', { actorId: actor.id, from: before, to: posture, reason, ...extra });
    }

    detectionDc(target, source, distance, noise = null) {
        const presence = this.isStealthed(target) || target.intelProfile?.presence === 'concealed' ? 10 : target.intelProfile?.presence === 'cautious' ? 5 : 0;
        const distancePenalty = Math.max(0, Math.floor(distance / 10) * 5);
        const soundBonus = source === 'auditory' && noise ? Math.max(0, Math.floor((Number(noise.radiusMeters || 0) - distance) / 10) * 5) : 0;
        const intelligenceBonus = source === 'intel' ? 5 : 0;
        return 50 + Number(target.attributes?.dexterityModifier || 0) + Number(target.intelProfile?.stealthBonus || 0) + presence + distancePenalty - soundBonus - intelligenceBonus;
    }

    awarenessForSource(source) {
        if (source === 'melee_contact') return 'engaged';
        if (source === 'visual' || source === 'intel' || source === 'shared' || source === 'dialogue') return 'tracking';
        return 'suspicious';
    }

    seedDeclaredContact(state) {
        this.ensureTacticalState(state);
        if (state.contactEstablished !== true) return;
        const resolve = id => state.combatants.filter(unit => unit.id === String(id) || unit.declarationId === String(id)).map(unit => unit.id);
        const explicit = (state.contactPairs || []).flatMap(pair => {
            if (!Array.isArray(pair) || pair.length !== 2) return [];
            const firstIds = resolve(pair[0]), secondIds = resolve(pair[1]);
            return firstIds.flatMap(firstId => secondIds.map(secondId => [firstId, secondId]));
        });
        const pairs = explicit.length ? explicit : state.combatants.filter(unit => unit.side === 'player').flatMap(player => state.combatants.filter(enemy => enemy.side === 'enemy').map(enemy => [player.id, enemy.id]));
        for (const [firstId, secondId] of pairs) {
            const first = state.combatants.find(unit => unit.id === firstId), second = state.combatants.find(unit => unit.id === secondId);
            if (!first || !second || !this.isOpposed(first, second) || !living(first) || !living(second)) continue;
            this.updateKnowledge(state, first, second, { source: 'dialogue', reason: 'story_contact_established', force: true });
            this.updateKnowledge(state, second, first, { source: 'dialogue', reason: 'story_contact_established', force: true });
            this.event(state, 'contact_seeded', { firstId, secondId, source: 'dialogue', reason: 'story_contact_established' });
        }
    }

    knowledgeCanTarget(source) { return AWARENESS_RANK[this.awarenessForSource(source)] >= AWARENESS_RANK.tracking; }

    updateKnowledge(state, observer, target, { source, reason, roll = null, total = null, dc = null, force = false } = {}) {
        this.ensureTacticalState(state);
        const records = state.intel.knowledge[observer.id] ||= {};
        const before = records[target.id];
        const awareness = this.awarenessForSource(source);
        const entry = { source, awareness, canTarget: AWARENESS_RANK[awareness] >= AWARENESS_RANK.tracking, position: { ...target.position }, round: state.round, reason, observedAt: state.sequence + 1, expiresAtRound: awareness === 'suspicious' ? state.round + 1 + Math.max(0, Number(observer.attributes?.spiritModifier || 0)) : null };
        records[target.id] = entry;
        state.intel.lastKnownPositions[target.id] = { ...entry.position, source, round: state.round };
        if (!before || this.awareness(before) !== awareness || before.source !== source || force) this.event(state, 'awareness_changed', { observerId: observer.id, targetId: target.id, from: this.awareness(before), to: awareness, source, reason, roll, total, dc, position: entry.position });
        if (!before || !this.isTracking(before) || before.source !== source || force) this.event(state, 'intel_detected', { observerId: observer.id, targetId: target.id, source, awareness, reason, roll, total, dc, position: entry.position });
        this.shareIntel(state, observer, target, entry, reason);
        return entry;
    }

    shareIntel(state, observer, target, entry, reason) {
        const profile = observer.tacticalProfile || {};
        if (!['squad', 'hive'].includes(profile.archetype)) return;
        const coordinationRange = Number(profile.coordinationRadiusMeters || 0) + Number(observer.attributes?.charismaModifier || 0) + Number(observer.intelProfile?.commandBonus || 0);
        const recipients = state.combatants.filter(unit => unit.id !== observer.id && living(unit) && unit.side === observer.side && tacticalGroupKey(unit) === tacticalGroupKey(observer) && (profile.archetype === 'hive' || centerDistance(unit, observer) <= coordinationRange)).sort((a, b) => a.id.localeCompare(b.id));
        if (!recipients.length) return;
        const ids = [];
        for (const recipient of recipients) {
            const records = state.intel.knowledge[recipient.id] ||= {};
            const prior = records[target.id];
            const sharedAwareness = this.isTracking(entry) ? 'tracking' : 'suspicious';
            records[target.id] = { ...entry, source: 'shared', sharedFrom: observer.id, awareness: sharedAwareness, canTarget: sharedAwareness === 'tracking' };
            if (!prior || !this.isTracking(prior)) ids.push(recipient.id);
        }
        if (ids.length) this.event(state, 'intel_shared', { group: tacticalGroupKey(observer), sourceObserverId: observer.id, targetId: target.id, recipients: ids, reason, source: entry.source });
    }

    rebuildPlayerVisibility(state) {
        const playerObservers = state.combatants.filter(unit => living(unit) && unit.side === 'player');
        // Do not erase the last confirmed battlefield when the final player
        // unit becomes dying/dead.  The debrief, replay and simulator still
        // need to show what had already been discovered at combat end.
        if (!playerObservers.length) {
            const frozen = new Set(state.intel.visibleToPlayer || []);
            for (const unit of state.combatants) if (unit.side === 'player') frozen.add(unit.id);
            state.intel.visibleToPlayer = [...frozen].sort();
            return;
        }
        const visible = new Set(playerObservers.map(unit => unit.id));
        for (const observer of playerObservers) for (const [targetId, entry] of Object.entries(state.intel.knowledge[observer.id] || {})) if (entry.canTarget) visible.add(targetId);
        state.intel.visibleToPlayer = [...visible].sort();
    }

    loseVisualContact(state, observer, target, reason) {
        const entry = this.knowledge(state, observer.id, target.id);
        if (!entry || entry.source !== 'visual' || !this.isTracking(entry) || this.inVisualField(observer, target)) return;
        // Turning away cannot erase a confirmed target before that target has
        // had its own turn in the current round.
        if (entry.round === state.round && !this.hasActedThisRound(state, target)) return;
        entry.awareness = 'suspicious'; entry.canTarget = false; entry.lostAtRound = state.round;
        entry.expiresAtRound = state.round + 1 + Math.max(0, Number(observer.attributes?.spiritModifier || 0));
        this.event(state, 'tracking_lost', { observerId: observer.id, targetId: target.id, source: 'visual', reason, lastKnownPosition: entry.position, expiresAtRound: entry.expiresAtRound });
        this.event(state, 'intel_lost', { observerId: observer.id, targetId: target.id, source: 'visual', reason, lastKnownPosition: entry.position });
    }

    attemptDetection(state, observer, target, { source, reason, noise = null, rng }) {
        if (!living(observer) || !living(target) || !this.isOpposed(observer, target)) return false;
        const distance = centerDistance(observer, target);
        const entry = this.knowledge(state, observer.id, target.id);
        if (source === 'visual' && !this.inVisualField(observer, target)) { this.loseVisualContact(state, observer, target, reason); return false; }
        if (source === 'visual') this.loseVisualContact(state, observer, target, reason);
        // A lower-fidelity hearing check must never downgrade an already
        // confirmed visual/intelligence/melee track to mere suspicion. This
        // matters when the new automatic counterattack emits attack noise:
        // nearby enemies remain eligible to act instead of losing their
        // target after one retaliatory exchange.
        if (this.isTracking(entry)) {
            entry.position = { ...target.position }; entry.round = state.round;
            state.intel.lastKnownPositions[target.id] = { ...target.position, source: entry.source, round: state.round };
            return true;
        }
        const automatic = source === 'visual' && target.intelProfile?.presence === 'obvious' && !this.isStealthed(target);
        if (automatic) { this.updateKnowledge(state, observer, target, { source, reason }); return true; }
        const roll = rng.d100();
        // Five-dimension mapping: DEX + stealth makes a target harder to
        // notice; SPI is deliberate sensing; CON is alertness/endurance;
        // CHA controls group sharing; STR contests scarce melee contact slots.
        const modifier = Number(observer.attributes?.spiritModifier || 0) + Number(observer.attributes?.constitutionModifier || 0) + Number(observer.intelProfile?.perceptionBonus || 0) + (source === 'intel' ? Number(observer.intelProfile?.intelligenceBonus || 0) : 0);
        const dc = this.detectionDc(target, source, distance, noise);
        const total = roll.selected + modifier;
        const success = roll.selected >= 96 || (roll.selected > 5 && total >= dc);
        this.event(state, 'intel_check', { observerId: observer.id, targetId: target.id, source, reason, rawRolls: roll.rolls, selected: roll.selected, rngIndex: roll.rngIndex, modifier, total, dc, distanceMeters: Math.round(distance * 1000) / 1000, success });
        if (success) this.updateKnowledge(state, observer, target, { source, reason, roll: roll.selected, total, dc });
        return success;
    }

    refreshIntelligence(state, options = {}) {
        return this.benchmarkMeasure(state, 'engine.refresh-intelligence', () => this.refreshIntelligenceMeasured(state, options));
    }

    refreshIntelligenceMeasured(state, { reason = 'state_changed', affectedIds = null, initial = false } = {}) {
        this.ensureTacticalState(state);
        const rng = this.rng(state);
        const pairs = new Map();
        const add = (observer, target) => { if (observer && target && this.isOpposed(observer, target)) pairs.set(`${observer.id}:${target.id}`, { observer, target }); };
        // Intelligence is only cross-faction.  Construct the two directed
        // player/enemy products directly: a 1v1000 AOE state change therefore
        // remains O(player × enemy), not an accidental million-unit scan.
        const players = state.combatants.filter(unit => living(unit) && unit.side === 'player');
        const enemies = state.combatants.filter(unit => living(unit) && unit.side === 'enemy');
        const changed = new Set((affectedIds || []).map(String));
        for (const observer of players) for (const target of enemies) if (initial || changed.has(observer.id) || changed.has(target.id)) add(observer, target);
        for (const observer of enemies) for (const target of players) if (initial || changed.has(observer.id) || changed.has(target.id)) add(observer, target);
        for (const { observer, target } of pairs.values()) {
            const distance = centerDistance(observer, target);
            if (this.inVisualField(observer, target)) this.attemptDetection(state, observer, target, { source: 'visual', reason, rng });
            else this.loseVisualContact(state, observer, target, reason);
            if (Number(observer.intelProfile?.intelligenceRangeMeters || 0) > 0 && distance <= Number(observer.intelProfile.intelligenceRangeMeters)) this.attemptDetection(state, observer, target, { source: 'intel', reason, rng });
        }
        this.saveRng(state, rng); this.rebuildPlayerVisibility(state);
    }

    decayIntelligence(state) {
        this.ensureTacticalState(state);
        const activation = { unaware: 0, suspicious: 0, tracking: 0, engaged: 0 };
        for (const observer of state.combatants.filter(living)) {
            const entries = state.intel.knowledge[observer.id] || {};
            for (const [targetId, entry] of Object.entries(entries)) {
                const target = state.combatants.find(unit => unit.id === targetId);
                if (!target || !living(target)) { delete entries[targetId]; continue; }
                if (this.awareness(entry) === 'suspicious' && Number(entry.expiresAtRound ?? Infinity) < state.round) {
                    this.event(state, 'awareness_changed', { observerId: observer.id, targetId, from: 'suspicious', to: 'unaware', source: entry.source, reason: 'suspicion_expired' });
                    delete entries[targetId];
                }
            }
            for (const target of enemiesOf(state, observer)) activation[this.awareness(entries[target.id])] += 1;
        }
        const primaryPlayer = state.combatants.find(player => player.side === 'player' && living(player));
        state.intel.activation = activation;
        this.event(state, 'activation_summary', { ...activation, enemyAwareOfPlayer: primaryPlayer ? state.combatants.filter(unit => unit.side === 'enemy' && this.isTracking(this.knowledge(state, unit.id, primaryPlayer.id))).length : 0 });
        this.rebuildPlayerVisibility(state);
    }

    emitNoise(state, actor, { reason, radiusMeters = null, rng: sharedRng = null } = {}) {
        this.ensureTacticalState(state);
        const radius = Number(radiusMeters ?? actor.intelProfile?.attackNoiseMeters ?? 0);
        if (radius <= 0) return;
        const noise = { id: `noise-${state.round}-${state.sequence + 1}-${actor.id}`, actorId: actor.id, position: { ...actor.position }, radiusMeters: radius, round: state.round, reason };
        state.intel.noise.push(noise); if (state.intel.noise.length > 60) state.intel.noise.splice(0, state.intel.noise.length - 60);
        const rng = sharedRng || this.rng(state); const listeners = []; let visibilityChanged = false;
        const opponents = sideIndexCache.get(state)?.index?.[actor.side === 'enemy' ? 'player' : 'enemy'] || state.combatants;
        for (const observer of opponents.filter(living)) {
            if (!this.isOpposed(observer, actor)) continue;
            const distance = centerDistance(observer, actor);
            if (distance <= Math.min(radius, Number(observer.intelProfile?.hearingMeters || 0))) {
                listeners.push(observer.id);
                const before = this.knowledge(state, observer.id, actor.id);
                const detected = this.attemptDetection(state, observer, actor, { source: 'auditory', reason, noise, rng });
                if (detected && !before?.canTarget) visibilityChanged = true;
            }
        }
        if (!sharedRng) this.saveRng(state, rng);
        if (listeners.length) this.event(state, 'noise_emitted', { actorId: actor.id, reason, position: noise.position, radiusMeters: radius, listenerIds: listeners });
        if (visibilityChanged) this.rebuildPlayerVisibility(state);
    }

    allocateMeleeSlots(state) {
        return this.benchmarkMeasure(state, 'engine.allocate-melee-slots', () => this.allocateMeleeSlotsMeasured(state));
    }

    allocateMeleeSlotsMeasured(state) {
        this.ensureTacticalState(state);
        const initiative = new Map(state.initiative.map((entry, index) => [entry.unitId, { total: entry.total, index }]));
        const targets = {};
        // Resolve each attacker's primary target once, then bucket by target.
        // The previous target-major scan repeated a full roster filter for
        // every target and made 1v1000 samples unnecessarily expensive.
        const buckets = new Map();
        for (const actor of state.combatants.filter(living)) {
            if (!actor.abilities.some(isMeleeAbility)) continue;
            // A manually controlled player must be able to choose any legal
            // melee contact that currently blocks movement. Automatic units
            // retain one primary target so their deterministic policy and
            // contact-slot pressure remain unchanged.
            const targetsForActor = actor.side === 'player' && actor.controller === 'player'
                ? enemiesOf(state, actor).filter(target => this.canTarget(state, actor, target) && actor.abilities.some(ability => isMeleeAbility(ability) && rangeLegal(state, actor, target, ability)))
                : [this.selectTarget(state, actor)];
            for (const target of targetsForActor) {
                if (!target || edgeDistance(actor, target) > effectiveSpeed(actor) + 1.5 + 1e-6) continue;
                const candidates = buckets.get(target.id) || [];
                candidates.push(actor); buckets.set(target.id, candidates);
            }
        }
        for (const [targetId, candidates] of buckets.entries()) {
            const target = state.combatants.find(unit => unit.id === targetId);
            candidates.sort((a, b) => {
                const rank = value => value.tacticalProfile?.archetype === 'hive' ? 0 : value.tacticalProfile?.archetype === 'squad' ? 1 : 2;
                const group = rank(a) - rank(b); if (group) return group;
                const distance = edgeDistance(a, target) - edgeDistance(b, target); if (distance) return distance;
                const strength = Number(b.attributes?.strengthModifier || 0) - Number(a.attributes?.strengthModifier || 0); if (strength) return strength;
                const order = (initiative.get(b.id)?.total || 0) - (initiative.get(a.id)?.total || 0); if (order) return order;
                return a.id.localeCompare(b.id);
            });
            targets[target.id] = { capacity: 8, attackerIds: candidates.slice(0, 8).map(unit => unit.id), waitlistIds: candidates.slice(8).map(unit => unit.id), targetId: target.id };
            this.event(state, 'melee_slots_allocated', { targetId: target.id, capacity: 8, attackerIds: targets[target.id].attackerIds, waitingCount: targets[target.id].waitlistIds.length });
        }
        state.meleeSlots = { round: state.round, targets };
    }

    hasMeleeSlot(state, actor, target) { return (state.meleeSlots?.targets?.[target.id]?.attackerIds || []).includes(actor.id); }

    searchDestination(state, actor) {
        const known = Object.values(state.intel.knowledge[actor.id] || {}).filter(entry => entry.position).sort((a, b) => b.round - a.round)[0];
        if (known) return { ...known.position, reason: 'last_known_position' };
        // Suspicion records are deliberately short-lived, but a player that
        // has already confirmed an opponent is still allowed to cautiously
        // recon its last map signal.  This global ledger only retains target
        // IDs; restrict it to actual opposed units so enemy knowledge of the
        // player can never leak back into the player policy.
        const recorded = Object.entries(state.intel.lastKnownPositions || {})
            .map(([targetId, item]) => ({ target: state.combatants.find(unit => unit.id === targetId), item }))
            .filter(({ target, item }) => target && living(target) && this.isOpposed(actor, target) && item?.x !== undefined && item?.y !== undefined)
            .sort((a, b) => Number(b.item.round || 0) - Number(a.item.round || 0))[0];
        if (recorded) return { x: Number(recorded.item.x), y: Number(recorded.item.y), reason: 'persistent_last_known_position' };
        const noise = [...(state.intel.noise || [])].filter(item => item.actorId !== actor.id).sort((a, b) => b.round - a.round || b.radiusMeters - a.radiusMeters).find(item => Math.hypot(actor.position.x - item.position.x, actor.position.y - item.position.y) <= Math.min(item.radiusMeters, Number(actor.intelProfile?.hearingMeters || 0)));
        if (noise) return { ...noise.position, reason: 'sound_source' };
        return null;
    }

    assertWritable(state, expectedVersion) {
        if (!state) throw httpError(404, '战斗不存在');
        if (expectedVersion !== undefined && Number(expectedVersion) !== state.version) throw httpError(409, `状态版本冲突：当前为 ${state.version}`);
        if (['completed', 'abandoned'].includes(state.status)) throw httpError(409, '战斗已结束');
    }

    async start(state) {
        this.assertWritable(state);
        if (!['draft', 'ready', 'paused'].includes(state.status)) throw httpError(409, '当前状态不能开始战斗');
        for (const unit of state.combatants) for (const ability of unit.abilities) {
            if (!ability.script) continue;
            const hash = scriptHash(ability.script);
            ability.scriptHash = hash;
            if (!this.repository.isScriptApproved(hash, state.rulesetVersion)) {
                state.status = 'awaiting_script_approval'; state.pauseReason = { type: 'script_approval', unitId: unit.id, abilityId: ability.id, inspection: inspectScript(ability.script, ability) };
                this.event(state, 'script_approval_required', state.pauseReason); return;
            }
            if (!state.approvedScripts.includes(hash)) state.approvedScripts.push(hash);
        }
        state.status = 'running'; state.pauseReason = null;
        if (!state.initialized) {
            this.ensureTacticalState(state);
            // A direct story exchange is a fact carried by the handoff flag,
            // not a new perception roll. Seed it before visual/hearing checks
            // so the first local turn cannot make already-speaking entities
            // mysteriously disappear from one another's target list.
            this.seedDeclaredContact(state);
            this.refreshIntelligence(state, { reason: 'combat_started', initial: true });
            state.initialized = true; this.beginRound(state);
        }
        await this.advanceUntilPause(state, state.mode === 'manual' ? 1000 : 10000);
    }

    beginRound(state) { return this.benchmarkMeasure(state, 'engine.begin-round', () => this.beginRoundMeasured(state)); }

    beginRoundMeasured(state) {
        state.round += 1; state.flags = {}; state.engagements = {}; state.turnBudget = {};
        this.decayIntelligence(state);
        const statusChanged = [];
        const livingUnits = state.combatants.filter(living);
        // Contact recovery used to call `some()` over the full roster for
        // every unit. Large hordes therefore paid an O(n^2) scan before every
        // initiative roll. A coarse spatial hash preserves the exact distance
        // check while limiting each lookup to nearby cells.
        const cellSize = Math.max(3, ...livingUnits.map(unit => Number(unit.radiusMeters || .5) * 2 + 1.5));
        const cellKey = (x, y) => `${Math.floor(Number(x || 0) / cellSize)},${Math.floor(Number(y || 0) / cellSize)}`;
        const cells = new Map();
        for (const unit of livingUnits) {
            const key = cellKey(unit.position?.x, unit.position?.y);
            const bucket = cells.get(key) || [];
            bucket.push(unit); cells.set(key, bucket);
        }
        const hasAdjacentOpponent = unit => {
            const x = Math.floor(Number(unit.position?.x || 0) / cellSize);
            const y = Math.floor(Number(unit.position?.y || 0) / cellSize);
            for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
                for (const other of cells.get(`${x + dx},${y + dy}`) || []) {
                    if (other.id !== unit.id && this.isOpposed(unit, other) && edgeDistance(unit, other) <= 1.5 + 1e-6) return true;
                }
            }
            return false;
        };
        for (const unit of state.combatants) {
            if (!living(unit)) continue;
            const beforeStatuses = deepClone(unit.statuses);
            for (const status of unit.statuses) {
                if (Number(status.damagePerRound) > 0) { const applied = applyDamage(unit, Number(status.damagePerRound)); this.event(state, 'periodic_damage', { unitId: unit.id, status: status.id, amount: status.damagePerRound, applied }); }
                if (Number(status.healPerRound) > 0) { const before = unit.hp; unit.hp = Math.min(unit.maxHp, unit.hp + Number(status.healPerRound)); this.event(state, 'periodic_heal', { unitId: unit.id, status: status.id, before, after: unit.hp }); }
            }
            // Durationless tactical stances (currently stealth) persist until
            // an explicit break or an action that reveals the unit.  Ordinary
            // combat effects retain the existing countdown semantics.
            unit.statuses = unit.statuses.map(status => status.duration === undefined ? status : ({ ...status, duration: Number(status.duration || 1) - 1 })).filter(status => status.duration === undefined || status.duration > 0);
            for (const key of Object.keys(unit.cooldowns)) unit.cooldowns[key] = Math.max(0, Number(unit.cooldowns[key]) - 1);
            if (canonical(beforeStatuses) !== canonical(unit.statuses)) { this.event(state, 'status_refreshed', { unitId: unit.id, before: beforeStatuses, after: unit.statuses }); statusChanged.push(unit.id); }
            const wasSpent = Boolean(unit._spentExertionLastRound);
            const inContact = hasAdjacentOpponent(unit);
            if (!wasSpent && !inContact) this.changeExertion(state, unit, 1, 'round_recovery');
            unit._spentExertionLastRound = false;
            state.turnBudget[unit.id] = { movement: 1, movementMeters: effectiveSpeed(unit), main: 1, minor: 1, movedMeters: 0, spentExertion: false };
        }
        if (statusChanged.length) this.refreshIntelligence(state, { reason: 'status_changed', affectedIds: statusChanged });
        const rng = this.rng(state);
        // Roll every living unit before assigning an active actor. No action,
        // manual pause, or player-priority shortcut is allowed to happen while
        // this batch is incomplete.
        state.initiative = livingUnits.map(unit => {
            const roll = rng.d100();
            const total = roll.selected + unit.initiativeDC;
            this.event(state, 'initiative_roll', { unitId: unit.id, rawRolls: roll.rolls, selected: roll.selected, initiativeDC: unit.initiativeDC, total, rngIndex: roll.rngIndex });
            return { unitId: unit.id, total, rawRolls: roll.rolls, selected: roll.selected, initiativeDC: unit.initiativeDC, rngIndex: roll.rngIndex };
        }).sort((a, b) => b.total - a.total || a.unitId.localeCompare(b.unitId));
        this.event(state, 'initiative_order_locked', {
            round: state.round,
            allUnitsRolled: state.initiative.length === livingUnits.length,
            rolledUnitIds: livingUnits.map(unit => unit.id),
            order: state.initiative.map((entry, index) => ({ rank: index + 1, ...entry })),
        });
        this.saveRng(state, rng); this.allocateMeleeSlots(state); state.cursor = 0; state.activeUnitId = state.initiative[0]?.unitId || null;
        this.event(state, 'round_started', { round: state.round, order: state.initiative });
    }

    async advanceUntilPause(state, maxActions = 1000) {
        return this.benchmarkMeasureAsync(state, 'engine.advance-until-pause', () => this.advanceUntilPauseMeasured(state, maxActions));
    }

    async advanceUntilPauseMeasured(state, maxActions = 1000) {
        let actions = 0;
        while (state.status === 'running' && actions < maxActions) {
            const actor = this.currentActor(state);
            if (!actor) { this.finishRound(state); continue; }
            if (actor.statuses.some(status => ['interrupted', 'stunned', 'controlled'].includes(status.id) || status.skipTurn)) { this.event(state, 'turn_skipped', { actorId: actor.id, statuses: actor.statuses.filter(status => ['interrupted', 'stunned', 'controlled'].includes(status.id) || status.skipTurn).map(status => status.id) }); state.cursor += 1; actions += 1; continue; }
            if (actor.side === 'player' && actor.state === 'dying') { this.pause(state, { type: 'player_dying', unitId: actor.id }); break; }
            if (this.shouldManualPause(state, actor)) { this.pause(state, { type: 'manual_turn', unitId: actor.id, legalActions: this.legalActions(state, actor) }); break; }
            await this.resolveAutomaticAction(state, actor); actions += 1;
            if (this.afterAction(state)) break;
        }
        if (actions >= maxActions && state.status === 'running') this.pause(state, { type: 'safety_limit', actions: maxActions });
    }

    shouldManualPause(state, actor) {
        const strategy = this.strategyFor(state, actor);
        if (actor.controller !== 'player' || actor.controlMode === 'auto') return false;
        if (actor.controlMode === 'manual') return true;
        return state.mode === 'manual' || state.mode === 'semi' && !strategy?.confirmed;
    }

    currentActor(state) {
        while (state.cursor < state.initiative.length) {
            const id = state.initiative[state.cursor].unitId;
            const unit = state.combatants.find(item => item.id === id);
            if (unit && living(unit)) { state.activeUnitId = id; return unit; }
            state.cursor += 1;
        }
        state.activeUnitId = null; return null;
    }

    hasActedThisRound(state, unit) {
        const initiativeIndex = state.initiative?.findIndex(entry => entry.unitId === unit.id) ?? -1;
        return initiativeIndex >= 0 && initiativeIndex < Number(state.cursor || 0);
    }

    legalActions(state, actor) {
        const targets = this.knownTargets(state, actor);
        const budget = state.turnBudget?.[actor.id] || { movement: 1, movementMeters: effectiveSpeed(actor), main: 1, minor: 1, movedMeters: 0, spentExertion: false };
        const maneuvers = [
            { id: 'sprint', name: '疾走', actionType: 'minor', type: 'maneuver', legalTargetIds: [], affordable: Number(actor.exertion || 0) >= 1, actionAvailable: budget.minor > 0 && Number(actor.exertion || 0) >= 1, detail: `消耗1体力，额外 ${sprintMeters(actor)}m 移动` },
            { id: 'withdraw', name: '战术脱离', actionType: 'minor', type: 'maneuver', legalTargetIds: [], affordable: Number(actor.exertion || 0) >= 1, actionAvailable: budget.minor > 0 && Number(actor.exertion || 0) >= 1 && this.adjacentOpponents(state, actor).length > 0, detail: `消耗1体力，优势脱离并移动 ${withdrawMeters(actor)}m` },
            { id: 'evasive', name: '闪避步法', actionType: 'minor', type: 'maneuver', legalTargetIds: [], affordable: true, actionAvailable: budget.minor > 0, detail: `下次回合前前 ${evasionAttacks(actor)} 次受击劣势` },
            { id: 'hide', name: this.isStealthed(actor) ? '结束潜行' : '隐蔽 / 切断追踪', actionType: 'minor', type: 'maneuver', legalTargetIds: [], affordable: true, actionAvailable: budget.minor > 0 && (this.isStealthed(actor) || Number(budget.movedMeters || 0) > 0 || actor.intelProfile?.presence === 'concealed'), detail: this.isStealthed(actor) ? '解除潜行状态' : '移动后尝试切断敌方追踪' },
            { id: 'lure', name: '诱导', actionType: 'minor', type: 'maneuver', legalTargetIds: [], affordable: true, actionAvailable: budget.minor > 0, detail: `在 ${6 + Math.max(0, Number(actor.attributes?.charismaModifier || 0)) * 2}m 内制造局部声源` },
        ];
        return [...actor.abilities.map(ability => ({ ...ability, script: undefined, legalTargetIds: targets.filter(target => rangeLegal(state, actor, target, ability) && this.canEngage(state, actor, target, ability)).map(target => target.id), affordable: actor.ep >= ability.epCost, actionAvailable: budget[ability.actionType || 'main'] > 0 && !actor.cooldowns?.[ability.id], cooldownRemaining: Number(actor.cooldowns?.[ability.id] || 0), budget })), ...maneuvers.map(item => ({ ...item, budget }))];
    }

    selectTarget(state, actor) {
        const targets = this.knownTargets(state, actor);
        const strategy = this.strategyFor(state, actor);
        if (actor.side === 'player' && strategy?.guerrilla) {
            return [...targets].sort((a, b) => {
                const localPressure = target => targets.filter(other => other.id !== target.id && centerDistance(other, target) <= 7 + Number(target.radiusMeters || .5) + Number(other.radiusMeters || .5)).length;
                // Do not march past a reachable pursuer merely because a
                // distant token has one fewer neighbour. Distance remains
                // primary; local density breaks near-distance ties.
                const score = target => edgeDistance(actor, target) * 4 + localPressure(target) * 5;
                const tactical = score(a) - score(b); if (tactical) return tactical;
                // Finish an already isolated wounded target before opening a
                // new contact; this prevents the policy from attracting a
                // second cluster to every partially damaged zombie.
                const health = a.hp / a.maxHp - b.hp / b.maxHp; if (health) return health;
                return edgeDistance(a, actor) - edgeDistance(b, actor) || a.id.localeCompare(b.id);
            })[0];
        }
        const focusRule = actor.tacticalProfile?.focusRule || 'nearest';
        const priorities = actor.side === 'player' && strategy?.priorities?.length ? strategy.priorities : focusRule === 'weakest' ? ['weakest', 'nearest', 'boss'] : focusRule === 'marked' ? ['marked', 'nearest', 'weakest'] : ['nearest', 'weakest', 'boss'];
        return [...targets].sort((a, b) => {
            for (const priority of priorities) {
                const delta = priority === 'weakest' ? a.hp - b.hp : priority === 'boss' ? Number(b.boss) - Number(a.boss) : priority === 'marked' ? Number(!b.statuses.some(status => status.id === 'marked')) - Number(!a.statuses.some(status => status.id === 'marked')) : edgeDistance(a, actor) - edgeDistance(b, actor);
                if (delta) return delta;
            }
            return a.id.localeCompare(b.id);
        })[0];
    }

    async resolveAutomaticAction(state, actor) {
        return this.benchmarkMeasureAsync(state, 'engine.automatic-action', () => this.resolveAutomaticActionMeasured(state, actor));
    }

    async resolveAutomaticActionMeasured(state, actor) {
        const budget = state.turnBudget[actor.id] ||= { movement: 1, movementMeters: effectiveSpeed(actor), main: 1, minor: 1, movedMeters: 0, spentExertion: false };
        const strategy = this.strategyFor(state, actor);
        const guerrilla = actor.side === 'player' && Boolean(strategy?.guerrilla);
        const guerrillaMemory = guerrilla ? this.guerrillaMemory(state, actor) : null;
        // Once a covert strike has happened, the policy must create a real
        // separation before it is allowed to choose another target.  The old
        // nearest-target loop immediately walked back toward the pursuer and
        // was the direct cause of the horde pile-up in the formal 1v100 run.
        if (guerrilla && guerrillaMemory.posture === 'escape') {
            this.resolveGuerrillaEscape(state, actor, guerrillaMemory);
            state.cursor += 1;
            return;
        }
        // A confirmed strategy may explicitly request a stealth approach.  It
        // is one deterministic movement action, never an implicit buff: the
        // actor still performs normal visual/auditory/intelligence checks and
        // breaks stealth as soon as it attacks.
        const openingTarget = this.selectTarget(state, actor);
        const nearestReach = actor.abilities.map(ability => Number(ability.maxRangeMeters || 0)).filter(value => value > 0).sort((a, b) => a - b)[0] || 1.5;
        const canReachAndStrike = openingTarget && edgeDistance(actor, openingTarget) <= this.movementRemaining(state, actor) + nearestReach + 1e-6;
        // In guerrilla mode the minor action is reserved for a guaranteed
        // withdrawal on an attack turn. Hide only while scouting/closing a
        // gap; otherwise the old "hide then attack" sequence accidentally
        // converted a safe disengage into an ordinary contested movement.
        const initialGuerrillaAmbush = guerrilla && guerrillaMemory.lastAttackRound === null;
        if (actor.side === 'player' && strategy?.stealth && !this.isStealthed(actor) && budget.minor > 0 && !this.adjacentOpponents(state, actor).length && (initialGuerrillaAmbush || !strategy?.guerrilla || !canReachAndStrike)) {
            this.enterHide(state, actor, { source: 'strategy', allowStationary: true }); budget.minor -= 1;
        }
        let target = openingTarget || this.selectTarget(state, actor);
        if (!target) {
            if (guerrilla && guerrillaMemory.posture === 'recon') {
                const search = this.searchDestination(state, actor);
                if (search && this.movementRemaining(state, actor) > 0) {
                    // Recon is intentionally half-speed: it gives an
                    // isolated watcher time to acquire a target without
                    // blindly re-entering the last known crowd position.
                    const moved = this.moveTowardPoint(state, actor, search, { maxMeters: Math.max(2, effectiveSpeed(actor) / 2), source: 'guerrilla_recon' });
                    if (moved) this.consumeMovement(state, actor, moved);
                    this.event(state, 'guerrilla_recon', { actorId: actor.id, destination: { x: search.x, y: search.y }, distanceMeters: moved || 0, reason: search.reason });
                } else this.event(state, 'unit_waited', { actorId: actor.id, reason: 'guerrilla_recon_no_signal' });
                state.cursor += 1;
                return;
            }
            const search = actor.tacticalProfile?.objective === 'hold' ? null : this.searchDestination(state, actor);
            if (search && this.movementRemaining(state, actor) > 0) { const moved = this.moveTowardPoint(state, actor, search); if (moved) this.consumeMovement(state, actor, moved); this.event(state, 'unit_searching', { actorId: actor.id, reason: search.reason, destination: { x: search.x, y: search.y } }); }
            else this.event(state, 'unit_waited', { actorId: actor.id, reason: 'no_detected_target' });
            state.cursor += 1; return;
        }
        let available = actor.abilities.filter(ability => actor.ep >= ability.epCost && !actor.cooldowns?.[ability.id] && rangeLegal(state, actor, target, ability) && this.canEngage(state, actor, target, ability) && (!ability.script || this.repository.isScriptApproved(ability.scriptHash || scriptHash(ability.script), state.rulesetVersion)));
        if (!available.length && this.movementRemaining(state, actor) > 0 && actor.tacticalProfile?.objective !== 'hold') {
            const moved = this.moveToward(state, actor, target);
            if (moved) this.consumeMovement(state, actor, moved);
            // Movement can reveal another isolated target and rebuild the
            // contact ledger. Use the current legal target, not the stale
            // pre-move choice that may no longer own the melee slot.
            target = this.selectTarget(state, actor) || target;
            available = actor.abilities.filter(ability => actor.ep >= ability.epCost && !actor.cooldowns?.[ability.id] && rangeLegal(state, actor, target, ability) && this.canEngage(state, actor, target, ability) && (!ability.script || this.repository.isScriptApproved(ability.scriptHash || scriptHash(ability.script), state.rulesetVersion)));
        }
        const ability = available.find(item => item.id !== 'basic-attack') || available[0];
        if (!ability) { state.flags.noLegalAction = true; this.event(state, 'unit_waited', { actorId: actor.id, reason: 'no_legal_action', targetId: target?.id || null, targetDistance: target ? edgeDistance(actor, target) : null, movementRemaining: this.movementRemaining(state, actor), knownTargetIds: this.knownTargets(state, actor).map(unit => unit.id).slice(0, 24), abilityDiagnostics: actor.abilities.map(item => ({ id: item.id, affordable: actor.ep >= item.epCost, cooldown: Number(actor.cooldowns?.[item.id] || 0), inRange: target ? rangeLegal(state, actor, target, item) : false, canEngage: target ? this.canEngage(state, actor, target, item) : false })) }); state.cursor += 1; return; }
        const targets = (ability.aoe || ability.targetCount > 1) ? this.knownTargets(state, actor).filter(item => rangeLegal(state, actor, item, ability) && this.canEngage(state, actor, item, ability)).slice(0, ability.targetCount) : [target];
        while (!ability.aoe && targets.length > 1 && actor.ep < Math.ceil(ability.epCost * targetCostMultiplier(targets.length))) targets.pop();
        if (ability.script) { if (!await this.executeScriptAbility(state, actor, targets, ability)) return; }
        else this.resolveAttack(state, actor, targets, ability);
        // A confirmed “拉扯/风筝/边打边退” strategy spends the remaining
        // movement budget immediately after a successful attack. This keeps
        // the player from standing in the same contact cluster while still
        // allowing the ordinary movement/attack path when no target is in
        // range. The contact ledger is rebuilt after the retreat so the next
        // actor sees the new eight-slot allocation.
        if (guerrilla && living(actor) && state.status === 'running') {
            guerrillaMemory.lastAttackRound = state.round;
            this.setGuerrillaPosture(state, actor, guerrillaMemory, 'escape', 'strike_resolved', { targetId: target.id, targetCount: targets.length });
            this.resolveGuerrillaEscape(state, actor, guerrillaMemory, { afterStrike: true });
        } else if (actor.side === 'player' && strategy?.retreat && this.movementRemaining(state, actor) > 0 && living(actor) && state.status === 'running') {
            const retreatTarget = living(target) ? target : this.selectTarget(state, actor);
            if (retreatTarget) { const moved = this.retreatFromTarget(state, actor, retreatTarget); if (moved) this.consumeMovement(state, actor, moved); }
        }
        state.cursor += 1;
    }

    meleeBlockRange(unit, target) {
        const distance = edgeDistance(unit, target);
        return (unit.abilities || []).some(ability => isMeleeAbility(ability)
            && distance + 1e-6 >= Number(ability.minRangeMeters || 0)
            && distance <= Number(ability.maxRangeMeters ?? (ability.range === 'contact' ? 1.5 : 1.5)) + 1e-6);
    }

    meleeBlockProfile(unit, target) {
        const distance = edgeDistance(unit, target);
        const ranges = (unit?.abilities || []).filter(isMeleeAbility).map(ability => ({ id: ability.id, min: Number(ability.minRangeMeters || 0), max: Number(ability.maxRangeMeters ?? 1.5) }));
        return { distance, ranges, canAttack: ranges.some(range => distance + 1e-6 >= range.min && distance <= range.max + 1e-6) };
    }

    adjacentOpponents(state, actor) {
        // A movement block is a mutual melee relationship. The blocker must
        // be able to attack the actor, and the actor must be able to answer
        // with its own melee attack at the current distance.
        return enemiesOf(state, actor).filter(other => this.meleeBlockRange(other, actor) && this.meleeBlockRange(actor, other));
    }

    shortestAttackPosition(state, actor, target, ability) {
        const maxRange = Number(ability.maxRangeMeters ?? 1.5);
        const dx = actor.position.x - target.position.x;
        const dy = actor.position.y - target.position.y;
        const centerDistance = Math.hypot(dx, dy) || 1;
        const edge = edgeDistance(actor, target);
        if (edge <= maxRange + 1e-6) return { ...actor.position };
        const desiredCenterDistance = Number(actor.radiusMeters || .5) + Number(target.radiusMeters || .5) + maxRange;
        const destination = { x: target.position.x + dx / centerDistance * desiredCenterDistance, y: target.position.y + dy / centerDistance * desiredCenterDistance };
        if (!positionInsideBattlefield(destination, Number(actor.radiusMeters || .5), state.battlefield)) throw httpError(400, '最短攻击落点超出战场边界');
        return destination;
    }

    moveAttack(state, actor, target, ability) {
        if (!target || !living(target)) throw httpError(400, '攻击目标不存在或已失能');
        if (ability.id !== 'basic-attack') throw httpError(400, '移动攻击只支持基础攻击');
        if (!this.canTarget(state, actor, target)) throw httpError(400, `目标 ${target.id} 尚未被发现`);
        const destination = this.shortestAttackPosition(state, actor, target, ability);
        const distance = Math.hypot(destination.x - actor.position.x, destination.y - actor.position.y);
        if (distance > this.movementRemaining(state, actor) + 1e-6) throw httpError(400, `移动攻击需要 ${distance.toFixed(2)}m，超过本回合剩余移动`);
        const originalPosition = actor.position;
        actor.position = destination;
        const legalAfterMove = this.canEngage(state, actor, target, ability);
        actor.position = originalPosition;
        if (!legalAfterMove) throw httpError(400, '最短攻击落点没有可用的近战攻击位置');
        if (distance > 1e-6) {
            this.moveTo(state, actor, destination, { source: 'move_attack' });
            this.consumeMovement(state, actor, distance);
        }
        if (!rangeLegal(state, actor, target, ability) || !this.canEngage(state, actor, target, ability)) throw httpError(400, '移动后仍不满足基础攻击条件');
        return distance;
    }

    attemptDisengage(state, actor, { advantage = false, reason = 'movement' } = {}) {
        const adjacent = this.adjacentOpponents(state, actor);
        if (!adjacent.length) return true;
        // A lone opponent occupies one contact point, not the whole plane.
        // In a coverless 2D field it cannot physically pin a mobile unit;
        // checks begin when multiple bodies create a closing ring. Squads and
        // hives add pressure through coordination, scattered instincts do not.
        const coordinated = adjacent.filter(unit => ['squad', 'hive'].includes(unit.tacticalProfile?.archetype)).length;
        const strongest = Math.max(...adjacent.map(unit => Number(unit.attributes?.strengthModifier || 0)));
        const rng = this.rng(state); const roll = rng.d100(advantage ? 'advantage' : 'normal');
        const modifier = Number(actor.attributes?.dexterityModifier || 0);
        const dc = 40 + strongest + Math.max(0, adjacent.length - 1) * 4 + coordinated * 2; const total = roll.selected + modifier;
        const success = roll.selected >= 96 || (roll.selected > 5 && total >= dc);
        this.saveRng(state, rng);
        this.event(state, 'withdrawal_resolved', { actorId: actor.id, opponentIds: adjacent.map(unit => unit.id), reason, advantage, rawRolls: roll.rolls, selected: roll.selected, rngIndex: roll.rngIndex, modifier, total, dc, success, blockingUnitIds: adjacent.map(unit => unit.id) });
        return success;
    }

    wouldLeaveContact(state, actor, destination) {
        return this.adjacentOpponents(state, actor).some(other => {
            const current = edgeDistance(actor, other);
            const projected = Math.max(0, Math.hypot(Number(destination.x) - other.position.x, Number(destination.y) - other.position.y) - Number(actor.radiusMeters || .5) - Number(other.radiusMeters || .5));
            return projected > current + 1e-6;
        });
    }

    attemptBreakTracking(state, actor, reason = 'hide') {
        const observers = enemiesOf(state, actor).filter(observer => this.isTracking(this.knowledge(state, observer.id, actor.id)) && !this.inVisualField(observer, actor));
        const rng = this.rng(state); let reduced = 0;
        for (const observer of observers) {
            const roll = rng.d100(); const modifier = Number(actor.attributes?.dexterityModifier || 0) + Number(actor.intelProfile?.stealthBonus || 0);
            const dc = 50 + Number(observer.attributes?.spiritModifier || 0) + Number(observer.intelProfile?.perceptionBonus || 0);
            const total = roll.selected + modifier; const success = roll.selected >= 96 || (roll.selected > 5 && total >= dc);
            this.event(state, 'maneuver_check', { maneuver: 'hide', actorId: actor.id, observerId: observer.id, rawRolls: roll.rolls, selected: roll.selected, rngIndex: roll.rngIndex, modifier, total, dc, success, reason });
            if (success) {
                const entry = this.knowledge(state, observer.id, actor.id);
                entry.awareness = 'suspicious'; entry.canTarget = false; entry.source = 'lost_track'; entry.round = state.round;
                entry.expiresAtRound = state.round + 1 + Math.max(0, Number(observer.attributes?.spiritModifier || 0));
                reduced += 1;
                this.event(state, 'tracking_lost', { observerId: observer.id, targetId: actor.id, source: 'hide', reason, lastKnownPosition: entry.position, expiresAtRound: entry.expiresAtRound });
            }
        }
        this.saveRng(state, rng); this.rebuildPlayerVisibility(state);
        return { observers: observers.length, reduced };
    }

    enterHide(state, actor, { source = 'player_command', allowStationary = false } = {}) {
        const budget = state.turnBudget[actor.id] || {};
        if (this.isStealthed(actor)) { this.breakStealth(state, actor, { reason: 'player_cancelled', source }); return { cancelled: true, reduced: 0 }; }
        // The explicit legacy `sneak` command is also used to declare a
        // pre-existing silent approach before the first blow.  Permit that
        // stationary declaration in contact; the first melee attack still
        // exposes the attacker unconditionally.  The map-menu Hide maneuver
        // remains blocked in an ongoing melee unless the player withdraws.
        if (this.adjacentOpponents(state, actor).length && !allowStationary) throw httpError(400, '近战接触中不能直接隐蔽；请先脱离');
        if (!allowStationary && !Number(budget.movedMeters || 0) && actor.intelProfile?.presence !== 'concealed') throw httpError(400, '隐蔽前必须先移动，或在模型中明确初始隐蔽');
        this.enterStealth(state, actor, { source });
        const result = this.attemptBreakTracking(state, actor, 'hide_action');
        this.event(state, 'hide_resolved', { actorId: actor.id, source, ...result });
        return result;
    }

    useSprint(state, actor) {
        const budget = state.turnBudget[actor.id];
        if (budget.minor <= 0) throw httpError(400, '本回合次要行动已用尽');
        if (Number(actor.exertion || 0) < 1) throw httpError(400, '体力不足，无法疾走');
        this.changeExertion(state, actor, -1, 'sprint'); actor._spentExertionLastRound = true;
        budget.spentExertion = true; budget.minor -= 1; budget.movementMeters = Number(budget.movementMeters || 0) + sprintMeters(actor); budget.movement = 1;
        this.event(state, 'maneuver_resolved', { maneuver: 'sprint', actorId: actor.id, addedMeters: sprintMeters(actor), exertion: actor.exertion });
    }

    useEvasive(state, actor) {
        const budget = state.turnBudget[actor.id];
        if (budget.minor <= 0) throw httpError(400, '本回合次要行动已用尽');
        budget.minor -= 1;
        actor.statuses = actor.statuses.filter(status => status.id !== 'evasive');
        actor.statuses.push({ id: 'evasive', name: '闪避步法', remainingAttacks: evasionAttacks(actor), duration: 1 });
        this.event(state, 'maneuver_resolved', { maneuver: 'evasive', actorId: actor.id, remainingAttacks: evasionAttacks(actor) });
    }

    useWithdraw(state, actor, destination = null) {
        const budget = state.turnBudget[actor.id];
        if (budget.minor <= 0) throw httpError(400, '本回合次要行动已用尽');
        if (Number(actor.exertion || 0) < 1) throw httpError(400, '体力不足，无法战术脱离');
        if (!this.attemptDisengage(state, actor, { advantage: true, reason: 'tactical_withdraw' })) throw httpError(400, '脱离检定失败，仍被近战压制', { blockingUnitIds: this.adjacentOpponents(state, actor).map(unit => unit.id) });
        this.changeExertion(state, actor, -1, 'withdraw'); actor._spentExertionLastRound = true;
        budget.spentExertion = true; budget.minor -= 1;
        // A withdrawal is a tactical reset, not merely a small extension of
        // whatever movement happened before the strike. This lets a fast
        // unit enter, resolve its main action, then create real separation.
        // The identical rule applies to every entity; DEX decides both the
        // full follow-up movement and the extra withdrawal step.
        budget.movementMeters = Math.max(Number(budget.movementMeters || 0), effectiveSpeed(actor)); budget.movement = 1;
        const nearest = this.adjacentOpponents(state, actor).sort((a, b) => edgeDistance(a, actor) - edgeDistance(b, actor))[0];
        let to = destination && Number.isFinite(Number(destination.x)) && Number.isFinite(Number(destination.y)) ? { x: Number(destination.x), y: Number(destination.y) } : null;
        if (!to && nearest) {
            const dx = actor.position.x - nearest.position.x, dy = actor.position.y - nearest.position.y, distance = Math.hypot(dx, dy) || 1;
            to = { x: actor.position.x + dx / distance * withdrawMeters(actor), y: actor.position.y + dy / distance * withdrawMeters(actor) };
        }
        if (!to) throw httpError(400, '没有可用于脱离的方向');
        const distance = Math.hypot(to.x - actor.position.x, to.y - actor.position.y);
        if (distance > withdrawMeters(actor) + 1e-6) throw httpError(400, `战术脱离最多移动 ${withdrawMeters(actor)}m`);
        const moved = this.moveTo(state, actor, to, { ignoreBudget: true, source: 'withdraw', disengageChecked: true });
        this.event(state, 'maneuver_resolved', { maneuver: 'withdraw', actorId: actor.id, distanceMeters: moved, followupMovementMeters: budget.movementMeters, exertion: actor.exertion });
    }

    useLure(state, actor, destination) {
        const budget = state.turnBudget[actor.id];
        if (budget.minor <= 0) throw httpError(400, '本回合次要行动已用尽');
        const maxDistance = 6 + Math.max(0, Number(actor.attributes?.charismaModifier || 0)) * 2;
        const position = destination && Number.isFinite(Number(destination.x)) && Number.isFinite(Number(destination.y)) ? { x: Number(destination.x), y: Number(destination.y) } : { ...actor.position };
        if (Math.hypot(position.x - actor.position.x, position.y - actor.position.y) > maxDistance + 1e-6) throw httpError(400, `诱导点必须在 ${maxDistance}m 内`);
        if (!positionInsideBattlefield(position, .05, state.battlefield)) throw httpError(400, '诱导点位于战场边界外');
        budget.minor -= 1;
        const radiusMeters = 4 + Math.max(0, Number(actor.attributes?.charismaModifier || 0));
        const decoy = { id: `decoy-${state.round}-${state.sequence + 1}-${actor.id}`, actorId: actor.id, side: actor.side, position, radiusMeters, round: state.round, expiresAtRound: state.round + 1 + Math.max(0, Number(actor.attributes?.charismaModifier || 0)) };
        state.intel.decoys.push(decoy); state.intel.decoys = state.intel.decoys.slice(-30);
        const rng = this.rng(state); const affected = [];
        for (const observer of enemiesOf(state, actor)) {
            const entry = this.knowledge(state, observer.id, actor.id);
            if (this.isTracking(entry) || centerDistance({ position }, observer) > radiusMeters + Number(observer.intelProfile?.hearingMeters || 0)) continue;
            const roll = rng.d100(); const modifier = Number(observer.attributes?.spiritModifier || 0) + Number(observer.intelProfile?.perceptionBonus || 0);
            const dc = 50 + Number(actor.attributes?.charismaModifier || 0) + Number(actor.intelProfile?.commandBonus || 0);
            const total = roll.selected + modifier; const success = !(roll.selected >= 96 || (roll.selected > 5 && total >= dc));
            this.event(state, 'maneuver_check', { maneuver: 'lure', actorId: actor.id, observerId: observer.id, rawRolls: roll.rolls, selected: roll.selected, rngIndex: roll.rngIndex, modifier, total, dc, success });
            if (success) {
                const records = state.intel.knowledge[observer.id] ||= {};
                records[actor.id] = { source: 'lure', awareness: 'suspicious', canTarget: false, position: { ...position }, round: state.round, reason: 'lure', expiresAtRound: decoy.expiresAtRound, observedAt: state.sequence + 1 };
                affected.push(observer.id);
            }
        }
        this.saveRng(state, rng);
        this.event(state, 'lure_created', { actorId: actor.id, position, radiusMeters, expiresAtRound: decoy.expiresAtRound, affectedIds: affected });
    }

    async command(state, command) {
        return this.benchmarkMeasureAsync(state, 'engine.command', () => this.commandMeasured(state, command));
    }

    async commandMeasured(state, command) {
        this.assertWritable(state, command.expectedVersion);
        const actor = this.currentActor(state);
        if (!actor || actor.id !== command.actorId) throw httpError(409, '不是该单位的行动时机');
        if (actor.controller !== 'player') throw httpError(403, '该单位不受当前玩家控制');
        if (actor.playerId !== (command.playerId || state.playerId) || actor.seatId !== (command.seatId || state.seatId)) throw httpError(403, '当前席位没有该单位的控制权');
        const budget = state.turnBudget[actor.id] ||= { movement: 1, movementMeters: effectiveSpeed(actor), main: 1, minor: 1, movedMeters: 0, spentExertion: false };
        let endTurn = true;
        if (command.type === 'move_attack') {
            const ability = actor.abilities.find(item => item.id === 'basic-attack');
            const target = state.combatants.find(item => item.id === command.targetId);
            if (!ability) throw httpError(400, '当前单位没有基础攻击');
            if (budget.main <= 0) throw httpError(400, '本回合主要行动已用尽');
            if (actor.cooldowns?.[ability.id]) throw httpError(400, `能力冷却中：剩余 ${actor.cooldowns[ability.id]} 回合`);
            const moved = this.moveAttack(state, actor, target, ability);
            this.resolveAttack(state, actor, [target], ability);
            budget.main -= 1;
            this.event(state, 'move_attack_resolved', { actorId: actor.id, targetId: target.id, abilityId: ability.id, distanceMeters: Math.round(moved * 1000) / 1000 });
            endTurn = this.movementRemaining(state, actor) <= 1e-6;
        } else if (command.type === 'move') {
            if (this.movementRemaining(state, actor) <= 0) throw httpError(400, '本回合移动距离已用尽');
            if (!Number.isFinite(Number(command.x)) || !Number.isFinite(Number(command.y))) {
                // V1 clients submitted a zoneId.  Preserve their command
                // compatibility by advancing toward the nearest opponent,
                // while all V2 clients submit an explicit meter coordinate.
                const target = this.selectTarget(state, actor);
                if (!target) throw httpError(400, '没有可用于旧区域移动的目标');
                const moved = this.moveToward(state, actor, target);
                if (moved) this.consumeMovement(state, actor, moved);
                // Zone-id movement is a V1 compatibility command with no
                // meter target. Keep the actual distance consumed above;
                // legacy callers must not turn movement into a one-shot flag.
                budget.movement = this.movementRemaining(state, actor) > 1e-6 ? 1 : 0;
                actor.zoneId = String(command.zoneId || 'field');
            } else {
                const moved = this.moveTo(state, actor, { x: Number(command.x), y: Number(command.y) });
                this.consumeMovement(state, actor, moved);
            }
            endTurn = false;
        } else if (command.type === 'wait') { budget.movement = 0; budget.movementMeters = 0; budget.main = 0; budget.minor = 0; this.changeExertion(state, actor, 2, 'wait_recovery'); this.event(state, 'unit_waited', { actorId: actor.id, reason: 'player_command' }); }
        else if (command.type === 'sneak' || command.type === 'unsneak') {
            const entering = command.type === 'sneak';
            if (entering) { if (budget.minor <= 0) throw httpError(400, '本回合次要行动已用尽'); this.enterHide(state, actor, { allowStationary: command.type === 'sneak' }); budget.minor -= 1; }
            else this.breakStealth(state, actor, { reason: 'player_cancelled', source: 'player_command' });
            endTurn = false;
        }
        else if (['sprint', 'withdraw', 'evasive', 'hide', 'lure'].includes(command.type)) {
            if (command.type === 'sprint') this.useSprint(state, actor);
            if (command.type === 'withdraw') this.useWithdraw(state, actor, { x: command.x, y: command.y });
            if (command.type === 'evasive') this.useEvasive(state, actor);
            if (command.type === 'hide') { this.enterHide(state, actor); budget.minor -= 1; }
            if (command.type === 'lure') this.useLure(state, actor, { x: command.x, y: command.y });
            endTurn = false;
        }
        else {
            const ability = actor.abilities.find(item => item.id === (command.abilityId || 'basic-attack'));
            if (!ability) throw httpError(400, '能力不存在');
            if (actor.cooldowns?.[ability.id]) throw httpError(400, `能力冷却中：剩余 ${actor.cooldowns[ability.id]} 回合`);
            const actionType = ability.actionType || 'main';
            if (budget[actionType] <= 0) throw httpError(400, `本回合 ${actionType} 行动已用尽`);
            const targets = (command.targetIds || []).map(id => state.combatants.find(item => item.id === id)).filter(Boolean);
            if (!targets.length) throw httpError(400, '请选择目标');
            if (targets.length > ability.targetCount) throw httpError(400, '目标数量超过能力上限');
            this.resolveAttack(state, actor, targets, ability);
            budget[actionType] -= 1;
            const hasAnotherAttack = actor.abilities.some(item => budget[item.actionType || 'main'] > 0 && !actor.cooldowns?.[item.id] && actor.ep >= item.epCost && this.knownTargets(state, actor).some(target => rangeLegal(state, actor, target, item) && this.canEngage(state, actor, target, item)));
            // Movement is a meter pool, not a separate once-per-turn action.
            // Keep the actor in the same turn after an attack whenever any
            // movement points remain, enabling move → attack → retreat.
            endTurn = !hasAnotherAttack && this.movementRemaining(state, actor) <= 1e-6;
        }
        state.commandHistory ||= [];
        if (!command.redo) {
            const replayable = ['move', 'move_attack', 'wait', 'sneak', 'unsneak', 'sprint', 'withdraw', 'evasive', 'hide', 'lure'].includes(command.type) || command.abilityId || command.type === 'attack';
            if (replayable) {
                state.commandHistory.push({ type: command.type || 'attack', actorId: actor.id, abilityId: command.abilityId || null, targetIds: Array.isArray(command.targetIds) ? command.targetIds.map(String) : [], x: Number.isFinite(Number(command.x)) ? Number(command.x) : undefined, y: Number.isFinite(Number(command.y)) ? Number(command.y) : undefined, zoneId: command.zoneId || undefined, playerId: command.playerId || state.playerId, seatId: command.seatId || state.seatId, recordedAtRound: state.round, recordedSequence: state.sequence });
                state.commandHistory = state.commandHistory.slice(-30);
            }
        }
        state.status = 'running'; state.pauseReason = null; if (endTurn) state.cursor += 1;
        if (!this.afterAction(state)) await this.advanceUntilPause(state, state.mode === 'manual' ? 1000 : 10000);
    }

    resolveAttack(state, actor, targets, ability, options = {}) {
        return this.benchmarkMeasure(state, 'engine.resolve-attack', () => this.resolveAttackMeasured(state, actor, targets, ability, options));
    }

    resolveAttackMeasured(state, actor, targets, ability, { allowCounterattack = true, counterattack = false, ignoreEngagement = false, triggerSequence = null, rng: sharedRng = null } = {}) {
        const totalEpCost = Math.ceil(ability.epCost * (ability.aoe ? 1 : targetCostMultiplier(targets.length)));
        if (actor.ep < totalEpCost) throw httpError(400, 'EP 不足');
        for (const target of targets) {
            if (!living(target)) throw httpError(400, `目标 ${target.id} 已失能`);
            if (!this.canTarget(state, actor, target)) throw httpError(400, `目标 ${target.id} 尚未被发现`);
            if (!rangeLegal(state, actor, target, ability)) throw httpError(400, `目标 ${target.id} 超出能力射程`);
            if (!ignoreEngagement && !this.canEngage(state, actor, target, ability)) throw httpError(400, `目标 ${target.id} 的近战接触位本回合已分配给其他实体`);
        }
        const rng = sharedRng || this.rng(state);
        actor.ep -= totalEpCost;
        if (Number(ability.cooldownRounds || 0) > 0) actor.cooldowns[ability.id] = Number(ability.cooldownRounds);
        if (ability.script) throw httpError(409, '脚本能力需通过脚本命令执行');
        // Snapshot surprise before the action reveals its source.  The
        // previous ordering cleared stealth first, which made an otherwise
        // valid ambush permanently evaluate to false.
        const stealthAtAttack = this.isStealthed(actor);
        const ambushTargetIds = new Set(stealthAtAttack ? targets.filter(target => !this.isTracking(this.knowledge(state, target.id, actor.id))).map(target => target.id) : []);
        this.breakStealth(state, actor, { reason: 'attack', source: 'attack' });
        this.emitNoise(state, actor, { reason: counterattack ? 'counterattack' : 'attack', radiusMeters: actor.intelProfile?.attackNoiseMeters, rng });
        const results = [];
        for (const [index, target] of targets.entries()) {
            const ambush = ambushTargetIds.has(target.id);
            this.recordEngagement(state, actor, target, ability);
            if (isMeleeAbility(ability)) this.updateKnowledge(state, target, actor, { source: 'melee_contact', reason: 'melee_attack_received', force: true });
            const evasive = target.statuses.find(item => item.id === 'evasive' && Number(item.remainingAttacks || 0) > 0);
            // A target that has not tracked a concealed attacker is being
            // ambushed.  This is an ordinary D100 advantage, not added damage
            // or an unseen balance multiplier; melee contact immediately
            // reveals the attacker afterwards through updateKnowledge above.
            const roll = rng.d100(evasive ? 'disadvantage' : ambush || actor.statuses.some(item => item.id === 'advantage') ? 'advantage' : actor.statuses.some(item => item.id === 'disadvantage') ? 'disadvantage' : 'normal');
            const total = roll.selected + actor.attackModifier + actor.tierCorrection + ability.modifier;
            const effectiveDefenseDC = target.defenseDC + target.statuses.reduce((sum, status) => sum + Number(status.defenseBonus || 0), 0);
            const hit = total >= effectiveDefenseDC;
            let damage = null, applied = null;
            if (hit) {
                damage = damageValue(actor, target, ability, roll.selected >= 96);
                const multiplier = !ability.aoe && index > 0 ? .7 : 1;
                applied = applyDamage(target, Math.round(damage.final * multiplier));
                if (target.state !== applied.before.state) this.event(state, 'unit_state_changed', { unitId: target.id, from: applied.before.state, to: target.state });
                if (target.state === 'dying' && applied.before.state === 'active') actor.kills += 1;
                this.checkBossPhase(state, target);
            }
            const result = { targetId: target.id, rawRolls: roll.rolls, selected: roll.selected, rngIndex: roll.rngIndex, modifier: actor.attackModifier + actor.tierCorrection + ability.modifier, total, defenseDC: effectiveDefenseDC, ambush, outcome: roll.selected <= 5 ? 'disaster' : roll.selected >= 96 ? 'miracle' : hit ? 'hit' : 'miss', damage, applied };
            const attackBasis = {
                actor: { id: actor.id, attack: actor.attack, magicAttack: actor.magicAttack, attackModifier: actor.attackModifier, tierCorrection: actor.tierCorrection },
                ability: { id: ability.id, name: ability.name, type: ability.type, power: ability.power, modifier: ability.modifier, minRangeMeters: ability.minRangeMeters, maxRangeMeters: ability.maxRangeMeters, aoe: ability.aoe },
                target: { id: target.id, defenseDC: effectiveDefenseDC, armor: target.armor, resistance: target.resistance },
                edgeDistanceMeters: Math.round(edgeDistance(actor, target) * 1000) / 1000,
                legalRange: rangeLegal(state, actor, target, ability),
                contactSlot: isMeleeAbility(ability) ? (state.meleeSlots?.targets?.[target.id]?.attackerIds || []).indexOf(actor.id) + 1 : null,
            };
            results.push(result);
            const attackEvent = this.event(state, 'attack_check', { actorId: actor.id, abilityId: ability.id, ...result, attackBasis, counterattack: Boolean(counterattack), triggerSequence });
            if (evasive) {
                evasive.remainingAttacks = Math.max(0, Number(evasive.remainingAttacks || 0) - 1);
                if (!evasive.remainingAttacks) target.statuses = target.statuses.filter(status => status !== evasive);
                this.event(state, 'evasion_consumed', { targetId: target.id, actorId: actor.id, remainingAttacks: evasive.remainingAttacks });
            }
            // A melee hit or miss still creates immediate contact.  The
            // default passive retaliates once for this incoming attack while
            // the defender remains active. Counterattacks opt out of this
            // hook so two melee units cannot recurse forever.
            if (allowCounterattack && isMeleeAbility(ability) && living(target) && living(actor)) {
                this.resolveMeleeCounterattack(state, target, actor, attackEvent, rng);
            }
            if (!living(actor)) break;
        }
        if (!sharedRng) this.saveRng(state, rng);
        this.event(state, 'action_resolved', { actorId: actor.id, abilityId: ability.id, epCost: totalEpCost, targetCostMultiplier: ability.aoe ? 1 : targetCostMultiplier(targets.length), results, counterattack: Boolean(counterattack), triggerSequence });
    }

    counterattackAbility(unit) {
        const passive = (unit.passives || []).find(item => item.id === 'melee-counterattack' && item.enabled !== false);
        if (!passive) return null;
        const preferred = unit.abilities?.find(item => item.id === (passive.abilityId || 'basic-attack') && (item.id === 'basic-attack' || isMeleeAbility(item)));
        return preferred || unit.abilities?.find(item => item.id === 'basic-attack' || isMeleeAbility(item)) || null;
    }

    resolveMeleeCounterattack(state, defender, attacker, triggerEvent, sharedRng = null) {
        const ability = this.counterattackAbility(defender);
        if (!ability || !living(defender) || !living(attacker) || !rangeLegal(state, defender, attacker, ability)) return;
        const passive = (defender.passives || []).find(item => item.id === 'melee-counterattack');
        this.event(state, 'counterattack_triggered', {
            actorId: defender.id, targetId: attacker.id, abilityId: ability.id,
            passiveId: passive?.id || 'melee-counterattack', triggerSequence: triggerEvent?.sequence || null,
            incomingOutcome: triggerEvent?.payload?.outcome || null,
        });
        this.resolveAttack(state, defender, [attacker], ability, { allowCounterattack: false, counterattack: true, ignoreEngagement: true, triggerSequence: triggerEvent?.sequence || null, rng: sharedRng });
    }

    canEngage(state, actor, target, ability) {
        if (!this.canTarget(state, actor, target) || !rangeLegal(state, actor, target, ability)) return false;
        if (!isMeleeAbility(ability)) return true;
        // A manually controlled player chooses the contact point at action
        // time. Do not make that choice depend on a stale or policy-selected
        // melee slot from an earlier snapshot; the eight-slot limit applies to
        // automatic attackers competing for the target, not to the player's
        // own legal melee target selection.
        if (actor.side === 'player' && actor.controller === 'player') return true;
        if (this.hasMeleeSlot(state, actor, target)) return true;
        // A melee AOE consumes one contact position at its primary target,
        // but may resolve its remaining in-range targets as the same sweep.
        return Boolean(ability.aoe && Object.values(state.meleeSlots?.targets || {}).some(entry => entry.attackerIds?.includes(actor.id)));
    }

    moveTo(state, actor, destination, { ignoreBudget = false, source = 'player', disengageChecked = false } = {}) {
        const to = { x: Number(destination?.x), y: Number(destination?.y) };
        if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) throw httpError(400, '移动坐标必须是有限数字');
        const from = { ...actor.position };
        const distance = Math.hypot(to.x - from.x, to.y - from.y);
        const available = this.movementRemaining(state, actor);
        if (!ignoreBudget && distance > available + 1e-6) throw httpError(400, `移动距离 ${distance.toFixed(2)}m 超过本回合剩余移动 ${available.toFixed(1)}m`);
        // A no-op coordinate is not movement.  In particular it must not
        // produce a footstep/noise event that wakes a nearby group merely
        // because an automatic policy re-evaluated an already optimal point.
        if (distance <= 1e-6) return 0;
        if (!disengageChecked && this.wouldLeaveContact(state, actor, to) && !this.attemptDisengage(state, actor, { reason: 'ordinary_movement' })) throw httpError(400, '脱离检定失败，无法离开近战接触', { blockingUnitIds: this.adjacentOpponents(state, actor).map(unit => unit.id) });
        if (!positionInsideBattlefield(to, actor.radiusMeters, state.battlefield)) throw httpError(400, '目标落点位于战场边界之外');
        const blocker = state.combatants.find(unit => unit.id !== actor.id && living(unit) && Math.hypot(to.x - unit.position.x, to.y - unit.position.y) < actor.radiusMeters + unit.radiusMeters - 1e-6);
        if (blocker) throw httpError(400, `目标落点与 ${blocker.name} 重叠`);
        actor.position = { x: Math.round(to.x * 1000) / 1000, y: Math.round(to.y * 1000) / 1000 };
        if (distance > 1e-6) actor.facingDegrees = Math.round((Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI + 360) % 360);
        this.event(state, 'unit_moved', { actorId: actor.id, from, to: actor.position, distanceMeters: Math.round(distance * 1000) / 1000, source });
        if (distance > 1e-6) this.emitNoise(state, actor, { reason: 'movement', radiusMeters: this.isStealthed(actor) ? Math.min(3, Number(actor.intelProfile?.movementNoiseMeters ?? 3)) : actor.intelProfile?.movementNoiseMeters });
        this.refreshIntelligence(state, { reason: 'movement', affectedIds: [actor.id] });
        // Contact positions are spatial, not initiative-static. A move can
        // bring a new attacker into melee range (or take one out of it), so
        // retain the eight-per-target rule against the new coordinates before
        // the player is allowed to issue the next action in this same round.
        // Automatic movement is already pre-budgeted by the round allocator;
        // rebuilding the full roster after every AI step would turn a large
        // horde into an O(n²) hot path. Player/script movement is the case
        // where a subsequent explicit attack must see fresh contact slots.
        if ((source === 'player' || source === 'script' || actor.side === 'player') && state.round > 0 && state.status !== 'completed' && state.status !== 'abandoned') this.allocateMeleeSlots(state);
        return distance;
    }

    moveTowardPoint(state, actor, point, { maxMeters = null, source = 'search' } = {}) {
        const dx = Number(point.x) - actor.position.x, dy = Number(point.y) - actor.position.y;
        const distance = Math.hypot(dx, dy); if (distance <= 1e-6) return false;
        const travel = Math.min(this.movementRemaining(state, actor), Number.isFinite(Number(maxMeters)) ? Math.max(0, Number(maxMeters)) : Infinity, distance); if (travel <= 1e-6) return false;
        try { const moved = this.moveTo(state, actor, { x: actor.position.x + dx / distance * travel, y: actor.position.y + dy / distance * travel }, { source }); return moved; }
        catch { this.event(state, 'unit_waited', { actorId: actor.id, reason: 'blocked_search_movement' }); return false; }
    }

    moveToward(state, actor, target) {
        const preferred = actor.abilities.map(item => Number(item.maxRangeMeters || 0)).filter(value => value > 0).sort((a, b) => a - b)[0] || 1.5;
        const current = centerDistance(actor, target);
        const desired = Math.max(actor.radiusMeters + target.radiusMeters + .05, preferred * .82 + actor.radiusMeters + target.radiusMeters);
        const travel = Math.min(this.movementRemaining(state, actor), Math.max(0, current - desired));
        if (travel <= 1e-6) return false;
        const dx = (target.position.x - actor.position.x) / current, dy = (target.position.y - actor.position.y) / current;
        // Pure 2D, deliberately not pathfinding: try the direct vector and
        // four deterministic sidesteps so a dense formation cannot turn one
        // blocked circle into a permanent no-action loop.
        const angles = [0, Math.PI / 6, -Math.PI / 6, Math.PI / 3, -Math.PI / 3];
        for (const angle of angles) {
            const cos = Math.cos(angle), sin = Math.sin(angle);
            const vx = dx * cos - dy * sin, vy = dx * sin + dy * cos;
            try {
                const moved = this.moveTo(state, actor, { x: actor.position.x + vx * travel, y: actor.position.y + vy * travel }, { source: 'automatic' });
                if (angle) this.event(state, 'maneuver_resolved', { maneuver: 'sidestep', actorId: actor.id, targetId: target.id, angleDegrees: Math.round(angle * 180 / Math.PI), distanceMeters: moved });
                return moved;
            } catch { /* deterministic candidate fallback */ }
        }
        this.event(state, 'unit_waited', { actorId: actor.id, reason: 'blocked_movement' }); return false;
    }

    retreatFromTarget(state, actor, target) {
        if (this.adjacentOpponents(state, actor).length && !this.attemptDisengage(state, actor, { reason: 'strategy_retreat' })) {
            this.event(state, 'unit_waited', { actorId: actor.id, reason: 'retreat_disengage_failed', targetId: target.id });
            return false;
        }
        const dx = actor.position.x - target.position.x;
        const dy = actor.position.y - target.position.y;
        const distance = Math.hypot(dx, dy);
        const speed = this.movementRemaining(state, actor);
        if (speed <= 1e-6) return false;
        const directions = [];
        if (distance > 1e-6) directions.push({ x: dx / distance, y: dy / distance });
        else {
            const angle = Number(actor.facingDegrees || 0) * Math.PI / 180;
            directions.push({ x: -Math.cos(angle), y: -Math.sin(angle) });
        }
        // If the direct retreat vector reaches a boundary or another unit,
        // try the two perpendicular vectors before giving up this movement.
        const primary = directions[0] || { x: -1, y: 0 };
        directions.push({ x: -primary.y, y: primary.x }, { x: primary.y, y: -primary.x });
        for (const direction of directions) {
            const destination = { x: actor.position.x + direction.x * speed, y: actor.position.y + direction.y * speed };
            try {
                const moved = this.moveTo(state, actor, destination, { source: 'strategy', disengageChecked: true });
                this.event(state, 'strategy_retreat', { actorId: actor.id, targetId: target.id, distanceMeters: speed, destination: actor.position });
                return moved;
            } catch { /* try the next escape vector */ }
        }
        this.event(state, 'unit_waited', { actorId: actor.id, reason: 'retreat_blocked', targetId: target.id });
        return false;
    }

    retreatFromThreats(state, actor, { reason = 'guerrilla_escape', disengageChecked = false } = {}) {
        const threats = this.knownThreats(state, actor);
        const speed = this.movementRemaining(state, actor);
        if (speed <= 1e-6) return false;
        if (!threats.length) {
            this.event(state, 'unit_waited', { actorId: actor.id, reason: 'retreat_no_confirmed_threat' });
            return false;
        }
        if (!disengageChecked && this.adjacentOpponents(state, actor).length && !this.attemptDisengage(state, actor, { reason })) {
            this.event(state, 'unit_waited', { actorId: actor.id, reason: 'retreat_disengage_failed' });
            return false;
        }
        // Sum inverse-distance vectors away from *known* threats. Candidate
        // rotations avoid using one target as a misleading escape axis when
        // the player is already between several pursuers.
        let awayX = 0, awayY = 0;
        for (const threat of threats) {
            const dx = actor.position.x - threat.position.x, dy = actor.position.y - threat.position.y;
            const distance = Math.max(1, Math.hypot(dx, dy));
            const weight = 1 / distance;
            awayX += dx / distance * weight; awayY += dy / distance * weight;
        }
        let angle = Math.atan2(awayY, awayX);
        if (!Number.isFinite(angle) || Math.hypot(awayX, awayY) < 1e-6) angle = Number(actor.facingDegrees || 0) * Math.PI / 180 + Math.PI;
        const offsets = [0, Math.PI / 8, -Math.PI / 8, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI * .75, -Math.PI * .75];
        const candidates = offsets.map(offset => {
            const direction = { x: Math.cos(angle + offset), y: Math.sin(angle + offset) };
            const destination = { x: actor.position.x + direction.x * speed, y: actor.position.y + direction.y * speed };
            // Favour the candidate that maximises its minimum separation,
            // rather than merely running away from the current focus target.
            const minDistance = Math.min(...threats.map(threat => Math.hypot(destination.x - threat.position.x, destination.y - threat.position.y)));
            return { direction, destination, minDistance, offset };
        }).sort((a, b) => b.minDistance - a.minDistance || Math.abs(a.offset) - Math.abs(b.offset));
        for (const candidate of candidates) {
            try {
                const moved = this.moveTo(state, actor, candidate.destination, { source: 'strategy', disengageChecked: true });
                this.event(state, 'strategy_retreat', { actorId: actor.id, reason, threatIds: threats.map(item => item.unit.id).slice(0, 24), distanceMeters: moved, destination: actor.position, minimumSeparationMeters: Math.round(candidate.minDistance * 1000) / 1000 });
                return moved;
            } catch { /* evaluate the next deterministic legal escape vector */ }
        }
        this.event(state, 'unit_waited', { actorId: actor.id, reason: 'retreat_blocked', threatIds: threats.map(item => item.unit.id).slice(0, 24) });
        return false;
    }

    resolveGuerrillaEscape(state, actor, memory, { afterStrike = false } = {}) {
        const budget = state.turnBudget[actor.id] ||= { movement: 1, movementMeters: effectiveSpeed(actor), main: 1, minor: 1, movedMeters: 0, spentExertion: false };
        const pressure = this.enemyPressure(state, actor);
        const enemyTracking = () => enemiesOf(state, actor).filter(observer => this.isTracking(this.knowledge(state, observer.id, actor.id)));
        this.event(state, 'guerrilla_escape_assessed', { actorId: actor.id, afterStrike, posture: memory.posture, escapeRounds: memory.escapeRounds, adjacentIds: pressure.adjacent.map(unit => unit.id), immediateThreatIds: pressure.immediate.map(item => item.unit.id), knownThreatIds: pressure.threats.map(item => item.unit.id).slice(0, 24), enemyTrackingIds: enemyTracking().map(unit => unit.id).slice(0, 24) });

        let clearedContact = !pressure.adjacent.length;
        if (pressure.adjacent.length && budget.minor > 0 && Number(actor.exertion || 0) > 0) {
            try { this.useWithdraw(state, actor); clearedContact = true; }
            catch (error) {
                this.event(state, 'maneuver_failed', { maneuver: 'withdraw', actorId: actor.id, reason: error.message });
                if (budget.minor > 0) this.useEvasive(state, actor);
            }
        }

        // Once a pursuer is outside visual range, hiding is the decisive
        // step.  It is a real D100 check per tracker, not an automatic local
        // deletion of hostile knowledge.  While still observed, spend the
        // minor action on a sprint to exploit the DEX-derived speed edge.
        const trackersBeforeHide = enemyTracking();
        const outsideAllTrackingFov = trackersBeforeHide.length > 0 && trackersBeforeHide.every(observer => !this.inVisualField(observer, actor));
        if (clearedContact && budget.minor > 0 && outsideAllTrackingFov) {
            let hidden;
            if (this.isStealthed(actor)) {
                const result = this.attemptBreakTracking(state, actor, 'guerrilla_retry_hide');
                hidden = { cancelled: false, ...result, retry: true };
                this.event(state, 'hide_resolved', { actorId: actor.id, source: 'guerrilla_retry', ...hidden });
            } else hidden = this.enterHide(state, actor, { source: 'guerrilla_escape', allowStationary: true });
            budget.minor -= 1;
            if (!enemyTracking().length) this.setGuerrillaPosture(state, actor, memory, 'recon', 'tracking_broken', { hide: hidden });
        } else if (clearedContact && budget.minor > 0 && Number(actor.exertion || 0) > 0 && this.movementRemaining(state, actor) > 0) {
            this.useSprint(state, actor);
        }

        if (this.movementRemaining(state, actor) > 0) {
            const moved = this.retreatFromThreats(state, actor, { reason: afterStrike ? 'post_strike_escape' : 'guerrilla_escape', disengageChecked: clearedContact });
            if (moved) this.consumeMovement(state, actor, moved);
        }
        memory.escapeRounds += 1;
        if (!enemyTracking().length && !pressure.adjacent.length && memory.posture === 'escape') this.setGuerrillaPosture(state, actor, memory, 'recon', 'no_active_tracking');
    }

    recordEngagement(state, actor, target, ability) {
        if (!isMeleeAbility(ability)) return;
        const list = state.engagements[target.id] ||= [];
        if (!list.includes(actor.id)) list.push(actor.id);
    }

    async scriptCommand(state, command) {
        this.assertWritable(state, command.expectedVersion);
        const actor = this.currentActor(state);
        const ability = actor?.abilities.find(item => item.id === command.abilityId);
        if (!actor || actor.id !== command.actorId || !ability?.script) throw httpError(400, '当前脚本能力无效');
        if (actor.playerId !== (command.playerId || state.playerId) || actor.seatId !== (command.seatId || state.seatId)) throw httpError(403, '当前席位没有该单位的控制权');
        const budget = state.turnBudget[actor.id] ||= { movement: 1, main: 1, minor: 1 };
        const actionType = ability.actionType || 'main';
        if (actor.cooldowns?.[ability.id]) throw httpError(400, `能力冷却中：剩余 ${actor.cooldowns[ability.id]} 回合`);
        if (budget[actionType] <= 0) throw httpError(400, `本回合 ${actionType} 行动已用尽`);
        const targets = (command.targetIds || []).map(id => state.combatants.find(item => item.id === id)).filter(Boolean);
        if (!targets.length) throw httpError(400, '请选择脚本能力目标');
        for (const target of targets) if (!this.canEngage(state, actor, target, ability)) throw httpError(400, `目标 ${target.id} 尚未发现、超出射程或近战接触位已满`);
        if (!await this.executeScriptAbility(state, actor, targets, ability)) return;
        budget[actionType] -= 1;
        const hasAnotherAttack = actor.abilities.some(item => budget[item.actionType || 'main'] > 0 && !actor.cooldowns?.[item.id] && actor.ep >= item.epCost && this.knownTargets(state, actor).some(target => this.canEngage(state, actor, target, item)));
        const endTurn = !hasAnotherAttack && this.movementRemaining(state, actor) <= 1e-6;
        state.status = 'running'; state.pauseReason = null; if (endTurn) state.cursor += 1;
        if (!this.afterAction(state)) await this.advanceUntilPause(state, state.mode === 'manual' ? 1000 : 10000);
    }

    async executeScriptAbility(state, actor, targets, ability) {
        const hash = ability.scriptHash || scriptHash(ability.script);
        if (!this.repository.isScriptApproved(hash, state.rulesetVersion)) throw httpError(428, '脚本尚未审批');
        if (actor.ep < ability.epCost) throw httpError(400, 'EP 不足');
        actor.ep -= ability.epCost;
        if (Number(ability.cooldownRounds || 0) > 0) actor.cooldowns[ability.id] = Number(ability.cooldownRounds);
        try {
            this.breakStealth(state, actor, { reason: 'script_ability', source: 'attack' });
            this.emitNoise(state, actor, { reason: 'script_ability', radiusMeters: actor.intelProfile?.attackNoiseMeters });
            if (isMeleeAbility(ability)) for (const target of targets) this.updateKnowledge(state, target, actor, { source: 'melee_contact', reason: 'melee_script_received', force: true });
            const output = await runScript(ability.script, { ability: { ...ability, script: undefined }, actor: deepClone(actor), targets: deepClone(targets), snapshot: { round: state.round, zones: state.zones } });
            this.applyEffects(state, actor, output.effects);
            this.event(state, 'script_action_resolved', { actorId: actor.id, abilityId: ability.id, scriptHash: hash, epCost: ability.epCost, effects: output.effects });
            return true;
        } catch (error) {
            actor.ep += ability.epCost;
            this.pause(state, { type: 'script_error', actorId: actor.id, abilityId: ability.id, scriptHash: hash, error: error.message });
            return false;
        }
    }

    applyEffects(state, actor, effects) {
        for (const effect of effects) {
            const target = state.combatants.find(item => item.id === effect.targetId);
            if (effect.type === 'damage' && target) {
                const applied = applyDamage(target, Math.max(0, Math.round(effect.amount)));
                if (target.state !== applied.before.state) this.event(state, 'unit_state_changed', { unitId: target.id, from: applied.before.state, to: target.state });
                this.checkBossPhase(state, target);
            }
            else if (effect.type === 'heal' && target) { const beforeState = target.state; target.hp = Math.min(target.maxHp, target.hp + Math.max(0, Math.round(effect.amount))); if (target.hp > 0 && target.state === 'dying') target.state = 'active'; if (beforeState !== target.state) this.event(state, 'unit_state_changed', { unitId: target.id, from: beforeState, to: target.state }); }
            else if (effect.type === 'status' && target) target.statuses.push({ id: effect.status, duration: Math.max(1, Math.round(effect.duration)) });
            else if (effect.type === 'dispel' && target) target.statuses = target.statuses.filter(item => item.id !== effect.status);
            else if (effect.type === 'move' && target && effect.position && Number.isFinite(Number(effect.position.x)) && Number.isFinite(Number(effect.position.y))) this.moveTo(state, target, effect.position, { ignoreBudget: true, source: 'script' });
            else if (effect.type === 'resource' && target && ['hp', 'ep', 'thp'].includes(effect.resource)) target[effect.resource] = Math.max(0, Math.min(effect.resource === 'ep' ? target.maxEp : effect.resource === 'hp' ? target.maxHp : Infinity, target[effect.resource] + effect.delta));
            else if (!['log'].includes(effect.type)) throw httpError(400, `脚本效果 ${effect.type} 未通过核心校验`);
            this.event(state, 'script_effect_applied', { actorId: actor.id, effect });
        }
    }

    afterAction(state) {
        const dyingPlayer = state.combatants.find(unit => unit.side === 'player' && unit.state === 'dying');
        // A real encounter protects the player with a takeover pause.  A
        // transient auto simulator is intentionally a full-run benchmark, so
        // it proceeds to a terminal winner instead of stopping at that guard.
        if (dyingPlayer && !(state.transient && state.mode === 'auto')) { this.pause(state, { type: 'player_dying', unitId: dyingPlayer.id }); return true; }
        const winner = this.winner(state);
        if (winner) { this.complete(state, winner); return true; }
        if (state.pendingReaction) {
            if (state.transient && state.mode === 'auto') { this.resolveAutoReaction(state); return false; }
            this.pause(state, { type: 'reaction_window', ...state.pendingReaction }); return true;
        }
        if (state.mode === 'semi') {
            const triggers = evaluateTriggers(state);
            if (triggers.length) { this.pause(state, { type: 'takeover_trigger', triggers }); return true; }
        }
        return false;
    }

    resolveAutoReaction(state) {
        const reaction = state.pendingReaction;
        if (!reaction) return;
        const actor = state.combatants.find(unit => unit.side === 'player' && living(unit));
        const target = state.combatants.find(unit => unit.id === reaction.unitId);
        const choice = this.strategyFor(state, actor)?.reactionPolicy === 'conserve' ? 'defend' : 'interrupt';
        if (choice === 'defend' && actor) actor.statuses.push({ id: 'reaction_defend', name: '反应防御', defenseBonus: 10, duration: 2 });
        if (choice === 'interrupt' && actor && target) {
            const rng = this.rng(state); const roll = rng.d100(); const total = roll.selected + actor.attackModifier + actor.tierCorrection; const dc = 100 + target.tierCorrection;
            if (total >= dc) target.statuses.push({ id: 'interrupted', name: '被打断', duration: 1 });
            this.saveRng(state, rng); this.event(state, 'reaction_check', { actorId: actor.id, targetId: target.id, choice, rawRolls: roll.rolls, selected: roll.selected, modifier: actor.attackModifier + actor.tierCorrection, total, dc, success: total >= dc, rngIndex: roll.rngIndex, automatic: true });
        }
        state.pendingReaction = null;
        this.event(state, 'reaction_resolved', { choice, source: 'simulator_auto_policy', reaction, automatic: true });
    }

    finishRound(state) {
        const progress = sha256(state.combatants.map(unit => [unit.id, unit.hp, unit.thp, unit.ep, unit.position, unit.state, unit.statuses, unit.reachedPhases]));
        state.noChangeRounds = progress === state.lastProgressHash ? state.noChangeRounds + 1 : 0; state.lastProgressHash = progress;
        this.event(state, 'round_completed', { round: state.round, progressHash: progress, noChangeRounds: state.noChangeRounds });
        if (state.noChangeRounds >= 10) return this.pause(state, { type: 'stalemate', rounds: 10 });
        const limit = state.combatants.some(unit => unit.side === 'player' && this.strategyFor(state, unit)?.guerrilla) ? 420 : 200;
        if (state.round >= limit) return this.pause(state, { type: 'round_limit', rounds: limit });
        this.beginRound(state);
    }

    checkBossPhase(state, target) {
        if (!target.boss || target.state !== 'active') return;
        const percent = target.hp / target.maxHp * 100;
        for (const threshold of target.phases) if (percent <= threshold && !target.reachedPhases.includes(threshold)) {
            target.reachedPhases.push(threshold); state.flags.bossPhaseChanged = true;
            state.pendingReaction = { type: 'boss_phase', unitId: target.id, threshold, options: ['interrupt', 'defend', 'policy'] };
            this.event(state, 'boss_phase_changed', { unitId: target.id, threshold, hpPercent: percent });
        }
    }

    winner(state) {
        const playerActive = state.combatants.some(unit => unit.side === 'player' && living(unit));
        const enemyActive = state.combatants.some(unit => unit.side === 'enemy' && living(unit));
        if (!enemyActive) return 'player';
        if (!playerActive) return 'enemy';
        return null;
    }

    complete(state, winner) {
        state.status = 'completed'; state.activeUnitId = null; state.pauseReason = null;
        const events = [...this.repository.events(state.id), ...state.pendingEvents];
        const finalSnapshot = { battlefield: deepClone(state.battlefield), combatants: deepClone(state.combatants), zones: deepClone(state.zones), intel: deepClone(state.intel), meleeSlots: deepClone(state.meleeSlots), round: state.round };
        const protagonist = state.combatants.find(unit => unit.side === 'player' && unit.controller === 'player') || state.combatants.find(unit => unit.side === 'player');
        state.finalResult = {
            battleId: state.id, winner, rulesetVersion: state.rulesetVersion, seed: state.seed, initialHash: state.initialHash,
            eventHash: events.at(-1)?.hash || null, rounds: state.round, initialState: state.initialSnapshot, finalState: finalSnapshot,
            casualties: state.combatants.filter(unit => unit.state !== 'active').map(unit => ({ id: unit.id, name: unit.name, side: unit.side, state: unit.state })),
            keyEvents: events.filter(event => ['initiative_roll', 'initiative_order_locked', 'round_started', 'attack_check', 'counterattack_triggered', 'unit_state_changed', 'boss_phase_changed', 'player_dying', 'intel_detected', 'intel_shared', 'noise_emitted', 'melee_slots_allocated', 'awareness_changed', 'tracking_lost', 'maneuver_check', 'maneuver_resolved', 'lure_created', 'withdrawal_resolved', 'activation_summary'].includes(event.type)).slice(-200),
            checkResults: events.filter(event => event.type === 'attack_check').map(event => event.payload),
            mvuPatch: protagonist ? [
                { op: 'replace', path: '/stat_data/系统状态/是否战斗中', value: false },
                { op: 'replace', path: '/stat_data/系统状态/当前轮次', value: state.round },
                { op: 'replace', path: '/stat_data/主角/HP', value: protagonist.hp },
                { op: 'replace', path: '/stat_data/主角/EP', value: protagonist.ep },
            ] : [],
            narrativeAnchors: this.buildNarrativeAnchors(events),
        };
        this.event(state, 'combat_completed', { winner, rounds: state.round, resultHash: sha256({ winner, rounds: state.round, seed: state.seed, initialHash: state.initialHash, finalState: finalSnapshot, casualties: state.finalResult.casualties, checkResults: state.finalResult.checkResults }) });
        // The result is part of the terminal event.  Expose that terminal
        // hash instead of the pre-completion hash so result/replay consumers
        // can verify the same final ledger tip.
        state.finalResult.eventHash = state.lastEventHash;
    }

    buildNarrativeAnchors(events) {
        return events.filter(event => ['initiative_roll', 'initiative_order_locked', 'round_started', 'attack_check', 'counterattack_triggered', 'boss_phase_changed', 'unit_state_changed', 'intel_detected', 'intel_shared', 'noise_emitted', 'melee_slots_allocated', 'awareness_changed', 'tracking_lost', 'maneuver_resolved', 'lure_created', 'withdrawal_resolved'].includes(event.type)).slice(-250).map(event => ({ sequence: event.sequence, round: event.round, type: event.type, data: event.payload }));
    }

    pause(state, reason) { state.status = 'paused'; state.pauseReason = reason; this.event(state, 'combat_paused', reason); }
    async resume(state) { this.assertWritable(state); state.status = 'running'; state.pauseReason = null; this.event(state, 'combat_resumed'); await this.advanceUntilPause(state, state.mode === 'manual' ? 1000 : 10000); }
    async reaction(state, input = {}) {
        this.assertWritable(state);
        if (!state.pendingReaction) throw httpError(409, '当前没有反应窗口');
        const reaction = state.pendingReaction;
        const actor = state.combatants.find(unit => unit.side === 'player' && unit.controller === 'player' && living(unit)) || state.combatants.find(unit => unit.side === 'player' && living(unit));
        const target = state.combatants.find(unit => unit.id === reaction.unitId);
        const choice = input.choice === 'policy' ? (this.strategyFor(state, actor)?.reactionPolicy === 'conserve' ? 'defend' : 'interrupt') : input.choice;
        if (choice === 'defend' && actor) actor.statuses.push({ id: 'reaction_defend', name: '反应防御', defenseBonus: 10, duration: 2 });
        if (choice === 'interrupt' && actor && target) {
            const rng = this.rng(state); const roll = rng.d100(); const total = roll.selected + actor.attackModifier + actor.tierCorrection; const dc = 100 + target.tierCorrection;
            if (total >= dc) target.statuses.push({ id: 'interrupted', name: '被打断', duration: 1 });
            this.saveRng(state, rng); this.event(state, 'reaction_check', { actorId: actor.id, targetId: target.id, choice, rawRolls: roll.rolls, selected: roll.selected, modifier: actor.attackModifier + actor.tierCorrection, total, dc, success: total >= dc, rngIndex: roll.rngIndex });
        }
        state.pendingReaction = null; this.event(state, 'reaction_resolved', { choice, source: input.choice || 'policy', reaction });
        await this.resume(state);
    }
    setControl(state, input) {
        const unit = state.combatants.find(item => item.id === input.unitId);
        if (!unit || unit.side !== 'player') throw httpError(400, '只能切换玩家方单位');
        if (input.controller !== undefined) unit.controller = input.controller === 'ai' ? 'ai' : 'player';
        if (input.modeOverride !== undefined) unit.controlMode = ['manual', 'auto'].includes(input.modeOverride) ? input.modeOverride : null;
        unit.playerId = input.playerId || unit.playerId; unit.seatId = input.seatId || unit.seatId;
        this.event(state, 'control_changed', { unitId: unit.id, controller: unit.controller, controlMode: unit.controlMode || 'follow', playerId: unit.playerId, seatId: unit.seatId });
    }
    setMode(state, mode) { if (!MODES.has(mode)) throw httpError(400, '控制模式无效'); state.mode = mode; this.event(state, 'mode_changed', { mode }); }
    rng(state) { return new DeterministicRng(state.seed, state.rng.state, state.rng.index); }
    saveRng(state, rng) { state.rng = rng.snapshot(); }
}

export function httpError(status, message, details = null) { const error = new Error(message); error.status = status; if (details) error.details = details; return error; }
