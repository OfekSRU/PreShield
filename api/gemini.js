/**
 * Vercel Serverless Function: Multi-API LLM Proxy with Rotation
 * 
 * This function handles requests to /api/gemini and proxies them to multiple
 * LLM providers with automatic failover:
 * 1. Groq API (primary)
 * 2. Together AI (secondary)
 * 3. OpenRouter (tertiary)
 * 4. Google Gemini API (fallback)
 * 
 * Environment Variables Required:
 * - GROQ_API_KEY: Groq API key (optional)
 * - TOGETHER_API_KEY: Together AI key (optional)
 * - OPENROUTER_API_KEY: OpenRouter key (optional)
 * - GEMINI_API_KEY: Google Gemini API key (fallback)
 */

import { invokeWithRotation, getRotationManager } from "./llm-rotation.js";

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Handle stats endpoint
  if (req.url === "/api/gemini/stats") {
    const manager = getRotationManager();
    return res.status(200).json({
      providers: manager.providers.map((p) => ({
        name: p.name,
        priority: p.priority,
        enabled: manager.canUseProvider(p.name),
      })),
      stats: manager.getStats(),
    });
  }

  try {
    const { messages, model, maxTokens, temperature } = req.body;

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: "Invalid request",
        message: "messages array is required",
      });
    }

    console.log("[API] Received request with", messages.length, "messages");

    // Use the rotation system to invoke LLM
    const response = await invokeWithRotation(messages, {
      maxTokens: maxTokens || 2048,
      temperature: temperature || 0.7,
    });

    console.log("[API] Successfully got response from LLM");

    // Return the response
    return res.status(200).json(response);
  } catch (error) {
    console.error("[API] Error:", error);

    // Check if it's a rate limit error
    if (error.message.includes("429") || error.message.includes("rate limit")) {
      return res.status(429).json({
        error: "Rate limit exceeded",
        message:
          "All LLM providers have reached their rate limits. Please try again in a few moments.",
      });
    }

    return res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to invoke LLM",
    });
  }
}
