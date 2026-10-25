import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/', {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => !!window.siliconTrails);
}

test('the real processor saves data, exposes memory, rewinds, and completes a loop', async ({page}) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await ready(page);
  await expect(page.getByRole('heading',{name:'Small parts. A working computer.'})).toBeVisible();
  await page.getByRole('button',{name:'Instruction',exact:true}).click();
  expect(await page.evaluate(()=>window.siliconTrails.getState().a)).toBe(7);
  await page.getByRole('button',{name:'Instruction',exact:true}).click();
  expect(await page.evaluate(()=>window.siliconTrails.getState().a)).toBe(12);
  await page.getByRole('button',{name:'Instruction',exact:true}).click();
  expect(await page.evaluate(()=>window.siliconTrails.getLab().ram[0x40])).toBe(12);
  await page.getByRole('button',{name:'MEMORY',exact:true}).click();
  await expect(page.getByRole('button',{name:'Memory address 0x40, value 12',exact:true})).toHaveText('0C');
  await page.getByRole('button',{name:'Rewind one clock',exact:true}).click();
  expect(await page.evaluate(()=>window.siliconTrails.getLab().ram[0x40])).toBe(0);
  await page.getByRole('button',{name:'Instruction',exact:true}).click();
  expect(await page.evaluate(()=>window.siliconTrails.getLab().ram[0x40])).toBe(12);
  await page.getByRole('button',{name:'Load program',exact:true}).click();
  await page.getByLabel('Example program').selectOption('loop');
  await page.getByRole('button',{name:'Load and reset',exact:true}).click();
  await page.getByLabel('Clock speed').selectOption('600');
  await page.getByRole('button',{name:'Run',exact:true}).click();
  await page.waitForFunction(()=>window.siliconTrails.getState().halted);
  expect(await page.evaluate(()=>window.siliconTrails.getState().display)).toBe(55);
  expect(errors).toEqual([]);
});

test('block inputs determine register output and projects restore correctly', async ({page}) => {
  await ready(page);
  await page.getByRole('button',{name:'Build',exact:true}).click();
  await page.getByRole('button',{name:'Clock',exact:true}).click();
  await expect(page.locator('[data-output="output1"]')).toHaveText('12');
  await page.locator('[data-input="inputA"]').last().fill('9');
  await page.locator('[data-input="inputA"]').last().press('Tab');
  await expect(page.locator('[data-output="output1"]')).toHaveText('12');
  await page.getByRole('button',{name:'Clock',exact:true}).click();
  await expect(page.locator('[data-output="output1"]')).toHaveText('14');
  // Empty input is unknown, not silently zero; a register captures it on an edge.
  await page.locator('[data-input="inputA"]').last().fill('');
  await page.locator('[data-input="inputA"]').last().press('Tab');
  await page.getByRole('button',{name:'Clock',exact:true}).click();
  await expect(page.locator('[data-output="output1"]')).toHaveText('X');
  const project=await page.evaluate(()=>window.siliconTrails.exportProject());
  await page.evaluate(data=>window.siliconTrails.restoreProject(data),project);
  await expect(page.getByRole('heading',{name:'Make something that computes.'})).toBeVisible();
  expect(await page.evaluate(()=>window.siliconTrails.getSimulator().getPort('inputA'))).toBeNull();
});

test('edited Verilog is synthesized locally and its changed output is live in the world', async ({page}) => {
  await ready(page);
  await page.getByRole('button',{name:'RTL studio',exact:true}).click();
  await page.getByLabel('RTL example').selectOption('fulladder');
  await expect(page.locator('[data-output="sum"]')).toHaveText('0');
  await page.locator('[data-input="cin"]').last().fill('1');
  await page.locator('[data-input="cin"]').last().press('Tab');
  await expect(page.locator('[data-output="sum"]')).toHaveText('1');
  const source='module top(input [7:0] a,b, output [7:0] y); assign y = a - b; endmodule';
  await page.locator('.cm-content').click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(source);
  await page.getByRole('button',{name:'Synthesize',exact:true}).click();
  await expect(page.locator('#compile-status')).toContainText('Synthesis complete',{timeout:110000});
  await page.locator('[data-input="a"]').last().fill('7');
  await page.locator('[data-input="a"]').last().press('Tab');
  await page.locator('[data-input="b"]').last().fill('5');
  await page.locator('[data-input="b"]').last().press('Tab');
  await expect(page.locator('[data-output="y"]')).toHaveText('2');
  expect(await page.evaluate(()=>Object.values(window.siliconTrails.getCompiled().netlist.modules.top.cells).some(c=>c.type==='$sub'))).toBe(true);
});

test('the workshop remains usable at mobile sizes', async ({page}) => {
  await page.setViewportSize({width:390,height:844});
  await ready(page);
  await expect(page.getByRole('button',{name:'Run',exact:true})).toBeVisible();
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await page.getByRole('button',{name:'Instruction',exact:true}).click();
  expect(await page.evaluate(()=>window.siliconTrails.getState().a)).toBe(7);
});

test('the 3D wire tool changes real connections and the palette places components', async ({page}) => {
  await ready(page);
  await page.getByRole('button',{name:'Build',exact:true}).click();
  await page.getByTitle('Connect output to input').click();
  async function socket(nodeId,port,direction) {
    return page.evaluate(({nodeId,port,direction})=>{
      const world=window.siliconTrails.getWorld();
      const point=world.portPosition(world.nodes.get(nodeId),port,direction).project(world.camera);
      const r=world.canvas.getBoundingClientRect();
      return {x:r.left+(point.x+1)*r.width/2,y:r.top+(1-point.y)*r.height/2};
    },{nodeId,port,direction});
  }
  let point=await socket('inputA','Y','output');await page.mouse.click(point.x,point.y);
  point=await socket('output1','A','input');await page.mouse.click(point.x,point.y);
  await expect(page.locator('[data-output="output1"]')).toHaveText('7');
  expect(await page.evaluate(()=>window.siliconTrails.getBuilder().edges.find(e=>e.to==='output1').from)).toBe('inputA');
  await page.getByTitle('Place NOT').click();
  const place=await page.evaluate(()=>{
    const w=window.siliconTrails.getWorld();const v=w.camera.position.clone().set(0,0,-9).project(w.camera);const r=w.canvas.getBoundingClientRect();
    return {x:r.left+(v.x+1)*r.width/2,y:r.top+(1-v.y)*r.height/2};
  });
  await page.mouse.click(place.x,place.y);
  expect(await page.evaluate(()=>[...window.siliconTrails.getBuilder().nodes.values()].some(n=>n.type==='not'))).toBe(true);
});
