import { NextResponse } from 'next/server';
import puppeteer, { type Browser, type HTTPRequest } from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { loginToStudyDrive, STUDYDRIVE_NETWORK_ARGS } from '@/lib/studydrive-login';

type PreviewRequest = {
  url: string;
  method: string;
  headers: Record<string, string>;
  postData?: string;
};

// Determine if we are running in an AWS/Netlify/Vercel serverless environment
const isLocal = !process.env.NETLIFY && !process.env.VERCEL && !process.env.AWS_REGION;

// Increase max duration for serverless functions (Netlify/Vercel) since Puppeteer takes time
export const maxDuration = 60;

const PDF_PREFIX = new TextEncoder().encode('%PDF-');

async function pipePdfBody(
  body: ReadableStream<Uint8Array>,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  const reader = body.getReader();
  let prefixOffset = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    let chunk = value;
    if (prefixOffset < PDF_PREFIX.length) {
      const bytesToCheck = Math.min(PDF_PREFIX.length - prefixOffset, chunk.length);
      for (let index = 0; index < bytesToCheck; index += 1) {
        if (chunk[index] !== PDF_PREFIX[prefixOffset + index]) {
          throw new Error('StudyDrive returned data that is not a PDF.');
        }
      }
      prefixOffset += bytesToCheck;
      chunk = chunk.subarray(bytesToCheck);
    }

    if (chunk.length > 0) controller.enqueue(chunk);
  }

  if (prefixOffset !== PDF_PREFIX.length) {
    throw new Error('StudyDrive returned an incomplete PDF.');
  }
}

async function streamDocument(
  url: string,
  email: string,
  password: string,
  controller: ReadableStreamDefaultController<Uint8Array>,
): Promise<void> {
  let browser: Browser | undefined;

  try {
    if (isLocal) {
      // Fallback to local full puppeteer installation (requires `puppeteer` package)
      const localPuppeteer = await import('puppeteer');
      browser = await localPuppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', ...STUDYDRIVE_NETWORK_ARGS]
      });
    } else {
      // Serverless Chromium setup
      chromium.setGraphicsMode = false;

      browser = await puppeteer.launch({
        args: [
          ...chromium.args,
          '--hide-scrollbars',
          '--disable-web-security',
          ...STUDYDRIVE_NETWORK_ARGS,
        ],
        // The package already contains the Brotli assets. Avoid downloading a
        // large archive from GitHub during every serverless cold start.
        executablePath: await chromium.executablePath(),
        headless: true,
        acceptInsecureCerts: true,
      });
    }

    const page = await browser.newPage();

    // 1. Initial login (Optional optimization: Could save/reuse cookies if we wanted to be faster, 
    // but for simplicity & reliability we login each time for now)

    const startTime = Date.now();
    const logStep = (msg: string) => console.log(`[${Date.now() - startTime}ms] ${msg}`);

    logStep("Navigating to login page...");

    try {
      logStep("Waiting for and submitting the login form...");
      await loginToStudyDrive(page, email, password);
      logStep("Logged in successfully.");
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown timeout';
      console.error("Failed to find login fields or login timed out.", error);
      throw new Error(`Login Step Failed: ${message}`);
    }

    logStep("Setting up interceptor...");

    // 2. Inject premium override before navigating to the target document
    await page.evaluateOnNewDocument(() => {
      const studyDriveWindow = window as unknown as Window & { sdWindow: object };
      studyDriveWindow.sdWindow = new Proxy({}, {
        set(target, prop, value, receiver) {
          if (prop === "user") {
            if (value && typeof value === "object") {
              Object.defineProperty(value, "is_premium", {
                value: true,
                configurable: false,
                writable: false,
              });
            }
          }
          return Reflect.set(target, prop, value, receiver);
        }
      });
    });

    const URL_REGEX = /studydrive\.net\/file-preview/;

    // Capture and abort the authenticated browser request before StudyDrive
    // consumes its signed URL. The server then opens that URL as a stream.
    await page.setRequestInterception(true);
    const previewRequestPromise = new Promise<PreviewRequest>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timeout waiting for file-preview request')),
        30_000,
      );
      let captured = false;

      const handleRequest = (request: HTTPRequest) => {
        const requestUrl = request.url();
        if (!captured && URL_REGEX.test(requestUrl)) {
          captured = true;
          logStep(`Intercepted PDF request: ${requestUrl.substring(0, 50)}...`);
          clearTimeout(timeout);
          resolve({
            url: requestUrl,
            method: request.method(),
            headers: request.headers(),
            postData: request.postData(),
          });
          void request.abort('blockedbyclient');
          return;
        }

        void request.continue();
      };

      page.on('request', handleRequest);
    });

    logStep(`Navigating to target URL: ${url}`);

    // domcontentloaded is too fast here, the React app hasn't mounted to trigger the PDF fetch.
    // We need to wait for the network to settle or at least have a longer timeout.
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown timeout';
      logStep(`Target URL Goto timeout: ${message}`);
    });

    logStep("Waiting for PDF request...");
    const previewRequest = await previewRequestPromise;

    const forwardedHeaders = new Headers();
    for (const name of ['accept', 'accept-language', 'authorization', 'content-type', 'origin', 'referer', 'user-agent']) {
      const value = previewRequest.headers[name];
      if (value) forwardedHeaders.set(name, value);
    }

    const cookies = await page.cookies(previewRequest.url);
    if (cookies.length > 0) {
      forwardedHeaders.set('cookie', cookies.map(({ name, value }) => `${name}=${value}`).join('; '));
    }

    logStep("Opening direct PDF stream...");
    const canHaveBody = !['GET', 'HEAD'].includes(previewRequest.method);
    const pdfResponse = await fetch(previewRequest.url, {
      method: previewRequest.method,
      headers: forwardedHeaders,
      body: canHaveBody ? previewRequest.postData : undefined,
      redirect: 'follow',
      signal: AbortSignal.timeout(30_000),
    });

    if (!pdfResponse.ok || !pdfResponse.body) {
      throw new Error(`StudyDrive file-preview returned HTTP ${pdfResponse.status}.`);
    }

    logStep("PDF stream opened. Closing browser...");
    await browser.close();
    browser = undefined;

    await pipePdfBody(pdfResponse.body, controller);
    controller.close();
  } catch (error: unknown) {
    console.error("Error generating PDF:", error);
    controller.error(error);
  } finally {
    await browser?.close().catch(() => undefined);
  }
}

export async function POST(req: Request) {
  try {
    const { url } = (await req.json()) as { url?: unknown };

    if (typeof url !== 'string' || !url.includes('studydrive.net')) {
      return NextResponse.json({ error: 'Valid StudyDrive URL is required.' }, { status: 400 });
    }

    const email = process.env.STUDYDRIVE_EMAIL;
    const password = process.env.STUDYDRIVE_PASSWORD;

    if (!email || !password) {
      return NextResponse.json(
        { error: 'Server configuration error: Missing StudyDrive credentials.' },
        { status: 500 },
      );
    }

    const match = url.match(/doc\/([^/]+)/);
    const filename = match?.[1] ? `${match[1]}.pdf` : 'StudyDrive-Document.pdf';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Flush valid PDF bytes immediately so Netlify does not terminate a
        // cold Chromium start as an inactive upstream connection.
        controller.enqueue(PDF_PREFIX);
        void streamDocument(url, email, password, controller);
      },
    });

    return new NextResponse(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Invalid request.';
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
