# Paper Desk
Static, read-only dashboard for a paper-trading bot (OANDA practice and Alpaca paper; no real money).

## Local configuration
Copy `config.example.js` to `config.js` and set your own API endpoint. `config.js` is deliberately ignored and must be supplied on disk when serving or deploying the dashboard. Existing local configuration is preserved. The dashboard loads it before `app.js`.

`open: true` skips the passphrase prompt only for a deliberately public, read-only paper API. This flag is not authentication. Enforce authentication and rate limits on the API itself; never expose live trading credentials or write endpoints. Do not put secrets in browser configuration. A custom deployment using `scripts/build_dashboard.py` must generate config.js outside Git.
