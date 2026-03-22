/**
 * Vercel Serverless Function: OpenRouter API proxy
 * 
 * Handles: /api/openrouter
 * Proxies to: https://openrouter.ai/api/v1/chat/completions
 * 
 * Used as fallback when Gemini API quota is exhausted
 */

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Get the API key from environment variables
  const apiKey = process.env.VITE_OPENROUTER_API_KEY;
  if (!apiKey) {
    console.error("[OpenRouter Proxy] VITE_OPENROUTER_API_KEY not configured");
    return res.status(500).json({
      error: "VITE_OPENROUTER_API_KEY is not configured",
      message: "Please set VITE_OPENROUTER_API_KEY in Vercel environment variables"
    });
  }

  try {
    const { model, messages } = req.body;
    
    if (!model || !messages) {
      return res.status(400).json({
        error: "Missing required fields",
        message: "Please provide 'model' and 'messages' in request body"
      });
    }

    console.log(`[OpenRouter Proxy] Forwarding request to model: ${model}`);

    // Forward the request to OpenRouter API
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
        "HTTP-Referer": process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "https://pre-shield.vercel.app",
        "X-Title": "PreShield"
      },
      body: JSON.stringify({
        model: model,
        messages: messages,
        temperature: 0.7,
        max_tokens: 2048
      })
    });

    // Get the response data
    const data = await response.json();

    // Log errors for debugging
    if (!response.ok) {
      console.error(`[OpenRouter Proxy] API Error (${response.status}):`, JSON.stringify(data, null, 2));
      console.error(`[OpenRouter Proxy] Request model: ${model}`);
    }

    // Return the response with the same status code
    return res.status(response.status).json(data);
  } catch (error) {
    console.error("[OpenRouter Proxy] Error:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to proxy request to OpenRouter API"
    });
  }
}
