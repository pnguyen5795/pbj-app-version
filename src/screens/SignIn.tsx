import { useState } from "react";
import type { FormEvent } from "react";
import { useSignIn, useSignUp } from "@clerk/clerk-react";
import { BackButton } from "../components/BackButton";
import { Button } from "../components/Button";
import { SOCIAL_PROOF_COUNT } from "../data/placeholders";
import "./SignIn.css";

type Mode = "landing" | "emailSignIn" | "emailSignUp";
type EmailStep = "email" | "code";

/** Pulls a human-readable message out of a Clerk API error, which always
 *  carries its real message in `.errors[0]`, not `.message`. */
function extractClerkError(err: unknown): string {
  if (err && typeof err === "object" && "errors" in err) {
    const errors = (err as { errors?: Array<{ message?: string; longMessage?: string }> }).errors;
    const first = errors?.[0];
    if (first?.longMessage) return first.longMessage;
    if (first?.message) return first.message;
  }
  return "Something Went Wrong — Try Again";
}

/**
 * Real Clerk auth underneath (per instructions, auth itself stays as-is) —
 * but zero Clerk-branded UI anywhere: the email flow is built entirely on
 * Clerk's headless useSignIn/useSignUp hooks (email code + password), not
 * the <SignIn>/<SignUp> prebuilt components, so there's no "secured by
 * Clerk" footer or dev-mode banner to fight with. Apple is the primary
 * (this is an Apple-native app, Apple sign-in is the expected default
 * path) even though it isn't wired to a configured Clerk social connection
 * yet — that's build-state, not a design call, so the tap is a stub: no
 * visible feedback, nothing pretending to authenticate. Google and email
 * both really work.
 */
