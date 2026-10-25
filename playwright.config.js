import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 120000,
  fullyParallel: false,
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5173', viewport: process.env.SILICON_LOW_MEMORY_BROWSER ? {width:1280,height:900} : {width:1440,height:1000},
    launchOptions: { args: [...(process.env.SILICON_LOW_MEMORY_BROWSER ? ['--single-process','--no-zygote','--in-process-gpu'] : []),'--no-sandbox','--disable-dev-shm-usage','--num-raster-threads=1','--enable-unsafe-swiftshader','--js-flags=--wasm-num-compilation-tasks=1 --liftoff-only'] },
  },
  webServer: { command: 'node scripts/serve.mjs', url: 'http://127.0.0.1:5173', reuseExistingServer: !process.env.CI, timeout: 120000 },
});
