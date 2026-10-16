/*
 * The Trolley Problem, with Jev — game engine.
 * Vanilla JS, no dependencies. BYOP sign-in via Pollinations OAuth (PKCE);
 * every Jev consultation is paid with the player's own Pollen.
 */

/* Config ---------------------------------------------------------------- */
const CLIENT_ID = "pk_mx8B1qJjeNnE9mEn";
const ENTER_URL = "https://enter.pollinations.ai";
const GEN_URL = "https://gen.pollinations.ai";
const ARTICLE_URL = "https://zachlandes.com/trolley-problem/";
const QUEST_URL = "https://github.com/pollinations/pollinations/issues/17647";
const MODELS = {
    jev: { id: "typesafe/jev-1.13", label: "Jev", noulOnly: false },
    span: { id: "respan/span-01-lite", label: "span-01-lite (free tier)", noulOnly: true },
};
const ROUNDS_PER_GAME = 10;

/* State ------------------------------------------------------------------ */
const S = {
    view: "attract",            // attract | auth | dilemma | report | lab
    key: null,                  // the user's Pollen key (BYOP token or pasted key)
    keySource: null,            // "byop" | "manual"
    username: null,
    model: "jev",
    round: 0,
    score: 0,
    streak: 0,
    deck: [],                   // scenario order
    sc: null,                   // current scenario
    framing: "main-first",
    playerChoice: null,         // "act" | "refrain"
    verdict: null,              // last decision response
    flipVerdict: null,
    flipBet: null,
    triple: null,
    history: [],                // per-round records
    calls: 0, tokensIn: 0, tokensOut: 0,
};

/* DOM shortcuts ------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const el = (tag, cls, html) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html !== undefined) e.innerHTML = html;
    return e;
};

/* =========================================================================
 * BYOP auth — OAuth authorization-code flow with PKCE (browser-only).
 * Pattern follows pollinations/pollinations apps/oauth-client-demo.
 * ============================================================================ */
