import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { context } from "./lib/context.js";
import { scrapeAndCacheCrowding, scrapeStats } from "./lib/scraping.js";
import { POSITIONS_CACHE_TTL, getCrowdingCacheTTL } from "./config.js";
import type { CrowdingLevel } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Cache for train positions (shared across all requests for instant page loads)
const positionsCache = new Map<string, {
  data: any[];
  timestamp: number;
}>();

// Cache for crowding data (shared across all requests for instant page loads)
const crowdingCache = new Map<string, {
  data: any[];
  timestamp: number;
}>();

export function registerRoutes(app: express.Express) {
    // Serve static files from dist/public in production
    const effectiveStaticPath = process.env.NODE_ENV === "production"
        ? path.resolve(__dirname, "public")
        : path.resolve(__dirname, "..", "dist", "public");

    // Helper for generic GTFS fetching
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
    
    // Debug endpoint: Scrape statistics for Railway debugging
    app.get("/api/scrape-stats", (_req, res) => {
      res.json({
        totalAttempts: scrapeStats.totalAttempts,
        successCount: scrapeStats.successCount,
        failCount: scrapeStats.failCount,
        successRate: `${scrapeStats.successRate}%`,
        lastFailReason: scrapeStats.lastFailReason || 'none',
        failedRoutes: Array.from(scrapeStats.failedRoutes),
        successfulRoutes: Array.from(scrapeStats.successfulRoutes),
        environment: process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV || 'local',
        serverTime: new Date().toISOString(),
        chicagoTime: new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })
      });
    });

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
        if (!context.getDatabase) {
          return res.status(503).json({ error: "Database not available" });
        }
        
        const db = context.getDatabase();
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
        if (!context.getAllSchedules) {
          return res.status(503).json({ error: "Database not available. Using static schedule data." });
        }
        const { station, terminal } = req.query;
        const stationId = typeof station === 'string' ? station : 'PALATINE';
        const terminalId = typeof terminal === 'string' ? terminal : 'OTC';
        const schedules = context.getAllSchedules(stationId, terminalId);
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
        if (!context.getAllSchedules) {
          return res.status(503).json({ error: "Database not available" });
        }
        const stationId = typeof station === 'string' ? station : 'PALATINE';
        const terminalId = typeof req.query.terminal === 'string' ? req.query.terminal : 'OTC';
        const schedules = context.getAllSchedules(stationId, terminalId);
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
        if (!context.getNextTrain) {
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
        const next = context.getNextTrain(
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
          if (context.getDatabase) {
            db = context.getDatabase();
          } else {
             // Fallback if context not ready?
             const { getDatabase } = await import("./db/schema.js");
             db = getDatabase();
          }
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

        // Fetch latest crowding info for this trip
        const crowdingRecord = db.prepare(`
          SELECT crowding 
          FROM crowding_cache 
          WHERE trip_id = ? 
          ORDER BY updated_at DESC 
          LIMIT 1
        `).get(tripId) as { crowding: string } | undefined;
        
        res.json({ 
          schedule,
          crowding: crowdingRecord?.crowding || null
        });
      } catch (error: any) {
        console.error("Error fetching trip schedule:", error.message);
        res.status(500).json({ error: "Failed to fetch trip schedule" });
      }
    });

    app.get("/api/delays", (_req, res) => {
      try {
        if (!context.getAllDelays) {
          return res.json({ delays: [] });
        }
        const delays = context.getAllDelays();
        res.json({ delays });
      } catch (error: any) {
        console.error("Error fetching delays:", error.message);
        res.json({ delays: [] });
      }
    });

    // Weather API endpoint
    app.get("/api/weather", (_req, res) => {
      try {
        if (!context.getAllWeather) {
           return res.json({ weather: [] });
        }
        const weather = context.getAllWeather();
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
      }, 55000); 
      
      const clearTimeoutAndSend = (data: any) => {
        clearTimeout(timeout);
        const elapsed = Date.now() - startTime;
        
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
      
      let db: any = null;
      const { origin = 'PALATINE', destination = 'OTC', force, line = 'UP-NW' } = req.query;
      const lineId = typeof line === 'string' ? line : 'UP-NW';
      const cacheKey = `${origin}_${destination}_${lineId}`;
      
      const isProblemRoute = (origin === 'PALATINE' && destination === 'OTC') || 
                              (origin === 'WESTMONT' && destination === 'CUS');
      if (isProblemRoute) {
        console.log(`🔍 [DEBUG-ROUTE] Problem route request: ${origin}->${destination} (${lineId})`);
      }
      
      try {
        const forceRefresh = force === 'true' || force === '1';
        
        if (context.getDatabase) {
             db = context.getDatabase();
        } else {
             const { getDatabase } = await import("./db/schema.js");
             db = getDatabase();
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
            const cacheAge = Math.round((Date.now() - new Date(cachedData[0].updated_at + 'Z').getTime()) / 1000 / 60);
            console.log(`✅ [CROWDING API] Cache HIT - Returning ${result.crowding.length} trains (${cacheAge} min old)`);
            if (isProblemRoute) {
              const sampleIds = result.crowding.slice(0, 5).map((t: any) => t.trip_id).join(', ');
              console.log(`🔍 [DEBUG-ROUTE] ${origin}->${destination} CACHE HIT: ${cachedData.length} raw, ${result.crowding.length} formatted`);
              console.log(`🔍 [DEBUG-ROUTE] Sample trip IDs: ${sampleIds}`);
            }
            return clearTimeoutAndSend(result);
          }
          
          console.log(`❌ [CROWDING API] Cache MISS - No fresh data (will scrape or use stale)`);
          if (isProblemRoute) {
            const totalInDb = db.prepare(`SELECT COUNT(*) as cnt FROM crowding_cache WHERE origin = ? AND destination = ?`).get(origin, destination) as { cnt: number };
            console.log(`🔍 [DEBUG-ROUTE] ${origin}->${destination} CACHE MISS! Total DB entries: ${totalInDb.cnt}, TTL: ${cacheTTLMinutes} min`);
          }
        }
        
        // Check for active lock is handled inside scrapeAndCacheCrowding but we also check here for clearer logs?
        // Actually, scrapeAndCacheCrowding handles the lock. We call it directly.
        // Wait, original code checked lock explicitly HERE too (line 1511).
        // scrapeAndCacheCrowding ALSO checks lock (line 337).
        // It's redundant but harmless. I'll omit here to simplify, as scrapeAndCacheCrowding returns the promise.
        // ACTUALLY, I don't have access to `scrapingLocks` map here! It's in `scraping.ts` and NOT exported.
        // So I MUST rely on `scrapeAndCacheCrowding` to handle the lock.
        // The original code had `scrapingLocks` in scope.
        // `scrapeAndCacheCrowding` DOES return the existing promise if locked.
        // So I can just call it!
        
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
        
        if (staleCache.length > 0) {
          const oldestAge = Math.round((Date.now() - new Date(staleCache[staleCache.length - 1].updated_at).getTime()) / 1000 / 60);
          const newestAge = Math.round((Date.now() - new Date(staleCache[0].updated_at).getTime()) / 1000 / 60);
          console.log(`[CACHE] Stale cache available: ${staleCache.length} entries (${newestAge}-${oldestAge} min old) - will use if scraping fails`);
        } else {
          console.log(`[CACHE] No stale cache available for ${origin}->${destination}`);
        }
        
        const scrapePromise = scrapeAndCacheCrowding(
          origin as string, 
          destination as string, 
          lineId as string,
          'API'
        );
        
        try {
          console.log(`[API] [${requestId}] Waiting for scraping promise to complete for ${origin}->${destination}...`);
          const result = await scrapePromise;
          console.log(`[API] [${requestId}] Scraping completed for ${origin}->${destination}, result has ${result?.crowding?.length || 0} entries`);
          console.log(`[API] [${requestId}] Sending JSON response for ${origin}->${destination}...`);
          return clearTimeoutAndSend(result);
        } catch (scrapeError: any) {
          const elapsed = Date.now() - startTime;
          console.error(`[API ERROR] [${requestId}] Scraping failed after ${elapsed}ms for ${origin}->${destination}: ${scrapeError.message}`);
          console.error(`[API ERROR] [${requestId}] Stack: ${scrapeError.stack}`);
          
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
        clearTimeout(timeout);
        const elapsed = Date.now() - startTime;
        console.log(`[API] [${requestId}] Request completed in ${elapsed}ms`);
      }
    });

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

    app.post("/api/refresh-realtime", async (_req, res) => {
      try {
        const token = process.env.VITE_METRA_API_TOKEN;
        if (!token) {
          return res.status(500).json({ error: "API token not configured" });
        }
        
        try {
          // If we have context db...
          const db = context.getDatabase ? context.getDatabase() : (await import("./db/schema.js")).getDatabase();
          db.prepare(`
            UPDATE crowding_cache 
            SET updated_at = datetime('now', '-2 hours')
            WHERE updated_at > datetime('now', '-24 hours')
          `).run();
          console.log("Crowding cache marked as stale - will refresh on next request (old data kept as fallback)");
        } catch (cacheError: any) {
          console.warn("Could not mark cache as stale:", cacheError.message);
        }
        
        if (!context.updateRealtimeData) {
          return res.json({ success: true, message: "Refresh requested (database unavailable)", timestamp: new Date().toISOString() });
        }
        try {
          await context.updateRealtimeData(token);
          
          const dbForTimestamp = context.getDatabase ? context.getDatabase() : (await import("./db/schema.js")).getDatabase();
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

    app.get("/api/realtime-status", async (_req, res) => {
      try {
        const db = context.getDatabase ? context.getDatabase() : (await import("./db/schema.js")).getDatabase();
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

    app.post("/api/reload-gtfs", async (_req, res) => {
      try {
        if (!context.loadGTFSIntoDatabase) {
          return res.status(503).json({ error: "Database not available" });
        }
        await context.loadGTFSIntoDatabase();
        res.json({ success: true, message: "GTFS data reloaded" });
      } catch (error: any) {
        console.error("Error reloading GTFS:", error.message);
        res.status(500).json({ error: "Failed to reload GTFS data" });
      }
    });

    app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (err instanceof URIError && err.message.includes('Failed to decode param')) {
        return res.status(404).end();
      }
      next(err);
    });

    app.use((req, res, next) => {
      if (req.url.includes('%VITE_') || req.url.includes('%PUBLIC_') || req.url.includes('umami')) {
        return res.status(404).end();
      }
      next();
    });

    app.use(express.static(effectiveStaticPath));

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
        const htmlPath = path.join(effectiveStaticPath, "index.html");
        let html = fs.readFileSync(htmlPath, 'utf8');
        
        // Gather initial data (use cached data from server memory)
        const initialData: Record<string, any> = {};
        
        try {
          if (context.getAllSchedules) {
            initialData.schedules = {
              PALATINE: context.getAllSchedules('PALATINE'),
              SCHAUM: context.getAllSchedules('SCHAUM'),
              WILMETTE: context.getAllSchedules('WILMETTE')
            };
          }
        } catch (e) {
          console.debug('Could not pre-load schedules:', e);
        }
        
        try {
          if (context.getAllWeather) {
            initialData.weather = context.getAllWeather();
          }
        } catch (e) {
          console.debug('Could not pre-load weather:', e);
        }
        
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
        
        try {
          initialData.crowding = {};
          
          if (crowdingCache.size > 0) {
            // Use in-memory cache if available
            crowdingCache.forEach((cached, routeKey) => {
              initialData.crowding[routeKey] = cached.data;
            });
          } else if (context.getDatabase) {
            // Cold start: Load from database for common routes
            const db = context.getDatabase();
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
        
        const dataScript = `<script>window.__INITIAL_DATA__ = ${JSON.stringify(initialData)};</script>`;
        html = html.replace('</head>', `${dataScript}\n</head>`);
        
        res.setHeader('Content-Type', 'text/html');
        res.send(html);
      } catch (e) {
        res.sendFile(path.join(effectiveStaticPath, "index.html"));
      }
    });
}
