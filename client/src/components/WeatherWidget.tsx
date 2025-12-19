import { useWeather } from '@/hooks/useWeather';
import { Cloud, CloudRain, CloudSnow, Sun, Wind } from 'lucide-react';
import { cn } from '@/lib/utils';

interface WeatherWidgetProps {
  location: string;
  className?: string;
}

export function WeatherWidget({ location, className }: WeatherWidgetProps) {
  const { getWeatherForLocation, loading } = useWeather();
  const weather = getWeatherForLocation(location);

  if (loading || !weather) return null;

  // Simple icon mapping based on WMO codes
  // 0: Clear sky
  // 1, 2, 3: Mainly clear, partly cloudy, and overcast
  // 45, 48: Fog
  // 51, 53, 55: Drizzle
  // 61, 63, 65: Rain
  // 71, 73, 75: Snow
  const getIcon = (code: number) => {
    if (code === 0 || code === 1) return <Sun className="w-3 h-3 text-amber-500" />;
    if (code >= 71) return <CloudSnow className="w-3 h-3 text-blue-400" />;
    if (code >= 51) return <CloudRain className="w-3 h-3 text-blue-500" />;
    return <Cloud className="w-3 h-3 text-zinc-400" />;
  };

  return (
    <div className={cn("flex items-center gap-1 text-xs font-medium", className)}>
      <div className="flex items-center gap-0.5">
        {getIcon(weather.condition_code)}
        <span>{Math.round(weather.temp_f)}°</span>
      </div>
      
      {weather.wind_speed_mph > 10 && (
        <div className="flex items-center gap-0.5">
          <Wind className="w-2.5 h-2.5" />
          <span>{Math.round(weather.wind_speed_mph)}</span>
        </div>
      )}
    </div>
  );
}
