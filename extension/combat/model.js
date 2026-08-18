import { normalizeEncounter, validateSpatialEncounter } from './rules.js';

const finite = value => Number.isFinite(Number(value));
const text = value => typeof value === 'string' && value.trim().length > 0;
const array = value => Array.isArray(value) ? value : [];
const sides = new Set(['player', 'enemy', 'neutral']);
const shapes = new Set(['rectangle', 'circle']);
const presences = new Set(['obvious', 'cautious', 'concealed']);
const tacticalArchetypes = new Set(['scattered', 'squad', 'hive']);
const tacticalObjectives = new Set(['search', 'engage', 'hold']);
const tacticalFocusRules = new Set(['nearest', 'weakest', 'marked']);
const distributionStyles = new Set(['scattered', 'squad', 'legion', 'line', 'ring', 'wedge', 'grid', 'random', 'free', 'loose', 'cluster', 'platoon', 'formal', 'legionary', 'square', 'circle']);
const LIFE_LEVELS = new Set(['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX']);
const QUALITY_LEVELS = new Set(['F', 'E', 'D', 'C', 'B', 'A', 'S', 'SS', 'SSS']);
const ATTRIBUTE_KEYS = ['strengthModifier', 'dexterityModifier', 'constitutionModifier', 'spiritModifier', 'charismaModifier'];

function issue(code, path, message, expected = undefined) {
    return { code, path, message, ...(expected === undefined ? {} : { expected }) };
}

function validateDistribution(value, path, errors) {
    if (value === undefined || value === null || value === '') return;
    const spec = typeof value === 'string' ? { style: value } : value;
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) { errors.push(issue('declaration.distribution_invalid', path, 'distribution 必须是样式字符串或对象')); return; }
    const style = spec.style === undefined ? null : String(spec.style).toLowerCase();
    if (spec.style !== undefined && (!text(spec.style) || !distributionStyles.has(style))) errors.push(issue('declaration.distribution_style_invalid', `${path}/style`, 'distribution.style 必须是 scattered、squad、legion、line、ring、wedge 或 grid'));
    for (const key of ['radiusMeters', 'spreadRadiusMeters', 'spacingMeters', 'jitterMeters', 'orientationDegrees']) if (spec[key] !== undefined && !finite(spec[key])) errors.push(issue('declaration.distribution_number_invalid', `${path}/${key}`, `${key} 必须是有限数字`));
    // rows/columns are meaningful only for a grid.  The declaration example
    // historically used 0 as an explicit "not applicable" marker for
    // scattered/ring groups; rejecting that marker prevented an otherwise
    // valid story-floor declaration from ever reaching the battle preview.
    for (const key of ['rows', 'columns']) {
        if (spec[key] === undefined) continue;
        const number = Number(spec[key]);
        const invalid = !finite(number) || !Number.isInteger(number) || (style === 'grid' ? number < 1 : number < 0);
        if (invalid) errors.push(issue('declaration.distribution_grid_invalid', `${path}/${key}`, style === 'grid' ? `${key} 必须是正整数` : `${key} 必须是非负整数`));
    }
}

export function extractDeclaration(source = '') {
    const match = String(source).match(/<BattleDeclaration\b[^>]*>([\s\S]*?)<\/BattleDeclaration\s*>/i);
    if (!match) return null;
    const raw = match[1].trim().replace(/^```json\s*/i, '').replace(/\s*```$/i, '');
    try { return { declaration: JSON.parse(raw), raw }; }
    catch (error) { return { error: `BattleDeclaration 不是合法 JSON：${error.message}`, raw }; }
}

