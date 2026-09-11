import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import {
  loginToStudyDriveViaHttp,
  STUDYDRIVE_NETWORK_ARGS,
} from './studydrive-login';

const runLiveTest = process.env.RUN_STUDYDRIVE_INTEGRATION === '1';

describe.skipIf(!runLiveTest)('StudyDrive login integration', () => {
  let browser: Browser;

  beforeAll(() => {
    process.loadEnvFile('.env.local');
  });

  afterAll(async () => {
    await browser?.close();
  });

  it('logs in with credentials from .env.local', async () => {
    expect(process.env.STUDYDRIVE_EMAIL).toBeTruthy();
    expect(process.env.STUDYDRIVE_PASSWORD).toBeTruthy();

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', ...STUDYDRIVE_NETWORK_ARGS],
    });
    const page = await browser.newPage();

    await loginToStudyDriveViaHttp(
      page,
      process.env.STUDYDRIVE_EMAIL!,
      process.env.STUDYDRIVE_PASSWORD!,
    );

    await page.goto('https://www.studydrive.net/en/dashboard', {
      waitUntil: 'domcontentloaded',
      timeout: 20_000,
    });

    expect(new URL(page.url()).pathname).not.toMatch(/\/login\/?$/);
  }, 60_000);
});
