import { useState, useEffect, useRef, useMemo, useCallback, memo, lazy, Suspense } from 'react';
import { Train } from '@/lib/scheduleData';
import { ArrowRight, Clock, RefreshCw, ArrowLeftRight, AlertTriangle, ExternalLink, X, Info, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getChicagoTime, getServiceDayType, getCurrentMinutesInChicago, formatChicagoTime } from '@/lib/time';


// Lazy load the map component since it's heavy
const TrainMap = lazy(() => import('@/components/TrainMap'));

type DayType = 'weekday' | 'saturday' | 'sunday';
type Direction = 'inbound' | 'outbound';

// API response types
interface ApiTrain {
  trip_id: string;
  departure_time: string;
  arrival_time: string;
  is_express: boolean | number;
}

interface ApiSchedule {
  type: DayType;
  inbound: ApiTrain[];
  outbound: ApiTrain[];
}

interface ApiAlerts {
  id: string;
  alert?: {
    activePeriod?: Array<{ start?: string; end?: string }>;
    informedEntity?: Array<{ routeId?: string }>;
    headerText?: { translation?: Array<{ text?: string }> };
    descriptionText?: { translation?: Array<{ text?: string }> };
  };
}

// Cache compiled regex patterns for better performance
const TRIP_ID_REGEX = /UNW(\d+)/;
const TIME_PATTERN_REGEX = /(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)/gi;

// Transform API train to frontend Train format
function transformTrain(apiTrain: ApiTrain, tripIdMap: Map<string, string>): Train {
  // Extract train number from trip_id (e.g., "UP-NW_UNW634_V3_A" -> "634")
  const match = apiTrain.trip_id.match(TRIP_ID_REGEX);
  const trainId = match ? match[1] : apiTrain.trip_id;
  
  // Store mapping of train_id -> trip_id for delay lookup
  tripIdMap.set(trainId, apiTrain.trip_id);
  
  return {
    id: trainId,
    departureTime: apiTrain.departure_time.substring(0, 5), // "HH:MM:SS" -> "HH:MM"
    arrivalTime: apiTrain.arrival_time.substring(0, 5),
    isExpress: Boolean(apiTrain.is_express)
  };
}

// Calculate trip duration in minutes
function calculateDuration(departureTime: string, arrivalTime: string): number {
  const [depHours, depMinutes] = departureTime.split(':').map(Number);
  const [arrHours, arrMinutes] = arrivalTime.split(':').map(Number);
  
  const depTotalMinutes = depHours * 60 + depMinutes;
  let arrTotalMinutes = arrHours * 60 + arrMinutes;
  
  // Handle next-day arrival (e.g., 23:30 -> 00:15)
  if (arrTotalMinutes < depTotalMinutes) {
    arrTotalMinutes += 24 * 60;
  }

  return arrTotalMinutes - depTotalMinutes;
}

function getChicagoMinutesFromTimeString(timeStr?: string | null): number | null {
  if (!timeStr) return null;

  const maybeIsoDate = timeStr.match(/\d{4}-\d{2}-\d{2}/);
  let date: Date | null = null;

  if (maybeIsoDate) {
    const parsed = new Date(timeStr);
    date = isNaN(parsed.getTime()) ? null : parsed;
  } else {
    const [hours, minutes] = timeStr.split(':').map(Number);
    if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
    const now = getChicagoTime();
    now.setHours(hours, minutes, 0, 0);
    date = now;
  }

  if (!date) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Chicago',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false
  }).formatToParts(date);

  const hour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);

  return hour * 60 + minute;
}

function isPredictedTimeReasonable(
  predicted?: string | null,
  scheduled?: string | null,
  fallbackScheduleTime?: string
): boolean {
  if (!predicted) return false;

  const predictedMinutes = getChicagoMinutesFromTimeString(predicted);
  if (predictedMinutes === null) return false;

  const scheduledMinutes =
    getChicagoMinutesFromTimeString(scheduled) ??
    getChicagoMinutesFromTimeString(fallbackScheduleTime);

  if (scheduledMinutes === null) return true;

  let diff = Math.abs(predictedMinutes - scheduledMinutes);
  if (diff > 720) {
    diff = Math.min(diff, 1440 - diff);
  }

  return diff <= 180; // ignore obviously wrong data (>3 hours off)
}

