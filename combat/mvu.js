// MVU（正文AI 变量状态树）辅助：楼层 JSONPatch 解析、全量回放（带缓存）、
// 以及发送给大模型前的有界投影。纯函数模块，无 DOM 依赖，可在 Node 下直接单测。

const clone = value => (typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value)));

export const MVU_LLM_BUDGET_CHARS = 18000;
export const MVU_LLM_PRUNE_DEPTH = 3;
export const MVU_LLM_ENTRIES_PER_CATEGORY = 12;
export const MVU_LLM_ALWAYS_KEEP = ['主角', '系统状态', '任务'];

const replayCache = { chatId: null, signature: '', state: null, applied: 0 };

export function isMvuStatData(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length);
}

export function pointerParts(pointer) {
    return String(pointer || '').split('/').slice(1).map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

export function applyPatch(root, operation) {
    const path = pointerParts(operation?.path);
    if (!path.length) return operation?.op === 'remove' ? {} : clone(operation?.value ?? {});
    let parent = root;
    for (let index = 0; index < path.length - 1; index += 1) {
        const key = path[index];
        if (parent[key] === undefined || parent[key] === null || typeof parent[key] !== 'object') parent[key] = /^\d+$/.test(path[index + 1]) ? [] : {};
        parent = parent[key];
    }
    const key = path.at(-1);
    if (operation?.op === 'remove') {
        if (Array.isArray(parent)) parent.splice(Number(key), 1);
        else delete parent[key];
    } else if (Array.isArray(parent) && key === '-') parent.push(clone(operation.value));
    else parent[key] = clone(operation?.value);
    return root;
}

export function parsePatchBlocks(content) {
    const text = String(content || '');
    // 绝大多数楼层不含 JSONPatch，先做一次廉价的前置判定，跳过整楼正则扫描。
    if (text.indexOf('<JSONPatch') === -1 && text.indexOf('<jsonpatch') === -1) return [];
    const patches = [];
    const pattern = /<JSONPatch\b[^>]*>\s*([\s\S]*?)\s*<\/JSONPatch\s*>/gi;
    for (const match of text.matchAll(pattern)) {
        try {
            const parsed = JSON.parse(match[1]);
            if (Array.isArray(parsed)) patches.push(...parsed);
        } catch { /* preserve the floor even when a model emitted bad JSON */ }
    }
    return patches;
}

export function replayMvu(messages) {
    const output = { stat_data: {} };
    let applied = 0;
    for (const message of messages || []) {
        for (const operation of parsePatchBlocks(message.content)) {
            if (!operation?.path) continue;
            applyPatch(output, operation);
            applied += 1;
        }
    }
    return { state: output, applied };
}

// 带缓存的 MVU 回放：楼层与内容在会话中只会追加/少变，缓存命中时零扫描。
// 签名 = chatId + 楼层数 + 尾楼(id, 内容长度)，覆盖“追加新楼”与“尾楼被编辑”两类常见变更。
export function cachedReplayMvu(chatId, messages) {
    const last = messages.length ? messages[messages.length - 1] : null;
    const signature = `${chatId || ''}|${messages.length}|${last ? `${last.id}:${last.content.length}` : '0'}`;
    if (replayCache.signature === signature && replayCache.state) {
        return { state: replayCache.state, applied: replayCache.applied };
    }
    const replayed = replayMvu(messages);
    replayCache.chatId = chatId || null;
    replayCache.signature = signature;
    replayCache.state = replayed.state;
    replayCache.applied = replayed.applied;
    return replayed;
}

// 有界 MVU 投影：为 LLM 上下文裁剪 stat_data 树，避免把几百楼累积出的超大快照整棵喂给模型。
// 主角/系统状态/任务 恒保留（战斗最相关且体积小）；其余分类按 key 序截取前 N 项、
// 深度超过 PRUNE_DEPTH 的子树折叠为 {__pruned__}；序列化总长超过预算的尾部分类直接舍弃。
export function pruneMvuNode(value, depth, entriesLimit, maxDepth) {
    if (value === null || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.slice(0, entriesLimit);
    if (depth >= maxDepth) return { __pruned__: true };
    const output = {};
    for (const key of Object.keys(value).slice(0, entriesLimit)) {
        output[key] = pruneMvuNode(value[key], depth + 1, entriesLimit, maxDepth);
    }
    return output;
}

export function boundedMvuForLlm(state, budgetChars = MVU_LLM_BUDGET_CHARS) {
    const wrapped = state && typeof state === 'object' && !Array.isArray(state);
    const source = wrapped && typeof state.stat_data === 'object' && state.stat_data !== null && !Array.isArray(state.stat_data)
        ? state.stat_data : (wrapped ? state : {});
    const output = {};
    let size = 0;
    const measure = value => Math.ceil((JSON.stringify(value) || '').length);
    const order = [
        ...MVU_LLM_ALWAYS_KEEP.filter(key => key in source),
        ...Object.keys(source).filter(key => !MVU_LLM_ALWAYS_KEEP.includes(key)),
    ];
    for (const key of order) {
        const pruned = pruneMvuNode(source[key], 0, MVU_LLM_ENTRIES_PER_CATEGORY, MVU_LLM_PRUNE_DEPTH);
        const nodeSize = measure(pruned);
        if (size + nodeSize > budgetChars && !MVU_LLM_ALWAYS_KEEP.includes(key)) continue;
        output[key] = pruned;
        size += nodeSize;
    }
    return output;
}
