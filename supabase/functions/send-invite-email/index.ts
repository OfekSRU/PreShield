import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders() });
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const EMAIL_FROM = Deno.env.get("EMAIL_FROM") || "";
    const GMAIL_SMTP_USER = Deno.env.get("GMAIL_SMTP_USER") || "";
    const GMAIL_SMTP_PASS = Deno.env.get("GMAIL_SMTP_PASS") || "";

    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return json({ message: "Missing Supabase service role env vars." }, 500, corsHeaders());
    }
    if (!EMAIL_FROM || !GMAIL_SMTP_USER || !GMAIL_SMTP_PASS) {
      return json(
        { message: "Missing email env vars (EMAIL_FROM / GMAIL_SMTP_USER / GMAIL_SMTP_PASS)." },
        500,
        corsHeaders(),
      );
    }

    const body = await req.json().catch(() => ({}));
    const projectId = body?.projectId;
    const projectName = body?.projectName;
    const email = body?.email;
    const businessName = body?.businessName;
    const businessLocation = body?.businessLocation;
    const origin = body?.origin;
    const emailSubject = body?.subject;
    const bodyTextDraft = body?.bodyText;

    const trimmedEmail = String(email || "").trim().toLowerCase();
    if (!projectId || !projectName || !trimmedEmail) {
      return json({ message: "Missing required fields." }, 400, corsHeaders());
    }

    const clientOrigin = origin && typeof origin === "string" ? origin : "https://example.com";

    // 1) Create pending invite row (so invite_token exists)
    const restHeaders = {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    } as const;

    const payloadWithBusiness = {
      project_id: projectId,
      project_name: projectName,
      email: trimmedEmail,
      status: "pending",
      business_name: businessName || null,
      business_location: businessLocation || null,
    };
    const payload = {
      project_id: projectId,
      project_name: projectName,
      email: trimmedEmail,
      status: "pending",
    };

    const postInvite = async (payloadObj: unknown) => {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/project_invites`, {
        method: "POST",
        headers: restHeaders,
        body: JSON.stringify(payloadObj),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) {
        throw new Error(data?.message || data?.error || `Invite insert failed (${r.status})`);
      }
      return Array.isArray(data) ? data[0] : data;
    };

    let invite;
    try {
      invite = await postInvite(payloadWithBusiness);
    } catch {
      invite = await postInvite(payload);
    }

    const inviteToken = invite?.invite_token;
    if (!inviteToken) {
      return json({ message: "Invite token was not returned from DB." }, 500, corsHeaders());
    }

    const joinUrl = `${clientOrigin}?invite=${encodeURIComponent(inviteToken)}`;

    // 2) Send invite email via Gmail SMTP
    const subject =
      typeof emailSubject === "string" && emailSubject.trim()
        ? emailSubject.trim()
        : `You're invited to "${projectName}" on PreShield`;

    const businessLine = businessName
      ? `${businessName} has invited you to collaborate on "${projectName}" on PreShield.`
      : `You have been invited to collaborate on "${projectName}" on PreShield.`;

    const bodyTemplate = (typeof bodyTextDraft === "string" && bodyTextDraft.trim())
      ? bodyTextDraft
      : `Hi,\n\n${businessLine}\n\nClick here to join:\n{{joinUrl}}\n`;

    const finalBodyText = bodyTemplate.split("{{joinUrl}}").join(joinUrl);

    const toBase64 = (s: string) => {
      const bytes = new TextEncoder().encode(s);
      let binary = "";
      for (const b of bytes) binary += String.fromCharCode(b);
      // btoa exists in the Edge runtime.
      // deno-lint-ignore no-explicit-any
      return (globalThis as any).btoa(binary);
    };

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();

    const smtpHost = "smtp.gmail.com";
    const smtpPort = 465;

    const conn = await Deno.connectTls({ hostname: smtpHost, port: smtpPort });
    const readBuf = new Uint8Array(4096);
    let readAccum = "";

    const readResponse = async () => {
      const lines: string[] = [];
      while (true) {
        const idx = readAccum.indexOf("\r\n");
        if (idx !== -1) {
          const line = readAccum.slice(0, idx);
          readAccum = readAccum.slice(idx + 2);
          lines.push(line);
          // Last line ends with "XYZ " (space), intermediate lines have "XYZ-"
          if (/^\d{3}\s/.test(line)) {
            return { code: line.slice(0, 3), lines };
          }
          continue;
        }
        const n = await conn.read(readBuf);
        if (!n) break;
        readAccum += decoder.decode(readBuf.subarray(0, n));
      }
      return { code: "", lines };
    };

    const writeLine = async (s: string) => {
      await conn.write(encoder.encode(s));
    };

    // Greeting
    await readResponse();

    await writeLine("EHLO preshield\r\n");
    await readResponse();

    await writeLine("AUTH LOGIN\r\n");
    await readResponse();
    await writeLine(`${toBase64(GMAIL_SMTP_USER)}\r\n`);
    await readResponse();
    await writeLine(`${toBase64(GMAIL_SMTP_PASS)}\r\n`);
    await readResponse();

    await writeLine(`MAIL FROM:<${EMAIL_FROM}>\r\n`);
    await readResponse();

    await writeLine(`RCPT TO:<${trimmedEmail}>\r\n`);
    await readResponse();

    await writeLine("DATA\r\n");
    await readResponse();

    const headers = [
      `From: ${EMAIL_FROM}`,
      `To: ${trimmedEmail}`,
      `Subject: ${subject}`,
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: 8bit",
      "",
    ].join("\r\n");

    const safeBodyLines = (headers + finalBodyText.replace(/\r\n/g, "\n")).split("\n").map((line) => {
      // Dot-stuffing per RFC 5321
      return line.startsWith(".") ? `.${line}` : line;
    }).join("\r\n");

    await writeLine(`${safeBodyLines}\r\n.\r\n`);
    await readResponse();

    await writeLine("QUIT\r\n");
    await readResponse();

    conn.close();

    return json({ ok: true, inviteToken }, 200, corsHeaders());
  } catch (e) {
    return json({ message: e?.message || "Unexpected error" }, 500, corsHeaders());
  }
});

