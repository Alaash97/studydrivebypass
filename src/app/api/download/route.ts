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
      browser = await puppeteer.launch({
        args: [...chromium.args, '--hide-scrollbars', '--disable-web-security'],
        defaultViewport: (chromium as any).defaultViewport,
        executablePath: await chromium.executablePath(),
        headless: (chromium as any).headless,
        ignoreHTTPSErrors: true,
      } as any);
    }

    const page = await browser.newPage();

    // 1. Initial login (Optional optimization: Could save/reuse cookies if we wanted to be faster, 
    // but for simplicity & reliability we login each time for now)

    console.log("Navigating to login page...");

    try {
      // First wait for the network to be mostly idle so JS can load the React/Vue components
      await page.goto('https://www.studydrive.net/en/login', { waitUntil: 'networkidle0', timeout: 30000 });

      console.log("Waiting for email and password fields...");

      // Wait for email and password fields with a generous timeout
      await page.waitForSelector('input[type="email"]', { timeout: 20000 });

      // We use page.evaluate to type into it to avoid some complex Puppeteer typing issues on modern frontends
      await page.evaluate((e: any) => {
        const emailInput = document.querySelector('input[type="email"]') as HTMLInputElement;
        const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
        if (emailInput && passwordInput) {
          emailInput.value = e;
          // dispatch event so framework knows it changed
          emailInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, email);

      await page.evaluate((p: any) => {
        const passwordInput = document.querySelector('input[type="password"]') as HTMLInputElement;
        if (passwordInput) {
          passwordInput.value = p;
          passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, password);

      console.log("Submitting login form...");

      // Try clicking the login button directly instead of pressing Enter
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        // Find the button that looks like the login submission
        const loginBtn = buttons.find(b => b.textContent?.toLowerCase().includes('log') || b.textContent?.toLowerCase().includes('sign'));
        if (loginBtn) {
          loginBtn.click();
        }
      });

      // Wait for login to complete
      await page.waitForNavigation({ waitUntil: 'networkidle2' });
      console.log("Logged in successfully.");
    } catch (e) {
      console.error("Failed to find login fields or login timed out.");
      // Take a screenshot and grab HTML to see what's actually on the screen
      const html = await page.content();
      const screenshot = await page.screenshot({ encoding: 'base64' });

      console.log("Page HTML snapshot (first 5000 chars):", html.substring(0, 5000));

      // Let's also check for common auth container components that might be lazy loaded
      const hasShadowRoot = await page.evaluate(() => !!document.querySelector('body > div'));
      console.log("Has simple div structures:", hasShadowRoot);

      throw new Error("StudyDrive login page did not load as expected. They might have a captcha or changed the login form. Check server console for details.");
    }

    console.log("Setting up interceptor...");

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
          console.log("Intercepted PDF response:", resUrl);
          try {
            // Get buffer directly from the response
            const buffer = await res.buffer();
            resolve(buffer);
          } catch (err) {
            reject(err);
          }
        }
      });

      // Safety timeout (e.g., 20 seconds)
      setTimeout(() => reject(new Error('Timeout waiting for file-preview request')), 20000);
    });

    console.log("Navigating to target URL:", url);
    await page.goto(url, { waitUntil: 'networkidle2' });

    console.log("Waiting for PDF buffer...");
    const pdfBuffer = await pdfResponsePromise;

    console.log("PDF buffer extracted. Closing browser...");
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
