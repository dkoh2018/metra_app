import { getSharedBrowser, globalScrapeQueue, resetSharedBrowser } from "./browser.js";
import type { Browser } from "puppeteer";
import type { CrowdingLevel } from "../types.js";

// Track ongoing scraping operations to prevent concurrent scrapes
const scrapingLocks = new Map<string, Promise<any>>();

export const scrapeStats = {
  totalAttempts: 0,
  successCount: 0,
  failCount: 0,
  lastFailReason: '',
  failedRoutes: new Set<string>(),
  successfulRoutes: new Set<string>(),
  get successRate() {
    return this.totalAttempts > 0 
      ? Math.round((this.successCount / this.totalAttempts) * 100) 
      : 0;
  }
};

// Circuit Breaker State (Global)
const circuitBreaker = {
  failures: 0,
  maxFailures: 5,
  trippedUntil: 0, // Timestamp
  cooldownMs: 30 * 60 * 1000, // 30 minutes
  
  get isOpen() {
    return Date.now() < this.trippedUntil;
  },
  
  trip() {
    this.trippedUntil = Date.now() + this.cooldownMs;
    console.error(`💥 [CIRCUIT BREAKER] Tripped! Pausing scrapes for ${this.cooldownMs / 1000 / 60} minutes.`);
  },
  
  reset() {
    if (this.failures > 0) {
      console.log("😌 [CIRCUIT BREAKER] Resetting failure count.");
      this.failures = 0;
      this.trippedUntil = 0;
    }
  },
  
  recordFailure() {
    this.failures++;
    console.warn(`⚠️ [CIRCUIT BREAKER] Failure ${this.failures}/${this.maxFailures}`);
    if (this.failures >= this.maxFailures) {
      this.trip();
    }
  }
};

