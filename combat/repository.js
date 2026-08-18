import fs from 'node:fs';
import path from 'node:path';
import { FileCombatStore } from './store-file.js';

// The combat ledger has no native (node-gyp) dependencies: on Node >= 22.13 it
// uses the SQLite engine that ships inside Node itself, and on older runtimes
// it falls back to a pure-JavaScript file store.  Either way `npm install`
// never needs a C++ toolchain such as Visual Studio Build Tools.
let SqliteCombatStore = null;
try {
    const sqlite = await import('node:sqlite');
    if (sqlite?.DatabaseSync) ({ SqliteCombatStore } = await import('./store-sqlite.js'));
} catch { /* runtime without node:sqlite: the file store below covers it */ }

export class CombatRepository {
    constructor(root) {
        const dataDir = path.join(root, 'data');
        fs.mkdirSync(dataDir, { recursive: true });
        if (SqliteCombatStore) {
            this.backend = 'node:sqlite';
            this.store = new SqliteCombatStore(dataDir);
        } else {
            this.backend = 'file';
            this.store = new FileCombatStore(dataDir);
            if (fs.existsSync(path.join(dataDir, 'combat.sqlite'))) {
                console.error('[combat] 检测到旧版 data/combat.sqlite，但当前 Node 缺少内置 node:sqlite（需 Node >= 22.13），旧战斗存档暂不可读取；升级 Node 后即可恢复。');
            }
        }
        // Simulator runs deliberately stay in process memory.  They retain the
        // same immutable event ledger and command idempotency as real battles,
        // but never acquire a persisted row or a story-session link.
        this.transient = new Map();
    }

    create(state) {
        if (state.transient) {
            this.transient.set(state.id, { state, events: [], commands: new Map() });
            return state;
        }
        this.store.create(state);
        return state;
    }

    get(id) {
        const transient = this.transient.get(id);
        if (transient) return JSON.parse(JSON.stringify(transient.state));
        return this.store.get(id);
    }

    save(state, benchmark = null) {
        const transient = this.transient.get(state.id);
        if (transient) { transient.state = JSON.parse(JSON.stringify(state)); return; }
        this.store.save(state, benchmark);
    }

    transaction(run) { return this.store.transaction(run); }

    appendEvent(battleId, event) {
        const transient = this.transient.get(battleId);
        if (transient) { transient.events.push(JSON.parse(JSON.stringify(event))); return; }
        this.store.appendEvent(battleId, event);
    }

    events(id, after = 0, options = {}) {
        const transient = this.transient.get(id);
        if (transient) {
            let events = transient.events.filter(event => event.sequence > (Number(after) || 0)).map(event => JSON.parse(JSON.stringify(event)));
            if (options.limit && events.length > options.limit) events = options.tail ? events.slice(-options.limit) : events.slice(0, options.limit);
            return events;
        }
        return this.store.events(id, after, options);
    }

    command(id, commandId) {
        const transient = this.transient.get(id);
        if (transient) return transient.commands.has(commandId) ? JSON.parse(JSON.stringify(transient.commands.get(commandId))) : null;
        return this.store.command(id, commandId);
    }

    saveCommand(id, commandId, result) {
        const transient = this.transient.get(id);
        if (transient) { transient.commands.set(commandId, JSON.parse(JSON.stringify(result))); return; }
        this.store.saveCommand(id, commandId, result);
    }

    commit(state, events = [], commandId = null, result = null, benchmark = null) {
        const nowMs = () => Number(process.hrtime.bigint()) / 1e6;
        this.store.transaction(() => {
            const eventStartedAt = nowMs();
            for (const event of events) this.appendEvent(state.id, event);
            if (benchmark) benchmark.spans['persist.events'] = { totalMs: nowMs() - eventStartedAt, count: events.length, maxMs: nowMs() - eventStartedAt };
            const commandStartedAt = nowMs();
            if (commandId) this.saveCommand(state.id, commandId, result);
            if (benchmark) benchmark.spans['persist.command-cache'] = { totalMs: nowMs() - commandStartedAt, count: commandId ? 1 : 0, maxMs: nowMs() - commandStartedAt };
            const stateStartedAt = nowMs();
            this.save(state, benchmark);
            if (benchmark) benchmark.spans['persist.state-save'] = { totalMs: nowMs() - stateStartedAt, count: 1, maxMs: nowMs() - stateStartedAt };
        });
    }

    approveScript(hash, rulesetVersion, source) {
        this.store.approveScript(hash, rulesetVersion, source);
    }

    isScriptApproved(hash, rulesetVersion) {
        return this.store.isScriptApproved(hash, rulesetVersion);
    }

    assetProfile(assetId) {
        return this.store.assetProfile(assetId);
    }

    saveAssetProfile(profile) {
        if (!profile?.assetId) return;
        this.store.saveAssetProfile(profile);
    }

    sessionCount() {
        return this.store.sessionCount();
    }

    insertSessionRow(row) {
        this.store.insertSessionRow(row);
    }
}
