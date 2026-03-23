/**
 * Vercel Serverless Function: Invite Email Proxy
 * 
 * This function handles requests to /api/send-invite-email and proxies them
 * to the Supabase Edge Function server-side, avoiding CORS issues.
 * 
 * Accepts Supabase credentials from request body or environment variables.
 */

export default async function handler(req, res) {
  // Set CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  // Handle preflight requests
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const {
      projectId,
      projectName,
      email,
      businessName,
      businessLocation,
      subject,
      bodyText,
      origin,
      supabaseUrl,
      supabaseKey,
    } = req.body;

    // Get Supabase credentials from request body or environment variables
    const SUPABASE_URL = supabaseUrl || process.env.SUPABASE_URL || "";
    const SUPABASE_ANON_KEY = supabaseKey || process.env.SUPABASE_ANON_KEY || "";

    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      console.error("[send-invite-email] Missing Supabase credentials");
      return res.status(500).json({
        error: "Server configuration error",
        message: "Missing Supabase configuration. Please provide supabaseUrl and supabaseKey in request body.",
      });
    }

    // Validate required fields
    if (!projectId || !projectName || !email) {
      return res.status(400).json({
        error: "Missing required fields",
        message: "projectId, projectName, email, supabaseUrl, and supabaseKey are required",
      });
    }

    console.log(
      `[send-invite-email] Proxying invite email for ${email} to project ${projectName}`
    );

    // Forward the request to Supabase Edge Function
    const supabaseResponse = await fetch(
      `${SUPABASE_URL}/functions/v1/send-invite-email`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({
          projectId,
          projectName,
          email,
          businessName: businessName || null,
          businessLocation: businessLocation || null,
          subject: subject || "",
          bodyText: bodyText || "",
          origin: origin || "https://example.com",
        }),
      }
    );

    const responseData = await supabaseResponse.json().catch(() => ({}));

    if (!supabaseResponse.ok) {
      console.error(
        `[send-invite-email] Supabase returned ${supabaseResponse.status}:`,
        responseData
      );
      return res.status(supabaseResponse.status).json({
        error: responseData?.message || "Failed to send invite email",
        details: responseData,
      });
    }

    console.log("[send-invite-email] Successfully sent invite email");
    return res.status(200).json(responseData);
  } catch (error) {
    console.error("[send-invite-email] Error:", error);
    return res.status(500).json({
      error: "Internal server error",
      message: error.message || "Failed to process invite email request",
    });
  }
}
