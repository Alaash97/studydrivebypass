import { NextResponse } from 'next/server';
import puppeteer from 'puppeteer-core';
import chromium from '@sparticuz/chromium';

// Determine if we are running in an AWS/Netlify/Vercel serverless environment
const isLocal = !process.env.NETLIFY && !process.env.VERCEL && !process.env.AWS_REGION;

// Increase max duration for serverless functions (Netlify/Vercel) since Puppeteer takes time
export const maxDuration = 60;

export async function POST(req: Request) {
  try {
    const { url } = await req.json();

    if (!url || !url.includes('studydrive.net')) {
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

    let browser;

    if (isLocal) {
      // Fallback to local full puppeteer installation (requires `puppeteer` package)
      const localPuppeteer = require('puppeteer');
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
        defaultViewport: (chromium as any).defaultViewport,
        executablePath: await chromium.executablePath(packUrl),
        headless: (chromium as any).headless,
        ignoreHTTPSErrors: true,
      } as any);
    }

    const page = await browser.newPage();

    // 1. Initial login (Optional optimization: Could save/reuse cookies if we wanted to be faster, 
    // but for simplicity & reliability we login each time for now)

    const startTime = Date.now();
    const logStep = (msg: string) => console.log(`[${Date.now() - startTime}ms] ${msg}`);

    logStep("Navigating to login page...");

    try {
      // Use domcontentloaded instead of networkidle0 to save huge amounts of time
      await page.goto('https://www.studydrive.net/en/login', { waitUntil: 'domcontentloaded', timeout: 15000 });

      logStep("Waiting for email and password fields...");

      // Wait for email and password fields with a smaller timeout
      await page.waitForSelector('input[type="email"]', { timeout: 10000 });

      // We use page.evaluate to type into it to avoid some complex Puppeteer typing issues on modern frontends
      await page.evaluate((e: any, p: any) => {
        const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
        const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
        if (emailInput && passwordInput) {
          emailInput.value = e;
          emailInput.dispatchEvent(new Event('input', { bubbles: true }));
          passwordInput.value = p;
          passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, email, password);

      logStep("Submitting login form...");

      // Try clicking the login button directly instead of pressing Enter
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        // Find the button that looks like the login submission
        const loginBtn = buttons.find(b => b.textContent?.toLowerCase().includes('log') || b.textContent?.toLowerCase().includes('sign'));
        if (loginBtn) {
          loginBtn.click();
        }
      });

      // Wait for login to complete. domcontentloaded is much faster than networkidle2
      await page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 });
      logStep("Logged in successfully.");
    } catch (e) {
      console.error("Failed to find login fields or login timed out.");
      throw new Error("StudyDrive login timeout or structure change. Check Netlify function logs.");
    }

    logStep("Setting up interceptor...");

    // 2. Inject premium override before navigating to the target document
    await page.evaluateOnNewDocument(() => {
      (window as any).sdWindow = new Proxy({}, {
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
      page.on('response', async (res: any) => {
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

      // Shorter safety timeout
      setTimeout(() => reject(new Error('Timeout waiting for file-preview request')), 15000);
    });

    logStep(`Navigating to target URL: ${url}`);
    // domcontentloaded is much faster
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });

    logStep("Waiting for PDF buffer...");
    const pdfBuffer = await pdfResponsePromise;

    logStep("PDF buffer extracted. Closing browser...");
    await browser.close();

    // Extract original filename if possible from the URL, or default it
    const match = url.match(/doc\/([^\/]+)/);
    const filename = match?.[1] ? `${match[1]}.pdf` : "StudyDrive-Document.pdf";

    // 3. Return the PDF
    return new NextResponse(pdfBuffer as unknown as BodyInit, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${filename}"`
      }
    });

  } catch (error: any) {
    console.error("Error generating PDF:", error);
    return NextResponse.json(
      { error: error?.message || 'Failed to download document.' },
      { status: 500 }
    );
  }
}
