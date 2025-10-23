# def.est.im - Astro Dictionary Application

This is a dictionary application built with Astro that provides both Server-Side Rendering (SSR) and Single Page Application (SPA) functionality.

## Architecture

### Pages
- **`/` (index.astro)** - SPA functionality with Alpine.js for client-side interactions
- **`/[word]` ([word].astro)** - SSR pages for individual word lookups

### Components
- **`BaseLayout.astro`** - Shared layout with styles and Alpine.js setup
- **`WordCard.astro`** - Word display component with search functionality
- **`MeaningsSection.astro`** - Displays word meanings and definitions

### API
- **`.lookup.ts`** - API endpoint for word lookups (moved from functions/.lookup.js)

### Caching
- **`.dict_json/out/`** - Directory for cached JSON results from API calls

## Features

1. **SSR for `/word` pages** - Individual word pages are server-rendered for better SEO
2. **SPA for other lookups** - Main page uses Alpine.js for client-side interactions
3. **Cached JSON results** - API responses are cached in `.dict_json/out/` directory
4. **Audio pronunciation** - Uses Web Speech API for word pronunciation
5. **Responsive design** - Mobile-friendly layout with modern CSS

## Development

```bash
npm run dev    # Start development server
npm run build  # Build for production
npm run deploy # Deploy to Cloudflare Pages
```

## Migration from index.html

The original `index.html` has been split into:
- Layout and shared styles → `BaseLayout.astro`
- Word display → `WordCard.astro`
- Meanings display → `MeaningsSection.astro`
- Main page → `index.astro` (SPA)
- Word pages → `[word].astro` (SSR)
- API endpoint → `.lookup.ts`
