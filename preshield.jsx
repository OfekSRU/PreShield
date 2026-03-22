import { useState, useEffect, useRef, useMemo } from "react";

const SUPABASE_URL = "https://uuakospgqfltwahjtaqw.supabase.co";
const SUPABASE_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV1YWtvc3BncWZsdHdhaGp0YXF3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQwMzM5MDYsImV4cCI6MjA4OTYwOTkwNn0.S5uU1qiRsbX-nfcE7ZKEEFNKdPc8-NHUoXS0Es9D0gM";

/** All available free Gemini models for automatic rotation when quota is reached.
 * These are all the free-tier models available in the Gemini v1beta API.
 * The app will automatically rotate through these models if one hits quota limits.
 */
const DEFAULT_GEMINI_MODELS = [
  "gemini-2.0-flash-lite",
  "gemini-2.0-flash",
  "gemini-1.5-flash",
  "gemini-1.5-pro",
];

/** OpenRouter models as fallback when Gemini quota is exhausted */
const DEFAULT_OPENROUTER_MODELS = [
  "openai/gpt-4o-mini",
  "anthropic/claude-3.5-sonnet",
  "google/gemini-2.0-flash-lite",
];
function parseGeminiModelFallbacks() {
  const multi = import.meta.env.VITE_GEMINI_MODELS?.trim();
  if (multi) {
    const arr = [...new Set(multi.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    if (arr.length) return arr;
  }
  const one = import.meta.env.VITE_GEMINI_MODEL?.trim();
  if (one) return [...new Set([one, ...DEFAULT_GEMINI_MODELS.filter((m) => m !== one)])];
  return [...DEFAULT_GEMINI_MODELS];
}
const GEMINI_MODEL_FALLBACKS = parseGeminiModelFallbacks();
const GEMINI_API_ROOT = import.meta.env.VITE_GEMINI_API_ROOT || "/api/gemini/generateContent";
const CUSTOM_GEMINI_URL = import.meta.env.VITE_GEMINI_GENERATE_URL?.trim();

/** Parse OpenRouter models from environment or use defaults */
function parseOpenRouterModelFallbacks() {
  const multi = import.meta.env.VITE_OPENROUTER_MODELS?.trim();
  if (multi) {
    const arr = [...new Set(multi.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
    if (arr.length) return arr;
  }
  return [...DEFAULT_OPENROUTER_MODELS];
}
const OPENROUTER_MODEL_FALLBACKS = parseOpenRouterModelFallbacks();
const OPENROUTER_API_ROOT = "https://openrouter.ai/api/v1/chat/completions";

function geminiEndpointForModel(modelId) {
  // Use the direct endpoint with the model as a query parameter
  return `${GEMINI_API_ROOT}?model=${encodeURIComponent(modelId)}`;
}

function geminiResponseText(data) {
  const parts = data.candidates?.[0]?.content?.parts;
  if (!parts?.length) {
    const block = data.promptFeedback?.blockReason;
    return block ? `[Response blocked: ${block}]` : "";
  }
  return parts.map((p) => p.text || "").join("");
}

function geminiApiError(data, status) {
  if (data?.error?.message) return data.error.message;
  return `Request failed (${status})`;
}

function geminiFailureIsRetriable(status, data) {
  // Don't retry on auth errors
  if (status === 401 || status === 403) return false;
  
  // Always retry on rate limit, unavailable, and quota errors
  if (status === 429 || status === 503) return true;
  if (status === 404) return true;
  
  const msg = String(data?.error?.message || "").toLowerCase();
  const st = String(data?.error?.status || "").toUpperCase();
  
  // Check for quota and resource exhaustion errors (ALWAYS retry)
  if (st === "RESOURCE_EXHAUSTED" || st === "UNAVAILABLE" || st === "DEADLINE_EXCEEDED") return true;
  if (status === 400 && /quota|exhausted|rate limit|billing|too many requests|resource has been exhausted|limit exceeded/.test(msg)) return true;
  
  // Retry on 500+ server errors
  if (status >= 500) return true;
  
  // Also retry on 400 errors that might indicate model issues
  if (status === 400) return true;
  
  return false;
}

function readPreferredGeminiModelIndex() {
  try {
    const n = parseInt(sessionStorage.getItem("ps_gemini_mi") || "0", 10);
    if (n >= 0 && n < GEMINI_MODEL_FALLBACKS.length) return n;
  } catch (_) {}
  return 0;
}

function writePreferredGeminiModelIndex(i) {
  try {
    sessionStorage.setItem("ps_gemini_mi", String(i));
  } catch (_) {}
}

/** Try OpenRouter as fallback when Gemini quota is exhausted */
async function tryOpenRouterFallback(body) {
  const models = OPENROUTER_MODEL_FALLBACKS;
  
  for (const model of models) {
    try {
      // Convert Gemini format to OpenRouter format
      const messages = body.contents?.map(c => ({
        role: c.role === "user" ? "user" : "assistant",
        content: c.parts?.[0]?.text || ""
      })) || [];
      
      console.log(`[OpenRouter] Attempting fallback with model: ${model}`);
      
      // Use server-side proxy to call OpenRouter API
      const res = await fetch("/api/openrouter", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: model,
          messages: messages
        })
      });
      
      const data = await res.json().catch(() => ({}));
      
      if (res.ok && data.choices?.[0]?.message?.content) {
        console.log(`[OpenRouter] Success with model: ${model}`);
        // Convert OpenRouter response to Gemini format for compatibility
        const geminiData = {
          candidates: [{
            content: {
              parts: [{ text: data.choices[0].message.content }]
            }
          }]
        };
        return { res, data: geminiData, model: `openrouter/${model}` };
      }
      
      if (!res.ok) {
        console.log(`[OpenRouter] Model ${model} failed with status ${res.status}:`, data);
        continue;
      }
    } catch (e) {
      console.log(`[OpenRouter] Error with model ${model}:`, e.message);
      continue;
    }
  }
  
  console.log("[OpenRouter] All fallback models exhausted");
  return null;
}

/** Tries models in order (starting from last working). Retries on quota / rate limit / unavailable. */
async function geminiGenerateWithModels(body) {
  if (CUSTOM_GEMINI_URL) {
    const res = await fetch(CUSTOM_GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    return { res, data, model: "custom" };
  }
  const models = GEMINI_MODEL_FALLBACKS;
  const start = readPreferredGeminiModelIndex();
  let lastRes = /** @type {Response | null} */ (null);
  let lastData = {};
  for (let o = 0; o < models.length; o++) {
    const idx = (start + o) % models.length;
    const m = models[idx];
    const res = await fetch(geminiEndpointForModel(m), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    lastRes = res;
    lastData = data;
    if (res.ok) {
      const text = geminiResponseText(data);
      if (text.trim()) {
        writePreferredGeminiModelIndex(idx);
        return { res, data, model: m };
      }
      continue;
    }
    if (geminiFailureIsRetriable(res.status, data)) continue;
    break;
  }
  
  // If all Gemini models failed, try OpenRouter as fallback
  console.log("[AI] All Gemini models exhausted, attempting OpenRouter fallback...");
  const orRes = await tryOpenRouterFallback(body);
  if (orRes) return orRes;
  
  return {
    res: lastRes || new Response(null, { status: 503 }),
    data: lastData,
    model: models[0] || "unknown",
  };
}

// ─── Auth helpers ────────────────────────────────────────────────────────────
const auth = {
  async signUp(email, password, userMetadata = {}) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/signup`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        email,
        password,
        options: { data: userMetadata || {} },
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || "Sign up failed");
    return data;
  },
  async signIn(email, password) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || data.msg || "Sign in failed");
    return data; // { access_token, refresh_token, user }
  },
  async signOut(token) {
    await fetch(`${SUPABASE_URL}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` }
    });
  },
  async resetPassword(email) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/recover`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ email })
    });
    if (!res.ok) { const d = await res.json(); throw new Error(d.error_description || "Reset failed"); }
  },
  async refreshSession(refreshToken) {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    const data = await res.json();
    if (!res.ok) throw new Error("Session expired");
    return data;
  }
};

// ─── Auth screen ─────────────────────────────────────────────────────────────
function validatePassword(password) {
  const checks = {
    length: password.length >= 6,
    number: /\d/.test(password),
    upper: /[A-Z]/.test(password),
  };
  return checks;
}

function PasswordStrength({ password }) {
  const checks = validatePassword(password);
  const items = [
    { label: "At least 6 characters", ok: checks.length },
    { label: "At least 1 number", ok: checks.number },
    { label: "At least 1 capital letter", ok: checks.upper },
  ];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
      {items.map(item => (
        <div key={item.label} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11 }}>
          <div style={{ width: 14, height: 14, borderRadius: "50%", background: item.ok ? "#1D9E7522" : "#E24B4A22", border: `1px solid ${item.ok ? "#1D9E75" : "#E24B4A44"}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <span style={{ color: item.ok ? "#1D9E75" : "#E24B4A", fontSize: 9 }}>{item.ok ? "✓" : "✕"}</span>
          </div>
          <span style={{ color: item.ok ? "#1D9E75" : "#9A9898" }}>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function AuthScreen({ onAuth }) {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [businessLocation, setBusinessLocation] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [rememberMe, setRememberMe] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);
  const [resetSent, setResetSent] = useState(false);
  const [language, setLanguage] = useState("EN");
  const [isDarkMode, setIsDarkMode] = useState(true);

  // Restore remembered email and preferences
  useEffect(() => {
    const remembered = localStorage.getItem("ps_remembered_email");
    if (remembered) setEmail(remembered);
    const savedLanguage = localStorage.getItem("ps_language");
    if (savedLanguage) setLanguage(savedLanguage);
    const savedTheme = localStorage.getItem("ps_theme");
    if (savedTheme) setIsDarkMode(savedTheme === "dark");
  }, []);

  const handleLanguageChange = (lang) => {
    setLanguage(lang);
    localStorage.setItem("ps_language", lang);
  };

  const handleThemeToggle = () => {
    const newTheme = !isDarkMode;
    setIsDarkMode(newTheme);
    localStorage.setItem("ps_theme", newTheme ? "dark" : "light");
  };

  const translations = {
    EN: { signIn: "Sign in", createAccount: "Create account", resetPassword: "Reset password", email: "Email", password: "Password", show: "Show", hide: "Hide", businessName: "Business name", businessLocation: "Business location", rememberMe: "Remember me", backToSignIn: "← Back to sign in", forgotPassword: "Forgot password?", checkEmail: "Check your email", resetLinkSent: "We sent a reset link to", subtitle: "AI-powered pre-mortem risk assessment", passwordRequirements: "Password doesn't meet requirements.", connectionError: "Connection error. If you're using this inside an iframe, please open it in a new tab to sign in.", accountCreated: "Account created! Please check your email to confirm before signing in." },
    עב: { signIn: "כניסה", createAccount: "יצירת חשבון", resetPassword: "איפוס סיסמה", email: "דוא״ל", password: "סיסמה", show: "הצג", hide: "הסתר", businessName: "שם העסק", businessLocation: "מיקום העסק", rememberMe: "זכור אותי", backToSignIn: "← חזרה לכניסה", forgotPassword: "שכחת סיסמה?", checkEmail: "בדוק את דוא״לך", resetLinkSent: "שלחנו קישור איפוס ל", subtitle: "הערכת סיכון מראש מופעלת בעזרת AI", passwordRequirements: "הסיסמה אינה עומדת בדרישות.", connectionError: "שגיאת חיבור. אם אתה משתמש בזה בתוך iframe, אנא פתח אותו בכרטיסייה חדשה.", accountCreated: "חשבון נוצר! אנא בדוק את דוא״לך כדי לאשר לפני הכניסה." },
    ES: { signIn: "Iniciar sesión", createAccount: "Crear cuenta", resetPassword: "Restablecer contraseña", email: "Correo electrónico", password: "Contraseña", show: "Mostrar", hide: "Ocultar", businessName: "Nombre del negocio", businessLocation: "Ubicación del negocio", rememberMe: "Recuérdame", backToSignIn: "← Volver a iniciar sesión", forgotPassword: "¿Olvidaste tu contraseña?", checkEmail: "Revisa tu correo electrónico", resetLinkSent: "Enviamos un enlace de restablecimiento a", subtitle: "Evaluación de riesgos previos a la mortem impulsada por IA", passwordRequirements: "La contraseña no cumple con los requisitos.", connectionError: "Error de conexión. Si está usando esto dentro de un iframe, abra en una pestaña nueva.", accountCreated: "¡Cuenta creada! Revise su correo para confirmar antes de iniciar sesión." },
    FR: { signIn: "Se connecter", createAccount: "Créer un compte", resetPassword: "Réinitialiser le mot de passe", email: "E-mail", password: "Mot de passe", show: "Afficher", hide: "Masquer", businessName: "Nom de l'entreprise", businessLocation: "Localisation de l'entreprise", rememberMe: "Se souvenir de moi", backToSignIn: "← Retour à la connexion", forgotPassword: "Mot de passe oublié?", checkEmail: "Vérifiez votre e-mail", resetLinkSent: "Nous avons envoyé un lien de réinitialisation à", subtitle: "Évaluation des risques pré-mortem alimentée par l'IA", passwordRequirements: "Le mot de passe ne répond pas aux exigences.", connectionError: "Erreur de connexion. Si vous utilisez ceci dans une iframe, veuillez l'ouvrir dans un nouvel onglet.", accountCreated: "Compte créé! Veuillez vérifier votre e-mail pour confirmer avant de vous connecter." },
    DE: { signIn: "Anmelden", createAccount: "Konto erstellen", resetPassword: "Passwort zurücksetzen", email: "E-Mail", password: "Passwort", show: "Anzeigen", hide: "Verbergen", businessName: "Geschäftsname", businessLocation: "Geschäftsstandort", rememberMe: "Mich merken", backToSignIn: "← Zurück zur Anmeldung", forgotPassword: "Passwort vergessen?", checkEmail: "Überprüfen Sie Ihre E-Mail", resetLinkSent: "Wir haben einen Zurücksetzen-Link an gesendet", subtitle: "KI-gestützte Vor-Mortem-Risikobewertung", passwordRequirements: "Das Passwort erfüllt die Anforderungen nicht.", connectionError: "Verbindungsfehler. Wenn Sie dies in einem iframe verwenden, öffnen Sie es bitte in einem neuen Tab.", accountCreated: "Konto erstellt! Bitte überprüfen Sie Ihre E-Mail, um sich anzumelden." },
  };

  const t = translations[language] || translations.EN;

  const checks = validatePassword(password);
  const passwordValid = checks.length && checks.number && checks.upper;

  const submit = async () => {
    if (!email.trim()) return;
    setError(null);
    setSuccess(null);

    // Client-side password validation for register
    if (mode === "register" && !passwordValid) {
      setError("Password doesn't meet requirements.");
      return;
    }

    setLoading(true);
    try {
      if (mode === "reset") {
        await auth.resetPassword(email.trim());
        setResetSent(true);
        return;
      }
      if (mode === "register") {
        const data = await auth.signUp(email.trim(), password, {
          business_name: businessName.trim(),
          business_location: businessLocation.trim(),
        });
        setEmail("");
        setPassword("");
        setBusinessName("");
        setBusinessLocation("");
        setShowPassword(false);
        setRememberMe(false);
        if (data?.access_token) {
          if (rememberMe) {
            localStorage.setItem("ps_remembered_email", email.trim());
            localStorage.setItem("ps_session", JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user }));
          } else {
            localStorage.removeItem("ps_remembered_email");
            sessionStorage.setItem("ps_session", JSON.stringify({ access_token: data.access_token, refresh_token: data.refresh_token, user: data.user }));
          }
          onAuth(data);
        } else {
          setMode("login");
          setSuccess("Account created! Please check your email to confirm before signing in.");
        }
        return;
      }
      const session = await auth.signIn(email.trim(), password);
      if (rememberMe) {
        localStorage.setItem("ps_remembered_email", email.trim());
        localStorage.setItem("ps_session", JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, user: session.user }));
      } else {
        localStorage.removeItem("ps_remembered_email");
        sessionStorage.setItem("ps_session", JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, user: session.user }));
      }
      onAuth(session);
    } catch (e) {
      if (e.message?.includes("fetch") || e.message?.includes("network") || e.message?.includes("Failed")) {
        setError("Connection error. If you're using this inside an iframe, please open it in a new tab to sign in.");
      } else {
        setError(e.message || "Something went wrong. Please try again.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ minHeight: "100vh", background: isDarkMode ? "#0A0A0F" : "#F5F5F5", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif", position: "relative" }}>
      {/* Language and Theme Controls */}
      <div style={{ position: "absolute", top: 20, right: 20, display: "flex", gap: 12, alignItems: "center" }}>
        <button onClick={handleThemeToggle} style={{ background: isDarkMode ? "#2A2A3A" : "#E0E0E0", border: "1px solid " + (isDarkMode ? "#3A3A4A" : "#D0D0D0"), color: isDarkMode ? "#E8E6E0" : "#333", borderRadius: 6, padding: "6px 10px", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 4 }} title="Toggle dark/light mode">{isDarkMode ? "🌙" : "☀️"}</button>
        <select value={language} onChange={(e) => handleLanguageChange(e.target.value)} style={{ background: isDarkMode ? "#2A2A3A" : "#E0E0E0", border: "1px solid " + (isDarkMode ? "#3A3A4A" : "#D0D0D0"), color: isDarkMode ? "#E8E6E0" : "#333", borderRadius: 6, padding: "6px 8px", fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}><option value="EN">EN</option><option value="עב">עב</option><option value="ES">ES</option><option value="FR">FR</option><option value="DE">DE</option></select>
      </div>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600&family=DM+Mono:wght@400;500&display=swap'); * { box-sizing: border-box; margin: 0; padding: 0; } input[type="email"], input[type="password"], input[type="text"] { background: #13131A; border: 1px solid #2A2A3A; color: #E8E6E0; border-radius: 8px; padding: 11px 14px; font-family: inherit; font-size: 14px; outline: none; width: 100%; transition: border-color 0.2s; } input:focus { border-color: #5B5BFF; } button { cursor: pointer; font-family: inherit; border: none; transition: all 0.15s; } .check-box { width: 16px; height: 16px; border-radius: 4px; border: 1.5px solid #2A2A3A; background: #13131A; cursor: pointer; display: flex; align-items: center; justify-content: center; flex-shrink: 0; transition: all 0.15s; } .check-box.checked { background: #5B5BFF; border-color: #5B5BFF; }`}</style>

      <div style={{ width: "100%", maxWidth: 400 }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ width: 48, height: 48, background: "#5B5BFF", borderRadius: 12, display: "inline-flex", alignItems: "center", justifyContent: "center", marginBottom: 14 }}>
            <svg width="24" height="24" viewBox="0 0 14 14" fill="none"><path d="M7 1L13 4V7C13 10.3 10.3 13 7 13C3.7 13 1 10.3 1 7V4L7 1Z" stroke="#fff" strokeWidth="1.5" fill="none"/><path d="M4.5 7L6.5 9L9.5 5.5" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: isDarkMode ? "#E8E6E0" : "#1A1A1A", letterSpacing: "-0.5px" }}>PreShield</div>
          <div style={{ fontSize: 13, color: isDarkMode ? "#9A9898" : "#666666", marginTop: 4 }}>AI-powered pre-mortem risk assessment</div>
        </div>

        {/* Card */}
        <div style={{ background: isDarkMode ? "#13131A" : "#FFFFFF", border: `1px solid ${isDarkMode ? "#1E1E2E" : "#E0E0E0"}`, borderRadius: 16, padding: "32px 28px", boxShadow: isDarkMode ? "none" : "0 4px 12px rgba(0,0,0,0.08)" }}>
          <div style={{ fontSize: 18, fontWeight: 600, color: isDarkMode ? "#E8E6E0" : "#1A1A1A", marginBottom: 22 }}>
            {mode === "login" ? t.signIn : mode === "register" ? t.createAccount : t.resetPassword}
          </div>

          {resetSent ? (
            <div style={{ textAlign: "center", padding: "8px 0" }}>
              <div style={{ fontSize: 32, marginBottom: 12 }}>📬</div>
              <div style={{ fontSize: 14, color: isDarkMode ? "#E8E6E0" : "#1A1A1A", marginBottom: 8 }}>{t.checkEmail}</div>
              <div style={{ fontSize: 13, color: isDarkMode ? "#9A9898" : "#666666", marginBottom: 20 }}>{t.resetLinkSent} {email}</div>
              <button onClick={() => { setMode("login"); setResetSent(false); }} style={{ fontSize: 13, color: "#5B5BFF", background: "none", border: "none", cursor: "pointer" }}>{t.backToSignIn}</button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              {/* Email */}
              <div>
                <label style={{ fontSize: 12, color: isDarkMode ? "#9A9898" : "#666666", marginBottom: 6, display: "block" }}>{t.email}</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@company.com" onKeyDown={e => e.key === "Enter" && submit()} autoFocus style={{ background: isDarkMode ? "#13131A" : "#F5F5F5", border: `1px solid ${isDarkMode ? "#2A2A3A" : "#D0D0D0"}`, color: isDarkMode ? "#E8E6E0" : "#1A1A1A" }} />
              </div>

              {/* Password */}
              {mode !== "reset" && (
                <div>
                  <label style={{ fontSize: 12, color: isDarkMode ? "#9A9898" : "#666666", marginBottom: 6, display: "block" }}>{t.password}</label>
                  <div style={{ position: "relative" }}>
                    <input
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={e => setPassword(e.target.value)}
                      placeholder="••••••••"
                      onKeyDown={e => e.key === "Enter" && submit()}
                      style={{ paddingRight: 42, background: isDarkMode ? "#13131A" : "#F5F5F5", border: `1px solid ${isDarkMode ? "#2A2A3A" : "#D0D0D0"}`, color: isDarkMode ? "#E8E6E0" : "#1A1A1A" }}
                    />
                    <button
                      onClick={() => setShowPassword(v => !v)}
                      style={{ position: "absolute", right: 12, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: isDarkMode ? "#9A9898" : "#666666", fontSize: 12, padding: 2, cursor: "pointer" }} >
                      {showPassword ? t.hide : t.show}
                    </button>
                  </div>
                  {/* Password requirements for register */}
                  {mode === "register" && password.length > 0 && <PasswordStrength password={password} />}
                </div>
              )}

              {/* Business details (register only) */}
              {mode === "register" && (
                <>
                  <div>
                    <label style={{ fontSize: 12, color: isDarkMode ? "#9A9898" : "#666666", marginBottom: 6, display: "block" }}>{t.businessName}</label>
                    <input
                      type="text"
                      value={businessName}
                      onChange={e => setBusinessName(e.target.value)}
                      placeholder="Your business name"
                      onKeyDown={e => e.key === "Enter" && submit()}
                      autoFocus={false}
                    />
                  </div>
                  <div>
                    <label style={{ fontSize: 12, color: isDarkMode ? "#9A9898" : "#666666", marginBottom: 6, display: "block" }}>{t.businessLocation}</label>
                    <input
                      type="text"
                      value={businessLocation}
                      onChange={e => setBusinessLocation(e.target.value)}
                      placeholder="City, Country"
                      onKeyDown={e => e.key === "Enter" && submit()}
                      autoFocus={false}
                    />
                  </div>
                </>
              )}

              {/* Remember me (login only) */}
              {mode === "login" && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }} onClick={() => setRememberMe(v => !v)}>
                  <div className={`check-box${rememberMe ? " checked" : ""}`} style={{ background: isDarkMode ? "#13131A" : "#F5F5F5", border: `1.5px solid ${isDarkMode ? "#2A2A3A" : "#D0D0D0"}` }}>
                    {rememberMe && <span style={{ color: "#fff", fontSize: 10 }}>✓</span>}
                  </div>
                  <span style={{ fontSize: 13, color: isDarkMode ? "#9A9898" : "#666666", userSelect: "none" }}>{t.rememberMe}</span>
                </div>
              )}

              {/* Error / Success */}
              {error && (
                <div style={{ fontSize: 12, padding: "10px 12px", borderRadius: 6, background: "#E24B4A18", color: "#E24B4A", lineHeight: 1.5, border: "1px solid #E24B4A33" }}>
                  {error}
                </div>
              )}
              {success && (
                <div style={{ fontSize: 12, padding: "10px 12px", borderRadius: 6, background: "#1D9E7518", color: "#1D9E75", lineHeight: 1.5, border: "1px solid #1D9E7533" }}>
                  {success}
                </div>
              )}

              {/* Submit */}
              <button
                onClick={submit}
                disabled={
                  loading ||
                  !email.trim() ||
                  (mode !== "reset" && !password) ||
                  (mode === "register" && (!passwordValid || !businessName.trim() || !businessLocation.trim()))
                }
                style={{ background: "#5B5BFF", color: "#fff", borderRadius: 8, padding: "12px", fontSize: 14, fontWeight: 500, opacity: (loading || (mode === "register" && !passwordValid && password.length > 0)) ? 0.6 : 1, marginTop: 4 }}
              >
                {loading ? "..." : mode === "login" ? "Sign in" : mode === "register" ? "Create account" : "Send reset link"}
              </button>

              {/* Mode switchers */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 2 }}>
                {mode === "login" ? (
                  <>
                    <button onClick={() => { setMode("register"); setError(null); setSuccess(null); }} style={{ fontSize: 12, color: "#9A9898", background: "none", border: "none", cursor: "pointer" }}>Create account</button>
                    <button onClick={() => { setMode("reset"); setError(null); setSuccess(null); }} style={{ fontSize: 12, color: "#9A9898", background: "none", border: "none", cursor: "pointer" }}>Forgot password?</button>
                  </>
                ) : (
                  <button onClick={() => { setMode("login"); setError(null); setSuccess(null); }} style={{ fontSize: 12, color: "#9A9898", background: "none", border: "none", cursor: "pointer" }}>← Back to sign in</button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const sb = {
  async getMembers(projectId) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/project_members?project_id=eq.${encodeURIComponent(projectId)}&order=joined_at.asc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    return res.json();
  },
  async getInvites(projectId) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/project_invites?project_id=eq.${encodeURIComponent(projectId)}&status=eq.pending&order=invited_at.asc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    return res.json();
  },
  async createInviteLink(projectId, projectName) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/project_invites`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=representation" },
      body: JSON.stringify({ project_id: projectId, project_name: projectName, email: `link-invite-${Date.now()}@preshield.link`, status: "pending" })
    });
    const data = await res.json();
    return Array.isArray(data) ? data[0] : data;
  },
  async createInviteByEmail(projectId, projectName, email, userBusinessMetadata = {}, emailSubject = "", emailBodyText = "") {
    const trimmed = String(email || "").trim().toLowerCase();
    const origin = (typeof window !== "undefined" && window.location && window.location.origin) ? window.location.origin : "";

    // Create + send is handled by the Supabase Edge Function.
    const res = await fetch(`${SUPABASE_URL}/functions/v1/send-invite-email`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        projectName,
        email: trimmed,
        businessName: userBusinessMetadata?.business_name,
        businessLocation: userBusinessMetadata?.business_location,
        subject: emailSubject,
        bodyText: emailBodyText,
        origin,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || data?.error || "Failed to send invite email");
    return data;
  },
  async getInviteByToken(token) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/project_invites?invite_token=eq.${token}&status=eq.pending`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
    const data = await res.json();
    return Array.isArray(data) ? data[0] : null;
  },
  async acceptInviteByToken(token, email) {
    const invite = await sb.getInviteByToken(token);
    if (!invite) throw new Error("Invalid or expired invite link");
    await fetch(`${SUPABASE_URL}/rest/v1/project_invites?id=eq.${invite.id}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "accepted" })
    });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/project_members`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ project_id: invite.project_id, email, role: "member" })
    });
    return invite;
  },
  async acceptInvite(projectId, email) {
    await fetch(`${SUPABASE_URL}/rest/v1/project_invites?project_id=eq.${encodeURIComponent(projectId)}&email=eq.${encodeURIComponent(email)}`, {
      method: "PATCH",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "accepted" })
    });
    const res = await fetch(`${SUPABASE_URL}/rest/v1/project_members`, {
      method: "POST",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify({ project_id: projectId, email, role: "member" })
    });
    return res.json();
  },
  async removeMember(id) {
    await fetch(`${SUPABASE_URL}/rest/v1/project_members?id=eq.${id}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
  },
  async cancelInvite(id) {
    await fetch(`${SUPABASE_URL}/rest/v1/project_invites?id=eq.${id}`, {
      method: "DELETE",
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` }
    });
  },

  // ── Project CRUD (auth-protected) ──────────────────────────────────────────
  headers(token) {
    return { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  },
  async loadProjects(token, options = {}) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/projects?order=created_at.asc`, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
      signal: options.signal,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Failed to load projects");
    return (Array.isArray(data) ? data : []).map(p => ({
      ...p,
      risks: p.risks || [],
      messages: p.messages || [],
      team: [],
      created: new Date(p.created_at).toLocaleDateString(),
    }));
  },
  async saveProject(token, project) {
    // Do not send user_id: many schemas use FK/RLS to public.users on that column; the
    // authenticated role then hits "permission denied for table users". Owner must be set
    // in the DB with DEFAULT auth.uid() (see supabase/set-project-owner-default.sql).
    const payload = {
      id: project.id,
      name: project.name,
      description: project.description || "",
      project_type: project.project_type || "other",
      team_size: project.team_size !== "" && project.team_size != null
        ? Math.max(0, parseInt(String(project.team_size), 10) || 0)
        : null,
      deadline: project.deadline || null,
      budget_range: project.budget_range || null,
      stakeholders: project.stakeholders || "",
      constraints: project.constraints || "",
      status: project.status || "setup",
      overall_risk_score: project.overall_risk_score || 0,
      risk_count: project.risks?.length || 0,
      report_generated: project.report_generated || false,
      messages: project.messages || [],
      risks: project.risks || [],
    };
    const res = await fetch(`${SUPABASE_URL}/rest/v1/projects`, {
      method: "POST",
      headers: { ...sb.headers(token), Prefer: "resolution=merge-duplicates,return=representation" },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Failed to save project");
    return Array.isArray(data) ? data[0] : data;
  },
  async deleteProject(token, projectId) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${projectId}`, {
      method: "DELETE",
      headers: sb.headers(token)
    });
    if (!res.ok) throw new Error("Failed to delete project");
  },
};

