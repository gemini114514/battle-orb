# Battle Orb 战斗球

Battle Orb 现在是 SillyTavern / Comic Orb 工作流内的原生第三方扩展，不需要启动独立服务、不需要 iframe，也不需要额外端口。

仓库根目录就是可安装的酒馆扩展入口；使用酒馆的第三方扩展安装器安装本仓库即可：

扩展位置：

```text
C:\SillyTavern\comic-orb-test-tavern\public\scripts\extensions\third-party\battle-orb
```

手动安装时，将仓库根目录的 `manifest.json`、`index.js`、`style.css` 和 `combat/` 复制到上面的目录。`extension/` 目录保留为同一份扩展源码备份。

刷新或重启酒馆后，点击右下角 Battle Orb 按钮即可使用：

1. 从当前酒馆聊天读取剧情楼层。
2. 从楼层中的 `UpdateVariable / JSONPatch` 重放当前 MVU 快照。
3. 自动识别正文 AI 输出的 `<BattleDeclaration>`，也可以调用当前酒馆 AI 草拟声明。
4. 用当前酒馆 AI 建立 CombatModel。
5. 在扩展内直接运行复用的二维本地权威战斗引擎，固定种子记录骰点、伤害、状态、位置、事件账本和胜负。
6. 战斗结束后调用当前酒馆 AI 融合战报，把正文、`CheckResult` 和 `UpdateVariable / JSONPatch` 作为 assistant 楼层直接写回当前聊天。

`combat/` 是从独立端抽出的规则、引擎、模型校验、策略和战报 DSL；`combat/browser-repository.js` 只负责把持久化改为当前酒馆页面内存存储。根目录中的 Node 服务文件仅保留给原有自动化回归测试使用，酒馆运行 Battle Orb 不会调用它。
