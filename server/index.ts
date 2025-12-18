import express from "express";
import { createServer } from "http";
import path from "path";
import fs from "fs";
import { Browser, ChromeReleaseChannel, computeExecutablePath, install, resolveBuildId } from "@puppeteer/browsers";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

// Database imports are lazy-loaded to allow server to start without database
let getAllSchedules: any, getNextTrain: any, shouldUpdateGTFS: any;
let getAllDelays: any, updateRealtimeData: any;
let loadGTFSIntoDatabase: any;
let getDatabase: any;

// Track ongoing scraping operations to prevent concurrent scrapes
const scrapingLocks = new Map<string, Promise<any>>();

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
      const buildId = await resolveBuildId(Browser.CHROME, ChromeReleaseChannel.STABLE);
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
      }

      chromeExecutablePath = executablePath;
      chromeAvailable = true;
      return executablePath;
    } catch (resolveError: any) {
      console.warn("⚠️  Chrome not available - crowding data will be disabled");
      console.warn("   Reason:", resolveError.message);
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
          const realtimeModule = await import("./db/realtime-updater.js");
          const loaderModule = await import("./db/gtfs-loader.js");
          
          // Assign to module-level variables
          getDatabase = dbModule.getDatabase;
          getAllSchedules = scheduleModule.getAllSchedules;
          getNextTrain = scheduleModule.getNextTrain;
          shouldUpdateGTFS = scheduleModule.shouldUpdateGTFS;
          getAllDelays = realtimeModule.getAllDelays;
          updateRealtimeData = realtimeModule.updateRealtimeData;
          loadGTFSIntoDatabase = loaderModule.loadGTFSIntoDatabase;
          
          // Initialize database schema
          const { initDatabase } = dbModule;
          initDatabase();
          
          if (shouldUpdateGTFS()) {
            console.log("Loading GTFS data into database...");
            await loadGTFSIntoDatabase();
          }
          console.log("✅ Database initialized successfully");
        } catch (dbError: any) {
          console.warn("⚠️  Database initialization skipped:", dbError.message);
          console.log("   Server will run without database features (schedule API will use static data)");
        }
      } catch (error: any) {
        console.warn("⚠️  Database setup failed:", error.message);
        console.log("   Server will continue without database features");
      }
    })();

    // Real-time update interval (every 60 seconds) - only if database is available
    const apiToken = process.env.VITE_METRA_API_TOKEN;
    if (apiToken) {
      const syncRealtimeData = async () => {
        if (updateRealtimeData) {
          try {
            await updateRealtimeData(apiToken);
          } catch (error: any) {
            console.error("Error updating real-time data:", error.message);
          }
        }
      };

      // Calculate time to next 30s mark
      const now = new Date();
      const msSinceLast30 = now.getTime() % 30000;
      const msToNextSync = 30000 - msSinceLast30;

      console.log(`⏱️  Aligning server polling: Waiting ${Math.round(msToNextSync/1000)}s to sync with wall clock...`);

      // Initial immediate update
      if (updateRealtimeData) {
        updateRealtimeData(apiToken).catch(console.error);
      }
      
      // Schedule aligned updates
      setTimeout(() => {
        syncRealtimeData();
        setInterval(syncRealtimeData, 30000);
        console.log("⏱️  Server polling aligned to wall clock (:00/:30)");
      }, msToNextSync);
      
      // Initial update (only if database available)
      if (updateRealtimeData) {
        updateRealtimeData(apiToken).catch(console.error);
      }
    }

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

    // UP-NW specific train positions for the map
    app.get("/api/positions/upnw", async (req, res) => {
      try {
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

        // Filter for UP-NW trains only and add direction info
        const upnwTrains = body.entity
          .filter((entity: any) => entity.vehicle?.trip?.routeId === 'UP-NW')
          .map((entity: any) => {
            const trainNumber = entity.vehicle?.vehicle?.label || entity.vehicle?.trip?.tripId?.split('_')[1]?.replace('UNW', '') || 'Unknown';
            const trainNum = parseInt(trainNumber);
            const direction = !isNaN(trainNum) ? (trainNum % 2 === 0 ? 'inbound' : 'outbound') : 'unknown';
            
            return {
              id: entity.id,
              trainNumber,
              tripId: entity.vehicle?.trip?.tripId,
              latitude: entity.vehicle?.position?.latitude,
              longitude: entity.vehicle?.position?.longitude,
              bearing: entity.vehicle?.position?.bearing,
              timestamp: entity.vehicle?.timestamp,
              vehicleId: entity.vehicle?.vehicle?.id,
              direction,
            };
          });
        
        // Save to database if available and save param is set
        const shouldSave = req.query.save === 'true';
        if (shouldSave && getDatabase) {
          try {
            const db = getDatabase();
            const insert = db.prepare(`
              INSERT INTO train_positions (train_number, trip_id, vehicle_id, latitude, longitude, bearing, direction, timestamp)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `);
            
            for (const train of upnwTrains) {
              insert.run(
                train.trainNumber,
                train.tripId,
                train.vehicleId,
                train.latitude,
                train.longitude,
                train.bearing,
                train.direction,
                train.timestamp
              );
            }
            console.log(`Saved ${upnwTrains.length} train positions to database`);
          } catch (dbError: any) {
            console.warn("Could not save positions to database:", dbError.message);
          }
        }
        
        res.json({
          trains: upnwTrains,
          timestamp: new Date().toISOString(),
          count: upnwTrains.length
        });
      } catch (error: any) {
        console.error("Error fetching UP-NW positions:", error.message);
        res.status(500).json({ error: "Failed to fetch UP-NW positions" });
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

    // Get UP-NW rail line shape for map overlay
    app.get("/api/shapes/upnw", async (_req, res) => {
      try {
        const fs = (await import("fs")).default;
        // In production, use cwd-relative path; in dev, use __dirname-relative
        const shapesPath = process.env.NODE_ENV === 'production'
          ? path.resolve(process.cwd(), "server/gtfs/data/shapes.txt")
          : path.resolve(__dirname, "gtfs/data/shapes.txt");
        const shapesData = fs.readFileSync(shapesPath, "utf-8");
        const lines = shapesData.split("\n");
        
        const inboundPoints: Array<[number, number]> = [];
        const outboundPoints: Array<[number, number]> = [];
        
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i].trim();
          if (!line) continue;
          
          const [shape_id, lat_str, lng_str] = line.split(",");
          
          if (shape_id === "UP-NW_IB_1") {
            const lat = parseFloat(lat_str);
            const lng = parseFloat(lng_str);
            if (!isNaN(lat) && !isNaN(lng)) {
              inboundPoints.push([lat, lng]);
            }
          } else if (shape_id === "UP-NW_OB_1") {
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
    app.get("/api/schedule", (_req, res) => {
      try {
        if (!getAllSchedules) {
          return res.status(503).json({ error: "Database not available. Using static schedule data." });
        }
        const schedules = getAllSchedules();
        res.json(schedules);
      } catch (error: any) {
        console.error("Error fetching schedule:", error.message);
        res.status(500).json({ error: "Failed to fetch schedule" });
      }
    });

    app.get("/api/schedule/:dayType", (req, res) => {
      try {
        const { dayType } = req.params;
        if (!['weekday', 'saturday', 'sunday'].includes(dayType)) {
          return res.status(400).json({ error: "Invalid day type" });
        }
        if (!getAllSchedules) {
          return res.status(503).json({ error: "Database not available" });
        }
        const schedules = getAllSchedules();
        res.json(schedules[dayType as keyof typeof schedules]);
      } catch (error: any) {
        console.error("Error fetching schedule:", error.message);
        res.status(500).json({ error: "Failed to fetch schedule" });
      }
    });

    app.get("/api/next-train", (req, res) => {
      try {
        const { direction, dayType, currentTime } = req.query;
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
        
        const next = getNextTrain(
          direction as 'inbound' | 'outbound',
          timeMinutes,
          dayType as 'weekday' | 'saturday' | 'sunday'
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

    // Fetch crowding data from Metra's website
    app.get("/api/crowding", async (req, res) => {
      let browser: any = null;
      let db: any = null;
      const cacheKey = `${req.query.origin || 'PALATINE'}_${req.query.destination || 'OTC'}`;
      
      try {
        const { origin = 'PALATINE', destination = 'OTC', force } = req.query;
        const forceRefresh = force === 'true' || force === '1';
        const { getDatabase } = await import("./db/schema.js");
        db = getDatabase();
        
        const formatCachedData = (cachedData: Array<{
          trip_id: string;
          crowding: string | null;
          updated_at: string;
        }>) => {
          const crowding = cachedData
            .filter(item => item.crowding)
            .map(item => ({ trip_id: item.trip_id, crowding: item.crowding as CrowdingLevel }));
          
          return { crowding };
        };
        
        if (!forceRefresh) {
          const cachedData = db.prepare(`
            SELECT trip_id, crowding, updated_at
            FROM crowding_cache
            WHERE origin = ? AND destination = ?
              AND updated_at > datetime('now', '-1 hour')
          `).all(origin, destination) as Array<{
            trip_id: string;
            crowding: string | null;
            updated_at: string;
          }>;
          
          if (cachedData.length > 0) {
            const result = formatCachedData(cachedData);
            console.log(`Returning cached crowding data for ${origin}->${destination} (${result.crowding.length} trains)`);
            return res.json(result);
          }
        }
        
        if (scrapingLocks.has(cacheKey)) {
          console.log(`Scraping already in progress for ${origin}->${destination}, waiting...`);
          try {
            const result = await scrapingLocks.get(cacheKey);
            return res.json(result);
          } catch (lockError: any) {
            console.warn(`Lock wait failed: ${lockError.message}`);
          }
        }
        
        const staleCache = db.prepare(`
          SELECT trip_id, crowding, updated_at
          FROM crowding_cache
          WHERE origin = ? AND destination = ?
            AND updated_at > datetime('now', '-24 hours')
          ORDER BY updated_at DESC
          LIMIT 100
        `).all(origin, destination) as Array<{
          trip_id: string;
          crowding: string | null;
          updated_at: string;
        }>;
        
        console.log(`Cache miss for ${origin}->${destination}, scraping...`);
        
        const scrapePromise = (async () => {
          let scrapeBrowser: any = null;
          try {
            const puppeteer = (await import("puppeteer")).default;
            const executablePath = await ensureChromeExecutable();
            
            // If Chrome is not available, throw to trigger fallback
            if (!executablePath) {
              throw new Error("Chrome not available - crowding scraping disabled");
            }
            
            let firstTrainTimestamp: number;

            try {
              const now = new Date();
              const chicagoNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));

              chicagoNow.setHours(3, 0, 0, 0);

              firstTrainTimestamp = Math.floor(chicagoNow.getTime() / 1000);
            } catch (dbError) {
              const now = new Date();
              firstTrainTimestamp = Math.floor(now.getTime() / 1000);
            }
            
            const url = `https://www.metra.com/schedules?line=UP-NW&orig=${origin}&dest=${destination}&time=${firstTrainTimestamp}&allstops=0&redirect=${firstTrainTimestamp}`;
            
            scrapeBrowser = await puppeteer.launch({
              headless: true,
              args: ['--no-sandbox', '--disable-setuid-sandbox'],
              executablePath,
              timeout: 30000
            });
            
            if (!scrapeBrowser.isConnected()) {
              throw new Error('Browser disconnected (server may have restarted)');
            }
            
            const page = await scrapeBrowser.newPage();
            
            await page.setViewport({ width: 1920, height: 1080 });
            await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
            
            try {
              if (page.isClosed()) {
                throw new Error('Page was closed before navigation');
              }
              
              await page.goto(url, { waitUntil: 'networkidle0', timeout: 20000 });
            } catch (gotoError: any) {
              if (gotoError.message.includes('detached') || gotoError.message.includes('Target closed')) {
                console.warn(`Browser/page was detached (likely due to server restart): ${gotoError.message}`);
                throw new Error('Browser was disconnected during scraping (server may have restarted)');
              }
              console.warn(`Page navigation timeout or error: ${gotoError.message}`);
              throw new Error(`Failed to load Metra schedule page: ${gotoError.message}`);
            }
            
            await page.waitForSelector('.trip-row', { timeout: 10000 }).catch(() => {
              console.warn('Trip rows not found after timeout, continuing anyway');
            });
            
            if (page.isClosed()) {
              throw new Error('Page was closed before data extraction');
            }
            
            const extractedData = await page.evaluate(() => {
              const trainRows = Array.from(document.querySelectorAll('.trip-row'));
              const crowdingResults: Array<{ trip_id: string; crowding: CrowdingLevel }> = [];
              
              trainRows.forEach((row: Element) => {
                const tripId = row.getAttribute('id');
                if (!tripId) return;
                
                // Crowding is stored in a nested span inside .trip--crowding container
                // Classes: trip--crowding-low, trip--crowding-some, trip--crowding-moderate, trip--crowding-high
                const crowdingContainer = row.querySelector('.trip--crowding');
                if (!crowdingContainer) return;
                
                // Check for crowding classes on both the container and nested spans
                const crowdingLow = crowdingContainer.querySelector('.trip--crowding-low') || 
                                    crowdingContainer.classList.contains('trip--crowding-low');
                const crowdingSome = crowdingContainer.querySelector('.trip--crowding-some') ||
                                     crowdingContainer.classList.contains('trip--crowding-some');
                const crowdingModerate = crowdingContainer.querySelector('.trip--crowding-moderate') ||
                                         crowdingContainer.classList.contains('trip--crowding-moderate');
                const crowdingHigh = crowdingContainer.querySelector('.trip--crowding-high') ||
                                     crowdingContainer.classList.contains('trip--crowding-high');

                let crowding: CrowdingLevel | null = null;
                if (crowdingHigh) {
                  crowding = 'high';
                } else if (crowdingModerate) {
                  crowding = 'moderate';
                } else if (crowdingSome) {
                  crowding = 'some';
                } else if (crowdingLow) {
                  crowding = 'low';
                } else {
                  // Fallback: if container exists but no specific level, assume low
                  crowding = 'low';
                }
                
                if (crowding) {
                  crowdingResults.push({ trip_id: tripId, crowding });
                }
              });
              
              return { crowding: crowdingResults };
            });
            
            if (extractedData.crowding.length === 0) {
              throw new Error('No crowding data extracted from Metra website');
            }
            
            console.log(`Extracted crowding data for ${extractedData.crowding.length} trains`);
            
            const { getDatabase: getDbForCache } = await import("./db/schema.js");
            const dbForCache = getDbForCache();
            
            try {
              const insertCache = dbForCache.prepare(`
                INSERT OR REPLACE INTO crowding_cache 
                (origin, destination, trip_id, crowding, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
              `);
              
              const transaction = dbForCache.transaction(() => {
                dbForCache.prepare(`
                  DELETE FROM crowding_cache 
                  WHERE origin = ? AND destination = ? AND updated_at < datetime('now', '-24 hours')
                `).run(origin, destination);
                
                extractedData.crowding.forEach((item: { trip_id: string; crowding: CrowdingLevel }) => {
                  insertCache.run(
                    origin,
                    destination,
                    item.trip_id,
                    item.crowding
                  );
                });
              });
              
              transaction();
              console.log(`Cached crowding data for ${origin}->${destination}`);
            } catch (cacheError: any) {
              console.warn(`Failed to cache data: ${cacheError.message}`);
            }
            
            if (scrapeBrowser && scrapeBrowser.isConnected()) {
              try {
                await scrapeBrowser.close();
              } catch (closeError: any) {
                if (!closeError.message.includes('Target closed') && 
                    !closeError.message.includes('Session closed') &&
                    !closeError.message.includes('Connection closed')) {
                  console.warn('Error closing browser:', closeError.message);
                }
              }
            }
            
            return {
              crowding: extractedData.crowding
            };
          } catch (scrapeError: any) {
            if (scrapeBrowser && scrapeBrowser.isConnected()) {
              try {
                await scrapeBrowser.close();
              } catch (closeError: any) {
                if (!closeError.message.includes('Target closed') && 
                    !closeError.message.includes('Session closed') &&
                    !closeError.message.includes('Connection closed')) {
                  console.warn('Error closing browser:', closeError.message);
                }
              }
            }
            
            if (scrapeError.message.includes('detached') || 
                scrapeError.message.includes('disconnected') || 
                scrapeError.message.includes('Target closed') ||
                scrapeError.message.includes('Session closed')) {
              throw new Error('Browser was disconnected during scraping (server may have restarted)');
            }
            
            throw scrapeError;
          }
        })();
        
        scrapingLocks.set(cacheKey, scrapePromise);
        
        try {
          const result = await scrapePromise;
          scrapingLocks.delete(cacheKey);
          return res.json(result);
        } catch (scrapeError: any) {
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
            console.log(`Falling back to stale cache (${staleCache.length} entries)`);
            const result = formatCachedData(staleCache);
            return res.json(result);
          }
          
          return res.json({ crowding: [] });
        }
      } catch (error: any) {
        console.error("Error fetching crowding data:", error.message);
        return res.json({ crowding: [] });
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

    // Handle client-side routing
    app.get("*", (_req, res) => {
      res.sendFile(path.join(staticPath, "index.html"));
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
