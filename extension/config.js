// Public client config only. Never put GEMINI_API_KEY or OAuth client secret here.
export const SUPABASE_URL = "https://jrrclxiqiohdcyiqlzwt.supabase.co";
// Legacy anon JWT — required for Auth + Edge Function verify_jwt from the extension.
export const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpycmNseGlxaW9oZGN5aXFsend0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5NDYyMjQsImV4cCI6MjEwOTUyMjIyNH0.X-uVtJ-XuPSfzXkxEh-k1pd5RkRaXpU97GTNpRrCtdg";

// Google Cloud → OAuth client (type: Web application) Client ID.
// Redirect URI must be: https://kcdlckibjellpjeoalndnabcnbhipcac.chromiumapp.org
export const GOOGLE_OAUTH_CLIENT_ID =
  "49884573668-8nisn4810nq9hipmkahosf5voh5lkc81.apps.googleusercontent.com";

export const LEVELS = ["A1", "A2", "B1", "B2", "C1", "C2"];
export const DAILY_PARAGRAPH_HINT = 200;
export const ANNOTATE_BATCH_SIZE = 6;