function localISODate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

const LANGS = {
  en: {
    appName: "PreShield",
    tagline: "AI-powered pre-mortem risk assessment",
    newProject: "New Project",
    dashboard: "Dashboard",
    projects: "Projects",
    noProjects: "No projects yet. Start your first pre-mortem.",
    createProject: "Create Project",
    savingProject: "Saving project…",
    saveProjectFailed: "Could not save project.",
    saveProjectUsersPermissionHint:
      "Supabase: (1) set-project-owner-default.sql (2) projects-rls-replace-policies.sql (3) Most common now: FK projects.user_id → auth.users — run fix-fk-to-auth-users.sql (4) Else trigger on projects — fix-permission-denied-users.sql",
    projectName: "Project name",
    projectType: "Project type",
    teamSize: "Team size",
    deadline: "Deadline",
    deadlinePast: "Deadline cannot be in the past.",
    budget: "Budget range",
    stakeholders: "Key stakeholders",
    constraints: "Known constraints",
    startInterview: "Start AI Interview",
    riskReport: "Risk Report",
    deleteProject: "Delete Project",
    deleteConfirm: "Are you sure you want to delete this project? This cannot be undone.",
    cancel: "Cancel",
    saveChanges: "Save",
    delete: "Delete",
    risks: "Risks",
    riskMatrix: "Risk Matrix",
    likelihood: "Likelihood",
    impact: "Impact",
    score: "Score",
    category: "Category",
    mitigation: "Mitigation",
    status: "Status",
    owner: "Owner",
    overallRisk: "Overall Risk Score",
    identified: "Identified",
    high: "High",
    medium: "Medium",
    low: "Low",
    critical: "Critical",
    allRisksTitle: "All Identified Risks",
    matrixExplainer: "Risks are placed by likelihood (up the chart) and impact (to the right). Higher values mean greater exposure.",
    mitigationPlanHeader: "Mitigation Plan",
    impactAxisShort: "Impact →",
    deleteRiskConfirm: "Remove this risk from the project?",
    thinking: "Analyzing...",
    typeMessage: "Type your response...",
    send: "Send",
    exportPDF: "Export Report",
    back: "Back",
    next: "Next",
    finish: "Finish",
    projectTypes: {
      software_development: "Software Development",
      product_launch: "Product Launch",
      infrastructure: "Infrastructure",
      migration: "Migration",
      marketing_campaign: "Marketing Campaign",
      organizational_change: "Org Change",
      research: "Research",
      other: "Other",
    },
    budgets: {
      under_10k: "Under $10k",
      "10k_50k": "$10k–$50k",
      "50k_200k": "$50k–$200k",
      "200k_1m": "$200k–$1M",
      over_1m: "Over $1M",
    },
    complete: "Complete",
    interviewing: "Interviewing",
    setup: "Setup",
    addComment: "Add comment",
    comments: "Comments",
    teamMembers: "Team Members",
    totalProjects: "Total Projects",
    risksIdentified: "Risks Identified",
    completionRate: "Completion Rate",
    acrossAllProjects: "Across all projects",
    recentProjects: "Recent Projects",
    due: "Due",
    viewReport: "View Report",
    open: "Open",
    rank: "Rank",
    inviteTeam: "Invite teammate",
    emailPlaceholder: "teammate@company.com",
    invite: "Invite",
    editRisk: "Edit",
    inviteByEmailButton: "Invite by email",
    newLink: "New link",
    inviteByEmailTitle: "Invite by Email",
    inviteEmailIntro:
      "We will send an invite email to the address below (using your app’s no-reply sender). The email includes your business name and the project name.",
    teammateEmailLabel: "Teammate email",
    emailPreviewTitle: "Email Preview",
    subjectLabel: "Subject",
    messageLabel: "Message",
    inviteTipJoinUrlPrefix: "Tip: the join link will be inserted where you write",
    sendInvite: "Send invite",
    sending: "Sending...",
    shareableLinkIntro:
      "Generate a shareable link — send it via WhatsApp, Slack, or email. Anyone with the link can join.",
    generateInviteLink: "🔗 Generate Invite Link",
    generatingInviteLink: "Generating...",
    copyLabel: "Copy",
    copiedLabel: "✓ Copied",
    assignOwner: "Assign owner",
    riskCategories: {
      technical: "Technical",
      resource: "Resource",
      schedule: "Schedule",
      scope: "Scope",
      communication: "Communication",
      external: "External",
      organizational: "Organizational",
      financial: "Financial",
    },
    noTeamMembers: "No team members yet.",
    completeInterviewFirst: "Complete the AI interview to identify risks.",
    completeInterviewMatrix: "Complete the AI interview to generate the risk matrix.",
    riskHeatmap: "Risk Heatmap",
    landingBadge: "AI-POWERED PRE-MORTEM",
    landingHeadline1: "Find what breaks",
    landingHeadline2: "before it breaks.",
    landingSubtitle: "Run a conversational AI interview, surface hidden risks, and get an actionable report — before your project starts.",
    feat1Title: "AI Interview",
    feat1Desc: "Conversational risk discovery",
    feat2Title: "Risk Matrix",
    feat2Desc: "Visual likelihood × impact grid",
    feat3Title: "5 Languages",
    feat3Desc: "EN, HE, ES, FR, DE",
    interviewIntro: "An AI facilitator will interview you to surface hidden project risks before they happen.",
    statusIdentified: "Identified",
    statusMitigating: "Mitigating",
    statusAccepted: "Accepted",
    statusResolved: "Resolved",
    member: "member",
    risksExtracted: "✅ Risks extracted and added to your report.",
    connectionError: "Connection error. Please try again.",
    interviewApiHint: "Add GEMINI_API_KEY to a .env file in this folder, then restart the dev server (npm run dev).",
    tabInterview: "Interview",
    tabRisks: "Risks",
    tabMatrix: "Matrix",
    tabTeam: "Team",
    tabChat: "Chat",
    projectChatTitle: "Project Team Chat",
    projectChatHint: "Use this space to coordinate tasks, blockers, and updates for this project.",
    noProjectChatYet: "No messages yet. Start the project conversation.",
    chatPlaceholder: "Write a message to your team...",
    interviewRelevantOnly:
      "I can only help with project-risk interview questions here. Please share project details, constraints, risks, timeline, budget, stakeholders, or delivery concerns.",
    description: "Project description",
    descriptionPlaceholder: "What you’re building, for whom, and what “done” looks like.",
    projectNamePlaceholder: "e.g. Q3 billing platform migration",
    teamSizePlaceholder: "e.g. 8",
    stakeholdersPlaceholder: "e.g. CTO, product lead, engineering manager",
    constraintsPlaceholder: "e.g. must integrate with SAP, fixed go-live date, $50k cap",
    generateReport: "Generate Report",
    reportGenerated: "Report Generated",
    markComplete: "Mark Complete",
    in_progress: "In Progress",
    completed: "Completed",
    questionsAsked: "Questions asked",
    risksFound: "Risks found",
    projectDescription: "Description",
    statusInProgress: "In Progress",
    statusCompleted: "Completed",
    statusSetup: "Setup",
    statusInterviewing: "Interviewing",
    statusReportReady: "Report Ready",
    dashboardSearchPlaceholder: "Search by project name…",
    dashboardFilterStatus: "Status",
    dashboardAllStatuses: "All statuses",
    dashboardNoMatches: "No projects match your search or filter.",
    themeUseLight: "Switch to light mode",
    themeUseDark: "Switch to dark mode",
  },
  he: {
    appName: "פרישילד",
    tagline: "הערכת סיכונים מוקדמת מבוססת AI",
    newProject: "פרויקט חדש",
    dashboard: "לוח בקרה",
    projects: "פרויקטים",
    noProjects: "אין פרויקטים עדיין. התחל את הניתוח הראשון שלך.",
    createProject: "צור פרויקט",
    savingProject: "שומר פרויקט…",
    saveProjectFailed: "לא ניתן לשמור את הפרויקט.",
    saveProjectUsersPermissionHint:
      "Supabase: (1) set-project-owner-default (2) projects-rls-replace-policies (3) FK ל-auth.users — fix-fk-to-auth-users.sql (4) טריגר — fix-permission-denied-users",
    projectName: "שם הפרויקט",
    projectType: "סוג פרויקט",
    teamSize: "גודל הצוות",
    deadline: "תאריך יעד",
    deadlinePast: "התאריך לא יכול להיות בעבר.",
    budget: "טווח תקציב",
    stakeholders: "בעלי עניין מרכזיים",
    constraints: "אילוצים ידועים",
    startInterview: "התחלת ראיון AI",
    riskReport: "דוח סיכונים",
    deleteProject: "מחק פרויקט",
    deleteConfirm: "האם אתה בטוח שברצונך למחוק פרויקט זה? לא ניתן לבטל פעולה זו.",
    cancel: "ביטול",
    delete: "מחק",
    risks: "סיכונים",
    riskMatrix: "מטריצת סיכונים",
    likelihood: "סבירות",
    impact: "השפעה",
    score: "ציון",
    category: "קטגוריה",
    mitigation: "הפחתה",
    status: "סטטוס",
    owner: "אחראי",
    overallRisk: "ציון סיכון כולל",
    identified: "זוהה",
    high: "גבוה",
    medium: "בינוני",
    low: "נמוך",
    critical: "קריטי",
    allRisksTitle: "כל הסיכונים שזוהו",
    matrixExplainer: "סיכונים ממוקמים לפי סבירות (למעלה) והשפעה (ימינה). ערכים גבוהים יותר = חשיפה גבוהה יותר.",
    mitigationPlanHeader: "תוכנית הפחתה",
    impactAxisShort: "השפעה ←",
    deleteRiskConfirm: "להסיר את הסיכון הזה מהפרויקט?",
    thinking: "מנתח...",
    typeMessage: "הקלד את תגובתך...",
    send: "שלח",
    exportPDF: "ייצא דוח",
    back: "חזור",
    next: "הבא",
    finish: "סיים",
    projectTypes: {
      software_development: "פיתוח תוכנה",
      product_launch: "השקת מוצר",
      infrastructure: "תשתית",
      migration: "מיגרציה",
      marketing_campaign: "קמפיין שיווקי",
      organizational_change: "שינוי ארגוני",
      research: "מחקר",
      other: "אחר",
    },
    budgets: {
      under_10k: "מתחת ל-$10k",
      "10k_50k": "$10k–$50k",
      "50k_200k": "$50k–$200k",
      "200k_1m": "$200k–$1M",
      over_1m: "מעל $1M",
    },
    complete: "הושלם",
    interviewing: "בראיון",
    setup: "הגדרה",
    addComment: "הוסף תגובה",
    comments: "תגובות",
    teamMembers: "חברי צוות",
    totalProjects: "כל הפרויקטים",
    risksIdentified: "סיכונים שזוהו",
    completionRate: "שיעור השלמה",
    acrossAllProjects: "בכל הפרויקטים",
    recentProjects: "פרויקטים אחרונים",
    due: "תאריך יעד",
    viewReport: "צפה בדוח",
    open: "פתח",
    rank: "דירוג",
    inviteTeam: "הזמן עמית",
    emailPlaceholder: "colleague@company.com",
    invite: "הזמן",
    editRisk: "ערוך",
    inviteByEmailButton: "הזמן במייל",
    newLink: "קישור חדש",
    inviteByEmailTitle: "הזמנה במייל",
    inviteEmailIntro:
      "נשלח מייל הזמנה לכתובת שלמטה (באמצעות כתובת ללא תשובה של האפליקציה). המייל כולל את שם העסק שלך ושם הפרויקט.",
    teammateEmailLabel: "מייל עמית",
    emailPreviewTitle: "תצוגת מייל",
    subjectLabel: "נושא",
    messageLabel: "הודעה",
    inviteTipJoinUrlPrefix: "טיפ: קישור ההצטרפות יוכנס במקום שבו אתה כותב",
    sendInvite: "שלח הזמנה",
    sending: "שולח...",
    shareableLinkIntro:
      "צור קישור לשיתוף— שלח אותו באמצעות WhatsApp, Slack או דוא\"ל. כל מי שיש לו את הקישור יכול להצטרף.",
    generateInviteLink: "🔗 יצירת קישור הזמנה",
    generatingInviteLink: "יוצר...",
    copyLabel: "העתק",
    copiedLabel: "✓ הועתק",
    assignOwner: "הקצה אחראי",
    riskCategories: {
      technical: "טכני",
      resource: "משאבים",
      schedule: "לוח זמנים",
      scope: "היקף",
      communication: "תקשורת",
      external: "חיצוני",
      organizational: "ארגוני",
      financial: "פיננסי",
    },
    noTeamMembers: "אין חברי צוות עדיין.",
    completeInterviewFirst: "השלם את ראיון ה-AI כדי לזהות סיכונים.",
    completeInterviewMatrix: "השלם את ראיון ה-AI כדי ליצור את מטריצת הסיכונים.",
    riskHeatmap: "מפת חום סיכונים",
    landingBadge: "ניתוח PRE-MORTEM מבוסס AI",
    landingHeadline1: "גלה מה ישבר",
    landingHeadline2: "לפני שזה שובר.",
    landingSubtitle: "הפעל ראיון AI שיחתי, גלה סיכונים נסתרים וקבל דוח פעולות — לפני שהפרויקט מתחיל.",
    feat1Title: "ראיון AI",
    feat1Desc: "גילוי סיכונים שיחתי",
    feat2Title: "מטריצת סיכונים",
    feat2Desc: "רשת ויזואלית סבירות × השפעה",
    feat3Title: "5 שפות",
    feat3Desc: "EN, HE, ES, FR, DE",
    interviewIntro: "מנחה AI ישאל אותך שאלות כדי לחשוף סיכוני פרויקט נסתרים לפני שהם קורים.",
    statusIdentified: "זוהה",
    statusMitigating: "בטיפול",
    statusAccepted: "מקובל",
    statusResolved: "נפתר",
    member: "חבר",
    risksExtracted: "✅ סיכונים חולצו והתווספו לדוח שלך.",
    connectionError: "שגיאת חיבור. אנא נסה שוב.",
    interviewApiHint: "הוסף GEMINI_API_KEY לקובץ .env בתיקייה, ואז הפעל מחדש npm run dev.",
    tabInterview: "ראיון",
    tabRisks: "סיכונים",
    tabMatrix: "מטריצה",
    tabTeam: "צוות",
    tabChat: "צ׳אט",
    projectChatTitle: "צ׳אט צוות הפרויקט",
    projectChatHint: "השתמשו כאן לתיאום משימות, חסמים ועדכונים בפרויקט.",
    noProjectChatYet: "אין הודעות עדיין. התחילו את שיחת הפרויקט.",
    chatPlaceholder: "כתבו הודעה לצוות...",
    interviewRelevantOnly:
      "כאן אני יכול לעזור רק בשאלות ראיון שקשורות לסיכוני פרויקט. נא לשתף פרטי פרויקט, אילוצים, סיכונים, לו״ז, תקציב ובעלי עניין.",
    description: "תיאור הפרויקט",
    descriptionPlaceholder: "מה בונים, למי, ומה נחשב להצלחה.",
    projectNamePlaceholder: "לדוגמה: מיגרציית מערכת החיוב — רבעון 3",
    teamSizePlaceholder: "לדוגמה: 8",
    stakeholdersPlaceholder: "לדוגמה: סמנכ״ל טכנולוגיות, מנהל מוצר, ראש צוות פיתוח",
    constraintsPlaceholder: "לדוגמה: חיבור למערכת קיימת, תאריך עליה קשיח, תקרת תקציב",
    generateReport: "צור דוח",
    reportGenerated: "דוח נוצר",
    markComplete: "סמן כהושלם",
    in_progress: "בתהליך",
    completed: "הושלם",
    questionsAsked: "שאלות שנשאלו",
    risksFound: "סיכונים שנמצאו",
    projectDescription: "תיאור",
    statusInProgress: "בתהליך",
    statusCompleted: "הושלם",
    statusSetup: "הגדרה",
    statusInterviewing: "בראיון",
    statusReportReady: "דוח מוכן",
    dashboardSearchPlaceholder: "חיפוש לפי שם פרויקט…",
    dashboardFilterStatus: "סטטוס",
    dashboardAllStatuses: "כל הסטטוסים",
    dashboardNoMatches: "אין פרויקטים שמתאימים לחיפוש או לסינון.",
    themeUseLight: "מעבר למצב בהיר",
    themeUseDark: "מעבר למצב כהה",
  },
  es: {
    appName: "PreShield",
    tagline: "Evaluación de riesgos pre-mortem con IA",
    newProject: "Nuevo Proyecto",
    dashboard: "Panel",
    projects: "Proyectos",
    noProjects: "Sin proyectos aún. Comienza tu primer pre-mortem.",
    createProject: "Crear Proyecto",
    savingProject: "Guardando proyecto…",
    saveProjectFailed: "No se pudo guardar el proyecto.",
    saveProjectUsersPermissionHint:
      "Supabase: (1) set-project-owner-default (2) projects-rls-replace-policies (3) FK a auth.users: fix-fk-to-auth-users.sql (4) trigger: fix-permission-denied-users",
    projectName: "Nombre del proyecto",
    projectType: "Tipo de proyecto",
    teamSize: "Tamaño del equipo",
    deadline: "Fecha límite",
    deadlinePast: "La fecha límite no puede estar en el pasado.",
    budget: "Rango de presupuesto",
    stakeholders: "Partes interesadas",
    constraints: "Restricciones conocidas",
    startInterview: "Iniciar entrevista IA",
    riskReport: "Informe de riesgos",
    deleteProject: "Eliminar proyecto",
    deleteConfirm: "¿Seguro que deseas eliminar este proyecto? Esta acción no se puede deshacer.",
    cancel: "Cancelar",
    saveChanges: "Guardar",
    delete: "Eliminar",
    risks: "Riesgos",
    riskMatrix: "Matriz de riesgos",
    likelihood: "Probabilidad",
    impact: "Impacto",
    score: "Puntuación",
    category: "Categoría",
    mitigation: "Mitigación",
    status: "Estado",
    owner: "Responsable",
    overallRisk: "Puntuación de riesgo global",
    identified: "Identificado",
    high: "Alto",
    medium: "Medio",
    low: "Bajo",
    critical: "Crítico",
    allRisksTitle: "Todos los riesgos identificados",
    matrixExplainer: "Los riesgos se ubican por probabilidad (hacia arriba) e impacto (hacia la derecha). Valores más altos = mayor exposición.",
    mitigationPlanHeader: "Plan de mitigación",
    impactAxisShort: "Impacto →",
    deleteRiskConfirm: "¿Quitar este riesgo del proyecto?",
    thinking: "Analizando...",
    typeMessage: "Escribe tu respuesta...",
    send: "Enviar",
    exportPDF: "Exportar informe",
    back: "Atrás",
    next: "Siguiente",
    finish: "Finalizar",
    projectTypes: {
      software_development: "Desarrollo de software",
      product_launch: "Lanzamiento de producto",
      infrastructure: "Infraestructura",
      migration: "Migración",
      marketing_campaign: "Campaña de marketing",
      organizational_change: "Cambio organizacional",
      research: "Investigación",
      other: "Otro",
    },
    budgets: {
      under_10k: "Menos de $10k",
      "10k_50k": "$10k–$50k",
      "50k_200k": "$50k–$200k",
      "200k_1m": "$200k–$1M",
      over_1m: "Más de $1M",
    },
    complete: "Completo",
    interviewing: "Entrevistando",
    setup: "Configuración",
    addComment: "Añadir comentario",
    comments: "Comentarios",
    teamMembers: "Miembros del equipo",
    totalProjects: "Proyectos totales",
    risksIdentified: "Riesgos identificados",
    completionRate: "Tasa de finalización",
    acrossAllProjects: "En todos los proyectos",
    recentProjects: "Proyectos recientes",
    due: "Vence",
    viewReport: "Ver informe",
    open: "Abrir",
    rank: "Rango",
    inviteTeam: "Invitar compañero",
    emailPlaceholder: "compañero@empresa.com",
    invite: "Invitar",
    editRisk: "Editar",
    inviteByEmailButton: "Invitar por correo",
    newLink: "Nuevo enlace",
    inviteByEmailTitle: "Invitar por correo",
    inviteEmailIntro:
      "Enviaremos un correo de invitación a la dirección de abajo (usando el remitente sin respuesta de tu app). El correo incluye tu nombre de empresa y el nombre del proyecto.",
    teammateEmailLabel: "Correo del compañero de equipo",
    emailPreviewTitle: "Vista previa del correo",
    subjectLabel: "Asunto",
    messageLabel: "Mensaje",
    inviteTipJoinUrlPrefix: "Consejo: el enlace de acceso se insertará donde escribas",
    sendInvite: "Enviar invitación",
    sending: "Enviando...",
    shareableLinkIntro:
      "Genera un enlace compartible; envíalo por WhatsApp, Slack o correo. Cualquiera con el enlace puede unirse.",
    generateInviteLink: "🔗 Generar enlace de invitación",
    generatingInviteLink: "Generando...",
    copyLabel: "Copiar",
    copiedLabel: "✓ Copiado",
    assignOwner: "Asignar responsable",
    riskCategories: {
      technical: "Técnico",
      resource: "Recursos",
      schedule: "Calendario",
      scope: "Alcance",
      communication: "Comunicación",
      external: "Externo",
      organizational: "Organizativo",
      financial: "Financiero",
    },
    noTeamMembers: "Aún no hay miembros del equipo.",
    completeInterviewFirst: "Completa la entrevista IA para identificar riesgos.",
    completeInterviewMatrix: "Completa la entrevista IA para generar la matriz de riesgos.",
    riskHeatmap: "Mapa de calor de riesgos",
    landingBadge: "PRE-MORTEM IMPULSADO POR IA",
    landingHeadline1: "Encuentra lo que falla",
    landingHeadline2: "antes de que falle.",
    landingSubtitle: "Realiza una entrevista conversacional con IA, descubre riesgos ocultos y obtén un informe accionable — antes de comenzar el proyecto.",
    feat1Title: "Entrevista IA",
    feat1Desc: "Descubrimiento conversacional de riesgos",
    feat2Title: "Matriz de riesgos",
    feat2Desc: "Cuadrícula visual probabilidad × impacto",
    feat3Title: "5 Idiomas",
    feat3Desc: "EN, HE, ES, FR, DE",
    interviewIntro: "Un facilitador IA te entrevistará para descubrir riesgos ocultos antes de que ocurran.",
    statusIdentified: "Identificado",
    statusMitigating: "Mitigando",
    statusAccepted: "Aceptado",
    statusResolved: "Resuelto",
    member: "miembro",
    risksExtracted: "✅ Riesgos extraídos y añadidos a tu informe.",
    connectionError: "Error de conexión. Por favor, inténtalo de nuevo.",
    interviewApiHint: "Añade GEMINI_API_KEY a un archivo .env en esta carpeta y reinicia npm run dev.",
    tabInterview: "Entrevista",
    tabRisks: "Riesgos",
    tabMatrix: "Matriz",
    tabTeam: "Equipo",
    tabChat: "Chat",
    projectChatTitle: "Chat del equipo del proyecto",
    projectChatHint: "Usa este espacio para coordinar tareas, bloqueos y actualizaciones del proyecto.",
    noProjectChatYet: "Aún no hay mensajes. Empieza la conversación del proyecto.",
    chatPlaceholder: "Escribe un mensaje para tu equipo...",
    interviewRelevantOnly:
      "Aquí solo puedo ayudar con preguntas de entrevista sobre riesgos del proyecto. Comparte detalles del proyecto, restricciones, riesgos, cronograma, presupuesto o stakeholders.",
    description: "Descripción del proyecto",
    descriptionPlaceholder: "Qué construyes, para quién y cuándo se considera un éxito.",
    projectNamePlaceholder: "p. ej., Migración de facturación Q3",
    teamSizePlaceholder: "p. ej., 8",
    stakeholdersPlaceholder: "p. ej., CTO, director de producto, lead de ingeniería",
    constraintsPlaceholder: "p. ej., integración con SAP, fecha fija de lanzamiento, tope de presupuesto",
    generateReport: "Generar informe",
    reportGenerated: "Informe generado",
    markComplete: "Marcar como completado",
    in_progress: "En curso",
    completed: "Completado",
    questionsAsked: "Preguntas realizadas",
    risksFound: "Riesgos encontrados",
    projectDescription: "Descripción",
    statusInProgress: "En curso",
    statusCompleted: "Completado",
    statusSetup: "Configuración",
    statusInterviewing: "Entrevistando",
    statusReportReady: "Informe listo",
    dashboardSearchPlaceholder: "Buscar por nombre de proyecto…",
    dashboardFilterStatus: "Estado",
    dashboardAllStatuses: "Todos los estados",
    dashboardNoMatches: "Ningún proyecto coincide con la búsqueda o el filtro.",
    themeUseLight: "Modo claro",
    themeUseDark: "Modo oscuro",
  },
  fr: {
    appName: "PreShield",
    tagline: "Évaluation des risques pré-mortem par IA",
    newProject: "Nouveau Projet",
    dashboard: "Tableau de bord",
    projects: "Projets",
    noProjects: "Aucun projet. Commencez votre premier pré-mortem.",
    createProject: "Créer un projet",
    savingProject: "Enregistrement du projet…",
    saveProjectFailed: "Impossible d’enregistrer le projet.",
    saveProjectUsersPermissionHint:
      "Supabase : (1) set-project-owner-default (2) projects-rls-replace-policies (3) FK vers auth.users : fix-fk-to-auth-users.sql (4) trigger : fix-permission-denied-users",
    projectName: "Nom du projet",
    projectType: "Type de projet",
    teamSize: "Taille de l'équipe",
    deadline: "Date limite",
    deadlinePast: "La date limite ne peut pas être dans le passé.",
    budget: "Fourchette budgétaire",
    stakeholders: "Parties prenantes",
    constraints: "Contraintes connues",
    startInterview: "Démarrer l'entretien IA",
    riskReport: "Rapport de risques",
    deleteProject: "Supprimer le projet",
    deleteConfirm: "Voulez-vous vraiment supprimer ce projet ? Cette action est irréversible.",
    cancel: "Annuler",
    saveChanges: "Enregistrer",
    delete: "Supprimer",
    risks: "Risques",
    riskMatrix: "Matrice des risques",
    likelihood: "Probabilité",
    impact: "Impact",
    score: "Score",
    category: "Catégorie",
    mitigation: "Atténuation",
    status: "Statut",
    owner: "Responsable",
    overallRisk: "Score de risque global",
    identified: "Identifié",
    high: "Élevé",
    medium: "Moyen",
    low: "Faible",
    critical: "Critique",
    allRisksTitle: "Tous les risques identifiés",
    matrixExplainer: "Les risques sont placés selon la probabilité (vers le haut) et l’impact (vers la droite). Des valeurs plus élevées signifient une exposition plus forte.",
    mitigationPlanHeader: "Plan d’atténuation",
    impactAxisShort: "Impact →",
    deleteRiskConfirm: "Retirer ce risque du projet ?",
    thinking: "Analyse en cours...",
    typeMessage: "Saisissez votre réponse...",
    send: "Envoyer",
    exportPDF: "Exporter le rapport",
    back: "Retour",
    next: "Suivant",
    finish: "Terminer",
    projectTypes: {
      software_development: "Développement logiciel",
      product_launch: "Lancement produit",
      infrastructure: "Infrastructure",
      migration: "Migration",
      marketing_campaign: "Campagne marketing",
      organizational_change: "Changement organisationnel",
      research: "Recherche",
      other: "Autre",
    },
    budgets: {
      under_10k: "Moins de 10k$",
      "10k_50k": "10k$–50k$",
      "50k_200k": "50k$–200k$",
      "200k_1m": "200k$–1M$",
      over_1m: "Plus de 1M$",
    },
    complete: "Terminé",
    interviewing: "Entretien",
    setup: "Configuration",
    addComment: "Ajouter un commentaire",
    comments: "Commentaires",
    teamMembers: "Membres de l'équipe",
    totalProjects: "Projets totaux",
    risksIdentified: "Risques identifiés",
    completionRate: "Taux d'achèvement",
    acrossAllProjects: "Sur tous les projets",
    recentProjects: "Projets récents",
    due: "Échéance",
    viewReport: "Voir le rapport",
    open: "Ouvrir",
    rank: "Classement",
    inviteTeam: "Inviter un collègue",
    emailPlaceholder: "collègue@entreprise.com",
    invite: "Inviter",
    editRisk: "Modifier",
    inviteByEmailButton: "Inviter par e-mail",
    newLink: "Nouveau lien",
    inviteByEmailTitle: "Inviter par e-mail",
    inviteEmailIntro:
      "Nous enverrons un e-mail d'invitation à l'adresse ci-dessous (en utilisant l'expéditeur sans réponse de votre application). L'e-mail inclut votre nom d'entreprise et le nom du projet.",
    teammateEmailLabel: "E-mail du coéquipier",
    emailPreviewTitle: "Aperçu de l'e-mail",
    subjectLabel: "Objet",
    messageLabel: "Message",
    inviteTipJoinUrlPrefix: "Astuce : le lien d'accès sera inséré à l'endroit où vous écrivez",
    sendInvite: "Envoyer l'invitation",
    sending: "Envoi...",
    shareableLinkIntro:
      "Générez un lien partageable : envoyez-le via WhatsApp, Slack ou e-mail. Toute personne disposant du lien peut rejoindre.",
    generateInviteLink: "🔗 Générer le lien d'invitation",
    generatingInviteLink: "Génération...",
    copyLabel: "Copier",
    copiedLabel: "✓ Copié",
    assignOwner: "Assigner un responsable",
    riskCategories: {
      technical: "Technique",
      resource: "Ressources",
      schedule: "Planification",
      scope: "Portée",
      communication: "Communication",
      external: "Externe",
      organizational: "Organisation",
      financial: "Financier",
    },
    noTeamMembers: "Aucun membre d'équipe pour l'instant.",
    completeInterviewFirst: "Terminez l'entretien IA pour identifier les risques.",
    completeInterviewMatrix: "Terminez l'entretien IA pour générer la matrice des risques.",
    riskHeatmap: "Carte de chaleur des risques",
    landingBadge: "PRÉ-MORTEM PROPULSÉ PAR IA",
    landingHeadline1: "Trouvez ce qui échoue",
    landingHeadline2: "avant que ça échoue.",
    landingSubtitle: "Menez un entretien IA conversationnel, détectez les risques cachés et obtenez un rapport actionnable — avant le démarrage du projet.",
    feat1Title: "Entretien IA",
    feat1Desc: "Découverte conversationnelle des risques",
    feat2Title: "Matrice des risques",
    feat2Desc: "Grille visuelle probabilité × impact",
    feat3Title: "5 Langues",
    feat3Desc: "EN, HE, ES, FR, DE",
    interviewIntro: "Un facilitateur IA vous interrogera pour révéler les risques cachés avant qu'ils se produisent.",
    statusIdentified: "Identifié",
    statusMitigating: "Atténuation",
    statusAccepted: "Accepté",
    statusResolved: "Résolu",
    member: "membre",
    risksExtracted: "✅ Risques extraits et ajoutés à votre rapport.",
    connectionError: "Erreur de connexion. Veuillez réessayer.",
    interviewApiHint: "Ajoutez GEMINI_API_KEY dans un fichier .env à la racine, puis redémarrez npm run dev.",
    tabInterview: "Entretien",
    tabRisks: "Risques",
    tabMatrix: "Matrice",
    tabTeam: "Équipe",
    tabChat: "Chat",
    projectChatTitle: "Chat de l'équipe projet",
    projectChatHint: "Utilisez cet espace pour coordonner les tâches, les blocages et les mises à jour du projet.",
    noProjectChatYet: "Aucun message pour l'instant. Lancez la conversation du projet.",
    chatPlaceholder: "Écrivez un message à votre équipe...",
    interviewRelevantOnly:
      "Ici, je peux seulement aider pour des questions d'entretien liées aux risques du projet. Partagez les détails du projet, contraintes, risques, planning, budget ou parties prenantes.",
    description: "Description du projet",
    descriptionPlaceholder: "Ce que vous livrez, pour qui, et ce qui compte comme un succès.",
    projectNamePlaceholder: "ex. : Migration de la facturation T3",
    teamSizePlaceholder: "ex. : 8",
    stakeholdersPlaceholder: "ex. : DSI, chef de produit, lead technique",
    constraintsPlaceholder: "ex. : intégration SAP, date de mise en ligne fixe, plafond budgétaire",
    generateReport: "Générer le rapport",
    reportGenerated: "Rapport généré",
    markComplete: "Marquer comme terminé",
    in_progress: "En cours",
    completed: "Terminé",
    questionsAsked: "Questions posées",
    risksFound: "Risques trouvés",
    projectDescription: "Description",
    statusInProgress: "En cours",
    statusCompleted: "Terminé",
    statusSetup: "Configuration",
    statusInterviewing: "Entretien",
    statusReportReady: "Rapport prêt",
    dashboardSearchPlaceholder: "Rechercher par nom de projet…",
    dashboardFilterStatus: "Statut",
    dashboardAllStatuses: "Tous les statuts",
    dashboardNoMatches: "Aucun projet ne correspond à la recherche ou au filtre.",
    themeUseLight: "Mode clair",
    themeUseDark: "Mode sombre",
  },
  de: {
    appName: "PreShield",
    tagline: "KI-gestützte Pre-Mortem-Risikoanalyse",
    newProject: "Neues Projekt",
    dashboard: "Dashboard",
    projects: "Projekte",
    noProjects: "Noch keine Projekte. Starten Sie Ihre erste Analyse.",
    createProject: "Projekt erstellen",
    savingProject: "Projekt wird gespeichert…",
    saveProjectFailed: "Projekt konnte nicht gespeichert werden.",
    saveProjectUsersPermissionHint:
      "Supabase: (1) set-project-owner-default (2) projects-rls-replace-policies (3) FK zu auth.users: fix-fk-to-auth-users.sql (4) Trigger: fix-permission-denied-users",
    projectName: "Projektname",
    projectType: "Projekttyp",
    teamSize: "Teamgröße",
    deadline: "Deadline",
    deadlinePast: "Die Deadline darf nicht in der Vergangenheit liegen.",
    budget: "Budgetrahmen",
    stakeholders: "Wichtige Stakeholder",
    constraints: "Bekannte Einschränkungen",
    startInterview: "KI-Interview starten",
    riskReport: "Risikobericht",
    deleteProject: "Projekt löschen",
    deleteConfirm: "Möchten Sie dieses Projekt wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.",
    cancel: "Abbrechen",
    saveChanges: "Speichern",
    delete: "Löschen",
    risks: "Risiken",
    riskMatrix: "Risikomatrix",
    likelihood: "Wahrscheinlichkeit",
    impact: "Auswirkung",
    score: "Score",
    category: "Kategorie",
    mitigation: "Minderung",
    status: "Status",
    owner: "Verantwortlicher",
    overallRisk: "Gesamtrisiko-Score",
    identified: "Identifiziert",
    high: "Hoch",
    medium: "Mittel",
    low: "Niedrig",
    critical: "Kritisch",
    allRisksTitle: "Alle identifizierten Risiken",
    matrixExplainer: "Risiken werden nach Wahrscheinlichkeit (nach oben) und Auswirkung (nach rechts) platziert. Höhere Werte bedeuten stärkere Exposition.",
    mitigationPlanHeader: "Minderungsplan",
    impactAxisShort: "Auswirkung →",
    deleteRiskConfirm: "Dieses Risiko aus dem Projekt entfernen?",
    thinking: "Analysiere...",
    typeMessage: "Antwort eingeben...",
    send: "Senden",
    exportPDF: "Bericht exportieren",
    back: "Zurück",
    next: "Weiter",
    finish: "Fertigstellen",
    projectTypes: {
      software_development: "Softwareentwicklung",
      product_launch: "Produkteinführung",
      infrastructure: "Infrastruktur",
      migration: "Migration",
      marketing_campaign: "Marketingkampagne",
      organizational_change: "Organisatorischer Wandel",
      research: "Forschung",
      other: "Sonstiges",
    },
    budgets: {
      under_10k: "Unter $10k",
      "10k_50k": "$10k–$50k",
      "50k_200k": "$50k–$200k",
      "200k_1m": "$200k–$1M",
      over_1m: "Über $1M",
    },
    complete: "Abgeschlossen",
    interviewing: "Im Interview",
    setup: "Einrichtung",
    addComment: "Kommentar hinzufügen",
    comments: "Kommentare",
    teamMembers: "Teammitglieder",
    totalProjects: "Gesamtprojekte",
    risksIdentified: "Identifizierte Risiken",
    completionRate: "Abschlussquote",
    acrossAllProjects: "Über alle Projekte",
    recentProjects: "Aktuelle Projekte",
    due: "Fällig",
    viewReport: "Bericht ansehen",
    open: "Öffnen",
    rank: "Rang",
    inviteTeam: "Kollegen einladen",
    emailPlaceholder: "kollege@firma.com",
    invite: "Einladen",
    editRisk: "Bearbeiten",
    inviteByEmailButton: "Per E-Mail einladen",
    newLink: "Neuer Link",
    inviteByEmailTitle: "Per E-Mail einladen",
    inviteEmailIntro:
      "Wir senden eine Einladung per E-Mail an die unten angegebene Adresse (mit dem No-Reply-Absender deiner App). Die E-Mail enthält deinen Geschäftsnamen und den Projektnamen.",
    teammateEmailLabel: "E-Mail des Teammitglieds",
    emailPreviewTitle: "E-Mail-Vorschau",
    subjectLabel: "Betreff",
    messageLabel: "Nachricht",
    inviteTipJoinUrlPrefix: "Tipp: Der Beitrittslink wird dort eingefügt, wo du schreibst",
    sendInvite: "Einladung senden",
    sending: "Senden...",
    shareableLinkIntro:
      "Erstelle einen freigabefähigen Link: sende ihn über WhatsApp, Slack oder E-Mail. Jeder mit dem Link kann beitreten.",
    generateInviteLink: "🔗 Einladung-Link erstellen",
    generatingInviteLink: "Erstellt...",
    copyLabel: "Kopieren",
    copiedLabel: "✓ Kopiert",
    assignOwner: "Verantwortlichen zuweisen",
    riskCategories: {
      technical: "Technisch",
      resource: "Ressourcen",
      schedule: "Zeitplan",
      scope: "Umfang",
      communication: "Kommunikation",
      external: "Extern",
      organizational: "Organisatorisch",
      financial: "Finanziell",
    },
    noTeamMembers: "Noch keine Teammitglieder.",
    completeInterviewFirst: "Schließen Sie das KI-Interview ab, um Risiken zu identifizieren.",
    completeInterviewMatrix: "Schließen Sie das KI-Interview ab, um die Risikomatrix zu erstellen.",
    riskHeatmap: "Risiko-Heatmap",
    landingBadge: "KI-GESTÜTZTE PRE-MORTEM-ANALYSE",
    landingHeadline1: "Finden Sie, was scheitert",
    landingHeadline2: "bevor es scheitert.",
    landingSubtitle: "Führen Sie ein KI-geführtes Interview, decken Sie versteckte Risiken auf und erhalten Sie einen umsetzbaren Bericht — bevor das Projekt beginnt.",
    feat1Title: "KI-Interview",
    feat1Desc: "Konversationelle Risikoerkennung",
    feat2Title: "Risikomatrix",
    feat2Desc: "Visuelles Wahrscheinlichkeit × Auswirkung-Raster",
    feat3Title: "5 Sprachen",
    feat3Desc: "EN, HE, ES, FR, DE",
    interviewIntro: "Ein KI-Moderator befragt Sie, um versteckte Projektrisiken aufzudecken, bevor sie eintreten.",
    statusIdentified: "Identifiziert",
    statusMitigating: "In Bearbeitung",
    statusAccepted: "Akzeptiert",
    statusResolved: "Gelöst",
    member: "Mitglied",
    risksExtracted: "✅ Risiken extrahiert und zum Bericht hinzugefügt.",
    connectionError: "Verbindungsfehler. Bitte erneut versuchen.",
    interviewApiHint: "GEMINI_API_KEY in einer .env-Datei in diesem Ordner setzen und npm run dev neu starten.",
    tabInterview: "Interview",
    tabRisks: "Risiken",
    tabMatrix: "Matrix",
    tabTeam: "Team",
    tabChat: "Chat",
    projectChatTitle: "Projekt-Team-Chat",
    projectChatHint: "Nutze diesen Bereich, um Aufgaben, Blocker und Updates zum Projekt zu koordinieren.",
    noProjectChatYet: "Noch keine Nachrichten. Starte die Projektunterhaltung.",
    chatPlaceholder: "Schreibe eine Nachricht an dein Team...",
    interviewRelevantOnly:
      "Hier kann ich nur bei Interviewfragen zu Projektrisiken helfen. Bitte teile Projektdetails, Einschränkungen, Risiken, Zeitplan, Budget oder Stakeholder.",
    description: "Projektbeschreibung",
    descriptionPlaceholder: "Was Sie liefern, für wen, und wann das Projekt als erfolgreich gilt.",
    projectNamePlaceholder: "z. B. Q3-Migration der Abrechnungsplattform",
    teamSizePlaceholder: "z. B. 8",
    stakeholdersPlaceholder: "z. B. CTO, Produktlead, Engineering Lead",
    constraintsPlaceholder: "z. B. SAP-Anbindung, fester Go-live, Budgetobergrenze",
    generateReport: "Bericht erstellen",
    reportGenerated: "Bericht erstellt",
    markComplete: "Als abgeschlossen markieren",
    in_progress: "In Bearbeitung",
    completed: "Abgeschlossen",
    questionsAsked: "Gestellte Fragen",
    risksFound: "Gefundene Risiken",
    projectDescription: "Beschreibung",
    statusInProgress: "In Bearbeitung",
    statusCompleted: "Abgeschlossen",
    statusSetup: "Einrichtung",
    statusInterviewing: "Im Interview",
    statusReportReady: "Bericht fertig",
    dashboardSearchPlaceholder: "Nach Projektname suchen…",
    dashboardFilterStatus: "Status",
    dashboardAllStatuses: "Alle Status",
    dashboardNoMatches: "Keine Projekte entsprechen Suche oder Filter.",
    themeUseLight: "Heller Modus",
    themeUseDark: "Dunkler Modus",
  },
};

