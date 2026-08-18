const DB_NAME = 'reincarnation-library';
const DB_VERSION = 4;
const STORES = ['presets', 'scripts', 'profiles', 'userProfiles', 'regexPresets', 'worldbooks'];

function openDb() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);
        request.onupgradeneeded = () => {
            for (const name of STORES) if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name, { keyPath: 'id' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function transaction(storeName, mode, operation) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const result = operation(tx.objectStore(storeName));
        tx.oncomplete = () => resolve(result?.result);
        tx.onerror = () => reject(tx.error);
    });
}

export const library = {
    async list(store) { return (await transaction(store, 'readonly', objectStore => objectStore.getAll())) ?? []; },
    async get(store, id) { return transaction(store, 'readonly', objectStore => objectStore.get(id)); },
    async put(store, value) { await transaction(store, 'readwrite', objectStore => objectStore.put(value)); return value; },
    async delete(store, id) { return transaction(store, 'readwrite', objectStore => objectStore.delete(id)); },
};

function activeOrder(raw) {
    const orders = raw.prompt_order ?? [];
    const selected = orders.find(item => String(item.character_id) === '100001') ?? orders.at(-1);
    return selected?.order ?? [];
}

function normalizeRegexScript(script = {}, index = 0) {
    return {
        id: script.id || crypto.randomUUID(),
        scriptName: script.scriptName || script.script_name || script.name || `正则 ${index + 1}`,
        disabled: Boolean(script.disabled),
        runOnEdit: Boolean(script.runOnEdit ?? script.run_on_edit),
        findRegex: script.findRegex || script.find_regex || script.regex || '',
        replaceString: script.replaceString ?? script.replace_string ?? script.replace ?? '',
        trimStrings: script.trimStrings || script.trim_strings || [],
        placement: script.placement || [1, 2],
        substituteRegex: script.substituteRegex ?? script.substitute_regex ?? 0,
        minDepth: script.minDepth ?? script.min_depth ?? null,
        maxDepth: script.maxDepth ?? script.max_depth ?? null,
        markdownOnly: Boolean(script.markdownOnly ?? script.markdown_only),
        promptOnly: Boolean(script.promptOnly ?? script.prompt_only),
    };
}

function presetRegexScripts(raw) {
    const extensions = raw?.extensions || {};
    const nested = extensions.SPreset?.RegexBinding?.regexes;
    const scripts = Array.isArray(extensions.regex_scripts)
        ? extensions.regex_scripts
        : Array.isArray(nested) ? nested : [];
    return scripts.map(normalizeRegexScript);
}

export function normalizePreset(raw, filename = '未命名预设') {
    if (!Array.isArray(raw?.prompts)) throw new Error('不是可识别的 SillyTavern OAI/AIRP 预设：缺少 prompts');
    const order = activeOrder(raw);
    // SillyTavern treats an existing character prompt order as an allow-list.
    // Entries that are enabled in the raw `prompts` array but are not present
    // in the selected order are not sent.  Falling back to prompt.enabled here
    // silently adds stale/system entries and is one of the most common causes
    // of an independent request drifting from Tavern.
    const hasExplicitOrder = Array.isArray(raw.prompt_order) && raw.prompt_order.length > 0
        && Array.isArray((raw.prompt_order.find(item => String(item.character_id) === '100001') ?? raw.prompt_order.at(-1))?.order);
    const enabledMap = new Map(order.map((item, index) => [item.identifier, { enabled: item.enabled !== false, index }]));
    const prompts = raw.prompts.map((prompt, sourceIndex) => ({
        identifier: prompt.identifier || crypto.randomUUID(),
        name: prompt.name || prompt.identifier || `条目 ${sourceIndex + 1}`,
        role: ['system', 'user', 'assistant'].includes(prompt.role) ? prompt.role : 'system',
        content: prompt.content || '',
        marker: Boolean(prompt.marker),
        enabled: hasExplicitOrder
            ? Boolean(enabledMap.get(prompt.identifier)?.enabled)
            : prompt.enabled !== false,
        order: enabledMap.get(prompt.identifier)?.index ?? 10000 + sourceIndex,
        injectionPosition: prompt.injection_position ?? 0,
        injectionDepth: prompt.injection_depth ?? 4,
    })).sort((a, b) => a.order - b.order);
    return {
        id: crypto.randomUUID(),
        name: filename.replace(/\.json$/i, ''),
        format: 'sillytavern-oai',
        importedAt: new Date().toISOString(),
        prompts,
        sampling: {
            temperature: raw.temperature,
            topP: raw.top_p,
            topK: raw.top_k,
            frequencyPenalty: raw.frequency_penalty,
            presencePenalty: raw.presence_penalty,
            maxTokens: raw.openai_max_tokens,
            contextSize: raw.openai_max_context,
            reasoningEffort: raw.reasoning_effort,
        },
        assistantPrefill: raw.assistant_prefill || '',
        squashSystemMessages: Boolean(raw.squash_system_messages),
        promptOrderAligned: true,
        // Tavern stores preset-bound regexes in extensions.regex_scripts. Keep
        // a normalized copy so the independent runtime can execute them in
        // both prompt and display passes instead of merely preserving them in
        // raw metadata.
        regexScripts: presetRegexScripts(raw),
        extensions: raw.extensions || {},
        raw,
    };
}

