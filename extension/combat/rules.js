import { makeId } from './util.js';
import { combatantFromMvu } from './adapter.js';

const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));
const asNumber = (value, fallback) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export const QUALITY_DC = Object.freeze({ F: 40, E: 50, D: 75, C: 100, B: 130, A: 160, S: 190, SS: 230, SSS: 280 });

// `radiusMeters` is the physical collision radius of one body. It is kept
// separate from a group's distribution radius and, when explicitly supplied,
// is preserved as-is. The model is allowed to describe unusual bodies.
export function entityRadiusMeters(source = {}) {
    const raw = source.radiusMeters ?? source.bodyRadiusMeters ?? source['占地半径'];
    if (raw === undefined || raw === null || raw === '') return .5;
    return Number.isFinite(Number(raw)) ? Number(raw) : .5;
}

export function checkOutcome(raw, total, dc) {
    if (raw <= 5) return 'disaster';
    if (raw >= 96) return 'miracle';
    return total >= dc ? 'success' : 'failure';
}

export function targetCostMultiplier(count) {
    return count <= 1 ? 1 : count === 2 ? 1.5 : count === 3 ? 2 : count === 4 ? 2.5 : 3;
}

const round = value => Math.round(Number(value) * 1000) / 1000;
const point = value => ({ x: round(value?.x), y: round(value?.y) });
const finite = value => Number.isFinite(Number(value));
const TACTICAL_ARCHETYPES = new Set(['scattered', 'squad', 'hive']);
const TACTICAL_OBJECTIVES = new Set(['search', 'engage', 'hold']);
const TACTICAL_FOCUS = new Set(['nearest', 'weakest', 'marked']);
const PRESENCE = new Set(['obvious', 'cautious', 'concealed']);
const DISTRIBUTION_STYLES = new Set(['scattered', 'squad', 'legion', 'line', 'ring', 'wedge', 'grid']);
const scatterCache = new WeakMap();

function modifier(source, english, chinese) {
    return asNumber(source?.attributes?.[english] ?? source?.attributes?.[chinese] ?? source?.[english] ?? source?.[chinese], 0);
}

export function normalizeAttributes(source = {}) {
    return {
        strengthModifier: modifier(source, 'strengthModifier', '力量修正'),
        dexterityModifier: modifier(source, 'dexterityModifier', '敏捷修正'),
        constitutionModifier: modifier(source, 'constitutionModifier', '体质修正'),
        spiritModifier: modifier(source, 'spiritModifier', '精神修正'),
        charismaModifier: modifier(source, 'charismaModifier', '魅力修正'),
    };
}

export function normalizeIntelProfile(source = {}) {
    const profile = source.intelProfile || {};
    const presence = PRESENCE.has(profile.presence) ? profile.presence : 'obvious';
    return {
        presence,
        stealthBonus: asNumber(profile.stealthBonus, 0), perceptionBonus: asNumber(profile.perceptionBonus, 0), commandBonus: asNumber(profile.commandBonus, 0),
        hearingMeters: clamp(profile.hearingMeters ?? source.hearingMeters ?? Math.max(8, Number(source.visionMeters ?? 30) / 2), 0, 1000),
        intelligenceRangeMeters: clamp(profile.intelligenceRangeMeters ?? source.intelligenceRangeMeters ?? 0, 0, 1000),
        intelligenceBonus: asNumber(profile.intelligenceBonus, 0),
        movementNoiseMeters: clamp(profile.movementNoiseMeters ?? (presence === 'concealed' ? 3 : presence === 'cautious' ? 7 : 12), 0, 1000),
        attackNoiseMeters: clamp(profile.attackNoiseMeters ?? (presence === 'concealed' ? 18 : 32), 0, 1000),
    };
}

export function normalizeTacticalProfile(source = {}) {
    const profile = source.tacticalProfile || {};
    const archetype = TACTICAL_ARCHETYPES.has(profile.archetype) ? profile.archetype : 'scattered';
    return {
        archetype,
        groupId: String(profile.groupId || source.groupId || source.templateId || source.id || source.name || 'individual'),
        objective: TACTICAL_OBJECTIVES.has(profile.objective) ? profile.objective : archetype === 'scattered' ? 'search' : 'engage',
        focusRule: TACTICAL_FOCUS.has(profile.focusRule) ? profile.focusRule : archetype === 'scattered' ? 'nearest' : 'weakest',
        coordinationRadiusMeters: clamp(profile.coordinationRadiusMeters ?? (archetype === 'squad' ? 18 : archetype === 'hive' ? 1000 : 0), 0, 1000),
    };
}

