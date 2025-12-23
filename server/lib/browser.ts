import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Browser as BrowserEnum, ChromeReleaseChannel, computeExecutablePath, install, resolveBuildId } from "@puppeteer/browsers";
import type { Browser } from "puppeteer";
import dotenv from "dotenv";
import { MAX_CONCURRENT_SCRAPES } from "../config.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PUPPETEER_CACHE =
  process.env.PUPPETEER_CACHE_DIR || path.join(process.cwd(), ".cache", "puppeteer");

// Helper to load Puppeteer with Stealth Plugin (if available) or fallback to standard
async function getPuppeteer() {
  try {
    // Try loading stealth dependencies (installed on Railway)
    // @ts-ignore - may be missing locally
    const { default: puppeteer } = await import("puppeteer-extra");
    // @ts-ignore - may be missing locally
    const { default: StealthPlugin } = await import("puppeteer-extra-plugin-stealth");
    
    puppeteer.use(StealthPlugin());
    console.log("🥸 [PUPPETEER] Using Stealth Mode (puppeteer-extra)");
    return puppeteer;
  } catch (e) {
    // Fallback to standard puppeteer (for local dev)
    console.log("🤖 [PUPPETEER] Using Standard Mode (puppeteer)");
    const { default: puppeteer } = await import("puppeteer");
    return puppeteer;
  }
}

export class RequestQueue {
  private queue: Array<() => void> = [];
  private activeCount = 0;

  async acquire(): Promise<void> {
    if (this.activeCount < MAX_CONCURRENT_SCRAPES) {
      this.activeCount++;
      return;
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.activeCount--;
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        this.activeCount++;
        next();
      }
    }
  }
}

export const globalScrapeQueue = new RequestQueue();

// ============================================
// SHARED BROWSER INSTANCE (Singleton)
// ============================================
let sharedBrowser: Browser | null = null;
let browserClosingPromise: Promise<void> | null = null;

let chromeExecutablePath: string | null = null;
let chromeInstallPromise: Promise<string | null> | null = null;
let chromeAvailable: boolean | null = null;

export async function ensureChromeExecutable(): Promise<string | null> {
  if (chromeExecutablePath && fs.existsSync(chromeExecutablePath)) {
    return chromeExecutablePath;
  }

  // If we already checked and Chrome is not available, don't retry
  if (chromeAvailable === false) {
    return null;
  }

  if (chromeInstallPromise) {
    return chromeInstallPromise;
  }

  chromeInstallPromise = (async () => {
    // First, try Puppeteer's built-in Chrome detection (works in Docker)
    try {
      const puppeteer = (await import("puppeteer")).default;
      const puppeteerPath = puppeteer.executablePath();
      if (puppeteerPath && fs.existsSync(puppeteerPath)) {
        console.log(`✅ Using Puppeteer's bundled Chrome at: ${puppeteerPath}`);
        chromeExecutablePath = puppeteerPath;
        chromeAvailable = true;
        return puppeteerPath;
      }
    } catch (e) {
      // Puppeteer's executablePath() failed, try other methods
    }

    // Try system Chrome paths (for local development)
    const systemChromePaths = [
      // macOS
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      // Linux
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      // Environment variable override
      process.env.PUPPETEER_EXECUTABLE_PATH,
    ].filter(Boolean) as string[];

    for (const chromePath of systemChromePaths) {
      if (fs.existsSync(chromePath)) {
        console.log(`✅ Using system Chrome at: ${chromePath}`);
        chromeExecutablePath = chromePath;
        chromeAvailable = true;
        return chromePath;
      }
    }

    // Fall back to downloading Chrome via @puppeteer/browsers
    console.log("No Chrome found, attempting to download...");
    const cacheDir = path.resolve(DEFAULT_PUPPETEER_CACHE);
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }

    try {
      let buildId: string;
      try {
        buildId = await resolveBuildId(BrowserEnum.CHROME, ChromeReleaseChannel.STABLE);
        console.log(`Resolved Chrome build ID: ${buildId}`);
      } catch (idError: any) {
        // Suppress known "Cannot read properties of undefined (reading 'match')" error from Puppeteer
        if (idError.message && idError.message.includes('match') && idError.message.includes('undefined')) {
             console.log("Could not resolve latest Chrome version from Google (likely network restriction), using fallback.");
        } else {
             console.warn("Failed to resolve Build ID from Google, using fallback:", idError.message);
        }
        // Fallback to a known recent stable version (Mac/Linux compatible)
        buildId = '121.0.6167.85'; 
      }

      const executablePath = computeExecutablePath({
        browser: BrowserEnum.CHROME,
        buildId,
        cacheDir
      });

      if (!fs.existsSync(executablePath)) {
        console.log(`Downloading Chrome (${buildId}) to ${cacheDir}...`);
        await install({
          browser: BrowserEnum.CHROME,
          buildId,
          cacheDir,
          unpack: true
        });
        console.log(`Chrome installed successfully at ${executablePath}`);
      }

      chromeExecutablePath = executablePath;
      chromeAvailable = true;
      return executablePath;
    } catch (resolveError: any) {
      console.warn("⚠️  Chrome not available - crowding data will be disabled");
      console.warn("   Reason:", resolveError.message);
      console.warn("   Stack:", resolveError.stack);
      chromeAvailable = false;
      return null;
    }
  })();

  try {
    return await chromeInstallPromise;
  } finally {
    chromeInstallPromise = null;
  }
}

export async function getSharedBrowser(): Promise<Browser> {
  // If closing, wait for it to finish
  if (browserClosingPromise) {
    await browserClosingPromise;
  }

  // If valid instance exists, reuse it
  if (sharedBrowser && !sharedBrowser.connected) {
    console.warn("⚠️ [BROWSER] Found disconnected browser handle, discarding...");
    sharedBrowser = null;
  }

  if (sharedBrowser) {
    return sharedBrowser;
  }

  console.log("🚀 [BROWSER] Launching NEW Shared Browser instance...");
  
  const puppeteer = (await import("puppeteer")).default;
  const executablePath = await ensureChromeExecutable();
  
  if (!executablePath) {
    throw new Error("Chrome executable not found cannot launch browser");
  }

  sharedBrowser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage', // Critical for Docker/Railway
      '--disable-gpu',
      '--no-zygote',             // Spawns fewer processes
      '--single-process',         // (Optional) forces single process, good for very low memory but less stable
      '--disable-blink-features=AutomationControlled'
    ],
    executablePath,
    timeout: 30000,
    env: { ...process.env, TZ: 'America/Chicago' }
  }) as unknown as Browser;

  // Cleanup handler if browser crashes or disconnects unexpectedly
  sharedBrowser.on('disconnected', () => {
    console.log("🔌 [BROWSER] Shared browser disconnected/closed!");
    sharedBrowser = null;
  });

  return sharedBrowser;
}

export async function resetSharedBrowser(): Promise<void> {
  console.log("♻️ [BROWSER] Resetting shared browser instance...");
  
  // 1. Mark as closing
  if (sharedBrowser) {
    try {
      if (sharedBrowser.process()?.pid) {
         console.log(`♻️ [BROWSER] Killing process ${sharedBrowser.process()?.pid}`);
         process.kill(sharedBrowser.process()!.pid!, 'SIGKILL');
      }
      await sharedBrowser.close().catch(() => {});
    } catch (e: any) {
      console.warn("⚠️ [BROWSER] Error closing browser:", e.message);
    }
  }

  sharedBrowser = null;
  
  // Wait a moment for OS to clean up
  await new Promise(r => setTimeout(r, 1000));
  console.log("✅ [BROWSER] Browser instance reset complete.");
}
