import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await page.waitForFunction(() => !!window.siliconTrails?.getGameState);
  await expect(page.locator('#start-screen')).toBeVisible();
}

async function openStation(page, name) {
  if (await page.evaluate(() => window.siliconTrails.getGameState().screen) === 'playing') {
    await page.getByRole('button', { name:'Pause game', exact:true }).click();
  }
  await page.getByRole('button', { name, exact:true }).click();
}

async function clock(page) {
  await openStation(page, 'Execution trace');
  await page.getByRole('button', { name:'Step clock', exact:true }).click();
}

async function packageSelection(page, name, ids, portNames) {
  await openStation(page, 'Component library');
  await page.getByRole('button', { name:'Create reusable module', exact:true }).click();
  const dialog = page.getByRole('dialog', { name:'Create reusable module', exact:true });
  await dialog.getByLabel('Module name', { exact:true }).fill(name);
  for (const id of ids) await dialog.locator(`[data-module-node="${id}"]`).check();
  for (const [from,to] of Object.entries(portNames)) await dialog.locator(`[data-module-port="${from}"]`).fill(to);
  await dialog.getByRole('button', { name:'Package selection', exact:true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('button', { name:`Choose ${name}`, exact:true })).toBeVisible();
  return page.evaluate(name => {
    const builder = window.siliconTrails.getBuilder();
    const definition = builder.listModules().find(module => module.name === name);
    const instance = [...builder.nodes.values()].find(node => node.type === 'module' && node.moduleId === definition.id);
    return {definition,instance};
  }, name);
}

async function placeAt(page, point) {
  await page.evaluate(point => {
    const world = window.siliconTrails.getWorld();
    world.startWalk({reset:true});
    world.camera.lookAt(...point);
    world.camera.updateMatrixWorld(true);
  }, point);
  await page.keyboard.press('e');
}

async function instanceResult(page, path) {
  return page.evaluate(path => {
    const api = window.siliconTrails;
    const output = api.getBuilder().getInstancePorts(path).find(port => port.name === 'result');
    return api.getSimulator().getBits(output.bits);
  }, path);
}

async function inspect(page, id) {
  await openStation(page, 'Component navigator');
  await page.locator(`[data-select-node="${id}"]`).click();
  await expect(page.locator('#inspector')).toBeVisible();
}

test('reusable modules package selections, keep independent state, nest, and expose live saved internals', async ({ page }) => {
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await ready(page);
  await page.getByRole('button', { name:'Explore freely', exact:true }).click();
  await openStation(page, 'Build sandbox');
  await clock(page);
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(12);

  const registered = await packageSelection(page, 'Registered adder', ['add1','register1'], {
    add1_A:'left',add1_B:'right',register1_EN:'enable',register1_Q:'result',
  });
  expect(Object.fromEntries(registered.definition.ports.map(port => [port.name,[port.direction,port.width]]))).toEqual({
    left:['input',8],right:['input',8],enable:['input',1],result:['output',8],
  });
  const rootIds = await page.evaluate(() => [...window.siliconTrails.getBuilder().nodes.keys()]);
  expect(rootIds).not.toContain('add1');
  expect(rootIds).not.toContain('register1');
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().cycle)).toBe(0);
  await clock(page);
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(12);
  await openStation(page, 'Component library');
  await page.getByRole('button', { name:'Choose Registered adder', exact:true }).click();
  await expect(page.locator('#held-item')).toContainText('Registered adder');
  await placeAt(page, [11,0,19]);
  const second = await page.evaluate(first => [...window.siliconTrails.getBuilder().nodes.values()].find(node => node.type === 'module' && node.id !== first), registered.instance.id);
  expect(second.moduleId).toBe(registered.definition.id);
  expect(await instanceResult(page, [second.id])).toBeNull();

  // Independent circuit setup; packaging, placement, inspection, and clocks use
  // the real controls. The existing core tests cover interactive port semantics.
  await page.evaluate(id => {
    const api = window.siliconTrails, builder = api.getBuilder();
    builder.connect({from:'inputA',fromPort:'Y',to:id,toPort:'left'});
    builder.connect({from:'inputA',fromPort:'Y',to:id,toPort:'right'});
    builder.connect({from:'inputEnable',fromPort:'Y',to:id,toPort:'enable'});
    api.setMode('build');
  }, second.id);
  await clock(page);
  expect(await instanceResult(page, [registered.instance.id])).toBe(12);
  expect(await instanceResult(page, [second.id])).toBe(14);

  await page.getByRole('button', { name:/^Resume world/ }).click();
  await page.locator('#hotbar [data-tool="not"]').click();
  await placeAt(page, [-4,0,19]);
  const inverter = await page.evaluate(() => [...window.siliconTrails.getBuilder().nodes.values()].find(node => node.type === 'not'));
  await page.evaluate(({first,inverter}) => {
    const api = window.siliconTrails, builder = api.getBuilder();
    builder.connect({from:first,fromPort:'result',to:inverter,toPort:'A'});
    builder.connect({from:inverter,fromPort:'Y',to:'output1',toPort:'A'});
    api.setMode('build');
  }, {first:registered.instance.id,inverter:inverter.id});
  const nestedPorts = await page.evaluate(ids => window.siliconTrails.getBuilder().previewModule(ids).ports, [registered.instance.id,inverter.id]);
  const renames = {};
  for (const name of ['left','right','enable']) {
    const input = nestedPorts.find(port => port.direction === 'input' && port.name.endsWith(`_${name}`));
    expect(input, `inferred nested ${name} input`).toBeTruthy();
    renames[input.name] = name;
  }
  renames[nestedPorts.find(port => port.direction === 'output').name] = 'result';
  const nested = await packageSelection(page, 'Complemented adder', [registered.instance.id,inverter.id], renames);
  await clock(page);
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(243);
  await page.locator('#panel-content [data-input="inputA"]').fill('10');
  await page.locator('#panel-content [data-input="inputA"]').press('Tab');
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(243);
  expect(await instanceResult(page, [second.id])).toBe(14);
  const beforeOpen = await page.evaluate(() => {
    window.__moduleSimulator = window.siliconTrails.getSimulator();
    return window.__moduleSimulator.snapshot();
  });

  await inspect(page, nested.instance.id);
  await page.getByRole('button', { name:'Open module', exact:true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getGameState().builderPath)).toEqual([nested.instance.id]);
  await expect(page.locator('#module-breadcrumb')).toBeVisible();
  await expect(page.locator('#module-breadcrumb')).toContainText('LIVE INTERNALS');
  expect(await page.evaluate(() => window.siliconTrails.getSimulator() === window.__moduleSimulator)).toBe(true);
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().snapshot())).toEqual(beforeOpen);
  const child = await page.evaluate(id => window.siliconTrails.getGraph().nodes.find(node => node.type === 'module' && node.localId === id), registered.instance.id);
  await inspect(page, child.id);
  await expect(page.locator('#inspector [data-module-signal="result"] strong')).toHaveText('12');
  await page.getByRole('button', { name:'Open module', exact:true }).click();
  expect(await page.evaluate(() => window.siliconTrails.getGameState().builderPath)).toEqual([nested.instance.id,registered.instance.id]);
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().snapshot())).toEqual(beforeOpen);
  const register = await page.evaluate(() => window.siliconTrails.getGraph().nodes.find(node => node.localId === 'register1'));
  await inspect(page, register.id);
  await expect(page.locator('#inspector .big-value strong')).toHaveText('12');
  await expect(page.locator('#inspector button[data-action="delete"]')).not.toBeVisible();
  await expect(page.locator('#inspector button[data-action="disconnect"]')).not.toBeVisible();
  await page.getByRole('button', { name:'Step module clock', exact:true }).click();
  await expect(page.locator('#inspector .big-value strong')).toHaveText('15');
  expect(await instanceResult(page, [nested.instance.id,registered.instance.id])).toBe(15);
  expect(await instanceResult(page, [second.id])).toBe(20);
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(240);
  await page.locator('#inspector button[data-action="rewind"]').click();
  await expect(page.locator('#inspector .big-value strong')).toHaveText('12');
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().getPort('output1'))).toBe(243);
  await page.getByRole('button', { name:'Step module clock', exact:true }).click();
  await expect(page.locator('#inspector .big-value strong')).toHaveText('15');
  const saved = await page.evaluate(() => window.siliconTrails.getSimulator().snapshot());
  await page.getByRole('button', { name:/^Resume world/ }).click();
  await page.locator('#module-breadcrumb [data-builder-level="0"]').click();
  expect(await page.evaluate(() => window.siliconTrails.getGameState().builderPath)).toEqual([]);
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().snapshot())).toEqual(saved);
  await openStation(page, 'Component library');
  await expect(page.getByRole('button', { name:'Choose Registered adder', exact:true })).toBeVisible();
  await expect(page.getByRole('button', { name:'Choose Complemented adder', exact:true })).toBeVisible();
  await page.getByRole('button', { name:'Save & title', exact:true }).click();
  await ready(page);
  await page.getByRole('button', { name:'Continue world', exact:true }).click();
  await expect(page.locator('#game-hud')).toBeVisible();
  expect(await page.evaluate(() => window.siliconTrails.getSimulator().snapshot())).toEqual(saved);
  expect(await instanceResult(page, [nested.instance.id,registered.instance.id])).toBe(15);
  expect(await instanceResult(page, [second.id])).toBe(20);
  expect(await page.evaluate(() => window.siliconTrails.getBuilder().listModules().map(module => module.name).sort())).toEqual(['Complemented adder','Registered adder']);
  expect(errors).toEqual([]);
});
