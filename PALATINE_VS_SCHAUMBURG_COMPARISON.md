# Palatine vs Schaumburg Feature Comparison
## Missing Features for Schaumburg

### ✅ **Features That Work for Both**

1. **Station Configuration** (`stations.ts`):
   - ✅ Both have `isHighlight: true` (red marker on map)
   - ✅ Both have correct `gtfsId`, `line`, and `terminal`
   - ✅ Both included in `StationSelector` filter

2. **Crowding Data**:
   - ✅ Both use same scraping logic
   - ✅ Both use same caching system
   - ✅ Both have localStorage persistence

3. **Schedule Data**:
   - ✅ Both fetch from same API endpoint
   - ✅ Both use same GTFS database
   - ✅ Both handle overnight trains correctly

4. **Map Display**:
   - ✅ Both show on map with red markers (isHighlight)
   - ✅ Both have coordinates snapped to rail line

---

### ❌ **Issues Found: Missing Features for Schaumburg**

#### **Issue 1: Real-Time Delay Data (CRITICAL)**
**Location**: `server/db/realtime-updater.ts` lines 7-8, 90, 204

**Problem**:
```typescript
const PALATINE_STOP = 'PALATINE';
const OTC_STOP = 'OTC';

// Line 90: Only processes Palatine and OTC
if (stopId !== PALATINE_STOP && stopId !== OTC_STOP) continue;

// Line 204: Only queries for Palatine and OTC
WHERE stop_id IN ('PALATINE', 'OTC')
```

**Impact**:
- ❌ Schaumburg (SCHAUM) and CUS stops are **NOT processed** in real-time updates
- ❌ Real-time delay data is **NOT available** for Schaumburg trains
- ❌ Historical delay data is **NOT saved** for Schaumburg

**Fix Needed**: Add SCHAUM and CUS to the stop filters

---

#### **Issue 2: Outdated Comment**
**Location**: `client/src/components/TrainMap.tsx` line 610

**Problem**:
```typescript
// Determine icon: Terminal or Palatine = Red, others = Grey
```

**Impact**: 
- ⚠️ Comment is misleading (should say "Terminal or Highlighted stations")
- ✅ Code actually works correctly (uses `isHighlight` which both have)

**Fix Needed**: Update comment to be accurate

---

#### **Issue 3: Default Station**
**Location**: `client/src/pages/Schedule.tsx` lines 239-240

**Current**:
```typescript
const [selectedGtfsId, setSelectedGtfsId] = useState<string>(STATIONS.palatine.gtfsId!);
const selectedStation = Object.values(STATIONS).find(s => s.gtfsId === selectedGtfsId) || STATIONS.palatine;
```

**Impact**: 
- ⚠️ Defaults to Palatine on page load
- ✅ Works fine, but could be more generic

**Fix Needed**: Optional - could make it more generic, but not critical

---

#### **Issue 4: GTFS Loader Comment**
**Location**: `server/db/gtfs-loader.ts` line 129

**Problem**:
```typescript
// Determine express trains (trains with fewer stops between Palatine and OTC)
```

**Impact**: 
- ⚠️ Comment is Palatine-specific
- ✅ Logic is actually generic (works for all stations)

**Fix Needed**: Update comment to be generic

---

## Summary

### **Critical Issues (Must Fix)**:
1. ❌ **Real-time delay data not processed for Schaumburg** - Lines 90, 204 in `realtime-updater.ts`
   - Schaumburg trains won't show real-time delays
   - Historical delay data won't be saved for Schaumburg

### **Minor Issues (Should Fix)**:
2. ⚠️ Outdated comment in `TrainMap.tsx` line 610
3. ⚠️ Outdated comment in `gtfs-loader.ts` line 129
4. ⚠️ Default station is Palatine (works but could be more generic)

### **Working Correctly**:
- ✅ Station configuration
- ✅ Crowding data scraping and caching
- ✅ Schedule data fetching
- ✅ Map display and markers
- ✅ Station selector
- ✅ All frontend features

---

## Recommended Fixes

### **Priority 1: Fix Real-Time Delay Data**
Update `realtime-updater.ts` to include SCHAUM and CUS:
- Line 7-8: Add constants for SCHAUM and CUS
- Line 90: Update filter to include SCHAUM and CUS
- Line 204: Update query to include SCHAUM and CUS

### **Priority 2: Update Comments**
- Update TrainMap.tsx comment to be generic
- Update gtfs-loader.ts comment to be generic

### **Priority 3: Optional Improvements**
- Make default station selection more generic (optional)

