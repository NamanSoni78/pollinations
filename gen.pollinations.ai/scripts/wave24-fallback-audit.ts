/**
 * SECURITY AUDIT (wave 24): dump every model's fallback chain with paidOnly flags.
 * Mirrors gen/src/fallback.ts linkFallbackEntries logic for OFFICIAL models:
 * no balance-class guard is applied when the primary is not a community endpoint.
 */
import { TEXT_SERVICES } from "../../shared/registry/text.ts";
import { IMAGE_SERVICES } from "../../shared/registry/image.ts";
import { AUDIO_SERVICES } from "../../shared/registry/audio.ts";
import { EMBEDDING_SERVICES } from "../../shared/registry/embeddings.ts";
import { MODEL3D_SERVICES } from "../../shared/registry/model3d.ts";

const catalogs: Record<string, Record<string, any>> = {
    text: TEXT_SERVICES as any,
    image: IMAGE_SERVICES as any,
    audio: AUDIO_SERVICES as any,
    embeddings: EMBEDDING_SERVICES as any,
    model3d: MODEL3D_SERVICES as any,
};

// alias map like byIdOrAlias (only exact ids here; aliases resolved separately below)
const byId = new Map<string, { def: any; catalog: string }>();
const byAlias = new Map<string, string>(); // alias -> id
for (const [cat, models] of Object.entries(catalogs)) {
    for (const [id, def] of Object.entries(models)) {
        byId.set(id, { def, catalog: cat });
        for (const a of def.aliases ?? []) byAlias.set(a, id);
    }
}

const resolve = (s: string) => byId.get(s)?.def ?? byId.get(byAlias.get(s) ?? "")?.def;

let violations = 0;
let chains = 0;
const rows: string[] = [];

for (const [cat, models] of Object.entries(catalogs)) {
    for (const [id, def] of Object.entries(models)) {
        const primaryPaidOnly = def.paidOnly ?? false;
        const declared: string[] = def.fallbacks ?? [];
        if (declared.length === 0) continue;
        chains++;
        const parts: string[] = [];
        for (const targetId of declared) {
            const target = resolve(targetId);
            if (!target) {
                parts.push(`${targetId}(UNRESOLVED)`);
                continue;
            }
            const targetPaidOnly = target.paidOnly ?? false;
            const sameModelRoute = targetId.includes(":"); // provider route, inherits parent flags
            parts.push(`${targetId}(paidOnly=${targetPaidOnly}${sameModelRoute ? ",route" : ""})`);
            if (!primaryPaidOnly && targetPaidOnly) {
                violations++;
                rows.push(
                    `VIOLATION [${cat}] ${id} (paidOnly=${primaryPaidOnly}) -> ${targetId} (paidOnly=${targetPaidOnly})`,
                );
            }
        }
        if (rows.length < 200)
            rows.push(`chain [${cat}] ${id} (paidOnly=${primaryPaidOnly}) -> ${parts.join(", ")}`);
    }
}

console.log(`total chains: ${chains}`);
console.log(`violations (non-paidOnly primary -> paidOnly target): ${violations}\n`);
for (const r of rows) console.log(r);

// Also: which models are paidOnly at all (per catalog)
console.log("\n---- paidOnly models ----");
for (const [cat, models] of Object.entries(catalogs)) {
    const paid = Object.entries(models)
        .filter(([, d]) => (d as any).paidOnly)
        .map(([id]) => id);
    console.log(`${cat}: ${paid.length} -> ${paid.join(", ")}`);
}
