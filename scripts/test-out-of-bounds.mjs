import assert from 'node:assert/strict';
import { normalizeEncounter, validateSpatialEncounter, positionInsideBattlefield } from '../combat/rules.js';
import { CombatEngine } from '../combat/engine.js';
import { BrowserCombatRepository } from '../combat/browser-repository.js';

const baseUnit = (id, overrides = {}) => ({
    id, name: id, side: 'enemy', hp: 20, maxHp: 20, ep: 0, maxEp: 0, attack: 5, attackModifier: 0, defenseDC: 50, initiativeDC: 0,
    armor: 0, resistance: 0, speedMeters: 6, radiusMeters: .5,
    intelProfile: { presence: 'obvious' }, tacticalProfile: { archetype: 'scattered', groupId: id, objective: 'search', focusRule: 'nearest' },
    abilities: [{ id: 'basic-attack', name: '基础攻击', type: 'physical', actionType: 'main', power: 0, modifier: 0, epCost: 0, minRangeMeters: 0, maxRangeMeters: 1.5, cooldownRounds: 0, targetCount: 1, aoe: false }],
    ...overrides,
});

// 1. 矩形战场：单位被模型丢到边界之外 → 按线索重新分配，不再抛致命错误。
{
    const encounter = normalizeEncounter({
        title: '越界回归·矩形', battlefield: { shape: 'rectangle', widthMeters: 30, heightMeters: 20, center: { x: 0, y: 0 } },
        combatants: [
            baseUnit('player', { side: 'player', position: { x: -1000, y: 0 } }),
            baseUnit('enemy', { position: { x: 9999, y: 8888 } }),
        ],
    });
    validateSpatialEncounter(encounter);
    for (const unit of encounter.combatants) {
        assert.ok(positionInsideBattlefield(unit.position, unit.radiusMeters, encounter.battlefield), `单位 ${unit.id} 仍在边界外：${JSON.stringify(unit.position)}`);
    }
    const player = encounter.combatants.find(u => u.id === 'player');
    const enemy = encounter.combatants.find(u => u.id === 'enemy');
    assert.ok(player.position.x < 0, `玩家应偏左（阵营线索）：${player.position.x}`);
    assert.ok(enemy.position.x > 0, `敌方应偏右（阵营线索）：${enemy.position.x}`);
    console.log('矩形越界重定位', JSON.stringify({ player: player.position, enemy: enemy.position }));
}

// 2. 圆形战场：半径外超远坐标 → 钳制回圆内。
{
    const encounter = normalizeEncounter({
        title: '越界回归·圆形', battlefield: { shape: 'circle', radiusMeters: 12, center: { x: 0, y: 0 } },
        combatants: [
            baseUnit('player', { side: 'player', position: { x: -9999, y: 0 } }),
            baseUnit('enemy', { position: { x: 0, y: 99999 } }),
        ],
    });
    validateSpatialEncounter(encounter);
    for (const unit of encounter.combatants) {
        assert.ok(positionInsideBattlefield(unit.position, unit.radiusMeters, encounter.battlefield), `单位 ${unit.id} 仍在圆外：${JSON.stringify(unit.position)}`);
    }
    console.log('圆形越界重定位', JSON.stringify(encounter.combatants.map(u => ({ id: u.id, position: u.position }))));
}

// 3. 完全重叠 → 迭代推开，无初始重叠。
{
    const encounter = normalizeEncounter({
        title: '重叠回归', battlefield: { shape: 'rectangle', widthMeters: 30, heightMeters: 20, center: { x: 0, y: 0 } },
        combatants: [
            baseUnit('player', { side: 'player', position: { x: 0, y: 0 } }),
            baseUnit('enemy-a', { position: { x: 0, y: 0 } }),
            baseUnit('enemy-b', { position: { x: 0, y: 0 } }),
            baseUnit('enemy-c', { position: { x: 0, y: 0 } }),
        ],
    });
    validateSpatialEncounter(encounter);
    const units = encounter.combatants;
    for (let i = 0; i < units.length; i += 1) for (let j = i + 1; j < units.length; j += 1) {
        const a = units[i], b = units[j];
        const distance = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
        assert.ok(distance + 1e-6 >= a.radiusMeters + b.radiusMeters, `单位 ${a.id}/${b.id} 仍重叠：${distance}`);
    }
    for (const unit of units) assert.ok(positionInsideBattlefield(unit.position, unit.radiusMeters, encounter.battlefield), `单位 ${unit.id} 推开后出界`);
    console.log('重叠化解', JSON.stringify(units.map(u => ({ id: u.id, position: u.position }))));
}

// 4. 端到端：engine.create 收到越界模型不再抛错，且落点全部在边界内。
{
    const repository = new BrowserCombatRepository();
    const engine = new CombatEngine(repository);
    const created = engine.create({
        seed: 'out-of-bounds-regression', mode: 'manual', transient: true,
        encounter: {
            title: '越界端到端', battlefield: { shape: 'circle', radiusMeters: 12, center: { x: 0, y: 0 } },
            combatants: [
                baseUnit('player', { side: 'player', position: { x: -500, y: 0 } }),
                baseUnit('enemy', { position: { x: 500, y: -500 } }),
            ],
        },
    });
    for (const unit of created.combatants) {
        assert.ok(positionInsideBattlefield(unit.position, unit.radiusMeters, created.battlefield), `引擎创建后单位 ${unit.id} 仍在边界外：${JSON.stringify(unit.position)}`);
    }
    console.log('引擎端到端越界', JSON.stringify(created.combatants.map(u => ({ id: u.id, position: u.position }))));
}

console.log(JSON.stringify({ ok: true, mode: 'out-of-bounds-reposition' }, null, 2));