const RISK_CATEGORIES = ["technical","resource","schedule","scope","communication","external","organizational","financial"];

function getRiskLevel(score) {
  if (score >= 18) return "critical";
  if (score >= 12) return "high";
  if (score >= 6) return "medium";
  return "low";
}

function getRiskColor(score) {
  if (score >= 18) return "#E53935";
  if (score >= 12) return "#F57C00";
  if (score >= 6) return "#EF9F27";
  return "#1D9E75";
}

function getRiskMarkerTextColor(score) {
  return getRiskLevel(score) === "medium" ? "#333" : "#fff";
}

function formatRiskCategory(cat, t) {
  if (!cat || typeof cat !== "string") return "—";
  if (t && t.riskCategories && typeof t.riskCategories[cat] === "string") return t.riskCategories[cat];
  return cat.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function getOverallRiskColor(score) {
  const x = parseFloat(String(score));
  const rank = !Number.isFinite(x)
    ? 1
    : x > 25
      ? Math.min(100, Math.max(1, Math.round(x)))
      : riskRank100(x);
  if (rank >= 60) return "#E24B4A";
  if (rank >= 30) return "#EF9F27";
  return "#1D9E75";
}

function riskRank100(score) {
  const x = parseFloat(String(score));
  if (!Number.isFinite(x)) return 1;
  // If the backend has already stored a 1..100 score, keep it.
  if (x > 25) return Math.min(100, Math.max(1, Math.round(x)));
  const minScore = 1;
  const maxScore = 25;
  const v = Math.min(maxScore, Math.max(minScore, x));
  // Map [1..25] -> [1..100]
  return Math.round(((v - minScore) / (maxScore - minScore)) * 99 + 1);
}

function readInitialColorMode() {
  try {
    const s = localStorage.getItem("ps_theme");
    if (s === "light" || s === "dark") return s;
  } catch (_) {}
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches) return "light";
  return "dark";
}