export function effectiveSpeed(unit = {}) {
    const base = clamp(unit.baseSpeedMeters ?? unit.speedMeters ?? 6, .1, 100);
    return round(clamp(base + Math.floor(Math.max(0, Number(unit.attributes?.dexterityModifier || 0)) / 2), .1, 100));
}

export function exertionMaximum(unit = {}) { return Math.max(0, 2 + Math.max(0, Number(unit.attributes?.constitutionModifier || 0))); }
export function sprintMeters(unit = {}) { return Math.max(0, 2 + Math.max(0, Number(unit.attributes?.dexterityModifier || 0))); }
export function withdrawMeters(unit = {}) { return Math.max(0, 2 + Math.floor(Math.max(0, Number(unit.attributes?.dexterityModifier || 0)) / 2)); }
export function evasionAttacks(unit = {}) { return Math.max(1, 1 + Math.floor(Math.max(0, Number(unit.attributes?.dexterityModifier || 0)) / 2)); }

export function normalizeBattlefield(source = {}) {
    const shape = source.shape === 'circle' ? 'circle' : 'rectangle';
    if (shape === 'circle') {
        const radiusMeters = clamp(source.radiusMeters ?? source.radius ?? 12, 2, 500);
        return { shape, name: String(source.name || '圆形战场'), radiusMeters, center: point(source.center || { x: radiusMeters, y: radiusMeters }), widthMeters: radiusMeters * 2, heightMeters: radiusMeters * 2 };
    }
    return { shape, name: String(source.name || '矩形战场'), widthMeters: clamp(source.widthMeters ?? source.width ?? 160, 4, 1000), heightMeters: clamp(source.heightMeters ?? source.height ?? 160, 4, 1000), center: point(source.center || { x: 0, y: 0 }) };
}

export function centerDistance(a, b) { return Math.hypot(Number(a.position?.x || 0) - Number(b.position?.x || 0), Number(a.position?.y || 0) - Number(b.position?.y || 0)); }
export function edgeDistance(a, b) { return Math.max(0, centerDistance(a, b) - Number(a.radiusMeters || .5) - Number(b.radiusMeters || .5)); }

export function positionInsideBattlefield(position, radiusMeters, battlefield) {
    if (battlefield.shape === 'circle') return Math.hypot(position.x - battlefield.center.x, position.y - battlefield.center.y) + radiusMeters <= battlefield.radiusMeters + 1e-6;
    const halfWidth = battlefield.widthMeters / 2, halfHeight = battlefield.heightMeters / 2;
    return position.x - radiusMeters >= battlefield.center.x - halfWidth && position.x + radiusMeters <= battlefield.center.x + halfWidth && position.y - radiusMeters >= battlefield.center.y - halfHeight && position.y + radiusMeters <= battlefield.center.y + halfHeight;
}

// 大模型没有"战场边界"的空间概念，给出的坐标可能落在边界之外。这里不再报致命
// 错误，而是把落点钳制回战场内部：圆形战场按方向缩回半径内，矩形战场按边界裁剪。
function clampToBattlefield(point, radiusMeters, battlefield) {
    if (battlefield.shape === 'circle') {
        const dx = point.x - battlefield.center.x, dy = point.y - battlefield.center.y;
        const distance = Math.hypot(dx, dy);
        const max = Math.max(radiusMeters, battlefield.radiusMeters - radiusMeters);
        if (distance <= max) return { x: round(point.x), y: round(point.y) };
        const scale = distance ? max / distance : 0;
        return { x: round(battlefield.center.x + dx * scale), y: round(battlefield.center.y + dy * scale) };
    }
    const halfWidth = battlefield.widthMeters / 2, halfHeight = battlefield.heightMeters / 2;
    const minX = battlefield.center.x - halfWidth + radiusMeters, maxX = battlefield.center.x + halfWidth - radiusMeters;
    const minY = battlefield.center.y - halfHeight + radiusMeters, maxY = battlefield.center.y + halfHeight - radiusMeters;
    return { x: round(Math.max(minX, Math.min(maxX, point.x))), y: round(Math.max(minY, Math.min(maxY, point.y))) };
}

