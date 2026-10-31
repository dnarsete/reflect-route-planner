/* Reflect Route Planner — sign-in

   Passwordless: the rep types their work email and gets a one-time link.
   Accounts are provisioned ahead of time (signup is off on the project),
   so shouldCreateUser is false — an unknown address never creates a user.

   Exposes:
     window.RP_DB          supabase client, once configured
     window.RP_AUTH.user   the signed-in user, or null
     window.RP_AUTH.ready(fn)  runs fn(user) as soon as auth settles */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };

  var cfg = window.RP_CONFIG || {};
  var client = null;
  var settled = false;
  var waiting = [];

  var AUTH = window.RP_AUTH = {
    user: null,
    ready: function (fn) {
      if (settled) fn(AUTH.user); else waiting.push(fn);
    }
  };

  function settle(user) {
    AUTH.user = user || null;
    settled = true;
    var list = waiting.slice();
    waiting.length = 0;
    list.forEach(function (fn) {
      try { fn(AUTH.user); } catch (e) { /* a listener must not break sign-in */ }
    });
  }

  function msg(text, kind) {
    var el = $('authMsg');
    if (!el) return;
    el.textContent = text || '';
    el.className = 'auth-msg' + (kind ? ' ' + kind : '');
  }

  function showGate(show) {
    var gate = $('authGate');
    var app = document.querySelector('.app');
    if (gate) gate.classList.toggle('hide', !show);
    if (app) app.classList.toggle('hide', show);
    document.body.classList.toggle('gated', show);
  }

  function signedIn(user) {
    showGate(false);
    var who = $('authWho');
    if (who) who.textContent = user.email || '';
    settle(user);
  }

  function signedOut() {
    showGate(true);
    settle(null);
  }

  /* The link Supabase sends has to come back to this exact page. Strip any
     query or hash so the redirect target matches what's allow-listed. */
  function redirectTarget() {
    return location.origin + location.pathname;
  }

  function send(e) {
    if (e) e.preventDefault();
    var input = $('authEmail');
    var btn = $('authBtn');
    if (!input || !client) return;

    var email = (input.value || '').trim().toLowerCase();
    if (!email || email.indexOf('@') < 1) { msg('Enter your email address.', 'err'); return; }

    btn.disabled = true;
    msg('Sending…');

    client.auth.signInWithOtp({
      email: email,
      options: { shouldCreateUser: false, emailRedirectTo: redirectTarget() }
    }).then(function (res) {
      btn.disabled = false;
      if (res.error) {
        var m = (res.error.message || '').toLowerCase();
        if (m.indexOf('signups not allowed') >= 0 || m.indexOf('not found') >= 0) {
          msg('That address is not set up for this app yet.', 'err');
        } else {
          msg(res.error.message || 'Could not send the link.', 'err');
        }
        return;
      }
      msg('Check your email — the link is on its way. Open it in this same browser.', 'ok');
    }).catch(function () {
      btn.disabled = false;
      msg('Could not reach the server. Check your connection.', 'err');
    });
  }

  function signOut() {
    if (!client) return;
    client.auth.signOut().then(function () { location.reload(); });
  }

  function boot() {
    var form = $('authForm');
    if (form) form.addEventListener('submit', send);
    var out = $('btnSignOut');
    if (out) out.addEventListener('click', signOut);

    if (!cfg.SUPABASE_URL || !cfg.SUPABASE_KEY) {
      showGate(true);
      msg('App is not configured yet.', 'err');
      settle(null);
      return;
    }
    if (!window.supabase || !window.supabase.createClient) {
      showGate(true);
      msg('Sign-in library failed to load. Reload the page.', 'err');
      settle(null);
      return;
    }

    client = window.RP_DB = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_KEY);

    /* Fires on first load and again when the magic link lands. */
    client.auth.onAuthStateChange(function (_evt, session) {
      if (session && session.user) signedIn(session.user);
      else if (settled) signedOut();
    });

    client.auth.getSession().then(function (res) {
      var session = res && res.data ? res.data.session : null;
      if (session && session.user) signedIn(session.user);
      else signedOut();
    }).catch(function () { signedOut(); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
