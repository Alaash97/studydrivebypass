import type { CookieData, Page } from 'puppeteer-core';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';

export const STUDYDRIVE_LOGIN_URL = 'https://www.studydrive.net/en/login';
export const STUDYDRIVE_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';

// Some serverless egress/CDN combinations reset StudyDrive's HTTP/2 stream.
// Chromium then displays chrome-error://chromewebdata before the DOM exists.
export const STUDYDRIVE_NETWORK_ARGS = ['--disable-http2', '--disable-quic'] as const;

export const LOGIN_SELECTORS = {
  email: [
    'input[autocomplete="username"]',
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="email" i]',
  ].join(', '),
  password: [
    'input[autocomplete="current-password"]',
    'input[type="password"]',
    'input[name="password"]',
  ].join(', '),
  submit: 'button[type="submit"], input[type="submit"]',
};

// Keep failed attempts comfortably inside Netlify's 60-second hard limit.
const LOGIN_TIMEOUT_MS = 15_000;

export function isLoginUrl(url: string): boolean {
  try {
    return new URL(url).pathname.replace(/\/$/, '').endsWith('/login');
  } catch {
    return true;
  }
}

function getSetCookieHeaders(headers: Headers): string[] {
  const cookieHeaders = headers as Headers & { getSetCookie?: () => string[] };
  return cookieHeaders.getSetCookie?.() ?? (headers.get('set-cookie') ? [headers.get('set-cookie')!] : []);
}

type HttpResult = {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
};

function requestHttps(
  url: string,
  options: RequestOptions,
  body?: string,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, { ...options, family: 4 }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }));
      response.on('error', reject);
    });

    request.setTimeout(10_000, () => request.destroy(new Error('StudyDrive HTTPS request timed out.')));
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

