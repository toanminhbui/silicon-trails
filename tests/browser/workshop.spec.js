import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => !!window.siliconTrails?.getGameState);
  await expect(page.locator('#start-screen')).toBeVisible();
}

async function startFree(page) {
  await ready(page);
  await page.getByRole('button', { name: 'Explore freely', exact: true }).click();
  await expect(page.locator('#game-hud')).toBeVisible();
  await page.waitForFunction(() => window.siliconTrails.getGameState().screen === 'playing');
}

async function pause(page) {
  await page.getByRole('button', { name: 'Pause game', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Game paused', exact: true })).toBeVisible();
  await page.waitForFunction(() => window.siliconTrails.getGameState().screen === 'paused');
}

test('the title screen starts a game without exposing workshop panels or global tabs', async ({ page }) => {
  await ready(page);
  await expect(page.locator('#start-screen h1')).toHaveText(/silicon\s*trails/i);
  await expect(page.getByRole('button', { name: 'Start guided journey', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Explore freely', exact: true })).toBeVisible();
  await expect(page.locator('#game-hud')).not.toBeVisible();
  await expect(page.locator('#sidebar')).not.toBeVisible();
  await expect(page.locator('.cm-content')).not.toBeVisible();
  await expect(page.locator('[data-mode="rtl"]')).not.toBeVisible();
  await page.getByRole('button', { name: 'Explore freely', exact: true }).click();
  await expect(page.locator('#start-screen')).not.toBeVisible();
  await expect(page.locator('#game-hud')).toBeVisible();
  await expect(page.locator('#crosshair')).toBeVisible();
  await expect(page.locator('.cm-content')).not.toBeVisible();
});

test('walking moves the player, while pause freezes movement and processor clocks', async ({ page }) => {
  await startFree(page);
  const initial = await page.evaluate(() => window.siliconTrails.getWorld().camera.position.toArray());
  await page.keyboard.down('w');
  try {
    await page.waitForFunction(origin => {
      const point = window.siliconTrails.getWorld().camera.position;
      return Math.hypot(point.x-origin[0],point.y-origin[1],point.z-origin[2]) > 0.2;
    }, initial);
  } finally { await page.keyboard.up('w'); }
  await page.getByRole('button', { name: 'Run processor', exact: true }).click();
  await pause(page);
  await expect(page.locator('#workbench-panel')).toHaveAttribute('data-station', 'rtl');
  await expect(page.locator('#rtl-station .cm-content')).toBeVisible();
  const paused = await page.evaluate(() => ({
    position: window.siliconTrails.getWorld().camera.position.toArray(),
    cycle: window.siliconTrails.getState().cycle,
  }));
  await page.keyboard.down('w');
  await page.waitForTimeout(350);
  await page.keyboard.up('w');
  expect(await page.evaluate(() => window.siliconTrails.getWorld().camera.position.toArray())).toEqual(paused.position);
  expect(await page.evaluate(() => window.siliconTrails.getState().cycle)).toBe(paused.cycle);
  await page.getByRole('button', { name: /^Resume world/ }).click();
  await expect(page.locator('#pause-screen')).not.toBeVisible();
  await expect(page.locator('#game-hud')).toBeVisible();
  await expect(page.locator('.cm-content')).not.toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Game paused', exact: true })).toBeVisible();
});

test('the guided journey advances through real walking, inspection, arithmetic, and saved data', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name:'Start guided journey', exact:true }).click();
  await expect(page.locator('#tutorial-card')).toBeVisible();
  expect(await page.evaluate(() => window.siliconTrails.getGameState().tutorial.id)).toBe('walk');
  await page.keyboard.down('w');
  try {
    await page.waitForFunction(() => window.siliconTrails.getGameState().tutorial.id === 'inspect-accumulator');
  } finally { await page.keyboard.up('w'); }
  await page.locator('#tutorial-card').getByRole('button', { name:'Find accumulator A', exact:true }).click();
  await page.waitForFunction(() => window.siliconTrails.getWorld().lastTarget?.id === 'overview:a');
  await page.keyboard.press('e');
  await expect(page.getByRole('dialog', { name:'Game paused', exact:true })).toBeVisible();
  expect(await page.evaluate(() => window.siliconTrails.getGameState().tutorial.id)).toBe('run-instructions');
  await page.getByRole('button', { name:'Execution trace', exact:true }).click();
  await page.getByRole('button', { name:'Step instruction', exact:true }).click();
  await page.getByRole('button', { name:'Step instruction', exact:true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getState().a)).toBe(12);
  await page.getByRole('button', { name:'Step instruction', exact:true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getLab().ram[0x40])).toBe(12);
  await page.getByRole('button', { name:'Memory bank', exact:true }).click();
  await page.getByRole('button', { name:'Memory address 0x40, value 12', exact:true }).click();
  await page.getByRole('button', { name:'Processor RTL', exact:true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getGameState().tutorial.complete)).toBe(true);
});

test('paused processor tools save data, expose memory provenance, rewind, and run a loop', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await startFree(page);
  await page.getByRole('button', { name: 'Step instruction', exact: true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getState().a)).toBe(7);
  await page.getByRole('button', { name: 'Step instruction', exact: true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getState().a)).toBe(12);
  await pause(page);
  await page.getByRole('button', { name: 'Memory bank', exact: true }).click();
  await page.getByRole('button', { name: 'Step instruction', exact: true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getLab().ram[0x40])).toBe(12);
  await expect(page.getByRole('button', { name: 'Memory address 0x40, value 12', exact: true })).toHaveText('0C');
  await page.getByRole('button', { name: 'Memory address 0x40, value 12', exact: true }).click();
  await expect(page.locator('#panel-content')).toContainText('Saved by STORE');
  await page.getByRole('button', { name: 'Rewind clock', exact: true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getLab().ram[0x40])).toBe(0);
  await page.getByRole('button', { name: 'Step instruction', exact: true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getLab().ram[0x40])).toBe(12);
  const savedCycle = await page.evaluate(() => window.siliconTrails.getState().cycle);
  await page.getByRole('button', { name:'Save & title', exact:true }).click();
  await expect(page.locator('#start-screen')).toBeVisible();
  await ready(page);
  await page.getByRole('button', { name:'Continue world', exact:true }).click();
  await expect(page.locator('#game-hud')).toBeVisible();
  expect(await page.evaluate(() => window.siliconTrails.getLab().ram[0x40])).toBe(12);
  expect(await page.evaluate(() => window.siliconTrails.getState().cycle)).toBe(savedCycle);
  await pause(page);
  await page.getByRole('button', { name: 'Load program', exact: true }).click();
  await page.getByLabel('Example program').selectOption('loop');
  await page.getByRole('button', { name: 'Load and reset', exact: true }).click();
  // Drive the same application instruction action while the world stays paused.
  await page.evaluate(() => {
    for (let i=0;i<120 && !window.siliconTrails.getState().halted;i++) window.siliconTrails.step('instruction');
  });
  expect(await page.evaluate(() => window.siliconTrails.getState().halted)).toBe(true);
  expect(await page.evaluate(() => window.siliconTrails.getState().display)).toBe(55);
  expect(await page.evaluate(() => window.siliconTrails.getGameState().screen)).toBe('paused');
  await page.getByRole('button', { name:'Cache lab', exact:true }).click();
  await expect(page.locator('.cache-table tbody tr')).toHaveCount(4);
  await page.getByLabel('Enable simulated cache').check();
  await expect(page.getByLabel('Enable simulated cache')).toBeChecked();
  expect(await page.evaluate(() => window.siliconTrails.getState().cycle)).toBe(0);
  expect(errors).toEqual([]);
});

test('the paused RTL workbench synthesizes edited Verilog into live circuitry', async ({ page }) => {
  await startFree(page);
  await pause(page);
  await page.getByRole('button', { name: 'Processor RTL', exact: true }).click();
  await page.getByLabel('RTL example').selectOption('fulladder');
  await expect(page.locator('#rtl-io [data-output="sum"]')).toHaveText('0');
  await page.locator('#rtl-io [data-input="cin"]').fill('1');
  await page.locator('#rtl-io [data-input="cin"]').press('Tab');
  await expect(page.locator('#rtl-io [data-output="sum"]')).toHaveText('1');
  await page.locator('#rtl-station .cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText('module top(input [7:0] a,b, output [7:0] y); assign y = a - b; endmodule');
  await page.getByRole('button', { name: 'Synthesize', exact: true }).click();
  await expect(page.locator('#compile-status')).toContainText('Synthesis complete', { timeout:110000 });
  await page.locator('#rtl-io [data-input="a"]').fill('7');
  await page.locator('#rtl-io [data-input="a"]').press('Tab');
  await page.locator('#rtl-io [data-input="b"]').fill('5');
  await page.locator('#rtl-io [data-input="b"]').press('Tab');
  await expect(page.locator('#rtl-io [data-output="y"]')).toHaveText('2');
  expect(await page.evaluate(() => Object.values(window.siliconTrails.getCompiled().netlist.modules.top.cells).some(cell => cell.type === '$sub'))).toBe(true);
  await page.getByRole('button', { name: /^Resume world/ }).click();
  await expect(page.locator('#workbench-panel')).not.toBeVisible();
  await expect(page.locator('.cm-content')).not.toBeVisible();
});

test('the building sandbox edits inputs, wires real ports, and places a component', async ({ page }) => {
  await startFree(page);
  await pause(page);
  await page.getByRole('button', { name:'Build sandbox', exact:true }).click();
  await expect(page.locator('#game-hud')).toBeVisible();
  expect(await page.evaluate(() => window.siliconTrails.getGameState().mode)).toBe('build');
  await pause(page);
  await page.getByRole('button', { name:'Execution trace', exact:true }).click();
  await page.getByRole('button', { name:'Step clock', exact:true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(12);
  await page.getByRole('button', { name: /^Resume world/ }).click();
  // Guidance can bring the player to a component; the real E interaction opens it.
  await page.evaluate(() => window.siliconTrails.getWorld().teleportToNode('inputA'));
  await page.waitForFunction(() => window.siliconTrails.getWorld().lastTarget?.id === 'inputA');
  await page.keyboard.press('e');
  await expect(page.getByRole('dialog', { name:'Game paused', exact:true })).toBeVisible();
  await page.locator('#inspector [data-input="inputA"]').fill('9');
  await page.locator('#inspector [data-input="inputA"]').press('Tab');
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(12);
  await page.getByRole('button', { name:'Execution trace', exact:true }).click();
  await page.getByRole('button', { name:'Step clock', exact:true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(14);
  await page.getByRole('button', { name: /^Resume world/ }).click();
  await page.evaluate(() => window.siliconTrails.getWorld().teleportToNode('inputA'));
  await page.waitForFunction(() => window.siliconTrails.getWorld().lastTarget?.id === 'inputA');
  await page.keyboard.press('e');
  await page.locator('#inspector [data-input="inputA"]').fill('');
  await page.locator('#inspector [data-input="inputA"]').press('Tab');
  await page.getByRole('button', { name:'Execution trace', exact:true }).click();
  await page.getByRole('button', { name:'Step clock', exact:true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBeNull();
  await page.getByRole('button', { name:'Processor RTL', exact:true }).click();
  await page.locator('#rtl-io [data-input="inputA"]').fill('7');
  await page.locator('#rtl-io [data-input="inputA"]').press('Tab');
  await page.getByRole('button', { name:/^Resume world/ }).click();
  await page.locator('#hotbar [data-tool="wire"]').click();
  for (const id of ['inputA','output1']) {
    await page.evaluate(id => window.siliconTrails.getWorld().teleportToNode(id), id);
    await page.waitForFunction(id => window.siliconTrails.getWorld().lastTarget?.id === id, id);
    await page.keyboard.press('e');
  }
  expect(await page.evaluate(() => window.siliconTrails.getBuilder().edges.find(edge => edge.to === 'output1').from)).toBe('inputA');
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(7);
  const before = await page.evaluate(() => [...window.siliconTrails.getBuilder().nodes.values()].filter(node => node.type === 'not').length);
  await page.locator('#hotbar [data-tool="not"]').click();
  await page.evaluate(() => {
    const world = window.siliconTrails.getWorld();
    world.startWalk({reset:true});
    world.camera.lookAt(4,0,19);
    world.camera.updateMatrixWorld(true);
  });
  await page.keyboard.press('e');
  expect(await page.evaluate(() => [...window.siliconTrails.getBuilder().nodes.values()].filter(node => node.type === 'not').length)).toBe(before+1);
});

test('the title screen, game HUD, and pause menu remain usable at mobile sizes', async ({ page }) => {
  await page.setViewportSize({ width:390, height:844 });
  await startFree(page);
  await expect(page.getByRole('button', { name:'Pause game', exact:true })).toBeVisible();
  await expect(page.getByRole('button', { name:'Step instruction', exact:true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name:'Step instruction', exact:true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getState().a)).toBe(7);
  await pause(page);
  await expect(page.locator('#workbench-panel')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole('button', { name:/^Resume world/ }).click();
  await expect(page.locator('#game-hud')).toBeVisible();
});
