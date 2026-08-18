import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', headless: true, args: ['--no-proxy-server'] });
try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' });
    await page.getByText('世界总览', { exact: true }).last().waitFor();
    await page.waitForFunction(() => document.querySelector('#runtimeBadge')?.classList.contains('ready'));

    async function goTo(panel) {
        const bottomButton = page.locator(`.mobile-bottom-nav [data-panel="${panel}"]`);
        const railOpen = await page.locator('#rail').evaluate(node => node.classList.contains('open'));
        const canUseBottom = await bottomButton.count() && await bottomButton.evaluate(node => {
            const rect = node.getBoundingClientRect();
            return getComputedStyle(node).display !== 'none' && rect.bottom > 0 && rect.top < innerHeight;
        });
        if (railOpen) {
            await page.locator(`#rail .nav-item[data-panel="${panel}"]`).click();
        } else if (canUseBottom) {
            await bottomButton.click();
        } else {
            await page.locator('.mobile-menu').click();
            await page.locator('#rail.open').waitFor();
            await page.locator(`#rail .nav-item[data-panel="${panel}"]`).click();
        }
        await page.locator(`#view-${panel}`).waitFor({ state: 'visible' });
    }

    await page.getByRole('button', { name: /继续冒险/ }).click();
    await page.getByText('REINCARNATION PROTOCOL · 3.2.6').waitFor();
    await page.locator('[data-cover-agree]').check();
    await page.getByRole('button', { name: '接入主神终端' }).click();
    await page.getByRole('button', { name: '开始建档' }).click();
    await page.locator('#setupForm [name="name"]').fill('测试轮回者');
    await page.locator('[data-attribute="力量"][data-delta="1"]').click();
    await page.locator('[data-attribute="敏捷"][data-delta="1"]').click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '下一步' }).click();
    await page.getByRole('button', { name: '注入 MVU 并开始' }).click();
    await page.getByPlaceholder('你准备做什么？').waitFor();

    await page.evaluate(() => {
        const app = window.__reincarnationApp;
        app.store.addMessage('assistant', '第二层剧情测试');
        app.store.activeSession.variables.stat_data.关系列表 = {
            甲: { 好感度: 12, 好感度关系: { 乙: -3 } },
            乙: { 好感度关系: {} },
        };
        app.store.save(); app.renderAll();
    });
    await goTo('chat');
    await page.getByText('建立轮回者档案', { exact: true }).waitFor();
    const openingFloorLabel = await page.locator('.story-floor-heading b').textContent();
    await page.locator('[data-action="toggle-story-tools"]').click();
    await page.locator('[data-action="floor-next"]').click();
    await page.locator('#messages').getByText('第二层剧情测试', { exact: true }).waitFor();
    await page.locator('[data-action="floor-prev"]').click();
    await page.getByText('建立轮回者档案', { exact: true }).waitFor();
    await page.locator('[data-action="floor-next"]').click();

    await goTo('status');
    await page.locator('#statusContent').getByText('HP', { exact: true }).waitFor();
    await goTo('inventory');
    await page.getByText('装备与道具', { exact: true }).last().waitFor();
    await goTo('world');
    await page.getByText('世界档案', { exact: true }).last().waitFor();
    await goTo('relations');
    await page.getByText('互相好感度', { exact: true }).waitFor();
    await goTo('user-settings');
    await page.locator('[data-action="new-user-profile"]').click();
    await page.locator('#userProfileForm [name="name"]').fill('用户B');
    await page.locator('#userProfileForm [name="displayName"]').fill('测试用户B');
    await page.locator('#userProfileForm [name="persona"]').fill('这是用户B的长期设定。');
    await page.locator('#userProfileForm').getByRole('button', { name: '保存设定' }).click();
    await page.locator('[data-action="activate-user-profile"]').click();
    await page.locator('[data-action="new-user-profile"]').click();
    await page.locator('#userProfileForm [name="name"]').fill('临时用户C');
    await page.locator('#userProfileForm').getByRole('button', { name: '保存设定' }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('[data-action="delete-user-profile"]').click();
    await goTo('settings');
    await page.locator('[data-settings-tab="connections"]').click();
    const settingsChrome = await page.evaluate(() => ({
        tabHeight: document.querySelector('.settings-tabs').getBoundingClientRect().height,
        firstTabHeight: document.querySelector('.settings-tabs button').getBoundingClientRect().height,
        runtimeVisible: getComputedStyle(document.querySelector('#runtimeBadge')).display !== 'none',
    }));
    const connectionCountBefore = await page.locator('#connectionList [data-connection-id]').count();
    await page.locator('[data-action="new-connection"]').click();
    const newConnectionId = await page.locator('#connectionForm [name="id"]').inputValue();
    const connectionCountAfterCreate = await page.locator('#connectionList [data-connection-id]').count();
    await page.locator('#connectionForm [name="name"]').fill('');
    await page.locator('#connectionForm [name="baseUrl"]').fill('');
    await page.locator('#connectionForm [name="model"]').fill('');
    await page.locator('#connectionForm').getByRole('button', { name: '保存连接' }).click();
    const connectionCountAfterSave = await page.locator('#connectionList [data-connection-id]').count();
    await page.locator('[data-action="test-connection"]').click();
    const testValidation = await page.locator('#connectionTestResult').textContent();
    await page.locator('[data-settings-tab="model-routing"]').click();
    await page.locator('#modelRoutingForm').waitFor({ state: 'visible' });
    const routingConnectionId = await page.locator('#modelRoutingForm select[name="storyConnectionId"] option').nth(1).getAttribute('value');
    await page.locator('#modelRoutingForm select[name="storyConnectionId"]').selectOption(routingConnectionId);
    await page.locator('#modelRoutingForm select[name="combatConnectionId"]').selectOption(routingConnectionId);
    await page.locator('#modelRoutingForm select[name="shopConnectionId"]').selectOption(routingConnectionId);
    await page.locator('#modelRoutingForm').getByRole('button', { name: '保存大模型配置' }).click();
    for (const panel of ['hub', 'chat', 'missions', 'status', 'inventory', 'abilities', 'world', 'relations', 'intel', 'archive', 'user-settings', 'settings']) {
        await goTo(panel);
    }

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-action="toggle-rail"]').last().click();
    await page.locator('#rail.open').waitFor();
    await goTo('hub');

    const result = await page.evaluate(({ connectionCountBefore, connectionCountAfterCreate, connectionCountAfterSave, newConnectionId, testValidation, settingsChrome, openingFloorLabel }) => {
        const data = JSON.parse(localStorage.getItem('reincarnation-web:v1'));
        const session = data.sessions.find(item => item.id === data.activeSessionId);
        return {
            player: data.settings.userName,
            activeUserProfileId: data.settings.activeUserProfileId,
            userProfileCount: window.__reincarnationApp.userProfiles().length,
            userProfile: window.__reincarnationApp.userProfiles().find(item => item.id === data.settings.activeUserProfileId),
            aiAssignments: data.settings.aiAssignments,
            connectionCountBefore,
            connectionCountAfterCreate,
            connectionCountAfterSave,
            newConnectionSaved: Boolean(newConnectionId && data.connections.some(item => item.id === newConnectionId)),
            testValidation,
            strength: session.variables.stat_data['主角']['最终属性']['力量'],
            world: session.variables.stat_data['世界']['名称'],
            hasIframe: Boolean(document.querySelector('iframe')),
            views: document.querySelectorAll('.view').length,
            promptReady: document.querySelector('#messageInput').value.includes('轮回者建档完成'),
            floors: document.querySelector('#tokenBadge').textContent,
            openingFloor: openingFloorLabel,
            navCategories: document.querySelectorAll('.nav-category').length,
            affectionNpcToPlayer: window.__reincarnationApp.getAffection('甲', '主角'),
            affectionNpcToNpc: window.__reincarnationApp.getAffection('甲', '乙'),
            affectionMissing: window.__reincarnationApp.getAffection('乙', '甲'),
            settingsChrome,
        };
    }, { connectionCountBefore, connectionCountAfterCreate, connectionCountAfterSave, newConnectionId, testValidation, settingsChrome, openingFloorLabel });
    console.log({ ...result, pageErrors: errors });
    if (result.player !== '测试用户B' || result.userProfileCount < 2 || !result.activeUserProfileId || result.userProfile?.persona !== '这是用户B的长期设定。' || !result.aiAssignments?.storyConnectionId || result.aiAssignments.storyConnectionId !== result.aiAssignments.combatConnectionId || result.aiAssignments.combatConnectionId !== result.aiAssignments.shopConnectionId || result.connectionCountAfterCreate !== result.connectionCountBefore + 1 || result.connectionCountAfterSave !== result.connectionCountAfterCreate || !result.newConnectionSaved || !result.testValidation?.includes('测试前请填写') || result.strength < 1 || result.world !== '主神空间' || result.hasIframe || result.views < 11 || !result.promptReady || result.openingFloor !== '第 0 楼' || !result.floors.includes('1 / 2 楼') || result.navCategories !== 2 || result.affectionNpcToPlayer !== 12 || result.affectionNpcToNpc !== -3 || result.affectionMissing !== 0 || result.settingsChrome.tabHeight < 44 || result.settingsChrome.firstTabHeight < 44 || result.settingsChrome.runtimeVisible || errors.length) process.exitCode = 1;
} finally {
    await browser.close();
}
