/**
 * Development shell UI — brand placement only.
 * Product states remain placeholders; no payment/auction/settlement behavior.
 */

const BRAND = "/brand/routeguard";

export function renderDevelopmentPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1"
  />
  <title>RouteGuard Freight Exchange</title>
  <link rel="icon" href="${BRAND}/routeguard-favicon.svg" type="image/svg+xml" />

  <style>
    :root {
      font-family:
        Inter,
        ui-sans-serif,
        system-ui,
        -apple-system,
        BlinkMacSystemFont,
        "Segoe UI",
        sans-serif;
      color: #171717;
      background: #f4f4f4;
      --charcoal: #101820;
      --border: #d4d4d4;
      --muted: #525252;
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
    }

    /* 01 / 04 — Public + mobile global header (light) */
    .global-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 24px;
      border-bottom: 1px solid var(--border);
      background: #ffffff;
    }

    .global-header .brand-compact {
      display: block;
      width: 240px;
      height: auto;
      max-width: 100%;
    }

    .global-header .brand-symbol-mobile {
      display: none;
      width: 40px;
      height: auto;
    }

    .shell {
      display: grid;
      grid-template-columns: 220px minmax(0, 1fr);
      min-height: calc(100vh - 200px);
    }

    /* 03 — Operations console sidebar (expanded dark compact / collapsed symbol) */
    .ops-sidebar {
      background: var(--charcoal);
      color: #e7e9ee;
      padding: 20px 16px;
      border-right: 1px solid #2a2f3a;
    }

    .ops-sidebar .brand-expanded {
      display: block;
      width: 200px;
      height: auto;
      max-width: 100%;
      margin: 0 auto;
    }

    .ops-sidebar .brand-collapsed {
      display: none;
      width: 32px;
      height: auto;
      margin: 0 auto;
    }

    .ops-sidebar.collapsed {
      width: 64px;
      padding: 20px 8px;
    }

    .ops-sidebar.collapsed .brand-expanded {
      display: none;
    }

    .ops-sidebar.collapsed .brand-collapsed {
      display: block;
    }

    .ops-nav {
      margin-top: 28px;
      display: grid;
      gap: 8px;
      font-size: 13px;
      color: #9aa1ad;
    }

    .ops-nav span {
      padding: 8px 10px;
      border-radius: 6px;
      background: #171a21;
    }

    .ops-toggle {
      margin-top: 16px;
      width: 100%;
      padding: 8px;
      border: 1px solid #2a2f3a;
      border-radius: 6px;
      background: #171a21;
      color: #e7e9ee;
      cursor: pointer;
      font-size: 12px;
    }

    .content {
      min-width: 0;
    }

    /* 00 — Design system master identity */
    .master-identity {
      padding: 24px;
      border-bottom: 1px solid var(--border);
      background: #ffffff;
    }

    .master-identity img {
      display: block;
      width: 320px;
      height: auto;
      max-width: 100%;
    }

    .master-identity p {
      margin: 12px 0 0;
      color: var(--muted);
      max-width: 60ch;
    }

    .warning {
      padding: 10px 24px;
      border-bottom: 1px solid var(--border);
      background: #fafafa;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.04em;
    }

    main {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      padding: 24px;
    }

    section {
      min-height: 210px;
      padding: 20px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #ffffff;
    }

    section h2 {
      margin: 0 0 16px;
      font-size: 17px;
    }

    .status {
      display: inline-block;
      padding: 5px 8px;
      border: 1px solid #a3a3a3;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 700;
    }

    dl {
      display: grid;
      grid-template-columns: 140px 1fr;
      gap: 10px;
      margin: 18px 0 0;
    }

    dt {
      color: #737373;
    }

    dd {
      margin: 0;
      font-weight: 600;
    }

    button {
      padding: 9px 14px;
      border: 1px solid #a3a3a3;
      border-radius: 7px;
      background: #f5f5f5;
      color: #737373;
      cursor: not-allowed;
    }

    .rail {
      margin: 0 0 12px;
    }

    .rail-cost {
      margin: 6px 0 0;
      color: #525252;
      font-size: 13px;
    }

    /* 01 — How it works workflow motif */
    .how-it-works {
      margin: 0 24px 24px;
      padding: 24px;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: #ffffff;
      text-align: center;
    }

    .how-it-works h2 {
      margin: 0 0 16px;
      font-size: 17px;
      text-align: left;
    }

    .how-it-works .motif-desktop {
      display: block;
      width: 100%;
      max-width: 1200px;
      height: auto;
      margin: 0 auto;
    }

    .how-it-works .motif-mobile {
      display: none;
      width: 120px;
      height: auto;
      margin: 0 auto;
    }

    .how-it-works .copy {
      margin: 16px 0 0;
      color: var(--muted);
      font-size: 14px;
      text-align: left;
      max-width: 70ch;
    }

    /* 01 — Global footer (dark) */
    .site-footer {
      padding: 28px 24px;
      background: var(--charcoal);
      color: #9aa1ad;
      font-size: 13px;
    }

    .site-footer .footer-brand {
      display: block;
      width: 320px;
      height: auto;
      max-width: 100%;
      margin: 0 0 16px;
    }

    .site-footer p {
      margin: 0;
      max-width: 70ch;
    }

    @media (max-width: 800px) {
      .shell {
        grid-template-columns: 1fr;
      }

      .ops-sidebar {
        display: none;
      }

      main {
        grid-template-columns: 1fr;
      }
    }

    /* Responsive brand substitutions (handoff: < 480px) */
    @media (max-width: 480px) {
      .global-header .brand-compact {
        display: none;
      }

      .global-header .brand-symbol-mobile {
        display: block;
      }

      .master-identity img {
        width: 100%;
        max-width: 280px;
      }

      .how-it-works .motif-desktop {
        display: none;
      }

      .how-it-works .motif-mobile {
        display: block;
      }

      .site-footer .footer-brand {
        width: 100%;
        max-width: 280px;
      }
    }
  </style>
