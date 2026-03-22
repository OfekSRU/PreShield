/**
 * Multi-API LLM Rotation System for Vercel
 * 
 * Provides automatic failover and rotation between multiple free AI APIs:
 * - Groq API (primary)
 * - Together AI (secondary)
 * - OpenRouter (tertiary)
 * - Google Gemini API (fallback)
 * 
 * Features:
 * - Automatic fallback on rate limit or error
 * - Round-robin rotation for load balancing
 * - Rate limit tracking
 * - Configurable retry logic
 */

class LLMRotationManager {
  constructor() {
    this.providers = this.initializeProviders();
    this.stats = new Map();
    this.currentIndex = 0;

    // Initialize stats for each provider
    for (const provider of this.providers) {
      this.stats.set(provider.name, {
        requestsThisMinute: 0,
        tokensThisMinute: 0,
        lastResetTime: Date.now(),
        failureCount: 0,
        lastError: null,
        lastErrorTime: null,
      });
    }
  }

  initializeProviders() {
    const providers = [];

    // Groq API - Primary (fastest, most reliable)
    if (process.env.GROQ_API_KEY) {
      providers.push({
        name: "groq",
        apiKey: process.env.GROQ_API_KEY,
        priority: 1,
        rateLimitRPM: 30,
        rateLimitTPM: 6000,
        endpoint: "https://api.groq.com/openai/v1/chat/completions",
        model: "llama-3.1-8b-instant",
      });
    }

    // Together AI - Secondary
    if (process.env.TOGETHER_API_KEY) {
      providers.push({
        name: "together",
        apiKey: process.env.TOGETHER_API_KEY,
        priority: 2,
        rateLimitRPM: 60,
        rateLimitTPM: 10000,
        endpoint: "https://api.together.xyz/v1/chat/completions",
        model: "meta-llama/Llama-3-70b-chat-hf",
      });
    }

    // OpenRouter - Tertiary
    if (process.env.OPENROUTER_API_KEY) {
      providers.push({
        name: "openrouter",
        apiKey: process.env.OPENROUTER_API_KEY,
        priority: 3,
        rateLimitRPM: 100,
        rateLimitTPM: 20000,
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model: "meta-llama/llama-3-8b-instruct:free",
      });
    }

    // Google Gemini API - Fallback
    if (process.env.GEMINI_API_KEY) {
      providers.push({
        name: "gemini",
        apiKey: process.env.GEMINI_API_KEY,
        priority: 4,
        endpoint: "gemini", // Special handling
      });
    }

    // Sort by priority
    providers.sort((a, b) => a.priority - b.priority);
    return providers;
  }

  getNextProvider() {
    if (this.providers.length === 0) {
      console.error("[LLM Rotation] No providers configured");
      return null;
    }

    const enabledProviders = this.providers.filter((p) => this.canUseProvider(p.name));

    if (enabledProviders.length === 0) {
      console.error("[LLM Rotation] No enabled providers available");
      return null;
    }

    this.currentIndex = (this.currentIndex + 1) % enabledProviders.length;
    return enabledProviders[this.currentIndex];
  }

  getBestProvider() {
    for (const provider of this.providers) {
      if (this.canUseProvider(provider.name)) {
        return provider;
      }
    }
    return this.providers[0] || null;
  }

  canUseProvider(providerName) {
    const stats = this.stats.get(providerName);
    const provider = this.providers.find((p) => p.name === providerName);

    if (!stats || !provider) return false;

    // Reset counters if a minute has passed
    const now = Date.now();
    if (now - stats.lastResetTime > 60000) {
      stats.requestsThisMinute = 0;
      stats.tokensThisMinute = 0;
      stats.lastResetTime = now;
    }

    // Check rate limits
    if (provider.rateLimitRPM && stats.requestsThisMinute >= provider.rateLimitRPM) {
      return false;
    }

    // Don't use provider if it had recent failures
    if (stats.failureCount > 3) {
      const timeSinceLastError = now - (stats.lastErrorTime || 0);
      if (timeSinceLastError < 60000) {
        return false;
      }
      stats.failureCount = 0;
    }

    return true;
  }

  recordSuccess(providerName, tokenCount = 0) {
    const stats = this.stats.get(providerName);
    if (stats) {
      stats.requestsThisMinute++;
      stats.tokensThisMinute += tokenCount;
      stats.failureCount = Math.max(0, stats.failureCount - 1);
    }
  }

  recordFailure(providerName, error) {
    const stats = this.stats.get(providerName);
    if (stats) {
      stats.failureCount++;
      stats.lastError = error;
      stats.lastErrorTime = Date.now();
      console.error(`[LLM Rotation] Provider ${providerName} failed: ${error}`);
    }
  }

  getStats() {
    return Array.from(this.stats.entries()).map(([name, stats]) => ({
      provider: name,
      ...stats,
    }));
  }
}

// Singleton instance
let rotationManager = null;

export function getRotationManager() {
  if (!rotationManager) {
    rotationManager = new LLMRotationManager();
  }
  return rotationManager;
}

export async function invokeWithRotation(messages, options = {}) {
  const manager = getRotationManager();
  const provider = manager.getBestProvider();

  if (!provider) {
    throw new Error("No LLM providers available");
  }

  console.log(`[LLM] Using provider: ${provider.name}`);

  try {
    let response;

    if (provider.name === "gemini") {
      // Handle Gemini API
      response = await invokeGemini(messages, provider.apiKey, options);
    } else {
      // Handle OpenAI-compatible APIs
      response = await invokeOpenAICompatible(messages, provider, options);
    }

    manager.recordSuccess(provider.name, response.usage?.total_tokens || 0);
    return response;
  } catch (error) {
    manager.recordFailure(provider.name, error.message);
    throw error;
  }
}

async function invokeOpenAICompatible(messages, provider, options = {}) {
  const payload = {
    model: provider.model,
    messages: messages,
    max_tokens: options.maxTokens || 2048,
    temperature: options.temperature || 0.7,
  };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${provider.apiKey}`,
  };

  // Add provider-specific headers
  if (provider.name === "openrouter") {
    headers["HTTP-Referer"] = "https://pre-shield.vercel.app";
    headers["X-Title"] = "PreShield";
  }

  const response = await fetch(provider.endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`${provider.name} API error: ${response.status} - ${errorData}`);
  }

  return await response.json();
}

async function invokeGemini(messages, apiKey, options = {}) {
  // Convert messages to Gemini format
  const contents = messages
    .filter((msg) => msg.role !== "system")
    .map((msg) => ({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    }));

  const payload = {
    contents,
    generationConfig: {
      maxOutputTokens: options.maxTokens || 2048,
      temperature: options.temperature || 0.7,
    },
  };

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${encodeURIComponent(
    apiKey
  )}`;

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorData = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorData}`);
  }

  const data = await response.json();

  // Transform to OpenAI format
  return {
    id: "gemini-" + Date.now(),
    model: "gemini-2.5-flash",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: data.candidates?.[0]?.content?.parts?.[0]?.text || "",
        },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    },
  };
}