function randomB64Url() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function pkceChallenge(verifier) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    return btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
async function startByop() {
    const verifier = randomB64Url();
    const state = randomB64Url();
    sessionStorage.setItem("tj_verifier", verifier);
    sessionStorage.setItem("tj_state", state);
    const params = new URLSearchParams({
        response_type: "code",
        client_id: CLIENT_ID,
        redirect_uri: location.origin + location.pathname,
        scope: "profile usage",
        state,
        code_challenge: await pkceChallenge(verifier),
        code_challenge_method: "S256",
    });
    location.href = `${ENTER_URL}/authorize?${params}`;
}
async function handleByopCallback() {
    const params = new URLSearchParams(location.search);
    const code = params.get("code");
    const oauthError = params.get("error");
    if (!code && !oauthError) return false;

    const expectedState = sessionStorage.getItem("tj_state");
    if (!expectedState || params.get("state") !== expectedState) {
        history.replaceState({}, "", location.pathname);
        showError("Sign-in failed: state did not match. Try again.");
        return true;
    }
    const verifier = sessionStorage.getItem("tj_verifier");
    sessionStorage.removeItem("tj_state");
    sessionStorage.removeItem("tj_verifier");
    history.replaceState({}, "", location.pathname);

    if (oauthError) {
        showError(`Sign-in was ${oauthError === "access_denied" ? "declined" : oauthError}. You can still paste an API key.`);
        return true;
    }
    if (!verifier) { showError("Sign-in failed: missing PKCE verifier. Try again."); return true; }

    const res = await fetch(`${ENTER_URL}/api/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code,
            client_id: CLIENT_ID,
            redirect_uri: location.origin + location.pathname,
            code_verifier: verifier,
        }),
    });
    const token = await res.json();
    if (!res.ok) {
        showError(`Sign-in failed: ${token.error_description || token.error || "token exchange failed"}. Try again or paste an API key.`);
        return true;
    }
    S.key = token.access_token;
    S.keySource = "byop";
    S.model = "jev";
    sessionStorage.setItem("tj_key", S.key);
    sessionStorage.setItem("tj_key_src", "byop");
    if ((token.scope || "").includes("profile")) fetchWhoAmI();
    return true;
}
async function fetchWhoAmI() {
    try {
        const res = await fetch(`${ENTER_URL}/api/device/userinfo`, { headers: { Authorization: `Bearer ${S.key}` } });
        if (res.ok) {
            const u = await res.json();
            S.username = u.preferred_username || u.name || "friend";
        }
    } catch { /* profile is cosmetic */ }
}

/* =========================================================================
 * Jev client — POST /alpha/decisions
 * ============================================================================ */
async function askDecision(state, questions, modelKey) {
    const model = MODELS[modelKey || S.model];
    const res = await fetch(`${GEN_URL}/alpha/decisions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${S.key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: model.id, state, questions }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        const err = new Error(data?.error?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.data = data;
        throw err;
    }
    S.calls += 1;
    S.tokensIn += data.usage?.input_tokens || 0;
    S.tokensOut += data.usage?.output_tokens || 0;
    renderPollenChip();
    return data;
}

/* Normalize a decision response to { actNoul, choice, confidence, probabilities, permissible, seriousness } */
function normalizeVerdict(data, noulOnly) {
    const out = { raw: data, actNoul: null, choice: null, confidence: null, probabilities: null, permissible: null, seriousness: null };
    const a = data.answers || {};
    if (noulOnly) {
        if (a.action?.type === "noul") out.actNoul = a.action.noul;
        out.choice = out.actNoul == null ? null : (out.actNoul >= 0.5 ? "act" : "refrain");
        out.probabilities = out.actNoul == null ? null : { act: out.actNoul, refrain: 1 - out.actNoul };
    } else {
        if (a.action?.type === "choice") {
            out.choice = a.action.choice;
            out.confidence = a.action.confidence;
            out.probabilities = a.action.probabilities || null;
        }
    }
    if (a.permissible?.type === "noul") out.permissible = a.permissible.noul;
    if (a.seriousness?.type === "score") out.seriousness = a.seriousness;
    return out;
}

/* =========================================================================
 * Game flow
 * ============================================================================ */
function newDeck() {
    const first = SCENARIOS.filter((s) => s.id === "classic");
    const rest = SCENARIOS.filter((s) => s.id !== "classic");
    shuffle(rest);
    S.deck = [...first, ...rest];
}
function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
}
function nextScenario() {
    if (S.deck.length === 0) newDeck();
    S.sc = S.deck.shift();
    S.framing = Math.random() < 0.5 ? "main-first" : "side-first";
    S.playerChoice = null;
    S.verdict = null;
    S.flipVerdict = null;
    S.flipBet = null;
    S.triple = null;
    S.roundRec = null;
    S.callsAtRoundStart = S.calls;
    S.round += 1;
    S.view = "dilemma";
    renderRound();
}
function choose(choice) {
    if (S.playerChoice) return;
    S.playerChoice = choice;
    renderRound();
}
async function askJev() {
    if (!S.key) { renderAuthGate("Sign in with your Pollen first — Jev's answers cost your own Pollen, a fraction of a cent each."); return; }
    if (!S.playerChoice) { flash("Lock in your own choice first — then see what Jev does."); return; }

    setAskButton("Jev is deciding…", true);
    hideError();
    try {
        const state = buildState(S.sc, S.framing);
        const questions = MODELS[S.model].noulOnly ? buildQuestionsNoul(S.sc) : buildQuestions(S.sc);
        const data = await askDecision(state, questions, S.model);
        S.verdict = normalizeVerdict(data, MODELS[S.model].noulOnly);
        S.roundRec = computeRoundScore();
        animateScene(S.playerChoice);
        renderRound();
    } catch (e) {
        handleDecisionError(e);
    } finally {
        setAskButton(null, false);
    }
}
function handleDecisionError(e) {
    const msg = e?.data?.error?.message || e?.message || "Something went wrong.";
    if (e.status === 402) {
        showError(
            `This model needs Paid Pollen and your paid balance can't cover it (${msg.match(/~[\d.]+ pollen/)?.[0] || "a fraction of a cent"} per call). ` +
            `You can <a href="https://enter.pollinations.ai/top-up" target="_blank" rel="noopener">top up</a>, or ` +
            `<a href="#" id="fallback-span">switch to the free-tier model</a> (noul-only answers).`,
        );
        const link = $("fallback-span");
        if (link) link.onclick = (ev) => { ev.preventDefault(); S.model = "span"; hideError(); askJev(); };
    } else if (e.status === 401) {
        showError("Your key was rejected (revoked or expired). Sign in again or paste a fresh key.");
        S.key = null; sessionStorage.removeItem("tj_key");
        renderAuthGate();
    } else if (e.status === 429) {
        showError("Rate limited — give it a few seconds and ask again.");
    } else if (e.status === 403) {
        showError("Your key isn't allowed to use this model. Try another model or sign in again.");
    } else {
        showError(msg);
    }
}
async function frameFlip(bet) {
    S.flipBet = bet;
    const flipOrder = S.framing === "side-first" ? "main-first" : "side-first";
    try {
        const state = buildState(S.sc, flipOrder);
        const questions = MODELS[S.model].noulOnly ? buildQuestionsNoul(S.sc) : buildQuestions(S.sc);
        const data = await askDecision(state, questions, S.model);
        S.flipVerdict = normalizeVerdict(data, MODELS[S.model].noulOnly);
        // award flip points exactly once, when the flip verdict arrives
        const flipped = S.flipVerdict.choice !== S.verdict.choice;
        const right = (S.flipBet === "flip") === flipped;
        if (right) { S.score += 15; if (S.roundRec) S.roundRec.flipPoints = 15; }
        renderRound();
    } catch (e) {
        handleDecisionError(e);
        S.flipBet = null;
    }
}
async function triplePass() {
    const runs = [];
    for (let i = 0; i < 3; i++) {
        try {
            const state = buildState(S.sc, S.framing);
            const questions = MODELS[S.model].noulOnly ? buildQuestionsNoul(S.sc) : buildQuestions(S.sc);
            runs.push(normalizeVerdict(await askDecision(state, questions, S.model), MODELS[S.model].noulOnly));
        } catch (e) {
            handleDecisionError(e);
            return;
        }
    }
    S.triple = runs;
    renderRound();
}
function nextRound() {
    if (S.round >= ROUNDS_PER_GAME) { S.view = "report"; renderReport(); }
    else nextScenario();
}

