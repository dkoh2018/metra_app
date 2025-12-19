import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.resolve(__dirname, 'metra.db');
const DB_DIR = path.dirname(DB_PATH);

export function initDatabase(): Database.Database {
  // Ensure database directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  
  const db = new Database(DB_PATH);
  
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  
  // Create schedules table - stores static schedule data from GTFS
  db.exec(`
    CREATE TABLE IF NOT EXISTS schedules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      route_id TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inbound', 'outbound')),
      stop_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL,
      arrival_time TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      is_express INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(trip_id, stop_id)
    );
    
    CREATE INDEX IF NOT EXISTS idx_schedules_route ON schedules(route_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_service ON schedules(service_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_direction ON schedules(direction);
    CREATE INDEX IF NOT EXISTS idx_schedules_stop ON schedules(stop_id);
    CREATE INDEX IF NOT EXISTS idx_schedules_time ON schedules(departure_time);
  `);
  
  // Create service_calendar table - maps service_id to day types
  db.exec(`
    CREATE TABLE IF NOT EXISTS service_calendar (
      service_id TEXT PRIMARY KEY,
      monday INTEGER DEFAULT 0,
      tuesday INTEGER DEFAULT 0,
      wednesday INTEGER DEFAULT 0,
      thursday INTEGER DEFAULT 0,
      friday INTEGER DEFAULT 0,
      saturday INTEGER DEFAULT 0,
      sunday INTEGER DEFAULT 0,
      start_date TEXT,
      end_date TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  // Create realtime_updates table - stores real-time trip updates
  db.exec(`
    CREATE TABLE IF NOT EXISTS realtime_updates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trip_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      scheduled_arrival TEXT,
      scheduled_departure TEXT,
      predicted_arrival TEXT,
      predicted_departure TEXT,
      delay_seconds INTEGER DEFAULT 0,
      update_timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(trip_id, stop_id, update_timestamp)
    );
    
    CREATE INDEX IF NOT EXISTS idx_realtime_trip ON realtime_updates(trip_id);
    CREATE INDEX IF NOT EXISTS idx_realtime_stop ON realtime_updates(stop_id);
    CREATE INDEX IF NOT EXISTS idx_realtime_timestamp ON realtime_updates(update_timestamp);
  `);
  
  // Create historical_delays table - stores delays by date for historical viewing
  db.exec(`
    CREATE TABLE IF NOT EXISTS historical_delays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      scheduled_time TEXT NOT NULL,
      actual_time TEXT,
      delay_seconds INTEGER DEFAULT 0,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(date, trip_id, stop_id, scheduled_time)
    );
    
    CREATE INDEX IF NOT EXISTS idx_historical_date ON historical_delays(date);
    CREATE INDEX IF NOT EXISTS idx_historical_trip ON historical_delays(trip_id);
    CREATE INDEX IF NOT EXISTS idx_historical_stop ON historical_delays(stop_id);
  `);
  
  // Create gtfs_metadata table - track when GTFS data was last updated
  db.exec(`
    CREATE TABLE IF NOT EXISTS gtfs_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      published_date TEXT NOT NULL,
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
      data_hash TEXT
    );
  `);
  
  // Create train_positions table - stores historical train position data
  db.exec(`
    CREATE TABLE IF NOT EXISTS train_positions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      train_number TEXT NOT NULL,
      trip_id TEXT,
      vehicle_id TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      bearing INTEGER,
      direction TEXT CHECK(direction IN ('inbound', 'outbound')),
      timestamp INTEGER,
      recorded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    
    CREATE INDEX IF NOT EXISTS idx_positions_train ON train_positions(train_number);
    CREATE INDEX IF NOT EXISTS idx_positions_trip ON train_positions(trip_id);
    CREATE INDEX IF NOT EXISTS idx_positions_recorded ON train_positions(recorded_at);
    CREATE INDEX IF NOT EXISTS idx_positions_direction ON train_positions(direction);
  `);
  
  // Create crowding_cache table - stores scraped crowding and delay data
  const existingCrowdingTable = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='crowding_cache'"
  ).get() as { sql?: string } | undefined;

  if (existingCrowdingTable?.sql && (!existingCrowdingTable.sql.includes("'some'") || !existingCrowdingTable.sql.includes("predicted_departure"))) {
    db.exec("DROP TABLE IF EXISTS crowding_cache");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS crowding_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origin TEXT NOT NULL,
      destination TEXT NOT NULL,
      trip_id TEXT NOT NULL,
      crowding TEXT CHECK(crowding IN ('low', 'some', 'moderate', 'high')),
      scheduled_departure TEXT,
      predicted_departure TEXT,
      scheduled_arrival TEXT,
      predicted_arrival TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(origin, destination, trip_id)
    );

    CREATE INDEX IF NOT EXISTS idx_crowding_origin_dest ON crowding_cache(origin, destination);
    CREATE INDEX IF NOT EXISTS idx_crowding_trip ON crowding_cache(trip_id);
    CREATE INDEX IF NOT EXISTS idx_crowding_updated ON crowding_cache(updated_at);
  `);

  // Create weather_data table - stores current weather for locations
  db.exec(`
    CREATE TABLE IF NOT EXISTS weather_data (
      location TEXT PRIMARY KEY,
      temp_f REAL,
      wind_speed_mph REAL,
      wind_direction INTEGER,
      condition_code INTEGER,
      condition_text TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  
  return db;
}

// Cache database connection for better performance
// SQLite with WAL mode supports concurrent reads, but we'll use a single connection
// for writes to avoid conflicts
let dbInstance: Database.Database | null = null;

export function getDatabase(): Database.Database {
  // Reuse existing connection if available
  // Note: better-sqlite3 connections are persistent and don't need to be checked for "open"
  // They will throw an error if used after being closed
  if (dbInstance) {
    try {
      // Test if connection is still valid by running a simple query
      dbInstance.prepare('SELECT 1').get();
      return dbInstance;
    } catch (error) {
      // Connection was closed, create a new one
      dbInstance = null;
    }
  }
  
  // Create new connection
  // Ensure database directory exists
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  
  dbInstance = new Database(DB_PATH);
  
  // Enable WAL mode for better concurrency
  dbInstance.pragma('journal_mode = WAL');
  
  // Set busy timeout to handle concurrent access gracefully
  dbInstance.pragma('busy_timeout = 5000');
  
  return dbInstance;
}

// For functions that need a fresh connection (e.g., for transactions that might fail)
export function getDatabaseAndClose(): Database.Database {
  return new Database(DB_PATH);
}

