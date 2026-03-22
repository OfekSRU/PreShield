/**
 * Vercel Serverless Function: Direct Gemini API proxy
 * 
 * Handles: /api/gemini/generateContent
 * Proxies to: https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 */

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Get the API key from environment variables
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("[Gemini Proxy] GEMINI_API_KEY not configured");
    return res.status(500).json({
      error: "GEMINI_API_KEY is not configured",
      message: "Please set GEMINI_API_KEY in Vercel environment variables"
    });
  }

  try {
    // Get the model from query parameters or body
    // All available free-tier models: gemini-1.5-flash, gemini-2.0-flash, gemini-2.0-flash-lite, gemini-1.5-pro, gemini-1.0-pro, gemini-pro
    const model = req.query.model || req.body?.model || "gemini-1.5-flash";
    
    // Build the full Gemini API URL using v1beta API
    // All free-tier models are supported in v1beta
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    console.log(`[Gemini Proxy] Forwarding request to model: ${model}`);

    // Forward the request to Google's Gemini API
    const response = await fetch(geminiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(req.body),
    });

    // Get the response data
    const data = await response.json();

    // Log errors for debugging
    if (!response.ok) {
      console.error(`[Gemini Proxy] API Error (${response.status}):`, JSON.stringify(data, null, 2));
      console.error(`[Gemini Proxy] Request model: ${model}`);
      if (response.status === 429 || data?.error?.status === "RESOURCE_EXHAUSTED") {
        console.error(`[Gemini Proxy] Quota exhausted for model: ${model}. Client will retry with next model.`);
      }
    }

    // Return the response with the same status code
    return res.status(response.status).json(data);
  } catch (error) {
    console.error("[Gemini Proxy] Error:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to proxy request to Gemini API"
    });
  }
}
