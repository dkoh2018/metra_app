# Crowding Indicator Flow Analysis
## Current Implementation & Potential Interruptions

### ✅ **Current Flow (Already Using DB Values)**

1. **Backend Cache (Working Correctly)**:
   - Returns DB cache if < 5 minutes old
   - Falls back to stale cache (< 24 hours) if scraping fails
   - Only scrapes if cache is expired

2. **Frontend State**:
   - `crowdingData` starts as empty `Map`
   - `fetchCrowding()` called on mount
   - Backend returns cached DB data immediately
   - State updates with DB values

3. **Polling**:
   - Every 60 seconds, checks for updates
   - Backend returns DB cache if fresh
   - Only triggers scrape if cache expired

### ⚠️ **Potential Interruptions**

#### 1. **Refresh Button** (Line 710)
```typescript
if (fetchCrowdingRef.current) {
  fetchCrowdingRef.current(true); // Forces refresh
}
```
**Impact**: Forces refresh, but backend still uses DB cache if < 5 min old
**Status**: ✅ Safe - won't interrupt DB usage

#### 2. **Visibility Change** (Line 630)
```typescript
fetchCrowding(true); // Refresh data immediately when tab becomes visible
```
**Impact**: Forces refresh when tab becomes visible
**Status**: ✅ Safe - backend uses DB cache if available

#### 3. **Polling Interval** (Line 610)
```typescript
interval = setInterval(() => fetchCrowding(false), 60000);
```
**Impact**: Checks every 60 seconds
**Status**: ✅ Safe - backend checks DB first, only scrapes if needed

#### 4. **Station/Direction Change** (Line 647)
```typescript
}, [selectedGtfsId, direction]);
```
**Impact**: Triggers new fetch when station/direction changes
**Status**: ✅ Safe - fetches new station's data from DB

### 🔍 **Current Issue**

**Problem**: On initial page load, `crowdingData` is empty until first API call completes
- Even though backend returns cached DB data, there's a brief moment with no data
- User sees empty state before data loads

**Solution**: Add localStorage persistence to show DB values immediately on page load

---

## Recommended Solution

### Option 1: localStorage Persistence (Recommended)
- Save `crowdingData` to localStorage when it updates
- Load from localStorage on mount (instant display)
- Still fetch from API to get latest data
- Seamless: Shows cached data immediately, updates when new data arrives

### Option 2: Optimistic Initial Load
- Make initial fetch synchronous/prioritized
- Show loading state until data arrives
- Backend already returns DB cache quickly

### Option 3: Keep Current (Already Works)
- Backend already uses DB cache
- Frontend just needs to wait for first fetch
- No changes needed, but slight delay on initial load

---

## Implementation Plan

**Recommended**: Option 1 (localStorage) for instant display while maintaining DB-first approach

**Changes Needed**:
1. Save `crowdingData` to localStorage on update
2. Load from localStorage on mount
3. Still fetch from API (which uses DB cache)
4. Merge localStorage data with fresh data

**Benefits**:
- Instant display on page load
- Still uses DB values (via backend cache)
- Updates seamlessly when new data arrives
- No interruptions to existing flow



