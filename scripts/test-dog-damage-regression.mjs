import assert from 'node:assert/strict';
import express from 'express';
import fs from 'node:fs';
import { createCombatRouter } from '../combat/router.js';

// Isolated regression: this intentionally tests only the local damage path.
// The old saved model declared a dog with attack=20 and basic-attack
// power=20/modifier=3, which doubled the panel values and produced raw 60 /
// final 37 on a natural miracle.  No entity-reuse or AI call is involved.
const root = new URL('../.test/dog-damage-regression/', import.meta.url).pathname.replace(/^\//, '').replaceAll('/', '\\');
const combat = createCombatRouter(root);
const app = express(); app.use(express.json()); app.use('/api/combat', combat.router);
const server = app.listen(0, '127.0.0.1');
await new Promise(resolve => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/combat`;
const request = async (route, options = {}) => { const response = await fetch(`${base}${route}`, { headers: { 'Content-Type': 'application/json' }, ...options }); const body = await response.json(); return { response, body }; };

try {
    const fallbackModel = {
        title: '丧尸犬伤害回归', location: '停车场', schema: 'vibe-combat-model/v3', worldLifeLevel: 'Ⅱ', contactEstablished: true, contactPairs: [['hero', 'dog']],
        battlefield: { shape: 'rectangle', widthMeters: 20, heightMeters: 20, center: { x: 0, y: 0 } },
        combatants: [
            { id: 'hero', declarationId: 'hero', name: '艾莉丝', side: 'player', controller: 'player', hp: 100, maxHp: 100, ep: 0, maxEp: 0, attack: 10, magicAttack: 0, attackModifier: 0, defenseDC: 35, initiativeDC: -1000, armor: 39, resistance: 0, radiusMeters: .5, speedMeters: 4, position: { x: 0, y: 0 }, facingDegrees: 0, fovDegrees: 120, visionMeters: 30, attributes: { strengthModifier: 0, dexterityModifier: 0, constitutionModifier: 0, spiritModifier: 0, charismaModifier: 0 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 10, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: 'hero', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 0 }, assetBindings: [], abilities: [{ id: 'basic-attack', name: '拳击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }], lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' }, combatProvenance: { source: 'combat-ai-derived', worldLifeLevel: 'Ⅱ', lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'F', dexterityModifier: 'F', constitutionModifier: 'F', spiritModifier: 'F', charismaModifier: 'F' }, formulaVersion: 'v3.2.6' } },
            // Deliberately retain the malformed old AI declaration. The
            // server-side normalization must make it safe even when a stale
            // save bypasses the new prompt/repair loop.
            { id: 'dog', declarationId: 'dog', name: '丧尸犬', side: 'enemy', controller: 'ai', hp: 32, maxHp: 32, ep: 0, maxEp: 0, attack: 20, magicAttack: 1, attackModifier: 100, defenseDC: 20, initiativeDC: 1000, armor: 0, resistance: 0, radiusMeters: .5, speedMeters: 4, position: { x: 1, y: 0 }, facingDegrees: 180, fovDegrees: 120, visionMeters: 20, attributes: { strengthModifier: 3, dexterityModifier: 3, constitutionModifier: 2, spiritModifier: 1, charismaModifier: 1 }, intelProfile: { presence: 'obvious', stealthBonus: 0, perceptionBonus: 0, commandBonus: 0, hearingMeters: 10, intelligenceRangeMeters: 0, intelligenceBonus: 0, movementNoiseMeters: 12, attackNoiseMeters: 32 }, tacticalProfile: { archetype: 'scattered', groupId: 'dogs', objective: 'engage', focusRule: 'nearest', coordinationRadiusMeters: 0 }, assetBindings: [], abilities: [{ id: 'basic-attack', name: '狂暴扑咬', type: 'physical', actionType: 'main', power: 20, modifier: 3, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }], lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'E', dexterityModifier: 'D', constitutionModifier: 'E', spiritModifier: 'F', charismaModifier: 'F' }, combatProvenance: { source: 'combat-ai-derived', worldLifeLevel: 'Ⅱ', lifeLevel: 'Ⅰ', attributeQualities: { strengthModifier: 'E', dexterityModifier: 'D', constitutionModifier: 'E', spiritModifier: 'F', charismaModifier: 'F' }, formulaVersion: 'v3.2.6' } },
        ],
    };
    const debugPath = 'C:\\Users\\fengx\\Downloads\\轮回战场-战术演算DEBUG-battle-dd540135-8d1a-4774-a7da-e40c1f6bcecc-2026-08-16T21-21-09-856Z.json';
    let model = fallbackModel;
    if (fs.existsSync(debugPath)) {
        const exported = JSON.parse(fs.readFileSync(debugPath, 'utf8'));
        const snapshot = exported.backend?.replay?.initialSnapshot;
        if (snapshot?.combatants?.length) {
            model = structuredClone(snapshot);
            model.title = '真实 DEBUG 丧尸犬伤害回归'; model.mode = 'manual';
            const player = model.combatants.find(unit => unit.side === 'player');
            const dogs = model.combatants.filter(unit => /丧尸犬|犬/.test(String(unit.name)));
            if (player) player.initiativeDC = -1000;
            for (const dog of dogs) dog.initiativeDC = 1000;
        }
    }
    const dogIds = model.combatants.filter(unit => /丧尸犬|犬/.test(String(unit.name))).map(unit => unit.id);
    const playerId = model.combatants.find(unit => unit.side === 'player')?.id || 'hero';
    assert.ok(dogIds.length, '真实 DEBUG 或回退场景必须存在丧尸犬');
    const declaredDog = model.combatants.find(unit => dogIds.includes(unit.id));
    const declaredDogDefenseDC = Number(declaredDog?.defenseDC ?? 0);
    const declaredDogRadius = Number(declaredDog?.radiusMeters ?? .5);
    const created = await request('/sessions', { method: 'POST', body: JSON.stringify({ mode: 'manual', seed: 'dog-damage-regression', encounter: model }) });
    assert.equal(created.response.status, 201);
    const started = await request(`/${created.body.id}/start`, { method: 'POST', body: JSON.stringify({ commandId: 'dog-start', expectedVersion: created.body.version }) });
    assert.equal(started.response.status, 200);
    let state = started.body;
    const dogUnit = state.combatants.find(unit => dogIds.includes(unit.id));
    assert.ok(dogUnit, '启动后的战斗状态必须保留丧尸犬实体');
    assert.equal(dogUnit.defenseDC, declaredDogDefenseDC, '本地战斗必须保留模型声明的丧尸犬防御 DC，不得静默覆盖');
    assert.equal(dogUnit.radiusMeters, declaredDogRadius, '本地战斗必须保留模型声明的实体占地半径，不得静默缩放');
    let replay = await request(`/${state.id}/replay`);
    if (!replay.body.events.some(event => event.type === 'attack_check' && dogIds.includes(event.payload.actorId))) {
        for (let i = 0; i < 3 && !dogIds.includes(state.activeUnitId); i += 1) {
            const waited = await request(`/${state.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: `dog-wait-${i}`, expectedVersion: state.version, type: 'wait', actorId: state.activeUnitId }) });
            assert.equal(waited.response.status, 200, JSON.stringify(waited.body));
            state = waited.body;
        }
        if (dogIds.includes(state.activeUnitId)) {
            const attacked = await request(`/${state.id}/commands`, { method: 'POST', body: JSON.stringify({ commandId: 'dog-attack', expectedVersion: state.version, type: 'attack', actorId: state.activeUnitId, abilityId: 'basic-attack', targetIds: [playerId] }) });
            assert.equal(attacked.response.status, 200, JSON.stringify(attacked.body));
        }
        replay = await request(`/${state.id}/replay`);
    }
    const attack = replay.body.events.find(event => event.type === 'attack_check' && dogIds.includes(event.payload.actorId) && event.payload.damage);
    assert.ok(attack, '缺少丧尸犬攻击裁定');
    assert.equal(attack.payload.attackBasis.ability.power, 0, 'basic-attack power 必须由本地归零');
    assert.equal(attack.payload.attackBasis.ability.modifier, 0, 'basic-attack modifier 必须由本地归零');
    assert.ok(attack.payload.damage.raw <= 30, `丧尸犬基础伤害不应重复叠加（raw=${attack.payload.damage.raw}）`);
    assert.ok(attack.payload.damage.final <= 19, `39%物理减伤下丧尸犬最终伤害异常（final=${attack.payload.damage.final}）`);
    console.log(JSON.stringify({ ok: true, battleId: state.id, dogDefenseDC: dogUnit.defenseDC, dogRadiusMeters: dogUnit.radiusMeters, selected: attack.payload.selected, raw: attack.payload.damage.raw, final: attack.payload.damage.final, targetHp: attack.payload.applied.after.hp }, null, 2));
} finally { await new Promise(resolve => server.close(resolve)); }
