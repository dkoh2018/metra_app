import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet';
import { RotateCcw } from 'lucide-react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { STATIONS } from '@/lib/stations';
import { LINE_COLORS } from '@/lib/colors';
import { Train, Station } from '@shared/types';
import { MAP_CONFIG } from '@shared/config';
import { SUPPORTED_LINES } from '@shared/constants';

// Key stations on the UP-NW line (full line from Harvard to Chicago)
// Coordinates from GTFS stops.txt
// Station definitions moved to @/lib/stations.ts

// Map center - Balanced to show all tracks
const MAP_CENTER: [number, number] = [41.96, -87.83];
const DEFAULT_ZOOM = 9;

interface TripSchedule {
    stop_id: string;
    stop_sequence: number;
    arrival_time: string;
    departure_time: string;
    delay_seconds: number | null;
    predicted_arrival: string | null;
    predicted_departure: string | null;
}

interface TrainMapProps {
  className?: string;
}

// Train data from the API
interface TrainPosition {
  id: string;
  trainNumber: string;
  tripId?: string;
  lineId?: string; // Added for multi-line support
  latitude: number;
  longitude: number;
  bearing?: number;
  timestamp?: string;
  vehicleId?: string;
  direction?: 'inbound' | 'outbound' | 'unknown';
}

// Utility: Find closest point on the rail line and get the track bearing at that point
function snapToTrack(
  lat: number, 
  lng: number, 
  railLine: Array<[number, number]>,
  direction: 'inbound' | 'outbound' | 'unknown'
): { snappedLat: number; snappedLng: number; trackBearing: number } {
  if (railLine.length < 2) {
    return { snappedLat: lat, snappedLng: lng, trackBearing: direction === 'inbound' ? 135 : 315 };
  }

  let closestPoint = { lat, lng };
  let closestDistance = Infinity;
  let segmentIndex = 0;

  // Find the closest point on any line segment
  for (let i = 0; i < railLine.length - 1; i++) {
    const [lat1, lng1] = railLine[i];
    const [lat2, lng2] = railLine[i + 1];

    // Project point onto line segment
    const dx = lat2 - lat1;
    const dy = lng2 - lng1;
    const segmentLengthSq = dx * dx + dy * dy;

    if (segmentLengthSq === 0) continue;

    // t is the parameter along the segment (0 = start, 1 = end)
    let t = ((lat - lat1) * dx + (lng - lng1) * dy) / segmentLengthSq;
    t = Math.max(0, Math.min(1, t)); // Clamp to segment

    const projectedLat = lat1 + t * dx;
    const projectedLng = lng1 + t * dy;

    const distSq = (lat - projectedLat) ** 2 + (lng - projectedLng) ** 2;

    if (distSq < closestDistance) {
      closestDistance = distSq;
      closestPoint = { lat: projectedLat, lng: projectedLng };
      segmentIndex = i;
    }
  }

  // Calculate bearing along the track at this segment
  const [segLat1, segLng1] = railLine[segmentIndex];
  const [segLat2, segLng2] = railLine[segmentIndex + 1] || railLine[segmentIndex];

  // Calculate angle from segment start to end (in degrees, 0 = north, 90 = east)
  const dLat = segLat2 - segLat1;
  const dLng = segLng2 - segLng1;
  let trackAngle = Math.atan2(dLng, dLat) * (180 / Math.PI); // atan2(x, y) for map coords

  // For inbound (toward Chicago = south-east), we want the segment direction as-is
  // For outbound (away from Chicago = north-west), we flip it 180 degrees
  // The rail line is stored inbound (Harvard to Chicago), so:
  // - Inbound trains go in the positive direction of the array
  // - Outbound trains go in the negative direction
  let trackBearing = trackAngle;
  if (direction === 'outbound') {
    trackBearing = (trackAngle + 180) % 360;
  }

  // Convert to compass bearing (0 = North, positive clockwise)
  if (trackBearing < 0) trackBearing += 360;

  return { 
    snappedLat: closestPoint.lat, 
    snappedLng: closestPoint.lng, 
    trackBearing 
  };
}

