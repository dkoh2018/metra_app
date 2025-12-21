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
  // Filter to only show supported suburban stations (OTC is the fixed destination)
  const suburbanStations = Object.values(STATIONS)
    .filter(s => s.gtfsId && ['PALATINE', 'SCHAUM', 'WILMETTE', 'WESTMONT', 'LOMBARD'].includes(s.gtfsId))
    .sort((a, b) => {
      // Keep Palatine at top if desired, or just alphabetical.
      // Given "vertical fix", I'll keep them alphabetical for now unless specified.
      return a.name.localeCompare(b.name);
    });

  return (
    <Select value={selectedGtfsId} onValueChange={onStationChange}>
      <SelectTrigger 
        className={cn(
          "w-full max-w-full px-0 py-1 h-auto border-0 bg-transparent shadow-none focus:ring-0", 
          "text-sm sm:text-base md:text-lg font-bold text-zinc-500 uppercase tracking-normal sm:tracking-[0.15em] hover:text-zinc-700 hover:bg-zinc-100 rounded-md transition-colors",
          "justify-center flex gap-0.5 cursor-pointer truncate",
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
