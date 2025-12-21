import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { Browser, ChromeReleaseChannel, computeExecutablePath, install, resolveBuildId } from "@puppeteer/browsers";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

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


// Database imports are lazy-loaded to allow server to start without database
let getAllSchedules: any, getNextTrain: any, shouldUpdateGTFS: any;
let getAllDelays: any, updateRealtimeData: any;
let updateWeatherData: any, getAllWeather: any;
let loadGTFSIntoDatabase: any;
let getDatabase: any;

// Track ongoing scraping operations to prevent concurrent scrapes
const scrapingLocks = new Map<string, Promise<any>>();

// ============================================
// TIME-BASED POLLING CONFIGURATION
// ============================================
// Active hours: 4 AM - 6 PM Chicago time (commute hours)
// Off hours: 6 PM - 4 AM Chicago time (reduced polling)

function isActiveHours(): boolean {
  const now = new Date();
  // Get Chicago time (handles DST automatically)
  const chicagoHour = parseInt(now.toLocaleString('en-US', { 
    timeZone: 'America/Chicago', 
    hour: 'numeric', 
    hour12: false 
  }));
  return chicagoHour >= 4 && chicagoHour < 18; // 4 AM to 6 PM
}

// Cache TTLs - different for active vs off hours
const POSITIONS_CACHE_TTL = 15 * 1000; // 15 seconds (positions come from free GTFS API)

// Crowding cache: 1 hour active, 4 hours off
function getCrowdingCacheTTL(): number {
  return isActiveHours() ? 10 * 60 * 1000 : 60 * 60 * 1000; // 10min active, 1hr off-hours
}

// Weather intervals: 15 min active, 30 min off  
function getWeatherInterval(): number {
  return isActiveHours() ? 15 * 60 * 1000 : 30 * 60 * 1000; // 15min or 30min
}
// ============================================

// Cache for train positions (shared across all requests for instant page loads)
// Unified positions cache - single bulk fetch for ALL lines
// Key: 'all' - stores all train positions from one Metra API call
const positionsCache = new Map<string, {
  data: any[];  // Array of all train positions
  timestamp: number;
}>();

// Cache for crowding data (shared across all requests for instant page loads)
// Key format: "ORIGIN_DESTINATION_LINE" (e.g., "PALATINE_OTC_UP-NW")
const crowdingCache = new Map<string, {
  data: Array<{
    trip_id: string;
    crowding: string;
    scheduled_departure?: string | null;
    predicted_departure?: string | null;
    scheduled_arrival?: string | null;
    predicted_arrival?: string | null;
  }>;
  timestamp: number;
}>();

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_PUPPETEER_CACHE =
  process.env.PUPPETEER_CACHE_DIR || path.join(process.cwd(), ".cache", "puppeteer");

let chromeExecutablePath: string | null = null;
let chromeInstallPromise: Promise<string | null> | null = null;

// Track if Chrome is available (null = not checked yet, false = unavailable)
let chromeAvailable: boolean | null = null;

