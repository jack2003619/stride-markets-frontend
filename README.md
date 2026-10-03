# Stride Markets

Stride Markets is a mobile-first **simulation trading UI**.

## Current frontend
- Home, Markets, Trade, Invest, Wallet
- Trade History with local simulation records
- Profile and Settings
- Responsive mobile navigation
- Wallet connection state stored locally
- PWA manifest and basic offline cache

## Run locally
Open `index.html` in a static web server. A service worker requires HTTPS or localhost.

Example:
```bash
python3 -m http.server 8080
```

Then open `http://localhost:8080`.

## Production integration
The current trading, balance, deposit, withdrawal, and wallet flows are simulation/UI flows. A production release should connect them to a verified backend, authentication, market-data provider, wallet provider, and compliant payment/withdrawal infrastructure. Do not represent simulated balances or orders as real transactions.

## GitHub Pages
A Pages workflow can be added once GitHub Pages is enabled for the repository's Actions deployment source.
