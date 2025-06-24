# Photo Gallery App

This repository contains a Cloudflare Worker backend and a static frontend for a simple photo gallery application.

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Deploy using Wrangler:
   ```bash
   npm run deploy
   ```

The frontend files in `public/` can be deployed to Cloudflare Pages, while the Worker in `src/worker.js` handles API requests.
