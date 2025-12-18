
import { ArrowLeftRight, ArrowRight } from 'lucide-react';
import { cn } from "@/lib/utils";
import { Direction } from "@/types/schedule";
import { StationSelector } from "@/components/StationSelector";
import { formatChicagoTime } from "@/lib/time";

interface ScheduleHeaderProps {
  direction: Direction;
  setDirection: (d: Direction) => void;
  selectedGtfsId: string;
  setSelectedGtfsId: (id: string) => void;
  lastUpdate: string | null;
}

export function ScheduleHeader({
  direction,
  setDirection,
  selectedGtfsId,
  setSelectedGtfsId,
  lastUpdate
}: ScheduleHeaderProps) {
  return (
    <div className="mb-4">
      {/* Main Row: Direction + Branding + Time */}
      <div className="flex items-center justify-between gap-2">
        
        {/* Left: Direction Switcher - Matches card style */}
        <button
          onClick={() => setDirection(direction === 'inbound' ? 'outbound' : 'inbound')}
          className={cn(
            "flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold transition-all",
            "border shadow-sm bg-white",
            direction === 'inbound' 
              ? "border-blue-200 text-blue-700 hover:bg-blue-50" 
              : "border-amber-200 text-amber-700 hover:bg-amber-50"
          )}
        >
          <ArrowLeftRight className="w-3 h-3" />
          <span className="font-bold">{direction === 'inbound' ? 'Inbound' : 'Outbound'}</span>
          <ArrowRight className="w-3 h-3 opacity-50" />
          <span>{direction === 'inbound' ? 'Chicago' : 'Suburbs'}</span>
        </button>

        {/* Center: Branding - Station Selector */}
        <div className="flex-1 text-center py-1 flex items-center justify-center">
          <StationSelector 
            selectedGtfsId={selectedGtfsId} 
            onStationChange={setSelectedGtfsId} 
          />
        </div>

        {/* Right: Live Sync Status - Matches card style */}
        <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-zinc-200 shadow-sm text-zinc-600">
          <span className="relative flex h-1.5 w-1.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
          </span>
          <span className="text-xs font-medium font-mono">
            {lastUpdate ? (() => {
              const date = lastUpdate.includes('T') ? new Date(lastUpdate) : new Date(lastUpdate.replace(' ', 'T') + 'Z');
              return formatChicagoTime(date, { hour: 'numeric', minute: '2-digit' });
            })() : '...'}
          </span>
        </div>
      </div>
    </div>
  );
}