// 依据阵营线索给出一个必然在边界内的基准落点：玩家在左（或圆形战场朝 180°），
// 敌方在右（朝 0°），中立在中心。这是模型坐标完全不可信时的兜底线索。
function sideAnchor(battlefield, side, radiusMeters = .5) {
    if (battlefield.shape === 'circle') {
        const angle = side === 'enemy' ? 0 : side === 'neutral' ? Math.PI / 2 : Math.PI;
        const max = Math.max(radiusMeters, battlefield.radiusMeters - radiusMeters);
        const distance = Math.max(radiusMeters, Math.min(max, battlefield.radiusMeters * .8));
        return { x: round(battlefield.center.x + Math.cos(angle) * distance), y: round(battlefield.center.y + Math.sin(angle) * distance) };
    }
    const halfWidth = battlefield.widthMeters / 2, halfHeight = battlefield.heightMeters / 2;
    const margin = radiusMeters;
    if (side === 'enemy') return { x: round(battlefield.center.x + halfWidth - margin), y: round(battlefield.center.y) };
    if (side === 'player') return { x: round(battlefield.center.x - halfWidth + margin), y: round(battlefield.center.y) };
    return { x: round(battlefield.center.x), y: round(battlefield.center.y) };
}

function distributionSpec(source = {}) {
    const raw = source.distribution ?? source.formation ?? null;
    if (!raw) return null;
    const value = typeof raw === 'string' ? { style: raw } : (raw && typeof raw === 'object' ? raw : {});
    const aliases = { random: 'scattered', free: 'scattered', loose: 'scattered', cluster: 'squad', platoon: 'squad', formal: 'legion', legionary: 'legion', square: 'grid', circle: 'ring' };
    const requested = String(value.style ?? value.type ?? value.pattern ?? 'scattered').toLowerCase();
    const style = aliases[requested] || requested;
    return {
        ...value,
        style: DISTRIBUTION_STYLES.has(style) ? style : 'scattered',
        formation: String(value.formation || '').toLowerCase(),
        radiusMeters: Math.max(.5, asNumber(value.radiusMeters ?? value.spreadRadiusMeters ?? value.radius, 12)),
        spacingMeters: Math.max(.5, asNumber(value.spacingMeters ?? source.formationSpacingMeters ?? source.radiusMeters * 2 + .2, 1.2)),
        jitterMeters: Math.max(0, asNumber(value.jitterMeters ?? value.jitter, 0)),
        rows: Math.max(1, Math.floor(asNumber(value.rows, 0))),
        columns: Math.max(1, Math.floor(asNumber(value.columns, 0))),
        orientationDegrees: asNumber(value.orientationDegrees ?? value.rotationDegrees ?? 0, 0),
    };
}

function deterministicUnit(seed) {
    let hash = 2166136261;
    for (const char of String(seed)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 16777619); }
    return ((hash >>> 0) % 100000) / 100000;
}

function rotateOffset(offset, degrees) {
    const radians = Number(degrees || 0) * Math.PI / 180;
    const cos = Math.cos(radians), sin = Math.sin(radians);
    return { x: offset.x * cos - offset.y * sin, y: offset.x * sin + offset.y * cos };
}

