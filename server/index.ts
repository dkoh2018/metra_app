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
let updateWeatherData: any, getAllWeather: any;
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
          const weatherModule = await import("./db/weather-updater.js");
          const loaderModule = await import("./db/gtfs-loader.js");
          
          // Assign to module-level variables
          getDatabase = dbModule.getDatabase;
          getAllSchedules = scheduleModule.getAllSchedules;
          getNextTrain = scheduleModule.getNextTrain;
          shouldUpdateGTFS = scheduleModule.shouldUpdateGTFS;
          getAllDelays = realtimeModule.getAllDelays;
          updateRealtimeData = realtimeModule.updateRealtimeData;
          updateWeatherData = weatherModule.updateWeatherData;
          getAllWeather = weatherModule.getAllWeather;
          loadGTFSIntoDatabase = loaderModule.loadGTFSIntoDatabase;
          
          // Initialize database schema
          const { initDatabase } = dbModule;
          initDatabase();
          
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

          // Weather updates
          if (updateWeatherData) {
             console.log("🌦️  Starting weather data polling...");
             // Initial update
             updateWeatherData().catch((err: any) => console.error("Weather init error:", err));
             // Schedule
             setInterval(() => {
                 console.log("🌦️  Updating weather data...");
                 updateWeatherData().catch((err: any) => console.error("Weather update error:", err.message));
             }, 60 * 1000);
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
    // Map cache by lineId
    const positionsCache = new Map<string, {
      data: any;
      timestamp: number;
    }>();
    const POSITIONS_CACHE_TTL = 10 * 1000; // 10 seconds for real-time feel

    app.get("/api/positions/:lineId", async (req, res) => {
      try {
        const { lineId } = req.params;
        const validLines = ['UP-NW', 'MD-W'];
        if (!validLines.includes(lineId)) {
          return res.status(400).json({ error: "Invalid line ID" });
        }

        const now = Date.now();
        const cache = positionsCache.get(lineId);
        
        // Serve from cache if fresh
        if (cache && (now - cache.timestamp < POSITIONS_CACHE_TTL)) {
          return res.json(cache.data);
        }

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

        // Filter for specific line trains only and add direction info
        const lineTrains = body.entity
          .filter((entity: any) => entity.vehicle?.trip?.routeId === lineId)
          .map((entity: any) => {
            const trainNumber = entity.vehicle?.vehicle?.label || entity.vehicle?.trip?.tripId?.split('_')[1]?.replace(lineId === 'UP-NW' ? 'UNW' : 'MDW', '') || 'Unknown';
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
        
        const responseData = {
          trains: lineTrains,
          timestamp: new Date().toISOString(),
          count: lineTrains.length
        };

        // Update cache for this line
        positionsCache.set(lineId, {
          data: responseData,
          timestamp: now
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
            
            for (const train of lineTrains) {
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
            console.log(`Saved ${lineTrains.length} train positions to database`);
          } catch (dbError: any) {
            console.warn("Could not save positions to database:", dbError.message);
          }
        }
        
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
        const validLines = ['UP-NW', 'MD-W'];
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
          
          if (shape_id === ibShapeId || (lineId === 'MD-W' && shape_id.startsWith('MD-W_IB'))) {
            const lat = parseFloat(lat_str);
            const lng = parseFloat(lng_str);
            if (!isNaN(lat) && !isNaN(lng)) {
              inboundPoints.push([lat, lng]);
            }
          } else if (shape_id === obShapeId || (lineId === 'MD-W' && shape_id.startsWith('MD-W_OB'))) {
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
      console.log(`[API] [${requestId}] Crowding request: ${req.query.origin || 'PALATINE'}->${req.query.destination || 'OTC'} (force=${req.query.force})`);
      console.log(`[API] [${requestId}] Railway env check - NODE_ENV: ${process.env.NODE_ENV}, PORT: ${process.env.PORT}`);
      
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
      
      // Clear timeout when response is sent
      const clearTimeoutAndSend = (data: any) => {
        clearTimeout(timeout);
        const elapsed = Date.now() - startTime;
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
          const cachedData = db.prepare(`
            SELECT trip_id, crowding, 
                   scheduled_departure, predicted_departure,
                   scheduled_arrival, predicted_arrival, updated_at
            FROM crowding_cache
            WHERE origin = ? AND destination = ?
              AND updated_at > datetime('now', '-5 minutes')
          `).all(origin, destination) as Array<{
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
            const cacheAge = Math.round((Date.now() - new Date(cachedData[0].updated_at).getTime()) / 1000 / 60);
            console.log(`[CACHE HIT] Returning cached crowding data for ${origin}->${destination} (${result.crowding.length} trains, ${cacheAge} min old)`);
            return res.json(result);
          }
          
          console.log(`[CACHE MISS] No fresh cache for ${origin}->${destination} (checking for stale cache or scraping...)`);
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

              // Fix for Railway/UTC servers: Use "Now - 1 Hour" logic
              // 1. Solves Timezone Bug: Date.now() is universal, so subtracting 1 hour always gives "1 hour ago" in absolute time, matching Chicago time correctly.
              // 2. Optimization: Fetches only relevant/active trains instead of the entire day history, preventing timeouts and null data.
              const now = new Date();
              firstTrainTimestamp = Math.floor(now.getTime() / 1000) - 3600;
              
              const chicagoTime = now.toLocaleString('en-US', { timeZone: 'America/Chicago' });
              console.log(`[CROWDING] Start Time: ${firstTrainTimestamp} (Now - 1h). Server Now (Chicago): ${chicagoTime}`);
            

            
            const url = `https://www.metra.com/schedules?line=${lineId}&orig=${origin}&dest=${destination}&time=${firstTrainTimestamp}&allstops=0&redirect=${firstTrainTimestamp}`;
            
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
            
            // Force Desktop Viewport (1920x1080) to ensure we get the full table layout
            // Railway defaults to 800x600 which triggers mobile view, breaking selectors
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
            
            const extractedData = await page.evaluate((scrapeOrigin: string, scrapeDest: string) => {
              type CrowdingLevel = 'low' | 'some' | 'moderate' | 'high';
              
              // Map to store results by trip_id
              const resultsMap = new Map<string, {
                trip_id: string;
                crowding: CrowdingLevel;
                scheduled_departure: string | null;
                estimated_departure: string | null;
                scheduled_arrival: string | null;
                estimated_arrival: string | null;
              }>();
              
              const debug: string[] = [];
              debug.push(`[SCRAPER] Starting extraction for ${scrapeOrigin} -> ${scrapeDest}`);
              debug.push(`[SCRAPER] Looking for cell IDs containing: "${scrapeOrigin.toUpperCase()}" (origin) and "${scrapeDest.toUpperCase()}" (dest)`);
              
              // First: Extract crowding from .trip-row elements
              const tripRows = Array.from(document.querySelectorAll('.trip-row'));
              if (tripRows.length > 0) {
                 const firstIds = tripRows.slice(0, 3).map(r => r.getAttribute('id')).filter(Boolean);
                 debug.push(`[TRIP ROWS] Found ${tripRows.length} trip rows. Sample IDs: ${firstIds.join(', ')}`);
              } else {
                 debug.push('[TRIP ROWS] WARNING: No .trip-row elements found!');
                 // Log body content to debug selector failure
                 debug.push(`[TRIP ROWS] Body preview: ${document.body.innerHTML.substring(0, 500)}...`);
              }
              
              tripRows.forEach((tripCell: Element) => {
                const tripId = tripCell.getAttribute('id');
                if (!tripId) return;
                
                const crowdingContainer = tripCell.querySelector('.trip--crowding');
                let crowding: CrowdingLevel = 'low';
                
                if (crowdingContainer) {
                  if (crowdingContainer.querySelector('.trip--crowding-high') || 
                      crowdingContainer.classList.contains('trip--crowding-high')) {
                    crowding = 'high';
                  } else if (crowdingContainer.querySelector('.trip--crowding-moderate') ||
                             crowdingContainer.classList.contains('trip--crowding-moderate')) {
                    crowding = 'moderate';
                  } else if (crowdingContainer.querySelector('.trip--crowding-some') ||
                             crowdingContainer.classList.contains('trip--crowding-some')) {
                    crowding = 'some';
                  }
                }
                
                resultsMap.set(tripId, {
                  trip_id: tripId,
                  crowding,
                  scheduled_departure: null,
                  estimated_departure: null,
                  scheduled_arrival: null,
                  estimated_arrival: null
                });
              });
              
              // Second: Extract estimated times from ALL td.stop elements (don't rely on has-exception class)
              // These have IDs like "UP-NW_UNW672_V3_APALATINE" (trip_id + "_" + stop)
              const estimatedStops = Array.from(document.querySelectorAll('td.stop'));
              debug.push(`[STOP CELLS] Found ${estimatedStops.length} total stop cells`);
              
              // Count how many match our origin/dest
              const originMatches = estimatedStops.filter(cell => {
                const cellId = cell.getAttribute('id') || '';
                return cellId.toUpperCase().includes(scrapeOrigin.toUpperCase());
              }).length;
              const destMatches = estimatedStops.filter(cell => {
                const cellId = cell.getAttribute('id') || '';
                return cellId.toUpperCase().includes(scrapeDest.toUpperCase());
              }).length;
              debug.push(`[STOP CELLS] Matches: ${originMatches} with "${scrapeOrigin.toUpperCase()}", ${destMatches} with "${scrapeDest.toUpperCase()}"`);
              
              estimatedStops.forEach((cell: Element, index: number) => {
                // Check if this cell has a strike-through time (indicating delay/change)
                // We access the text container first
                const stopText = cell.querySelector('.stop--text');
                if (!stopText) return;

                const strikeOut = stopText.querySelector('.strike-out');
                // If there's no strike-out, there's no estimated time update to process
                if (!strikeOut) return;

                const cellId = cell.getAttribute('id');
                if (!cellId) return;
                
                // Extract trip_id by removing the stop suffix (e.g., "_APALATINE", "_OTC", "_PALATINE")
                // Trip IDs look like: UP-NW_UNW672_V3_A or MD-W_MW2254_V2_A
                // Cell IDs look like: UP-NW_UNW672_V3_APALATINE or MD-W_MW2254_V2_ASCHAUM
                const tripIdMatch = cellId.match(/^((?:UP-NW|MD-W)_[A-Z0-9]+_V\d+_[A-Z])/);
                if (!tripIdMatch) return;
                const tripId = tripIdMatch[1];
                
                // Determine if this is departure (origin) or arrival (dest) based on cell ID
                // Use the actual origin/dest passed from the scraper (case insensitive)
                const isOriginStop = cellId.toUpperCase().includes(scrapeOrigin.toUpperCase());
                const isDestStop = cellId.toUpperCase().includes(scrapeDest.toUpperCase());
                
                // Debug logging for first few matches to verify station matching works
                if (index < 3 && (isOriginStop || isDestStop)) {
                  debug.push(`[MATCH] CellId: ${cellId} | Origin: ${scrapeOrigin} (${isOriginStop ? 'MATCH' : 'no'}) | Dest: ${scrapeDest} (${isDestStop ? 'MATCH' : 'no'})`);
                }
                
                // Get the estimated time from the cell
                // We already have stopText and strikeOut from above
                
                const scheduledTime = strikeOut.textContent?.trim() || null;
                // Estimated time is the text after the strikeout
                const fullText = stopText.textContent || '';
                const strikeText = strikeOut.textContent || '';
                const estimatedTime = fullText.replace(strikeText, '').trim() || null;
                
                // Update the results map
                const existing = resultsMap.get(tripId);
                if (existing) {
                  if (isOriginStop) {
                    existing.scheduled_departure = scheduledTime;
                    existing.estimated_departure = estimatedTime;
                    debug.push(`Updated departure for ${tripId}: ${scheduledTime} -> ${estimatedTime}`);
                  } else if (isDestStop) {
                    existing.scheduled_arrival = scheduledTime;
                    existing.estimated_arrival = estimatedTime;
                    debug.push(`Updated arrival for ${tripId}: ${scheduledTime} -> ${estimatedTime}`);
                  } else {
                     if (index < 5) debug.push(`Trip ${tripId} match but not origin/dest. CellId: ${cellId}`);
                  }
                } else {
                     if (index < 5) debug.push(`Trip ${tripId} not found in resultsMap`);
                }
              });

              // Final Summary with detailed breakdown
              const crowdingFound = Array.from(resultsMap.values()).filter(r => r.crowding !== 'low').length;
              const estimatesFound = Array.from(resultsMap.values()).filter(r => r.estimated_departure || r.estimated_arrival).length;
              const withDepartureEst = Array.from(resultsMap.values()).filter(r => r.estimated_departure).length;
              const withArrivalEst = Array.from(resultsMap.values()).filter(r => r.estimated_arrival).length;
              
              debug.push(`SCRAPER SUMMARY: Total Trips: ${resultsMap.size}`);
              debug.push(`  └─ Crowding Updates: ${crowdingFound} (low: ${resultsMap.size - crowdingFound}, some/moderate/high: ${crowdingFound})`);
              debug.push(`  └─ Estimated Times: ${estimatesFound} total (departures: ${withDepartureEst}, arrivals: ${withArrivalEst})`);
              debug.push(`  └─ Origin: ${scrapeOrigin}, Dest: ${scrapeDest}`);
              
              return { crowding: Array.from(resultsMap.values()), debug };
            }, origin, destination);


            if (extractedData.debug && extractedData.debug.length > 0) {
                console.log("SCRAPER DEBUG LOGS:\n" + extractedData.debug.join('\n'));
            }
            
            // Add defensive checks and logging
            if (!extractedData) {
              throw new Error('No data returned from page.evaluate()');
            }
            
            if (!extractedData.crowding) {
              console.error(`[ERROR] extractedData.crowding is missing. extractedData keys: ${Object.keys(extractedData).join(', ')}`);
              throw new Error('Crowding data missing from extraction result');
            }
            
            if (!Array.isArray(extractedData.crowding)) {
              console.error(`[ERROR] extractedData.crowding is not an array. Type: ${typeof extractedData.crowding}, Value: ${JSON.stringify(extractedData.crowding).substring(0, 200)}`);
              throw new Error('Crowding data is not an array');
            }
            
            if (extractedData.crowding.length === 0) {
              console.warn(`[WARNING] No crowding data extracted from Metra website for ${origin}->${destination}`);
              throw new Error('No crowding data extracted from Metra website');
            }
            
            console.log(`[CROWDING] Extracted data for ${origin}->${destination} (${extractedData.crowding.length} trains)`);
            
            // Count statistics
            const withCrowding = extractedData.crowding.filter((item: any) => item.crowding !== 'low').length;
            const withEstimates = extractedData.crowding.filter(
              (item: any) => item.estimated_departure || item.estimated_arrival
            ).length;
            const withDepartureEst = extractedData.crowding.filter((item: any) => item.estimated_departure).length;
            const withArrivalEst = extractedData.crowding.filter((item: any) => item.estimated_arrival).length;
            
            console.log(`  └─ Crowding levels: ${withCrowding} non-low (${extractedData.crowding.length - withCrowding} low)`);
            if (withEstimates > 0) {
              console.log(`  └─ Estimated times: ${withEstimates} trains (${withDepartureEst} departures, ${withArrivalEst} arrivals)`);
            }
            
            // Show sample for debugging (first train with non-low crowding or estimates)
            const sampleTrain = extractedData.crowding.find((item: any) => 
              item.crowding !== 'low' || item.estimated_departure || item.estimated_arrival
            ) || extractedData.crowding[0];
            
            if (sampleTrain) {
              console.log(`  └─ Sample: ${sampleTrain.trip_id} | Crowding: ${sampleTrain.crowding} | ` +
                `Dep: ${sampleTrain.scheduled_departure}${sampleTrain.estimated_departure ? ` -> ${sampleTrain.estimated_departure}` : ''} | ` +
                `Arr: ${sampleTrain.scheduled_arrival}${sampleTrain.estimated_arrival ? ` -> ${sampleTrain.estimated_arrival}` : ''}`);
            }
            
            console.log(`[CROWDING] About to save to database for ${origin}->${destination}...`);
            const { getDatabase: getDbForCache } = await import("./db/schema.js");
            let dbForCache;
            try {
              dbForCache = getDbForCache();
              console.log(`[CROWDING] Database connection obtained for ${origin}->${destination}`);
              
              // Test database write capability
              try {
                dbForCache.prepare('SELECT 1').get();
                console.log(`[CROWDING] Database connection verified for ${origin}->${destination}`);
              } catch (testError: any) {
                console.error(`[ERROR] Database connection test failed for ${origin}->${destination}: ${testError.message}`);
                throw new Error(`Database connection invalid: ${testError.message}`);
              }
            } catch (dbInitError: any) {
              console.error(`[ERROR] Failed to get database connection for ${origin}->${destination}: ${dbInitError.message}`);
              console.error(`[ERROR] Stack: ${dbInitError.stack}`);
              // Continue without caching - still return the data
              dbForCache = null;
            }
            
            if (dbForCache) {
              try {
                console.log(`[CROWDING] Preparing database insert for ${origin}->${destination} (${extractedData.crowding.length} items)...`);
                const insertCache = dbForCache.prepare(`
                  INSERT OR REPLACE INTO crowding_cache 
                  (origin, destination, trip_id, crowding, 
                   scheduled_departure, predicted_departure, 
                   scheduled_arrival, predicted_arrival, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                `);
                
                console.log(`[CROWDING] Starting transaction for ${origin}->${destination}...`);
                const transaction = dbForCache.transaction(() => {
                  console.log(`[CROWDING] Deleting old cache entries for ${origin}->${destination}...`);
                  dbForCache.prepare(`
                    DELETE FROM crowding_cache 
                    WHERE origin = ? AND destination = ? AND updated_at < datetime('now', '-24 hours')
                  `).run(origin, destination);
                  
                  console.log(`[CROWDING] Inserting ${extractedData.crowding.length} cache entries for ${origin}->${destination}...`);
                  extractedData.crowding.forEach((item: {
                    trip_id: string;
                    crowding: CrowdingLevel;
                    scheduled_departure: string | null;
                    estimated_departure: string | null;
                    scheduled_arrival: string | null;
                    estimated_arrival: string | null;
                  }, index: number) => {
                    try {
                      insertCache.run(
                        origin,
                        destination,
                        item.trip_id,
                        item.crowding,
                        item.scheduled_departure,
                        item.estimated_departure,
                        item.scheduled_arrival,
                        item.estimated_arrival
                      );
                      if (index < 3) {
                        console.log(`[CROWDING] Inserted cache entry ${index + 1}/${extractedData.crowding.length}: ${item.trip_id} (${item.crowding})`);
                      }
                    } catch (insertError: any) {
                      console.error(`[ERROR] Failed to insert cache entry for ${item.trip_id}: ${insertError.message}`);
                      throw insertError;
                    }
                  });
                });
                
                console.log(`[CROWDING] Executing transaction for ${origin}->${destination}...`);
                transaction();
                const savedCount = extractedData.crowding.length;
                console.log(`[CACHE SAVE] Saved ${savedCount} entries to database for ${origin}->${destination} (using INSERT OR REPLACE - updates existing, no duplicates)`);
              
              // Verify no duplicates exist (should always be 0 due to unique constraint)
              const duplicateCheck = dbForCache.prepare(`
                SELECT origin, destination, trip_id, COUNT(*) as count
                FROM crowding_cache
                WHERE origin = ? AND destination = ?
                GROUP BY origin, destination, trip_id
                HAVING count > 1
              `).all(origin, destination);
              
              if (duplicateCheck.length > 0) {
                console.warn(`[CACHE WARNING] Found ${duplicateCheck.length} duplicate entries for ${origin}->${destination} (this should not happen!)`);
              } else {
                console.log(`[CACHE VERIFY] No duplicates found for ${origin}->${destination} (unique constraint working correctly)`);
              }
              
              // Show cache statistics for this origin/destination
              const cacheStats = dbForCache.prepare(`
                SELECT COUNT(*) as total, 
                       MIN(updated_at) as oldest,
                       MAX(updated_at) as newest
                FROM crowding_cache
                WHERE origin = ? AND destination = ?
              `).get(origin, destination) as { total: number; oldest: string; newest: string };
              
                if (cacheStats) {
                  console.log(`[CACHE STATS] ${origin}->${destination}: ${cacheStats.total} total entries (oldest: ${cacheStats.oldest}, newest: ${cacheStats.newest})`);
                }
              } catch (cacheError: any) {
                console.error(`[ERROR] Failed to cache data for ${origin}->${destination}: ${cacheError.message}`);
                console.error(`[ERROR] Stack: ${cacheError.stack}`);
                // Don't throw - we still want to return the data even if caching fails
              }
            } else {
              console.warn(`[WARNING] Database not available, skipping cache save for ${origin}->${destination} (data will still be returned)`);
            }
            
            console.log(`[CROWDING] About to close browser and return data for ${origin}->${destination}...`);
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
            
            console.log(`[CROWDING] Returning ${extractedData.crowding.length} crowding entries for ${origin}->${destination}`);
            
            // Ensure all data is properly serializable
            const result = {
              crowding: extractedData.crowding.map((item: any) => ({
                trip_id: String(item.trip_id || ''),
                crowding: String(item.crowding || 'low'),
                scheduled_departure: item.scheduled_departure ? String(item.scheduled_departure) : null,
                predicted_departure: item.estimated_departure ? String(item.estimated_departure) : null,
                scheduled_arrival: item.scheduled_arrival ? String(item.scheduled_arrival) : null,
                predicted_arrival: item.estimated_arrival ? String(item.estimated_arrival) : null
              }))
            };
            
            console.log(`[CROWDING] Result prepared with ${result.crowding.length} entries, returning for ${origin}->${destination}`);
            console.log(`[CROWDING] Sample entry: ${JSON.stringify(result.crowding[0] || {}).substring(0, 200)}`);
            return result;
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
