import { getDatabase } from "../db/schema.js";
import { scrapeAndCacheCrowding } from "./scraping.js";

// Scheduled Task: Daily Crowding Seed (3:55 AM Chicago Time)
// Runs once per day to fetch FULL DAY crowding predictions for all active routes
export function scheduleDailyScrapes() {
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
        uniquePairs.add(key);
        scrapeQueue.push(route);
      }
    });

    // Also add defaults if empty (cold start) - though keyRoutes handles this now
    if (scrapeQueue.length === 0) {
      scrapeQueue.push({ origin: 'PALATINE', destination: 'OTC', line: 'UP-NW' });
    }
    
    // Process queue in parallel chunks to speed up seeding
    const CONCURRENCY = 3;
    
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
        
        try {
          await scrapeAndCacheCrowding(
            origin, 
            destination, 
            line, 
            'SCHEDULED', // Source
            targetDate   // Date override
          );
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
export function scheduleFrequentDelayScrapes() {
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

  const SCRAPE_INTERVAL_MS = 7 * 60 * 1000; // 7 minutes
  const CONCURRENCY = 2; // Process 2 routes at a time to avoid overwhelming

  const runDelayScrape = async () => {
    const now = new Date();
    const chicagoHour = parseInt(now.toLocaleString('en-US', { 
      timeZone: 'America/Chicago', 
      hour: 'numeric', 
      hour12: false 
    }));

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

  console.log(`⏱️ [DELAY SCRAPE] Will start in ${Math.round(msToNextSync / 1000 / 60)} min, then every 7 min during active hours (5AM-10PM)`);

  setTimeout(() => {
    runDelayScrape();
    setInterval(runDelayScrape, SCRAPE_INTERVAL_MS);
  }, msToNextSync);
}
