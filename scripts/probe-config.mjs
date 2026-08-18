import { chromium } from 'playwright-core';

const profile = 'C:\\SillyTavern\\reincarnation-web\\.test\\profile-copy-20260813';
const context = await chromium.launchPersistentContext(profile, {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    headless: true,
    args: ['--no-proxy-server', '--profile-directory=Default'],
    viewport: { width: 1440, height: 1000 },
});
try {
    const page = context.pages()[0] || await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime, null, { timeout: 60000 });
    const result = await page.evaluate(async () => {
        const app = window.__reincarnationApp;
        const settings = app.store.data.settings;
        const presets = app.presets();
        const events = await app.blackbox.events();
        return {
            hasConnection: app.store.data.connections.length > 0,
            hasApiKey: Boolean(settings.apiKey),
            hasModel: Boolean(settings.model),
            protocol: settings.protocol || 'openai-chat',
            presetCount: presets.length,
            hasActivePreset: Boolean(presets.find(item => item.id === settings.activePresetId)),
            activePresetPromptCount: presets.find(item => item.id === settings.activePresetId)?.prompts?.length || 0,
            sessionCount: app.store.data.sessions.length,
            blackboxEvents: events.length,
            eventTypes: Object.fromEntries([...new Set(events.map(item => item.type))].map(type => [type, events.filter(item => item.type === type).length])),
            recentRuns: await Promise.all((await app.blackbox.runs()).slice(0, 8).map(async item => ({ id: item.id, eventCount: item.eventCount, startedAt: item.startedAt, types: (await app.blackbox.events(item.id)).map(event => event.type) }))),
        };
    });
    console.log(JSON.stringify({ ...result, pageErrors: errors }, null, 2));
    if (!result.hasConnection || !result.hasApiKey || !result.hasModel || !result.hasActivePreset || errors.length) process.exitCode = 2;
} finally {
    await context.close();
}