function validateContact(value, participantIds, errors, { strict = false } = {}) {
    const hasFlag = value?.contactEstablished !== undefined;
    if (strict && !hasFlag) errors.push(issue('declaration.contact_flag_required', '/contactEstablished', 'v3 战场声明必须明确标记已建立的敌我接触状态'));
    if (hasFlag && typeof value.contactEstablished !== 'boolean') errors.push(issue('declaration.contact_flag_invalid', '/contactEstablished', 'contactEstablished 必须是布尔值'));
    const pairs = value?.contactPairs;
    if (pairs !== undefined && (!Array.isArray(pairs) || pairs.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(id => !participantIds.has(String(id)))))) {
        errors.push(issue('declaration.contact_pairs_invalid', '/contactPairs', 'contactPairs 必须是声明实体 ID 组成的二元数组'));
    }
}

function validateLifeAndQualities(value, path, errors, { strict = false } = {}) {
    if (!strict && value?.lifeLevel === undefined && value?.attributeQualities === undefined && value?.qualityProfile === undefined) return;
    if (!LIFE_LEVELS.has(String(value?.lifeLevel || ''))) errors.push(issue('declaration.life_level_required', `${path}/lifeLevel`, '必须声明 I–IX（罗马数字）的生命层级'));
    const qualities = value?.attributeQualities || value?.qualityProfile;
    if (!qualities || typeof qualities !== 'object' || ATTRIBUTE_KEYS.some(key => !QUALITY_LEVELS.has(String(qualities[key] || '').toUpperCase()))) errors.push(issue('declaration.attribute_qualities_required', `${path}/attributeQualities`, '必须为五维分别声明 F–SSS 品质，不能用阿拉伯数字代替'));
}

export function validateBattleDeclaration(value, { strict = false } = {}) {
    const errors = [];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, errors: [issue('declaration.invalid', '/', '战场声明必须是 JSON 对象')] };
    if (!text(value.reason || value.task || value.summary)) errors.push(issue('declaration.reason_required', '/reason', '必须说明战斗原因、任务或冲突'));
    const field = value.battlefield;
    if (!field || typeof field !== 'object') errors.push(issue('declaration.battlefield_required', '/battlefield', '必须提供笼统战场信息'));
    else {
        if (!text(field.kind || field.description || field.type)) errors.push(issue('declaration.battlefield_kind_required', '/battlefield/kind', '必须说明战场类型，例如建筑内部、空旷地或街道'));
        if (field.shapeHint && !['rectangle', 'circle', 'unknown'].includes(field.shapeHint)) errors.push(issue('declaration.shape_hint_invalid', '/battlefield/shapeHint', 'shapeHint 只能是 rectangle / circle / unknown'));
    }
    if (strict && value.schema !== 'vibe-combat-declaration/v3') errors.push(issue('declaration.schema_required', '/schema', '自动本地战斗必须使用 vibe-combat-declaration/v3 协议'));
    if (strict && !LIFE_LEVELS.has(String(value.worldLifeLevel || ''))) errors.push(issue('declaration.world_life_level_required', '/worldLifeLevel', '必须声明当前世界生命层级 I–IX'));
    const participants = array(value.participants);
    const participantIds = new Set(participants.map(item => String(item?.id || '')).filter(Boolean));
    validateContact(value, participantIds, errors, { strict });
    if (!participants.length) errors.push(issue('declaration.participants_required', '/participants', '必须声明至少两名参战实体'));
    let hasPlayer = false, hasEnemy = false;
    participants.forEach((participant, index) => {
        const path = `/participants/${index}`;
        if (!text(participant.id)) errors.push(issue('declaration.participant_id_required', `${path}/id`, '每个实体必须有稳定 id'));
        if (!text(participant.name) && !text(participant.reference)) errors.push(issue('declaration.participant_name_required', `${path}/name`, '每个实体必须有名称或已有实体引用'));
        if (!sides.has(participant.side)) errors.push(issue('declaration.participant_side_required', `${path}/side`, 'side 必须是 player、enemy 或 neutral'));
        if (!text(participant.state || participant.condition || participant.appearance)) errors.push(issue('declaration.participant_state_required', `${path}/state`, '必须描述该实体的大致状态'));
        if (!text(participant.relativePosition || participant.positionHint) && !(participant.distribution && typeof participant.distribution === 'object') && !text(participant.distribution)) errors.push(issue('declaration.participant_position_required', `${path}/relativePosition`, '必须描述相对主控角色的模糊方位、距离或分布'));
        validateDistribution(participant.distribution, `${path}/distribution`, errors);
        if (participant.count !== undefined && (!finite(participant.count) || Number(participant.count) < 1 || Number(participant.count) > 1000 || !Number.isInteger(Number(participant.count)))) errors.push(issue('declaration.participant_count_invalid', `${path}/count`, 'count 必须是 1–1000 的整数'));
        if (!['existing', 'create'].includes(participant.source)) errors.push(issue('declaration.participant_source_required', `${path}/source`, 'source 必须是 existing 或 create'));
        if (participant.source === 'existing' && !text(participant.reference)) errors.push(issue('declaration.participant_reference_required', `${path}/reference`, '引用已有实体时必须给出 reference'));
        if (participant.source === 'create' && participant.side !== 'enemy' && !text(participant.role || participant.intent)) errors.push(issue('declaration.created_entity_intent_required', `${path}/intent`, '新建非敌对实体必须描述意图'));
        if (strict) validateLifeAndQualities(participant, path, errors, { strict: true });
        if (participant.side === 'player') hasPlayer = true;
        if (participant.side === 'enemy') hasEnemy = true;
    });
    if (!hasPlayer) errors.push(issue('declaration.player_required', '/participants', '必须包含玩家方实体'));
    if (!hasEnemy) errors.push(issue('declaration.enemy_required', '/participants', '必须包含敌对实体'));
    return { ok: errors.length === 0, errors };
}

