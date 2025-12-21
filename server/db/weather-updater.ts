import axios from 'axios';
import { getDatabase } from './schema.js';

// Open-Meteo API URL
// We use current_weather=true to get current conditions
// temperature_unit=fahrenheit, windspeed_unit=mph
import { WEATHER_API } from '@shared/config';

const WEATHER_API_URL = WEATHER_API.BASE_URL;

interface WeatherConfig {
  name: string;
  lat: number;
  lon: number;
}

// Locations to monitor
const LOCATIONS: WeatherConfig[] = [
  { name: 'Chicago', lat: 41.8781, lon: -87.6298 },
  { name: 'Palatine', lat: 42.1103, lon: -88.0342 },
  { name: 'Schaumburg', lat: 42.0334, lon: -88.0834 },
  { name: 'Wilmette', lat: 42.0773, lon: -87.7092 },
  { name: 'Westmont', lat: 41.7956, lon: -87.9764 },
  { name: 'Lombard', lat: 41.8867, lon: -88.0186 }
];

export async function updateWeatherData(): Promise<void> {
  const db = getDatabase();
  
  try {
    const now = new Date();
    // Format: YYYY-MM-DD HH:MM:SS
    const chicagoTime = now.toLocaleString('en-US', {
      timeZone: 'America/Chicago',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).replace(/(\d+)\/(\d+)\/(\d+),/, '$3-$1-$2');

    const updateStmt = db.prepare(`
      INSERT INTO weather_data (location, temp_f, wind_speed_mph, wind_direction, condition_code, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(location) DO UPDATE SET
        temp_f = excluded.temp_f,
        wind_speed_mph = excluded.wind_speed_mph,
        wind_direction = excluded.wind_direction,
        condition_code = excluded.condition_code,
        updated_at = excluded.updated_at
    `);
    
    const transaction = db.transaction((updates: any[]) => {
      for (const update of updates) {
        updateStmt.run(
          update.location,
          update.temp_f,
          update.wind_speed_mph,
          update.wind_direction,
          update.condition_code,
          chicagoTime
        );
      }
    });

    const pendingUpdates = [];

    for (const loc of LOCATIONS) {
      try {
        const response = await axios.get(WEATHER_API_URL, {
          params: {
            latitude: loc.lat,
            longitude: loc.lon,
            current_weather: true,
            temperature_unit: 'fahrenheit',
            windspeed_unit: 'mph'
          }
        });
        
        const weather = response.data.current_weather;
        
        if (weather) {
          pendingUpdates.push({
            location: loc.name,
            temp_f: weather.temperature,
            wind_speed_mph: weather.windspeed,
            wind_direction: weather.winddirection,
            condition_code: weather.weathercode
          });
        }
      } catch (err: any) {
        console.error(`Failed to fetch weather for ${loc.name}:`, err.message);
      }
    }
    
    if (pendingUpdates.length > 0) {
      transaction(pendingUpdates);
      console.log(`✅ Weather data updated for ${pendingUpdates.length} locations`);
    }

  } catch (error: any) {
    console.error('Error updating weather data:', error.message);
    throw error;
  }
}

export function getAllWeather() {
  const db = getDatabase();
  return db.prepare('SELECT * FROM weather_data').all();
}