/** Nav logo: purple mark on dark mode; outlined mark on light nav backgrounds. */
function PreShieldLogoMark({ mode, size = 28 }) {
  const light = mode === "light";
  const icon = size * 0.5;
  const stroke = light ? "#5B5BFF" : "#ffffff";
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: 6,
        background: light ? "#ffffff" : "#5B5BFF",
        border: light ? "1px solid #c8c8dc" : "none",
        boxShadow: light ? "0 1px 3px rgba(15, 15, 30, 0.08)" : "none",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
      aria-hidden
    >
      <svg width={icon} height={icon} viewBox="0 0 14 14" fill="none">
        <path d="M7 1L13 4V7C13 10.3 10.3 13 7 13C3.7 13 1 10.3 1 7V4L7 1Z" stroke={stroke} strokeWidth="1.5" fill="none" />
        <path d="M4.5 7L6.5 9L9.5 5.5" stroke={stroke} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Check for invite token in URL first
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get("invite");

    // Try to restore session from localStorage or sessionStorage
    try {
      const stored = localStorage.getItem("ps_session") || sessionStorage.getItem("ps_session");
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed.access_token) {
          // Try to refresh the session
          auth.refreshSession(parsed.refresh_token)
            .then(refreshed => {
              const newSession = { access_token: refreshed.access_token, refresh_token: refreshed.refresh_token, user: refreshed.user };
              localStorage.setItem("ps_session", JSON.stringify(newSession));
              setSession(newSession);
            })
            .catch(() => {
              localStorage.removeItem("ps_session");
            })
            .finally(() => setLoading(false));
          return;
        }
      }
    } catch {}
    setLoading(false);
  }, []);

  const handleAuth = (sessionData) => {
    setSession(sessionData);
  };

  const handleSignOut = async () => {
    if (session?.access_token) await auth.signOut(session.access_token);
    localStorage.removeItem("ps_session");
    setSession(null);
  };

  if (loading) return (
    <div style={{ minHeight: "100vh", background: "#0A0A0F", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: "#9A9898", fontFamily: "'DM Sans', sans-serif", fontSize: 14 }}>Loading...</div>
    </div>
  );

  if (!session) return <AuthScreen onAuth={handleAuth} />;

  return <PreShieldApp session={session} onSignOut={handleSignOut} />;
}