function validateAbility(ability, path, errors) {
    if (!text(ability?.id)) errors.push(issue('model.ability_id_required', `${path}/id`, '能力必须有 id'));
    if (!text(ability?.name)) errors.push(issue('model.ability_name_required', `${path}/name`, '能力必须有名称'));
    if (!finite(ability?.maxRangeMeters) || Number(ability.maxRangeMeters) < 0 || Number(ability.maxRangeMeters) > 1000) errors.push(issue('model.ability_range_required', `${path}/maxRangeMeters`, '能力必须具备 0–1000 米的明确最大射程'));
    if (!finite(ability?.minRangeMeters ?? 0) || Number(ability?.minRangeMeters ?? 0) < 0 || Number(ability?.minRangeMeters ?? 0) > Number(ability?.maxRangeMeters ?? -1)) errors.push(issue('model.ability_min_range_invalid', `${path}/minRangeMeters`, '最小射程必须不大于最大射程'));
    if (!finite(ability?.epCost ?? 0) || Number(ability?.epCost ?? 0) < 0) errors.push(issue('model.ability_ep_cost_invalid', `${path}/epCost`, 'EP 消耗必须是非负数'));
    if (!finite(ability?.cooldownRounds ?? 0) || Number(ability?.cooldownRounds ?? 0) < 0) errors.push(issue('model.ability_cooldown_invalid', `${path}/cooldownRounds`, '冷却必须是非负回合数'));
    if (!['main', 'minor'].includes(ability?.actionType)) errors.push(issue('model.ability_action_type_invalid', `${path}/actionType`, '行动类型只能是 main 或 minor'));
    if (!finite(ability?.targetCount) || Number(ability.targetCount) < 1 || Number(ability.targetCount) > 1000) errors.push(issue('model.ability_target_count_invalid', `${path}/targetCount`, '目标数量必须是 1–1000 的整数'));
    if (typeof ability?.aoe !== 'boolean') errors.push(issue('model.ability_aoe_required', `${path}/aoe`, '必须明确标记 aoe 为 true 或 false'));
    const basic = ability?.id === 'basic-attack';
    if (basic && finite(ability?.power) && Number(ability.power) !== 0) errors.push(issue('model.basic_attack_power_duplicate', `${path}/power`, 'basic-attack 的 power 必须为 0；攻击面板 ATK/MATK 已包含基础攻击力，禁止重复相加'));
    if (basic && finite(ability?.modifier) && Number(ability.modifier) !== 0) errors.push(issue('model.basic_attack_modifier_duplicate', `${path}/modifier`, 'basic-attack 的 modifier 必须为 0；攻击检定修正来自单位攻击修正，禁止重复相加'));
    if (!basic && !text(ability?.script) && !finite(ability?.power)) errors.push(issue('model.ability_effect_missing', path, '非基础能力必须提供可审查脚本或明确 power'));
}