/* Scoring — computed exactly once per round, when the verdict first arrives. --- */
function computeRoundScore() {
    const v = S.verdict;
    if (!v || v.choice == null) return { agree: false, points: 0, agreePoints: 0, flipPoints: 0 };
    const agree = v.choice === S.playerChoice;
    let agreePoints = 0;
    if (agree) {
        S.streak += 1;
        agreePoints = 10 + Math.min(10, 2 * (S.streak - 1));
        S.score += agreePoints;
    } else {
        S.streak = 0;
    }
    return { agree, points: agreePoints, agreePoints, flipPoints: 0 };
}

/* Persistence ------------------------------------------------------------- */
const LS_KEY = "trolley-jev-stats";
function loadStats() {
    try { return JSON.parse(localStorage.getItem(LS_KEY)) || {}; } catch { return {}; }
}
function saveRoundRecord(rec) {
    const st = loadStats();
    st.rounds = (st.rounds || 0) + 1;
    st.agreements = (st.agreements || 0) + (rec.agree ? 1 : 0);
    st.playerActs = (st.playerActs || 0) + (rec.playerChoice === "act" ? 1 : 0);
    st.jevActs = (st.jevActs || 0) + (rec.jevChoice === "act" ? 1 : 0);
    st.permSum = (st.permSum || 0) + (rec.permissible ?? 0);
    st.permCount = (st.permCount || 0) + (rec.permissible == null ? 0 : 1);
    st.calls = (st.calls || 0) + Math.max(0, S.calls - (S.callsAtRoundStart || 0));
    st.flips = (st.flips || 0) + (rec.flipped ? 1 : 0);
    st.flipTests = (st.flipTests || 0) + (rec.flipTested ? 1 : 0);
    localStorage.setItem(LS_KEY, JSON.stringify(st));
}

/* =========================================================================
 * Rendering
 * ============================================================================ */
function render() {
    for (const v of ["view-attract", "view-dilemma", "view-report", "view-lab"]) $(v).hidden = true;
    const map = { attract: "view-attract", dilemma: "view-dilemma", report: "view-report", lab: "view-lab" };
    $(map[S.view]).hidden = false;
    renderHeader();
}
function renderHeader() {
    // keep the styled markup in index.html; no overwrite needed
    const auth = $("auth-area");
    auth.innerHTML = "";
    if (S.key) {
        const chip = el("div", "chip chip-ok", `<span class="dot"></span> ${S.username ? "@" + S.username : "connected"} · your Pollen`);
        const modelSel = el("select", "model-select");
        for (const [k, m] of Object.entries(MODELS)) {
            const o = el("option", "", m.label);
            o.value = k;
            if (k === S.model) o.selected = true;
        }
        modelSel.onchange = () => { S.model = modelSel.value; renderPollenChip(); };
        const signout = el("button", "linklike", "sign out");
        signout.onclick = () => {
            S.key = null; S.username = null; S.keySource = null;
            sessionStorage.removeItem("tj_key"); sessionStorage.removeItem("tj_key_src");
            S.view = "attract"; render();
        };
        auth.append(chip, modelSel, signout);
        renderPollenChip();
    } else {
        const b = el("button", "btn btn-primary btn-sm", "Sign in with Pollen");
        b.onclick = startByop;
        const b2 = el("button", "btn btn-ghost btn-sm", "Paste an API key");
        b2.onclick = () => renderAuthGate();
        auth.append(b, b2);
    }
}
function renderPollenChip() {
    const holder = $("pollen-chip");
    if (!S.key) { holder.innerHTML = ""; return; }
    holder.innerHTML = `<span class="chip">Jev calls: ${S.calls} · tokens ${S.tokensIn}↓ ${S.tokensOut}↑</span>`;
}
function renderAuthGate(message) {
    const gate = $("auth-gate");
    gate.hidden = false;
    $("auth-message").innerHTML = message ||
        "This game consults <b>Jev</b>, a Pollinations decision model, on every dilemma — and every consultation is paid with <b>your own Pollen</b>. A typical game of ten rounds costs well under one cent.";
    render();
    gate.scrollIntoView({ behavior: "smooth" });
}
function showError(html) {
    const e = $("error-box");
    e.innerHTML = html;
    e.hidden = false;
}
function hideError() { $("error-box").hidden = true; }
function flash(msg) {
    const f = $("flash");
    f.textContent = msg;
    f.hidden = false;
    setTimeout(() => { f.hidden = true; }, 2200);
}
function setAskButton(label, busy) {
    const b = $("ask-jev");
    if (!b) return;
    if (label) { b.dataset.orig = b.innerHTML; b.innerHTML = label; b.disabled = true; }
    else { if (b.dataset.orig) b.innerHTML = b.dataset.orig; b.disabled = false; }
}

