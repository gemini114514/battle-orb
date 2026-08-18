const DOCTOR_VERSION = '1.0.0';
const ROOT_ID = 'battle-orb-root';
const FAB_ID = 'battle-orb-fab';
const STYLE_HINT = /battle-orb/i;
const TRACE_KEY = 'battle-orb.doctor.trace.v1';
const SETTINGS_ID = 'battle-orb-extension-settings';

function scrub(value) {
    return String(value ?? '')
        .replace(/(?:api[-_ ]?key|authorization|cookie|secret|password|access[-_ ]?token|refresh[-_ ]?token)\s*[:=]\s*[^\s,;]+/gi, '[redacted]')
        .slice(0, 4000);
}

function record(stage, detail = {}) {
    const event = { time: new Date().toISOString(), stage, detail };
    if (!Array.isArray(globalThis.__battleOrbBootEvents)) globalThis.__battleOrbBootEvents = [];
    globalThis.__battleOrbBootEvents.push(event);
    globalThis.__battleOrbBootEvents = globalThis.__battleOrbBootEvents.slice(-100);
    return event;
}

function elementSnapshot(selector) {
    const element = document.querySelector(selector);
    if (!element) return { exists: false, selector };
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
        exists: true,
        selector,
        connected: element.isConnected,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        position: style.position,
        zIndex: style.zIndex,
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        inViewport: rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
    };
}

function resourceSnapshot() {
    return [...(globalThis.performance?.getEntriesByType?.('resource') || [])]
        .filter(entry => STYLE_HINT.test(entry.name))
        .slice(-20)
        .map(entry => ({ name: entry.name.replace(/[?&](?:key|token|api_key)=[^&]*/gi, '$1=[redacted]'), durationMs: Math.round(entry.duration), transferSize: entry.transferSize }));
}

function scriptSnapshot() {
    return [...document.scripts]
        .filter(script => STYLE_HINT.test(script.src))
        .map(script => ({ src: script.src, type: script.type, async: script.async }));
}

async function contextSnapshot() {
    try {
        const module = await import('../../../extensions.js');
        const context = module.getContext?.();
        return {
            available: Boolean(context),
            chatLength: Array.isArray(context?.chat) ? context.chat.length : null,
            chatId: context?.getCurrentChatId?.() || null,
            hasGenerateRaw: typeof context?.generateRaw === 'function',
            hasEventSource: Boolean(context?.eventSource),
            hasSaveChat: typeof context?.saveChat === 'function',
        };
    } catch (error) {
        return { available: false, error: scrub(error?.message || error) };
    }
}

export async function collect() {
    const context = await contextSnapshot();
    return {
        format: 'battle-orb-diagnostics',
        version: 1,
        doctorVersion: DOCTOR_VERSION,
        extensionVersion: globalThis.__battleOrbExpectedVersion || 'unknown',
        exportedAt: new Date().toISOString(),
        page: { origin: location.origin, pathname: location.pathname, readyState: document.readyState },
        bootEvents: Array.isArray(globalThis.__battleOrbBootEvents) ? globalThis.__battleOrbBootEvents.slice(-100) : [],
        dom: { root: elementSnapshot(`#${ROOT_ID}`), fab: elementSnapshot(`#${FAB_ID}`), status: elementSnapshot('#battle-orb-status') },
        styles: [...document.querySelectorAll('link[rel="stylesheet"]')].filter(link => STYLE_HINT.test(link.href)).map(link => ({ href: link.href, sheetLoaded: Boolean(link.sheet) })),
        scripts: scriptSnapshot(),
        resources: resourceSnapshot(),
        sillyTavern: context,
        settings: (() => { try { const raw = localStorage.getItem('battle-orb.fab-visible'); return { fabVisible: raw !== '0', storedValue: raw }; } catch (error) { return { readable: false, error: scrub(error?.message || error) }; } })(),
        traceEnabled: (() => { try { return localStorage.getItem(TRACE_KEY) === '1'; } catch { return false; } })(),
    };
}

function summary(report) {
    const fatal = [...(report.bootEvents || [])].reverse().find(item => /fatal|error|rejection/i.test(item.stage));
    const fab = report.dom.fab;
    return [
        `Battle Orb 版本：${report.extensionVersion}`,
        `酒馆上下文：${report.sillyTavern.available ? '正常' : '不可用'}`,
        `主界面 DOM：${report.dom.root.exists ? '存在' : '不存在'}`,
        `悬浮球：${fab.exists ? (fab.inViewport && fab.display !== 'none' ? '位于可视区' : '存在但不可见') : '不存在'}`,
        `样式资源：${report.styles.length ? (report.styles.some(item => item.sheetLoaded) ? '已加载' : '存在但未加载') : '未找到'}`,
        `当前聊天楼层：${report.sillyTavern.chatLength ?? '未知'}`,
        fatal ? `最近异常：${fatal.stage} · ${fatal.detail?.message || fatal.detail?.reason || '详见下方报告'}` : '最近异常：未捕获',
    ].join('\n');
}

export function openOrb() {
    globalThis.dispatchEvent(new CustomEvent('battle-orb:open-panel'));
    const root = document.getElementById(ROOT_ID);
    if (root) root.classList.add('open');
    record('open-orb-from-extension-settings', { rootExists: Boolean(root) });
    return Boolean(root);
}

export function setFabVisible(visible) {
    const next = Boolean(visible);
    try { localStorage.setItem('battle-orb.fab-visible', next ? '1' : '0'); } catch {}
    globalThis.dispatchEvent(new CustomEvent('battle-orb:set-fab-visible', { detail: { visible: next } }));
    const fab = document.getElementById(FAB_ID);
    if (fab) fab.style.display = next ? '' : 'none';
    record('fab-visibility-changed', { visible: next, fabExists: Boolean(fab) });
    return Boolean(fab);
}

