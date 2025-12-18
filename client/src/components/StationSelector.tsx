import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { STATIONS } from "@/lib/stations"
import { cn } from "@/lib/utils"

interface StationSelectorProps {
  selectedGtfsId: string;
  onStationChange: (gtfsId: string) => void;
  className?: string;
}

export function StationSelector({ selectedGtfsId, onStationChange, className }: StationSelectorProps) {
  // Filter out OTC (Chicago) as it's the fixed destination, not a selectable origin for suburban commuters
  const suburbanStations = Object.values(STATIONS)
    .filter(s => s.gtfsId !== 'OTC' && s.gtfsId !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Select value={selectedGtfsId} onValueChange={onStationChange}>
      <SelectTrigger 
        className={cn(
          "w-auto min-w-[20px] px-2 py-1 h-auto border-0 bg-transparent shadow-none focus:ring-0", 
          "text-base sm:text-lg font-bold text-zinc-500 uppercase tracking-[0.15em] hover:text-zinc-700 hover:bg-zinc-100 rounded-md transition-colors",
          "justify-center flex gap-2 cursor-pointer",
          className
        )}
      >
        <SelectValue placeholder="Select Station" />
      </SelectTrigger>
      <SelectContent className="max-h-[300px]">
        {suburbanStations.map((station) => (
          <SelectItem key={station.gtfsId} value={station.gtfsId as string} className="font-medium text-zinc-600">
            {station.name.toUpperCase()}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
