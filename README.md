# Kalshi Dashboard

A performance tracker for Kalshi traders. Upload the transaction CSVs from your Kalshi account and it plots your PnL over time and displays useful stats: per-series performance, maker/taker split, yes/no direction, settlement vs. market exit outcomes, and risk-adjusted returns (variance, Sharpe).

Everything runs client-side, so your trading data never leaves the browser.

Supports multi-csv upload to cover multiple years of trading.

Live version: [jsteng19.github.io/kalshi-dash](https://jsteng19.github.io/kalshi-dash/)

## Usage

Download your transaction CSVs from the [Documents](https://kalshi.com/account/taxes) section of the Kalshi desktop site, then upload them on the dashboard.

## Running locally

```bash
npm install
npm run dev
```

Next.js + TypeScript, Chart.js for the plots, Papa Parse for the CSVs.
