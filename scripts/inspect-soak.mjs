import { chromium } from 'playwright-core';

const context = await chromium.launchPersistentContext('C:\\SillyTavern\\reincarnation-web\\.test\\profile-copy-20260813', {
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true,
    args: ['--no-proxy-server'], viewport: { width: 1200, height: 800 },
});
try {
    const page = context.pages()[0] || await context.newPage();
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.waitForFunction(() => window.__reincarnationApp?.runtime);
    const report = await page.evaluate(async () => {
        const app = window.__reincarnationApp;
        const session = app.store.data.sessions.find(item => item.id === '6564a1e4-25e7-4ddd-ad36-4cec0d31f69c');
        const assistants = session.messages.filter(item => item.role === 'assistant').slice(1);
        const key = app.store.data.settings.apiKey;
        const allRuns = await app.blackbox.runs();
        const allEvents = (await Promise.all(allRuns.map(run => app.blackbox.events(run.id)))).flat();
        return {
            title: session.title,
            messages: session.messages.length,
            variableSnapshots: session.variableSnapshots.length,
            assistant: assistants.map((item, index) => ({
                turn: index + 1,
                length: item.content.length,
                updateBlocks: (item.content.match(/<UpdateVariable>/gi) || []).length,
                checkBlocks: (item.content.match(/<CheckResult>/gi) || []).length,
                optionBlocks: (item.content.match(/<options>|<mission>/gi) || []).length,
                hasTruncationHint: /截断|未完待续|finish_reason.{0,20}length/i.test(item.content),
                ending: item.content.slice(-180).replace(/\s+/g, ' '),
            })),
            secretLeak: Boolean(key) && allEvents.some(event => JSON.stringify(event).includes(key)),
            blackboxRuns: allRuns.length,
            failedEvents: allEvents.filter(event => /failed|error|unhandled/i.test(event.type)).map(event => event.type),
        };
    });
    console.log(JSON.stringify(report, null, 2));
} finally { await context.close(); }
