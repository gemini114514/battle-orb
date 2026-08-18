import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
    CREATE TABLE IF NOT EXISTS combat_sessions (
        id TEXT PRIMARY KEY, story_session_id TEXT, status TEXT NOT NULL,
        version INTEGER NOT NULL, ruleset_version TEXT NOT NULL,
        seed TEXT NOT NULL, state_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS combat_events (
        battle_id TEXT NOT NULL, sequence INTEGER NOT NULL,
        event_json TEXT NOT NULL, hash TEXT NOT NULL,
        PRIMARY KEY (battle_id, sequence),
        FOREIGN KEY (battle_id) REFERENCES combat_sessions(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS combat_commands (
        battle_id TEXT NOT NULL, command_id TEXT NOT NULL,
        result_json TEXT NOT NULL, created_at TEXT NOT NULL,
        PRIMARY KEY (battle_id, command_id)
    );
    CREATE TABLE IF NOT EXISTS combat_script_approvals (
        script_hash TEXT NOT NULL, ruleset_version TEXT NOT NULL,
        source_json TEXT NOT NULL, approved_at TEXT NOT NULL,
        PRIMARY KEY (script_hash, ruleset_version)
    );
    CREATE TABLE IF NOT EXISTS combat_asset_profiles (
        asset_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL,
        kind TEXT NOT NULL, profile_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
`;

export class SqliteCombatStore {
    constructor(dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });
        this.db = new DatabaseSync(path.join(dataDir, 'combat.sqlite'));
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA foreign_keys = ON');
        this.db.exec(SCHEMA);
        this.insertSession = this.db.prepare('INSERT INTO combat_sessions VALUES (@id,@storySessionId,@status,@version,@rulesetVersion,@seed,@stateJson,@createdAt,@updatedAt)');
        this.updateSession = this.db.prepare('UPDATE combat_sessions SET status=@status,version=@version,state_json=@stateJson,updated_at=@updatedAt WHERE id=@id');
    }

    transaction(run) {
        this.db.exec('BEGIN');
        try {
            const result = run();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            try { this.db.exec('ROLLBACK'); } catch { /* connection already aborted the transaction */ }
            throw error;
        }
    }

    create(state) {
        const now = new Date().toISOString();
        this.insertSession.run({ id: state.id, storySessionId: state.storySessionId || null, status: state.status, version: state.version, rulesetVersion: state.rulesetVersion, seed: state.seed, stateJson: JSON.stringify(state), createdAt: now, updatedAt: now });
    }

    insertSessionRow(row) {
        this.insertSession.run({ id: row.id, storySessionId: row.storySessionId ?? null, status: row.status, version: row.version, rulesetVersion: row.rulesetVersion, seed: row.seed, stateJson: row.stateJson, createdAt: row.createdAt, updatedAt: row.updatedAt });
    }

    sessionCount() {
        return this.db.prepare('SELECT COUNT(*) AS count FROM combat_sessions').get().count;
    }

    get(id) {
        const row = this.db.prepare('SELECT state_json FROM combat_sessions WHERE id=?').get(id);
        return row ? JSON.parse(row.state_json) : null;
    }

    save(state, benchmark = null) {
        const startedAt = benchmark ? Number(process.hrtime.bigint()) / 1e6 : 0;
        const stateJson = JSON.stringify(state);
        if (benchmark) benchmark.spans['persist.state-serialize'] = { totalMs: Number(process.hrtime.bigint()) / 1e6 - startedAt, count: 1, maxMs: Number(process.hrtime.bigint()) / 1e6 - startedAt };
        this.updateSession.run({ id: state.id, status: state.status, version: state.version, stateJson, updatedAt: new Date().toISOString() });
    }

    appendEvent(battleId, event) {
        this.db.prepare('INSERT INTO combat_events VALUES (?,?,?,?)').run(battleId, event.sequence, JSON.stringify(event), event.hash);
    }

    events(id, after = 0, options = {}) {
        const limit = Number(options.limit) || 0;
        const order = options.tail ? 'DESC' : 'ASC';
        const suffix = limit ? ` LIMIT ${Math.min(1000, Math.max(1, limit))}` : '';
        const rows = this.db.prepare(`SELECT event_json FROM combat_events WHERE battle_id=? AND sequence>? ORDER BY sequence ${order}${suffix}`).all(id, Number(after) || 0);
        const events = rows.map(row => JSON.parse(row.event_json));
        return options.tail ? events.reverse() : events;
    }

    command(id, commandId) {
        const row = this.db.prepare('SELECT result_json FROM combat_commands WHERE battle_id=? AND command_id=?').get(id, commandId);
        return row ? JSON.parse(row.result_json) : null;
    }

    saveCommand(id, commandId, result) {
        this.db.prepare('INSERT INTO combat_commands VALUES (?,?,?,?)').run(id, commandId, JSON.stringify(result), new Date().toISOString());
    }

    approveScript(hash, rulesetVersion, source) {
        this.db.prepare('INSERT OR REPLACE INTO combat_script_approvals VALUES (?,?,?,?)').run(hash, rulesetVersion, JSON.stringify(source), new Date().toISOString());
    }

    isScriptApproved(hash, rulesetVersion) {
        return Boolean(this.db.prepare('SELECT 1 ok FROM combat_script_approvals WHERE script_hash=? AND ruleset_version=?').get(hash, rulesetVersion));
    }

    assetProfile(assetId) {
        const row = this.db.prepare('SELECT profile_json FROM combat_asset_profiles WHERE asset_id=?').get(assetId);
        return row ? JSON.parse(row.profile_json) : null;
    }

    saveAssetProfile(profile) {
        if (!profile?.assetId) return;
        const now = new Date().toISOString();
        this.db.prepare(`INSERT INTO combat_asset_profiles(asset_id,fingerprint,kind,profile_json,created_at,updated_at)
            VALUES (@assetId,@fingerprint,@kind,@profileJson,@now,@now)
            ON CONFLICT(asset_id) DO UPDATE SET fingerprint=excluded.fingerprint,kind=excluded.kind,profile_json=excluded.profile_json,updated_at=excluded.updated_at`)
            .run({ assetId: String(profile.assetId), fingerprint: String(profile.fingerprint || ''), kind: String(profile.kind || 'unknown'), profileJson: JSON.stringify(profile), now });
    }
}