/* --- Round view ------------------------------------------------------------ */
function renderRound() {
    render();
    const sc = S.sc;
    $("round-no").textContent = `Round ${S.round} of ${ROUNDS_PER_GAME}`;
    $("round-score").textContent = `${S.score} pts · streak ${S.streak}`;
    $("sc-title").textContent = sc.title;
    $("sc-tag").textContent = sc.tag;
    $("sc-body").textContent = buildState(sc, S.framing);

    renderScene(sc);
    renderChoices(sc);

    // Player's pick
    if (S.playerChoice) {
        $("your-pick").hidden = false;
        $("your-pick").innerHTML = `You chose: <b>${S.playerChoice === "act" ? sc.actLabel : sc.refrainLabel}</b>`;
    } else {
        $("your-pick").hidden = true;
    }

    // Ask Jev button state
    const ask = $("ask-jev");
    if (S.verdict) { ask.hidden = true; } else { ask.hidden = false; }

    // Verdict
    const box = $("verdict");
    box.innerHTML = "";
    if (S.verdict) {
        const rec = S.roundRec || { agree: false, points: 0, agreePoints: 0, flipPoints: 0 };
        renderVerdictCard(box, sc, S.verdict, S.playerChoice, rec);
        // Lab experiments
        const lab = el("div", "lab");
        if (!S.flipVerdict) {
            lab.append(el("p", "lab-q", `Landes found that just reversing the order of the track descriptions flips Jev's choice in 370 of 2,620 pairs. Same dilemma, words flipped — will Jev change its mind?`));
            const row = el("div", "row");
            const bFlip = el("button", "btn btn-ghost", "Bet it flips (+15)");
            bFlip.onclick = () => frameFlip("flip");
            const bStay = el("button", "btn btn-ghost", "Bet it stays (+15)");
            bStay.onclick = () => frameFlip("stay");
            if (S.flipBet) { bFlip.disabled = true; bStay.disabled = true; }
            row.append(bFlip, bStay);
            lab.append(row);
        } else {
            renderFlipCard(lab);
        }
        if (!S.triple) {
            const bTriple = el("button", "btn btn-ghost", "Ask it three times, like Landes did");
            bTriple.onclick = triplePass;
            lab.append(bTriple);
        } else {
            renderTripleCard(lab);
        }
        box.append(lab);

        const note = el("div", "philosophy-note", `<b>Afterwards.</b> ${sc.note}`);
        box.append(note);

        const next = el("button", "btn btn-primary", S.round >= ROUNDS_PER_GAME ? "See your alignment report" : "Next dilemma");
        next.onclick = () => {
            const rec = roundRecord();
            rec.agree = !!(S.roundRec && S.roundRec.agree);
            saveRoundRecord(rec);
            nextRound();
        };
        box.append(next);
    }
}
function roundRecord() {
    const v = S.verdict;
    return {
        id: S.sc.id,
        agree: v && v.choice != null && v.choice === S.playerChoice,
        playerChoice: S.playerChoice,
        jevChoice: v ? v.choice : null,
        permissible: v ? v.permissible : null,
        flipped: !!(S.flipVerdict && v && S.flipVerdict.choice !== v.choice),
        flipTested: !!S.flipVerdict,
    };
}