export function SignIn({
  onDevBypass,
  onSignUpComplete,
}: {
  onDevBypass: () => void;
  onSignUpComplete: () => void;
}) {
  const [mode, setMode] = useState<Mode>("landing");
  const { signIn, isLoaded: signInLoaded, setActive } = useSignIn();
  const { signUp, isLoaded: signUpLoaded } = useSignUp();

  const [emailStep, setEmailStep] = useState<EmailStep>("email");
  const [emailValue, setEmailValue] = useState("");
  const [passwordValue, setPasswordValue] = useState("");
  const [codeValue, setCodeValue] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Not wired to a configured Clerk connection yet — deliberately a no-op
  // rather than a fake "isn't set up yet" note (see the file-level comment).
  function tapApple() {}

  async function continueWithGoogle() {
    if (!signInLoaded) return;
    await signIn.authenticateWithRedirect({
      strategy: "oauth_google",
      redirectUrl: window.location.href,
      redirectUrlComplete: window.location.href,
    });
  }

  function enterEmailMode() {
    // Sign-up is the default landing state for "continue with email" — the
    // passwordless sign-in form is reached only via the "already have an
    // account?" toggle below, never directly.
    setMode("emailSignUp");
    setEmailStep("email");
    setAuthError(null);
  }

  function switchEmailMode() {
    setMode(mode === "emailSignIn" ? "emailSignUp" : "emailSignIn");
    setEmailStep("email");
    setPasswordValue("");
    setCodeValue("");
    setAuthError(null);
  }

  function backFromEmail() {
    if (emailStep === "code") {
      setEmailStep("email");
      setCodeValue("");
      setAuthError(null);
    } else {
      setMode("landing");
      setPasswordValue("");
      setAuthError(null);
    }
  }

  async function submitEmailStep(e: FormEvent) {
    e.preventDefault();
    const email = emailValue.trim();
    const password = passwordValue;
    if (!email || !signInLoaded || !signUpLoaded) return;
    if (mode === "emailSignUp" && !password) return;

    // Dev-only test shortcut — never reachable in a production build since
    // import.meta.env.DEV is statically false there and this whole branch
    // is dead-code-eliminated. Skips Clerk entirely rather than faking a
    // real session (which isn't something that can be done honestly from
    // the client anyway).
    if (import.meta.env.DEV && mode === "emailSignUp" && email === "test@test.com" && password === "test1234") {
      onDevBypass();
      return;
    }

    setSubmitting(true);
    setAuthError(null);
    try {
      if (mode === "emailSignIn") {
        const attempt = await signIn.create({ identifier: email });
        const factor = attempt.supportedFirstFactors?.find((f) => f.strategy === "email_code");
        if (!factor || factor.strategy !== "email_code") {
          throw new Error("Email Code Sign-In Isn't Available for This Account");
        }
        await signIn.prepareFirstFactor({
          strategy: "email_code",
          emailAddressId: factor.emailAddressId,
        });
      } else {
        // No name collected at sign-up on purpose — this is a solo editing
        // tool, no name is ever shown to anyone else, and it's one more
        // field of friction at the highest-drop-off moment in the funnel.
        // Apple sign-in supplies a name automatically on the path where one
        // would ever matter; billing can ask later if it needs one.
        await signUp.create({ emailAddress: email, password });
        await signUp.prepareEmailAddressVerification({ strategy: "email_code" });
      }
      setEmailStep("code");
    } catch (err) {
      setAuthError(extractClerkError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function submitCodeStep(e: FormEvent) {
    e.preventDefault();
    const code = codeValue.trim();
    if (!code || !signInLoaded || !signUpLoaded) return;
    setSubmitting(true);
    setAuthError(null);
    try {
      if (mode === "emailSignIn") {
        const res = await signIn.attemptFirstFactor({ strategy: "email_code", code });
        if (res.status === "complete") {
          await setActive({ session: res.createdSessionId });
        } else {
          setAuthError("That Code Didn't Work — Try Again");
        }
      } else {
        const res = await signUp.attemptEmailAddressVerification({ code });
        if (res.status === "complete") {
          await setActive({ session: res.createdSessionId });
          onSignUpComplete();
        } else {
          setAuthError("That Code Didn't Work — Try Again");
        }
      }
    } catch (err) {
      setAuthError(extractClerkError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (mode === "emailSignIn" || mode === "emailSignUp") {
    return (
      <div className="pbj-signin">
        <div className="pbj-signin__scroll pbj-signin__scroll--email">
          <BackButton onClick={backFromEmail} className="pbj-back-btn--floating" />

          <div className="pbj-signin__email-body">
            {emailStep === "email" ? (
              <>
                <h1 className="pbj-signin__email-title">
                  {mode === "emailSignIn" ? "Sign In With Email" : "Create Your Account"}
                </h1>
                <p className="pbj-signin__email-sub">
                  {mode === "emailSignIn"
                    ? "We'll Send a Code to Your Inbox"
                    : "Choose a Password, Then We'll Verify Your Email"}
                </p>
                <form className="pbj-signin__email-form" onSubmit={submitEmailStep}>
                  <input
                    type="email"
                    inputMode="email"
                    autoComplete="email"
                    autoFocus
                    required
                    placeholder="you@example.com"
                    className="pbj-signin__input"
                    value={emailValue}
                    onChange={(e) => setEmailValue(e.target.value)}
                  />
                  {mode === "emailSignUp" && (
                    <input
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={8}
                      placeholder="Password"
                      className="pbj-signin__input"
                      value={passwordValue}
                      onChange={(e) => setPasswordValue(e.target.value)}
                    />
                  )}
                  {authError && <p className="pbj-signin__error">{authError}</p>}
                  <Button type="submit" fullWidth disabled={submitting}>
                    {submitting ? "Sending…" : "Continue"}
                  </Button>
                </form>
                <p className="pbj-signin__switch">
                  {mode === "emailSignIn" ? "Don't Have an Account? " : "Already Have an Account? "}
                  <button type="button" className="pbj-signin__switch-link" onClick={switchEmailMode}>
                    {mode === "emailSignIn" ? "Sign Up" : "Sign In"}
                  </button>
                </p>
              </>
            ) : (
              <>
                <h1 className="pbj-signin__email-title">Check Your Email</h1>
                <p className="pbj-signin__email-sub">We Sent a Code to {emailValue}</p>
                <form className="pbj-signin__email-form" onSubmit={submitCodeStep}>
                  <input
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    autoFocus
                    required
                    placeholder="123456"
                    className="pbj-signin__input pbj-signin__input--code"
                    value={codeValue}
                    onChange={(e) => setCodeValue(e.target.value)}
                  />
                  {authError && <p className="pbj-signin__error">{authError}</p>}
                  <Button type="submit" fullWidth disabled={submitting}>
                    {submitting ? "Verifying…" : "Verify"}
                  </Button>
                </form>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pbj-signin">
      <div className="pbj-signin__scroll">
        <div className="pbj-signin__middle">
          <div className="pbj-signin__top">
            <div className="pbj-signin__lockup">
              <img src="/sandwich-logo.png" alt="pb&j" className="pbj-signin__mark" />
            </div>

            <h1 className="pbj-signin__title">Welcome to pb&j</h1>
            <p className="pbj-signin__sub">let's cook</p>

            <div className="pbj-signin__social-proof">
              <span className="pbj-signin__social-dot" aria-hidden="true" />
              <span>{SOCIAL_PROOF_COUNT} Edits Made This Week</span>
              <span aria-hidden="true">👨‍🍳</span>
            </div>
          </div>

          <div className="pbj-signin__actions">
            <div className="pbj-signin__apple-wrap">
              <Button
                type="button"
                variant="primary"
                className="pbj-signin__apple-btn"
                fullWidth
                onClick={tapApple}
                icon={
                  <svg width="17" height="20" viewBox="0 0 17 20" fill="none" aria-hidden="true">
                    <path
                      d="M13.9 10.6c0-2 1.6-3 1.7-3.1-1-1.4-2.4-1.6-3-1.6-1.3-.1-2.4.7-3.1.7-.6 0-1.6-.7-2.6-.7-1.4 0-2.6.8-3.3 2-1.4 2.5-.4 6.1 1 8.2.7 1 1.5 2.1 2.6 2.1s1.4-.7 2.7-.7 1.6.7 2.6.6c1.1 0 1.8-1 2.5-2 .8-1.1 1.1-2.2 1.1-2.3-.1 0-2.2-.8-2.2-3.2zM11.9 3.5c.6-.7 1-1.7.9-2.6-.9 0-1.9.6-2.5 1.3-.5.6-1 1.6-.9 2.5.9.1 1.8-.5 2.5-1.2z"
                      fill="currentColor"
                    />
                  </svg>
                }
              >
                Continue With Apple
              </Button>
            </div>

            <div className="pbj-signin__divider">
              <span />
              <em>Or</em>
              <span />
            </div>

            <Button
              type="button"
              variant="secondary"
              fullWidth
              onClick={continueWithGoogle}
              icon={
                <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden="true">
                  <path
                    d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.9c1.7-1.57 2.7-3.88 2.7-6.62z"
                    fill="#4285F4"
                  />
                  <path
                    d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.9-2.26c-.81.54-1.84.86-3.06.86-2.35 0-4.34-1.59-5.05-3.72H.96v2.33A9 9 0 0 0 9 18z"
                    fill="#34A853"
                  />
                  <path
                    d="M3.95 10.7A5.4 5.4 0 0 1 3.67 9c0-.59.1-1.17.28-1.7V4.97H.96A9 9 0 0 0 0 9c0 1.45.35 2.83.96 4.03l2.99-2.33z"
                    fill="#FBBC05"
                  />
                  <path
                    d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.58C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.97l2.99 2.33C4.66 5.17 6.65 3.58 9 3.58z"
                    fill="#EA4335"
                  />
                </svg>
              }
            >
              Continue With Google
            </Button>
            <Button
              type="button"
              variant="secondary"
              fullWidth
              onClick={enterEmailMode}
              icon={
                <svg width="16" height="16" viewBox="0 0 20 16" fill="none" aria-hidden="true">
                  <rect x="1" y="1" width="18" height="14" rx="2.5" stroke="currentColor" strokeWidth="1.5" />
                  <path
                    d="M2 2.5L10 9l8-6.5"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              }
            >
              Continue With Email
            </Button>
          </div>
        </div>

        <div className="pbj-signin__legal">
          <p className="pbj-signin__legal-line">By Continuing, You Agree to Our</p>
          <p className="pbj-signin__legal-line">
            <a href="#" className="pbj-signin__legal-link">
              Privacy Policy
            </a>
            {" & "}
            <a href="#" className="pbj-signin__legal-link">
              Terms of Service
            </a>
          </p>
        </div>
      </div>
    </div>
  );
}
