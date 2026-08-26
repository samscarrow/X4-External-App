/**
 * Aggregation for tailored co-captain summaries. Pure functions over data the
 * REST API returns, so every summary instance can be shaped by filters instead
 * of one fixed report.
 */

/**
 * Summarize transaction-log entries (fields: entryid, time, money,
 * partnername, eventtypename, highlighted).
 *
 * Filters (all optional, combinable):
 *  direction    'income' | 'expense' | 'all' (sign of money)
 *  event_type   case-insensitive substring on eventtypename (e.g. "trade")
 *  partner      case-insensitive substring on partnername
 *  q            substring on either field
 *  min_amount   |money| at least this
 *  since_time / until_time   bounds on the entry's in-game time value
 *  newest       only the N most recent entries (applied before aggregation)
 *
 * Shaping:
 *  group_by     'event_type' | 'partner' | 'none' (default 'event_type')
 *  top          max groups returned, by |net| (default 10; rest rolled up)
 */
export function summarizeTransactions(entries, {
    direction = "all",
    event_type,
    partner,
    q,
    min_amount,
    since_time,
    until_time,
    newest,
    group_by = "event_type",
    top = 10,
} = {}) {
    const contains = (haystack, needle) =>
        typeof haystack === "string" && haystack.toLowerCase().includes(needle.toLowerCase());

    let rows = (Array.isArray(entries) ? entries : [])
        .filter((entry) => typeof entry?.money === "number");

    rows.sort((a, b) => (b.time ?? 0) - (a.time ?? 0));
    if (newest != null) rows = rows.slice(0, newest);

    rows = rows.filter((entry) => {
        if (direction === "income" && entry.money <= 0) return false;
        if (direction === "expense" && entry.money >= 0) return false;
        if (event_type && !contains(entry.eventtypename, event_type)) return false;
        if (partner && !contains(entry.partnername, partner)) return false;
        if (q && !(contains(entry.eventtypename, q) || contains(entry.partnername, q))) return false;
        if (min_amount != null && Math.abs(entry.money) < min_amount) return false;
        if (since_time != null && (entry.time ?? 0) < since_time) return false;
        if (until_time != null && (entry.time ?? 0) > until_time) return false;
        return true;
    });

    const bucket = () => ({ count: 0, income: 0, expenses: 0, net: 0 });
    const add = (acc, money) => {
        acc.count++;
        if (money > 0) acc.income += money; else acc.expenses += -money;
        acc.net += money;
    };

    const totals = bucket();
    const groups = new Map();
    const keyOf = (entry) =>
        group_by === "partner" ? (entry.partnername ?? "(unknown)")
            : group_by === "event_type" ? (entry.eventtypename ?? "(unknown)")
                : null;

    for (const entry of rows) {
        add(totals, entry.money);
        const key = keyOf(entry);
        if (key != null) {
            if (!groups.has(key)) groups.set(key, bucket());
            add(groups.get(key), entry.money);
        }
    }

    const ranked = [...groups.entries()]
        .map(([key, acc]) => ({ [group_by]: key, ...acc }))
        .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

    const times = rows.map((entry) => entry.time).filter((time) => time != null);
    return {
        matched: rows.length,
        totals,
        group_by,
        groups: ranked.slice(0, top),
        groups_truncated: Math.max(0, ranked.length - top),
        time_range: times.length ? { from: Math.min(...times), to: Math.max(...times) } : null,
    };
}

/**
 * Summarize journal events (rows from /api/events) into an activity report:
 * counts by type and severity, net credit flow, and the highlights worth
 * reading (urgent events, mission changes).
 */
export function summarizeEvents(events, { top = 10 } = {}) {
    const rows = Array.isArray(events) ? events : [];
    const byType = {};
    const bySeverity = { info: 0, notable: 0, urgent: 0 };
    let creditsNet = 0;
    const urgent = [];
    const missionChanges = [];

    for (const event of rows) {
        byType[event.type] = (byType[event.type] ?? 0) + 1;
        if (bySeverity[event.severity] != null) bySeverity[event.severity]++;
        if (event.type === "credits_changed" && typeof event.delta === "number") {
            creditsNet += event.delta;
        }
        if (event.severity === "urgent") urgent.push(event);
        if (event.type === "active_mission_changed") {
            missionChanges.push({ at: event.created_at, from: event.from, to: event.to });
        }
    }

    return {
        event_count: rows.length,
        by_type: byType,
        by_severity: bySeverity,
        credits_net: creditsNet,
        urgent_events: urgent.slice(-top),
        mission_changes: missionChanges.slice(-top),
    };
}
