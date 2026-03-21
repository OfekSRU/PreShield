# How to Redeploy on Vercel

After adding the `GEMINI_API_KEY` environment variable, you need to trigger a redeployment. Here are all the ways to do it:

## Method 1: Redeploy from Vercel Dashboard (Easiest) ✅

1. Go to https://vercel.com/dashboard
2. Click on your **PreShield** project
3. Go to the **Deployments** tab
4. Find the latest deployment (usually at the top)
5. Click the **three dots (...)** menu on the right
6. Select **Redeploy**
7. Click **Redeploy** in the confirmation dialog
8. Wait for the deployment to complete (usually 1-2 minutes)

**That's it!** Your project is now redeployed with the new environment variable.

---

## Method 2: Push a New Commit to GitHub

If you've made changes to the code and committed them:

1. Make sure you're in the PreShield directory
2. Stage your changes:
   ```bash
   git add .
   ```
3. Commit your changes:
   ```bash
   git commit -m "Fix: Add Gemini API proxy for production"
   ```
4. Push to GitHub:
   ```bash
   git push origin main
   ```
5. Vercel will automatically detect the push and redeploy

**Note:** This only works if your GitHub repository is connected to Vercel (which it should be).

---

## Method 3: Use Vercel CLI (For Advanced Users)

If you have the Vercel CLI installed:

```bash
# Install Vercel CLI (if not already installed)
npm install -g vercel

# Navigate to your project
cd /path/to/PreShield

# Redeploy
vercel --prod
```

---

## Method 4: Trigger via GitHub (Automatic)

If your repo is connected to Vercel:
- Any push to your main branch automatically triggers a deployment
- Just commit and push your changes

---

## Recommended Approach

**For this fix, use Method 1 (Redeploy from Dashboard):**

1. ✅ Add `GEMINI_API_KEY` to Vercel environment variables
2. ✅ Click "Redeploy" from the Deployments tab
3. ✅ Wait for it to complete
4. ✅ Test the AI interview

This is the fastest way and doesn't require any code changes.

---

## Verify the Redeployment

After redeploying:

1. Go to https://pre-shield.vercel.app
2. Click **"Start AI Interview"**
3. You should see the first question appear (no 404 error!)
4. The interview should work normally

---

## Troubleshooting

### Still Getting 404?
- ✅ Verify the environment variable was saved (check Vercel dashboard)
- ✅ Verify you redeployed (check Deployments tab for a new deployment)
- ✅ Clear browser cache (Ctrl+Shift+Delete or Cmd+Shift+Delete)
- ✅ Wait 2-3 minutes for the deployment to fully propagate

### Deployment Failed?
- ✅ Check the deployment logs in Vercel dashboard
- ✅ Look for build errors or warnings
- ✅ Verify all files are properly committed to GitHub

### Still Not Working?
- ✅ Check browser console (F12) for error messages
- ✅ Check Vercel function logs (Functions tab in dashboard)
- ✅ Verify the API key is correct

---

## What Gets Redeployed?

When you redeploy:
- ✅ Your code from GitHub is pulled
- ✅ Environment variables are injected
- ✅ The serverless functions (api/gemini.js) are updated
- ✅ The frontend is rebuilt
- ✅ Everything is deployed to Vercel's CDN

---

## Expected Timeline

- **Redeploy starts**: Immediately
- **Build completes**: 1-2 minutes
- **Deployment completes**: 30 seconds
- **Live on internet**: 1-3 minutes (CDN propagation)

Total time: **2-5 minutes**

---

## Next Steps

1. Add `GEMINI_API_KEY` to Vercel environment variables
2. Redeploy using Method 1 above
3. Test the AI interview at https://pre-shield.vercel.app
4. Enjoy working interviews! 🎉
