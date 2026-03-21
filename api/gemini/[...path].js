/**
 * Vercel Serverless Function: Catch-all for nested Gemini API paths
 * 
 * This handles requests like:
 * - /api/gemini/v1beta/models/gemini-2.5-flash-lite:generateContent
 * - /api/gemini/v1beta/models/gemini-2.0-flash:generateContent
 * etc.
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
    // Extract the path from the dynamic route parameter
    const { path } = req.query;
    const pathStr = Array.isArray(path) ? "/" + path.join("/") : "/" + (path || "");

    // Build the full Gemini API URL
    const geminiUrl = `https://generativelanguage.googleapis.com${pathStr}?key=${encodeURIComponent(apiKey)}`;

    console.log(`[Gemini Proxy] Forwarding request to: ${geminiUrl.split("?")[0]}`);

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
