/* Reflect Route Planner — configuration

   The publishable key is safe to sit in client code: it carries no
   privileges of its own. Row Level Security on the database is what
   actually decides who can read or write what, and every policy here
   keys off auth.uid(). An unauthenticated request with this key gets
   nothing back.

   Project: reflect-routing-app (separate from the CRM by design — the
   planner ingests spreadsheets and third-party page content, which is
   not something that belongs next to orders and Shopify tokens). */
window.RP_CONFIG = {
  SUPABASE_URL: 'https://hnuyelzryztlmjdeicje.supabase.co',
  SUPABASE_KEY: 'sb_publishable_Oz-oQmTZP0_R6Q3AlgxkkQ_3qqLcSfm',

  /* Server-side reader. Needed for anything a browser cannot reach
     directly - the Prollenium locator answers only a cross-origin POST. */
  FETCH_FN: 'https://hnuyelzryztlmjdeicje.supabase.co/functions/v1/fetch-accounts'
};
