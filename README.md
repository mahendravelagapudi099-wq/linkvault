# LinkVault 🗝️

An AI-powered link manager. Paste any URL and LinkVault:

1. **Saves it locally** (browser localStorage — nothing leaves your device)
2. **Fetches metadata** (title, description, favicon via Microlink)
3. **Searches the web** for context (optional, via Tavily)
4. **Analyzes with Gemini** — summary, category, tags, technologies, use cases
5. **Finds relationships** — related resources + links already in your vault
6. **Displays a detailed report** — no manual analysis required

## Try it

The app is deployed with GitHub Pages: **https://mahendravelagapudi099-wq.github.io/linkvault/**

## Setup

1. Open the app and click **⚙️ Settings**.
2. Paste your **Gemini API key** (free at [Google AI Studio](https://aistudio.google.com/app/apikey)). Required for AI analysis.
3. Optionally add a **Tavily API key** (free tier at [tavily.com](https://tavily.com)) to enrich analysis with live web search.
4. Paste a URL and hit **Analyze & Save**.

Keys are stored only in your browser's localStorage and are sent only to Google's / Tavily's APIs.

## Development

No build step — it's vanilla HTML/CSS/JS. Open `index.html` directly or serve the folder:

```bash
npx serve .
```

CI (`node --check app.js`) and Pages deployment run automatically via `.github/workflows/pages.yml` on every push to `main`.

## Privacy

- Links, reports and settings live in your browser's localStorage.
- The only network calls are: Microlink (metadata), Tavily (optional search), Google Gemini (analysis).