function PreShieldApp({ session, onSignOut }) {
  const [lang, setLang] = useState("en");
  const [view, setView] = useState("dashboard");
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [projects, setProjects] = useState([]);
  const [dbLoading, setDbLoading] = useState(true);
  const [dbError, setDbError] = useState(null);
  const [currentProject, setCurrentProject] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [subView, setSubView] = useState("interview");
  const [joinModal, setJoinModal] = useState(null);
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState(null);
  const [colorMode, setColorMode] = useState(readInitialColorMode);
  const t = LANGS[lang];
  const isRTL = lang === "he";

  useEffect(() => {
    try {
      localStorage.setItem("ps_theme", colorMode);
    } catch (_) {}
  }, [colorMode]);

  useEffect(() => {
    const ac = new AbortController();
    let cancelled = false;
    setDbLoading(true);
    setDbError(null);
    sb.loadProjects(session.access_token, { signal: ac.signal })
      .then(data => {
        if (cancelled) return;
        setProjects(data);
        setDbLoading(false);
      })
      .catch(e => {
        if (cancelled || e?.name === "AbortError") return;
        setDbError("Failed to load projects.");
        setDbLoading(false);
      });
    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [session.access_token]);

  const persist = async (project) => {
    try {
      await sb.saveProject(session.access_token, project);
    } catch (e) {
      console.error("Save failed:", e.message);
    }
  };

  // Close user menu on outside click
  useEffect(() => {
    if (!showUserMenu) return;
    const close = () => setShowUserMenu(false);
    setTimeout(() => document.addEventListener("click", close), 0);
    return () => document.removeEventListener("click", close);
  }, [showUserMenu]);

  // Check URL for invite token on load
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const token = params.get("invite");
    if (token) {
      sb.getInviteByToken(token).then(invite => {
        if (invite) setJoinModal({ token, projectName: invite.project_name || "a project", projectId: invite.project_id });
      });
    }
  }, []);

  const deleteProject = async (id) => {
    setProjects(prev => prev.filter(p => p.id !== id));
    setDeleteTarget(null);
    if (currentProject?.id === id) { setCurrentProject(null); setView("dashboard"); }
    try { await sb.deleteProject(session.access_token, id); } catch (e) { console.error("Delete failed:", e); }
  };

  const addProject = async (project) => {
    setCreateProjectError(null);
    const newProject = {
      ...project,
      id: Date.now().toString(),
      status: "setup",
      risks: [],
      messages: [],
      comments: {},
      team: [],
      overall_risk_score: 0,
      risk_count: 0,
      report_generated: false,
      created: new Date().toLocaleDateString(),
    };
    setCreatingProject(true);
    try {
      await sb.saveProject(session.access_token, newProject);
      setProjects(prev => [...prev, newProject]);
      setCurrentProject(newProject);
      setSubView("interview");
      setView("project");
    } catch (e) {
      console.error("Save failed:", e.message);
      const msg = e.message || t.saveProjectFailed;
      const usersPerm = /permission denied.*table users|table users/i.test(String(msg));
      setCreateProjectError(usersPerm ? `${msg}\n\n${t.saveProjectUsersPermissionHint}` : msg);
    } finally {
      setCreatingProject(false);
    }
  };

  const updateProject = async (updated) => {
    setProjects(prev => prev.map(p => p.id === updated.id ? updated : p));
    setCurrentProject(updated);
    await persist(updated);
  };

  return (
    <div
      dir={isRTL ? "rtl" : "ltr"}
      data-ps-theme={colorMode}
      style={{
        minHeight: "100vh",
        background: "var(--ps-page-bg)",
        color: "var(--ps-text)",
        fontFamily: "'DM Sans', 'Helvetica Neue', sans-serif",
        position: "relative",
        colorScheme: colorMode === "light" ? "light" : "dark",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;1,300&family=DM+Mono:wght@400;500&display=swap');
        [data-ps-theme="dark"] {
          --ps-page-bg: #0A0A0F;
          --ps-text: #E8E6E0;
          --ps-text-muted: #9A9898;
          --ps-nav-bg: #0A0A0F;
          --ps-nav-border: #1E1E2E;
          --ps-input-bg: #13131A;
          --ps-input-border: #2A2A3A;
          --ps-card-bg: #13131A;
          --ps-card-border: #1E1E2E;
          --ps-menu-bg: #13131A;
          --ps-menu-border: #1E1E2E;
          --ps-menu-divider: #1E1E2E;
          --ps-panel: #0F0F16;
          --ps-chat-ai-bg: #13131A;
          --ps-border-subtle: #1E1E2E;
          --ps-spinner-track: #1E1E2E;
          --ps-shimmer-a: #1E1E2E;
          --ps-shimmer-b: #252535;
          --ps-select-color: #9A9898;
          --ps-thumb-bg: #333;
          --ps-matrix-track: #1E1E2E;
          --ps-quote-text: #C8C6C0;
          --ps-grid: #2A2A3A;
        }
        [data-ps-theme="light"] {
          --ps-page-bg: #f2f2f7;
          --ps-text: #14141c;
          --ps-text-muted: #5c5c6a;
          --ps-nav-bg: #ffffff;
          --ps-nav-border: #e2e2eb;
          --ps-input-bg: #fafafc;
          --ps-input-border: #d4d4e0;
          --ps-card-bg: #ffffff;
          --ps-card-border: #e2e2eb;
          --ps-menu-bg: #ffffff;
          --ps-menu-border: #e2e2eb;
          --ps-menu-divider: #e8e8f0;
          --ps-panel: #eceef5;
          --ps-chat-ai-bg: #f0f1f6;
          --ps-border-subtle: #dfe0ea;
          --ps-spinner-track: #e0e0ea;
          --ps-shimmer-a: #e8e8f0;
          --ps-shimmer-b: #f0f0f5;
          --ps-select-color: #5c5c6a;
          --ps-thumb-bg: #b4b4c4;
          --ps-matrix-track: #dfe0ea;
          --ps-quote-text: #3d3d48;
          --ps-grid: #c4c5d4;
        }
        [data-ps-theme="light"] .ps-nav { background: #ffffff; border-bottom-color: #e2e2eb; }
        .ps-form-label { font-size: 12px; color: var(--ps-text-muted); margin-bottom: 6px; display: block; }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: var(--ps-thumb-bg); border-radius: 2px; }
        input, textarea, select { background: var(--ps-input-bg); border: 1px solid var(--ps-input-border); color: var(--ps-text); border-radius: 8px; padding: 10px 14px; font-family: inherit; font-size: 14px; outline: none; width: 100%; transition: border-color 0.2s; }
        input:focus, textarea:focus, select:focus { border-color: #5B5BFF; }
        select option { background: var(--ps-input-bg); color: var(--ps-text); }
        button { cursor: pointer; font-family: inherit; border: none; transition: all 0.15s; }
        .btn-primary { background: #5B5BFF; color: #fff; border-radius: 8px; padding: 10px 20px; font-size: 14px; font-weight: 500; }
        .btn-primary:hover { background: #4A4AEE; transform: translateY(-1px); }
        .btn-ghost { background: transparent; color: var(--ps-text-muted); border: 1px solid var(--ps-input-border); border-radius: 8px; padding: 8px 16px; font-size: 13px; }
        .btn-ghost:hover { border-color: #5B5BFF; color: #5B5BFF; }
        .btn-danger { background: transparent; color: #E24B4A; border: 1px solid #E24B4A33; border-radius: 8px; padding: 8px 16px; font-size: 13px; }
        .btn-danger:hover { background: #E24B4A22; }
        .card { background: var(--ps-card-bg); border: 1px solid var(--ps-card-border); border-radius: 12px; }
        .tag { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 500; letter-spacing: 0.5px; }
        .tag-critical { background: #E5393522; color: #E53935; }
        .tag-high { background: #F57C0022; color: #F57C00; }
        .tag-medium { background: #EF9F2722; color: #EF9F27; }
        .tag-low { background: #1D9E7522; color: #1D9E75; }
        .risk-card-ref { box-shadow: 0 1px 3px rgba(0,0,0,.06); }
        [data-ps-theme="dark"] .risk-card-ref { box-shadow: none; }
        .fade-in { animation: fadeIn 0.3s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
        .shimmer { animation: shimmer 2s infinite; background: linear-gradient(90deg, var(--ps-shimmer-a) 25%, var(--ps-shimmer-b) 50%, var(--ps-shimmer-a) 75%); background-size: 200% 100%; }
        @keyframes shimmer { 0% { background-position: -200% 0; } 100% { background-position: 200% 0; } }
        .page { max-width: 1120px; margin: 0 auto; padding: 24px 16px; }
        .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin-bottom: 30px; }
        .dashboard-stat-card { min-height: 122px; }
        .dashboard-project-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
        .dashboard-project-card { min-height: 230px; }
        .project-card-meta { display: flex; align-items: center; gap: 16px; }
        .project-score { text-align: right; min-width: 70px; }
        @media (max-width: 600px) {
          .page { padding: 16px 12px; }
          .stat-grid { grid-template-columns: repeat(2, 1fr); gap: 8px; }
          .dashboard-project-grid { grid-template-columns: 1fr; }
          .project-card-meta { gap: 8px; }
          .project-score { min-width: 52px; }
          .feat-grid { grid-template-columns: 1fr !important; }
          .form-grid-2 { grid-template-columns: 1fr !important; }
          .tab-btn { padding: 8px 10px !important; font-size: 12px !important; }
          .risk-inputs { grid-template-columns: 1fr 1fr !important; }
          .matrix-wrap { max-width: 100% !important; }
          .risk-card-ref { padding-left: 16px !important; padding-right: 16px !important; }
          .project-header { flex-wrap: wrap; }
          .project-actions { flex-wrap: wrap; gap: 6px !important; }
          .interview-stats { flex-wrap: wrap; gap: 8px; }
          .heatmap-title { display: none; }
          .legend-wrap { flex-wrap: wrap; gap: 8px !important; }
        }
      `}</style>

      {/* Nav */}
      <nav className="ps-nav" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 16px", borderBottom: "1px solid var(--ps-nav-border)", position: "sticky", top: 0, background: "var(--ps-nav-bg)", zIndex: 100 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div onClick={() => setView("dashboard")} style={{ cursor: "pointer", display: "flex", alignItems: "center", gap: 8 }}>
            <PreShieldLogoMark mode={colorMode} size={28} />
            <span style={{ fontWeight: 600, fontSize: 15, letterSpacing: "-0.3px", color: "var(--ps-text)" }}>{t.appName}</span>
          </div>
          {view !== "landing" && view !== "dashboard" && (
            <button className="btn-ghost" style={{ padding: "6px 12px", fontSize: 13 }} onClick={() => setView("dashboard")}>{t.dashboard}</button>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            className="btn-ghost"
            style={{ padding: "6px 10px", fontSize: 16, lineHeight: 1 }}
            onClick={() => setColorMode(m => (m === "dark" ? "light" : "dark"))}
            title={colorMode === "dark" ? t.themeUseLight : t.themeUseDark}
            aria-label={colorMode === "dark" ? t.themeUseLight : t.themeUseDark}
          >
            {colorMode === "dark" ? "☀️" : "🌙"}
          </button>
          <select value={lang} onChange={e => setLang(e.target.value)} style={{ width: "auto", padding: "6px 10px", fontSize: 12, background: "var(--ps-input-bg)", border: "1px solid var(--ps-input-border)", color: "var(--ps-select-color)" }}>
            <option value="en">EN</option>
            <option value="he">עב</option>
            <option value="es">ES</option>
            <option value="fr">FR</option>
            <option value="de">DE</option>
          </select>
          {view !== "landing" && (
            <button className="btn-primary" style={{ padding: "7px 14px", fontSize: 13 }} onClick={() => { setView("new-project"); }}>+ {t.newProject}</button>
          )}
          {/* User avatar + sign out */}
          <div style={{ position: "relative" }}>
            <div
              onClick={() => setShowUserMenu(v => !v)}
              style={{ width: 30, height: 30, borderRadius: "50%", background: "#5B5BFF33", border: "1px solid #5B5BFF66", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 600, color: "#9999FF", cursor: "pointer", flexShrink: 0 }}
            >
              {session?.user?.email?.[0]?.toUpperCase() || "?"}
            </div>
            {showUserMenu && (
              <div style={{ position: "absolute", right: 0, top: 38, background: "var(--ps-menu-bg)", border: "1px solid var(--ps-menu-border)", borderRadius: 10, padding: 8, minWidth: 200, zIndex: 200, boxShadow: colorMode === "light" ? "0 8px 24px rgba(0,0,0,.1)" : "none" }}>
                <div style={{ fontSize: 12, color: "var(--ps-text-muted)", padding: "6px 10px", borderBottom: "1px solid var(--ps-menu-divider)", marginBottom: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{session?.user?.email}</div>
                <button onClick={() => { setShowUserMenu(false); onSignOut(); }} style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 10px", fontSize: 13, color: "#E24B4A", background: "none", border: "none", cursor: "pointer", borderRadius: 6 }}>
                  Sign out
                </button>
              </div>
            )}
          </div>
        </div>
      </nav>

      {/* Views */}
      {view === "dashboard" && dbLoading && (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", padding: "80px 24px", flexDirection: "column", gap: 12 }}>
          <div style={{ width: 32, height: 32, border: "3px solid var(--ps-spinner-track)", borderTop: "3px solid #5B5BFF", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
          <div style={{ fontSize: 13, color: "var(--ps-text-muted)" }}>Loading your projects...</div>
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}
      {view === "dashboard" && !dbLoading && dbError && (
        <div style={{ textAlign: "center", padding: "60px 24px", color: "#E24B4A", fontSize: 14 }}>{dbError}</div>
      )}
      {view === "dashboard" && !dbLoading && !dbError && <DashboardView t={t} projects={projects} onSelect={p => { setCurrentProject(p); setSubView("interview"); setView("project"); }} onNew={() => { setCreateProjectError(null); setView("new-project"); }} onDelete={p => setDeleteTarget(p)} />}
      {view === "new-project" && (
        <NewProjectView
          t={t}
          onBack={() => { setCreateProjectError(null); setView("dashboard"); }}
          onCreate={addProject}
          submitting={creatingProject}
          saveError={createProjectError}
        />
      )}
      {view === "project" && currentProject && (
        <ProjectView t={t} project={currentProject} subView={subView} setSubView={setSubView} onUpdate={updateProject} onDelete={() => setDeleteTarget(currentProject)} onBack={() => setView("dashboard")} lang={lang} colorMode={colorMode} />
      )}

      {/* Delete Modal */}
      {deleteTarget && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
          <div className="card fade-in" style={{ padding: 28, maxWidth: 400, width: "90%", margin: 16 }}>
            <div style={{ marginBottom: 8, fontWeight: 600, fontSize: 16 }}>{t.deleteProject}</div>
            <div style={{ fontSize: 14, color: "#9A9898", marginBottom: 24, lineHeight: 1.6 }}>{t.deleteConfirm}</div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button className="btn-ghost" onClick={() => setDeleteTarget(null)}>{t.cancel}</button>
              <button className="btn-danger" onClick={() => deleteProject(deleteTarget.id)}>{t.delete}</button>
            </div>
          </div>
        </div>
      )}

      {/* Join via invite link modal */}
      {joinModal && <JoinModal modal={joinModal} onClose={() => setJoinModal(null)} />}
    </div>
  );
}

function JoinModal({ modal, onClose }) {
  const [email, setEmail] = useState("");
  const [joining, setJoining] = useState(false);
  const [joined, setJoined] = useState(false);
  const [error, setError] = useState(null);

  const join = async () => {
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) return;
    setJoining(true);
    setError(null);
    try {
      await sb.acceptInviteByToken(modal.token, trimmed);
      setJoined(true);
    } catch (e) {
      setError(e.message || "Failed to join. The link may have expired.");
    } finally {
      setJoining(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
      <div className="card fade-in" style={{ padding: 32, maxWidth: 420, width: "90%", margin: 16, textAlign: "center" }}>
        <div style={{ fontSize: 40, marginBottom: 16 }}>🛡️</div>
        {joined ? (
          <>
            <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8 }}>You're in!</div>
            <div style={{ fontSize: 14, color: "#9A9898", marginBottom: 24 }}>You've joined <strong style={{ color: "#E8E6E0" }}>{modal.projectName}</strong> as a team member.</div>
            <button className="btn-primary" style={{ width: "100%" }} onClick={onClose}>Go to App</button>
          </>
        ) : (
          <>
            <div style={{ fontWeight: 600, fontSize: 18, marginBottom: 8 }}>You've been invited</div>
            <div style={{ fontSize: 14, color: "#9A9898", marginBottom: 6 }}>Join the pre-mortem for:</div>
            <div style={{ display: "inline-block", background: "#5B5BFF22", border: "1px solid #5B5BFF44", color: "#9999FF", borderRadius: 8, padding: "6px 16px", fontSize: 14, fontWeight: 500, marginBottom: 24 }}>{modal.projectName}</div>
            <div style={{ marginBottom: 16 }}>
              <input value={email} onChange={e => setEmail(e.target.value)} placeholder="Enter your email to join" onKeyDown={e => e.key === "Enter" && join()} style={{ textAlign: "center" }} />
            </div>
            {error && <div style={{ fontSize: 12, color: "#E24B4A", marginBottom: 12 }}>{error}</div>}
            <div style={{ display: "flex", gap: 10 }}>
              <button className="btn-ghost" style={{ flex: 1 }} onClick={onClose}>Cancel</button>
              <button className="btn-primary" style={{ flex: 2 }} onClick={join} disabled={joining || !email.trim()}>
                {joining ? "Joining..." : "Join Project"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function LandingView({ t, onStart }) {
  return (
    <div className="fade-in" style={{ maxWidth: 700, margin: "0 auto", padding: "80px 24px", textAlign: "center" }}>
      <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "#5B5BFF22", border: "1px solid #5B5BFF44", borderRadius: 20, padding: "5px 14px", marginBottom: 32, fontSize: 12, color: "#9999FF", letterSpacing: "0.5px" }}>
        {t.landingBadge}
      </div>
      <h1 style={{ fontSize: "clamp(36px, 6vw, 64px)", fontWeight: 600, lineHeight: 1.1, letterSpacing: "-2px", marginBottom: 20 }}>
        {t.landingHeadline1}<br /><span style={{ color: "#5B5BFF" }}>{t.landingHeadline2}</span>
      </h1>
      <p style={{ fontSize: 17, color: "#9A9898", lineHeight: 1.7, maxWidth: 480, margin: "0 auto 40px" }}>
        {t.landingSubtitle}
      </p>
      <button className="btn-primary" style={{ padding: "14px 32px", fontSize: 16, borderRadius: 10 }} onClick={onStart}>
        {t.newProject} →
      </button>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginTop: 64 }}>
        {[
          { icon: "🎯", title: t.feat1Title, desc: t.feat1Desc },
          { icon: "📊", title: t.feat2Title, desc: t.feat2Desc },
          { icon: "🌍", title: t.feat3Title, desc: t.feat3Desc },
        ].map(f => (
          <div key={f.title} className="card" style={{ padding: "20px 16px", textAlign: "left" }}>
            <div style={{ fontSize: 24, marginBottom: 8 }}>{f.icon}</div>
            <div style={{ fontWeight: 500, fontSize: 14, marginBottom: 4 }}>{f.title}</div>
            <div style={{ fontSize: 12, color: "#9A9898" }}>{f.desc}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

const DASHBOARD_STATUS_FILTERS = ["setup", "interviewing", "report_ready", "completed"];

function DashboardView({ t, projects, onSelect, onNew, onDelete }) {
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const totalProjects = projects.length;
  const completedProjects = projects.filter(p => p.status === "completed").length;
  const risksIdentified = projects.reduce((a, p) => a + (p.risk_count ?? p.risks?.length ?? 0), 0);
  const completionRate = totalProjects ? Math.round((completedProjects / totalProjects) * 100) : 0;
  const teamMembersTotal = projects.reduce((a, p) => a + (parseFloat(p.team_size ?? 0) || 0), 0);

  const filteredProjects = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return projects.filter(p => {
      const name = (p.name || "").toLowerCase();
      const nameMatch = !q || name.includes(q);
      const statusMatch = !statusFilter || p.status === statusFilter;
      return nameMatch && statusMatch;
    });
  }, [projects, searchQuery, statusFilter]);

  return (
    <div className="fade-in page">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
        <h2 style={{ fontSize: 20, fontWeight: 600, letterSpacing: "-0.5px" }}>{t.dashboard}</h2>
        <button className="btn-primary" style={{ padding: "8px 14px", fontSize: 13 }} onClick={onNew}>+ {t.newProject}</button>
      </div>
      <div className="stat-grid">
        {[
          { label: t.totalProjects || t.projects, value: totalProjects, sub: `${completedProjects} ${t.completed}`, icon: "📁" },
          { label: t.risksIdentified || t.risksFound || t.risks, value: risksIdentified, sub: t.acrossAllProjects || "", icon: "⚠️" },
          { label: t.completionRate || "Completion Rate", value: `${completionRate}%`, sub: "", icon: "✅" },
          { label: t.teamMembers, value: teamMembersTotal, sub: t.acrossAllProjects || "", icon: "👥" },
        ].map(m => (
          <div
            key={m.label}
            className="card dashboard-stat-card"
            style={{ padding: "16px 16px", display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 11, color: "#9A9898", marginBottom: 8, textTransform: "uppercase", letterSpacing: "0.5px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {m.label}
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: "'DM Mono', monospace", lineHeight: 1 }}>{m.value}</div>
              {m.sub ? <div style={{ fontSize: 12, color: "#9A9898", marginTop: 4 }}>{m.sub}</div> : null}
            </div>
            <div style={{ width: 34, height: 34, borderRadius: 10, background: "#F0F1FF", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 16 }}>
              {m.icon}
            </div>
          </div>
        ))}
      </div>
      {projects.length === 0 ? (
        <div className="card" style={{ padding: "60px 24px", textAlign: "center" }}>
          <div style={{ fontSize: 40, marginBottom: 16 }}>🛡️</div>
          <div style={{ color: "#9A9898", fontSize: 15 }}>{t.noProjects}</div>
          <button className="btn-primary" style={{ marginTop: 20 }} onClick={onNew}>{t.createProject}</button>
        </div>
      ) : (
        <>
          <div
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 10,
              marginBottom: 12,
            }}
          >
            <input
              type="search"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder={t.dashboardSearchPlaceholder}
              aria-label={t.dashboardSearchPlaceholder}
              style={{ flex: "1 1 200px", minWidth: 160, maxWidth: 360 }}
            />
            <div style={{ display: "flex", alignItems: "center", gap: 8, flex: "0 1 auto" }}>
              <label htmlFor="dashboard-status-filter" style={{ fontSize: 12, color: "#9A9898", whiteSpace: "nowrap" }}>
                {t.dashboardFilterStatus}
              </label>
              <select
                id="dashboard-status-filter"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
                style={{ width: "auto", minWidth: 140 }}
              >
                <option value="">{t.dashboardAllStatuses}</option>
                {DASHBOARD_STATUS_FILTERS.map(s => (
                  <option key={s} value={s}>{getStatusLabel(s, t)}</option>
                ))}
              </select>
            </div>
          </div>
        <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginTop: 4, marginBottom: 10 }}>
          <h3 style={{ fontSize: 16, fontWeight: 700, margin: 0, letterSpacing: "-0.2px" }}>{t.recentProjects || "Recent Projects"}</h3>
        </div>
        <div className="dashboard-project-grid">
          {filteredProjects.length === 0 ? (
            <div className="card" style={{ padding: "28px 16px", textAlign: "center", color: "#9A9898", fontSize: 14, gridColumn: "1 / -1" }}>
              {t.dashboardNoMatches}
            </div>
          ) : (
          filteredProjects.map(p => {
            const scoreRank = riskRank100(p.overall_risk_score);
            const riskCnt = p.risk_count ?? p.risks?.length ?? 0;
            const due = p.deadline ? (() => { try { return new Date(p.deadline).toLocaleDateString(undefined, { month: "short", day: "numeric" }); } catch { return p.deadline; } })() : null;
            return (
              <div
                key={p.id}
                className="card dashboard-project-card"
                style={{ padding: "20px 20px", cursor: "pointer", display: "flex", flexDirection: "column", gap: 12, position: "relative" }}
                onClick={() => onSelect(p)}
              >
                <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 16, lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "100%" }}>
                      {p.name}
                    </div>
                    <div style={{ fontSize: 12, color: "#9A9898", marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {t.projectTypes?.[p.project_type] || p.project_type?.replace(/_/g, " ")}
                    </div>
                  </div>
                  <span
                    className="tag"
                    style={{
                      flexShrink: 0,
                      background: p.status === "completed" ? "#1D9E7533" : p.status === "report_ready" ? "#5B5BFF22" : "#EF9F2722",
                      color: p.status === "completed" ? "#1D9E75" : p.status === "report_ready" ? "#9999FF" : "#EF9F27",
                      border: `1px solid ${p.status === "completed" ? "#1D9E751f" : p.status === "report_ready" ? "#5B5BFF1f" : "#EF9F271f"}`,
                    }}
                  >
                    {getStatusLabel(p.status, t)}
                  </span>
                </div>

                {p.description ? (
                  <div style={{ fontSize: 13, color: "var(--ps-quote-text)", lineHeight: 1.4, overflow: "hidden", display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical" }}>
                    {p.description}
                  </div>
                ) : null}

                <div style={{ height: 1, background: "var(--ps-border-subtle)", marginTop: 2, marginBottom: 2 }} />

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, flexWrap: "wrap" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, color: "#9A9898", fontSize: 12 }}>
                    {due ? <span>{t.due || "Due"} {due}</span> : null}
                    <span>•</span>
                    <span>{riskCnt} {t.risks}</span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ textAlign: "right" }}>
                      <div style={{ fontSize: 18, fontWeight: 700, fontFamily: "'DM Mono', monospace", color: getOverallRiskColor(scoreRank) }}>{scoreRank}</div>
                      <div style={{ fontSize: 10, color: "#9A9898" }}>{t.score}</div>
                    </div>
                    <div style={{ fontSize: 12, color: "#9A9898", textAlign: "right", lineHeight: 1.2 }}>
                      {p.status === "report_ready" ? (t.viewReport || "View Report") : (t.open || "Open")} →
                    </div>
                  </div>
                </div>
              </div>
            );
          })
          )}
        </div>
        </>
      )}
    </div>
  );
}

function NewProjectView({ t, onBack, onCreate, submitting = false, saveError = null }) {
  const [form, setForm] = useState({ name: "", description: "", project_type: "software_development", team_size: "", deadline: "", budget_range: "10k_50k", stakeholders: "", constraints: "" });
  const [deadlineErr, setDeadlineErr] = useState(null);
  const minDeadline = localISODate();
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const submit = () => {
    if (submitting) return;
    if (form.deadline && form.deadline < minDeadline) {
      setDeadlineErr(t.deadlinePast);
      return;
    }
    setDeadlineErr(null);
    onCreate(form);
  };
  return (
    <div className="fade-in page" style={{ maxWidth: 560 }}>
      <button type="button" className="btn-ghost" style={{ marginBottom: 20 }} onClick={onBack} disabled={submitting}>← {t.back}</button>
      <h2 style={{ fontSize: 18, fontWeight: 600, marginBottom: 20, letterSpacing: "-0.5px" }}>{t.createProject}</h2>
      <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label className="ps-form-label">{t.projectName} *</label>
          <input value={form.name} onChange={e => set("name", e.target.value)} placeholder={t.projectNamePlaceholder} disabled={submitting} />
        </div>
        <div>
          <label className="ps-form-label">{t.description}</label>
          <textarea value={form.description} onChange={e => set("description", e.target.value)} placeholder={t.descriptionPlaceholder} rows={2} style={{ resize: "vertical" }} disabled={submitting} />
        </div>
        <div className="form-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label className="ps-form-label">{t.projectType}</label>
            <select value={form.project_type} onChange={e => set("project_type", e.target.value)} disabled={submitting}>
              {Object.entries(t.projectTypes).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <div>
            <label className="ps-form-label">{t.budget}</label>
            <select value={form.budget_range} onChange={e => set("budget_range", e.target.value)} disabled={submitting}>
              {Object.entries(t.budgets).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
        </div>
        <div className="form-grid-2" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
          <div>
            <label className="ps-form-label">{t.teamSize}</label>
            <input
              type="number"
              min={0}
              step={1}
              value={form.team_size}
              onChange={e => {
                const raw = e.target.value;
                if (raw === "") return set("team_size", "");
                const n = parseInt(raw, 10);
                if (Number.isNaN(n)) return;
                set("team_size", String(Math.max(0, n)));
              }}
              placeholder={t.teamSizePlaceholder}
              disabled={submitting}
            />
          </div>
          <div>
            <label className="ps-form-label">{t.deadline}</label>
            <input
              type="date"
              min={minDeadline}
              disabled={submitting}
              value={form.deadline}
              onChange={e => {
                const v = e.target.value;
                setDeadlineErr(null);
                if (v === "") return set("deadline", "");
                if (v < minDeadline) {
                  setDeadlineErr(t.deadlinePast);
                  return;
                }
                set("deadline", v);
              }}
            />
            {deadlineErr && <div style={{ fontSize: 11, color: "#E24B4A", marginTop: 6 }}>{deadlineErr}</div>}
          </div>
        </div>
        <div>
          <label className="ps-form-label">{t.stakeholders}</label>
          <input value={form.stakeholders} onChange={e => set("stakeholders", e.target.value)} placeholder={t.stakeholdersPlaceholder} disabled={submitting} />
        </div>
        <div>
          <label className="ps-form-label">{t.constraints}</label>
          <textarea value={form.constraints} onChange={e => set("constraints", e.target.value)} placeholder={t.constraintsPlaceholder} rows={3} style={{ resize: "vertical" }} disabled={submitting} />
        </div>
        {saveError && (
          <div style={{ fontSize: 13, color: "#E24B4A", lineHeight: 1.5, padding: "10px 12px", background: "#E24B4A11", borderRadius: 8, border: "1px solid #E24B4A33", whiteSpace: "pre-wrap" }}>
            {saveError}
          </div>
        )}
        <button
          type="button"
          className="btn-primary"
          style={{ marginTop: 8, padding: "12px" }}
          disabled={!form.name || submitting || !!(form.deadline && form.deadline < minDeadline)}
          onClick={submit}
        >
          {submitting ? t.savingProject : `${t.startInterview} →`}
        </button>
      </div>
    </div>
  );
}

function getStatusLabel(status, t) {
  const map = { setup: t.statusSetup, interviewing: t.statusInterviewing, report_ready: t.statusReportReady, in_progress: t.statusInProgress, completed: t.statusCompleted };
  return map[status] || status;
}

function buildReportHTML(project, t, forPrint = false) {
  const risks = project.risks || [];
  const sorted = [...risks].sort((a, b) => b.risk_score - a.risk_score);
  const scoreColor = project.overall_risk_score >= 60 ? "#E24B4A" : project.overall_risk_score >= 30 ? "#EF9F27" : "#1D9E75";
  const riskColor = (s) => s >= 18 ? "#E53935" : s >= 12 ? "#F57C00" : s >= 6 ? "#EF9F27" : "#1D9E75";
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>PreShield Report — ${project.name}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; color: #111; background: #fff; font-size: 14px; line-height: 1.65; }
  .page { max-width: 780px; margin: 0 auto; padding: ${forPrint ? "20px" : "40px 32px"}; }
  .matrix-container { margin: 32px 0; border: 1px solid #eee; border-radius: 12px; padding: 20px; background: #fcfcfc; page-break-inside: avoid; }
  .matrix-grid { display: grid; grid-template-columns: 30px repeat(5, 1fr); grid-template-rows: repeat(5, 1fr) 30px; gap: 4px; aspect-ratio: 4/3; max-width: 600px; margin: 0 auto; }
  .matrix-cell { border-radius: 6px; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 600; position: relative; }
  .matrix-label { display: flex; align-items: center; justify-content: center; font-size: 11px; color: #888; font-weight: 600; }
  .matrix-dot { width: 10px; height: 10px; border-radius: 50%; background: #111; border: 2px solid #fff; box-shadow: 0 2px 4px rgba(0,0,0,0.3); position: absolute; z-index: 10; }
  .matrix-legend { display: flex; gap: 16px; justify-content: center; margin-top: 16px; font-size: 11px; color: #666; }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-color { width: 10px; height: 10px; border-radius: 50%; }
  .header { border-bottom: 3px solid #111; padding-bottom: 20px; margin-bottom: 28px; }
  .header-top { display: flex; justify-content: space-between; align-items: flex-start; gap: 20px; }
  .brand { font-size: 12px; font-weight: 600; letter-spacing: 2px; color: #888; text-transform: uppercase; margin-bottom: 6px; }
  h1 { font-size: 26px; font-weight: 700; letter-spacing: -0.5px; margin-bottom: 6px; }
  .meta { font-size: 12px; color: #666; }
  .score-pill { background: ${scoreColor}15; border: 2px solid ${scoreColor}; border-radius: 10px; padding: 10px 18px; text-align: center; flex-shrink: 0; }
  .score-num { font-size: 28px; font-weight: 800; font-family: monospace; color: ${scoreColor}; display: block; }
  .score-label { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  .summary-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 12px; margin-bottom: 32px; }
  .summary-card { background: #f8f8f8; border-radius: 8px; padding: 12px 14px; }
  .summary-card .val { font-size: 20px; font-weight: 700; font-family: monospace; }
  .summary-card .lbl { font-size: 10px; color: #888; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 2px; }
  h2 { font-size: 15px; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; color: #888; margin: 28px 0 14px; }
  .risk { border: 1px solid #e8e8e8; border-left: 4px solid #ddd; border-radius: 0 8px 8px 0; padding: 14px 16px; margin-bottom: 10px; page-break-inside: avoid; }
  .risk-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
  .risk-title { font-weight: 700; font-size: 14px; }
  .risk-score { font-family: monospace; font-weight: 800; font-size: 18px; flex-shrink: 0; }
  .tags { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .tag { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 10px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; }
  .tag-cat { background: #f0f0f0; color: #555; }
  .tag-status { background: #e8f4ff; color: #2266cc; }
  .tag-owner { background: #f0fff4; color: #1a7a3a; }
  .risk-desc { font-size: 13px; color: #333; margin-bottom: 10px; }
  .mitigation-box { background: #fffbf0; border: 1px solid #ffe066; border-radius: 6px; padding: 8px 12px; font-size: 12px; color: #555; }
  .mitigation-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #b8930a; margin-bottom: 3px; }
  .scores-row { display: flex; gap: 16px; font-size: 11px; color: #888; margin-bottom: 8px; }
  .scores-row span { font-weight: 600; color: #444; }
  .info-section { background: #f8f8f8; border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
  .info-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-bottom: 4px; }
  .footer { margin-top: 40px; padding-top: 16px; border-top: 1px solid #eee; font-size: 11px; color: #aaa; display: flex; justify-content: space-between; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } .page { padding: 16px; } }
</style></head><body>
<div class="page">
  <div class="header">
    <div class="header-top">
      <div>
        <div class="brand">PreShield · Risk Report</div>
        <h1>${project.name}</h1>
        <div class="meta">
          ${project.project_type?.replace(/_/g, " ")} &nbsp;·&nbsp; Generated ${new Date().toLocaleDateString()}
          ${project.deadline ? ` &nbsp;·&nbsp; Deadline: ${project.deadline}` : ""}
        </div>
      </div>
      <div class="score-pill">
        <span class="score-num">${parseFloat(project.overall_risk_score || 0).toFixed(1)}</span>
        <span class="score-label">Risk Score</span>
      </div>
    </div>
    ${project.description ? `<p style="margin-top:14px;color:#555;font-size:13px;">${project.description}</p>` : ""}
  </div>

  <div class="matrix-container">
    <div style="font-size:13px; font-weight:700; margin-bottom:12px; text-align:center; text-transform:uppercase; letter-spacing:1px; color:#888;">Risk Matrix</div>
    <div class="matrix-grid">
      ${[5, 4, 3, 2, 1].map(L => `
        <div class="matrix-label">${L}</div>
        ${[1, 2, 3, 4, 5].map(I => {
          const cellRisks = risks.filter(r => Math.round(r.likelihood) === L && Math.round(r.impact) === I);
          const p = (I * L) / 25;
          const bg = p < 0.12 ? "#E8F5E9" : p < 0.28 ? "#FFE9B5" : p < 0.5 ? "#FFE0B2" : "#FFEBEE";
          return `<div class="matrix-cell" style="background:${bg}">
            ${cellRisks.length > 0 ? `<div class="matrix-dot" title="${cellRisks.length} risks"></div>` : ""}
          </div>`;
        }).join("")}
      `).join("")}
      <div></div>
      ${[1, 2, 3, 4, 5].map(I => `<div class="matrix-label">${I}</div>`).join("")}
    </div>
    <div style="display:flex; justify-content:space-between; margin-top:4px; font-size:10px; color:#aaa; font-weight:700; text-transform:uppercase; letter-spacing:1px;">
      <div style="margin-left:30px">Impact →</div>
      <div style="transform:rotate(-90deg) translateY(-280px); width:0; white-space:nowrap;">Likelihood →</div>
    </div>
    <div class="matrix-legend">
      <div class="legend-item"><div class="legend-color" style="background:#1D9E75"></div>Low</div>
      <div class="legend-item"><div class="legend-color" style="background:#EF9F27"></div>Medium</div>
      <div class="legend-item"><div class="legend-color" style="background:#F57C00"></div>High</div>
      <div class="legend-item"><div class="legend-color" style="background:#E53935"></div>Critical</div>
    </div>
  </div>

  <div class="summary-grid">
    <div class="summary-card"><div class="val">${risks.length}</div><div class="lbl">Total Risks</div></div>
    <div class="summary-card"><div class="val" style="color:#E53935">${risks.filter(r => r.risk_score >= 18).length}</div><div class="lbl">Critical</div></div>
    <div class="summary-card"><div class="val" style="color:#F57C00">${risks.filter(r => r.risk_score >= 12 && r.risk_score < 18).length}</div><div class="lbl">High</div></div>
    <div class="summary-card"><div class="val" style="color:#EF9F27">${risks.filter(r => r.risk_score >= 6 && r.risk_score < 12).length}</div><div class="lbl">Medium</div></div>
    <div class="summary-card"><div class="val" style="color:#1D9E75">${risks.filter(r => r.risk_score < 6).length}</div><div class="lbl">Low</div></div>
  </div>

  <h2>Risk Assessment</h2>
  ${sorted.map((r, i) => `
  <div class="risk" style="border-left-color:${riskColor(r.risk_score)}">
    <div class="risk-row">
      <span class="risk-title">#${i + 1} ${r.title}</span>
      <span class="risk-score" style="color:${riskColor(r.risk_score)}">${parseFloat(r.risk_score).toFixed(1)}</span>
    </div>
    <div class="tags">
      <span class="tag tag-cat">${r.category}</span>
      <span class="tag tag-status">${r.status}</span>
      ${r.owner ? `<span class="tag tag-owner">👤 ${r.owner}</span>` : ""}
    </div>
    <div class="scores-row">
      <div>Likelihood: <span>${parseFloat(r.likelihood).toFixed(1)}/5</span></div>
      <div>Impact: <span>${parseFloat(r.impact).toFixed(1)}/5</span></div>
      <div>Score: <span style="color:${riskColor(r.risk_score)}">${parseFloat(r.risk_score).toFixed(2)}</span></div>
    </div>
    <div class="risk-desc">${r.description}</div>
    <div class="mitigation-box">
      <div class="mitigation-label">Mitigation</div>
      ${r.mitigation || "—"}
    </div>
  </div>`).join("")}

  ${project.stakeholders || project.constraints ? `
  <h2>Project Details</h2>
  ${project.stakeholders ? `<div class="info-section"><div class="info-label">Stakeholders</div>${project.stakeholders}</div>` : ""}
  ${project.constraints ? `<div class="info-section"><div class="info-label">Constraints</div>${project.constraints}</div>` : ""}
  ` : ""}

  <div class="footer">
    <span>PreShield Risk Assessment</span>
    <span>${new Date().toLocaleDateString()} · ${risks.length} risks identified</span>
  </div>
</div>
</body></html>`;
}

function buildPPTXHtml(project, t) {
  const risks = project.risks || [];
  const sorted = [...risks].sort((a, b) => b.risk_score - a.risk_score);
  const scoreColor = project.overall_risk_score >= 60 ? "#E24B4A" : project.overall_risk_score >= 30 ? "#EF9F27" : "#1D9E75";
  const riskColor = (s) => s >= 18 ? "#E53935" : s >= 12 ? "#F57C00" : s >= 6 ? "#EF9F27" : "#1D9E75";
  const crit = risks.filter(r => r.risk_score >= 18);
  const high = risks.filter(r => r.risk_score >= 12 && r.risk_score < 18);
  const med = risks.filter(r => r.risk_score >= 6 && r.risk_score < 12);
  const low = risks.filter(r => r.risk_score < 6);
  const slides = [
    // Slide 1: Title
    `<div class="slide slide-title">
      <div class="slide-brand">PreShield · Risk Assessment</div>
      <h1>${project.name}</h1>
      <div class="slide-sub">${project.project_type?.replace(/_/g, " ")} &nbsp;·&nbsp; ${new Date().toLocaleDateString()}${project.deadline ? ` &nbsp;·&nbsp; Deadline: ${project.deadline}` : ""}</div>
      ${project.description ? `<p class="slide-desc">${project.description}</p>` : ""}
      <div class="title-score" style="border-color:${scoreColor};color:${scoreColor}">
        <div class="big-num">${parseFloat(project.overall_risk_score || 0).toFixed(1)}</div>
        <div>Overall Risk Score</div>
      </div>
    </div>`,
    // Slide 2: Summary
    `<div class="slide">
      <div class="slide-num">02</div>
      <h2>Risk Summary</h2>
      <div class="stat-row">
        <div class="stat-box"><div class="stat-n">${risks.length}</div><div class="stat-l">Total Risks</div></div>
        <div class="stat-box" style="border-color:#E53935"><div class="stat-n" style="color:#E53935">${crit.length}</div><div class="stat-l">Critical</div></div>
        <div class="stat-box" style="border-color:#F57C00"><div class="stat-n" style="color:#F57C00">${high.length}</div><div class="stat-l">High</div></div>
        <div class="stat-box" style="border-color:#EF9F27"><div class="stat-n" style="color:#B8860B">${med.length}</div><div class="stat-l">Medium</div></div>
        <div class="stat-box" style="border-color:#1D9E75"><div class="stat-n" style="color:#1D9E75">${low.length}</div><div class="stat-l">Low</div></div>
      </div>
      <div style="margin-top:28px">
        ${sorted.slice(0, 5).map((r, i) => `
        <div class="risk-row-slide">
          <span style="color:#888;font-size:12px;min-width:20px">#${i+1}</span>
          <span style="flex:1;font-weight:600;font-size:14px">${r.title}</span>
          <span class="score-badge" style="background:${riskColor(r.risk_score)}22;color:${riskColor(r.risk_score)}">${parseFloat(r.risk_score).toFixed(1)}</span>
        </div>`).join("")}
      </div>
    </div>`,
    // Slides 3+: Individual risks (up to 6)
    ...sorted.slice(0, 6).map((r, i) => `
    <div class="slide">
      <div class="slide-num" style="color:${riskColor(r.risk_score)}">0${i+3}</div>
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:14px">
        <h2 style="margin:0">${r.title}</h2>
        <div class="score-badge-lg" style="background:${riskColor(r.risk_score)}22;color:${riskColor(r.risk_score)};border:2px solid ${riskColor(r.risk_score)}44">${parseFloat(r.risk_score).toFixed(1)}</div>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:14px">
        <span class="chip">${r.category}</span>
        <span class="chip">L: ${parseFloat(r.likelihood).toFixed(1)}</span>
        <span class="chip">I: ${parseFloat(r.impact).toFixed(1)}</span>
        ${r.owner ? `<span class="chip">👤 ${r.owner}</span>` : ""}
      </div>
      <div class="slide-section-label">Risk Description</div>
      <p style="font-size:14px;color:#333;margin-bottom:16px">${r.description}</p>
      <div class="slide-section-label" style="color:#b8930a">Mitigation Strategy</div>
      <div class="mitigation-block">${r.mitigation || "—"}</div>
    </div>`),
    // Last slide
    `<div class="slide slide-end">
      <div class="slide-brand">PreShield</div>
      <h1 style="font-size:28px">Thank you</h1>
      <p style="color:#888;margin-top:8px">This pre-mortem was generated by PreShield AI</p>
    </div>`
  ];

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>PreShield Deck — ${project.name}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; background: #1a1a2e; color: #111; }
  .slides-container { display: flex; flex-direction: column; gap: 4px; padding: 20px; }
  .slide { background: #fff; width: 960px; height: 540px; padding: 48px 56px; position: relative; overflow: hidden; page-break-after: always; display: flex; flex-direction: column; justify-content: center; }
  .slide::before { content: ""; position: absolute; top: 0; left: 0; right: 0; height: 5px; background: #5B5BFF; }
  .slide-title { background: #0A0A0F; color: #fff; }
  .slide-title::before { background: #5B5BFF; height: 5px; }
  .slide-end { background: #0A0A0F; color: #fff; text-align: center; }
  .slide-brand { font-size: 11px; font-weight: 700; letter-spacing: 3px; text-transform: uppercase; color: #9999FF; margin-bottom: 16px; }
  h1 { font-size: 36px; font-weight: 800; letter-spacing: -1px; margin-bottom: 8px; }
  h2 { font-size: 22px; font-weight: 700; margin-bottom: 16px; }
  .slide-sub { font-size: 13px; color: #888; margin-bottom: 16px; }
  .slide-desc { font-size: 14px; color: #aaa; max-width: 500px; }
  .slide-num { font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #ccc; position: absolute; top: 24px; right: 56px; }
  .title-score { border: 3px solid; border-radius: 12px; padding: 16px 24px; text-align: center; position: absolute; right: 56px; top: 50%; transform: translateY(-50%); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 1px; }
  .big-num { font-size: 48px; font-weight: 900; font-family: monospace; display: block; margin-bottom: 4px; }
  .stat-row { display: flex; gap: 16px; }
  .stat-box { flex: 1; border: 2px solid #eee; border-radius: 10px; padding: 16px; text-align: center; }
  .stat-n { font-size: 36px; font-weight: 800; font-family: monospace; }
  .stat-l { font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; color: #888; margin-top: 4px; }
  .risk-row-slide { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
  .score-badge { padding: 3px 10px; border-radius: 20px; font-size: 12px; font-weight: 700; font-family: monospace; }
  .score-badge-lg { padding: 8px 14px; border-radius: 10px; font-size: 22px; font-weight: 800; font-family: monospace; flex-shrink: 0; }
  .chip { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; background: #f0f0f0; color: #555; }
  .slide-section-label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #888; margin-bottom: 6px; }
  .mitigation-block { background: #fffbf0; border: 1px solid #ffe08a; border-radius: 8px; padding: 12px 14px; font-size: 13px; color: #555; }
  @media print { body { background: #fff; } .slides-container { padding: 0; gap: 0; } .slide { page-break-after: always; } }
</style></head><body>
<div class="slides-container">${slides.join("")}</div>
</body></html>`;
}

function ExportModal({ project, t, onClose }) {
  const [exporting, setExporting] = useState(null);
  const filename = project.name.replace(/[^a-z0-9]/gi, "_");

  const doExport = async (format) => {
    setExporting(format);
    try {
      if (format === "html") {
        const html = buildReportHTML(project, t);
        download(html, `PreShield_${filename}.html`, "text/html");
      } else if (format === "pdf") {
        const html = buildReportHTML(project, t, true);
        const win = window.open("", "_blank");
        win.document.write(html);
        win.document.close();
        setTimeout(() => { win.print(); }, 600);
      } else if (format === "word") {
        const html = buildReportHTML(project, t);
        const wordHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word'><head><meta charset='utf-8'></head><body>${html}</body></html>`;
        download(wordHtml, `PreShield_${filename}.doc`, "application/msword");
      } else if (format === "pptx") {
        const html = buildPPTXHtml(project, t);
        download(html, `PreShield_${filename}_deck.html`, "text/html");
      } else if (format === "jpeg") {
        const html = buildReportHTML(project, t);
        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        const win = window.open(url, "_blank");
        setTimeout(() => { URL.revokeObjectURL(url); }, 3000);
        // Show instruction for JPEG
        setExporting("jpeg-tip");
        return;
      }
    } finally {
      if (format !== "jpeg") setExporting(null);
    }
  };

  const download = (content, filename, type) => {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  };

  const formats = [
    { id: "pdf", icon: "📄", label: "PDF", desc: "Opens print dialog — Save as PDF" },
    { id: "word", icon: "📝", label: "Word (.doc)", desc: "Opens in Microsoft Word or Google Docs" },
    { id: "html", icon: "🌐", label: "HTML", desc: "Download as HTML file" },
    { id: "pptx", icon: "📊", label: "Presentation", desc: "16:9 slide deck — open & print to PPTX" },
    { id: "jpeg", icon: "🖼️", label: "JPEG / Image", desc: "Opens report — use browser screenshot" },
  ];

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
      <div className="card fade-in" style={{ padding: 28, maxWidth: 420, width: "90%", margin: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
          <div style={{ fontWeight: 600, fontSize: 16, color: "var(--ps-text)" }}>Export Report</div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--ps-text-muted)", fontSize: 18, cursor: "pointer", padding: "0 4px" }}>✕</button>
        </div>
        {exporting === "jpeg-tip" ? (
          <div style={{ textAlign: "center", padding: "12px 0" }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🖼️</div>
            <div style={{ fontSize: 14, color: "var(--ps-text)", marginBottom: 8 }}>Report opened in new tab</div>
            <div style={{ fontSize: 13, color: "var(--ps-text-muted)", marginBottom: 20 }}>Use your browser's screenshot tool or <strong>Cmd+Shift+4</strong> (Mac) / <strong>Windows+Shift+S</strong> to capture as JPEG.</div>
            <button className="btn-primary" style={{ width: "100%" }} onClick={() => setExporting(null)}>Back</button>
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {formats.map(f => (
              <button key={f.id} onClick={() => doExport(f.id)} disabled={!!exporting} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 16px", background: exporting === f.id ? "#5B5BFF22" : "var(--ps-panel)", border: "1px solid var(--ps-border-subtle)", borderRadius: 10, cursor: "pointer", textAlign: "left", transition: "all 0.15s", opacity: exporting && exporting !== f.id ? 0.5 : 1 }}>
                <span style={{ fontSize: 22, flexShrink: 0 }}>{f.icon}</span>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, color: "var(--ps-text)" }}>{f.label}</div>
                  <div style={{ fontSize: 11, color: "var(--ps-text-muted)", marginTop: 1 }}>{f.desc}</div>
                </div>
                {exporting === f.id && <span style={{ fontSize: 12, color: "#5B5BFF" }}>...</span>}
                {!exporting && <span style={{ color: "var(--ps-text-muted)", fontSize: 14 }}>↓</span>}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function ProjectView({ t, project, subView, setSubView, onUpdate, onDelete, onBack, lang, colorMode }) {
  const [showExport, setShowExport] = useState(false);
  const tabs = [
    { id: "interview", label: t.tabInterview },
    { id: "risks", label: t.tabRisks },
    { id: "matrix", label: t.tabMatrix },
    { id: "chat", label: t.tabChat || "Chat" },
    { id: "team", label: t.tabTeam },
  ];
  return (
    <div className="fade-in page">
      <div className="project-header" style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 20 }}>
        <button className="btn-ghost" style={{ padding: "6px 10px", flexShrink: 0, marginTop: 2 }} onClick={onBack}>←</button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 2 }}>
            <h2 style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.3px" }}>{project.name}</h2>
            <span style={{ fontSize: 11, padding: "2px 8px", borderRadius: 20, background: project.status === "completed" ? "#1D9E7533" : project.status === "report_ready" ? "#5B5BFF22" : "#EF9F2722", color: project.status === "completed" ? "#1D9E75" : project.status === "report_ready" ? "#9999FF" : "#EF9F27", fontWeight: 500, flexShrink: 0 }}>
              {getStatusLabel(project.status, t)}
            </span>
          </div>
          {project.description && <div style={{ fontSize: 12, color: "var(--ps-text-muted)", marginBottom: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{project.description}</div>}
          <div style={{ fontSize: 11, color: "var(--ps-text-muted)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.projectTypes?.[project.project_type] || project.project_type?.replace(/_/g, " ")} · {project.risks?.length || 0} {t.risks} · {project.deadline || "—"}</div>
        </div>
        <div className="project-actions" style={{ display: "flex", gap: 6, flexShrink: 0, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {project.status === "report_ready" && (
            <button className="btn-ghost" style={{ fontSize: 12, padding: "6px 12px" }} onClick={() => onUpdate({ ...project, status: "completed" })}>
              ✓ {t.markComplete}
            </button>
          )}
          {(project.risks?.length > 0) && (
            <button className="btn-ghost" style={{ fontSize: 12, padding: "6px 12px" }} onClick={() => setShowExport(true)}>
              ↓ {t.exportPDF}
            </button>
          )}
          <button className="btn-danger" style={{ fontSize: 13, padding: "8px 12px", display: "inline-flex", alignItems: "center", gap: 10 }} onClick={onDelete}>
            <span aria-hidden style={{ fontSize: 16, lineHeight: 1 }}>🗑</span>
            <span>{t.deleteProject}</span>
          </button>
        </div>
      </div>
      <div style={{ display: "flex", gap: 0, marginBottom: 20, borderBottom: "1px solid var(--ps-border-subtle)", overflowX: "auto" }}>
        {tabs.map(tab => (
          <button key={tab.id} onClick={() => setSubView(tab.id)} className="tab-btn" style={{ background: "transparent", border: "none", padding: "8px 14px", fontSize: 13, color: subView === tab.id ? "#5B5BFF" : "var(--ps-text-muted)", fontFamily: "inherit", borderBottom: subView === tab.id ? "2px solid #5B5BFF" : "2px solid transparent", marginBottom: "-1px", cursor: "pointer", transition: "color 0.15s", flexShrink: 0, whiteSpace: "nowrap" }}>
            {tab.label}
          </button>
        ))}
      </div>
      {subView === "interview" && <InterviewView t={t} project={project} onUpdate={onUpdate} lang={lang} />}
      {subView === "risks" && <RisksView t={t} project={project} onUpdate={onUpdate} colorMode={colorMode} />}
      {subView === "matrix" && <MatrixView t={t} project={project} colorMode={colorMode} />}
      {subView === "chat" && <ProjectChatView t={t} project={project} onUpdate={onUpdate} />}
      {subView === "team" && <TeamView t={t} project={project} onUpdate={onUpdate} />}
      {showExport && <ExportModal project={project} t={t} onClose={() => setShowExport(false)} />}
    </div>
  );
}

/** Gemini requires the first content role to be `user`; our thread stores the assistant as `ai`. */
function interviewThreadToGeminiContents(thread) {
  const mapped = thread.map((m) => ({
    role: (m.role === "ai" || m.role === "model") ? "model" : "user",
    parts: [{ text: m.content || "" }],
  }));
  
  if (mapped.length === 0) return [];

  const result = [];
  // Gemini requires the first message to be from the user
  if (mapped[0].role === "model") {
    result.push({ role: "user", parts: [{ text: "Continue the discussion." }] });
  }

  for (let i = 0; i < mapped.length; i++) {
    const current = mapped[i];
    const last = result[result.length - 1];

    if (last && last.role === current.role) {
      // If consecutive roles are the same, merge their content
      last.parts[0].text += "\n\n" + current.parts[0].text;
    } else {
      result.push(current);
    }
  }

  return result;
}

function buildGeminiRequestBody(systemPrompt, thread, isInterview = true) {
  const contents = interviewThreadToGeminiContents(thread);
  
  // If no contents, start with the system prompt as a user message
  if (contents.length === 0) {
    const suffix = isInterview ? "\n\nStart the interview now." : "";
    return {
      contents: [{ role: "user", parts: [{ text: systemPrompt + suffix }] }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
    };
  }

  // Otherwise, prepend the system prompt to the first user message
  const finalContents = [...contents];
  if (finalContents[0].role === "user") {
    finalContents[0].parts[0].text = systemPrompt + "\n\n" + finalContents[0].parts[0].text;
  } else {
    finalContents.unshift({ role: "user", parts: [{ text: systemPrompt }] });
  }

  return {
    contents: finalContents,
    generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
  };
}

function buildGeminiStartBody(systemPrompt) {
  return {
    contents: [{ role: "user", parts: [{ text: systemPrompt + "\n\nStart the interview now." }] }],
    generationConfig: { maxOutputTokens: 2048, temperature: 0.7 },
  };
}

function isLikelyIrrelevantInterviewInput(text) {
  const s = String(text || "").trim().toLowerCase();
  if (!s) return false;
  const irrelevantHints = [
    "weather", "temperature", "joke", "song", "movie", "football", "basketball", "cricket",
    "politics", "election", "celebrity", "horoscope", "astrology", "recipe", "cook", "travel",
    "bitcoin price", "stock price", "news headlines", "who won", "tell me a joke",
    "מזג אוויר", "בדיחה", "מתכון", "כדורגל",
    "clima", "broma", "receta", "futbol",
    "météo", "blague", "recette", "football",
    "wetter", "witz", "rezept", "fussball",
  ];
  return irrelevantHints.some((k) => s.includes(k));
}

function mergeProjectMessagesByChannel(existing, channel, nextChannelMessages) {
  const keep = (existing || []).filter((m) => (m?.channel || "interview") !== channel);
  return [...keep, ...nextChannelMessages];
}

// ─── Translation helper ──────────────────────────────────────────────────────
async function translateMessage(text, targetLang) {
  if (!text || targetLang === "en") return text;
  
  const langMap = {
    "he": "Hebrew",
    "es": "Spanish",
    "fr": "French",
    "de": "German",
    "en": "English"
  };
  
  const targetLangName = langMap[targetLang] || "English";
  
  try {
    const body = {
      contents: [{
        role: "user",
        parts: [{
          text: `Translate the following text to ${targetLangName}. Only provide the translation, nothing else. Do not add any explanation or additional text.\n\n${text}`
        }]
      }],
      generationConfig: { maxOutputTokens: 2048, temperature: 0.3 },
    };
    
    const { res, data } = await geminiGenerateWithModels(body);
    
    if (res?.ok) {
      const translated = geminiResponseText(data);
      return translated.trim() || text;
    }
  } catch (e) {
    console.warn("Translation failed:", e);
  }
  
  return text;
}

function InterviewView({ t, project, onUpdate, lang }) {
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [startError, setStartError] = useState(null);
  const [translatedMessages, setTranslatedMessages] = useState([]);
  const [translationInProgress, setTranslationInProgress] = useState(false);
  const messagesEndRef = useRef(null);
  const allMessages = project.messages || [];
  const messages = allMessages.filter((m) => (m?.channel || "interview") === "interview");
  
  // Translation cache to avoid redundant API calls
  const translationCacheRef = useRef({});
  
  // Translate messages when language changes
  useEffect(() => {
    const translateAllMessages = async () => {
      if (messages.length === 0) {
        setTranslatedMessages([]);
        return;
      }
      
      setTranslationInProgress(true);
      const translated = await Promise.all(
        messages.map(async (msg) => {
          // Only translate AI messages, keep user messages as-is
          if (msg.role === "user") {
            return msg;
          }
          
          // Check cache first
          const cacheKey = `${msg.content}-${lang}`;
          if (translationCacheRef.current[cacheKey]) {
            return {
              ...msg,
              content: translationCacheRef.current[cacheKey]
            };
          }
          
          // Translate AI message
          const translatedContent = await translateMessage(msg.content, lang);
          translationCacheRef.current[cacheKey] = translatedContent;
          
          return {
            ...msg,
            content: translatedContent
          };
        })
      );
      
      setTranslatedMessages(translated);
      setTranslationInProgress(false);
    };
    
    translateAllMessages();
  }, [lang, messages]);

  useEffect(() => { messagesEndRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages]);

  const systemPrompt = `You are PreShield, an expert AI facilitator conducting a pre-mortem risk assessment interview. Your goal is to uncover hidden risks before the project starts.

Project context:
- Name: ${project.name}
- Type: ${project.project_type}
- Team size: ${project.team_size || "unknown"}
- Deadline: ${project.deadline || "unspecified"}
- Budget: ${project.budget_range}
- Stakeholders: ${project.stakeholders || "unspecified"}
- Constraints: ${project.constraints || "none listed"}

Your job:
1. Ask ONE probing, specific question at a time. Never ask multiple questions.
2. Dig deeper into concerning answers with follow-up probes.
3. Keep the interview strictly on project risk analysis. If the user asks an irrelevant question, politely redirect to project risks and ask a relevant follow-up question.
4. After 6-10 questions, output a JSON block like this:
{"risks": [{"title": "...", "description": "...", "category": "technical|resource|schedule|scope|communication|external|organizational|financial", "likelihood": 1-5, "impact": 1-5, "mitigation": "Step 1: ...\nStep 2: ...\nStep 3: ..."}]}

Keep questions conversational, insightful, and specific to the project type. Avoid generic risk checklists. Respond in ${lang === "en" ? "English" : lang === "he" ? "Hebrew" : lang === "es" ? "Spanish" : lang === "fr" ? "French" : "German"}.

If this is the first message, introduce yourself briefly and ask your first question about what could most likely cause this project to fail.`;

  const sendMessage = async () => {
    if (!input.trim() || loading) return;
    if (isLikelyIrrelevantInterviewInput(input)) {
      const redirectMsg = {
        role: "ai",
        channel: "interview",
        content: t.interviewRelevantOnly || "I can only help with project-risk interview questions here. Please answer with project details, constraints, risks, timeline, budget, stakeholders, or delivery concerns.",
        timestamp: new Date().toISOString(),
      };
      const withRedirect = mergeProjectMessagesByChannel(allMessages, "interview", [...messages, redirectMsg]);
      onUpdate({ ...project, messages: withRedirect, status: "interviewing" });
      setInput("");
      return;
    }
    const userMsg = { role: "user", channel: "interview", content: input, timestamp: new Date().toISOString() };
    const updatedMsgs = [...messages, userMsg];
    onUpdate({ ...project, messages: mergeProjectMessagesByChannel(allMessages, "interview", updatedMsgs), status: "interviewing" });
    setInput("");
    setLoading(true);
    try {
      const { res, data } = await geminiGenerateWithModels(buildGeminiRequestBody(systemPrompt, updatedMsgs));
      if (!res?.ok) {
        let errText = geminiApiError(data, res?.status || 0);
        if (res?.status === 401 || res?.status === 403 || res?.status === 400) errText = `${errText}\n\n${t.interviewApiHint}`;
        const errMsg = { role: "ai", channel: "interview", content: errText, timestamp: new Date().toISOString() };
        onUpdate({ ...project, messages: mergeProjectMessagesByChannel(allMessages, "interview", [...updatedMsgs, errMsg]) });
        return;
      }
      const text = geminiResponseText(data);
      const aiMsg = { role: "ai", channel: "interview", content: text, timestamp: new Date().toISOString() };
      const finalMsgs = [...updatedMsgs, aiMsg];

      // Extract risks if JSON block present
      let newRisks = project.risks || [];
      const jsonMatch = text.match(/\{[\s\S]*"risks"[\s\S]*\}/);
      if (jsonMatch) {
        try {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed.risks) {
            const existingRisks = project.risks || [];
            const existingTitles = new Set(existingRisks.map(r => r.title?.toLowerCase().trim()));
            const addedRisks = parsed.risks
              .filter(r => !existingTitles.has(r.title?.toLowerCase().trim()))
              .map((r, i) => ({
                ...r,
                id: `${Date.now()}-${i}`,
                risk_score: parseFloat((r.likelihood * r.impact).toFixed(2)),
                status: "identified",
                owner: "",
                comments: [],
              }));
            const allRisks = [...existingRisks, ...addedRisks];
            const overallScore = parseFloat(allRisks.reduce((a, r) => a + r.risk_score, 0).toFixed(1));
            onUpdate({ ...project, messages: mergeProjectMessagesByChannel(allMessages, "interview", finalMsgs), risks: allRisks, risk_count: allRisks.length, overall_risk_score: overallScore, report_generated: true, status: "report_ready" });
            return;
          }
        } catch {}
      }
      onUpdate({ ...project, messages: mergeProjectMessagesByChannel(allMessages, "interview", finalMsgs), risks: newRisks });
    } catch (e) {
      const errMsg = { role: "ai", channel: "interview", content: t.connectionError, timestamp: new Date().toISOString() };
      onUpdate({ ...project, messages: mergeProjectMessagesByChannel(allMessages, "interview", [...updatedMsgs, errMsg]) });
    } finally {
      setLoading(false);
    }
  };

  const startInterview = async () => {
    setStartError(null);
    setLoading(true);
    try {
      const { res, data } = await geminiGenerateWithModels(buildGeminiStartBody(systemPrompt));
      if (!res?.ok) {
        let msg = geminiApiError(data, res?.status || 0);
        if (res?.status === 401 || res?.status === 403 || res?.status === 400) msg = `${msg}\n\n${t.interviewApiHint}`;
        setStartError(msg);
        return;
      }
      const text = geminiResponseText(data);
      if (!text.trim()) {
        setStartError(t.connectionError);
        return;
      }
      onUpdate({
        ...project,
        messages: mergeProjectMessagesByChannel(allMessages, "interview", [{ role: "ai", channel: "interview", content: text, timestamp: new Date().toISOString() }]),
        status: "interviewing"
      });
    } catch (e) {
      setStartError(t.connectionError);
    } finally {
      setLoading(false);
    }
  };

  if (messages.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "60px 24px" }}>
        <div style={{ fontSize: 48, marginBottom: 20 }}>🎙️</div>
        <h3 style={{ fontSize: 18, fontWeight: 500, marginBottom: 8 }}>{t.startInterview}</h3>
        <p style={{ color: "var(--ps-text-muted)", fontSize: 14, marginBottom: 28, maxWidth: 360, margin: "0 auto 28px" }}>
          {t.interviewIntro}
        </p>
        {startError && (
          <div style={{ color: "#E24B4A", fontSize: 13, marginBottom: 20, maxWidth: 420, marginLeft: "auto", marginRight: "auto", lineHeight: 1.55, whiteSpace: "pre-wrap" }}>
            {startError}
          </div>
        )}
        <button className="btn-primary" style={{ padding: "12px 28px" }} onClick={startInterview} disabled={loading}>
          {loading ? t.thinking : `${t.startInterview} →`}
        </button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "calc(100vh - 240px)", minHeight: 400 }}>
      {/* Session stats */}
      <div className="interview-stats" style={{ display: "flex", gap: 16, marginBottom: 12, padding: "10px 14px", background: "var(--ps-panel)", borderRadius: 8, border: "1px solid var(--ps-border-subtle)", flexWrap: "wrap" }}>
        <div style={{ fontSize: 12, color: "var(--ps-text-muted)" }}>{t.questionsAsked}: <span style={{ color: "var(--ps-text)", fontFamily: "'DM Mono', monospace" }}>{messages.filter(m => m.role === "ai").length}</span></div>
        <div style={{ fontSize: 12, color: "var(--ps-text-muted)" }}>{t.risksFound}: <span style={{ color: getOverallRiskColor(project.overall_risk_score), fontFamily: "'DM Mono', monospace" }}>{project.risks?.length || 0}</span></div>
        {project.report_generated && <div style={{ fontSize: 12, color: "#1D9E75", marginLeft: "auto" }}>✓ {t.reportGenerated}</div>}
        {project.status === "completed" && !project.report_generated && <div style={{ fontSize: 12, color: "#1D9E75", marginLeft: "auto", fontWeight: 600 }}>✓ {t.statusCompleted}</div>}
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "4px 0", display: "flex", flexDirection: "column", gap: 12 }}>
        {translatedMessages.map((m, i) => (
          <div key={i} style={{ display: "flex", justifyContent: m.role === "user" ? "flex-end" : "flex-start" }}>
            <div style={{
              maxWidth: "72%",
              padding: "12px 16px",
              borderRadius: m.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
              background: m.role === "user" ? "#5B5BFF" : "var(--ps-chat-ai-bg)",
              border: m.role === "ai" ? "1px solid var(--ps-border-subtle)" : "none",
              fontSize: 14,
              lineHeight: 1.6,
              color: m.role === "user" ? "#fff" : "var(--ps-text)",
              whiteSpace: "pre-wrap",
            }}>
              {m.content.replace(/\{[\s\S]*"risks"[\s\S]*\}/, t.risksExtracted)}
            </div>
          </div>
        ))}
        {(loading || translationInProgress) && (
          <div style={{ display: "flex", justifyContent: "flex-start" }}>
            <div className="card" style={{ padding: "12px 16px", display: "flex", gap: 6, alignItems: "center" }}>
              {[0, 1, 2].map(i => <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#5B5BFF", animation: `bounce 1s ${i * 0.15}s infinite` }} />)}
              <style>{`@keyframes bounce { 0%,100%{transform:translateY(0)} 50%{transform:translateY(-4px)} }`}</style>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <div style={{ display: "flex", gap: 10, marginTop: 16, paddingTop: 16, borderTop: "1px solid var(--ps-border-subtle)" }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => e.key === "Enter" && !e.shiftKey && sendMessage()} placeholder={t.typeMessage} />
        <button className="btn-primary" style={{ minWidth: 72, flexShrink: 0 }} onClick={sendMessage} disabled={loading || !input.trim()}>{t.send}</button>
      </div>
    </div>
  );
}

function riskSeverityWord(t, score) {
  const lv = getRiskLevel(score);
  if (lv === "critical") return t.critical;
  if (lv === "high") return t.high;
  if (lv === "medium") return t.medium;
  return t.low;
}

function clampLikertInput(v) {
  const x = parseFloat(String(v).replace(",", "."));
  if (Number.isNaN(x)) return 3;
  const rounded = Math.round(x);
  return Math.min(5, Math.max(1, rounded));
}

function mitigationToDetailedSteps(text) {
  const raw = String(text || "").trim();
  if (!raw) return "—";
  if (/step\s*\d+[:.)-]/i.test(raw) || /\n[-*]\s+/.test(raw) || /\n\d+[.)]\s+/.test(raw)) return raw;
  const parts = raw
    .split(/[.;]\s+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .slice(0, 5);
  if (parts.length <= 1) return `Step 1: ${raw}`;
  return parts.map((p, i) => `Step ${i + 1}: ${p}`).join("\n");
}

function RisksView({ t, project, onUpdate, colorMode }) {
  const risks = project.risks || [];
  const [commentInputs, setCommentInputs] = useState({});
  const [expandedRisk, setExpandedRisk] = useState(null);
  const [editDraft, setEditDraft] = useState(null);
  const [riskMitigationChat, setRiskMitigationChat] = useState(null);
  const [riskChatMessages, setRiskChatMessages] = useState([]);
  const [riskChatLoading, setRiskChatLoading] = useState(false);
  const [riskChatInput, setRiskChatInput] = useState("");
  const sortedRisks = [...risks].sort((a, b) => b.risk_score - a.risk_score);
  const mitBlue = colorMode === "light" ? "#2563EB" : "#60A5FA";

  const updateRisk = (id, updates) => {
    const updatedRisks = risks.map(r => r.id === id ? { ...r, ...updates } : r);
    const overallScore = parseFloat(updatedRisks.reduce((a, r) => a + r.risk_score, 0).toFixed(1));
    onUpdate({ ...project, risks: updatedRisks, risk_count: updatedRisks.length, overall_risk_score: overallScore });
  };

  const deleteRisk = (id) => {
    if (!window.confirm(t.deleteRiskConfirm)) return;
    const updatedRisks = risks.filter(r => r.id !== id);
    const overallScore = parseFloat(updatedRisks.reduce((a, r) => a + r.risk_score, 0).toFixed(1));
    onUpdate({ ...project, risks: updatedRisks, risk_count: updatedRisks.length, overall_risk_score: overallScore });
    setExpandedRisk(e => (e === id ? null : e));
    setEditDraft(d => (d?.id === id ? null : d));
  };

  const startRiskMitigationChat = async (risk) => {
    setRiskMitigationChat(risk);
    const history = risk.chatHistory || [];
    setRiskChatMessages(history);
    
    // If we already have history, don't trigger initial AI message
    if (history.length > 0) return;

    setRiskChatLoading(true);
    try {
      const systemPrompt = `You are an expert risk mitigation specialist. Your role is to help develop a comprehensive, detailed mitigation plan for this specific risk.\n\nRISK DETAILS:\n- Title: ${risk.title}\n- Description: ${risk.description}\n- Current Likelihood: ${risk.likelihood}/5\n- Current Impact: ${risk.impact}/5\n- Current Mitigation: ${risk.mitigation || "Not yet defined"}\n- Status: ${risk.status || "identified"}\n\nPROVIDE:\n1. 5-7 detailed, actionable mitigation tips specific to this risk\n2. For each tip: implementation steps and expected outcomes\n3. Clarifying questions to understand project context\n4. Refined mitigation strategy through conversation\n5. Realistic updates to likelihood and impact\n6. Specific metrics or KPIs to track effectiveness\n\nFOCUS: Keep conversation ONLY about this specific risk. Provide practical, implementable guidance.`;
      
      // Use buildGeminiRequestBody with isInterview=false to avoid interview-specific instructions
      const body = buildGeminiRequestBody(systemPrompt, [], false);
      const { res, data } = await geminiGenerateWithModels(body);
      
      if (!res?.ok) throw new Error("Failed to start chat");
      const text = geminiResponseText(data);
      const initialMsg = { role: "ai", content: text };
      setRiskChatMessages([initialMsg]);
      
      // Save initial message to risk history
      updateRisk(risk.id, { chatHistory: [initialMsg] });
    } catch (e) {
      console.error("Risk mitigation chat error:", e);
      setRiskChatMessages([{ role: "ai", content: "Error starting mitigation chat. Please try again." }]);
    } finally {
      setRiskChatLoading(false);
    }
  };

  const sendRiskChatMessage = async (userMessage) => {
    if (!riskMitigationChat || !userMessage.trim()) return;
    const newMessages = [...riskChatMessages, { role: "user", content: userMessage }];
    setRiskChatMessages(newMessages);
    setRiskChatLoading(true);
    try {
      const systemPrompt = `You are an expert risk mitigation specialist helping to refine the mitigation plan for this risk: ${riskMitigationChat.title}. Continue the conversation and help develop practical, actionable mitigation strategies. Keep responses focused on this specific risk.`;
      const thread = newMessages.map(m => ({
        role: m.role === "user" ? "user" : "ai",
        content: m.content
      }));
      const body = buildGeminiRequestBody(systemPrompt, thread, false);
      const { res, data } = await geminiGenerateWithModels(body);
      if (!res?.ok) throw new Error("Failed to get response");
      const text = geminiResponseText(data);
      const aiMsg = { role: "ai", content: text };
      const finalMessages = [...newMessages, aiMsg];
      setRiskChatMessages(finalMessages);
      
      // Save history to project
      const updatedRisks = risks.map(r => r.id === riskMitigationChat.id ? { ...r, chatHistory: finalMessages } : r);
      onUpdate({ ...project, risks: updatedRisks });
    } catch (e) {
      console.error("Risk chat message error:", e);
      const errorMessages = [...newMessages, { role: "ai", content: "Error: Could not process your message." }];
      setRiskChatMessages(errorMessages);
      updateRisk(riskMitigationChat.id, { chatHistory: errorMessages });
    } finally {
      setRiskChatLoading(false);
    }
  };

  const saveRiskMitigationUpdates = () => {
    if (!riskMitigationChat) return;
    // AI suggestions for updates will be extracted from chat history
    // For now, users can manually update parameters in the risk edit form
    closeRiskMitigationChat();
  };

  const exportRiskReport = async (format = 'html') => {
    if (!riskMitigationChat) return;
    try {
      const reportData = {
        riskTitle: riskMitigationChat.title,
        riskDescription: riskMitigationChat.description,
        likelihood: riskMitigationChat.likelihood,
        impact: riskMitigationChat.impact,
        riskScore: riskMitigationChat.risk_score,
        mitigation: riskMitigationChat.mitigation,
        status: riskMitigationChat.status,
        owner: riskMitigationChat.owner,
        chatHistory: riskChatMessages,
        generatedAt: new Date().toISOString(),
        projectName: project.name,
      };

      const htmlContent = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Risk Report - ${reportData.riskTitle}</title><style>body{font-family:Arial,sans-serif;margin:40px;color:#333;line-height:1.6}h1{color:#1f2937;border-bottom:3px solid #5B5BFF;padding-bottom:10px}h2{color:#374151;margin-top:30px;border-left:4px solid #5B5BFF;padding-left:10px}.risk-card{background:#f3f4f6;padding:20px;border-radius:8px;margin:20px 0;border-left:4px solid #5B5BFF}.parameter{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #e5e7eb}.parameter-label{font-weight:bold;color:#6b7280;min-width:150px}.parameter-value{color:#1f2937;flex:1;text-align:right}.chat-section{margin:30px 0}.message{margin:15px 0;padding:15px;border-radius:8px;page-break-inside:avoid}.user-message{background:#dbeafe;text-align:right;border-left:4px solid #3b82f6}.ai-message{background:#f0f9ff;border-left:4px solid #5B5BFF}.footer{margin-top:40px;padding-top:20px;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280}@media print{.no-print{display:none}}</style></head><body><h1>Risk Mitigation Report</h1><p><strong>Project:</strong> ${reportData.projectName}</p><p><strong>Generated:</strong> ${new Date(reportData.generatedAt).toLocaleString()}</p><h2>Risk Details</h2><div class="risk-card"><div class="parameter"><span class="parameter-label">Risk Title:</span><span class="parameter-value">${reportData.riskTitle}</span></div><div class="parameter"><span class="parameter-label">Description:</span><span class="parameter-value">${reportData.riskDescription}</span></div><div class="parameter"><span class="parameter-label">Likelihood:</span><span class="parameter-value">${reportData.likelihood}/5</span></div><div class="parameter"><span class="parameter-label">Impact:</span><span class="parameter-value">${reportData.impact}/5</span></div><div class="parameter"><span class="parameter-label">Risk Score:</span><span class="parameter-value">${reportData.riskScore}</span></div><div class="parameter"><span class="parameter-label">Status:</span><span class="parameter-value">${reportData.status}</span></div><div class="parameter"><span class="parameter-label">Owner:</span><span class="parameter-value">${reportData.owner || 'Unassigned'}</span></div></div><h2>Mitigation Plan</h2><div class="risk-card">${reportData.mitigation || '<em>No mitigation plan defined yet</em>'}</div><h2>Mitigation Discussion</h2><div class="chat-section">${reportData.chatHistory.map(msg => `<div class="message ${msg.role === 'user' ? 'user-message' : 'ai-message'}"><strong>${msg.role === 'user' ? 'You' : 'AI Expert'}:</strong><br>${msg.content.replace(/\n/g, '<br>')}</div>`).join('')}</div><div class="footer"><p>This report was generated by PreShield Risk Assessment Platform</p><p>Report Version: ${new Date().toISOString()}</p></div></body></html>`;

      if (format === 'html') {
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Risk-Report-${riskMitigationChat.title.replace(/\s+/g, '-')}-${Date.now()}.html`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else if (format === 'pdf' || format === 'image') {
        const win = window.open('', '_blank');
        win.document.write(htmlContent);
        win.document.close();
        setTimeout(() => {
          win.print();
        }, 500);
      } else if (format === 'word') {
        const wordHtml = `<html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'><head><meta charset='utf-8'><title>Export</title></head><body>${htmlContent}</body></html>`;
        const blob = new Blob([wordHtml], { type: 'application/msword' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `Risk-Report-${riskMitigationChat.title.replace(/\s+/g, '-')}-${Date.now()}.doc`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      } else if (format === 'ppt') {
        // Proper PPTX export using a library would be better, but for now we'll provide a clear instruction
        // and a better formatted slide deck that users can print to PDF then save as PPTX.
        const pptHtml = buildPPTXHtml({ ...project, risks: [riskMitigationChat] }, t);
        const win = window.open('', '_blank');
        win.document.write(pptHtml);
        win.document.close();
        setTimeout(() => {
          alert('To get a .pptx file: \n1. Press Cmd+P (Mac) or Ctrl+P (Windows) in the new tab\n2. Save as PDF\n3. Open the PDF and "Save as PowerPoint"');
        }, 1000);
      }
    } catch (e) {
      console.error('Export failed:', e);
      alert('Export failed: ' + e.message);
    }
  };

  const closeRiskMitigationChat = () => {
    setRiskMitigationChat(null);
    setRiskChatMessages([]);
    setRiskChatInput("");
  };

  const toggleRiskEdit = (risk, e) => {
    e.stopPropagation();
    if (expandedRisk === risk.id) {
      setExpandedRisk(null);
      setEditDraft(null);
      return;
    }
    setExpandedRisk(risk.id);
    setEditDraft({
      id: risk.id,
      likelihood: String(risk.likelihood ?? 3),
      impact: String(risk.impact ?? 3),
      owner: risk.owner || "",
      status: risk.status || "identified",
    });
  };

  const saveRiskEdit = () => {
    if (!editDraft) return;
    const L = clampLikertInput(editDraft.likelihood);
    const I = clampLikertInput(editDraft.impact);
    updateRisk(editDraft.id, {
      likelihood: L,
      impact: I,
      risk_score: parseFloat((L * I).toFixed(2)),
      owner: editDraft.owner.trim(),
      status: editDraft.status,
    });
    setExpandedRisk(null);
    setEditDraft(null);
  };

  const addComment = (riskId) => {
    const text = commentInputs[riskId]?.trim();
    if (!text) return;
    const risk = risks.find(r => r.id === riskId);
    const newComments = [...(risk.comments || []), { text, time: new Date().toLocaleTimeString() }];
    updateRisk(riskId, { comments: newComments });
    setCommentInputs(c => ({ ...c, [riskId]: "" }));
  };

  if (!risks.length) return (
    <div className="card" style={{ padding: "48px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>🔍</div>
      <div style={{ color: "var(--ps-text-muted)", fontSize: 14 }}>{t.completeInterviewFirst}</div>
    </div>
  );

  const sevPill = (score) => {
    const lv = getRiskLevel(score);
    const base = colorMode === "light"
      ? { critical: { bg: "#FFEBEE", fg: "#C62828", bd: "#E5393533" }, high: { bg: "#FFF3E0", fg: "#F57C00", bd: "#F57C0033" }, medium: { bg: "#FFF4E6", fg: "#EF9F27", bd: "#EF9F2744" }, low: { bg: "#E8F5E9", fg: "#1D9E75", bd: "#1D9E7533" } }
      : { critical: { bg: "#E5393522", fg: "#FF8A80", bd: "#E5393544" }, high: { bg: "#F57C0022", fg: "#FFB74D", bd: "#F57C0044" }, medium: { bg: "#EF9F2722", fg: "#FFE0B3", bd: "#EF9F2744" }, low: { bg: "#1D9E7522", fg: "#81C784", bd: "#1D9E7544" } };
    const s = base[lv];
    return { ...s, label: riskSeverityWord(t, score) };
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
      <div>
        <h3 style={{ fontSize: 18, fontWeight: 700, color: "var(--ps-text)", marginBottom: 6, letterSpacing: "-0.3px" }}>{t.allRisksTitle}</h3>
        <div style={{ fontSize: 13, color: "var(--ps-text-muted)" }}>{risks.length} {t.risks} · {t.overallRisk}: <span style={{ color: getOverallRiskColor(project.overall_risk_score), fontFamily: "'DM Mono', monospace", fontWeight: 600 }}>{riskRank100(project.overall_risk_score)}</span></div>
      </div>
      {sortedRisks.map((risk, idx) => {
        const accent = getRiskColor(risk.risk_score);
        const pill = sevPill(risk.risk_score);
        return (
          <div
            key={risk.id}
            className="risk-card-ref card"
            style={{
              overflow: "hidden",
              border: "1px solid var(--ps-card-border)",
              borderLeft: `5px solid ${accent}`,
              borderRadius: 12,
              padding: "20px 22px 22px",
              background: "var(--ps-card-bg)",
            }}
          >
            <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
              <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 16, color: "var(--ps-text)", lineHeight: 1.35, letterSpacing: "-0.2px" }}>
                  #{idx + 1} {risk.title}
                </div>
              </div>
              <div style={{ display: "flex", alignItems: "flex-start", gap: 20, flexShrink: 0 }}>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "var(--ps-text-muted)", textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 4 }}>{t.likelihood}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ps-text)", fontFamily: "'DM Mono', monospace" }}>{parseFloat(risk.likelihood).toFixed(1)}/5</div>
                </div>
                <div style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: "var(--ps-text-muted)", textTransform: "uppercase", letterSpacing: "0.6px", marginBottom: 4 }}>{t.impact}</div>
                  <div style={{ fontSize: 15, fontWeight: 700, color: "var(--ps-text)", fontFamily: "'DM Mono', monospace" }}>{parseFloat(risk.impact).toFixed(1)}/5</div>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, paddingTop: 2 }}>
                  <button
                    type="button"
                    className="btn-primary"
                    title="Detailed Report"
                    aria-label="Detailed Report"
                    style={{
                      padding: "8px 12px",
                      fontSize: 13,
                      background: "#5B5BFF",
                      color: "#fff",
                      border: "none",
                      borderRadius: 6,
                    }}
                    onClick={(e) => { e.stopPropagation(); startRiskMitigationChat(risk); }}
                  >
                    📋 {t.detailedReport || "Detailed Report"}
                  </button>
                </div>
              </div>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 14, alignItems: "center" }}>
              <span style={{ display: "inline-block", padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 500, background: colorMode === "light" ? "#ECEEF5" : "var(--ps-panel)", color: "var(--ps-text-muted)", border: "1px solid var(--ps-border-subtle)" }}>{formatRiskCategory(risk.category, t)}</span>
              <span style={{ display: "inline-block", padding: "4px 12px", borderRadius: 20, fontSize: 11, fontWeight: 600, background: pill.bg, color: pill.fg, border: `1px solid ${pill.bd}` }}>
                {pill.label} · {t.rank || t.score}: {riskRank100(risk.risk_score)}
              </span>
            </div>
            <p style={{ marginTop: 14, marginBottom: 0, fontSize: 14, lineHeight: 1.65, color: "var(--ps-quote-text)" }}>{risk.description}</p>
            <div style={{ marginTop: 18, padding: "14px 16px", borderRadius: 10, background: colorMode === "light" ? "#FAFAFC" : "var(--ps-panel)", border: "1px solid var(--ps-border-subtle)" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, fontSize: 13, fontWeight: 600, color: mitBlue }}>
                <span style={{ fontSize: 18, lineHeight: 1 }} aria-hidden>🛡</span>
                {t.mitigationPlanHeader}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.65, color: "var(--ps-quote-text)", whiteSpace: "pre-wrap" }}>{mitigationToDetailedSteps(risk.mitigation)}</div>
            </div>
            {expandedRisk === risk.id && editDraft?.id === risk.id && (
              <div style={{ borderTop: "1px solid var(--ps-border-subtle)", marginTop: 18, paddingTop: 18, display: "flex", flexDirection: "column", gap: 14 }}>
                <div className="risk-inputs" style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--ps-text-muted)", display: "block", marginBottom: 4 }}>{t.likelihood}</label>
                    <select value={editDraft.likelihood} onChange={e => setEditDraft(d => d ? { ...d, likelihood: e.target.value } : d)}>
                      {[1, 2, 3, 4, 5].map(v => <option key={v} value={String(v)}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--ps-text-muted)", display: "block", marginBottom: 4 }}>{t.impact}</label>
                    <select value={editDraft.impact} onChange={e => setEditDraft(d => d ? { ...d, impact: e.target.value } : d)}>
                      {[1, 2, 3, 4, 5].map(v => <option key={v} value={String(v)}>{v}</option>)}
                    </select>
                  </div>
                  <div>
                    <label style={{ fontSize: 11, color: "var(--ps-text-muted)", display: "block", marginBottom: 4 }}>{t.owner}</label>
                    <input value={editDraft.owner} onChange={e => setEditDraft(d => d ? { ...d, owner: e.target.value } : d)} placeholder={t.assignOwner} />
                  </div>
                </div>
                <div>
                  <label style={{ fontSize: 11, color: "var(--ps-text-muted)", display: "block", marginBottom: 4 }}>{t.status}</label>
                  <select value={editDraft.status} onChange={e => setEditDraft(d => d ? { ...d, status: e.target.value } : d)} style={{ width: "auto" }}>
                    <option value="identified">{t.statusIdentified}</option>
                    <option value="mitigating">{t.statusMitigating}</option>
                    <option value="accepted">{t.statusAccepted}</option>
                    <option value="resolved">{t.statusResolved}</option>
                  </select>
                </div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", marginTop: 4 }}>
                  <button type="button" className="btn-primary" style={{ padding: "8px 18px", fontSize: 13 }} onClick={saveRiskEdit}>{t.saveChanges}</button>
                  <button type="button" className="btn-ghost" style={{ padding: "8px 16px", fontSize: 13 }} onClick={() => { setExpandedRisk(null); setEditDraft(null); }}>{t.cancel}</button>
                </div>
                {(risk.comments || []).length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ fontSize: 11, color: "var(--ps-text-muted)", textTransform: "uppercase", letterSpacing: "0.5px" }}>{t.comments}</div>
                    {risk.comments.map((c, i) => (
                      <div key={i} style={{ fontSize: 13, color: "var(--ps-quote-text)", padding: "8px 12px", background: "var(--ps-panel)", borderRadius: 6, borderLeft: "2px solid #5B5BFF" }}>
                        {c.text} <span style={{ color: "var(--ps-text-muted)", fontSize: 11 }}>· {c.time}</span>
                      </div>
                    ))}
                  </div>
                )}
                <div style={{ display: "flex", gap: 8 }}>
                  <input value={commentInputs[risk.id] || ""} onChange={e => setCommentInputs(c => ({ ...c, [risk.id]: e.target.value }))} placeholder={t.addComment} onKeyDown={e => e.key === "Enter" && addComment(risk.id)} />
                  <button className="btn-ghost" style={{ flexShrink: 0 }} type="button" onClick={() => addComment(risk.id)}>+</button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      
      {riskMitigationChat && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}>
          <div className="card fade-in" style={{ padding: 24, maxWidth: 600, width: "90%", margin: 16, maxHeight: "80vh", display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>📋 Risk Mitigation</div>
              <button type="button" className="btn-ghost" onClick={closeRiskMitigationChat} style={{ padding: "4px 8px" }}>✕</button>
            </div>
            <div style={{ fontSize: 13, color: "var(--ps-text-muted)", marginBottom: 12 }}><strong>{riskMitigationChat.title}</strong></div>
            <div style={{ flex: 1, overflowY: "auto", marginBottom: 16, display: "flex", flexDirection: "column", gap: 12, padding: "8px 0" }}>
              {riskChatMessages.map((msg, i) => (
                <div key={i} style={{ display: "flex", justifyContent: msg.role === "user" ? "flex-end" : "flex-start" }}>
                  <div style={{
                    maxWidth: "80%",
                    padding: "12px 16px",
                    borderRadius: msg.role === "user" ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
                    background: msg.role === "user" ? "#5B5BFF" : "var(--ps-chat-ai-bg)",
                    border: msg.role === "ai" ? "1px solid var(--ps-border-subtle)" : "none",
                    fontSize: 13,
                    lineHeight: 1.6,
                    color: msg.role === "user" ? "#fff" : "var(--ps-text)",
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word"
                  }}>
                    {msg.content}
                  </div>
                </div>
              ))}
              {riskChatLoading && <div style={{ fontSize: 12, color: "var(--ps-text-muted)", fontStyle: "italic" }}>Thinking...</div>}
            </div>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input
                type="text"
                placeholder="Type your response..."
                value={riskChatInput}
                onChange={e => setRiskChatInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !riskChatLoading && riskChatInput.trim()) {
                    sendRiskChatMessage(riskChatInput);
                    setRiskChatInput("");
                  }
                }}
                style={{ flex: 1 }}
                disabled={riskChatLoading}
              />
              <button className="btn-primary" onClick={() => {
                if (riskChatInput.trim()) {
                  sendRiskChatMessage(riskChatInput);
                  setRiskChatInput("");
                }
              }} disabled={riskChatLoading || !riskChatInput.trim()}>
                Send
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <select onChange={(e) => { if (e.target.value) exportRiskReport(e.target.value); e.target.value = ''; }} style={{ padding: "8px 12px", fontSize: 12, borderRadius: 6, border: "1px solid var(--ps-border-subtle)", background: "var(--ps-card-bg)", color: "var(--ps-text)" }}>
                <option value="">📥 Export as...</option>
                <option value="html">HTML</option>
                <option value="pdf">PDF</option>
                <option value="word">Word (.docx)</option>
                <option value="ppt">PowerPoint</option>
                <option value="image">Image (PNG/JPEG)</option>
              </select>
              <button className="btn-ghost" onClick={closeRiskMitigationChat} style={{ fontSize: 12, padding: "8px 12px" }}>
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function clampMatrixMarkerCenter(cx, cy, radius, padLeft, padTop, innerW, innerH, inset = 3) {
  const minX = padLeft + radius + inset;
  const maxX = padLeft + innerW - radius - inset;
  const minY = padTop + radius + inset;
  const maxY = padTop + innerH - radius - inset;
  return {
    cx: Math.min(maxX, Math.max(minX, cx)),
    cy: Math.min(maxY, Math.max(minY, cy)),
  };
}

function matrixZoneFill(impactCell, likelihoodCell, dark) {
  const p = (impactCell * likelihoodCell) / 25;
  if (dark) {
    if (p < 0.12) return "rgba(76, 175, 80, 0.14)";
    if (p < 0.28) return "rgba(239, 159, 39, 0.16)";
    if (p < 0.5) return "rgba(245, 124, 0, 0.18)";
    return "rgba(229, 57, 53, 0.2)";
  }
  if (p < 0.12) return "#E8F5E9";
  if (p < 0.28) return "#FFE9B5";
  if (p < 0.5) return "#FFE0B2";
  return "#FFEBEE";
}

function MatrixView({ t, project, colorMode }) {
  const [tooltip, setTooltip] = useState(null);
  const risks = project.risks || [];
  const dark = colorMode === "dark";
  const sortedRisks = [...risks].sort((a, b) => b.risk_score - a.risk_score);

  if (!risks.length) return (
    <div className="card" style={{ padding: "48px 24px", textAlign: "center" }}>
      <div style={{ fontSize: 32, marginBottom: 12 }}>📊</div>
      <div style={{ color: "var(--ps-text-muted)", fontSize: 14 }}>{t.completeInterviewMatrix}</div>
    </div>
  );

  const isPartial = project.status === "interviewing" && risks.length > 0;

  const PLOT_W = 720;
  const PLOT_H = 480;
  const PAD_LEFT = 52;
  const PAD_TOP = 58;
  const PAD_RIGHT = 40;
  const PAD_BOTTOM = 44;
  const innerW = PLOT_W - PAD_LEFT - PAD_RIGHT;
  const innerH = PLOT_H - PAD_TOP - PAD_BOTTOM;
  const cellW = innerW / 5;
  const cellH = innerH / 5;
  const cellInset = 1.5;
  const cellRx = 10;
  const strokeCell = dark ? "rgba(255,255,255,0.09)" : "rgba(0,0,0,0.07)";

  const toX = (impact) => PAD_LEFT + ((parseFloat(impact) - 1) / 4) * innerW;
  const toY = (likelihood) => PAD_TOP + ((5 - parseFloat(likelihood)) / 4) * innerH;

  const axisTick = "var(--ps-text-muted)";
  const legend = [
    ["low", "#1D9E75", t.low],
    ["medium", "#EF9F27", t.medium],
    ["high", "#F57C00", t.high],
    ["critical", "#E53935", t.critical],
  ];

  return (
    <div>
      {isPartial && (
        <div style={{ marginBottom: 16, padding: "8px 14px", background: "#EF9F2712", border: "1px solid #EF9F2733", borderRadius: 8, fontSize: 12, color: "#EF9F27" }}>
          ⚠️ Interview in progress — matrix shows partial results so far.
        </div>
      )}
      <div className="card" style={{ padding: "22px 24px 26px", border: "1px solid var(--ps-card-border)" }}>
        <div style={{ fontWeight: 700, fontSize: 18, color: "var(--ps-text)", letterSpacing: "-0.3px", marginBottom: 6 }}>{t.riskMatrix}</div>
        <div style={{ fontSize: 13, color: "var(--ps-text-muted)", lineHeight: 1.5, maxWidth: 640, marginBottom: 20 }}>{t.matrixExplainer}</div>
        <div style={{ display: "flex", gap: 20, marginBottom: 22, alignItems: "center", flexWrap: "wrap" }} className="legend-wrap">
          <div>
            <div style={{ fontSize: 11, color: "var(--ps-text-muted)", marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.5px" }}>{t.overallRisk}</div>
            <div style={{ fontSize: 28, fontWeight: 600, fontFamily: "'DM Mono', monospace", color: getOverallRiskColor(project.overall_risk_score) }}>{parseFloat(project.overall_risk_score).toFixed(1)}</div>
          </div>
          <div style={{ display: "flex", gap: 14, marginLeft: "auto", flexWrap: "wrap", alignItems: "center" }}>
            {legend.map(([k, c, l]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: "var(--ps-text-muted)" }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: c }} />
                {l} <span style={{ fontFamily: "'DM Mono', monospace", color: c }}>({risks.filter(r => getRiskLevel(r.risk_score) === k).length})</span>
              </div>
            ))}
          </div>
        </div>

        <div className="matrix-wrap" style={{ position: "relative", width: "100%", maxWidth: 820 }}>
          <svg width="100%" viewBox={`0 0 ${PLOT_W} ${PLOT_H}`} style={{ display: "block" }} preserveAspectRatio="xMidYMid meet">
            <defs>
              <filter id="psMatrixDotShadow" x="-50%" y="-50%" width="200%" height="200%">
                <feDropShadow dx="0" dy="1.5" stdDeviation="2" floodOpacity="0.2" />
              </filter>
              <clipPath id="psMatrixPlotClip">
                <rect x={PAD_LEFT} y={PAD_TOP} width={innerW} height={innerH} rx={12} ry={12} />
              </clipPath>
            </defs>

            <text x={PAD_LEFT + innerW / 2} y={22} textAnchor="middle" fontSize="12" fontWeight="600" fill="var(--ps-text)">{t.impactAxisShort}</text>
            {[1, 2, 3, 4, 5].map((v) => (
              <text key={`itop-${v}`} x={toX(v)} y={PAD_TOP - 10} textAnchor="middle" fontSize="11" fill={axisTick}>{v}</text>
            ))}
            <text x={18} y={PAD_TOP + innerH / 2} textAnchor="middle" fontSize="11" fill={axisTick} transform={`rotate(-90, 18, ${PAD_TOP + innerH / 2})`}>{t.likelihood}</text>
            {[1, 2, 3, 4, 5].map((v) => (
              <text key={`ileft-${v}`} x={PAD_LEFT - 12} y={toY(v) + 4} textAnchor="end" fontSize="11" fill={axisTick}>{v}</text>
            ))}

            {[1, 2, 3, 4, 5].map((L) =>
              [1, 2, 3, 4, 5].map((I) => {
                const x0 = PAD_LEFT + (I - 1) * cellW;
                const y0 = PAD_TOP + (5 - L) * cellH;
                return (
                  <rect
                    key={`c${L}-${I}`}
                    x={x0 + cellInset}
                    y={y0 + cellInset}
                    width={cellW - 2 * cellInset}
                    height={cellH - 2 * cellInset}
                    rx={cellRx}
                    ry={cellRx}
                    fill={matrixZoneFill(I, L, dark)}
                    stroke={strokeCell}
                    strokeWidth={1}
                  />
                );
              })
            )}

            <rect x={PAD_LEFT} y={PAD_TOP} width={innerW} height={innerH} fill="none" stroke="var(--ps-border-subtle)" strokeWidth="1.2" rx={12} />

            <g clipPath="url(#psMatrixPlotClip)">
              {sortedRisks.map((r, idx) => {
                const cxRaw = toX(r.impact ?? 3);
                const cyRaw = toY(r.likelihood ?? 3);
                const radius = 17;
                const { cx, cy } = clampMatrixMarkerCenter(cxRaw, cyRaw, radius, PAD_LEFT, PAD_TOP, innerW, innerH, 3);
                const color = getRiskColor(r.risk_score);
                const txt = getRiskMarkerTextColor(r.risk_score);
                const num = idx + 1;
                const rating = riskRank100(r.risk_score);
                return (
                  <g
                    key={r.id}
                    onMouseEnter={() => setTooltip({ r, cx, cy, num })}
                    onMouseLeave={() => setTooltip(null)}
                    style={{ cursor: "pointer" }}
                  >
                    <circle cx={cx} cy={cy} r={radius} fill={color} filter="url(#psMatrixDotShadow)" />
                    <text x={cx} y={cy - 3} textAnchor="middle" fontSize="9" fill={txt} fontWeight="800" style={{ pointerEvents: "none" }}>#{num}</text>
                    <text x={cx} y={cy + 8} textAnchor="middle" fontSize="8" fill={txt} fontWeight="700" opacity="0.95" style={{ pointerEvents: "none" }}>{rating}</text>
                  </g>
                );
              })}
            </g>
          </svg>

          {tooltip && (
            <div style={{ position: "absolute", left: `clamp(10px, ${(tooltip.cx / PLOT_W) * 100}%, calc(100% - 200px))`, top: `clamp(10px, calc(${(tooltip.cy / PLOT_H) * 100}% - 88px), calc(100% - 88px))`, background: "var(--ps-card-bg)", border: `1px solid ${getRiskColor(tooltip.r.risk_score)}66`, borderRadius: 10, padding: "10px 14px", fontSize: 12, maxWidth: 220, zIndex: 10, pointerEvents: "none", boxShadow: "0 6px 24px rgba(0,0,0,.12)" }}>
              <div style={{ fontWeight: 600, color: "var(--ps-text)", marginBottom: 4 }}>#{tooltip.num} {tooltip.r.title}</div>
              <div style={{ color: "var(--ps-text-muted)", fontSize: 11, marginBottom: 2 }}>{t.likelihood}: <span style={{ color: "var(--ps-text)" }}>{parseFloat(tooltip.r.likelihood).toFixed(1)}</span> · {t.impact}: <span style={{ color: "var(--ps-text)" }}>{parseFloat(tooltip.r.impact).toFixed(1)}</span></div>
              <div style={{ fontFamily: "'DM Mono', monospace", fontSize: 12, color: getRiskColor(tooltip.r.risk_score), fontWeight: 600 }}>{t.rank || t.score}: {riskRank100(tooltip.r.risk_score)}</div>
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 24 }}>
        <div className="heatmap-title" style={{ fontSize: 11, color: "var(--ps-text-muted)", marginBottom: 12, textTransform: "uppercase", letterSpacing: "0.5px" }}>{t.riskHeatmap}</div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {sortedRisks.map((r, idx) => (
            <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <div style={{ width: 24, height: 24, borderRadius: "50%", background: getRiskColor(r.risk_score), display: "flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 700, color: getRiskMarkerTextColor(r.risk_score), flexShrink: 0, boxShadow: "0 2px 6px rgba(0,0,0,.12)" }}>
                {idx + 1}
              </div>
              <div style={{ fontSize: 12, color: "var(--ps-quote-text)", minWidth: 0, flex: "0 1 240px", maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.title}</div>
              <div style={{ flex: 1, height: 8, background: "var(--ps-matrix-track)", borderRadius: 4, overflow: "hidden" }}>
                <div style={{ width: `${riskRank100(r.risk_score)}%`, height: "100%", background: getRiskColor(r.risk_score), borderRadius: 4, transition: "width 0.6s ease" }} />
              </div>
              <div style={{ fontSize: 12, fontFamily: "'DM Mono', monospace", color: getRiskColor(r.risk_score), width: 40, textAlign: "right", flexShrink: 0 }}>{riskRank100(r.risk_score)}</div>
            </div>
          ))}
        </div>
      </div>


    </div>
  );
}

function ProjectChatView({ t, project, onUpdate }) {
  const [input, setInput] = useState("");
  const listRef = useRef(null);
  const teamMessages = (project.messages || []).filter((m) => m?.channel === "team");

  const currentUser = (() => {
    try {
      const stored = localStorage.getItem("ps_session") || sessionStorage.getItem("ps_session");
      const parsed = stored ? JSON.parse(stored) : null;
      const user = parsed?.user || {};
      const display = user?.user_metadata?.business_name || user?.email || "You";
      return String(display);
    } catch {
      return "You";
    }
  })();

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [teamMessages.length]);

  const sendTeamMessage = () => {
    const text = input.trim();
    if (!text) return;
    const next = [
      ...(project.messages || []),
      {
        id: `team-${Date.now()}`,
        channel: "team",
        role: "team",
        author: currentUser,
        content: text,
        timestamp: new Date().toISOString(),
      },
    ];
    onUpdate({ ...project, messages: next });
    setInput("");
  };

  return (
    <div className="card" style={{ padding: "16px 16px 12px", border: "1px solid var(--ps-card-border)" }}>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{t.projectChatTitle || "Project Team Chat"}</div>
      <div style={{ fontSize: 12, color: "var(--ps-text-muted)", marginBottom: 12 }}>
        {t.projectChatHint || "Use this space to coordinate tasks, blockers, and updates for this project."}
      </div>
      <div ref={listRef} style={{ maxHeight: 360, overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 2 }}>
        {teamMessages.length === 0 ? (
          <div style={{ fontSize: 13, color: "var(--ps-text-muted)", textAlign: "center", padding: "24px 10px" }}>
            {t.noProjectChatYet || "No messages yet. Start the project conversation."}
          </div>
        ) : (
          teamMessages.map((m) => {
            const mine = m.author === currentUser;
            return (
              <div key={m.id || `${m.timestamp}-${m.author}`} style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start" }}>
                <div style={{ maxWidth: "78%", background: mine ? "#5B5BFF" : "var(--ps-panel)", color: mine ? "#fff" : "var(--ps-text)", border: mine ? "1px solid #5B5BFF" : "1px solid var(--ps-border-subtle)", borderRadius: 12, padding: "10px 12px", lineHeight: 1.45 }}>
                  <div style={{ fontSize: 11, opacity: mine ? 0.9 : 0.7, marginBottom: 4 }}>{m.author || "Member"}</div>
                  <div style={{ fontSize: 13, whiteSpace: "pre-wrap" }}>{m.content}</div>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendTeamMessage()}
          placeholder={t.chatPlaceholder || "Write a message to your team..."}
        />
        <button className="btn-primary" style={{ minWidth: 80 }} onClick={sendTeamMessage}>
          {t.send}
        </button>
      </div>
    </div>
  );
}

function TeamView({ t, project, onUpdate }) {
  const [email, setEmail] = useState("");
  const [members, setMembers] = useState([]);
  const [invites, setInvites] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generatingLink, setGeneratingLink] = useState(false);
  const [inviteLink, setInviteLink] = useState(null);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviting, setInviting] = useState(false);
  const [emailSubjectDraft, setEmailSubjectDraft] = useState("");
  const [emailBodyDraft, setEmailBodyDraft] = useState("");
  const [emailSubjectSaved, setEmailSubjectSaved] = useState("");
  const [emailBodySaved, setEmailBodySaved] = useState("");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(null);

  // Used for the preview + optional columns (if your DB trigger supports them).
  const userMeta = (() => {
    try {
      const stored = localStorage.getItem("ps_session") || sessionStorage.getItem("ps_session");
      if (!stored) return {};
      const parsed = JSON.parse(stored);
      return parsed?.user?.user_metadata || {};
    } catch {
      return {};
    }
  })();
  const userBusinessName = userMeta?.business_name || "";
  const userBusinessLocation = userMeta?.business_location || "";

  useEffect(() => {
    if (!showInviteDialog) return;
    const businessLine = userBusinessName
      ? `${userBusinessName} has invited you to collaborate on "${project.name}" on PreShield.`
      : `You have been invited to collaborate on "${project.name}" on PreShield.`;
    const subject = `You're invited to "${project.name}" on PreShield`;
    const body = `Hi,\n\n${businessLine}\n\nClick here to join:\n{{joinUrl}}\n`;
    setEmailSubjectDraft(subject);
    setEmailBodyDraft(body);
    setEmailSubjectSaved(subject);
    setEmailBodySaved(body);
  }, [showInviteDialog, project.name, userBusinessName, userBusinessLocation]);

  const load = async () => {
    setLoading(true);
    try {
      const [m, i] = await Promise.all([sb.getMembers(project.id), sb.getInvites(project.id)]);
      setMembers(Array.isArray(m) ? m : []);
      // Filter out link-invite placeholder entries from display
      setInvites((Array.isArray(i) ? i : []).filter(inv => !inv.email.startsWith("link-invite-")));
    } catch {
      setError("Failed to load team data.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [project.id]);

  const generateLink = async () => {
    setGeneratingLink(true);
    setError(null);
    try {
      const invite = await sb.createInviteLink(project.id, project.name);
      const baseUrl = window.location.href.split("?")[0];
      const link = `${baseUrl}?invite=${invite.invite_token}`;
      setInviteLink(link);
    } catch {
      setError("Failed to generate link. Try again.");
    } finally {
      setGeneratingLink(false);
    }
  };

  const copyLink = () => {
    navigator.clipboard.writeText(inviteLink);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const removeMember = async (id) => {
    try { await sb.removeMember(id); await load(); }
    catch { setError("Failed to remove member."); }
  };

  const cancelInvite = async (id) => {
    try { await sb.cancelInvite(id); await load(); }
    catch { setError("Failed to cancel invite."); }
  };

  const submitInviteByEmail = async () => {
    const trimmed = inviteEmail.trim().toLowerCase();
    if (!trimmed) return;
    setInviting(true);
    setError(null);
    try {
      await sb.createInviteByEmail(
        project.id,
        project.name,
        trimmed,
        { business_name: userBusinessName, business_location: userBusinessLocation }
        ,
        emailSubjectDraft,
        emailBodyDraft
      );
      setShowInviteDialog(false);
      setInviteEmail("");
      await load();
    } catch (e) {
      setError(e?.message || "Failed to send invite. Try again.");
    } finally {
      setInviting(false);
    }
  };

  return (
    <div style={{ maxWidth: 500 }}>
      {/* Invite link generator */}
      <div className="card" style={{ padding: "18px 20px", marginBottom: 16 }}>
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>{t.inviteTeam}</div>
        <div style={{ fontSize: 12, color: "var(--ps-text-muted)", marginBottom: 14 }}>{t.shareableLinkIntro || "Generate a shareable link — send it via WhatsApp, Slack, or email. Anyone with the link can join."}</div>

        {!inviteLink ? (
          <button className="btn-primary" style={{ width: "100%", padding: "10px" }} onClick={generateLink} disabled={generatingLink}>
            {generatingLink ? (t.generatingInviteLink || "Generating...") : (t.generateInviteLink || "🔗 Generate Invite Link")}
          </button>
        ) : (
          <div>
            <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
              <input value={inviteLink} readOnly style={{ fontSize: 11, color: "var(--ps-text-muted)", background: "var(--ps-panel)" }} onClick={e => e.target.select()} />
              <button className="btn-primary" style={{ flexShrink: 0, minWidth: 70 }} onClick={copyLink}>
                {copied ? (t.copiedLabel || "✓ Copied") : (t.copyLabel || "Copy")}
              </button>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {[
                { label: "WhatsApp", color: "#25D366", url: `https://wa.me/?text=${encodeURIComponent(`You've been invited to join "${project.name}" on PreShield 🛡️\n\nClick to join: ${inviteLink}`)}` },
                { label: "Telegram", color: "#2AABEE", url: `https://t.me/share/url?url=${encodeURIComponent(inviteLink)}&text=${encodeURIComponent(`Join "${project.name}" on PreShield`)}` },
              ].map(s => (
                <a key={s.label} href={s.url} target="_blank" rel="noopener noreferrer" style={{ display: "inline-block", padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500, background: s.color + "22", color: s.color, border: `1px solid ${s.color}44`, textDecoration: "none" }}>
                  {s.label}
                </a>
              ))}
              <button
                type="button"
                className="btn-ghost"
                style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: "5px 12px", borderRadius: 6, fontSize: 12, fontWeight: 700, background: "#9999FF22", color: "#9999FF", border: "1px solid #9999FF44" }}
                onClick={() => { setError(null); setInviteEmail(""); setShowInviteDialog(true); }}
                disabled={loading || generatingLink}
              >
                ✉️ {t.inviteByEmailButton || "Invite by email"}
              </button>
              <button className="btn-ghost" style={{ fontSize: 12, padding: "5px 12px" }} onClick={() => setInviteLink(null)}>{t.newLink || "New link"}</button>
            </div>
          </div>
        )}
        {error && <div style={{ fontSize: 12, color: "#E24B4A", marginTop: 8 }}>{error}</div>}
      </div>

      {showInviteDialog && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.7)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 999 }}>
          <div className="card fade-in" style={{ padding: 26, maxWidth: 460, width: "90%", margin: 16 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>{t.inviteByEmailTitle || "Invite by Email"}</div>
            </div>
            <div style={{ fontSize: 13, color: "var(--ps-text-muted)", marginBottom: 12, lineHeight: 1.5 }}>
              {t.inviteEmailIntro || "We will send an invite email to the address below (using your app’s no-reply sender). The email includes your business name and the project name."}
            </div>
            <div style={{ marginBottom: 14 }}>
              <label style={{ fontSize: 12, color: "var(--ps-text-muted)", display: "block", marginBottom: 6 }}>{t.teammateEmailLabel || "Teammate email"}</label>
              <input
                type="email"
                value={inviteEmail}
                onChange={e => setInviteEmail(e.target.value)}
                placeholder={t.emailPlaceholder || "teammate@company.com"}
                onKeyDown={e => e.key === "Enter" && !inviting && submitInviteByEmail()}
              />
            </div>
            <div style={{ marginBottom: 12, padding: "10px 12px", borderRadius: 10, background: "var(--ps-panel)", border: "1px solid var(--ps-border-subtle)" }}>
              <div style={{ fontSize: 12, color: "var(--ps-text-muted)", marginBottom: 6, textTransform: "uppercase", letterSpacing: "0.5px" }}>{t.emailPreviewTitle || "Email Preview"}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div>
                  <label style={{ fontSize: 12, color: "var(--ps-text-muted)", display: "block", marginBottom: 6 }}>{t.subjectLabel || "Subject"}</label>
                  <input
                    value={emailSubjectDraft}
                    onChange={e => setEmailSubjectDraft(e.target.value)}
                    placeholder={emailSubjectSaved}
                  />
                </div>
                <div>
                  <label style={{ fontSize: 12, color: "var(--ps-text-muted)", display: "block", marginBottom: 6 }}>{t.messageLabel || "Message"}</label>
                  <textarea
                    value={emailBodyDraft}
                    onChange={e => setEmailBodyDraft(e.target.value)}
                    rows={6}
                    style={{ resize: "vertical" }}
                    placeholder={emailBodySaved}
                  />
                  <div style={{ fontSize: 11, color: "var(--ps-text-muted)", marginTop: 6 }}>
                    {(t.inviteTipJoinUrlPrefix || "Tip: the join link will be inserted where you write").trim()}{" "}
                    <code style={{ fontFamily: "'DM Mono', monospace" }}>{"{{joinUrl}}"}</code>.
                  </div>
                </div>
              </div>
            </div>

            {error && <div style={{ fontSize: 12, color: "#E24B4A", marginBottom: 10 }}>{error}</div>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button
                className="btn-ghost"
                style={{ padding: "10px 14px" }}
                onClick={() => {
                  setEmailSubjectDraft(emailSubjectSaved);
                  setEmailBodyDraft(emailBodySaved);
                  setShowInviteDialog(false);
                }}
                disabled={inviting}
              >
                {t.cancel}
              </button>
              <button
                className="btn-primary"
                style={{ padding: "10px 14px" }}
                onClick={() => submitInviteByEmail()}
                disabled={inviting || !inviteEmail.trim()}
              >
                {inviting ? (t.sending || "Sending...") : (t.sendInvite || "Send invite")}
              </button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <div style={{ textAlign: "center", padding: "24px 0", color: "var(--ps-text-muted)", fontSize: 13 }}>Loading...</div>
      ) : (
        <>
          {members.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: "var(--ps-text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>{t.teamMembers} ({members.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {members.map(m => (
                  <div key={m.id} className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#1D9E7533", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, color: "#1D9E75", flexShrink: 0 }}>
                      {m.email[0].toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "#E8E6E0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.email}</div>
                      <div style={{ fontSize: 11, color: "var(--ps-text-muted)" }}>{t.member} · {new Date(m.joined_at).toLocaleDateString()}</div>
                    </div>
                    <button
                      className="btn-ghost"
                      style={{ fontSize: 14, padding: "8px 12px", minWidth: 44, borderRadius: 10, color: "#E53935" }}
                      onClick={() => removeMember(m.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {invites.length > 0 && (
            <div>
              <div style={{ fontSize: 11, color: "var(--ps-text-muted)", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: 8 }}>Pending ({invites.length})</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {invites.map(inv => (
                  <div key={inv.id} className="card" style={{ padding: "12px 16px", display: "flex", alignItems: "center", gap: 12, opacity: 0.8 }}>
                    <div style={{ width: 32, height: 32, borderRadius: "50%", background: "#EF9F2722", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13, fontWeight: 600, color: "#EF9F27", flexShrink: 0 }}>
                      {inv.email[0].toUpperCase()}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13, color: "#E8E6E0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{inv.email}</div>
                      <div style={{ fontSize: 11, color: "#EF9F27" }}>⏳ Pending · {new Date(inv.invited_at).toLocaleDateString()}</div>
                    </div>
                    <button
                      className="btn-ghost"
                      style={{ fontSize: 14, padding: "8px 12px", minWidth: 44, borderRadius: 10, color: "#E53935" }}
                      onClick={() => cancelInvite(inv.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {members.length === 0 && invites.length === 0 && (
            <div style={{ textAlign: "center", padding: "32px 0", color: "var(--ps-text-muted)", fontSize: 14 }}>{t.noTeamMembers}</div>
          )}
        </>
      )}
    </div>
  );
}
