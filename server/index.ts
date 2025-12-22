import express from "express";
import { createServer } from "http";
import dotenv from "dotenv";
import { registerRoutes } from "./routes.js";
import { scheduleDailyScrapes, scheduleFrequentDelayScrapes } from "./lib/scheduler.js";
import { getWeatherInterval, isActiveHours } from "./config.js";
import { context } from "./lib/context.js";

dotenv.config();

async function startServer() {
  try {
    const app = express();
    const server = createServer(app);
    
    app.use(express.json());

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
          
          // Populate context for other modules to use
          context.getDatabase = dbModule.getDatabase;
          context.getAllSchedules = scheduleModule.getAllSchedules;
          context.getNextTrain = scheduleModule.getNextTrain;
          context.shouldUpdateGTFS = scheduleModule.shouldUpdateGTFS;
          context.getAllDelays = realtimeModule.getAllDelays;
          context.updateRealtimeData = realtimeModule.updateRealtimeData;
          context.updateWeatherData = weatherModule.updateWeatherData;
          context.getAllWeather = weatherModule.getAllWeather;
          context.loadGTFSIntoDatabase = loaderModule.loadGTFSIntoDatabase;
          
          // Initialize database schema
          const { initDatabase } = dbModule;
          initDatabase();
          
          // Start the daily scheduled scrape task
          scheduleDailyScrapes();
          
          // Start the 7-minute delay scrape task (active hours only)
          scheduleFrequentDelayScrapes();
          
          if (context.shouldUpdateGTFS && context.shouldUpdateGTFS()) {
            console.log("Loading GTFS data into database...");
            if (context.loadGTFSIntoDatabase) {
                await context.loadGTFSIntoDatabase();
            }
          }
          console.log("✅ Database initialized successfully");
          
          // Start intervals after DB and functions are ready
          const apiToken = process.env.VITE_METRA_API_TOKEN;
          
          // Real-time updates
          if (apiToken && context.updateRealtimeData) {
             console.log("⏱️  Starting real-time data polling...");
             // Initial update
             context.updateRealtimeData(apiToken).catch((err: any) => console.error("Realtime init error:", err));
             
             // Server polling alignment
             const now = new Date();
             const msSinceLast30 = now.getTime() % 30000;
             const msToNextSync = 30000 - msSinceLast30;
             
             setTimeout(() => {
               const syncRealtimeData = async () => {
                 try {
                    if (context.updateRealtimeData) await context.updateRealtimeData(apiToken);
                 } catch (e: any) { console.error("Realtime sync error:", e.message); }
               };
               syncRealtimeData();
               setInterval(syncRealtimeData, 30000);
               console.log("⏱️  Server polling aligned to wall clock (:00/:30)");
             }, msToNextSync);
          }

          // Weather updates - dynamic interval based on active hours
          if (context.updateWeatherData) {
             console.log("🌦️  Starting weather data polling (dynamic interval)...");
             // Initial update
             context.updateWeatherData().catch((err: any) => console.error("Weather init error:", err));
             
             // Dynamic scheduling - recalculates interval each time
             const scheduleWeatherUpdate = () => {
               const interval = getWeatherInterval();
               const intervalMin = Math.round(interval / 1000 / 60);
               console.log(`🌦️  Next weather update in ${intervalMin} min (active=${isActiveHours()})`);
               
               setTimeout(() => {
                 console.log("🌦️  Updating weather data...");
                 if (context.updateWeatherData) {
                    context.updateWeatherData().catch((err: any) => console.error("Weather update error:", err.message));
                 }
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

    // Register all routes and SSR logic
    registerRoutes(app);

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