function validateAsset(profile, index, errors) {
    const path = `/assetProfiles/${index}`;
    if (!text(profile?.assetId)) errors.push(issue('asset.id_required', `${path}/assetId`, '战斗资料必须绑定唯一 assetId'));
    if (!text(profile?.fingerprint)) errors.push(issue('asset.fingerprint_required', `${path}/fingerprint`, '战斗资料必须绑定物品指纹'));
    if (!text(profile?.kind)) errors.push(issue('asset.kind_required', `${path}/kind`, '战斗资料必须说明来源类型'));
    const combat = profile?.combat;
    if (!combat || typeof combat !== 'object') errors.push(issue('asset.combat_required', `${path}/combat`, '战斗资料缺少本地战斗参数'));
    else {
        if (!finite(combat.minRangeMeters ?? 0) || !finite(combat.maxRangeMeters) || Number(combat.maxRangeMeters) < Number(combat.minRangeMeters ?? 0)) errors.push(issue('asset.range_required', `${path}/combat`, '资料必须有合法最小/最大射程'));
        if (!finite(combat.cooldownRounds ?? 0) || Number(combat.cooldownRounds ?? 0) < 0) errors.push(issue('asset.cooldown_required', `${path}/combat/cooldownRounds`, '资料必须有非负冷却'));
    }
}

function validateIntelProfile(profile, path, errors) {
    if (!profile || typeof profile !== 'object') { errors.push(issue('model.intel_profile_required', path, '单位必须具有情报档案')); return; }
    if (!presences.has(profile.presence)) errors.push(issue('model.intel_presence_invalid', `${path}/presence`, 'presence 只能是 obvious、cautious 或 concealed'));
    for (const key of ['stealthBonus', 'perceptionBonus', 'commandBonus']) if (!finite(profile[key] ?? 0)) errors.push(issue('model.intel_modifier_invalid', `${path}/${key}`, '情报修正必须是有限数值'));
    for (const key of ['hearingMeters', 'intelligenceRangeMeters', 'movementNoiseMeters', 'attackNoiseMeters']) if (profile[key] !== undefined && (!finite(profile[key]) || Number(profile[key]) < 0 || Number(profile[key]) > 1000)) errors.push(issue('model.intel_range_invalid', `${path}/${key}`, '情报距离与声响范围必须为 0–1000 米'));
    if (profile.intelligenceBonus !== undefined && !finite(profile.intelligenceBonus)) errors.push(issue('model.intel_modifier_invalid', `${path}/intelligenceBonus`, '情报能力修正必须是有限数值'));
}

function validateTacticalProfile(profile, path, errors) {
    if (!profile || typeof profile !== 'object') { errors.push(issue('model.tactical_profile_required', path, '单位必须具有团体战术档案')); return; }
    if (!tacticalArchetypes.has(profile.archetype)) errors.push(issue('model.tactical_archetype_invalid', `${path}/archetype`, 'archetype 只能是 scattered、squad 或 hive'));
    if (!text(profile.groupId)) errors.push(issue('model.tactical_group_required', `${path}/groupId`, '团体战术必须有稳定 groupId'));
    if (!tacticalObjectives.has(profile.objective)) errors.push(issue('model.tactical_objective_invalid', `${path}/objective`, 'objective 只能是 search、engage 或 hold'));
    if (!tacticalFocusRules.has(profile.focusRule)) errors.push(issue('model.tactical_focus_invalid', `${path}/focusRule`, 'focusRule 只能是 nearest、weakest 或 marked'));
    if (!finite(profile.coordinationRadiusMeters) || Number(profile.coordinationRadiusMeters) < 0 || Number(profile.coordinationRadiusMeters) > 1000) errors.push(issue('model.tactical_radius_invalid', `${path}/coordinationRadiusMeters`, '协同半径必须为 0–1000 米'));
}