// Create a custom train icon with direction arrow attached to the circle
// Create a custom train icon with direction arrow attached to the circle
const createTrainIcon = (trainNumber: string, bearing?: number, direction?: string) => {
  const isInbound = direction === 'inbound';
  
  // Revert to Blue/Orange as requested, overriding line colors for the icon itself
  const primaryColor = isInbound ? '#3b82f6' : '#f59e0b';
  
  // Neon bright colors for the arrow (Direction Indicator)
  const arrowColor = isInbound ? '#00d4ff' : '#ff6b00'; // Neon cyan / Neon orange
  
  // Bearing is the track direction (0 = North, 90 = East, etc.)
  // We want the arrow to point IN the direction of travel
  const arrowAngle = bearing ?? (isInbound ? 135 : 315);
  
  // Icon size and circle radius
  const iconSize = 60;
  const circleRadius = 12;
  const arrowLength = 10;
  
  // Calculate arrow position on circle edge
  // Arrow points outward from circle in the direction of travel
  const angleRad = (arrowAngle - 90) * (Math.PI / 180); // -90 because CSS rotation 0 = "up"
  const arrowX = iconSize/2 + Math.cos(angleRad) * (circleRadius + arrowLength/2);
  const arrowY = iconSize/2 + Math.sin(angleRad) * (circleRadius + arrowLength/2);

  const iconHtml = `
    <div style="
      position: relative;
      width: ${iconSize}px;
      height: ${iconSize}px;
    ">
      <!-- Train Circle (centered in the icon) -->
      <div style="
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: ${circleRadius * 2}px;
        height: ${circleRadius * 2}px;
        background: ${primaryColor};
        border-radius: 50%;
        border: 2px solid ${primaryColor};
        box-shadow: 0 2px 6px rgba(0,0,0,0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 2;
      ">
        <span style="color: white; font-size: 8px; font-weight: bold;">${trainNumber}</span>
      </div>
      
      <!-- Direction Arrow (attached to circle edge, pointing along track) -->
      <div style="
        position: absolute;
        left: ${arrowX}px;
        top: ${arrowY}px;
        transform: translate(-50%, -50%) rotate(${arrowAngle}deg);
        width: 0;
        height: 0;
        border-left: 6px solid transparent;
        border-right: 6px solid transparent;
        border-bottom: 12px solid ${arrowColor};
        filter: drop-shadow(0 0 3px ${arrowColor}) drop-shadow(0 0 6px ${arrowColor});
        z-index: 3;
      "></div>
    </div>
  `;

  return L.divIcon({
    html: iconHtml,
    className: 'train-marker',
    iconSize: [iconSize, iconSize],
    // Anchor at center of the icon (where the circle is)
    iconAnchor: [iconSize/2, iconSize/2],
    popupAnchor: [0, -circleRadius - 5],
  });
};

const createStationIcon = (isTerminal: boolean = false) => {
  const size = 14; // All stations same size as terminal
  const iconHtml = `
    <div style="
      width: ${size}px;
      height: ${size}px;
      background: ${isTerminal ? '#ef4444' : '#9ca3af'};
      border-radius: 50%;
      border: 2px solid white;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      transform: translate(-50%, -50%);
    "></div>
  `;

  return L.divIcon({
    html: iconHtml,
    className: 'station-marker',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
    popupAnchor: [0, -10],
  });
};

// Create a glowing green user location icon (Apple Maps style)
const createUserLocationIcon = () => {
  const iconHtml = `
    <div style="
      position: relative;
      width: 36px;
      height: 36px;
    ">
      <!-- Outer pulsing glow ring - DARK GREEN -->
      <div style="
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 28px;
        height: 28px;
        background: rgba(0, 180, 80, 0.4);
        border: 2px solid rgba(0, 180, 80, 0.7);
        border-radius: 50%;
        animation: userPulse 1.5s ease-out infinite;
        filter: blur(1px);
      "></div>
      <!-- Static glow ring - DARK GREEN -->
      <div style="
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 18px;
        height: 18px;
        background: rgba(0, 180, 80, 0.5);
        border-radius: 50%;
        box-shadow: 0 0 12px rgba(0, 180, 80, 0.8), 0 0 20px rgba(0, 180, 80, 0.5);
      "></div>
      <!-- Core bright dot - DARK GREEN -->
      <div style="
        position: absolute;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        width: 12px;
        height: 12px;
        background: #00b450;
        border-radius: 50%;
        border: 2px solid white;
        box-shadow: 
          0 0 0 2px rgba(0, 180, 80, 0.5),
          0 0 8px rgba(0, 180, 80, 1),
          0 0 16px rgba(0, 180, 80, 0.8),
          0 0 24px rgba(0, 180, 80, 0.5);
      "></div>
    </div>
    <style>
      @keyframes userPulse {
        0% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
        100% { transform: translate(-50%, -50%) scale(2.2); opacity: 0; }
      }
    </style>
  `;

  return L.divIcon({
    html: iconHtml,
    className: 'user-location-marker',
    iconSize: [36, 36],
    iconAnchor: [18, 18],
    popupAnchor: [0, -14],
  });
};