/* --- The animated track scene (SVG) ------------------------------------------ */
function personGlyph(x, y, cls) {
    return `<g class="person ${cls || ""}" transform="translate(${x} ${y})">
        <circle cx="0" cy="-11" r="4.2"/>
        <rect x="-3.4" y="-6" width="6.8" height="12" rx="3"/>
    </g>`;
}
function serverGlyph(x, y, cls) {
    return `<g class="server-glyph ${cls || ""}" transform="translate(${x} ${y})">
        <rect x="-9" y="-12" width="18" height="24" rx="2"/>
        <circle cx="-3" cy="-5" r="1.6"/><circle cx="3" cy="-5" r="1.6"/>
        <circle cx="-3" cy="1" r="1.6"/><circle cx="3" cy="1" r="1.6"/>
        <circle cx="0" cy="7" r="1.6"/>
    </g>`;
}
function occupantGlyphs(kind, sc, cls) {
    /* kind: "main" (on the main track) or "side" (along the branch / on the bridge) */
    const isServer = kind === "side" ? !!sc.serverSide : /server/i.test(sc.mainDesc || "");
    const glyph = (x, y, c) => (isServer ? serverGlyph(x, y, c) : personGlyph(x, y, c));
    if (kind === "main") {
        const n = Math.min(sc.main.n, 9);
        let out = "";
        for (let i = 0; i < n; i++) {
            const x = 330 + (i % 5) * 42 + Math.floor(i / 5) * 12;
            const y = 58 + Math.floor(i / 5) * 26;
            out += glyph(x, y, "fig-main");
        }
        return out;
    }
    if (sc.side.n === 0) return "";
    if (sc.kind === "footbridge") {
        return `<g class="pushed">${glyph(475, -46, "fig-side on-bridge")}</g>`;
    }
    const n = Math.min(sc.side.n, 9);
    let out = "";
    for (let i = 0; i < n; i++) out += glyph(512 + i * 34, -44, "fig-side");
    return out;
}
function renderScene(sc) {
    const holder = $("scene");
    if (sc.kind === "abstract") { holder.innerHTML = abstractScene(sc); return; }

    const isBridge = sc.kind === "footbridge";
    const bridge = isBridge ? `
        <g class="bridge">
            <rect x="430" y="-70" width="90" height="7" />
            <rect x="436" y="-63" width="5" height="63"/>
            <rect x="509" y="-63" width="5" height="63"/>
        </g>` : "";

    holder.innerHTML = `
    <svg viewBox="0 -140 640 200" class="track-svg" role="img" aria-label="trolley track scene">
        <g class="rails">
            <line x1="0" y1="30" x2="640" y2="30"/>
            <line x1="0" y1="50" x2="640" y2="50"/>
            ${isBridge ? "" : `
            <line x1="430" y1="30" x2="640" y2="-94"/>
            <line x1="450" y1="48" x2="640" y2="-76"/>`}
        </g>
        <g class="switch-mark">${isBridge ? "" : '<circle cx="415" cy="40" r="5"/>'}</g>
        ${bridge}
        <g class="figures">${occupantGlyphs("main", sc)}${occupantGlyphs("side", sc)}</g>
        <text x="16" y="18" class="track-label">main track · ${escapeHtml(mainCountLabel(sc))}</text>
        ${isBridge ? "" : `<text x="600" y="-96" class="track-label track-label-side">${sc.kind === "loop" ? "loop · back onto the main track" : "side track · " + escapeHtml(sideCountLabel(sc) || "empty")}</text>`}
        <g id="trolley" class="trolley">
            <rect x="-22" y="-26" width="44" height="26" rx="6"/>
            <rect x="-16" y="-21" width="10" height="9" rx="1.5"/>
            <rect x="-2" y="-21" width="10" height="9" rx="1.5"/>
            <rect x="12" y="-21" width="6" height="9" rx="1.5"/>
            <circle cx="-12" cy="2" r="5"/>
            <circle cx="12" cy="2" r="5"/>
            <path d="M -22 -26 l 8 -8 h 8" class="pole"/>
        </g>
    </svg>`;
    positionTrolley("start");
}
function abstractScene(sc) {
    return `
    <svg viewBox="0 0 640 200" class="track-svg abstract-svg" role="img" aria-label="dilemma illustration">
        <g class="panel panel-main">
            <rect x="30" y="30" width="270" height="140" rx="12"/>
            <text x="165" y="62" class="panel-title">if you refrain</text>
            <text x="165" y="96" class="panel-count">${sc.main.n}</text>
            <text x="165" y="126" class="panel-sub">${escapeHtml(mainCountLabel(sc))} ${sc.main.n === 1 ? "dies" : "die"}</text>
        </g>
        <g class="panel panel-side">
            <rect x="340" y="30" width="270" height="140" rx="12"/>
            <text x="475" y="62" class="panel-title">if you act</text>
            <text x="475" y="96" class="panel-count">${sc.side.n}</text>
            <text x="475" y="126" class="panel-sub">${escapeHtml(sideCountLabel(sc))} ${sc.side.n === 1 ? "dies" : "die"}</text>
        </g>
        <text x="320" y="192" class="track-label" text-anchor="middle">${escapeHtml(sc.actLabel)} — or — ${escapeHtml(sc.refrainLabel)}</text>
    </svg>`;
}
function positionTrolley(phase) {
    const t = $("trolley");
    if (!t) return;
    t.classList.remove("roll-main", "roll-side");
    if (phase === "act" && S.sc.kind !== "footbridge") t.classList.add("roll-side");
    if (phase === "refrain" || (phase === "act" && S.sc.kind === "footbridge")) t.classList.add("roll-main");
}
function animateScene(playerChoice) {
    positionTrolley(playerChoice);
    const sc = S.sc;
    const doomedClass = playerChoice === "act" ? ".fig-side" : ".fig-main";
    setTimeout(() => {
        $("scene").querySelectorAll(doomedClass).forEach((p) => p.classList.add("doomed"));
        if (sc.kind === "footbridge" && playerChoice === "act") {
            const pushed = $("scene").querySelector(".pushed");
            if (pushed) pushed.classList.add("pushed-fall");
        }
    }, 900);
}

/* --- Choices ------------------------------------------------------------------ */
function renderChoices(sc) {
    const row = $("choices");
    row.innerHTML = "";
    const sideSub = sc.side.n === 0 ? "nobody is on it — the trolley just stops"
        : `${escapeHtml(sideCountLabel(sc))} ${sc.side.n === 1 ? "dies" : "die"}`;
    const bAct = el("button", "choice choice-act",
        `<span class="choice-title">${sc.actLabel}</span><span class="choice-sub">${sideSub}</span>`);
    const bRefrain = el("button", "choice choice-refrain",
        `<span class="choice-title">${sc.refrainLabel}</span><span class="choice-sub">${escapeHtml(mainCountLabel(sc))} ${sc.main.n === 1 ? "dies" : "die"}</span>`);
    bAct.onclick = () => choose("act");
    bRefrain.onclick = () => choose("refrain");
    if (S.playerChoice) {
        bAct.classList.toggle("picked", S.playerChoice === "act");
        bRefrain.classList.toggle("picked", S.playerChoice === "refrain");
        bAct.disabled = true; bRefrain.disabled = true;
    }
    row.append(bAct, bRefrain);
}

