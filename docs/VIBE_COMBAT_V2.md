# Vibe Combat V2：二维数值战场实现

V2 保留 V1 的固定种子、事件哈希、SQLite 战斗存档、三种控制模式和脚本审批；空间规则收敛为易审计的二维回合制模型。

## 固定流程

1. 正文 AI 仅在正常叙事尾部附加隐藏的 `<BattleDeclaration>`：笼统战场、所有参战实体、阵营、已有实体引用/新建意图、大致状态及相对于主控角色的方位/模糊距离。敌群可声明数量和分布。它禁止输出 HP、坐标、伤害、技能和胜负。
2. 客户端验证声明并要求玩家确认。战斗 AI 将声明建模为严格 `CombatModel`：圆形或矩形边界、单位圆形碰撞体、坐标、半径、移速、HP/EP、行动、射程、冷却，以及五维、情报与团体战术档案。
3. 服务器检查模型。缺失参战者、数值、能力、射程、资产资料、边界或碰撞都会生成结构化错误报告；战斗 AI 最多修复五轮。耗尽后保留完整诊断，玩家可编辑完整模型后重新校验。
4. 玩家确认已通过验证的模型，服务器以固定种子创建本地战斗；行动、移动、命中、伤害、资源、冷却、状态、死亡和胜负只由本地引擎裁定。
5. 正式暂停/结算时，服务器提取 `vibe-combat-result-outline/v2`，仅含胜负、轮次、位置、HP/EP、伤亡、检定、关键事件和 MVU Patch。正文 AI 只能把该大纲润色为剧情，不能改写战果。

## 首版空间边界

- 只有 `rectangle` 与 `circle` 战场；单位都是有半径的圆。
- 使用连续米制坐标；点选地图后服务器校验单回合移动距离、边界及单位重叠。
- 技能以圆边到圆边的最小距离判断 `minRangeMeters` / `maxRangeMeters`，并按回合处理冷却。
- 暂不实现掩体、区域、地形、弹道、路径、投射物或环境伤害。任何这些概念均不可由 AI 暗中裁定。

## 情报、潜行与团体战术

- 每个单位具有 `attributes`：力量决定争夺近战接触位的优先级；敏捷与 `stealthBonus` 提高被发现 DC；体质参与警觉；精神参与发现；魅力和 `commandBonus` 扩大小队的情报协同半径。
- 发现检定使用固定 D100，基础 DC 为 50。来源独立记录为 `visual`、`auditory`、`intel`、`melee_contact` 或 `shared`，因此黑盒事件和剧情大纲可以追溯“如何得知”。
- 视觉发现受单位视野和目标显眼度影响；移动/攻击产生可听声源；`intelligenceRangeMeters` 是不造成伤害的额外情报感知距离。
- 近战攻击无论命中或未命中，受攻击单位立刻以 `melee_contact` 发现攻击者，不能用潜行永久规避贴身接触。
- 潜行不是玩家默认状态：手操回合可从地图空白处的行为菜单进入/退出潜行。进入潜行消耗次要行动、保持无持续时间状态；视觉发现改为正常 D100 检定，移动声源上限为 3m；攻击、脚本攻击或近战接触会立刻破隐并记录 `stealth_broken`。显式的 `sneak` 指令可在贴身首击前声明既有静默接敌，但首个近战动作仍必定以 `melee_contact` 暴露攻击者。
- 策略文本包含“游击、分割、切割、诱导、逐个击破、避免主群”时会编译为 `guerrilla` 风格，同时启用潜行与撤离倾向；策略按可审计的 `approach → escape → recon` 状态机运行。突袭后先执行战术脱离或疾走，优先拉开已确认威胁的最小距离；脱离视野后逐个进行 D100 断追踪，再以半速侦察回到己方最后确认的敌情点，绝不立刻折返追击同一名追兵。
- 伏击优势不改变伤害或装备数值：若攻击者处于潜行且目标尚未追踪攻击者，该次攻击使用 D100 优势；攻击后的声源、破隐与近战曝光仍按普通规则结算。`guerrilla_posture_changed`、`guerrilla_escape_assessed`、`strategy_retreat`、`tracking_lost` 和每次检定都进入事件账本。
- `scattered` 是各自搜寻的本能群体；`squad` 在有限协同半径内共享已确认目标；`hive` 可对同组所有活跃节点同步情报。它们的 `objective` 可为 `search`、`engage`、`hold`，`focusRule` 可为 `nearest`、`weakest`、`marked`。
- `BattleDeclaration.participants[].distribution` 只描述空间形态，不决定任何数值：`scattered` 使用确定性散落圆盘（适合丧尸），`squad`/`wedge` 使用小队形态，`legion`/`grid` 使用整齐方阵，`line` 使用横列，`ring` 使用环形。战斗 AI 必须将该声明落实到固定坐标；未声明时才沿用兼容性的旧默认排列。
- 迷雾地图与名单只显示玩家方已确认的敌方实体；失去视觉后保留“最后信号”位置，但不可作为攻击目标。