function distributedPosition(source, index, battlefield, sourceIndex, spec) {
    const count = Math.max(1, Number(source.count || 1));
    const groupExtent = Math.max(spec.radiusMeters, Math.ceil(Math.sqrt(count)) * spec.spacingMeters / 2);
    const legacyOffset = source.side === 'enemy' ? Math.max(1, groupExtent + 1) : source.side === 'neutral' ? 0 : -1;
    const anchor = clampToBattlefield(point(source.position || { x: battlefield.center.x + legacyOffset, y: battlefield.center.y + (count > 1 ? (sourceIndex % 2 ? 6 : -6) : 0) }), Number(source.radiusMeters || .5), battlefield);
    const jitterSeed = `${source.id || source.name || sourceIndex}:${index}:${spec.style}`;
    const jitter = Math.min(spec.jitterMeters, spec.spacingMeters * .22);
    const angleJitter = (deterministicUnit(`${jitterSeed}:a`) - .5) * Math.min(.12, spec.spacingMeters / Math.max(spec.radiusMeters, 1) * .35);
    const radialJitter = (deterministicUnit(`${jitterSeed}:r`) - .5) * 2 * jitter;
    let offset = { x: 0, y: 0 };
    const columns = spec.columns > 1 ? spec.columns : Math.max(1, Math.ceil(Math.sqrt(count)));
    const rows = spec.rows > 1 ? spec.rows : Math.max(1, Math.ceil(count / columns));
    if (spec.style === 'scattered') {
        // Build a deterministic, shuffled hex-lattice disk once per source.
        // It is deliberately not a row/column formation, but the minimum
        // separation is still guaranteed so a 100-unit horde cannot fail the
        // spatial overlap validator merely because of presentation jitter.
        let offsets = scatterCache.get(source);
        if (!offsets || offsets.length < count) {
            const spacing = Math.max(Number(source.radiusMeters || .5) * 2 + .08, spec.spacingMeters);
            const radius = Math.max(spec.radiusMeters, spacing * Math.sqrt(count) * .9);
            const candidates = [];
            const rowStep = spacing * .87;
            let row = 0;
            for (let y = -radius; y <= radius + 1e-6; y += rowStep, row += 1) {
                const stagger = row % 2 ? spacing / 2 : 0;
                for (let x = -radius - spacing; x <= radius + spacing; x += spacing) {
                    const px = x + stagger;
                    if (Math.hypot(px, y) <= radius - .01) candidates.push({ x: px, y });
                }
            }
            candidates.sort((a, b) => deterministicUnit(`${source.id || source.name || sourceIndex}:${a.x}:${a.y}`) - deterministicUnit(`${source.id || source.name || sourceIndex}:${b.x}:${b.y}`));
            const jitterLimit = Math.min(spec.jitterMeters, Math.max(0, spacing - Number(source.radiusMeters || .5) * 2 - .08) * .2);
            offsets = candidates.slice(0, count).map((candidate, candidateIndex) => {
                const dx = (deterministicUnit(`${source.id || source.name || sourceIndex}:${candidateIndex}:jx`) - .5) * 2 * jitterLimit;
                const dy = (deterministicUnit(`${source.id || source.name || sourceIndex}:${candidateIndex}:jy`) - .5) * 2 * jitterLimit;
                return { x: candidate.x + dx, y: candidate.y + dy };
            });
            scatterCache.set(source, offsets);
        }
        offset = offsets[index] || { x: 0, y: 0 };
    } else if (spec.style === 'ring' || spec.formation === 'ring') {
        const angle = (index / count) * Math.PI * 2 + angleJitter;
        const radius = Math.max(spec.spacingMeters, spec.radiusMeters) + radialJitter;
        offset = { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
    } else if (spec.style === 'line') {
        offset = { x: (index - (count - 1) / 2) * spec.spacingMeters, y: radialJitter };
    } else if (spec.style === 'wedge' || spec.formation === 'wedge') {
        let row = 0, consumed = 0;
        while (consumed + row + 1 <= index) { consumed += row + 1; row += 1; }
        const inRow = index - consumed;
        offset = { x: (inRow - row / 2) * spec.spacingMeters, y: -row * spec.spacingMeters * .82 + radialJitter };
    } else {
        // squad/grid/legion: explicit rows and columns are honoured. Legion
        // is intentionally the only strict rectangular formation.
        const row = Math.floor(index / columns), column = index % columns;
        offset = { x: (column - (Math.min(columns, count) - 1) / 2) * spec.spacingMeters, y: (row - (rows - 1) / 2) * spec.spacingMeters + radialJitter };
    }
    const rotated = rotateOffset(offset, spec.orientationDegrees);
    const tentative = { x: round(anchor.x + rotated.x), y: round(anchor.y + rotated.y) };
    return positionInsideBattlefield(tentative, Number(source.radiusMeters || .5), battlefield) ? tentative : anchor;
}

function groupPosition(source, index, battlefield, sourceIndex = 0) {
    const spec = distributionSpec(source);
    if (spec) return distributedPosition(source, index, battlefield, sourceIndex, spec);
    const memberCount = Number(source.count || 1);
    const groupExtent = memberCount > 1 ? Math.ceil(Math.sqrt(memberCount)) * Math.max(Number(source.formationSpacingMeters || source.radiusMeters || .5) * 2 + .2, .5) / 2 : 0;
    const legacyOffset = source.side === 'enemy' ? Math.max(1, groupExtent + 1) : source.side === 'neutral' ? 0 : -1;
    const anchor = clampToBattlefield(point(source.position || { x: battlefield.center.x + legacyOffset, y: battlefield.center.y + (memberCount > 1 ? (sourceIndex % 2 ? 6 : -6) : 0) }), Number(source.radiusMeters || .5), battlefield);
    const spacing = Math.max(Number(source.formationSpacingMeters || source.radiusMeters || .5) * 2 + .2, .5);
    const columns = Math.max(1, Math.ceil(Math.sqrt(Number(source.count || 1))));
    const row = Math.floor(index / columns), column = index % columns;
    const offsetX = (column - (columns - 1) / 2) * spacing;
    const offsetY = (row - (Math.ceil(Number(source.count || 1) / columns) - 1) / 2) * spacing;
    const tentative = { x: round(anchor.x + offsetX), y: round(anchor.y + offsetY) };
    return positionInsideBattlefield(tentative, Number(source.radiusMeters || .5), battlefield) ? tentative : anchor;
}

export function normalizeEncounter(draft = {}) {
    const battlefield = normalizeBattlefield(draft.battlefield || draft.map || {});
    // Keep a one-zone legacy projection so existing replay/UI readers continue
    // to work; V2 legality is exclusively determined by meters and positions.
    const normalizedZones = [{ id: 'field', name: battlefield.name, adjacent: [], capacity: 1000, narrow: false, cover: 0, blocked: false, hazard: null }];
    const usedIds = new Set();
    const combatants = (draft.combatants || []).flatMap((rawSource, sourceIndex) => {
        const source = rawSource?.mvu || rawSource?.mvuSnapshot ? combatantFromMvu(rawSource) : rawSource;
        const count = clamp(source.count || source['数量'] || 1, 1, 1000);
        return Array.from({ length: count }, (_none, memberIndex) => {
            let id = String(source.id || `unit-${sourceIndex + 1}`);
            if (count > 1) id = `${id}-${String(memberIndex + 1).padStart(3, '0')}`;
            while (usedIds.has(id)) id = makeId('unit-');
            usedIds.add(id);
            const maxHp = Math.max(1, asNumber(source.maxHp ?? source.HP_MAX ?? source.hp, 20));
            const maxEp = Math.max(0, asNumber(source.maxEp ?? source.EP_MAX ?? source.ep, 0));
            const attributes = normalizeAttributes(source);
            const maxExertion = exertionMaximum({ attributes });
            const abilities = normalizeAbilities(source.abilities);
            const radiusMeters = entityRadiusMeters(source);
            const positionedSource = { ...source, radiusMeters };
            // Combat AI values are data, not a hidden answer key. Preserve an
            // explicitly declared DC and only use zero for legacy records that
            // omitted the field entirely.
            const defenseDC = asNumber(source.defenseDC ?? source.DEF, 0);
            return {
                id, templateId: String(source.templateId || source.id || source.name || `template-${sourceIndex}`),
                name: count > 1 ? `${source.name || '单位'} ${memberIndex + 1}` : String(source.name || id),
                side: source.side === 'enemy' ? 'enemy' : source.side === 'neutral' ? 'neutral' : 'player',
                controller: source.controller || (source.side === 'enemy' ? 'ai' : source.isPlayer === false ? 'ai' : 'player'),
                playerId: source.playerId || 'local-player', seatId: source.seatId || 'seat-1',
                hp: clamp(source.hp ?? maxHp, 0, maxHp), maxHp, ep: clamp(source.ep ?? maxEp, 0, maxEp), maxEp,
                thp: Math.max(0, asNumber(source.thp, 0)), attack: asNumber(source.attack ?? source.ATK, 10), magicAttack: asNumber(source.magicAttack ?? source.MATK, 10),
                attackModifier: asNumber(source.attackModifier, Math.floor((asNumber(source.primaryAttribute, 10) - 10) / 2)),
                defenseDC, initiativeDC: asNumber(source.initiativeDC, 0),
                armor: clamp(source.armor ?? source.physicalReduction, 0, 95), resistance: clamp(source.resistance ?? source.magicalReduction, 0, 95),
                tierCorrection: asNumber(source.tierCorrection, 0), zoneId: 'field',
                position: groupPosition(positionedSource, memberIndex, battlefield, sourceIndex), radiusMeters, baseSpeedMeters: clamp(source.baseSpeedMeters ?? source.speedMeters ?? 6, .1, 100), speedMeters: clamp(source.baseSpeedMeters ?? source.speedMeters ?? 6, .1, 100), facingDegrees: round(source.facingDegrees ?? 0), visionMeters: clamp(source.visionMeters ?? 30, 1, 1000), fovDegrees: clamp(source.fovDegrees ?? (source.facingDegrees === undefined ? 360 : 120), 20, 360),
                sizeClass: source.sizeClass || source.bodySize || source['体型'] || 'medium',
                homePosition: point(source.position || groupPosition(positionedSource, memberIndex, battlefield, sourceIndex)), distribution: source.distribution || source.formation || null, attributes, intelProfile: normalizeIntelProfile(source), tacticalProfile: normalizeTacticalProfile(source),
                // Preserve the declaration-to-engine identity projection.  A
                // grouped declaration is expanded into stable member IDs, but
                // every member still belongs to the same source declaration
                // and carries the immutable life/quality facts used by the
                // model validator and the black-box trace.
                declarationId: source.declarationId == null ? null : String(source.declarationId),
                lifeLevel: source.lifeLevel ?? source['生命层级'] ?? null,
                attributeQualities: source.attributeQualities || source.qualityProfile ? structuredClone(source.attributeQualities || source.qualityProfile) : null,
                qualityProfile: source.qualityProfile ? structuredClone(source.qualityProfile) : null,
                mvu: source.mvu || source.mvuSnapshot ? structuredClone(source.mvu || source.mvuSnapshot) : null,
                equipment: Array.isArray(source.equipment) ? structuredClone(source.equipment) : null,
                equipments: Array.isArray(source.equipments) ? structuredClone(source.equipments) : null,
                range: source.range || 'contact', statuses: Array.isArray(source.statuses) ? source.statuses : [], cooldowns: source.cooldowns || {}, assetBindings: Array.isArray(source.assetBindings) ? source.assetBindings.map(String) : [], combatProvenance: source.combatProvenance || null,
                exertion: clamp(source.exertion ?? maxExertion, 0, maxExertion), maxExertion,
                abilities, passives: normalizePassives(source.passives, abilities), state: source.hp === 0 ? 'dying' : 'active', dyingHits: 0,
                boss: Boolean(source.boss), elite: Boolean(source.elite), named: Boolean(source.named || source.boss),
                phases: Array.isArray(source.phases) ? source.phases : source.boss ? [70, 40, 15] : [], reachedPhases: [], kills: 0,
            };
        });
    });
    if (!combatants.some(unit => unit.side === 'player') || !combatants.some(unit => unit.side === 'enemy')) throw new Error('遭遇必须至少包含一名玩家方和一名敌方单位');
    return {
        title: String(draft.title || '未命名遭遇'), location: String(draft.location || battlefield.name), description: String(draft.description || ''),
        battlefield, zones: normalizedZones, combatants,
        // These fields are protocol metadata, not combat results.  Keeping
        // them on the normalized encounter lets the engine seed direct
        // dialogue contact before its first discovery pass.
        contactEstablished: typeof draft.contactEstablished === 'boolean' ? draft.contactEstablished : Boolean(draft.contact?.established),
        contactPairs: Array.isArray(draft.contactPairs) ? draft.contactPairs.map(pair => Array.isArray(pair) ? pair.map(String) : pair).filter(pair => Array.isArray(pair) && pair.length === 2) : Array.isArray(draft.contact?.pairs) ? draft.contact.pairs.map(pair => pair.map(String)).filter(pair => pair.length === 2) : [],
        worldLifeLevel: draft.worldLifeLevel || null,
        schema: draft.schema || null,
    };
}

function normalizeAbilities(abilities) {
    const list = Array.isArray(abilities) ? abilities : [];
    const output = list.map((ability, index) => {
        const id = String(ability.id || `ability-${index + 1}`);
        // Basic attack already uses the actor's authoritative ATK/MATK and
        // attack modifier.  Treating the model's repeated ATK as both the
        // panel and ability power/modifier was the source of the dog replay's
        // 20 + 20, then miracle x1.5, damage spike.  Keep ability power for
        // explicitly named skills only; the local engine is the final guard
        // even when an old CombatModel has not been repaired yet.
        const basicAttack = id === 'basic-attack';
        return {
        id, name: String(ability.name || `能力 ${index + 1}`), type: ability.type || 'physical', actionType: ability.actionType === 'minor' ? 'minor' : 'main',
        power: basicAttack ? 0 : Math.max(0, asNumber(ability.power, 0)), modifier: basicAttack ? 0 : asNumber(ability.modifier, 0), epCost: Math.max(0, asNumber(ability.epCost, 0)),
        range: ability.range || 'contact', minRangeMeters: clamp(ability.minRangeMeters ?? 0, 0, 1000), maxRangeMeters: clamp(ability.maxRangeMeters ?? (ability.range === 'far' ? 1000 : ability.range === 'contact' ? 1.5 : 8), 0, 1000), cooldownRounds: clamp(ability.cooldownRounds ?? 0, 0, 1000), targetCount: clamp(ability.targetCount || 1, 1, 1000), aoe: Boolean(ability.aoe), weakPoint: Boolean(ability.weakPoint),
        script: typeof ability.script === 'string' ? ability.script : null,
        };
    });
    // An explicitly ranged-only unit must stay ranged-only. The basic attack
    // fallback belongs only to units whose model omitted the entire ability
    // list, otherwise it silently creates a melee blocker.
    if (!list.length && !output.some(item => item.id === 'basic-attack')) output.unshift({ id: 'basic-attack', name: '基础攻击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, range: 'contact', minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false, weakPoint: false, script: null });
    return output;
}

// Every unit with a melee-capable ability receives this passive by default.
// It is intentionally data-driven so clients can display it and future cards
// can add more passive triggers without hard-coding them into the UI.
export function normalizePassives(passives, abilities = []) {
    const output = Array.isArray(passives) ? passives.filter(Boolean).map((passive, index) => ({
        id: String(passive.id || `passive-${index + 1}`),
        name: String(passive.name || passive.id || `被动 ${index + 1}`),
        type: 'passive',
        enabled: passive.enabled !== false,
        trigger: passive.trigger || null,
        abilityId: passive.abilityId ? String(passive.abilityId) : null,
    })) : [];
    if (!output.some(passive => passive.id === 'melee-counterattack') && abilities.some(ability => ability?.id === 'basic-attack' || isMeleeAbility(ability))) {
        output.unshift({ id: 'melee-counterattack', name: '近战自动反击', type: 'passive', enabled: true, trigger: 'melee_attacked', abilityId: 'basic-attack' });
    }
    return output;
}

export function living(unit) { return unit.state === 'active' && unit.hp > 0; }
export function enemiesOf(state, actor) { return state.combatants.filter(unit => living(unit) && unit.side !== actor.side && unit.side !== 'neutral'); }
export function alliesOf(state, actor) { return state.combatants.filter(unit => living(unit) && unit.side === actor.side); }

export function rangeLegal(state, actor, target, ability) {
    const distance = edgeDistance(actor, target);
    return distance + 1e-6 >= Number(ability.minRangeMeters || 0) && distance <= Number(ability.maxRangeMeters ?? (ability.range === 'far' ? 1000 : ability.range === 'contact' ? 1.5 : 8)) + 1e-6;
}

export function isMeleeAbility(ability = {}) { return Number(ability.maxRangeMeters ?? (ability.range === 'contact' ? 1.5 : Infinity)) <= 1.5 + 1e-6; }

export function tacticalGroupKey(unit = {}) { return `${unit.side}:${unit.tacticalProfile?.archetype || 'scattered'}:${unit.tacticalProfile?.groupId || unit.templateId || unit.id}`; }

export function validUnitAttributes(attributes = {}) {
    return ['strengthModifier', 'dexterityModifier', 'constitutionModifier', 'spiritModifier', 'charismaModifier'].every(key => finite(attributes[key]));
}

// 大模型的坐标不可信（它没有战场边界的空间概念），因此这里不再抛致命错误。
// 越界单位按可用线索重新分配位置：homePosition（若有效）→ 阵营锚点 → 战场中心；
// 重叠单位做迭代推开。只有当真到所有候选都无法安放时才会抛错（实际不会发生）。
function reassignedPosition(unit, units, battlefield) {
    const radius = Number(unit.radiusMeters || .5);
    const candidates = [];
    if (unit.homePosition && positionInsideBattlefield(unit.homePosition, radius, battlefield)) candidates.push(point(unit.homePosition));
    candidates.push(sideAnchor(battlefield, unit.side, radius));
    candidates.push(point(battlefield.center));
    for (const candidate of candidates) {
        const conflict = units.some(other => other !== unit && Math.hypot(candidate.x - other.position.x, candidate.y - other.position.y) + 1e-6 < radius + Number(other.radiusMeters || .5));
        if (!conflict) return candidate;
    }
    return clampToBattlefield(candidates[1], radius, battlefield);
}

// 兜底：把仍重叠的单位放到战场中心外围的空位环上（确定性、必然在界内）。
function placeOnFreeRing(unit, units, battlefield) {
    const radius = Number(unit.radiusMeters || .5);
    const base = point(battlefield.center);
    const max = battlefield.shape === 'circle' ? Math.max(radius, battlefield.radiusMeters - radius) : Math.min(battlefield.widthMeters, battlefield.heightMeters) / 2 - radius;
    const spacing = radius * 2 + .4;
    for (let ring = 0; ring < 8; ring += 1) {
        const ringRadius = Math.min(max, (ring + 1) * spacing);
        const steps = Math.max(6, Math.ceil(2 * Math.PI * ringRadius / spacing));
        for (let step = 0; step < steps; step += 1) {
            const angle = step / steps * Math.PI * 2;
            const candidate = { x: round(base.x + Math.cos(angle) * ringRadius), y: round(base.y + Math.sin(angle) * ringRadius) };
            if (!positionInsideBattlefield(candidate, radius, battlefield)) continue;
            const conflict = units.some(other => other !== unit && Math.hypot(candidate.x - other.position.x, candidate.y - other.position.y) + 1e-6 < radius + Number(other.radiusMeters || .5));
            if (!conflict) return candidate;
        }
    }
    return clampToBattlefield(point({ x: base.x + spacing, y: base.y }), radius, battlefield);
}

export function validateSpatialEncounter(encounter) {
    const battlefield = encounter.battlefield;
    const units = encounter.combatants;
    for (const unit of units) {
        if (!positionInsideBattlefield(unit.position, unit.radiusMeters, battlefield)) unit.position = reassignedPosition(unit, units, battlefield);
    }
    // 重叠：双方对称推开（各移动一半），最多 40 轮。
    for (let pass = 0; pass < 40; pass += 1) {
        let moved = false;
        for (let index = 0; index < units.length; index += 1) for (let other = index + 1; other < units.length; other += 1) {
            const a = units[index], b = units[other];
            const min = Number(a.radiusMeters || .5) + Number(b.radiusMeters || .5) + 1e-6;
            const dx = b.position.x - a.position.x, dy = b.position.y - a.position.y;
            const d = Math.hypot(dx, dy) || .001;
            if (d >= min) continue;
            const push = (min - d) / 2;
            const ox = dx / d * push, oy = dy / d * push;
            a.position = clampToBattlefield({ x: a.position.x - ox, y: a.position.y - oy }, Number(a.radiusMeters || .5), battlefield);
            b.position = clampToBattlefield({ x: b.position.x + ox, y: b.position.y + oy }, Number(b.radiusMeters || .5), battlefield);
            moved = true;
        }
        if (!moved) break;
    }
    // 兜底：把仍重叠的单位放到空位环上，避免完全重合时推不开。
    for (let pass = 0; pass < 8; pass += 1) {
        let stillOverlapping = false;
        for (let index = 0; index < units.length; index += 1) {
            const a = units[index];
            const conflict = units.some((b, other) => other !== index && Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y) + 1e-6 < Number(a.radiusMeters || .5) + Number(b.radiusMeters || .5));
            if (!conflict) continue;
            stillOverlapping = true;
            a.position = placeOnFreeRing(a, units, battlefield);
        }
        if (!stillOverlapping) break;
    }
    for (const unit of units) if (!positionInsideBattlefield(unit.position, unit.radiusMeters, battlefield)) unit.position = reassignedPosition(unit, units, battlefield);
    return true;
}

export function damageValue(actor, target, ability, critical = false) {
    if (ability.type === 'hybrid') {
        const multiplier = critical || ability.weakPoint ? 1.5 : 1;
        const physicalRaw = Math.max(0, Number(actor.attack || 0) + Number(ability.power || 0)) * multiplier;
        const magicalRaw = Math.max(0, Number(actor.magicAttack || 0)) * multiplier;
        const physicalFinal = physicalRaw * (1 - Number(target.armor || 0) / 100);
        const magicalFinal = magicalRaw * (1 - Number(target.resistance || 0) / 100);
        return { raw: Math.round(physicalRaw + magicalRaw), reduction: { physical: Number(target.armor || 0), magical: Number(target.resistance || 0) }, channels: { physical: Math.round(physicalFinal), magical: Math.round(magicalFinal) }, final: Math.max(0, Math.round(physicalFinal + magicalFinal)) };
    }
    const panel = ability.type === 'magical' ? actor.magicAttack : actor.attack;
    let raw = Math.max(0, panel + ability.power);
    if (critical || ability.weakPoint) raw *= 1.5;
    const reduction = ability.type === 'true' ? 0 : ability.type === 'magical' ? target.resistance : target.armor;
    return { raw: Math.round(raw), reduction, final: Math.max(0, Math.round(raw * (1 - reduction / 100))) };
}

export function applyDamage(target, amount) {
    const before = { hp: target.hp, thp: target.thp, state: target.state };
    let remaining = Math.max(0, amount);
    const absorbed = Math.min(target.thp, remaining); target.thp -= absorbed; remaining -= absorbed;
    const hpDamage = Math.min(target.hp, remaining);
    const overkill = Math.max(0, remaining - hpDamage);
    target.hp = Math.max(0, target.hp - hpDamage);
    if (target.hp <= 0) {
        if (target.state === 'dying') { target.state = 'dead'; target.dyingHits += 1; }
        else { target.state = 'dying'; target.dyingHits = 0; }
    }
    return { before, after: { hp: target.hp, thp: target.thp, state: target.state }, absorbed, hpDamage, overkill, incomingAfterArmor: absorbed + remaining };
}

export function aggregateCohorts(combatants) {
    const groups = new Map();
    for (const unit of combatants) {
        const key = unit.boss || unit.elite || unit.named ? unit.id : `${unit.side}:${unit.templateId}:${unit.zoneId}:${unit.state}`;
        const group = groups.get(key) || { key, name: unit.name.replace(/ \d+$/, ''), side: unit.side, zoneId: unit.zoneId, state: unit.state, count: 0, totalHp: 0, totalMaxHp: 0, ids: [] };
        group.count += 1; group.totalHp += unit.hp + unit.thp; group.totalMaxHp += unit.maxHp; group.ids.push(unit.id); groups.set(key, group);
    }
    return [...groups.values()];
}
