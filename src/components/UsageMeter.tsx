import { MOCK_BILLING } from "../data/placeholders";
import "./UsageMeter.css";

/**
 * Shown on both Settings and the Dashboard. Backed by MOCK_BILLING —
 * there is no real billing/subscription system yet (Clerk supplies
 * identity, not plan/usage data), so these numbers are static placeholders,
 * not a live count of anything a creator has actually used. Kept as its
 * own component specifically so that fact lives in exactly one place
 * instead of two copies silently drifting.
 */
export function UsageMeter() {
  // Label and fill both read off minutesUsed now — they used to disagree
  // (a "remaining" label next to a "used" percentage fill).
  const pct = Math.min(
    100,
    Math.round((MOCK_BILLING.minutesUsed / MOCK_BILLING.minutesLimit) * 100)
  );

  return (
    <section className="pbj-usage-meter">
      <div className="pbj-usage-meter__row">
        <span className="pbj-usage-meter__label">Subscription</span>
        <span className="pbj-usage-meter__tier-badge">{MOCK_BILLING.tier}</span>
      </div>

      <div className="pbj-usage-meter__divider" />

      <div className="pbj-usage-meter__row pbj-usage-meter__row--stack">
        <div className="pbj-usage-meter__row">
          <span className="pbj-usage-meter__label">Minutes Used</span>
          <span className="pbj-usage-meter__value">
            {MOCK_BILLING.minutesUsed} / {MOCK_BILLING.minutesLimit}
          </span>
        </div>
        <div className="pbj-usage-meter__bar">
          <div className="pbj-usage-meter__bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    </section>
  );
}
