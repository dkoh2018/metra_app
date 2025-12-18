# Schedule Performance Optimization Plan
## Verified Against Actual Codebase

## Critical Findings:
1. ✅ `currentTime` is passed to `ScheduleTable` but **NOT actually used** - functions call `getCurrentMinutesInChicago()` directly
2. ⚠️ `currentTime` is in `computedNextTrain` dependency array (line 710) but function doesn't use it - safe to remove
3. ✅ `activeAlerts` useMemo calls `getCurrentMinutesInChicago()` but doesn't depend on `currentTime` - no change needed
4. ✅ Next train card has its own `getMinutesUntilDeparture` (line 1002) - separate from ScheduleTable, leave as-is for now

---

## Step 1: Pass `currentMinutes` instead of `currentTime` Date object
**Goal:** Reduce re-renders by passing a number that only changes when the minute changes.

**What to verify BEFORE implementing:**
- [ ] Current behavior: Schedule table updates every 15 seconds
- [ ] Note: Which trains show "Gone" vs active status
- [ ] Note: Countdown timers update correctly
- [ ] Note: Next train highlighting works correctly
- [ ] Note: `computedNextTrain` useMemo currently has `currentTime` in deps (line 710) but doesn't use it

**Changes:**
1. In `Schedule` component (line 1327): Calculate `currentMinutes` using `getCurrentMinutesInChicago()` and pass that instead of `currentTime`
2. In `ScheduleTable` component (line 1360): Change prop type from `currentTime: Date` to `currentMinutes: number`
3. In `ScheduleTable` component (lines 1459, 1514): Update `hasDeparted()` and `getMinutesUntilDeparture()` to accept `currentMinutes` as parameter instead of calling `getCurrentMinutesInChicago()` directly
4. In `Schedule` component (line 710): Remove `currentTime` from `computedNextTrain` dependency array (it's not used anyway)

**Verification AFTER Step 1:**
- [ ] Schedule table still displays correctly
- [ ] "Gone" status appears on departed trains
- [ ] Countdown timers show correct values
- [ ] Next train is highlighted correctly
- [ ] No console errors
- [ ] `computedNextTrain` still works correctly (it calls `getCurrentMinutesInChicago()` directly, so removing `currentTime` from deps is safe)
- [ ] Performance: Table should update less frequently (only when minute changes, not every 15 seconds)

**Risk Level:** 🟢 LOW - `currentTime` isn't actually used in ScheduleTable, so this is safe

---

## Step 2: Memoize `currentMinutes` to only change when minute changes
**Goal:** Prevent unnecessary re-renders when seconds change but the minute stays the same.

**What to verify BEFORE implementing:**
- [ ] Current behavior: `currentTime` updates every 15 seconds
- [ ] Note: The minute value (not seconds) is what matters for train status
- [ ] Note: After Step 1, we're passing `currentMinutes` directly

**Changes:**
1. In `Schedule` component (around line 242-256): Create a memoized `currentMinutes` value
2. Use `useMemo` to calculate minutes from `currentTime`, only recalculating when the minute actually changes
3. Pass this memoized value to `ScheduleTable` instead of recalculating on every render

**Verification AFTER Step 2:**
- [ ] Schedule table updates only when the minute changes (not every 15 seconds)
- [ ] All train statuses remain correct
- [ ] Countdown timers update at the right time
- [ ] No visual glitches or stuttering
- [ ] Performance: Smoother experience, fewer unnecessary re-renders

**Risk Level:** 🟢 LOW - Just memoizing a calculation, no logic changes

---

## Step 3: Extract and memoize `hasDeparted` calculation per train
**Goal:** Avoid recalculating `hasDeparted` for every train on every render.

**What to verify BEFORE implementing:**
- [ ] Current behavior: Which trains show "Gone" status
- [ ] Note: Edge cases (overnight trains, late night viewing, etc.)
- [ ] Note: Train departure times that are close to current time
- [ ] Note: `hasDeparted` function is defined inside ScheduleTable (line 1457)

**Changes:**
1. In `ScheduleTable` component: Create a `useMemo` that calculates `hasDeparted` for all trains at once
2. Store results in a `Map<trainId, boolean>`
3. Use this map in the render loop instead of calling `hasDeparted()` for each train
4. Keep the `hasDeparted` function logic exactly the same, just call it once per train in the memo

**Verification AFTER Step 3:**
- [ ] "Gone" status appears on the same trains as before
- [ ] Edge cases work (overnight trains, late night, etc.)
- [ ] No trains incorrectly marked as departed/active
- [ ] Performance: Faster rendering, especially with many trains

**Risk Level:** 🟡 MEDIUM - Need to ensure memo dependencies are correct

---

## Step 4: Extract and memoize `getMinutesUntilDeparture` calculation per train
**Goal:** Avoid recalculating countdown timers for every train on every render.

**What to verify BEFORE implementing:**
- [ ] Current behavior: Countdown timers show correct values
- [ ] Note: Trains showing "Gone" vs active countdowns
- [ ] Note: Edge cases (overnight trains, trains departing soon)
- [ ] Note: `getMinutesUntilDeparture` function is defined inside ScheduleTable (line 1512)
- [ ] Note: This function is called inside the render loop for each train (line 1770)

**Changes:**
1. In `ScheduleTable` component: Create a `useMemo` that calculates minutes until departure for all trains
2. Store results in a `Map<trainId, number | null>`
3. Use this map in the render loop instead of calling `getMinutesUntilDeparture()` for each train
4. Keep the `getMinutesUntilDeparture` function logic exactly the same, just call it once per train in the memo

**Verification AFTER Step 4:**
- [ ] Countdown timers show the same values as before
- [ ] "Gone" trains show "Gone" (not countdown)
- [ ] Active trains show correct countdown
- [ ] Edge cases work correctly
- [ ] Performance: Even faster rendering

**Risk Level:** 🟡 MEDIUM - Need to ensure memo dependencies are correct

---

## Step 5: Extract `parseTime` helper outside render loop
**Goal:** Avoid creating the same function repeatedly in the render loop.

**What to verify BEFORE implementing:**
- [ ] Current behavior: Time parsing works correctly for "8:13 PM" format
- [ ] Note: All time formats that are parsed (AM/PM, 24h, etc.)
- [ ] Note: `parseTime` is defined inline in multiple places (lines 1657, 1698, and inside nextTrain card)

**Changes:**
1. Move `parseTime` function outside the component (or use `useCallback`)
2. Update all places that use inline `parseTime` to use the extracted version
3. Keep the logic exactly the same

**Verification AFTER Step 5:**
- [ ] All time displays remain correct
- [ ] Estimated times show correctly
- [ ] No parsing errors
- [ ] Performance: Slight improvement, cleaner code

**Risk Level:** 🟢 LOW - Just extracting a helper function

---

## Step 6: Optimize auto-scroll behavior
**Goal:** Make scrolling smoother and less jarring.

**What to verify BEFORE implementing:**
- [ ] Current behavior: Auto-scroll happens when next train changes
- [ ] Note: When smooth vs auto scroll occurs (line 1439)
- [ ] Note: User experience when scrolling manually

**Changes:**
1. Track if user has manually scrolled (add state/ref to track manual scroll)
2. Only use smooth scroll if user hasn't manually scrolled
3. Use `'auto'` for initial positioning, `'smooth'` only when appropriate

**Verification AFTER Step 6:**
- [ ] Auto-scroll still works when next train changes
- [ ] Manual scrolling isn't interrupted
- [ ] Scrolling feels smoother
- [ ] No jarring jumps

**Risk Level:** 🟡 MEDIUM - Need to track user interaction state

---

## Step 7: Memoize individual train row data (ADVANCED - Optional)
**Goal:** Prevent re-rendering rows when their data hasn't changed.

**What to verify BEFORE implementing:**
- [ ] Current behavior: All train rows render correctly
- [ ] Note: Which props change frequently vs rarely
- [ ] Note: This is a bigger refactor - consider doing this last

**Changes:**
1. Extract train row rendering into a separate memoized component
2. Use `React.memo` with custom comparison function
3. Only re-render row when its specific data changes

**Verification AFTER Step 7:**
- [ ] All train rows display correctly
- [ ] Individual rows only re-render when their data changes
- [ ] No visual glitches
- [ ] Performance: Significant improvement, especially with many trains

**Risk Level:** 🔴 HIGH - Bigger refactor, do this last after all other optimizations

---

## Testing Checklist (After Each Step)

Before moving to the next step, verify:

### 1. Visual Correctness:
- [ ] All trains display correctly
- [ ] Times show correctly
- [ ] Status indicators work (Gone, Next train highlight, etc.)
- [ ] Countdown timers accurate
- [ ] Crowding indicators show
- [ ] Estimated times display correctly

### 2. Edge Cases:
- [ ] Overnight trains (24:XX format)
- [ ] Late night viewing (after 6 PM)
- [ ] Early morning (before 4 AM)
- [ ] Trains departing soon
- [ ] Trains that just departed

### 3. Performance:
- [ ] No console errors
- [ ] No visual stuttering
- [ ] Smooth scrolling
- [ ] Responsive interactions

### 4. Functionality:
- [ ] Direction switching works
- [ ] Station switching works
- [ ] Day type switching works
- [ ] Refresh button works

---

## Recommended Order

**Start with Step 1** (biggest impact, lowest risk), then proceed sequentially. Test thoroughly after each step before moving to the next.

**Stop if any step breaks functionality** - each step should be independently safe and testable.

