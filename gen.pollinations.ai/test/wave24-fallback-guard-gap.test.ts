/**
 * SECURITY AUDIT (wave 24) — unit PoC:
 * linkFallbackEntries() applies the paidOnly balance-class guard ONLY when the
 * primary is a community endpoint. An official (non-community) model that
 * declares a paid-only fallback target links it with no check. If such a chain
 * is ever added to the static catalog (a one-line config change), admission
 * (which runs once, on the primary) lets a Quest-Pollen-only key through, the
 * paid-only target serves, and settlement (track.ts modelPaidOnly =
 * c.var.model.definition.paidOnly = the PRIMARY's flag) charges the 'tier'
 * bucket — a paid-only model paid for with Quest Pollen.
 */
import assert from "node:assert";
import { linkFallbackEntries } from "../src/fallback.ts";
import type { GenerationModelEntry } from "../src/model-registry.ts";
import { staticFallbackRejection } from "../../shared/community-endpoints.ts";

const freeDef = {
    id: "free/model",
    provider: "prov",
    paidOnly: false,
    fallbacks: ["paid/model"],
    cost: { promptTextTokens: 0, completionTextTokens: 0 },
} as const;

const paidDef = {
    id: "paid/model",
    provider: "prov",
    paidOnly: true,
    // Mirror a real public text model's visibility/endpoint/modality fields so
    // staticFallbackRejection reaches its paidOnly balance check (line 564)
    // instead of rejecting earlier on category/endpoints.
    hidden: false,
    fallbackOnly: false,
    category: "text",
    supportedEndpoints: [
        "/v1/chat/completions",
        "/text",
        "/text/{prompt}",
    ],
    outputModalities: ["text"],
    inputModalities: ["text"],
    priceMultiplier: 1,
    cost: { promptTextTokens: 1e-7, completionTextTokens: 5e-7 },
} as const;

function entry(def: any, communityEndpoint?: any): GenerationModelEntry {
    return {
        id: def.id,
        definition: def,
        eventType: "generate.text",
        supportedEndpoints: ["/v1/chat/completions"],
        ...(communityEndpoint ? { communityEndpoint } : {}),
    } as GenerationModelEntry;
}

// 1. OFFICIAL primary (no communityEndpoint): free -> paid-only LINKS.
{
    const byIdOrAlias = new Map<string, GenerationModelEntry>([
        ["free/model", entry(freeDef)],
        ["paid/model", entry(paidDef)],
    ]);
    linkFallbackEntries([...byIdOrAlias.values()], byIdOrAlias);
    const linked = byIdOrAlias.get("free/model")
        ?.fallbackEntries as GenerationModelEntry[];
    console.log(
        "[official primary] fallbackEntries after link:",
        linked?.map((e) => e.id),
    );
    assert.ok(
        linked?.some((e) => e.id === "paid/model"),
        "OFFICIAL free model linked a paid-only fallback target (guard absent)",
    );
    console.log(
        "  => CONFIRMED: official free -> paid-only chain is linked, no balance-class check",
    );
}

// 2. The SAME pair as a community primary is rejected by the guard.
{
    const communityPrimary = {
        modality: "text",
        imagePricing: "request" as const,
        paidOnly: false,
        prices: {
            promptTextTokens: 1e-7,
            completionTextTokens: 5e-7,
        },
    } as const;
    const rejection = staticFallbackRejection(communityPrimary, paidDef as any);
    console.log("[community primary] staticFallbackRejection:", rejection);
    assert.ok(
        typeof rejection === "string",
        "community primary -> paid-only target is rejected",
    );
}

// 3. Settlement consequence (documented, no DB needed):
//    shared/billing/deduction.ts CASE order is
//      WHEN isPaidOnly THEN 'pack'
//      WHEN questPollenOnly THEN 'tier'
//      WHEN tier >= amount THEN 'tier'
//      WHEN pack > 0 THEN 'pack'
//      ELSE 'tier'
//    track.ts passes modelPaidOnly = c.var.model?.definition.paidOnly — the
//    PRIMARY's flag (false here) — so a quest-only key settling the served
//    paid-only target charges 'tier': Quest Pollen pays for a paid-only model.
console.log(
    "\n[settlement] primary's paidOnly=false => ladder never selects 'pack' for a quest-only key: paid-only output is billed to Quest Pollen.",
);
console.log("\nPoC complete.");
