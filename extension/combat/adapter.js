// The MVU bridge is deliberately data-only: it never recalculates card
// balance.  It selects the panel the card has already calculated, then keeps
// an auditable provenance record beside the combatant.
const number = (value, fallback = 0) => {
    if (Number.isFinite(Number(value))) return Number(value);
    const text = String(value ?? '').trim();
    const percent = text.match(/^(-?(?:\d+\.?\d*|\.\d+))\s*%$/);
    return percent ? Number(percent[1]) : fallback;
};

function equipmentNames(player = {}) {
    const equipment = player['装备'];
    if (!equipment || typeof equipment !== 'object') return [];
    return Object.entries(equipment)
        .filter(([, item]) => Number(item?.状态 ?? item?.status ?? 0) === 1)
        .flatMap(([slot, item]) => [item?.名称, item?.name, slot].filter(Boolean).map(String));
}

export function resolveMvuCombatPanel(mvu = {}) {
    const player = mvu.player || mvu['主角'] || {};
    const final = player['最终属性'] || mvu.finalAttributes || {};
    const weapons = final['武器'] && typeof final['武器'] === 'object' ? final['武器'] : {};
    const requested = String(mvu.weaponName || mvu.selectedWeaponName || '').trim();
    const selectedName = requested && weapons[requested]
        ? requested
        : equipmentNames(player).find(name => weapons[name] && typeof weapons[name] === 'object')
            || (weapons['无武装'] ? '无武装' : Object.keys(weapons).find(name => weapons[name] && typeof weapons[name] === 'object'))
            || null;
    const weapon = selectedName ? weapons[selectedName] || {} : {};
    const attribute = (key, fallback = 0) => number(final[key] ?? player[key], fallback);
    const modifier = key => attribute(`${key}修正`, 0);
    const panel = {
        hp: number(player.HP, 20), maxHp: Math.max(1, number(player.HP_MAX, number(player.HP, 20))),
        ep: Math.max(0, number(player.EP, 0)), maxEp: Math.max(0, number(player.EP_MAX, number(player.EP, 0))),
        attack: number(weapon.ATK ?? final.ATK, attribute('力量', 10)),
        magicAttack: number(weapon.MATK ?? final.MATK, attribute('精神', 10)),
        // Some V3.2.6 MVU snapshots do not materialize a separate attack
        // correction. In that case DND-style physical attacks use the
        // already-authoritative strength modifier, never a guessed constant.
        attackModifier: attribute('攻击修正', modifier('力量')), defenseDC: attribute('防御DC', 0), initiativeDC: attribute('先攻DC', 0),
        armor: attribute('物理减伤率', 0), resistance: attribute('魔法减伤率', 0),
        attributes: {
            strengthModifier: modifier('力量'), dexterityModifier: modifier('敏捷'), constitutionModifier: modifier('体质'),
            spiritModifier: modifier('精神'), charismaModifier: modifier('魅力'),
        },
        weaponName: selectedName,
        provenance: {
            source: 'mvu-final-attributes',
            selectedWeapon: selectedName,
            paths: {
                hp: '主角.HP', maxHp: '主角.HP_MAX', ep: '主角.EP', maxEp: '主角.EP_MAX',
                attack: selectedName ? `主角.最终属性.武器.${selectedName}.ATK` : '主角.最终属性.ATK',
                magicAttack: selectedName ? `主角.最终属性.武器.${selectedName}.MATK` : '主角.最终属性.MATK',
                modifiers: '主角.最终属性.[力量/敏捷/体质/精神/魅力修正]',
                defense: '主角.最终属性.[防御DC/物理减伤率/魔法减伤率]',
            },
        },
    };
    panel.hp = Math.max(0, Math.min(panel.maxHp, panel.hp));
    panel.ep = Math.max(0, Math.min(panel.maxEp, panel.ep));
    return panel;
}

export function combatantFromMvu(source = {}) {
    const mvu = source.mvu || source.mvuSnapshot || source;
    const panel = resolveMvuCombatPanel(mvu);
    return {
        ...source,
        name: source.name || mvu.player?.姓名 || mvu['主角']?.姓名 || '主角',
        hp: panel.hp, maxHp: panel.maxHp, ep: panel.ep, maxEp: panel.maxEp,
        attack: panel.attack, magicAttack: panel.magicAttack, attackModifier: panel.attackModifier,
        defenseDC: panel.defenseDC, initiativeDC: panel.initiativeDC, armor: panel.armor, resistance: panel.resistance,
        attributes: panel.attributes, weaponName: panel.weaponName,
        combatProvenance: panel.provenance,
    };
}