export default function Schedule() {
  const [currentTime, setCurrentTime] = useState(getChicagoTime());
  const [dayType, setDayType] = useState<DayType>('weekday');
  const [direction, setDirection] = useState<Direction>('inbound');
  const [nextTrain, setNextTrain] = useState<Train | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastUpdate, setLastUpdate] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [scheduleData, setScheduleData] = useState<{ [key: string]: { inbound: Train[]; outbound: Train[] } }>({
    weekday: { inbound: [], outbound: [] },
    saturday: { inbound: [], outbound: [] },
    sunday: { inbound: [], outbound: [] }
  });
  const [alerts, setAlerts] = useState<ApiAlerts[]>([]);
  const [dismissedAlerts, setDismissedAlerts] = useState<Set<string>>(new Set());
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const [scheduleError, setScheduleError] = useState<string | null>(null);
  const [delays, setDelays] = useState<Map<string, number>>(new Map());
  const [predictedTimes, setPredictedTimes] = useState<Map<string, { 
    scheduled?: string; 
    predicted?: string; 
    stop_id: string;
  }>>(new Map());
  const [tripIdMap, setTripIdMap] = useState<Map<string, string>>(new Map());
  const [crowdingData, setCrowdingData] = useState<Map<string, 'low' | 'medium' | 'high'>>(new Map());
  const [showDelayDebug, setShowDelayDebug] = useState(false);
  const fetchCrowdingRef = useRef<((forceRefresh?: boolean) => void) | null>(null);
  const lastFetchMinuteRef = useRef<number | null>(null);
  const isFetchingCrowdingRef = useRef<boolean>(false);

  // Initialize day type based on current service day
  useEffect(() => {
    setDayType(getServiceDayType(getChicagoTime()));
  }, []);

  // Update current time every 15 seconds
  useEffect(() => {
    const timer = setInterval(() => {
      const now = getChicagoTime();
      setCurrentTime(now);
      
      const currentServiceDay = getServiceDayType(now);
      setDayType(prev => {
        if (prev !== currentServiceDay) {
          return currentServiceDay;
        }
        return prev;
      });
    }, 15000);
    return () => clearInterval(timer);
  }, []);

  // Fetch schedule data from GTFS API
  useEffect(() => {
    setScheduleLoading(true);
    setScheduleError(null);
    
    fetch('/api/schedule')
      .then(res => {
        if (!res.ok) {
          if (res.status === 503) {
            console.log('Database not available, using fallback schedule');
            return null;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: { weekday?: ApiSchedule; saturday?: ApiSchedule; sunday?: ApiSchedule } | null) => {
        if (data) {
          const newTripIdMap = new Map<string, string>();
          
          const transformed: { [key: string]: { inbound: Train[]; outbound: Train[] } } = {
            weekday: {
              inbound: (data.weekday?.inbound || []).map(train => transformTrain(train, newTripIdMap)),
              outbound: (data.weekday?.outbound || []).map(train => transformTrain(train, newTripIdMap))
            },
            saturday: {
              inbound: (data.saturday?.inbound || []).map(train => transformTrain(train, newTripIdMap)),
              outbound: (data.saturday?.outbound || []).map(train => transformTrain(train, newTripIdMap))
            },
            sunday: {
              inbound: (data.sunday?.inbound || []).map(train => transformTrain(train, newTripIdMap)),
              outbound: (data.sunday?.outbound || []).map(train => transformTrain(train, newTripIdMap))
            }
          };
          setScheduleData(transformed);
          setTripIdMap(newTripIdMap);
        } else {
          const fallback = require('@/lib/scheduleData').scheduleData;
          setScheduleData(fallback);
        }
        setScheduleLoading(false);
      })
      .catch(error => {
        console.error('Error fetching schedule:', error);
        const fallback = require('@/lib/scheduleData').scheduleData;
        setScheduleData(fallback);
        setScheduleError('Using offline schedule data');
        setScheduleLoading(false);
      });
  }, []);

  // Fetch alerts from Metra API
  useEffect(() => {
    fetch('/api/alerts')
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then((data: ApiAlerts[]) => {
        const upnwAlerts = data.filter(alert => {
          const routeIds = alert.alert?.informedEntity?.map(e => e.routeId) || [];
          return routeIds.includes('UP-NW') || routeIds.length === 0;
        });
        setAlerts(upnwAlerts);
      })
      .catch(error => {
        console.debug('Could not fetch alerts:', error.message);
      });
  }, []);

  // Fetch delays from API
  useEffect(() => {
    const fetchDelays = () => {
      fetch('/api/delays')
        .then(res => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        })
        .then((data: { delays: Array<{ 
          trip_id: string; 
          stop_id: string; 
          delay_seconds: number;
          scheduled_arrival?: string | null;
          scheduled_departure?: string | null;
          predicted_arrival?: string | null;
          predicted_departure?: string | null;
        }> }) => {
          const delayMap = new Map<string, number>();
          const predictedMap = new Map<string, { scheduled?: string; predicted?: string; stop_id: string }>();
          
          data.delays.forEach(delay => {
            const destinationStopId = direction === 'inbound' ? 'OTC' : 'PALATINE';
            const originStopId = direction === 'inbound' ? 'PALATINE' : 'OTC';
            
            if (delay.stop_id === destinationStopId) {
              const existingDelay = delayMap.get(delay.trip_id) || 0;
              delayMap.set(delay.trip_id, Math.max(existingDelay, delay.delay_seconds));
              
              if (delay.scheduled_arrival && delay.predicted_arrival) {
                predictedMap.set(`${delay.trip_id}_arrival`, {
                  scheduled: delay.scheduled_arrival,
                  predicted: delay.predicted_arrival,
                  stop_id: delay.stop_id
                });
              }
            }
            
            if (delay.stop_id === originStopId) {
              if (delay.scheduled_departure && delay.predicted_departure) {
                predictedMap.set(`${delay.trip_id}_departure`, {
                  scheduled: delay.scheduled_departure,
                  predicted: delay.predicted_departure,
                  stop_id: delay.stop_id
                });
              }
            }
          });
          
          setDelays(delayMap);
          setPredictedTimes(predictedMap);
          setLastUpdate(new Date().toISOString());
        })
        .catch(error => {
          console.debug('Could not fetch delays:', error.message);
        });
    };
    
    fetchDelays();
    
    const now = new Date();
    const msToNextSync = 30000 - (now.getTime() % 30000);
    
    let interval: NodeJS.Timeout;
    const timeout = setTimeout(() => {
      fetchDelays();
      interval = setInterval(fetchDelays, 30000);
    }, msToNextSync);
    
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [direction]);

  // Fetch crowding data
  useEffect(() => {
    const fetchCrowding = (forceRefresh = false) => {
      if (isFetchingCrowdingRef.current && !forceRefresh) {
        return;
      }
      
      isFetchingCrowdingRef.current = true;
      
      const forceParam = forceRefresh ? '&force=true' : '';
      const palatineToChicago = fetch(`/api/crowding?origin=PALATINE&destination=OTC${forceParam}`)
        .then(res => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        })
        .catch(error => {
          console.debug('Could not fetch crowding data (Palatine->Chicago):', error.message);
          return { crowding: [] };
        });
      
      const chicagoToPalatine = fetch(`/api/crowding?origin=OTC&destination=PALATINE${forceParam}`)
        .then(res => {
          if (!res.ok) {
            throw new Error(`HTTP ${res.status}`);
          }
          return res.json();
        })
        .catch(error => {
          console.debug('Could not fetch crowding data (Chicago->Palatine):', error.message);
          return { crowding: [] };
        });
      
      Promise.all([palatineToChicago, chicagoToPalatine])
        .then(([palatineData, chicagoData]) => {
          const crowdingMap = new Map<string, 'low' | 'medium' | 'high'>();
          
          palatineData.crowding?.forEach((item: { trip_id: string; crowding: 'low' | 'medium' | 'high' }) => {
            const match = item.trip_id.match(TRIP_ID_REGEX);
            if (match) {
              const trainNumber = match[1];
              crowdingMap.set(trainNumber, item.crowding);
              crowdingMap.set(item.trip_id, item.crowding);
            }
          });
          
          chicagoData.crowding?.forEach((item: { trip_id: string; crowding: 'low' | 'medium' | 'high' }) => {
            const match = item.trip_id.match(TRIP_ID_REGEX);
            if (match) {
              const trainNumber = match[1];
              if (!crowdingMap.has(trainNumber) || !crowdingMap.has(item.trip_id)) {
                crowdingMap.set(trainNumber, item.crowding);
                crowdingMap.set(item.trip_id, item.crowding);
              }
            }
          });
          
          setCrowdingData(crowdingMap);
        })
        .catch(error => {
          console.debug('Could not fetch crowding data:', error.message);
        })
        .finally(() => {
          isFetchingCrowdingRef.current = false;
        });
    };
    
    fetchCrowdingRef.current = fetchCrowding;
    
    fetchCrowding();
    
    const now = new Date();
    const msToNextSync = 30000 - (now.getTime() % 30000);
    
    let interval: NodeJS.Timeout;
    const timeout = setTimeout(() => {
      fetchCrowding(false);
      interval = setInterval(() => fetchCrowding(false), 30000);
    }, msToNextSync);
    
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
      fetchCrowdingRef.current = null;
    };
  }, []);

  // Fetch real-time status on mount
  useEffect(() => {
    fetch('/api/realtime-status')
      .then(res => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
      })
      .then(data => {
        if (data && data.last_update) {
          setLastUpdate(data.last_update);
        }
      })
      .catch(error => {
        console.debug('Could not fetch real-time status:', error.message);
      });
  }, []);

  // Refresh real-time data and alerts
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setRefreshError(null);
    
    try {
      const [realtimeResponse, alertsResponse] = await Promise.all([
        fetch('/api/refresh-realtime', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }),
        fetch('/api/alerts').catch(() => ({ ok: false }))
      ]);
      
      if (!realtimeResponse.ok) {
        let errorMessage = `Server error: ${realtimeResponse.status}`;
        try {
          const errorData = await realtimeResponse.json();
          errorMessage = errorData.error || errorData.message || errorMessage;
        } catch {
          errorMessage = realtimeResponse.statusText || errorMessage;
        }
        throw new Error(errorMessage);
      }
      
      const data = await realtimeResponse.json();
      
      if (data && data.timestamp) {
        setLastUpdate(data.timestamp);
      }
      
      if (alertsResponse.ok && 'json' in alertsResponse) {
        const alertData: ApiAlerts[] = await alertsResponse.json();
        const upnwAlerts = alertData.filter(alert => {
          const routeIds = alert.alert?.informedEntity?.map(e => e.routeId) || [];
          return routeIds.includes('UP-NW') || routeIds.length === 0;
        });
        setAlerts(upnwAlerts);
      }
      
      if (fetchCrowdingRef.current) {
        fetchCrowdingRef.current(true);
      }
      
      setTimeout(() => {
        setIsRefreshing(false);
      }, 500);
    } catch (error: any) {
      setRefreshError(error.message || 'Failed to refresh. Make sure backend is running.');
      setIsRefreshing(false);
    }
  }, []);

  // Find next train based on current view mode
  const computedNextTrain = useMemo(() => {
    const currentMinutes = getCurrentMinutesInChicago();
    const currentSchedule = scheduleData[dayType];
    const trains = direction === 'inbound' ? currentSchedule.inbound : currentSchedule.outbound;
    
    if (trains.length === 0) {
      return null;
    }
    
    const next = trains.find(train => {
      const [hours, minutes] = train.departureTime.split(':').map(Number);
      const trainMinutes = hours * 60 + minutes;
      return trainMinutes > currentMinutes;
    });
    
    return next || trains[0] || null;
  }, [dayType, currentTime, direction, scheduleData]);
  
  useEffect(() => {
    if (nextTrain?.id !== computedNextTrain?.id) {
      setNextTrain(computedNextTrain);
    }
  }, [computedNextTrain, nextTrain?.id]);

  // Format time for display - handles GTFS overnight times (24:XX, 25:XX = next day AM hours)
  const formatTime = useCallback((timeStr: string) => {
    let [hours, minutes] = timeStr.split(':').map(Number);
    
    // GTFS uses 24:XX, 25:XX etc for overnight trains (past midnight)
    // Normalize to 0-23 range
    hours = hours % 24;
    
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
  }, []);

  const memoizedCalculateDuration = useCallback((departureTime: string, arrivalTime: string): number => {
    return calculateDuration(departureTime, arrivalTime);
  }, []);

  // Memoize filtered and active alerts
  const activeAlerts = useMemo(() => {
    const currentMinutes = getCurrentMinutesInChicago();
    const currentHours = Math.floor(currentMinutes / 60);
    
    return alerts
      .filter(alert => !dismissedAlerts.has(alert.id))
      .filter((alert) => {
        const activePeriods = alert.alert?.activePeriod || [];
        if (activePeriods.length > 0) {
          const now = new Date();
          const allPeriodsExpired = activePeriods.every(period => {
            if (period.end) {
              const endTime = new Date(parseInt(period.end) * 1000);
              return endTime.getTime() < now.getTime() - (10 * 60 * 1000);
            }
            return false;
          });
          if (allPeriodsExpired) {
            return false;
          }
        }
        
        const headerText = alert.alert?.headerText?.translation?.[0]?.text || '';
        const descriptionText = alert.alert?.descriptionText?.translation?.[0]?.text || '';
        const fullText = (headerText + ' ' + descriptionText).toLowerCase();
        
        const timePattern = new RegExp(TIME_PATTERN_REGEX.source, TIME_PATTERN_REGEX.flags);
        
        let hasPastTime = false;
        let match;
        const foundTimes: number[] = [];
        
        while ((match = timePattern.exec(fullText)) !== null) {
          let hours = parseInt(match[1], 10);
          const minutes = parseInt(match[2], 10);
          const period = (match[3] || '').toUpperCase().replace(/\./g, '');
          
          if (period.includes('PM') && hours !== 12) {
            hours += 12;
          } else if (period.includes('AM') && hours === 12) {
            hours = 0;
          }
          
          const alertTimeMinutes = hours * 60 + minutes;
          foundTimes.push(alertTimeMinutes);
        }
        
        if (foundTimes.length > 0) {
          const allPast = foundTimes.every(alertTimeMinutes => {
            const alertHours = Math.floor(alertTimeMinutes / 60);
            
            if (currentHours >= 22 && alertHours < 6) {
              return false;
            }
            
            return alertTimeMinutes < currentMinutes - 10;
          });
          
          if (allPast) {
            hasPastTime = true;
          }
        }
        
        return !hasPastTime;
      });
  }, [alerts, dismissedAlerts]);

  // Memoize current trains list
  const currentTrains = useMemo(() => {
    return direction === 'inbound' 
      ? scheduleData[dayType].inbound 
      : scheduleData[dayType].outbound;
  }, [direction, dayType, scheduleData]);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans selection:bg-primary selection:text-white">
      <main className="container py-6 md:py-8 max-w-5xl mx-auto px-2 sm:px-4">
        {/* Modern Alerts Display */}
        {activeAlerts.length > 0 && (
          <div className="mb-4 md:mb-6 space-y-2">
            {activeAlerts.map((alert) => {
                const headerText = alert.alert?.headerText?.translation?.[0]?.text || 'Service Alert';
                const descriptionText = alert.alert?.descriptionText?.translation?.[0]?.text || '';
                
                const isCritical = /delay|late|cancel|disrupt|mechanical|problem/i.test(headerText + descriptionText);
                const isWarning = /schedule|change|update|notice/i.test(headerText + descriptionText);
                
                const alertType = isCritical ? 'critical' : isWarning ? 'warning' : 'info';
                
                const alertStyles = {
                  critical: {
                    bg: 'bg-red-50 dark:bg-red-950/20',
                    border: 'border-red-500',
                    icon: 'text-red-600 dark:text-red-400',
                    title: 'text-red-900 dark:text-red-100',
                    text: 'text-red-800 dark:text-red-200',
                    iconComponent: AlertCircle
                  },
                  warning: {
                    bg: 'bg-amber-50 dark:bg-amber-950/20',
                    border: 'border-amber-500',
                    icon: 'text-amber-600 dark:text-amber-400',
                    title: 'text-amber-900 dark:text-amber-100',
                    text: 'text-amber-800 dark:text-amber-200',
                    iconComponent: AlertTriangle
                  },
                  info: {
                    bg: 'bg-blue-50 dark:bg-blue-950/20',
                    border: 'border-blue-500',
                    icon: 'text-blue-600 dark:text-blue-400',
                    title: 'text-blue-900 dark:text-blue-100',
                    text: 'text-blue-800 dark:text-blue-200',
                    iconComponent: Info
                  }
                };
                
                const style = alertStyles[alertType];
                const IconComponent = style.iconComponent;
                
                return (
                  <div
                    key={alert.id}
                    className={cn(
                      "flex items-start gap-2.5 px-3 py-2.5 rounded-lg border",
                      style.bg,
                      style.border.replace('border-', 'border-l-2 border-')
                    )}
                  >
                    <IconComponent className={cn("w-4 h-4 flex-shrink-0 mt-0.5", style.icon)} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <h3 className={cn("font-medium text-sm leading-snug", style.title)}>
                          {headerText}
                        </h3>
                        <button
                          onClick={() => setDismissedAlerts(prev => new Set(prev).add(alert.id))}
                          className="flex-shrink-0 p-0.5 rounded hover:bg-black/5"
                          aria-label="Dismiss alert"
                        >
                          <X className="w-3.5 h-3.5 text-zinc-400" />
                        </button>
                      </div>
                      {descriptionText && (
                        <p className={cn("text-xs leading-relaxed mt-1 opacity-80", style.text)}>
                          {descriptionText}
                        </p>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        )}

        {/* Schedule Loading/Error State */}
        {scheduleLoading && (
          <div className="flex items-center justify-center gap-2 py-6 text-zinc-400 text-sm">
            <RefreshCw className="w-4 h-4 animate-spin" />
            <span>Loading schedule...</span>
          </div>
        )}
        {scheduleError && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs mb-3">
            <AlertTriangle className="w-3.5 h-3.5" />
            <span>{scheduleError}</span>
          </div>
        )}

        {/* Header Bar - Consistent with Dashboard */}
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

            {/* Center: Branding - Palatine */}
            <div className="flex-1 text-center">
              <span className="text-sm sm:text-base font-bold text-zinc-500 uppercase tracking-[0.15em]">
                Palatine
              </span>
            </div>

            {/* Right: Live Sync Status - Matches card style */}
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-white border border-zinc-200 shadow-sm text-zinc-600">
              <span className="relative flex h-1.5 w-1.5">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500"></span>
              </span>
              <span className="text-[10px] font-medium font-mono">
                {lastUpdate ? (() => {
                  const date = lastUpdate.includes('T') ? new Date(lastUpdate) : new Date(lastUpdate.replace(' ', 'T') + 'Z');
                  return formatChicagoTime(date, { hour: 'numeric', minute: '2-digit' });
                })() : '...'}
              </span>
            </div>
          </div>
        </div>

        {refreshError && (
          <div className="mb-3 px-3 py-2 rounded-lg bg-red-50 border border-red-200 text-red-600 text-xs">
            {refreshError}
          </div>
        )}

        {/* Next Train Status - Single Card */}
        {nextTrain && (() => {
          const tripId = tripIdMap.get(nextTrain.id);
          const realtimeDelay = tripId ? delays.get(tripId) : null;
          const predictedDepartureData = tripId ? predictedTimes.get(`${tripId}_departure`) : null;
          const predictedArrivalData = tripId ? predictedTimes.get(`${tripId}_arrival`) : null;
          
          const usePredictedDeparture =
            predictedDepartureData?.predicted &&
            isPredictedTimeReasonable(
              predictedDepartureData.predicted,
              predictedDepartureData.scheduled,
              nextTrain.departureTime
            );

          const usePredictedArrival =
            predictedArrivalData?.predicted &&
            isPredictedTimeReasonable(
              predictedArrivalData.predicted,
              predictedArrivalData.scheduled,
              nextTrain.arrivalTime
            );

          let delayMinutes: number | null = null;
          if (
            usePredictedDeparture &&
            predictedDepartureData?.scheduled &&
            predictedDepartureData?.predicted
          ) {
            const scheduled = new Date(predictedDepartureData.scheduled);
            const predicted = new Date(predictedDepartureData.predicted);
            const diffMs = predicted.getTime() - scheduled.getTime();
            const diffMinutes = Math.round(diffMs / (1000 * 60));
            if (diffMinutes > 0) {
              delayMinutes = diffMinutes;
            }
          }
          if (delayMinutes === null && realtimeDelay) {
            delayMinutes = Math.round(realtimeDelay / 60);
          }
          
          const duration = calculateDuration(nextTrain.departureTime, nextTrain.arrivalTime);
          
          const getMinutesUntilDeparture = (departureTime: string): number | null => {
            const [depHours, depMinutes] = departureTime.split(':').map(Number);
            const depTotalMinutes = depHours * 60 + depMinutes;
            const currentMinutes = getCurrentMinutesInChicago();
            
            let adjustedDepMinutes = depTotalMinutes;
            if (depTotalMinutes < currentMinutes) {
              adjustedDepMinutes += 24 * 60;
            }
            
            const minutesUntil = adjustedDepMinutes - currentMinutes;
            return minutesUntil >= 0 && minutesUntil < 24 * 60 ? minutesUntil : null;
          };
          
          const departureTimeForCountdown = usePredictedDeparture && predictedDepartureData?.predicted
            ? (() => {
                const predDate = new Date(predictedDepartureData.predicted);
                const hours = predDate.getHours();
                const minutes = predDate.getMinutes();
                return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
              })()
            : nextTrain.departureTime;
          const minutesUntil = getMinutesUntilDeparture(departureTimeForCountdown);
          
          const formatPredictedTimeForCard = (timeStr: string) => {
            if (!timeStr) return null;
            if (timeStr.includes('T')) {
              const timePart = timeStr.split('T')[1]?.split('.')[0] || timeStr.split('T')[1] || '';
              const [hours, minutes] = timePart.split(':').map(Number);
              const period = hours >= 12 ? 'PM' : 'AM';
              const displayHours = hours % 12 || 12;
              return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
            }
            const timeMatch = timeStr.match(/(\d{1,2}):(\d{2})/);
            if (timeMatch) {
              const hours = parseInt(timeMatch[1], 10);
              const minutes = parseInt(timeMatch[2], 10);
              const period = hours >= 12 ? 'PM' : 'AM';
              const displayHours = hours % 12 || 12;
              return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
            }
            return formatTime(timeStr);
          };
          
          const predictedDeparture = usePredictedDeparture && predictedDepartureData?.predicted
            ? formatPredictedTimeForCard(predictedDepartureData.predicted)
            : null;
          const scheduledDeparture = predictedDepartureData?.scheduled
            ? formatPredictedTimeForCard(predictedDepartureData.scheduled)
            : null;
          const predictedArrival = usePredictedArrival && predictedArrivalData?.predicted
            ? formatPredictedTimeForCard(predictedArrivalData.predicted)
            : null;
          const scheduledArrival = predictedArrivalData?.scheduled
            ? formatPredictedTimeForCard(predictedArrivalData.scheduled)
            : null;
          
          const hasGPSTracking = tripId && delays.has(tripId);
          const crowdingLevel = tripId 
            ? (crowdingData.get(tripId) || crowdingData.get(nextTrain.id))
            : crowdingData.get(nextTrain.id);
          
          return (
            <div className={cn(
              "rounded-xl border shadow-sm mb-6 overflow-hidden bg-white border-zinc-200",
              direction === 'outbound' ? "border-l-4 border-l-amber-500" : "border-l-4 border-l-blue-500"
            )}>
              {/* Compact Header Row */}
              <div className={cn(
                "flex items-center justify-between px-4 py-2 border-b border-zinc-200",
                direction === 'outbound' ? "bg-amber-50/50" : "bg-blue-50/50"
              )}>
                <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-zinc-600">
                  <span className={direction === 'outbound' ? "text-amber-700 font-bold" : "text-blue-700 font-bold"}>
                    {direction === 'inbound' ? 'Inbound' : 'Outbound'}
                  </span>
                  <ArrowRight className="w-3 h-3" />
                  <span>{direction === 'inbound' ? 'Chicago' : 'Palatine'}</span>
                </div>
                <div className="flex items-center gap-2">
                  {crowdingLevel && (
                    <span className={cn(
                      "px-2 py-0.5 rounded text-[10px] font-semibold uppercase",
                      crowdingLevel === 'low' 
                        ? "bg-green-100 text-green-700" 
                        : crowdingLevel === 'medium'
                        ? "bg-amber-100 text-amber-700"
                        : "bg-red-100 text-red-700"
                    )}>
                      {crowdingLevel === 'low' ? 'Low' : crowdingLevel === 'medium' ? 'Mod' : 'High'}
                    </span>
                  )}
                  {nextTrain.isExpress && (
                    <span className="px-2 py-0.5 rounded text-[10px] font-semibold uppercase bg-primary/10 text-primary">
                      Express
                    </span>
                  )}
                  <span className="text-xs font-mono text-zinc-500">
                    #{nextTrain.id}
                  </span>
                </div>
              </div>
              
              {/* Main Content - Compact Layout */}
              <div className="px-3 py-2.5 sm:px-4 sm:py-3">
                {/* Time Row - Primary Info - Always single row */}
                <div className="flex flex-row items-center justify-between gap-2 mb-2">
                  {/* Left: Departure Time */}
                  <div className="flex items-baseline gap-2">
                    <div className={cn(
                      "text-2xl sm:text-3xl md:text-4xl font-bold tabular-nums tracking-tight text-zinc-900",
                      delayMinutes && delayMinutes > 0 ? "text-red-600" : ""
                    )}>
                      {predictedDeparture && scheduledDeparture && scheduledDeparture !== predictedDeparture ? (
                        <>
                          <span className="line-through text-zinc-400 text-base sm:text-xl mr-1 sm:mr-2">{scheduledDeparture}</span>
                          <span className="text-red-600">{predictedDeparture}</span>
                        </>
                      ) : (
                        predictedDeparture || formatTime(nextTrain.departureTime)
                      )}
                    </div>
                    <div className={cn(
                      "flex items-center gap-1 px-1.5 py-0.5 sm:px-2.5 sm:py-1 text-[8px] sm:text-[10px] font-bold uppercase tracking-wider rounded-full border shadow-sm",
                      direction === 'outbound' 
                        ? "bg-amber-50 text-amber-700 border-amber-200" 
                        : "bg-blue-50 text-blue-700 border-blue-200"
                    )}>
                      <span className="relative flex h-1.5 w-1.5 sm:h-2 sm:w-2">
                        <span className={cn(
                          "animate-ping absolute inline-flex h-full w-full rounded-full opacity-75",
                          direction === 'outbound' ? "bg-amber-500" : "bg-blue-500"
                        )}></span>
                        <span className={cn(
                          "relative inline-flex rounded-full h-1.5 w-1.5 sm:h-2 sm:w-2",
                          direction === 'outbound' ? "bg-amber-500" : "bg-blue-500"
                        )}></span>
                      </span>
                      <span className="hidden sm:inline">Next Train</span>
                      <span className="sm:hidden">Next</span>
                    </div>
                  </div>
                  
                  {/* Right: Countdown */}
                  {minutesUntil !== null && (
                    <div className="text-right flex-shrink-0">
                      <div className={cn(
                        "text-xl sm:text-2xl md:text-3xl font-bold tabular-nums",
                        direction === 'outbound' ? "text-amber-600" : "text-primary"
                      )}>
                        {minutesUntil}<span className="text-sm sm:text-lg ml-0.5">m</span>
                      </div>
                      <div className="text-[8px] sm:text-[10px] uppercase tracking-wide text-zinc-500">
                        until departure
                      </div>
                    </div>
                  )}
                </div>
                
                {/* Secondary Info Row */}
                <div className="flex items-center gap-4 mt-2 pt-2 border-t border-zinc-100 text-sm text-zinc-600">
                  <div className="flex items-center gap-1.5">
                    <Clock className="w-3.5 h-3.5" />
                    <span>Arrives</span>
                    <span className={cn(
                      "font-semibold",
                      delayMinutes && delayMinutes > 0 ? "text-red-600" : ""
                    )}>
                      {predictedArrival && scheduledArrival && scheduledArrival !== predictedArrival ? (
                        <>
                          <span className="line-through text-zinc-400 mr-1">{scheduledArrival}</span>
                          <span className="text-red-600">{predictedArrival}</span>
                        </>
                      ) : (
                        predictedArrival || formatTime(nextTrain.arrivalTime)
                      )}
                    </span>
                  </div>
                  <span className="text-zinc-400">•</span>
                  <span>{duration} min trip</span>
                  {delayMinutes && delayMinutes > 0 && (
                    <>
                      <span className="text-zinc-400">•</span>
                      <span className="text-red-600 font-medium">+{delayMinutes}m delay</span>
                    </>
                  )}
                  <a 
                    href={(() => {
                      const now = new Date();
                      const thirtyMinAgo = new Date(now.getTime() - 30 * 60 * 1000);
                      const timestamp = Math.floor(thirtyMinAgo.getTime() / 1000);
                      const origin = direction === 'inbound' ? 'PALATINE' : 'OTC';
                      const dest = direction === 'inbound' ? 'OTC' : 'PALATINE';
                      return `https://www.metra.com/schedules?line=UP-NW&orig=${origin}&dest=${dest}&time=${timestamp}&allstops=0&redirect=${Math.floor(now.getTime() / 1000)}`;
                    })()}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex items-center gap-1 text-primary hover:underline text-xs font-medium ml-auto"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>Tracker</span>
                  </a>
                </div>
              </div>
            </div>
          );
        })()}

        {/* Full Schedule - Single Direction */}
        <div>
          <ScheduleTable 
            trains={currentTrains} 
            formatTime={formatTime}
            nextTrainId={nextTrain?.id}
            tripIdMap={tripIdMap}
            delays={delays}
            predictedTimes={predictedTimes}
            crowdingData={crowdingData}
            calculateDuration={memoizedCalculateDuration}
            currentTime={currentTime}
            direction={direction}
          />
        </div>

        {/* Train Map */}
        <div className="mt-6">
          <Suspense fallback={
            <div className="rounded-xl border border-zinc-200 shadow-sm overflow-hidden bg-white h-[280px] flex items-center justify-center">
              <div className="text-zinc-400 text-sm flex items-center gap-2">
                <RefreshCw className="w-4 h-4 animate-spin" />
                Loading map...
              </div>
            </div>
          }>
            <TrainMap />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

const ScheduleTable = memo(function ScheduleTable({ 
  trains, 
  formatTime, 
  nextTrainId,
  tripIdMap,
  delays,
  predictedTimes,
  crowdingData,
  calculateDuration,
  currentTime,
  direction,
}: { 
  trains: Train[], 
  formatTime: (t: string) => string,
  nextTrainId?: string,
  tripIdMap: Map<string, string>,
  delays: Map<string, number>,
  predictedTimes: Map<string, { scheduled?: string; predicted?: string; stop_id: string }>,
  crowdingData: Map<string, 'low' | 'medium' | 'high'>,
  calculateDuration: (dep: string, arr: string) => number,
  currentTime: Date,
  direction: Direction,
}) {
  const nextTrainRef = useRef<HTMLDivElement | null>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const headerScrollRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledToNext = useRef(false);
  
  // Sync horizontal scroll between header and content
  useEffect(() => {
    const scrollContainer = scrollContainerRef.current;
    const headerContainer = headerScrollRef.current;
    
    if (!scrollContainer || !headerContainer) return;
    
    let isScrolling = false;
    
    const handleContentScroll = () => {
      if (!isScrolling) {
        isScrolling = true;
        headerContainer.scrollLeft = scrollContainer.scrollLeft;
        requestAnimationFrame(() => {
          isScrolling = false;
        });
      }
    };
    
    const handleHeaderScroll = () => {
      if (!isScrolling) {
        isScrolling = true;
        scrollContainer.scrollLeft = headerContainer.scrollLeft;
        requestAnimationFrame(() => {
          isScrolling = false;
        });
      }
    };
    
    scrollContainer.addEventListener('scroll', handleContentScroll, { passive: true });
    headerContainer.addEventListener('scroll', handleHeaderScroll, { passive: true });
    
    return () => {
      scrollContainer.removeEventListener('scroll', handleContentScroll);
      headerContainer.removeEventListener('scroll', handleHeaderScroll);
    };
  }, []);
  
  // Auto-scroll to next train on initial load
  useEffect(() => {
    if (nextTrainRef.current && scrollContainerRef.current && trains.length > 0 && nextTrainId) {
      const rafId = requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (nextTrainRef.current && scrollContainerRef.current) {
            const container = scrollContainerRef.current;
            const nextTrainElement = nextTrainRef.current;
            
            const scrollPosition = nextTrainElement.offsetTop;
            
            container.scrollTo({
              top: Math.max(0, scrollPosition - 8),
              behavior: hasScrolledToNext.current ? 'smooth' : 'auto'
            });
            
            hasScrolledToNext.current = true;
          }
        });
      });
      
      return () => cancelAnimationFrame(rafId);
    } else if (!hasScrolledToNext.current && trains.length > 0) {
      hasScrolledToNext.current = false;
    }
  }, [nextTrainId, trains.length]);

  const formatPredictedTime = (isoString: string): string => {
    const date = new Date(isoString);
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const period = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${minutes.toString().padStart(2, '0')} ${period}`;
  };

  const hasDeparted = (departureTime: string): boolean => {
    const [depHours, depMinutes] = departureTime.split(':').map(Number);
    const currentMinutes = getCurrentMinutesInChicago();
    
    // Service day boundary: 1 AM (60 minutes into the day)
    // Before 1 AM, we're still on "yesterday's" service day
    const SERVICE_DAY_START = 60; // 1:00 AM
    const isBeforeServiceDayStart = currentMinutes < SERVICE_DAY_START;
    
    // GTFS overnight trains (24:XX, 25:XX) are for "next day" - not departed when viewing late at night
    if (depHours >= 24) {
      // Normalize to 0-23 range (24:12 -> 0:12)
      const normalizedHours = depHours - 24;
      const normalizedMinutes = normalizedHours * 60 + depMinutes;
      
      // Before 1 AM: these overnight trains are still upcoming
      if (isBeforeServiceDayStart) {
        return normalizedMinutes < currentMinutes;
      }
      
      // After 1 AM: these overnight trains (which ran earlier tonight) are departed
      return true;
    }
    
    const depTotalMinutes = depHours * 60 + depMinutes;
    
    // Before 1 AM: we're still on yesterday's service day
    // So early morning trains (before 1 AM) that haven't happened yet are NOT departed
    if (isBeforeServiceDayStart) {
      // If train is between midnight and 1 AM, check if it's passed
      if (depTotalMinutes < SERVICE_DAY_START) {
        return depTotalMinutes < currentMinutes;
      }
      // Trains after 1 AM are all departed (from yesterday)
      return true;
    }
    
    // After 1 AM: new service day
    // Early morning trains (before 1 AM) from this calendar day are departed
    const isEarlyMorningTrain = depTotalMinutes < SERVICE_DAY_START;
    if (isEarlyMorningTrain) {
      return true; // These trains ran earlier today (before 1 AM)
    }
    
    // If viewing late at night (after 10 PM), early morning trains (1 AM - 5 AM) 
    // from TODAY's schedule are definitely departed (they ran 17+ hours ago)
    const isLateNight = currentMinutes > 22 * 60; // After 10 PM
    const isEarlyMorningScheduleTrain = depTotalMinutes < 5 * 60; // Before 5 AM
    
    if (isLateNight && isEarlyMorningScheduleTrain) {
      return true; // These trains ran earlier today
    }
    
    // Regular comparison: departed if train time is before current time
    return depTotalMinutes < currentMinutes;
  };

  const getMinutesUntilDeparture = (departureTime: string): number | null => {
    const [depHours, depMinutes] = departureTime.split(':').map(Number);
    const currentMinutes = getCurrentMinutesInChicago();
    
    // Handle GTFS overnight format (24:XX = tomorrow's AM hours)
    // For 24:12, depTotalMinutes = 24*60 + 12 = 1452
    // At current 23:22 (1402), minutes until = 1452 - 1402 = 50
    const depTotalMinutes = depHours * 60 + depMinutes;
    
    let minutesUntil = depTotalMinutes - currentMinutes;
    
    // If negative but within reasonable range, train already departed
    if (minutesUntil < 0 && minutesUntil > -60) {
      return null;
    }
    
    // If very negative, it might mean we need to add a day
    if (minutesUntil < 0) {
      minutesUntil += 24 * 60;
    }
    
    return minutesUntil > 0 && minutesUntil < 1440 ? minutesUntil : null;
  };

  return (
    <div className="rounded-xl border border-zinc-200 shadow-sm overflow-hidden bg-white">
      {/* Table Header - Independent flex row */}
      <div 
        ref={headerScrollRef}
        className="overflow-x-auto overflow-y-hidden [&::-webkit-scrollbar]:hidden [-ms-overflow-style:none] [scrollbar-width:none] bg-zinc-50 border-b border-zinc-200"
      >
        <div className="flex items-center text-[11px] font-semibold uppercase tracking-wider text-zinc-500 py-2.5 px-4 min-w-fit">
          <div className="w-20 shrink-0">Depart</div>
          <div className="w-20 shrink-0">Arrive</div>
          <div className="w-14 shrink-0">Dur.</div>
          <div className="w-16 shrink-0">Status</div>
          <div className="flex-1 text-right pr-1">Train</div>
        </div>
      </div>
      {/* Table Body */}
      <div 
        ref={scrollContainerRef}
        className="divide-y divide-zinc-100 h-[280px] overflow-y-auto overflow-x-auto [scrollbar-width:thin] [scrollbar-color:transparent_transparent] hover:[scrollbar-color:rgb(212_212_212)_transparent] [&::-webkit-scrollbar]:w-1.5 [&::-webkit-scrollbar]:h-1.5 [&::-webkit-scrollbar-thumb]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full hover:[&::-webkit-scrollbar-thumb]:bg-zinc-300 [&::-webkit-scrollbar-track]:bg-transparent"
      >
        {trains.map((train, index) => {
          const isNext = train.id === nextTrainId;
          const duration = calculateDuration(train.departureTime, train.arrivalTime);
          const tripId = tripIdMap.get(train.id);
          const realtimeDelay = tripId ? delays.get(tripId) : null;
          const predictedDepartureData = tripId ? predictedTimes.get(`${tripId}_departure`) : null;
          const predictedArrivalData = tripId ? predictedTimes.get(`${tripId}_arrival`) : null;
          const departed = hasDeparted(train.departureTime);
          
          const usePredictedDeparture =
            predictedDepartureData?.predicted &&
            isPredictedTimeReasonable(
              predictedDepartureData.predicted,
              predictedDepartureData.scheduled,
              train.departureTime
            );

          const usePredictedArrival =
            predictedArrivalData?.predicted &&
            isPredictedTimeReasonable(
              predictedArrivalData.predicted,
              predictedArrivalData.scheduled,
              train.arrivalTime
            );

          const predictedDeparture = usePredictedDeparture && predictedDepartureData?.predicted
            ? formatPredictedTime(predictedDepartureData.predicted)
            : null;
          const scheduledDeparture = predictedDepartureData?.scheduled
            ? formatPredictedTime(predictedDepartureData.scheduled)
            : null;
          const predictedArrival = usePredictedArrival && predictedArrivalData?.predicted
            ? formatPredictedTime(predictedArrivalData.predicted)
            : null;
          const scheduledArrival = predictedArrivalData?.scheduled
            ? formatPredictedTime(predictedArrivalData.scheduled)
            : null;

          let delayMinutes: number | null = null;
          if (
            usePredictedDeparture &&
            predictedDepartureData?.predicted &&
            predictedDepartureData?.scheduled
          ) {
            const scheduled = new Date(predictedDepartureData.scheduled);
            const predicted = new Date(predictedDepartureData.predicted);
            const diffMs = predicted.getTime() - scheduled.getTime();
            const diffMinutes = Math.round(diffMs / (1000 * 60));
            if (diffMinutes > 0) {
              delayMinutes = diffMinutes;
            }
          }
          if (delayMinutes === null && realtimeDelay) {
            delayMinutes = Math.round(realtimeDelay / 60);
          }
          
          return (
            <div
              key={train.id}
              ref={isNext ? nextTrainRef : null}
              className={cn(
                "flex items-center py-2.5 px-4 transition-colors",
                // Priority: 1) Next train (current styling), 2) Departed (grayed), 3) Express (light blue)
                isNext 
                  ? "bg-primary/5 border-l-2 border-primary" 
                  : departed 
                    ? "opacity-50"
                    : train.isExpress 
                      ? "bg-blue-50/70"
                      : ""
              )}
            >
              {/* Depart Column with crowding dot */}
              <div className={cn(
                "w-20 shrink-0 font-semibold tabular-nums text-sm",
                isNext ? "text-primary" : "text-zinc-900",
                departed && !isNext && "text-zinc-400"
              )}>
                {isNext && predictedDeparture && scheduledDeparture && scheduledDeparture !== predictedDeparture ? (
                  <span className="text-red-600">{predictedDeparture}</span>
                ) : isNext && predictedDeparture && delayMinutes && delayMinutes > 0 ? (
                  <span className="text-red-600">{predictedDeparture}</span>
                ) : (
                  formatTime(train.departureTime)
                )}
              </div>
              
              {/* Arrive Column */}
              <div className={cn(
                "w-20 shrink-0 tabular-nums text-sm",
                isNext ? "text-zinc-700" : "text-zinc-700",
                departed && !isNext && "text-zinc-400"
              )}>
                {isNext && predictedArrival && scheduledArrival && scheduledArrival !== predictedArrival ? (
                  <span className="text-red-600">{predictedArrival}</span>
                ) : isNext && predictedArrival && delayMinutes && delayMinutes > 0 ? (
                  <span className="text-red-600">{predictedArrival}</span>
                ) : (
                  formatTime(train.arrivalTime)
                )}
              </div>
              
              {/* Duration Column */}
              <div className={cn(
                "w-14 shrink-0 text-xs text-zinc-600",
                departed && !isNext && "text-zinc-400"
              )}>
                {duration}m
              </div>
              
              {/* Status Column */}
              <div className={cn(
                "w-16 shrink-0 text-xs font-medium",
                isNext ? "text-primary" : "text-zinc-500",
                departed && !isNext && "text-zinc-400"
              )}>
                {departed && !isNext ? (
                  <span className="text-zinc-400">Gone</span>
                ) : isNext ? (
                  (() => {
                    const departureTimeForCountdown = predictedDeparture
                      ? (() => {
                          const predDate = new Date(predictedDepartureData!.predicted!);
                          return `${predDate.getHours().toString().padStart(2, '0')}:${predDate.getMinutes().toString().padStart(2, '0')}`;
                        })()
                      : train.departureTime;
                    const minutesUntil = getMinutesUntilDeparture(departureTimeForCountdown);
                    
                    if (delayMinutes && delayMinutes > 0) {
                      return (
                        <span className="text-red-600">+{delayMinutes}m</span>
                      );
                    }
                    return minutesUntil !== null ? (
                      <span className="text-primary font-semibold">{minutesUntil}m</span>
                    ) : null;
                  })()
                ) : null}
              </div>
              
              {/* Train # Column with crowding dot */}
              <div className={cn(
                "flex-1 flex items-center justify-end gap-1.5 text-xs font-mono pr-1",
                isNext ? "text-zinc-700" : "text-zinc-600",
                departed && !isNext && "text-zinc-400"
              )}>
                {/* Crowding indicator dot */}
                {(() => {
                  const crowdingLevel = tripId 
                    ? (crowdingData.get(tripId) || crowdingData.get(train.id))
                    : crowdingData.get(train.id);
                  
                  return crowdingLevel ? (
                    <span className={cn(
                      "w-2 h-2 rounded-full shrink-0",
                      crowdingLevel === 'low' ? "bg-green-600" 
                        : crowdingLevel === 'medium' ? "bg-orange-500"
                        : "bg-red-700"
                    )} title={crowdingLevel === 'low' ? 'Low crowding' : crowdingLevel === 'medium' ? 'Moderate crowding' : 'High crowding'} />
                  ) : null;
                })()}
                {train.id}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
});