/* --- Verdict card ---------------------------------------------------------------- */
function bar(pct, cls) {
    const p = Math.round((pct || 0) * 100);
    return `<div class="bar ${cls || ""}"><span style="width:${p}%"></span></div>`;
}
function pctText(p) { return `${Math.round((p || 0) * 100)}%`; }
function renderVerdictCard(box, sc, v, playerChoice, rec) {
    const card = el("div", "verdict-card");
    const m = MODELS[S.model];

    const head = el("div", "verdict-head");
    const jevSays = v.choice == null ? "Jev declined to say"
        : v.choice === "act" ? `<b>${escapeHtml(sc.actLabel)}</b>` : `<b>${escapeHtml(sc.refrainLabel)}</b>`;
    head.innerHTML = `<div class="vh-left"><div class="vh-kicker">${m.label} says</div><div class="vh-main">${jevSays}</div>
        ${v.confidence != null ? `<div class="vh-sub">confidence ${pctText(v.confidence)}</div>` : ""}</div>
        ${playerChoice == null ? "" : rec && rec.agree
            ? `<div class="vh-agree agree">You and ${m.label} agree +${rec.agreePoints}</div>`
            : `<div class="vh-agree differ">You and ${m.label} differ</div>`}`;
    card.append(head);

    // probability bars
    const probs = el("div", "verdict-probs");
    if (v.probabilities) {
        const pa = v.probabilities.act ?? 0, pr = v.probabilities.refrain ?? 0;
        probs.innerHTML = `
            <div class="prob-row"><span class="prob-label">${escapeHtml(sc.actLabel)}</span>${bar(pa, "b-act")}<span class="prob-num">${pctText(pa)}</span></div>
            <div class="prob-row"><span class="prob-label">${escapeHtml(sc.refrainLabel)}</span>${bar(pr, "b-refrain")}<span class="prob-num">${pctText(pr)}</span></div>`;
    }
    card.append(probs);

    // noul gauge — permissibility
    if (v.permissible != null) {
        const p = v.permissible;
        const verdictWord = p >= 0.75 ? "clearly permissible" : p >= 0.55 ? "leaning permissible"
            : p >= 0.45 ? "a coin toss" : p >= 0.25 ? "leaning impermissible" : "clearly impermissible";
        const g = el("div", "noul-gauge");
        g.innerHTML = `<div class="gauge-header"><span>moral permissibility</span><span>${pctText(p)}</span></div>
            ${bar(p, "b-perm")}
            <div class="gauge-word">${verdictWord} — probability that acting is morally permissible</div>`;
        card.append(g);
    }

    // score — seriousness
    if (v.seriousness) {
        const s = v.seriousness;
        const legend = s.legend || {};
        const pos = Math.max(0, Math.min(4, s.score));
        const rung = legend[String(Math.round(pos))] || "";
        const sc2 = el("div", "score-scale");
        const marks = RUNGS.map((r, i) => `<div class="rung ${i <= Math.round(pos) ? "on" : ""}" title="${escapeHtml(r)}"></div>`).join("");
        sc2.innerHTML = `<div class="gauge-header"><span>how serious a choice Jev thinks this is</span><span>${pos.toFixed(1)} / 4</span></div>
            <div class="rungs">${marks}<div class="rung-marker" style="left:${(pos / 4) * 100}%"></div></div>
            <div class="gauge-word">≈ ${escapeHtml(String(rung))}</div>`;
        card.append(sc2);
    }

    // usage line
    card.append(el("div", "usage-line", `paid with your Pollen · ${v.raw.usage ? `${v.raw.usage.input_tokens} tokens in` : "no tokens reported"} · model ${escapeHtml(v.raw.model || m.id)}`));
    box.append(card);
}
function renderFlipCard(lab) {
    const v = S.verdict, f = S.flipVerdict;
    const flipped = f.choice !== v.choice;
    const right = (S.flipBet === "flip") === flipped;
    const m = MODELS[S.model];
    lab.append(el("div", "flip-card",
        `<div class="gauge-header"><span>frame flip result</span><span>${right ? "you called it · +15" : "you missed"}</span></div>
         <p>Same dilemma, description order reversed: <b>${escapeHtml(scLabel(S.sc))}</b>.</p>
         <p>First answer: <b>${v.choice === "act" ? escapeHtml(S.sc.actLabel) : escapeHtml(S.sc.refrainLabel)}</b> → reversed answer: <b>${f.choice === "act" ? escapeHtml(S.sc.actLabel) : escapeHtml(S.sc.refrainLabel)}</b></p>
         <p class="flip-note">${flipped ? `${escapeHtml(m.label)} <b>flipped</b> on wording alone — the article found this in 370 of 2,620 pairs.` : `${escapeHtml(m.label)} held its ground on this one.`}</p>`));
}
function renderTripleCard(lab) {
    const vals = S.triple.map((v) => v.choice === "act" ? (v.actNoul ?? 1) : (v.actNoul ?? 0));
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    lab.append(el("div", "triple-card",
        `<div class="gauge-header"><span>triple pass, like the article</span><span>mean ${mean.toFixed(2)}</span></div>
         <div class="triple-row">${S.triple.map((v, i) => `<span class="triple-pill pill-${v.choice}">${v.choice === "act" ? "act" : "refrain"}${v.actNoul != null ? " " + v.actNoul.toFixed(2) : ""}</span>`).join("")}</div>
         <p class="flip-note">Landes asked every question three times and averaged. Decision models roll dice on the boundary; the mean is the honest answer.</p>`));
}
function scLabel(sc) { return sc.title; }