// Custom control to reset map view - Matches Leaflet zoom control style
function ResetZoomControl() {
  const map = useMap();
  
  const handleReset = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    // Reset to default center and zoom
  map.setView(MAP_CENTER, DEFAULT_ZOOM);
  };

  return (
    <div className="leaflet-top leaflet-left" style={{ marginTop: '60px', marginLeft: '1px' }}>
      <div className="leaflet-control" style={{ marginTop: '0', border: 'none', boxShadow: 'none' }}>
        <button 
          type="button"
          onClick={handleReset}
          title="Reset View"
          aria-label="Reset View"
          style={{ 
            display: 'flex', 
            alignItems: 'center', 
            justifyContent: 'center',
            width: '31px', 
            height: '31px',
            color: '#333',
            backgroundColor: 'white',
            border: '1px solid #ccc',
            borderTop: 'none',
            borderRadius: '0 0 4px 4px',
            cursor: 'pointer',
            marginTop: '13px'
          }}
        >
          <RotateCcw className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}


// Memoized TrainMarker component to prevent event handler and icon thrashing
const TrainMarker = ({ 
  train, 
  railLines, 
  onTrainClick, 
  isSelected, 
  loadingSchedule, 
  schedule, 
  selectedCrowding,
  STATIONS 
}: { 
  train: TrainPosition;
  railLines: Record<string, Array<[number, number]>>;
  onTrainClick: (tripId: string) => void;
  isSelected: boolean;
  loadingSchedule: boolean;
  schedule: TripSchedule[];
  selectedCrowding: string | null;
  STATIONS: Record<string, Station>;
}) => {
  // 1. Memoize handlers to prevent listener detachment/reattachment on every frame
  const eventHandlers = useMemo(() => ({
    click: () => {
      console.log('🚂 Clicked train (Stable Handler):', train.trainNumber, 'TripID:', train.tripId);
      if (train.tripId) {
        onTrainClick(train.tripId);
      } else {
        console.warn('⚠️ No tripId for this train!');
      }
    }
  }), [train.tripId, train.trainNumber, onTrainClick]);

  // 2. Identify line and snap to track
  // This calculation runs every frame, but that's necessary for animation.
  // We compute it here to keep the main component clean.
  const trainLineId = train.lineId || (train.tripId && train.tripId.includes('MD-W') ? 'MD-W' : 'UP-NW');
  const targetLine = railLines[trainLineId] || railLines['UP-NW'];
  
  const { snappedLat, snappedLng, trackBearing } = snapToTrack(
    train.latitude,
    train.longitude,
    targetLine || [],
    train.direction || 'unknown'
  );

  // 3. Memoize icon creation if bearing hasn't changed (optional optimization, but good for performance)
  // We round bearing to nearest integer to reduce icon thrashing if bearing jitters slightly
  const roundedBearing = Math.round(trackBearing);
  const icon = useMemo(() => 
    createTrainIcon(train.trainNumber, roundedBearing, train.direction),
  [train.trainNumber, roundedBearing, train.direction]);

  return (
    <Marker
      position={[snappedLat, snappedLng]}
      icon={icon}
      zIndexOffset={100}
      eventHandlers={eventHandlers}
    >
      <Popup 
        className="train-popup" 
        minWidth={280} 
        maxWidth={280}
      >
        <div className="p-1">
          <div className="flex items-center justify-between mb-2 pb-2 border-b border-zinc-100">
            <div>
              <div className="text-base font-bold text-zinc-800">Train #{train.trainNumber}</div>
              <div className={`text-xs font-semibold ${train.direction === 'inbound' ? 'text-blue-600' : 'text-amber-600'}`}>
                {train.direction === 'inbound' ? '→ Inbound to Chicago' : '← Outbound'}
              </div>
            </div>
            
            {/* Live Pulse Indicator & Crowding Badge */}
            <div className="flex flex-col items-end gap-1">
              <div className="flex items-center gap-1.5 bg-green-50 px-2 py-1 rounded-full border border-green-100">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500"></span>
                </span>
                <span className="text-[10px] font-bold text-green-700 uppercase tracking-wider">Live</span>
              </div>
              {selectedCrowding && isSelected && (
                  <div className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
                    selectedCrowding === 'LOW' ? 'bg-green-100 text-green-800 border-green-200' :
                    selectedCrowding === 'MEDIUM' ? 'bg-yellow-100 text-yellow-800 border-yellow-200' :
                    'bg-red-100 text-red-800 border-red-200'
                  }`}>
                    {selectedCrowding} Load
                  </div>
              )}
            </div>
          </div>

          {loadingSchedule && isSelected ? (
            <div className="py-4 text-center">
              <div className="animate-spin h-5 w-5 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-2"></div>
              <div className="text-xs text-zinc-400">Loading schedule...</div>
            </div>
          ) : isSelected && schedule.length > 0 ? (
            <div 
              className="max-h-[200px] overflow-y-auto pr-1 custom-scrollbar"
              onWheel={(e) => {
                // Stop scroll events from propagating to the map
                e.stopPropagation();
              }}
              style={{
                scrollBehavior: 'smooth',
                WebkitOverflowScrolling: 'touch'
              }}
            >
              <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider mb-1">Next Stops</div>
              <div className="space-y-px">
                {schedule.filter(stop => {
                  // Filter logic: Only show stops in the future
                  if (!stop.arrival_time) return false;
                  
                  const now = new Date();
                  const currentMinutes = now.getHours() * 60 + now.getMinutes();
                  
                  const [h, m] = stop.arrival_time.split(':').map(Number);
                  let stopMinutes = h * 60 + m;
                  
                  // OVERNIGHT FIX: Handle GTFS 24:XX format
                  const EARLY_MORNING_CUTOFF = 4 * 60; // 4 AM
                  const EVENING_START = 18 * 60; // 6 PM
                  const MIDNIGHT = 24 * 60;
                  
                  if (currentMinutes < EARLY_MORNING_CUTOFF && 
                      stopMinutes >= EVENING_START && 
                      stopMinutes < MIDNIGHT) {
                    return false;
                  }
                  
                  if (currentMinutes < EARLY_MORNING_CUTOFF && stopMinutes >= MIDNIGHT) {
                    stopMinutes -= MIDNIGHT;
                  }
                  
                  return stopMinutes > currentMinutes;
                }).map((stop, outputIndex) => {
                  // Find station name
                  // Find station name
                  const stationEntry = Object.values(STATIONS).find(s => s.gtfsId === stop.stop_id);
                  
                  const getStationName = (stopId: string) => {
                    if (stationEntry) return stationEntry.name;
                    return stopId
                      .toLowerCase()
                      .split('_')
                      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                      .join(' ');
                  };

                  const stationName = getStationName(stop.stop_id);
                  const isNextStop = outputIndex === 0;

                  // Robust time formatting
                  const formatTime = (timeStr: string) => {
                      if (!timeStr) return '--:--';
                      try {
                          // Handle ISO timestamps (from realtime_updates)
                          // Example: 2025-12-23T07:18:14.000Z
                          if (timeStr.includes('T') || timeStr.includes('Z')) {
                            const date = new Date(timeStr);
                            if (isNaN(date.getTime())) return timeStr;
                            
                            // FORCE Chicago Timezone
                            return new Intl.DateTimeFormat('en-US', {
                              timeZone: 'America/Chicago',
                              hour: 'numeric',
                              minute: '2-digit',
                              hour12: true
                            }).format(date);
                          }

                          // Handle GTFS HH:MM:SS (potentially > 24 for overnight)
                          const parts = timeStr.split(':');
                          if (parts.length < 2) return timeStr; 
                          
                          let h = parseInt(parts[0]);
                          const m = parseInt(parts[1]);
                          
                          if (isNaN(h) || isNaN(m)) return timeStr;
                          
                          // Fix 24:xx, 25:xx, 26:xx -> 00:xx, 01:xx, 02:xx
                          if (h >= 24) {
                            h = h % 24;
                          }
                          
                          const ampm = h >= 12 ? 'PM' : 'AM';
                          const h12 = h % 12 || 12;
                          
                          return `${h12}:${m.toString().padStart(2, '0')} ${ampm}`;
                      } catch (e) {
                          return timeStr;
                      }
                  };
                  
                  // Calculate delay color logic here (omitted for brevity, assume default text color if logic complex)
                  // For now, simpler rendering to ensure it works
                  
                  return (
                    <div key={`${stop.stop_id}-${outputIndex}`} className={`flex justify-between items-center py-0.5 px-2 rounded group ${isNextStop ? 'bg-blue-50 border-l-2 border-blue-500' : 'hover:bg-zinc-50'}`}>
                      <div className="flex items-center gap-2 overflow-hidden">
                          <div className={`w-1.5 h-1.5 rounded-full ${isNextStop ? 'bg-blue-500 animate-pulse' : (stationEntry?.isTerminal || stationEntry?.isHighlight ? 'bg-zinc-800' : 'bg-zinc-300 group-hover:bg-zinc-400')}`}></div>
                          <span className={`text-xs truncate ${isNextStop ? 'font-bold text-blue-900' : (stationEntry?.isHighlight ? 'font-bold text-zinc-800' : 'text-zinc-600')}`}>{stationName}</span>
                      </div>
                      <div className="text-xs font-mono font-medium text-zinc-500">
                        {formatTime(stop.predicted_arrival || stop.arrival_time)}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="text-xs text-zinc-400 italic py-2 text-center">
              Click train to view schedule
            </div>
          )}
        </div>
      </Popup>
    </Marker>
  );
};

export default function TrainMap({ className = '' }: TrainMapProps) {
  const [trains, setTrains] = useState<TrainPosition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [stationIcon, setStationIcon] = useState<L.DivIcon | null>(null);
  const [terminalIcon, setTerminalIcon] = useState<L.DivIcon | null>(null);
  
  // Store multiple lines: 'UP-NW' -> points[], 'MD-W' -> points[]
  const [railLines, setRailLines] = useState<Record<string, Array<[number, number]>>>({});
  
  const [selectedTripId, setSelectedTripId] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<TripSchedule[]>([]);
  const [loadingSchedule, setLoadingSchedule] = useState(false);
  const [selectedCrowding, setSelectedCrowding] = useState<string | null>(null);
  
  const [userLocation, setUserLocation] = useState<{ lat: number; lng: number } | null>(null);
  const [userLocationIcon, setUserLocationIcon] = useState<L.DivIcon | null>(null);

  // Define fetchTripSchedule using useCallback to be stable
  const fetchTripSchedule = useCallback(async (tripId: string) => {
    if (!tripId) return;
    
    setLoadingSchedule(true);
    setSelectedTripId(tripId);
    setSchedule([]); // Clear previous
    setSelectedCrowding(null);
    
    try {
      const response = await fetch(`/api/trip-schedule/${tripId}`);
      if (!response.ok) throw new Error('Failed to fetch schedule');
      const data = await response.json();
      setSchedule(data.schedule || []);
      setSelectedCrowding(data.crowding || null);
    } catch (err) {
      console.error('Error fetching trip schedule:', err);
    } finally {
      setLoadingSchedule(false);
    }
  }, []); // ID-independent

  const fetchPositions = useCallback(async () => {
    try {
      const lines = SUPPORTED_LINES;
      const responses = await Promise.all(
        lines.map(id => fetch(`/api/positions/${id}`).then(r => r.json()))
      );

      const allTrains = responses.flatMap((data, index) => {
        if (data && Array.isArray(data.trains)) {
          return data.trains.map((t: any) => ({ ...t, lineId: lines[index] }));
        }
        return [];
      });

      setTrains(allTrains);
      setLastUpdate(new Date());
      setError(null);
    } catch (err: any) {
      console.error('Error fetching train positions:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  const useInterpolatedPositions = (rawTrains: TrainPosition[]) => {
    const targetsRef = useRef<Record<string, { start: [number, number], target: [number, number], startTime: number }>>({});
    const [animatedTrains, setAnimatedTrains] = useState<TrainPosition[]>(rawTrains);

    useEffect(() => {
        const now = performance.now();
        const newTargets = { ...targetsRef.current };
        
        rawTrains.forEach(train => {
            const newPos: [number, number] = [train.latitude, train.longitude];
            
            if (newTargets[train.id]) {
                const prevTarget = newTargets[train.id].target;
                if (prevTarget[0] !== newPos[0] || prevTarget[1] !== newPos[1]) {
                    newTargets[train.id] = {
                        start: prevTarget,
                        target: newPos,
                        startTime: now
                    };
                }
            } else {
                newTargets[train.id] = {
                    start: newPos,
                    target: newPos,
                    startTime: now
                };
            }
        });
        
        Object.keys(newTargets).forEach(id => {
            if (!rawTrains.find(t => t.id === id)) {
                delete newTargets[id];
            }
        });

        targetsRef.current = newTargets;
    }, [rawTrains]);

    useEffect(() => {
        let animationFrameId: number;
        const animate = (time: number) => {
            const DURATION = 30000;
            const frameTrains = rawTrains.map(train => {
                const animData = targetsRef.current[train.id];
                if (!animData) return train;

                const elapsed = time - animData.startTime;
                const progress = Math.min(1, elapsed / DURATION);
                
                const lat = animData.start[0] + (animData.target[0] - animData.start[0]) * progress;
                const lng = animData.start[1] + (animData.target[1] - animData.start[1]) * progress;
                
                return { ...train, latitude: lat, longitude: lng };
            });

            setAnimatedTrains(frameTrains);
            animationFrameId = requestAnimationFrame(animate);
        };

        animationFrameId = requestAnimationFrame(animate);
        return () => cancelAnimationFrame(animationFrameId);
    }, [rawTrains]);

    return animatedTrains;
  };

  const ghostTrains = useInterpolatedPositions(trains);

  useEffect(() => {
    const lines = SUPPORTED_LINES;
    Promise.all(lines.map(id => fetch(`/api/shapes/${id}`).then(r => r.json())))
      .then(results => {
        const newRailLines: Record<string, Array<[number, number]>> = {};
        results.forEach((data, index) => {
          const lineId = lines[index];
          if (Array.isArray(data.inbound) && data.inbound.length > 0) {
             const firstItem = data.inbound[0];
             if (Array.isArray(firstItem) && firstItem.length > 0 && Array.isArray(firstItem[0])) {
                 const segments = data.inbound as Array<Array<[number, number]>>;
                 const mainLine = segments.reduce((prev, current) => (prev.length > current.length) ? prev : current, []);
                 newRailLines[lineId] = mainLine;
             } else {
                 newRailLines[lineId] = data.inbound;
             }
          }
        });
        setRailLines(newRailLines);
      })
      .catch(err => console.error('Error loading rail lines:', err));
  }, []);

  useEffect(() => {
    setStationIcon(createStationIcon(false));
    setTerminalIcon(createStationIcon(true));
    setUserLocationIcon(createUserLocationIcon());
    
    fetchPositions();
    
    const now = new Date();
    const msSinceLast30 = now.getTime() % 30000;
    const msToNextSync = 30000 - msSinceLast30;
    
    let interval: NodeJS.Timeout;
    const timeout = setTimeout(() => {
        fetchPositions();
        interval = setInterval(fetchPositions, 30000);
    }, msToNextSync);
    
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [fetchPositions]);

  useEffect(() => {
    if (!navigator.geolocation) return;
    const handleSuccess = (position: GeolocationPosition) => {
      setUserLocation({
        lat: position.coords.latitude,
        lng: position.coords.longitude
      });
    };
    const handleError = () => setUserLocation(null);
    const watchId = navigator.geolocation.watchPosition(handleSuccess, handleError, {
      enableHighAccuracy: true,
      timeout: 10000,
      maximumAge: 0
    });
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  const inboundCount = trains.filter(t => t.direction === 'inbound').length;
  const outboundCount = trains.filter(t => t.direction === 'outbound').length;
  const totalCount = inboundCount + outboundCount;

  if (!stationIcon || !terminalIcon) {
    return (
      <div className={`rounded-xl border border-zinc-200 shadow-sm overflow-hidden bg-zinc-100 h-[380px] flex items-center justify-center ${className}`}>
        <div className="text-zinc-400 text-sm">Loading map...</div>
      </div>
    );
  }

  return (
    <div className={`rounded-xl border border-zinc-200 shadow-sm overflow-hidden ${className}`}>
      <div className="h-[380px] relative">
        {loading && (
          <div className="absolute inset-0 z-[1001] flex items-center justify-center bg-zinc-100/80 backdrop-blur-sm">
            <div className="text-zinc-500 text-sm">Connecting to real-time feed...</div>
          </div>
        )}
      
        <MapContainer
          center={MAP_CENTER}
          zoom={DEFAULT_ZOOM}
          scrollWheelZoom={true}
          style={{ height: '100%', width: '100%', background: '#f4f4f5' }}
          zoomControl={true}
        >
          <ResetZoomControl />
          <TileLayer attribution={MAP_CONFIG.ATTRIBUTION} url={MAP_CONFIG.TILE_LAYER_URL} />
          
          {Object.entries(railLines).map(([lineId, points]) => (
            <Polyline
              key={lineId}
              positions={points}
              pathOptions={{
                color: LINE_COLORS[lineId] || LINE_COLORS['default'],
                weight: 6,
                opacity: 0.8,
              }}
            />
          ))}
          
          {Object.entries(STATIONS).map(([key, station]) => {
            const isRed = station.isTerminal || station.isHighlight;
            const icon = isRed ? terminalIcon : stationIcon;
            return (
              <Marker 
                key={key}
                position={[station.lat, station.lng]} 
                icon={icon}
                zIndexOffset={10}
              >
                <Popup offset={[0, -10]} className="station-popup">
                  <div className="font-bold text-sm">{station.name}</div>
                  {station.isTerminal && <div className="text-xs text-zinc-400">Terminal</div>}
                </Popup>
              </Marker>
            );
          })}
          
          {ghostTrains.map(train => (
            <TrainMarker
              key={train.id}
              train={train}
              railLines={railLines}
              onTrainClick={fetchTripSchedule}
              isSelected={selectedTripId === train.tripId}
              loadingSchedule={loadingSchedule}
              schedule={schedule}
              selectedCrowding={selectedCrowding}
              STATIONS={STATIONS} // Pass STATIONS to avoid closure staleness
            />
          ))}
          
          {userLocation && userLocationIcon && (
            <Marker
              position={[userLocation.lat, userLocation.lng]}
              icon={userLocationIcon}
              zIndexOffset={1000}
            >
              <Popup className="user-popup">
                <div className="text-center">
                  <div className="font-bold text-blue-600">📍 Your Location</div>
                </div>
              </Popup>
            </Marker>
          )}
        </MapContainer>
        
        {(loading || error) && (
          <div className="absolute bottom-2 left-2 z-[1000] bg-white/90 backdrop-blur-sm rounded-md px-2 py-1 text-[10px] text-zinc-500 shadow-sm">
            {loading ? 'Loading...' : <span className="text-red-500">Error: {error}</span>}
          </div>
        )}
        
        <div className="absolute top-2 right-2 z-[1000] bg-white/95 backdrop-blur-sm rounded-md px-2.5 py-1.5 text-[10px] shadow-sm border border-zinc-200">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1 text-blue-600 font-semibold">
              <span className="text-xs font-bold">{inboundCount}</span>
              <span className="text-[11px]">→</span>
              <span className="text-[9px] text-blue-500 font-normal">Chicago</span>
            </div>
            <span className="text-zinc-300 text-[10px]">|</span>
            <div className="flex items-center gap-1 text-amber-600 font-semibold">
              <span className="text-[11px]">←</span>
              <span className="text-xs font-bold">{outboundCount}</span>
              <span className="text-[9px] text-amber-500 font-normal">Outbound</span>
            </div>
            {totalCount > 0 && (
              <>
                <span className="text-zinc-300 text-[10px]">|</span>
                <span className="text-[9px] text-zinc-500 font-normal">
                  Total: <span className="font-semibold text-zinc-700">{totalCount}</span>
                </span>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
