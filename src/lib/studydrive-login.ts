import type { Page } from 'puppeteer-core';

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
  const cookieJar = new Map<string, string>();
  const initialResponse = await fetch(STUDYDRIVE_LOGIN_URL, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': STUDYDRIVE_USER_AGENT,
    },
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });

  if (!initialResponse.ok) {
    throw new Error(`StudyDrive login bootstrap returned HTTP ${initialResponse.status}.`);
  }
  mergeSetCookies(cookieJar, initialResponse.headers);
  await initialResponse.body?.cancel();

  const loginResponse = await fetch('https://www.studydrive.net/login', {
    method: 'POST',
    headers: {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      cookie: Array.from(cookieJar, ([name, value]) => `${name}=${value}`).join('; '),
      origin: 'https://www.studydrive.net',
      referer: STUDYDRIVE_LOGIN_URL,
      'user-agent': STUDYDRIVE_USER_AGENT,
      'x-requested-with': 'XMLHttpRequest',
    },
    body: JSON.stringify({ email, password, remember: true }),
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });

  mergeSetCookies(cookieJar, loginResponse.headers);
  const result = await loginResponse.json().catch(() => null) as { success?: boolean } | null;
  if (!loginResponse.ok || !result?.success) {
    throw new Error(`StudyDrive login request returned HTTP ${loginResponse.status}.`);
  }

  await page.setCookie(
    ...Array.from(cookieJar, ([name, value]) => ({
      name,
      value,
      domain: '.studydrive.net',
      path: '/',
      secure: true,
    })),
  );
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
