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
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
    }

    header {
      padding: 24px;
      border-bottom: 1px solid #d4d4d4;
      background: #ffffff;
    }

    header h1 {
      margin: 0 0 6px;
      font-size: 24px;
    }

    header p {
      margin: 0;
      color: #525252;
    }

    .warning {
      padding: 10px 24px;
      border-bottom: 1px solid #d4d4d4;
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
      border: 1px solid #d4d4d4;
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

    footer {
      padding: 0 24px 24px;
      color: #737373;
      font-size: 13px;
    }

    @media (max-width: 800px) {
      main {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>

<body>
  <header>
    <h1>RouteGuard Freight Exchange</h1>
    <p>
      Software-to-software freight-capacity reservation
      through x402 and Hedera.
    </p>
  </header>

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

      <button type="button" disabled>USDC</button>
      <button type="button" disabled>HBAR</button>

      <dl>
        <dt>402 challenge</dt>
        <dd>—</dd>

        <dt>Settlement</dt>
        <dd>—</dd>
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

  <footer>
    Functional page structure only. Dedicated visual design
    begins after the complete payment and freight flow is stable.
  </footer>
</body>
</html>`;
}