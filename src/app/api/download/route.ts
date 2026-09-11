import { NextResponse } from 'next/server';
import puppeteer, { type Browser, type HTTPResponse } from 'puppeteer-core';
import chromium from '@sparticuz/chromium';
import { loginToStudyDrive } from '@/lib/studydrive-login';

// Determine if we are running in an AWS/Netlify/Vercel serverless environment
const isLocal = !process.env.NETLIFY && !process.env.VERCEL && !process.env.AWS_REGION;

// Increase max duration for serverless functions (Netlify/Vercel) since Puppeteer takes time
export const maxDuration = 60;

export async function POST(req: Request) {
  let browser: Browser | undefined;

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
        { status: 500 }
      );
    }

    if (isLocal) {
      // Fallback to local full puppeteer installation (requires `puppeteer` package)
      const localPuppeteer = await import('puppeteer');
      browser = await localPuppeteer.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
      });
    } else {
      // Serverless Chromium setup
      const packUrl = process.arch === 'arm64'
        ? 'https://github.com/Sparticuz/chromium/releases/download/v143.0.4/chromium-v143.0.4-pack.arm64.tar'
        : 'https://github.com/Sparticuz/chromium/releases/download/v143.0.4/chromium-v143.0.4-pack.x64.tar';

      browser = await puppeteer.launch({
        args: [...chromium.args, '--hide-scrollbars', '--disable-web-security'],
        executablePath: await chromium.executablePath(packUrl),
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

    const URL_REGEX = /.*studydrive\.net\/file-preview/g;

    // Promise to wait for the specific PDF response
    const pdfResponsePromise = new Promise<Buffer>((resolve, reject) => {
      page.on('response', async (res: HTTPResponse) => {
        const resUrl = res.url();
        if (resUrl.match(URL_REGEX) && res.status() === 200) {
          logStep(`Intercepted PDF response: ${resUrl.substring(0, 50)}...`);
          try {
            // Get buffer directly from the response
            const buffer = await res.buffer();
            resolve(buffer);
          } catch (err) {
            reject(err);
          }
        }
      });

      // Increased safety timeout because the PDF fetch might take a while to start
      setTimeout(() => reject(new Error('Timeout waiting for file-preview request')), 30000);
    });

    logStep(`Navigating to target URL: ${url}`);

    // domcontentloaded is too fast here, the React app hasn't mounted to trigger the PDF fetch.
    // We need to wait for the network to settle or at least have a longer timeout.
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown timeout';
      logStep(`Target URL Goto timeout: ${message}`);
    });

    logStep("Waiting for PDF buffer...");
    const pdfBuffer = await pdfResponsePromise;

    logStep("PDF buffer extracted. Closing browser...");
    await browser.close();
    browser = undefined;

    // Extract original filename if possible from the URL, or default it
    const match = url.match(/doc\/([^/]+)/);
    const filename = match?.[1] ? `${match[1]}.pdf` : "StudyDrive-Document.pdf";

    // 3. Return the PDF
    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    });

  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to download document.';
    console.error("Error generating PDF:", error);
    return NextResponse.json(
      { error: message },
      { status: 500 }
    );
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