export function download() {
    return collect().then(report => {
        const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `battle-orb-diagnostics-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        return report;
    });
}

async function runInto(status, json) {
    status.textContent = '正在检查脚本、样式、酒馆接口、DOM 与聊天上下文…';
    try {
        const report = await collect();
        status.textContent = summary(report);
        json.value = JSON.stringify(report, null, 2);
        json.hidden = false;
        record('diagnostic-collected', { fabExists: report.dom.fab.exists, rootExists: report.dom.root.exists });
    } catch (error) {
        status.textContent = `诊断失败：${scrub(error?.message || error)}`;
        record('diagnostic-failed', { message: scrub(error?.message || error) });
    }
}

function installSettingsPanel() {
    if (document.getElementById(SETTINGS_ID)) return true;
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) return false;
    const container = document.createElement('div');
    container.id = SETTINGS_ID;
    container.className = 'extension_container';
    container.innerHTML = `
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header"><b>Battle Orb 战斗球</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
        <div class="inline-drawer-content" style="display:none">
          <label class="checkbox_label"><input id="battle-orb-settings-show-fab" type="checkbox"><span>显示战斗球悬浮球</span></label>
          <div class="flex-container flexGap5" style="flex-wrap:wrap;margin:.5em 0">
            <button id="battle-orb-settings-open" class="menu_button" type="button">打开战斗球界面</button>
            <button id="battle-orb-settings-mount" class="menu_button" type="button">重新挂载悬浮球</button>
            <button id="battle-orb-settings-run-diagnostic" class="menu_button" type="button">运行诊断</button>
            <button id="battle-orb-settings-export-diagnostic" class="menu_button" type="button">导出 DEBUG</button>
            <button id="battle-orb-settings-trace-reload" class="menu_button" type="button">开启启动追踪并刷新</button>
          </div>
          <div id="battle-orb-settings-diagnostic-status" class="mes_text" style="white-space:pre-wrap;word-break:break-word;padding:.6em;border:1px solid var(--SmartThemeBorderColor);border-radius:6px">尚未运行诊断。</div>
          <textarea id="battle-orb-settings-diagnostic-json" readonly hidden style="width:100%;height:240px;margin-top:.5em;font-family:monospace;font-size:.8em"></textarea>
          <small>报告不包含 API Key、Authorization 或聊天正文，只记录接口状态、资源、错误和悬浮球 DOM。</small>
        </div>
      </div>`;
    host.prepend(container);
    const status = container.querySelector('#battle-orb-settings-diagnostic-status');
    const json = container.querySelector('#battle-orb-settings-diagnostic-json');
    const visibility = container.querySelector('#battle-orb-settings-show-fab');
    visibility.checked = (() => { try { return localStorage.getItem('battle-orb.fab-visible') !== '0'; } catch { return true; } })();
    visibility.addEventListener('change', () => setFabVisible(visibility.checked));
    container.querySelector('#battle-orb-settings-open').addEventListener('click', () => { status.textContent = openOrb() ? '战斗球界面已打开。' : '主脚本尚未成功挂载，请运行诊断查看最近异常。'; });
    container.querySelector('#battle-orb-settings-mount').addEventListener('click', () => { globalThis.dispatchEvent(new CustomEvent('battle-orb:remount')); setTimeout(() => { status.textContent = document.getElementById(FAB_ID) ? '已重新挂载战斗球悬浮球。' : '重新挂载后仍未找到悬浮球，请运行诊断。'; }, 50); });
    container.querySelector('#battle-orb-settings-run-diagnostic').addEventListener('click', () => void runInto(status, json));
    container.querySelector('#battle-orb-settings-export-diagnostic').addEventListener('click', () => download().then(() => { status.textContent = '诊断报告已下载。'; }).catch(error => { status.textContent = `导出失败：${scrub(error?.message || error)}`; }));
    container.querySelector('#battle-orb-settings-trace-reload').addEventListener('click', () => { localStorage.setItem(TRACE_KEY, '1'); status.textContent = '启动追踪已开启，正在刷新页面…'; setTimeout(() => location.reload(), 300); });
    record('extension-settings-panel-installed', { host: host.id });
    return true;
}

function scheduleSettingsPanel() {
    if (installSettingsPanel()) return;
    let attempts = 0;
    const timer = setInterval(() => { attempts += 1; if (installSettingsPanel() || attempts >= 40) clearInterval(timer); }, 500);
    const observer = new MutationObserver(() => { if (installSettingsPanel()) observer.disconnect(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 20000);
}

function installErrorCapture() {
    if (globalThis.__battleOrbDoctorListenersInstalled) return;
    globalThis.__battleOrbDoctorListenersInstalled = true;
    addEventListener('error', event => record('window-error', { message: scrub(event.error?.message || event.message), source: event.filename, line: event.lineno }));
    addEventListener('unhandledrejection', event => record('unhandled-rejection', { reason: scrub(event.reason?.message || event.reason) }));
}

export function install({ version } = {}) {
    globalThis.__battleOrbExpectedVersion ||= version || 'unknown';
    globalThis.BattleOrbDoctor = { collect, download, openOrb, setFabVisible, record, version: DOCTOR_VERSION };
    installErrorCapture();
    record('doctor-installed', { version: globalThis.__battleOrbExpectedVersion });
    scheduleSettingsPanel();
    if (localStorage.getItem(TRACE_KEY) === '1') void collect().then(report => console.info('[Battle Orb Doctor] 启动诊断', report)).catch(() => {});
}
