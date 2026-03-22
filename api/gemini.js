/**
 * Vercel Serverless Function: Proxy for Google Gemini API
 * 
 * This function handles requests to /api/gemini and proxies them to Google's
 * Generative Language API. It keeps the GEMINI_API_KEY secure server-side.
 * 
 * Environment Variables Required:
 * - GEMINI_API_KEY: Your Google Gemini API key (set in Vercel dashboard)
 */

export default async function handler(req, res) {
  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  // Get the API key from environment variables
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: "GEMINI_API_KEY is not configured",
      message: "Please set GEMINI_API_KEY in your Vercel environment variables"
    });
  }

  try {
    // Extract the model and action from the request path
    // Expected format: /api/gemini/v1beta/models/{model}:generateContent
    const path = req.url.replace(/^\/api\/gemini/, "") || "";
    
    // Build the full Gemini API URL
    // Fix: Ensure we use v1 instead of v1beta
    const finalPath = path.replace(/^\/v1beta\//, "/v1/");
    const geminiUrl = `https://generativelanguage.googleapis.com${finalPath}?key=${encodeURIComponent(apiKey)}`;

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

    // Return the response with the same status code
    return res.status(response.status).json(data);
  } catch (error) {
    console.error("Gemini API proxy error:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to proxy request to Gemini API"
    });
  }
}