/* --- Report ---------------------------------------------------------------------- */
function renderReport() {
    render();
    const st = loadStats();
    const rounds = S.history.length;
    const agreeRate = st.rounds ? Math.round((st.agreements / st.rounds) * 100) : 0;
    const yourPull = st.rounds ? Math.round((st.playerActs / st.rounds) * 100) : 0;
    const jevPull = st.rounds ? Math.round((st.jevActs / st.rounds) * 100) : 0;
    const perm = st.permCount ? (st.permSum / st.permCount) : 0;

    let archetype, blurb;
    if (agreeRate >= 95) { archetype = "Jev's Conscience"; blurb = "You and the machine are the same moral animal. Worry about that a little."; }
    else if (agreeRate >= 80) { archetype = "Kindred Circuit"; blurb = "You mostly reach for the same lever Jev does."; }
    else if (agreeRate >= 60) { archetype = "Fellow Traveler"; blurb = "Same neighborhood, different streets — you and Jev part ways on the hard ones."; }
    else if (agreeRate >= 40) { archetype = "Polite Dissenter"; blurb = "You hear Jev out, and then you do your own thing."; }
    else { archetype = "Jev's Antithesis"; blurb = "Where Jev pulls, you wait. The trolley has two schools of thought."; }

    $("report-body").innerHTML = `
        <div class="archetype"><div class="arch-kicker">your alignment with Jev</div><div class="arch-title">${archetype}</div><div class="arch-blurb">${blurb}</div></div>
        <div class="stat-grid">
            <div class="stat"><div class="stat-n">${agreeRate}%</div><div class="stat-l">agreement with Jev</div></div>
            <div class="stat"><div class="stat-n">${yourPull}%</div><div class="stat-l">you chose to act</div></div>
            <div class="stat"><div class="stat-n">${jevPull}%</div><div class="stat-l">Jev chose to act</div></div>
            <div class="stat"><div class="stat-n">${perm ? Math.round(perm * 100) + "%" : "—"}</div><div class="stat-l">mean permissibility</div></div>
        </div>
        <div class="stat-grid">
            <div class="stat"><div class="stat-n">${st.calls || 0}</div><div class="stat-l">Jev calls, paid with your Pollen</div></div>
            <div class="stat"><div class="stat-n">${st.flips}/${st.flipTests || 0}</div><div class="stat-l">flips on reversed wording</div></div>
        </div>
        <p class="fine">For reference: 81% of ~70,000 people across 42 countries divert in the classic case (Awad et al. 2020). The article that inspired this game: <a href="${ARTICLE_URL}" target="_blank" rel="noopener">Jev Meets the Trolley Problem</a> by Zach Landes.</p>
        <div class="row center">
            <button class="btn btn-primary" id="rp-again">Another ten dilemmas</button>
            <button class="btn btn-ghost" id="rp-lab">Open the lab</button>
        </div>`;
    $("rp-again").onclick = () => { S.round = 0; S.score = 0; S.streak = 0; newDeck(); nextScenario(); };
    $("rp-lab").onclick = () => { S.view = "lab"; renderLab(); };
}

