import { describe, expect, it } from "vitest";
import {
    getGenerationModelRegistry,
} from "../src/model-registry.ts";

/**
 * SECURITY AUDIT: dump every official (non-community) model's cross-model
 * fallback chain with paidOnly flags, and flag any chain where a non-paidOnly
 * primary can fall back to a paidOnly target.
 */
describe("audit: fallback paidOnly matrix", () => {
    it("dumps chains", async () => {
        const registry = await getGenerationModelRegistry();
        const all = registry.getAll?.() ?? [];
        // Build byId map including hidden/fallbackOnly entries
        const byId = new Map<string, any>();
        for (const entry of all) {
            byId.set(entry.id, entry);
        }

        const rows: string[] = [];
        const violations: string[] = [];
        for (const entry of all) {
            const def = entry.definition ?? (entry as any);
            const primaryPaidOnly = (def as any).paidOnly ?? false;
            const declared = ((def as any).fallbacks ?? []) as string[];
            if (declared.length === 0) continue;
            // resolve targets through the same map linkFallbackEntries uses
            const targets = declared
                .map((id) => byId.get(id))
                .filter(Boolean) as any[];
            const chain = targets.map((t) => {
                const tpaid = t.definition?.paidOnly ?? t.paidOnly ?? false;
                return `${t.id}(paidOnly=${tpaid})`;
            });
            rows.push(
                `${entry.id} [paidOnly=${primaryPaidOnly}] -> ${chain.join(", ")}`,
            );
            for (const t of targets) {
                const tpaid = t.definition?.paidOnly ?? t.paidOnly ?? false;
                const isCommunity = Boolean(
                    t.communityEndpoint ?? entry.communityEndpoint,
                );
                if (!primaryPaidOnly && tpaid) {
                    violations.push(
                        `${entry.id} (paidOnly=false) -> ${t.id} (paidOnly=true)` +
                            (isCommunity ? " [community primary]" : " [OFFICIAL primary]"),
                    );
                }
            }
        }

        console.log(`total entries: ${all.length}`);
        console.log("---- FALLBACK CHAINS ----");
        for (const r of rows) console.log(r);
        console.log("---- VIOLATIONS (free primary -> paid-only target) ----");
        if (violations.length === 0) console.log("(none)");
        for (const v of violations) console.log(v);

        // Registry interface discovery
        expect(registry).toBeTruthy();
    }, 120_000);
});