// Reusable scraping function for both API requests and scheduled background tasks
export async function scrapeAndCacheCrowding(
  origin: string, 
  destination: string, 
  lineId: string, 
  source: string = 'API',
  dateOverride?: Date
) {
  const cacheKey = `${origin}_${destination}_${lineId}`;

  // Check if a scrape is already in progress
  if (scrapingLocks.has(cacheKey)) {
    return scrapingLocks.get(cacheKey);
  }

  // Check Circuit Breaker
  if (circuitBreaker.isOpen) {
    const remainingMin = Math.ceil((circuitBreaker.trippedUntil - Date.now()) / 60000);
    console.warn(`🛑 [CIRCUIT BREAKER] Scraping paused for ${remainingMin}m due to repeated crashes: ${origin}->${destination}`);
    throw new Error(`Circuit Breaker Open: Scraping paused for ${remainingMin}m`);
  }

  const scrapePromise = (async () => {
    let page: any = null;
    let browser: Browser | null = null;
    
    // Acquire concurrency slot
    await globalScrapeQueue.acquire();
    
    try {
      // Get the SHARED browser (lazy loads if needed)
      browser = await getSharedBrowser();
      
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
        
        scheduleDate = Math.floor(targetDate.getTime() / 1000);
      }
      
      const { getMetraScheduleUrl } = await import("@shared/metra-urls");
      
      const url = getMetraScheduleUrl({
        origin: String(origin),
        destination: String(destination),
        line: String(lineId),
        date: scheduleDate * 1000 
      });
      
      // Open a TAB (Page), not a new Browser
      page = await browser.newPage();
      
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
      
      // Track HTTP responses to detect WAF blocks
      let httpStatus = 0;
      let wasBlocked = false;
      
      page.on('response', (response: any) => {
        if (response.url().includes('metra.com/schedules')) {
          httpStatus = response.status();
          if (httpStatus === 403) {
            wasBlocked = true;
            console.error(`🚫 [WAF_BLOCK] HTTP 403 received for ${origin}->${destination}`);
          }
        }
      });
      
      // Navigate
      console.log(`[SCRAPE] 🌐 Navigating to Metra... (attempt #${scrapeStats.totalAttempts + 1})`);
      const navStartTime = Date.now();
      await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
      const navEndTime = Date.now();
      
      // Check if page loaded correctly
      const pageTitle = await page.title();
      console.log(`[TIMING] ⏱️ Navigation took ${navEndTime - navStartTime}ms for ${origin}->${destination}`);
      
      // Detect WAF block page
      if (pageTitle.includes('ERROR') || pageTitle.includes('Request could not be satisfied') || wasBlocked) {
        scrapeStats.totalAttempts++;
        scrapeStats.failCount++;
        scrapeStats.lastFailReason = `WAF_BLOCK (HTTP ${httpStatus})`;
        scrapeStats.failedRoutes.add(`${origin}->${destination}`);
        console.error(`🚫 [SCRAPE] WAF BLOCKED: ${origin}->${destination} (HTTP ${httpStatus})`);
        console.log(`📊 [STATS] Success Rate: ${scrapeStats.successRate}% (${scrapeStats.successCount}/${scrapeStats.totalAttempts})`);
        throw new Error(`WAF blocked request (HTTP ${httpStatus})`);
      }
      
      // TIMING DIAGNOSTICS: Track how long it takes for .trip-row to appear
      const selectorWaitStart = Date.now();
      let selectorFound = false;
      
      await page.waitForSelector('.trip-row', { timeout: 34000 })
        .then(() => {
          selectorFound = true;
          const selectorWaitEnd = Date.now();
          console.log(`[TIMING] ✅ .trip-row appeared after ${selectorWaitEnd - selectorWaitStart}ms for ${origin}->${destination}`);
        })
        .catch(() => {
          const selectorWaitEnd = Date.now();
          console.warn(`[TIMING] ❌ .trip-row TIMEOUT after ${selectorWaitEnd - selectorWaitStart}ms for ${origin}->${destination}`);
        });
      
      // DIAGNOSTIC: If selector timed out, check if elements appeared AFTER timeout
      // This helps us understand if we just need a longer timeout
      if (!selectorFound) {
        // Wait an extra 5 seconds and check again
        console.log(`[TIMING] 🔍 Checking if .trip-row appears with extended wait...`);
        await new Promise(r => setTimeout(r, 5000));
        const tripRowCount = await page.$$eval('.trip-row', (rows: Element[]) => rows.length);
        console.log(`[TIMING] 🔍 After +5s extra wait: Found ${tripRowCount} .trip-row elements for ${origin}->${destination}`);
        if (tripRowCount > 0) {
          console.log(`[TIMING] 💡 RECOMMENDATION: Increase timeout! Data appeared after ${Date.now() - selectorWaitStart}ms total`);
        }
      }
      
      // Extract data (Same logic as before)
      const extractedData = await page.evaluate((scrapeOrigin: string, scrapeDest: string, scheduleDate: number) => {
        type ClientCrowdingLevel = 'low' | 'some' | 'moderate' | 'high';
        
        const resultsMap = new Map<string, any>();
        
        // Crowding extraction
        const tripRows = Array.from(document.querySelectorAll('.trip-row'));
        
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
        
        stopCells.forEach((cell: Element) => {
           const stopText = cell.querySelector('.stop--text');
           const strikeOut = stopText?.querySelector('.strike-out');
           
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
        
        const results = Array.from(resultsMap.values());
        
        return { crowding: results };
      }, origin, destination, scheduleDate);

      if (!extractedData || !extractedData.crowding) {
        console.error(`[${source}] ❌ Extraction failed - no crowding data returned`);
        throw new Error('No crowding data extracted');
      }

      // Save to Database (UPSERT)
      const { getDatabase } = await import("../db/schema.js");
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
           
           extractedData.crowding.forEach((item: any) => {
             insert.run(
               origin, destination, item.trip_id, item.crowding,
               item.scheduled_departure, item.estimated_departure,
               item.scheduled_arrival, item.estimated_arrival
             );
           });
         });
         transaction();
      }

      if (extractedData.crowding.length === 0) {
        scrapeStats.totalAttempts++;
        scrapeStats.failCount++;
        scrapeStats.lastFailReason = 'NO_DATA_EXTRACTED';
        scrapeStats.failedRoutes.add(`${origin}->${destination}`);
        console.warn(`[SCRAPE] ⚠️ No crowding data extracted for ${origin}->${destination}`);
        console.log(`📊 [STATS] Success Rate: ${scrapeStats.successRate}% (${scrapeStats.successCount}/${scrapeStats.totalAttempts})`);
        throw new Error('No crowding data extracted from Metra website');
      }
      
      // SUCCESS! Track it
      scrapeStats.totalAttempts++;
      scrapeStats.successCount++;
      scrapeStats.successfulRoutes.add(`${origin}->${destination}`);
      console.log(`✅ [SCRAPE] SUCCESS: ${origin}->${destination} (${extractedData.crowding.length} trains)`);
      console.log(`📊 [STATS] Success Rate: ${scrapeStats.successRate}% (${scrapeStats.successCount}/${scrapeStats.totalAttempts})`);
      
      // Reset Circuit Breaker on success
      circuitBreaker.reset();
      
      // Only close the PAGE, not the browser
      await page.close();
      page = null;
      
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
      if (page) await page.close().catch(() => {});
      console.error(`[${source}] Scraping failed:`, error.message);
      
      // If the browser crashed/disconnected, force a reset
      if (error.message.includes("Session closed") || error.message.includes("Target closed") || error.message.includes("Protocol error")) {
         console.warn("⚠️ [BROWSER] Browser appears to have crashed. Resetting instance.");
         
         // Critical failure - record it
         circuitBreaker.recordFailure();
         
         await resetSharedBrowser();
      }
      
      throw error;
    } finally {
       // ALWAYS RELEASE THE SLOT
       globalScrapeQueue.release();
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
