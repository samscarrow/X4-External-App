/**
 * Guard for the read-only SQL tool: single SELECT/WITH statement only.
 */
export function assertReadOnlySql(sql) {
    const stripped = sql
        .replace(/--.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .trim();
    if (!/^(select|with)\b/i.test(stripped)) {
        throw new Error("Only SELECT / WITH queries are allowed (read-only database).");
    }
    if (/;[\s\S]*\S/.test(stripped)) {
        throw new Error("Only a single SQL statement is allowed.");
    }
    return stripped;
}