async function ensureChromeExecutable(): Promise<string | null> {
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
        buildId = await resolveBuildId(Browser.CHROME, ChromeReleaseChannel.STABLE);
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
        browser: Browser.CHROME,
        buildId,
        cacheDir
      });

      if (!fs.existsSync(executablePath)) {
        console.log(`Downloading Chrome (${buildId}) to ${cacheDir}...`);
        await install({
          browser: Browser.CHROME,
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

// Helper type
type CrowdingLevel = 'low' | 'some' | 'moderate' | 'high';

// Reusable scraping function for both API requests and scheduled background tasks
async function scrapeAndCacheCrowding(
  origin: string, 
  destination: string, 
  lineId: string, 
  source: string = 'API',
  dateOverride?: Date
) {
  const cacheKey = `${origin}_${destination}_${lineId}`;
  const startTime = Date.now();
  console.log(`[${source}] Starting scraping for ${origin}->${destination} (Line: ${lineId})...`);

  // Check if a scrape is already in progress
  if (scrapingLocks.has(cacheKey)) {
    console.log(`[${source}] Detailed scrape already in progress for ${cacheKey}, waiting for it...`);
    return scrapingLocks.get(cacheKey);
  }

  const scrapePromise = (async () => {
    let scrapeBrowser: any = null;
    try {
      const puppeteer = (await import("puppeteer")).default;
      const executablePath = await ensureChromeExecutable();
      
      if (!executablePath) {
        throw new Error("Chrome not available - crowding scraping disabled");
      }
      
      let scheduleDate: number;

      if (dateOverride) {
        scheduleDate = Math.floor(dateOverride.getTime() / 1000);
        console.log(`[${source}] Using schedule override: ${dateOverride.toLocaleString('en-US', { timeZone: 'America/Chicago' })}`);
      } else {
        // FIX: Calculate "Service Date" based on 4:00 AM cutoff
        // If it's before 4:00 AM in Chicago, we want the PREVIOUS day's schedule (late night trains)
        // If it's after 4:00 AM, we want TODAY's schedule

        const now = new Date();
        
        // 1. Get current time attributes in Chicago
        const chicagoTimeParts = new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/Chicago',
          year: 'numeric', month: '2-digit', day: '2-digit',
          hour: 'numeric', minute: 'numeric', second: 'numeric',
          hour12: false
        }).formatToParts(now);
        
        const getPart = (type: string) => parseInt(chicagoTimeParts.find(p => p.type === type)?.value || '0');
        
        let targetYear = getPart('year');
        let targetMonth = getPart('month');
        let targetDay = getPart('day');
        const chicagoHour = getPart('hour');
        
        // 2. Adjust for Service Day (Rollover at 4:00 AM)
        if (chicagoHour < 4) {
             // It's technically "early morning" (e.g. 1AM), but part of "yesterday's" service day
             // So we go back one day
             const yesterday = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay - 1));
             // Re-extract Y/M/D from the adjusted date
             targetYear = yesterday.getUTCFullYear();
             targetMonth = yesterday.getUTCMonth() + 1;
             targetDay = yesterday.getUTCDate();
             console.log(`[${source}] Early morning detected (${chicagoHour} AM). Using YESTERDAY'S schedule.`);
        }

        // 3. Construct the target date string (YYYY-MM-DD)
        const dateStr = `${targetYear}-${String(targetMonth).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
        
        // 4. Create proper Date object for "4:00 AM Chicago Time" on that specific date
        //    We MUST handle the timezone offset manually to be safe on UTC servers
        
        // Get the offset for that specific date/time in Chicago
        const lookupDate = new Date(`${dateStr}T12:00:00Z`); // Noon UTC is safe for checking offset
        const timeZoneString = lookupDate.toLocaleString('en-US', { timeZone: 'America/Chicago', timeZoneName: 'short' });
        const isCST = timeZoneString.includes('Central Standard') || timeZoneString.includes('CST');
        // CST = UTC-6, CDT = UTC-5
        const offsetHours = isCST ? 6 : 5; 
        
        // 4:00 AM Chicago = (4 + offset) UTC
        // e.g. 4am CST = 10am UTC
        const targetDate = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay, 4 + offsetHours, 0, 0));
        
        console.log(`[${source}] 📅 Requesting schedule for Service Day: ${dateStr} (Server: 4:00 AM + ${offsetHours}h offset)`);
        
        scheduleDate = Math.floor(targetDate.getTime() / 1000);
      }
      
      const { getMetraScheduleUrl } = await import("@shared/metra-urls");
      
      const url = getMetraScheduleUrl({
        origin: String(origin),
        destination: String(destination),
        line: String(lineId),
        date: scheduleDate * 1000 
      });
      console.log(`[${source}] Constructed URL: ${url}`);
      
      // Add a random delay before launching browser to avoid being too predictable
      // if (runMode !== 'TESTING') await new Promise(r => setTimeout(r, Math.random() * 2000 + 1000));
      
      scrapeBrowser = await puppeteer.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled' // Extra stealth
        ],
        executablePath,
        timeout: 30000,
        env: { ...process.env, TZ: 'America/Chicago' }
      });
      
      const page = await scrapeBrowser.newPage();
      
      // Force Chicago timezone for the page context
      await page.emulateTimezone('America/Chicago');
      
      // Stealth: Hide webdriver property to bypass simple WAF checks
      await page.evaluateOnNewDocument(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => false });
      });
      
      await page.setViewport({ width: 1920, height: 1080 });
      await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
      
      await page.setExtraHTTPHeaders({
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8'
      });
      
      // DEBUG: Forward browser console logs to server terminal
      page.on('console', (msg: any) => console.log(`[BROWSER_LOG] ${msg.type().toUpperCase()}: ${msg.text()}`));
      
      // Navigate
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
      
      // DEBUG: Check if page loaded correctly
      const pageTitle = await page.title();
      console.log(`[DEBUG_SCRAPE] Page loaded: "${pageTitle}"`);
      
      await page.waitForSelector('.trip-row', { timeout: 10000 }).catch(() => {
        console.warn(`[DEBUG_SCRAPE] Timed out waiting for .trip-row selector`);
      });
      
      // Extract data (Same logic as before)
      const extractedData = await page.evaluate((scrapeOrigin: string, scrapeDest: string, scheduleDate: number) => {
        // DEBUG: Log Environment inside Browser
        console.log(`[DEBUG_BROWSER] Browser Date: ${new Date().toString()}`);
        console.log(`[DEBUG_BROWSER] Browser Timezone Offset: ${new Date().getTimezoneOffset()}`);
        console.log(`[DEBUG_BROWSER] Target Schedule Date: ${new Date(scheduleDate * 1000).toString()}`);
        
        type ClientCrowdingLevel = 'low' | 'some' | 'moderate' | 'high';
        
        const resultsMap = new Map<string, any>();
        
        // Crowding extraction
        const tripRows = Array.from(document.querySelectorAll('.trip-row'));
        console.log(`[DEBUG_BROWSER] Found ${tripRows.length} .trip-row elements`);
        
        tripRows.forEach((tripCell: Element) => {
          const tripId = tripCell.getAttribute('id');
          if (!tripId) return;
          
          let crowding: ClientCrowdingLevel = 'low';
          const container = tripCell.querySelector('.trip--crowding');
          if (container) {
            if (container.querySelector('.trip--crowding-high') || container.classList.contains('trip--crowding-high')) crowding = 'high';
            else if (container.querySelector('.trip--crowding-moderate') || container.classList.contains('trip--crowding-moderate')) crowding = 'moderate';
            else if (container.querySelector('.trip--crowding-some') || container.classList.contains('trip--crowding-some')) crowding = 'some';
          }
          
          resultsMap.set(tripId, {
            trip_id: tripId,
            crowding,
            scheduled_departure: null, // Populated next
            estimated_departure: null,
            scheduled_arrival: null,
            estimated_arrival: null
          });
        });
        
        // Time/Delay extraction
        const stopCells = Array.from(document.querySelectorAll('td.stop'));
        let debugLogCount = 0;
        
        stopCells.forEach((cell: Element) => {
           const stopText = cell.querySelector('.stop--text');
           const strikeOut = stopText?.querySelector('.strike-out');
           
           // DEBUG: Log first few cells html to verify structure
           if (debugLogCount < 3) {
             const cellId = cell.getAttribute('id') || 'no-id';
             if (cellId.includes(scrapeOrigin) || cellId.includes(scrapeDest)) {
               console.log(`[DEBUG_BROWSER] Checking cell ${cellId}:`);
               console.log(`[DEBUG_BROWSER]   HTML: ${cell.innerHTML.substring(0, 200)}...`);
               console.log(`[DEBUG_BROWSER]   StrikeOut Found: ${!!strikeOut}`);
               debugLogCount++;
             }
           }
           
           if (!strikeOut) return; // No delay info
           
           const cellId = cell.getAttribute('id');
           if (!cellId) return;
           
           const tripIdMatch = cellId.match(/^((?:UP-NW|MD-W|UP-N|BNSF|UP-W)_[A-Z0-9]+_V\d+_[A-Z])/);
           if (!tripIdMatch) return;
           const tripId = tripIdMatch[1];
           
           const isOriginStop = cellId.toUpperCase().includes(scrapeOrigin.toUpperCase());
           const isDestStop = cellId.toUpperCase().includes(scrapeDest.toUpperCase());
           
           const scheduledTime = strikeOut.textContent?.trim() || null;
           
           // Improved extraction using innerText to respect visual separation (newlines)
           let estimatedTime: string | null = null;
           if (stopText) {
             const fullText = (stopText as HTMLElement).innerText || '';
             const parts = fullText.split('\n').map(s => s.trim()).filter(s => s);
             
             // If we found multiple parts (e.g. "8:33 PM", "8:35 PM"), find the one that isn't the scheduled time
             if (parts.length > 1 && scheduledTime) {
               estimatedTime = parts.find(p => p !== scheduledTime) || null;
             }
             
             // Fallback to text replacement if split didn't work (e.g. no newline)
             if (!estimatedTime) {
                estimatedTime = (stopText.textContent || '').replace(scheduledTime || '', '').trim() || null;
             }
           }

           // Log the extraction result for debugging
           if (isOriginStop || isDestStop) {
             console.log(`[DEBUG_BROWSER] 🎯 Trip ${tripId}: Found StrikeOut. Sch='${scheduledTime}', Est='${estimatedTime}'`);
             console.log(`[DEBUG_BROWSER]    Full Text: ${(stopText as HTMLElement)?.innerText?.replace(/\n/g, '|')}`);
           }
           
           // DEBUG: Log if we found a delay
           if (isOriginStop || isDestStop) {
             console.log(`[DEBUG_BROWSER] Found Delay Info for ${tripId}: Sch=${scheduledTime}, Est=${estimatedTime}`);
           }
           
           const existing = resultsMap.get(tripId);
           if (existing) {
             if (isOriginStop) {
               existing.scheduled_departure = scheduledTime;
               existing.estimated_departure = estimatedTime;
             } else if (isDestStop) {
               existing.scheduled_arrival = scheduledTime;
               existing.estimated_arrival = estimatedTime;
             }
           }
        });
        
        // Debug output size
        const results = Array.from(resultsMap.values());
        console.log(`[DEBUG_BROWSER] Extracted ${results.length} total trips`);
        
        return { crowding: results };
      }, origin, destination, scheduleDate);

      if (!extractedData || !extractedData.crowding) {
        console.error(`[${source}] ❌ Extraction failed - no crowding data returned`);
        throw new Error('No crowding data extracted');
      }
      
      console.log(`\n📊 [${source}] CROWDING DATA EXTRACTED:`);
      console.log(`   Total trains found: ${extractedData.crowding.length}`);
      console.log(`   Sample (first 3):`);
      extractedData.crowding.slice(0, 3).forEach((item: any) => {
        console.log(`   - ${item.trip_id}: crowding=${item.crowding}, dep=${item.scheduled_departure || 'N/A'}${item.estimated_departure ? ` (delayed to ${item.estimated_departure})` : ''}`);
      });

      // Save to Database (UPSERT)
      const { getDatabase } = await import("./db/schema.js");
      const db = getDatabase();
      if (db) {
         const transaction = db.transaction(() => {
           const insert = db.prepare(`
             INSERT OR REPLACE INTO crowding_cache 
             (origin, destination, trip_id, crowding, 
              scheduled_departure, predicted_departure, 
              scheduled_arrival, predicted_arrival, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
           `);
           
           let savedCount = 0;
           extractedData.crowding.forEach((item: any) => {
             insert.run(
               origin, destination, item.trip_id, item.crowding,
               item.scheduled_departure, item.estimated_departure,
               item.scheduled_arrival, item.estimated_arrival
             );
             savedCount++;
           });
           console.log(`[${source}] Saved/Updated ${savedCount} entries for ${origin}->${destination}`);
         });
         transaction();
      }

      if (extractedData.crowding.length === 0) {
        console.warn(`[WARNING] No crowding data extracted from Metra website for ${origin}->${destination}`);
        throw new Error('No crowding data extracted from Metra website');
      }
      
      await scrapeBrowser.close();
      
      return { 
        crowding: extractedData.crowding.map((item: any) => ({
             trip_id: String(item.trip_id || ''),
             crowding: String(item.crowding || 'low'),
             scheduled_departure: item.scheduled_departure || null,
             predicted_departure: item.estimated_departure || null,
             scheduled_arrival: item.scheduled_arrival || null,
             predicted_arrival: item.estimated_arrival || null
        }))
      };

    } catch (error: any) {
      if (scrapeBrowser) await scrapeBrowser.close().catch(() => {});
      console.error(`[${source}] Scraping failed:`, error.message);
      throw error;
    }
  })();

  scrapingLocks.set(cacheKey, scrapePromise);
  
  try {
    const result = await scrapePromise;
    scrapingLocks.delete(cacheKey);
    return result;
  } catch (err) {
    scrapingLocks.delete(cacheKey);
    throw err;
  }
}


// Scheduled Task: Daily Crowding Seed (3:55 AM Chicago Time)
// Runs once per day to fetch FULL DAY crowding predictions for all active routes
function scheduleDailyScrapes() {
  const runScheduledScrape = async () => {
    console.log("⏰ [SCHEDULE] Starting daily crowding seed (3:55 AM)...");
    
    // 1. Identify active routes from recent cache usage
    const db = getDatabase();
    if (!db) {
      console.warn("⏰ [SCHEDULE] Database not available, skipping scheduled scrape");
      return;
    }
    
    // Get distinct origin-destination pairs that have been queried in the last 7 days
    // This ensures we only scrape relevant routes effectively
    const activeRoutes = db.prepare(`
      SELECT DISTINCT origin, destination, trip_id 
      FROM crowding_cache 
      WHERE updated_at > datetime('now', '-7 days')
    `).all() as Array<{origin: string, destination: string, trip_id: string}>;
    
    // Group by unique origin/dest/line to avoid duplicate scrapes
    // We infer line from trip_id (e.g. BNSF_..., UP-NW_...)
    const uniquePairs = new Set<string>();
    const scrapeQueue: Array<{origin: string, destination: string, line: string}> = [];
    
    activeRoutes.forEach(r => {
      let line = '';
      if (r.trip_id.startsWith('BNSF')) line = 'BNSF';
      else if (r.trip_id.startsWith('UP-NW')) line = 'UP-NW';
      else if (r.trip_id.startsWith('UP-N')) line = 'UP-N';
      else if (r.trip_id.startsWith('MD-W')) line = 'MD-W';
      
      if (line) {
        const key = `${r.origin}|${r.destination}|${line}`;
        if (!uniquePairs.has(key)) {
          uniquePairs.add(key);
          scrapeQueue.push({ origin: r.origin, destination: r.destination, line });
        }
      }
    });

    // 2. Ensure the 4 key highlighted stations are ALWAYS seeded (Inbound & Outbound)
    // This guarantees data availability for the main user flows even if cache is empty
    const keyRoutes = [
      { origin: 'PALATINE', destination: 'OTC', line: 'UP-NW' },
      { origin: 'OTC', destination: 'PALATINE', line: 'UP-NW' },
      { origin: 'SCHAUM', destination: 'CUS', line: 'MD-W' },
      { origin: 'CUS', destination: 'SCHAUM', line: 'MD-W' },
      { origin: 'WILMETTE', destination: 'OTC', line: 'UP-N' },
      { origin: 'OTC', destination: 'WILMETTE', line: 'UP-N' },
      { origin: 'WESTMONT', destination: 'CUS', line: 'BNSF' },
      { origin: 'CUS', destination: 'WESTMONT', line: 'BNSF' }
    ];

    keyRoutes.forEach(route => {
      const key = `${route.origin}|${route.destination}|${route.line}`;
      if (!uniquePairs.has(key)) {
        console.log(`⏰ [SCHEDULE] Adding priority route: ${route.origin}->${route.destination}`);
        uniquePairs.add(key);
        scrapeQueue.push(route);
      }
    });

    // Also add defaults if empty (cold start) - though keyRoutes handles this now
    if (scrapeQueue.length === 0) {
      console.log("⏰ [SCHEDULE] No active routes found, adding defaults...");
      scrapeQueue.push({ origin: 'PALATINE', destination: 'OTC', line: 'UP-NW' });
    }
    
    console.log(`⏰ [SCHEDULE] Found ${scrapeQueue.length} routes to seed:`, scrapeQueue.map(q => `${q.origin}->${q.destination}`).join(', '));
    
    // Process queue in parallel chunks to speed up seeding
    const CONCURRENCY = 3;
    console.log(`⏰ [SCHEDULE] Processing ${scrapeQueue.length} routes with concurrency ${CONCURRENCY}...`);
    
    for (let i = 0; i < scrapeQueue.length; i += CONCURRENCY) {
      const chunk = scrapeQueue.slice(i, i + CONCURRENCY);
      await Promise.all(chunk.map(async (task) => {
        const { origin, destination, line } = task;
        
        // Simplified timezone calculation (tested and working)
        const nowUtc = new Date();
        const tomorrowChicago = new Date(nowUtc.getTime() + 24 * 60 * 60 * 1000);
        
        const chiYear = parseInt(tomorrowChicago.toLocaleString('en-US', { timeZone: 'America/Chicago', year: 'numeric' }));
        const chiMonth = parseInt(tomorrowChicago.toLocaleString('en-US', { timeZone: 'America/Chicago', month: '2-digit' }));
        const chiDay = parseInt(tomorrowChicago.toLocaleString('en-US', { timeZone: 'America/Chicago', day: '2-digit' }));
        const chicagoDateStr = `${chiYear}-${String(chiMonth).padStart(2, '0')}-${String(chiDay).padStart(2, '0')}`;
        const targetDate = new Date(`${chicagoDateStr}T04:00:00-06:00`);
        
        console.log(`[SCHEDULED] Scraping ${origin}->${destination} (${line}) for ${targetDate.toLocaleString('en-US', { timeZone: 'America/Chicago' })}...`);
        
        try {
          await scrapeAndCacheCrowding(
            origin, 
            destination, 
            line, 
            'SCHEDULED', // Source
            targetDate   // Date override
          );
          console.log(`[SCHEDULED] Completed scraping for ${origin}->${destination}`);
        } catch (error) {
          console.error(`[SCHEDULED] Failed daily scrape for ${origin}->${destination}:`, error);
        }
      }));
    }
    
    console.log("⏰ [SCHEDULE] Daily seed completed!");
  };

  const scheduleNextRun = () => {
    const now = new Date();
    const chicagoTimeStr = now.toLocaleString('en-US', { timeZone: 'America/Chicago' });
    const chicagoNow = new Date(chicagoTimeStr);
    
    // Target: 3:55 AM Chicago time
    const target = new Date(chicagoNow);
    target.setHours(3, 55, 0, 0);
    
    // If 3:55 AM has passed today, schedule for tomorrow
    if (target.getTime() <= chicagoNow.getTime()) {
      target.setDate(target.getDate() + 1);
    }
    
    const msUntilRun = target.getTime() - chicagoNow.getTime();
    console.log(`⏰ [SCHEDULE] Next daily scrape scheduled for ${target.toLocaleString()} (in ${Math.round(msUntilRun/1000/60/60)} hours)`);
    
    setTimeout(() => {
      runScheduledScrape();
      scheduleNextRun(); // Re-schedule for next day
    }, msUntilRun);
  };
  
  // Start the scheduling loop
  // SMART COLD START: Check if we have data before forcing a seed
  const dbCheck = getDatabase();
  if (dbCheck) {
    try {
      // Check for RECENT data (within last 24 hours)
      const result = dbCheck.prepare(`
        SELECT COUNT(*) as count FROM crowding_cache 
        WHERE updated_at > datetime('now', '-24 hours')
      `).get() as { count: number };
      
      const count = result?.count || 0;
      console.log(`⏰ [SCHEDULE] Startup check: Found ${count} valid crowding entries in database.`);
      
      if (count < 5) {
        // Cold start - mostly empty DB
        console.log("❄️ [SCHEDULE] Cold start detected (low data). Triggering immediate initial seed...");
        runScheduledScrape();
      } else {
        // Warm start - data exists
        console.log("✅ [SCHEDULE] Data exists. Skipping immediate seed to save resources.");
      }
    } catch (err: any) {
      console.warn("⚠️ [SCHEDULE] Could not verify DB state, defaulting to standard schedule:", err.message);
    }
  } else {
    // If no DB, we can't really do anything, but try running anyway?
    // Probably best to just let the schedule handle it
  }

  scheduleNextRun();
}

// Frequent Delay Scraping (every 10 minutes during active hours)
// This provides more real-time delay info from the Metra website strike-out times
// Runs 5 AM - 10 PM Chicago time only to avoid unnecessary late-night scraping
function scheduleFrequentDelayScrapes() {
  // All routes we want to scrape for delay data
  const ALL_ROUTES = [
    { origin: 'PALATINE', destination: 'OTC', line: 'UP-NW' },
    { origin: 'OTC', destination: 'PALATINE', line: 'UP-NW' },
    { origin: 'SCHAUM', destination: 'CUS', line: 'MD-W' },
    { origin: 'CUS', destination: 'SCHAUM', line: 'MD-W' },
    { origin: 'WILMETTE', destination: 'OTC', line: 'UP-N' },
    { origin: 'OTC', destination: 'WILMETTE', line: 'UP-N' },
    { origin: 'WESTMONT', destination: 'CUS', line: 'BNSF' },
    { origin: 'CUS', destination: 'WESTMONT', line: 'BNSF' }
  ];

  const SCRAPE_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const CONCURRENCY = 2; // Process 2 routes at a time to avoid overwhelming

  const runDelayScrape = async () => {
    // Check if we're in active hours (5 AM - 10 PM Chicago)
    const now = new Date();
    const chicagoHour = parseInt(now.toLocaleString('en-US', { 
      timeZone: 'America/Chicago', 
      hour: 'numeric', 
      hour12: false 
    }));

    if (chicagoHour < 5 || chicagoHour >= 22) {
      console.log(`🌙 [DELAY SCRAPE] Skipping - off hours (${chicagoHour}:00 Chicago)`);
      return;
    }

    console.log(`⏱️ [DELAY SCRAPE] Starting frequent scrape (${chicagoHour}:${now.getMinutes().toString().padStart(2, '0')} Chicago)...`);

    // Process routes in chunks
    for (let i = 0; i < ALL_ROUTES.length; i += CONCURRENCY) {
      const chunk = ALL_ROUTES.slice(i, i + CONCURRENCY);
      
      await Promise.all(chunk.map(async ({ origin, destination, line }) => {
        try {
          await scrapeAndCacheCrowding(origin, destination, line, 'DELAY_REFRESH');
        } catch (error: any) {
          // Don't log full error for routine failures
          console.warn(`[DELAY] ${origin}->${destination}: ${error.message?.substring(0, 50) || 'failed'}`);
        }
      }));
      
      // Small pause between chunks to be gentle on Metra's servers
      if (i + CONCURRENCY < ALL_ROUTES.length) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    console.log(`✅ [DELAY SCRAPE] Completed all routes`);
  };

  // Start interval - aligned to 10 minute marks
  const now = new Date();
  const msSinceLastTen = now.getTime() % SCRAPE_INTERVAL_MS;
  const msToNextSync = SCRAPE_INTERVAL_MS - msSinceLastTen;

  console.log(`⏱️ [DELAY SCRAPE] Will start in ${Math.round(msToNextSync / 1000 / 60)} min, then every 10 min during active hours (5AM-10PM)`);

  setTimeout(() => {
    runDelayScrape();
    setInterval(runDelayScrape, SCRAPE_INTERVAL_MS);
  }, msToNextSync);
}

async function startServer() {
  try {
    const app = express();
    const server = createServer(app);
    
    app.use(express.json());

    // Serve static files from dist/public in production
    const staticPath =
      process.env.NODE_ENV === "production"
        ? path.resolve(__dirname, "public")
        : path.resolve(__dirname, "..", "dist", "public");

    // Initialize database and load GTFS if needed (don't block server startup)
    (async () => {
      try {
        // Try to load database modules
        try {
          const dbModule = await import("./db/schema.js");
          const scheduleModule = await import("./db/schedule-api.js");
          const realtimeModule = await import("./db/realtime-updater.js"); // Still import for getAllDelays
          const weatherModule = await import("./db/weather-updater.js");
          const loaderModule = await import("./db/gtfs-loader.js");
          
          // Assign to module-level variables
          getDatabase = dbModule.getDatabase;
          getAllSchedules = scheduleModule.getAllSchedules;
          getNextTrain = scheduleModule.getNextTrain;
          shouldUpdateGTFS = scheduleModule.shouldUpdateGTFS;
          getAllDelays = realtimeModule.getAllDelays; // Only getAllDelays from realtimeModule
          updateWeatherData = weatherModule.updateWeatherData;
          getAllWeather = weatherModule.getAllWeather;
          loadGTFSIntoDatabase = loaderModule.loadGTFSIntoDatabase;
          
          // Initialize database schema
          const { initDatabase } = dbModule;
          initDatabase();
          
          // Start the daily scheduled scrape task
          scheduleDailyScrapes();
          
          // Start the 10-minute delay scrape task (active hours only)
          scheduleFrequentDelayScrapes();

          // [TESTING] 4-Minute Interval for Crowding Data
          console.log("🧪 [TESTING] Starting 4-minute CROWDING DATA interval for testing...");
          const runTestScrape = async () => {
             console.log("🧪 [TESTING] Triggering 4-minute scrape...");
             const testRoutes = [
               { origin: 'PALATINE', destination: 'OTC', line: 'UP-NW' },
               { origin: 'OTC', destination: 'PALATINE', line: 'UP-NW' },
               { origin: 'WESTMONT', destination: 'CUS', line: 'BNSF' },
               { origin: 'CUS', destination: 'WESTMONT', line: 'BNSF' },
               { origin: 'SCHAUM', destination: 'CUS', line: 'MD-W' },
               { origin: 'CUS', destination: 'SCHAUM', line: 'MD-W' },
               { origin: 'WILMETTE', destination: 'OTC', line: 'UP-N' },
               { origin: 'OTC', destination: 'WILMETTE', line: 'UP-N' }
             ];
             
             for (const route of testRoutes) {
               try {
                 await scrapeAndCacheCrowding(route.origin, route.destination, route.line, 'TESTING');
               } catch (e) { console.error(`[TESTING] Failed scrape for ${route.origin}:`, e); }
             }
          };
          // Run immediately then every 4 mins
          runTestScrape(); 
          setInterval(runTestScrape, 4 * 60 * 1000);
          
          if (shouldUpdateGTFS()) {
            console.log("Loading GTFS data into database...");
            await loadGTFSIntoDatabase();
          }
          console.log("✅ Database initialized successfully");
          
          // Start intervals after DB and functions are ready
          const apiToken = process.env.VITE_METRA_API_TOKEN;
          
          // Real-time updates
          if (apiToken && updateRealtimeData) {
             console.log("⏱️  Starting real-time data polling...");
             // Initial update
             updateRealtimeData(apiToken).catch((err: any) => console.error("Realtime init error:", err));
             
             // Server polling alignment
             const now = new Date();
             const msSinceLast30 = now.getTime() % 30000;
             const msToNextSync = 30000 - msSinceLast30;
             
             setTimeout(() => {
               const syncRealtimeData = async () => {
                 try {
                    await updateRealtimeData(apiToken);
                 } catch (e: any) { console.error("Realtime sync error:", e.message); }
               };
               syncRealtimeData();
               setInterval(syncRealtimeData, 30000);
               console.log("⏱️  Server polling aligned to wall clock (:00/:30)");
             }, msToNextSync);
          }

          // Weather updates - dynamic interval based on active hours
          if (updateWeatherData) {
             console.log("🌦️  Starting weather data polling (dynamic interval)...");
             // Initial update
             updateWeatherData().catch((err: any) => console.error("Weather init error:", err));
             
             // Dynamic scheduling - recalculates interval each time
             const scheduleWeatherUpdate = () => {
               const interval = getWeatherInterval();
               const intervalMin = Math.round(interval / 1000 / 60);
               console.log(`🌦️  Next weather update in ${intervalMin} min (active=${isActiveHours()})`);
               
               setTimeout(() => {
                 console.log("🌦️  Updating weather data...");
                 updateWeatherData().catch((err: any) => console.error("Weather update error:", err.message));
                 scheduleWeatherUpdate(); // Re-schedule with potentially different interval
               }, interval);
             };
             scheduleWeatherUpdate();
          }
        } catch (dbError: any) {
          console.warn("⚠️  Database initialization skipped:", dbError.message);
          console.log("   Server will run without database features (schedule API will use static data)");
        }
      } catch (error: any) {
        console.warn("⚠️  Database setup failed:", error.message);
        console.log("   Server will continue without database features");
      }
    })();



    const fetchData = async (endpoint: string, res: express.Response) => {
      try {
        const axios = (await import("axios")).default;
        const GtfsRealtimeBindings = (await import("gtfs-realtime-bindings")).default;

        const token = process.env.VITE_METRA_API_TOKEN;
        const url = `https://gtfspublic.metrarr.com/gtfs/public/${endpoint}`;

        const response = await axios.get(url, {
          responseType: "arraybuffer",
          params: {
            api_token: token
          }
        });

        const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(response.data));
        
        const body = GtfsRealtimeBindings.transit_realtime.FeedMessage.toObject(feed, {
          longs: String,
          enums: String,
          bytes: String,
        });
        
        res.json(body.entity);
      } catch (error: any) {
        console.error(`Error fetching ${endpoint}:`, error.message);
        res.status(500).json({ error: `Failed to fetch ${endpoint}` });
      }
    };

    // Existing real-time API endpoints
    app.get("/api/positions", (_req, res) => fetchData("positions", res));
    app.get("/api/tripupdates", (_req, res) => fetchData("tripupdates", res));
    app.get("/api/alerts", (_req, res) => fetchData("alerts", res));

    // Line-specific train positions (UP-NW, MD-W, etc.)
    // Cache positions to prevent hitting Metra rate limits with multiple users
    // Note: positionsCache is defined at module level for access by HTML injection

    app.get("/api/positions/:lineId", async (req, res) => {
      try {
        const { lineId } = req.params;
        const validLines = ['UP-NW', 'MD-W', 'UP-N', 'BNSF', 'UP-W'];
        if (!validLines.includes(lineId)) {
          return res.status(400).json({ error: "Invalid line ID" });
        }

        const now = Date.now();
        const cache = positionsCache.get('all');
        
        // Check if we have fresh cached data for ALL lines
        let allTrains: any[] = [];
        
        if (cache && (now - cache.timestamp < POSITIONS_CACHE_TTL)) {
          // Use cached data
          allTrains = cache.data;
        } else {
          // Fetch fresh data from Metra API (SINGLE CALL for all lines)
          const axios = (await import("axios")).default;
          const GtfsRealtimeBindings = (await import("gtfs-realtime-bindings")).default;

          const token = process.env.VITE_METRA_API_TOKEN;
          const url = `https://gtfspublic.metrarr.com/gtfs/public/positions`;

          const response = await axios.get(url, {
            responseType: "arraybuffer",
            params: { api_token: token }
          });

          const feed = GtfsRealtimeBindings.transit_realtime.FeedMessage.decode(new Uint8Array(response.data));
          
          const body = GtfsRealtimeBindings.transit_realtime.FeedMessage.toObject(feed, {
            longs: String,
            enums: String,
            bytes: String,
          });

          // Process ALL trains from all lines (single API parse)
          allTrains = body.entity
            .filter((entity: any) => entity.vehicle?.trip?.routeId && validLines.includes(entity.vehicle.trip.routeId))
            .map((entity: any) => {
              const trainNumber = entity.vehicle?.vehicle?.label || entity.vehicle?.trip?.tripId?.split('_')[1]?.replace(/\D/g, '') || 'Unknown';
              const trainNum = parseInt(trainNumber);
              const direction = !isNaN(trainNum) ? (trainNum % 2 === 0 ? 'inbound' : 'outbound') : 'unknown';
              
              return {
                id: entity.id,
                trainNumber,
                tripId: entity.vehicle?.trip?.tripId,
                routeId: entity.vehicle?.trip?.routeId, // Store route for filtering
                latitude: entity.vehicle?.position?.latitude,
                longitude: entity.vehicle?.position?.longitude,
                bearing: entity.vehicle?.position?.bearing,
                timestamp: entity.vehicle?.timestamp,
                vehicleId: entity.vehicle?.vehicle?.id,
                direction,
              };
            });

          // Update unified cache (stores ALL lines together)
          positionsCache.set('all', {
            data: allTrains,
            timestamp: now
          });
          
          console.log(`[POSITIONS] Bulk cached ${allTrains.length} trains across all lines`);
        }
        
        // Filter for requested line only
        const lineTrains = allTrains.filter((t: any) => t.routeId === lineId);
        
        const responseData = {
          trains: lineTrains,
          timestamp: new Date().toISOString(),
          count: lineTrains.length
        };
        
        res.json(responseData);
      } catch (error: any) {
        console.error(`Error fetching ${req.params.lineId} positions:`, error.message);
        res.status(500).json({ error: `Failed to fetch ${req.params.lineId} positions` });
      }
    });
    
    // Get historical position data
    app.get("/api/positions/history", async (_req, res) => {
      try {
        if (!getDatabase) {
          return res.status(503).json({ error: "Database not available" });
        }
        
        const db = getDatabase();
        const positions = db.prepare(`
          SELECT train_number, trip_id, latitude, longitude, bearing, direction, timestamp, recorded_at
          FROM train_positions
          WHERE recorded_at > datetime('now', '-24 hours')
          ORDER BY recorded_at DESC
          LIMIT 1000
        `).all();
        
        res.json({
          positions,
          count: positions.length
        });
      } catch (error: any) {
        console.error("Error fetching position history:", error.message);
        res.status(500).json({ error: "Failed to fetch position history" });
      }
    });

    // Get rail line shape for map overlay
    app.get("/api/shapes/:lineId", async (req, res) => {
      try {
        const { lineId } = req.params;
        const validLines = ['UP-NW', 'MD-W', 'UP-N', 'BNSF', 'UP-W'];
        if (!validLines.includes(lineId)) {
          return res.status(400).json({ error: "Invalid line ID" });
        }

        const fs = (await import("fs")).default;
        // In production, use cwd-relative path; in dev, use __dirname-relative
        const shapesPath = process.env.NODE_ENV === 'production'
          ? path.resolve(process.cwd(), "server/gtfs/data/shapes.txt")
          : path.resolve(__dirname, "gtfs/data/shapes.txt");
        const shapesData = fs.readFileSync(shapesPath, "utf-8");
        const lines = shapesData.split("\n");
        
        const inboundPoints: Array<[number, number]> = [];
        const outboundPoints: Array<[number, number]> = [];
        
        // Shape IDs in GTFS: UP-NW_IB_1, MD-W_IB_1, etc.
        const ibShapeId = `${lineId}_IB_1`;
        const obShapeId = `${lineId}_OB_1`;
        
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          const [shape_id, lat_str, lng_str] = line.split(",");
          
          if (shape_id === ibShapeId || (lineId === 'MD-W' && shape_id.startsWith('MD-W_IB')) || (lineId === 'BNSF' && shape_id.startsWith('BNSF_IB'))) {
            const lat = parseFloat(lat_str);
            const lng = parseFloat(lng_str);
            if (!isNaN(lat) && !isNaN(lng)) {
              inboundPoints.push([lat, lng]);
            }
          } else if (shape_id === obShapeId || (lineId === 'MD-W' && shape_id.startsWith('MD-W_OB')) || (lineId === 'BNSF' && shape_id.startsWith('BNSF_OB'))) {
            const lat = parseFloat(lat_str);
            const lng = parseFloat(lng_str);
            if (!isNaN(lat) && !isNaN(lng)) {
              outboundPoints.push([lat, lng]);
            }
          }
        }
        
        res.json({
          inbound: inboundPoints,
          outbound: outboundPoints
        });
      } catch (error: any) {
        console.error("Error loading rail shapes:", error.message);
        res.status(500).json({ error: "Failed to load rail shapes" });
      }
    });

    // New schedule API endpoints
    app.get("/api/schedule", (req, res) => {
      try {
        if (!getAllSchedules) {
          return res.status(503).json({ error: "Database not available. Using static schedule data." });
        }
        const { station, terminal } = req.query;
        const stationId = typeof station === 'string' ? station : 'PALATINE';
        const terminalId = typeof terminal === 'string' ? terminal : 'OTC';
        const schedules = getAllSchedules(stationId, terminalId);
        res.json(schedules);
      } catch (error: any) {
        console.error("Error fetching schedule:", error.message);
        res.status(500).json({ error: "Failed to fetch schedule" });
      }
    });

    app.get("/api/schedule/:dayType", (req, res) => {
      try {
        const { dayType } = req.params;
        const { station } = req.query;
        
        if (!['weekday', 'saturday', 'sunday'].includes(dayType)) {
          return res.status(400).json({ error: "Invalid day type" });
        }
        if (!getAllSchedules) {
          return res.status(503).json({ error: "Database not available" });
        }
        const stationId = typeof station === 'string' ? station : 'PALATINE';
        const terminalId = typeof req.query.terminal === 'string' ? req.query.terminal : 'OTC';
        const schedules = getAllSchedules(stationId, terminalId);
        res.json(schedules[dayType as keyof typeof schedules]);
      } catch (error: any) {
        console.error("Error fetching schedule:", error.message);
        res.status(500).json({ error: "Failed to fetch schedule" });
      }
    });

    app.get("/api/next-train", (req, res) => {
      try {
        const { direction, dayType, currentTime, station } = req.query;
        if (!direction || !dayType || !currentTime) {
          return res.status(400).json({ error: "Missing required parameters" });
        }
        if (!getNextTrain) {
          return res.status(503).json({ error: "Database not available" });
        }
        
        const timeMinutes = typeof currentTime === 'string' && currentTime.includes(':')
          ? (() => {
              const [h, m] = currentTime.split(':').map(Number);
              return h * 60 + m;
            })()
          : parseInt(currentTime as string);
        
        const stationId = typeof station === 'string' ? station : 'PALATINE';
        const terminalId = typeof req.query.terminal === 'string' ? req.query.terminal : 'OTC';
        const next = getNextTrain(
          direction as 'inbound' | 'outbound',
          timeMinutes,
          dayType as 'weekday' | 'saturday' | 'sunday',
          stationId,
          terminalId
        );
        
        res.json({ train: next });
      } catch (error: any) {
        console.error("Error fetching next train:", error.message);
        res.status(500).json({ error: "Failed to fetch next train" });
      }
    });

    app.get("/api/trip-schedule/:tripId", async (req, res) => {
      try {
        const { tripId } = req.params;
        if (!tripId) {
          return res.status(400).json({ error: "Missing tripId" });
        }

        let db;
        try {
          const { getDatabase } = await import("./db/schema.js");
          db = getDatabase();
        } catch (e) {
          return res.status(503).json({ error: "Database not available" });
        }
        
        const schedule = db.prepare(`
          SELECT 
            s.stop_id,
            s.stop_sequence,
            s.arrival_time,
            s.departure_time,
            r.delay_seconds,
            r.predicted_arrival,
            r.predicted_departure
          FROM schedules s
          LEFT JOIN (
            SELECT trip_id, stop_id, delay_seconds, predicted_arrival, predicted_departure, MAX(update_timestamp)
            FROM realtime_updates
            GROUP BY trip_id, stop_id
          ) r ON s.trip_id = r.trip_id AND s.stop_id = r.stop_id
          WHERE s.trip_id = ?
          ORDER BY s.stop_sequence ASC
        `).all(tripId);
        
        res.json({ schedule });
      } catch (error: any) {
        console.error("Error fetching trip schedule:", error.message);
        res.status(500).json({ error: "Failed to fetch trip schedule" });
      }
    });

    app.get("/api/delays", (_req, res) => {
      try {
        if (!getAllDelays) {
          return res.json({ delays: [] });
        }
        const delays = getAllDelays();
        res.json({ delays });
      } catch (error: any) {
        console.error("Error fetching delays:", error.message);
        res.json({ delays: [] });
      }
    });

    type CrowdingLevel = 'low' | 'some' | 'moderate' | 'high';

    // Weather API endpoint
    app.get("/api/weather", (_req, res) => {
      try {
        if (!getAllWeather) {
           return res.json({ weather: [] });
        }
        const weather = getAllWeather();
        res.json({ weather });
      } catch (error: any) {
        console.error("Error fetching weather:", error.message);
        res.status(500).json({ error: "Failed to fetch weather" });
      }
    });

    // Fetch crowding data from Metra's website
    app.get("/api/crowding", async (req, res) => {
      const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
      const startTime = Date.now();
      
      console.log(`\n🎯 [CROWDING API] [${requestId}] Request received`);
      console.log(`   Origin: ${req.query.origin || 'PALATINE'}`);
      console.log(`   Destination: ${req.query.destination || 'OTC'}`);
      console.log(`   Line: ${req.query.line || 'UP-NW'}`);
      console.log(`   Force refresh: ${req.query.force}`);
      
      // Set a timeout for the response (60 seconds should be enough for scraping)
      // Railway has a 60s request timeout, so we set ours slightly lower
      const timeout = setTimeout(() => {
        if (!res.headersSent) {
          const elapsed = Date.now() - startTime;
          console.error(`[API TIMEOUT] [${requestId}] Request timed out after ${elapsed}ms for ${req.query.origin}->${req.query.destination}`);
          try {
            res.status(504).json({ 
              error: 'Request timeout', 
              crowding: [],
              requestId 
            });
          } catch (timeoutError: any) {
            console.error(`[API TIMEOUT ERROR] [${requestId}] Failed to send timeout response: ${timeoutError.message}`);
          }
        }
      }, 55000); // 55 seconds to avoid Railway's 60s timeout
      
      // Clear timeout when response is sent, and cache crowding data for HTML injection
      const clearTimeoutAndSend = (data: any) => {
        clearTimeout(timeout);
        const elapsed = Date.now() - startTime;
        
        // Store crowding data in memory cache for instant page loads
        if (data?.crowding && data.crowding.length > 0) {
          crowdingCache.set(cacheKey, {
            data: data.crowding,
            timestamp: Date.now()
          });
        }
        
        if (!res.headersSent) {
          try {
            console.log(`[API] [${requestId}] Sending response after ${elapsed}ms (${data?.crowding?.length || 0} entries)`);
            return res.json({ ...data, requestId, responseTime: elapsed });
          } catch (sendError: any) {
            console.error(`[API SEND ERROR] [${requestId}] Failed to send response after ${elapsed}ms: ${sendError.message}`);
            return;
          }
        } else {
          console.warn(`[API WARNING] [${requestId}] Response already sent after ${elapsed}ms for ${req.query.origin}->${req.query.destination}`);
        }
      };
      
      let browser: any = null;
      let db: any = null;
      const { origin = 'PALATINE', destination = 'OTC', force, line = 'UP-NW' } = req.query;
      const lineId = typeof line === 'string' ? line : 'UP-NW';
      const cacheKey = `${origin}_${destination}_${lineId}`;
      
      try {
        const forceRefresh = force === 'true' || force === '1';
        const { getDatabase } = await import("./db/schema.js");
        db = getDatabase();

        // Debug: Check if DB has the new columns
        try {
           // We don't select * to avoid performance hit, just check one new column
           const check = db.prepare("SELECT predicted_departure FROM crowding_cache LIMIT 1").get();
           console.log("[DB] Schema check passed: 'predicted_departure' column exists.");
        } catch (e: any) {
           console.error("[DB] 🚨 SCHEMA ERROR: crowding_cache table is missing new columns! Migration failed or didn't run.", e.message);
        }

        const formatCachedData = (cachedData: Array<{
          trip_id: string;
          crowding: string | null;
          scheduled_departure?: string | null;
          predicted_departure?: string | null;
          scheduled_arrival?: string | null;
          predicted_arrival?: string | null;
          updated_at: string;
        }>) => {
          const crowding = cachedData
            .filter(item => item.crowding)
            .map(item => ({ 
              trip_id: item.trip_id, 
              crowding: item.crowding as CrowdingLevel,
              scheduled_departure: item.scheduled_departure || null,
              predicted_departure: item.predicted_departure || null,
              scheduled_arrival: item.scheduled_arrival || null,
              predicted_arrival: item.predicted_arrival || null
            }));
          
          return { crowding };
        };
        
        if (!forceRefresh) {
          // Dynamic cache TTL: 1 hour during active hours, 4 hours off-hours
          const cacheTTLMinutes = Math.round(getCrowdingCacheTTL() / 1000 / 60);
          const cachedData = db.prepare(`
            SELECT trip_id, crowding, 
                   scheduled_departure, predicted_departure,
                   scheduled_arrival, predicted_arrival, updated_at
            FROM crowding_cache
            WHERE origin = ? AND destination = ?
              AND updated_at > datetime('now', '-' || ? || ' minutes')
          `).all(origin, destination, cacheTTLMinutes) as Array<{
            trip_id: string;
            crowding: string | null;
            scheduled_departure: string | null;
            predicted_departure: string | null;
            scheduled_arrival: string | null;
            predicted_arrival: string | null;
            updated_at: string;
          }>;
          
          if (cachedData.length > 0) {
            const result = formatCachedData(cachedData);
            // Append 'Z' to treat database timestamp (UTC) as UTC
            const cacheAge = Math.round((Date.now() - new Date(cachedData[0].updated_at + 'Z').getTime()) / 1000 / 60);
            console.log(`✅ [CROWDING API] Cache HIT - Returning ${result.crowding.length} trains (${cacheAge} min old)`);
            console.log(`   First 3 trains: ${result.crowding.slice(0, 3).map((t: any) => `${t.trip_id}:${t.crowding}`).join(', ')}`);
            return clearTimeoutAndSend(result);
          }
          
          console.log(`❌ [CROWDING API] Cache MISS - No fresh data (will scrape or use stale)`);
        }
        
        if (scrapingLocks.has(cacheKey)) {
          console.log(`⏳ [CROWDING API] Scraping in progress for ${cacheKey}, waiting...`);
          try {
            const result = await scrapingLocks.get(cacheKey);
            console.log(`✅ [CROWDING API] Got result from ongoing scrape: ${result?.crowding?.length || 0} trains`);
            return clearTimeoutAndSend(result);
          } catch (lockError: any) {
            console.warn(`⚠️ [CROWDING API] Lock wait failed: ${lockError.message}`);
          }
        }
        
        const staleCache = db.prepare(`
          SELECT trip_id, crowding, 
                 scheduled_departure, predicted_departure,
                 scheduled_arrival, predicted_arrival, updated_at
          FROM crowding_cache
          WHERE origin = ? AND destination = ?
            AND updated_at > datetime('now', '-24 hours')
          ORDER BY updated_at DESC
          LIMIT 100
        `).all(origin, destination) as Array<{
          trip_id: string;
          crowding: string | null;
          scheduled_departure: string | null;
          predicted_departure: string | null;
          scheduled_arrival: string | null;
          predicted_arrival: string | null;
          updated_at: string;
        }>;
        
        console.log(`[CACHE MISS] No fresh cache (< 5 min) for ${origin}->${destination}, checking stale cache or scraping...`);
        
        // Log stale cache availability
        if (staleCache.length > 0) {
          const oldestAge = Math.round((Date.now() - new Date(staleCache[staleCache.length - 1].updated_at).getTime()) / 1000 / 60);
          const newestAge = Math.round((Date.now() - new Date(staleCache[0].updated_at).getTime()) / 1000 / 60);
          console.log(`[CACHE] Stale cache available: ${staleCache.length} entries (${newestAge}-${oldestAge} min old) - will use if scraping fails`);
        } else {
          console.log(`[CACHE] No stale cache available for ${origin}->${destination}`);
        }
        
        // Use reusable function for both API and scheduled scrapes
        const scrapePromise = scrapeAndCacheCrowding(
          origin as string, 
          destination as string, 
          lineId as string,
          'API'
        );
        
        scrapingLocks.set(cacheKey, scrapePromise);
        
        try {
          console.log(`[API] [${requestId}] Waiting for scraping promise to complete for ${origin}->${destination}...`);
          const result = await scrapePromise;
          console.log(`[API] [${requestId}] Scraping completed for ${origin}->${destination}, result has ${result?.crowding?.length || 0} entries`);
          scrapingLocks.delete(cacheKey);
          console.log(`[API] [${requestId}] Sending JSON response for ${origin}->${destination}...`);
          return clearTimeoutAndSend(result);
        } catch (scrapeError: any) {
          const elapsed = Date.now() - startTime;
          console.error(`[API ERROR] [${requestId}] Scraping failed after ${elapsed}ms for ${origin}->${destination}: ${scrapeError.message}`);
          console.error(`[API ERROR] [${requestId}] Stack: ${scrapeError.stack}`);
          scrapingLocks.delete(cacheKey);
          
          const isDetachmentError = scrapeError.message.includes('detached') || 
                                    scrapeError.message.includes('disconnected') || 
                                    scrapeError.message.includes('Target closed') ||
                                    scrapeError.message.includes('Session closed');
          
          if (isDetachmentError) {
            console.warn(`Scraping interrupted for ${origin}->${destination} (browser detached - likely server restart)`);
          } else {
            console.error(`Scraping failed for ${origin}->${destination}:`, scrapeError.message);
          }
          
          if (staleCache.length > 0) {
            const oldestEntry = staleCache[staleCache.length - 1];
            const ageHours = Math.round((Date.now() - new Date(oldestEntry.updated_at).getTime()) / (1000 * 60 * 60));
            console.log(`[CROWDING] Scraping failed for ${origin}->${destination}, falling back to stale cache (${staleCache.length} entries, ~${ageHours}h old)`);
            const result = formatCachedData(staleCache);
            return clearTimeoutAndSend(result);
          }
          
          console.warn(`[CROWDING] No data available for ${origin}->${destination} (scraping failed, no stale cache)`);
          return clearTimeoutAndSend({ crowding: [] });
        }
      } catch (error: any) {
        const elapsed = Date.now() - startTime;
        console.error(`[API ERROR] [${requestId}] Error fetching crowding data after ${elapsed}ms for ${origin}->${destination}:`, error.message);
        console.error(`[API ERROR] [${requestId}] Stack: ${error.stack}`);
        return clearTimeoutAndSend({ crowding: [], error: error.message, requestId });
      } finally {
        // Ensure timeout is cleared
        clearTimeout(timeout);
        const elapsed = Date.now() - startTime;
        console.log(`[API] [${requestId}] Request completed in ${elapsed}ms`);
      }
    });

    // Get historical delays for a specific date
    app.get("/api/historical-delays/:date", async (req, res) => {
      try {
        const { date } = req.params;
        const { getHistoricalDelays } = await import("./db/historical-api.js");
        const delays = getHistoricalDelays(date);
        res.json({ delays });
      } catch (error: any) {
        console.error("Error fetching historical delays:", error.message);
        res.json({ delays: [] });
      }
    });

    // Manual real-time refresh endpoint
    app.post("/api/refresh-realtime", async (_req, res) => {
      try {
        const token = process.env.VITE_METRA_API_TOKEN;
        if (!token) {
          return res.status(500).json({ error: "API token not configured" });
        }
        
        try {
          const { getDatabase } = await import("./db/schema.js");
          const db = getDatabase();
          db.prepare(`
            UPDATE crowding_cache 
            SET updated_at = datetime('now', '-2 hours')
            WHERE updated_at > datetime('now', '-24 hours')
          `).run();
          console.log("Crowding cache marked as stale - will refresh on next request (old data kept as fallback)");
        } catch (cacheError: any) {
          console.warn("Could not mark cache as stale:", cacheError.message);
        }
        
        if (!updateRealtimeData) {
          return res.json({ success: true, message: "Refresh requested (database unavailable)", timestamp: new Date().toISOString() });
        }
        try {
          await updateRealtimeData(token);
          
          const { getDatabase: getDbForTimestamp } = await import("./db/schema.js");
          const dbForTimestamp = getDbForTimestamp();
          const result = dbForTimestamp.prepare(`
            SELECT MAX(update_timestamp) as last_update 
            FROM realtime_updates
          `).get() as { last_update: string | null } | undefined;
          
          const timestamp = result?.last_update 
            ? new Date(result.last_update + 'Z').toISOString()
            : new Date().toISOString();
          
          res.json({ success: true, message: "Real-time data refreshed", timestamp });
        } catch (dbError: any) {
          console.warn("Database update failed:", dbError.message);
          res.json({ success: true, message: "API data fetched (database unavailable)", timestamp: new Date().toISOString() });
        }
      } catch (error: any) {
        console.error("Error refreshing real-time data:", error.message);
        res.status(500).json({ error: "Failed to refresh real-time data", message: error.message });
      }
    });

    // Get last update time
    app.get("/api/realtime-status", async (_req, res) => {
      try {
        const { getDatabase } = await import("./db/schema.js");
        const db = getDatabase();
        const result = db.prepare(`
          SELECT MAX(update_timestamp) as last_update 
          FROM realtime_updates
        `).get() as { last_update: string | null } | undefined;
        
        const lastUpdate = result?.last_update 
          ? new Date(result.last_update + 'Z').toISOString()
          : null;
        
        res.json({ 
          last_update: lastUpdate,
          auto_refresh_interval: 60
        });
      } catch (error: any) {
        res.json({ 
          last_update: null,
          auto_refresh_interval: 60
        });
      }
    });

    // Manual GTFS reload endpoint
    app.post("/api/reload-gtfs", async (_req, res) => {
      try {
        if (!loadGTFSIntoDatabase) {
          return res.status(503).json({ error: "Database not available" });
        }
        await loadGTFSIntoDatabase();
        res.json({ success: true, message: "GTFS data reloaded" });
      } catch (error: any) {
        console.error("Error reloading GTFS:", error.message);
        res.status(500).json({ error: "Failed to reload GTFS data" });
      }
    });

    // Error handler for invalid URL encoding
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof URIError && err.message.includes('Failed to decode param')) {
        return res.status(404).end();
      }
      next(err);
    });

    // Filter out invalid URLs
    app.use((req, res, next) => {
      if (req.url.includes('%VITE_') || req.url.includes('%PUBLIC_') || req.url.includes('umami')) {
        return res.status(404).end();
      }
      next();
    });

    app.use(express.static(staticPath));

    // Error handler for URI decode errors
    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof URIError && err.message.includes('Failed to decode param')) {
        return res.status(404).end();
      }
      next(err);
    });

    // Handle client-side routing - inject initial data for instant page loads
    app.get("*", async (_req, res) => {
      try {
        // Read the HTML file
        const htmlPath = path.join(staticPath, "index.html");
        let html = fs.readFileSync(htmlPath, 'utf8');
        
        // Gather initial data (use cached data from server memory)
        const initialData: Record<string, any> = {};
        
        // Get schedule data for default station (PALATINE)
        try {
          if (getAllSchedules) {
            initialData.schedules = {
              PALATINE: getAllSchedules('PALATINE'),
              SCHAUM: getAllSchedules('SCHAUM'),
              WILMETTE: getAllSchedules('WILMETTE')
            };
          }
        } catch (e) {
          console.debug('Could not pre-load schedules:', e);
        }
        
        // Get weather data
        try {
          if (getAllWeather) {
            initialData.weather = getAllWeather();
          }
        } catch (e) {
          console.debug('Could not pre-load weather:', e);
        }
        
        // Get cached train positions (from memory cache)
        try {
          if (positionsCache.size > 0) {
            initialData.positions = {};
            positionsCache.forEach((data: { data: any; timestamp: number }, lineId: string) => {
              initialData.positions[lineId] = data.data;
            });
          }
        } catch (e) {
          console.debug('Could not pre-load positions:', e);
        }
        
        // Get crowding data (prefer memory cache, fallback to database for cold starts)
        try {
          initialData.crowding = {};
          
          if (crowdingCache.size > 0) {
            // Use in-memory cache if available
            crowdingCache.forEach((cached, routeKey) => {
              initialData.crowding[routeKey] = cached.data;
            });
          } else if (getDatabase) {
            // Cold start: Load from database for common routes
            const db = getDatabase();
            if (db) {
              const commonRoutes = [
                { origin: 'PALATINE', dest: 'OTC', line: 'UP-NW' },
                { origin: 'OTC', dest: 'PALATINE', line: 'UP-NW' },
                { origin: 'SCHAUM', dest: 'CUS', line: 'MD-W' },
                { origin: 'CUS', dest: 'SCHAUM', line: 'MD-W' },
                { origin: 'WILMETTE', dest: 'OTC', line: 'UP-N' },
                { origin: 'OTC', dest: 'WILMETTE', line: 'UP-N' },
                { origin: 'WESTMONT', dest: 'CUS', line: 'BNSF' },
                { origin: 'CUS', dest: 'WESTMONT', line: 'BNSF' }
              ];
              
              for (const route of commonRoutes) {
                const cacheKey = `${route.origin}_${route.dest}_${route.line}`;
                const crowdingData = db.prepare(`
                  SELECT trip_id, crowding, scheduled_departure, predicted_departure,
                         scheduled_arrival, predicted_arrival
                  FROM crowding_cache
                  WHERE origin = ? AND destination = ?
                    AND updated_at > datetime('now', '-4 hours')
                `).all(route.origin, route.dest);
                
                if (crowdingData.length > 0) {
                  initialData.crowding[cacheKey] = crowdingData;
                }
              }
              console.log(`[COLD START] Pre-loaded ${Object.keys(initialData.crowding).length} routes from DB`);
            }
          }
        } catch (e) {
          console.debug('Could not pre-load crowding:', e);
        }
        
        // Inject the data into HTML before </head>
        const dataScript = `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};</script>`;
        html = html.replace('</head>', `${dataScript}\n</head>`);
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (e) {
        // Fallback to static file if anything fails
        res.sendFile(path.join(staticPath, "index.html"));
      }
    });

    const port = Number(process.env.PORT) || 3001;

    const tryKillPort = async (port: number) => {
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec) as (command: string) => Promise<{ stdout: string; stderr: string }>;
        
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const { stdout } = await execAsync(`lsof -ti:${port}`);
            const pid = stdout.trim();
            if (pid) {
              console.log(`⚠️  Port ${port} is in use (PID: ${pid}), attempting to free it (attempt ${attempt}/3)...`);
              await execAsync(`kill -9 ${pid}`);
              await new Promise<void>(resolve => setTimeout(resolve, 500));
              
              try {
                await execAsync(`lsof -ti:${port}`);
              } catch {
                console.log(`✅ Port ${port} freed`);
                return;
              }
            } else {
              return;
            }
          } catch {
            return;
          }
        }
      } catch (error: any) {
        console.log(`⚠️  Could not automatically free port ${port}, will try to bind anyway`);
      }
    };

    for (let i = 0; i < 3; i++) {
      await tryKillPort(port);
      await new Promise<void>(resolve => setTimeout(resolve, 500));
      
      try {
        const { exec } = await import('child_process');
        const { promisify } = await import('util');
        const execAsync = promisify(exec) as (command: string) => Promise<{ stdout: string; stderr: string }>;
        await execAsync(`lsof -ti:${port}`);
        if (i < 2) {
          console.log(`Port ${port} still in use, retrying cleanup...`);
          continue;
        }
      } catch {
        break;
      }
    }
    
    await new Promise(resolve => setTimeout(resolve, 500));

    server.listen(port, () => {
      console.log(`✅ Backend server running on http://localhost:${port}/`);
      console.log(`📡 API endpoints available at http://localhost:${port}/api/*`);
    });
    
    server.on('error', (error: any) => {
      if (error.code === 'EADDRINUSE') {
        console.error(`❌ Port ${port} is still in use after cleanup attempts.`);
        console.error(`   Try manually: lsof -ti:${port} | xargs kill -9`);
        console.error(`   Or use a different port: PORT=3001 pnpm dev`);
        process.exit(1);
      } else {
        console.error('Server error:', error);
      }
    });
  } catch (error: any) {
    console.error('❌ Failed to start server:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

startServer().catch((error) => {
  console.error('❌ Fatal error starting server:', error);
  process.exit(1);
});