function validateAttributes(attributes, path, errors) {
    if (!attributes || typeof attributes !== 'object') { errors.push(issue('model.attributes_required', path, '单位必须具有五维修正')); return; }
    for (const key of ['strengthModifier', 'dexterityModifier', 'constitutionModifier', 'spiritModifier', 'charismaModifier']) if (!finite(attributes[key])) errors.push(issue('model.attribute_modifier_required', `${path}/${key}`, '五维修正必须是有限数值'));
}

export function validateCombatModel(model, { declaration = null, requiredAssets = [], strict = false } = {}) {
    const errors = [];
    if (!model || typeof model !== 'object' || Array.isArray(model)) return { ok: false, errors: [issue('model.invalid', '/', 'CombatModel 必须是 JSON 对象')] };
    if (!text(model.title)) errors.push(issue('model.title_required', '/title', '战斗模型必须有标题'));
    if (strict && model.schema !== 'vibe-combat-model/v3') errors.push(issue('model.schema_required', '/schema', '自动本地战斗必须使用 vibe-combat-model/v3 协议'));
    if (strict && !LIFE_LEVELS.has(String(model.worldLifeLevel || ''))) errors.push(issue('model.world_life_level_required', '/worldLifeLevel', '模型必须保留世界生命层级 I–IX'));
    if (strict && typeof model.contactEstablished !== 'boolean') errors.push(issue('model.contact_flag_required', '/contactEstablished', '模型必须保留正文 contactEstablished 关键旗标'));
    const field = model.battlefield;
    if (!field || typeof field !== 'object') errors.push(issue('model.battlefield_required', '/battlefield', '必须创建数字化战场'));
    else {
        if (!shapes.has(field.shape)) errors.push(issue('model.shape_invalid', '/battlefield/shape', 'shape 只能为 rectangle 或 circle'));
        if (!field.center || !finite(field.center.x) || !finite(field.center.y)) errors.push(issue('model.center_required', '/battlefield/center', '战场必须有固定中心坐标 center{x,y}'));
        if (field.shape === 'rectangle' && (!finite(field.widthMeters) || !finite(field.heightMeters) || Number(field.widthMeters) < 4 || Number(field.heightMeters) < 4)) errors.push(issue('model.rectangle_size_invalid', '/battlefield', '矩形战场必须有至少 4 米的宽和高'));
        if (field.shape === 'circle' && (!finite(field.radiusMeters) || Number(field.radiusMeters) < 2)) errors.push(issue('model.circle_size_invalid', '/battlefield/radiusMeters', '圆形战场半径至少为 2 米'));
    }
    const units = array(model.combatants);
    if (units.length < 2) errors.push(issue('model.units_required', '/combatants', '至少需要两名完整战斗单位'));
    let hasPlayer = false, hasEnemy = false;
    const unitIds = new Set();
    units.forEach((unit, index) => {
        const path = `/combatants/${index}`;
        if (!text(unit?.id) || !text(unit?.name)) errors.push(issue('model.unit_identity_required', path, '单位必须有 id 和 name'));
        else if (unitIds.has(unit.id)) errors.push(issue('model.unit_id_duplicate', `${path}/id`, `单位 id “${unit.id}”重复`));
        else unitIds.add(unit.id);
        if (!text(unit?.declarationId)) errors.push(issue('model.unit_declaration_required', `${path}/declarationId`, '单位必须关联正文 AI 的参战声明 id'));
        if (unit?.count !== undefined && (!finite(unit.count) || Number(unit.count) < 1 || Number(unit.count) > 1000 || !Number.isInteger(Number(unit.count)))) errors.push(issue('model.unit_count_invalid', `${path}/count`, '单位数量必须是 1–1000 的整数'));
        if (!sides.has(unit?.side)) errors.push(issue('model.unit_side_required', `${path}/side`, '单位必须具有合法阵营'));
        if (!finite(unit?.hp) || !finite(unit?.maxHp) || Number(unit.maxHp) <= 0 || Number(unit.hp) < 0 || Number(unit.hp) > Number(unit.maxHp)) errors.push(issue('model.unit_hp_invalid', path, '单位 HP / maxHp 不完整或不合法'));
        if (!finite(unit?.ep ?? 0) || !finite(unit?.maxEp ?? 0) || Number(unit.ep ?? 0) < 0 || Number(unit.maxEp ?? 0) < Number(unit.ep ?? 0)) errors.push(issue('model.unit_ep_invalid', path, '单位 EP / maxEp 不完整或不合法'));
        for (const key of ['attack', 'magicAttack', 'attackModifier', 'defenseDC', 'initiativeDC', 'armor', 'resistance', 'radiusMeters', 'speedMeters', 'facingDegrees', 'fovDegrees', 'visionMeters']) if (!finite(unit?.[key])) errors.push(issue('model.unit_stat_required', `${path}/${key}`, `单位缺少可计算字段 ${key}`));
        if (!unit?.position || !finite(unit.position.x) || !finite(unit.position.y)) errors.push(issue('model.unit_position_required', `${path}/position`, '单位必须有固定 x/y 初始坐标'));
        if (Number(unit?.speedMeters) <= 0 || Number(unit?.speedMeters) > 100 || Number(unit?.fovDegrees) < 20 || Number(unit?.fovDegrees) > 360) errors.push(issue('model.unit_spatial_invalid', path, '单位移速或视野扇形超出首版允许范围'));
        validateAttributes(unit?.attributes, `${path}/attributes`, errors);
        if (strict) {
            if (!LIFE_LEVELS.has(String(unit?.lifeLevel || ''))) errors.push(issue('model.unit_life_level_required', `${path}/lifeLevel`, '单位必须有 I–IX 生命层级'));
            const qualities = unit?.attributeQualities || unit?.qualityProfile;
            if (!qualities || ATTRIBUTE_KEYS.some(key => !QUALITY_LEVELS.has(String(qualities[key] || '').toUpperCase()))) errors.push(issue('model.unit_attribute_qualities_required', `${path}/attributeQualities`, '单位必须有完整五维 F–SSS 品质结果'));
            if (!unit?.combatProvenance || unit.combatProvenance.source === 'temporary' || !text(unit.combatProvenance.formulaVersion)) errors.push(issue('model.unit_provenance_required', `${path}/combatProvenance`, '单位必须记录世界生命层级、品质来源和公式版本，禁止临时瞎填'));
            if (unit?.side === 'player' && Array.isArray(unit.combatProvenance?.missingPaths) && unit.combatProvenance.missingPaths.length) errors.push(issue('model.player_authority_missing', `${path}/combatProvenance/missingPaths`, `玩家 MVU 缺少权威战斗字段：${unit.combatProvenance.missingPaths.join('、')}`));
            if (strict && unit?.combatProvenance) {
                if (String(unit.combatProvenance.worldLifeLevel || '') !== String(model.worldLifeLevel || '')) errors.push(issue('model.unit_provenance_world_mismatch', `${path}/combatProvenance/worldLifeLevel`, '单位来源证明中的世界生命层级不一致'));
                if (String(unit.combatProvenance.lifeLevel || '') !== String(unit.lifeLevel || '')) errors.push(issue('model.unit_provenance_life_mismatch', `${path}/combatProvenance/lifeLevel`, '单位来源证明中的生命层级不一致'));
                if (JSON.stringify(unit.combatProvenance.attributeQualities || {}) !== JSON.stringify(unit.attributeQualities || unit.qualityProfile || {})) errors.push(issue('model.unit_provenance_quality_mismatch', `${path}/combatProvenance/attributeQualities`, '单位来源证明中的五维品质不一致'));
            }
            if (!Array.isArray(unit.assetBindings)) errors.push(issue('model.unit_asset_bindings_required', `${path}/assetBindings`, 'v3 单位必须明确列出装备绑定（无装备也须为空数组）'));
        }
        validateIntelProfile(unit?.intelProfile, `${path}/intelProfile`, errors);
        validateTacticalProfile(unit?.tacticalProfile, `${path}/tacticalProfile`, errors);
        const abilities = array(unit?.abilities);
        if (!abilities.length) errors.push(issue('model.unit_actions_missing', `${path}/abilities`, '每个单位必须至少有一个可用行动'));
        abilities.forEach((ability, abilityIndex) => validateAbility(ability, `${path}/abilities/${abilityIndex}`, errors));
        if (unit.assetBindings !== undefined && (!Array.isArray(unit.assetBindings) || unit.assetBindings.some(value => !text(value)))) errors.push(issue('model.unit_asset_bindings_invalid', `${path}/assetBindings`, 'assetBindings 必须是战斗资产 ID 数组'));
        if (unit?.side === 'player') hasPlayer = true;
        if (unit?.side === 'enemy') hasEnemy = true;
    });
    if (!hasPlayer) errors.push(issue('model.player_required', '/combatants', '模型中缺少玩家方'));
    if (!hasEnemy) errors.push(issue('model.enemy_required', '/combatants', '模型中缺少敌对方'));
    const profiles = array(model.assetProfiles);
    profiles.forEach((profile, index) => validateAsset(profile, index, errors));
    const profileIds = new Set(profiles.map(profile => profile?.assetId));
    if (profileIds.size !== profiles.length) errors.push(issue('asset.profile_id_duplicate', '/assetProfiles', '战斗资料 assetId 不可重复'));
    const requiredById = new Map(requiredAssets.map(asset => [asset.assetId, asset]));
    requiredAssets.forEach(asset => {
        const profile = profiles.find(item => item?.assetId === asset.assetId);
        if (!profile) errors.push(issue('asset.profile_missing', '/assetProfiles', `战术栏资产“${asset.name || asset.assetId}”缺少本地战斗资料`, { assetId: asset.assetId }));
        else if (profile.fingerprint !== asset.fingerprint || profile.kind !== asset.kind) errors.push(issue('asset.profile_identity_mismatch', '/assetProfiles', `资产“${asset.name || asset.assetId}”的 ID、指纹或来源类型不一致`, { assetId: asset.assetId }));
        else if (strict && asset.finalAttributes && JSON.stringify(profile.finalAttributes || {}) !== JSON.stringify(asset.finalAttributes)) errors.push(issue('asset.final_attributes_mismatch', '/assetProfiles', `资产“${asset.name || asset.assetId}”的真实属性被战斗 AI 改写`, { assetId: asset.assetId }));
    });
    units.forEach((unit, index) => array(unit?.assetBindings).forEach(assetId => {
        if (!profileIds.has(assetId)) errors.push(issue('model.unit_asset_binding_unknown', `/combatants/${index}/assetBindings`, `单位绑定了不存在的战斗资产 ${assetId}`));
    }));
    profiles.forEach((profile, index) => {
        const required = requiredById.get(profile?.assetId);
        if (required && (profile.fingerprint !== required.fingerprint || profile.kind !== required.kind)) errors.push(issue('asset.profile_identity_mismatch', `/assetProfiles/${index}`, `资产“${required.name || required.assetId}”的身份信息不一致`));
        if (strict && required && required.finalAttributes && (!profile.finalAttributes || typeof profile.finalAttributes !== 'object' || JSON.stringify(profile.finalAttributes) !== JSON.stringify(required.finalAttributes))) errors.push(issue('asset.final_attributes_mismatch', `/assetProfiles/${index}/finalAttributes`, `资产“${required.name || required.assetId}”必须保留本地真实属性`));
    });
    if (declaration) {
        const declarations = array(declaration.participants);
        const declared = new Set(declarations.map(item => item.id));
        const represented = new Set(units.map(unit => unit?.declarationId).filter(Boolean));
        units.forEach((unit, index) => { if (unit.declarationId && !declared.has(unit.declarationId)) errors.push(issue('model.declaration_reference_invalid', `/combatants/${index}/declarationId`, '单位引用了声明中不存在的参战者')); });
        declared.forEach(id => { if (!represented.has(id)) errors.push(issue('model.declaration_participant_missing', '/combatants', `正文声明中的参战实体 ${id} 未被数字化为战斗单位`)); });
        declarations.forEach(item => {
            const declaredCount = Number(item.count ?? 1);
            const modeledCount = units.filter(unit => unit?.declarationId === item.id).reduce((sum, unit) => sum + Number(unit.count ?? 1), 0);
            if (modeledCount && modeledCount !== declaredCount) errors.push(issue('model.declaration_count_mismatch', '/combatants', `参战声明 ${item.id} 的数量为 ${declaredCount}，战斗模型为 ${modeledCount}`));
        });
    }
    if (strict && declaration) {
        // The modeler must preserve the declaration's protocol contract, but
        // only when the declaration actually carries it.  A declaration that
        // omits contactEstablished/worldLifeLevel/contactPairs (for example a
        // manually drafted recognition without the v3 protocol fields) must
        // not turn every guessed model value into an impossible mismatch.
        if (declaration.contactEstablished !== undefined && model.contactEstablished !== declaration.contactEstablished) errors.push(issue('model.contact_flag_mismatch', '/contactEstablished', '战斗模型不得改写正文 contactEstablished 关键旗标'));
        if (declaration.worldLifeLevel !== undefined && model.worldLifeLevel !== declaration.worldLifeLevel) errors.push(issue('model.world_life_level_mismatch', '/worldLifeLevel', '战斗模型不得改写正文世界生命层级'));
        const pairKey = pair => Array.isArray(pair) && pair.length === 2 ? pair.map(String).sort().join('::') : '';
        const declaredPairs = new Set(array(declaration.contactPairs).map(pairKey).filter(Boolean));
        const modeledPairs = new Set(array(model.contactPairs).map(pairKey).filter(Boolean));
        if (declaration.contactPairs !== undefined && [...declaredPairs].some(pair => !modeledPairs.has(pair)) || [...modeledPairs].some(pair => !declaredPairs.has(pair))) errors.push(issue('model.contact_pairs_mismatch', '/contactPairs', '战斗模型必须原样保留正文接触实体对'));
        const declarationById = new Map(array(declaration.participants).map(item => [String(item.id), item]));
        units.forEach((unit, index) => {
            const source = declarationById.get(String(unit.declarationId));
            if (source?.lifeLevel && String(unit.lifeLevel) !== String(source.lifeLevel)) errors.push(issue('model.unit_life_level_mismatch', `/combatants/${index}/lifeLevel`, '单位生命层级必须与正文参战声明一致'));
            const sourceQualities = source?.attributeQualities || source?.qualityProfile;
            const modelQualities = unit.attributeQualities || unit.qualityProfile;
            if (sourceQualities && JSON.stringify(sourceQualities) !== JSON.stringify(modelQualities)) errors.push(issue('model.unit_attribute_qualities_mismatch', `/combatants/${index}/attributeQualities`, '单位五维品质必须与正文参战声明一致'));
        });
    }
    if (!errors.length) {
        try { validateSpatialEncounter(normalizeEncounter(model)); }
        catch (error) { errors.push(issue('model.spatial_invalid', '/combatants', error.message)); }
    }
    return { ok: errors.length === 0, errors, report: { version: 1, errors, requiredAssets: requiredAssets.map(asset => ({ assetId: asset.assetId, name: asset.name, kind: asset.kind })) } };
}
