/**
 * Co-captain event classification and diffing.
 *
 * Shared between server.js (which diffs every game POST and persists the
 * resulting events to the SQLite journal) and any other consumer. Severity
 * tiers: info < notable < urgent.
 *
 * Tuning via environment:
 *  X4_CREDITS_NOTABLE  credit delta (abs) that becomes notable (default 100000)
 *  X4_CREDITS_URGENT   credit loss that becomes urgent (default 1000000)
 *  X4_URGENT_REGEX     logbook pattern marking an entry urgent
 */

const SEVERITY_RANK = { info: 0, notable: 1, urgent: 2 };
const maxSeverity = (a, b) => (SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b);

function thresholds () {
    return {
        creditsNotable: parseInt(process.env.X4_CREDITS_NOTABLE || '100000', 10),
        creditsUrgent: parseInt(process.env.X4_CREDITS_URGENT || '1000000', 10),
        urgentPattern: new RegExp(
            process.env.X4_URGENT_REGEX ||
            'attack|under fire|destroy|hostile|boarding|emergency|distress',
            'i'
        ),
    };
}

// Logbook entries carry stable ids since v3.6.1's incremental accumulation;
// fall back to content identity for older extensions.
const logbookKey = (entry) =>
    entry?.id != null
        ? `${entry.id}_${entry.time ?? ''}`
        : [entry?.passedtime, entry?.title, entry?.text, entry?.money].join('|');

function classifyLogbookEntry (entry, config = thresholds()) {
    const haystack = `${entry?.title ?? ''} ${entry?.text ?? ''}`;
    if (config.urgentPattern.test(haystack)) return 'urgent';
    if (entry?.highlighted || Math.abs(entry?.money ?? 0) >= config.creditsNotable) return 'notable';
    return 'info';
}

function classifyCredits (delta, config = thresholds()) {
    if (delta <= -config.creditsUrgent) return 'urgent';
    if (Math.abs(delta) >= config.creditsNotable) return 'notable';
    return 'info';
}

function classifyRelation (from, to) {
    // Dropping while negative means shots may follow; anything else is a
    // mention, not an alarm.
    if (to < 0 && to < from) return 'urgent';
    return 'notable';
}

/**
 * Stateful differ. Feed it successive game-state snapshots (null = game not
 * posting); it returns the classified events for each transition. The first
 * call establishes a baseline and emits nothing.
 */
class EventDiffer {
    constructor (config = thresholds()) {
        this.config = config;
        this.initialized = false;
        this.gameOnline = null;
        this.credits = null;
        this.missionName = null;
        this.offerCount = null;
        this.latestSavegameId = null;
        this.logbookKeys = new Set();
        this.factionRelations = new Map();
    }

    diff (gameData, latestSavegame = null) {
        const events = [];
        const online = gameData != null;

        if (this.initialized && online !== this.gameOnline) {
            events.push({
                type: online ? 'game_online' : 'game_offline',
                severity: online ? 'info' : 'notable',
            });
        }
        this.gameOnline = online;

        if (online) {
            const credits = gameData.playerProfile?.credits;
            if (this.initialized && typeof credits === 'number' &&
                typeof this.credits === 'number' && credits !== this.credits) {
                const delta = credits - this.credits;
                events.push({
                    type: 'credits_changed',
                    severity: classifyCredits(delta, this.config),
                    from: this.credits,
                    to: credits,
                    delta,
                });
            }
            if (typeof credits === 'number') this.credits = credits;

            const missionName = gameData.activeMission?.name ?? gameData.activeMission?.title ?? null;
            if (this.initialized && missionName !== this.missionName) {
                events.push({
                    type: 'active_mission_changed',
                    severity: 'notable',
                    from: this.missionName,
                    to: missionName,
                });
            }
            this.missionName = missionName;

            const offers = Array.isArray(gameData.missionOffers) ? gameData.missionOffers.length : null;
            if (this.initialized && offers != null && this.offerCount != null && offers !== this.offerCount) {
                events.push({ type: 'mission_offers_changed', severity: 'info', from: this.offerCount, to: offers });
            }
            if (offers != null) this.offerCount = offers;

            const logbook = Array.isArray(gameData.logbook) ? gameData.logbook : [];
            const newEntries = logbook.filter((entry) => !this.logbookKeys.has(logbookKey(entry)));
            if (this.initialized && newEntries.length > 0) {
                const annotated = newEntries
                    .slice(0, 20)
                    .map((entry) => ({ ...entry, severity: classifyLogbookEntry(entry, this.config) }));
                events.push({
                    type: 'logbook_entries',
                    severity: annotated.reduce((acc, entry) => maxSeverity(acc, entry.severity), 'info'),
                    count: newEntries.length,
                    entries: annotated,
                });
            }
            // Accumulated list grows without bound upstream; keep every key so
            // re-sent entries never re-fire.
            for (const entry of logbook) this.logbookKeys.add(logbookKey(entry));

            const factions = Array.isArray(gameData.factions) ? gameData.factions : [];
            for (const faction of factions) {
                const name = faction?.factionname ?? faction?.name;
                const relation = faction?.relation ?? faction?.relationvalue ?? faction?.reputation;
                if (name == null || relation == null) continue;
                const previous = this.factionRelations.get(name);
                if (this.initialized && previous != null && previous !== relation) {
                    events.push({
                        type: 'faction_relation_changed',
                        severity: classifyRelation(previous, relation),
                        faction: name,
                        from: previous,
                        to: relation,
                    });
                }
                this.factionRelations.set(name, relation);
            }
        }

        const saveId = latestSavegame?.id ?? null;
        if (this.initialized && saveId != null && saveId !== this.latestSavegameId) {
            events.push({
                type: 'savegame_parsed',
                severity: 'info',
                savegame_id: saveId,
                filename: latestSavegame?.filename,
            });
        }
        if (saveId != null) this.latestSavegameId = saveId;

        this.initialized = true;
        return events;
    }
}

module.exports = {
    SEVERITY_RANK,
    maxSeverity,
    thresholds,
    logbookKey,
    classifyLogbookEntry,
    classifyCredits,
    classifyRelation,
    EventDiffer,
};
