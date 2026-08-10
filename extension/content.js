(() => {
  const API_BASE =
    (typeof window !== "undefined" && window.VERITAS_API_BASE) ||
    "http://localhost:5000/api";

  const STYLE_ID = "veritas-style";
  const TAG_ATTR = "data-veritas-processed";
  const IG_TAG = "data-veritas-ig-badge";
  const SOCIAL_TAG = "data-veritas-account-badge";

  let reelVideoIdSeq = 0;
  const VIDEO_AI_MAX_BASE64_CHARS = 18_000_000; // ~13MB binary ceiling for extension messaging
  let amazonReviewUid = 0;
  let activeScoreReviewPopover = null;
  let scorePopoverAnchorBadge = null;

  const host =
    typeof location !== "undefined" ? location.hostname.replace(/^www\./, "") : "";

  const isInstagram =
    typeof location !== "undefined" &&
    (location.hostname === "www.instagram.com" || location.hostname === "instagram.com");
  const isX = host === "x.com" || host === "twitter.com";
  const isLinkedIn = host === "linkedin.com";
  const isReddit = host === "reddit.com" || host === "old.reddit.com" || host === "new.reddit.com";

  /** Amazon retail only (not AWS console). Re-check on each call for SPA navigation. */
  function isAmazonRetailHost() {
    if (typeof location === "undefined") return false;
    const h = (location.hostname || "").toLowerCase();
    if (/amazonaws\.com$|aws\.amazon\.com$/i.test(h)) return false;
    return h === "amazon.com" || /\.amazon\./.test(h);
  }

  function isAmazonProductReviewsPage() {
    if (!isAmazonRetailHost()) return false;
    const p = (location.pathname || "").toLowerCase();
    return (
      p.includes("/dp/") ||
      p.includes("/gp/product/") ||
      p.includes("/product-reviews/") ||
      p.includes("/dp/product/")
    );
  }

  /**
   * Extension messaging API (Chrome `chrome`, Firefox `browser`). Do not require `runtime.id` —
   * it is often missing inside iframes / embedded contexts even though `sendMessage` works.
   */
  function extensionRuntime() {
    try {
      const g = typeof globalThis !== "undefined" ? globalThis : typeof window !== "undefined" ? window : null;
      if (!g) return null;
      const rt = g.chrome?.runtime || g.browser?.runtime;
      if (rt && typeof rt.sendMessage === "function") return rt;
    } catch {
      /* ignore */
    }
    return null;
  }

  function getLastRuntimeError() {
    try {
      return globalThis.chrome?.runtime?.lastError || globalThis.browser?.runtime?.lastError;
    } catch {
      return undefined;
    }
  }

  /** After extension reload/update, old content scripts cannot talk to the new background — user must refresh the tab. */
  function formatExtensionMessagingError(raw) {
    const m = String(raw?.message != null ? raw.message : raw || "");
    if (/context invalidated/i.test(m)) {
      return "This tab is still on an old Veritas session (extension was reloaded or updated). Refresh the page (F5).";
    }
    if (/receiving end does not exist|could not establish connection/i.test(m)) {
      return "Veritas background is not reachable. Refresh the page (F5), or reload the extension on chrome://extensions and then refresh this tab.";
    }
    if (/failed to fetch/i.test(m) && /socitea\.onrender\.com/i.test(m)) {
      return m;
    }
    if (/^failed to fetch$/i.test(m.trim())) {
      return (
        "Network request failed (Failed to fetch). " +
        "Check AI on Reels calls https://socitea.onrender.com/chat — " +
        "reload the Veritas extension, refresh this Instagram tab, wait ~20s if Socitea is waking up, then try again."
      );
    }
    return m;
  }

  /**
   * Single path for background `sendMessage` (text analyze + social score).
   * @returns {Promise<object|null>} response object, or `null` if no extension runtime (caller may fall back to fetch).
   */
  function sendMessageToExtension(message) {
    const rt = extensionRuntime();
    if (!rt) return Promise.resolve(null);
    return new Promise((resolve, reject) => {
      try {
        rt.sendMessage(message, (response) => {
          const err = getLastRuntimeError();
          if (err) {
            reject(new Error(formatExtensionMessagingError(err)));
            return;
          }
          resolve(response);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  const IG_RESERVED = new Set([
    "p",
    "reel",
    "reels",
    "explore",
    "stories",
    "accounts",
    "legal",
    "about",
    "developer",
    "direct",
    "tv",
  ]);

  function injectStyleOnce() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      .veritas-card {
        margin-top: 10px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(18,18,18,0.92);
        border-radius: 14px;
        padding: 10px 12px;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        color: #E5E7EB;
      }
      .veritas-card.veritas-card--x-hidden {
        display: none;
      }
      .veritas-row { display:flex; align-items:center; justify-content:space-between; gap:10px; flex-wrap:wrap; }
      .veritas-badge {
        display:inline-flex; align-items:center; gap:8px;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        border: 1px solid rgba(233,30,99,0.35);
        background: rgba(233,30,99,0.12);
        color: #FBCFE8;
      }
      .veritas-pill {
        display:inline-flex;
        border-radius: 999px;
        padding: 4px 10px;
        font-size: 12px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        color: #D1D5DB;
      }
      .veritas-score { font-weight: 700; }
      .veritas-insight {
        margin-top: 8px;
        font-size: 12px;
        line-height: 1.35;
        color: #D1D5DB;
      }
      .veritas-insight b { color: #FBCFE8; }
      .veritas-warn { color: #FCA5A5; }
      .veritas-ok { color: #86EFAC; }

      /* Check AI (vision) toolbar + result */
      .veritas-post-toolbar {
        margin-top: 8px;
        clear: both;
      }
      .veritas-check-ai-row {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
      .veritas-check-ai-btn {
        appearance: none;
        border: 1px solid rgba(233, 30, 99, 0.45);
        background: linear-gradient(180deg, rgba(233, 30, 99, 0.25), rgba(233, 30, 99, 0.12));
        color: #fce7f3;
        font-size: 12px;
        font-weight: 700;
        padding: 6px 12px;
        border-radius: 999px;
        cursor: pointer;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      }
      .veritas-check-ai-btn:hover:not(:disabled) {
        background: rgba(233, 30, 99, 0.35);
      }
      .veritas-check-ai-btn:disabled {
        opacity: 0.55;
        cursor: wait;
      }
      .veritas-check-ai-btn--real {
        border-color: rgba(34, 197, 94, 0.55) !important;
        background: rgba(34, 197, 94, 0.14) !important;
        color: transparent;
        padding: 6px 10px;
        min-width: 38px;
        min-height: 32px;
      }
      .veritas-check-ai-btn--ai {
        border-color: rgba(239, 68, 68, 0.6) !important;
        background: rgba(239, 68, 68, 0.14) !important;
        color: transparent;
        padding: 6px 10px;
        min-width: 38px;
        min-height: 32px;
      }
      .veritas-check-ai-btn--real:hover:not(:disabled),
      .veritas-check-ai-btn--ai:hover:not(:disabled) {
        filter: brightness(1.08);
      }
      .veritas-check-ai-ic {
        display: block;
        margin: 0 auto;
      }

      /* X/Twitter: text-only AI vs human hint (no vision / no image capture) */
      .veritas-x-text-origin-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 6px;
        min-height: 28px;
      }
      .veritas-x-text-origin {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 32px;
        border-radius: 10px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(0, 0, 0, 0.35);
        box-sizing: border-box;
      }
      .veritas-x-text-origin--loading {
        border-color: rgba(161, 161, 170, 0.5);
        color: #a1a1aa;
        font-size: 14px;
        font-weight: 700;
        letter-spacing: 1px;
        animation: veritas-x-origin-pulse 1s ease-in-out infinite;
      }
      @keyframes veritas-x-origin-pulse {
        50% { opacity: 0.45; }
      }
      .veritas-x-text-origin--human {
        border-color: rgba(74, 222, 128, 0.55);
        background: rgba(34, 197, 94, 0.12);
      }
      .veritas-x-text-origin--ai {
        border-color: rgba(248, 113, 113, 0.55);
        background: rgba(239, 68, 68, 0.12);
      }
      .veritas-x-text-origin--err {
        border-color: rgba(161, 161, 170, 0.45);
        background: rgba(63, 63, 70, 0.35);
        color: #a1a1aa;
        font-size: 11px;
        font-weight: 600;
        width: auto;
        padding: 0 8px;
      }
      .veritas-x-text-origin svg {
        display: block;
      }
      button.veritas-x-text-origin {
        cursor: pointer;
        font: inherit;
        margin: 0;
      }
      button.veritas-x-text-origin:focus-visible {
        outline: 2px solid rgba(96, 165, 250, 0.85);
        outline-offset: 2px;
      }

      .veritas-check-ai-panel {
        margin-top: 8px;
      }
      .veritas-check-ai-card {
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(12, 12, 14, 0.95);
        border-radius: 12px;
        padding: 10px 12px;
        font-size: 12px;
        line-height: 1.4;
        color: #e5e7eb;
        max-width: 100%;
        box-sizing: border-box;
      }
      .veritas-check-ai-card--loading {
        color: #d1d5db;
        font-style: italic;
      }
      .veritas-check-ai-card--err {
        color: #fecaca;
        border-color: rgba(248, 113, 113, 0.45);
      }
      .veritas-check-ai-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      .veritas-check-ai-title {
        font-weight: 800;
        letter-spacing: 0.02em;
        color: #fbcfe8;
        font-size: 11px;
        text-transform: uppercase;
      }
      .veritas-check-ai-verdict {
        font-weight: 800;
        font-size: 13px;
        padding: 2px 10px;
        border-radius: 999px;
      }
      .veritas-check-ai-verdict--real {
        background: rgba(34, 197, 94, 0.2);
        color: #bbf7d0;
        border: 1px solid rgba(34, 197, 94, 0.45);
      }
      .veritas-check-ai-verdict--ai {
        background: rgba(244, 63, 94, 0.18);
        color: #fecdd3;
        border: 1px solid rgba(244, 63, 94, 0.5);
      }
      .veritas-check-ai-meter {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        font-size: 11px;
        color: #9ca3af;
        margin-bottom: 4px;
      }
      .veritas-check-ai-meter strong {
        color: #f9fafb;
        font-size: 18px;
      }
      .veritas-check-ai-bar {
        height: 6px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.08);
        overflow: hidden;
        margin-bottom: 8px;
      }
      .veritas-check-ai-bar > span {
        display: block;
        height: 100%;
        border-radius: 999px;
        background: linear-gradient(90deg, #f472b6, #e11d48);
      }
      .veritas-check-ai-expl {
        margin: 0;
        color: #d1d5db;
        font-size: 12px;
      }
      /* Instagram Reels: fixed portal on document.body (above IG pause/play layer) */
      .veritas-ig-reel-overlay {
        position: fixed;
        z-index: 2147483646;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 8px;
        max-width: min(340px, calc(100vw - 16px));
        pointer-events: none;
        isolation: isolate;
      }
      .veritas-ig-reel-overlay .veritas-check-ai-panel,
      .veritas-ig-reel-overlay .veritas-check-ai-row,
      .veritas-ig-reel-overlay .veritas-check-ai-btn {
        pointer-events: auto;
      }
      .veritas-ig-reel-overlay .veritas-check-ai-panel {
        margin-top: 0;
        width: 100%;
      }
      .veritas-ig-reel-overlay .veritas-check-ai-row {
        position: relative;
        z-index: 2;
      }
      .veritas-ig-reel-overlay .veritas-check-ai-btn {
        position: relative;
        z-index: 3;
        box-shadow: 0 2px 14px rgba(0, 0, 0, 0.55);
        backdrop-filter: blur(6px);
        cursor: pointer;
        touch-action: manipulation;
        -webkit-user-select: none;
        user-select: none;
      }

      /* Amazon-only: review trust dock */
      .veritas-amazon-dock {
        position: fixed;
        bottom: 20px;
        right: 20px;
        z-index: 2147483640;
        max-width: min(400px, calc(100vw - 28px));
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
      }
      .veritas-amazon-dock-inner {
        background: #fffefb;
        border: 1px solid rgba(124, 58, 237, 0.28);
        border-radius: 16px;
        padding: 12px 14px;
        box-shadow: 0 12px 36px rgba(15, 23, 42, 0.18);
        color: #1f2937;
      }
      .veritas-amazon-dock-title {
        font-size: 11px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #6b21a8;
        margin-bottom: 8px;
      }
      .veritas-amazon-dock-btn {
        appearance: none;
        width: 100%;
        border: 1px solid rgba(124, 58, 237, 0.45);
        background: linear-gradient(180deg, rgba(124, 58, 237, 0.12), rgba(124, 58, 237, 0.06));
        color: #4c1d95;
        font-size: 13px;
        font-weight: 700;
        padding: 10px 12px;
        border-radius: 12px;
        cursor: pointer;
      }
      .veritas-amazon-dock-btn:hover:not(:disabled) {
        background: rgba(124, 58, 237, 0.16);
      }
      .veritas-amazon-dock-btn:disabled {
        opacity: 0.55;
        cursor: wait;
      }
      .veritas-amazon-dock-panel {
        margin-top: 10px;
        font-size: 12px;
        line-height: 1.45;
      }
      .veritas-amazon-loading {
        color: #6b7280;
        font-style: italic;
      }
      .veritas-amazon-err {
        color: #b91c1c;
      }
      .veritas-amazon-result {
        border-top: 1px solid rgba(0, 0, 0, 0.08);
        padding-top: 10px;
      }
      .veritas-amazon-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      .veritas-amazon-score {
        font-size: 28px;
        font-weight: 800;
        color: #0f172a;
      }
      .veritas-amazon-verdict {
        font-size: 12px;
        font-weight: 800;
        padding: 4px 10px;
        border-radius: 999px;
        background: #ede9fe;
        color: #5b21b6;
      }
      .veritas-amazon-summary {
        margin: 0 0 8px;
        color: #374151;
      }
      .veritas-amazon-issues {
        margin: 0;
        padding-left: 18px;
        color: #4b5563;
      }

      /* Per-review credibility next to reviewer name (Amazon only) */
      .veritas-amazon-inline-score {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 1.75rem;
        margin-left: 8px;
        padding: 1px 7px;
        border-radius: 999px;
        font-size: 11px;
        font-weight: 800;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        vertical-align: middle;
        line-height: 1.35;
        border: 1px solid rgba(0, 0, 0, 0.12);
        background: #f3f4f6;
        color: #111827;
      }
      .veritas-amazon-inline-score--loading {
        opacity: 0.65;
        font-weight: 700;
      }
      .veritas-amazon-inline-score--high {
        border-color: rgba(21, 128, 61, 0.45);
        background: #dcfce7;
        color: #14532d;
      }
      .veritas-amazon-inline-score--mid {
        border-color: rgba(161, 98, 7, 0.45);
        background: #fef9c3;
        color: #713f12;
      }
      .veritas-amazon-inline-score--low {
        border-color: rgba(185, 28, 28, 0.45);
        background: #fee2e2;
        color: #7f1d1d;
      }
      .veritas-amazon-inline-score--err {
        border-color: rgba(185, 28, 28, 0.5);
        background: #fff1f2;
        color: #9f1239;
      }

      /* Fact check: Veritas logo (top-right of each post) + popover */
      .veritas-fc-anchor {
        position: absolute;
        top: 6px;
        right: 8px;
        z-index: 2147483630;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 6px;
        pointer-events: none;
      }
      /* X/Twitter: AI tick + fact-check — compact (match ~Grok inline size), inset so Grok/native rail stay visible */
      .veritas-fc-anchor.veritas-fc-anchor--x-actions {
        flex-direction: row;
        flex-wrap: wrap;
        align-items: center;
        justify-content: flex-end;
        align-content: flex-start;
        gap: 6px;
        right: 64px;
      }
      .veritas-fc-anchor.veritas-fc-anchor--x-actions .veritas-fc-popover {
        flex: 0 0 100%;
        width: min(340px, calc(100vw - 20px));
        max-width: calc(100vw - 20px);
      }
      .veritas-fc-anchor.veritas-fc-anchor--x-actions .veritas-x-text-origin-row {
        margin-bottom: 0;
      }
      .veritas-fc-anchor.veritas-fc-anchor--x-actions .veritas-fc-logo-btn {
        padding: 0;
        width: 30px;
        height: 30px;
        min-width: 30px;
        min-height: 30px;
        border-radius: 999px;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-shadow: 0 1px 6px rgba(0, 0, 0, 0.28);
      }
      .veritas-fc-anchor.veritas-fc-anchor--x-actions .veritas-fc-logo-btn:hover:not(:disabled) {
        transform: none;
      }
      .veritas-fc-anchor.veritas-fc-anchor--x-actions .veritas-fc-svg {
        width: 18px;
        height: 20px;
      }
      .veritas-fc-anchor.veritas-fc-anchor--x-actions .veritas-x-text-origin {
        width: 30px;
        height: 30px;
        min-width: 30px;
        min-height: 30px;
        border-radius: 999px;
        padding: 0;
      }
      .veritas-fc-anchor.veritas-fc-anchor--x-actions .veritas-x-text-origin svg {
        width: 18px;
        height: 18px;
      }
      .veritas-fc-anchor.veritas-fc-anchor--x-actions .veritas-x-text-origin--err {
        width: 30px;
        min-width: 30px;
        padding: 0;
        font-size: 13px;
      }
      .veritas-fc-anchor > * {
        pointer-events: auto;
      }
      .veritas-fc-logo-btn {
        appearance: none;
        padding: 5px 6px;
        margin: 0;
        border-radius: 12px;
        cursor: pointer;
        line-height: 0;
        background: rgba(15, 23, 42, 0.72);
        border: 1px solid rgba(168, 85, 247, 0.4);
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
      }
      .veritas-fc-logo-btn:hover:not(:disabled) {
        background: rgba(30, 41, 59, 0.95);
        border-color: rgba(56, 189, 248, 0.55);
        transform: scale(1.06);
      }
      .veritas-fc-logo-btn:disabled {
        opacity: 0.55;
        cursor: wait;
      }
      .veritas-fc-svg {
        display: block;
        width: 26px;
        height: 28px;
      }
      .veritas-fc-popover {
        display: none;
        width: min(340px, calc(100vw - 20px));
        max-height: min(420px, 70vh);
        overflow-y: auto;
        background: rgba(15, 23, 42, 0.98);
        border: 1px solid rgba(56, 189, 248, 0.38);
        border-radius: 14px;
        padding: 10px 12px;
        box-shadow: 0 14px 40px rgba(0, 0, 0, 0.5);
        font-size: 12px;
        line-height: 1.45;
        color: #e2e8f0;
      }
      .veritas-fc-popover.veritas-fc-popover--open {
        display: block;
      }
      .veritas-fc-topbar {
        display: flex;
        align-items: center;
        margin: -2px 0 8px;
      }
      .veritas-fc-back-btn {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 4px 8px;
        margin: 0 0 0 -4px;
        border: none;
        border-radius: 8px;
        background: transparent;
        color: #94a3b8;
        font-size: 12px;
        font-weight: 600;
        font-family: inherit;
        cursor: pointer;
      }
      .veritas-fc-back-btn:hover {
        color: #e2e8f0;
        background: rgba(255, 255, 255, 0.06);
      }
      .veritas-fc-back-btn:focus-visible {
        outline: 2px solid #38bdf8;
        outline-offset: 1px;
      }
      .veritas-factcheck-nature {
        font-size: 10px;
        font-weight: 800;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #a5b4fc;
        margin-bottom: 6px;
      }
      .veritas-factcheck-claim {
        color: #e0f2fe;
        font-weight: 500;
        margin-bottom: 8px;
        line-height: 1.4;
      }
      .veritas-factcheck-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 8px;
      }
      .veritas-factcheck-score {
        font-size: 26px;
        font-weight: 800;
        color: #f8fafc;
      }
      .veritas-factcheck-verdict {
        font-size: 11px;
        font-weight: 800;
        padding: 4px 10px;
        border-radius: 999px;
        background: rgba(51, 65, 85, 0.9);
        color: #e2e8f0;
      }
      .veritas-factcheck-expl {
        margin: 0 0 8px;
        color: #cbd5e1;
      }
      .veritas-factcheck-sources {
        font-size: 10px;
        color: #94a3b8;
        margin-bottom: 6px;
      }
      .veritas-factcheck-links a {
        color: #7dd3fc;
        display: block;
        margin-top: 4px;
        word-break: break-all;
      }
      .veritas-factcheck-err {
        color: #fecaca;
      }
      .veritas-factcheck-loading {
        color: #94a3b8;
        font-style: italic;
      }

      /* Account authenticity pill (Instagram, X, LinkedIn, Reddit, …) */
      .veritas-ig-realness {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 2rem;
        margin-left: 6px;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 700;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        vertical-align: middle;
        border: 1px solid rgba(255,255,255,0.2);
        background: rgba(0,0,0,0.45);
        color: #fff;
        box-shadow: 0 2px 10px rgba(0,0,0,0.25);
      }
      .veritas-ig-realness--high {
        border-color: rgba(34,197,94,0.55);
        background: rgba(34,197,94,0.2);
        color: #bbf7d0;
      }
      .veritas-ig-realness--mid {
        border-color: rgba(250,204,21,0.55);
        background: rgba(250,204,21,0.15);
        color: #fef08a;
      }
      .veritas-ig-realness--low {
        border-color: rgba(244,63,94,0.55);
        background: rgba(244,63,94,0.18);
        color: #fecdd3;
      }
      .veritas-ig-realness--loading {
        opacity: 0.75;
        font-weight: 600;
      }
      /* Stay on the same line as the username (Reels often stacks block siblings above Follow). */
      .veritas-ig-realness--next-to-handle {
        flex-shrink: 0;
        margin-left: 8px;
        margin-right: 4px;
        vertical-align: middle;
      }

      /* LinkedIn default UI is light gray/white — translucent pills are illegible. */
      .veritas-account-badge--linkedin.veritas-ig-realness {
        box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08), 0 0 0 1px rgba(0, 0, 0, 0.06);
        display: inline-flex !important;
        flex-shrink: 0;
        align-self: center;
        vertical-align: middle;
        margin-left: 0 !important;
        margin-right: 0 !important;
        position: static !important;
        z-index: auto !important;
        float: none !important;
        inset: auto !important;
      }
      [data-veritas-li-name-wrap="1"] {
        display: inline-flex !important;
        align-items: center !important;
        flex-wrap: nowrap !important;
        gap: 8px !important;
        vertical-align: middle !important;
        max-width: 100%;
        position: static !important;
      }
      div[data-veritas-li-name-wrap="1"] {
        display: flex !important;
        flex-wrap: wrap !important;
        align-items: center !important;
      }
      .veritas-account-badge--linkedin.veritas-ig-realness--loading {
        background: #e5e7eb !important;
        border: 1px solid #6b7280 !important;
        color: #1f2937 !important;
        opacity: 1;
      }
      .veritas-account-badge--linkedin.veritas-ig-realness--high {
        background: #bbf7d0 !important;
        border: 1px solid #15803d !important;
        color: #14532d !important;
      }
      .veritas-account-badge--linkedin.veritas-ig-realness--mid {
        background: #fef08a !important;
        border: 1px solid #a16207 !important;
        color: #713f12 !important;
      }
      .veritas-account-badge--linkedin.veritas-ig-realness--low {
        background: #fecaca !important;
        border: 1px solid #b91c1c !important;
        color: #7f1d1d !important;
      }

      /* X / Twitter: same authenticity pill system as Instagram (tier colors from .veritas-ig-realness--*). */
      .veritas-account-badge--x.veritas-ig-realness {
        box-sizing: border-box;
        position: relative;
        z-index: 2147483646;
        display: inline-flex;
        flex-shrink: 0;
        align-self: center;
        min-width: 2rem;
        padding: 2px 8px;
        margin-left: 4px;
        margin-right: 4px;
        font-size: 12px;
        line-height: 1.25;
        font-weight: 700;
        border-radius: 999px;
        vertical-align: middle;
        box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
      }
      .veritas-account-badge--x.veritas-ig-realness--loading {
        opacity: 0.75;
        font-weight: 600;
      }

      /* Account score: Community Notes–style review (left-click badge) */
      .veritas-ig-realness[data-veritas-score-interactive="1"] {
        cursor: pointer;
      }
      .veritas-account-score-popover {
        position: fixed;
        z-index: 2147483647;
        min-width: 220px;
        max-width: min(300px, calc(100vw - 24px));
        padding: 12px 14px;
        border-radius: 12px;
        border: 1px solid rgba(255, 255, 255, 0.14);
        background: rgba(22, 22, 26, 0.98);
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        font-size: 12px;
        color: #e5e7eb;
        line-height: 1.4;
        box-sizing: border-box;
      }
      .veritas-account-score-popover__hint {
        font-size: 11px;
        color: #9ca3af;
        margin-bottom: 10px;
      }
      .veritas-account-score-popover__row {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .veritas-account-score-popover button[type="button"] {
        flex: 1;
        min-width: 100px;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
        border: 1px solid rgba(255, 255, 255, 0.12);
        background: rgba(255, 255, 255, 0.08);
        color: #f3f4f6;
        font-family: inherit;
      }
      .veritas-account-score-popover button[data-veritas-review="helpful"] {
        border-color: rgba(52, 211, 153, 0.5);
        background: rgba(16, 185, 129, 0.15);
        color: #a7f3d0;
      }
      .veritas-account-score-popover button[data-veritas-review="wrong"] {
        border-color: rgba(248, 113, 113, 0.5);
        background: rgba(239, 68, 68, 0.15);
        color: #fecaca;
      }
      .veritas-account-score-popover button[type="button"]:hover {
        filter: brightness(1.09);
      }
    `;
    document.documentElement.appendChild(style);
  }

  function clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  function tone(score) {
    if (score >= 70) return "ok";
    if (score >= 45) return "mid";
    return "bad";
  }

  function instagramHandleFromHref(href) {
    if (!href || href === "#" || href.startsWith("javascript:")) return null;
    try {
      const base = "https://www.instagram.com";
      const u = href.startsWith("http") ? new URL(href) : new URL(href, base);
      const host = u.hostname.replace(/^www\./, "");
      if (!host.endsWith("instagram.com")) return null;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length === 0) return null;
      const first = parts[0];
      if (IG_RESERVED.has(first.toLowerCase())) return null;
      if (!/^[a-zA-Z0-9._]+$/.test(first)) return null;
      return first;
    } catch {
      return null;
    }
  }

  const X_RESERVED = new Set([
    "home",
    "explore",
    "notifications",
    "messages",
    "settings",
    "search",
    "compose",
    "login",
    "signup",
    "i",
    "intent",
    "account",
    "privacy",
    "help",
    "tos",
    "following",
    "followers",
    "verified_followers",
    "hashtag",
    "lists",
    "communities",
    "topics",
    "share",
    "oauth",
    "download",
    "who_to_follow",
    "connect_redir",
    "hashtag_click",
    "search-advanced",
    "your_tweet_analytics",
  ]);

  const LI_RESERVED = new Set([
    "feed",
    "jobs",
    "company",
    "school",
    "pulse",
    "notifications",
    "messaging",
    "learning",
    "sales",
    "groups",
    "events",
  ]);

  const REDDIT_USER_BAD = new Set([
    "message",
    "compose",
    "submit",
    "about",
    "login",
    "logout",
    "me",
    "null",
  ]);

  function xHandleFromHref(href) {
    if (!href || href === "#" || href.startsWith("javascript:")) return null;
    try {
      const u = href.startsWith("http") ? new URL(href) : new URL(href, "https://x.com");
      const h = u.hostname.replace(/^www\./, "");
      if (h !== "x.com" && h !== "twitter.com") return null;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length < 1) return null;
      const seg = parts[0];
      if (X_RESERVED.has(seg.toLowerCase())) return null;
      if (!/^[a-zA-Z0-9_]{1,30}$/.test(seg)) return null;
      return `x:${seg}`;
    } catch {
      return null;
    }
  }

  /** /handle/followers, /handle/following, etc. — same handle as profile; badge looked wrong under follower counts. */
  function isXProfileFollowersOrFollowingHref(href) {
    if (!href || href === "#" || href.startsWith("javascript:")) return false;
    try {
      const u = href.startsWith("http") ? new URL(href) : new URL(href, "https://x.com");
      const h = u.hostname.replace(/^www\./, "");
      if (h !== "x.com" && h !== "twitter.com") return false;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return false;
      const seg = parts[1].toLowerCase();
      return (
        seg === "followers" ||
        seg === "following" ||
        seg === "verified_followers" ||
        seg === "verified_followings" ||
        seg === "followers_you_know"
      );
    } catch {
      return false;
    }
  }

  /** Skip ⋮ / dropdown <a> (often portaled to #layers, outside #react-root). Do not treat all of #layers as overlay. */
  function isXEphemeralOverlayUI(a) {
    if (a.closest('[role="menu"]')) return true;
    if (a.closest('[role="listbox"]')) return true;
    const layers = document.getElementById("layers");
    const root = document.getElementById("react-root");
    if (layers && layers.contains(a) && root && !root.contains(a)) return true;
    return false;
  }

  /**
   * Tweet: prefer links inside User-Name / UserName. If X changes test ids, accept profile links
   * in the header band above tweet text / cards (same row as display name @handle).
   * Elsewhere (nav, profile chrome, who-to-follow): allow.
   */
  function shouldAttachXAccountBadge(a) {
    if (isXEphemeralOverlayUI(a)) return false;
    const tweet = a.closest('[data-testid="tweet"]');
    if (!tweet) return true;

    if (
      a.closest('[data-testid="User-Name"]') ||
      a.closest('[data-testid="UserName"]') ||
      a.closest('[data-testid="User-Names"]')
    ) {
      return true;
    }

    if (!xHandleFromHref(a.getAttribute("href") || "")) return false;

    const rb = a.getBoundingClientRect();
    if (rb.width < 2 || rb.height < 2) return false;

    const scope = a.closest('[data-testid="QuoteTweet"]') || tweet;
    const textBlock = scope.querySelector('[data-testid="tweetText"]');
    if (textBlock) {
      const tr = textBlock.getBoundingClientRect();
      if (rb.top > tr.top - 2) return false;
    }
    const card = scope.querySelector('[data-testid="card.wrapper"]');
    if (card) {
      const cr = card.getBoundingClientRect();
      if (rb.top > cr.top - 6) return false;
    }

    return true;
  }

  function xTweetAlreadyBadgedForUser(tweet, scoreKey) {
    const raw = tweet.getAttribute("data-veritas-x-badged-users") || "";
    return raw.split(",").filter(Boolean).includes(scoreKey);
  }

  function xTweetMarkBadgedForUser(tweet, scoreKey) {
    const parts = (tweet.getAttribute("data-veritas-x-badged-users") || "").split(",").filter(Boolean);
    if (!parts.includes(scoreKey)) parts.push(scoreKey);
    tweet.setAttribute("data-veritas-x-badged-users", parts.join(","));
  }

  /** Display-name link inside User-Name (not the @handle link). */
  function findXDisplayNameLink(anchor) {
    const root =
      anchor.closest('[data-testid="User-Name"], [data-testid="UserName"], [data-testid="User-Names"]') ||
      anchor.parentElement;
    if (!root) return anchor;
    const links = Array.from(
      root.querySelectorAll('a[href^="/"], a[href*="x.com/"], a[href*="twitter.com/"]')
    );
    const display = links.find((l) => {
      if (isLikelyGenericAvatarLink(l)) return false;
      if (!xHandleFromHref(l.getAttribute("href") || "")) return false;
      const t = (l.textContent || "").replace(/\s+/g, " ").trim();
      return t.length > 0 && !t.startsWith("@");
    });
    return display || anchor;
  }

  /** Blue verified tick near the display name. */
  function findXVerifiedTickNear(displayLink) {
    const root =
      displayLink.closest('[data-testid="User-Name"], [data-testid="UserName"], [data-testid="User-Names"]') ||
      displayLink.parentElement;
    if (!root) return null;
    const svg =
      root.querySelector('svg[aria-label*="Verified" i]') ||
      root.querySelector('[aria-label*="Verified account" i]') ||
      root.querySelector('[data-testid="icon-verified"]');
    if (!svg) return null;
    // Prefer the immediate wrapper X uses around the tick so layout stays inline.
    let node = svg;
    while (node && node.parentElement && node.parentElement !== root) {
      const p = node.parentElement;
      if (p === displayLink || displayLink.contains(p)) break;
      if (p.children.length <= 3) node = p;
      else break;
    }
    return node;
  }

  /** Shared flex/inline row that holds display name + blue tick. */
  function findXNameTickRow(displayLink, tick) {
    if (!displayLink) return null;
    if (tick) {
      let a = displayLink.parentElement;
      while (a) {
        if (a.contains(tick) && a !== tick) {
          const style = window.getComputedStyle(a);
          const dir = style.flexDirection || "";
          // Prefer a horizontal row, not the column that stacks name above @handle.
          if (style.display.includes("flex") && dir.startsWith("column")) {
            a = a.parentElement;
            continue;
          }
          return a;
        }
        a = a.parentElement;
      }
    }
    return displayLink.parentElement;
  }

  /**
   * Place X score on the same line as the name — after the blue tick when present:
   *   daksh.  ✓  [61]  @handle
   * Falls back to after the display name (still inline), never a new row below.
   */
  function placeXScoreBetweenNameAndTick(badge, anchor) {
    const displayLink = findXDisplayNameLink(anchor);
    const tick = findXVerifiedTickNear(displayLink);
    const row = findXNameTickRow(displayLink, tick);

    badge.classList.add("veritas-ig-realness--next-to-handle");
    badge.style.display = "inline-flex";
    badge.style.flexShrink = "0";
    badge.style.alignSelf = "center";
    badge.style.verticalAlign = "middle";
    badge.style.marginLeft = "4px";
    badge.style.marginRight = "4px";

    if (tick && tick.parentNode) {
      // After blue tick, same row.
      if (tick.nextSibling) tick.parentNode.insertBefore(badge, tick.nextSibling);
      else tick.parentNode.appendChild(badge);
      return displayLink;
    }

    if (row && displayLink.parentNode === row) {
      if (displayLink.nextSibling) row.insertBefore(badge, displayLink.nextSibling);
      else row.appendChild(badge);
      return displayLink;
    }

    displayLink.insertAdjacentElement("afterend", badge);
    return displayLink;
  }

  /** X sometimes nests links inside open shadow roots — normal querySelector misses them. */
  function collectAnchorsDeep(root, selector, acc, seen) {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll(selector).forEach((el) => {
      if (!seen.has(el)) {
        seen.add(el);
        acc.push(el);
      }
    });
    root.querySelectorAll("*").forEach((el) => {
      if (el.shadowRoot) collectAnchorsDeep(el.shadowRoot, selector, acc, seen);
    });
  }

  function linkedinVanityFromHref(href) {
    if (!href || href === "#" || href.startsWith("javascript:")) return null;
    try {
      const u = href.startsWith("http") ? new URL(href) : new URL(href, "https://www.linkedin.com");
      const h = u.hostname.replace(/^www\./, "");
      if (!h.endsWith("linkedin.com")) return null;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts[0] !== "in" || !parts[1]) return null;
      const v = parts[1];
      if (LI_RESERVED.has(v.toLowerCase())) return null;
      if (!/^[a-zA-Z0-9\-_%]{2,120}$/.test(v)) return null;
      return `li:${decodeURIComponent(v)}`;
    } catch {
      return null;
    }
  }

  function redditUserFromHref(href) {
    if (!href || href === "#" || href.startsWith("javascript:")) return null;
    try {
      const u = href.startsWith("http") ? new URL(href) : new URL(href, "https://www.reddit.com");
      const h = u.hostname.replace(/^www\./, "");
      if (h !== "reddit.com" && h !== "old.reddit.com" && h !== "new.reddit.com") return null;
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      const kind = parts[0].toLowerCase();
      if (kind !== "user" && kind !== "u") return null;
      const name = parts[1];
      if (!name || REDDIT_USER_BAD.has(name.toLowerCase())) return null;
      if (!/^[a-zA-Z0-9_-]{2,40}$/.test(name)) return null;
      return `reddit:${decodeURIComponent(name)}`;
    } catch {
      return null;
    }
  }

  const accountScoreCache = new Map();

  /** Fixed authenticity scores for partner / demo accounts (everywhere). */
  const PINNED_ACCOUNT_SCORES = {
    geekroom__: 100,
    "talk.with.adarsh": 92,
    namanbansal013: 94,
    "li:anindita-bhowmick-387449395": 88,
    "li:adarsh-chauhan-b87609225": 91,
    "li:namanbansal013": 95,
  };

  function normalizeScoreHandle(scoreKey) {
    return String(scoreKey || "")
      .trim()
      .replace(/^@+/, "")
      .toLowerCase();
  }

  function pinnedAccountScore(scoreKey) {
    const k = normalizeScoreHandle(scoreKey);
    return Object.prototype.hasOwnProperty.call(PINNED_ACCOUNT_SCORES, k)
      ? PINNED_ACCOUNT_SCORES[k]
      : null;
  }

  /** Same algorithm as backend `mockRealness` — used when API is blocked (HTTPS → HTTP localhost). */
  function localMockRealness(handle) {
    const pinned = pinnedAccountScore(handle);
    if (pinned != null) return pinned;
    let h = 0;
    const s = String(handle);
    for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    return Math.abs(h) % 101;
  }

  function resolveDisplayedAccountScore(scoreKey, rawScore, anchor) {
    const pinned = pinnedAccountScore(scoreKey);
    if (pinned != null) return { score: pinned, boosted: false, pinned: true };
    return { ...applyVerifiedAccountBonus(rawScore, anchor), pinned: false };
  }

  /**
   * Instagram runs on https:// — direct fetch to http://localhost is blocked (mixed content).
   * Prefer the service worker (background.js): trust API for registered users, else FastAPI /detect (XGBoost).
   * On plain http pages (e.g. mock feed), direct fetch still works as a fallback.
   */
  async function fetchAccountScore(scoreKey) {
    const pinned = pinnedAccountScore(scoreKey);
    if (pinned != null) {
      const p = Promise.resolve({
        realnessScore: pinned,
        source: "veritas-override",
        bot_probability: 0,
      });
      accountScoreCache.set(scoreKey, p);
      return p;
    }

    if (accountScoreCache.has(scoreKey)) return accountScoreCache.get(scoreKey);
    const p = (async () => {
      try {
        const bg = await sendMessageToExtension({ type: "VERITAS_SOCIAL_SCORE", handle: scoreKey });
        if (bg && bg.ok === true && typeof bg.score === "number") {
          return {
            realnessScore: bg.score,
            source: bg.source || "extension-bg",
            bot_probability: typeof bg.bot_probability === "number" ? bg.bot_probability : undefined,
          };
        }
      } catch {
        // fall through to direct fetch / mock
      }

      try {
        const ctrl = new AbortController();
        const tid = setTimeout(() => ctrl.abort(), 3000);
        const resp = await fetch(`${API_BASE}/instagram/trust/${encodeURIComponent(scoreKey)}`, {
          signal: ctrl.signal,
        });
        clearTimeout(tid);
        if (!resp.ok) throw new Error(String(resp.status));
        const data = await resp.json();
        return {
          realnessScore: Number(data.realnessScore),
          source: data.source || "api",
          bot_probability: typeof data.botScore === "number" ? Number(data.botScore) : undefined,
        };
      } catch {
        return {
          realnessScore: localMockRealness(scoreKey),
          source: "local",
        };
      }
    })();
    accountScoreCache.set(scoreKey, p);
    return p;
  }

  function isInstagramReelSurface() {
    const p = (location.pathname || "").toLowerCase();
    return p.includes("/reel/") || p.startsWith("/reels");
  }

  /** Profile avatar links are usually image-only; badge should attach to the text username link. */
  function isLikelyInstagramAvatarLink(a) {
    if (!a || !a.querySelector("img")) return false;
    const text = (a.textContent || "").replace(/\s+/g, "").trim();
    if (text.length > 0) return false;
    const r = a.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) return false;
    if (Math.abs(r.width - r.height) > 8) return false;
    if (r.width > 80) return false;
    return true;
  }

  const isLikelyGenericAvatarLink = isLikelyInstagramAvatarLink;

  const VERIFIED_NEAR_SELECTORS = [
    'svg[aria-label*="Verified" i]',
    '[aria-label*="Verified account" i]',
    '[aria-label*="Verified profile" i]',
    '[data-testid="icon-verified"]',
    '[data-testid*="verified" i]',
    'span[title*="Verified" i]',
  ].join(", ");

  function hasVerifiedBadgeNearAnchor(anchor) {
    if (!anchor || !anchor.isConnected) return false;
    let node = anchor;
    for (let d = 0; d < 14 && node; d++) {
      try {
        if (node.querySelector?.(VERIFIED_NEAR_SELECTORS)) return true;
      } catch {
        /* invalid selector in edge engines */
      }
      const lab = (node.getAttribute?.("aria-label") || node.getAttribute?.("title") || "").toLowerCase();
      if (
        lab.includes("verified account") ||
        lab.includes("verified profile") ||
        lab.includes("identity verified") ||
        lab.includes("instagram verified")
      ) {
        return true;
      }
      node = node.parentElement;
    }
    for (let sib = anchor.nextElementSibling, i = 0; sib && i < 8; sib = sib.nextElementSibling, i++) {
      try {
        if (sib.matches?.("[aria-label*='Verified' i], [aria-label*='verified' i]")) return true;
        if (sib.querySelector?.(VERIFIED_NEAR_SELECTORS)) return true;
      } catch {
        /* ignore */
      }
    }
    for (let sib = anchor.previousElementSibling, i = 0; sib && i < 8; sib = sib.previousElementSibling, i++) {
      try {
        if (sib.matches?.("[aria-label*='Verified' i], [aria-label*='verified' i]")) return true;
        if (sib.querySelector?.(VERIFIED_NEAR_SELECTORS)) return true;
      } catch {
        /* ignore */
      }
    }
    return false;
  }

  /** Official blue check in the UI → +20 to displayed score, never above 100. */
  function applyVerifiedAccountBonus(baseScore, anchor) {
    const b = clamp(Math.round(Number(baseScore) || 0), 0, 100);
    if (!hasVerifiedBadgeNearAnchor(anchor)) return { score: b, boosted: false };
    return { score: clamp(b + 20, 0, 100), boosted: true };
  }

  const SCORE_REVIEW_LS = "veritas.scoreReview.v1.";
  function scoreReviewStorageKey(scoreKey) {
    return SCORE_REVIEW_LS + encodeURIComponent(scoreKey);
  }
  function getStoredScoreReview(scoreKey) {
    try {
      const raw = localStorage.getItem(scoreReviewStorageKey(scoreKey));
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }
  function setStoredScoreReview(scoreKey, verdict, displayScore) {
    try {
      localStorage.setItem(
        scoreReviewStorageKey(scoreKey),
        JSON.stringify({ verdict, score: displayScore, at: Date.now() })
      );
    } catch {
      /* quota */
    }
  }

  function closeActiveScoreReviewPopover() {
    if (activeScoreReviewPopover && activeScoreReviewPopover.parentNode) {
      activeScoreReviewPopover.remove();
    }
    activeScoreReviewPopover = null;
    scorePopoverAnchorBadge = null;
    document.removeEventListener("mousedown", onDocMouseDownForScorePopover, true);
    document.removeEventListener("keydown", onKeyDownForScorePopover, true);
  }

  function onDocMouseDownForScorePopover(ev) {
    if (!activeScoreReviewPopover) return;
    if (activeScoreReviewPopover.contains(ev.target)) return;
    if (scorePopoverAnchorBadge && (ev.target === scorePopoverAnchorBadge || scorePopoverAnchorBadge.contains(ev.target))) {
      return;
    }
    closeActiveScoreReviewPopover();
  }

  function onKeyDownForScorePopover(ev) {
    if (ev.key === "Escape") closeActiveScoreReviewPopover();
  }

  function openScoreReviewPopover(badge, scoreKey, displayScore) {
    closeActiveScoreReviewPopover();
    injectStyleOnce();
    const prev = getStoredScoreReview(scoreKey);
    const pop = document.createElement("div");
    pop.className = "veritas-account-score-popover";
    pop.setAttribute("data-veritas-score-review-popover", "1");

    const row = document.createElement("div");
    row.className = "veritas-account-score-popover__row";

    if (prev && (prev.verdict === "helpful" || prev.verdict === "wrong")) {
      const hint = document.createElement("div");
      hint.className = "veritas-account-score-popover__hint";
      hint.textContent =
        prev.verdict === "helpful"
          ? `You marked this score (${displayScore}) as helpful.`
          : `You marked this score (${displayScore}) as inaccurate.`;
      pop.appendChild(hint);
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.textContent = "Close";
      closeBtn.addEventListener("click", (e) => {
        e.preventDefault();
        closeActiveScoreReviewPopover();
      });
      row.appendChild(closeBtn);
    } else {
      const bHelp = document.createElement("button");
      bHelp.type = "button";
      bHelp.dataset.veritasReview = "helpful";
      bHelp.textContent = "Helpful";
      bHelp.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setStoredScoreReview(scoreKey, "helpful", displayScore);
        closeActiveScoreReviewPopover();
      });
      const bWrong = document.createElement("button");
      bWrong.type = "button";
      bWrong.dataset.veritasReview = "wrong";
      bWrong.textContent = "Wrong";
      bWrong.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        setStoredScoreReview(scoreKey, "wrong", displayScore);
        closeActiveScoreReviewPopover();
      });
      row.appendChild(bHelp);
      row.appendChild(bWrong);
    }

    pop.appendChild(row);
    document.body.appendChild(pop);
    activeScoreReviewPopover = pop;
    scorePopoverAnchorBadge = badge;

    const positionPopover = () => {
      const rect = badge.getBoundingClientRect();
      const margin = 8;
      let left = rect.left;
      let top = rect.bottom + 6;
      const w = pop.offsetWidth;
      const h = pop.offsetHeight;
      if (left + w > window.innerWidth - margin) left = window.innerWidth - w - margin;
      if (left < margin) left = margin;
      if (top + h > window.innerHeight - margin && rect.top > h + margin) {
        top = rect.top - h - 6;
      }
      if (top < margin) top = margin;
      pop.style.left = `${Math.round(left)}px`;
      pop.style.top = `${Math.round(top)}px`;
    };
    positionPopover();
    requestAnimationFrame(positionPopover);

    document.addEventListener("mousedown", onDocMouseDownForScorePopover, true);
    document.addEventListener("keydown", onKeyDownForScorePopover, true);
  }

  function applyAccountBadgeTitles(badge, score, src, botPct, verifiedBoost) {
    let suffix = verifiedBoost ? " · +20 verified account (max 100)" : "";
    if (src === "xgboost") {
      badge.title =
        (botPct != null
          ? `Veritas · XGBoost: authenticity ${score}/100 · bot ~${botPct}% · start: cd veritas-backend && uvicorn model:app --reload`
          : `Veritas · XGBoost: authenticity ${score}/100`) + suffix;
    } else if (src === "veritas-user") {
      badge.title =
        `Veritas · Registered user: authenticity ${score}/100${botPct != null ? ` · botScore ~${botPct}%` : ""}` + suffix;
    } else if (src === "offline" || src === "local") {
      badge.title =
        `Veritas: ${score}/100 (offline estimate — run backend :5000 + FastAPI :8000 for live scores)` + suffix;
    } else {
      badge.title = `Veritas authenticity: ${score}/100 (${src})` + suffix;
    }
  }

  function attachAccountScoreBadge(anchor, scoreKey, useReelWrap, extraBadgeClass, insertBadgeBeforeAnchor) {
    const badge = document.createElement("span");
    badge.className = "veritas-ig-realness veritas-ig-realness--loading";
    if (extraBadgeClass) badge.classList.add(extraBadgeClass);
    badge.textContent = "…";
    badge.title = "Veritas: account authenticity (0–100, higher = more human) — click to review";
    badge.setAttribute("data-veritas-score-key", scoreKey);
    badge.setAttribute("data-veritas-score-interactive", "1");
    badge.setAttribute("role", "button");
    badge.setAttribute("tabindex", "0");

    const onBadgeActivate = (ev) => {
      if (ev.type === "keydown" && ev.key !== "Enter" && ev.key !== " ") return;
      if (ev.type === "click" && ev.button !== 0) return;
      if (ev.type === "keydown") ev.preventDefault();
      const raw = badge.getAttribute("data-veritas-display-score");
      if (!raw || raw === "…") return;
      const n = Number(raw);
      if (Number.isNaN(n)) return;
      if (activeScoreReviewPopover && scorePopoverAnchorBadge === badge) {
        closeActiveScoreReviewPopover();
        return;
      }
      ev.preventDefault();
      ev.stopPropagation();
      openScoreReviewPopover(badge, scoreKey, n);
    };
    badge.addEventListener("click", onBadgeActivate);
    badge.addEventListener("keydown", onBadgeActivate);

    if (useReelWrap && anchor.parentNode) {
      const wrap = document.createElement("span");
      wrap.setAttribute("data-veritas-handle-wrap", "1");
      wrap.style.cssText =
        "display:inline-flex;align-items:center;flex-wrap:nowrap;gap:6px;vertical-align:middle;max-width:100%;";
      anchor.parentNode.insertBefore(wrap, anchor);
      // Score behind the username: leomessi 67
      wrap.appendChild(anchor);
      wrap.appendChild(badge);
      badge.classList.add("veritas-ig-realness--next-to-handle");
      badge.style.marginLeft = "6px";
      badge.style.marginRight = "0";
    } else if (extraBadgeClass === "veritas-account-badge--x") {
      // X: same line as name, after blue tick (not below the name).
      placeXScoreBetweenNameAndTick(badge, anchor);
    } else if (extraBadgeClass === "veritas-account-badge--linkedin") {
      placeLinkedInScoreNextToName(badge, anchor);
    } else if (insertBadgeBeforeAnchor) {
      anchor.insertAdjacentElement("beforebegin", badge);
      badge.classList.add("veritas-ig-realness--next-to-handle");
      badge.style.marginLeft = "0";
      badge.style.marginRight = "6px";
    } else {
      anchor.insertAdjacentElement("afterend", badge);
      badge.classList.add("veritas-ig-realness--next-to-handle");
      badge.style.marginLeft = "6px";
      badge.style.marginRight = "0";
    }

    // Paint a score immediately (pinned overrides / local mock) so pills show like 0.1.x
    // without waiting on the network — then refresh from API when available.
    if (!extraBadgeClass || extraBadgeClass === "veritas-account-badge--linkedin") {
      try {
        const raw = localMockRealness(scoreKey);
        const { score, boosted } = resolveDisplayedAccountScore(scoreKey, raw, anchor);
        badge.textContent = String(score);
        badge.setAttribute("data-veritas-display-score", String(score));
        badge.classList.remove("veritas-ig-realness--loading");
        applyRealnessClass(badge, score);
        badge.title = boosted
          ? `Veritas: ${score}/100 · +20 verified account (max 100) — click to review`
          : `Veritas: ${score}/100 — click to review`;
      } catch {
        /* keep loading ellipsis */
      }
    }

    fetchAccountScore(scoreKey)
      .then((data) => {
        const raw = clamp(Math.round(Number(data.realnessScore) || 0), 0, 100);
        const { score, boosted } = resolveDisplayedAccountScore(scoreKey, raw, anchor);
        const botPct =
          typeof data.bot_probability === "number"
            ? clamp(Math.round(data.bot_probability * 100), 0, 100)
            : null;
        badge.textContent = String(score);
        badge.setAttribute("data-veritas-display-score", String(score));
        badge.classList.remove("veritas-ig-realness--loading");
        applyRealnessClass(badge, score);
        applyAccountBadgeTitles(badge, score, data.source || "api", botPct, boosted);
        badge.title += " — click to review";
      })
      .catch(() => {
        const raw = localMockRealness(scoreKey);
        const { score, boosted } = resolveDisplayedAccountScore(scoreKey, raw, anchor);
        badge.textContent = String(score);
        badge.setAttribute("data-veritas-display-score", String(score));
        badge.classList.remove("veritas-ig-realness--loading");
        applyRealnessClass(badge, score);
        badge.title = boosted
          ? `Veritas: ${score}/100 (fallback) · +20 verified account (max 100) — click to review`
          : `Veritas: ${score}/100 (fallback) — click to review`;
      });
  }

  function applyRealnessClass(el, score) {
    el.classList.remove(
      "veritas-ig-realness--high",
      "veritas-ig-realness--mid",
      "veritas-ig-realness--low"
    );
    const t = tone(score);
    if (t === "ok") el.classList.add("veritas-ig-realness--high");
    else if (t === "mid") el.classList.add("veritas-ig-realness--mid");
    else el.classList.add("veritas-ig-realness--low");
  }

  /** True if this handle already has a score badge in the same local post/header row. */
  function igHandleAlreadyBadgedNear(anchor, handle) {
    const key = String(handle || "").toLowerCase();
    if (!key || !(anchor instanceof Element)) return false;
    const root =
      anchor.closest("article, [role='article'], section, header") ||
      anchor.parentElement ||
      anchor;
    const badges = root.querySelectorAll?.(".veritas-ig-realness[data-veritas-score-key]") || [];
    for (const b of badges) {
      if (String(b.getAttribute("data-veritas-score-key") || "").toLowerCase() === key) {
        return true;
      }
    }
    // Same flex/inline row as the username link.
    let n = anchor.parentElement;
    for (let i = 0; i < 4 && n; i++) {
      for (const b of n.querySelectorAll(".veritas-ig-realness[data-veritas-score-key]")) {
        if (String(b.getAttribute("data-veritas-score-key") || "").toLowerCase() === key) {
          return true;
        }
      }
      n = n.parentElement;
    }
    return false;
  }

  /** Left rail / bottom nav profile shortcuts — not post authors. */
  function isInstagramNavChromeLink(a) {
    if (!a) return true;
    if (a.closest('nav, [role="navigation"]')) return true;
    const label = `${a.getAttribute("aria-label") || ""} ${a.textContent || ""}`.toLowerCase();
    if (/\b(home|search|explore|reels|messages|notifications|create|more)\b/.test(label) && !label.includes("@")) {
      const r = a.getBoundingClientRect();
      if (r.left < 120) return true;
    }
    const r = a.getBoundingClientRect();
    // Desktop left icon rail
    if (r.left < 96 && r.width <= 96) return true;
    // Bottom-left profile chip in the rail
    if (r.left < 120 && r.bottom > (window.innerHeight || 0) - 140 && r.width < 140) return true;
    return false;
  }

  /** Edit profile / View archive / Follow etc. — never badge these. */
  function isInstagramActionOrWideLink(a) {
    const text = (a.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (
      /^(edit profile|view archive|following|follow|message|requested|promote|email)$/i.test(text) ||
      /\b(edit profile|view archive)\b/.test(text)
    ) {
      return true;
    }
    const r = a.getBoundingClientRect();
    if (r.width > 140) return true;
    return false;
  }

  /** Prefer the visible @username text link over other profile hrefs in the same row. */
  function igAnchorUsernameScore(anchor, handle) {
    const text = (anchor.textContent || "").replace(/\s+/g, " ").trim().toLowerCase();
    const h = String(handle || "").toLowerCase();
    if (!text) return 0;
    if (text === h || text === `@${h}`) return 100;
    if (text.includes(h)) return 80;
    return 20;
  }

  /** /username or /username/reels|tagged|… profile surfaces. */
  function getInstagramProfileHandleFromPath() {
    const parts = (location.pathname || "").split("/").filter(Boolean);
    if (!parts.length) return null;
    const first = parts[0];
    if (IG_RESERVED.has(first.toLowerCase())) return null;
    if (!/^[a-zA-Z0-9._]+$/.test(first)) return null;
    if (parts.length === 1) return first;
    if (parts.length === 2 && /^(reels|tagged|channel|guides|saved)$/i.test(parts[1])) return first;
    return null;
  }

  /** Profile header username node (often a span/h2, not a link). */
  function findInstagramProfileUsernameNode(handle) {
    const h = String(handle || "").toLowerCase();
    if (!h) return null;
    const nodes = document.querySelectorAll(
      'header h1, header h2, header span, main header h1, main header h2, main header span, [role="main"] header span, [role="main"] header h2'
    );
    let best = null;
    let bestScore = -1;
    for (const el of nodes) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.closest('nav, [role="navigation"], [role="tablist"]')) continue;
      if (el.querySelector("img, video")) continue;
      if (el.querySelector(".veritas-ig-realness")) continue;
      const ownText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => String(n.textContent || "").trim())
        .join("")
        .toLowerCase();
      const text = (ownText || String(el.textContent || "").replace(/\s+/g, " ").trim()).toLowerCase();
      if (text !== h && text !== `@${h}`) continue;
      // Prefer tight leaf-like nodes (exact username only).
      if ((el.textContent || "").replace(/\s+/g, " ").trim().length > h.length + 2 && !ownText) continue;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      if (r.top > Math.min(520, window.innerHeight * 0.65)) continue;
      if (r.left < 80) continue; // skip left rail
      const score = 2000 - r.top * 2 + r.width;
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function scanInstagram() {
    injectStyleOnce();

    // Profile pages: pin score next to the username (talk.with.adarsh 92).
    const profileHandle = getInstagramProfileHandleFromPath();
    if (profileHandle) {
      const uname = findInstagramProfileUsernameNode(profileHandle);
      if (uname && !igHandleAlreadyBadgedNear(uname, profileHandle)) {
        attachAccountScoreBadge(uname, profileHandle, false, null, false);
      }
    }

    // 0.1.3-style: badge every visible author username in feed / reels / suggestions.
    const anchors = Array.from(document.querySelectorAll('a[href^="/"], a[href*="instagram.com"]'));
    const slotSeen = new Set();

    for (const a of anchors) {
      if (a.getAttribute(IG_TAG) === "1") continue;
      const handle = instagramHandleFromHref(a.getAttribute("href") || "");
      if (!handle) continue;
      if (isLikelyInstagramAvatarLink(a)) continue;
      if (a.closest('[role="tablist"]')) {
        a.setAttribute(IG_TAG, "1");
        continue;
      }
      if (isInstagramNavChromeLink(a)) {
        a.setAttribute(IG_TAG, "1");
        continue;
      }
      if (isInstagramActionOrWideLink(a)) {
        a.setAttribute(IG_TAG, "1");
        continue;
      }

      // Prefer the username text link; skip weak avatar-adjacent hrefs in same row if a better one exists.
      const text = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (!text) {
        a.setAttribute(IG_TAG, "1");
        continue;
      }

      const r = a.getBoundingClientRect();
      if (r.width < 2 && r.height < 2) continue;

      // Same slotting as 0.1.3 — same person can score on many posts.
      const slot = `${handle.toLowerCase()}@${Math.round(r.top / 320)}_${Math.round(r.left / 200)}`;
      if (slotSeen.has(slot)) {
        a.setAttribute(IG_TAG, "1");
        continue;
      }
      if (igHandleAlreadyBadgedNear(a, handle)) {
        a.setAttribute(IG_TAG, "1");
        continue;
      }

      // On profile pages, skip extra links for the owner (header already pinned).
      if (profileHandle && handle.toLowerCase() === profileHandle.toLowerCase()) {
        a.setAttribute(IG_TAG, "1");
        continue;
      }

      // Prefer higher username-match anchors in the same slot: collect then attach best.
      slotSeen.add(slot);
      a.setAttribute(IG_TAG, "1");
      // If this lookalike is a weak match, try to find a sibling with exact handle text.
      let target = a;
      const row = a.closest("header, article, [role='article'], div") || a.parentElement;
      if (row && igAnchorUsernameScore(a, handle) < 80) {
        const better = Array.from(row.querySelectorAll('a[href^="/"], a[href*="instagram.com"]')).find((x) => {
          if (instagramHandleFromHref(x.getAttribute("href") || "")?.toLowerCase() !== handle.toLowerCase()) {
            return false;
          }
          if (isLikelyInstagramAvatarLink(x) || isInstagramNavChromeLink(x)) return false;
          return igAnchorUsernameScore(x, handle) >= 80;
        });
        if (better) target = better;
      }
      if (igHandleAlreadyBadgedNear(target, handle)) continue;
      attachAccountScoreBadge(target, handle, isInstagramReelSurface(), null, false);
    }

    // Strip chrome leftovers only — do NOT collapse to one badge per handle (feed needs many).
    document.querySelectorAll(".veritas-ig-realness[data-veritas-score-key]").forEach((b) => {
      if (b.closest('nav, [role="navigation"], [role="tablist"]')) {
        b.remove();
        return;
      }
      const br = b.getBoundingClientRect();
      if (br.left < 96 && br.bottom > (window.innerHeight || 0) - 140) {
        b.remove();
      }
    });
  }

  function scanXAccountBadges() {
    injectStyleOnce();
    const sel = 'a[href^="/"], a[href*="x.com/"], a[href*="twitter.com/"]';
    const seen = new Set();
    const collected = [];
    collectAnchorsDeep(document, sel, collected, seen);
    const anchors = collected;
    const slotSeen = new Set();
    for (const a of anchors) {
      if (a.getAttribute(SOCIAL_TAG) === "1") continue;
      const href = a.getAttribute("href") || "";
      if (isXProfileFollowersOrFollowingHref(href)) continue;
      const scoreKey = xHandleFromHref(href);
      if (!scoreKey) continue;
      if (isLikelyGenericAvatarLink(a)) continue;
      if (!shouldAttachXAccountBadge(a)) continue;

      // Prefer the display-name link; skip bare @handle links in the same User-Name row.
      const t = (a.textContent || "").replace(/\s+/g, " ").trim();
      if (
        t.startsWith("@") &&
        a.closest('[data-testid="User-Name"], [data-testid="UserName"], [data-testid="User-Names"]')
      ) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }

      const tweet = a.closest('[data-testid="tweet"]');
      if (tweet && xTweetAlreadyBadgedForUser(tweet, scoreKey)) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }

      const r = a.getBoundingClientRect();
      if (r.width < 2 && r.height < 2) continue;
      const slot = `${scoreKey}@${Math.round(r.top / 320)}_${Math.round(r.left / 200)}`;
      if (slotSeen.has(slot)) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }
      slotSeen.add(slot);
      a.setAttribute(SOCIAL_TAG, "1");
      attachAccountScoreBadge(a, scoreKey, false, "veritas-account-badge--x", false);
      if (tweet) xTweetMarkBadgedForUser(tweet, scoreKey);
    }
  }

  function scanLinkedInAccountBadges() {
    injectStyleOnce();

    const profileKey = getLinkedInProfileVanityFromPath();
    if (profileKey) {
      ensureLinkedInProfileNameScore(profileKey);
    }

    // "Name reposted this" rows (not covered by plain /in/ name links alone).
    scanLinkedInRepostHeaderBadges(profileKey);

    // 0.1.3-style: badge every visible profile name link — feed, sidebar, search, etc.
    const anchors = Array.from(
      document.querySelectorAll('a[href*="/in/"], a[href*="linkedin.com/in/"]')
    );
    const slotSeen = new Set();

    for (const a of anchors) {
      if (a.getAttribute(SOCIAL_TAG) === "1") continue;
      const scoreKey = linkedinVanityFromHref(a.getAttribute("href") || "");
      if (!scoreKey) continue;

      // Top chrome / messaging only — do NOT skip aside / "More profiles for you".
      if (a.closest(".global-nav, header.global-nav__content, .msg-overlay-list-bubble, footer")) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }

      // Allow the profile owner elsewhere too (Open to work / lockups) like 0.1.3.
      // H1 is still pinned separately via ensureLinkedInProfileNameScore.

      if (isLinkedInRepostHeaderContext(a)) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }

      if (isLikelyGenericAvatarLink(a)) continue;

      const text = linkedInAnchorDisplayName(a.textContent || "");
      if (!text || text.length < 2) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }
      if (/^(message|connect|follow|pending|more|view profile)$/i.test(text)) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }

      const r = a.getBoundingClientRect();
      if (r.width < 2 && r.height < 2) continue;

      // Same slotting as 0.1.3 — allows multiple people + sidebar columns.
      const slot = `${scoreKey}@${Math.round(r.top / 280)}_${Math.round(r.left / 200)}`;
      if (slotSeen.has(slot)) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }

      // Only skip if THIS local row/card already has the badge (never page-wide).
      const near =
        a.closest(
          ".artdeco-entity-lockup, .entity-result, .reusable-search__result-container, li.artdeco-list__item, .feed-shared-update-v2, .occludable-update, [data-urn*='activity'], [data-id*='activity']"
        ) || a.parentElement;
      if (
        near &&
        near.querySelector(
          `.veritas-ig-realness[data-veritas-score-key="${CSS.escape(scoreKey)}"]`
        )
      ) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }

      slotSeen.add(slot);
      a.setAttribute(SOCIAL_TAG, "1");
      const nameTarget = resolveLinkedInFeedNameTarget(a);
      attachAccountScoreBadge(nameTarget, scoreKey, false, "veritas-account-badge--linkedin");
    }

    // Never strip sidebar / aside scores (0.1.3 showed them).
    document.querySelectorAll(".veritas-account-badge--linkedin").forEach((b) => {
      if (b.closest(".global-nav, header.global-nav__content, footer")) b.remove();
    });
  }

  function linkedInFeedCardRoot(el) {
    if (!(el instanceof Element)) return null;
    return (
      el.closest(
        ".feed-shared-update-v2, .occludable-update, [data-urn*='activity'], [data-id*='activity'], [data-urn*='aggregate'], article"
      ) || null
    );
  }

  function cardHasLinkedInBadge(card, scoreKey) {
    const root = card || document;
    return !!root.querySelector(
      `.veritas-ig-realness[data-veritas-score-key="${CSS.escape(scoreKey)}"]`
    );
  }

  function linkedInAnchorDisplayName(raw) {
    return String(raw || "")
      .replace(/\s+/g, " ")
      .replace(/\breposted this\b/gi, "")
      .replace(/\breposted a .*?\b/gi, "")
      .trim();
  }

  function isLinkedInRepostHeaderContext(el) {
    if (!(el instanceof Element)) return false;
    const header =
      el.closest(
        ".update-components-header, .feed-shared-header, .update-components-header__text-wrapper"
      ) || null;
    const scope = header || el.parentElement;
    if (!scope) return false;
    const t = (scope.textContent || "").replace(/\s+/g, " ");
    return /\breposted this\b/i.test(t) || /\breposted\b/i.test(t);
  }

  /**
   * "Name reposted this" row — separate from the original author actor lockup.
   */
  function scanLinkedInRepostHeaderBadges(profileKey) {
    const headers = new Set();

    document
      .querySelectorAll(
        ".update-components-header, .feed-shared-header, .update-components-header__text-wrapper"
      )
      .forEach((el) => {
        const t = (el.textContent || "").replace(/\s+/g, " ");
        if (/\breposted this\b/i.test(t) || /\breposted\b/i.test(t)) headers.add(el);
      });

    // Fallback: any compact node that literally contains "reposted this".
    document.querySelectorAll("span, div, p").forEach((el) => {
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!/\breposted this\b/i.test(t)) return;
      if (t.length > 140) return;
      const header =
        el.closest(
          ".update-components-header, .feed-shared-header, .update-components-header__text-wrapper"
        ) || el;
      headers.add(header);
    });

    for (const header of headers) {
      if (!(header instanceof HTMLElement)) continue;
      if (header.getAttribute("data-veritas-li-repost") === "1") {
        if (header.querySelector(".veritas-account-badge--linkedin")) continue;
        header.removeAttribute("data-veritas-li-repost");
      }

      const links = Array.from(
        header.querySelectorAll('a[href*="/in/"], a[href*="linkedin.com/in/"]')
      );
      let nameLink = null;
      for (const a of links) {
        if (isLikelyGenericAvatarLink(a)) continue;
        const name = linkedInAnchorDisplayName(a.textContent || "");
        if (!name || name.length < 2) continue;
        if (isLinkedInHeadlineLike(name)) continue;
        nameLink = a;
        break;
      }
      // Avatar-only header: still resolve vanity from the first profile link.
      if (!nameLink) {
        const any = links.find((a) => linkedinVanityFromHref(a.getAttribute("href") || ""));
        if (!any) continue;
        nameLink = any;
      }

      const scoreKey = linkedinVanityFromHref(nameLink.getAttribute("href") || "");
      if (!scoreKey) continue;
      if (profileKey && scoreKey.toLowerCase() === profileKey.toLowerCase()) {
        header.setAttribute("data-veritas-li-repost", "1");
        continue;
      }

      const card = linkedInFeedCardRoot(header);
      if (cardHasLinkedInBadge(header, scoreKey) || cardHasLinkedInBadge(card, scoreKey)) {
        // Prefer a badge inside this header; if only on the author row below, still add here.
        if (header.querySelector(`.veritas-ig-realness[data-veritas-score-key="${CSS.escape(scoreKey)}"]`)) {
          header.setAttribute("data-veritas-li-repost", "1");
          continue;
        }
      }
      if (header.querySelector(".veritas-account-badge--linkedin")) {
        header.setAttribute("data-veritas-li-repost", "1");
        continue;
      }

      links.forEach((a) => a.setAttribute(SOCIAL_TAG, "1"));
      header.setAttribute("data-veritas-li-repost", "1");

      // Place after the name link (before "reposted this"), not after the whole header.
      const placeOn =
        !isLikelyGenericAvatarLink(nameLink) && linkedInAnchorDisplayName(nameLink.textContent || "")
          ? nameLink
          : findLinkedInRepostNameNode(header, nameLink) || nameLink;
      attachAccountScoreBadge(placeOn, scoreKey, false, "veritas-account-badge--linkedin");
    }
  }

  function findLinkedInRepostNameNode(header, fallbackLink) {
    const spans = Array.from(header.querySelectorAll("span[aria-hidden='true'], span, strong, a"));
    for (const el of spans) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.querySelector("img")) continue;
      const t = linkedInAnchorDisplayName(el.textContent || "");
      if (!t || t.length < 2 || t.length > 60) continue;
      if (/\breposted\b/i.test(el.textContent || "") && t.split(/\s+/).length > 4) continue;
      if (isLinkedInHeadlineLike(t)) continue;
      const words = t.split(/\s+/).filter(Boolean);
      if (words.length < 1 || words.length > 6) continue;
      // Prefer the visible name sitting before "reposted this".
      return el;
    }
    return fallbackLink;
  }

  function isLinkedInHeadlineLike(text) {
    const t = String(text || "").replace(/\s+/g, " ").trim();
    if (!t) return true;
    if (/[|]/.test(t)) return true;
    if (t.length > 60) return true;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length > 7) return true;
    if (
      /\b(developer|engineer|hiring|open to|looking for|full-?stack|machine learning|wellbeing|founder &)\b/i.test(
        t
      ) &&
      words.length > 4
    ) {
      return true;
    }
    return false;
  }

  function cleanLinkedInNameText(raw) {
    let t = String(raw || "").replace(/\s+/g, " ").trim();
    t = t.replace(/\b(he\/him|she\/her|they\/them)\b/gi, "").trim();
    t = t.replace(/[•·].*$/, "").trim(); // drop "· 2nd" / degree
    t = t.replace(/\b(1st|2nd|3rd|premium)\b/gi, "").trim();
    t = t.replace(/\b\d{1,3}\b/g, "").replace(/\s+/g, " ").trim();
    return t;
  }

  function isLinkedInProfileNameCandidate(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.closest("aside, footer, nav, [role='navigation'], .scaffold-layout__aside, .global-nav")) {
      return false;
    }
    if (el.closest(".scaffold-layout__aside, [componentkey*='Aside'], .pv-other-entity")) {
      return false;
    }
    const t = cleanLinkedInNameText(el.textContent || "");
    if (!t || t.length < 2) return false;
    if (isLinkedInHeadlineLike(t)) return false;
    const words = t.split(/\s+/).filter(Boolean);
    if (words.length < 1 || words.length > 8) return false;
    const r = el.getBoundingClientRect();
    // During SPA mount the heading can be 0×0 for a few frames — still accept it.
    if (r.width === 0 && r.height === 0 && !el.isConnected) return false;
    if (r.left > window.innerWidth * 0.85) return false;
    return true;
  }

  /**
   * Profile page: pin score beside the person name without moving the name node
   * (wrapping/moving <h1> is undone by LinkedIn's React remount → badge vanishes).
   */
  function ensureLinkedInProfileNameScore(profileKey) {
    const nameEl = findLinkedInProfileNameNode();
    if (!nameEl) return false;

    const sel = `.veritas-ig-realness[data-veritas-score-key="${CSS.escape(profileKey)}"]`;
    const nearName =
      (nameEl.nextElementSibling &&
        nameEl.nextElementSibling.classList?.contains("veritas-account-badge--linkedin") &&
        nameEl.nextElementSibling.getAttribute("data-veritas-score-key") === profileKey &&
        nameEl.nextElementSibling) ||
      (nameEl.parentElement &&
        Array.from(nameEl.parentElement.children).find(
          (c) =>
            c.classList?.contains("veritas-account-badge--linkedin") &&
            c.getAttribute("data-veritas-score-key") === profileKey
        )) ||
      null;

    if (nearName && nearName.isConnected) return true;

    // Do not delete other badges for this key (0.1.3 showed multiple: name + Open to work, etc.).
    attachAccountScoreBadge(nameEl, profileKey, false, "veritas-account-badge--linkedin");
    return !!document.querySelector(sel);
  }

  function getLinkedInProfileVanityFromPath() {
    try {
      const parts = (location.pathname || "").split("/").filter(Boolean);
      if (parts[0] !== "in" || !parts[1]) return null;
      let v = decodeURIComponent(parts[1]);
      if (v.toLowerCase() === "me") {
        const pub = document.querySelector(
          'a[href*="linkedin.com/in/"]:not([href*="/in/me"]), a[href^="/in/"]:not([href^="/in/me"])'
        );
        const fromPub = pub && linkedinVanityFromHref(pub.getAttribute("href") || "");
        if (fromPub) return fromPub;
        const urlText = Array.from(document.querySelectorAll("a, span, p"))
          .map((n) => (n.textContent || "").trim())
          .find((t) => /linkedin\.com\/in\//i.test(t) && !/\/in\/me\/?/i.test(t));
        if (urlText) {
          const m = urlText.match(/linkedin\.com\/in\/([a-zA-Z0-9\-_%]+)/i);
          if (m) v = m[1];
        } else {
          return null;
        }
      }
      if (LI_RESERVED.has(v.toLowerCase())) return null;
      if (!/^[a-zA-Z0-9\-_%]{2,120}$/.test(v)) return null;
      return `li:${v}`;
    } catch {
      return null;
    }
  }

  function findLinkedInProfileNameNode() {
    const selectors = [
      "main h1",
      ".scaffold-layout__main h1",
      "section.artdeco-card h1",
      ".pv-text-details__left-panel h1",
      "h1.text-heading-xlarge",
      "h1.inline.t-24",
      "h1[class*='heading']",
      "h1",
      "[data-anonymize='person-name']",
      ".pv-text-details__left-panel .text-heading-xlarge",
      "main .text-heading-xlarge",
    ];
    const seen = new Set();
    const nodes = [];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach((el) => {
        if (!seen.has(el)) {
          seen.add(el);
          nodes.push(el);
        }
      });
    }

    let best = null;
    let bestScore = -1;
    for (const el of nodes) {
      if (!isLinkedInProfileNameCandidate(el)) continue;
      const r = el.getBoundingClientRect();
      const score =
        10000 -
        Math.abs(Math.min(r.top || 0, 400)) * 3 +
        (r.width || 40) +
        (el.tagName === "H1" ? 500 : 0) +
        (el.getAttribute("data-anonymize") === "person-name" ? 400 : 0) +
        (String(el.className || "").includes("heading") ? 80 : 0) +
        (el.closest(".pv-text-details__left-panel, .scaffold-layout__main") ? 120 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }
    if (best) return best;

    // Last-resort (older 0.2.x behavior): first short main-column h1.
    for (const el of document.querySelectorAll("main h1, .scaffold-layout__main h1, h1")) {
      if (!(el instanceof HTMLElement)) continue;
      if (el.closest("aside, nav, footer, .global-nav, .scaffold-layout__aside")) continue;
      const t = cleanLinkedInNameText(el.textContent || "");
      if (t.length >= 2 && t.length <= 80 && !/[|]/.test(t)) return el;
    }
    return null;
  }

  /** Place score beside the LinkedIn display name — never stacked on top of it. */
  function placeLinkedInScoreNextToName(badge, nameEl) {
    if (!(nameEl instanceof HTMLElement) || !nameEl.parentNode) return;

    badge.classList.add("veritas-ig-realness--next-to-handle");
    badge.style.setProperty("position", "static", "important");
    badge.style.setProperty("z-index", "2147483000", "important");
    badge.style.setProperty("display", "inline-flex", "important");
    badge.style.setProperty("flex-shrink", "0", "important");
    badge.style.setProperty("float", "none", "important");
    badge.style.setProperty("inset", "auto", "important");
    badge.style.marginLeft = "8px";
    badge.style.marginRight = "4px";
    badge.style.verticalAlign = "middle";

    // Profile H1: insert after name — never wrap/move (LinkedIn React remounts).
    if (
      nameEl.tagName === "H1" ||
      nameEl.getAttribute("data-anonymize") === "person-name" ||
      (nameEl.classList?.contains("text-heading-xlarge") && !!getLinkedInProfileVanityFromPath())
    ) {
      const parent = nameEl.parentElement;
      if (parent) {
        const disp = window.getComputedStyle(parent).display;
        if (disp === "block" || disp === "list-item") {
          parent.style.setProperty("display", "flex", "important");
          parent.style.setProperty("flex-direction", "row", "important");
          parent.style.setProperty("flex-wrap", "wrap", "important");
          parent.style.setProperty("align-items", "center", "important");
          parent.style.setProperty("gap", "8px", "important");
        }
        parent.setAttribute("data-veritas-li-profile-name", "1");
      }
      if (nameEl.nextElementSibling !== badge) nameEl.insertAdjacentElement("afterend", badge);
      return;
    }

    // Repost header + everything else (feed / sidebar): 0.1.3 behavior — afterend.
    if (nameEl.nextElementSibling !== badge) nameEl.insertAdjacentElement("afterend", badge);
  }

  function resolveLinkedInFeedNameTarget(anchor) {
    if (!(anchor instanceof HTMLElement)) return anchor;

    // Sidebar / entity lockup title (More profiles for you).
    const lockupTitle =
      anchor.querySelector?.(
        ".artdeco-entity-lockup__title, .entity-result__title-text, .artdeco-entity-lockup__title span[aria-hidden='true']"
      ) ||
      anchor.closest?.(".artdeco-entity-lockup__title, .entity-result__title-text");
    if (lockupTitle && linkedInAnchorDisplayName(lockupTitle.textContent || "").length >= 2) {
      return lockupTitle;
    }

    const title =
      anchor.closest(".update-components-actor__title") ||
      anchor.closest(".update-components-actor__name") ||
      anchor.closest(".feed-shared-actor__name") ||
      anchor.closest(".artdeco-entity-lockup__title");
    if (title) {
      const nt = linkedInAnchorDisplayName(title.textContent || "");
      if (nt && !isLinkedInHeadlineLike(nt)) return title;
    }

    // If the <a> mixes name + headline, prefer the first short visible name span.
    const full = linkedInAnchorDisplayName(anchor.textContent || "");
    if (full.length > 48 || /[|]/.test(full)) {
      for (const el of anchor.querySelectorAll("span[aria-hidden='true'], span, strong")) {
        if (!(el instanceof HTMLElement) || el.querySelector("img")) continue;
        const t = linkedInAnchorDisplayName(el.textContent || "");
        if (t.length >= 2 && t.length <= 48 && !/[|]/.test(t) && t.split(/\s+/).length <= 6) {
          return el;
        }
      }
    }

    return anchor;
  }

  function scanRedditAccountBadges() {
    injectStyleOnce();
    const anchors = Array.from(
      document.querySelectorAll(
        'a[href*="/user/"], a[href*="/u/"], a[href*="reddit.com/user/"], a[href*="reddit.com/u/"]'
      )
    );
    const slotSeen = new Set();
    for (const a of anchors) {
      if (a.getAttribute(SOCIAL_TAG) === "1") continue;
      const scoreKey = redditUserFromHref(a.getAttribute("href") || "");
      if (!scoreKey) continue;
      if (isLikelyGenericAvatarLink(a)) continue;
      const r = a.getBoundingClientRect();
      if (r.width < 2 && r.height < 2) continue;
      const slot = `${scoreKey}@${Math.round(r.top / 280)}_${Math.round(r.left / 200)}`;
      if (slotSeen.has(slot)) {
        a.setAttribute(SOCIAL_TAG, "1");
        continue;
      }
      slotSeen.add(slot);
      a.setAttribute(SOCIAL_TAG, "1");
      attachAccountScoreBadge(a, scoreKey, false);
    }
  }

  function postTextFromElement(el) {
    const xText = el.querySelector('[data-testid="tweetText"]');
    if (xText && xText.textContent) return xText.textContent.trim();

    const generic = el.innerText || el.textContent || "";
    return generic.trim();
  }

  function pickLargestVisibleImage(root) {
    const imgs =
      root instanceof HTMLImageElement
        ? [root]
        : Array.from(root.querySelectorAll("img"));
    let best = null;
    let bestArea = 0;
    for (const img of imgs) {
      const r = img.getBoundingClientRect();
      const a = r.width * r.height;
      if (a < 48 * 48) continue;
      if (r.bottom < -80 || r.top > window.innerHeight + 80) continue;
      if (a > bestArea) {
        bestArea = a;
        best = img;
      }
    }
    return best;
  }

  function tryCaptureVideoFrame(root) {
    const videos =
      root instanceof HTMLVideoElement
        ? [root]
        : Array.from(root.querySelectorAll?.("video") || []);
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width * r.height < 64 * 64) continue;
      try {
        const vw = v.videoWidth;
        const vh = v.videoHeight;
        if (!vw || !vh) continue;
        const maxS = 1280;
        const scale = Math.min(1, maxS / Math.max(vw, vh));
        const tw = Math.max(1, Math.round(vw * scale));
        const th = Math.max(1, Math.round(vh * scale));
        const c = document.createElement("canvas");
        c.width = tw;
        c.height = th;
        const ctx = c.getContext("2d");
        ctx.drawImage(v, 0, 0, tw, th);
        const dataUrl = c.toDataURL("image/jpeg", 0.88);
        if (dataUrl && dataUrl.length > 400) return { imageBase64: dataUrl };
      } catch {
        /* CORS-tainted canvas or not ready — Instagram CDN videos hit this often */
      }
    }
    return null;
  }

  function tryCaptureImageDataUrl(img) {
    try {
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (!w || !h) return null;
      const maxS = 1280;
      const scale = Math.min(1, maxS / Math.max(w, h));
      const tw = Math.max(1, Math.round(w * scale));
      const th = Math.max(1, Math.round(h * scale));
      const c = document.createElement("canvas");
      c.width = tw;
      c.height = th;
      const ctx = c.getContext("2d");
      ctx.drawImage(img, 0, 0, tw, th);
      return c.toDataURL("image/jpeg", 0.88);
    } catch {
      return null;
    }
  }

  /** Map an element rect into the top-level viewport (handles iframe content scripts). */
  function getRectInTopViewport(el) {
    const r = el.getBoundingClientRect();
    let left = r.left;
    let top = r.top;
    let win = window;
    try {
      while (win !== win.top) {
        const frame = win.frameElement;
        if (!frame) break;
        const fr = frame.getBoundingClientRect();
        left += fr.left;
        top += fr.top;
        win = win.parent;
      }
    } catch {
      /* cross-origin parent access — use local rect */
    }
    return { left, top, width: r.width, height: r.height };
  }

  function waitTwoAnimationFrames() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(resolve));
    });
  }

  /**
   * Crop a full-tab screenshot data URL to an element’s on-screen box.
   * @returns {Promise<{ imageBase64: string } | null>}
   */
  function cropDataUrlToRect(dataUrl, rect) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        try {
          const dpr = window.devicePixelRatio || 1;
          let sx = Math.round(rect.left * dpr);
          let sy = Math.round(rect.top * dpr);
          let sw = Math.round(rect.width * dpr);
          let sh = Math.round(rect.height * dpr);
          sx = Math.max(0, Math.min(sx, img.naturalWidth - 1));
          sy = Math.max(0, Math.min(sy, img.naturalHeight - 1));
          sw = Math.max(1, Math.min(sw, img.naturalWidth - sx));
          sh = Math.max(1, Math.min(sh, img.naturalHeight - sy));
          const maxS = 1280;
          const scale = Math.min(1, maxS / Math.max(sw, sh));
          const tw = Math.max(1, Math.round(sw * scale));
          const th = Math.max(1, Math.round(sh * scale));
          const c = document.createElement("canvas");
          c.width = tw;
          c.height = th;
          const ctx = c.getContext("2d");
          ctx.drawImage(img, sx, sy, sw, sh, 0, 0, tw, th);
          const out = c.toDataURL("image/jpeg", 0.88);
          if (out && out.length > 400) resolve({ imageBase64: out });
          else resolve(null);
        } catch {
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = dataUrl;
    });
  }

  /**
   * Screenshot fallback when canvas cannot read Instagram/CDN media (CORS).
   * Temporarily hides Veritas overlays so they are not in the crop.
   * @returns {Promise<{ imageBase64: string } | null>}
   */
  async function captureTabRegionForElement(el, hideEls) {
    if (!el || !el.isConnected) return null;
    const restore = [];
    for (const node of hideEls || []) {
      if (!node) continue;
      const prev = node.style.visibility;
      node.style.visibility = "hidden";
      restore.push(() => {
        node.style.visibility = prev;
      });
    }
    try {
      await waitTwoAnimationFrames();
      const bg = await sendMessageToExtension({ type: "VERITAS_CAPTURE_TAB" });
      if (!bg || bg.ok !== true || typeof bg.dataUrl !== "string") return null;
      return await cropDataUrlToRect(bg.dataUrl, getRectInTopViewport(el));
    } catch {
      return null;
    } finally {
      for (const fn of restore) fn();
    }
  }

  function pickCaptureVideo(root) {
    if (root instanceof HTMLVideoElement) return root;
    if (root && typeof root.querySelector === "function") {
      const videos = Array.from(root.querySelectorAll("video"));
      let best = null;
      let bestArea = 0;
      for (const v of videos) {
        const r = v.getBoundingClientRect();
        const area = r.width * r.height;
        if (area < 64 * 64) continue;
        if (area > bestArea) {
          bestArea = area;
          best = v;
        }
      }
      if (best) return best;
    }
    return findPrimaryInstagramReelVideo();
  }

  /**
   * Prefer a video frame; else largest visible image; else tab screenshot crop
   * (required for Instagram Reels — CDN video frames taint canvas).
   * @returns {Promise<{ imageBase64?: string, imageUrl?: string } | null>}
   */
  async function captureMediaForCheckAi(root, opts) {
    const hideEls = opts?.hideEls || [];
    const v = tryCaptureVideoFrame(root);
    if (v) return v;

    const imgRoot =
      root && typeof root.querySelector === "function"
        ? root
        : document.documentElement;
    const img = pickLargestVisibleImage(imgRoot);
    if (img) {
      const dataUrl = tryCaptureImageDataUrl(img);
      if (dataUrl) return { imageBase64: dataUrl };
      const url = img.currentSrc || img.getAttribute("src") || "";
      if (url && !url.startsWith("blob:") && /^https?:\/\//i.test(url)) {
        return { imageUrl: url };
      }
    }

    const video = pickCaptureVideo(root);
    if (video) {
      const shot = await captureTabRegionForElement(video, hideEls);
      if (shot) return shot;
    }

    return null;
  }

  function mountCheckAiPanel(host) {
    let panel = host.querySelector(".veritas-check-ai-panel");
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "veritas-check-ai-panel";
      host.appendChild(panel);
    }
    return panel;
  }

  function renderCheckAiResult(panel, { aiProbability, verdict, explanation }) {
    const raw = Math.round(Number(aiProbability));
    /** Check AI returns a random percent 1–10 on the usual 0–100 scale; other callers may send any 0–100 value. */
    let displayPct;
    let barWidth;
    if (raw >= 1 && raw <= 10) {
      displayPct = raw;
      barWidth = raw;
    } else {
      displayPct = clamp(raw, 0, 100);
      barWidth = displayPct;
    }
    const isAi = verdict === "AI-generated";
    panel.textContent = "";
    const card = document.createElement("div");
    card.className = "veritas-check-ai-card";
    const head = document.createElement("div");
    head.className = "veritas-check-ai-head";
    const title = document.createElement("span");
    title.className = "veritas-check-ai-title";
    title.textContent = "Check AI";
    const ver = document.createElement("span");
    ver.className = `veritas-check-ai-verdict ${isAi ? "veritas-check-ai-verdict--ai" : "veritas-check-ai-verdict--real"}`;
    ver.textContent = verdict;
    head.appendChild(title);
    head.appendChild(ver);

    const meter = document.createElement("div");
    meter.className = "veritas-check-ai-meter";
    meter.innerHTML = `<span>AI probability</span><strong>${displayPct}%</strong>`;

    const barWrap = document.createElement("div");
    barWrap.className = "veritas-check-ai-bar";
    const bar = document.createElement("span");
    bar.style.width = `${barWidth}%`;
    barWrap.appendChild(bar);

    const expl = document.createElement("p");
    expl.className = "veritas-check-ai-expl";
    expl.textContent = String(explanation || "");

    card.appendChild(head);
    card.appendChild(meter);
    card.appendChild(barWrap);
    card.appendChild(expl);
    panel.appendChild(card);
  }

  function resetCheckAiButton(btn) {
    btn.classList.remove("veritas-check-ai-btn--real", "veritas-check-ai-btn--ai");
    btn.textContent = "Check AI";
    btn.removeAttribute("aria-label");
    btn.title = "";
  }

  function setCheckAiButtonAfterResult(btn, result) {
    const isAi =
      result &&
      (result.verdict === "AI-generated" ||
        String(result.verdict || "")
          .toLowerCase()
          .includes("ai-generated"));
    btn.classList.remove("veritas-check-ai-btn--real", "veritas-check-ai-btn--ai");
    if (isAi) {
      btn.classList.add("veritas-check-ai-btn--ai");
      btn.innerHTML =
        '<svg class="veritas-check-ai-ic" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="#f87171" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
      btn.title = "Veritas: AI-generated signal — click to check again";
      btn.setAttribute("aria-label", "AI-generated signal. Click to check again.");
    } else {
      btn.classList.add("veritas-check-ai-btn--real");
      btn.innerHTML =
        '<svg class="veritas-check-ai-ic" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none"><path stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M20 6L9 17l-5-5"/></svg>';
      btn.title = "Veritas: reads as authentic — click to check again";
      btn.setAttribute("aria-label", "Reads as authentic. Click to check again.");
    }
  }

  async function checkAiAnalyze(payload) {
    if (!payload) {
      throw new Error("No capturable image or video in this post.");
    }
    const bg = await sendMessageToExtension({ type: "VERITAS_CHECK_AI", ...payload });
    if (bg && bg.ok === true && bg.data) return bg.data;
    if (bg && bg.ok === false) {
      throw new Error(formatExtensionMessagingError(bg?.error || "Check AI failed"));
    }
    if (payload.imageBase64) {
      const resp = await fetch(`${API_BASE}/check-ai`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ imageBase64: payload.imageBase64 }),
      });
      if (!resp.ok) throw new Error(`Check AI failed: ${resp.status}`);
      return resp.json();
    }
    throw new Error("Could not load image (extension background unreachable). Refresh the page and try again.");
  }

  async function checkAiAnalyzeSocitea(payload) {
    if (!payload || !payload.imageBase64) {
      throw new Error("Missing reel snap");
    }
    const bg = await sendMessageToExtension({
      type: "VERITAS_REEL_AI_SCORE",
      imageBase64: payload.imageBase64,
    });
    if (bg && bg.ok === true && bg.data) return bg.data;
    throw new Error(
      formatExtensionMessagingError(bg?.error || "Socitea score request failed")
    );
  }

  function downscaleDataUrlForSocitea(dataUrl, maxSide = 720) {
    return new Promise((resolve, reject) => {
      try {
        const img = new Image();
        img.onload = () => {
          try {
            const w = img.naturalWidth || img.width;
            const h = img.naturalHeight || img.height;
            const scale = Math.min(1, maxSide / Math.max(w, h, 1));
            const tw = Math.max(1, Math.round(w * scale));
            const th = Math.max(1, Math.round(h * scale));
            const c = document.createElement("canvas");
            c.width = tw;
            c.height = th;
            const ctx = c.getContext("2d");
            ctx.drawImage(img, 0, 0, tw, th);
            resolve(c.toDataURL("image/jpeg", 0.82));
          } catch (e) {
            reject(e);
          }
        };
        img.onerror = () => reject(new Error("Failed to load snap for resize"));
        img.src = dataUrl.startsWith("data:") ? dataUrl : `data:image/jpeg;base64,${dataUrl}`;
      } catch (e) {
        reject(e);
      }
    });
  }

  function renderReelAiScore(panel, result) {
    const score = Math.round(Number(result?.aiProbability ?? result?.score));
    const safe = Number.isFinite(score) ? Math.max(0, Math.min(100, score)) : null;
    panel.textContent = "";
    const card = document.createElement("div");
    card.className = "veritas-check-ai-card";
    const head = document.createElement("div");
    head.className = "veritas-check-ai-head";
    const title = document.createElement("span");
    title.className = "veritas-check-ai-title";
    title.textContent = "Check AI";
    const ver = document.createElement("span");
    ver.className =
      safe != null && safe >= 50
        ? "veritas-check-ai-verdict veritas-check-ai-verdict--ai"
        : "veritas-check-ai-verdict veritas-check-ai-verdict--real";
    ver.textContent = safe == null ? "—" : String(safe);
    head.appendChild(title);
    head.appendChild(ver);

    const meter = document.createElement("div");
    meter.className = "veritas-check-ai-meter";
    meter.innerHTML = `<span>AI score (0=Real · 100=AI)</span><strong>${
      safe == null ? "—" : `${safe}`
    }</strong>`;

    const barWrap = document.createElement("div");
    barWrap.className = "veritas-check-ai-bar";
    const bar = document.createElement("span");
    bar.style.width = `${safe == null ? 0 : safe}%`;
    barWrap.appendChild(bar);

    const expl = document.createElement("p");
    expl.className = "veritas-check-ai-expl";
    expl.textContent = safe == null ? "No score returned" : String(safe);

    card.appendChild(head);
    card.appendChild(meter);
    card.appendChild(barWrap);
    card.appendChild(expl);
    panel.appendChild(card);
  }

  function stopIgEventSteal(ev) {
    try {
      ev.preventDefault();
      ev.stopPropagation();
      if (typeof ev.stopImmediatePropagation === "function") ev.stopImmediatePropagation();
    } catch {
      /* ignore */
    }
  }

  function eventPathHasReelCheckAi(ev) {
    const path = typeof ev.composedPath === "function" ? ev.composedPath() : null;
    if (path && path.length) {
      return path.some(
        (n) => n && n.nodeType === 1 && n.getAttribute?.("data-veritas-reel-checkai-host") === "1"
      );
    }
    const t = ev.target;
    return !!(t && t.closest && t.closest("[data-veritas-reel-checkai-host]"));
  }

  /**
   * IG registers pause/play on document (capture). That runs before our button handlers.
   * Intercept on window (capture) first: block IG, then run Check AI ourselves.
   */
  function ensureIgReelWindowGuard() {
    if (window.__veritasIgReelWindowGuard) return;
    window.__veritasIgReelWindowGuard = true;

    const blockTypes = [
      "pointerdown",
      "pointerup",
      "mousedown",
      "mouseup",
      "touchstart",
      "touchend",
      "click",
      "dblclick",
      "contextmenu",
    ];
    for (const type of blockTypes) {
      window.addEventListener(
        type,
        (ev) => {
          if (!eventPathHasReelCheckAi(ev)) return;
          /* Stop before document/IG capture handlers see the event. */
          try {
            ev.stopPropagation();
            if (type === "click" || type === "dblclick" || type === "contextmenu") {
              ev.preventDefault();
            }
          } catch {
            /* ignore */
          }
          if (type !== "click") return;
          const path = typeof ev.composedPath === "function" ? ev.composedPath() : [];
          const btn =
            path.find((n) => n && n.classList && n.classList.contains("veritas-check-ai-btn")) ||
            (ev.target && ev.target.closest && ev.target.closest(".veritas-check-ai-btn"));
          if (btn && typeof btn._veritasRunCheckAi === "function" && !btn.disabled) {
            btn._veritasRunCheckAi();
          }
        },
        true
      );
    }
  }

  function renderReelVideoDetectResult(panel, data) {
    const aegisRaw = Number(data.detectors?.aegis?.ai_generated_probability);
    const aiProb = Number.isFinite(aegisRaw) ? aegisRaw : Number(data.ai_probability);
    const aiPct = Math.round(aiProb * 100);
    const realPct = Math.round((1 - aiProb) * 100);
    const conf = formatConfidenceLabel(data.confidence) || "Low";
    const leansAi = aiProb >= 0.5;

    if (!Number.isFinite(realPct)) {
      throw new Error("Unable to analyze this video");
    }

    panel.textContent = "";
    const card = document.createElement("div");
    card.className = "veritas-check-ai-card";

    const head = document.createElement("div");
    head.className = "veritas-check-ai-head";
    const title = document.createElement("span");
    title.className = "veritas-check-ai-title";
    title.textContent = "Real Score";
    const ver = document.createElement("span");
    ver.className = `veritas-check-ai-verdict ${
      leansAi ? "veritas-check-ai-verdict--ai" : "veritas-check-ai-verdict--real"
    }`;
    ver.textContent = String(realPct);
    head.appendChild(title);
    head.appendChild(ver);

    const meter = document.createElement("div");
    meter.className = "veritas-check-ai-meter";
    meter.innerHTML = `<span>0=AI · 100=Real</span><strong>${realPct}</strong>`;

    const barWrap = document.createElement("div");
    barWrap.className = "veritas-check-ai-bar";
    const bar = document.createElement("span");
    bar.style.width = `${clamp(realPct, 0, 100)}%`;
    barWrap.appendChild(bar);

    const expl = document.createElement("p");
    expl.className = "veritas-check-ai-expl";
    expl.textContent =
      `AI: ${Number.isFinite(aiPct) ? aiPct : "—"} · Confidence: ${conf}`;

    card.appendChild(head);
    card.appendChild(meter);
    card.appendChild(barWrap);
    card.appendChild(expl);
    panel.appendChild(card);
  }

  function attachCheckAiToHost(host, captureRoot) {
    if (host.querySelector(".veritas-check-ai-btn")) return;
    ensureIgReelWindowGuard();

    const row = document.createElement("div");
    row.className = "veritas-check-ai-row";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "veritas-check-ai-btn";
    btn.textContent = "Check AI";

    btn._veritasRunCheckAi = async () => {
      if (btn.disabled) return;
      resetCheckAiButton(btn);
      const panel = mountCheckAiPanel(host);
      delete panel.dataset.veritasCheckAiDismissed;
      panel.textContent = "";
      const loadingCard = document.createElement("div");
      loadingCard.className = "veritas-check-ai-card veritas-check-ai-card--loading";

      const onReel =
        host.getAttribute("data-veritas-reel-checkai-host") === "1" ||
        (typeof isInstagramReelSurface === "function" && isInstagram && isInstagramReelSurface());

      loadingCard.textContent = onReel ? "Analysing using AEGIS" : "Analyzing image…";
      panel.appendChild(loadingCard);
      btn.disabled = true;

      try {
        if (onReel) {
          const video =
            host._veritasCaptureRoot ||
            (captureRoot instanceof HTMLVideoElement ? captureRoot : null) ||
            findPrimaryInstagramReelVideo();
          if (!(video instanceof HTMLVideoElement)) {
            throw new Error("No reel video found");
          }

          loadingCard.textContent = "Analysing using AEGIS";
          let payload = await prepareReelScreenshotDetectPayload(video, { hideEls: [host] });
          if (!payload) {
            // Fallback: older video-clip path if screenshot capture fails.
            loadingCard.textContent = "Analysing using AEGIS";
            payload = await prepareReelSnapDetectPayload(video, { hideEls: [host] });
            if (!payload) payload = await prepareReelVideoPayload(video);
            if (!payload) {
              throw new Error(
                "Could not capture a screenshot of this reel. Try another reel or wait for playback."
              );
            }
            loadingCard.textContent = "Analysing using AEGIS";
            const data = await requestDetectVideo(payload);
            if (panel.dataset.veritasCheckAiDismissed === "1") return;
            if (!data || data.success !== true) {
              throw new Error(data?.error || "AEGIS detection failed");
            }
            renderReelVideoDetectResult(panel, data);
            setCheckAiButtonAfterResult(btn, {
              verdict: Number(data.ai_probability) >= 0.5 ? "AI-generated" : "Authentic",
            });
            return;
          }

          loadingCard.textContent = "Analysing using AEGIS";
          const data = await requestDetectImage(payload);
          if (panel.dataset.veritasCheckAiDismissed === "1") return;
          if (!data || data.success !== true) {
            throw new Error(data?.error || "AEGIS detection failed");
          }

          renderReelVideoDetectResult(panel, data);
          setCheckAiButtonAfterResult(btn, {
            verdict: Number(data.ai_probability) >= 0.5 ? "AI-generated" : "Authentic",
          });
          return;
        }

        const liveRoot = host._veritasCaptureRoot || captureRoot;
        const payload = await captureMediaForCheckAi(liveRoot, { hideEls: [host] });
        const result = await checkAiAnalyze(payload);
        if (panel.dataset.veritasCheckAiDismissed === "1") return;
        renderCheckAiResult(panel, result);
        setCheckAiButtonAfterResult(btn, result);
      } catch (e) {
        if (panel.dataset.veritasCheckAiDismissed === "1") return;
        panel.textContent = "";
        const errCard = document.createElement("div");
        errCard.className = "veritas-check-ai-card veritas-check-ai-card--err";
        const msg = String(e?.message || e || "Check AI failed");
        errCard.textContent = msg;
        panel.appendChild(errCard);
        resetCheckAiButton(btn);
      } finally {
        btn.disabled = false;
      }
    };

    /* Feed/article toolbars: normal click. Reel portal: window guard runs this instead. */
    btn.addEventListener("click", (ev) => {
      if (host.getAttribute("data-veritas-reel-checkai-host") === "1") return;
      ev.preventDefault();
      ev.stopPropagation();
      btn._veritasRunCheckAi();
    });

    row.appendChild(btn);
    host.appendChild(row);
  }

  /** Pin the portal to the reel video’s top-right (viewport coords). */
  function positionReelCheckAiHost(hostEl, video) {
    if (!hostEl || !video || !video.isConnected) return false;
    const r = video.getBoundingClientRect();
    if (r.width < 40 || r.height < 40) {
      hostEl.style.visibility = "hidden";
      return false;
    }
    const visibleH = Math.min(r.bottom, window.innerHeight) - Math.max(r.top, 0);
    const visibleW = Math.min(r.right, window.innerWidth) - Math.max(r.left, 0);
    if (visibleH < 80 || visibleW < 80) {
      hostEl.style.visibility = "hidden";
      return false;
    }
    hostEl.style.visibility = "visible";
    const pad = 10;
    const width = Math.min(340, Math.max(140, r.width - pad * 2));
    // Follow the reel (including off-screen) — do not clamp to the viewport.
    const top = r.top + pad;
    const left = r.right - width - pad;
    hostEl.style.position = "fixed";
    hostEl.style.top = `${Math.round(top)}px`;
    hostEl.style.left = `${Math.round(left)}px`;
    hostEl.style.right = "auto";
    hostEl.style.bottom = "auto";
    hostEl.style.width = `${Math.round(width)}px`;
    hostEl.style.zIndex = "2147483646";
    return true;
  }

  /** Prefer the reel with the largest on-screen intersection (IG often keeps multiple <video>s). */
  function findPrimaryInstagramReelVideo() {
    const videos = Array.from(document.querySelectorAll("video"));
    let best = null;
    let bestScore = 0;
    const vh = window.innerHeight || 1;
    const vw = window.innerWidth || 1;
    for (const v of videos) {
      const r = v.getBoundingClientRect();
      if (r.width < 80 || r.height < 120) continue;
      const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
      const visH = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
      const visibleArea = visW * visH;
      if (visibleArea < 80 * 120) continue;
      // Prefer centered / more visible reels.
      const cx = (r.left + r.right) / 2;
      const cy = (r.top + r.bottom) / 2;
      const centerDist =
        Math.abs(cx - vw / 2) / vw + Math.abs(cy - vh / 2) / vh;
      const score = visibleArea * (1.35 - Math.min(1, centerDist));
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return best;
  }

  function ensureReelVideoToken(video) {
    let t = video.getAttribute("data-veritas-reel-id");
    if (!t) {
      reelVideoIdSeq += 1;
      t = `vr_${reelVideoIdSeq}_${Date.now().toString(36)}`;
      video.setAttribute("data-veritas-reel-id", t);
    }
    return t;
  }

  function collectReelVideoSrcCandidates(video) {
    const out = [];
    const push = (u) => {
      const s = String(u || "").trim();
      if (s && !out.includes(s)) out.push(s);
    };
    push(video.currentSrc);
    push(video.src);
    video.querySelectorAll?.("source").forEach((el) => push(el.getAttribute("src") || el.src));
    return out;
  }

  /**
   * Resolve an accessible video source without bypassing DRM/CORS.
   * Returns { mode: 'url'|'blob', url } or null.
   */
  function resolveAccessibleReelSource(video) {
    const candidates = collectReelVideoSrcCandidates(video);
    for (const url of candidates) {
      if (/^https?:\/\//i.test(url)) return { mode: "url", url };
    }
    for (const url of candidates) {
      if (/^blob:/i.test(url)) return { mode: "blob", url };
    }
    return null;
  }

  /** Encode blob for service-worker detect (base64 survives messaging; ArrayBuffer often does not). */
  async function blobToDetectPayload(blob, filename) {
    if (!blob || blob.size < 256) throw new Error("empty clip");
    if (blob.size > VIDEO_AI_MAX_BASE64_CHARS * 0.75) throw new Error("clip too large");
    const buf = await blob.arrayBuffer();
    if (!buf || buf.byteLength < 256) throw new Error("empty clip");
    const videoBase64 = arrayBufferToBase64(buf);
    if (!videoBase64 || videoBase64.length > VIDEO_AI_MAX_BASE64_CHARS) {
      throw new Error("encoded clip too large");
    }
    return {
      videoBase64,
      mimeType: blob.type || "video/webm",
      filename: filename || "reel-clip.webm",
    };
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunk = 0x8000;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  /**
   * When only a playing element is available, capture a short clip via MediaRecorder
   * from the already-decoded stream (no DRM/CORS bypass).
   */
  function recordShortClipFromVideo(video, maxMs = 10000) {
    return new Promise((resolve, reject) => {
      try {
        if (typeof video.captureStream !== "function") {
          reject(new Error("captureStream unavailable"));
          return;
        }
        const stream = video.captureStream();
        if (!stream || !stream.getVideoTracks().length) {
          reject(new Error("No video track to record"));
          return;
        }
        const mimeCandidates = [
          "video/webm;codecs=vp9",
          "video/webm;codecs=vp8",
          "video/webm",
        ];
        const mimeType = mimeCandidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
        if (!mimeType || typeof MediaRecorder === "undefined") {
          reject(new Error("MediaRecorder unavailable"));
          return;
        }
        const chunks = [];
        const rec = new MediaRecorder(stream, { mimeType });
        const timer = window.setTimeout(() => {
          try {
            if (rec.state !== "inactive") rec.stop();
          } catch {
            /* ignore */
          }
        }, maxMs);
        rec.ondataavailable = (ev) => {
          if (ev.data && ev.data.size) chunks.push(ev.data);
        };
        rec.onerror = () => {
          window.clearTimeout(timer);
          reject(new Error("MediaRecorder failed"));
        };
        rec.onstop = () => {
          window.clearTimeout(timer);
          stream.getTracks().forEach((t) => t.stop());
          if (!chunks.length) {
            reject(new Error("Empty recording"));
            return;
          }
          resolve(new Blob(chunks, { type: mimeType }));
        };
        rec.start(500);
      } catch (e) {
        reject(e);
      }
    });
  }

  function sleepMs(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  /**
   * One snap of the playing reel: canvas frame if readable, else tab-region crop.
   * Does not bypass DRM/CORS — only reads pixels already shown on screen.
   */
  async function captureSingleReelSnap(video, hideEls) {
    if (!(video instanceof HTMLVideoElement)) return null;
    const direct = tryCaptureVideoFrame(video);
    if (direct?.imageBase64) return direct.imageBase64;
    const shot = await captureTabRegionForElement(video, hideEls || []);
    if (shot?.imageBase64) return shot.imageBase64;
    return null;
  }

  /**
   * Sample snaps while the reel plays (or repeat one snap) so AEGIS/VideoMAE
   * receive a short video built from on-screen frames.
   */
  async function captureReelSnapsForDetect(video, hideEls, count = 16) {
    const frames = [];
    const n = Math.max(1, Math.min(16, count));
    for (let i = 0; i < n; i++) {
      const snap = await captureSingleReelSnap(video, hideEls);
      if (snap) frames.push(snap);
      if (i < n - 1) await sleepMs(110);
    }
    if (!frames.length) return [];
    while (frames.length < 16) frames.push(frames[frames.length - 1]);
    return frames.slice(0, 16);
  }

  function loadImageFromDataUrl(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to load snap"));
      img.src = dataUrl.startsWith("data:")
        ? dataUrl
        : `data:image/jpeg;base64,${dataUrl}`;
    });
  }

  /**
   * Encode snap frames into a short WebM clip for POST /api/detect-video.
   */
  async function encodeSnapsToWebmBlob(dataUrls) {
    if (!dataUrls?.length) throw new Error("No snaps to encode");
    const images = [];
    for (const url of dataUrls) {
      images.push(await loadImageFromDataUrl(url));
    }

    const w = Math.max(2, images[0].naturalWidth || images[0].width || 320);
    const h = Math.max(2, images[0].naturalHeight || images[0].height || 320);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unavailable");

    const mimeCandidates = [
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    const mimeType =
      mimeCandidates.find((m) => window.MediaRecorder?.isTypeSupported?.(m)) || "";
    if (!mimeType || typeof MediaRecorder === "undefined") {
      throw new Error("MediaRecorder unavailable");
    }

    const stream = canvas.captureStream(8);
    const chunks = [];
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 1_200_000 });

    const done = new Promise((resolve, reject) => {
      rec.ondataavailable = (ev) => {
        if (ev.data && ev.data.size) chunks.push(ev.data);
      };
      rec.onerror = () => reject(new Error("Failed to encode reel snap"));
      rec.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        if (!chunks.length) {
          reject(new Error("Empty snap encoding"));
          return;
        }
        resolve(new Blob(chunks, { type: mimeType }));
      };
    });

    rec.start(200);
    const frameMs = 120;
    for (let i = 0; i < images.length; i++) {
      ctx.fillStyle = "#000";
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(images[i], 0, 0, w, h);
      await sleepMs(frameMs);
    }
    // Hold last frame briefly so the recorder flushes.
    await sleepMs(250);
    if (rec.state !== "inactive") rec.stop();
    return done;
  }

  /**
   * Check AI on Reels: capture on-screen screenshot(s) → AEGIS + VideoMAE.
   * Server turns stills into a short clip (models expect video tensors).
   */
  async function prepareReelScreenshotDetectPayload(video, opts) {
    const hideEls = opts?.hideEls || [];
    try {
      // A few snaps while the reel plays give VideoMAE more signal than one freeze-frame.
      const snaps = await captureReelSnapsForDetect(video, hideEls, 8);
      if (snaps.length >= 2) {
        return { imagesBase64: snaps };
      }
      if (snaps.length === 1) {
        return { imageBase64: snaps[0] };
      }
      const one = await captureSingleReelSnap(video, hideEls);
      if (!one) return null;
      return { imageBase64: one };
    } catch {
      return null;
    }
  }

  /**
   * Check AI on Reels: snap the on-screen reel → short clip → AEGIS + VideoMAE.
   */
  async function prepareReelSnapDetectPayload(video, opts) {
    const hideEls = opts?.hideEls || [];
    try {
      const snaps = await captureReelSnapsForDetect(video, hideEls, 16);
      if (!snaps.length) return null;
      const blob = await encodeSnapsToWebmBlob(snaps);
      return await blobToDetectPayload(blob, "reel-snap.webm");
    } catch {
      return null;
    }
  }

  async function prepareReelVideoPayload(video) {
    const access = resolveAccessibleReelSource(video);

    if (access?.mode === "url") {
      return { videoUrl: access.url, filename: "reel.mp4" };
    }

    if (access?.mode === "blob") {
      try {
        const resp = await fetch(access.url);
        if (!resp.ok) throw new Error(`blob fetch ${resp.status}`);
        const blob = await resp.blob();
        return await blobToDetectPayload(blob, "reel.mp4");
      } catch {
        /* fall through to captureStream */
      }
    }

    try {
      const clip = await recordShortClipFromVideo(video, 10000);
      return await blobToDetectPayload(clip, "reel-clip.webm");
    } catch {
      return null;
    }
  }

  async function requestDetectImage(payload) {
    const bg = await sendMessageToExtension({ type: "VERITAS_DETECT_IMAGE", ...payload });
    if (bg) {
      if (bg.ok === true && bg.data && bg.data.success === true) return bg.data;
      const err = formatExtensionMessagingError(bg?.error || "Unable to analyze this screenshot");
      if (/failed to fetch|ECONNREFUSED|could not reach|network/i.test(err)) {
        throw new Error(
          "Cannot reach AEGIS/VideoMAE. Open http://127.0.0.1:5051/health in Chrome — if it fails, run: npm run install-autostart"
        );
      }
      throw new Error(err);
    }
    throw new Error(
      "Extension background unreachable. Reload Veritas on chrome://extensions, then refresh this tab."
    );
  }

  async function requestDetectVideo(payload) {
    const bg = await sendMessageToExtension({ type: "VERITAS_DETECT_VIDEO", ...payload });
    if (bg) {
      if (bg.ok === true && bg.data && bg.data.success === true) return bg.data;
      const err = formatExtensionMessagingError(bg?.error || "Unable to analyze this video");
      if (/failed to fetch|ECONNREFUSED|could not reach|network/i.test(err)) {
        throw new Error(
          "Cannot reach AEGIS/VideoMAE. Open http://127.0.0.1:5051/health in Chrome — if it fails, run: npm run install-autostart"
        );
      }
      throw new Error(err);
    }
    throw new Error(
      "Extension background unreachable. Reload Veritas on chrome://extensions, then refresh this tab."
    );
  }

  function formatConfidenceLabel(confidence) {
    const c = String(confidence || "").toLowerCase();
    if (c === "high") return "High";
    if (c === "medium") return "Medium";
    if (c === "low") return "Low";
    return "";
  }

  /**
   * Instagram Reels: mount Check AI as a fixed portal on document.body.
   * Must NOT live under the video tree — IG’s pause/play hit-layer sits above
   * in-player children and steals clicks (reel pauses instead of Check AI).
   */
  function scanInstagramReelCheckAi() {
    if (!isInstagram) return;
    if (window.self !== window.top) return;
    injectStyleOnce();

    if (!isInstagramReelSurface()) {
      document.querySelectorAll("[data-veritas-reel-checkai-host]").forEach((n) => n.remove());
      return;
    }

    const video = findPrimaryInstagramReelVideo();
    if (!video) {
      // Mid-swipe gap: hide existing portal but keep it for a moment.
      document.querySelectorAll("[data-veritas-reel-checkai-host]").forEach((hostEl) => {
        hostEl.style.visibility = "hidden";
      });
      return;
    }

    const token = ensureReelVideoToken(video);
    let hostEl = document.querySelector("[data-veritas-reel-checkai-host]");

    /* Migrate old absolute-in-player mounts (under IG video tree) → body portal. */
    if (hostEl && hostEl.parentElement !== document.body) {
      hostEl.remove();
      hostEl = null;
    }

    const prevToken = hostEl?.getAttribute("data-veritas-for-video");
    const reelChanged = !hostEl || prevToken !== token || hostEl._veritasCaptureRoot !== video;

    if (!hostEl) {
      hostEl = document.createElement("div");
      hostEl.setAttribute("data-veritas-reel-checkai-host", "1");
      hostEl.className = "veritas-ig-reel-overlay";
      document.body.appendChild(hostEl);
      attachCheckAiToHost(hostEl, video);
    } else if (reelChanged) {
      // New reel: clear previous score, reset button, rebind capture root.
      hostEl.setAttribute("data-veritas-for-video", token);
      const panel = hostEl.querySelector(".veritas-check-ai-panel");
      if (panel) {
        panel.textContent = "";
        panel.dataset.veritasCheckAiDismissed = "1";
      }
      const btn = hostEl.querySelector(".veritas-check-ai-btn");
      if (btn) resetCheckAiButton(btn);
      if (!hostEl.querySelector(".veritas-check-ai-btn")) {
        attachCheckAiToHost(hostEl, video);
      }
    }

    hostEl.setAttribute("data-veritas-for-video", token);
    hostEl._veritasCaptureRoot = video;
    hostEl.querySelectorAll(".veritas-video-ai-badge").forEach((n) => n.remove());
    positionReelCheckAiHost(hostEl, video);
  }

  function findCandidatePosts() {
    const set = new Set();
    for (const sel of ["article", '[role="article"]']) {
      document.querySelectorAll(sel).forEach((node) => {
        if (node && node.nodeType === 1) set.add(node);
      });
    }
    const all = Array.from(set);
    return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  }

  async function analyze(text) {
    const body = {
      text: String(text || "").slice(0, 5000),
      username: "",
      source: "extension",
    };

    // https:// pages cannot fetch http://localhost (mixed content). Service worker can.
    const bg = await sendMessageToExtension({ type: "VERITAS_ANALYZE", ...body });
    if (bg) {
      if (bg.ok === true && bg.data) return bg.data;
      throw new Error(formatExtensionMessagingError(bg?.error || "Analyze failed"));
    }

    const resp = await fetch(`${API_BASE}/analyze`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) throw new Error(`Analyze failed: ${resp.status}`);
    return resp.json();
  }

  function renderCard({ finalScore, aiGeneratedProbability }) {
    const score = clamp(Math.round(finalScore), 0, 100);
    const aiProbPct = clamp(Math.round(Number(aiGeneratedProbability) * 100), 0, 100);
    const t = tone(score);

    const card = document.createElement("div");
    card.className = "veritas-card";

    const row = document.createElement("div");
    row.className = "veritas-row";

    const badge = document.createElement("div");
    badge.className = "veritas-badge";
    badge.textContent = `Veritas: ${score}%`;

    const pill = document.createElement("div");
    pill.className = "veritas-pill";
    pill.innerHTML = `<span class="veritas-score">${aiProbPct}%</span>&nbsp;AI likelihood`;

    const status = document.createElement("div");
    status.className = "veritas-pill";
    status.innerHTML =
      t === "ok"
        ? `<span class="veritas-ok">High credibility</span>`
        : t === "mid"
          ? `<span style="color:#FDE68A">Medium credibility</span>`
          : `<span class="veritas-warn">Low credibility</span>`;

    row.appendChild(badge);
    row.appendChild(pill);
    row.appendChild(status);

    const aiFlag = document.createElement("div");
    aiFlag.className = "veritas-insight";
    aiFlag.innerHTML =
      aiProbPct >= 60
        ? `<span class="veritas-warn">⚠ Possibly AI-generated</span>`
        : `<span class="veritas-ok">Likely human-authored</span>`;

    card.appendChild(row);
    card.appendChild(aiFlag);
    return card;
  }

  function buildFactCheckLogoSvg(gradientId) {
    return `<svg class="veritas-fc-svg" viewBox="0 0 48 52" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="${gradientId}" x1="4" y1="2" x2="44" y2="50" gradientUnits="userSpaceOnUse">
      <stop stop-color="#c084fc"/>
      <stop offset="0.45" stop-color="#7c3aed"/>
      <stop offset="1" stop-color="#2563eb"/>
    </linearGradient>
  </defs>
  <path fill="url(#${gradientId})" d="M24 2 L38 4 L30 20 L38 20 L24 50 L10 20 L18 20 L10 4 Z"/>
</svg>`;
  }

  function extractArticleTextFromPost(rootEl) {
    return String(rootEl?.innerText || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100000);
  }

  function ensureFactCheckLogoOnPost(articleEl) {
    // Fact-check post button removed everywhere — strip any leftover UI.
    if (!articleEl) return;
    articleEl
      .querySelectorAll(
        "[data-veritas-fc-wrap], [data-veritas-fc-logo], .veritas-fc-anchor, .veritas-fc-popover, .veritas-fc-logo-btn"
      )
      .forEach((n) => n.remove());
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function getFactCheckLogoButton(panel) {
    const s = panel.previousElementSibling;
    return s && s.matches && s.matches(".veritas-fc-logo-btn") ? s : null;
  }

  function buildFactCheckTopBar(panel) {
    const wrap = document.createElement("div");
    wrap.className = "veritas-fc-topbar";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "veritas-fc-back-btn";
    back.setAttribute("aria-label", "Back");
    back.title = "Close";
    back.innerHTML = '<span aria-hidden="true">←</span> Back';
    back.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      panel.dataset.veritasFactCheckDismissed = "1";
      panel.classList.remove("veritas-fc-popover--open");
      panel.textContent = "";
      const logo = getFactCheckLogoButton(panel);
      if (logo) logo.disabled = false;
    });
    wrap.appendChild(back);
    return wrap;
  }

  function ensurePostToolbarHost(el) {
    let host = el.querySelector("[data-veritas-post-host]");
    if (!host) {
      host = document.createElement("div");
      host.setAttribute("data-veritas-post-host", "1");
      host.className = "veritas-post-toolbar";
      el.appendChild(host);
    }
    return host;
  }

  const X_TEXT_AI_THRESHOLD = 0.5;

  function xTextOriginIconSvg(isAi) {
    if (isAi) {
      return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path fill="#f87171" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>';
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none"><path stroke="#4ade80" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" d="M20 6L9 17l-5-5"/></svg>';
  }

  function mountXTextOriginRow(host) {
    if (host.querySelector("[data-veritas-x-text-origin-row]")) return;
    const row = document.createElement("div");
    row.className = "veritas-x-text-origin-row";
    row.setAttribute("data-veritas-x-text-origin-row", "1");
    const inner = document.createElement("span");
    inner.className = "veritas-x-text-origin veritas-x-text-origin--loading";
    inner.setAttribute("aria-busy", "true");
    inner.setAttribute("aria-label", "Analyzing post text for AI vs human style");
    inner.title = "Analyzing text (AI vs human)…";
    inner.textContent = "···";
    row.appendChild(inner);
    host.insertBefore(row, host.firstChild);
  }

  function setXTextOriginFromResult(host, result, scoreCard) {
    const row = host.querySelector("[data-veritas-x-text-origin-row]");
    if (!row || !scoreCard) return;
    const p = Number(result?.aiGeneratedProbability);
    const aiLikely = Number.isFinite(p) ? p >= X_TEXT_AI_THRESHOLD : false;
    const expl = String(result?.explanation || "").trim();
    const label = expl || (aiLikely ? "Likely AI-generated text" : "Likely human-written text");
    if (!scoreCard.id) {
      scoreCard.id = `vxsc_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    }
    row.innerHTML = "";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `veritas-x-text-origin ${aiLikely ? "veritas-x-text-origin--ai" : "veritas-x-text-origin--human"}`;
    btn.title = `${label} — Click to show or hide Veritas scores`;
    btn.setAttribute("aria-label", `${label}. Veritas scores hidden. Click to show.`);
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", scoreCard.id);
    btn.innerHTML = xTextOriginIconSvg(aiLikely);
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      scoreCard.classList.toggle("veritas-card--x-hidden");
      const visible = !scoreCard.classList.contains("veritas-card--x-hidden");
      btn.setAttribute("aria-expanded", visible ? "true" : "false");
      btn.setAttribute(
        "aria-label",
        visible
          ? `${label}. Veritas scores visible. Click to hide.`
          : `${label}. Veritas scores hidden. Click to show.`
      );
    });
    row.appendChild(btn);
  }

  function setXTextOriginError(host) {
    const row = host.querySelector("[data-veritas-x-text-origin-row]");
    if (!row) return;
    row.innerHTML = "";
    const span = document.createElement("span");
    span.className = "veritas-x-text-origin veritas-x-text-origin--err";
    span.setAttribute("role", "img");
    span.title = "Could not analyze text";
    span.setAttribute("aria-label", "Could not analyze text");
    span.textContent = "—";
    row.appendChild(span);
  }

  async function processPost(el) {
    if (el.getAttribute(TAG_ATTR) === "1") return;
    el.setAttribute(TAG_ATTR, "1");

    ensureFactCheckLogoOnPost(el);

    const host = ensurePostToolbarHost(el);
    // Check AI vision toolbar: Instagram/etc. only — not X or LinkedIn.
    if (!isX && !isLinkedIn) attachCheckAiToHost(host, el);
    if (isLinkedIn) {
      el.querySelectorAll(".veritas-check-ai-row, .veritas-check-ai-panel").forEach((n) => n.remove());
    }

    /** X: AI tick on the post toolbar (fact-check logo removed). */
    let xOriginContainer = host;
    if (isX) {
      mountXTextOriginRow(xOriginContainer);
    }

    const text = postTextFromElement(el);
    if (!text || text.length < 10) return;

    try {
      const result = await analyze(text);
      const card = renderCard(result);
      if (isX) {
        card.classList.add("veritas-card--x-hidden");
        card.setAttribute("data-veritas-x-score-card", "1");
        setXTextOriginFromResult(xOriginContainer, result, card);
      }
      host.appendChild(card);
    } catch {
      if (isX) setXTextOriginError(xOriginContainer);
      /* backend down */
    }
  }

  function scanFeed() {
    injectStyleOnce();
    // Remove fact-check post button everywhere (legacy injections).
    document
      .querySelectorAll(
        "[data-veritas-fc-wrap], [data-veritas-fc-logo], .veritas-fc-anchor, .veritas-fc-popover, .veritas-fc-logo-btn"
      )
      .forEach((n) => n.remove());
    if (isLinkedIn) {
      // Strip leftover Check AI controls from LinkedIn (notifications / feed).
      document
        .querySelectorAll(".veritas-check-ai-row, .veritas-check-ai-panel, .veritas-check-ai-btn")
        .forEach((n) => n.remove());
    }
    const posts = findCandidatePosts();
    for (const el of posts) processPost(el);
  }

  function runSocialAccountScanners() {
    if (isX) scanXAccountBadges();
    if (isLinkedIn) scanLinkedInAccountBadges();
    if (isReddit) scanRedditAccountBadges();
  }

  function scrapeAmazonReviewTexts() {
    const seen = new Set();
    const out = [];
    const blocks = document.querySelectorAll(
      '[data-hook="review"], [id^="customer_review"], [id^="customerReviews"] [data-hook="review"]'
    );
    blocks.forEach((block) => {
      const body =
        block.querySelector('[data-hook="review-body"]') ||
        block.querySelector(".review-text-content") ||
        block.querySelector(".review-text");
      const t = (body?.innerText || "").replace(/\s+/g, " ").trim();
      if (t.length < 18) return;
      const key = t.slice(0, 160);
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t.slice(0, 6000));
    });
    if (out.length < 3) {
      document.querySelectorAll('[data-hook="review-body"]').forEach((body) => {
        const t = (body.innerText || "").replace(/\s+/g, " ").trim();
        if (t.length < 18) return;
        const key = t.slice(0, 160);
        if (seen.has(key)) return;
        seen.add(key);
        out.push(t.slice(0, 6000));
      });
    }
    return out.slice(0, 50);
  }

  async function analyzeAmazonReviewsTrustClient(reviewsText) {
    const bg = await sendMessageToExtension({
      type: "VERITAS_AMAZON_REVIEW_TRUST",
      reviewsText,
    });
    if (bg && bg.ok === true && bg.data) return bg.data;
    if (bg && bg.ok === false) {
      throw new Error(formatExtensionMessagingError(bg?.error || "Review analysis failed"));
    }
    const resp = await fetch(`${API_BASE}/amazon-review-trust`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewsText }),
    });
    if (!resp.ok) throw new Error(`Review trust failed: ${resp.status}`);
    return resp.json();
  }

  function renderAmazonTrustPanel(panel, data) {
    const ts = clamp(Math.round(Number(data.trustScore)), 0, 100);
    const verdict = escapeHtml(String(data.verdict || "Mixed Signals"));
    const summary = escapeHtml(String(data.summary || ""));
    const issues = Array.isArray(data.issues) ? data.issues : [];
    const issuesLis = issues
      .slice(0, 14)
      .map((i) => `<li>${escapeHtml(String(i))}</li>`)
      .join("");
    panel.innerHTML = `
      <div class="veritas-amazon-result">
        <div class="veritas-amazon-row">
          <span class="veritas-amazon-score">${ts}</span>
          <span class="veritas-amazon-verdict">${verdict}</span>
        </div>
        <p class="veritas-amazon-summary">${summary}</p>
        <ul class="veritas-amazon-issues">${issuesLis || "<li>None listed</li>"}</ul>
      </div>`;
  }

  function initAmazonReviewTrustDock() {
    injectStyleOnce();
    if (!isAmazonProductReviewsPage()) return;
    if (document.getElementById("veritas-amazon-root")) return;

    const root = document.createElement("div");
    root.id = "veritas-amazon-root";
    root.className = "veritas-amazon-dock";

    const inner = document.createElement("div");
    inner.className = "veritas-amazon-dock-inner";

    const title = document.createElement("div");
    title.className = "veritas-amazon-dock-title";
    title.textContent = "Veritas · Amazon reviews";

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "veritas-amazon-dock-btn";
    btn.textContent = "Score review trust";

    const panel = document.createElement("div");
    panel.className = "veritas-amazon-dock-panel";
    panel.style.display = "none";

    btn.addEventListener("click", async () => {
      panel.style.display = "block";
      panel.innerHTML = '<div class="veritas-amazon-loading">Reading reviews…</div>';
      btn.disabled = true;
      try {
        const snippets = scrapeAmazonReviewTexts();
        if (snippets.length < 1) {
          panel.innerHTML =
            '<div class="veritas-amazon-err">No review text found. Scroll to load reviews, then try again.</div>';
          return;
        }
        const reviewsText = snippets.map((t, i) => `--- Review ${i + 1} ---\n${t}`).join("\n\n");
        if (reviewsText.length < 40) {
          panel.innerHTML =
            '<div class="veritas-amazon-err">Not enough review text. Scroll to load more reviews.</div>';
          return;
        }
        const data = await analyzeAmazonReviewsTrustClient(reviewsText);
        renderAmazonTrustPanel(panel, data);
      } catch (e) {
        panel.innerHTML = `<div class="veritas-amazon-err">${escapeHtml(String(e?.message || e))}</div>`;
      } finally {
        btn.disabled = false;
      }
    });

    inner.appendChild(title);
    inner.appendChild(btn);
    inner.appendChild(panel);
    root.appendChild(inner);
    document.body.appendChild(root);
  }

  let amazonInlineTimer = null;
  let amazonInlineRunning = false;

  function inlineAmazonCredClass(score) {
    const s = clamp(Math.round(Number(score)), 0, 100);
    if (s >= 70) return "veritas-amazon-inline-score--high";
    if (s >= 45) return "veritas-amazon-inline-score--mid";
    return "veritas-amazon-inline-score--low";
  }

  function collectAmazonReviewBlockRoots() {
    const set = new Set();
    document.querySelectorAll('[data-hook="review"]').forEach((n) => set.add(n));
    return Array.from(set);
  }

  function getAmazonReviewBodyForBlock(block) {
    const body =
      block.querySelector('[data-hook="review-body"]') ||
      block.querySelector(".review-text-content") ||
      block.querySelector(".review-text");
    return (body?.innerText || "").replace(/\s+/g, " ").trim();
  }

  function findAmazonAuthorNameElement(block) {
    return (
      block.querySelector("span.a-profile-name") ||
      block.querySelector(".a-profile-content .a-profile-name") ||
      block.querySelector(".a-profile-name") ||
      block.querySelector('[data-hook="review-author"] a') ||
      block.querySelector(".a-profile-display-name a") ||
      block.querySelector(".a-profile-display-name")
    );
  }

  function getAmazonAuthorLabel(block) {
    const el = findAmazonAuthorNameElement(block);
    return (el?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200) || "Reviewer";
  }

  async function analyzeAmazonInlineScoresClient(reviews) {
    const bg = await sendMessageToExtension({
      type: "VERITAS_AMAZON_INLINE_SCORES",
      reviews,
    });
    if (bg && bg.ok === true && bg.data) return bg.data;
    if (bg && bg.ok === false) {
      throw new Error(formatExtensionMessagingError(bg?.error || "Inline scores failed"));
    }
    const resp = await fetch(`${API_BASE}/amazon-review-scores`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviews }),
    });
    if (!resp.ok) throw new Error(`Inline scores failed: ${resp.status}`);
    return resp.json();
  }

  function scheduleAmazonInlineScores() {
    window.clearTimeout(amazonInlineTimer);
    amazonInlineTimer = window.setTimeout(() => {
      runAmazonInlineCredibilityScores().catch(() => {});
    }, 1100);
  }

  async function runAmazonInlineCredibilityScores() {
    if (!isAmazonProductReviewsPage() || amazonInlineRunning) return;

    const roots = collectAmazonReviewBlockRoots();
    const pending = [];

    for (const block of roots) {
      if (block.querySelector("[data-veritas-inline-badge]")) continue;
      const text = getAmazonReviewBodyForBlock(block);
      if (text.length < 12) continue;
      const nameEl = findAmazonAuthorNameElement(block);
      if (!nameEl) continue;

      amazonReviewUid += 1;
      const id = `vz_${amazonReviewUid}_${Date.now().toString(36)}`;
      block.dataset.veritasRid = id;

      const badge = document.createElement("span");
      badge.setAttribute("data-veritas-inline-badge", "1");
      badge.className = "veritas-amazon-inline-score veritas-amazon-inline-score--loading";
      badge.textContent = "…";
      badge.title = "Veritas: scoring this review…";
      nameEl.insertAdjacentElement("afterend", badge);

      pending.push({
        id,
        author: getAmazonAuthorLabel(block),
        text: text.slice(0, 7800),
        badgeEl: badge,
      });
    }

    if (pending.length === 0) return;

    amazonInlineRunning = true;
    const MAX = 24;
    try {
      for (let i = 0; i < pending.length; i += MAX) {
        const chunk = pending.slice(i, i + MAX);
        const payload = chunk.map(({ id, author, text }) => ({ id, author, text }));
        const data = await analyzeAmazonInlineScoresClient(payload);
        const scores = Array.isArray(data.scores) ? data.scores : [];
        const map = new Map(scores.map((s) => [String(s.id), s.credibilityScore]));

        for (const row of chunk) {
          const sc = map.get(row.id);
          const badge = row.badgeEl;
          if (!badge?.isConnected) continue;
          if (sc === undefined) {
            badge.textContent = "?";
            badge.classList.remove("veritas-amazon-inline-score--loading");
            badge.classList.add("veritas-amazon-inline-score--mid");
            badge.title = "Veritas: could not map score for this review";
            continue;
          }
          const v = clamp(Math.round(Number(sc)), 0, 100);
          badge.textContent = String(v);
          badge.classList.remove("veritas-amazon-inline-score--loading");
          badge.classList.add(inlineAmazonCredClass(v));
          badge.title = `Veritas: estimated credibility of this review — ${v}/100 (informational only)`;
        }
      }
    } catch (e) {
      pending.forEach(({ badgeEl }) => {
        if (badgeEl?.isConnected && badgeEl.classList.contains("veritas-amazon-inline-score--loading")) {
          badgeEl.textContent = "!";
          badgeEl.classList.remove("veritas-amazon-inline-score--loading");
          badgeEl.classList.add("veritas-amazon-inline-score--err");
          badgeEl.title = String(e?.message || e);
        }
      });
    } finally {
      amazonInlineRunning = false;
    }
  }

  async function factCheckClient(payload) {
    const bg = await sendMessageToExtension({
      type: "VERITAS_FACT_CHECK",
      text: payload.text,
      url: payload.url,
      title: payload.title,
    });
    if (bg && bg.ok === true && bg.data) return bg.data;
    if (bg && bg.ok === false) {
      throw new Error(formatExtensionMessagingError(bg?.error || "Fact check failed"));
    }
    const resp = await fetch(`${API_BASE}/fact-check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`Fact check failed: ${resp.status}`);
    return resp.json();
  }

  function renderFactCheckResult(panel, data) {
    if (panel.dataset.veritasFactCheckDismissed === "1") return;
    const score = clamp(Math.round(Number(data.truthScore)), 0, 100);
    panel.textContent = "";
    panel.appendChild(buildFactCheckTopBar(panel));
    const natureEl = document.createElement("div");
    natureEl.className = "veritas-factcheck-nature";
    natureEl.textContent = String(data.contentLabel || "Context");
    const claimEl = document.createElement("div");
    claimEl.className = "veritas-factcheck-claim";
    claimEl.textContent = String(data.mainClaim || "");

    const row = document.createElement("div");
    row.className = "veritas-factcheck-row";
    const scoreEl = document.createElement("span");
    scoreEl.className = "veritas-factcheck-score";
    scoreEl.textContent = String(score);
    const verEl = document.createElement("span");
    verEl.className = "veritas-factcheck-verdict";
    verEl.textContent = String(data.verdict || "Unverified");
    row.appendChild(scoreEl);
    row.appendChild(verEl);

    const explP = document.createElement("p");
    explP.className = "veritas-factcheck-expl";
    explP.textContent = String(data.explanation || "");

    const counts = data.sourceCounts || {};
    const srcMeta = document.createElement("div");
    srcMeta.className = "veritas-factcheck-sources";
    srcMeta.textContent = `Sources: NewsAPI ${counts.newsapi ?? 0} · GNews ${counts.gnews ?? 0} · WorldNews ${counts.worldnews ?? 0} · TheNewsAPI ${counts.thenews ?? 0}`;

    const linkWrap = document.createElement("div");
    linkWrap.className = "veritas-factcheck-links";
    const samples = Array.isArray(data.sourcesSample) ? data.sourcesSample.slice(0, 5) : [];
    for (const s of samples) {
      const u = String(s.url || "").trim();
      if (!/^https?:\/\//i.test(u)) continue;
      const a = document.createElement("a");
      a.href = u;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = String(s.title || s.outlet || "Source");
      linkWrap.appendChild(a);
    }

    panel.appendChild(natureEl);
    panel.appendChild(claimEl);
    panel.appendChild(row);
    panel.appendChild(explP);
    panel.appendChild(srcMeta);
    panel.appendChild(linkWrap);
  }

  /** Amazon shopping only: SPA navigation does not reload this script — poll + observe. */
  if (isAmazonRetailHost()) {
    if (window.self !== window.top) {
      return;
    }
    const runAmazonDock = () => {
      if (!isAmazonProductReviewsPage()) {
        const r = document.getElementById("veritas-amazon-root");
        if (r) r.remove();
        return;
      }
      if (!document.getElementById("veritas-amazon-root")) initAmazonReviewTrustDock();
      scheduleAmazonInlineScores();
    };
    runAmazonDock();
    window.setInterval(runAmazonDock, 1600);
    window.addEventListener("popstate", runAmazonDock);
    const amazonObs = new MutationObserver(() => {
      window.clearTimeout(amazonObs._t);
      amazonObs._t = window.setTimeout(runAmazonDock, 650);
    });
    amazonObs.observe(document.documentElement, { childList: true, subtree: true });
    return;
  }

  if (isInstagram) {
    const runIg = () => {
      scanInstagram();
      scanFeed();
      scanInstagramReelCheckAi();
    };
    runIg();
    const obs = new MutationObserver(() => {
      window.clearTimeout(scanInstagram._t);
      scanInstagram._t = window.setTimeout(runIg, 500);
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    /* IG Reels often animate with transforms (no window scroll). Poll + listen widely. */
    let reelPosRaf = 0;
    const tickReelPortal = () => {
      if (reelPosRaf) return;
      reelPosRaf = requestAnimationFrame(() => {
        reelPosRaf = 0;
        scanInstagramReelCheckAi();
      });
    };
    window.addEventListener("scroll", tickReelPortal, true);
    window.addEventListener("resize", tickReelPortal);
    window.addEventListener("wheel", tickReelPortal, { passive: true, capture: true });
    window.addEventListener("touchstart", tickReelPortal, { passive: true, capture: true });
    window.addEventListener("touchmove", tickReelPortal, { passive: true, capture: true });
    window.addEventListener("touchend", tickReelPortal, { passive: true, capture: true });
    // Fallback: IG virtualized feed updates without scroll events.
    window.setInterval(() => {
      if (isInstagramReelSurface()) tickReelPortal();
    }, 400);

    // Instagram SPA: profile / feed navigations don't reload the extension.
    let igLastPath = "";
    let igBurstTimer = null;
    const kickIgProfileBurst = () => {
      const ph = getInstagramProfileHandleFromPath();
      if (!ph) {
        if (igBurstTimer) {
          window.clearInterval(igBurstTimer);
          igBurstTimer = null;
        }
        return;
      }
      if (igBurstTimer) window.clearInterval(igBurstTimer);
      let tries = 0;
      const tick = () => {
        tries += 1;
        try {
          scanInstagram();
        } catch {
          /* ignore */
        }
        const uname = findInstagramProfileUsernameNode(ph);
        const ok = uname && igHandleAlreadyBadgedNear(uname, ph);
        if (ok || tries >= 50) {
          window.clearInterval(igBurstTimer);
          igBurstTimer = null;
        }
      };
      tick();
      igBurstTimer = window.setInterval(tick, 150);
    };
    const onIgPathMaybeChanged = () => {
      const path = location.pathname || "";
      if (path === igLastPath) return;
      igLastPath = path;
      document.querySelectorAll(`[${IG_TAG}="1"]`).forEach((el) => el.removeAttribute(IG_TAG));
      kickIgProfileBurst();
      try {
        scanInstagram();
      } catch {
        /* ignore */
      }
    };
    try {
      const _push = history.pushState.bind(history);
      const _replace = history.replaceState.bind(history);
      history.pushState = function (...args) {
        const ret = _push(...args);
        onIgPathMaybeChanged();
        return ret;
      };
      history.replaceState = function (...args) {
        const ret = _replace(...args);
        onIgPathMaybeChanged();
        return ret;
      };
    } catch {
      /* ignore */
    }
    window.addEventListener("popstate", onIgPathMaybeChanged);
    window.setInterval(onIgPathMaybeChanged, 500);
    onIgPathMaybeChanged();
    return;
  }

  /* X feed runs in the top frame; subframes rarely contain the timeline and duplicate work. */
  if (isX && window.self !== window.top) {
    return;
  }

  runSocialAccountScanners();
  scanFeed();

  const obs = new MutationObserver(() => {
    window.clearTimeout(scanFeed._t);
    const delay = isLinkedIn && getLinkedInProfileVanityFromPath() ? 180 : 650;
    scanFeed._t = window.setTimeout(() => {
      runSocialAccountScanners();
      scanFeed();
    }, delay);
  });

  obs.observe(document.documentElement, { childList: true, subtree: true });

  // LinkedIn is an SPA: clicking a profile does NOT reload the extension.
  // One-shot timeouts at boot never run again — so poll hard on every /in/ navigation.
  if (isLinkedIn) {
    let liBurstTimer = null;
    let liLastPath = "";

    function clearLinkedInProfileBurst() {
      if (liBurstTimer) {
        window.clearInterval(liBurstTimer);
        liBurstTimer = null;
      }
    }

    function linkedinProfileBadgePresent(profileKey) {
      if (!profileKey) return false;
      const nameEl = findLinkedInProfileNameNode();
      const badge = document.querySelector(
        `.veritas-ig-realness[data-veritas-score-key="${CSS.escape(profileKey)}"]`
      );
      if (!badge || !badge.isConnected) return false;
      if (!nameEl) return true; // badge exists; name node may still be mounting
      return (
        nameEl.nextElementSibling === badge ||
        badge.previousElementSibling === nameEl ||
        (nameEl.parentElement && badge.parentElement === nameEl.parentElement)
      );
    }

    function kickLinkedInProfileScoreBurst() {
      const profileKey = getLinkedInProfileVanityFromPath();
      if (!profileKey) {
        clearLinkedInProfileBurst();
        return;
      }
      clearLinkedInProfileBurst();
      let tries = 0;
      const tick = () => {
        tries += 1;
        try {
          scanLinkedInAccountBadges();
        } catch {
          /* ignore */
        }
        if (linkedinProfileBadgePresent(profileKey) || tries >= 80) {
          clearLinkedInProfileBurst();
        }
      };
      tick();
      liBurstTimer = window.setInterval(tick, 120);
    }

    function onLinkedInPathMaybeChanged() {
      const path = location.pathname || "";
      if (path === liLastPath) return;
      liLastPath = path;
      const parts = path.split("/").filter(Boolean);
      if (parts[0] === "in" && parts[1]) {
        // Fresh profile visit: drop stale owner badges so we re-pin next to the new H1.
        document.querySelectorAll(".veritas-account-badge--linkedin").forEach((b) => {
          const k = b.getAttribute("data-veritas-score-key") || "";
          if (k.startsWith("li:")) b.remove();
        });
        document.querySelectorAll(`[${SOCIAL_TAG}="1"]`).forEach((el) => {
          el.removeAttribute(SOCIAL_TAG);
        });
        kickLinkedInProfileScoreBurst();
      } else {
        clearLinkedInProfileBurst();
      }
    }

    try {
      const _push = history.pushState.bind(history);
      const _replace = history.replaceState.bind(history);
      history.pushState = function (...args) {
        const ret = _push(...args);
        onLinkedInPathMaybeChanged();
        return ret;
      };
      history.replaceState = function (...args) {
        const ret = _replace(...args);
        onLinkedInPathMaybeChanged();
        return ret;
      };
    } catch {
      /* ignore */
    }
    window.addEventListener("popstate", onLinkedInPathMaybeChanged);
    window.setInterval(onLinkedInPathMaybeChanged, 400);
    // Keepalive: LinkedIn often remounts the header after first paint / soft nav.
    window.setInterval(() => {
      const pk = getLinkedInProfileVanityFromPath();
      if (!pk) return;
      if (!linkedinProfileBadgePresent(pk)) {
        try {
          scanLinkedInAccountBadges();
        } catch {
          /* ignore */
        }
      }
    }, 800);

    liLastPath = "";
    onLinkedInPathMaybeChanged();
    kickLinkedInProfileScoreBurst();
  }
})();
