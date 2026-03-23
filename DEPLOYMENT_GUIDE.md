# Gmail Invite Fixes - Deployment Guide

## Changes Made

### 1. Created Vercel Serverless Function
**File**: `api/send-invite-email.js`
- Proxies invite email requests to Supabase server-side
- Avoids CORS issues that caused "failed to fetch" errors
- Properly forwards all parameters and handles responses

### 2. Updated Supabase Edge Function
**File**: `supabase/functions/send-invite-email/index.ts`
- Changed email format from plain text to HTML
- Added Open Graph meta tags for Gmail preview generation
- Includes project URL prominently in the email
- Professional HTML template with styling and CTA button

### 3. Updated Client-Side Code
**File**: `preshield.jsx` (lines 574-598)
- Changed endpoint from Supabase direct call to new Vercel proxy
- Removed Supabase authentication headers
- Uses `window.location.origin` for dynamic URL construction

## What These Fixes Solve

✅ **"Failed to Fetch" Error**: The Vercel proxy handles the request server-side, avoiding CORS issues
✅ **Gmail Preview Issue**: HTML emails with Open Graph metadata now display the project URL in Gmail previews
✅ **Better UX**: Professional HTML email template with CTA button instead of plain text

## Deployment Steps

### Step 1: Push to GitHub
```bash
cd /home/ubuntu/preshield-repo
git push origin main
```

### Step 2: Deploy to Vercel
Option A - Automatic (Recommended):
- Go to https://vercel.com/ofeksrus-projects/pre-shield
- Vercel will automatically detect the new commit and deploy

Option B - Manual via CLI:
```bash
vercel --prod
```

### Step 3: Verify Environment Variables
Ensure these environment variables are set in Vercel:
- `SUPABASE_URL` - Your Supabase project URL
- `SUPABASE_ANON_KEY` - Your Supabase anonymous key

### Step 4: Test the Invite System
1. Go to your PreShield app
2. Try sending an invite to a test email
3. Check that:
   - No "failed to fetch" error appears
   - Email arrives in inbox
   - Email preview shows project URL and details
   - HTML formatting is displayed correctly

## Troubleshooting

### If you still get "failed to fetch" error:
1. Check Vercel function logs: https://vercel.com/ofeksrus-projects/pre-shield/functions
2. Ensure `SUPABASE_URL` and `SUPABASE_ANON_KEY` are set in Vercel environment
3. Verify the Supabase Edge Function is deployed and working

### If emails don't arrive:
1. Check Supabase function logs
2. Verify Gmail SMTP credentials are correct
3. Check spam folder

### If email preview doesn't show:
1. The HTML email should render with the new template
2. Open Graph tags are included for better preview generation
3. Gmail may cache old previews - try a fresh email

## Files Changed

| File | Change |
|------|--------|
| `api/send-invite-email.js` | **NEW** - Vercel proxy function |
| `supabase/functions/send-invite-email/index.ts` | Updated to send HTML emails with Open Graph metadata |
| `preshield.jsx` | Updated to use new Vercel proxy endpoint |

## Rollback Instructions

If needed, revert to the previous version:
```bash
git revert HEAD
git push origin main
```

Then redeploy on Vercel (automatic or manual).
