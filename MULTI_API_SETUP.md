# PreShield - Multi-API LLM Integration Guide

## Overview

PreShield now supports multiple free AI APIs with automatic rotation and failover. This ensures your application continues working even if one API reaches its rate limits.

## Supported APIs

### 1. **Groq API** (Recommended - Primary) ⭐
- **Speed:** Fastest inference in the industry
- **Free Tier:** 
  - 30 requests per minute (RPM)
  - 6K-12K tokens per minute (TPM)
  - 100K-500K tokens per day (TPD)
- **Models:** Llama 3.1 8B, Llama 3.3 70B, Mixtral 8x7B
- **No Credit Card:** Yes
- **Website:** https://console.groq.com

**Setup Steps:**
1. Go to https://console.groq.com
2. Click "Sign Up" (no credit card required)
3. Verify your email
4. Navigate to "API Keys" section
5. Click "Create API Key"
6. Copy the key and save it

### 2. **Together AI** (Secondary)
- **Speed:** Very fast inference
- **Free Tier:**
  - 60 requests per minute (RPM)
  - 10K tokens per minute (TPM)
  - 300K tokens per day (TPD)
- **Models:** Llama 3.3 70B, Mistral, and others
- **No Credit Card:** Yes
- **Website:** https://www.together.ai

**Setup Steps:**
1. Go to https://www.together.ai
2. Click "Sign Up"
3. Verify your email
4. Go to "Settings" → "API Keys"
5. Click "Generate API Key"
6. Copy the key and save it

### 3. **OpenRouter** (Tertiary)
- **Speed:** Good inference speed
- **Free Tier:** Access to free models (Llama, Mistral, etc.)
- **Models:** 200+ models including Claude, GPT, Llama
- **Requires:** $10 minimum credit (free models don't charge)
- **Website:** https://openrouter.ai

**Setup Steps:**
1. Go to https://openrouter.ai
2. Click "Sign Up"
3. Verify your email
4. Go to "Settings" → "Keys"
5. Click "Create Key"
6. Add $10 credit (can use free models without spending)
7. Copy the key and save it

### 4. **Google Gemini API** (Fallback)
- Already configured in your project
- Uses your existing GEMINI_API_KEY
- Fallback when all free APIs are exhausted

## Configuration on Vercel

### Step 1: Set Environment Variables

1. Go to your Vercel project dashboard
2. Click "Settings" → "Environment Variables"
3. Add the following variables:

```
GROQ_API_KEY=your_groq_api_key_here
TOGETHER_API_KEY=your_together_api_key_here
OPENROUTER_API_KEY=your_openrouter_api_key_here
GEMINI_API_KEY=your_gemini_api_key_here
```

4. Click "Save" for each variable
5. Redeploy your project

### Step 2: Redeploy

1. Go to "Deployments" tab
2. Click the three dots on the latest deployment
3. Click "Redeploy"
4. Wait for deployment to complete

## How the Rotation System Works

### Priority Order
1. **Groq API** (fastest, most reliable)
2. **Together AI** (good backup)
3. **OpenRouter** (access to diverse models)
4. **Google Gemini API** (fallback)

### Automatic Failover

The system automatically:
- Tries providers in priority order
- Skips providers that hit rate limits
- Falls back to next provider on error
- Retries failed providers after 1 minute
- Logs all API calls and failures

### Rate Limit Tracking

- Tracks requests and tokens per minute for each provider
- Prevents exceeding rate limits
- Temporarily disables providers when limits are reached
- Automatically re-enables them after 1 minute

## API Usage

### Making Requests

```javascript
// Client-side code
const response = await fetch("/api/gemini", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    messages: [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: "Hello!" }
    ],
    maxTokens: 2048,
    temperature: 0.7
  })
});

const data = await response.json();
console.log(data.choices[0].message.content);
```

### Checking Provider Stats

```javascript
// Get current provider stats
const stats = await fetch("/api/gemini/stats").then(r => r.json());
console.log(stats);
```

## Monitoring

### Check Server Logs

Look for these log messages in your Vercel logs:

```
[LLM] Using provider: groq
[LLM Rotation] Provider groq failed: ...
[API] Successfully got response from LLM
```

### Provider Status

The `/api/gemini/stats` endpoint returns:
- List of available providers
- Which providers are currently enabled
- Request and token counts per provider
- Failure counts and last errors

## Troubleshooting

### "No LLM providers available"
- Ensure at least one API key is configured
- Check that the API key is valid and not expired
- Verify the key is set in Vercel environment variables
- Redeploy after adding environment variables

### "Rate limit exceeded"
- All providers have hit their rate limits
- Wait a few minutes and try again
- Consider adding more API keys
- Implement caching on the client side

### Provider keeps failing
- Check the error message in logs
- Verify API key is still valid
- Check provider's status page
- Try a different provider

### Deployment not picking up new keys
- Make sure you saved the environment variables
- Click "Redeploy" in the Deployments tab
- Wait for deployment to complete
- Clear browser cache and refresh

## Best Practices

### 1. **Set Up Multiple APIs**
Configure at least 2-3 APIs for redundancy:
```
GROQ_API_KEY=xxx
TOGETHER_API_KEY=xxx
OPENROUTER_API_KEY=xxx
```

### 2. **Monitor Usage**
- Check logs regularly for errors
- Monitor which providers are being used
- Adjust if one provider is hitting limits frequently

### 3. **Handle Errors Gracefully**
- Implement retry logic on the client side
- Show loading states to users
- Provide helpful error messages

### 4. **Cache Responses**
- Cache LLM responses when possible
- Reduces API calls
- Improves response time

## Cost Analysis

All APIs used are **completely free**:

| API | Free Tier | Daily Limit |
|-----|-----------|-------------|
| Groq | Yes | 500K tokens |
| Together | Yes | 300K tokens |
| OpenRouter | Yes (free models) | Unlimited* |
| Gemini | Yes | Varies |

**Total Free Capacity:** ~800K tokens/day

*OpenRouter free tier has no daily limit for free models

## API Rate Limits

| Provider | RPM | TPM | TPD |
|----------|-----|-----|-----|
| Groq | 30 | 6K-12K | 100K-500K |
| Together | 60 | 10K | 300K |
| OpenRouter | 100 | 20K | Unlimited* |
| Gemini | 15 | Varies | Varies |

## Vercel Deployment Checklist

- [ ] Created Groq API account and got API key
- [ ] Created Together AI account and got API key
- [ ] Created OpenRouter account and got API key
- [ ] Added all API keys to Vercel environment variables
- [ ] Redeployed the project
- [ ] Tested the API with `/api/gemini` endpoint
- [ ] Checked logs for successful provider usage
- [ ] Verified `/api/gemini/stats` endpoint works

## Next Steps

1. **Sign up for free APIs** (Groq, Together, OpenRouter)
2. **Get API keys** for each service
3. **Add environment variables** to Vercel
4. **Redeploy** your project
5. **Test** the integration
6. **Monitor logs** to ensure rotation is working

## Support

If you encounter issues:
1. Check the troubleshooting section above
2. Review Vercel logs for error messages
3. Verify API keys are correct
4. Try with a different provider
5. Contact support if problems persist

## Summary

Your PreShield application now has:
- ✅ Multiple free AI APIs
- ✅ Automatic rotation and failover
- ✅ Rate limit tracking
- ✅ Error handling and retries
- ✅ Logging and monitoring
- ✅ Zero cost for AI features

Enjoy unlimited AI capabilities! 🚀
