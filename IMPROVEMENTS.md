# Future Improvements

This app already feels solid for the core schedule experience. Here are a few scoped enhancements that could make it feel more “production ready” and easier to scale.

## User experience
- **Offline-friendly schedule view:** Cache the latest fetched timetable and allow the client to fall back to it when connectivity drops.
- **Personalized alerts:** Let riders opt into push/email alerts for disruptions or when their usual train is delayed.
- **Quick actions for home screen:** Add an “Add to Home Screen” CTA and deep link into a pre-selected line or station pair.

## Reliability and performance
- **Server-side caching:** Cache GTFS/rail API responses for short intervals to reduce upstream calls and improve load times.
- **Background refresh job:** Run a small worker that periodically refreshes schedules into a local cache to keep startup fast.
- **Monitoring and logging:** Centralize request logs and error tracking (e.g., with structured logs) to watch for time-rollover bugs.

## Engineering hygiene
- **Automated tests for rollover logic:** Add unit tests for the late-night `hasDeparted` edge cases (11:30 PM, 12:30 AM, 1:30 AM) to lock in the intended behavior.
- **Bundle size audits:** Track client bundle size and prioritize lazy-loading maps or heavy visualization components.
- **Dependency trim:** Periodically audit `package.json` for unused UI/tooling libraries to keep installs lean.

## Easy feature wins
- **Service alerts banner:** A small banner for known outages or maintenance windows, sourced from the rail provider’s alert feed.
- **Recent searches:** Persist the last few origin/destination pairs locally for one-tap re-selection.
- **Feedback hook:** A lightweight “Report an issue” link that opens an email or feedback form to capture real-world problems.