export function normalizeScript(raw, filename = '未命名脚本') {
    if (raw?.type !== 'script' || typeof raw.content !== 'string') throw new Error('不是可识别的酒馆助手脚本');
    const { content, ...metadata } = raw;
    return { id: raw.id || crypto.randomUUID(), name: raw.name || filename.replace(/\.(?:json|m?js)$/i, ''), enabled: raw.enabled !== false, importedAt: new Date().toISOString(), content, data: raw.data || {}, button: raw.button || {}, raw: metadata };
}

export function normalizeUserProfile(raw = {}, fallbackName = '用户设定') {
    const name = String(raw.name || fallbackName).trim() || fallbackName;
    return {
        id: raw.id || crypto.randomUUID(),
        name,
        displayName: String(raw.displayName ?? raw.userName ?? '').trim(),
        persona: String(raw.persona ?? raw.content ?? '').trim(),
        description: String(raw.description ?? raw.note ?? '').trim(),
        tags: Array.isArray(raw.tags) ? raw.tags.map(item => String(item).trim()).filter(Boolean).slice(0, 20) : [],
        createdAt: raw.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}

export function normalizeRegexPreset(raw, filename = '未命名正则预设') {
    const scripts = Array.isArray(raw) ? raw : raw?.scripts || raw?.regex_scripts;
    if (!Array.isArray(scripts)) throw new Error('不是可识别的酒馆正则预设：缺少脚本数组');
    return {
        id: raw?.id || crypto.randomUUID(),
        name: raw?.name || filename.replace(/\.json$/i, ''),
        enabled: raw?.enabled !== false,
        importedAt: new Date().toISOString(),
        scripts: scripts.map(normalizeRegexScript),
        raw,
    };
}

function splitKeys(value) {
    if (Array.isArray(value)) return value.map(String).map(item => item.trim()).filter(Boolean);
    return String(value || '').split(/[,，]/).map(item => item.trim()).filter(Boolean);
}

// Same V3 snake_case entry shape the 3.2.6 card uses inside
// data.character_book.entries, so custom entries flow through the identical
// worldbook activation, EJS rendering and depth-injection paths.
export function normalizeWorldbookEntry(raw = {}) {
    const depthRaw = raw.extensions?.depth;
    const depth = Number(depthRaw);
    const inChat = depthRaw !== null && depthRaw !== undefined && Number.isFinite(depth);
    const position = raw.position === 'after_char' ? 'after_char' : 'before_char';
    return {
        id: Number.isFinite(Number(raw.id)) ? Number(raw.id) : Date.now() * 1000 + Math.floor(Math.random() * 1000),
        keys: splitKeys(raw.keys),
        secondary_keys: splitKeys(raw.secondary_keys),
        comment: String(raw.comment || raw.name || '未命名条目'),
        content: String(raw.content || ''),
        constant: Boolean(raw.constant),
        selective: Boolean(raw.selective),
        insertion_order: Number.isFinite(Number(raw.insertion_order)) ? Number(raw.insertion_order) : 100,
        enabled: raw.enabled !== false,
        position,
        use_regex: raw.use_regex !== false,
        extensions: {
            position: inChat ? 4 : (position === 'after_char' ? 1 : 0),
            ...(inChat ? { depth } : {}),
            role: Number(raw.extensions?.role) || 0,
        },
        origin: raw.origin || 'user',
        createdAt: raw.createdAt || new Date().toISOString(),
        updatedAt: new Date().toISOString(),
    };
}