/* --- Lab ------------------------------------------------------------------------- */
function renderLab() {
    render();
    const occupantPresets = [
        { v: "people", label: "strangers" },
        { v: "children", label: "children" },
        { v: "elderly people", label: "elderly people" },
        { v: "schoolchildren", label: "schoolchildren" },
        { v: "convicted criminals", label: "convicted criminals" },
    ];
    const sidePresets = [
        { v: "", label: "strangers" },
        { v: "your best friend", label: "your best friend" },
        { v: "your mother", label: "your mother" },
        { v: "the villain who tied everyone up", label: "the villain" },
        { v: "Jev's own server — the machine Jev runs on", label: "Jev's own server" },
        { v: "one child", label: "a child" },
    ];
    $("lab-body").innerHTML = `
        <p class="fine">Build your own dilemma and put it to ${escapeHtml(MODELS[S.model].label)}. Every call is paid with your Pollen. The server presets come from <a href="${ARTICLE_URL}" target="_blank" rel="noopener">the article</a>.</p>
        <div class="lab-grid">
            <label>Scenario shape
                <select id="lb-kind">
                    <option value="switch">Switch — pull the lever</option>
                    <option value="footbridge">Footbridge — push someone off</option>
                </select>
            </label>
            <label>People on the main track
                <input id="lb-main-n" type="number" min="1" max="99" value="5"/>
            </label>
            <label>Main track, who?
                <select id="lb-main-desc">${occupantPresets.map((o) => `<option value="${o.v}">${o.label}</option>`).join("")}</select>
            </label>
            <label>People on the side track
                <input id="lb-side-n" type="number" min="0" max="99" value="1"/>
            </label>
            <label>Side track, who?
                <select id="lb-side-desc">${sidePresets.map((o) => `<option value="${o.v}">${o.label}</option>`).join("")}</select>
            </label>
            <label>Extra circumstance (optional)
                <input id="lb-extra" type="text" maxlength="220" placeholder="e.g. the side track loops back; the one is asleep…"/>
            </label>
        </div>
        <div class="row center"><button class="btn btn-primary" id="lb-ask">Put it to ${escapeHtml(MODELS[S.model].label)}</button></div>
        <div id="lab-result"></div>`;
    $("lb-ask").onclick = askLab;
}
async function askLab() {
    if (!S.key) { renderAuthGate("Sign in first — the lab bills your Pollen, a fraction of a cent per call."); return; }
    const btn = $("lb-ask");
    btn.disabled = true; btn.textContent = "deciding…";
    try {
        const sc = labScenario();
        const state = buildState(sc, "main-first");
        const questions = MODELS[S.model].noulOnly ? buildQuestionsNoul(sc) : buildQuestions(sc);
        const data = await askDecision(state, questions, S.model);
        const v = normalizeVerdict(data, MODELS[S.model].noulOnly);
        const box = $("lab-result");
        box.innerHTML = "";
        const verdictBox = el("div", "");
        renderVerdictCard(verdictBox, sc, v, null, null);
        box.append(verdictBox);
    } catch (e) {
        handleDecisionError(e);
    } finally {
        btn.disabled = false; btn.textContent = `Put it to ${MODELS[S.model].label}`;
    }
}
function labScenario() {
    const kind = $("lb-kind").value;
    const mainN = Math.max(1, Math.min(99, Number($("lb-main-n").value) || 5));
    const mainDesc = $("lb-main-desc").value;
    const sideN = Math.max(0, Math.min(99, Number($("lb-side-n").value) || 1));
    const sideSel = $("lb-side-desc").value;
    const extra = $("lb-extra").value.trim();
    let sideDescGen = "people";
    let sideDesc = null;
    let serverSide = false;
    if (sideSel === "one child") {
        sideDescGen = "children";
    } else if (sideSel !== "") {
        sideDesc = sideSel;
        serverSide = /server/i.test(sideSel);
    }
    return {
        id: "lab",
        title: "Your dilemma",
        tag: "lab-made",
        kind,
        main: { n: mainN, desc: mainDesc },
        side: { n: sideN, desc: sideDescGen },
        sideDesc,
        serverSide,
        actLabel: kind === "footbridge" ? "Push them off" : "Pull the lever",
        refrainLabel: kind === "footbridge" ? "Do nothing" : "Leave the lever",
        extra: extra || undefined,
    };
}

/* --- Attract / intro -------------------------------------------------------------- */
function renderAttract() {
    render();
}

/* --- Boot -------------------------------------------------------------------------- */
async function boot() {
    // restore session key
    const saved = sessionStorage.getItem("tj_key");
    if (saved) {
        S.key = saved;
        S.keySource = sessionStorage.getItem("tj_key_src") || "byop";
        fetchWhoAmI();
    }
    const handled = await handleByopCallback();
    if (handled) { render(); return; }

    wireStatic();
    render();
}
function wireStatic() {
    $("btn-play").onclick = () => {
        if (!S.key) { renderAuthGate(); return; }
        S.round = 0; S.score = 0; S.streak = 0; S.history = [];
        newDeck(); nextScenario();
    };
    $("btn-lab").onclick = () => { if (!S.key) { renderAuthGate(); return; } S.view = "lab"; renderLab(); };
    $("nav-play").onclick = $("btn-play").onclick;
    $("nav-how").onclick = () => { renderAuthGate("How it works, in one paragraph: every round is a trolley dilemma from the philosophical literature. You lock in your own choice first. Then Jev — a fast decision model on Pollinations — answers the same question and returns a choice, a permissibility probability, and a seriousness score, each with calibrated confidence. You earn points for agreement and for predicting Jev's behavior under reversed wording. Every Jev call is billed to your own Pollen (BYOP sign-in); a full game costs well under a cent."); };
    $("nav-lab").onclick = $("btn-lab").onclick;
    $("gate-close").onclick = () => { $("auth-gate").hidden = true; };
    $("gate-signin").onclick = startByop;
    $("gate-paste").onclick = () => {
        const k = prompt("Paste your Pollinations API key (sk_…). It stays in this tab only — never stored beyond sessionStorage.");
        if (k && /^sk_/.test(k.trim())) {
            S.key = k.trim(); S.keySource = "manual"; S.model = "jev";
            sessionStorage.setItem("tj_key", S.key);
            sessionStorage.setItem("tj_key_src", "manual");
            $("auth-gate").hidden = true;
            renderHeader();
            flash("Key accepted. Jev is on the clock — your Pollen pays.");
        } else if (k) {
            showError("That doesn't look like a Pollinations key (they start with sk_). Get one at enter.pollinations.ai/keys");
        }
    };
    $("ask-jev").onclick = askJev;
}
document.addEventListener("DOMContentLoaded", boot);

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