## 近战接触位

- 每个目标每回合只有 8 个近战攻击者位置，并在回合开始时固定分配；远程能力不受此项限制。
- 槽位按团体协同性、距离、力量、先攻、稳定 ID 排序。未获分配的实体仍会依照其战术档案移动、搜索或等待，但不能在该回合叠加进攻。
- 单个 `scattered` 敌人的近战接触不构成物理包围：单位可自动脱离；多名敌人或 `squad` / `hive` 的协同包围才进行敏捷脱离检定。此规则对玩家与 AI 完全对称。

## 战斗资产资料

主角已装备物品、可用道具与技能会首次赋予稳定的 `战斗资产ID` 和基于物品内容的指纹。战斗 AI 必须为每个资产提交 `assetProfiles`（最小/最大射程、冷却与攻击风格），服务器在确认创建时写入 `combat_asset_profiles`。正式战斗快照同时固化这份资料，物品后续变动不会追溯改变旧战斗。

## API 与验证

- `POST /api/combat/declaration/validate`
- `POST /api/combat/model/validate`
- `GET /api/combat/assets/:assetId`
- 现有 `sessions`、`commands`、`events`、`replay`、`narrative-bundle` API 继续可用。
- `POST /api/combat/:id/redo` 会在当前仍属于同一可操作行动时机时重复最近一次玩家命令，并追加 `command_redone` 事件；它不回滚状态，也不重掷历史事件。

`narrative-bundle` 现在返回的是可给正文 AI 使用的结果大纲，而不是可随意解释的完整内部状态。完整重放仍通过 `replay` 获取。

## 验收覆盖

`npm run test:combat` 覆盖确定性、100/1000 单位压力、8 个近战接触位、视觉/听觉/情报发现、近战暴露、格式塔共享情报、校验 API、坐标移动、资产 SQLite 缓存和结果大纲。1000 单位是纯 AOE 吞吐测试，显式设置全向远距感知，不与迷雾规则混淆。

`npm run test:guerrilla-v2` 使用最后存档的正式 MVU（HP 56、EP 8、等离子战矛 ATK 54 / MATK 40、五维修正 4/4/4/1/1）通过正式 HTTP 路由重复运行 1 对 100 散乱丧尸；黑盒输出写入 `.test/guerrilla-v2-formal-result.json`，包含正式面板来源、接触位峰值、敌方确认峰值与事件哈希状态。

`npm run test:last-save-stealth` 使用 `.test/last-save-combat-debug-final.json` 的最后存档人物和 100 个原始丧尸实体，走正式 HTTP 路由执行潜行、移动、等待和黑盒导出；结果保存至 `.test/last-save-100-zombies-stealth-result.json`。

`npm run test:last-save-stealth -- --engage` 在同一存档上执行游击式“潜行 → 分割 → 单点突袭 → 脱离”，结果保存至 `.test/last-save-100-zombies-stealth-combat-result.json`。

`npm run test:last-save-guerrilla-full` 使用正式 CardRuntime 生成的武器面板，持续运行到胜负终局（全歼、主角失能或引擎终止），结果保存至 `.test/last-save-100-zombies-guerrilla-full-result.json`。

`npm run test:combat-v2-ui` 覆盖隐藏战场声明预览、移动端二维画布点选、服务器坐标写入、重做按钮、100%/200% 缩放和浏览器错误；截图固定保存为 `.test/combat-v2-2d-map.png`。
