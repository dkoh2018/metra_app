import { useState, useEffect } from 'react';

export interface WeatherData {
  location: string;
  temp_f: number;
  wind_speed_mph: number;
  wind_direction: number;
  condition_code: number;
  updated_at: string;
}

export function useWeather() {
  const [weather, setWeather] = useState<WeatherData[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchWeather = async () => {
      try {
        const res = await fetch('/api/weather');
        if (res.ok) {
          const data = await res.json();
          setWeather(data.weather || []);
        }
      } catch (error) {
        console.error('Failed to fetch weather:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchWeather();
    // Poll every 1 minute
    const interval = setInterval(fetchWeather, 60 * 1000);
    
    return () => clearInterval(interval);
  }, []);

  const getWeatherForLocation = (locationName: string) => {
    if (!locationName) return null;
    
    // Normalize names for comparison
    const target = locationName.toLowerCase();
    
    return weather.find(w => {
      const wLoc = w.location.toLowerCase();
      // Handle "Schaumburg" matching "Schaum" if needed, though backend names are clean
      return wLoc === target || wLoc.includes(target) || target.includes(wLoc);
    });
  };

  return { weather, loading, getWeatherForLocation };
}