function mergeNodeCookies(cookieJar: Map<string, string>, headers: IncomingHttpHeaders): void {
  for (const setCookie of headers['set-cookie'] ?? []) {
    const pair = setCookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

export function mergeSetCookies(cookieJar: Map<string, string>, headers: Headers): void {
  for (const setCookie of getSetCookieHeaders(headers)) {
    const pair = setCookie.split(';', 1)[0];
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    cookieJar.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
}

export async function loginToStudyDriveViaHttp(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await page.setCookie(...await createStudyDriveSession(email, password));
}

export async function createStudyDriveSession(
  email: string,
  password: string,
): Promise<CookieData[]> {
  const cookieJar = new Map<string, string>();
  const requestHeaders = {
    accept: 'application/json, text/plain, */*',
    'content-type': 'application/json',
    origin: 'https://www.studydrive.net',
    referer: STUDYDRIVE_LOGIN_URL,
    'user-agent': STUDYDRIVE_USER_AGENT,
    'x-requested-with': 'XMLHttpRequest',
  };

  const bootstrapStarted = Date.now();
  const initialResponse = await requestHttps('https://www.studydrive.net/login', {
    method: 'POST',
    headers: requestHeaders,
  }, '{}');

  mergeNodeCookies(cookieJar, initialResponse.headers);
  console.log(
    `[StudyDrive HTTP login] Bootstrap HTTP ${initialResponse.status} after ${Date.now() - bootstrapStarted}ms`,
  );
  if (cookieJar.size === 0) {
    throw new Error(`StudyDrive login bootstrap returned no session cookies (HTTP ${initialResponse.status}).`);
  }

  const loginStarted = Date.now();
  const loginResponse = await requestHttps('https://www.studydrive.net/login', {
    method: 'POST',
    headers: {
      ...requestHeaders,
      cookie: Array.from(cookieJar, ([name, value]) => `${name}=${value}`).join('; '),
    },
  }, JSON.stringify({ email, password, remember: true }));

  mergeNodeCookies(cookieJar, loginResponse.headers);
  let result: { success?: boolean } | null = null;
  try {
    result = JSON.parse(loginResponse.body.toString('utf8')) as { success?: boolean };
  } catch {
    // The status check below provides a safe error without exposing response data.
  }
  console.log(
    `[StudyDrive HTTP login] Credentials HTTP ${loginResponse.status} after ${Date.now() - loginStarted}ms`,
  );
  if (loginResponse.status < 200 || loginResponse.status >= 300 || !result?.success) {
    throw new Error(`StudyDrive login request returned HTTP ${loginResponse.status}.`);
  }

  return Array.from(cookieJar, ([name, value]) => ({
    name,
    value,
    domain: '.studydrive.net',
    path: '/',
    secure: true,
  }));
}

async function getPageSummary(page: Page): Promise<string> {
  const summary = await page.evaluate(() => ({
    title: document.title,
    text: document.body?.innerText.replace(/\s+/g, ' ').trim().slice(0, 180) ?? '',
  }));

  return `URL: ${page.url()}; title: ${summary.title || '(none)'}; page: ${summary.text || '(empty)'}`;
}

async function openLoginForm(page: Page): Promise<void> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptStarted = Date.now();
    console.log(`[StudyDrive login] Opening form (attempt ${attempt}/2)`);
    try {
      await Promise.all([
        page.goto(STUDYDRIVE_LOGIN_URL, {
          waitUntil: 'domcontentloaded',
          timeout: LOGIN_TIMEOUT_MS,
        }),
        page.waitForSelector(LOGIN_SELECTORS.email, {
          visible: true,
          timeout: LOGIN_TIMEOUT_MS,
        }),
      ]);
      console.log(`[StudyDrive login] Form ready after ${Date.now() - attemptStarted}ms`);
      return;
    } catch (error) {
      lastError = error;
      const summary = await getPageSummary(page).catch(() => `URL: ${page.url()}`);
      const reason = error instanceof Error ? error.message : 'Unknown navigation error';
      console.warn(
        `[StudyDrive login] Attempt ${attempt}/2 failed after ${Date.now() - attemptStarted}ms: ${reason}. ${summary}`,
      );
    }
  }

  const summary = await getPageSummary(page).catch(() => `URL: ${page.url()}`);
  const reason = lastError instanceof Error ? lastError.message : 'Login form did not appear';
  throw new Error(`${reason}. ${summary}`);
}

export async function loginToStudyDrive(
  page: Page,
  email: string,
  password: string,
): Promise<void> {
  await openLoginForm(page);

  const emailInput = await page.waitForSelector(LOGIN_SELECTORS.email, { visible: true });
  const passwordInput = await page.waitForSelector(LOGIN_SELECTORS.password, {
    visible: true,
    timeout: LOGIN_TIMEOUT_MS,
  });

  if (!emailInput || !passwordInput) {
    throw new Error('StudyDrive login fields disappeared before they could be filled.');
  }

  // Keyboard input triggers the React events that direct value assignment can miss.
  await emailInput.click({ clickCount: 3 });
  await emailInput.type(email, { delay: 15 });
  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(password, { delay: 15 });

  const submit = await page.waitForSelector(LOGIN_SELECTORS.submit, {
    visible: true,
    timeout: 10_000,
  });

  if (!submit) {
    throw new Error('StudyDrive login button was not found.');
  }

  await submit.click();

  try {
    await page.waitForFunction(
      () => !window.location.pathname.replace(/\/$/, '').endsWith('/login'),
      { timeout: LOGIN_TIMEOUT_MS },
    );
  } catch {
    const errorMessage = await page.evaluate(() => {
      const candidates = Array.from(
        document.querySelectorAll('[role="alert"], [aria-live], form p, form span'),
      );
      return candidates
        .map((element) => element.textContent?.trim())
        .find((text) => text && /invalid|incorrect|wrong|failed|error|required/i.test(text));
    });

    const summary = await getPageSummary(page).catch(() => `URL: ${page.url()}`);
    throw new Error(errorMessage ? `StudyDrive rejected the login: ${errorMessage}` : `Login did not complete. ${summary}`);
  }

  if (isLoginUrl(page.url())) {
    throw new Error(`Login returned to the login page. ${await getPageSummary(page)}`);
  }
}
