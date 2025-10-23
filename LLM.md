# def.est.im - Astro.js Dictionary

A modern dictionary application built with Astro.js, supporting both Server-Side Rendering (SSR) and Single Page Application (SPA) functionality.

## Features

- **Hybrid Rendering**: SSR for `/word` paths, SPA for subsequent navigation
- **Cloudflare Pages**: Deployed on Cloudflare Pages with Functions and KV storage
- **Modern UI**: Clean, responsive design with gradient backgrounds
- **Audio Support**: Text-to-speech pronunciation
- **Caching**: Local storage caching for improved performance

## Architecture

### SSR Pages
- `/` - Home page with search interface
- `/[word]` - Dynamic word definition pages (server-rendered for first load, SPA for the rest)

### API Endpoints (Cloudflare Pages Functions)
- `GET /.dict_json/out/[word].json` - JSON static data, cheap
- `POST /.lookup?q=word` - Word lookup API, costy

### SPA Navigation
- Client-side navigation between words using `fetch()` and `history.pushState()`
- No page reloads for subsequent word lookups
- Maintains URL state for bookmarking and sharing

## Development


## File Structure

## Migration from Original

The original `index.html` has been migrated to Astro.js with the following changes:

1. **Removed Alpine.js**: Replaced with vanilla JavaScript for SPA functionality
2. **Added SSR**: Dynamic `[word].astro` pages for server-side rendering
3. **Hybrid Architecture**: Combines SSR for initial loads with SPA for navigation
4. **Modern Build System**: Astro.js build system with Cloudflare Pages adapter

## Configuration

- `astro.config.mjs` - Astro configuration with Cloudflare adapter
- `wrangler.toml` - Cloudflare Pages deployment configuration
- `package.json` - Dependencies and scripts

## Deployment

The application is configured to deploy to Cloudflare Pages using the `@astrojs/cloudflare` adapter. The build process generates optimized server-side code that runs on Cloudflare's edge network with Pages Functions for API endpoints.
