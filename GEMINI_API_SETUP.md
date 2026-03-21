# Gemini API Setup Guide

## Overview

This document explains how to set up the Gemini API proxy for PreShield. The application uses Google's Gemini API for AI-powered project risk interviews.

## Problem Solved

Previously, the app relied on Vite's dev server proxy, which only worked locally. In production (Vercel), requests to `/api/gemini` returned 404 errors because there was no backend to handle them.

**Solution**: Vercel serverless functions now proxy all Gemini API requests securely server-side, keeping your API key protected.

## Setup Instructions

### 1. Get a Gemini API Key

1. Go to [Google AI Studio](https://aistudio.google.com/apikey)
2. Click "Create API Key"
3. Copy your API key (keep it secret!)

### 2. Configure Environment Variables

#### For Local Development:
1. Create a `.env` file in the project root (copy from `.env.example`)
2. Add your API key:
   ```
   GEMINI_API_KEY=your_api_key_here
   ```
3. Run `npm run dev` - the Vite proxy will use this key

#### For Vercel Production:
1. Go to your [Vercel Dashboard](https://vercel.com/dashboard)
2. Select your PreShield project
3. Go to **Settings** → **Environment Variables**
4. Add a new variable:
   - **Name**: `GEMINI_API_KEY`
   - **Value**: Your API key
   - **Environments**: Select "Production" (and "Preview" if desired)
5. Click "Save"
6. **Redeploy** your project for changes to take effect

### 3. How It Works

#### Local Development (Dev Mode):
```
Browser → Vite Dev Server (localhost:8080)
         ↓
      Vite Proxy (vite.config.js)
         ↓
   Google Gemini API
```
- Vite's proxy rewrites `/api/gemini` requests to Google's API
- API key is kept in `.env` (never exposed to browser)

#### Production (Vercel):
```
Browser → Vercel (pre-shield.vercel.app)
         ↓
   Serverless Function (/api/gemini/[...path].js)
         ↓
   Google Gemini API
```
- Serverless functions handle `/api/gemini/*` requests
- API key is stored securely in Vercel environment variables
- Browser never sees the API key

### 4. Verify It's Working

1. **Local**: Run `npm run dev` and try the AI interview
2. **Production**: After deploying to Vercel, test the interview feature
3. **Check Logs**: 
   - Local: Check browser console (F12)
   - Vercel: Check function logs in Vercel dashboard

### 5. Troubleshooting

#### Still Getting 404 Error?
- ✅ Verify `GEMINI_API_KEY` is set in Vercel environment variables
- ✅ Redeploy the project after adding the environment variable
- ✅ Check that the API key is valid (test in Google AI Studio)
- ✅ Clear browser cache (Ctrl+Shift+Delete or Cmd+Shift+Delete)

#### Getting 401/403 Error?
- ✅ API key is invalid or expired
- ✅ Go back to Google AI Studio and create a new key
- ✅ Update the environment variable in Vercel

#### Getting 429 Error (Rate Limited)?
- ✅ You've hit the free tier quota
- ✅ Wait a few hours or upgrade to a paid plan
- ✅ The app will automatically retry with fallback models

#### Interview Not Starting?
- ✅ Check browser console for error messages
- ✅ Verify network tab shows requests to `/api/gemini/...`
- ✅ Check Vercel function logs for server-side errors

### 6. File Structure

```
PreShield/
├── api/
│   ├── gemini.js              ← Main proxy handler
│   └── gemini/
│       └── [...path].js       ← Catch-all for nested paths
├── preshield.jsx              ← Frontend (unchanged)
├── vite.config.js             ← Dev proxy (still used locally)
├── .env.example               ← Template for local setup
└── GEMINI_API_SETUP.md        ← This file
```

### 7. Security Notes

- ✅ API key is **never** exposed to the browser
- ✅ API key is **only** used server-side in Vercel functions
- ✅ All requests are proxied through Vercel's secure infrastructure
- ✅ Requests to Google's API are HTTPS encrypted
- ✅ Never commit `.env` file to Git (it's in `.gitignore`)

### 8. Cost Considerations

Google Gemini API has a free tier:
- **Free**: 15 requests per minute, 1 million tokens per day
- **Paid**: $0.075 per 1M input tokens, $0.30 per 1M output tokens

For typical usage (a few interviews per day), you'll stay within the free tier.

## Support

If you encounter issues:
1. Check the [Google Gemini API documentation](https://ai.google.dev/docs)
2. Review Vercel function logs in the dashboard
3. Check browser console for error messages
4. Verify environment variables are correctly set