</head>

<body>
  <header class="global-header" role="banner">
    <a href="/" aria-label="RouteGuard home">
      <img
        class="brand-compact"
        src="${BRAND}/routeguard-compact-header-light.svg"
        width="240"
        alt="RouteGuard"
      />
      <img
        class="brand-symbol-mobile"
        src="${BRAND}/routeguard-symbol-small.svg"
        width="40"
        alt="RouteGuard"
      />
    </a>
  </header>

  <div class="shell">
    <aside class="ops-sidebar" id="ops-sidebar" aria-label="Operations console">
      <img
        class="brand-expanded"
        src="${BRAND}/routeguard-compact-header-dark.svg"
        width="200"
        alt="RouteGuard"
      />
      <img
        class="brand-collapsed"
        src="${BRAND}/routeguard-symbol.svg"
        width="32"
        alt="RouteGuard symbol"
      />
      <nav class="ops-nav" aria-label="Console sections">
        <span>Tender</span>
        <span>Auction evidence</span>
        <span>Payment</span>
        <span>Reservation</span>
      </nav>
      <button
        type="button"
        class="ops-toggle"
        id="ops-toggle"
        aria-controls="ops-sidebar"
        aria-expanded="true"
      >
        Collapse sidebar
      </button>
    </aside>

    <div class="content">
      <div class="master-identity">
        <img
          src="${BRAND}/routeguard-full-lockup-light.svg"
          width="320"
          alt="RouteGuard Freight Exchange logo"
        />
        <p>
          Software-to-software freight-capacity reservation
          through x402 and Hedera.
        </p>
      </div>

      <div class="warning">
        DEVELOPMENT SHELL — NOT FINAL VISUAL DESIGN —
        LIVE PAYMENTS DISABLED
      </div>

      <main>
        <section>
          <h2>Tender</h2>
          <span class="status">NOT CREATED</span>

          <dl>
            <dt>Route</dt>
            <dd>Hamburg → Istanbul</dd>

            <dt>Equipment</dt>
            <dd>Curtainsider</dd>

            <dt>Auction</dt>
            <dd>Not connected</dd>
          </dl>
        </section>

        <section>
          <h2>Auction evidence</h2>
          <span class="status">HCS NOT CONNECTED</span>

          <dl>
            <dt>Tender opened</dt>
            <dd>—</dd>

            <dt>Bid commitments</dt>
            <dd>—</dd>

            <dt>Close barrier</dt>
            <dd>—</dd>
          </dl>
        </section>

        <section>
          <h2>x402 payment</h2>
          <span class="status">DISABLED</span>

          <p>Preferred settlement rail</p>

          <div class="rail">
            <button type="button" disabled>USDC</button>
            <p class="rail-cost">
              Challenge-stated Hedera transfer cost: $0.001
            </p>
          </div>
          <div class="rail">
            <button type="button" disabled>HBAR</button>
            <p class="rail-cost">
              Challenge-stated Hedera transfer cost: $0.0001
            </p>
          </div>

          <dl>
            <dt>402 challenge</dt>
            <dd>—</dd>

            <dt>Settlement</dt>
            <dd>—</dd>
          </dl>
        </section>

        <section>
          <h2>Payment summary</h2>
          <span class="status">AWAITING SELECTION</span>

          <dl>
            <dt>Carrier reservation</dt>
            <dd>—</dd>

            <dt>Selected asset</dt>
            <dd>—</dd>

            <dt>Hedera network transfer cost</dt>
            <dd>
              Challenge-stated fixed amount by rail
              (HBAR $0.0001 / USDC $0.001)
            </dd>

            <dt>Facilitator fee</dt>
            <dd>Not modeled as a separate x402 charge</dd>

            <dt>RouteGuard fee</dt>
            <dd>Not modeled as a separate charge</dd>

            <dt>Carrier received</dt>
            <dd>Equals reservation payment (network cost not deducted)</dd>
          </dl>
        </section>

        <section>
          <h2>Reservation</h2>
          <span class="status">AWAITING PAYMENT CORE</span>

          <dl>
            <dt>Status</dt>
            <dd>Not reserved</dd>

            <dt>Transaction</dt>
            <dd>—</dd>

            <dt>Notifications</dt>
            <dd>—</dd>
          </dl>
        </section>
      </main>

      <section class="how-it-works" aria-labelledby="how-it-works-heading">
        <h2 id="how-it-works-heading">How it works</h2>
        <img
          class="motif-desktop"
          src="${BRAND}/routeguard-trust-lane-horizontal.svg"
          alt=""
          aria-hidden="true"
        />
        <img
          class="motif-mobile"
          src="${BRAND}/routeguard-proof-rail-mobile.svg"
          width="120"
          alt=""
          aria-hidden="true"
        />
        <p class="copy">
          Inbound capacity offers are evaluated deterministically.
          Confirmed settlement precedes <code>ROUTE_RESERVED</code>.
          Public Hedera proof anchors the order of events.
        </p>
      </section>
    </div>
  </div>

  <footer class="site-footer" role="contentinfo">
    <img
      class="footer-brand"
      src="${BRAND}/routeguard-full-lockup-dark.svg"
      width="320"
      alt="RouteGuard Freight Exchange"
    />
    <p>
      Functional page structure only. Dedicated visual design
      begins after the complete payment and freight flow is stable.
      Brand assets follow the locked RouteGuard production family.
    </p>
  </footer>

  <script>
    (function () {
      var sidebar = document.getElementById("ops-sidebar");
      var toggle = document.getElementById("ops-toggle");
      if (!sidebar || !toggle) return;
      toggle.addEventListener("click", function () {
        var collapsed = sidebar.classList.toggle("collapsed");
        toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
        toggle.textContent = collapsed ? "Expand sidebar" : "Collapse sidebar";
      });
    })();
  </script>
</body>
</html>`;
}
