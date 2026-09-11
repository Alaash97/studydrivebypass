import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import puppeteer, { type Browser } from 'puppeteer';
import { loginToStudyDrive } from './studydrive-login';

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
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    });
    const page = await browser.newPage();

    await loginToStudyDrive(
      page,
      process.env.STUDYDRIVE_EMAIL!,
      process.env.STUDYDRIVE_PASSWORD!,
    );

    expect(new URL(page.url()).pathname).not.toMatch(/\/login\/?$/);
  }, 60_000);
});
